// src/peer/bridge-client.mjs
//
// A minimal JSON-RPC 2.0 client for the LOCAL DSH bridge MCP endpoint.
//
// A peer harness (Claude Code or Codex) that ran a bridge task on its own behalf must
// still read that task's dossier and full result, and archive or clean the task up,
// after the peer process has ended. Those are bridge_* tools on the DSH bridge; this
// client calls them over the same bearer-authenticated HTTP transport the Codex carrier
// uses.
//
// Two invariants hold for every call:
//   * the endpoint must be loopback (http://127.0.0.1 or http://localhost, any port or
//     path). The bearer credential belongs to THIS machine's bridge, so a non-local URL
//     is refused at construction, before a single byte is sent;
//   * the credential is resolved per call (DSH_MCP_TOKEN first, the credential file
//     second) and the resolved token is NEVER placed in an error message or detail.
//
// Only Node built-ins are used; the network seam (fetchImpl) and the file seam
// (readFileImpl) are injectable so the module can be tested without I/O.

import { readFile } from 'node:fs/promises';

import { PeerPolicyError } from './chain.mjs';

/** Page size `resultText` asks `bridge_result` for. */
export const RESULT_PAGE_LIMIT = 100_000;
/** Default cap for `resultText`; larger results are cut and marked as truncated. */
export const RESULT_TEXT_MAX_CHARS = 2_000_000;
/** Appended when `resultText` stops at `maxChars` while the bridge still has text. */
export const TRUNCATION_MARKER = '\n…[truncated by agent-bridge]';
/** The only hosts a bridge url may name. */
export const LOCAL_BRIDGE_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);
/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** The environment variable carrying the bridge bearer token. */
export const CREDENTIAL_ENV = 'DSH_MCP_TOKEN';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when `url` is an http URL on a loopback host. A different host, `https`, a
 * malformed value and a blank string are all "not a local bridge".
 */
export function isLocalBridgeUrl(url) {
  if (typeof url !== 'string') return false;
  const candidate = url.trim();
  if (candidate === '') return false;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && LOCAL_BRIDGE_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * The bridge error body the DSH handler puts inside `result.content[0].text` for an
 * isError result: `{code, message, ...}`. Returns nulls when that text is absent or is
 * not JSON, so `details.code` is only ever a code the bridge actually sent.
 */
function parseBridgeError(payload) {
  const content = payload?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return { code: null, message: null };
  const first = content[0];
  const raw = isObject(first) && typeof first.text === 'string' ? first.text : null;
  if (raw === null) return { code: null, message: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: null, message: null };
  }
  if (!isObject(parsed)) return { code: null, message: null };
  const code = typeof parsed.code === 'string' && parsed.code !== ''
    ? parsed.code
    : (Number.isSafeInteger(parsed.code) ? parsed.code : null);
  const message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : null;
  return { code, message };
}

/**
 * Build the client for one bridge endpoint.
 *
 * @param {object} spec
 * @param {string} spec.url loopback http URL of the bridge MCP endpoint.
 * @param {string|null} [spec.credentialFile] file holding the bearer token.
 * @param {object} [spec.env] environment; `DSH_MCP_TOKEN` is read first, per call.
 * @param {Function} [spec.fetchImpl] fetch seam.
 * @param {Function} [spec.readFileImpl] credential-file seam.
 * @param {number} [spec.timeoutMs] per-request AbortSignal timeout.
 * @returns {Readonly<{dossier: Function, resultText: Function, archive: Function, cleanup: Function}>}
 * @throws {PeerPolicyError} PEER_CONFIG_INVALID for a non-loopback url or a bad seam.
 */
