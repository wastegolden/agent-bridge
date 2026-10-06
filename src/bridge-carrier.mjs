// src/bridge-carrier.mjs
//
// The Codex stdio carrier for the DSH bridge, plus the OPTIONAL one-shot deadline
// watchdog hook.
//
// Compatibility is the first rule: every existing JSON-RPC behaviour is preserved —
// one JSON object per stdin line, the upstream reply emitted exactly once as one stdout
// line, HTTP 202 producing no reply at all, `-32700` for invalid JSON and `-32000` for a
// transport/HTTP fault. The measured behaviour is: a successful 200 reply body is
// forwarded EVEN when the input carried no `id` (the host answers `notifications/*` with
// 202, which is the only silent case), and a transport/HTTP fault yields an error reply
// only when the input `id` is defined and not null.
//
// The watchdog hook runs strictly AFTER the upstream reply has been written and is
// wrapped so it can never change the reply, throw into the request path or write to
// stdout. With no `DSH_BRIDGE_WATCHDOG_CONFIG` the carrier behaves exactly as before.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { receiptFilePath } from './watchdog-receipts.mjs';
import { observeSubmitForWatchdog } from './watchdog.mjs';
import { isLocalAbsolutePath, normalizeWatchdogConfig, WATCHDOG_CONFIG_ENV } from './watchdog-config.mjs';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:3080/mcp/codex-bridge-v1';
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 70_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Bounded, secret-free stderr diagnostics. The value of any secret is never written. */
export function createCarrierLogger(stream = process.stderr) {
  return (event) => {
    try {
      stream.write(`${JSON.stringify({ at: new Date().toISOString(), component: 'bridge-carrier', ...event })}\n`);
    } catch {
      // Diagnostics must never break the carrier.
    }
  };
}

/**
 * Load the operator watchdog configuration from the opt-in environment variable.
 * It NEVER throws: an unset variable disables the feature, and an invalid configuration
 * disables it with a bounded diagnostic (code plus field only). A malformed optional
 * feature must not damage the MCP transport.
 */
export async function loadCarrierWatchdogConfig({ env = process.env, readFileImpl = readFile, logger = null } = {}) {
  const configPath = env?.[WATCHDOG_CONFIG_ENV];
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    return { enabled: false, reason: 'watchdog config is not configured' };
  }
  // The CONFIG PATH itself must be absolute and local: a relative or UNC/remote path is
  // refused before any read, not only the fields inside the file.
  if (isLocalAbsolutePath(configPath.trim()) !== true) {
    logger?.({ phase: 'watchdog-config', state: 'refused', code: 'WATCHDOG_CONFIG_PATH_NOT_LOCAL' });
    return { enabled: false, reason: 'watchdog config path is not an absolute local path' };
  }
  try {
    const parsed = JSON.parse(await readFileImpl(configPath, 'utf8'));
    return normalizeWatchdogConfig(parsed, { env });
  } catch (error) {
    logger?.({ phase: 'watchdog-config', state: 'refused', code: error?.code ?? 'WATCHDOG_CONFIG_INVALID', ...(typeof error?.detail?.field === 'string' ? { field: error.detail.field } : {}) });
    return { enabled: false, reason: 'watchdog config is invalid' };
  }
}

/** The fixed package sidecar executable. Never a task- or model-supplied path. */
export function defaultSidecarSpec() {
  return {
    command: process.execPath,
    args: [path.join(HERE, '..', 'bin', 'watchdog-sidecar.mjs')],
  };
}

/**
 * Spawn the detached finite sidecar for one armed attempt. It inherits only the
 * environment needed to re-read the SAME operator config file (and the originating
 * `CODEX_THREAD_ID`), is windowless, and is unref'd so the carrier can exit immediately.
 * Its stdio is ignored: it can never write into the MCP stdout stream.
 */
