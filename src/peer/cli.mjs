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
//   claude-code claude -p --output-format json [--no-session-persistence] [--resume ID]
//                 [--model M] [--effort E] [--fallback-model F] [--add-dir D]... <permission flags>
//   antigravity agy --input-format stream-json --output-format stream-json --disable-slash-commands
//                 [--conversation ID] [--model M] [--effort E] [--add-dir D]...
//                 [--agent A] [--sandbox] --settings <json>
//
// Read-only (consult/review):
//   codex   -s read-only (shell sandbox). MCP servers configured in the user's Codex
//           are NOT sandboxed by Codex; `readOnlyIgnoreUserConfig: true` drops them
//           (and the rest of config.toml) for read-only runs.
//   claude  --tools <read-only built-ins> (nothing else exists in the session, so a
//           pre-approved Write/Bash rule in settings has nothing to approve),
//           --disallowedTools <write tools>, --strict-mcp-config (no MCP servers),
//           --permission-mode dontAsk, --no-session-persistence (a read-only peer leaves
//           no resumable session behind).
//   antigravity --disable-slash-commands, optional --agent <readOnlyAgent> (strips
//           write/shell/MCP tool declarations when deployed), and ephemeral --settings
//           with `allowNonWorkspaceAccess: false` plus `permissions.deny` blocking
//           write_file(*), command(*), mcp(*), execute_url(*) and download_url(*).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripBridgeCredentials } from '../bridge-credentials.mjs';
import { PeerPolicyError } from './chain.mjs';

/** Default read-only tool set handed to a Claude Code peer for consult/review. */
export const CLAUDE_READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
/** Every built-in a read-only Claude peer may be given. Anything else is refused by config. */
export const CLAUDE_READ_ONLY_ALLOWED = Object.freeze(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LS', 'NotebookRead', 'TodoWrite']);
/** Built-ins that can change files, run commands or spawn agents: always denied when read-only. */
export const CLAUDE_WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Task', 'Agent']);
/** Read-only web built-ins toggled by `webSearch` for Claude Code. */
export const CLAUDE_WEB_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);
export const CODEX_SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
export const CODEX_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
/** Codex plugin selector `name@marketplace`, used to disable plugins for read-only runs. */
export const CODEX_PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CLAUDE_DELEGATE_MODES = Object.freeze(['acceptEdits', 'auto', 'dontAsk']);
export const ANTIGRAVITY_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const ANTIGRAVITY_DELEGATE_MODES = Object.freeze(['accept-edits', 'auto']);
/** Permission rules always denied on a read-only Antigravity run (consult/review). */
export const ANTIGRAVITY_READ_ONLY_DENY = Object.freeze([
  'write_file(*)',
  'command(*)',
  'mcp(*)',
  'execute_url(*)',
  'download_url(*)',
]);
/** Default MCP permission rules granted to an Antigravity sub-controller (delegate). */
export const ANTIGRAVITY_DEFAULT_DELEGATE_PERMISSIONS = Object.freeze([
  'mcp(agent-bridge_dsh_project/*)',
  'mcp(agent-bridge_agent_peer/*)',
]);
export const ANTIGRAVITY_AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Structured Antigravity permission rule `<action>(<target>)`, without control chars or nested parens. */
export const ANTIGRAVITY_PERMISSION_RULE_RE = /^[a-z][a-z0-9_-]{0,63}\([^\u0000-\u001f\u007f()]{1,256}\)$/;
/**
 * One reasoning-effort value. Deliberately narrow: the codex value is interpolated
 * into `-c model_reasoning_effort="<E>"`, so no quote, space or shell metacharacter
 * can survive this check.
 */
export const EFFORT_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Built-in names (Read) and MCP rules (mcp__plugin_agent-bridge_dsh_project, optionally
// __tool). No spaces, parentheses or wildcards: those would change rule semantics.
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

/**
 * Session-identity variables of the CALLING harness. A child harness must start its
 * own session, so these are removed from the inherited environment; everything else
 * (PATH and unrelated settings) is inherited. Bridge credentials are injected only
 * after the server verifies the effective delegate credential.
 * Case-insensitive: Windows environment names are case-insensitive.
 */
const CALLER_SESSION_ENV_RE = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|HOST_SESSION_ID|ENTRYPOINT|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_[A-Z_]+)|CODEX_(THREAD_ID|TURN_ID|CALL_ID|APP_TOOLS_[A-Z_]+)|ANTIGRAVITY_(AGENT|AGENTAPI_EXE|APP_DATA_DIR|CONVERSATION_ID|CSRF_TOKEN|LS_ADDRESS|LS_VERSION|PROJECT_ID|SOURCE_METADATA|TRAJECTORY_ID)|AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP)$/i;

