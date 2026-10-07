// scripts/smoke-autonomy.mjs
//
// REAL installed-DSH offline probe for the autonomy product connection
// (contract supervisor-event-wake-v1; release 1.3.0 / adapter 0.5.0).
//
// Run by the controller:  node scripts/smoke-autonomy.mjs <directory containing node_modules/@deepseek-ai/dsh>
//
// Guarantees:
//   * only FRESH temporary DSH homes inside the provided DSH installation directory
//     are used; no production profile, no global settings, no existing session;
//   * the installed DSH (0.1.7-rc.2 by default) is launched on an ephemeral port with
//     an offline synthetic model from test/fixtures/autonomy-provider.mjs: no paid API
//     call, no network dependency, no GPU work;
//   * the bridge is installed into each isolated profile with the REAL host config,
//     including the serializable `eventWake` option, so the actual `mountBridge`
//     wiring is what produces the outbox records;
//   * ordinary `scope.allowedTools` names only ordinary preflight tools (`read`, and
//     the host-classified owned-job `job_output`/`job_kill` where a job is granted).
//     The bridge-owned synthetic tools (`dsh_child_*`, `dsh_bridge_reply`,
//     `dsh_job_start`) are registered additively by the matching packet grant and are
//     NEVER named in `allowedTools`;
//   * it NEVER performs a real Codex send. The wake runner is exercised only with an
//     injected fake client against the real outbox, and that check never claims a
//     delivery.
//
// Every check records the real observation it made. A scenario that cannot run (for
// example a host seam that refuses) is recorded as `passed:false` with its concrete
// evidence instead of being reported as a success.
//
// Live-work observation uses the fields the bridge really persists: the supervisor's
// child ledger (`task.children`) and the adapter's owned-job record (`task.commandJobs`,
// written at job start). The settlement-only `activeChildren`/`activeJobs` counters are
// never polled for liveness, and a settled `unknown` is never treated as a confirmed
// stop. When a product seam really refuses (for example a host that cannot start a
// controlled child), the check records the exact refusal, cancels its own probe and
// waits for a confirmed stop with zero live work: the run stays nonzero instead of
// turning the refusal into a pass.
//
// Two fresh temporary hosts are started and stopped by this script:
//   host A (production-shaped `maxConcurrent: 16`) runs the ordinary worker, the real
//   child session and reply, the real denial checks, the per-task child cap, the
//   fixed-profile job and the cancellation-of-live-descendants/job checks;
//   host B (`maxConcurrent: 2`) proves that roots and children share ONE global
//   admission ledger, separately from the configured 16.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import { install } from './install.mjs';
import { resolveTargetOutboxDir, wakeTargetDirName } from '../src/wake-integration.mjs';
import { createWakeOutbox } from '../src/wake-outbox.mjs';
import { runWakeRunner } from '../bin/wake-codex.mjs';

export const DEFAULT_DSH_VERSION = '0.1.7-rc.2';
const TARGET = '01a0e7a9-7906-7280-86a5-abca2e6bca27';
const GRANT_ID = 'originating-chat';
const AUTHORITY = Object.freeze({ root: true, source: 'trusted-controller' });
const PROVIDER = 'bridge-autonomy-mock';
const CONTRACT = 'supervisor-event-wake-v1';
// `unknown` is a settled word but NEVER a stop: the host records it exactly when the
// stop could not be proven. Settlement detection uses TERMINAL; every pass/cleanup gate
// uses a terminal completed|failed|cancelled status PLUS the host's stopConfirmed and
// zero live jobs and children.
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const STOPPED = new Set(['completed', 'failed', 'cancelled']);
const CHILD_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const isTerminal = (task) => TERMINAL.has(task?.status);
const isConfirmedStop = (task) =>
  STOPPED.has(task?.status) &&
  task?.stopConfirmed === true &&
  Number(task?.activeJobs ?? 0) === 0 &&
  Number(task?.activeChildren ?? 0) === 0;
// `bridge_check` returns the durable store view. The supervisor persists the child
// ledger live, and the adapter persists `commandJobs` when a real owned job starts, so
// those are the fields that can prove live work; `activeChildren`/`activeJobs` are
// written at settlement and must never be polled for liveness.
const childrenOf = (task) => (Array.isArray(task?.children) ? task.children : []);
// EXECUTION, not reservation: a child counts as running only when the supervisor's own
// ledger says `running` AND the published session identity exists. A `starting`
// reservation with a null sessionId holds a capacity slot but proves nothing about the
// child actually executing, so it must never satisfy a live-execution probe.
const runningChildrenOf = (task) =>
  childrenOf(task).filter(
    (child) => child?.state === 'running' && typeof child?.sessionId === 'string' && child.sessionId.length > 0,
  );
const failedChildrenOf = (task) => childrenOf(task).filter((child) => child?.state === 'failed');
/**
 * The offline provider's own record of a REAL child-session model invocation. The
 * fixture appends one line per `stream()` call and marks the ones whose history carries
 * the adapter's child prompt, so this corroborates execution independently of the
 * bridge's persisted child ledger.
 */
const childInvocations = (root) => readCalls(root).filter((entry) => entry.child === true);
const ownedJobsOf = (task) => (Array.isArray(task?.commandJobs) ? task.commandJobs : []);
const liveJobsOf = (task) => ownedJobsOf(task).filter((job) => job?.state === 'running' || job?.state === 'stopping');

const source = path.resolve(import.meta.dirname, '..');
const dshRoot = path.resolve(process.argv[2] ?? process.cwd());
const dshBin = path.join(dshRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
assert.ok(fs.existsSync(dshBin), 'Provide the DSH installation directory that contains node_modules/@deepseek-ai/dsh');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readCalls(root) {
  const file = path.join(root, 'calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** One raw JSON-RPC call against a live host endpoint (never logged). */
async function rpc(endpoint, token, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!body.error, JSON.stringify(body.error));
  return body.result;
}

/**
 * The payload of one `tools/call` result. The bridge serialises the same value twice
 * (`structuredContent` and the JSON text in `content`); a differently wrapped host may
 * carry only one of them, so both are consumed, and a non-JSON text payload is
 * surfaced as `{text}` instead of being dropped. A host-level refusal is thrown with
 * its real text, never parsed into a fake success.
 */
function toolPayload(result, name = 'tool') {
  if (result === null || typeof result !== 'object') throw new Error(`${name}: the host returned no result object`);
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join('');
  if (result.isError === true) {
    throw new Error(`${name}: the bridge refused the call: ${String(text.length > 0 ? text : JSON.stringify(content)).slice(0, 600)}`);
  }
  const structured = result.structuredContent;
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured)) return structured;
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* the payload is plain text */
  }
  return { text };
}

/** One named bridge tool call against a launched host. */
async function callTool(host, name, args = {}) {
  return toolPayload(await rpc(host.endpoint, host.token, 'tools/call', { name, arguments: args }), name);
}

/**
 * The complete `bridge_result` text: the tool slices a long result, so every slice is
 * followed until the host reports no more text. Evidence, checks and uncertainties come
 * from the first slice and are never dropped.
 */
async function readResult(call, taskId) {
  const first = await call('bridge_result', { taskId });
  let text = typeof first.text === 'string' ? first.text : '';
  let next = Number.isInteger(first.nextOffset) ? first.nextOffset : text.length;
  for (let slice = 0; slice < 20 && first.hasMore === true; slice += 1) {
    const page = await call('bridge_result', { taskId, offset: next, limit: 20000 });
    const part = typeof page.text === 'string' ? page.text : '';
    if (part.length === 0) break;
    text += part;
    next = Number.isInteger(page.nextOffset) ? page.nextOffset : text.length;
    if (page.hasMore !== true) break;
  }
  return { ...first, text };
}

/** Bounded per-scenario progress on stderr, so the stdout report stays valid JSON. */
function progress(line) {
  try {
    process.stderr.write(`[autonomy-smoke] ${String(line).slice(0, 300)}\n`);
  } catch {
    /* progress output is diagnostics only */
  }
}

