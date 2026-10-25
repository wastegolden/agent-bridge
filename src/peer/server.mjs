// src/peer/server.mjs
//
// The agent-peer MCP server (contract agent-peer-v1): lets one harness (Claude Code
// or Codex) consult, request an independent review from, or appoint as a
// sub-controller the OTHER harness, through that harness's own headless CLI.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio). Tools:
//   peer_capabilities  where this harness sits on the chain and what it may call
//   peer_ask           start one peer job (optionally waiting a bounded time)
//   peer_check         bounded wait for a job; never cancels it
//   peer_result        the peer's final answer in repeatable slices
//   peer_cancel        request a stop of a running job (process tree)
//   peer_list          recent jobs
//   record_closeout    close out one root task into its durable record
//   record_list        the durable records known to the index
//   cleanup_run        sweep raw sessions whose retention window has arrived
//
// Policy is enforced here, not in prompts: src/peer/chain.mjs refuses self-targets,
// cycles back to any harness on the chain (including the root controller), depth
// overruns and sub-controller appointment below the delegate depth. The chain comes
// from the environment, cross-checked against the process-lineage ledger so a
// harness that filters its MCP environment cannot make a callee look like a root.
// A session can only be resumed if a peer job of this ledger created it — and a
// read-only claude-code peer leaves no session behind at all.
//
// Errors: unknown tools and schema-invalid arguments are JSON-RPC protocol errors
// (-32602); policy refusals and runtime failures are tool results with isError.

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { createBridgeClient } from './bridge-client.mjs';
import { ENV_KEYS, PEER_MODES, PEER_TARGETS, PeerPolicyError, buildPeerPreamble, formatChain, planPeerCall, readChainContext } from './chain.mjs';
import { EFFORT_RE, MODEL_RE, SESSION_ID_RE, buildInvocation, childEnvironment, effortChoices } from './cli.mjs';
import { CLOSEOUT_OUTCOMES, closeoutRootTask } from './closeout.mjs';
import { createCodexThreadClient } from './codex-threads.mjs';
import { createPeerJobs } from './jobs.mjs';
import { readIndex } from './records.mjs';
import { sweepRecords } from './sweeper.mjs';

export const PEER_SERVER_NAME = 'agent-peer';
export const PEER_SERVER_VERSION = '1.1.0';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** Node timers overflow above 2^31-1 ms, so a sweep interval is capped there. */
const MAX_TIMER_MS = 2_147_483_647;
const FIRST_SWEEP_DELAY_MS = 60_000;
const JOB_ID_PATTERN = '^peer-\\d{13}-[0-9a-f]{8}$';
const ROOT_TASK_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
/** The codex app-server refuses a longer thread name. */
const MAX_THREAD_NAME_CHARS = 200;

