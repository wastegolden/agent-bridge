// src/watchdog-receipts.mjs
//
// The durable, per-task+attempt watchdog receipt.
//
// The receipt is the ONLY cross-process fence that makes "one finite timer for one
// exact root attempt" true even across carrier restarts and identical submission
// replays. It is created with the exclusive `wx` flag BEFORE any timer or sidecar is
// started, so a duplicate arm loses the race and can never start a second check.
//
// Rules:
//   * the file name is the SHA-256 of the exact (taskId, attemptId) tuple, so ids are
//     data and never path components;
//   * only bounded, secret-free fields are stored (never a credential, token, endpoint
//     or environment value);
//   * an existing `armed`/`checking` receipt from a process we cannot prove is alive is
//     AMBIGUOUS: it is never silently adopted, re-armed or auto-continued.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RECEIPT_SCHEMA_VERSION = 1;
export const RECEIPT_STATES = Object.freeze(['armed', 'checking', 'resolved', 'unresolved', 'enqueued', 'unavailable', 'ambiguous']);
/** States that prove a check already ran (or is running) for this exact attempt. */
export const RECEIPT_TERMINAL_STATES = Object.freeze(['resolved', 'unresolved', 'enqueued', 'unavailable', 'ambiguous']);
const MAX_FIELD_CHARS = 200;

export class WatchdogReceiptError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'WatchdogReceiptError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** Deterministic, filesystem-safe receipt name for one exact task+attempt. */
export function receiptFileName({ taskId, attemptId } = {}) {
  const digest = createHash('sha256').update(JSON.stringify([String(taskId ?? ''), String(attemptId ?? '')]), 'utf8').digest('hex');
  return `wd-${digest}.json`;
}

/** Absolute receipt path inside an operator-configured receipt root. */
export function receiptFilePath({ receiptRoot, taskId, attemptId } = {}) {
  if (typeof receiptRoot !== 'string' || !path.isAbsolute(receiptRoot)) {
    throw new WatchdogReceiptError('watchdog/invalid-receipt-root', 'receiptRoot must be an absolute path', {});
  }
  return path.join(path.resolve(receiptRoot), receiptFileName({ taskId, attemptId }));
}

function boundedText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_CHARS) : null;
}

function boundedInt(value) {
  return Number.isInteger(value) ? value : null;
}

/**
 * Keep only the bounded, secret-free project binding fields. An absent/invalid binding is
 * `null`, which the receipt omits entirely so an ordinary or legacy receipt keeps its
 * EXACT previous bytes and semantics.
 */
function boundedProjectBinding(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const projectId = boundedText(raw.projectId);
  if (projectId === null || projectId.length === 0) return null;
  const attemptId = boundedText(raw.attemptId);
  const targetId = boundedText(raw.targetId);
  if (attemptId === null || attemptId.length === 0) return null;
  if (targetId === null || targetId.length === 0) return null;
  return {
    projectId,
    projectCreatedAt: boundedInt(raw.projectCreatedAt),
    taskCreatedAt: boundedInt(raw.taskCreatedAt),
    attemptId,
    targetId,
    recurrent: raw.recurrent === true,
    maxRounds: boundedInt(raw.maxRounds),
    pause: raw.pause === true,
    timeoutMs: boundedInt(raw.timeoutMs),
    graceMs: boundedInt(raw.graceMs),
    deadlineAt: boundedInt(raw.deadlineAt),
  };
}

/** Keep only the bounded, secret-free receipt fields; drop everything else. */
export function normalizeReceipt(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WatchdogReceiptError('watchdog/invalid-receipt', 'a receipt must be a JSON object', {});
  }
  const state = typeof raw.state === 'string' && RECEIPT_STATES.includes(raw.state) ? raw.state : 'ambiguous';
  const project = boundedProjectBinding(raw.project);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    taskId: boundedText(raw.taskId),
    attemptId: boundedText(raw.attemptId),
    state,
    targetId: boundedText(raw.targetId),
    timeoutMs: boundedInt(raw.timeoutMs),
    graceMs: boundedInt(raw.graceMs),
    deadlineAt: boundedInt(raw.deadlineAt),
    armedAt: boundedInt(raw.armedAt),
    finishedAt: boundedInt(raw.finishedAt),
    checks: Number.isInteger(raw.checks) && raw.checks >= 0 ? Math.min(raw.checks, 8) : 0,
    outcome: boundedText(raw.outcome),
    observed: boundedText(raw.observed),
    observedStopConfirmed: raw.observedStopConfirmed === true,
    observedActiveJobs: Number.isInteger(raw.observedActiveJobs) ? raw.observedActiveJobs : null,
    observedActiveChildren: Number.isInteger(raw.observedActiveChildren) ? raw.observedActiveChildren : null,
    existingEventId: boundedText(raw.existingEventId),
    existingEventState: boundedText(raw.existingEventState),
    enqueuedEventId: boundedText(raw.enqueuedEventId),
    eventState: boundedText(raw.eventState),
    reason: boundedText(raw.reason),
    ...(project === null ? {} : { project }),
    ...(raw.error === undefined || raw.error === null
      ? {}
      : { error: { code: boundedText(raw.error?.code) ?? 'WATCHDOG_ERROR', message: boundedText(raw.error?.message) } }),
  };
}

