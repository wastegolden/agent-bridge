// src/peer/cli.mjs
//
// Headless invocation of a peer harness CLI and parsing of its output
// (contract agent-peer-v1). Pure functions: argv construction, child environment
// shaping and output parsing. Process management lives in src/peer/jobs.mjs.
//
// The prompt always travels on stdin, never on the command line: no quoting
// surface, no Windows 32K command-line limit, and a prompt that starts with "-" can
// never be read as a flag. There is no free-form "extra arguments" channel: every
// flag is built here from validated, structured options, and the read-only flags are
// placed last so nothing configured can override them.
//
//   codex       codex exec --json --skip-git-repo-check [-m M] [-c model_reasoning_effort=E]
//                 [-p PROFILE] [--ignore-user-config] -o <file> -s <sandbox> -C <cwd> [--add-dir D]... -
//               codex exec resume ... -o <file> -c sandbox_mode="<s>" <id> -
//   claude-code claude -p --output-format json [--resume ID] [--model M] [--effort E]
//                 [--fallback-model F] [--add-dir D]... <permission flags>
//
// Read-only (consult/review):
//   codex   -s read-only (shell sandbox). MCP servers configured in the user's Codex
//           are NOT sandboxed by Codex; `readOnlyIgnoreUserConfig: true` drops them
//           (and the rest of config.toml) for read-only runs.
//   claude  --tools <read-only built-ins> (nothing else exists in the session, so a
//           pre-approved Write/Bash rule in settings has nothing to approve),
//           --disallowedTools <write tools>, --strict-mcp-config (no MCP servers),
//           --permission-mode dontAsk.

import path from 'node:path';

import { PeerPolicyError } from './chain.mjs';

/** Default read-only tool set handed to a Claude Code peer for consult/review. */
export const CLAUDE_READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
/** Every built-in a read-only Claude peer may be given. Anything else is refused by config. */
export const CLAUDE_READ_ONLY_ALLOWED = Object.freeze(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LS', 'NotebookRead', 'TodoWrite']);
/** Built-ins that can change files, run commands or spawn agents: always denied when read-only. */
export const CLAUDE_WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Task', 'Agent']);
export const CODEX_SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
export const CODEX_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CLAUDE_DELEGATE_MODES = Object.freeze(['acceptEdits', 'auto', 'dontAsk']);
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Session-identity variables of the CALLING harness. A child harness must start its
 * own session, so these are removed from the inherited environment; everything else
 * (PATH, credentials files, DSH_MCP_TOKEN for a sub-controller) is inherited.
 * Case-insensitive: Windows environment names are case-insensitive.
 */
const CALLER_SESSION_ENV_RE = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|HOST_SESSION_ID|ENTRYPOINT|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_[A-Z_]+)|CODEX_(THREAD_ID|TURN_ID|CALL_ID|APP_TOOLS_[A-Z_]+))$/i;

export function childEnvironment(baseEnv, chainEnv) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (typeof value !== 'string') continue;
    if (CALLER_SESSION_ENV_RE.test(key)) continue;
    if (key.toUpperCase().startsWith('AGENT_BRIDGE_')) continue;
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

function checkToolNames(list, field) {
  for (const name of list) {
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) throw new PeerPolicyError('PEER_CONFIG_INVALID', `${field} contains an invalid tool name`, { field });
  }
  return list;
}

