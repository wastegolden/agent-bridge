// src/wake-integration.mjs
//
// Product connection for contract `supervisor-event-wake-v1`.
//
// The accepted callback component (`src/wake-outbox.mjs`, `src/codex-wake-client.mjs`,
// `bin/wake-codex.mjs`) is a controller-only transport with its OWN defaults (1200
// characters, etc.). This module is the missing seam between the accepted core
// (`BridgeSupervisor.config.notificationSink`) and that transport, and it owns exactly
// four things:
//
//  1. `normalizeEventWakeConfig` — validate the serializable host `eventWake` option.
//     The integration limit (8192) is passed EXPLICITLY by this layer; the accepted
//     low-level defaults are never rewritten (intentional compatibility, m3 §2).
//
//  2. `resolveTargetOutboxDir` / `wakeTargetDirName` — one directory per TRUSTED
//     target id. The trailing path segment is the full SHA-256 of the target id, so a
//     target id is data and never a path component; two runners for distinct Codex
//     chats can never consume each other's records. A binding marker file
//     (`target.json`) makes a digest collision fail closed instead of aliasing.
//
//  3. `createTargetOutboxRouter` — the real notification sink. It reuses the accepted
//     `createWakeSink` (never a reimplementation) and lazily constructs ONE durable
//     outbox per configured grant. The sink returns the outbox's own enqueue
//     acknowledgement, which `BridgeSupervisor` interprets as `queued`, never as
//     `delivered`: a configured producer is not proof that a runner delivered anything.
//
//  4. `loadControllerConfig` — the trusted-controller launch shape (paths and limits
//     only, never an env secret). `bin/wake-controller.mjs` is the only caller.
//
// Nothing here performs an external send, spawns a process, opens the Codex transport
// or grants a worker any destination/transport authority. All destination authority
// comes from the operator's top-level `rootCallbackGrants` map.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createWakeSink } from './wake-outbox.mjs';

/** Host `eventWake` schema version (the host config protocol, not the plugin version). */
export const EVENT_WAKE_SCHEMA_VERSION = 1;
/**
 * The single documented bounded INTEGRATION summary limit. It is applied when this
 * layer constructs an outbox/client; the accepted low-level default (1200) is left
 * untouched so old hosts and the old runner keep their exact behaviour.
 */
export const EVENT_WAKE_MAX_SUMMARY_CHARS = 8192;
/**
 * Retained for compatibility with callers that referenced the historical floor. The
 * integration no longer accepts a range: host and controller limits must both be
 * exactly `EVENT_WAKE_MAX_SUMMARY_CHARS`, because a smaller cap can lose a valid raw
 * 8000-character reply plus the controller prefix.
 */
export const MIN_EVENT_WAKE_MAX_SUMMARY_CHARS = 256;
/** Default claim lease for the integration outboxes (same value the old runner used). */
export const EVENT_WAKE_CLAIM_LEASE_MS = 30_000;
/** Trusted-controller authority descriptor. Packaging convention, not an OS sandbox. */
export const TRUSTED_CONTROLLER_AUTHORITY = Object.freeze({ root: true, source: 'trusted-controller' });

const CONTROLLER_CONFIG_KEYS = Object.freeze([
  'stateRoot',
  'targetId',
  'callerThreadId',
  'serverPath',
  'nodePath',
  'idleTimeoutMs',
  'claimLeaseMs',
  'maxSummaryChars',
  'once',
]);
const EVENT_WAKE_KEYS = Object.freeze(['enabled', 'stateRoot', 'maxSummaryChars', 'claimLeaseMs']);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_TARGET_ID_CHARS = 200;

export class WakeIntegrationError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'WakeIntegrationError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Nonblank string with no control characters and a bounded length. */
function boundedOpaque(value, field, max = MAX_TARGET_ID_CHARS) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WakeIntegrationError('eventWake/invalid-config', `${field} must be a nonblank string`, { field });
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new WakeIntegrationError('eventWake/invalid-config', `${field} must not contain control characters`, { field });
  }
  const text = value.trim();
  if (text.length > max) {
    throw new WakeIntegrationError('eventWake/invalid-config', `${field} must be at most ${max} characters`, { field });
  }
  return text;
}

