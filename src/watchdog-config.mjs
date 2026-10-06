// src/watchdog-config.mjs
//
// Trusted-controller configuration and the ONE-SHOT deadline model for the optional
// bridge deadline watchdog (see docs/deadline-watchdog.md and watchdog-brief.md).
//
// This module is pure validation plus pure planning: it opens no file, starts no timer,
// performs no request and sends nothing. It exists so the carrier, the sidecar and the
// tests all agree on one validated shape and one arming decision.
//
// Authority rules encoded here, not delegated to callers:
//   * the operator owns the config file; the opt-in switch is the MCP environment
//     variable `DSH_BRIDGE_WATCHDOG_CONFIG` (an absolute path);
//   * only the nine documented keys are accepted;
//   * every path must be absolute and local; the endpoint must be loopback HTTP(S);
//   * the bound target must equal the configured caller thread AND the real
//     `CODEX_THREAD_ID` of this process — a fallback would forge caller metadata;
//   * a timer is armed only for a granted root with an exact attempt identity and an
//     exact project grant (or validated request) deadline. Anything else refuses arming
//     while leaving the upstream MCP result untouched.

import path from 'node:path';

/** Watchdog config schema version (this module's protocol, not the plugin version). */
export const WATCHDOG_SCHEMA_VERSION = 1;
/** The ONLY accepted config keys. No command, server, pipe, token, env or tool key. */
export const WATCHDOG_CONFIG_KEYS = Object.freeze([
  'enabled',
  'targetId',
  'callerThreadId',
  'stateRoot',
  'receiptRoot',
  'endpoint',
  'credentialFile',
  'graceMs',
  'checkTimeoutMs',
]);
export const DEFAULT_GRACE_MS = 2_000;
export const MAX_GRACE_MS = 60_000;
export const DEFAULT_CHECK_TIMEOUT_MS = 70_000;
export const MIN_CHECK_TIMEOUT_MS = 1_000;
export const MAX_CHECK_TIMEOUT_MS = 120_000;
/** Largest project/budget timeout the bridge contract can grant (24 h). */
export const MAX_PROJECT_TIMEOUT_MS = 86_400_000;
/** Largest deadline horizon the watchdog may wait for: grant + grace. */
export const MAX_DEADLINE_HORIZON_MS = MAX_PROJECT_TIMEOUT_MS + MAX_GRACE_MS;
/** Largest finite wait a Node timer accepts without firing early. */
export const MAX_TIMER_MS = 2_147_483_647;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const REMOTE_PATH_RE = /^[\\/]{2}/;
/** Environment variable that opts a carrier process in. */
export const WATCHDOG_CONFIG_ENV = 'DSH_BRIDGE_WATCHDOG_CONFIG';
/** Fixed bounded summary budget for the one needs-input event. */
export const WATCHDOG_SUMMARY_CHARS = 800;
const MAX_IDENTIFIER_CHARS = 200;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export class WatchdogConfigError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'WatchdogConfigError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function boundedOpaque(value, field, max = MAX_IDENTIFIER_CHARS) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WatchdogConfigError('watchdog/invalid-config', `${field} must be a nonblank string`, { field });
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new WatchdogConfigError('watchdog/invalid-config', `${field} must not contain control characters`, { field });
  }
  const text = value.trim();
  if (text.length > max) {
    throw new WatchdogConfigError('watchdog/invalid-config', `${field} must be at most ${max} characters`, { field });
  }
  return text;
}

/**
 * Whether a configured path is an absolute LOCAL path. UNC/remote paths
 * (`\\server\share`, `//server/share`, `\\?\...`) are refused on every platform so a
 * watchdog can never be pointed at a network share, and a bare drive-relative path
 * (`C:x`) is not absolute.
 */
export function isLocalAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (REMOTE_PATH_RE.test(value)) return false;
  if (!path.isAbsolute(value)) return false;
  if (process.platform === 'win32') return WINDOWS_DRIVE_RE.test(value);
  return true;
}