export function defaultSpawnSidecar({
  spec,
  taskId,
  attemptId,
  createdAt,
  timeoutMs,
  deadlineAt,
  env,
  spawnImpl = spawn,
  logger = null,
} = {}) {
  const child = spawnImpl(
    spec.command,
    [...spec.args, '--task', taskId, '--attempt', attemptId, '--created-at', String(createdAt), '--timeout-ms', String(timeoutMs), '--deadline', String(deadlineAt)],
    {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        CODEX_THREAD_ID: env?.CODEX_THREAD_ID,
        [WATCHDOG_CONFIG_ENV]: env?.[WATCHDOG_CONFIG_ENV],
      },
    },
  );
  child.on?.('error', (error) => logger?.({ phase: 'watchdog-spawn', state: 'error', code: error?.code ?? 'SPAWN_FAILED' }));
  child.unref?.();
  return { ok: true, pid: child.pid ?? null, child };
}

/** Whether a value is a plain JSON object (never an array or null). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract the request identity, (for a tool call) the tool name, and the EXPLICIT request
 * budget timeout the watchdog hook may use. Only a positive safe integer actually present
 * on the request is reported; an omitted/defaulted budget stays null so the hook refuses
 * to arm rather than inventing the server-side default.
 */
function describeRequest(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const isToolCall = msg.method === 'tools/call' && msg.id !== undefined && msg.id !== null;
  const args = isPlainObject(msg.params) ? msg.params.arguments : undefined;
  const packet = isPlainObject(args) && isPlainObject(args.packet) ? args.packet : null;
  const requested = packet !== null && isPlainObject(packet.budget) ? packet.budget.timeoutMs : undefined;
  return {
    id: msg.id,
    method: msg.method,
    name: isToolCall ? msg.params?.name : undefined,
    hasId: msg.id !== undefined && msg.id !== null,
    budgetTimeoutMs: Number.isSafeInteger(requested) && requested > 0 ? requested : null,
  };
}

