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
//   "credentialFile": "E:/.../token.txt",
//   "codexPluginDir": "C:/Users/<you>/.agents/plugins/plugins/agent-bridge",   optional
//   "codexExecutable": "C:/.../codex.exe",                                      optional
//   "codexPluginId": "agent-bridge@personal"                                     optional
// }
//
// Why defaults are patched: a plugin host may not apply stored userConfig values to
// every session (the Claude desktop app started the servers with the literal default
// "node"). Machine paths therefore become the defaults of the DEPLOYED copy only; the
// repository keeps portable defaults.
//
// Steps: git archive HEAD -> stage dir -> patch .claude-plugin/plugin.json defaults ->
// swap stage into <deployRoot>/plugin (previous copy kept as plugin.prev) -> refresh the
// Codex plugin's skills and manifest (its machine-specific .mcp.json is kept) -> codex
// plugin remove/add so the Codex cache matches. Nothing outside these paths is touched.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
for (const key of ['repo', 'deployRoot', 'nodePath', 'peerConfig', 'bridgeUrl', 'credentialFile']) {
  if (typeof config[key] !== 'string' || config[key].trim() === '') throw new Error(`deploy config: ${key} is required`);
}
for (const key of ['repo', 'deployRoot', 'nodePath', 'peerConfig', 'credentialFile', 'codexPluginDir', 'codexExecutable']) {
  if (config[key] !== undefined && !path.isAbsolute(config[key])) throw new Error(`deploy config: ${key} must be absolute`);
}

const exists = async (p) => stat(p).then(() => true, () => false);
const step = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`);
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${argv.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  return result.stdout.trim();
};

const git = (argv) => run('git', ['-C', config.repo, ...argv]);
if (git(['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error('repository has uncommitted tracked changes; commit before deploying');
const head = git(['rev-parse', '--short', 'HEAD']);
step(`exporting ${config.repo} @ ${head}`);

const pluginDir = path.join(config.deployRoot, 'plugin');
const stageDir = path.join(config.deployRoot, `plugin.stage-${head}`);
const prevDir = path.join(config.deployRoot, 'plugin.prev');
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
  const defaults = {
    node_path: config.nodePath.replaceAll('\\', '/'),
    peer_config: config.peerConfig.replaceAll('\\', '/'),
    dsh_bridge_url: config.bridgeUrl,
    dsh_credential_file: config.credentialFile.replaceAll('\\', '/'),
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!manifest.userConfig?.[key]) throw new Error(`plugin.json has no userConfig.${key}`);
    manifest.userConfig[key].default = value;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
step('patched Claude plugin defaults: node_path, peer_config, dsh_bridge_url, dsh_credential_file');

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
    await cp(path.join(pluginDir, '.codex-plugin', 'plugin.json'), path.join(config.codexPluginDir, '.codex-plugin', 'plugin.json'));
  }
  step(`refreshed Codex plugin skills and manifest in ${config.codexPluginDir} (kept its .mcp.json)`);
  if (config.codexExecutable && config.codexPluginId) {
    if (!dryRun) {
      run(config.codexExecutable, ['plugin', 'remove', config.codexPluginId]);
      run(config.codexExecutable, ['plugin', 'add', config.codexPluginId]);
    }
    step(`reinstalled ${config.codexPluginId} in Codex`);
  }
}
step(`done @ ${head}. New Claude Code and Codex sessions load this version.`);
