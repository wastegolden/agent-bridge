#!/usr/bin/env node
// Deploy this plugin to a local machine (Claude Code + Codex): first install or update.
//
//   node scripts/deploy-local.mjs --config <deploy.json> [--dry-run]
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
//   "credentialFile": "D:/.../token.txt",         optional; only written into a NEW peer config
//   "codexPluginDir": "C:/Users/<you>/.agents/plugins/plugins/agent-bridge",   optional
//   "codexExecutable": "C:/.../Codex/bin/*/codex.exe",                           optional
//   "codexPluginId": "agent-bridge@personal",                                    optional
//   "codexMarketplace": "C:/Users/<you>/.agents/plugins/marketplace.json",      optional
//   "claudeExecutable": "C:/.../claude-code/*/*/claude.exe",                     optional
//   "claudePluginId": "agent-bridge@agent-bridge-local"                          optional
// }
// Executable paths may use whole `*` segments; the newest match is used, because both
// desktop apps install their CLI under version/hash directories that change on update.
//
// First install: files that are machine-specific are created only when missing and never
// overwritten — the Claude marketplace (<deployRoot>/.claude-plugin/marketplace.json), the
// agent-peer config, the Codex plugin's .mcp.json (dsh_project over HTTP with
// DSH_MCP_TOKEN, agent_peer with the absolute node path) and the Codex marketplace entry.
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
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1];
const dryRun = args.includes('--dry-run');
if (!configPath || args.indexOf('--config') < 0) {
  console.error('usage: node scripts/deploy-local.mjs --config <deploy.json> [--dry-run]');
  process.exit(2);
}

const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
for (const key of ['deployRoot', 'nodePath', 'bridgeUrl']) {
  if (typeof config[key] !== 'string' || config[key].trim() === '') throw new Error(`deploy config: ${key} is required`);
}
for (const key of ['repo', 'gitExecutable', 'deployRoot', 'nodePath', 'peerConfig', 'credentialFile', 'codexPluginDir', 'codexExecutable', 'codexMarketplace', 'claudeExecutable']) {
  if (config[key] !== undefined && !path.isAbsolute(config[key])) throw new Error(`deploy config: ${key} must be absolute`);
}
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slash = (p) => p.replaceAll('\\', '/');
const peerConfigPath = config.peerConfig ?? path.join(config.deployRoot, 'config', 'agent-peer.json');

const exists = async (p) => stat(p).then(() => true, () => false);
const step = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`);
const attempt = (command, argv) => spawnSync(command, argv, { encoding: 'utf8', windowsHide: true });
const run = (command, argv) => {
  const result = attempt(command, argv);
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${argv.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500)}`);
  return result.stdout.trim();
};
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

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

if (!(await exists(config.nodePath))) throw new Error(`nodePath does not exist: ${config.nodePath}`);
// dsh_project reaches the bridge over MCP HTTP with "Bearer ${DSH_MCP_TOKEN}"; Claude and
// Codex read it from their own environment, so it must be a user environment variable.
if (!process.env.DSH_MCP_TOKEN?.trim()) console.warn('warning: DSH_MCP_TOKEN is not set in this environment; set it as a user environment variable (the bridge token of the DSH host) before starting Claude/Codex');

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

const pluginDir = path.join(config.deployRoot, 'plugin');
const stageDir = path.join(config.deployRoot, `plugin.stage-${revision}`);
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
    await cp(packageRoot, stageDir, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(path.relative(packageRoot, src) ? `/${path.relative(packageRoot, src)}` : '') });
  }
  const stagedManifest = path.join(stageDir, '.claude-plugin', 'plugin.json');
  const deployed = JSON.parse(await readFile(stagedManifest, 'utf8'));
  const defaults = { node_path: slash(config.nodePath), peer_config: slash(peerConfigPath), dsh_bridge_url: config.bridgeUrl };
  for (const [key, value] of Object.entries(defaults)) {
    if (!deployed.userConfig?.[key]) throw new Error(`plugin.json has no userConfig.${key}`);
    deployed.userConfig[key].default = value;
  }
  await writeJson(stagedManifest, deployed);
  await rm(prevDir, { recursive: true, force: true });
  if (await exists(pluginDir)) await rename(pluginDir, prevDir);
  await rename(stageDir, pluginDir);
}
step(`deployed ${manifest.name} ${manifest.version} from ${label} to ${pluginDir} (previous copy: ${prevDir}); Claude defaults: node_path, peer_config, dsh_bridge_url`);

// ── 2. machine files, created only when missing ─────────────────────────────
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

if (!(await exists(peerConfigPath))) {
  const peers = {};
  if (config.codexExecutable) peers.codex = { executable: slash(config.codexExecutable), delegateSandbox: 'workspace-write', readOnlyDisablePlugins: [config.codexPluginId ?? 'agent-bridge@personal'], threadSection: 'Agent Bridge', threadNamePrefix: '[agent-bridge]' };
  if (config.claudeExecutable) peers['claude-code'] = { executable: slash(config.claudeExecutable), delegatePermissionMode: 'acceptEdits', delegateAllowedTools: ['mcp__plugin_agent-bridge_dsh_project', 'mcp__plugin_agent-bridge_agent_peer', 'Bash'] };
  const peerConfig = {
    schemaVersion: 1,
    stateDir: slash(path.join(config.deployRoot, 'state')),
    peers,
    records: { enabled: true, dirName: '.agent-bridge/records', retainDays: 3, disputedRetainDays: 30, sweepIntervalMinutes: 60, claudeProjectsDir: slash(path.join(os.homedir(), '.claude', 'projects')) },
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

// ── 3. Codex ────────────────────────────────────────────────────────────────
if (config.codexPluginDir) {
  const codexMcp = path.join(config.codexPluginDir, '.mcp.json');
  if (!(await exists(codexMcp))) {
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

// ── 4. Claude Code ──────────────────────────────────────────────────────────
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
step(`done (${manifest.version}, ${revision}). Restart the Claude desktop app and start new Codex sessions to load this version.`);
