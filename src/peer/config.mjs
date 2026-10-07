// src/peer/config.mjs
//
// Operator configuration for the agent-peer MCP server (contract agent-peer-v1).
// One JSON file, named by AGENT_PEER_CONFIG, holds absolute paths and limits only —
// never a credential. Each peer CLI keeps using its own login. Codex and Claude Code
// should point at the SAME file so both see one job ledger and one lineage ledger.
//
// {
//   "schemaVersion": 1,
//   "stateDir": "E:/.../agent-peer",
//   "peers": {
//     "codex":       { "executable": "C:/.../codex.exe", "reasoningEffort": "high" },
//     "claude-code": { "executable": "C:/.../claude.exe", "delegatePermissionMode": "acceptEdits" }
//   },
//   "limits": { "timeoutMs": 1800000, "maxConcurrentJobs": 3, "maxPromptChars": 200000 },
//   "records": {
//     "enabled": true, "dirName": ".agent-bridge/records", "retainDays": 3,
//     "disputedRetainDays": 30, "sweepIntervalMinutes": 60,
//     "claudeProjectsDir": "C:/Users/me/.claude/projects"
//   },
//   "bridge": { "url": "http://127.0.0.1:3080/mcp", "credentialFile": "C:/.../token" }
// }
//
// There is deliberately no free-form argument list: every CLI flag is derived from a
// validated field, so configuration can never re-open a read-only sandbox.

import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isLocalBridgeUrl } from './bridge-client.mjs';
import { CLAUDE_DELEGATE_MODES, CLAUDE_EFFORTS, CLAUDE_READ_ONLY_ALLOWED, CLAUDE_READ_ONLY_TOOLS, CODEX_EFFORTS, CODEX_PLUGIN_ID_RE, CODEX_SANDBOXES, MODEL_RE } from './cli.mjs';
import { PEER_TARGETS, PeerPolicyError } from './chain.mjs';
import { DEFAULT_DISPUTED_RETAIN_DAYS, DEFAULT_RECORD_DIR, DEFAULT_RETAIN_DAYS } from './records.mjs';

export const CONFIG_ENV = 'AGENT_PEER_CONFIG';
export const PEER_CONFIG_SCHEMA_VERSION = 1;
/** Node timers overflow above 2^31-1 ms and fire after ~1 ms instead. */
export const MAX_TIMER_MS = 2_147_483_647;

export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 30 * 60_000,
  maxTimeoutMs: 4 * 60 * 60_000,
  maxConcurrentJobs: 3,
  maxPromptChars: 200_000,
  maxWaitMs: 55_000,
});

/** Codex thread section a finished peer job is moved into unless configured otherwise. */
export const DEFAULT_THREAD_SECTION = 'Agent Bridge';
/** Prefix of the thread name a finished peer job is renamed to. */
export const DEFAULT_THREAD_NAME_PREFIX = '[agent-bridge]';
export const MAX_THREAD_NAME_PREFIX_CHARS = 40;
export const MAX_THREAD_SECTION_CHARS = 200;
/** Default sweep cadence for the retention sweeper, in minutes (0 disables the timer). */
export const DEFAULT_SWEEP_INTERVAL_MINUTES = 60;

const TOP_KEYS = ['schemaVersion', 'stateDir', 'peers', 'limits', 'records', 'bridge'];
const PEER_KEYS = {
  codex: ['executable', 'enabled', 'model', 'reasoningEffort', 'profile', 'delegateSandbox', 'readOnlyIgnoreUserConfig', 'readOnlyDisablePlugins', 'threadSection', 'threadNamePrefix'],
  'claude-code': ['executable', 'enabled', 'model', 'effort', 'fallbackModel', 'readOnlyTools', 'delegatePermissionMode', 'delegateAllowedTools'],
};
const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);
const RECORD_KEYS = ['enabled', 'dirName', 'retainDays', 'disputedRetainDays', 'sweepIntervalMinutes', 'claudeProjectsDir'];
const BRIDGE_KEYS = ['url', 'credentialFile'];
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function fail(message, field) {
  throw new PeerPolicyError('PEER_CONFIG_INVALID', message, { field });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (key === 'extraArgs') fail(`${where}.extraArgs is not supported: free-form CLI arguments could override the read-only sandbox`, `${where}.extraArgs`);
    if (!allowed.includes(key)) fail(`${where}.${key} is not a recognized field`, `${where}.${key}`);
  }
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

function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null) return null;
  if (!allowed.includes(value)) fail(`${field} must be one of ${allowed.join(', ')}`, field);
  return value;
}