/**
 * Resolve an operator-configured path. Only paths are required to be absolute: a
 * target id is an opaque conversation id, never a path.
 */
function absolutePath(value, field) {
  const text = boundedOpaque(value, field, 4096);
  if (!path.isAbsolute(text)) {
    throw new WakeIntegrationError('eventWake/invalid-config', `${field} must be an absolute path`, { field });
  }
  return path.resolve(text);
}

/**
 * The safe filesystem name for one trusted target id: the FULL SHA-256 digest, so a
 * target id never contributes a path separator, a reserved device name, an NTFS
 * alternate-data-stream colon or a case alias to the directory name.
 * @param {string} targetId - trusted, opaque conversation id (a UUID is valid).
 * @returns {string} directory name.
 */
export function wakeTargetDirName(targetId) {
  const id = boundedOpaque(targetId, 'targetId');
  return `t-${createHash('sha256').update(id, 'utf8').digest('hex')}`;
}

/**
 * The durable outbox directory for one trusted target id under the configured root.
 * Host setup and controller setup both call this, so they can never disagree.
 * @param {{stateRoot: string, targetId: string}} spec - absolute state root and trusted target.
 * @returns {string} absolute directory.
 */
export function resolveTargetOutboxDir({ stateRoot, targetId } = {}) {
  const root = absolutePath(stateRoot, 'stateRoot');
  return path.join(root, wakeTargetDirName(targetId));
}

/**
 * Validate the host `eventWake` option.
 *
 * Disabled/absent configuration is OFF and preserves the historical behaviour exactly
 * (no sink, no reply authority). Enabled configuration is validated fail-closed and
 * may not smuggle a second destination source: grants stay in the top-level
 * `rootCallbackGrants` map, and an injected `notificationSink` together with an enabled
 * `eventWake` is an ambiguous dual configuration and is refused.
 *
 * @param {unknown} raw - `config.eventWake` as supplied by the operator.
 * @param {{notificationSink?: unknown, rootCallbackGrants?: object}} [host] - the rest of the host config.
 * @returns {{enabled: false, reason: string, status: object}|{enabled: true, stateRoot: string, maxSummaryChars: number, claimLeaseMs: number, targets: object[], status: object}}
 */
