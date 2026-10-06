// Durable wake-event outbox (callback-owned, trusted-controller side only).
//
// This module is NOT a worker tool. Construction requires a controller-issued
// root authority descriptor, and the module refuses any event that tries to
// carry a destination, transport setting, credential or control command: those
// can only come from trusted controller configuration.
//
// Durability model (documented, bounded):
//   pending   -> enqueued, no owner
//   claimed   -> one runner holds a lease; no external effect can have happened
//   in_flight -> dispatch marker persisted immediately BEFORE the external call
//   delivered -> host acknowledgement observed
//   refused   -> policy/host denial, terminal, never blind-retried
//   failed    -> deterministic failure with no external effect, terminal
//   unknown   -> ambiguous: an external send may have happened, never retried
//
// Ownership model:
//   * every read-modify-write operation runs under an exclusive lock file
//     (open(...,'wx')) so concurrent processes cannot interleave a read with
//     another process's write;
//   * one live runner owns a separate exclusive runner lock file per state dir;
//   * locks are released only by their token-checked owner. A lock is NEVER
//     reclaimed automatically, not on a dead pid and never on elapsed time:
//     two automatic reclaimers could delete a freshly acquired lock and destroy
//     exclusivity. A lock that cannot be positively released is fail-closed with
//     a diagnostic and a documented offline operator procedure (stop all
//     producers/runners, confirm no live owner, delete only that lock file).
//
// This module never places an eventId in a filesystem path: records live at
// evt-<sha256(eventId)>.json and the eventId is verified as record data.

import { createHash, randomUUID } from 'node:crypto';
import { watch as nodeWatch } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const OUTBOX_SCHEMA_VERSION = 1;
export const WAKE_EVENT_KINDS = Object.freeze(['completed', 'failed', 'cancelled', 'needs-input']);
export const OUTBOX_STATES = Object.freeze([
  'pending',
  'claimed',
  'in_flight',
  'delivered',
  'unknown',
  'refused',
  'failed',
]);
export const TERMINAL_STATES = Object.freeze(['delivered', 'unknown', 'refused', 'failed']);
export const DEFAULT_MAX_SUMMARY_CHARS = 1200;
export const MAX_RESULT_IDS = 32;
export const MAX_IDENTIFIER_CHARS = 200;
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_LOCK_RETRY_MS = 20;
export const DEFAULT_RUNNER_LOCK_TIMEOUT_MS = 1_000;
export const DEFAULT_SAFETY_TIMEOUT_MS = 5_000;

// eventId is data, never a path: ':' and Windows reserved device names are fine
// because the on-disk name is a hash. It still must be a bounded, path-safe id.
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const RECORD_FILE_RE = /^evt-[0-9a-f]{64}\.json$/;
const MAX_HISTORY = 32;

// Fields that would let caller/model text choose a destination, a transport,
// credentials or behaviour. Their presence is a hard refusal, never a silent drop.
const FORBIDDEN_EVENT_KEYS = Object.freeze([
  'threadId', 'thread_id', 'thread', 'conversationId', 'conversation_id', 'conversation',
  'destination', 'destinationId', 'endpoint', 'url', 'host', 'port', 'pipe', 'pipePath',
  'command', 'executable', 'binary', 'args', 'argv', 'cwd', 'env', 'environment',
  'token', 'tokens', 'secret', 'secrets', 'credential', 'credentials', 'apiKey', 'auth',
  'headers', 'serverPath', 'mcpServer', 'tool', 'toolName', 'method', 'jsonrpc', 'params',
  'target', 'meta', '_meta', 'codexThreadId', 'codexTurnId', 'codexCallId',
  'instructions', 'systemPrompt', 'prompt', 'shell', 'delegate', 'delegation', 'subagent',
  'childTask', 'scheduler', 'heartbeat', 'retry', 'retries', 'watch', 'poll', 'intervalMs',
]);

export class WakeError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'WakeError';
    this.code = code;
    this.detail = detail;
  }
}

export function assertRootAuthority(authority) {
  if (
    authority == null ||
    typeof authority !== 'object' ||
    authority.root !== true ||
    typeof authority.source !== 'string' ||
    !authority.source.trim()
  ) {
    throw new WakeError(
      'E_AUTHORITY',
      'wake modules require controller-issued root authority ({root:true, source:"..."}); they are not available as a worker tool',
    );
  }
  return authority;
}

