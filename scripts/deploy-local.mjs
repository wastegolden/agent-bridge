#!/usr/bin/env node
// Deploy this plugin to a local machine (Claude Code + Codex + optional Antigravity): first install or update.
//
//   node scripts/deploy-local.mjs --config <deploy.json> [--dry-run] [--prepare-only]
//
// --prepare-only requires identity mode. It creates a stable plugin.prepared-* copy
// and missing identity artifacts, preserving active plugins, caches and settings.
// Pass the reported directory to switch-controller-clients.mjs --prepared-plugin.
//
// deploy.json (machine-specific, keep it outside the package; see scripts/deploy.example.json):
// {
//   "deployRoot": "D:/.../agent-bridge",          holds plugin/, config/, state/ and the
//                                                 Claude marketplace (.claude-plugin/)
//   "nodePath": "C:/.../node.exe",                Node 24+, written into the Claude plugin defaults
//   "bridgeUrl": "http://127.0.0.1:3080/mcp/codex-bridge-v1",
//   "repo": "E:/.../agent-bridge",                optional: export the committed HEAD of this git
//                                                 repository; without it the package directory
//                                                 that holds this script is copied as is
//   "gitExecutable": "C:/.../git.exe",            optional (default: git on PATH), repo mode only
//   "peerConfig": "D:/.../config/agent-peer.json", optional (default <deployRoot>/config/agent-peer.json)
//   "credentialFile": "D:/.../token.txt",         optional legacy shared token; rejected with identity
//   "identity": {                                 optional controller identity deployment
//     "credentialDirectory": "D:/.../credentials",
//     "migrationBackupDirectory": "D:/.../backups",
//     "legacyTokenFile": "D:/.../legacy.token"    optional; validates and adds the admin legacy controller
//   },
//   "codexPluginDir": "C:/Users/<you>/.agents/plugins/plugins/agent-bridge",   optional
//   "codexExecutable": "C:/.../Codex/bin/*/codex.exe",                           optional
//   "codexPluginId": "agent-bridge@personal",                                    optional
//   "codexMarketplace": "C:/Users/<you>/.agents/plugins/marketplace.json",      optional
//   "claudeExecutable": "C:/.../claude-code/*/*/claude.exe",                     optional
//   "claudePluginId": "agent-bridge@agent-bridge-local",                         optional
//   "antigravityPluginDir": "C:/Users/<you>/.gemini/config/plugins/agent-bridge", optional
//   "antigravityExecutable": "C:/Users/<you>/AppData/Local/agy/bin/agy.exe",      optional
//   "antigravityDataDir": "C:/Users/<you>/.gemini/antigravity-cli"                optional
// }
// Executable paths may use whole `*` segments; the newest match is used, because desktop
// apps may install their CLI under version/hash directories that change on update.
//
// Identity mode additionally writes, under <deployRoot>/config:
//   controller-host-overlap.json / controller-host-final.json  (host controller identity fragments)
//   agent-peer-claude-code.json / agent-peer-codex.json        (one peer config per root; + antigravity when configured)
//   launch-claude-code.mjs / launch-codex.mjs                  (root launch wrappers; + antigravity when configured; no token inside)
// Those are deployment artifacts only; no token content is ever written into a config.
//
// First install: files that are machine-specific are created only when missing and never
// overwritten — the Claude marketplace, the agent-peer configs, the Codex plugin's
// .mcp.json and the Codex marketplace entry. In identity mode an existing old Codex
// .mcp.json is migrated to the A3 stdio carrier shape instead of keeping HTTP/shared-token.
//
// Why defaults are patched: a plugin host may not apply stored userConfig values to
// every session (the Claude desktop app started the servers with the literal default
// "node"). Machine paths therefore become the defaults of the DEPLOYED copy only; the
// package keeps portable defaults.
//
// Why the Claude CLI is called: Claude Code runs an installed plugin from its own cache
// (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>), not from deployRoot, so a
// deploy that skips `plugin marketplace update` + `plugin update` leaves the old copy
// running. That is how 1.4.0 kept starting with the literal "node" after 1.5.0 shipped.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isAbsoluteLocalPath, loadControllerRegistry } from '../src/controller-auth.mjs';
import { stripBridgeCredentials } from '../src/bridge-credentials.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const CONTROLLER_TOKEN_NAMES = Object.freeze({
  claude: 'claude-code.token',
  codex: 'codex.token',
  operator: 'operator.token',
});
export const IDENTITY_FILE_NAMES = Object.freeze({
  overlap: 'controller-host-overlap.json',
  final: 'controller-host-final.json',
});
export const PEER_FILE_NAMES = Object.freeze({
  claude: 'agent-peer-claude-code.json',
  codex: 'agent-peer-codex.json',
});
export const LAUNCHER_FILE_NAMES = Object.freeze({
  claude: 'launch-claude-code.mjs',
  codex: 'launch-codex.mjs',
});
export const ANTIGRAVITY_FILE_NAMES = Object.freeze({
  token: 'antigravity.token',
  peer: 'agent-peer-antigravity.json',
  launcher: 'launch-antigravity.mjs',
});
const TOKEN_RE = /^[\x21-\x7e]{24,512}$/;
const BRIDGE_CREDENTIAL_ENV = /^(DSH_MCP_TOKEN|DSH_BRIDGE_CREDENTIAL_FILE|DSH_BRIDGE_DELEGATED|DSH_BRIDGE_DISABLED)$/i;
const ROOT_PROVENANCE_ENV = /^(AGENT_BRIDGE_CHAIN|AGENT_BRIDGE_ROOT_TASK)$/i;
const hasAntigravity = (config) => Boolean(config?.antigravityPluginDir || config?.antigravityExecutable);

export const USAGE = 'usage: node scripts/deploy-local.mjs --config <deploy.json> [--dry-run] [--prepare-only]';

