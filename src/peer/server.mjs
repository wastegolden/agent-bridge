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
//
// Policy is enforced here, not in prompts: src/peer/chain.mjs refuses self-targets,
// cycles back to any harness on the chain (including the root controller), depth
// overruns and sub-controller appointment below the delegate depth. The chain comes
// from the environment, cross-checked against the process-lineage ledger so a
// harness that filters its MCP environment cannot make a callee look like a root.
// A session can only be resumed if a peer job of this ledger created it.
//
// Errors: unknown tools and schema-invalid arguments are JSON-RPC protocol errors
// (-32602); policy refusals and runtime failures are tool results with isError.

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { ENV_KEYS, PEER_MODES, PEER_TARGETS, PeerPolicyError, buildPeerPreamble, formatChain, planPeerCall, readChainContext } from './chain.mjs';
import { MODEL_RE, SESSION_ID_RE, buildInvocation, childEnvironment } from './cli.mjs';
import { createPeerJobs } from './jobs.mjs';

export const PEER_SERVER_NAME = 'agent-peer';
export const PEER_SERVER_VERSION = '1.1.0';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

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
  const jobId = str('Peer job id returned by peer_ask.', { pattern: '^peer-\\d{13}-[0-9a-f]{8}$' });
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
        model: str('Optional explicit model for the peer CLI. Omitted uses the configured or CLI default.', { pattern: MODEL_RE.source }),
        addDirs: { type: 'array', items: { type: 'string', pattern: ABSOLUTE_PATH_PATTERN }, description: 'delegate only, new sessions only: extra absolute writable directories.' },
        title: str('Short label for job listings.', { maxLength: 200 }),
        timeoutMs: int('Wall-clock limit for the peer process.', { minimum: 10_000, maximum: limits.maxTimeoutMs }),
        waitMs: int('How long this call waits for completion before returning the running job.', { minimum: 0, maximum: limits.maxWaitMs }),
        rootTask: str('Root controller only: task label carried down the chain. Omitted, this server instance (one controller session) uses its own label. Peer sessions can only be continued under the same root task.', { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' }),
      },
      ['target', 'mode', 'prompt', 'cwd'],
    ),
    tool('peer_check', 'Bounded wait for a peer job; returning early never cancels it.', { jobId, waitMs: int('Wait budget.', { minimum: 0, maximum: limits.maxWaitMs }) }, ['jobId']),
    tool('peer_result', "Read a finished peer job's final answer in slices. The answer is the peer's claim, not evidence: verify it. outcomeUnknown:true means no answer was recorded.", { jobId, offset: int('Start offset.', { minimum: 0 }), limit: int('Slice size.', { minimum: 1, maximum: 200_000 }) }, ['jobId']),
    tool('peer_cancel', 'Request a stop of a running peer job and its process tree. The job becomes cancelled only once the process has exited.', { jobId }, ['jobId']),
    tool('peer_list', 'List recent peer jobs, newest first.', { limit: int('Maximum jobs.', { minimum: 1, maximum: 200 }) }),
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
        : schema.type === 'array' ? Array.isArray(value) && value.every((item) => typeof item === 'string' && (schema.items?.pattern === undefined || new RegExp(schema.items.pattern).test(item)))
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
 */
export function createPeerServer({ env = process.env, config = null, configError = null, resolveLineage = null, jobs = null, statImpl = stat } = {}) {
  const limits = config?.limits ?? { maxPromptChars: 200_000, maxTimeoutMs: 4 * 60 * 60_000, maxWaitMs: 55_000, timeoutMs: 30 * 60_000, maxConcurrentJobs: 3 };
  const tools = peerTools(limits);
  const jobManager = jobs ?? (config ? createPeerJobs({ stateDir: config.stateDir, maxConcurrent: limits.maxConcurrentJobs }) : null);
  // One MCP server process serves one controller session: its default root task label.
  const instanceTask = `session-${randomUUID()}`;
  let contextPromise = null;

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
      const entry = { configured: Boolean(config?.peers?.[target]), enabled: config?.peers?.[target]?.enabled === true, modes: {} };
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
      { target: args.target, mode: args.mode, cwd: args.cwd, sessionId: args.sessionId ?? null, model: args.model ?? null, addDirs: args.addDirs ?? [], lastMessageFile: allocation.lastMessageFile },
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
    });
    const waitMs = args.waitMs ?? Math.min(limits.maxWaitMs, 55_000);
    return waitMs > 0 ? jobManager.wait(job.jobId, waitMs) : job;
  }

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

  return Object.freeze({ handle, call, capabilities, attach, tools, close: async () => { await jobManager?.close(); } });
}