export function normalizeTargets(allowedTargetIds) {
  if (!Array.isArray(allowedTargetIds) || allowedTargetIds.length === 0) {
    throw new WakeError('E_ARGS', 'allowedTargetIds must be a nonempty array of trusted target ids');
  }
  const targets = [];
  for (const value of allowedTargetIds) {
    const id = requireIdentifier(value, 'allowedTargetIds[]');
    if (!targets.includes(id)) targets.push(id);
  }
  return Object.freeze(targets);
}

export function normalizeWakeEvent(event, options = {}) {
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const allowedTargetIds = options.allowedTargetIds ?? null;
  if (event == null || typeof event !== 'object' || Array.isArray(event)) {
    throw new WakeError('E_ARGS', 'event must be a plain object');
  }
  for (const key of Object.keys(event)) {
    if (FORBIDDEN_EVENT_KEYS.includes(key)) {
      throw new WakeError(
        'E_ARGS',
        `event field "${key}" is not accepted: destination, transport, credentials and control commands come only from controller configuration`,
      );
    }
  }
  const normalized = {
    eventId: requireIdentifier(event.eventId, 'eventId', EVENT_ID_RE),
    taskId: requireIdentifier(event.taskId, 'taskId'),
    attemptId: requireIdentifier(event.attemptId, 'attemptId'),
    targetId: requireIdentifier(event.targetId, 'targetId'),
    kind: requireKind(event.kind),
    summary: requireSummary(event.summary, maxSummaryChars),
    resultIds: requireResultIds(event.resultIds),
  };
  if (allowedTargetIds != null && !allowedTargetIds.includes(normalized.targetId)) {
    throw new WakeError('E_TARGET', `targetId ${normalized.targetId} is not in the controller opt-in allowlist`);
  }
  return normalized;
}

export function eventOf(record) {
  return {
    eventId: record.eventId,
    taskId: record.taskId,
    attemptId: record.attemptId,
    targetId: record.targetId,
    kind: record.kind,
    summary: record.summary,
    resultIds: Array.isArray(record.resultIds) ? [...record.resultIds] : [],
  };
}

// Deterministic, filesystem-safe record name. The eventId itself is preserved
// only as record data, so ':' (NTFS alternate data stream), reserved device
// names and case-differing ids cannot alias or vanish in the path layer.
export function filenameForEventId(eventId) {
  const text = typeof eventId === 'string' ? eventId : String(eventId ?? '');
  return `evt-${createHash('sha256').update(text, 'utf8').digest('hex')}.json`;
}

function requireIdentifier(value, field, regex = null) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WakeError('E_ARGS', `${field} must be a non-blank string`);
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new WakeError('E_ARGS', `${field} must not contain control characters (CR/LF/NUL/ESC...)`);
  }
  const text = value.trim();
  if (text.length > MAX_IDENTIFIER_CHARS) {
    throw new WakeError('E_ARGS', `${field} must be at most ${MAX_IDENTIFIER_CHARS} characters`);
  }
  if (regex && !regex.test(text)) {
    throw new WakeError('E_ARGS', `${field} must match ${String(regex)}`);
  }
  return text;
}

function requireKind(kind) {
  if (typeof kind !== 'string' || !WAKE_EVENT_KINDS.includes(kind)) {
    throw new WakeError('E_ARGS', `kind must be one of ${WAKE_EVENT_KINDS.join('|')}`);
  }
  return kind;
}

function requireSummary(summary, maxSummaryChars) {
  if (typeof summary !== 'string') {
    throw new WakeError('E_ARGS', 'summary must be a string');
  }
  if (summary.includes('\u0000')) {
    throw new WakeError('E_ARGS', 'summary must not contain NUL');
  }
  if (summary.length > maxSummaryChars) {
    throw new WakeError('E_ARGS', `summary must be at most ${maxSummaryChars} characters (got ${summary.length}); refusing rather than truncating`);
  }
  return summary;
}

