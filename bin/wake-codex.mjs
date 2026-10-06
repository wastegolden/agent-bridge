#!/usr/bin/env node
// Wake runner: drains the durable wake outbox through the official
// codex-app-tools MCP route. Event-driven only: it sleeps while the outbox is
// empty (in-process notification or filesystem watch) and never polls an LLM,
// a scheduler or a Codex heartbeat.
//
// Trusted-controller side only. Every dependency (state dir, target, server
// path, caller context) is injected; env values are never logged.

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { WakeError, createWakeOutbox, eventOf } from '../src/wake-outbox.mjs';
import { createStdioTransport, createWakeClient } from '../src/codex-wake-client.mjs';

export const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
export const ENV_KEYS = Object.freeze({
  stateDir: 'DSH_WAKE_STATE_DIR',
  target: 'DSH_WAKE_TARGET',
  serverPath: 'DSH_WAKE_SERVER',
  nodePath: 'DSH_WAKE_NODE',
  callerThread: 'DSH_WAKE_CALLER_THREAD',
  callerTurn: 'DSH_WAKE_CALLER_TURN',
  callerCall: 'DSH_WAKE_CALLER_CALL',
  idleTimeoutMs: 'DSH_WAKE_IDLE_TIMEOUT_MS',
  claimLeaseMs: 'DSH_WAKE_CLAIM_LEASE_MS',
  maxSummaryChars: 'DSH_WAKE_MAX_SUMMARY_CHARS',
});