export function normalizeEventWakeConfig(raw, host = {}) {
  const injectedSink = typeof host.notificationSink === 'function';
  if (raw === undefined || raw === null) {
    return {
      enabled: false,
      reason: 'host eventWake is absent',
      status: { enabled: false, configured: false, producer: false, reason: 'host eventWake is absent' },
    };
  }
  if (!isPlainObject(raw)) {
    throw new WakeIntegrationError('eventWake/invalid-config', 'eventWake must be a plain object when present', { field: 'eventWake' });
  }
  for (const key of Object.keys(raw)) {
    if (!EVENT_WAKE_KEYS.includes(key)) {
      throw new WakeIntegrationError(
        'eventWake/invalid-config',
        `eventWake.${key} is not a permitted field; trusted root callback grants stay in the top-level rootCallbackGrants map and are never nested here`,
        { field: `eventWake.${key}` },
      );
    }
  }
  if (raw.enabled !== true) {
    if (raw.enabled !== false && raw.enabled !== undefined) {
      throw new WakeIntegrationError('eventWake/invalid-config', 'eventWake.enabled must be exactly true or false when present', {
        field: 'eventWake.enabled',
      });
    }
    return {
      enabled: false,
      reason: 'host eventWake is disabled',
      status: { enabled: false, configured: false, producer: false, reason: 'host eventWake is disabled' },
    };
  }
  if (injectedSink) {
    throw new WakeIntegrationError(
      'eventWake/dual-configuration',
      'an injected config.notificationSink and an enabled config.eventWake are ambiguous dual configuration; configure exactly one notification destination',
      { field: 'eventWake' },
    );
  }

  const stateRoot = absolutePath(raw.stateRoot, 'eventWake.stateRoot');
  // ONE fixed integration limit. A smaller producer cap would silently drop an
  // otherwise valid raw 8000-character root reply plus the controller prefix, and an
  // unbounded one would let a host claim a wire contract the runner cannot honour, so
  // the integration pins exactly EVENT_WAKE_MAX_SUMMARY_CHARS.
  const maxSummaryChars = raw.maxSummaryChars === undefined ? EVENT_WAKE_MAX_SUMMARY_CHARS : raw.maxSummaryChars;
  if (!Number.isInteger(maxSummaryChars) || maxSummaryChars !== EVENT_WAKE_MAX_SUMMARY_CHARS) {
    throw new WakeIntegrationError(
      'eventWake/invalid-config',
      `eventWake.maxSummaryChars must be exactly ${EVENT_WAKE_MAX_SUMMARY_CHARS}: the fixed integration wire limit that carries a raw 8000-character reply plus the controller prefix`,
      { field: 'eventWake.maxSummaryChars' },
    );
  }
  const claimLeaseMs = raw.claimLeaseMs === undefined ? EVENT_WAKE_CLAIM_LEASE_MS : raw.claimLeaseMs;
  if (!Number.isInteger(claimLeaseMs) || claimLeaseMs < 1) {
    throw new WakeIntegrationError('eventWake/invalid-config', 'eventWake.claimLeaseMs must be a positive integer', {
      field: 'eventWake.claimLeaseMs',
    });
  }

  const grants = isPlainObject(host.rootCallbackGrants) ? host.rootCallbackGrants : {};
  const targets = [];
  for (const grantId of Object.keys(grants)) {
    const grant = grants[grantId];
    if (!isPlainObject(grant) || typeof grant.targetId !== 'string' || grant.targetId.trim().length === 0) continue;
    const targetId = boundedOpaque(grant.targetId, `rootCallbackGrants.${grantId}.targetId`);
    targets.push({
      grantId,
      targetId,
      dir: resolveTargetOutboxDir({ stateRoot, targetId }),
      maxSummaryChars,
      claimLeaseMs,
    });
  }

  return {
    enabled: true,
    stateRoot,
    maxSummaryChars,
    claimLeaseMs,
    targets,
    status: {
      enabled: true,
      configured: true,
      producer: true,
      maxSummaryChars,
      claimLeaseMs,
      stateRoot,
      targets: targets.map((target) => ({ grantId: target.grantId, targetId: target.targetId, dir: target.dir })),
      // A configured producer is not proof of a live destination. These stay
      // `unknown`, never `false` (which would assert absence nobody verified).
      liveTransport: 'unknown',
      runnerAvailable: 'unknown',
      liveAck: 'unknown',
      reason: 'host outbox producer configured; a live runner, transport and positive acknowledgement are verified independently and are not proven by configuration',
    },
  };
}

/**
 * Write (or verify) the binding marker that makes a target directory provably belong
 * to exactly one trusted target id. A digest collision therefore fails closed rather
 * than letting two chats share records.
 * @param {string} dir - target outbox directory.
 * @param {string} targetId - trusted target id.
 */
