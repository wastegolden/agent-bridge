#!/usr/bin/env node
// Deploy the committed HEAD of this repository to a local machine (Claude Code + Codex).
//
//   node scripts/deploy-local.mjs --config <deploy.json> [--dry-run]
//
// deploy.json (machine-specific, keep it outside the repository):
// {
//   "repo": "E:/.../agent-bridge",                 git repository to export (HEAD only)
//   "deployRoot": "E:/.../runtime/agent-bridge",   holds plugin/, config/, state/ and the
//                                                  Claude marketplace (.claude-plugin/)
//   "nodePath": "C:/.../node.exe",                 written into the Claude plugin defaults
//   "peerConfig": "E:/.../config/agent-peer.json",
//   "bridgeUrl": "http://127.0.0.1:3080/mcp/codex-bridge-v1",
//   "codexPluginDir": "C:/Users/<you>/.agents/plugins/plugins/agent-bridge",   optional
//   "codexExecutable": "C:/.../codex.exe",                                      optional
//   "codexPluginId": "agent-bridge@personal",                                    optional
//   "claudeExecutable": "C:/.../claude-code/*/*/claude.exe",                     optional
//   "claudePluginId": "agent-bridge@agent-bridge-local"                          optional
// }
// Executable paths may use whole `*` segments; the newest match is used, because both
// desktop apps install their CLI under version/hash directories that change on update.
//
// Why defaults are patched: a plugin host may not apply stored userConfig values to
// every session (the Claude desktop app started the servers with the literal default
// "node"). Machine paths therefore become the defaults of the DEPLOYED copy only; the
// repository keeps portable defaults.
//
// Why the Claude CLI is called: Claude Code runs an installed plugin from its own cache
// (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>), not from deployRoot, so a
// deploy that skips `plugin marketplace update` + `plugin update` leaves the old copy
// running. That is how 1.4.0 kept starting with the literal "node" after 1.5.0 shipped.
//
// Steps: git archive HEAD -> stage dir -> patch .claude-plugin/plugin.json defaults ->
// swap stage into <deployRoot>/plugin (previous copy kept as plugin.prev) -> refresh the
// Codex plugin's skills and manifest (its machine-specific .mcp.json is kept) -> codex
// plugin remove/add -> claude plugin marketplace update + plugin update. Nothing outside
// these paths is touched.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1];
const dryRun = args.includes('--dry-run');
if (!configPath || args.indexOf('--config') < 0) {
  console.error('usage: node scripts/deploy-local.mjs --config <deploy.json> [--dry-run]');
  process.exit(2);
}

const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
for (const key of ['repo', 'deployRoot', 'nodePath', 'peerConfig', 'bridgeUrl']) {
  if (typeof config[key] !== 'string' || config[key].trim() === '') throw new Error(`deploy config: ${key} is required`);
}
for (const key of ['repo', 'deployRoot', 'nodePath', 'peerConfig', 'codexPluginDir', 'codexExecutable', 'claudeExecutable']) {
  if (config[key] !== undefined && !path.isAbsolute(config[key])) throw new Error(`deploy config: ${key} must be absolute`);
}

const exists = async (p) => stat(p).then(() => true, () => false);
const step = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`);
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${argv.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  return result.stdout.trim();
};

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

const git = (argv) => run('git', ['-C', config.repo, ...argv]);
if (git(['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error('repository has uncommitted tracked changes; commit before deploying');
const head = git(['rev-parse', '--short', 'HEAD']);
step(`exporting ${config.repo} @ ${head}`);

// dsh_project reaches the bridge over MCP HTTP with "Bearer ${DSH_MCP_TOKEN}"; Claude
// expands that from its own environment, so the variable must exist for the user.
if (!process.env.DSH_MCP_TOKEN?.trim()) console.warn('warning: DSH_MCP_TOKEN is not set in this environment; Claude Code needs it (user environment) for dsh_project');

const pluginDir = path.join(config.deployRoot, 'plugin');
const stageDir = path.join(config.deployRoot, `plugin.stage-${head}`);
const prevDir = path.join(config.deployRoot, 'plugin.prev');
let version = '?';
if (!dryRun) {
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  const tarFile = path.join(config.deployRoot, `export-${head}.tar`);
  git(['archive', '--format=tar', '-o', tarFile, 'HEAD']);
  run('tar', ['-xf', tarFile, '-C', stageDir]);
  await rm(tarFile, { force: true });
  await writeFile(path.join(stageDir, '.export-commit'), `${head}\n`, 'ascii');

  const manifestPath = path.join(stageDir, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  version = manifest.version;
  const defaults = {
    node_path: config.nodePath.replaceAll('\\', '/'),
    peer_config: config.peerConfig.replaceAll('\\', '/'),
    dsh_bridge_url: config.bridgeUrl,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!manifest.userConfig?.[key]) throw new Error(`plugin.json has no userConfig.${key}`);
    manifest.userConfig[key].default = value;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
step(`patched Claude plugin defaults: node_path, peer_config, dsh_bridge_url (version ${version})`);

if (!dryRun) {
  await rm(prevDir, { recursive: true, force: true });
  if (await exists(pluginDir)) await rename(pluginDir, prevDir);
  await rename(stageDir, pluginDir);
}
step(`deployed ${pluginDir} (previous copy: ${prevDir})`);

if (config.codexPluginDir) {
  if (!(await exists(path.join(config.codexPluginDir, '.mcp.json')))) throw new Error('codexPluginDir has no .mcp.json; set it up once by hand (machine-specific)');
  if (!dryRun) {
    await rm(path.join(config.codexPluginDir, 'skills'), { recursive: true, force: true });
    await cp(path.join(pluginDir, 'skills'), path.join(config.codexPluginDir, 'skills'), { recursive: true });
    await mkdir(path.join(config.codexPluginDir, '.codex-plugin'), { recursive: true });
    // The repository ships its Codex MCP template as .codex-mcp.json (a root .mcp.json is
    // also read by Claude Code); the machine copy keeps its own hand-made .mcp.json.
    const codexManifest = JSON.parse(await readFile(path.join(pluginDir, '.codex-plugin', 'plugin.json'), 'utf8'));
    codexManifest.mcpServers = './.mcp.json';
    await writeFile(path.join(config.codexPluginDir, '.codex-plugin', 'plugin.json'), `${JSON.stringify(codexManifest, null, 2)}\n`, 'utf8');
  }
  step(`refreshed Codex plugin skills and manifest in ${config.codexPluginDir} (kept its .mcp.json)`);
  if (config.codexExecutable && config.codexPluginId) {
    const codex = await resolveExecutable(config.codexExecutable);
    if (!dryRun) {
      run(codex, ['plugin', 'remove', config.codexPluginId]);
      run(codex, ['plugin', 'add', config.codexPluginId]);
    }
    step(`reinstalled ${config.codexPluginId} in Codex (${codex})`);
  }
}

if (config.claudeExecutable) {
  const claude = await resolveExecutable(config.claudeExecutable);
  const pluginId = config.claudePluginId ?? 'agent-bridge@agent-bridge-local';
  const marketplace = pluginId.split('@')[1];
  if (!dryRun) {
    run(claude, ['plugin', 'marketplace', 'update', marketplace]);
    run(claude, ['plugin', 'update', pluginId]);
  }
  step(`refreshed Claude Code cache: marketplace ${marketplace}, plugin ${pluginId} (${claude})`);
} else {
  step('claudeExecutable not set: Claude Code keeps running its cached copy until `claude plugin update` runs');
}
step(`done @ ${head}. Restart the Claude desktop app and start new Codex sessions to load this version.`);