export function childEnvironment(baseEnv, chainEnv, { mode, bridgeCredential = null } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(stripBridgeCredentials(baseEnv))) {
    if (typeof value !== 'string') continue;
    if (CALLER_SESSION_ENV_RE.test(key)) continue;
    if (key.toUpperCase().startsWith('AGENT_BRIDGE_')) continue;
    env[key] = value;
  }
  Object.assign(env, chainEnv);
  if (mode === 'delegate' && bridgeCredential !== null) {
    env.DSH_MCP_TOKEN = bridgeCredential.token;
    env.DSH_BRIDGE_DELEGATED = '1';
  } else {
    env.DSH_BRIDGE_DISABLED = '1';
  }
  return env;
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

function checkAntigravityPermissions(list, field) {
  for (const rule of list) {
    if (typeof rule !== 'string' || !ANTIGRAVITY_PERMISSION_RULE_RE.test(rule)) {
      throw new PeerPolicyError('PEER_CONFIG_INVALID', `${field} contains an invalid Antigravity permission rule`, { field });
    }
  }
  return list;
}

/** Frame a prompt as one NDJSON user turn for `agy --input-format stream-json`. */
export function formatAntigravityInput(prompt) {
  return `${JSON.stringify({ event: 'user', message: { content: String(prompt ?? '') } })}\n`;
}

/**
 * The reasoning-effort values a target accepts: the configured
 * `peers.<target>.efforts` list when it is set, otherwise the built-in list.
 * Unknown targets have no list.
 *
 * @param {string} target 'codex' | 'claude-code' | 'antigravity'
 * @param {object|null} peer normalized peer config (may be a partial `{ efforts }`)
 * @returns {string[]}
 */
export function effortChoices(target, peer) {
  const configured = peer?.efforts;
  if (Array.isArray(configured) && configured.length > 0) return [...configured];
  if (target === 'codex') return [...CODEX_EFFORTS];
  if (target === 'claude-code') return [...CLAUDE_EFFORTS];
  if (target === 'antigravity') return [...ANTIGRAVITY_EFFORTS];
  return [];
}

/**
 * The reasoning effort actually passed to one CLI run: per-call argument >
 * configured default > nothing (the CLI's own default). Only validated values can
 * ever reach the argv.
 */
function resolveEffort(target, request, peer) {
  const isCodex = target === 'codex';
  const configured = isCodex ? (peer.reasoningEffort ?? null) : (peer.effort ?? null);
  const field = isCodex ? 'reasoningEffort' : 'effort';
  const choices = effortChoices(target, peer);
  if (configured !== null && !choices.includes(configured)) {
    throw new PeerPolicyError('PEER_CONFIG_INVALID', `invalid ${target} ${field}`, { field });
  }
  const requested = request.reasoningEffort ?? null;
  if (requested === null) {
    return { reasoningEffort: configured, effortSource: configured === null ? 'cli-default' : 'config' };
  }
  if (typeof requested !== 'string' || !EFFORT_RE.test(requested) || !choices.includes(requested)) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', `reasoningEffort must be one of ${choices.join(', ')}`, { field: 'reasoningEffort' });
  }
  return { reasoningEffort: requested, effortSource: 'call' };
}

/**
 * Build one CLI invocation.
 * @param {object} request - { target, mode, cwd, sessionId?, model?, reasoningEffort?, addDirs?, lastMessageFile }
 * @param {object} peer - normalized peer config for request.target (src/peer/config.mjs)
 * @returns {{command: string, args: string[], cwd: string, readOnly: boolean,
 *   model: string|null, modelSource: 'call'|'config'|'cli-default',
 *   reasoningEffort: string|null, effortSource: 'call'|'config'|'cli-default'}}
 */