export function parseArgs(argv) {
  const options = { configPath: null, dryRun: false, prepareOnly: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--prepare-only') options.prepareOnly = true;
    else if (argument === '-h' || argument === '--help') options.help = true;
    else if (argument === '--config') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--config requires a value');
      options.configPath = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const slash = (value) => value.replaceAll('\\', '/');

/**
 * Compare two path spellings after normalizing both.
 * Windows paths are case-insensitive; every other platform keeps exact case.
 */
export function samePath(left, right, platform = process.platform) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function validateConfig(config) {
  if (!isPlainObject(config)) throw new Error('deploy config: must be a JSON object');
  for (const key of ['deployRoot', 'nodePath', 'bridgeUrl']) {
    if (typeof config[key] !== 'string' || config[key].trim() === '') throw new Error(`deploy config: ${key} is required`);
  }
  for (const key of ['repo', 'gitExecutable', 'deployRoot', 'nodePath', 'peerConfig', 'credentialFile', 'codexPluginDir', 'codexExecutable', 'codexMarketplace', 'claudeExecutable', 'antigravityPluginDir', 'antigravityExecutable', 'antigravityDataDir']) {
    if (config[key] !== undefined && !path.isAbsolute(config[key])) throw new Error(`deploy config: ${key} must be absolute`);
  }
  if (config.identity === undefined) return;
  if (config.credentialFile !== undefined) {
    throw new Error('deploy config: credentialFile is the legacy shared credential and cannot be used with identity');
  }
  if (!isPlainObject(config.identity)) throw new Error('deploy config: identity must be an object');
  const allowed = ['credentialDirectory', 'migrationBackupDirectory', 'legacyTokenFile'];
  for (const key of Object.keys(config.identity)) {
    if (!allowed.includes(key)) throw new Error(`deploy config: identity.${key} is not a recognized field`);
  }
  for (const key of ['credentialDirectory', 'migrationBackupDirectory', 'legacyTokenFile']) {
    if (config.identity[key] !== undefined && !isAbsoluteLocalPath(config.identity[key])) {
      throw new Error(`deploy config: identity.${key} must be an absolute local path`);
    }
  }
  for (const key of ['credentialDirectory', 'migrationBackupDirectory']) {
    if (typeof config.identity[key] !== 'string' || config.identity[key].trim() === '') {
      throw new Error(`deploy config: identity.${key} is required`);
    }
  }
}

/** Every path identity mode derives from the deploy config. */
export function identityLayout(config) {
  const credentialDirectory = path.resolve(config.identity.credentialDirectory);
  const migrationBackupDirectory = path.resolve(config.identity.migrationBackupDirectory);
  const legacyTokenFile = config.identity.legacyTokenFile === undefined ? null : path.resolve(config.identity.legacyTokenFile);
  const peerConfigPath = config.peerConfig ?? path.join(config.deployRoot, 'config', 'agent-peer.json');
  const peerDirectory = path.dirname(peerConfigPath);
  const includeAntigravity = hasAntigravity(config);
  const tokenFiles = Object.fromEntries(Object.entries(CONTROLLER_TOKEN_NAMES).map(([id, name]) => [id, path.join(credentialDirectory, name)]));
  const peerFiles = Object.fromEntries(Object.entries(PEER_FILE_NAMES).map(([id, name]) => [id, path.join(peerDirectory, name)]));
  const launcherFiles = Object.fromEntries(Object.entries(LAUNCHER_FILE_NAMES).map(([id, name]) => [id, path.join(config.deployRoot, 'config', name)]));
  if (includeAntigravity) {
    tokenFiles.antigravity = path.join(credentialDirectory, ANTIGRAVITY_FILE_NAMES.token);
    peerFiles.antigravity = path.join(peerDirectory, ANTIGRAVITY_FILE_NAMES.peer);
    launcherFiles.antigravity = path.join(config.deployRoot, 'config', ANTIGRAVITY_FILE_NAMES.launcher);
  }
  return {
    credentialDirectory,
    migrationBackupDirectory,
    legacyTokenFile,
    peerConfigPath,
    tokenFiles,
    peerFiles,
    hostFiles: Object.fromEntries(Object.entries(IDENTITY_FILE_NAMES).map(([id, name]) => [id, path.join(config.deployRoot, 'config', name)])),
    launcherFiles,
  };
}

const exists = async (file) => stat(file).then(() => true, () => false);

async function readJsonIfExists(file, label) {
  if (!(await exists(file))) return null;
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`deploy config: cannot read ${label}: ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`deploy config: ${label} is not valid JSON: ${file}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`deploy config: ${label} must be a JSON object: ${file}`);
  return parsed;
}

async function readToken(file, required) {
  if (!(await exists(file))) {
    if (required) throw new Error(`deploy config: credential file does not exist: ${file}`);
    return null;
  }
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    // Never include file contents or OS errors in this message.
    throw new Error(`deploy config: credential file is not readable: ${file}`);
  }
  const token = text.trim();
  if (!TOKEN_RE.test(token)) {
    throw new Error(`deploy config: credential file must hold 24 to 512 printable ASCII characters without whitespace: ${file}`);
  }
  return { file, text, token };
}

/** Read and validate every existing token before any write. */
export async function inspectIdentity(layout) {
  const existing = {};
  const missing = [];
  const seen = new Set();
  for (const [id, file] of Object.entries(layout.tokenFiles)) {
    const value = await readToken(file, false);
    if (value === null) {
      missing.push(id);
      continue;
    }
    if (seen.has(value.token)) throw new Error(`deploy config: duplicate controller token in ${file}`);
    seen.add(value.token);
    existing[id] = value;
  }
  let legacy = null;
  if (layout.legacyTokenFile !== null) {
    if (!(await exists(layout.legacyTokenFile))) {
      throw new Error(
        `deploy config: identity.legacyTokenFile does not exist: ${layout.legacyTokenFile}; `
        + 'after the final cutover remove the identity.legacyTokenFile field from the deploy config. '
        + 'Keep the token file itself while the overlap host config still references it.',
      );
    }
    legacy = await readToken(layout.legacyTokenFile, true);
    if (seen.has(legacy.token)) throw new Error('deploy config: the legacy token duplicates a controller token');
  }
  return { existing, missing, legacy };
}

