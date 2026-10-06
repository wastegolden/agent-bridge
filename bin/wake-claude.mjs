#!/usr/bin/env node
// Trusted-controller entrypoint for the Claude Code wake runner.
//
// This is NOT a worker tool and exposes no worker destination/transport authority.
// It reuses the accepted durable outbox (`src/wake-outbox.mjs`), the accepted
// event-driven runner loop and reconcile helper (`bin/wake-codex.mjs`) and the
// accepted wire format (`src/codex-wake-client.mjs`), but it has NO Codex
// transport: the message is written to this process's stdout, which the trusted
// Claude Code controller session reads, one block per event.
//
//   * everything comes from a trusted JSON config file (paths and bounded limits
//     only; never an environment secret, never a destination supplied by a model);
//   * every mode builds exactly one outbox for the configured target and always
//     closes it;
//   * stdout carries ONLY event messages and the acknowledgement hint, so a
//     monitor can pipe stdout; diagnostics go to stderr as one-line JSON;
//   * no message may ever be marked delivered by this file: handing text to the
//     controller session is ambiguous until the operator acknowledges it.
//
// Usage:
//   node bin/wake-claude.mjs --config <absolute-config.json> \
//     ( --wait [--timeout-ms N] | --follow | --ack <eventId> | --nack <eventId> [--requeue] | --status )

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createWakeOutbox } from '../src/wake-outbox.mjs';
import { createClaudeWakeClient } from '../src/claude-wake-client.mjs';
import {
  EVENT_WAKE_CLAIM_LEASE_MS,
  EVENT_WAKE_MAX_SUMMARY_CHARS,
  TRUSTED_CONTROLLER_AUTHORITY,
  WakeIntegrationError,
  resolveTargetOutboxDir,
} from '../src/wake-integration.mjs';
import { createSafeLogger, reconcileEvent, runWakeRunner } from './wake-codex.mjs';

export const CLAUDE_CONTROLLER_USAGE =
  'usage: node bin/wake-claude.mjs --config <absolute-config.json> (--wait [--timeout-ms N] | --follow | --ack <eventId> | --nack <eventId> [--requeue] | --status)';

/** Default --wait bound (one hour), in milliseconds. */
export const DEFAULT_CLAUDE_WAIT_TIMEOUT_MS = 3_600_000;

const MODE_FLAGS = Object.freeze(['wait', 'follow', 'ack', 'nack', 'status']);
const VALUE_FLAGS = Object.freeze(['config', 'ack', 'nack', 'timeout-ms']);
const CLAUDE_CONTROLLER_CONFIG_KEYS = Object.freeze([
  'stateRoot',
  'targetId',
  'claimLeaseMs',
  'maxSummaryChars',
  'requireSessionBinding',
]);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_TARGET_ID_CHARS = 200;
const MAX_PATH_CHARS = 4096;
const WAKE_MESSAGE_PREFIX = '[dsh-bridge-event] ';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidConfig(message, field) {
  return new WakeIntegrationError('controller/invalid-config', message, { field });
}

function invalidArguments(message, field) {
  return new WakeIntegrationError('controller/invalid-arguments', message, { field });
}

/**
 * Parse the controller command line. Exactly one mode flag is required; every
 * other combination is a typed refusal (never a silent default mode).
 *
 * @param {string[]} [argv]
 * @returns {{config: string, mode: string, eventId: string|null, timeoutMs: number|null, requeue: boolean}}
 */
