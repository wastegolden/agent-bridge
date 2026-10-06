// src/peer/cli.mjs
//
// Headless invocation of a peer harness CLI and parsing of its output
// (contract agent-peer-v1). Pure functions: argv construction, child environment
// shaping and output parsing. Process management lives in src/peer/jobs.mjs.
//
// The prompt always travels on stdin, never on the command line: no quoting
// surface, no Windows 32K command-line limit, and a prompt that starts with "-" can
// never be read as a flag.
//
//   codex       codex exec --json --skip-git-repo-check -s <sandbox> -C <cwd> -o <file> -
//               codex exec resume --json --skip-git-repo-check -c sandbox_mode="<s>" -o <file> <id> -
//   claude-code claude -p --output-format json --permission-mode <mode> [--allowedTools ...]
//               claude -p --resume <id> ...

import path from 'node:path';

import { PeerPolicyError } from './chain.mjs';

/** Read-only tool set handed to a Claude Code peer for consult/review. */
export const CLAUDE_READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
export const CODEX_SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
export const CLAUDE_DELEGATE_MODES = Object.freeze(['acceptEdits', 'auto', 'dontAsk']);
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/;

/**
 * Session-identity variables of the CALLING harness. A child harness must start its
 * own session, so these are removed from the inherited environment; everything else
 * (PATH, credentials files, DSH_MCP_TOKEN for a sub-controller) is inherited.
 */
const CALLER_SESSION_ENV_RE = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|HOST_SESSION_ID|ENTRYPOINT|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_[A-Z_]+)|CODEX_(THREAD_ID|TURN_ID|CALL_ID|APP_TOOLS_[A-Z_]+))$/;

export function childEnvironment(baseEnv, chainEnv) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (typeof value !== 'string') continue;
    if (CALLER_SESSION_ENV_RE.test(key)) continue;
    if (key.startsWith('AGENT_BRIDGE_')) continue;
    env[key] = value;
  }
  return { ...env, ...chainEnv };
}

function assertAbsoluteDir(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', `${field} must be an absolute path`, { field });
  }
  return path.resolve(value);
}

/**
 * Build one CLI invocation.
 * @param {object} request - { target, mode, cwd, sessionId?, model?, addDirs?, lastMessageFile }
 * @param {object} peer - normalized peer config for request.target
 * @returns {{command: string, args: string[], cwd: string, readOnly: boolean}}
 */