/** Start one fresh temporary DSH host with the bridge installed and mounted. */
async function launchHost({ rootPrefix, makeConfig }) {
  const root = fs.mkdtempSync(path.join(dshRoot, rootPrefix));
  const home = path.join(root, 'home');
  const profile = path.join(home, 'profiles/web');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'allowed.txt'), 'BRIDGE_AUTONOMY_ALLOWED_CONTENT');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'BRIDGE_AUTONOMY_OUTSIDE_MUST_NOT_BE_READ');
  fs.copyFileSync(path.join(source, 'test/fixtures/autonomy-provider.mjs'), path.join(root, 'provider.mjs'));

  const hostConfig = makeConfig({ root, home, profile, cwd });
  const token = randomBytes(32).toString('base64url');
  fs.writeFileSync(hostConfig.credentialFile, token, { mode: 0o600 });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({
      name: 'bridge-autonomy-profile',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }),
  );
  fs.writeFileSync(
    path.join(profile, 'cordis.patch.yml'),
    `- insert:\n    - id: bridge-autonomy-mock\n      name: ${JSON.stringify(path.join(root, 'provider.mjs'))}\n`,
  );

  await install({ sourceDir: source, profileDir: profile, requireHostEntry: true, hostConfig });

  const logPath = path.join(root, 'host.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [dshBin, 'web', '--port', '0', '--no-open'], {
    cwd: dshRoot,
    env: { ...process.env, DSH_HOME: home },
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  const exited = once(child, 'exit');

  let endpoint;
  try {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`DSH exited during startup; inspect ${logPath}`);
      const content = fs.readFileSync(logPath, 'utf8');
      const address = content.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (address) {
        endpoint = `${address}/mcp/codex-bridge-v1`;
        try {
          await rpc(endpoint, token, 'ping', {});
          break;
        } catch {
          endpoint = undefined;
        }
      }
      await sleep(200);
    }
    assert.ok(endpoint, 'DSH startup timed out');
  } catch (error) {
    // Stop ONLY this freshly spawned temporary host before propagating the launch
    // failure: a failed launch must never leave its own DSH process behind.
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await Promise.race([exited, sleep(5000)]);
    progress(`launch failed (${rootPrefix}): ${String(error?.message ?? error)}`);
    throw error;
  }

  let stopped = false;
  return {
    root,
    home,
    profile,
    cwd,
    endpoint,
    token,
    logPath,
    /** Whether this host's own stop already ran (normal path); cleanup can skip it. */
    isStopped: () => stopped,
    /** Stop ONLY this fresh temporary host. Idempotent. */
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
      await Promise.race([exited, sleep(5000)]);
    },
  };
}