export function parseClaudeControllerArgs(argv = []) {
  const values = {};
  const modes = [];
  let timeoutMs = null;
  let requeue = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string' || !arg.startsWith('--')) {
      throw invalidArguments(`unexpected argument ${arg} (${CLAUDE_CONTROLLER_USAGE})`, 'arguments');
    }
    const name = arg.slice(2);
    if (MODE_FLAGS.includes(name)) {
      modes.push(name);
      continue;
    }
    if (name === 'requeue') {
      requeue = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(name)) {
      throw invalidArguments(`unexpected flag --${name} (${CLAUDE_CONTROLLER_USAGE})`, name);
    }
    const value = argv[index + 1];
    if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
      throw invalidArguments(`--${name} requires a value`, name);
    }
    index += 1;
    if (name === 'timeout-ms') {
      if (!/^[0-9]+$/.test(String(value)) || Number.parseInt(String(value), 10) <= 0) {
        throw invalidArguments('--timeout-ms must be a positive integer', 'timeout-ms');
      }
      timeoutMs = Number.parseInt(String(value), 10);
      continue;
    }
    if (name === 'ack' || name === 'nack') {
      if (typeof value !== 'string' || !value.trim()) {
        throw invalidArguments(`--${name} requires a nonblank event id`, name);
      }
      modes.push(name);
      values.eventId = value;
      continue;
    }
    values.config = value;
  }

  if (typeof values.config !== 'string' || !values.config.trim()) {
    throw invalidArguments(`--config is required (${CLAUDE_CONTROLLER_USAGE})`, 'config');
  }
  if (modes.length !== 1) {
    throw invalidArguments(`exactly one mode flag is required (${CLAUDE_CONTROLLER_USAGE})`, 'mode');
  }
  const mode = modes[0];
  if (requeue && mode !== 'nack') {
    throw invalidArguments('--requeue is only valid together with --nack', 'requeue');
  }
  if (timeoutMs !== null && mode !== 'wait') {
    throw invalidArguments('--timeout-ms is only valid together with --wait', 'timeout-ms');
  }

  return {
    config: values.config,
    mode,
    eventId: typeof values.eventId === 'string' ? values.eventId : null,
    timeoutMs: timeoutMs ?? (mode === 'wait' ? DEFAULT_CLAUDE_WAIT_TIMEOUT_MS : null),
    requeue,
  };
}

function requireAbsolutePath(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidConfig(`${field} must be a nonblank string`, field);
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw invalidConfig(`${field} must not contain control characters`, field);
  }
  const text = value.trim();
  if (text.length > MAX_PATH_CHARS) {
    throw invalidConfig(`${field} must be at most ${MAX_PATH_CHARS} characters`, field);
  }
  if (!path.isAbsolute(text)) {
    throw invalidConfig(`${field} must be an absolute path`, field);
  }
  return path.resolve(text);
}

function requireTargetId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidConfig('targetId must be a nonblank string', 'targetId');
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw invalidConfig('targetId must not contain control characters', 'targetId');
  }
  const text = value.trim();
  if (text.length > MAX_TARGET_ID_CHARS) {
    throw invalidConfig(`targetId must be at most ${MAX_TARGET_ID_CHARS} characters`, 'targetId');
  }
  return text;
}

/**
 * Validate the trusted Claude controller launch configuration.
 *
 * Paths and bounded limits only: no credentials, no environment secret, no
 * message text, and no transport (the controller session is the transport). The
 * outbox directory is resolved with `resolveTargetOutboxDir` so the host producer
 * and this controller can never disagree about where records live.
 *
 * @param {unknown} raw - parsed JSON config file.
 * @returns {{stateRoot: string, targetId: string, claimLeaseMs: number, maxSummaryChars: number, requireSessionBinding: boolean, outboxDir: string}}
 */
