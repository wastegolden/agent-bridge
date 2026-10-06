#!/usr/bin/env node
// bin/watchdog-sidecar.mjs
//
// Trusted one-shot deadline-watchdog sidecar.
//
// This is NOT a worker tool: it is a fixed package executable that a carrier spawns
// detached (windowsHide:true) for ONE exact root attempt. It owns a single finite timer,
// performs ONE authenticated loopback `bridge_check` at expiry, and then at most one
// bounded `needs-input` enqueue into the accepted target outbox. The official
// wake-controller remains the only delivery path; this process never sends externally,
// never cancels anything and never releases a model slot.
//
// Configuration comes only from the operator's absolute config file, whose path is
// delivered in the `DSH_BRIDGE_WATCHDOG_CONFIG` environment variable. No credential is
// ever passed on the command line, printed, logged or stored.

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { computeDeadline, MAX_PROJECT_TIMEOUT_MS, normalizeWatchdogConfig, WATCHDOG_CONFIG_ENV } from '../src/watchdog-config.mjs';
import { readReceipt, receiptFilePath, updateReceipt } from '../src/watchdog-receipts.mjs';
import { runWatchdogCheck } from '../src/watchdog.mjs';

export const SIDECAR_USAGE =
  'usage: node bin/watchdog-sidecar.mjs --task <taskId> --attempt <attemptId> --created-at <ms> --timeout-ms <ms> [--deadline <ms>] [--once]';

export class WatchdogSidecarError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'WatchdogSidecarError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** Bounded, secret-free stderr diagnostic. Never stdout, never a secret. */
export function createSidecarLogger(stream = process.stderr) {
  return (event) => {
    try {
      const payload = { at: new Date().toISOString(), component: 'watchdog-sidecar', ...event };
      stream.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // A diagnostic must never be fatal.
    }
  };
}

export function parseSidecarArgs(argv = []) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new WatchdogSidecarError('watchdog/invalid-arguments', `unexpected argument ${arg} (${SIDECAR_USAGE})`, {});
    const name = arg.slice(2);
    if (name === 'once') {
      flags.once = true;
      continue;
    }
    if (!['task', 'attempt', 'created-at', 'timeout-ms', 'deadline'].includes(name)) {
      throw new WatchdogSidecarError('watchdog/invalid-arguments', `unexpected flag --${name} (${SIDECAR_USAGE})`, { field: name });
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new WatchdogSidecarError('watchdog/invalid-arguments', `--${name} requires a value`, { field: name });
    }
    flags[name] = value;
    index += 1;
  }
  const taskId = typeof flags.task === 'string' ? flags.task.trim() : '';
  const attemptId = typeof flags.attempt === 'string' ? flags.attempt.trim() : '';
  if (!taskId || taskId.length > 200) throw new WatchdogSidecarError('watchdog/invalid-arguments', '--task must be a nonblank id of at most 200 characters', { field: 'task' });
  if (!attemptId || attemptId.length > 200) throw new WatchdogSidecarError('watchdog/invalid-arguments', '--attempt must be a nonblank id of at most 200 characters', { field: 'attempt' });
  const createdAt = Number(flags['created-at']);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new WatchdogSidecarError('watchdog/invalid-arguments', '--created-at must be a positive safe integer of milliseconds', { field: 'created-at' });
  const timeoutMs = Number(flags['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_PROJECT_TIMEOUT_MS) {
    throw new WatchdogSidecarError('watchdog/invalid-arguments', `--timeout-ms must be a positive safe integer of at most ${MAX_PROJECT_TIMEOUT_MS}`, { field: 'timeout-ms' });
  }
  const deadlineAt = flags.deadline === undefined ? null : Number(flags.deadline);
  if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)) {
    throw new WatchdogSidecarError('watchdog/invalid-arguments', '--deadline must be a positive safe integer of milliseconds when present', { field: 'deadline' });
  }
  return { taskId, attemptId, createdAt, timeoutMs, deadlineAt, once: flags.once === true };
}

/** Read and validate the operator config file named by the MCP environment. */
export async function readWatchdogConfigFromEnv({ env = process.env, readFileImpl = readFile } = {}) {
  const configPath = env?.[WATCHDOG_CONFIG_ENV];
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    throw new WatchdogSidecarError('watchdog/config-unset', `${WATCHDOG_CONFIG_ENV} is not set for this process`, { field: WATCHDOG_CONFIG_ENV });
  }
  let text;
  try {
    text = await readFileImpl(configPath, 'utf8');
  } catch (error) {
    throw new WatchdogSidecarError('watchdog/config-unreadable', `cannot read the watchdog config file: ${error?.message ?? error}`, { field: 'config' });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WatchdogSidecarError('watchdog/config-invalid-json', `the watchdog config file is not valid JSON: ${error?.message ?? error}`, { field: 'config' });
  }
  const config = normalizeWatchdogConfig(parsed, { env });
  if (config.enabled !== true) throw new WatchdogSidecarError('watchdog/disabled', 'the watchdog config is not enabled', { field: 'enabled' });
  return config;
}