async function bindTargetDir(dir, targetId) {
  const marker = path.join(dir, 'target.json');
  await mkdir(dir, { recursive: true });
  let existing = null;
  try {
    existing = JSON.parse(await readFile(marker, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new WakeIntegrationError('eventWake/target-binding', `cannot read the target binding marker ${marker}: ${error?.message ?? error}`, {
        lockPath: marker,
      });
    }
  }
  if (existing !== null && existing !== undefined) {
    if (!isPlainObject(existing) || existing.targetId !== targetId) {
      throw new WakeIntegrationError(
        'eventWake/target-binding',
        `target directory ${dir} is already bound to a different target id; refusing to share one outbox between two chats`,
        { dir },
      );
    }
    return;
  }
  await writeFile(marker, `${JSON.stringify({ schemaVersion: EVENT_WAKE_SCHEMA_VERSION, targetId })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
    // Another process bound it between the read and the write: re-verify.
    const raced = JSON.parse(await readFile(marker, 'utf8'));
    if (!isPlainObject(raced) || raced.targetId !== targetId) {
      throw new WakeIntegrationError('eventWake/target-binding', `target directory ${dir} was concurrently bound to another target id`, { dir });
    }
  });
}

/**
 * The real notification sink for one bridge mount.
 *
 * Construction is cheap and creates no directory; the first use of a target (an event
 * or an `outboxFor` inspection) binds no directory either, and the accepted
 * `createWakeSink` is built once and cached per target. Failures of validation,
 * binding or persistence PROPAGATE to the supervisor, which records
 * `unknown`/`refused` rather than claiming a delivery.
 *
 * `createSink` is an OPTIONAL controller-only test seam (default `createWakeSink`); it
 * cannot widen any worker authority and the accepted outbox module is never modified.
 *
 * @param {{stateRoot: string, targets: object[], maxSummaryChars?: number, claimLeaseMs?: number, createSink?: Function}} spec
 * @returns {{sink: Function, capabilities: Function, targetDirs: Function, outboxFor: Function, close: Function, isClosed: Function}}
 */
export function createTargetOutboxRouter({ stateRoot, targets, maxSummaryChars, claimLeaseMs, createSink = createWakeSink } = {}) {
  if (!Array.isArray(targets)) {
    throw new WakeIntegrationError('eventWake/invalid-config', 'targets must be the normalized eventWake target list', { field: 'targets' });
  }
  if (typeof createSink !== 'function') {
    throw new WakeIntegrationError('eventWake/invalid-config', 'createSink must be a function when supplied', { field: 'createSink' });
  }
  const root = absolutePath(stateRoot, 'stateRoot');
  const limit = Number.isInteger(maxSummaryChars) ? maxSummaryChars : EVENT_WAKE_MAX_SUMMARY_CHARS;
  const lease = Number.isInteger(claimLeaseMs) ? claimLeaseMs : EVENT_WAKE_CLAIM_LEASE_MS;
  const byTarget = new Map();
  for (const target of targets) {
    const targetId = boundedOpaque(target?.targetId, 'targets[].targetId');
    const dir = typeof target?.dir === 'string' && path.isAbsolute(target.dir)
      ? path.resolve(target.dir)
      : resolveTargetOutboxDir({ stateRoot: root, targetId });
    byTarget.set(targetId, {
      grantId: typeof target.grantId === 'string' ? target.grantId : null,
      targetId,
      dir,
      maxSummaryChars: Number.isInteger(target.maxSummaryChars) ? target.maxSummaryChars : limit,
      claimLeaseMs: Number.isInteger(target.claimLeaseMs) ? target.claimLeaseMs : lease,
    });
  }

  const sinks = new Map();
  // Honest lifecycle state. `closing` means "shutting down: no new work is accepted".
  // `closed` means "every owned outbox confirmed closed". They are deliberately
  // separate, so a failed close can be retried instead of being reported as success.
  let closing = false;
  let closed = false;
  let closedAt = null;
  let closePromise = null;
  let closeAttempts = 0;
  // Enqueues that were ACCEPTED before close(): close() awaits all of them before it
  // closes any outbox, so an accepted settlement is never lost to a concurrent close.
  const inflight = new Set();

  function track(operation) {
    inflight.add(operation);
    const forget = () => inflight.delete(operation);
    operation.then(forget, forget);
    return operation;
  }

  /**
   * The producer for one GRANTED target, built (and cached) on first use. An
   * ungranted target is a typed refusal, never an implicit destination.
   */
  function producerFor(targetId) {
    const target = byTarget.get(targetId);
    if (target === undefined) {
      throw new WakeIntegrationError(
        'eventWake/ungranted-target',
        `target ${targetId} is not in the operator-configured rootCallbackGrants map`,
        { targetId },
      );
    }
    const existing = sinks.get(targetId);
    if (existing !== undefined) return existing;
    const created = {
      target,
      ready: false,
      sink: null,
      outbox: null,
    };
    // The accepted sink factory owns validation, durability, dedupe and the
    // queued-vs-delivered vocabulary; this router only routes to the right one.
    const rawSink = createSink({
      dir: target.dir,
      authority: TRUSTED_CONTROLLER_AUTHORITY,
      allowedTargetIds: [targetId],
      maxSummaryChars: target.maxSummaryChars,
      claimLeaseMs: target.claimLeaseMs,
    });
    if (typeof rawSink !== 'function' || rawSink.outbox === undefined || rawSink.outbox === null) {
      throw new WakeIntegrationError('eventWake/invalid-config', 'the wake sink factory must return a function carrying its outbox', { targetId });
    }
    created.ready = true;
    created.outbox = rawSink.outbox;
    created.sink = (event) => {
      if (closing) {
        return Promise.reject(
          new WakeIntegrationError('eventWake/closed', 'the host wake producer is closing or closed; the event was not accepted', {}),
        );
      }
      // ACCEPTED here: close() waits for every accepted operation before closing the
      // owning outbox, so an enqueue awaiting directory binding is never lost.
      const operation = (async () => {
        await bindTargetDir(target.dir, targetId);
        return await rawSink(event);
      })();
      return track(operation);
    };
    sinks.set(targetId, created);
    return created;
  }

  async function sink(event) {
    const targetId = event !== null && typeof event === 'object' && !Array.isArray(event) ? event.targetId : undefined;
    if (typeof targetId !== 'string' || targetId.trim().length === 0) {
      throw new WakeIntegrationError('eventWake/invalid-event', 'a wake event requires a trusted targetId', {});
    }
    return await producerFor(targetId.trim()).sink(event);
  }

  function capabilities() {
    const configuredTargets = [...byTarget.values()].map((target) => ({
      grantId: target.grantId,
      targetId: target.targetId,
      dir: target.dir,
      outboxCreated: sinks.has(target.targetId),
    }));
    return {
      enabled: true,
      schemaVersion: EVENT_WAKE_SCHEMA_VERSION,
      producer: true,
      producerSource: 'integrated-outbox',
      outboxConfigured: true,
      stateRoot: root,
      maxSummaryChars: limit,
      claimLeaseMs: lease,
      targets: configuredTargets,
      openOutboxes: sinks.size,
      closed,
      closing,
      closedAt,
      // Configuration proves a producer, not a destination. These stay `unknown` so a
      // configured sink never claims an available runner or a proven live transport.
      liveTransport: 'unknown',
      runnerAvailable: 'unknown',
      liveAck: 'unknown',
      deliveryReporting: 'enqueue acknowledgements are reported as queued; only a runner with a positive exact-target acknowledgement can make an event delivered',
      isolation: 'one durable outbox directory per full-SHA256 target id, bound by a target.json marker',
      reason: 'host outbox producer configured; live transport, runner availability and acknowledgement remain unverified until an actual controller run observes them',
    };
  }

  function targetDirs() {
    return [...byTarget.values()].map((target) => ({ ...target }));
  }

  /**
   * The durable producer for one granted target. It is the SAME cached instance the
   * sink writes through, so a caller can inspect real records before or after an
   * event; an ungranted target is a typed refusal instead of a silent null.
   */
  function outboxFor(targetId) {
    return producerFor(boundedOpaque(targetId, 'targetId')).outbox;
  }

  /**
   * Close every owned outbox honestly.
   *
   *  - once closing, new enqueues are refused (`eventWake/closed`);
   *  - already ACCEPTED enqueues are awaited before their outbox is closed;
   *  - a real close failure is reported (typed error), `isClosed()` stays false and a
   *    later `close()` is a genuine retry of the outboxes that did not close;
   *  - concurrent callers await the same close attempt.
   */
  function close() {
    if (closed) {
      return Promise.resolve({ ok: true, duplicate: true, closed: true, closedAt, attempts: closeAttempts });
    }
    if (closePromise !== null) return closePromise;
    closing = true;
    closeAttempts += 1;
    const attempt = closeAttempts;
    closePromise = (async () => {
      // Settle every accepted enqueue first. A rejection here was already reported to
      // its caller; close() must not turn it into a claim about the whole outbox.
      const accepted = [...inflight];
      const settled = accepted.length === 0 ? [] : await Promise.allSettled(accepted);
      const failedEnqueues = settled
        .filter((result) => result.status === 'rejected')
        .map((result) => ({ code: result.reason?.code ?? 'E_ENQUEUE', message: String(result.reason?.message ?? result.reason) }));
      const closedOutboxes = [];
      const closeFailures = [];
      for (const created of sinks.values()) {
        try {
          await created.outbox?.close();
          closedOutboxes.push(created.target.targetId);
        } catch (error) {
          closeFailures.push({
            targetId: created.target.targetId,
            code: error?.code ?? 'E_CLOSE',
            message: String(error?.message ?? error),
          });
        }
      }
      if (closeFailures.length > 0) {
        // Never report a failed close as success, never force-release a lock or an
        // ownership that the outbox itself refused to release, and stay NOT closed so
        // the caller can retry honestly.
        const error = new WakeIntegrationError(
          'eventWake/close-failed',
          `the host wake producer did not close cleanly (attempt ${attempt}): ${closeFailures.map((failure) => failure.targetId).join(', ')}`,
          { attempts: attempt, failures: closeFailures },
        );
        error.failures = closeFailures;
        error.closedOutboxes = closedOutboxes;
        error.pendingEnqueues = accepted.length;
        throw error;
      }
      closed = true;
      closedAt = Date.now();
      return {
        ok: true,
        duplicate: false,
        closed: true,
        closedAt,
        attempts: attempt,
        closedOutboxes,
        pendingEnqueues: accepted.length,
        failedEnqueues,
      };
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  }

  return Object.freeze({
    stateRoot: root,
    sink,
    capabilities,
    targetDirs,
    outboxFor,
    close,
    isClosed: () => closed,
    isClosing: () => closing,
  });
}

/**
 * Build the runtime the host mount uses. Returns the sink the supervisor is
 * configured with plus an explicit close hook for the bridge lifecycle.
 * @param {{eventWake: object, rootCallbackGrants?: object, notificationSink?: unknown}} spec
 */
export function createEventWakeRuntime(spec = {}) {
  const normalized = normalizeEventWakeConfig(spec.eventWake, {
    notificationSink: spec.notificationSink,
    rootCallbackGrants: spec.rootCallbackGrants,
  });
  if (normalized.enabled !== true) {
    return {
      enabled: false,
      sink: undefined,
      // No integrated producer exists; the status says so instead of borrowing the
      // convenience of a `producer: true` default.
      capabilities: () => ({ ...normalized.status, producerSource: null, integratedOutbox: false, targets: [] }),
      // Nothing was opened, so a close is trivially complete. `closed: true` lets an
      // owning lifecycle closer distinguish "released" from "skipped".
      close: async () => ({ ok: true, closed: true, skipped: 'eventWake is disabled' }),
      targetDirs: () => [],
      outboxFor: () => null,
      isClosed: () => true,
      status: normalized.status,
    };
  }
  const router = createTargetOutboxRouter({
    stateRoot: normalized.stateRoot,
    targets: normalized.targets,
    maxSummaryChars: normalized.maxSummaryChars,
    claimLeaseMs: normalized.claimLeaseMs,
    createSink: spec.createSink,
  });
  return {
    enabled: true,
    sink: router.sink,
    capabilities: router.capabilities,
    close: router.close,
    targetDirs: router.targetDirs,
    // Public helpers bound to the SAME lazy producers the sink writes through.
    outboxFor: router.outboxFor,
    isClosed: router.isClosed,
    status: normalized.status,
  };
}

/**
 * Validate the trusted-controller launch configuration.
 *
 * Paths and bounded limits only: no credentials, no environment secret, no message
 * text. There is deliberately no way to override the bound target from the command
 * line — the config file is the single validated binding.
 *
 * @param {unknown} raw - parsed JSON config file.
 * @returns {{stateRoot: string, targetId: string, callerThreadId: string, serverPath: string, nodePath: string, idleTimeoutMs: number, claimLeaseMs: number, maxSummaryChars: number, once: boolean, outboxDir: string}}
 */
export function loadControllerConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new WakeIntegrationError('controller/invalid-config', 'the controller config file must contain a JSON object', {});
  }
  for (const key of Object.keys(raw)) {
    if (!CONTROLLER_CONFIG_KEYS.includes(key)) {
      throw new WakeIntegrationError('controller/invalid-config', `controller config field "${key}" is not permitted`, { field: key });
    }
  }
  const stateRoot = absolutePath(raw.stateRoot, 'stateRoot');
  const targetId = boundedOpaque(raw.targetId, 'targetId');
  const callerThreadId = raw.callerThreadId === undefined ? targetId : boundedOpaque(raw.callerThreadId, 'callerThreadId');
  if (callerThreadId !== targetId) {
    throw new WakeIntegrationError(
      'controller/caller-mismatch',
      'callerThreadId must equal the bound targetId: a runner is bound to exactly one originating chat and never relays to another',
      { field: 'callerThreadId' },
    );
  }
  const serverPath = absolutePath(raw.serverPath, 'serverPath');
  const nodePath = raw.nodePath === undefined ? process.execPath : absolutePath(raw.nodePath, 'nodePath');
  const idleTimeoutMs = raw.idleTimeoutMs === undefined ? 5_000 : raw.idleTimeoutMs;
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw new WakeIntegrationError('controller/invalid-config', 'idleTimeoutMs must be a positive integer', { field: 'idleTimeoutMs' });
  }
  const claimLeaseMs = raw.claimLeaseMs === undefined ? EVENT_WAKE_CLAIM_LEASE_MS : raw.claimLeaseMs;
  if (!Number.isInteger(claimLeaseMs) || claimLeaseMs < 1) {
    throw new WakeIntegrationError('controller/invalid-config', 'claimLeaseMs must be a positive integer', { field: 'claimLeaseMs' });
  }
  const maxSummaryChars = raw.maxSummaryChars === undefined ? EVENT_WAKE_MAX_SUMMARY_CHARS : raw.maxSummaryChars;
  if (!Number.isInteger(maxSummaryChars) || maxSummaryChars !== EVENT_WAKE_MAX_SUMMARY_CHARS) {
    throw new WakeIntegrationError(
      'controller/invalid-config',
      `maxSummaryChars must be exactly ${EVENT_WAKE_MAX_SUMMARY_CHARS}: the fixed integration wire limit (an unbounded or smaller controller cap is refused)`,
      { field: 'maxSummaryChars' },
    );
  }
  if (raw.once !== undefined && typeof raw.once !== 'boolean') {
    throw new WakeIntegrationError('controller/invalid-config', 'once must be a boolean when present', { field: 'once' });
  }
  return {
    stateRoot,
    targetId,
    callerThreadId,
    serverPath,
    nodePath,
    idleTimeoutMs,
    claimLeaseMs,
    maxSummaryChars,
    once: raw.once === true,
    outboxDir: resolveTargetOutboxDir({ stateRoot, targetId }),
  };
}

/**
 * The originating-chat binding check for a controller run. All three values must be
 * the same trusted id; the environment value is only ever compared, never logged.
 * @param {{targetId: string, callerThreadId: string, env?: object}} spec
 */
export function assertControllerBinding({ targetId, callerThreadId, env = process.env } = {}) {
  const bound = boundedOpaque(targetId, 'targetId');
  if (callerThreadId !== bound) {
    throw new WakeIntegrationError('controller/caller-mismatch', 'callerThreadId must equal the bound targetId', { field: 'callerThreadId' });
  }
  const fromEnv = env?.CODEX_THREAD_ID;
  if (typeof fromEnv !== 'string' || fromEnv.trim().length === 0) {
    throw new WakeIntegrationError(
      'controller/caller-unavailable',
      'CODEX_THREAD_ID is not set for this controller process; refusing to send without the actual originating chat identity (a fallback would forge caller metadata)',
      { field: 'CODEX_THREAD_ID' },
    );
  }
  if (fromEnv.trim() !== bound) {
    throw new WakeIntegrationError(
      'controller/caller-mismatch',
      'the running CODEX_THREAD_ID does not equal the configured targetId; this runner is bound to a different originating chat',
      { field: 'CODEX_THREAD_ID' },
    );
  }
  return { targetId: bound, callerThreadId: bound };
}

/**
 * Presence-only check for the official transport environment. The value is never
 * read, copied, hashed or logged — only the fact that the operator environment
 * carries it.
 * @param {{env?: object}} [spec]
 */
export function assertTransportEnvironment({ env = process.env } = {}) {
  const present = typeof env?.CODEX_APP_TOOLS_PIPE_PATH === 'string' && env.CODEX_APP_TOOLS_PIPE_PATH.trim().length > 0;
  if (!present) {
    throw new WakeIntegrationError(
      'controller/transport-unavailable',
      'the normal official Codex App Tools transport environment is not present in this controller process; refusing to start a runner that could not deliver (the raw pipe is never opened by this code)',
      { field: 'CODEX_APP_TOOLS_PIPE_PATH', present: false },
    );
  }
  return { present: true };
}
