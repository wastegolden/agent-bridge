// src/watchdog.mjs
//
// The one-shot trusted deadline watchdog.
//
// One finite timer per exact GRANTED root attempt. At expiry the watchdog performs
// exactly ONE authenticated `bridge_check` for that task, then:
//
//   * a QUIET positive stop (`completed`/`cancelled` + explicit confirmed stop + explicit
//     numeric zero jobs AND children) is recorded quietly — no callback, ever;
//   * a `failed` positive stop is never quiet: a same-attempt outbox record is reused or
//     exactly ONE `needs-input` is enqueued;
//   * an existing callback for the SAME task and attempt already in the accepted target
//     outbox is reused as-is (its state is recorded, including ambiguity) — never resent;
//   * a bounded RECURRENT project that advanced from the armed first attempt to a later
//     attempt is treated as legitimate ONLY with the durable project binding written at
//     arming plus a complete readable exact lineage, exact project anchor/grant/deadline/
//     target and a positive all-work stop; a stopped completed/cancelled project is then
//     quiet and a genuine current failed aggregate callback is reused. Missing, broken or
//     mismatched lineage/counts/target/grant/deadline stays an anomaly;
//   * anything else (running, queued, unknown, unconfirmed, unreachable, mismatched
//     identity) is an anomaly and produces AT MOST ONE stable bounded `needs-input` event,
//     and an unreadable outbox fails closed with no enqueue.
//
// The watchdog never cancels, never releases a model slot, never replays a dispatch,
// never changes a task's scope/model/config and never performs an external send: the
// existing official wake-controller owns delivery. `enqueued` is never reported as
// `delivered`.