/** Decode an upstream reply for the watchdog hook only. Never re-serialised. */
function decodeReply(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the bearer credential exactly as the historical carrier did: an explicit
 * environment token first, otherwise the credential file. The value is never logged.
 */
export async function resolveCarrierToken({ env = process.env, readFileImpl = readFile, credentialFile } = {}) {
  if (typeof env?.DSH_MCP_TOKEN === 'string' && env.DSH_MCP_TOKEN.trim()) return env.DSH_MCP_TOKEN.trim();
  try {
    const fromFile = String(await readFileImpl(credentialFile, 'utf8')).trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

/**
 * An environment value that is present and nonblank, otherwise null. A plugin host may
 * substitute an unset option as an empty string; blank must mean "not configured".
 */
export function nonBlankEnv(env, key) {
  const value = env?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The historical default credential path. */
export function defaultCredentialFile(env = process.env) {
  return path.join(env?.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'codex-bridge-v1', 'bridge-token');
}

/**
 * Build the carrier.
 *
 * @param {object} spec - injectable seams (stdin/stdout, env, fetch, clock, spawn, logger).
 * @returns {{handleLine: Function, watchdogState: Function, close: Function, isClosed: Function}}
 */
export function createCarrier({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  endpoint = nonBlankEnv(env, 'DSH_BRIDGE_URL') ?? DEFAULT_ENDPOINT,
  credentialFile = nonBlankEnv(env, 'DSH_BRIDGE_CREDENTIAL_FILE') ?? defaultCredentialFile(env),
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  now = () => Date.now(),
  spawnImpl = spawn,
  sidecarSpec = null,
  logger = null,
  watchdogEnabled = true,
} = {}) {
  const log = logger ?? createCarrierLogger();
  const state = { config: { enabled: false, reason: 'not loaded' }, armed: 0, refusals: 0, observed: 0 };
  const inflight = new Set();
  let closed = false;

  /** Run one optional watchdog operation, tracked for `whenIdle`; never throws. */
  function trackWatchdog(described, text) {
    const operation = afterReply(described, text)
      .catch((error) => log({ phase: 'watchdog-hook', state: 'error', code: error?.code ?? 'WATCHDOG_HOOK_FAILED' }))
      .finally(() => inflight.delete(operation));
    inflight.add(operation);
    return operation;
  }

  /** Write exactly one reply line for one request. Never writes for a notification. */
  async function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } })}\n`);
      return { replied: true, code: -32700 };
    }
    const described = describeRequest(msg);
    try {
      const token = await resolveCarrierToken({ env, readFileImpl, credentialFile });
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: line,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
      if (response.status === 202) return { replied: false, code: 202 };
      if (!response.ok) throw new Error(`DSH bridge HTTP ${response.status}`);
      const text = await response.text();
      // Emit the upstream reply EXACTLY once and before any watchdog work. Re-serialising
      // the decoded value keeps the historical one-line JSON semantics.
      stdout.write(`${JSON.stringify(JSON.parse(text))}\n`);
      // The reply is complete: the optional watchdog observes the result strictly off
      // the reply's critical path, so a slow or failing hook can never delay the caller.
      void trackWatchdog(described, text);
      return { replied: true, code: response.status, text };
    } catch (e) {
      if (described?.hasId === true) {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: described.id, error: { code: -32000, message: e.message } })}\n`);
        return { replied: true, code: -32000 };
      }
      return { replied: false, code: -32000 };
    }
  }

  /** The optional watchdog hook: after the reply, never on the reply's critical path. */
  async function afterReply(described, text) {
    try {
      if (watchdogEnabled !== true || described?.method !== 'tools/call' || described?.name !== 'bridge_submit') return;
      if (state.config.enabled !== true) return;
      state.observed += 1;
      const decoded = decodeReply(text);
      if (decoded === null) return;
      const call = { method: 'tools/call', name: 'bridge_submit', id: described.id, result: decoded.result };
      const verdict = await observeSubmitForWatchdog({
        config: state.config,
        call,
        env,
        now,
        requestBudgetTimeoutMs: described?.budgetTimeoutMs ?? null,
        receiptFilePath,
        spawnSidecar: ({ plan }) =>
          defaultSpawnSidecar({
            spec: sidecarSpec ?? defaultSidecarSpec(),
            taskId: plan.taskId,
            attemptId: plan.attemptId,
            createdAt: plan.createdAt,
            timeoutMs: plan.timeoutMs,
            deadlineAt: plan.deadlineAt,
            env,
            spawnImpl,
            logger: log,
          }),
        logger: log,
      });
      if (verdict?.armed === true) state.armed += 1;
      else state.refusals += 1;
    } catch (error) {
      log({ phase: 'watchdog-hook', state: 'error', code: error?.code ?? 'WATCHDOG_HOOK_FAILED' });
    }
  }

  /** Load the optional watchdog configuration once, before the first line is handled. */
  async function start() {
    if (watchdogEnabled === true) state.config = await loadCarrierWatchdogConfig({ env, readFileImpl, logger: log });
    return { ok: true, watchdogEnabled: state.config.enabled === true };
  }

  /** Attach the line reader. `createInterface` is injected so tests can drive it. */
  function attach(createInterface) {
    const input = createInterface({ input: stdin });
    input.on('line', (line) => {
      void handleLine(line);
    });
    return input;
  }

  return {
    handleLine,
    start,
    attach,
    /** Await every in-flight watchdog observation (tests and shutdown). */
    async whenIdle() {
      for (let round = 0; round < 50 && inflight.size > 0; round += 1) {
        await Promise.allSettled([...inflight]);
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { pending: inflight.size };
    },
    watchdogState: () => ({ ...state, enabled: state.config.enabled === true }),
    close: () => {
      closed = true;
      return { ok: true, closed };
    },
    isClosed: () => closed,
  };
}