function optionalModel(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !MODEL_RE.test(value)) fail(`${field} is not a valid model identifier`, field);
  return value;
}

function positiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive integer`, field);
  return value;
}

function nonNegativeInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be an integer >= 0`, field);
  return value;
}

function booleanValue(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`, field);
  return value;
}

/** A relative directory that can never escape the project root (`..`, absolute, drive). */
function relativeDirName(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '' || CONTROL_CHAR_RE.test(value)) {
    fail(`${field} must be a nonempty relative path`, field);
  }
  const normalized = path.normalize(value);
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    fail(`${field} must be a relative path that stays inside the project root`, field);
  }
  return value;
}

/** A nonblank, bounded, control-character-free name. */
function boundedName(value, maxChars, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxChars || CONTROL_CHAR_RE.test(value)) {
    fail(`${field} must be a nonblank string of at most ${maxChars} characters without control characters`, field);
  }
  return value;
}

function normalizeRecordsConfig(value) {
  const records = {
    enabled: true,
    dirName: DEFAULT_RECORD_DIR,
    retainDays: DEFAULT_RETAIN_DAYS,
    disputedRetainDays: DEFAULT_DISPUTED_RETAIN_DAYS,
    sweepIntervalMinutes: DEFAULT_SWEEP_INTERVAL_MINUTES,
    claudeProjectsDir: path.join(os.homedir(), '.claude', 'projects'),
  };
  if (value === undefined || value === null) return records;
  if (!isPlainObject(value)) fail('records must be an object', 'records');
  onlyKeys(value, RECORD_KEYS, 'records');
  records.enabled = booleanValue(value.enabled, records.enabled, 'records.enabled');
  records.dirName = relativeDirName(value.dirName, records.dirName, 'records.dirName');
  if (value.retainDays !== undefined) records.retainDays = positiveInt(value.retainDays, 'records.retainDays');
  if (value.disputedRetainDays !== undefined) records.disputedRetainDays = positiveInt(value.disputedRetainDays, 'records.disputedRetainDays');
  if (value.sweepIntervalMinutes !== undefined) records.sweepIntervalMinutes = nonNegativeInt(value.sweepIntervalMinutes, 'records.sweepIntervalMinutes');
  if (value.claudeProjectsDir !== undefined) records.claudeProjectsDir = absolute(value.claudeProjectsDir, 'records.claudeProjectsDir');
  return records;
}

/** The local DSH bridge endpoint, or null when the operator configured none. */
function normalizeBridgeConfig(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) fail('bridge must be an object', 'bridge');
  onlyKeys(value, BRIDGE_KEYS, 'bridge');
  if (!isLocalBridgeUrl(value.url)) {
    fail('bridge.url must be http://127.0.0.1 or http://localhost (any port or path)', 'bridge.url');
  }
  const credentialFile = value.credentialFile === undefined || value.credentialFile === null
    ? null
    : absolute(value.credentialFile, 'bridge.credentialFile');
  return { url: value.url.trim(), credentialFile };
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
      model: optionalModel(value.model, `peers.${name}.model`),
    };
    if (/\.(cmd|bat)$/i.test(peer.executable)) {
      fail(`peers.${name}.executable must be the real executable, not a .cmd/.bat shim (spawned without a shell)`, `peers.${name}.executable`);
    }
    if (name === 'codex') {
      peer.reasoningEffort = optionalEnum(value.reasoningEffort, CODEX_EFFORTS, 'peers.codex.reasoningEffort');
      peer.profile = value.profile === undefined || value.profile === null ? null : String(value.profile);
      if (peer.profile !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(peer.profile)) fail('peers.codex.profile is not a valid profile name', 'peers.codex.profile');
      peer.delegateSandbox = value.delegateSandbox ?? 'workspace-write';
      if (!CODEX_SANDBOXES.includes(peer.delegateSandbox)) fail(`peers.codex.delegateSandbox must be one of ${CODEX_SANDBOXES.join(', ')}`, 'peers.codex.delegateSandbox');
      peer.readOnlyIgnoreUserConfig = value.readOnlyIgnoreUserConfig === undefined ? false : value.readOnlyIgnoreUserConfig;
      if (typeof peer.readOnlyIgnoreUserConfig !== 'boolean') fail('peers.codex.readOnlyIgnoreUserConfig must be a boolean', 'peers.codex.readOnlyIgnoreUserConfig');
      peer.readOnlyDisablePlugins = stringList(value.readOnlyDisablePlugins, 'peers.codex.readOnlyDisablePlugins') ?? [];
      if (peer.readOnlyDisablePlugins.some((id) => !CODEX_PLUGIN_ID_RE.test(id))) fail('peers.codex.readOnlyDisablePlugins must hold plugin ids like name@marketplace', 'peers.codex.readOnlyDisablePlugins');
      // null disables thread grouping entirely; a string names the section to move into.
      peer.threadSection = value.threadSection === undefined
        ? DEFAULT_THREAD_SECTION
        : value.threadSection === null
          ? null
          : boundedName(value.threadSection, MAX_THREAD_SECTION_CHARS, 'peers.codex.threadSection');
      peer.threadNamePrefix = value.threadNamePrefix === undefined
        ? DEFAULT_THREAD_NAME_PREFIX
        : boundedName(value.threadNamePrefix, MAX_THREAD_NAME_PREFIX_CHARS, 'peers.codex.threadNamePrefix');
    } else {
      peer.effort = optionalEnum(value.effort, CLAUDE_EFFORTS, 'peers.claude-code.effort');
      peer.fallbackModel = optionalModel(value.fallbackModel, 'peers.claude-code.fallbackModel');
      peer.readOnlyTools = stringList(value.readOnlyTools, 'peers.claude-code.readOnlyTools') ?? [...CLAUDE_READ_ONLY_TOOLS];
      if (peer.readOnlyTools.length === 0 || peer.readOnlyTools.some((tool) => !CLAUDE_READ_ONLY_ALLOWED.includes(tool))) {
        fail(`peers.claude-code.readOnlyTools may only name ${CLAUDE_READ_ONLY_ALLOWED.join(', ')}`, 'peers.claude-code.readOnlyTools');
      }
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
  if (limits.maxTimeoutMs > MAX_TIMER_MS) fail(`limits.maxTimeoutMs must be at most ${MAX_TIMER_MS}`, 'limits.maxTimeoutMs');
  if (limits.timeoutMs > limits.maxTimeoutMs) fail('limits.timeoutMs must not exceed limits.maxTimeoutMs', 'limits.timeoutMs');
  if (limits.maxWaitMs > 600_000) fail('limits.maxWaitMs must be at most 600000', 'limits.maxWaitMs');
  const records = normalizeRecordsConfig(raw.records);
  const bridge = normalizeBridgeConfig(raw.bridge);
  return Object.freeze({
    schemaVersion: PEER_CONFIG_SCHEMA_VERSION,
    stateDir,
    peers: Object.freeze(peers),
    limits: Object.freeze(limits),
    records: Object.freeze(records),
    bridge: bridge === null ? null : Object.freeze(bridge),
  });
}

/**
 * Resolve an executable pattern with exactly one `*` path segment (an app-managed
 * version or hash directory, e.g. `.../claude-code/* /claude.exe`) to the newest
 * matching existing file. A plain path is returned unchanged.
 */
export async function resolveExecutablePattern(pattern, { readdirImpl = readdir, statImpl = stat } = {}) {
  if (typeof pattern !== 'string' || !pattern.includes('*')) return pattern;
  const segments = pattern.split(/[\\/]+/);
  const star = segments.indexOf('*');
  if (star <= 0 || segments.filter((segment) => segment.includes('*')).length !== 1) {
    fail('an executable pattern may contain exactly one whole "*" path segment', 'executable');
  }
  const parent = segments.slice(0, star).join(path.sep) || path.sep;
  const rest = segments.slice(star + 1);
  let candidates = [];
  try {
    candidates = await readdirImpl(parent, { withFileTypes: true });
  } catch {
    fail(`executable pattern parent ${parent} is not readable`, 'executable');
  }
  const found = [];
  for (const entry of candidates) {
    if (!entry.isDirectory()) continue;
    const file = path.join(parent, entry.name, ...rest);
    try {
      const info = await statImpl(file);
      if (info.isFile()) found.push({ file, mtimeMs: info.mtimeMs });
    } catch {
      // this version directory has no such executable
    }
  }
  if (found.length === 0) fail(`no executable matches ${pattern}`, 'executable');
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0].file;
}

export async function loadPeerConfig({ env = process.env, readFileImpl = readFile, resolveExecutable = resolveExecutablePattern } = {}) {
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
  if (isPlainObject(parsed?.peers)) {
    for (const peer of Object.values(parsed.peers)) {
      if (isPlainObject(peer) && typeof peer.executable === 'string' && peer.executable.includes('*')) {
        peer.executable = await resolveExecutable(peer.executable);
      }
    }
  }
  return normalizePeerConfig(parsed);
}