/**
 * Create the arm receipt with an EXCLUSIVE create. Throws
 * `watchdog/receipt-exists` when a receipt already exists for this exact attempt: the
 * caller must treat that as a duplicate/ambiguous arm and never start a timer.
 */
export async function writeArmReceipt({ filePath, record, mkdirImpl = mkdir, writeFileImpl = writeFile }) {
  await mkdirImpl(path.dirname(filePath), { recursive: true });
  const body = `${JSON.stringify(normalizeReceipt(record))}\n`;
  try {
    await writeFileImpl(filePath, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new WatchdogReceiptError('watchdog/receipt-exists', `a watchdog receipt already exists for this exact task and attempt`, { filePath });
    }
    throw new WatchdogReceiptError('watchdog/receipt-write-failed', `cannot write the watchdog receipt: ${error?.message ?? error}`, { filePath });
  }
  return normalizeReceipt(record);
}

/** Read one receipt; a missing/unreadable receipt is reported, never invented. */
export async function readReceipt({ filePath, readFileImpl = readFile }) {
  try {
    const text = await readFileImpl(filePath, 'utf8');
    return { ok: true, record: normalizeReceipt(JSON.parse(text)) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }
}

/** Overwrite a receipt we already own (state transitions after a check). */
export async function updateReceipt({ filePath, record, writeFileImpl = writeFile }) {
  const body = `${JSON.stringify(normalizeReceipt(record))}\n`;
  try {
    await writeFileImpl(filePath, body, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    throw new WatchdogReceiptError('watchdog/receipt-write-failed', `cannot update the watchdog receipt: ${error?.message ?? error}`, { filePath });
  }
  return normalizeReceipt(record);
}

/** The deterministic exclusive claim marker path for one receipt. */
export function receiptClaimPath(filePath) {
  return `${filePath}.claim`;
}

/**
 * Claim the ONE check for an exact receipt with an EXCLUSIVE create. The claim marker is
 * the cross-process fence that makes "one check per attempt" true: two processes that
 * both read `armed` cannot both proceed. A marker that survives a crash is NEVER
 * reclaimed automatically — the attempt stays ambiguous rather than double-checked.
 *
 * @returns {Promise<{claimed: true, claimPath: string}|{claimed: false, reason: string}>}
 */
export async function claimReceipt({ filePath, taskId, attemptId, targetId, now = () => Date.now(), mkdirImpl = mkdir, writeFileImpl = writeFile } = {}) {
  const claimPath = receiptClaimPath(filePath);
  const claimedAt = now();
  const body = `${JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    taskId: boundedText(taskId),
    attemptId: boundedText(attemptId),
    targetId: boundedText(targetId),
    claimedAt: Number.isInteger(claimedAt) ? claimedAt : null,
  })}\n`;
  try {
    await mkdirImpl(path.dirname(claimPath), { recursive: true });
    await writeFileImpl(claimPath, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') return { claimed: false, reason: 'claim-held' };
    return { claimed: false, reason: 'claim-write-failed' };
  }
  return { claimed: true, claimPath };
}

/** Whether a receipt belongs to exactly this task+attempt (and optionally target). */
export function receiptMatchesIdentity(record, { taskId, attemptId, targetId } = {}) {
  if (record === null || typeof record !== 'object') return false;
  if (record.taskId !== taskId || record.attemptId !== attemptId) return false;
  if (targetId !== undefined && record.targetId !== targetId) return false;
  return true;
}