/** Diagnostics go to stderr as one JSON line; a log line never fails a call. */
function defaultLogger(record) {
  try {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: 'agent-peer', ...record })}\n`);
  } catch {
    // stderr is gone; nothing left to log to
  }
}

/**
 * Stand-in bridge client for a host with no `bridge` config. closeoutRootTask requires
 * the dossier/resultText surface even when no bridge task is selected; every call is
 * refused first, so this object is never actually reached.
 */
const NO_BRIDGE = Object.freeze({
  dossier: async () => { throw new PeerPolicyError('PEER_NOT_CONFIGURED', 'no bridge client is configured', { field: 'bridgeTaskIds' }); },
  resultText: async () => { throw new PeerPolicyError('PEER_NOT_CONFIGURED', 'no bridge client is configured', { field: 'bridgeTaskIds' }); },
});

/** Windows drive (C:\ or C:/), UNC or POSIX absolute path. */
const ABSOLUTE_PATH_PATTERN = '^(?:[A-Za-z]:[\\\\/]|[\\\\/])';
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export function peerTools(limits) {
  const jobId = str('Peer job id returned by peer_ask.', { pattern: JOB_ID_PATTERN });
  const rootTask = str('Root controller only: task label carried down the chain. Omitted, this server instance (one controller session) uses its own label. Peer sessions can only be continued under the same root task.', { pattern: ROOT_TASK_PATTERN });
  const peerJobIds = { type: 'array', items: { type: 'string', pattern: JOB_ID_PATTERN }, description: 'Peer job ids of THIS root task to close out.' };
  return [
    tool('peer_capabilities', 'Report this harness, its delegation chain, which peers it may call in which modes right now, and the configured limits. Call before planning cross-harness work.', {}),
    tool(
      'peer_ask',
      'Start one headless run of ANOTHER harness (codex or claude-code). mode "consult" answers a question, "review" is an independent read-only review, "delegate" appoints the peer as sub-controller for a bounded objective (it may run its own subagents or DSH bridge tasks). The call is refused when the target is this harness, is already on the chain (no work flows back toward the root controller), or the hop/delegate limits are exceeded. Returns the job; waits up to waitMs for completion.',
      {
        target: { type: 'string', enum: [...PEER_TARGETS], description: 'Harness to run.' },
        mode: { type: 'string', enum: [...PEER_MODES], description: 'consult | review (both read-only) | delegate (may write inside cwd/addDirs).' },
        prompt: str('Complete, self-contained request. The peer sees nothing of this conversation. For review, include the exact material or file paths and what to judge; do not reveal which model produced it.', { minLength: 1, maxLength: limits.maxPromptChars }),
        cwd: str('Absolute existing working directory for the peer. When continuing a session it must equal that session\'s directory.', { pattern: ABSOLUTE_PATH_PATTERN }),
        sessionId: str('Continue a session that an earlier peer job of the SAME target and the SAME root task created (from that job\'s sessionId). Other sessions are refused.', { pattern: SESSION_ID_RE.source }),
        model: str('Optional explicit model for the peer CLI. Omitted uses the configured default; with neither, nothing is passed and the CLI decides.', { pattern: MODEL_RE.source }),
        reasoningEffort: str('Optional reasoning effort for THIS run (new or continued session). Overrides peers.<target>.reasoningEffort / peers.<target>.effort; omitted uses the configured default, and with neither nothing is passed. Allowed values are peers.<target>.reasoningEfforts in peer_capabilities (call it before choosing).', { pattern: EFFORT_RE.source }),
        addDirs: { type: 'array', items: { type: 'string', pattern: ABSOLUTE_PATH_PATTERN }, description: 'delegate only, new sessions only: extra absolute writable directories.' },
        title: str('Short label for job listings.', { maxLength: 200 }),
        timeoutMs: int('Wall-clock limit for the peer process.', { minimum: 10_000, maximum: limits.maxTimeoutMs }),
        waitMs: int('How long this call waits for completion before returning the running job.', { minimum: 0, maximum: limits.maxWaitMs }),
        rootTask,
      },
      ['target', 'mode', 'prompt', 'cwd'],
    ),
    tool('peer_check', 'Bounded wait for a peer job; returning early never cancels it.', { jobId, waitMs: int('Wait budget.', { minimum: 0, maximum: limits.maxWaitMs }) }, ['jobId']),
    tool('peer_result', "Read a finished peer job's final answer in slices. The answer is the peer's claim, not evidence: verify it. outcomeUnknown:true means no answer was recorded.", { jobId, offset: int('Start offset.', { minimum: 0 }), limit: int('Slice size.', { minimum: 1, maximum: 200_000 }) }, ['jobId']),
    tool('peer_cancel', 'Request a stop of a running peer job and its process tree. The job becomes cancelled only once the process has exited.', { jobId }, ['jobId']),
    tool('peer_list', 'List recent peer jobs, newest first.', { limit: int('Maximum jobs.', { minimum: 1, maximum: 200 }) }),
    tool(
      'record_closeout',
      'Close out ONE root task: write its durable Markdown record from the STORED data (never summarised by a model) and append one index event, so its raw sessions may later be swept. Every listed peer job must be finished and every bridge task settled and acknowledged, otherwise the call is refused and nothing is written. A repeated identical closeout is a no-op.',
      {
        title: str('Short title of the closed-out task; part of the record file name.', { minLength: 1, maxLength: 200 }),
        outcome: { type: 'string', enum: [...CLOSEOUT_OUTCOMES], description: 'accepted | failed | disputed | unresolved.' },
        conclusion: str('The conclusion text stored verbatim in the record.', { minLength: 1, maxLength: 20_000 }),
        findings: { type: 'array', items: { type: 'object' }, description: 'Optional cross-verification findings: {id, raisedBy[], verdict, summary, evidence}.' },
        bridgeTaskIds: { type: 'array', items: { type: 'string' }, description: 'DSH bridge task ids of this root task to close out (needs a configured bridge client).' },
        peerJobIds,
        projectRoot: str('Absolute project root that receives the record. Discovered from the first job/dossier when omitted.', { pattern: ABSOLUTE_PATH_PATTERN }),
        keep: { type: 'boolean', description: 'Keep the raw sessions forever (never swept).' },
        rootTask,
      },
      ['title', 'outcome', 'conclusion'],
    ),
    tool('record_list', 'List the durable accepted-result records known to the index, newest first by closedAt.', { limit: int('Maximum records.', { minimum: 1, maximum: 200 }) }),
    tool('cleanup_run', 'Sweep the raw sessions of closed records whose retention window has arrived. dryRun (the default) plans every action and changes nothing.', { dryRun: { type: 'boolean', description: 'Default true: plan only, call nothing, write nothing.' } }),
  ];
}

const INSTRUCTIONS = [
  'agent-peer: cross-harness consult / review / delegate between Claude Code and Codex.',
  'Each task has exactly one root controller. Work flows down the chain; results flow back as answers. A peer can never be asked to call a harness already on its chain.',
  'Peer answers are claims from another model: verify them against files, commands and tests before acting. For cross-verification, ask independently first, then cross-examine disagreements, and decide on evidence.',
  'DSH (DeepSeek) work goes through the dsh_project bridge_* tools, not through this server.',
].join(' ');

class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.rpcCode = code;
    this.data = data;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateArgs(spec, args) {
  const invalid = (message, field) => new ProtocolError(-32602, message, { code: 'PEER_ARGS_INVALID', ...(field ? { field } : {}) });
  if (!isPlainObject(args)) throw invalid('arguments must be an object');
  const { properties, required } = spec.inputSchema;
  for (const key of required) if (!Object.hasOwn(args, key)) throw invalid(`missing ${key}`, key);
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) throw invalid(`unexpected ${key}`, key);
    const schema = properties[key];
    const value = args[key];
    const ok =
      schema.type === 'integer' ? Number.isSafeInteger(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum)
        : schema.type === 'boolean' ? typeof value === 'boolean'
          : schema.type === 'array' ? Array.isArray(value) && (schema.items?.type === 'object'
            ? value.every((item) => isPlainObject(item))
            : value.every((item) => typeof item === 'string' && (schema.items?.pattern === undefined || new RegExp(schema.items.pattern).test(item))))
            : schema.type === 'string' ? typeof value === 'string' && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength) && (schema.enum === undefined || schema.enum.includes(value)) && (schema.pattern === undefined || new RegExp(schema.pattern).test(value))
              : false;
    if (!ok) throw invalid(`invalid ${key}`, key);
  }
}

const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * @param {object} spec
 * @param {object} spec.env - the server's process environment (self + inherited chain).
 * @param {object|null} spec.config - normalized peer config, or null when unavailable.
 * @param {Error|null} [spec.configError]
 * @param {Function} [spec.resolveLineage] - async () => ({ env, source }) reconciling the
 *   environment with the lineage ledger; default trusts the environment as-is.
 * @param {object} [spec.jobs] - injected job manager (tests).
 * @param {Function} [spec.jobsFactory] - builds the job manager the server owns; it is
 *   called with { stateDir, maxConcurrent, onSettled }. A test seam so the server-created
 *   manager can run a fixture CLI. Defaults to createPeerJobs.
 * @param {Function} [spec.statImpl]
 * @param {Function} [spec.codexThreadsFactory] - () => codex app-server client
 *   (organize/archive/remove/close). Defaults to a real client when codex is configured.
 * @param {object} [spec.bridgeClient] - DSH bridge client (dossier/resultText/archive/
 *   cleanup). Defaults to a real loopback client when config.bridge exists, else null.
 * @param {Function} [spec.now] - clock seam (epoch milliseconds), default Date.now.
 * @param {boolean} [spec.startSweepTimer] - start the retention sweep timers, default true.
 * @param {Function} [spec.logger] - receives {phase, ...} diagnostic records.
 */
export function createPeerServer({
  env = process.env,
  config = null,
  configError = null,
  resolveLineage = null,
  jobs = null,
  jobsFactory = createPeerJobs,
  statImpl = stat,
  codexThreadsFactory,
  bridgeClient,
  now = () => Date.now(),
  startSweepTimer = true,
  logger = defaultLogger,
} = {}) {
  const log = typeof logger === 'function' ? logger : defaultLogger;
  const limits = config?.limits ?? { maxPromptChars: 200_000, maxTimeoutMs: 4 * 60 * 60_000, maxWaitMs: 55_000, timeoutMs: 30 * 60_000, maxConcurrentJobs: 3 };
  const tools = peerTools(limits);

  // Both clients are created once, for the life of this server. A client that cannot be
  // built degrades to null (the tools that need it then refuse) instead of failing the
  // whole server: peer_capabilities must still be able to explain the situation.
  const resolvedCodexThreadsFactory = codexThreadsFactory !== undefined
    ? codexThreadsFactory
    : (config?.peers?.codex ? () => createCodexThreadClient({ executable: config.peers.codex.executable }) : null);
  let resolvedBridgeClient = bridgeClient;
  if (resolvedBridgeClient === undefined) {
    if (config?.bridge) {
      try {
        resolvedBridgeClient = createBridgeClient({ url: config.bridge.url, credentialFile: config.bridge.credentialFile ?? null });
      } catch (error) {
        log({ phase: 'bridge-client', code: error?.code ?? 'PEER_CONFIG_INVALID' });
        resolvedBridgeClient = null;
      }
    } else {
      resolvedBridgeClient = null;
    }
  }

  /**
   * A finished codex peer job leaves a thread behind. Rename it and move it into the
   * configured section so a controller can find it later. This runs after the job is
   * settled and persisted; it never throws and never changes job state.
   */
  async function organizeSettledJob(record) {
    try {
      const codex = config?.peers?.codex ?? null;
      const section = codex?.threadSection ?? null;
      if (record?.target !== 'codex' || typeof record?.sessionId !== 'string' || record.sessionId === '' || section === null) return;
      if (typeof resolvedCodexThreadsFactory !== 'function') return;
      const prefix = codex.threadNamePrefix ?? '[agent-bridge]';
      const label = record.title ?? record.rootTask ?? record.jobId ?? 'peer job';
      const name = `${prefix} ${record.mode ?? 'peer'} · ${label}`.slice(0, MAX_THREAD_NAME_CHARS);
      const client = resolvedCodexThreadsFactory();
      try {
        await client.organize(record.sessionId, { name, sectionName: section });
      } finally {
        try {
          await client?.close?.();
        } catch (error) {
          log({ phase: 'organize-close', jobId: record.jobId ?? null, code: error?.code ?? 'E_ORGANIZE' });
        }
      }
    } catch (error) {
      log({ phase: 'organize', jobId: record?.jobId ?? null, target: record?.target ?? null, code: error?.code ?? 'E_ORGANIZE' });
    }
  }

  const jobManager = jobs ?? (config
    ? (typeof jobsFactory === 'function' ? jobsFactory : createPeerJobs)({
      stateDir: config.stateDir,
      maxConcurrent: limits.maxConcurrentJobs,
      onSettled: organizeSettledJob,
    })
    : null);
  // One MCP server process serves one controller session: its default root task label.
  const instanceTask = `session-${randomUUID()}`;
  let contextPromise = null;
  /** In-flight retention sweep (timer ticks and cleanup_run never overlap). */
  let sweepInFlight = null;
  let sweepTimer = null;
  let firstSweepTimer = null;

  /** Resolve (once) where this server sits on the chain. */
  function resolveContext() {
    if (!contextPromise) {
      contextPromise = (async () => {
        let effectiveEnv = env;
        let source = 'environment';
        if (resolveLineage) {
          try {
            ({ env: effectiveEnv, source } = await resolveLineage(env));
          } catch (error) {
            // Without a verified lineage, a process that claims to be a root controller
            // cannot be distinguished from a callee whose chain was filtered away. A
            // one-element chain is a root claim too (a real root carries no chain).
            const inherited = typeof env?.[ENV_KEYS.chain] === 'string' ? env[ENV_KEYS.chain].split('>').filter((part) => part.trim() !== '') : [];
            const claimsRoot = inherited.length <= 1;
            if (claimsRoot || error?.code === 'PEER_CHAIN_INVALID') {
              return { context: null, error: error?.code ? error : new PeerPolicyError('PEER_LINEAGE_UNAVAILABLE', String(error?.message ?? error)), source: 'unverified' };
            }
            source = 'environment (lineage unavailable)';
          }
        }
        try {
          return { context: readChainContext(effectiveEnv), error: null, source };
        } catch (error) {
          return { context: null, error, source };
        }
      })();
    }
    return contextPromise;
  }

  async function requireReady() {
    const { context, error } = await resolveContext();
    if (error) throw error;
    if (!config || !jobManager) throw configError ?? new PeerPolicyError('PEER_CONFIG_INVALID', 'peer config is not loaded');
    return context;
  }

  async function capabilities() {
    const { context, error: contextError, source } = await resolveContext();
    const peers = {};
    for (const target of PEER_TARGETS) {
      const peer = config?.peers?.[target] ?? null;
      const entry = {
        configured: Boolean(peer),
        enabled: peer?.enabled === true,
        // What a plain peer_ask would pass when the call names neither model nor effort.
        defaultModel: peer?.model ?? null,
        defaultReasoningEffort: peer ? (target === 'codex' ? (peer.reasoningEffort ?? null) : (peer.effort ?? null)) : null,
        // The per-call values a reasoningEffort argument may name right now.
        reasoningEfforts: peer ? effortChoices(target, peer) : [],
        modes: {},
      };
      for (const mode of PEER_MODES) {
        if (!context) {
          entry.modes[mode] = { allowed: false, code: contextError?.code ?? 'PEER_SELF_UNKNOWN' };
          continue;
        }
        try {
          planPeerCall(context, { target, mode });
          entry.modes[mode] = entry.enabled ? { allowed: true } : { allowed: false, code: 'PEER_NOT_CONFIGURED' };
        } catch (error) {
          entry.modes[mode] = { allowed: false, code: error.code };
        }
      }
      peers[target] = entry;
    }
    return {
      server: PEER_SERVER_NAME,
      version: PEER_SERVER_VERSION,
      self: context?.self ?? null,
      chain: context ? formatChain(context.chain) : null,
      chainSource: source,
      root: context?.root ?? null,
      depth: context?.depth ?? null,
      isRootController: context?.isRoot ?? null,
      maxDepth: context?.maxDepth ?? null,
      maxDelegateDepth: context?.maxDelegateDepth ?? null,
      rootTask: context ? (context.isRoot ? instanceTask : context.rootTask) : null,
      contextError: contextError ? { code: contextError.code, message: contextError.message } : null,
      configError: config ? null : { code: configError?.code ?? 'PEER_CONFIG_INVALID', message: configError?.message ?? 'peer config is not loaded' },
      peers,
      limits,
    };
  }

  async function ask(args) {
    const context = await requireReady();
    if (args.rootTask !== undefined && !context.isRoot) {
      throw new PeerPolicyError('PEER_ARGS_INVALID', 'only the root controller may set rootTask; it is inherited below the root', { field: 'rootTask' });
    }
    // Every call carries a root task: inherited below the root; at the root the explicit
    // label or this server instance's own label (one controller session).
    const rootTask = context.isRoot ? (args.rootTask ?? instanceTask) : context.rootTask;
    // Policy first: a refused call must not depend on whether the peer is installed.
    const plan = planPeerCall(context, { target: args.target, mode: args.mode, rootTask });
    const peer = config.peers[args.target];
    if (!peer || peer.enabled !== true) throw new PeerPolicyError('PEER_NOT_CONFIGURED', `peer "${args.target}" is not configured or disabled on this host`, { field: 'target' });
    if (!path.isAbsolute(args.cwd)) throw new PeerPolicyError('PEER_ARGS_INVALID', 'cwd must be an absolute path', { field: 'cwd' });
    if (args.sessionId !== undefined) {
      const prior = await jobManager.findSession(args.target, args.sessionId);
      if (!prior) {
        throw new PeerPolicyError('PEER_SESSION_UNKNOWN', 'only sessions created by an earlier peer job of the same target can be continued', { field: 'sessionId' });
      }
      // A read-only claude-code peer runs with --no-session-persistence: it never wrote
      // a session, so there is nothing to continue however the ledger looks.
      if (prior.target === 'claude-code' && prior.readOnly === true) {
        throw new PeerPolicyError(
          'PEER_SESSION_NOT_RESUMABLE',
          'a read-only claude-code peer runs with --no-session-persistence and leaves no session to continue; ask again without sessionId',
          { field: 'sessionId' },
        );
      }
      // Another controller session (or another task) sharing this ledger cannot take
      // over the session: root controller and root task must both match.
      if (prior.root !== context.root || prior.rootTask === null || prior.rootTask === undefined || prior.rootTask !== plan.rootTask) {
        throw new PeerPolicyError('PEER_SESSION_FOREIGN', 'that session belongs to another root controller session or task; pass the same rootTask it was created under', { field: 'sessionId' });
      }
      if (typeof prior.cwd === 'string' && !samePath(prior.cwd, args.cwd)) {
        throw new PeerPolicyError('PEER_ARGS_INVALID', `a continued session keeps its working directory ${prior.cwd}`, { field: 'cwd' });
      }
    }
    let info;
    try {
      info = await statImpl(args.cwd);
    } catch {
      info = null;
    }
    if (!info?.isDirectory?.()) throw new PeerPolicyError('PEER_ARGS_INVALID', 'cwd must be an existing directory', { field: 'cwd' });
    const allocation = jobManager.allocate();
    const invocation = buildInvocation(
      { target: args.target, mode: args.mode, cwd: args.cwd, sessionId: args.sessionId ?? null, model: args.model ?? null, reasoningEffort: args.reasoningEffort ?? null, addDirs: args.addDirs ?? [], lastMessageFile: allocation.lastMessageFile },
      peer,
    );
    const prompt = `${buildPeerPreamble(plan)}\n\n${args.prompt}`;
    const job = await jobManager.start({
      jobId: allocation.jobId,
      invocation,
      plan,
      prompt,
      env: childEnvironment(env, plan.childEnv),
      timeoutMs: args.timeoutMs ?? limits.timeoutMs,
      title: args.title ?? null,
      cwd: invocation.cwd,
      sessionIdRequested: args.sessionId ?? null,
      // What buildInvocation actually passed, and where it came from.
      model: invocation.model,
      modelSource: invocation.modelSource,
      reasoningEffort: invocation.reasoningEffort,
      effortSource: invocation.effortSource,
    });
    const waitMs = args.waitMs ?? Math.min(limits.maxWaitMs, 55_000);
    return waitMs > 0 ? jobManager.wait(job.jobId, waitMs) : job;
  }

  /** Close out ONE root task into its durable record (see src/peer/closeout.mjs). */
  async function recordCloseout(args) {
    const context = await requireReady();
    // rootTask resolves exactly like ask(): explicit at the root, inherited below it.
    if (args.rootTask !== undefined && !context.isRoot) {
      throw new PeerPolicyError('PEER_ARGS_INVALID', 'only the root controller may set rootTask; it is inherited below the root', { field: 'rootTask' });
    }
    const rootTask = context.isRoot ? (args.rootTask ?? instanceTask) : context.rootTask;
    if (config.records?.enabled === false) {
      throw new PeerPolicyError('PEER_NOT_CONFIGURED', 'record closeout is disabled on this host (records.enabled is false)', { field: 'records' });
    }
    const bridgeTaskIds = Array.isArray(args.bridgeTaskIds) ? args.bridgeTaskIds : [];
    if (bridgeTaskIds.length > 0 && !resolvedBridgeClient) {
      throw new PeerPolicyError('PEER_NOT_CONFIGURED', 'bridgeTaskIds needs a configured bridge client (config.bridge url and credential)', { field: 'bridgeTaskIds' });
    }
    return closeoutRootTask({
      input: args,
      rootTask,
      context: { self: context.self, chain: context.chain, root: context.root },
      jobs: jobManager,
      // closeoutRootTask requires the dossier/resultText surface; with no bridge client
      // every bridge-task path is refused above, so this stub is never actually called.
      bridge: resolvedBridgeClient ?? NO_BRIDGE,
      stateDir: config.stateDir,
      recordsConfig: config.records,
      now,
    });
  }

  /** The durable records known to the index, newest first by closedAt. */
  async function recordList(args) {
    await requireReady();
    const closedAtOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY);
    const index = await readIndex(config.stateDir);
    const records = [...index.values()]
      .sort((a, b) => closedAtOf(b.closedAt) - closedAtOf(a.closedAt))
      .slice(0, args.limit ?? 20)
      .map((record) => ({
        recordId: record.recordId ?? null,
        title: record.title ?? null,
        rootTask: record.rootTask ?? null,
        path: record.path ?? null,
        outcome: record.outcome ?? null,
        keep: record.keep === true,
        closedAt: record.closedAt ?? null,
        eligibleAt: record.eligibleAt ?? null,
        sessions: [...record.sessions.values()].map((session) => ({
          harness: session.harness ?? null,
          id: session.id ?? null,
          state: session.state ?? null,
        })),
      }));
    return { records };
  }

  /** Run one retention sweep with the clients this server owns (never overlaps). */
  async function runSweepNow(dryRun) {
    let codexThreads = null;
    if (typeof resolvedCodexThreadsFactory === 'function') {
      try {
        codexThreads = resolvedCodexThreadsFactory();
      } catch (error) {
        log({ phase: 'sweep-client', code: error?.code ?? 'E_SWEEP' });
        codexThreads = null;
      }
    }
    try {
      return await sweepRecords({
        stateDir: config.stateDir,
        now,
        dryRun,
        codexThreads,
        bridge: resolvedBridgeClient ?? null,
        claudeProjectsDir: config.records?.claudeProjectsDir ?? null,
      });
    } finally {
      try {
        await codexThreads?.close?.();
      } catch (error) {
        log({ phase: 'sweep-close', code: error?.code ?? 'E_SWEEP' });
      }
    }
  }

  /** One sweep at a time: a second request waits for the running sweep, timer ticks skip. */
  function runSweep(dryRun) {
    const previous = sweepInFlight;
    const promise = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // the earlier sweep's failure belongs to its own caller
        }
      }
      return runSweepNow(dryRun);
    })();
    sweepInFlight = promise;
    const settled = () => { if (sweepInFlight === promise) sweepInFlight = null; };
    promise.then(settled, settled);
    return promise;
  }

  async function cleanupRun(args) {
    await requireReady();
    return runSweep(args.dryRun ?? true);
  }

  /** Retention sweep timers: unref'd, never overlapping, cleared by close(). */
  function startSweepTimers() {
    if (startSweepTimer !== true || !config) return;
    const records = config.records;
    if (!records || records.enabled !== true) return;
    if (!Number.isInteger(records.sweepIntervalMinutes) || records.sweepIntervalMinutes <= 0) return;
    const tick = () => {
      if (sweepInFlight) return;
      void runSweep(false).catch((error) => log({ phase: 'sweep-timer', code: error?.code ?? 'E_SWEEP' }));
    };
    firstSweepTimer = setTimeout(() => {
      firstSweepTimer = null;
      tick();
    }, Math.min(FIRST_SWEEP_DELAY_MS, MAX_TIMER_MS));
    firstSweepTimer.unref?.();
    sweepTimer = setInterval(tick, Math.min(records.sweepIntervalMinutes * 60_000, MAX_TIMER_MS));
    sweepTimer.unref?.();
  }

  function stopSweepTimers() {
    if (firstSweepTimer !== null) {
      clearTimeout(firstSweepTimer);
      firstSweepTimer = null;
    }
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  startSweepTimers();

  async function call(name, args = {}) {
    const spec = tools.find((entry) => entry.name === name);
    if (!spec) throw new ProtocolError(-32602, `Unknown tool: ${String(name)}`, { code: 'PEER_UNKNOWN_TOOL' });
    validateArgs(spec, args ?? {});
    switch (name) {
      case 'peer_capabilities':
        return capabilities();
      case 'peer_ask':
        return { job: await ask(args) };
      case 'peer_check':
        await requireReady();
        return { job: await jobManager.wait(args.jobId, args.waitMs ?? 0) };
      case 'peer_result':
        await requireReady();
        return jobManager.result(args.jobId, { offset: args.offset ?? 0, limit: args.limit ?? 20_000 });
      case 'peer_cancel':
        await requireReady();
        return jobManager.cancel(args.jobId);
      case 'peer_list':
        await requireReady();
        return { jobs: await jobManager.list({ limit: args.limit ?? 20 }) };
      case 'record_closeout':
        return recordCloseout(args);
      case 'record_list':
        return recordList(args);
      case 'cleanup_run':
        return cleanupRun(args);
      default:
        throw new ProtocolError(-32602, `Unknown tool: ${String(name)}`, { code: 'PEER_UNKNOWN_TOOL' });
    }
  }

  const validId = (id) => typeof id === 'string' || Number.isSafeInteger(id);

  /** Handle one decoded JSON-RPC message; resolves the reply object or null. */
  async function handle(message) {
    if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: validId(message?.id) ? message.id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    // A notification omits the id; a present id must be a string or an integer (MCP).
    if (!Object.hasOwn(message, 'id')) return null;
    const { id, method, params } = message;
    if (!validId(id)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: id must be a string or an integer' } };
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: PEER_SERVER_NAME, version: PEER_SERVER_VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
    if (method === 'tools/call') {
      try {
        const value = await call(params?.name, params?.arguments ?? {});
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } };
      } catch (error) {
        if (error instanceof ProtocolError) return { jsonrpc: '2.0', id, error: { code: error.rpcCode, message: error.message, data: error.data } };
        const detail = isPlainObject(error?.detail) && typeof error.detail.field === 'string' ? { field: error.detail.field } : undefined;
        const body = { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error), ...(detail ? { details: detail } : {}) };
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] } };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }

  /** Attach to line-delimited stdio. Replies are written in completion order. */
  function attach({ input, output, createInterface }) {
    const reader = createInterface({ input, crlfDelay: Infinity });
    const write = (reply) => {
      try {
        output.write(`${JSON.stringify(reply)}\n`);
      } catch {
        // the client went away; nothing left to answer
      }
    };
    reader.on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      handle(message)
        .then((reply) => { if (reply) write(reply); })
        .catch(() => write({ jsonrpc: '2.0', id: validId(message?.id) ? message.id : null, error: { code: -32603, message: 'Internal error' } }));
    });
    return reader;
  }

  return Object.freeze({
    handle,
    call,
    capabilities,
    attach,
    tools,
    close: async () => {
      stopSweepTimers();
      await jobManager?.close();
    },
  });
}