export function parseArgs(argv = []) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new WakeError('E_ARGS', `unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (name === 'once') {
      flags.once = true;
      continue;
    }
    if (name === 'requeue') {
      flags.requeue = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new WakeError('E_ARGS', `--${name} requires a value`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

function pick(flags, env, envKey, flagName) {
  const fromFlag = flags[flagName];
  if (typeof fromFlag === 'string' && fromFlag.trim()) return fromFlag.trim();
  const fromEnv = env?.[envKey];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return null;
}

function positiveInt(value, fallback, field) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new WakeError('E_ARGS', `${field} must be a positive integer`);
  return parsed;
}

export function loadConfig({ argv = [], env = process.env } = {}) {
  const flags = parseArgs(argv);
  const config = {
    stateDir: pick(flags, env, ENV_KEYS.stateDir, 'state-dir'),
    targetId: pick(flags, env, ENV_KEYS.target, 'target'),
    serverPath: pick(flags, env, ENV_KEYS.serverPath, 'server-path'),
    nodePath: pick(flags, env, ENV_KEYS.nodePath, 'node-path') ?? process.execPath ?? 'node',
    callerThreadId: pick(flags, env, ENV_KEYS.callerThread, 'caller-thread'),
    callerTurnId: pick(flags, env, ENV_KEYS.callerTurn, 'caller-turn'),
    callerCallId: pick(flags, env, ENV_KEYS.callerCall, 'caller-call'),
    idleTimeoutMs: positiveInt(pick(flags, env, ENV_KEYS.idleTimeoutMs, 'idle-timeout-ms'), DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs'),
    claimLeaseMs: positiveInt(pick(flags, env, ENV_KEYS.claimLeaseMs, 'claim-lease-ms'), 30_000, 'claimLeaseMs'),
    maxSummaryChars: positiveInt(pick(flags, env, ENV_KEYS.maxSummaryChars, 'max-summary-chars'), 1200, 'maxSummaryChars'),
    once: flags.once === true,
    requeue: flags.requeue === true,
    reconcileEventId: pick(flags, env, '', 'reconcile') ?? null,
    delivered: flags.delivered === undefined ? null : flags.delivered === 'true',
  };
  const required = [
    ['stateDir', '--state-dir or DSH_WAKE_STATE_DIR'],
    // The granted target is required in every mode: the operator reconcile path
    // builds a target-bound outbox too, and silently accepting no target is how
    // the documented command failed before.
    ['targetId', '--target or DSH_WAKE_TARGET'],
  ];
  for (const [field, source] of required) {
    if (!config[field]) throw new WakeError('E_ARGS', `${field} is required (${source})`);
  }
  if (!config.reconcileEventId) {
    for (const [field, source] of [
      ['serverPath', '--server-path or DSH_WAKE_SERVER'],
      ['callerThreadId', '--caller-thread or DSH_WAKE_CALLER_THREAD'],
    ]) {
      if (!config[field]) throw new WakeError('E_ARGS', `${field} is required (${source})`);
    }
  }
  return config;
}

export function createSafeLogger(sink = (line) => process.stdout.write(`${line}\n`)) {
  const safeKeys = new Set([
    'at', 'phase', 'eventId', 'taskId', 'attemptId', 'kind', 'code', 'outcome', 'state',
    'claims', 'delivered', 'refused', 'unknown', 'failed', 'idleWaits', 'present', 'bytes',
    'targetAllowed', 'callerMetaPresent', 'tool',
    // Bounded lock-diagnostic fields only; never raw MCP messages, env, pipe paths or credentials.
    'lockPath', 'label', 'stale', 'ownerPid', 'ownerHost', 'message',
  ]);
  return (record) => {
    const safe = { at: new Date().toISOString() };
    for (const [key, value] of Object.entries(record ?? {})) {
      if (!safeKeys.has(key)) continue;
      safe[key] = value;
    }
    sink(JSON.stringify(safe));
  };
}

export async function runWakeRunner(options = {}) {
  const {
    outbox,
    client,
    runnerId = 'wake-runner',
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    once = false,
    signal = null,
    logger = () => {},
    maxEvents = Number.POSITIVE_INFINITY,
  } = options;

  if (!outbox || typeof outbox.claimNext !== 'function') throw new WakeError('E_ARGS', 'outbox is required');
  if (!client || typeof client.deliver !== 'function') throw new WakeError('E_ARGS', 'client is required');

  const stats = { claims: 0, delivered: 0, refused: 0, unknown: 0, failed: 0, idleWaits: 0, claimErrors: 0 };
  for (;;) {
    if (signal?.aborted) break;
    if (stats.claims >= maxEvents) break;

    let claimed = null;
    try {
      claimed = await outbox.claimNext({ runnerId });
    } catch (error) {
      stats.claimErrors += 1;
      // The refusal stays explicit (no wait/retry, no lock stealing), but the
      // operator gets the bounded, actionable lock diagnostic through the safe
      // logger: which lock file, the owner pid/host when safely available, and
      // the documented offline recovery instruction.
      logger({
        phase: 'claim',
        code: error?.code ?? 'E_CLAIM',
        lockPath: error?.detail?.lockPath ?? null,
        label: error?.detail?.label ?? null,
        stale: error?.detail?.stale ?? null,
        ownerPid: error?.detail?.owner?.pid ?? null,
        ownerHost: error?.detail?.owner?.host ?? null,
        message: typeof error?.message === 'string' ? error.message : null,
      });
      break;
    }

    if (!claimed) {
      if (once) break;
      stats.idleWaits += 1;
      const wake = await outbox.waitForWork({ timeoutMs: idleTimeoutMs, signal });
      if (signal?.aborted || wake?.reason === 'closed') break;
      continue;
    }

    stats.claims += 1;
    let record;
    try {
      record = await outbox.markInFlight(claimed.eventId, { runnerId, claimId: claimed.claim?.claimId });
    } catch (error) {
      logger({ phase: 'dispatch-marker', eventId: claimed.eventId, code: error?.code ?? 'E_STATE' });
      continue;
    }

    let outcome;
    try {
      outcome = await client.deliver(eventOf(record), { attemptId: record.attempt?.dispatchId ?? null });
    } catch (error) {
      outcome = { outcome: 'unknown', code: error?.code ?? 'E_CLIENT', message: String(error?.message ?? error) };
    }
    const settled = outcome && typeof outcome === 'object' ? outcome : { outcome: 'unknown', code: 'E_CLIENT_SHAPE' };
    logger({ phase: 'wake-outcome', eventId: record.eventId, outcome: settled.outcome, code: settled.code ?? null });

    try {
      if (settled.outcome === 'delivered') {
        await outbox.recordDelivered(record.eventId, { code: settled.code, ackId: settled.ack?.tool ?? null, ack: settled.ack ?? null });
        stats.delivered += 1;
      } else if (settled.outcome === 'refused') {
        await outbox.recordRefused(record.eventId, { code: settled.code, message: settled.message, hostError: settled.hostError });
        stats.refused += 1;
      } else if (settled.outcome === 'failed') {
        await outbox.recordFailed(record.eventId, { code: settled.code, message: settled.message, hostError: settled.hostError });
        stats.failed += 1;
      } else {
        // Ambiguous external send: recorded as unknown, never retried here.
        await outbox.recordUnknown(record.eventId, { code: settled.code ?? 'E_AMBIGUOUS', message: settled.message, hostError: settled.hostError });
        stats.unknown += 1;
      }
    } catch (error) {
      logger({ phase: 'settle', eventId: record.eventId, code: error?.code ?? 'E_STATE' });
    }
  }
  return stats;
}

export async function reconcileEvent(outbox, config) {
  if (!config.reconcileEventId) return null;
  if (config.delivered !== true && config.delivered !== false) {
    throw new WakeError('E_ARGS', '--delivered true|false is required with --reconcile');
  }
  return await outbox.reconcile(config.reconcileEventId, {
    delivered: config.delivered,
    requeue: config.requeue === true && config.delivered === false,
    note: 'operator-cli',
  });
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const logger = createSafeLogger();
  const config = loadConfig({ argv, env });
  const authority = { root: true, source: 'trusted-controller' };
  const outbox = createWakeOutbox({
    dir: config.stateDir,
    authority,
    allowedTargetIds: [config.targetId],
    claimLeaseMs: config.claimLeaseMs,
    maxSummaryChars: config.maxSummaryChars,
  });

  if (config.reconcileEventId) {
    const result = await reconcileEvent(outbox, config);
    logger({ phase: 'reconcile', eventId: config.reconcileEventId, state: result?.event?.state, code: result?.duplicate ? 'duplicate' : 'reconciled' });
    await outbox.close();
    return 0;
  }

  const client = createWakeClient({
    authority,
    allowedTargetIds: [config.targetId],
    callerContext: {
      codexThreadId: config.callerThreadId,
      codexTurnId: config.callerTurnId ?? undefined,
      codexCallId: config.callerCallId ?? undefined,
    },
    maxSummaryChars: config.maxSummaryChars,
    logger,
    stdio: {
      serverPath: config.serverPath,
      nodePath: config.nodePath,
      // Env is passed through for the official server child; values are never read or logged here.
      env: env ?? process.env,
      logger,
    },
  });

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const stats = await runWakeRunner({
      outbox,
      client,
      idleTimeoutMs: config.idleTimeoutMs,
      once: config.once,
      signal: controller.signal,
      logger,
    });
    logger({ phase: 'runner-stopped', ...stats });
    // A claim failure (E_RUNNER_BUSY / E_LOCK_STALE / any claim error) is a
    // runner failure: the process must exit nonzero so a supervisor sees it.
    // Code 2 distinguishes it from the fatal-error path (exit code 1).
    return stats.claimErrors > 0 ? 2 : 0;
  } finally {
    await client.close().catch(() => undefined);
    await outbox.close().catch(() => undefined);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), phase: 'fatal', code: error?.code ?? 'E_FATAL' })}\n`);
      process.exitCode = 1;
    });
}

export { createStdioTransport };