import { setTimeout as defaultSleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';

import { createWakeOutbox } from './wake-outbox.mjs';
import { TRUSTED_CONTROLLER_AUTHORITY, resolveTargetOutboxDir } from './wake-integration.mjs';
import {
  WATCHDOG_EVENT_LOGICAL_ID,
  WATCHDOG_SCHEMA_VERSION,
  WATCHDOG_SUMMARY_CHARS,
  MAX_TIMER_MS,
  computeDeadline,
  isSuccessfulSubmitReply,
  planWatchdogArm,
} from './watchdog-config.mjs';
import { claimReceipt, readReceipt, receiptMatchesIdentity, updateReceipt, writeArmReceipt } from './watchdog-receipts.mjs';

/** Outcome classes recorded on a receipt. */
export const WATCHDOG_OUTCOMES = Object.freeze([
  'positive-stop',
  'existing-callback',
  'unresolved',
  'unavailable',
  'refused',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Strict stop-count rule: only an explicit numeric zero proves a zero. */
export function isExplicitZero(value) {
  return Number.isInteger(value) && value === 0;
}

/** Terminal task statuses, as the bridge records them. */
const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

/**
 * Whether a `bridge_check` observation is a positive stop. Status must be terminal, the
 * stop must be explicitly confirmed, and BOTH counts must be explicit numeric zeros.
 * Missing/null/non-numeric is unknown and is never coerced into a zero.
 */
export function isPositiveStop(observation) {
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) return false;
  if (!TERMINAL_STATUSES.includes(observation.status)) return false;
  if (observation.stopConfirmed !== true) return false;
  if (!isExplicitZero(observation.activeJobs)) return false;
  if (!isExplicitZero(observation.activeChildren)) return false;
  return true;
}

/**
 * Whether an observation is a QUIET positive stop: only a clean `completed` or an
 * explicit `cancelled` is silent. A `failed` task is a distinct outcome class: an
 * already-recorded same-attempt callback is reused, otherwise one `needs-input` event is
 * surfaced — a failure that produced no callback must never disappear.
 */
export function isQuietStop(observation) {
  if (isPositiveStop(observation) !== true) return false;
  return observation.status !== 'failed';
}

/** One EXACT terminal, positively stopped round record (explicit numeric zeros). */
function isStoppedRound(round) {
  if (!isPlainObject(round)) return false;
  if (!TERMINAL_STATUSES.includes(round.status)) return false;
  if (round.stopConfirmed !== true) return false;
  if (!isExplicitZero(round.activeJobs)) return false;
  if (!isExplicitZero(round.activeChildren)) return false;
  return true;
}

/**
 * Whether a `bridge_check` observation whose attempt differs from the ARMED attempt is a
 * LEGITIMATE bounded-recurrent continuation of the SAME project, rather than an anomaly.
 *
 * This is the ONLY place identity is reinterpreted, and it is deliberately strict. It
 * requires the durable project binding written at ARMING (so an ordinary or legacy arm can
 * never take this path) plus a COMPLETE, READABLE, EXACT proof from the real public check
 * view:
 *
 *   * same projectId, same immutable project anchor and grant, same recomputed project
 *     deadline and the same granted callback target;
 *   * the root observation is a positive stop (terminal, confirmed, true/0/0);
 *   * the ARMED first attempt is present in the round lineage as an exact stopped round,
 *     the observed current attempt is the EXACT last round at the recorded `roundsUsed`;
 *   * every owned worker attempt carries its own positive true/0/0 stop — a missing or
 *     non-numeric child count is UNKNOWN and refuses, never a zero.
 *
 * Anything missing, unreadable, broken or mismatched returns `legitimate: false`; the
 * caller then keeps the original anomaly behaviour (the armed attempt is never
 * reinterpreted, no stop is inferred and no callback is reused).
 *
 * @param {{observation: unknown, binding: unknown, graceMs?: unknown}} spec
 * @returns {{legitimate: boolean, reason: string, attemptId?: string}}
 */
export function evaluateRecurrentLineage({ observation, binding, graceMs } = {}) {
  if (!isPlainObject(binding)) return { legitimate: false, reason: 'no-project-binding' };
  if (binding.recurrent !== true) return { legitimate: false, reason: 'not-recurrent-binding' };
  if (!isPlainObject(observation)) return { legitimate: false, reason: 'no-observation' };
  const project = isPlainObject(observation.project) ? observation.project : null;
  if (project === null) return { legitimate: false, reason: 'no-project-view' };
  if (project.projectId !== binding.projectId) return { legitimate: false, reason: 'project-mismatch' };
  if (project.createdAt !== binding.projectCreatedAt) return { legitimate: false, reason: 'project-anchor-mismatch' };
  if (observation.createdAt !== binding.taskCreatedAt) return { legitimate: false, reason: 'task-anchor-mismatch' };
  if (project.grant?.recurrent !== true) return { legitimate: false, reason: 'project-not-recurrent' };
  if (project.grant?.timeoutMs !== binding.timeoutMs) return { legitimate: false, reason: 'grant-timeout-mismatch' };
  if (!Number.isSafeInteger(binding.maxRounds) || binding.maxRounds < 2 || binding.maxRounds > 8 || project.grant.maxRounds !== binding.maxRounds || (project.grant.pause === true) !== binding.pause) return { legitimate: false, reason: 'grant-mismatch' };
  const deadline = computeDeadline({ createdAt: project.createdAt, timeoutMs: project.grant.timeoutMs, graceMs });
  if (deadline.ok !== true || deadline.deadlineAt !== binding.deadlineAt) return { legitimate: false, reason: 'project-deadline-mismatch' };
  const callback = isPlainObject(observation.callback) ? observation.callback : null;
  if (callback === null || callback.targetId !== binding.targetId) return { legitimate: false, reason: 'callback-target-mismatch' };
  if (isPositiveStop(observation) !== true) return { legitimate: false, reason: 'root-not-positively-stopped' };
  const rounds = Array.isArray(project.rounds) ? project.rounds : null;
  if (rounds === null || rounds.length === 0) return { legitimate: false, reason: 'no-round-lineage' };
  if (rounds.length > binding.maxRounds || project.roundsUsed !== rounds.length || project.pendingRound != null) return { legitimate: false, reason: 'round-lineage-incomplete' };
  const attemptIds = new Set();
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    if (!isStoppedRound(round) || round.index !== index + 1 || typeof round.attemptId !== 'string' || !round.attemptId.trim() || attemptIds.has(round.attemptId)) return { legitimate: false, reason: 'round-lineage-unproven' };
    attemptIds.add(round.attemptId);
  }
  const original = rounds.find((round) => isPlainObject(round) && round.attemptId === binding.attemptId);
  if (original === undefined) return { legitimate: false, reason: 'original-attempt-not-in-lineage' };
  if (isStoppedRound(original) !== true) return { legitimate: false, reason: 'original-round-not-stopped' };
  const last = rounds[rounds.length - 1];
  if (isPlainObject(last) !== true || last.attemptId !== observation.attemptId) return { legitimate: false, reason: 'current-round-mismatch' };
  if (project.roundsUsed !== last.index) return { legitimate: false, reason: 'current-round-index-mismatch' };
  if (isStoppedRound(last) !== true) return { legitimate: false, reason: 'current-round-not-stopped' };
  const workers = Array.isArray(project.workers) ? project.workers : null;
  if (workers === null) return { legitimate: false, reason: 'workers-unreadable' };
  for (const worker of workers) {
    const attempts = Array.isArray(worker?.attempts) ? worker.attempts : null;
    if (attempts === null || attempts.length === 0) return { legitimate: false, reason: 'owned-work-unproven' };
    for (const attempt of attempts) {
      if (isPlainObject(attempt) !== true) return { legitimate: false, reason: 'owned-work-unproven' };
      if (attempt.stopConfirmed !== true) return { legitimate: false, reason: 'owned-work-unproven' };
      if (!isExplicitZero(attempt.activeJobs)) return { legitimate: false, reason: 'owned-work-unproven' };
      if (!isExplicitZero(attempt.activeChildren)) return { legitimate: false, reason: 'owned-child-count-unknown' };
    }
  }
  return { legitimate: true, reason: 'recurrent-lineage', attemptId: observation.attemptId };
}

/** Deterministic bounded event id for the single needs-input wake of one attempt. */
export function watchdogEventId({ taskId, attemptId } = {}) {
  const digest = createHash('sha256').update(JSON.stringify([String(taskId ?? ''), String(attemptId ?? ''), WATCHDOG_EVENT_LOGICAL_ID]), 'utf8').digest('hex');
  return `watchdog-${digest}`;
}

/** Bounded, factual, instruction-free summary of the observed state. */
export function watchdogSummary({ taskId, attemptId, observation, error } = {}) {
  const parts = [
    `[watchdog] deadline reached for task ${String(taskId ?? '')} attempt ${String(attemptId ?? '')}`,
    `status=${observation?.status ?? 'unavailable'}`,
    `stopConfirmed=${observation?.stopConfirmed === true}`,
    `activeJobs=${Number.isInteger(observation?.activeJobs) ? observation.activeJobs : 'unknown'}`,
    `activeChildren=${Number.isInteger(observation?.activeChildren) ? observation.activeChildren : 'unknown'}`,
  ];
  if (error !== undefined && error !== null) parts.push(`checkError=${String(error.code ?? 'WATCHDOG_CHECK_FAILED')}`);
  parts.push('no stop is inferred; this is a status observation only');
  const text = parts.join(' ');
  return text.length > WATCHDOG_SUMMARY_CHARS ? `${text.slice(0, WATCHDOG_SUMMARY_CHARS - 1)}…` : text;
}

/** Trim an observation to the bounded, secret-free fields a receipt may carry. */
function boundedObservation(observation) {
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) return null;
  return {
    status: typeof observation.status === 'string' ? observation.status.slice(0, 60) : 'unknown',
    stopConfirmed: observation.stopConfirmed === true,
    activeJobs: Number.isInteger(observation.activeJobs) ? observation.activeJobs : null,
    activeChildren: Number.isInteger(observation.activeChildren) ? observation.activeChildren : null,
  };
}

