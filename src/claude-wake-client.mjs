// Claude Code wake client (callback-owned, trusted-controller side only).
//
// Route: there is NO transport here. The accepted wake message is handed to the
// trusted Claude Code controller SESSION through an injected `emit(text)` sink
// (bin/wake-claude.mjs writes it to stdout, one block per event). The event text
// itself, the untrusted-data boundary wording and the identifier header are the
// accepted wire format produced by `buildWakeMessage`, so the Codex and Claude
// paths deliver the same bytes.
//
// Delivery is NEVER claimed by this client. A successful emit only proves that
// the controller session was handed the text; the durable record stays ambiguous
// (`unknown` / AWAITING_CONTROLLER_ACK) until an operator/controller explicitly
// acknowledges it (`--ack`), which is the only thing that can make it delivered.

import { WakeError, assertRootAuthority, normalizeTargets, normalizeWakeEvent } from './wake-outbox.mjs';
import { buildWakeMessage } from './codex-wake-client.mjs';
import { EVENT_WAKE_MAX_SUMMARY_CHARS } from './wake-integration.mjs';

/** The outcome code of a successful hand-off that is not yet acknowledged. */
export const CLAUDE_WAKE_ACK_CODE = 'AWAITING_CONTROLLER_ACK';

const ACK_PENDING_MESSAGE =
  'event handed to the controller session; delivery is confirmed only by an explicit controller acknowledgement';

/**
 * Build the Claude Code delivery path for one or more controller-granted targets.
 *
 * @param {{
 *   authority: object,
 *   allowedTargetIds: string[],
 *   maxSummaryChars?: number,
 *   emit: (text: string) => void|Promise<void>,
 * }} options
 * @returns {Readonly<{deliver: Function, buildMessage: Function, allowedTargetIds: readonly string[], close: Function}>}
 */
export function createClaudeWakeClient(options = {}) {
  const {
    authority,
    allowedTargetIds,
    maxSummaryChars = EVENT_WAKE_MAX_SUMMARY_CHARS,
    emit,
  } = options;

  assertRootAuthority(authority);
  const targets = normalizeTargets(allowedTargetIds);
  if (typeof emit !== 'function') {
    throw new WakeError(
      'E_ARGS',
      'emit must be a function (text) => void|Promise<void>: the trusted controller session is the only delivery path and there is no fallback transport',
    );
  }

  // Never throws for policy/validation/emit failures: every failure is a typed
  // outcome so the runner can persist it without guessing, and no code path may
  // report `delivered` — only an explicit controller acknowledgement can.
  async function deliver(rawEvent) {
    let event;
    try {
      event = normalizeWakeEvent(rawEvent, { maxSummaryChars, allowedTargetIds: targets });
    } catch (error) {
      return {
        outcome: 'refused',
        code: error?.code ?? 'E_ARGS',
        message: String(error?.message ?? error),
        hostError: null,
      };
    }

    let text;
    try {
      text = buildWakeMessage(event, { maxSummaryChars });
    } catch (error) {
      return {
        outcome: 'failed',
        code: error?.code ?? 'E_MESSAGE',
        message: String(error?.message ?? error),
        hostError: null,
      };
    }

    try {
      await emit(text);
    } catch (error) {
      // The text may or may not have reached the controller session; it is never
      // reported as delivered, and the caller records the typed failure.
      return {
        outcome: 'failed',
        code: 'E_EMIT',
        message: String(error?.message ?? error),
        hostError: null,
      };
    }

    return {
      outcome: 'unknown',
      code: CLAUDE_WAKE_ACK_CODE,
      message: ACK_PENDING_MESSAGE,
      hostError: null,
    };
  }

  function buildMessage(event) {
    return buildWakeMessage(event, { maxSummaryChars });
  }

  async function close() {
    return { ok: true };
  }

  return Object.freeze({ deliver, buildMessage, allowedTargetIds: targets, close });
}