export function buildInvocation(request, peer) {
  const { target, mode } = request;
  const cwd = assertAbsoluteDir(request.cwd, 'cwd');
  const readOnly = mode !== 'delegate';
  const sessionId = request.sessionId ?? null;
  if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', 'sessionId is not a valid session identifier', { field: 'sessionId' });
  }
  // Precedence for both model and effort: per-call argument > configured default >
  // nothing (the CLI's own default). `model`/`reasoningEffort` are what was PASSED.
  const model = request.model ?? peer.model ?? null;
  const modelSource = request.model != null ? 'call' : peer.model != null ? 'config' : 'cli-default';
  if (model !== null && (typeof model !== 'string' || !MODEL_RE.test(model))) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', 'model is not a valid model identifier', { field: 'model' });
  }
  let effort = { reasoningEffort: null, effortSource: 'cli-default' };
  const addDirs = (request.addDirs ?? []).map((dir, index) => assertAbsoluteDir(dir, `addDirs[${index}]`));
  if (readOnly && addDirs.length > 0) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', 'addDirs grants extra writable roots and is only accepted for mode "delegate"', { field: 'addDirs' });
  }
  const webSearch = request.webSearch ?? null;
  if (webSearch !== null && typeof webSearch !== 'boolean') {
    throw new PeerPolicyError('PEER_ARGS_INVALID', 'webSearch must be a boolean', { field: 'webSearch' });
  }
  if (!readOnly && webSearch !== null) {
    throw new PeerPolicyError('PEER_ARGS_INVALID', 'webSearch only controls read-only modes ("consult" or "review")', { field: 'webSearch' });
  }

  if (target === 'codex') {
    if (webSearch !== null) {
      throw new PeerPolicyError('PEER_ARGS_INVALID', 'codex does not support per-call webSearch control', { field: 'webSearch' });
    }
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
    effort = resolveEffort(target, request, peer);
    if (peer.profile != null && !PROFILE_RE.test(peer.profile)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid codex profile', { field: 'profile' });
    const options = [
      '--json',
      '--skip-git-repo-check',
      ...(model ? ['-m', model] : []),
      ...(effort.reasoningEffort ? ['-c', `model_reasoning_effort="${effort.reasoningEffort}"`] : []),
      ...(peer.profile ? ['-p', peer.profile] : []),
      ...(readOnly && peer.readOnlyIgnoreUserConfig === true ? ['--ignore-user-config'] : []),
      // MCP tools are outside the shell sandbox; plugins whose tools are pre-approved are
      // switched off for read-only runs so a reviewer cannot act through them.
      ...(readOnly ? (peer.readOnlyDisablePlugins ?? []).flatMap((id) => {
        if (!CODEX_PLUGIN_ID_RE.test(id)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid codex plugin id in readOnlyDisablePlugins', { field: 'readOnlyDisablePlugins' });
        return ['-c', `plugins."${id}".enabled=false`];
      }) : []),
      '-o', request.lastMessageFile,
    ];
    const args = sessionId === null
      ? ['exec', ...options, '-s', sandbox, '-C', cwd, ...addDirs.flatMap((dir) => ['--add-dir', dir]), '-']
      // `exec resume` has no -s/-C: the sandbox is pinned by the LAST config override and
      // the working directory is the session's own (the server requires the same cwd).
      : ['exec', 'resume', ...options, '-c', `sandbox_mode="${sandbox}"`, sessionId, '-'];
    return { command: peer.executable, args, cwd, readOnly, webSearch: null, model, modelSource, reasoningEffort: effort.reasoningEffort, effortSource: effort.effortSource };
  }

  if (target === 'claude-code') {
    effort = resolveEffort(target, request, peer);
    if (peer.fallbackModel != null && !MODEL_RE.test(peer.fallbackModel)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid claude fallbackModel', { field: 'fallbackModel' });
    let permission;
    let resolvedWebSearch = null;
    if (readOnly) {
      const configuredTools = checkToolNames(peer.readOnlyTools ?? [...CLAUDE_READ_ONLY_TOOLS], 'readOnlyTools');
      if (configuredTools.some((name) => !CLAUDE_READ_ONLY_ALLOWED.includes(name))) {
        throw new PeerPolicyError('PEER_CONFIG_INVALID', `readOnlyTools may only name ${CLAUDE_READ_ONLY_ALLOWED.join(', ')}`, { field: 'readOnlyTools' });
      }
      let tools = configuredTools;
      let disallowed = [...CLAUDE_WRITE_TOOLS];
      if (webSearch === false) {
        tools = configuredTools.filter((name) => !CLAUDE_WEB_TOOLS.includes(name));
        if (tools.length === 0) {
          throw new PeerPolicyError('PEER_CONFIG_INVALID', 'readOnlyTools leaves no non-web tools when webSearch is false', { field: 'readOnlyTools' });
        }
        disallowed = [...CLAUDE_WRITE_TOOLS, ...CLAUDE_WEB_TOOLS];
        resolvedWebSearch = false;
      } else if (webSearch === true) {
        tools = [...configuredTools];
        for (const name of CLAUDE_WEB_TOOLS) if (!tools.includes(name)) tools.push(name);
        resolvedWebSearch = true;
      }
      permission = [
        '--strict-mcp-config',
        '--permission-mode', 'dontAsk',
        '--disallowedTools', ...disallowed,
        '--allowedTools', ...tools,
        '--tools', ...tools,
      ];
    } else {
      if (!CLAUDE_DELEGATE_MODES.includes(peer.delegatePermissionMode)) {
        throw new PeerPolicyError('PEER_CONFIG_INVALID', `claude delegate permission mode must be one of ${CLAUDE_DELEGATE_MODES.join(', ')}`, { field: 'delegatePermissionMode' });
      }
      const allowed = checkToolNames(peer.delegateAllowedTools ?? [], 'delegateAllowedTools');
      // Delegate MCP uses the carrier so inherited credentials, disabled markers and
      // via apply in both directions. Root Claude also uses stdio with its own file;
      // this strict delegate config inherits the verified root token.
      // These names preserve the plugin's existing MCP tool permission prefixes.
      const mcpConfig = { mcpServers: {
        'plugin_agent-bridge_dsh_project': {
          command: process.execPath,
          args: [fileURLToPath(new URL('../../bin/bridge.mjs', import.meta.url))],
        },
        'plugin_agent-bridge_agent_peer': {
          command: process.execPath,
          args: [fileURLToPath(new URL('../../bin/peer-mcp.mjs', import.meta.url))],
          env: { AGENT_BRIDGE_SELF: 'claude-code' },
        },
      } };
      permission = ['--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig), '--permission-mode', peer.delegatePermissionMode, ...(allowed.length > 0 ? ['--allowedTools', ...allowed] : [])];
    }
    const args = [
      '-p',
      '--output-format', 'json',
      // A read-only peer (consult/review) leaves no session behind, so there is nothing
      // to resume later; the flag sits directly after --output-format json.
      ...(readOnly ? ['--no-session-persistence'] : []),
      ...(sessionId !== null ? ['--resume', sessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(effort.reasoningEffort ? ['--effort', effort.reasoningEffort] : []),
      ...(peer.fallbackModel ? ['--fallback-model', peer.fallbackModel] : []),
      ...addDirs.flatMap((dir) => ['--add-dir', dir]),
      // Permission flags last; the variadic tool lists end the argv (the prompt is stdin).
      ...permission,
    ];
    return { command: peer.executable, args, cwd, readOnly, webSearch: resolvedWebSearch, model, modelSource, reasoningEffort: effort.reasoningEffort, effortSource: effort.effortSource };
  }

  if (target === 'antigravity') {
    effort = resolveEffort(target, request, peer);
    const readOnlyAgent = peer.readOnlyAgent ?? null;
    if (readOnlyAgent !== null && (typeof readOnlyAgent !== 'string' || !ANTIGRAVITY_AGENT_NAME_RE.test(readOnlyAgent))) {
      throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid antigravity readOnlyAgent', { field: 'readOnlyAgent' });
    }
    const readOnlyWebAgent = peer.readOnlyWebAgent ?? null;
    if (readOnlyWebAgent !== null && (typeof readOnlyWebAgent !== 'string' || !ANTIGRAVITY_AGENT_NAME_RE.test(readOnlyWebAgent))) {
      throw new PeerPolicyError('PEER_CONFIG_INVALID', 'invalid antigravity readOnlyWebAgent', { field: 'readOnlyWebAgent' });
    }
    let settings;
    let selectedAgent = null;
    let resolvedWebSearch = null;
    if (readOnly) {
      if (webSearch === true) {
        if (readOnlyWebAgent !== null) {
          selectedAgent = readOnlyWebAgent;
        } else if (readOnlyAgent !== null) {
          throw new PeerPolicyError('PEER_CONFIG_INVALID', 'antigravity webSearch=true requires peers.antigravity.readOnlyWebAgent when readOnlyAgent is set', { field: 'readOnlyWebAgent' });
        }
        resolvedWebSearch = true;
      } else if (webSearch === false) {
        if (readOnlyAgent === null) {
          throw new PeerPolicyError('PEER_CONFIG_INVALID', 'antigravity webSearch=false requires peers.antigravity.readOnlyAgent to disable search_web', { field: 'readOnlyAgent' });
        }
        selectedAgent = readOnlyAgent;
        resolvedWebSearch = false;
      } else {
        selectedAgent = readOnlyAgent;
        resolvedWebSearch = readOnlyAgent !== null ? false : null;
      }
      settings = {
        agentMode: '',
        toolPermission: 'request-review',
        allowNonWorkspaceAccess: false,
        permissions: { deny: [...ANTIGRAVITY_READ_ONLY_DENY] },
      };
    } else {
      const delegateMode = peer.delegateMode ?? 'accept-edits';
      if (!ANTIGRAVITY_DELEGATE_MODES.includes(delegateMode)) {
        throw new PeerPolicyError('PEER_CONFIG_INVALID', `antigravity delegateMode must be one of ${ANTIGRAVITY_DELEGATE_MODES.join(', ')}`, { field: 'delegateMode' });
      }
      const allowedPermissions = checkAntigravityPermissions(peer.delegateAllowedPermissions ?? [...ANTIGRAVITY_DEFAULT_DELEGATE_PERMISSIONS], 'delegateAllowedPermissions');
      settings = {
        agentMode: delegateMode,
        ...(allowedPermissions.length > 0 ? { permissions: { allow: allowedPermissions } } : {}),
      };
    }
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      ...(sessionId !== null ? ['--conversation', sessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(effort.reasoningEffort ? ['--effort', effort.reasoningEffort] : []),
      ...addDirs.flatMap((dir) => ['--add-dir', dir]),
      ...(readOnly && selectedAgent !== null ? ['--agent', selectedAgent] : []),
      ...(!readOnly && peer.delegateSandbox === true ? ['--sandbox'] : []),
      // Session-only settings sit last so nothing configured can weaken the read-only deny rules.
      '--settings', JSON.stringify(settings),
    ];
    return {
      command: peer.executable,
      args,
      cwd,
      readOnly,
      webSearch: resolvedWebSearch,
      inputFormat: 'stream-json',
      model,
      modelSource,
      reasoningEffort: effort.reasoningEffort,
      effortSource: effort.effortSource,
    };
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

/** Parse `agy --output-format stream-json` NDJSON. Unknown event types are counted, never guessed. */
export function createAntigravityOutputParser() {
  const result = { sessionId: null, finalMessage: null, usage: null, errors: [], eventCounts: {}, unparsedLines: 0, numTurns: null };
  let sawResult = false;
  function acceptLine(raw) {
    const line = raw.trim();
    if (!line) return;
    const event = safeJson(line);
    if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
      result.unparsedLines += 1;
      return;
    }
    result.eventCounts[event.event] = (result.eventCounts[event.event] ?? 0) + 1;
    if (typeof event.conversation_id === 'string' && event.conversation_id.trim() !== '') {
      result.sessionId = event.conversation_id.trim();
    }
    if (event.event === 'result' && event.result && typeof event.result === 'object') {
      sawResult = true;
      const body = event.result;
      if (typeof body.conversation_id === 'string' && body.conversation_id.trim() !== '') {
        result.sessionId = body.conversation_id.trim();
      }
      if (typeof body.response === 'string') result.finalMessage = body.response;
      if (body.usage && typeof body.usage === 'object') result.usage = body.usage;
      if (Number.isInteger(body.num_turns)) result.numTurns = body.num_turns;
      const status = typeof body.status === 'string' ? body.status.toUpperCase() : '';
      if (typeof body.error === 'string' && body.error.trim() !== '') {
        result.errors.push(body.error.trim().slice(0, 2000));
      } else if (status !== '' && status !== 'SUCCESS') {
        result.errors.push(`antigravity ended with status ${status}`.slice(0, 2000));
      }
    } else if (event.event === 'error') {
      const message = event.error?.message ?? event.error ?? event.message ?? JSON.stringify(event).slice(0, 500);
      result.errors.push(String(message).slice(0, 2000));
    }
  }
  function finish() {
    if (!sawResult && result.errors.length === 0) {
      result.errors.push('antigravity output did not include a result event');
    }
    result.ok = sawResult && result.errors.length === 0 && result.finalMessage !== null;
    return result;
  }
  return { acceptLine, finish };
}

export function parseAntigravityOutput(stdoutText) {
  const parser = createAntigravityOutputParser();
  for (const line of String(stdoutText ?? '').split(/\r?\n/)) parser.acceptLine(line);
  return parser.finish();
}

export function parsePeerOutput(target, stdoutText, lastMessageText = null) {
  if (target === 'codex') return parseCodexOutput(stdoutText, lastMessageText);
  if (target === 'antigravity') return parseAntigravityOutput(stdoutText);
  return parseClaudeOutput(stdoutText);
}