/** The credential value is read here and only here; it is never logged or stored. */
export async function readCredential({ credentialFile, readFileImpl = readFile } = {}) {
  let token;
  try {
    token = String(await readFileImpl(credentialFile, 'utf8')).trim();
  } catch (error) {
    throw new WatchdogSidecarError('watchdog/credential-unavailable', `the configured credential file could not be read: ${error?.message ?? error}`, { field: 'credentialFile' });
  }
  if (!token) throw new WatchdogSidecarError('watchdog/credential-unavailable', 'the configured credential file is empty', { field: 'credentialFile' });
  return token;
}

/**
 * ONE authenticated local `bridge_check` for the exact task. The reply is returned as
 * decoded JSON; HTTP/transport faults are thrown so the caller records `unavailable`.
 */
export function createCheckRequest({ fetchImpl = globalThis.fetch, readFileImpl = readFile } = {}) {
  return async function request({ config, taskId, checkTimeoutMs }) {
    const token = await readCredential({ credentialFile: config.credentialFile, readFileImpl });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `watchdog-${taskId}`,
      method: 'tools/call',
      params: { name: 'bridge_check', arguments: { taskId, after: 0, waitMs: 0, limit: 1 } },
    });
    const timeoutMs = Number.isInteger(checkTimeoutMs) ? checkTimeoutMs : config.checkTimeoutMs;
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new WatchdogSidecarError('watchdog/check-http-error', `the bridge answered HTTP ${response.status}`, { status: response.status });
    return await response.json();
  };
}

/**
 * One watchdog run. Never throws for an expected refusal: it records the receipt state
 * and returns a bounded report. Only a usage/config failure exits non-zero.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  readFileImpl = readFile,
  logger = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = undefined,
  createOutbox = undefined,
} = {}) {
  const log = logger ?? createSidecarLogger();
  const args = parseSidecarArgs(argv);
  const config = await readWatchdogConfigFromEnv({ env, readFileImpl });
  const receiptPath = receiptFilePath({ receiptRoot: config.receiptRoot, taskId: args.taskId, attemptId: args.attemptId });

  // Bind to the exact attempt the carrier armed: a receipt that is missing, belongs to
  // another attempt, or is not `armed` is a refusal, never an implicit adoption.
  const receipt = await readReceipt({ filePath: receiptPath, readFileImpl });
  if (receipt.ok !== true) {
    log({ phase: 'refused', code: 'watchdog/receipt-missing', reason: receipt.reason });
    return 3;
  }
  if (receipt.record.taskId !== args.taskId || receipt.record.attemptId !== args.attemptId) {
    log({ phase: 'refused', code: 'watchdog/receipt-identity-mismatch' });
    return 3;
  }
  // The receipt's pinned target is IMMUTABLE across processes: a config re-read that points
  // at another target refuses without a check and never notifies a different destination.
  if (typeof receipt.record.targetId !== 'string' || receipt.record.targetId !== config.targetId) {
    log({ phase: 'refused', code: 'watchdog/receipt-target-mismatch' });
    return 3;
  }
  // The deadline is recomputed from the SAME anchor + grant + grace the carrier used, and
  // a receipt that disagrees is ambiguous rather than silently re-anchored.
  const recomputed = computeDeadline({ createdAt: args.createdAt, timeoutMs: args.timeoutMs, graceMs: config.graceMs });
  if (recomputed.ok !== true) {
    log({ phase: 'refused', code: 'watchdog/deadline-unavailable', reason: recomputed.reason });
    return 3;
  }
  if (Number.isInteger(receipt.record.deadlineAt) && receipt.record.deadlineAt !== recomputed.deadlineAt) {
    await updateReceipt({ filePath: receiptPath, record: { ...receipt.record, state: 'ambiguous', reason: 'deadline-mismatch' } }).catch(() => undefined);
    log({ phase: 'refused', code: 'watchdog/deadline-mismatch' });
    return 3;
  }
  if (receipt.record.state !== 'armed') {
    log({ phase: 'refused', code: 'watchdog/receipt-not-armed', state: receipt.record.state });
    return 3;
  }

  const request = createCheckRequest({ fetchImpl, readFileImpl });
  const outcome = await runWatchdogCheck({
    config,
    taskId: args.taskId,
    attemptId: args.attemptId,
    receiptPath,
    now,
    ...(sleep === undefined ? {} : { sleep }),
    ...(createOutbox === undefined ? {} : { createOutbox }),
    request: (spec) => request({ config, taskId: spec.taskId, checkTimeoutMs: config.checkTimeoutMs }),
    logger: log,
  });
  log({ phase: 'finished', outcome: outcome.outcome, state: outcome.receipt?.state ?? null, eventState: outcome.receipt?.eventState ?? null });
  return outcome.receipt?.state === 'unavailable' && outcome.outcome === 'unavailable' ? 2 : 0;
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Bounded, secret-free diagnostic: code plus the settings field, never a value.
      const payload = { at: new Date().toISOString(), component: 'watchdog-sidecar', phase: 'fatal', code: error?.code ?? 'E_FATAL' };
      if (typeof error?.detail?.field === 'string') payload.field = error.detail.field;
      process.stderr.write(`${JSON.stringify(payload)}\n`);
      process.exitCode = 1;
    });
}