/**
 * Build one CLI invocation.
 * @param {object} request - { target, mode, cwd, sessionId?, model?, addDirs?, lastMessageFile }
 * @param {object} peer - normalized peer config for request.target (src/peer/config.mjs)
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

  if (target === 'codex') {
    if (sessionId !== null && addDirs.length > 0) {
      throw new PeerPolicyError('PEER_ARGS_INVALID', 'codex exec resume cannot add writable roots; start a new delegate session instead', { field: 'addDirs' });
    }
    const sandbox = readOnly ? 'read-only' : peer.delegateSandbox;
    if (!CODEX_SANDBOXES.includes(sandbox)) {
      throw new PeerPolicyError('PEER_CONFIG_INVALID', `codex sandbox must be one of ${CODEX_SANDBOXES.join(', ')}`, { field: 'delegateSandbox' });
    }
    if (typeof request.lastMessageFile !== 'string' || !path.isAbsolute(request.lastMessageFile)) {
      throw new PeerPolicyError('PEER_ARGS_INVALID', 'lastMessageFile must be an absolute path', { field: 'lastMessageFile' });
    }
    if (peer.reasoningEffort != null && !CODEX_EFFORTS.includes(peer.reasoningEffort)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid codex reasoningEffort', { field: 'reasoningEffort' });
    if (peer.profile != null && !PROFILE_RE.test(peer.profile)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid codex profile', { field: 'profile' });
    const options = [
      '--json',
      '--skip-git-repo-check',
      ...(model ? ['-m', model] : []),
      ...(peer.reasoningEffort ? ['-c', `model_reasoning_effort="${peer.reasoningEffort}"`] : []),
      ...(peer.profile ? ['-p', peer.profile] : []),
      ...(readOnly && peer.readOnlyIgnoreUserConfig === true ? ['--ignore-user-config'] : []),
      '-o', request.lastMessageFile,
    ];
    const args = sessionId === null
      ? ['exec', ...options, '-s', sandbox, '-C', cwd, ...addDirs.flatMap((dir) => ['--add-dir', dir]), '-']
      // `exec resume` has no -s/-C: the sandbox is pinned by the LAST config override and
      // the working directory is the session's own (the server requires the same cwd).
      : ['exec', 'resume', ...options, '-c', `sandbox_mode="${sandbox}"`, sessionId, '-'];
    return { command: peer.executable, args, cwd, readOnly };
  }

  if (target === 'claude-code') {
    if (peer.effort != null && !CLAUDE_EFFORTS.includes(peer.effort)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid claude effort', { field: 'effort' });
    if (peer.fallbackModel != null && !MODEL_RE.test(peer.fallbackModel)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid claude fallbackModel', { field: 'fallbackModel' });
    let permission;
    if (readOnly) {
      const tools = checkToolNames(peer.readOnlyTools ?? [...CLAUDE_READ_ONLY_TOOLS], 'readOnlyTools');
      if (tools.some((name) => !CLAUDE_READ_ONLY_ALLOWED.includes(name))) {
        throw new PeerPolicyError('PEER_CONFIG_INVALID', `readOnlyTools may only name ${CLAUDE_READ_ONLY_ALLOWED.join(', ')}`, { field: 'readOnlyTools' });
      }
      permission = [
        '--strict-mcp-config',
        '--permission-mode', 'dontAsk',
        '--disallowedTools', ...CLAUDE_WRITE_TOOLS,
        '--allowedTools', ...tools,
        '--tools', ...tools,
      ];
    } else {
      if (!CLAUDE_DELEGATE_MODES.includes(peer.delegatePermissionMode)) {
        throw new PeerPolicyError('PEER_CONFIG_INVALID', `claude delegate permission mode must be one of ${CLAUDE_DELEGATE_MODES.join(', ')}`, { field: 'delegatePermissionMode' });
      }
      const allowed = checkToolNames(peer.delegateAllowedTools ?? [], 'delegateAllowedTools');
      permission = ['--permission-mode', peer.delegatePermissionMode, ...(allowed.length > 0 ? ['--allowedTools', ...allowed] : [])];
    }
    const args = [
      '-p',
      '--output-format', 'json',
      ...(sessionId !== null ? ['--resume', sessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(peer.effort ? ['--effort', peer.effort] : []),
      ...(peer.fallbackModel ? ['--fallback-model', peer.fallbackModel] : []),
      ...addDirs.flatMap((dir) => ['--add-dir', dir]),
      // Permission flags last; the variadic tool lists end the argv (the prompt is stdin).
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