function absolutePath(value, field) {
  const text = boundedOpaque(value, field, 4096);
  if (!isLocalAbsolutePath(text)) {
    throw new WatchdogConfigError('watchdog/invalid-config', `${field} must be an absolute local path (UNC/remote paths are refused)`, { field });
  }
  return path.resolve(text);
}

/**
 * A loopback HTTP endpoint only. Remote hosts, other schemes, credentials embedded in
 * the URL and non-loopback addresses are refused: the watchdog may talk to the local
 * bridge and nothing else.
 */
function loopbackEndpoint(value) {
  const text = boundedOpaque(value, 'endpoint', 4096);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new WatchdogConfigError('watchdog/invalid-config', 'endpoint must be a valid URL', { field: 'endpoint' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WatchdogConfigError('watchdog/invalid-config', 'endpoint must use http or https', { field: 'endpoint' });
  }
  if (url.username !== '' || url.password !== '') {
    throw new WatchdogConfigError('watchdog/invalid-config', 'endpoint must not embed credentials', { field: 'endpoint' });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new WatchdogConfigError('watchdog/invalid-config', 'endpoint must be a loopback address so the watchdog can only reach the local bridge', { field: 'endpoint' });
  }
  return url.toString();
}

/**
 * Validate the operator watchdog configuration.
 *
 * Absent/disabled configuration is OFF and changes nothing. Invalid configuration is a
 * typed refusal; the caller decides whether that is fatal (sidecar) or merely disables
 * the optional feature (carrier), and the carrier logs only the code and field.
 *
 * @param {unknown} raw - parsed JSON config object.
 * @param {{env?: object}} [host] - environment used only for the caller binding.
 * @returns {{enabled: false, reason: string}|{enabled: true, targetId: string, callerThreadId: string, stateRoot: string, receiptRoot: string, endpoint: string, credentialFile: string, graceMs: number, checkTimeoutMs: number}}
 */
export function normalizeWatchdogConfig(raw, host = {}) {
  if (raw === undefined || raw === null) {
    return { enabled: false, reason: 'watchdog config is absent' };
  }
  if (!isPlainObject(raw)) {
    throw new WatchdogConfigError('watchdog/invalid-config', 'the watchdog config must be a JSON object', {});
  }
  for (const key of Object.keys(raw)) {
    if (!WATCHDOG_CONFIG_KEYS.includes(key)) {
      throw new WatchdogConfigError(
        'watchdog/invalid-config',
        `watchdog config field "${key}" is not permitted; the allowed fields are ${WATCHDOG_CONFIG_KEYS.join(', ')}`,
        { field: key },
      );
    }
  }
  if (raw.enabled !== true) {
    if (raw.enabled !== false && raw.enabled !== undefined) {
      throw new WatchdogConfigError('watchdog/invalid-config', 'enabled must be exactly true or false when present', { field: 'enabled' });
    }
    return { enabled: false, reason: 'watchdog is disabled' };
  }
  const targetId = boundedOpaque(raw.targetId, 'targetId');
  const callerThreadId = raw.callerThreadId === undefined ? targetId : boundedOpaque(raw.callerThreadId, 'callerThreadId');
  if (callerThreadId !== targetId) {
    throw new WatchdogConfigError(
      'watchdog/caller-mismatch',
      'callerThreadId must equal the bound targetId: a watchdog is bound to exactly one originating chat',
      { field: 'callerThreadId' },
    );
  }
  const env = host.env ?? {};
  const fromEnv = env?.CODEX_THREAD_ID;
  if (typeof fromEnv !== 'string' || fromEnv.trim().length === 0) {
    throw new WatchdogConfigError(
      'watchdog/caller-unavailable',
      'CODEX_THREAD_ID is not set for this process; refusing to arm without the actual originating chat identity',
      { field: 'CODEX_THREAD_ID' },
    );
  }
  if (fromEnv.trim() !== targetId) {
    throw new WatchdogConfigError(
      'watchdog/caller-mismatch',
      'the running CODEX_THREAD_ID does not equal the configured targetId',
      { field: 'CODEX_THREAD_ID' },
    );
  }
  const stateRoot = absolutePath(raw.stateRoot, 'stateRoot');
  const receiptRoot = absolutePath(raw.receiptRoot, 'receiptRoot');
  const endpoint = loopbackEndpoint(raw.endpoint);
  const credentialFile = absolutePath(raw.credentialFile, 'credentialFile');
  const graceMs = raw.graceMs === undefined ? DEFAULT_GRACE_MS : raw.graceMs;
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > MAX_GRACE_MS) {
    throw new WatchdogConfigError('watchdog/invalid-config', `graceMs must be an integer 0..${MAX_GRACE_MS}`, { field: 'graceMs' });
  }
  const checkTimeoutMs = raw.checkTimeoutMs === undefined ? DEFAULT_CHECK_TIMEOUT_MS : raw.checkTimeoutMs;
  if (!Number.isInteger(checkTimeoutMs) || checkTimeoutMs < MIN_CHECK_TIMEOUT_MS || checkTimeoutMs > MAX_CHECK_TIMEOUT_MS) {
    throw new WatchdogConfigError(
      'watchdog/invalid-config',
      `checkTimeoutMs must be an integer ${MIN_CHECK_TIMEOUT_MS}..${MAX_CHECK_TIMEOUT_MS}`,
      { field: 'checkTimeoutMs' },
    );
  }
  return { enabled: true, targetId, callerThreadId, stateRoot, receiptRoot, endpoint, credentialFile, graceMs, checkTimeoutMs };
}