export function loadClaudeControllerConfig(raw) {
  if (!isPlainObject(raw)) {
    throw invalidConfig('the Claude controller config file must contain a JSON object', 'config');
  }
  for (const key of Object.keys(raw)) {
    if (!CLAUDE_CONTROLLER_CONFIG_KEYS.includes(key)) {
      throw invalidConfig(`controller config field "${key}" is not permitted`, key);
    }
  }
  const stateRoot = requireAbsolutePath(raw.stateRoot, 'stateRoot');
  const targetId = requireTargetId(raw.targetId);
  const claimLeaseMs = raw.claimLeaseMs === undefined ? EVENT_WAKE_CLAIM_LEASE_MS : raw.claimLeaseMs;
  if (!Number.isInteger(claimLeaseMs) || claimLeaseMs < 1) {
    throw invalidConfig('claimLeaseMs must be a positive integer', 'claimLeaseMs');
  }
  const maxSummaryChars = raw.maxSummaryChars === undefined ? EVENT_WAKE_MAX_SUMMARY_CHARS : raw.maxSummaryChars;
  if (!Number.isInteger(maxSummaryChars) || maxSummaryChars !== EVENT_WAKE_MAX_SUMMARY_CHARS) {
    throw invalidConfig(
      `maxSummaryChars must be exactly ${EVENT_WAKE_MAX_SUMMARY_CHARS}: the fixed integration wire limit that carries a raw 8000-character reply plus the controller prefix`,
      'maxSummaryChars',
    );
  }
  if (raw.requireSessionBinding !== undefined && typeof raw.requireSessionBinding !== 'boolean') {
    throw invalidConfig('requireSessionBinding must be a boolean when present', 'requireSessionBinding');
  }
  return {
    stateRoot,
    targetId,
    claimLeaseMs,
    maxSummaryChars,
    requireSessionBinding: raw.requireSessionBinding === true,
    outboxDir: resolveTargetOutboxDir({ stateRoot, targetId }),
  };
}