/**
 * The decoded `bridge_check` payload out of an MCP tools/call reply. The host wraps the
 * service value in `structuredContent` (or JSON text content); a refusal is `isError`.
 */
export function decodeCheckObservation(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'malformed-check-reply' };
  }
  if (payload.error !== undefined && payload.error !== null) {
    return { ok: false, reason: 'check-rpc-error', error: { code: payload.error.code ?? 'RPC_ERROR', message: String(payload.error.message ?? '').slice(0, 200) } };
  }
  const result = payload.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, reason: 'malformed-check-reply' };
  }
  if (result.isError === true) return { ok: false, reason: 'check-refused' };
  if (result.structuredContent !== null && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    return { ok: true, value: result.structuredContent };
  }
  if (Array.isArray(result.content)) {
    const text = result.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')?.text;
    if (typeof text === 'string') {
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, reason: 'malformed-check-reply' };
      }
    }
  }
  return { ok: false, reason: 'malformed-check-reply' };
}

/** Pull the exact task view out of a decoded check payload. */
export function checkTaskView(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.task !== null && typeof value.task === 'object' && !Array.isArray(value.task)) return value.task;
  return typeof value.status === 'string' ? value : null;
}

/** One needs-input event id plus its stable payload for an exact task+attempt. */
function buildNeedsInputEvent({ targetId, taskId, attemptId, summary }) {
  return {
    eventId: watchdogEventId({ taskId, attemptId }),
    taskId,
    attemptId,
    targetId,
    kind: 'needs-input',
    summary,
    resultIds: [],
  };
}

