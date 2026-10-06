const DAY_MS = 86_400_000;
const MISSING = Symbol('missing');
const UNREADABLE = Symbol('unreadable');

// Read only known fields. Malformed objects, including throwing proxies and
// accessors, must produce blockers rather than exceptions.
function readField(value, key) {
  if (value === null || typeof value !== 'object') return MISSING;
  try {
    return key in value ? value[key] : MISSING;
  } catch {
    return UNREADABLE;
  }
}

function nonblank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonnegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function durationMilliseconds(days) {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
    return null;
  }
  const milliseconds = days * DAY_MS;
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0
    ? milliseconds
    : null;
}

export function evaluateRetention(task, policy, now) {
  const policyOwner = readField(policy, 'ownerId');
  const successDuration = durationMilliseconds(readField(policy, 'successDays'));
  const failureDuration = durationMilliseconds(readField(policy, 'failureDays'));
  const owner = readField(task, 'ownerId');
  const origin = readField(task, 'origin');
  const id = readField(task, 'id');
  const status = readField(task, 'status');
  const endedAt = readField(task, 'endedAt');
  const resultCollected = readField(task, 'resultCollected');
  const pinned = readField(task, 'pinned');
  const stopConfirmed = readField(task, 'stopConfirmed');
  const activeJobs = readField(task, 'activeJobs');
  const artifactState = readField(task, 'artifactState');

  const ownerValid = nonblank(policyOwner);
  let policyValid = ownerValid && successDuration !== null && failureDuration !== null;
  const timeValid = nonnegativeInteger(now);
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const endWellFormed = nonnegativeInteger(endedAt);
  const endValid = endWellFormed && (!timeValid || endedAt <= now);
  const duration = status === 'completed' ? successDuration : failureDuration;

  let candidate = null;
  if (terminal && endWellFormed && duration !== null) {
    const sum = endedAt + duration;
    if (Number.isSafeInteger(sum) && sum >= 0) {
      candidate = sum;
    } else {
      // A duration must also be representable when applied to this task.
      policyValid = false;
    }
  }

  const eligibleAt = terminal && endValid && policyValid && timeValid
    ? candidate
    : null;
  const reasons = [];

  if (!policyValid) reasons.push('invalid_policy');
  if (!timeValid) reasons.push('invalid_time');
  if (!ownerValid || !nonblank(owner) || owner !== policyOwner) reasons.push('foreign_owner');
  if (origin !== 'codex-bridge' || !nonblank(id)) reasons.push('invalid_identity');
  if (!terminal) reasons.push('nonterminal');
  if (!endValid) reasons.push('invalid_end');
  if (resultCollected !== true) reasons.push('uncollected');
  if (pinned !== MISSING && pinned !== false) reasons.push('pinned');
  if (stopConfirmed !== true) reasons.push('stop_unconfirmed');
  if (activeJobs !== 0) reasons.push('active_jobs');
  if (artifactState !== 'none' && artifactState !== 'merged' &&
      artifactState !== 'preserved' && artifactState !== 'discarded') {
    reasons.push('artifacts_unresolved');
  }
  if (eligibleAt !== null && now < eligibleAt) reasons.push('retention_pending');

  return { eligible: reasons.length === 0, reasons, eligibleAt };
}
