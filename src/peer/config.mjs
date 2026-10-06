// src/peer/config.mjs
//
// Operator configuration for the agent-peer MCP server (contract agent-peer-v1).
// One JSON file, named by AGENT_PEER_CONFIG, holds absolute paths and limits only —
// never a credential. Each peer CLI keeps using its own login.
//
// {
//   "schemaVersion": 1,
//   "stateDir": "E:/.../agent-peer",
//   "peers": {
//     "codex":       { "executable": "C:/.../codex.exe", "delegateSandbox": "workspace-write" },
//     "claude-code": { "executable": "C:/.../claude.exe", "delegatePermissionMode": "acceptEdits" }
//   },
//   "limits": { "timeoutMs": 1800000, "maxConcurrentJobs": 3, "maxPromptChars": 200000 }
// }

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CLAUDE_DELEGATE_MODES, CLAUDE_READ_ONLY_TOOLS, CODEX_SANDBOXES } from './cli.mjs';
import { PEER_TARGETS, PeerPolicyError } from './chain.mjs';

export const CONFIG_ENV = 'AGENT_PEER_CONFIG';
export const PEER_CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 30 * 60_000,
  maxTimeoutMs: 4 * 60 * 60_000,
  maxConcurrentJobs: 3,
  maxPromptChars: 200_000,
  maxWaitMs: 55_000,
});

const TOP_KEYS = ['schemaVersion', 'stateDir', 'peers', 'limits'];
const PEER_KEYS = {
  codex: ['executable', 'model', 'extraArgs', 'delegateSandbox', 'enabled'],
  'claude-code': ['executable', 'model', 'extraArgs', 'readOnlyTools', 'delegatePermissionMode', 'delegateAllowedTools', 'enabled'],
};
const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);

function fail(message, field) {
  throw new PeerPolicyError('PEER_CONFIG_INVALID', message, { field });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(object, allowed, where) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`${where}.${key} is not a recognized field`, `${where}.${key}`);
}

function absolute(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) fail(`${field} must be an absolute path`, field);
  return path.resolve(value);
}

function stringList(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '' || item.includes('\u0000'))) {
    fail(`${field} must be an array of nonblank strings`, field);
  }
  return [...value];
}

function positiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive integer`, field);
  return value;
}

export function normalizePeerConfig(raw) {
  if (!isPlainObject(raw)) fail('peer config must be a JSON object', 'config');
  onlyKeys(raw, TOP_KEYS, 'config');
  if (raw.schemaVersion !== PEER_CONFIG_SCHEMA_VERSION) fail(`schemaVersion must be ${PEER_CONFIG_SCHEMA_VERSION}`, 'schemaVersion');
  const stateDir = absolute(raw.stateDir, 'stateDir');
  if (!isPlainObject(raw.peers)) fail('peers must be an object', 'peers');
  const peers = {};
  for (const [name, value] of Object.entries(raw.peers)) {
    if (!PEER_TARGETS.includes(name)) fail(`peers.${name} is not a supported peer`, `peers.${name}`);
    if (!isPlainObject(value)) fail(`peers.${name} must be an object`, `peers.${name}`);
    onlyKeys(value, PEER_KEYS[name], `peers.${name}`);
    const enabled = value.enabled === undefined ? true : value.enabled;
    if (typeof enabled !== 'boolean') fail(`peers.${name}.enabled must be a boolean`, `peers.${name}.enabled`);
    const peer = {
      name,
      enabled,
      executable: absolute(value.executable, `peers.${name}.executable`),
      model: value.model === undefined || value.model === null ? null : String(value.model),
      extraArgs: stringList(value.extraArgs, `peers.${name}.extraArgs`) ?? [],
    };
    if (name === 'codex') {
      peer.delegateSandbox = value.delegateSandbox ?? 'workspace-write';
      if (!CODEX_SANDBOXES.includes(peer.delegateSandbox)) fail(`peers.codex.delegateSandbox must be one of ${CODEX_SANDBOXES.join(', ')}`, 'peers.codex.delegateSandbox');
    } else {
      peer.readOnlyTools = stringList(value.readOnlyTools, 'peers.claude-code.readOnlyTools') ?? [...CLAUDE_READ_ONLY_TOOLS];
      peer.delegatePermissionMode = value.delegatePermissionMode ?? 'acceptEdits';
      if (!CLAUDE_DELEGATE_MODES.includes(peer.delegatePermissionMode)) {
        fail(`peers.claude-code.delegatePermissionMode must be one of ${CLAUDE_DELEGATE_MODES.join(', ')}`, 'peers.claude-code.delegatePermissionMode');
      }
      peer.delegateAllowedTools = stringList(value.delegateAllowedTools, 'peers.claude-code.delegateAllowedTools') ?? [];
    }
    peers[name] = Object.freeze(peer);
  }
  const limits = { ...DEFAULT_LIMITS };
  if (raw.limits !== undefined) {
    if (!isPlainObject(raw.limits)) fail('limits must be an object', 'limits');
    onlyKeys(raw.limits, LIMIT_KEYS, 'limits');
    for (const [key, value] of Object.entries(raw.limits)) limits[key] = positiveInt(value, `limits.${key}`);
  }
  if (limits.timeoutMs > limits.maxTimeoutMs) fail('limits.timeoutMs must not exceed limits.maxTimeoutMs', 'limits.timeoutMs');
  if (limits.maxWaitMs > 600_000) fail('limits.maxWaitMs must be at most 600000', 'limits.maxWaitMs');
  return Object.freeze({ schemaVersion: PEER_CONFIG_SCHEMA_VERSION, stateDir, peers: Object.freeze(peers), limits: Object.freeze(limits) });
}

export async function loadPeerConfig({ env = process.env, readFileImpl = readFile } = {}) {
  const file = env?.[CONFIG_ENV];
  if (typeof file !== 'string' || file.trim() === '') fail(`${CONFIG_ENV} must name the peer config file`, CONFIG_ENV);
  const configPath = absolute(file.trim(), CONFIG_ENV);
  let text;
  try {
    text = await readFileImpl(configPath, 'utf8');
  } catch (error) {
    fail(`cannot read the peer config file (${error?.code ?? 'E_READ'})`, CONFIG_ENV);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    fail('the peer config file is not valid JSON', CONFIG_ENV);
  }
  return normalizePeerConfig(parsed);
}