function requireResultIds(resultIds) {
  if (resultIds == null) return [];
  if (!Array.isArray(resultIds)) throw new WakeError('E_ARGS', 'resultIds must be an array of strings when present');
  if (resultIds.length > MAX_RESULT_IDS) {
    throw new WakeError('E_ARGS', `resultIds must hold at most ${MAX_RESULT_IDS} ids`);
  }
  const ids = [];
  for (const value of resultIds) {
    const id = requireIdentifier(value, 'resultIds[]');
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means no such process; anything else (EPERM/EINVAL) is not proof of death.
    return error?.code !== 'ESRCH';
  }
}

// The lock file lives in a controller-owned dir, but its owner fields are still
// treated as untrusted strings: bounded length and no control characters, so a
// tampered lock can never inject or bloat a logged diagnostic.
function boundedOwnerField(value) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function readLockInfo(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      token: typeof parsed?.token === 'string' ? parsed.token : null,
      pid: Number.isInteger(parsed?.pid) ? parsed.pid : null,
      host: boundedOwnerField(parsed?.hostname),
      kind: typeof parsed?.kind === 'string' ? parsed.kind : null,
      createdAt: typeof parsed?.createdAt === 'string' ? parsed.createdAt : null,
    };
  } catch {
    return { token: null, pid: null, host: null, kind: null, createdAt: null };
  }
}

function describeOwner(info) {
  if (!info.token) return 'owner record unreadable';
  // The token is used only for token-checked release and is never rendered or
  // logged; pid/host are the bounded, safely available owner fields.
  return `pid=${info.pid ?? 'unknown'} host=${info.host ?? 'unknown'}`;
}