async function readClaudeControllerConfigFile(filePath, readFileImpl) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw invalidArguments('a config file path is required', 'config');
  }
  let text;
  try {
    text = await readFileImpl(filePath, 'utf8');
  } catch (error) {
    throw new WakeIntegrationError('controller/config-unreadable', `cannot read the controller config file: ${error?.message ?? error}`, {
      field: 'config',
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WakeIntegrationError('controller/config-invalid-json', `the controller config file is not valid JSON: ${error?.message ?? error}`, {
      field: 'config',
    });
  }
  return loadClaudeControllerConfig(parsed);
}

// The running Claude Code session identity is compared only; its value is never
// copied into a message, a log line or an error. The documented key is checked
// first; the short alias keeps already-running monitors of either spelling bound
// to the same opaque target label.
const SESSION_ENV_KEYS = Object.freeze(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']);

function assertClaudeSessionBinding({ config, env = process.env } = {}) {
  if (config.requireSessionBinding !== true) return { required: false };
  let fromEnv = null;
  for (const key of SESSION_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      fromEnv = value;
      break;
    }
  }
  if (fromEnv === null) {
    throw new WakeIntegrationError(
      'controller/caller-unavailable',
      'CLAUDE_CODE_SESSION_ID is not set for this controller process; refusing to hand off without the actual originating session identity (a fallback would forge the binding)',
      { field: 'CLAUDE_CODE_SESSION_ID' },
    );
  }
  if (fromEnv.trim() !== config.targetId) {
    throw new WakeIntegrationError(
      'controller/caller-mismatch',
      'the running CLAUDE_CODE_SESSION_ID does not equal the configured targetId; this runner is bound to a different Claude Code session',
      { field: 'CLAUDE_CODE_SESSION_ID' },
    );
  }
  return { required: true };
}

// The event id is read back out of the accepted wire header so the ack hint can
// name exactly the record the controller just received. `buildWakeMessage` always
// emits this JSON header as the first line.
function eventIdFromMessage(text) {
  const lines = String(text).split('\n');
  for (const line of lines) {
    if (!line.startsWith(WAKE_MESSAGE_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(WAKE_MESSAGE_PREFIX.length));
      if (typeof parsed?.eventId === 'string' && parsed.eventId) return parsed.eventId;
    } catch {
      return null;
    }
  }
  return null;
}

function fatalPayload(error) {
  const payload = { phase: 'fatal', code: error?.code ?? 'E_FATAL' };
  if (typeof error?.detail?.field === 'string') payload.field = error.detail.field;
  // Message text only for integration-owned refusals, whose wording is generated
  // in this file and never contains an environment value.
  if (error instanceof WakeIntegrationError) payload.message = error.message;
  return payload;
}

/**
 * Run one controller session with exactly one mode.
 *
 * @param {{argv?: string[], env?: object, stdout?: object, stderr?: object, readFileImpl?: Function}|string[]} [options]
 * @returns {Promise<number>} exit code: 0 success, 1 fatal, 2 claim error, 3 wait timeout with no event.
 */
export async function main(options = {}) {
  const opts = Array.isArray(options) ? { argv: options } : options ?? {};
  const {
    argv = process.argv.slice(2),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    readFileImpl = readFile,
  } = opts;

  const log = createSafeLogger((line) => {
    stderr.write(`${line}\n`);
  });

  let outbox = null;
  try {
    const flags = parseClaudeControllerArgs(argv);
    const config = await readClaudeControllerConfigFile(flags.config, readFileImpl);
    outbox = createWakeOutbox({
      dir: config.outboxDir,
      authority: TRUSTED_CONTROLLER_AUTHORITY,
      allowedTargetIds: [config.targetId],
      claimLeaseMs: config.claimLeaseMs,
      maxSummaryChars: config.maxSummaryChars,
    });
    assertClaudeSessionBinding({ config, env });

    if (flags.mode === 'status') {
      const counts = await outbox.stats();
      stdout.write(`${JSON.stringify({ phase: 'status', ...counts })}\n`);
      return 0;
    }

    if (flags.mode === 'ack' || flags.mode === 'nack') {
      const delivered = flags.mode === 'ack';
      const result = await reconcileEvent(outbox, {
        reconcileEventId: flags.eventId,
        delivered,
        requeue: delivered ? false : flags.requeue === true,
      });
      stdout.write(`${JSON.stringify({ phase: delivered ? 'ack' : 'nack', eventId: flags.eventId, state: result?.event?.state ?? null })}\n`);
      return 0;
    }

    let emitted = 0;
    const client = createClaudeWakeClient({
      authority: TRUSTED_CONTROLLER_AUTHORITY,
      allowedTargetIds: [config.targetId],
      maxSummaryChars: config.maxSummaryChars,
      emit: (text) => {
        const message = String(text);
        const eventId = eventIdFromMessage(message);
        stdout.write(`${message}\n`);
        if (eventId !== null) {
          stdout.write(
            `[dsh-bridge-ack] eventId=${eventId} verify against bridge_check/bridge_result, then acknowledge with --ack ${eventId}\n`,
          );
        }
        emitted += 1;
      },
    });

    const isWait = flags.mode === 'wait';
    const controller = new AbortController();
    let timer = null;
    let stop = null;
    if (isWait) {
      timer = setTimeout(() => controller.abort(), flags.timeoutMs);
    } else {
      stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }

    try {
      const stats = await runWakeRunner({
        outbox,
        client,
        runnerId: `wake-claude:${config.targetId}`,
        idleTimeoutMs: 1000,
        ...(isWait ? { maxEvents: 1 } : {}),
        signal: controller.signal,
        logger: log,
      });
      log({ phase: 'runner-stopped', ...stats });
      if (stats.claimErrors > 0) return 2;
      if (!isWait) return 0;
      if (emitted > 0) return 0;
      // No event was handed over. The only way a --wait loop ends here without a
      // claim error is its own timeout abort; report the documented code.
      return 3;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (stop !== null) {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    stderr.write(`${JSON.stringify(fatalPayload(error))}\n`);
    return 1;
  } finally {
    if (outbox !== null) await outbox.close().catch(() => undefined);
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
      process.stderr.write(`${JSON.stringify(fatalPayload(error))}\n`);
      process.exitCode = 1;
    });
}