/** Find an existing outbox record for the SAME task and attempt (any state). */
async function findExistingEvent(outbox, { taskId, attemptId }) {
  if (outbox === null || typeof outbox.listEvents !== 'function') return { supported: false, record: null };
  const records = await outbox.listEvents({});
  const match = records.find((record) => record?.taskId === taskId && record?.attemptId === attemptId);
  return { supported: true, record: match ?? null };
}

/**
 * Arm exactly one watchdog for one exact root attempt.
 *
 * Returns a verdict; it never throws into a carrier request path and never writes to
 * stdout. A duplicate/ambiguous arm is a refusal, never a second timer.
 *
 * @param {object} spec - config, planned arm, and injectable seams.
 * @returns {Promise<{armed: boolean, reason?: string, receipt?: object, spawn?: Function}>}
 */
export async function armWatchdog({
  config,
  plan,
  env = {},
  now = () => Date.now(),
  receiptPath,
  writeArmReceiptImpl = writeArmReceipt,
  readReceiptImpl = readReceipt,
  spawnSidecar = null,
  sidecar = null,
  logger = null,
} = {}) {
  if (plan?.arm !== true) return { armed: false, reason: plan?.reason ?? 'not-armable' };
  const record = {
    taskId: plan.taskId,
    attemptId: plan.attemptId,
    state: 'armed',
    targetId: plan.targetId,
    timeoutMs: Number.isInteger(plan.timeoutMs) ? plan.timeoutMs : null,
    graceMs: Number.isInteger(config?.graceMs) ? config.graceMs : null,
    deadlineAt: plan.deadlineAt,
    armedAt: now(),
    checks: 0,
    // The durable recurrent PROJECT binding (absent for ordinary/legacy arms, whose
    // receipt bytes and semantics therefore stay exactly as before).
    ...(isPlainObject(plan.project) ? { project: plan.project } : {}),
  };
  try {
    await writeArmReceiptImpl({ filePath: receiptPath, record });
  } catch (error) {
    if (error?.code === 'watchdog/receipt-exists') {
      // An identical replay (or a crashed arm) must never start a second timer/check. The
      // FIRST receipt and its live owner are left EXACTLY untouched: rewriting it to
      // `ambiguous` here would make the already-spawned sidecar refuse a legitimate first
      // check. Crash ambiguity stays fail-closed because the receipt is never adopted or
      // re-armed; it is simply preserved as it is.
      const existing = await readReceiptImpl({ filePath: receiptPath }).catch(() => ({ ok: false, reason: 'unreadable' }));
      const state = existing?.ok === true ? existing.record.state : 'unreadable';
      logger?.({ phase: 'watchdog-arm', state: 'duplicate', receiptState: state, preserved: true });
      return { armed: false, reason: 'duplicate-arm', existingState: state };
    }
    logger?.({ phase: 'watchdog-arm', state: 'refused', code: error?.code ?? 'WATCHDOG_ARM_FAILED' });
    return { armed: false, reason: 'receipt-write-failed' };
  }
  if (typeof spawnSidecar === 'function') {
    try {
      const started = spawnSidecar({ config, plan, receiptPath, taskId: plan.taskId, attemptId: plan.attemptId });
      if (started?.ok === false) {
        await updateReceipt({ filePath: receiptPath, record: { ...record, state: 'unavailable', reason: 'sidecar-spawn-failed' } }).catch(() => undefined);
        return { armed: false, reason: 'sidecar-spawn-failed' };
      }
    } catch {
      await updateReceipt({ filePath: receiptPath, record: { ...record, state: 'unavailable', reason: 'sidecar-spawn-failed' } }).catch(() => undefined);
      return { armed: false, reason: 'sidecar-spawn-failed' };
    }
  }
  logger?.({ phase: 'watchdog-arm', state: 'armed', deadlineAt: plan.deadlineAt });
  return { armed: true, receipt: record };
}