/**
 * The exact deadline for one root attempt: anchored at the task's own `createdAt`, plus
 * the host-resolved project grant timeout (or the validated request budget) plus grace.
 * No other anchor is accepted. Non-finite, non-safe-integer, out-of-range and overflow
 * values are refused rather than turned into a timer that fires immediately or never.
 *
 * @param {{createdAt: unknown, timeoutMs: unknown, graceMs: number}} spec
 * @returns {{ok: true, deadlineAt: number}|{ok: false, reason: string}}
 */
export function computeDeadline({ createdAt, timeoutMs, graceMs } = {}) {
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return { ok: false, reason: 'no-created-at' };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return { ok: false, reason: 'no-grant-or-budget-timeout' };
  if (timeoutMs > MAX_PROJECT_TIMEOUT_MS) return { ok: false, reason: 'timeout-out-of-range' };
  const grace = Number.isInteger(graceMs) && graceMs >= 0 && graceMs <= MAX_GRACE_MS ? graceMs : DEFAULT_GRACE_MS;
  const deadlineAt = createdAt + timeoutMs + grace;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= createdAt) return { ok: false, reason: 'deadline-overflow' };
  if (deadlineAt - createdAt > MAX_DEADLINE_HORIZON_MS) return { ok: false, reason: 'deadline-out-of-range' };
  return { ok: true, deadlineAt };
}

/**
 * Decode the value out of one MCP `tools/call` result envelope. The host wraps the tool
 * value in `structuredContent` and ALSO mirrors it as JSON text in `content`; a refusal
 * is `isError:true` with no value. This is the ONLY place the real host wire shape is
 * decoded, so the carrier, the sidecar and the tests agree.
 *
 * @param {unknown} result - the `result` member of a JSON-RPC tools/call reply.
 * @returns {object|null} the structured tool value, or null.
 */