export function buildInvocation(request, peer) {
  const { target, mode } = request;
  const cwd = assertAbsoluteDir(request.cwd, 'cwd');
  const readOnly = mode !== 'delegate';
  const sessionId = request.sessionId ?? null;
  if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', 'sessionId is not a valid session identifier', { field: 'sessionId' });
  }
  const model = request.model ?? peer.model ?? null;
  if (model !== null && (typeof model !== 'string' || !MODEL_RE.test(model))) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', 'model is not a valid model identifier', { field: 'model' });
  }
  const addDirs = (request.addDirs ?? []).map((dir, index) => assertAbsoluteDir(dir, `addDirs[${index}]`));
  if (readOnly && addDirs.length > 0) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', 'addDirs grants extra writable roots and is only accepted for mode "delegate"', { field: 'addDirs' });
  }
  const extraArgs = [...(peer.extraArgs ?? [])];

  if (target === 'codex') {
    const sandbox = readOnly ? 'read-only' : peer.delegateSandbox;
    if (!CODEX_SANDBOXES.includes(sandbox)) {
      throw new PeerPolicyError('PEER_CONFIG_INVALID', `codex sandbox must be one of ${CODEX_SANDBOXES.join(', ')}`, { field: 'delegateSandbox' });
    }
    if (typeof request.lastMessageFile !== 'string' || !path.isAbsolute(request.lastMessageFile)) {
      throw new PeerPolicyError('PEER_ARGS_INVALID', 'lastMessageFile must be an absolute path', { field: 'lastMessageFile' });
    }
    const common = ['--json', '--skip-git-repo-check', ...(model ? ['-m', model] : []), '-o', request.lastMessageFile];
    const args = sessionId === null
      ? ['exec', ...common, '-s', sandbox, '-C', cwd, ...addDirs.flatMap((dir) => ['--add-dir', dir]), ...extraArgs, '-']
      // `exec resume` has no -s/-C: the sandbox is pinned by a config override and the
      // working directory by the spawned process.
      : ['exec', 'resume', ...common, '-c', `sandbox_mode="${sandbox}"`, ...extraArgs, sessionId, '-'];
    return { command: peer.executable, args, cwd, readOnly };
  }

  if (target === 'claude-code') {
    const permission = readOnly
      ? ['--permission-mode', 'dontAsk', '--allowedTools', ...(peer.readOnlyTools ?? CLAUDE_READ_ONLY_TOOLS)]
      : ['--permission-mode', peer.delegatePermissionMode, ...((peer.delegateAllowedTools ?? []).length > 0 ? ['--allowedTools', ...peer.delegateAllowedTools] : [])];
    if (!readOnly && !CLAUDE_DELEGATE_MODES.includes(peer.delegatePermissionMode)) {
      throw new PeerPolicyError('PEER_CONFIG_INVALID', `claude delegate permission mode must be one of ${CLAUDE_DELEGATE_MODES.join(', ')}`, { field: 'delegatePermissionMode' });
    }
    const args = [
      '-p',
      '--output-format', 'json',
      ...(sessionId !== null ? ['--resume', sessionId] : []),
      ...(model ? ['--model', model] : []),
      ...addDirs.flatMap((dir) => ['--add-dir', dir]),
      ...extraArgs,
      // Variadic --allowedTools goes last so nothing after it is read as a tool name.
      ...permission,
    ];
    return { command: peer.executable, args, cwd, readOnly };
  }

  throw new PeerPolicyError('PEER_UNKNOWN_TARGET', `no CLI adapter for "${target}"`, { field: 'target' });
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Parse `codex exec --json` JSONL. Unknown event types are counted, never guessed. */
export function parseCodexOutput(stdoutText, lastMessageText = null) {
  const result = { sessionId: null, finalMessage: null, usage: null, errors: [], eventCounts: {}, unparsedLines: 0 };
  for (const raw of String(stdoutText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const event = safeJson(line);
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      result.unparsedLines += 1;
      continue;
    }
    result.eventCounts[event.type] = (result.eventCounts[event.type] ?? 0) + 1;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') result.sessionId = event.thread_id;
    else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') result.finalMessage = event.item.text;
    else if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') result.usage = event.usage;
    else if (event.type === 'turn.failed' || event.type === 'error') {
      const message = event.error?.message ?? event.message ?? JSON.stringify(event).slice(0, 500);
      result.errors.push(String(message).slice(0, 2000));
    }
  }
  if (typeof lastMessageText === 'string' && lastMessageText.trim() !== '') result.finalMessage = lastMessageText;
  result.ok = result.errors.length === 0 && result.finalMessage !== null;
  return result;
}

/** Parse `claude -p --output-format json` (one result object). */
export function parseClaudeOutput(stdoutText) {
  const text = String(stdoutText ?? '').trim();
  const result = { sessionId: null, finalMessage: null, usage: null, errors: [], costUsd: null, numTurns: null, permissionDenials: 0 };
  const parsed = text ? safeJson(text) ?? safeJson(text.split(/\r?\n/).filter(Boolean).at(-1) ?? '') : undefined;
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'result') {
    result.errors.push('claude output is not a JSON result object');
    result.ok = false;
    return result;
  }
  result.sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
  result.finalMessage = typeof parsed.result === 'string' ? parsed.result : null;
  result.usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : null;
  result.costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
  result.numTurns = Number.isInteger(parsed.num_turns) ? parsed.num_turns : null;
  result.permissionDenials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : 0;
  if (parsed.is_error === true) result.errors.push(String(parsed.result ?? parsed.subtype ?? 'claude reported an error').slice(0, 2000));
  result.ok = result.errors.length === 0 && result.finalMessage !== null;
  return result;
}

export function parsePeerOutput(target, stdoutText, lastMessageText = null) {
  return target === 'codex' ? parseCodexOutput(stdoutText, lastMessageText) : parseClaudeOutput(stdoutText);
}