/**
 * The one bounded check and its one possible enqueue. Performs NO external send.
 *
 * @param {object} spec - validated config, exact identity, clock/timer/request/outbox seams.
 * @returns {Promise<{outcome: string, receipt: object}>}
 */
export async function runWatchdogCheck({
  config,
  taskId,
  attemptId,
  receiptPath,
  readReceiptImpl = readReceipt,
  updateReceiptImpl = updateReceipt,
  claimReceiptImpl = claimReceipt,
  now = () => Date.now(),
  sleep = defaultSleep,
  request = null,
  createOutbox = (options) => createWakeOutbox(options),
  signal = null,
  logger = null,
} = {}) {
  const pinnedTargetId = config?.targetId ?? null;
  const base = {
    taskId,
    attemptId,
    targetId: pinnedTargetId,
    deadlineAt: null,
  };
  const finish = async (record) => {
    const written = await updateReceiptImpl({ filePath: receiptPath, record }).catch(() => null);
    return written ?? record;
  };

  const existing = await readReceiptImpl({ filePath: receiptPath });
  if (existing.ok !== true) {
    // A missing receipt proves no arm: refuse in memory and never create/overwrite one.
    return { outcome: 'refused', receipt: { ...base, state: 'unavailable', reason: 'missing-receipt', checks: 0 } };
  }
  const armed = existing.record;
  // Immutable identity is verified BEFORE any check. A receipt for another task/attempt or
  // another pinned target is refused without rewriting the file.
  if (receiptMatchesIdentity(armed, { taskId, attemptId }) !== true) {
    return { outcome: 'refused', receipt: { ...armed, reason: 'receipt-identity-mismatch' } };
  }
  if (pinnedTargetId !== null && armed.targetId !== pinnedTargetId) {
    return { outcome: 'refused', receipt: { ...armed, reason: 'receipt-target-mismatch' } };
  }
  if (armed.state !== 'armed') {
    // A receipt that is not `armed` for this exact attempt is ambiguous or already done:
    // never run a second check, never adopt it and never rewrite it.
    const state = armed.state === 'checking' ? 'ambiguous' : armed.state;
    return { outcome: 'refused', receipt: { ...armed, state, reason: `receipt-not-armed:${armed.state}` } };
  }

  // The ONE check is claimed with an exclusive marker before the state transition, so two
  // processes that both read `armed` cannot both run. A marker left by a crash is never
  // reclaimed: the attempt stays ambiguous instead of being double-checked.
  const claim = await claimReceiptImpl({ filePath: receiptPath, taskId, attemptId, targetId: armed.targetId, now });
  if (claim.claimed !== true) {
    return { outcome: 'refused', receipt: { ...armed, reason: `check-${claim.reason ?? 'not-claimed'}` } };
  }

  const wake = { ...armed, state: 'checking', checks: (armed.checks ?? 0) + 1, checkedAt: now() };
  await updateReceiptImpl({ filePath: receiptPath, record: wake }).catch(() => undefined);

  const waitMs = Number.isInteger(armed.deadlineAt) ? Math.max(0, armed.deadlineAt - now()) : 0;
  if (waitMs > MAX_TIMER_MS) {
    // An unsupported huge wait is refused rather than handed to a timer that would fire
    // immediately (and check far too early) or never.
    return { outcome: 'refused', receipt: await finish({ ...wake, state: 'unavailable', reason: 'unsupported-wait' }) };
  }
  if (waitMs > 0) {
    try {
      // One finite wait; `sleep` is an injected seam so tests never wait in real time.
      if (signal === null || signal === undefined) await sleep(waitMs);
      else await sleep(waitMs, { signal });
    } catch {
      // A signalled wait is not a check: record it and stop without sending anything.
      return { outcome: 'refused', receipt: await finish({ ...wake, state: 'unavailable', reason: 'wait-aborted' }) };
    }
  }

  let decoded = null;
  let requestError = null;
  try {
    const payload = await request({ config, taskId, attemptId, signal });
    decoded = decodeCheckObservation(payload);
  } catch (error) {
    requestError = { code: error?.code ?? 'WATCHDOG_CHECK_FAILED', message: String(error?.message ?? error).slice(0, 200) };
    decoded = { ok: false, reason: 'check-unreachable' };
  }

  const observation = decoded.ok === true ? checkTaskView(decoded.value) : null;
  // The observation must be for EXACTLY this task and attempt. A reply for another
  // task/attempt with perfect positive counts is never evidence for this attempt — UNLESS
  // it is a legible bounded-recurrent continuation bound at arming, proven strictly below.
  const identityMatches = observation !== null && observation.id === taskId && observation.attemptId === attemptId;
  const lineage = decoded.ok === true && identityMatches !== true && observation !== null && observation.id === taskId
    ? evaluateRecurrentLineage({ observation, binding: armed.project ?? null, graceMs: config?.graceMs })
    : null;
  const lineageLegitimate = lineage !== null && lineage.legitimate === true;
  // A legitimate lineage is reinterpreted as THIS project's CURRENT bounded attempt; every
  // other changed-attempt reply keeps the armed attempt identity and stays an anomaly.
  const effectiveAttemptId = lineageLegitimate ? observation.attemptId : attemptId;
  const positive = decoded.ok === true && (identityMatches || lineageLegitimate) && isPositiveStop(observation);
  const quiet = positive && isQuietStop(observation);
  const bounded = boundedObservation(observation);
  const summary = watchdogSummary({ taskId, attemptId: effectiveAttemptId, observation: bounded, error: requestError });

  // Quiet positive stop (completed/cancelled): factual recording only, no callback.
  if (quiet) {
    const record = await finish({ ...wake, state: 'resolved', outcome: 'positive-stop', finishedAt: now(), observed: bounded?.status ?? null, observedStopConfirmed: true, observedActiveJobs: 0, observedActiveChildren: 0, reason: 'quiet-positive-stop' });
    logger?.({ phase: 'watchdog-check', outcome: 'positive-stop' });
    return { outcome: 'positive-stop', receipt: record };
  }

  // Only now is the accepted target outbox touched, and only to read this attempt's record.
  let outbox = null;
  let outboxError = null;
  try {
    outbox = createOutbox({
      dir: resolveTargetOutboxDir({ stateRoot: config.stateRoot, targetId: pinnedTargetId }),
      authority: TRUSTED_CONTROLLER_AUTHORITY,
      allowedTargetIds: [pinnedTargetId],
      maxSummaryChars: 8192,
    });
  } catch (error) {
    outboxError = { code: error?.code ?? 'WATCHDOG_OUTBOX_FAILED', message: String(error?.message ?? error).slice(0, 200) };
  }

  let existingEvent = null;
  let lookupProven = false;
  if (outbox !== null) {
    try {
      const found = await findExistingEvent(outbox, { taskId, attemptId: effectiveAttemptId });
      if (found.supported !== true) {
        // "No event" was NOT proven when the outbox cannot be listed: fail closed with
        // bounded unavailable evidence instead of enqueueing as though nothing existed.
        outboxError = outboxError ?? { code: 'WATCHDOG_OUTBOX_LOOKUP_UNSUPPORTED', message: 'the target outbox does not support listing events' };
      } else {
        lookupProven = true;
        existingEvent = found.record;
      }
    } catch {
      existingEvent = null;
      outboxError = outboxError ?? { code: 'WATCHDOG_OUTBOX_READ_FAILED', message: 'the target outbox could not be read' };
    }
  }

  const reason = requestError !== null
    ? (decoded?.reason ?? 'check-unreachable')
    : (decoded.ok !== true ? (decoded?.reason ?? 'state-unconfirmed') : (identityMatches !== true && lineageLegitimate !== true ? 'check-identity-mismatch' : (positive ? 'failed-without-callback' : 'state-unconfirmed')));
  const observationFields = {
    observed: bounded?.status ?? null,
    observedStopConfirmed: bounded?.stopConfirmed === true,
    observedActiveJobs: bounded?.activeJobs ?? null,
    observedActiveChildren: bounded?.activeChildren ?? null,
  };

  // An existing same-attempt callback already covers this attempt: preserve it, record
  // its state (including an ambiguous one) and never resend or rewrite it.
  if (existingEvent !== null) {
    const record = await finish({
      ...wake,
      ...observationFields,
      state: 'resolved',
      outcome: 'existing-callback',
      finishedAt: now(),
      existingEventId: typeof existingEvent.eventId === 'string' ? existingEvent.eventId : null,
      existingEventState: typeof existingEvent.state === 'string' ? existingEvent.state : null,
      reason: `existing-callback:${existingEvent.state ?? 'unknown'}`,
    });
    if (outbox !== null) await outbox.close().catch(() => undefined);
    logger?.({ phase: 'watchdog-check', outcome: 'existing-callback', eventState: existingEvent.state ?? null });
    return { outcome: 'existing-callback', receipt: record };
  }

  // Unresolved/unavailable without a proven "no event": at most ONE stable bounded
  // needs-input event, or a bounded unavailable record and nothing sent.
  if (outbox === null || lookupProven !== true) {
    const record = await finish({
      ...wake,
      ...observationFields,
      state: 'unavailable',
      outcome: 'unavailable',
      finishedAt: now(),
      reason: outboxError?.code ?? 'outbox-unavailable',
      ...(requestError === null && outboxError === null ? {} : { error: requestError ?? outboxError }),
    });
    if (outbox !== null) await outbox.close().catch(() => undefined);
    logger?.({ phase: 'watchdog-check', outcome: 'unavailable', code: outboxError?.code ?? null });
    return { outcome: 'unavailable', receipt: record };
  }

  const event = buildNeedsInputEvent({ targetId: pinnedTargetId, taskId, attemptId: effectiveAttemptId, summary });
  try {
    const verdict = await outbox.enqueue(event);
    const record = await finish({
      ...wake,
      ...observationFields,
      state: 'enqueued',
      outcome: (identityMatches === true || lineageLegitimate) && decoded.ok === true ? 'unresolved' : 'unavailable',
      finishedAt: now(),
      enqueuedEventId: event.eventId,
      eventState: typeof verdict?.event?.state === 'string' ? verdict.event.state : 'pending',
      reason,
      ...(requestError === null ? {} : { error: requestError }),
    });
    logger?.({ phase: 'watchdog-check', outcome: record.outcome, eventState: record.eventState, duplicate: verdict?.duplicate === true });
    return { outcome: record.outcome, receipt: record };
  } catch (error) {
    const record = await finish({
      ...wake,
      ...observationFields,
      state: 'unavailable',
      outcome: 'unavailable',
      finishedAt: now(),
      reason: 'enqueue-failed',
      error: { code: error?.code ?? 'WATCHDOG_ENQUEUE_FAILED', message: String(error?.message ?? error).slice(0, 200) },
    });
    logger?.({ phase: 'watchdog-check', outcome: 'unavailable', code: error?.code ?? 'WATCHDOG_ENQUEUE_FAILED' });
    return { outcome: 'unavailable', receipt: record };
  } finally {
    await outbox.close().catch(() => undefined);
  }
}