/** Create only missing tokens and the migration backup directory; never overwrite. */
export async function applyIdentity(layout, inspection, dryRun) {
  const tokens = {};
  for (const [id, value] of Object.entries(inspection.existing)) tokens[id] = value.token;
  if (inspection.legacy !== null) tokens.legacy = inspection.legacy.token;
  if (dryRun) {
    for (const id of inspection.missing) tokens[id] = null;
    return tokens;
  }
  const seen = new Set(Object.values(inspection.existing).map((entry) => entry.token));
  if (inspection.legacy !== null) seen.add(inspection.legacy.token);
  await mkdir(layout.credentialDirectory, { recursive: true });
  for (const id of inspection.missing) {
    let token;
    do token = randomBytes(32).toString('hex');
    while (seen.has(token));
    seen.add(token);
    // Preserve the new file as a secret: path-only configs and 0600 where supported.
    await writeFile(layout.tokenFiles[id], token, { encoding: 'utf8', mode: 0o600 });
    tokens[id] = token;
  }
  await mkdir(layout.migrationBackupDirectory, { recursive: true });
  return tokens;
}

function hostFragment(layout, includeLegacy) {
  const controllers = [
    { id: 'claude-code', tokenFile: slash(layout.tokenFiles.claude) },
    { id: 'codex', tokenFile: slash(layout.tokenFiles.codex) },
    ...(layout.tokenFiles.antigravity ? [{ id: 'antigravity', tokenFile: slash(layout.tokenFiles.antigravity) }] : []),
    { id: 'operator', tokenFile: slash(layout.tokenFiles.operator), admin: true },
  ];
  if (includeLegacy) controllers.push({ id: 'legacy', tokenFile: slash(layout.legacyTokenFile), admin: true });
  return { controllers, identityMigrationBackupDirectory: slash(layout.migrationBackupDirectory) };
}

async function readExistingPeerFiles(layout) {
  const entries = { shared: await readJsonIfExists(layout.peerConfigPath, 'peer config') };
  for (const [id, file] of Object.entries(layout.peerFiles)) {
    entries[id] = await readJsonIfExists(file, `${id} peer config`);
  }
  return entries;
}

/** Resolve the shared stateDir and validate (without writing) existing per-root configs. */
export async function inspectPeerConfigs(config, layout, readFiles = null) {
  const files = readFiles ?? await readExistingPeerFiles(layout);
  const peerIds = Object.keys(layout.peerFiles);
  let stateDir = null;
  if (files.shared !== null) {
    if (typeof files.shared.stateDir !== 'string' || !path.isAbsolute(files.shared.stateDir)) {
      throw new Error(`deploy config: existing peer config has no absolute stateDir: ${layout.peerConfigPath}`);
    }
    stateDir = path.resolve(files.shared.stateDir);
  } else {
    for (const id of peerIds) {
      const existing = files[id];
      if (existing !== null && existing !== undefined) {
        if (typeof existing.stateDir !== 'string' || !path.isAbsolute(existing.stateDir)) {
          throw new Error(`deploy config: existing ${id} peer config has no absolute stateDir: ${layout.peerFiles[id]}`);
        }
        stateDir = path.resolve(existing.stateDir);
        break;
      }
    }
  }
  if (stateDir === null) stateDir = path.join(config.deployRoot, 'state');

  const defaultRecords = {
    enabled: true,
    dirName: '.agent-bridge/records',
    retainDays: 3,
    disputedRetainDays: 30,
    sweepIntervalMinutes: 60,
    claudeProjectsDir: slash(path.join(os.homedir(), '.claude', 'projects')),
    ...(hasAntigravity(config) || config.antigravityDataDir
      ? { antigravityDataDir: slash(config.antigravityDataDir ?? path.join(os.homedir(), '.gemini', 'antigravity-cli')) }
      : {}),
  };
  const base = files.shared === null
    ? {
        schemaVersion: 1,
        peers: {},
        records: defaultRecords,
        limits: { timeoutMs: 1800000, maxConcurrentJobs: 3 },
      }
    : structuredClone(files.shared);
  base.schemaVersion = 1;
  base.stateDir = slash(stateDir);
  if (!isPlainObject(base.peers)) throw new Error(`deploy config: existing peer config has an invalid peers field: ${layout.peerConfigPath}`);
  if (!isPlainObject(base.records)) base.records = defaultRecords;
  else if (config.antigravityDataDir) base.records.antigravityDataDir = slash(config.antigravityDataDir);
  else if (hasAntigravity(config) && base.records.antigravityDataDir === undefined) base.records.antigravityDataDir = slash(path.join(os.homedir(), '.gemini', 'antigravity-cli'));
  if (!isPlainObject(base.limits)) base.limits = { timeoutMs: 1800000, maxConcurrentJobs: 3 };
  if (config.codexExecutable) {
    base.peers.codex = { ...(isPlainObject(base.peers.codex) ? base.peers.codex : {}), executable: slash(config.codexExecutable), delegateSandbox: 'workspace-write', readOnlyDisablePlugins: [config.codexPluginId ?? 'agent-bridge@personal'], threadSection: 'Agent Bridge', threadNamePrefix: '[agent-bridge]' };
  }
  if (config.claudeExecutable) {
    base.peers['claude-code'] = { ...(isPlainObject(base.peers['claude-code']) ? base.peers['claude-code'] : {}), executable: slash(config.claudeExecutable), delegatePermissionMode: 'acceptEdits', delegateAllowedTools: ['mcp__plugin_agent-bridge_dsh_project', 'mcp__plugin_agent-bridge_agent_peer', 'Bash'] };
  }
  if (config.antigravityExecutable) {
    const existingAgy = isPlainObject(base.peers.antigravity) ? base.peers.antigravity : {};
    base.peers.antigravity = {
      ...existingAgy,
      executable: slash(config.antigravityExecutable),
      delegateMode: existingAgy.delegateMode ?? 'accept-edits',
      ...(config.antigravityPluginDir
        ? {
            readOnlyAgent: existingAgy.readOnlyAgent ?? 'agent-bridge-readonly',
            readOnlyWebAgent: existingAgy.readOnlyWebAgent ?? 'agent-bridge-readonly-web',
          }
        : {}),
      delegateAllowedPermissions: existingAgy.delegateAllowedPermissions ?? ['mcp(agent-bridge_dsh_project/*)', 'mcp(agent-bridge_agent_peer/*)'],
    };
  }

  for (const id of peerIds) {
    const existing = files[id];
    if (existing === null || existing === undefined) continue;
    if (typeof existing.stateDir !== 'string' || !path.isAbsolute(existing.stateDir) || !samePath(existing.stateDir, stateDir)) {
      throw new Error(`deploy config: existing ${id} peer config does not use the shared stateDir ${stateDir}: ${layout.peerFiles[id]}`);
    }
    const credentialFile = existing.bridge?.credentialFile;
    if (typeof credentialFile !== 'string' || !path.isAbsolute(credentialFile) || !samePath(credentialFile, layout.tokenFiles[id])) {
      throw new Error(`deploy config: existing ${id} peer config does not use its own credential file ${layout.tokenFiles[id]}: ${layout.peerFiles[id]}`);
    }
  }
  return { stateDir, base, files };
}

