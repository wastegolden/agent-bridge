// src/peer/sweeper.mjs
//
// Retention sweeper for accepted-result records (contract agent-bridge-1.5.0-w3b2).
//
// Every closed ROOT task owns:
//   * one durable Markdown record inside its project (the file at `record.path`), and
//   * one `record` event in `<stateDir>/records-index.jsonl` listing the raw harness
//     sessions of that task ({harness:'dsh'|'codex'|'claude-code', id, source, revision?})
//     together with the instant its raw sessions become eligible (`eligibleAt`; null means
//     "keep forever").
//
// This module deletes those raw sessions after `eligibleAt`. The index is the ONLY source
// of session ids: the sweeper never scans a filesystem for sessions and never guesses one.
// An id is touched only after it has been validated for its harness.
//
// Bounds:
//   * Sessions already recorded as 'deleted', 'archived' or 'skipped' are FINAL: they are
//     never acted on again. A 'failed' session is retried while it has fewer than
//     `maxAttempts` failure events in the index, then it is left alone.
//   * The record file is the evidence that the result was captured. When it is missing the
//     record's actionable sessions are NOT cleaned: they are reported (and, outside dryRun,
//     recorded) as 'skipped' with the note 'record file missing'.
//   * Validation runs before any side effect: codex and claude-code ids must be UUIDs and a
//     dsh `source` must be a nonblank string without path separators, otherwise the session
//     is reported 'failed' / 'invalid id' and neither a client nor the filesystem is used.
//
// Modes:
//   * dryRun (the default): no action API is called and nothing is written. Every action
//     that would be attempted carries state 'planned'. Two determinations are local and
//     call-free, so they keep their real outcome even in dryRun: an invalid id
//     ('failed' / 'invalid id') and a due record whose record file is missing.
//   * dryRun === false: each finished action appends exactly ONE `{kind:'session'}` index
//     event immediately after it, so a crash in the middle of a sweep can never repeat a
//     deletion that already completed.
//
// Harness actions:
//   * codex       -> 'delete'  : codexThreads.archive(id) then codexThreads.remove(id).
//   * claude-code -> 'delete'  : remove `<claudeProjectsDir>/<project>/<id>.jsonl` and, when
//                                present, the sibling directory `<project>/<id>` (recursive).
//   * dsh         -> 'archive' : bridge.archive(source, revision), then bridge.cleanup(source,
//                                {dryRun:false}); a cleanup failure never fails the session.
//
// Codex clients are created (and closed) by the caller. Every filesystem touch goes through
// `fsImpl`, an optional bag of node:fs/promises overrides, so this module can be driven
// without a real Codex CLI, a real Claude Code install or a real index.
//
// Exported surface: sweepRecords (see SWEEPER_EXPORTS).

import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { PeerPolicyError } from './chain.mjs';
import { appendIndexEvent, INDEX_FILE, readIndex } from './records.mjs';

const ARGS_CODE = 'PEER_ARGS_INVALID';

const CODEX = 'codex';
const CLAUDE = 'claude-code';
const DSH = 'dsh';

/** The exact id shape shared by a Codex thread id and a Claude Code session id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Failures a session may accumulate before the sweeper stops retrying it. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Every note is bounded so one large error cannot bloat the index. */
const MAX_NOTE_CHARS = 300;

const NOTE_RECORD_FILE_MISSING = 'record file missing';
const NOTE_INVALID_ID = 'invalid id';
const NOTE_CODEX_UNAVAILABLE = 'codex client unavailable';
const NOTE_CLAUDE_DIR_UNAVAILABLE = 'claude projects dir unavailable';
const NOTE_CLAUDE_FILE_MISSING = 'session file not found';
const NOTE_CLAUDE_AMBIGUOUS = 'ambiguous';
const NOTE_BRIDGE_UNAVAILABLE = 'bridge unavailable';
const NOTE_UNSUPPORTED_HARNESS = 'unsupported harness';

/** The exported names of this module, so a caller can assert the surface. */
export const SWEEPER_EXPORTS = Object.freeze(['sweepRecords']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function boundNote(value) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return text.length > MAX_NOTE_CHARS ? text.slice(0, MAX_NOTE_CHARS) : text;
}

/** `code: message`, bounded, for any thrown error. */
function errorNote(error) {
  const code = typeof error?.code === 'string' && error.code !== ''
    ? error.code
    : typeof error?.name === 'string' && error.name !== '' ? error.name : 'error';
  const message = typeof error?.message === 'string' ? error.message : String(error);
  return boundNote(`${code}: ${message}`);
}