/**
 * The carrier-side one-shot integration: observe one `bridge_submit` reply and arm at
 * most one watchdog. It returns a verdict for diagnostics and NEVER throws, so a
 * watchdog fault can never corrupt the MCP response. It also never writes stdout.
 */
export async function observeSubmitForWatchdog({
  config,
  call,
  env = {},
  now = () => Date.now(),
  requestBudgetTimeoutMs = null,
  receiptFilePath: receiptFilePathFn,
  arm = armWatchdog,
  spawnSidecar = null,
  sidecar = null,
  logger = null,
} = {}) {
  try {
    if (config === null || config?.enabled !== true) return { armed: false, reason: 'watchdog-disabled' };
    if (isSuccessfulSubmitReply(call) !== true) return { armed: false, reason: 'not-a-successful-submit' };
    const plan = planWatchdogArm({ config, result: call.result, requestBudgetTimeoutMs });
    if (plan.arm !== true) return { armed: false, reason: plan.reason };
    const receiptPath = receiptFilePathFn({ receiptRoot: config.receiptRoot, taskId: plan.taskId, attemptId: plan.attemptId });
    return await arm({ config, plan, env, now, receiptPath, spawnSidecar, sidecar, logger });
  } catch (error) {
    logger?.({ phase: 'watchdog-observe', state: 'error', code: error?.code ?? 'WATCHDOG_OBSERVE_FAILED' });
    return { armed: false, reason: 'observe-failed' };
  }
}

export { WATCHDOG_SCHEMA_VERSION };