async function writePeerConfigs(config, layout, plan, dryRun, step) {
  const peerIds = Object.keys(layout.peerFiles);
  if (dryRun) {
    for (const id of peerIds) if (plan.files[id] === null) step(`would create ${id} root peer config ${layout.peerFiles[id]}`);
    return;
  }
  for (const id of peerIds) {
    if (plan.files[id] !== null) continue;
    await mkdir(path.dirname(layout.peerFiles[id]), { recursive: true });
    await mkdir(plan.stateDir, { recursive: true });
    const value = {
      ...structuredClone(plan.base),
      // The bridge URL comes from the deploy config, not from a stale shared block.
      bridge: { url: config.bridgeUrl, credentialFile: slash(layout.tokenFiles[id]) },
    };
    await writeFile(layout.peerFiles[id], `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    step(`created ${id} root peer config ${layout.peerFiles[id]}`);
  }
}

function codexMcpValue(template, config, pluginDir, codexPeerConfig) {
  if (!isPlainObject(template?.mcpServers?.dsh_project) || !isPlainObject(template?.mcpServers?.agent_peer)) {
    throw new Error('deploy config: .codex-mcp.json must contain the A3 dsh_project and agent_peer carrier entries');
  }
  const desired = structuredClone(template);
  desired.mcpServers.dsh_project = {
    ...template.mcpServers.dsh_project,
    command: slash(config.nodePath),
    args: [slash(path.join(pluginDir, 'bin', 'bridge.mjs'))],
  };
  desired.mcpServers.agent_peer = {
    ...template.mcpServers.agent_peer,
    command: slash(config.nodePath),
    args: [slash(path.join(pluginDir, 'bin', 'peer-mcp.mjs'))],
    env: { ...(isPlainObject(template.mcpServers.agent_peer.env) ? template.mcpServers.agent_peer.env : {}), AGENT_BRIDGE_SELF: 'codex', AGENT_PEER_CONFIG: slash(codexPeerConfig) },
  };
  for (const entry of Object.values(desired.mcpServers)) {
    if (!isPlainObject(entry.env)) entry.env = {};
    for (const key of Object.keys(entry.env)) if (BRIDGE_CREDENTIAL_ENV.test(key) || /^DSH_BRIDGE_URL$/i.test(key)) delete entry.env[key];
    // Write root paths after removing inherited credential defaults. Delegates
    // still forward their explicit token through the template's env_vars.
    entry.env.DSH_BRIDGE_CREDENTIAL_FILE = slash(identityLayout(config).tokenFiles.codex);
    entry.env.DSH_BRIDGE_URL = config.bridgeUrl;
  }
  return desired;
}

async function inspectCodexMcp(config, pluginDir, codexPeerConfig, packageRoot) {
  const template = await readJsonIfExists(path.join(packageRoot, '.codex-mcp.json'), 'Codex MCP template');
  if (template === null) throw new Error('deploy config: .codex-mcp.json is missing from the package');
  const desired = codexMcpValue(template, config, pluginDir, codexPeerConfig);
  const file = path.join(config.codexPluginDir, '.mcp.json');
  const existing = await readJsonIfExists(file, 'existing Codex MCP config');
  return { file, desired, existing };
}

async function applyCodexMcp(plan, dryRun, step) {
  if (plan.existing === null) {
    if (!dryRun) {
      await mkdir(path.dirname(plan.file), { recursive: true });
      await writeFile(plan.file, `${JSON.stringify(plan.desired, null, 2)}\n`, 'utf8');
    }
    step(`created Codex MCP config ${plan.file}`);
    return;
  }
  const merged = {
    ...plan.existing,
    mcpServers: { ...(isPlainObject(plan.existing.mcpServers) ? plan.existing.mcpServers : {}), ...plan.desired.mcpServers },
  };
  if (JSON.stringify(merged) !== JSON.stringify(plan.existing)) {
    if (!dryRun) await writeFile(plan.file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    step(`migrated Codex MCP config to the A3 stdio carrier shape ${plan.file}`);
  } else {
    step(`validated Codex MCP config ${plan.file}`);
  }
}

function antigravityMcpValue(template, config, pluginDir, antigravityPeerConfig, credentialFile) {
  if (!isPlainObject(template?.mcpServers?.dsh_project) || !isPlainObject(template?.mcpServers?.agent_peer)) {
    throw new Error('deploy config: .antigravity-mcp.json must contain the dsh_project and agent_peer carrier entries');
  }
  const desired = structuredClone(template);
  desired.mcpServers.dsh_project = {
    ...template.mcpServers.dsh_project,
    command: slash(config.nodePath),
    args: [slash(path.join(pluginDir, 'bin', 'bridge.mjs'))],
  };
  desired.mcpServers.agent_peer = {
    ...template.mcpServers.agent_peer,
    command: slash(config.nodePath),
    args: [slash(path.join(pluginDir, 'bin', 'peer-mcp.mjs'))],
    env: {
      ...(isPlainObject(template.mcpServers.agent_peer.env) ? template.mcpServers.agent_peer.env : {}),
      AGENT_BRIDGE_SELF: 'antigravity',
      AGENT_PEER_CONFIG: slash(antigravityPeerConfig),
    },
  };
  for (const entry of Object.values(desired.mcpServers)) {
    if (!isPlainObject(entry.env)) entry.env = {};
    for (const key of Object.keys(entry.env)) if (BRIDGE_CREDENTIAL_ENV.test(key) || /^DSH_BRIDGE_URL$/i.test(key)) delete entry.env[key];
    entry.env.DSH_BRIDGE_URL = config.bridgeUrl;
    if (credentialFile) entry.env.DSH_BRIDGE_CREDENTIAL_FILE = slash(credentialFile);
  }
  return desired;
}

async function inspectAntigravityMcp(config, pluginDir, antigravityPeerConfig, credentialFile, packageRoot) {
  const template = await readJsonIfExists(path.join(packageRoot, '.antigravity-mcp.json'), 'Antigravity MCP template');
  if (template === null) throw new Error('deploy config: .antigravity-mcp.json is missing from the package');
  const desired = antigravityMcpValue(template, config, pluginDir, antigravityPeerConfig, credentialFile);
  const file = path.join(config.antigravityPluginDir, 'mcp_config.json');
  const existing = await readJsonIfExists(file, 'existing Antigravity MCP config');
  return { file, desired, existing };
}

async function applyAntigravityMcp(plan, dryRun, step) {
  if (plan.existing === null) {
    if (!dryRun) {
      await mkdir(path.dirname(plan.file), { recursive: true });
      await writeFile(plan.file, `${JSON.stringify(plan.desired, null, 2)}\n`, 'utf8');
    }
    step(`created Antigravity MCP config ${plan.file}`);
    return;
  }
  const merged = {
    ...plan.existing,
    mcpServers: { ...(isPlainObject(plan.existing.mcpServers) ? plan.existing.mcpServers : {}), ...plan.desired.mcpServers },
  };
  if (JSON.stringify(merged) !== JSON.stringify(plan.existing)) {
    if (!dryRun) await writeFile(plan.file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    step(`updated Antigravity MCP config ${plan.file}`);
  } else {
    step(`validated Antigravity MCP config ${plan.file}`);
  }
}

function launcherSource({ cli, tokenFile, peerConfigPath, bridgeUrl }) {
  const lines = [
    '#!/usr/bin/env node',
    '// Generated by scripts/deploy-local.mjs. Root launch wrapper: paths only, no token.',
    "import { spawn } from 'node:child_process';",
    "import process from 'node:process';",
    '',
    `const CLI = ${JSON.stringify(cli)};`,
    `const CREDENTIAL_VARS = ${BRIDGE_CREDENTIAL_ENV.toString()};`,
    `const PROVENANCE_VARS = ${ROOT_PROVENANCE_ENV.toString()};`,
    `const TOKEN_FILE = ${JSON.stringify(slash(tokenFile))};`,
    `const AGENT_PEER_CONFIG = ${JSON.stringify(slash(peerConfigPath))};`,
    `const BRIDGE_URL = ${JSON.stringify(bridgeUrl)};`,
    '',
    'const env = {};',
    'for (const [key, value] of Object.entries(process.env)) {',
    '  if (!CREDENTIAL_VARS.test(key) && !PROVENANCE_VARS.test(key)) env[key] = value;',
    '}',
    'env.AGENT_PEER_CONFIG = AGENT_PEER_CONFIG;',
    'env.DSH_BRIDGE_URL = BRIDGE_URL;',
    'env.DSH_BRIDGE_CREDENTIAL_FILE = TOKEN_FILE;',
  ];
  lines.push(
    '',
    "const child = spawn(CLI, process.argv.slice(2), { env, stdio: 'inherit', windowsHide: false });",
    "child.on('error', () => { process.stderr.write('root launcher: failed to start the root CLI\\n'); process.exitCode = 1; });",
    "child.on('exit', (code) => { process.exitCode = typeof code === 'number' ? code : 1; });",
  );
  return `${lines.join('\n')}\n`;
}

async function writeLaunchers(config, layout, dryRun, step, resolveExecutable, preserveExisting = false) {
  const cli = {
    claude: config.claudeExecutable ? await resolveExecutable(config.claudeExecutable) : 'claude',
    codex: config.codexExecutable ? await resolveExecutable(config.codexExecutable) : 'codex',
    ...(layout.launcherFiles.antigravity
      ? { antigravity: config.antigravityExecutable ? await resolveExecutable(config.antigravityExecutable) : 'agy' }
      : {}),
  };
  for (const id of Object.keys(layout.launcherFiles)) {
    if (preserveExisting && await exists(layout.launcherFiles[id])) continue;
    const source = launcherSource({
      // The launcher spawns exactly one root CLI string; pass only this root's selection.
      cli: cli[id],
      tokenFile: layout.tokenFiles[id],
      peerConfigPath: layout.peerFiles[id],
      bridgeUrl: config.bridgeUrl,
    });
    if (!dryRun) {
      await mkdir(path.dirname(layout.launcherFiles[id]), { recursive: true });
      await writeFile(layout.launcherFiles[id], source, 'utf8');
    }
    step(`${dryRun ? 'would create' : 'created'} ${id} root launcher ${layout.launcherFiles[id]}`);
  }
}

/** Resolve whole `*` path segments to the newest existing match (by mtime). */
async function resolveExecutable(pattern) {
  const parts = path.resolve(pattern).split(/[\\/]+/);
  let candidates = [parts[0] + path.sep];
  for (const part of parts.slice(1)) {
    const next = [];
    for (const dir of candidates) {
      if (part !== '*') { next.push(path.join(dir, part)); continue; }
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) next.push(path.join(dir, entry.name));
    }
    candidates = next;
  }
  const found = [];
  for (const file of candidates) {
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) found.push({ file, mtime: info.mtimeMs });
  }
  if (found.length === 0) throw new Error(`no executable matches ${pattern}`);
  return found.sort((a, b) => b.mtime - a.mtime)[0].file;
}

export async function deploy(options = {}) {
  const config = options.config ?? JSON.parse((await readFile(options.configPath, 'utf8')).replace(/^\uFEFF/, ''));
  validateConfig(config);
  const dryRun = options.dryRun === true;
  const prepareOnly = options.prepareOnly === true;
  if (prepareOnly && config.identity === undefined) throw new Error('--prepare-only requires identity deployment configuration');
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const env = options.env ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const step = (message) => stdout(`${dryRun ? '[dry-run] ' : ''}${message}\n`);
  const writeJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const spawnEnv = stripBridgeCredentials(env);
  const attempt = (command, argv) => spawnImpl(command, argv, { encoding: 'utf8', windowsHide: true, env: spawnEnv });
  const run = (command, argv) => {
    const result = attempt(command, argv);
    if (result.status !== 0) throw new Error(`${path.basename(command)} ${argv.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500)}`);
    return String(result.stdout ?? '').trim();
  };

  if (config.identity === undefined && !env.DSH_MCP_TOKEN?.trim()) {
    stderr('warning: DSH_MCP_TOKEN is not set in this environment; set the legacy shared token before starting Claude/Codex\n');
  }

  // Identity preflight reads existing tokens and configs before any write.
  const layout = config.identity === undefined ? null : identityLayout(config);
  const identityInspection = layout === null ? null : await inspectIdentity(layout);
  const peerPlan = layout === null ? null : await inspectPeerConfigs(config, layout);
  const codexMcpPlan = prepareOnly || layout === null || !config.codexPluginDir
    ? null
    : await inspectCodexMcp(config, path.join(config.deployRoot, 'plugin'), layout.peerFiles.codex, config.repo ?? packageRoot);
  const antigravityMcpPlan = prepareOnly || !config.antigravityPluginDir
    ? null
    : await inspectAntigravityMcp(
        config,
        path.join(config.deployRoot, 'plugin'),
        layout?.peerFiles.antigravity ?? (config.peerConfig ?? path.join(config.deployRoot, 'config', 'agent-peer.json')),
        layout?.tokenFiles.antigravity ?? config.credentialFile ?? null,
        config.repo ?? packageRoot,
      );

  // ── 1. stage the plugin copy ────────────────────────────────────────────────
  const label = config.repo ? 'git' : 'package';
  let revision;
  if (config.repo) {
    const git = (argv) => run(config.gitExecutable ?? 'git', ['-C', config.repo, ...argv]);
    if (git(['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error('repository has uncommitted tracked changes; commit before deploying');
    revision = git(['rev-parse', '--short', 'HEAD']);
    step(`exporting ${config.repo} @ ${revision}`);
  } else {
    revision = (await readFile(path.join(packageRoot, '.export-commit'), 'utf8').catch(() => 'unknown')).trim();
    step(`copying package ${packageRoot} (export ${revision})`);
  }

  const preparedPluginDir = prepareOnly ? path.join(config.deployRoot, `plugin.prepared-${randomBytes(6).toString('hex')}`) : null;
  const pluginDir = preparedPluginDir ?? path.join(config.deployRoot, 'plugin');
  const preparedLauncherFiles = prepareOnly
    ? Object.fromEntries(Object.entries(layout.launcherFiles).map(([id, file]) => [id, path.join(pluginDir, 'config', path.basename(file))]))
    : null;
  const stageDir = prepareOnly ? `${pluginDir}.stage` : path.join(config.deployRoot, `plugin.stage-${revision}`);
  const prevDir = path.join(config.deployRoot, 'plugin.prev');
  const manifest = JSON.parse(await readFile(path.join(config.repo ?? packageRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (!dryRun) {
    await mkdir(config.deployRoot, { recursive: true });
    await rm(stageDir, { recursive: true, force: true });
    await mkdir(stageDir, { recursive: true });
    if (config.repo) {
      const tarFile = path.join(config.deployRoot, `export-${revision}.tar`);
      run(config.gitExecutable ?? 'git', ['-C', config.repo, 'archive', '--format=tar', '-o', tarFile, 'HEAD']);
      run('tar', ['-xf', tarFile, '-C', stageDir]);
      await rm(tarFile, { force: true });
      await writeFile(path.join(stageDir, '.export-commit'), `${revision}\n`, 'ascii');
    } else {
      if (path.resolve(packageRoot).toLowerCase() === path.resolve(pluginDir).toLowerCase()) throw new Error('run the script from the extracted package, not from the deployed plugin directory');
      await cp(packageRoot, stageDir, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|\.plans|\.runtime|\.worktrees)([\\/]|$)/.test(path.relative(packageRoot, src) ? `/${path.relative(packageRoot, src)}` : '') });
    }
    const stagedManifest = path.join(stageDir, '.claude-plugin', 'plugin.json');
    const deployed = JSON.parse(await readFile(stagedManifest, 'utf8'));
    const defaults = { node_path: slash(config.nodePath), peer_config: slash(layout?.peerFiles.claude ?? (config.peerConfig ?? path.join(config.deployRoot, 'config', 'agent-peer.json'))), dsh_bridge_url: config.bridgeUrl, bridge_credential_file: slash(layout?.tokenFiles.claude ?? config.credentialFile ?? '') };
    for (const [key, value] of Object.entries(defaults)) {
      if (!deployed.userConfig?.[key]) throw new Error(`plugin.json has no userConfig.${key}`);
      deployed.userConfig[key].default = value;
    }
    await writeJson(stagedManifest, deployed);
    if (!prepareOnly) {
      await rm(prevDir, { recursive: true, force: true });
      if (await exists(pluginDir)) await rename(pluginDir, prevDir);
    }
    await rename(stageDir, pluginDir);
  }
  step(`${prepareOnly ? 'prepared' : 'deployed'} ${manifest.name} ${manifest.version} from ${label} to ${pluginDir}${prepareOnly ? '' : ` (previous copy: ${prevDir})`}; Claude defaults: node_path, peer_config, dsh_bridge_url, bridge_credential_file`);

  // ── 2. controller identity (tokens, peer configs, host fragments, launchers) ─
  if (layout !== null) {
    await applyIdentity(layout, identityInspection, dryRun);
    await writePeerConfigs(config, layout, peerPlan, dryRun, step);
    const overlap = hostFragment(layout, layout.legacyTokenFile !== null);
    const final = hostFragment(layout, false);
    if (!dryRun) {
      await mkdir(path.dirname(layout.hostFiles.overlap), { recursive: true });
      // Validate the generated fragments against the actual auth module before writing.
      loadControllerRegistry(overlap.controllers);
      loadControllerRegistry(final.controllers);
      if (!prepareOnly || !(await exists(layout.hostFiles.overlap))) await writeJson(layout.hostFiles.overlap, overlap);
      if (!prepareOnly || !(await exists(layout.hostFiles.final))) await writeJson(layout.hostFiles.final, final);
    }
    step(`${dryRun ? 'would prepare' : 'prepared'} controller identity fragments ${layout.hostFiles.overlap} and ${layout.hostFiles.final}${prepareOnly ? ' (existing files preserved)' : ''}`);
    await writeLaunchers(config, layout, dryRun, step, resolveExecutable, prepareOnly);
    if (prepareOnly) await writeLaunchers(config, { ...layout, launcherFiles: preparedLauncherFiles }, dryRun, step, resolveExecutable);
  }

  if (prepareOnly) {
    step(`prepared plugin: ${preparedPluginDir}; use switch-controller-clients.mjs --prepared-plugin with this path after the overlap host is ready.`);
    return { dryRun, prepareOnly, preparedPluginDir, preparedLauncherFiles, identity: true, layout };
  }

  // ── 3. machine files, created only when missing ─────────────────────────────
  const claudeMarketplace = path.join(config.deployRoot, '.claude-plugin', 'marketplace.json');
  const claudePluginId = config.claudePluginId ?? 'agent-bridge@agent-bridge-local';
  const [claudePluginName, claudeMarketplaceName] = claudePluginId.split('@');
  if (!(await exists(claudeMarketplace))) {
    if (!dryRun) {
      await mkdir(path.dirname(claudeMarketplace), { recursive: true });
      await writeJson(claudeMarketplace, {
        name: claudeMarketplaceName,
        owner: { name: 'Local developer' },
        plugins: [{ name: claudePluginName, source: './plugin', description: manifest.description }],
      });
    }
    step(`created Claude marketplace ${claudeMarketplace}`);
  }

  const peerConfigPath = layout?.peerConfigPath ?? (config.peerConfig ?? path.join(config.deployRoot, 'config', 'agent-peer.json'));
  if (layout === null && !(await exists(peerConfigPath))) {
    const peers = {};
    if (config.codexExecutable) peers.codex = { executable: slash(config.codexExecutable), delegateSandbox: 'workspace-write', readOnlyDisablePlugins: [config.codexPluginId ?? 'agent-bridge@personal'], threadSection: 'Agent Bridge', threadNamePrefix: '[agent-bridge]' };
    if (config.claudeExecutable) peers['claude-code'] = { executable: slash(config.claudeExecutable), delegatePermissionMode: 'acceptEdits', delegateAllowedTools: ['mcp__plugin_agent-bridge_dsh_project', 'mcp__plugin_agent-bridge_agent_peer', 'Bash'] };
    if (config.antigravityExecutable) {
      peers.antigravity = {
        executable: slash(config.antigravityExecutable),
        delegateMode: 'accept-edits',
        ...(config.antigravityPluginDir
          ? { readOnlyAgent: 'agent-bridge-readonly', readOnlyWebAgent: 'agent-bridge-readonly-web' }
          : {}),
        delegateAllowedPermissions: ['mcp(agent-bridge_dsh_project/*)', 'mcp(agent-bridge_agent_peer/*)'],
      };
    }
    const peerConfig = {
      schemaVersion: 1,
      stateDir: slash(path.join(config.deployRoot, 'state')),
      peers,
      records: {
        enabled: true,
        dirName: '.agent-bridge/records',
        retainDays: 3,
        disputedRetainDays: 30,
        sweepIntervalMinutes: 60,
        claudeProjectsDir: slash(path.join(os.homedir(), '.claude', 'projects')),
        ...(hasAntigravity(config) || config.antigravityDataDir
          ? { antigravityDataDir: slash(config.antigravityDataDir ?? path.join(os.homedir(), '.gemini', 'antigravity-cli')) }
          : {}),
      },
      bridge: { url: config.bridgeUrl, ...(config.credentialFile ? { credentialFile: slash(config.credentialFile) } : {}) },
      limits: { timeoutMs: 1800000, maxConcurrentJobs: 3 },
    };
    if (!dryRun) {
      await mkdir(path.dirname(peerConfigPath), { recursive: true });
      await mkdir(path.join(config.deployRoot, 'state'), { recursive: true });
      await writeJson(peerConfigPath, peerConfig);
    }
    step(`created agent-peer config ${peerConfigPath} (peers: ${Object.keys(peers).join(', ') || 'none'})`);
  }

  // ── 4. Codex ────────────────────────────────────────────────────────────────
  if (config.codexPluginDir) {
    const codexMcp = path.join(config.codexPluginDir, '.mcp.json');
    if (layout !== null) {
      await applyCodexMcp(codexMcpPlan, dryRun, step);
    } else if (!(await exists(codexMcp))) {
      if (!dryRun) {
        await mkdir(config.codexPluginDir, { recursive: true });
        await writeJson(codexMcp, {
          mcpServers: {
            dsh_project: { url: config.bridgeUrl, bearer_token_env_var: 'DSH_MCP_TOKEN', tool_timeout_sec: 75, default_tools_approval_mode: 'approve' },
            agent_peer: {
              command: slash(config.nodePath),
              args: [slash(path.join(pluginDir, 'bin', 'peer-mcp.mjs'))],
              tool_timeout_sec: 75,
              default_tools_approval_mode: 'approve',
              env: { AGENT_BRIDGE_SELF: 'codex', AGENT_PEER_CONFIG: slash(peerConfigPath) },
              env_vars: ['AGENT_BRIDGE_CHAIN', 'AGENT_BRIDGE_MAX_DEPTH', 'AGENT_BRIDGE_MAX_DELEGATE_DEPTH', 'AGENT_BRIDGE_ROOT_TASK'],
            },
          },
        });
      }
      step(`created Codex MCP config ${codexMcp}`);
    }
    if (!dryRun) {
      await rm(path.join(config.codexPluginDir, 'skills'), { recursive: true, force: true });
      await cp(path.join(pluginDir, 'skills'), path.join(config.codexPluginDir, 'skills'), { recursive: true });
      await mkdir(path.join(config.codexPluginDir, '.codex-plugin'), { recursive: true });
      // The package ships its Codex MCP template as .codex-mcp.json (a root .mcp.json is
      // also read by Claude Code); the machine copy uses its own .mcp.json.
      const codexManifest = JSON.parse(await readFile(path.join(pluginDir, '.codex-plugin', 'plugin.json'), 'utf8'));
      codexManifest.mcpServers = './.mcp.json';
      await writeJson(path.join(config.codexPluginDir, '.codex-plugin', 'plugin.json'), codexManifest);
    }
    step(`refreshed Codex plugin skills and manifest in ${config.codexPluginDir} (kept its .mcp.json)`);

    const codexPluginId = config.codexPluginId ?? 'agent-bridge@personal';
    const homePlugins = path.join(os.homedir(), '.agents', 'plugins');
    const codexMarketplace = config.codexMarketplace ?? (path.resolve(config.codexPluginDir).toLowerCase().startsWith(path.join(homePlugins, 'plugins').toLowerCase()) ? path.join(homePlugins, 'marketplace.json') : undefined);
    if (codexMarketplace) {
      const market = (await exists(codexMarketplace)) ? JSON.parse((await readFile(codexMarketplace, 'utf8')).replace(/^\uFEFF/, '')) : { name: codexPluginId.split('@')[1], interface: { displayName: 'Personal' }, plugins: [] };
      const pluginName = codexPluginId.split('@')[0];
      if (!market.plugins.some((entry) => entry.name === pluginName)) {
        // Codex resolves a local marketplace path relative to the user's home directory.
        market.plugins.push({ name: pluginName, source: { source: 'local', path: `./${slash(path.relative(os.homedir(), config.codexPluginDir))}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
        if (!dryRun) { await mkdir(path.dirname(codexMarketplace), { recursive: true }); await writeJson(codexMarketplace, market); }
        step(`added ${pluginName} to Codex marketplace ${codexMarketplace}`);
      }
    }
    if (config.codexExecutable) {
      const codex = await resolveExecutable(config.codexExecutable);
      if (!dryRun) {
        attempt(codex, ['plugin', 'remove', codexPluginId]); // absent on a first install
        run(codex, ['plugin', 'add', codexPluginId]);
      }
      step(`(re)installed ${codexPluginId} in Codex (${codex})`);
    }
  }

  // ── 5. Claude Code ──────────────────────────────────────────────────────────
  if (config.claudeExecutable) {
    const claude = await resolveExecutable(config.claudeExecutable);
    if (!dryRun) {
      if (attempt(claude, ['plugin', 'marketplace', 'update', claudeMarketplaceName]).status !== 0) run(claude, ['plugin', 'marketplace', 'add', config.deployRoot]);
      if (attempt(claude, ['plugin', 'update', claudePluginId]).status !== 0) run(claude, ['plugin', 'install', claudePluginId]);
    }
    step(`refreshed Claude Code: marketplace ${claudeMarketplaceName}, plugin ${claudePluginId} (${claude})`);
  } else {
    step('claudeExecutable not set: Claude Code keeps running its cached copy until `claude plugin update` runs');
  }

  // ── 6. Antigravity ──────────────────────────────────────────────────────────
  if (config.antigravityPluginDir) {
    await applyAntigravityMcp(antigravityMcpPlan, dryRun, step);
    if (!dryRun) {
      await mkdir(config.antigravityPluginDir, { recursive: true });
      const agyManifestPath = path.join(pluginDir, '.antigravity-plugin', 'plugin.json');
      const agyManifest = JSON.parse(await readFile(agyManifestPath, 'utf8'));
      await writeJson(path.join(config.antigravityPluginDir, 'plugin.json'), agyManifest);
      await rm(path.join(config.antigravityPluginDir, 'skills'), { recursive: true, force: true });
      await cp(path.join(pluginDir, 'skills'), path.join(config.antigravityPluginDir, 'skills'), { recursive: true });
      const agyAgentsSource = path.join(pluginDir, '.antigravity-plugin', 'agents');
      await rm(path.join(config.antigravityPluginDir, 'agents'), { recursive: true, force: true });
      if (await exists(agyAgentsSource)) {
        await cp(agyAgentsSource, path.join(config.antigravityPluginDir, 'agents'), { recursive: true });
      }
    }
    step(`refreshed Antigravity plugin manifest, skills and agents in ${config.antigravityPluginDir}`);
    if (config.antigravityExecutable) {
      const agy = await resolveExecutable(config.antigravityExecutable);
      if (!dryRun) {
        run(agy, ['plugin', 'validate', config.antigravityPluginDir]);
      }
      step(`validated Antigravity plugin in ${config.antigravityPluginDir} (${agy})`);
    }
  }
  step(`done (${manifest.version}, ${revision}). Restart the Claude desktop app and start new Codex/Antigravity sessions to load this version.`);
  return { dryRun, identity: layout !== null, layout };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }
  if (options.configPath === null) {
    stderr(`${USAGE}\n`);
    return 2;
  }
  try {
    await deploy({ configPath: options.configPath, dryRun: options.dryRun, prepareOnly: options.prepareOnly, stdout, stderr });
    return 0;
  } catch (error) {
    stderr(`deploy failed: ${error?.message ?? error}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