/** The error CODE alone (message only as a fallback) for a tolerated cleanup failure. */
function errorCodeOf(error) {
  if (typeof error?.code === 'string' && error.code !== '') return boundNote(error.code);
  return boundNote(typeof error?.message === 'string' ? error.message : String(error));
}

/** True when an archive error means "this task is already archived", which is success here. */
function isAlreadyArchived(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/archiv/i.test(code) && /already/i.test(code)) return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return /already (been )?archived/i.test(message);
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A dsh source is a bridge task id: nonblank and free of path separators. */
function isDshSource(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !/[/\\]/.test(value);
}

function actionForHarness(harness) {
  if (harness === CODEX || harness === CLAUDE) return 'delete';
  if (harness === DSH) return 'archive';
  return 'skip';
}

/** The failure-event key of one session: recordId + harness + id, exactly as folded. */
function sessionKeyOf(recordId, harness, id) {
  const recordPart = recordId === null || recordId === undefined ? '' : String(recordId);
  return `${recordPart}\u0000${harness}\u0000${id}`;
}

async function entryExists(target, statImpl) {
  try {
    await statImpl(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function isDirectoryEntry(target, statImpl) {
  try {
    const info = await statImpl(target);
    return typeof info?.isDirectory === 'function' ? info.isDirectory() : false;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * Read the raw index once and count `failed` session events per session. The folded index
 * (readIndex) only remembers the LAST state of a session, so the retry limit needs the raw
 * event stream to know how many attempts have already failed.
 */
function countFailureEvents(raw) {
  const counts = new Map();
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(event) || event.kind !== 'session' || event.state !== 'failed') continue;
    const harness = typeof event.harness === 'string' ? event.harness : '';
    const id = typeof event.id === 'string' ? event.id : '';
    const key = sessionKeyOf(event.recordId, harness, id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The dsh action needs the bridge task revision, which the folded index does not carry
 * (readIndex keeps harness/id/source/state only). It is read back out of the raw `record`
 * events, keyed exactly like the folded sessions, with a later record event replacing an
 * earlier one just as the fold does.
 */
function collectRevisions(raw) {
  const revisions = new Map();
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(event) || event.kind !== 'record') continue;
    const recordId = String(event.recordId ?? '');
    if (recordId === '') continue;
    for (const session of Array.isArray(event.sessions) ? event.sessions : []) {
      if (!isObject(session)) continue;
      const harness = typeof session.harness === 'string' ? session.harness : '';
      const id = typeof session.id === 'string' ? session.id : '';
      const key = sessionKeyOf(recordId, harness, id);
      if (session.revision === undefined) revisions.delete(key);
      else revisions.set(key, session.revision);
    }
  }
  return revisions;
}

/**
 * The immediate subdirectories of `claudeProjectsDir` that hold a FILE named `<id>.jsonl`.
 * Exactly one level below the root is inspected; nothing deeper is ever searched, and a
 * directory that merely has the file's name is not a session file. A missing root is zero
 * matches rather than an error.
 */
async function findClaudeSessionDirs(root, id, readdirImpl) {
  let projects;
  try {
    projects = await readdirImpl(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const matches = [];
  for (const project of projects) {
    const projectIsDirectory = typeof project?.isDirectory === 'function' ? project.isDirectory() : true;
    if (!projectIsDirectory) continue;
    const dir = path.join(root, project.name);
    let children;
    try {
      children = await readdirImpl(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const child of children) {
      if (child?.name !== `${id}.jsonl`) continue;
      const childIsFile = typeof child.isFile === 'function' ? child.isFile() : true;
      if (!childIsFile) continue;
      matches.push(dir);
    }
  }
  return matches;
}

/** A string for the (JSON-safe) outcome of bridge.cleanup. */
function describeOutcome(outcome) {
  if (outcome === undefined) return null;
  if (typeof outcome === 'string') return boundNote(outcome);
  if (typeof outcome === 'number' || typeof outcome === 'boolean') return String(outcome);
  try {
    const json = JSON.stringify(outcome);
    return json === undefined ? 'cleanup outcome is not serialisable' : boundNote(json);
  } catch {
    return 'cleanup outcome is not serialisable';
  }
}

function archiveFailureNote(outcome) {
  const reason = typeof outcome.reason === 'string' && outcome.reason !== ''
    ? outcome.reason
    : typeof outcome.error?.message === 'string' && outcome.error.message !== ''
      ? outcome.error.message
      : 'archive returned archived=false';
  return boundNote(reason);
}

async function deleteCodexThread(id, deps) {
  const action = 'delete';
  const client = deps.codexThreads;
  if (client === null || client === undefined) {
    return { action, state: 'skipped', note: NOTE_CODEX_UNAVAILABLE };
  }
  try {
    await client.archive(id);
    await client.remove(id);
    return { action, state: 'deleted', note: null };
  } catch (error) {
    return { action, state: 'failed', note: errorNote(error) };
  }
}

async function deleteClaudeSession(id, deps) {
  const action = 'delete';
  const root = deps.claudeProjectsDir;
  if (root === null || root === undefined) {
    return { action, state: 'skipped', note: NOTE_CLAUDE_DIR_UNAVAILABLE };
  }
  try {
    const matches = await findClaudeSessionDirs(root, id, deps.readdir);
    if (matches.length === 0) return { action, state: 'skipped', note: NOTE_CLAUDE_FILE_MISSING };
    if (matches.length > 1) return { action, state: 'failed', note: NOTE_CLAUDE_AMBIGUOUS };
    const dir = matches[0];
    await deps.rm(path.join(dir, `${id}.jsonl`));
    const sibling = path.join(dir, id);
    if (await isDirectoryEntry(sibling, deps.stat)) {
      await deps.rm(sibling, { recursive: true, force: true });
    }
    return { action, state: 'deleted', note: null };
  } catch (error) {
    return { action, state: 'failed', note: errorNote(error) };
  }
}

async function archiveDshTask(source, revision, deps) {
  const action = 'archive';
  const client = deps.bridge;
  if (client === null || client === undefined) {
    return { action, state: 'skipped', note: NOTE_BRIDGE_UNAVAILABLE };
  }
  try {
    const outcome = await client.archive(source, revision === undefined ? null : revision);
    if (isObject(outcome) && outcome.archived === false) {
      return { action, state: 'failed', note: archiveFailureNote(outcome) };
    }
  } catch (error) {
    // "Already archived" is the outcome we wanted, not a failure.
    if (!isAlreadyArchived(error)) return { action, state: 'failed', note: errorNote(error) };
  }
  // The physical cleanup is a separate, tolerated step: its outcome (or the error code) is
  // reported in the note, but a cleanup failure never turns an archived session into failed.
  let note = null;
  try {
    note = describeOutcome(await client.cleanup(source, { dryRun: false }));
  } catch (error) {
    note = errorCodeOf(error);
  }
  return { action, state: 'archived', note };
}

/**
 * Validate one session's id and, outside dryRun, perform its harness action.
 * Returns `{action, state, note}` without ever throwing.
 */
async function executeSession({ harness, id, source, revision, dryRun, deps }) {
  const action = actionForHarness(harness);
  if (harness === CODEX || harness === CLAUDE) {
    if (!isUuid(id)) return { action, state: 'failed', note: NOTE_INVALID_ID };
  } else if (harness === DSH) {
    if (!isDshSource(source)) return { action, state: 'failed', note: NOTE_INVALID_ID };
  } else {
    return { action: 'skip', state: dryRun ? 'planned' : 'skipped', note: NOTE_UNSUPPORTED_HARNESS };
  }
  if (dryRun) return { action, state: 'planned', note: null };
  if (harness === CODEX) return deleteCodexThread(id, deps);
  if (harness === CLAUDE) return deleteClaudeSession(id, deps);
  return archiveDshTask(source, revision, deps);
}

/** A session is actionable while it is pending, or failed with attempts left. */
function isActionable(state, failures, recordId, harness, id, maxAttempts) {
  if (state === 'pending') return true;
  if (state !== 'failed') return false; // deleted, archived and skipped are final
  return (failures.get(sessionKeyOf(recordId, harness, id)) ?? 0) < maxAttempts;
}

/**
 * Clean the raw sessions of every record whose retention window has arrived.
 *
 * @param {object} input
 * @param {string} input.stateDir absolute directory holding records-index.jsonl
 * @param {Function} [input.now] returns epoch milliseconds (default Date.now)
 * @param {boolean} [input.dryRun] default true: plan only, call nothing, write nothing
 * @param {object|null} [input.codexThreads] createCodexThreadClient result (never closed here)
 * @param {object|null} [input.bridge] `{archive(source, revision), cleanup(source, {dryRun})}`
 * @param {string|null} [input.claudeProjectsDir] root whose immediate subdirectories hold
 *   `<sessionId>.jsonl` files
 * @param {number} [input.maxAttempts] failed attempts allowed before a session is left alone
 * @param {object} [input.fsImpl] optional node:fs/promises overrides
 *   ({readFile, readdir, rm, stat, mkdir, appendFile})
 * @returns {Promise<{dryRun: boolean, checked: number, due: number, actions: Array<object>}>}
 *   `checked` is the number of records in the index; `due` is the number whose retention
 *   window has arrived (a due record whose record file is missing still yields 'skip'
 *   actions); each action is `{recordId, harness, id, action, state, note}`.
 */
export async function sweepRecords({
  stateDir,
  now = Date.now,
  dryRun = true,
  codexThreads = null,
  bridge = null,
  claudeProjectsDir = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  fsImpl = {},
} = {}) {
  if (typeof stateDir !== 'string' || stateDir === '' || !path.isAbsolute(stateDir)) {
    throw new PeerPolicyError(ARGS_CODE, 'stateDir must be an absolute path', { field: 'stateDir' });
  }
  if (typeof now !== 'function') {
    throw new PeerPolicyError(ARGS_CODE, 'now must be a function returning epoch milliseconds', { field: 'now' });
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new PeerPolicyError(ARGS_CODE, 'maxAttempts must be a positive integer', { field: 'maxAttempts' });
  }
  const overrides = isObject(fsImpl) ? fsImpl : {};
  const deps = {
    readFile: typeof overrides.readFile === 'function' ? overrides.readFile : readFile,
    readdir: typeof overrides.readdir === 'function' ? overrides.readdir : readdir,
    rm: typeof overrides.rm === 'function' ? overrides.rm : rm,
    stat: typeof overrides.stat === 'function' ? overrides.stat : stat,
    mkdir: typeof overrides.mkdir === 'function' ? overrides.mkdir : mkdir,
    appendFile: typeof overrides.appendFile === 'function' ? overrides.appendFile : appendFile,
    codexThreads,
    bridge,
    claudeProjectsDir,
    maxAttempts,
  };

  // Fold the index through readIndex and capture the same bytes in passing: the raw event
  // stream is needed for the failure counts and for the dsh revisions the fold drops.
  const indexPath = path.join(stateDir, INDEX_FILE);
  let rawIndex = '';
  const capturingRead = async (target, encoding) => {
    const data = await deps.readFile(target, encoding);
    if (typeof data === 'string' && path.normalize(target) === path.normalize(indexPath)) rawIndex = data;
    return data;
  };
  const index = await readIndex(stateDir, { readFile: capturingRead });
  const failures = countFailureEvents(rawIndex);
  const revisions = collectRevisions(rawIndex);

  const isDryRun = Boolean(dryRun);
  const at = now();
  const actions = [];
  let due = 0;

  for (const record of index.values()) {
    const eligibleAt = record.eligibleAt;
    if (typeof eligibleAt !== 'number' || !Number.isFinite(eligibleAt)) continue;
    if (eligibleAt > at) continue;
    if (record.keep === true) continue;
    // The retention window has arrived. Whether the record file still exists is the second,
    // action-level gate: a missing file yields 'skip' actions instead of any cleaning.
    due += 1;
    const recordId = record.recordId === null || record.recordId === undefined ? '' : String(record.recordId);
    const recordPath = typeof record.path === 'string' && record.path !== '' ? record.path : null;
    const recordFileExists = recordPath !== null && (await entryExists(recordPath, deps.stat));

    for (const session of record.sessions.values()) {
      const harness = typeof session.harness === 'string' ? session.harness : '';
      const id = typeof session.id === 'string' ? session.id : '';
      const source = typeof session.source === 'string' ? session.source : '';
      if (!isActionable(session.state, failures, recordId, harness, id, deps.maxAttempts)) continue;

      let outcome;
      if (!recordFileExists) {
        outcome = { action: 'skip', state: 'skipped', note: NOTE_RECORD_FILE_MISSING };
      } else {
        outcome = await executeSession({
          harness,
          id,
          source,
          revision: revisions.get(sessionKeyOf(recordId, harness, id)),
          dryRun: isDryRun,
          deps,
        });
      }
      actions.push({
        recordId,
        harness,
        id,
        action: outcome.action,
        state: outcome.state,
        note: outcome.note,
      });
      // In dryRun nothing is written. Otherwise the event lands straight away, so an
      // interrupted sweep never repeats an action that already finished.
      if (!isDryRun) {
        await appendIndexEvent(stateDir, {
          kind: 'session',
          recordId,
          harness,
          id,
          state: outcome.state,
          note: outcome.note,
        }, { now, mkdir: deps.mkdir, appendFile: deps.appendFile });
      }
    }
  }

  return { dryRun: isDryRun, checked: index.size, due, actions };
}