async function main() {
  const report = {
    dsh: readJson(path.join(dshRoot, 'node_modules/@deepseek-ai/dsh/package.json'), {}).version ?? 'unknown',
    dshExpected: DEFAULT_DSH_VERSION,
    bridge: readJson(path.join(source, 'package.json'), {}).version ?? 'unknown',
    adapter: '0.5.0',
    provider: 'offline synthetic model (test/fixtures/autonomy-provider.mjs); no paid API call',
    hosts: [],
    target: TARGET,
    checks: [],
    notExecuted: [
      'no real Codex send was performed: the wake runner is exercised only with an injected fake client, and its unknown-only outcome is never reported as delivered',
      'no production profile, global setting, GPU or paid model was used',
    ],
  };
  // Await-aware so an asynchronous check records its own failure instead of a
  // resolved-but-unobserved Promise being reported as a pass.
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      report.checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
      progress(`PASS ${name}`);
      return true;
    } catch (error) {
      report.checks.push({ name, passed: false, error: String(error?.stack ?? error) });
      progress(`FAIL ${name}: ${String(error?.message ?? error).slice(0, 160)}`);
      return false;
    }
  };

  const hosts = [];
  // One scenario runs to completion even when a later independent scenario fails:
  // a hard throw (a task that never settles, or a typed submit refusal) is recorded
  // as its own failed check so the remaining probes still produce evidence.
  const scenario = async (label, fn) => {
    progress(`scenario start: ${label}`);
    try {
      await fn();
      progress(`scenario done: ${label}`);
    } catch (error) {
      report.checks.push({ name: `${label} (scenario aborted)`, passed: false, error: String(error?.stack ?? error) });
      progress(`scenario ABORTED: ${label}: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  };
  try {
    /* ================================================================== host A */
    const hostA = await launchHost({
      rootPrefix: '.bridge-autonomy-a-',
      makeConfig: ({ root, cwd }) => ({
      dataDirectory: path.join(root, 'state'),
      credentialFile: path.join(root, 'bridge-token'),
      ownerId: 'codex-bridge-autonomy',
      agentPreset: 'standard',
      // The production configuration this user runs. The ordinary default (4) is
      // untouched in source; this fixture only proves the configured 16 is preserved.
      maxConcurrent: 16,
      childSessions: { enabled: true, maxDepth: 1, maxChildrenPerTask: 2, waitTimeoutMs: 200, maxWaitTimeoutMs: 2000 },
      commandJobs: { enabled: true, maxJobsPerTask: 1 },
      commandProfiles: [
        {
          id: 'autonomy-echo',
          executable: process.execPath,
          argv: ['-e', 'console.log("BRIDGE_AUTONOMY_JOB_OK")'],
          cwd,
          env: {},
          timeoutMs: 5000,
          maxOutputBytes: 4096,
        },
        {
          id: 'autonomy-wait',
          executable: process.execPath,
          argv: ['-e', 'console.log("BRIDGE_AUTONOMY_JOB_STARTED"); setTimeout(() => console.log("BRIDGE_AUTONOMY_JOB_LATE"), 30000)'],
          cwd,
          env: {},
          timeoutMs: 60000,
          maxOutputBytes: 4096,
        },
      ],
      commandAllowedRoots: [root],
      // The serializable product connection: the real BridgeSupervisor sink enqueues
      // into the real durable outbox, one directory per trusted target.
      eventWake: { enabled: true, stateRoot: path.join(root, 'wake-state'), maxSummaryChars: 8192, claimLeaseMs: 30000 },
      // The ONLY grant map. A worker never supplies a destination.
      rootCallbackGrants: { [GRANT_ID]: { targetId: TARGET } },
      }),
    });
    const stateRootA = path.join(hostA.root, 'wake-state');
    hosts.push(hostA);
    report.hosts.push({ role: 'main', root: hostA.root, maxConcurrent: 16 });

    const callA = async (name, args = {}) => callTool(hostA, name, args);
    const waitTask = async (taskId, timeoutMs = 180000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { task } = await callA('bridge_check', { taskId });
        if (isTerminal(task)) return task;
        if (Date.now() > deadline) throw new Error(`task ${taskId} did not settle (status ${task.status})`);
        await sleep(200);
      }
    };
    /**
     * Bounded observation of a running probe. Returns the first state that satisfies
     * `predicate`, or the state in which the attempt settled, or the last state at the
     * deadline. It never throws on settlement and never infers a stop from a cancel
     * request, so the caller can report the real refusal or outcome.
     */
    const observe = async (call, taskId, predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { task, events } = await call('bridge_check', { taskId, limit: 200 });
        const seen = { task, events: Array.isArray(events) ? events : [], label };
        if (typeof predicate === 'function' && predicate(task, seen.events) === true) return { ...seen, observed: true, settled: false, timedOut: false };
        if (isTerminal(task)) return { ...seen, observed: false, settled: true, timedOut: false };
        if (Date.now() > deadline) return { ...seen, observed: false, settled: false, timedOut: true };
        await sleep(200);
      }
    };
    /**
     * Bounded POST-STOP event/state observation. The child ledger settles synchronously
     * with the confirmed stop, but the adapter emits `child/settled` from an asynchronous
     * teardown continuation (`void this.#settleChild(...)` after the child's own
     * `turn/end`), so the immediate post-stop event page can already be terminal and still
     * lack that event. Unlike `observe`, this keeps rereading state+events until the
     * predicate holds or the bounded deadline passes: it never stops early on a terminal
     * task, never sleeps unboundedly, and a timeout stays an observable failure.
     */
    const observeEventsAfterStop = async (call, taskId, predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      const started = Date.now();
      let seen = { task: null, events: [], label };
      for (;;) {
        const { task, events } = await call('bridge_check', { taskId, limit: 200 });
        seen = { task, events: Array.isArray(events) ? events : [], label };
        if (typeof predicate === 'function' && predicate(task, seen.events) === true) {
          return { ...seen, observed: true, timedOut: false, waitedMs: Date.now() - started };
        }
        if (Date.now() > deadline) return { ...seen, observed: false, timedOut: true, waitedMs: Date.now() - started };
        await sleep(200);
      }
    };
    /**
     * Cancel this probe when it is not already stopped, then wait for the host to prove
     * a confirmed stop with zero live jobs and children. A cancel REQUEST is never a
     * stop, and an already-settled unconfirmed task can no longer change.
     */
    const confirmStop = async (call, taskId, { reason, timeoutMs = 90000 } = {}) => {
      const first = (await call('bridge_check', { taskId })).task;
      if (isConfirmedStop(first)) return { task: first, confirmed: true };
      if (isTerminal(first)) return { task: first, confirmed: false };
      try {
        await call('bridge_cancel', { taskId, reason });
      } catch {
        /* the observed state below decides */
      }
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { task } = await call('bridge_check', { taskId });
        if (isConfirmedStop(task)) return { task, confirmed: true };
        if (isTerminal(task)) return { task, confirmed: false };
        if (Date.now() > deadline) return { task, confirmed: false };
        await sleep(200);
      }
    };
    let packetSeq = 0;
    const submit = async ({ model, allowedTools = ['read'], childSessions, backgroundJobs, rootCallback, cwd = hostA.cwd }) => {
      packetSeq += 1;
      return await callA('bridge_submit', {
        packet: {
          schemaVersion: 1,
          idempotencyKey: `autonomy-${model}-${packetSeq}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          revision: 1,
          projectId: 'autonomy',
          title: `Autonomy offline probe ${model}`,
          objective: 'Run the bounded offline autonomy probe and report exactly what happened.',
          cwd,
          role: 'investigate',
          acceptance: ['The probe reports its real observable evidence.'],
          scope: {
            readRoots: [cwd],
            writeRoots: [],
            allowedTools,
            allowShell: false,
            allowNetwork: false,
            allowDelegation: false,
            ...(childSessions === undefined ? {} : { childSessions }),
            ...(backgroundJobs === undefined ? {} : { backgroundJobs }),
          },
          ...(rootCallback === undefined ? {} : { rootCallback }),
          materials: [],
          contractVersion: CONTRACT,
          model: { provider: PROVIDER, model },
          budget: { timeoutMs: 180000, maxToolCalls: 40, maxOutputChars: 60000 },
        },
      });
    };

    /* ------------------------------------------------- A0: real host surface */
    const initialized = await rpc(hostA.endpoint, hostA.token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'autonomy-smoke', version: '1' },
    });
    await check('the installed DSH host mounts the 1.5.0 bridge over normal MCP', () => {
      assert.equal(initialized.serverInfo.version, '1.5.0');
      return { serverInfo: initialized.serverInfo };
    });

    const capabilities = await callA('bridge_capabilities');
    await check('capabilities report the real integrated producer, the granted seams and the configured 16', () => {
      assert.equal(capabilities.maxConcurrent, 16, 'the configured production concurrency is preserved');
      assert.equal(capabilities.version, '1.5.0');
      assert.equal(capabilities.adapterVersion, '0.5.0');
      assert.equal(capabilities.eventWake?.producer, true, 'the mount must report its real eventWake producer');
      assert.equal(capabilities.eventWake?.outboxConfigured, true);
      assert.equal(capabilities.eventWake?.liveTransport, 'unknown');
      assert.equal(capabilities.eventWake?.runnerAvailable, 'unknown');
      assert.equal(capabilities.eventWake?.liveAck, 'unknown');
      assert.equal(capabilities.supervisor?.notification?.supported, true);
      assert.deepEqual(capabilities.supervisor?.notification?.targets, [
        { grantId: GRANT_ID, targetId: TARGET, dir: resolveTargetOutboxDir({ stateRoot: stateRootA, targetId: TARGET }), outboxCreated: false },
      ]);
      // Inventory (live children) and adapter SUPPORT are separate fields and both must
      // survive the dispatcher: read support from supervisor.capabilities, never from
      // the inventory array.
      assert.ok(Array.isArray(capabilities.supervisor?.children), 'the live child inventory must stay an array');
      assert.equal(capabilities.supervisor?.capabilities?.children?.supported, true, 'the real agents.create child seam must be reported');
      assert.equal(capabilities.supervisor?.capabilities?.children?.lineage, 'agents.create');
      assert.equal(capabilities.supervisor?.capabilities?.jobs?.supported, true, 'the real owned job registry must be reported');
      assert.equal(capabilities.supervisor?.capabilities?.reply?.supported, true, 'the granted root reply seam must be reported');
      assert.equal(capabilities.supervisor?.ledger?.limit, 16);
      return {
        maxConcurrent: capabilities.maxConcurrent,
        eventWake: capabilities.eventWake,
        inventoryChildren: capabilities.supervisor?.children?.length,
        children: capabilities.supervisor?.capabilities?.children,
        jobs: { supported: capabilities.supervisor?.capabilities?.jobs?.supported, jobsRegistryReady: capabilities.supervisor?.capabilities?.jobs?.jobsRegistryReady },
        reply: capabilities.supervisor?.capabilities?.reply,
        ledger: capabilities.supervisor?.ledger,
      };
    });

    const outboxDir = resolveTargetOutboxDir({ stateRoot: stateRootA, targetId: TARGET });
    await check('the configured outbox directory matches the host-reported one', () => {
      const reported = capabilities.eventWake.targets[0].dir;
      assert.equal(reported, outboxDir);
      assert.equal(path.basename(outboxDir), wakeTargetDirName(TARGET));
      return { outboxDir };
    });

    /* ------------------------------------- A1: ordinary worker, unchanged path */
    await scenario('ordinary worker', async () => {
      const submitted = await submit({ model: 'ordinary' });
      const task = await waitTask(submitted.id);
      await check('an ordinary worker still executes, settles and reports through the unchanged path', () => {
        assert.equal(task.status, 'completed');
        assert.equal(task.stopConfirmed, true);
        assert.equal(task.activeJobs, 0);
        assert.equal('result' in task, false, 'bridge_check must not expose the result; use bridge_result');
        return { events: 'bridge_check returns task state; result comes from bridge_result' };
      });
      await check('bridge_result is the result source and the ordinary session saw only ordinary tools', async () => {
        const result = await readResult(callA, task.id);
        assert.match(result.text, /AUTONOMY_TEXT_OK/);
        const parentCalls = readCalls(hostA.root).filter((entry) => entry.model === 'ordinary' && entry.child === false);
        assert.ok(parentCalls.length >= 1, 'the ordinary model must have run as a real session');
        for (const entry of parentCalls) {
          assert.ok(entry.tools.includes('read'), 'the ordinary worker keeps its ordinary read tool');
          // The native `subagent` tool can stay VISIBLE: the installed host exposes only
          // a global tool-presentation layer, so its presence is not a per-task grant and
          // is never treated as denial. Real delegation denial is proven by the denial
          // scenario, which actually dispatches the call and reads the error result.
          assert.equal(entry.tools.includes('pwsh') || entry.tools.includes('bash'), false, 'no shell tool may be offered');
          assert.equal(entry.tools.some((name) => name.startsWith('dsh_child_') || name === 'dsh_bridge_reply' || name === 'dsh_job_start'), false, 'no synthetic bridge tool may be granted without a scope grant');
        }
        const lastOrdinary = parentCalls.at(-1);
        assert.equal(fs.existsSync(path.join(hostA.root, 'child-id.txt')), false, 'the fixture must not depend on an external child-id file');
        return { text: result.text.slice(0, 120), tools: lastOrdinary.tools, subagentVisible: lastOrdinary.tools.includes('subagent') };
      });
    });

    /* ------------------------------- A2: real child session + real root reply */
    let childIdObserved = null;
    await scenario('real child session + reply', async () => {
      const submitted = await submit({
        model: 'child-agent',
        rootCallback: { grantId: GRANT_ID },
        childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] },
      });
      const task = await waitTask(submitted.id);
      const { events } = await callA('bridge_check', { taskId: submitted.id, limit: 200 });
      await check('a real child session runs through agents.create, waits boundedly and its result reaches the parent', async () => {
        assert.equal(task.status, 'completed', `task status was ${task.status}`);
        assert.equal(task.stopConfirmed, true);
        assert.equal(task.activeJobs, 0);
        assert.equal(task.activeChildren ?? 0, 0, 'no child may remain live after settlement');
        const result = await readResult(callA, submitted.id);
        // A refused spawn is surfaced by the fixture as CHILD_SPAWN_REFUSED so this check
        // fails immediately with the host's exact refusal instead of a later mismatch.
        assert.equal(result.text.includes('CHILD_SPAWN_REFUSED'), false, `the real child spawn was refused by the host: ${result.text.slice(0, 600)}`);
        assert.ok(Array.isArray(task.children) && task.children.length === 1, 'the bridge_check view must expose the real child');
        childIdObserved = task.children[0].childId;
        assert.ok(typeof childIdObserved === 'string' && childIdObserved.length > 0);
        assert.ok(task.children[0].state === 'completed' || task.children[0].state === 'cancelled', `child state was ${task.children[0].state}`);
        const kinds = events.map((event) => event.type);
        assert.ok(kinds.includes('child/starting'), `expected a child/starting event, saw ${kinds.join(',')}`);
        assert.ok(kinds.includes('child/settled'), `expected a child/settled event, saw ${kinds.join(',')}`);
        assert.match(result.text, /ROOT_DONE/, 'the parent must finish after collecting the child');
        assert.match(result.text, /CHILD_DONE/, 'the real child result must reach the parent');
        assert.match(result.text, /BRIDGE_AUTONOMY_ALLOWED_CONTENT/, 'the child must have read the allowed file through the real host tool');
        assert.equal(result.text.includes('BRIDGE_AUTONOMY_OUTSIDE_MUST_NOT_BE_READ'), false, 'no out-of-root content may leak');
        const calls = readCalls(hostA.root);
        const childCalls = calls.filter((entry) => entry.model === 'child-agent' && entry.child === true);
        assert.ok(childCalls.length >= 1, 'the child model must have run as a real session');
        for (const entry of childCalls) {
          assert.ok(entry.tools.includes('read'), 'the child keeps its attenuated read tool');
          // The native `subagent` tool can stay visible on the child too (global
          // presentation only); the real child delegation denial is the dispatch the
          // denial scenario performs and observes as an error result.
          assert.equal(entry.tools.includes('pwsh') || entry.tools.includes('bash'), false, 'the child must not see a shell tool');
          assert.equal(entry.tools.some((name) => name.startsWith('dsh_child_')), false, 'the child must not be able to delegate further');
          assert.equal(entry.tools.includes('dsh_bridge_reply'), false, 'the child must not be able to wake the root');
          assert.equal(entry.tools.includes('job_output') || entry.tools.includes('dsh_job_start'), false, 'owned-job tools stay unavailable to a child');
        }
        const parentCalls = calls.filter((entry) => entry.model === 'child-agent' && entry.child === false);
        assert.ok(parentCalls.some((entry) => entry.tools.includes('dsh_child_spawn')), 'the opted-in root must see the child tools');
        assert.ok(parentCalls.some((entry) => entry.tools.includes('dsh_bridge_reply')), 'the callback-granted root must see the reply tool');
        return { childId: childIdObserved, childState: task.children[0].state, childSessions: childCalls.length, eventKinds: [...new Set(kinds)].slice(0, 20) };
      });
    });

    /* ----------------------------------------- A3: explicit real denials */
    await scenario('explicit real denials', async () => {
      const submitted = await submit({
        model: 'denial',
        childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] },
      });
      const task = await waitTask(submitted.id);
      await check('out-of-root reads, the native subagent tool and scope widening are really denied for root and child', async () => {
        assert.equal(task.status, 'completed', `task status was ${task.status}`);
        assert.equal(task.stopConfirmed, true);
        const result = await readResult(callA, submitted.id);
        const text = result.text;
        assert.match(text, /DENIAL_DONE/, 'the denial root must report its real observations');
        // The INITIAL denial child and the LATER deliberately widening spawn are separate
        // operations, and the fixture labels them separately. The initial child must have
        // really started and run; the widening request is independently refused, never
        // clamped, never accepted, and never proof that the initial child failed.
        assert.match(text, /initial=spawned/, `the initial denial child must have started: ${text.slice(0, 600)}`);
        assert.equal(text.includes('initial=CHILD_SPAWN_REFUSED'), false, `the initial denial child spawn was refused by the host: ${text.slice(0, 600)}`);
        assert.match(text, /widening=WIDENING_SPAWN_REFUSED/, `the later widening spawn must be refused, never accepted: ${text.slice(0, 800)}`);
        assert.match(text, /CHILD_DENIAL_DONE/, 'the denial child must report its real observations');
        // The child's own evidence (carried in the parent's answer) must show its real
        // refused operations: the out-of-root read, the native subagent delegation and the
        // further-delegation attempt all failed as `isError` results, while its allowed
        // read still succeeded.
        assert.match(
          text,
          /CHILD_DENIAL_DONE outsideRefused=true nativeDelegationRefused=true delegationRefused=true allowedRead=true/,
          `the denial child must report its real refused operations: ${text.slice(0, 900)}`,
        );
        assert.match(text, /read target [\s\S]* resolves outside this task's readRoots/, 'the root out-of-root read must be refused by the real fence');
        assert.match(text, /read target [\s\S]* resolves outside this child grant's readRoots/, 'the child out-of-root read must be refused by its own fence');
        // The native subagent call must produce a REAL failed tool result, whether the
        // host reports the adapter guard's delegation refusal or its own unknown-tool
        // refusal for a tool the allowlist withholds. The fixture labels either one.
        assert.match(text, /subagent\[error\]/, 'the native subagent call must return a real error result');
        assert.match(text, /(denied|disabled|unknown tool|not in this task's allowedTools|not available)/i, 'the subagent refusal must be explicit, never silently ignored');
        assert.match(text, /dsh_child_spawn\[error\]/, 'the child delegation attempt must return a real error result');
        assert.equal(Array.isArray(task.children) ? task.children.length : -1, 1, 'no grandchild may ever be created by the child');
        assert.match(text, /grant-widened|outside the immutable parent grant/, 'a widening child request must be refused, never clamped');
        assert.equal(text.includes('BRIDGE_AUTONOMY_OUTSIDE_MUST_NOT_BE_READ'), false, 'a denied read must never leak the target content');
        assert.match(text, /BRIDGE_AUTONOMY_ALLOWED_CONTENT/, 'the allowed read must still work after every refusal');
        // No native subagent may have actually started while being refused.
        const { events } = await callA('bridge_check', { taskId: submitted.id, limit: 200 });
        const startedDelegations = events.filter((event) => event.type === 'policy/violation' && event.violation === 'delegation-started');
        assert.equal(startedDelegations.length, 0, 'no native subagent may start for a task whose allowDelegation is false');
        return { text: text.slice(0, 600), eventKinds: [...new Set(events.map((event) => event.type))].slice(0, 20) };
      });
    });

    /* -------------------------------- A4: per-task child cap, not the global cap */
    await scenario('per-task child cap', async () => {
      const submitted = await submit({
        model: 'children-cap',
        childSessions: { enabled: true, maxChildren: 2, toolNames: ['read'] },
      });
      const task = await waitTask(submitted.id);
      await check('the per-task maxChildren grant refuses a third live child (never clamped) and still settles clean', async () => {
        assert.equal(task.status, 'completed', `task status was ${task.status}`);
        assert.equal(task.stopConfirmed, true);
        assert.equal(task.activeChildren ?? 0, 0, 'every cancelled child must be proven stopped before settlement');
        const result = await readResult(callA, submitted.id);
        assert.match(result.text, /CHILDREN_DONE/);
        // A first/second spawn failure is infrastructure, not the cap: fail with the
        // host's exact refusal instead of misreading it as the per-task cap refusal.
        assert.equal(result.text.includes('CHILDREN_SPAWN_REFUSED'), false, `a live child spawn was refused by the host: ${result.text.slice(0, 600)}`);
        assert.equal(result.text.includes('CHILDREN_NOT_LIVE'), false, `the two children were not live when the cap was tested: ${result.text.slice(0, 600)}`);
        // The per-task cap is about LIVE children: the fixture lists them before the
        // third spawn and reports that count, so a count of completed children cannot pass.
        assert.match(result.text, /liveAtRefusal=2/, 'the cap must be measured while two children are LIVE');
        assert.match(result.text, /autonomy-child-a/);
        assert.match(result.text, /autonomy-child-b/);
        assert.match(result.text, /supervisor\/child-limit|already has 2 live child/, `expected the typed per-task cap refusal in ${result.text.slice(0, 800)}`);
        assert.equal(Array.isArray(task.children) ? task.children.length : -1, 2, 'the refused third spawn must never create a child');
        return { text: result.text.slice(0, 500), children: task.children };
      });
    });

    /* ------------------------------------------- A5: fixed-profile owned job */
    await scenario('fixed-profile owned job', async () => {
      const submitted = await submit({
        model: 'job',
        allowedTools: ['read', 'job_output'],
        backgroundJobs: { enabled: true, profileIds: ['autonomy-echo', 'autonomy-wait'], maxJobs: 1 },
      });
      const task = await waitTask(submitted.id);
      await check('a real owned fixed-profile job reports its identity, output and status through the ordinary job tool', async () => {
        assert.equal(task.status, 'completed', `task status was ${task.status}: ${JSON.stringify(task.error ?? null)}`);
        assert.equal(task.stopConfirmed, true);
        assert.equal(task.activeJobs, 0, 'the job must be settled before the task settles');
        const result = await readResult(callA, submitted.id);
        const text = result.text;
        assert.match(text, /JOB_ROOT_DONE/, 'the job root must report its real observations');
        assert.match(text, /BRIDGE_AUTONOMY_JOB_OK/, 'the profile stdout must be observable through job_output');
        // The actual result shape: the fixture parses the real job_output read (structured
        // payload or the rendered `[status: <status>, <detail>]` line) and reports the
        // parsed fields. A bare `[status: X]` regex would miss the real detail suffix.
        const reported = /JOB_ROOT_DONE (\{[^\n]*\})/.exec(text);
        assert.ok(reported, `the fixture must report the parsed job fields: ${text.slice(0, 600)}`);
        let job = null;
        try {
          job = JSON.parse(reported[1]);
        } catch {
          job = null;
        }
        assert.ok(job !== null && typeof job === 'object', `the job report must be valid JSON: ${reported[1].slice(0, 300)}`);
        assert.ok(['completed', 'failed', 'killed'].includes(job.status), `job status ${job.status} is not a real terminal status`);
        assert.equal(job.jobOk, true, 'a terminal job read must carry BRIDGE_AUTONOMY_JOB_OK');
        assert.equal(job.foreignRefused, true, 'the foreign job read must be refused, never answered');
        assert.equal(typeof job.detail, 'string', 'the terminal read must carry its real detail');
        assert.match(job.detail, /exit code:\s*0/, `the terminal detail must be the profile exit code, saw ${job.detail}`);
        assert.match(text, /\[status:\s*completed\b[^\]]*\]/, 'the real rendered status line must remain visible');
        assert.match(text, /job_output\[error\][^|]*job-offline-foreign-000000000000/, 'the foreign job read must be refused inside its own result, never answered');
        return { text: text.slice(0, 700), job };
      });
    });

    /* ------------------- A6: cancellation of live descendants and a live job */
    await scenario('cancellation of a live child tree', async () => {
      // Baseline BEFORE this probe: corroboration must be an invocation THIS scenario
      // caused, not one left behind by an earlier scenario on the same host.
      const childCallsBefore = childInvocations(hostA.root).length;
      const submitted = await submit({
        model: 'live-child',
        childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] },
      });
      // Observe the REAL live descendant — a `running` child carrying a published
      // sessionId AND corroborated by the offline provider's own child invocation — or a
      // real refusal, or the attempt settling. A `starting` capacity reservation and the
      // settlement-only `activeChildren` field are never polled for liveness.
      const childCallsNow = () => childInvocations(hostA.root).length - childCallsBefore;
      const seen = await observe(
        callA,
        submitted.id,
        (task) =>
          (runningChildrenOf(task).length >= 1 && childCallsNow() >= 1) ||
          failedChildrenOf(task).length >= 1,
        90000,
        'live child start',
      );
      const live = runningChildrenOf(seen.task);
      if (live.length === 0) {
        // The child seam really refused (or the root settled first): cancel this probe,
        // prove a confirmed stop with zero live work, and keep the failure with the
        // exact refusal instead of a scenario abort.
        const stop = await confirmStop(callA, submitted.id, { reason: 'offline smoke: the live child tree was never live' });
        const result = stop.confirmed ? await readResult(callA, submitted.id).catch(() => null) : null;
        await check('a real live descendant is observable before cancellation', () => {
          assert.fail(
            `the live child tree was never RUNNING (${seen.observed ? 'the child spawn really failed' : seen.settled ? 'the attempt settled first' : 'the observation timed out'}); children=${JSON.stringify(childrenOf(seen.task))}; childModelInvocations=${childCallsNow()}; after cancel: status=${stop.task.status} stopConfirmed=${stop.task.stopConfirmed} activeChildren=${stop.task.activeChildren ?? 0} activeJobs=${stop.task.activeJobs ?? 0}; result=${String(result?.text ?? '(no result)').slice(0, 600)}`,
          );
        });
        await check('cancelling the root cancels its live descendants and confirms the stop', () => {
          assert.fail(
            `no live descendant existed to cancel; final state status=${stop.task.status} stopConfirmed=${stop.task.stopConfirmed} activeChildren=${stop.task.activeChildren ?? 0} activeJobs=${stop.task.activeJobs ?? 0}`,
          );
        });
        return;
      }
      await check('a real live descendant is observable before cancellation', () => {
        assert.ok(live.length >= 1, 'the bridge_check view must expose the live child');
        for (const child of live) {
          assert.equal(typeof child.sessionId, 'string', `a running child must carry its published sessionId: ${JSON.stringify(child)}`);
          assert.ok(child.sessionId.length > 0, 'a running child must have a real sessionId, never a bare reservation');
        }
        assert.ok(
          childCallsNow() >= 1,
          'the offline provider must have really invoked the child session before liveness is claimed',
        );
        return { children: childrenOf(seen.task), liveChildren: live.length, childModelInvocations: childCallsNow() };
      });
      const stopped = await confirmStop(callA, submitted.id, { reason: 'offline smoke: cancel a live child tree' });
      await check('cancelling the root cancels its live descendants and confirms the stop', async () => {
        assert.equal(
          stopped.confirmed,
          true,
          `no confirmed stop: status=${stopped.task.status} stopConfirmed=${stopped.task.stopConfirmed} activeJobs=${stopped.task.activeJobs ?? 0} activeChildren=${stopped.task.activeChildren ?? 0}`,
        );
        assert.equal(stopped.task.status, 'cancelled', `task status was ${stopped.task.status}`);
        assert.equal(stopped.task.stopConfirmed, true);
        assert.equal(stopped.task.activeJobs, 0);
        assert.equal(stopped.task.activeChildren ?? 0, 0);
        const children = childrenOf(stopped.task);
        assert.ok(children.length >= 1, 'the cancelled descendant must stay visible in the child ledger');
        for (const child of children) assert.ok(CHILD_TERMINAL.has(child.state), `child ${child.childId} stayed ${child.state}`);
        // Preserve the durable stop-request evidence: the confirmed stop must be the
        // result of a real child stop request, not inferred from task settlement alone.
        const immediate = await callA('bridge_check', { taskId: submitted.id, limit: 200 });
        const immediateKinds = (Array.isArray(immediate.events) ? immediate.events : []).map((event) => event.type);
        assert.ok(
          immediateKinds.includes('child/stop-requested'),
          `the confirmed stop must carry its real child stop request, saw ${immediateKinds.join(',')}`,
        );
        // The adapter memoizes ONE settlement per child: a child's own `turn/end` starts
        // it and the parent's descendant cancel AWAITS that same settlement, so exactly
        // one `child/teardown` outcome and exactly one `child/settled` record are emitted
        // before the root task can reach its durable terminal status. The installed
        // bridge_check only persists adapter events while the task is not terminal, so a
        // settlement that landed after the stop was recorded would be a LOST settlement;
        // missing or duplicated evidence here is a real failure, never an accepted
        // absence. The bounded re-read still tolerates host event-delivery latency
        // instead of assuming the first post-stop page is complete.
        const settledSeen = await observeEventsAfterStop(
          callA,
          submitted.id,
          (task, events) =>
            events.filter((event) => event.type === 'child/settled').length === 1 &&
            events.some((event) => event.type === 'child/teardown' || event.type === 'child/teardown-failed'),
          15000,
          'one child/teardown outcome and one child/settled after confirmed stop',
        );
        const kinds = settledSeen.events.map((event) => event.type);
        const settledCount = kinds.filter((type) => type === 'child/settled').length;
        const teardownCount = kinds.filter((type) => type === 'child/teardown').length;
        const teardownFailedCount = kinds.filter((type) => type === 'child/teardown-failed').length;
        const missingSettlement = [];
        if (settledCount !== 1) missingSettlement.push(`child/settled=${settledCount}`);
        if (teardownCount + teardownFailedCount !== 1) {
          missingSettlement.push(`child/teardown=${teardownCount} child/teardown-failed=${teardownFailedCount}`);
        }
        assert.ok(
          settledSeen.observed && missingSettlement.length === 0,
          `expected exactly one child teardown outcome and exactly one child/settled before the cancelled task is treated as stopped (read for ${settledSeen.waitedMs}ms); missing/duplicated: ${missingSettlement.join(', ') || 'none'}; saw ${kinds.join(',')}`,
        );
        return {
          status: stopped.task.status,
          children,
          stopRequestedEvent: immediateKinds.includes('child/stop-requested'),
          childTeardownEvents: teardownCount + teardownFailedCount,
          childSettledEvents: settledCount,
          childSettledWaitedMs: settledSeen.waitedMs,
          eventKinds: [...new Set(kinds)].slice(0, 20),
        };
      });
    });

    await scenario('cancellation of a live job', async () => {
      const submitted = await submit({
        model: 'live-job',
        allowedTools: ['read', 'job_output'],
        backgroundJobs: { enabled: true, profileIds: ['autonomy-wait'], maxJobs: 1 },
      });
      // A real owned job is proven live from the fields the bridge actually persists: the
      // `job/started` event and the task's `commandJobs` entry, never the settlement-only
      // `activeJobs` counter.
      const seen = await observe(
        callA,
        submitted.id,
        (task, events) => liveJobsOf(task).length >= 1 && events.some((event) => event.type === 'job/started'),
        60000,
        'live job start',
      );
      const liveJobs = liveJobsOf(seen.task);
      const startedEvents = seen.events.filter((event) => event.type === 'job/started');
      if (liveJobs.length === 0 || startedEvents.length === 0) {
        // A job that never became observable live (for example a sandbox EPERM) is a
        // real failure: cancel this probe, prove a confirmed stop with zero live work,
        // and surface the real outcome.
        const stop = await confirmStop(callA, submitted.id, { reason: 'offline smoke: the live job was never observable' });
        const result = stop.confirmed ? await readResult(callA, submitted.id).catch(() => null) : null;
        await check('a real owned job is observed live before cancellation', () => {
          assert.fail(
            `no live owned job was observable (${seen.settled ? 'the attempt settled first' : 'the observation timed out'}); commandJobs=${JSON.stringify(ownedJobsOf(seen.task))}; jobStartedEvents=${startedEvents.length}; after cancel: status=${stop.task.status} stopConfirmed=${stop.task.stopConfirmed} activeJobs=${stop.task.activeJobs ?? 0}; result=${String(result?.text ?? '(no result)').slice(0, 600)}`,
          );
        });
        await check('cancelling the root kills its live owned job and confirms the stop', () => {
          assert.fail(
            `the live job probe never became live, so job cancellation could not be exercised; final state status=${stop.task.status} stopConfirmed=${stop.task.stopConfirmed} activeJobs=${stop.task.activeJobs ?? 0}`,
          );
        });
        return;
      }
      await check('a real owned job is observed live before cancellation', () => {
        assert.ok(liveJobs.length >= 1, 'the owned job must be counted live');
        assert.ok(startedEvents.length >= 1, 'the host must have reported job/started for the observed job');
        return { activeJobs: liveJobs.length, commandJobs: liveJobs, startedEvents: startedEvents.slice(0, 3) };
      });
      const stopped = await confirmStop(callA, submitted.id, { reason: 'offline smoke: cancel a live job' });
      await check('cancelling the root kills its live owned job and confirms the stop', () => {
        assert.equal(
          stopped.confirmed,
          true,
          `no confirmed stop: status=${stopped.task.status} stopConfirmed=${stopped.task.stopConfirmed} activeJobs=${stopped.task.activeJobs ?? 0}`,
        );
        assert.equal(stopped.task.status, 'cancelled', `task status was ${stopped.task.status}`);
        assert.equal(stopped.task.stopConfirmed, true);
        assert.equal(stopped.task.activeJobs, 0, 'no owned job may remain live after cancellation');
        return { status: stopped.task.status, activeJobs: stopped.task.activeJobs };
      });
    });

    /* --------------------------- A7: real producer outbox records (reply/settle) */
    await scenario('real producer outbox records', async () => {
      const records = [];
      const outbox = createWakeOutbox({ dir: outboxDir, authority: AUTHORITY, allowedTargetIds: [TARGET], maxSummaryChars: 8192 });
      try {
        for (const record of await outbox.listEvents()) records.push(record);
      } finally {
        await outbox.close();
      }
      await check('the ACTUAL mountBridge producer wrote genuine durable queued records for the reply and the settlement', () => {
        assert.ok(records.length >= 2, `expected a reply and a settlement record, saw ${records.length}`);
        for (const record of records) {
          assert.equal(record.targetId, TARGET, 'every record must be bound to the trusted target');
          assert.equal(record.state, 'pending', 'the producer only queues; it never claims delivery');
        }
        const reply = records.find((record) => record.kind === 'needs-input');
        assert.ok(reply, 'the dsh_bridge_reply event must be durable');
        assert.equal(reply.summary, '[needs-input] Offline smoke: root callback reply probe.', 'the durable reply must carry the honest reply-probe summary');
        const settlement = records.find((record) => record.kind === 'completed');
        assert.ok(settlement, 'the terminal completed settlement event must be durable');
        return { count: records.length, replyEventId: reply.eventId, settlementEventId: settlement.eventId };
      });

      await check('a queued producer record is not a delivered record, and the durable reply is deduplicated by event id', async () => {
        assert.equal(records.some((record) => record.state === 'delivered'), false);
        const outbox2 = createWakeOutbox({ dir: outboxDir, authority: AUTHORITY, allowedTargetIds: [TARGET], maxSummaryChars: 8192 });
        try {
          const first = records[0];
          const replay = await outbox2.enqueue({
            eventId: first.eventId,
            taskId: first.taskId,
            attemptId: first.attemptId,
            targetId: first.targetId,
            kind: first.kind,
            summary: first.summary,
            resultIds: first.resultIds ?? [],
          });
          assert.equal(replay.duplicate, true, 'a replay of the same durable event must dedupe');
          return { eventId: first.eventId, states: [...new Set(records.map((record) => record.state))] };
        } finally {
          await outbox2.close();
        }
      });

      // HONEST LABEL: this offline client can never prove a positive exact-target
      // acknowledgement, so the only truthful claim is that an unknown outcome is
      // never reported as delivered. Positive-ack interpretation is covered by
      // test/codex-wake-client.test.mjs against the real client with fake MCP
      // responses; this smoke does not duplicate it.
      await check('an offline client that cannot prove a positive exact-target ack leaves records unknown, never delivered', async () => {
        const outbox3 = createWakeOutbox({ dir: outboxDir, authority: AUTHORITY, allowedTargetIds: [TARGET], maxSummaryChars: 8192 });
        const deliveries = [];
        try {
          const stats = await runWakeRunner({
            outbox: outbox3,
            runnerId: 'smoke-fake-runner',
            once: true,
            logger: () => {},
            client: {
              async deliver(event) {
                deliveries.push(event.eventId);
                return { outcome: 'unknown', code: 'E_ACK_UNCONFIRMED', message: 'offline smoke never claims a delivery' };
              },
              async close() {},
            },
          });
          assert.ok(stats.claims >= 1, 'the runner must have claimed a queued event');
          assert.equal(stats.delivered, 0, 'no delivery may be claimed without a positive exact-target ack');
          for (const record of await outbox3.listEvents()) assert.equal(record.state, 'unknown', 'an unproven send stays unknown');
          return { attempted: deliveries.length, states: [...new Set((await outbox3.listEvents()).map((record) => record.state))] };
        } finally {
          await outbox3.close();
        }
      });
    });

    await check('every main-host probe task settled with a confirmed stop and zero live work', async () => {
      const before = (await callA('bridge_list', {})).tasks.filter((task) => task.projectId === 'autonomy');
      assert.ok(before.length >= 7, `expected all main scenarios, saw ${before.length}`);
      // Unknown is not a stop: explicitly cancel every probe task whose stop is not
      // already host-confirmed, then demand a confirmed stop with zero live work.
      const cancelled = [];
      for (const task of before.filter((entry) => !isConfirmedStop(entry))) {
        try {
          await callA('bridge_cancel', { taskId: task.id, reason: 'offline smoke: probe task still active at settlement' });
        } catch {
          /* already settled: the confirmed-stop assertion below decides */
        }
        const settled = await waitTask(task.id, 90000).catch(() => null);
        cancelled.push({ id: task.id, status: settled?.status ?? 'unknown', stopConfirmed: settled?.stopConfirmed === true });
      }
      const after = (await callA('bridge_list', {})).tasks.filter((task) => task.projectId === 'autonomy');
      for (const task of after) {
        assert.equal(
          isConfirmedStop(task),
          true,
          `${task.id} is not stopped: status=${task.status} stopConfirmed=${task.stopConfirmed} activeJobs=${task.activeJobs ?? 0} activeChildren=${task.activeChildren ?? 0}`,
        );
        assert.equal(task.activeJobs ?? 0, 0, `${task.id} still has live jobs`);
        assert.equal(task.activeChildren ?? 0, 0, `${task.id} still has live children`);
      }
      return { tasks: after.map((task) => ({ id: task.id, status: task.status, stopConfirmed: task.stopConfirmed })), cancelledAtSettlement: cancelled };
    });

    await hostA.stop();

    /* ================================================================== host B */
    /* Shared root+child admission with a SMALL configured cap, isolated from the
       configured 16 above. maxConcurrent is a host-level ledger limit, so this case
       needs its own fresh temporary host. */
    await scenario('small-cap shared root+child ledger', async () => {
    const hostB = await launchHost({
      rootPrefix: '.bridge-autonomy-b-',
      makeConfig: ({ root }) => ({
        dataDirectory: path.join(root, 'state'),
        credentialFile: path.join(root, 'bridge-token'),
        ownerId: 'codex-bridge-autonomy-small',
        agentPreset: 'standard',
        maxConcurrent: 2,
        childSessions: { enabled: true, maxDepth: 1, maxChildrenPerTask: 1, waitTimeoutMs: 200, maxWaitTimeoutMs: 2000 },
      }),
    });
    hosts.push(hostB);
    report.hosts.push({ role: 'small-cap', root: hostB.root, maxConcurrent: 2 });

    const callB = async (name, args = {}) => callTool(hostB, name, args);
    const waitTaskB = async (taskId, timeoutMs = 180000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { task } = await callB('bridge_check', { taskId });
        if (isTerminal(task)) return task;
        if (Date.now() > deadline) throw new Error(`task ${taskId} did not settle (status ${task.status})`);
        await sleep(200);
      }
    };
    const submitB = async ({ model, allowedTools = ['read'], childSessions }) =>
      await callB('bridge_submit', {
        packet: {
          schemaVersion: 1,
          idempotencyKey: `autonomy-small-${model}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          revision: 1,
          projectId: 'autonomy',
          title: `Autonomy small-cap probe ${model}`,
          objective: 'Probe the shared root+child admission ledger under a small configured cap.',
          cwd: hostB.cwd,
          role: 'investigate',
          acceptance: ['The probe reports its real observable evidence.'],
          scope: {
            readRoots: [hostB.cwd],
            writeRoots: [],
            allowedTools,
            allowShell: false,
            allowNetwork: false,
            allowDelegation: false,
            ...(childSessions === undefined ? {} : { childSessions }),
          },
          materials: [],
          contractVersion: CONTRACT,
          model: { provider: PROVIDER, model },
          budget: { timeoutMs: 180000, maxToolCalls: 20, maxOutputChars: 20000 },
        },
      });

    const smallCaps = await callB('bridge_capabilities');
    await check('the isolated small-cap host reports its own configured ledger limit', () => {
      assert.equal(smallCaps.maxConcurrent, 2);
      assert.equal(smallCaps.supervisor?.ledger?.limit, 2);
      assert.equal(smallCaps.supervisor?.capabilities?.children?.supported, true);
      return { maxConcurrent: smallCaps.maxConcurrent, ledgerLimit: smallCaps.supervisor?.ledger?.limit };
    });

    // Baseline BEFORE this probe: the corroborating provider invocation must belong to
    // THIS child, not to an earlier scenario on the same host.
    const childCallsBefore = childInvocations(hostB.root).length;
    const childCallsNow = () => childInvocations(hostB.root).length - childCallsBefore;
    const parentB = await submitB({
      model: 'smallcap',
      childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] },
    });
    // Observe the REAL live child — a `running` child carrying a published sessionId
    // AND corroborated by the offline provider's own child invocation — or a real
    // refusal, or the root settling. A `starting` reservation alone is capacity, never
    // execution, so it can not prove saturation here.
    const seenB = await observe(
      callB,
      parentB.id,
      (task) =>
        (runningChildrenOf(task).length >= 1 && childCallsNow() >= 1) ||
        failedChildrenOf(task).length >= 1,
      90000,
      'small-cap child start',
    );
    const liveB = runningChildrenOf(seenB.task);
    if (liveB.length === 0) {
      // The child seam really refused (or the root settled): release the shared slot,
      // prove a confirmed stop, and keep the nonzero failure with the exact refusal.
      const stop = await confirmStop(callB, parentB.id, { reason: 'offline smoke: the small-cap child never became live' });
      const result = stop.confirmed ? await readResult(callB, parentB.id).catch(() => null) : null;
      await check('a live root AND its live child consume the ONE shared global ledger', () => {
        assert.fail(
          `the small-cap child never became RUNNING (${seenB.observed ? 'the child spawn really failed' : seenB.settled ? 'the root settled first' : 'the observation timed out'}); children=${JSON.stringify(childrenOf(seenB.task))}; childModelInvocations=${childCallsNow()}; after cancel: status=${stop.task.status} stopConfirmed=${stop.task.stopConfirmed} activeChildren=${stop.task.activeChildren ?? 0} activeJobs=${stop.task.activeJobs ?? 0}; result=${String(result?.text ?? '(no result)').slice(0, 600)}`,
        );
      });
      await check('cancelling the saturated root releases its shared slot and the queued root then runs', () => {
        assert.fail(
          `the shared root+child ledger could not be exercised because the child never became live; final state status=${stop.task.status} stopConfirmed=${stop.task.stopConfirmed} activeChildren=${stop.task.activeChildren ?? 0}`,
        );
      });
      return;
    }

    await check('a live root AND its live child consume the ONE shared global ledger', async () => {
      const caps = await callB('bridge_capabilities');
      const ledger = caps.supervisor?.ledger;
      assert.equal(ledger?.limit, 2, 'the small configured cap must be the shared limit');
      assert.equal(ledger?.used, 2, `expected root+child to hold both slots, saw ${JSON.stringify(ledger)}`);
      assert.equal(ledger?.roots, 1, 'exactly one root slot must be held');
      assert.equal(ledger?.children, 1, 'the child must hold a slot in the SAME ledger, not a child-local one');
      assert.equal(ledger?.free, 0);
      // The child slot must be held by a child that is provably EXECUTING, not a bare
      // `starting` reservation: a published sessionId plus a real provider invocation.
      for (const child of liveB) {
        assert.equal(typeof child.sessionId, 'string', `the running child must carry its published sessionId: ${JSON.stringify(child)}`);
        assert.ok(child.sessionId.length > 0, 'a running child must have a real sessionId, never a bare reservation');
      }
      assert.ok(
        childCallsNow() >= 1,
        'the offline provider must have really invoked the small-cap child before saturation is claimed',
      );
      return { ledger, children: childrenOf(seenB.task), liveChildren: liveB.length, childModelInvocations: childCallsNow() };
    });

    const queued = await submitB({ model: 'ordinary' });
    await check('a second root stays queued while root+child saturate the shared cap', async () => {
      const deadline = Date.now() + 3000;
      let observed = null;
      while (Date.now() < deadline) {
        const { task } = await callB('bridge_check', { taskId: queued.id });
        observed = task.status;
        assert.equal(task.status, 'queued', `the second root must not be admitted while the ledger is full (saw ${task.status})`);
        await sleep(200);
      }
      return { queuedForMs: 3000, status: observed };
    });

    const stoppedB = await confirmStop(callB, parentB.id, { reason: 'offline smoke: release the shared slots' });
    const parentBFinal = stoppedB.task;
    await check('cancelling the saturated root releases its shared slot and the queued root then runs', async () => {
      assert.equal(isConfirmedStop(parentBFinal), true, `parent is not stopped: status=${parentBFinal.status} stopConfirmed=${parentBFinal.stopConfirmed} activeChildren=${parentBFinal.activeChildren ?? 0} activeJobs=${parentBFinal.activeJobs ?? 0}`);
      assert.equal(parentBFinal.status, 'cancelled', `parent status was ${parentBFinal.status}`);
      assert.equal(parentBFinal.stopConfirmed, true);
      assert.equal(parentBFinal.activeChildren ?? 0, 0);
      const released = await callB('bridge_capabilities');
      // Exactly the parent's and its child's reservations must be gone; the queued
      // root may already hold one of the freed slots by the time this is read.
      assert.ok(
        released.supervisor?.ledger?.used <= 1,
        `the parent and child reservations must be released, saw ${JSON.stringify(released.supervisor?.ledger)}`,
      );
      assert.equal(released.supervisor?.ledger?.children, 0, 'no child reservation may survive the proven stop');
      const queuedFinal = await waitTaskB(queued.id, 120000);
      assert.equal(queuedFinal.status, 'completed', `the queued root must run once slots free (saw ${queuedFinal.status})`);
      assert.equal(queuedFinal.stopConfirmed, true);
      return { parent: parentBFinal.status, queued: queuedFinal.status, ledgerAfter: released.supervisor?.ledger };
    });

    await hostB.stop();
    });
  } catch (error) {
    report.error = String(error?.stack ?? error);
  } finally {
    // Failure cleanup: a scenario that threw must not leave an unstopped probe task
    // behind. Cancel every probe task whose stop is not confirmed on every still-running
    // host, re-read the host state, and fail the run if a stop is still unconfirmed.
    const cleanup = { cancelled: [], unstopped: [], probeErrors: [] };
    for (const host of hosts) {
      if (host.isStopped()) continue;
      try {
        const before = await callTool(host, 'bridge_list', {});
        const outstanding = before.tasks.filter((entry) => entry.projectId === 'autonomy' && !isConfirmedStop(entry));
        const unconfirmed = new Map(outstanding.map((task) => [task.id, task]));
        for (const task of outstanding) {
          try {
            await callTool(host, 'bridge_cancel', { taskId: task.id, reason: 'offline smoke: failure cleanup of an unstopped probe task' });
            cleanup.cancelled.push(task.id);
          } catch (error) {
            cleanup.probeErrors.push({ id: task.id, error: String(error?.message ?? error) });
          }
        }
        // Bounded confirmation loop: a cancel REQUEST is not a stop, so wait for the
        // host to report the terminal state with zero live jobs and children. If the
        // host cannot be re-read, every still-unconfirmed task stays unstopped (fail
        // closed) instead of silently passing.
        try {
          const deadline = Date.now() + 20000;
          while (unconfirmed.size > 0 && Date.now() < deadline) {
            for (const id of [...unconfirmed.keys()]) {
              const { task } = await callTool(host, 'bridge_check', { taskId: id });
              if (isConfirmedStop(task)) unconfirmed.delete(id);
              else unconfirmed.set(id, task);
            }
            if (unconfirmed.size > 0) await sleep(200);
          }
        } catch (error) {
          cleanup.probeErrors.push({ host: host.root, error: `stop confirmation failed: ${String(error?.message ?? error)}` });
        }
        for (const task of unconfirmed.values()) {
          cleanup.unstopped.push({ host: host.root, id: task.id, status: task.status, stopConfirmed: task.stopConfirmed === true, activeJobs: task.activeJobs ?? 0, activeChildren: task.activeChildren ?? 0 });
        }
      } catch (error) {
        cleanup.probeErrors.push({ host: host.root, error: String(error?.message ?? error) });
      }
    }
    report.cleanup = cleanup;
    if (cleanup.unstopped.length > 0) {
      report.checks.push({ name: 'failure cleanup left no unstopped probe task', passed: false, error: `an explicit cancel did not confirm a stop: ${JSON.stringify(cleanup.unstopped)}` });
    }
    for (const host of hosts) await host.stop().catch(() => {});
    report.passed = report.error === undefined && report.checks.every((entry) => entry.passed === true);
    report.failedChecks = report.checks.filter((entry) => entry.passed !== true).map((entry) => entry.name);
    if (hosts.length > 0) {
      try {
        fs.writeFileSync(path.join(hosts[0].root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      } catch {
        /* diagnostics stay in memory when the temp root is gone */
      }
    }
    console.log(JSON.stringify(report, null, 2));
  }
  return report.passed === true ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(JSON.stringify({ phase: 'fatal', message: String(error?.stack ?? error) }));
    process.exitCode = 1;
  });