export function createWakeOutbox(options = {}) {
  const {
    dir,
    authority,
    allowedTargetIds,
    maxSummaryChars = DEFAULT_MAX_SUMMARY_CHARS,
    claimLeaseMs = 30_000,
    now = () => Date.now(),
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    lockRetryMs = DEFAULT_LOCK_RETRY_MS,
    runnerLockTimeoutMs = DEFAULT_RUNNER_LOCK_TIMEOUT_MS,
    safetyTimeoutMs = DEFAULT_SAFETY_TIMEOUT_MS,
    watch = nodeWatch,
    isProcessAlive = defaultProcessAlive,
    fsync = true,
  } = options;

  assertRootAuthority(authority);
  if (typeof dir !== 'string' || !dir.trim()) throw new WakeError('E_ARGS', 'dir is required');
  if (!Number.isInteger(claimLeaseMs) || claimLeaseMs <= 0) {
    throw new WakeError('E_ARGS', 'claimLeaseMs must be a positive integer');
  }
  if (!Number.isInteger(maxSummaryChars) || maxSummaryChars <= 0) {
    throw new WakeError('E_ARGS', 'maxSummaryChars must be a positive integer');
  }
  for (const [field, value] of [
    ['lockTimeoutMs', lockTimeoutMs],
    ['lockRetryMs', lockRetryMs],
    ['runnerLockTimeoutMs', runnerLockTimeoutMs],
    ['safetyTimeoutMs', safetyTimeoutMs],
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new WakeError('E_ARGS', `${field} must be a positive integer`);
  }
  if (typeof watch !== 'function') throw new WakeError('E_ARGS', 'watch must be a function (fs.watch seam)');
  if (typeof isProcessAlive !== 'function') throw new WakeError('E_ARGS', 'isProcessAlive must be a function (liveness seam)');
  if (typeof fsync !== 'boolean') throw new WakeError('E_ARGS', 'fsync must be a boolean');

  const rootDir = path.resolve(dir);
  const eventsDir = path.join(rootDir, 'events');
  const stateLockPath = path.join(rootDir, 'state.lock');
  const runnerLockPath = path.join(rootDir, 'runner.lock');
  const targets = normalizeTargets(allowedTargetIds);
  const waiters = new Set();
  let closed = false;
  let runnerOwnership = null;

  const fileFor = (eventId) => path.join(eventsDir, filenameForEventId(eventId));

  async function ensureRoot() {
    await mkdir(rootDir, { recursive: true });
  }

  async function ensureDirs() {
    await ensureRoot();
    await mkdir(eventsDir, { recursive: true });
  }

  function isOwnerDefinitelyDead(info) {
    if (info.pid == null) return false;
    if (info.host && info.host !== hostname()) return false; // another host: cannot prove death
    if (info.pid === process.pid) return false; // us: definitely not dead
    return !isProcessAlive(info.pid);
  }

  function lockDiagnostic(lockPath, info, label) {
    const stale = isOwnerDefinitelyDead(info);
    const owner = describeOwner(info);
    const state = stale ? 'stale' : 'held';
    return {
      code: stale ? 'E_LOCK_STALE' : 'E_LOCK_BUSY',
      label,
      lockPath,
      stale,
      owner: info,
      message:
        `${state} ${label} ${lockPath} (${owner}); automatic reclamation is disabled because two reclaimers could delete a freshly acquired lock. ` +
        'Offline recovery: stop every producer and runner that uses this state directory, confirm no live owner remains, then delete only that lock file.',
    };
  }

  // Exclusive lock acquisition. The lock file is created with 'wx' (atomic on
  // NTFS/POSIX). Contention is bounded; a lock is never stolen, not even when its
  // owner looks dead, so the caller always fails closed with a diagnostic.
  async function acquireLock(lockPath, { label, busyCode = 'E_LOCK_BUSY', timeoutMs = lockTimeoutMs }) {
    await ensureRoot();
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let handle = null;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(
            `${JSON.stringify({
              token,
              pid: process.pid,
              hostname: hostname(),
              kind: label,
              createdAt: new Date().toISOString(),
              lockTimeoutMs,
            })}\n`,
            'utf8',
          );
        } catch (error) {
          await handle.close().catch(() => undefined);
          handle = null;
          await rm(lockPath, { force: true }).catch(() => undefined);
          throw new WakeError('E_STORE', `cannot initialize lock ${lockPath}: ${error?.message ?? error}`);
        }
        await handle.close();
        handle = null;
        return token;
      } catch (error) {
        if (error instanceof WakeError) throw error;
        if (handle) await handle.close().catch(() => undefined);
        if (error?.code !== 'EEXIST') {
          throw new WakeError('E_STORE', `cannot acquire ${label} ${lockPath}: ${error?.message ?? error}`);
        }
      }
      let raw = null;
      try {
        raw = await readFile(lockPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') continue; // released between attempts
        throw new WakeError('E_STORE', `cannot read ${label} ${lockPath}: ${error?.message ?? error}`);
      }
      const info = readLockInfo(raw);
      const diagnostic = lockDiagnostic(lockPath, info, label);
      if (Date.now() >= deadline) {
        throw new WakeError(diagnostic.stale ? 'E_LOCK_STALE' : busyCode, diagnostic.message, {
          lockPath,
          label,
          stale: diagnostic.stale,
          owner: info,
        });
      }
      await sleep(lockRetryMs + Math.floor(Math.random() * 10));
    }
  }

  // Token-checked release: never delete a lock this owner no longer holds.
  async function releaseLock(lockPath, token) {
    if (!token) return false;
    let raw;
    try {
      raw = await readFile(lockPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new WakeError('E_STORE', `cannot read lock ${lockPath}: ${error?.message ?? error}`);
    }
    const info = readLockInfo(raw);
    if (info.token !== token) return false;
    await rm(lockPath, { force: true });
    return true;
  }

  async function withStateLock(work) {
    const token = await acquireLock(stateLockPath, { label: 'state-lock', busyCode: 'E_LOCK_BUSY' });
    try {
      return await work();
    } finally {
      await releaseLock(stateLockPath, token).catch(() => undefined);
    }
  }

  // One live runner per outbox: the runner lock is held for the runner's
  // lifetime and released on close()/releaseRunnerOwnership(). Another live
  // process gets E_RUNNER_BUSY or, when its owner looks dead, E_LOCK_STALE.
  async function acquireRunnerOwnership(runnerId) {
    const id = requireIdentifier(runnerId, 'runnerId');
    if (runnerOwnership) {
      if (runnerOwnership.runnerId === id) return runnerOwnership.token;
      throw new WakeError('E_RUNNER_BUSY', `this outbox already owns the runner lock as ${runnerOwnership.runnerId}`);
    }
    const token = await acquireLock(runnerLockPath, {
      label: 'runner-lock',
      busyCode: 'E_RUNNER_BUSY',
      timeoutMs: runnerLockTimeoutMs,
    });
    runnerOwnership = { token, runnerId: id };
    return token;
  }

  async function releaseRunnerOwnership() {
    if (!runnerOwnership) return false;
    const { token } = runnerOwnership;
    runnerOwnership = null;
    return await releaseLock(runnerLockPath, token);
  }

  async function readRecordFile(name) {
    let text;
    try {
      text = await readFile(path.join(eventsDir, name), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new WakeError('E_STORE', `cannot read wake record ${name}: ${error?.message ?? error}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WakeError('E_STORE', `wake record ${name} is not valid JSON: ${error?.message ?? error}`);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.eventId !== 'string') {
      throw new WakeError('E_STORE', `wake record ${name} carries no usable eventId`);
    }
    if (filenameForEventId(parsed.eventId) !== name) {
      throw new WakeError('E_STORE', `wake record ${name} declares eventId ${parsed.eventId}; refusing a mismatched record identity`);
    }
    return parsed;
  }

  async function readRecord(eventId) {
    return await readRecordFile(filenameForEventId(eventId));
  }

  async function requireRecord(eventId) {
    const id = requireIdentifier(eventId, 'eventId', EVENT_ID_RE);
    const record = await readRecord(id);
    if (!record) throw new WakeError('E_STATE', `unknown wake event ${id}`);
    return record;
  }

  async function writeRecord(record) {
    await ensureDirs();
    const target = fileFor(record.eventId);
    const tmp = path.join(eventsDir, `.${randomUUID()}.tmp`);
    let handle = null;
    try {
      handle = await open(tmp, 'w', 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      if (fsync) {
        // Best-effort flush before the rename so a power loss cannot lose the
        // dispatch marker after the send. Unsupported fsync codes are tolerated.
        try {
          await handle.sync();
        } catch (error) {
          const tolerated = ['ENOSYS', 'EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR', 'EBADF'];
          if (!tolerated.includes(error?.code)) throw error;
        }
      }
      await handle.close();
      handle = null;
      await rename(tmp, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(tmp, { force: true }).catch(() => undefined);
      if (error instanceof WakeError) throw error;
      throw new WakeError('E_STORE', `cannot persist wake event ${record.eventId}: ${error?.message ?? error}`);
    }
    return record;
  }

  async function listRecords() {
    await ensureDirs();
    let names = [];
    try {
      names = await readdir(eventsDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new WakeError('E_STORE', `cannot list wake events: ${error?.message ?? error}`);
    }
    const records = [];
    for (const name of names) {
      if (!RECORD_FILE_RE.test(name)) continue;
      const record = await readRecordFile(name);
      if (record) records.push(record);
    }
    records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.eventId).localeCompare(String(b.eventId)));
    return records;
  }

  function notifyWaiters() {
    for (const waiter of [...waiters]) waiter();
  }

  function stamp(record, state, code, ts) {
    const history = Array.isArray(record.history) ? record.history : [];
    return {
      ...record,
      history: [...history, { at: ts, state, code: code ?? null }].slice(-MAX_HISTORY),
    };
  }

  function applySettlement(record, state, outcome, ts) {
    const next = stamp(record, state, outcome?.code ?? null, ts);
    next.state = state;
    next.outcome = outcome ?? null;
    next.updatedAt = ts;
    if (state === 'pending') next.claim = null;
    return next;
  }

  function samePayload(record, event) {
    return (
      record.taskId === event.taskId &&
      record.attemptId === event.attemptId &&
      record.targetId === event.targetId &&
      record.kind === event.kind &&
      record.summary === event.summary &&
      JSON.stringify(record.resultIds ?? []) === JSON.stringify(event.resultIds ?? [])
    );
  }

  // Reply identity is the immutable eventId alone. Distinct replies that happen
  // to share task/attempt/kind are separate events and are never dropped.
  async function enqueue(eventInput) {
    if (closed) throw new WakeError('E_CLOSED', 'outbox is closed');
    return withStateLock(async () => {
      const event = normalizeWakeEvent(eventInput, { maxSummaryChars, allowedTargetIds: targets });
      const existing = await readRecord(event.eventId);
      if (existing) {
        if (!samePayload(existing, event)) {
          throw new WakeError('E_CONFLICT', `eventId ${event.eventId} already exists with a different payload`);
        }
        return { ok: true, duplicate: true, reason: 'event-id', event: existing };
      }
      const ts = now();
      const record = stamp(
        {
          schemaVersion: OUTBOX_SCHEMA_VERSION,
          ...event,
          state: 'pending',
          createdAt: ts,
          updatedAt: ts,
          claim: null,
          attempt: null,
          outcome: null,
          history: [],
        },
        'pending',
        'enqueued',
        ts,
      );
      await writeRecord(record);
      notifyWaiters();
      return { ok: true, duplicate: false, reason: null, event: record };
    });
  }

  async function claimNext(request = {}) {
    if (closed) throw new WakeError('E_CLOSED', 'outbox is closed');
    const runnerId = requireIdentifier(request.runnerId, 'runnerId');
    await acquireRunnerOwnership(runnerId);
    return withStateLock(async () => {
      const leaseMs = request.leaseMs ?? claimLeaseMs;
      const ts = now();
      const candidates = (await listRecords()).filter(
        (record) =>
          record.state === 'pending' ||
          (record.state === 'claimed' && !(record.claim && record.claim.leaseExpiresAt > ts)),
      );
      const candidate = candidates[0];
      if (!candidate) return null;
      const claim = {
        runnerId,
        claimId: randomUUID(),
        claimedAt: ts,
        leaseExpiresAt: ts + leaseMs,
        reclaimed: candidate.state === 'claimed',
      };
      const next = stamp(candidate, 'claimed', claim.reclaimed ? 'reclaimed-expired-lease' : 'claimed', ts);
      next.state = 'claimed';
      next.claim = claim;
      next.updatedAt = ts;
      await writeRecord(next);
      const confirmed = await readRecord(next.eventId);
      if (!confirmed?.claim || confirmed.claim.claimId !== claim.claimId) return null;
      return confirmed;
    });
  }

  async function markInFlight(eventId, request = {}) {
    return withStateLock(async () => {
      const record = await requireRecord(eventId);
      if (record.state === 'in_flight') {
        throw new WakeError('E_STATE', `event ${eventId} already has a persisted dispatch marker (ambiguous; reconcile explicitly)`);
      }
      if (record.state !== 'claimed') {
        throw new WakeError('E_STATE', `cannot persist a dispatch marker for event ${eventId} in state ${record.state}`);
      }
      const runnerId = requireIdentifier(request.runnerId, 'runnerId');
      const claimId = requireIdentifier(request.claimId, 'claimId');
      if (!record.claim || record.claim.claimId !== claimId || record.claim.runnerId !== runnerId) {
        throw new WakeError('E_CLAIM_LOST', `claim ${claimId} is not the persisted owner of event ${eventId}`);
      }
      const ts = now();
      const attempt = {
        attemptNumber: (record.attempt?.attemptNumber ?? 0) + 1,
        startedAt: ts,
        dispatchId: randomUUID(),
        phase: 'in_flight',
      };
      const next = stamp(record, 'in_flight', 'dispatch-marker', ts);
      next.state = 'in_flight';
      next.attempt = attempt;
      next.updatedAt = ts;
      await writeRecord(next);
      const confirmed = await readRecord(eventId);
      if (confirmed?.state !== 'in_flight' || confirmed.attempt?.dispatchId !== attempt.dispatchId) {
        throw new WakeError('E_CLAIM_LOST', `dispatch marker for event ${eventId} was not persisted as ours`);
      }
      return confirmed;
    });
  }

  async function settle(eventId, state, outcome, allowedFrom) {
    return withStateLock(async () => {
      const record = await requireRecord(eventId);
      if (record.state === state) return { ok: true, duplicate: true, event: record };
      if (TERMINAL_STATES.includes(record.state)) {
        throw new WakeError('E_STATE', `event ${eventId} is already settled as ${record.state}`);
      }
      if (!allowedFrom.includes(record.state)) {
        throw new WakeError('E_STATE', `cannot move event ${eventId} from ${record.state} to ${state}`);
      }
      const next = applySettlement(record, state, outcome, now());
      await writeRecord(next);
      notifyWaiters();
      return { ok: true, duplicate: false, event: next };
    });
  }

  // Explicit operator reconciliation of an ambiguous record. Two states can be
  // settled and only these two:
  //   in_flight -> the dispatch marker was persisted; the process may have died
  //                before the outcome was known (existing compatibility);
  //   unknown   -> the runner or recover() already terminalized the ambiguous
  //                send; an operator/root decision is the ONLY way out of it.
  // The operator decision is never inferred and never acted on by this call
  // beyond persisting it: delivered:true marks it delivered, delivered:false
  // marks it failed, and ONLY delivered:false,requeue:true returns it to
  // pending, where the existing runner path decides whether to send exactly
  // once more. No target, claim, attempt or history is rewritten here.
  const RECONCILABLE_STATES = Object.freeze(['in_flight', 'unknown']);

  // A replay is idempotent only for the identical decision: same resulting
  // state AND same operator outcome code. A record already settled by another
  // route (the runner's `delivered`/`failed`, a refusal, a prior requeue) is
  // never confirmed or rewritten by a different decision.
  function reconcileReplay(record, state, code) {
    return record.state === state && record.outcome?.code === code;
  }

  async function reconcile(eventId, decision = {}) {
    return withStateLock(async () => {
      const record = await requireRecord(eventId);
      const ts = now();
      const note = typeof decision.note === 'string' ? decision.note.slice(0, 300) : null;
      if (decision.delivered === true) {
        if (reconcileReplay(record, 'delivered', 'reconciled-delivered')) {
          return { ok: true, duplicate: true, event: record };
        }
        if (!RECONCILABLE_STATES.includes(record.state)) {
          throw new WakeError('E_STATE', `cannot reconcile event ${eventId} as delivered from state ${record.state}`);
        }
        const next = applySettlement(record, 'delivered', { code: 'reconciled-delivered', ackId: decision.ackId ?? null, note }, ts);
        await writeRecord(next);
        return { ok: true, duplicate: false, event: next };
      }
      if (decision.delivered === false) {
        const state = decision.requeue === true ? 'pending' : 'failed';
        const code = decision.requeue === true ? 'operator-requeue' : 'reconciled-not-delivered';
        if (reconcileReplay(record, state, code)) return { ok: true, duplicate: true, event: record };
        if (!RECONCILABLE_STATES.includes(record.state)) {
          throw new WakeError('E_STATE', `cannot reconcile event ${eventId} from state ${record.state}`);
        }
        const next = applySettlement(record, state, { code, note }, ts);
        await writeRecord(next);
        if (state === 'pending') notifyWaiters();
        return { ok: true, duplicate: false, event: next };
      }
      throw new WakeError('E_ARGS', 'reconcile requires delivered:true or delivered:false');
    });
  }

  // Explicit recovery. It may only run while this outbox holds exclusive runner
  // ownership, so a live sender's in_flight marker can never be touched. Expired
  // claims are returned to pending; orphaned in_flight markers become the
  // terminal ambiguous state "unknown" and are never automatically resent.
  async function recover(request = {}) {
    if (closed) throw new WakeError('E_CLOSED', 'outbox is closed');
    const runnerId = requireIdentifier(request.runnerId, 'runnerId');
    await acquireRunnerOwnership(runnerId);
    return withStateLock(async () => {
      const ts = now();
      const reclaimed = [];
      const ambiguous = [];
      const skipped = [];
      for (const record of await listRecords()) {
        if (record.state === 'claimed') {
          if (record.claim && record.claim.leaseExpiresAt > ts) {
            skipped.push(record.eventId);
            continue;
          }
          const next = applySettlement(record, 'pending', { code: 'recovered-expired-claim', note: 'exclusive-runner-recovery' }, ts);
          await writeRecord(next);
          reclaimed.push(record.eventId);
        } else if (record.state === 'in_flight') {
          const next = applySettlement(
            record,
            'unknown',
            {
              code: 'recovered-interrupted-send',
              message: 'exclusive runner ownership acquired; the interrupted send stays ambiguous and is never resent',
              hostError: null,
            },
            ts,
          );
          await writeRecord(next);
          ambiguous.push(record.eventId);
        }
      }
      notifyWaiters();
      return { ok: true, runnerId, reclaimed, ambiguous, skipped };
    });
  }

  async function getEvent(eventId) {
    return readRecord(requireIdentifier(eventId, 'eventId', EVENT_ID_RE));
  }

  async function listEvents(filter = {}) {
    const records = await listRecords();
    if (!filter.state) return records;
    return records.filter((record) => record.state === filter.state);
  }

  async function hasWork() {
    const ts = now();
    return (await listRecords()).some(
      (record) =>
        record.state === 'pending' ||
        (record.state === 'claimed' && !(record.claim && record.claim.leaseExpiresAt > ts)),
    );
  }

  // Event-driven wait: resolves on an in-process enqueue notification, a
  // filesystem change in the events directory, an abort, a watch error, or a
  // bounded safety timer. It never polls in a loop; the timer is the fallback
  // for a missed OS notification or an unavailable watcher, so a pending event
  // cannot sit undelivered forever.
  async function waitForWork(request = {}) {
    if (closed) return { reason: 'closed' };
    const requested = request.timeoutMs ?? 0;
    const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : safetyTimeoutMs;
    const signal = request.signal ?? null;
    if (await hasWork()) return { reason: 'work' };
    if (signal?.aborted) return { reason: 'closed' };
    return await new Promise((resolve) => {
      let finished = false;
      let watcher = null;
      let timer = null;
      let watchError = false;
      const onNotify = () => finish('work');
      function cleanup() {
        waiters.delete(onNotify);
        if (watcher) {
          try {
            watcher.close();
          } catch {
            /* already closed */
          }
        }
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function finish(reason) {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({ reason, watchError, timeoutMs });
      }
      function onAbort() {
        finish('closed');
      }
      waiters.add(onNotify);
      try {
        watcher = watch(eventsDir, () => finish('work'));
        if (watcher && typeof watcher.on === 'function') {
          watcher.on('error', () => {
            watchError = true;
            finish('watch-error');
          });
        }
      } catch {
        // No usable watcher: keep the safety timer as the only fallback and say so.
        watchError = true;
        watcher = null;
      }
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      if (signal) {
        if (signal.aborted) return finish('closed');
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // Close the race between the first hasWork() check and registering the
      // waiter/watch handles above.
      void hasWork()
        .then((work) => {
          if (work) finish('work');
        })
        .catch(() => undefined);
    });
  }

  async function stats() {
    const counts = {};
    for (const state of OUTBOX_STATES) counts[state] = 0;
    for (const record of await listRecords()) {
      if (record.state in counts) counts[record.state] += 1;
    }
    return counts;
  }

  async function close() {
    closed = true;
    for (const waiter of [...waiters]) waiter();
    await releaseRunnerOwnership().catch(() => undefined);
    return { ok: true };
  }

  return Object.freeze({
    dir: rootDir,
    eventsDir,
    stateLockPath,
    runnerLockPath,
    allowedTargetIds: targets,
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    filenameFor: filenameForEventId,
    enqueue,
    claimNext,
    markInFlight,
    recordDelivered: (eventId, outcome = {}) =>
      settle(eventId, 'delivered', { code: outcome.code ?? 'delivered', ackId: outcome.ackId ?? null, ack: outcome.ack ?? null }, ['in_flight']),
    recordUnknown: (eventId, outcome = {}) =>
      settle(eventId, 'unknown', { code: outcome.code ?? 'E_AMBIGUOUS', message: outcome.message ?? null, hostError: outcome.hostError ?? null }, ['in_flight']),
    recordRefused: (eventId, outcome = {}) =>
      settle(eventId, 'refused', { code: outcome.code ?? 'E_REFUSED', message: outcome.message ?? null, hostError: outcome.hostError ?? null }, ['claimed', 'in_flight']),
    recordFailed: (eventId, outcome = {}) =>
      settle(eventId, 'failed', { code: outcome.code ?? 'E_FAILED', message: outcome.message ?? null, hostError: outcome.hostError ?? null }, ['claimed', 'in_flight']),
    recover,
    acquireRunnerOwnership,
    releaseRunnerOwnership,
    runnerOwnership: () => (runnerOwnership ? { ...runnerOwnership } : null),
    reconcile,
    getEvent,
    listEvents,
    hasWork,
    waitForWork,
    stats,
    close,
  });
}

// The exact integration API for the core supervisor sink:
//   const sink = createWakeSink({ dir, authority, allowedTargetIds });
//   await sink({ eventId, taskId, attemptId, targetId, kind, summary, resultIds? });
// It resolves {ok, duplicate, event} and REJECTS on validation/persistence
// failure (fail-closed), so the core must treat a rejection as "not reported".
export function createWakeSink(options) {
  const outbox = createWakeOutbox(options);
  const sink = (event) => outbox.enqueue(event);
  sink.outbox = outbox;
  return sink;
}