export function decodeToolResultValue(result) {
  if (!isPlainObject(result)) return null;
  if (result.isError === true) return null;
  if (isPlainObject(result.structuredContent)) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const text = result.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')?.text;
    if (typeof text === 'string') {
      try {
        const parsed = JSON.parse(text);
        return isPlainObject(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The exact attempt identity the watchdog is allowed to watch: the REAL host task view
 * reports `id` (never `taskId`) plus `attemptId`, and only a ROOT attempt may be watched.
 * A worker/child carries `parentTaskId`; a root may not already own children.
 *
 * @param {unknown} value - decoded host task view.
 * @returns {{ok: true, taskId: string, attemptId: string}|{ok: false, reason: string}}
 */
export function normalizeWatchdogIdentity(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'no-task' };
  const id = typeof value.id === 'string' ? value.id.trim() : (typeof value.taskId === 'string' ? value.taskId.trim() : '');
  const attemptId = typeof value.attemptId === 'string' ? value.attemptId.trim() : '';
  if (!id || id.length > MAX_IDENTIFIER_CHARS) return { ok: false, reason: 'no-task-id' };
  if (!attemptId || attemptId.length > MAX_IDENTIFIER_CHARS) return { ok: false, reason: 'no-attempt-id' };
  if (value.parentTaskId !== undefined && value.parentTaskId !== null) return { ok: false, reason: 'not-a-root-task' };
  if (Array.isArray(value.children) && value.children.length > 0) return { ok: false, reason: 'not-a-root-task' };
  return { ok: true, taskId: id, attemptId };
}

/**
 * The grant timeout the host actually resolved for this task. A project task reports
 * `project.grant.timeoutMs`; an ordinary explicit-budget task reports the validated
 * request budget. Both are read from the host result, never invented.
 *
 * @param {unknown} taskResult - host task view.
 * @returns {number|null} exact positive integer milliseconds, or null.
 */
export function resolveGrantTimeoutMs(taskResult) {
  const candidates = [
    taskResult?.project?.grant?.timeoutMs,
    taskResult?.project?.grant?.projectTimeoutMs,
    taskResult?.effectivePacket?.budget?.timeoutMs,
    taskResult?.packet?.project?.projectTimeoutMs,
    taskResult?.packet?.budget?.timeoutMs,
  ];
  for (const value of candidates) {
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

/**
 * The durable, bounded project identity the watchdog binds at ARMING for a legitimate
 * bounded RECURRENT project. It is built only from the real public task view and only when
 * the project actually opted into recurrence: an ordinary or legacy grant produces NO
 * binding, so its armed deadline and receipt semantics stay exactly as before.
 *
 * Both identities are kept: the OUTER task anchor (`taskCreatedAt`) and the immutable
 * PROJECT anchor (`projectCreatedAt`, which may differ slightly because the project record
 * is prepared before `TaskStore.submit`). The PROJECT anchor drives the deadline; the outer
 * task identity is retained for identity comparison.
 *
 * @param {{project: unknown, taskCreatedAt: unknown, attemptId: unknown, targetId: string, timeoutMs: number, graceMs: unknown}} spec
 * @returns {object|null} bounded binding, or null when the arm is not a recurrent project.
 */
export function buildProjectBinding({ project, taskCreatedAt, attemptId, targetId, timeoutMs, graceMs } = {}) {
  if (!isPlainObject(project)) return null;
  if (project.grant?.recurrent !== true) return null;
  const projectId = typeof project.projectId === 'string' ? project.projectId.trim() : '';
  if (!projectId || projectId.length > MAX_IDENTIFIER_CHARS) return null;
  if (!Number.isSafeInteger(project.createdAt) || project.createdAt <= 0) return null;
  if (typeof attemptId !== 'string' || attemptId.trim().length === 0) return null;
  return {
    projectId,
    projectCreatedAt: project.createdAt,
    taskCreatedAt: Number.isSafeInteger(taskCreatedAt) ? taskCreatedAt : null,
    attemptId: attemptId.trim(),
    targetId,
    recurrent: true,
    maxRounds: Number.isInteger(project.grant?.maxRounds) ? project.grant.maxRounds : null,
    pause: project.grant?.pause === true,
    timeoutMs,
    graceMs: Number.isInteger(graceMs) ? graceMs : null,
  };
}

/**
 * The ONE arming decision for an observed submission.
 *
 * A project task carries `project.grant.timeoutMs` in its view. An ordinary accepted
 * submit view does NOT expose `packet`/`effectivePacket`, so its deadline can only come
 * from the explicit budget of the request that was successfully validated — supplied by
 * the carrier as `requestBudgetTimeoutMs`. With neither, arming is refused rather than
 * guessed.
 *
 * @param {{config: object, result?: unknown, requestBudgetTimeoutMs?: unknown}} spec - validated config plus host tool result.
 * @returns {{arm: true, taskId: string, attemptId: string, targetId: string, timeoutMs: number, createdAt: number, deadlineAt: number, project?: object}
 *   |{arm: false, reason: string}}
 */
export function planWatchdogArm({ config, result, requestBudgetTimeoutMs } = {}) {
  if (!isPlainObject(config) || config.enabled !== true) return { arm: false, reason: 'watchdog-disabled' };
  // The real host tool result is `{content, structuredContent}`; a decoded view is also
  // accepted directly (tests and internal callers).
  const taskResult = isPlainObject(result?.task) ? result.task : (decodeToolResultValue(result) ?? (isPlainObject(result) ? result : null));
  if (taskResult === null) return { arm: false, reason: 'no-task-view' };
  const identity = normalizeWatchdogIdentity(taskResult);
  if (identity.ok !== true) return { arm: false, reason: identity.reason };
  const callback = isPlainObject(taskResult?.callback) ? taskResult.callback : null;
  const targetId = callback !== null && typeof callback.targetId === 'string' ? callback.targetId.trim() : '';
  if (!targetId) return { arm: false, reason: 'no-granted-target' };
  if (targetId !== config.targetId) return { arm: false, reason: 'target-mismatch' };
  const granted = resolveGrantTimeoutMs(taskResult);
  const explicitBudget = Number.isSafeInteger(requestBudgetTimeoutMs) && requestBudgetTimeoutMs > 0 ? requestBudgetTimeoutMs : null;
  const timeoutMs = granted ?? explicitBudget;
  if (timeoutMs === null) return { arm: false, reason: 'no-project-grant-or-explicit-budget' };
  // A recurrent project binds its real project identity; the PROJECT anchor is the deadline
  // anchor, never the slightly different outer task `createdAt`.
  const projectBinding = buildProjectBinding({ project: taskResult.project, taskCreatedAt: taskResult.createdAt, attemptId: identity.attemptId, targetId, timeoutMs, graceMs: config.graceMs });
  const anchorCreatedAt = projectBinding !== null ? projectBinding.projectCreatedAt : taskResult.createdAt;
  const deadline = computeDeadline({ createdAt: anchorCreatedAt, timeoutMs, graceMs: config.graceMs });
  if (deadline.ok !== true) return { arm: false, reason: deadline.reason };
  return {
    arm: true,
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    targetId,
    timeoutMs,
    createdAt: anchorCreatedAt,
    deadlineAt: deadline.deadlineAt,
    ...(projectBinding === null ? {} : { project: { ...projectBinding, deadlineAt: deadline.deadlineAt } }),
  };
}

/**
 * Whether a submission reply IS a successful `bridge_submit` (not a refusal, an error
 * envelope or a notification). The host wraps the task view in `structuredContent`, so
 * the decoded value — never `result.task` — decides. Only then may a watchdog be armed.
 *
 * @param {{method?: unknown, name?: unknown, id?: unknown, result?: unknown}} call - decoded request/reply.
 * @returns {boolean}
 */
export function isSuccessfulSubmitReply(call) {
  if (!isPlainObject(call)) return false;
  if (call.method !== 'tools/call') return false;
  if (call.name !== 'bridge_submit') return false;
  if (call.id === undefined || call.id === null) return false;
  const view = decodeToolResultValue(call.result);
  if (!isPlainObject(view)) return false;
  return typeof view.id === 'string' && view.id.trim().length > 0;
}

/** The immutable logical id of the single watchdog event for one attempt. */
export const WATCHDOG_EVENT_LOGICAL_ID = 'deadline-watchdog:needs-input';