export function createBridgeClient({
  url,
  credentialFile = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!isLocalBridgeUrl(url)) {
    throw new PeerPolicyError(
      'PEER_CONFIG_INVALID',
      'the bridge url must be http://127.0.0.1 or http://localhost (any port or path)',
      { field: 'url' },
    );
  }
  const endpoint = url.trim();
  if (typeof fetchImpl !== 'function') {
    throw new PeerPolicyError('PEER_CONFIG_INVALID', 'fetchImpl must be a function', { field: 'fetchImpl' });
  }
  if (typeof readFileImpl !== 'function') {
    throw new PeerPolicyError('PEER_CONFIG_INVALID', 'readFileImpl must be a function', { field: 'readFileImpl' });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PeerPolicyError('PEER_CONFIG_INVALID', 'timeoutMs must be a positive integer', { field: 'timeoutMs' });
  }

  let sequence = 0;

  /** The bearer token for THIS call: the environment first, the credential file second. */
  async function resolveToken() {
    if (typeof env?.[CREDENTIAL_ENV] === 'string' && env[CREDENTIAL_ENV].trim() !== '') {
      return env[CREDENTIAL_ENV].trim();
    }
    if (typeof credentialFile === 'string' && credentialFile.trim() !== '') {
      try {
        const fromFile = String(await readFileImpl(credentialFile, 'utf8')).trim();
        if (fromFile !== '') return fromFile;
      } catch {
        // A missing or unreadable credential file means "no credential", never a crash.
      }
    }
    return null;
  }

  /** Strip the resolved credential out of any externally sourced error text. */
  function redact(message, token) {
    const text = String(message ?? '');
    if (typeof token !== 'string' || token === '') return text;
    return text.split(token).join('[redacted]');
  }

  /** One `tools/call` request; resolves with `result.structuredContent`. */
  async function call(tool, args) {
    const token = await resolveToken();
    if (token === null) {
      throw new PeerPolicyError(
        'PEER_BRIDGE_UNAVAILABLE',
        `no DSH bridge credential is available for ${tool}: set ${CREDENTIAL_ENV} or configure the credential file`,
        { tool },
      );
    }
    sequence += 1;
    const request = { jsonrpc: '2.0', id: sequence, method: 'tools/call', params: { name: tool, arguments: args } };
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error?.message ?? error?.name ?? 'unknown error';
      throw new PeerPolicyError('PEER_BRIDGE', redact(`bridge ${tool} request failed: ${reason}`, token), { tool, code: null });
    }
    const status = Number(response?.status);
    if (status !== 200) {
      throw new PeerPolicyError('PEER_BRIDGE', `bridge ${tool} returned HTTP ${Number.isFinite(status) ? status : 'unknown'}`, { tool, code: null });
    }
    let raw;
    try {
      raw = await response.text();
    } catch (error) {
      const reason = error?.message ?? 'unknown error';
      throw new PeerPolicyError('PEER_BRIDGE', redact(`bridge ${tool} reply could not be read: ${reason}`, token), { tool, code: null });
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new PeerPolicyError('PEER_BRIDGE', `bridge ${tool} reply was not JSON`, { tool, code: null });
    }
    if (!isObject(payload)) {
      throw new PeerPolicyError('PEER_BRIDGE', `bridge ${tool} reply was not a JSON-RPC object`, { tool, code: null });
    }
    if (isObject(payload.error)) {
      const message = typeof payload.error.message === 'string' ? payload.error.message : 'JSON-RPC error';
      throw new PeerPolicyError('PEER_BRIDGE', redact(`bridge ${tool} failed: ${message}`, token), { tool, code: null });
    }
    if (!isObject(payload.result)) {
      throw new PeerPolicyError('PEER_BRIDGE', `bridge ${tool} returned no result`, { tool, code: null });
    }
    if (payload.result.isError === true) {
      const { code, message } = parseBridgeError(payload);
      const suffix = message === null ? '' : `: ${message}`;
      throw new PeerPolicyError('PEER_BRIDGE', redact(`bridge ${tool} refused the call${suffix}`, token), { tool, code });
    }
    return payload.result.structuredContent;
  }

  /** The closeout dossier of one owned bridge task. */
  async function dossier(taskId) {
    return call('bridge_dossier', { taskId });
  }

  /**
   * The full result text of one owned bridge task, paged from offset 0 with
   * `limit: RESULT_PAGE_LIMIT` until `hasMore` is false or `maxChars` is reached. A
   * result cut short gets TRUNCATION_MARKER appended; a task with no text yields ''.
   */
  async function resultText(taskId, { maxChars = RESULT_TEXT_MAX_CHARS } = {}) {
    const cap = Number.isFinite(maxChars) && maxChars >= 0 ? Math.floor(maxChars) : RESULT_TEXT_MAX_CHARS;
    let offset = 0;
    let collected = '';
    let truncated = false;
    for (;;) {
      const page = await call('bridge_result', { taskId, offset, limit: RESULT_PAGE_LIMIT });
      const text = isObject(page) && typeof page.text === 'string' ? page.text : '';
      if (isObject(page) && page.totalChars === 0) return '';
      const remaining = cap - collected.length;
      if (text.length > remaining) {
        collected += remaining > 0 ? text.slice(0, remaining) : '';
        truncated = true;
        break;
      }
      collected += text;
      if (!isObject(page) || page.hasMore !== true) break;
      if (collected.length >= cap) {
        truncated = true;
        break;
      }
      const next = page.nextOffset;
      // A cursor that does not advance would page forever: stop on it.
      if (!Number.isFinite(next) || next <= offset) break;
      offset = next;
    }
    return truncated ? `${collected}${TRUNCATION_MARKER}` : collected;
  }

  /** UI-hide one settled owned bridge task at an exact revision. */
  async function archive(taskId, revision) {
    return call('bridge_archive', { taskId, revision });
  }

  /** Preview (the default) or apply retention-qualified cleanup of one owned task. */
  async function cleanup(taskId, { dryRun = false } = {}) {
    return call('bridge_cleanup', { taskId, dryRun: dryRun === true });
  }

  return Object.freeze({ dossier, resultText, archive, cleanup });
}
