/**
 * D1 controller-deploy tests.
 *
 * Everything is disposable and is created through test/helpers/test-root.mjs
 * (BRIDGE_TEST_TMP when set, the platform temporary directory otherwise); only fake
 * tokens and fake CLIs are used. The repository's own plugin manifest and Codex MCP
 * template are copied into a package fixture so the generated artifacts are checked
 * against the real A3 schema without touching a machine deployment.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { testDir } from './helpers/test-root.mjs';
import {
  deploy,
  identityLayout,
  samePath,
} from '../scripts/deploy-local.mjs';
import {
  MUTATION_TOOLS,
  isLoopbackUrl,
  main as operatorMain,
} from '../bin/operator.mjs';
import { loadControllerRegistry } from '../src/controller-auth.mjs';
import { normalizePeerConfig } from '../src/peer/config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_TOKEN = (label) => `${label}-`.padEnd(64, 'f').slice(0, 64);
const slash = (value) => value.replaceAll('\\', '/');

async function exists(file) {
  return fsp.stat(file).then(() => true, () => false);
}

async function writeFile(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function makePackage(root) {
  await fsp.mkdir(root, { recursive: true });
  const plugin = await fsp.readFile(path.join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8');
  const codexMcp = await fsp.readFile(path.join(REPO_ROOT, '.codex-mcp.json'), 'utf8');
  const codexPlugin = await fsp.readFile(path.join(REPO_ROOT, '.codex-plugin', 'plugin.json'), 'utf8');
  await writeFile(path.join(root, '.claude-plugin', 'plugin.json'), plugin);
  await writeFile(path.join(root, '.codex-mcp.json'), codexMcp);
  await writeFile(path.join(root, '.codex-plugin', 'plugin.json'), codexPlugin);
  await writeFile(path.join(root, 'bin', 'bridge.mjs'), '// test carrier\n');
  await writeFile(path.join(root, 'bin', 'peer-mcp.mjs'), '// test peer server\n');
  await writeFile(path.join(root, 'skills', 'dsh-project-execution', 'SKILL.md'), '---\nname: dsh-project-execution\n---\n');
  return root;
}

function makeConfig(sandbox, overrides = {}) {
  const base = {
    deployRoot: path.join(sandbox, 'deploy'),
    nodePath: process.execPath,
    bridgeUrl: 'http://127.0.0.1:3080/mcp/codex-bridge-v1',
    codexPluginDir: path.join(sandbox, 'codex-plugin'),
    codexPluginId: 'agent-bridge@test',
    claudePluginId: 'agent-bridge@test',
    identity: {
      credentialDirectory: path.join(sandbox, 'credentials'),
      migrationBackupDirectory: path.join(sandbox, 'backups'),
    },
  };
  return { ...base, ...overrides };
}

function makeSpawn() {
  const calls = [];
  const impl = (command, argv, options) => {
    calls.push({ command, argv, options });
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, impl };
}

async function runDeploy(config, packageRoot, extra = {}) {
  const stdout = [];
  const stderr = [];
  const report = await deploy({
    config,
    packageRoot,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    ...extra,
  });
  return { report, stdout: stdout.join(''), stderr: stderr.join('') };
}

function envKey(env, name) {
  return Object.keys(env ?? {}).find((key) => key.toUpperCase() === name);
}

function envValue(env, name) {
  const key = envKey(env, name);
  return key === undefined ? undefined : env[key];
}

function response(payload, status = 200) {
  return { status, text: async () => JSON.stringify(payload) };
}

function capabilitiesResponse(admin = true) {
  return response({
    jsonrpc: '2.0',
    id: 1,
    result: { structuredContent: { controllerIdentity: { enabled: true, self: 'operator', admin } } },
  });
}

test('identity dry-run creates no token, config, launcher or deployment files', async (t) => {
  const sandbox = testDir(t, 'controller-deploy');
  const packageRoot = await makePackage(path.join(sandbox, 'package'));
  const config = makeConfig(sandbox);
  const { stdout } = await runDeploy(config, packageRoot, { dryRun: true });

  assert.match(stdout, /\[dry-run\]/);
  const layout = identityLayout(config);
  for (const file of [...Object.values(layout.tokenFiles), ...Object.values(layout.peerFiles), ...Object.values(layout.hostFiles), ...Object.values(layout.launcherFiles)]) {
    assert.equal(await exists(file), false, `dry-run wrote ${file}`);
  }
  assert.equal(await exists(config.deployRoot), false, 'dry-run created deployRoot');
  assert.equal(await exists(config.codexPluginDir), false, 'dry-run created the Codex plugin dir');

  await assert.rejects(
    runDeploy({ ...config, credentialFile: path.join(sandbox, 'legacy-shared.token') }, packageRoot, { dryRun: true }),
    /legacy shared credential/,
  );
  await assert.rejects(
    runDeploy({ ...config, identity: { ...config.identity, credentialDirectory: 'relative' } }, packageRoot, { dryRun: true }),
    /absolute local path/,
  );
});

test('a missing legacy token file is refused with the final-cutover instruction', async (t) => {
  const sandbox = testDir(t, 'controller-deploy');
  const packageRoot = await makePackage(path.join(sandbox, 'package'));
  const config = makeConfig(sandbox);
  config.identity.legacyTokenFile = path.join(sandbox, 'missing-legacy.token');

  await assert.rejects(runDeploy(config, packageRoot), (error) => {
    assert.match(error.message, /identity\.legacyTokenFile/);
    assert.match(error.message, /after the final cutover remove the identity\.legacyTokenFile field/);
    assert.match(error.message, /overlap host config/);
    return true;
  });
  assert.equal(await exists(config.deployRoot), false, 'a refused legacy file must not deploy anything');
});

test('missing token files are created, valid bytes are preserved and invalid/duplicate tokens are refused', async (t) => {
  const sandbox = testDir(t, 'controller-deploy');
  const packageRoot = await makePackage(path.join(sandbox, 'package'));
  const config = makeConfig(sandbox);
  await runDeploy(config, packageRoot);
  const layout = identityLayout(config);

  const created = {};
  for (const [id, file] of Object.entries(layout.tokenFiles)) {
    created[id] = (await fsp.readFile(file, 'utf8')).trim();
    assert.match(created[id], /^[0-9a-f]{64}$/, `${id} token must be 32 random bytes as hex`);
  }
  assert.equal(new Set(Object.values(created)).size, 3, 'controller tokens must be distinct');

  const preserved = 'a'.repeat(64);
  await writeFile(layout.tokenFiles.claude, preserved);
  await fsp.rm(layout.tokenFiles.codex);
  await runDeploy(config, packageRoot);
  assert.equal(await fsp.readFile(layout.tokenFiles.claude, 'utf8'), preserved, 'existing valid token bytes must be preserved');
  assert.match((await fsp.readFile(layout.tokenFiles.codex, 'utf8')).trim(), /^[0-9a-f]{64}$/, 'a deleted token is recreated');
  assert.equal((await fsp.readFile(layout.tokenFiles.operator, 'utf8')).trim(), created.operator, 'unrelated existing token is preserved');

  const shortToken = 'too-short';
  await writeFile(layout.tokenFiles.operator, shortToken);
  await assert.rejects(runDeploy(config, packageRoot), /24 to 512 printable ASCII/);
  assert.equal(await fsp.readFile(layout.tokenFiles.operator, 'utf8'), shortToken, 'invalid token must not be overwritten');

  await writeFile(layout.tokenFiles.codex, preserved);
  await assert.rejects(runDeploy(config, packageRoot), /duplicates a controller token|duplicate/i);
  assert.equal(await fsp.readFile(layout.tokenFiles.codex, 'utf8'), preserved);
});

test('peer configs share a preexisting stateDir, use their own credentials and preserve settings', async (t) => {
  const sandbox = testDir(t, 'controller-deploy');
  const packageRoot = await makePackage(path.join(sandbox, 'package'));
  const config = makeConfig(sandbox);
  const sharedState = path.join(sandbox, 'shared-state');
  const legacyTokenFile = path.join(sandbox, 'legacy.token');
  await writeFile(legacyTokenFile, FAKE_TOKEN('legacy'));
  config.identity.legacyTokenFile = legacyTokenFile;
  const sharedPeerConfig = path.join(config.deployRoot, 'config', 'agent-peer.json');
  await writeFile(sharedPeerConfig, `${JSON.stringify({
    schemaVersion: 1,
    stateDir: slash(sharedState),
    peers: {},
    records: { enabled: true, retainDays: 5 },
    limits: { timeoutMs: 60_000, maxConcurrentJobs: 7 },
    bridge: { url: 'http://127.0.0.1:1111/mcp', credentialFile: slash(path.join(sandbox, 'old-shared.token')) },
  }, null, 2)}\n`);

  await runDeploy(config, packageRoot);
  const layout = identityLayout(config);
  const claudePeer = await readJson(layout.peerFiles.claude);
  const codexPeer = await readJson(layout.peerFiles.codex);
  assert.equal(path.resolve(claudePeer.stateDir), path.resolve(sharedState));
  assert.equal(path.resolve(codexPeer.stateDir), path.resolve(sharedState));
  assert.equal(path.resolve(claudePeer.bridge.credentialFile), path.resolve(layout.tokenFiles.claude));
  assert.equal(path.resolve(codexPeer.bridge.credentialFile), path.resolve(layout.tokenFiles.codex));
  assert.equal(claudePeer.bridge.url, config.bridgeUrl);
  assert.equal(claudePeer.limits.maxConcurrentJobs, 7, 'unrelated user peer settings are preserved');
  assert.doesNotThrow(() => normalizePeerConfig(claudePeer));
  assert.doesNotThrow(() => normalizePeerConfig(codexPeer));

  const overlap = await readJson(layout.hostFiles.overlap);
  const final = await readJson(layout.hostFiles.final);
  assert.deepEqual(overlap.controllers.map((entry) => entry.id), ['claude-code', 'codex', 'operator', 'legacy']);
  assert.equal(overlap.controllers.find((entry) => entry.id === 'legacy').admin, true);
  assert.deepEqual(final.controllers.map((entry) => entry.id), ['claude-code', 'codex', 'operator']);
  assert.equal(path.resolve(overlap.identityMigrationBackupDirectory), path.resolve(config.identity.migrationBackupDirectory));
  assert.equal(await exists(config.identity.migrationBackupDirectory), true);
  loadControllerRegistry(overlap.controllers);
  loadControllerRegistry(final.controllers);

  const legacy = { ...config, identity: { ...config.identity, legacyTokenFile: undefined } };
  await runDeploy(legacy, packageRoot);
  const overlapWithoutLegacy = await readJson(layout.hostFiles.overlap);
  assert.deepEqual(overlapWithoutLegacy.controllers.map((entry) => entry.id), ['claude-code', 'codex', 'operator']);

  const stale = await readJson(layout.peerFiles.claude);
  stale.bridge.credentialFile = slash(layout.tokenFiles.codex);
  await writeFile(layout.peerFiles.claude, `${JSON.stringify(stale, null, 2)}\n`);
  await assert.rejects(runDeploy(config, packageRoot), /does not use its own credential file/);
});

test('peer config paths are normalized before comparison and a conflicting stateDir is refused', async (t) => {
  const sandbox = testDir(t, 'controller-deploy');
  const packageRoot = await makePackage(path.join(sandbox, 'package'));
  const config = makeConfig(sandbox);
  const layout = identityLayout(config);
  const stateDir = path.join(config.deployRoot, 'state');
  const normalizedState = `${slash(path.dirname(stateDir))}/scratch/../${path.basename(stateDir)}`;
  const normalizedCredential = `${slash(path.dirname(layout.tokenFiles.claude))}/./${path.basename(layout.tokenFiles.claude)}`;

  await writeFile(layout.peerConfigPath, `${JSON.stringify({ schemaVersion: 1, stateDir: normalizedState, peers: {} }, null, 2)}\n`);
  await writeFile(layout.peerFiles.claude, `${JSON.stringify({
    schemaVersion: 1,
    stateDir: `${slash(path.dirname(stateDir))}/./${path.basename(stateDir)}`,
    bridge: { credentialFile: normalizedCredential },
  }, null, 2)}\n`);

  await runDeploy(config, packageRoot);
  const claudePeer = await readJson(layout.peerFiles.claude);
  assert.equal(path.resolve(claudePeer.stateDir), path.resolve(stateDir), 'a normalized stateDir is accepted');
  assert.equal(path.resolve(claudePeer.bridge.credentialFile), path.resolve(layout.tokenFiles.claude), 'a normalized credential path is accepted');

  claudePeer.stateDir = slash(path.join(sandbox, 'other-state'));
  await writeFile(layout.peerFiles.claude, `${JSON.stringify(claudePeer, null, 2)}\n`);
  await assert.rejects(runDeploy(config, packageRoot), /does not use the shared stateDir/);
});

test('stateDir and credential path comparisons are case-insensitive only on Windows', async (t) => {
  const left = path.join(process.cwd(), 'ControllerDeployCase', 'Shared');
  const right = path.join(process.cwd(), 'controllerdeploycase', 'shared');
  assert.equal(samePath(left, right, 'win32'), true, 'Windows path comparisons ignore case');
  assert.equal(samePath(left, right, 'linux'), false, 'other platforms keep case-sensitive path comparisons');
  assert.equal(samePath(`${path.dirname(left)}/./${path.basename(left)}`, left, 'linux'), true, 'paths are normalized before comparison');

  const stateSandbox = testDir(t, 'controller-deploy');
  const stateConfig = makeConfig(stateSandbox);
  const statePackage = await makePackage(path.join(stateSandbox, 'package'));
  const stateLayout = identityLayout(stateConfig);
  const stateDir = path.join(stateConfig.deployRoot, 'state');
  const caseState = slash(path.join(path.dirname(stateDir), path.basename(stateDir).toUpperCase()));
  await writeFile(stateLayout.peerConfigPath, `${JSON.stringify({ schemaVersion: 1, stateDir: slash(stateDir), peers: {} }, null, 2)}\n`);
  await writeFile(stateLayout.peerFiles.claude, `${JSON.stringify({
    schemaVersion: 1,
    stateDir: caseState,
    bridge: { credentialFile: slash(stateLayout.tokenFiles.claude) },
  }, null, 2)}\n`);
  if (process.platform === 'win32') {
    await runDeploy(stateConfig, statePackage);
    assert.equal((await readJson(stateLayout.peerFiles.claude)).stateDir, caseState, 'Windows accepts a stateDir that differs only in case');
  } else {
    await assert.rejects(runDeploy(stateConfig, statePackage), /does not use the shared stateDir/, 'other platforms keep case-sensitive stateDir comparisons');
  }

  const credentialSandbox = testDir(t, 'controller-deploy');
  const credentialConfig = makeConfig(credentialSandbox);
  const credentialPackage = await makePackage(path.join(credentialSandbox, 'package'));
  const credentialLayout = identityLayout(credentialConfig);
  const credentialState = path.join(credentialConfig.deployRoot, 'state');
  const caseCredential = slash(path.join(path.dirname(credentialLayout.tokenFiles.claude), path.basename(credentialLayout.tokenFiles.claude).toUpperCase()));
  await writeFile(credentialLayout.peerConfigPath, `${JSON.stringify({ schemaVersion: 1, stateDir: slash(credentialState), peers: {} }, null, 2)}\n`);
  await writeFile(credentialLayout.peerFiles.claude, `${JSON.stringify({
    schemaVersion: 1,
    stateDir: slash(credentialState),
    bridge: { credentialFile: caseCredential },
  }, null, 2)}\n`);
  if (process.platform === 'win32') {
    await runDeploy(credentialConfig, credentialPackage);
    assert.equal((await readJson(credentialLayout.peerFiles.claude)).bridge.credentialFile, caseCredential, 'Windows accepts a credential path that differs only in case');
  } else {
    await assert.rejects(runDeploy(credentialConfig, credentialPackage), /does not use its own credential file/, 'other platforms keep case-sensitive credential comparisons');
  }
});

test('Codex MCP config migrates to A3 stdio carriers and generated launchers provide the real root env', async (t) => {
  const sandbox = testDir(t, 'controller-deploy');
  const packageRoot = await makePackage(path.join(sandbox, 'package'));
  const config = makeConfig(sandbox, { claudeExecutable: process.execPath, codexExecutable: process.execPath });
  const spawn = makeSpawn();
  const oldMcp = path.join(config.codexPluginDir, '.mcp.json');
  await writeFile(oldMcp, `${JSON.stringify({
    mcpServers: {
      dsh_project: { url: 'http://127.0.0.1:9999/mcp', bearer_token_env_var: 'DSH_MCP_TOKEN' },
      agent_peer: { command: 'node', args: ['./bin/peer-mcp.mjs'] },
      unrelated: { command: 'keep-me' },
    },
  }, null, 2)}\n`);

  const env = { ...process.env, KEEP_ME: 'yes', DSH_MCP_TOKEN: 'shared-decoy', dsh_mcp_token: 'shared-decoy', Dsh_Bridge_Credential_File: 'shared-file', DSH_BRIDGE_DELEGATED: '1', DSH_BRIDGE_DISABLED: '1' };
  const deployRun = await runDeploy(config, packageRoot, { spawnImpl: spawn.impl, env });
  assert.ok(spawn.calls.length > 0, 'deploy should exercise the external CLI calls');
  for (const call of spawn.calls) {
    assert.equal(envValue(call.options.env, 'DSH_MCP_TOKEN'), undefined);
    assert.equal(envValue(call.options.env, 'DSH_BRIDGE_CREDENTIAL_FILE'), undefined);
    assert.equal(envValue(call.options.env, 'DSH_BRIDGE_DELEGATED'), undefined);
    assert.equal(envValue(call.options.env, 'DSH_BRIDGE_DISABLED'), undefined);
    assert.equal(envValue(call.options.env, 'KEEP_ME'), 'yes');
  }

  const template = await readJson(path.join(packageRoot, '.codex-mcp.json'));
  const mcp = await readJson(oldMcp);
  assert.equal(mcp.mcpServers.unrelated.command, 'keep-me');
  for (const name of ['dsh_project', 'agent_peer']) {
    assert.deepEqual(mcp.mcpServers[name].env_vars, template.mcpServers[name].env_vars);
    assert.equal(mcp.mcpServers[name].command, slash(process.execPath));
    assert.equal(envKey(mcp.mcpServers[name].env, 'DSH_MCP_TOKEN'), undefined);
    assert.equal(envKey(mcp.mcpServers[name].env, 'DSH_BRIDGE_CREDENTIAL_FILE'), undefined);
  }
  assert.match(mcp.mcpServers.dsh_project.args[0], /plugin[\\/]bin[\\/]bridge\.mjs$/);
  assert.match(mcp.mcpServers.agent_peer.args[0], /plugin[\\/]bin[\\/]peer-mcp\.mjs$/);
  assert.equal(path.resolve(mcp.mcpServers.agent_peer.env.AGENT_PEER_CONFIG), path.resolve(identityLayout(config).peerFiles.codex));

  const deployedPlugin = await readJson(path.join(config.deployRoot, 'plugin', '.claude-plugin', 'plugin.json'));
  assert.equal(path.resolve(deployedPlugin.userConfig.peer_config.default), path.resolve(identityLayout(config).peerFiles.claude));
  assert.equal(deployedPlugin.mcpServers.dsh_project.headers.Authorization, 'Bearer ${DSH_MCP_TOKEN}');

  const layout = identityLayout(config);
  const claudeToken = (await fsp.readFile(layout.tokenFiles.claude, 'utf8')).trim();
  const codexToken = (await fsp.readFile(layout.tokenFiles.codex, 'utf8')).trim();
  for (const text of [deployRun.stdout, deployRun.stderr]) {
    assert.equal(text.includes(claudeToken), false, 'deploy output must not contain the Claude token');
    assert.equal(text.includes(codexToken), false, 'deploy output must not contain the Codex token');
  }
  for (const [id, file] of Object.entries(layout.launcherFiles)) {
    const source = await fsp.readFile(file, 'utf8');
    assert.equal(source.includes(claudeToken), false, `${id} launcher must not contain the Claude token`);
    assert.equal(source.includes(codexToken), false, `${id} launcher must not contain the Codex token`);
    assert.equal(source.includes('DSH_MCP_TOKEN = token') || source.includes('DSH_BRIDGE_CREDENTIAL_FILE = TOKEN_FILE'), true);
    // The regression passed the whole {claude,codex} map as CLI, so the generated
    // wrapper must embed one string (the selected root CLI), never an object.
    const cliLine = source.split('\n').find((line) => line.startsWith('const CLI = '));
    assert.equal(typeof cliLine, 'string', `${id} launcher must declare its CLI constant`);
    const selectedCli = JSON.parse(cliLine.slice('const CLI = '.length, -1));
    assert.equal(typeof selectedCli, 'string', `${id} launcher must spawn one CLI string, not an object`);
    assert.equal(path.resolve(selectedCli), path.resolve(process.execPath), `${id} launcher must embed the selected root CLI`);
  }

  const capture = path.join(sandbox, 'capture.mjs');
  await writeFile(capture, [
    "import { writeFileSync } from 'node:fs';",
    'writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), env: process.env }));',
    '',
  ].join('\n'));
  const decoyEnv = { ...process.env, KEEP_ME: 'yes', DSH_MCP_TOKEN: 'decoy', dsh_mcp_token: 'decoy', DSH_BRIDGE_CREDENTIAL_FILE: 'decoy-file', DSH_BRIDGE_DELEGATED: '1', DSH_BRIDGE_DISABLED: '1', AGENT_BRIDGE_CHAIN: 'claude-code>codex', AGENT_BRIDGE_ROOT_TASK: 'root' };
  for (const [id, expectedPeer] of [['claude', layout.peerFiles.claude], ['codex', layout.peerFiles.codex]]) {
    const out = path.join(sandbox, `${id}-launch.json`);
    const result = spawnSync(process.execPath, [layout.launcherFiles[id], capture, out, 'hello'], { encoding: 'utf8', env: decoyEnv });
    assert.equal(result.status, 0, result.stderr);
    const captured = await readJson(out);
    assert.deepEqual(captured.argv, ['hello'], `${id} launcher must forward argv`);
    assert.equal(envValue(captured.env, 'KEEP_ME'), 'yes');
    assert.equal(envValue(captured.env, 'DSH_BRIDGE_DELEGATED'), undefined);
    assert.equal(envValue(captured.env, 'DSH_BRIDGE_DISABLED'), undefined);
    assert.equal(envValue(captured.env, 'AGENT_BRIDGE_CHAIN'), undefined);
    assert.equal(envValue(captured.env, 'AGENT_BRIDGE_ROOT_TASK'), undefined);
    assert.equal(path.resolve(envValue(captured.env, 'AGENT_PEER_CONFIG')), path.resolve(expectedPeer));
    assert.equal(envValue(captured.env, 'DSH_BRIDGE_URL'), config.bridgeUrl);
    if (id === 'claude') {
      assert.equal(envValue(captured.env, 'DSH_MCP_TOKEN'), claudeToken);
      assert.equal(envValue(captured.env, 'DSH_BRIDGE_CREDENTIAL_FILE'), undefined);
    } else {
      assert.equal(envValue(captured.env, 'DSH_MCP_TOKEN'), undefined);
      assert.equal(path.resolve(envValue(captured.env, 'DSH_BRIDGE_CREDENTIAL_FILE')), path.resolve(layout.tokenFiles.codex));
    }
  }
});

test('operator CLI enforces loopback, admin identity, mutation/reason and redacts the token', async (t) => {
  const sandbox = testDir(t, 'controller-deploy');
  const token = FAKE_TOKEN('operator');
  const tokenFile = path.join(sandbox, 'operator.token');
  const argsFile = path.join(sandbox, 'args.json');
  await writeFile(tokenFile, token);
  await writeFile(argsFile, `${JSON.stringify({ taskId: 'task-1', override: { reason: '  inspect  ' } })}\n`);

  const calls = [];
  let toolResponse = { ok: true, echo: token };
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    const request = JSON.parse(options.body);
    if (request.params.name === 'bridge_capabilities') return capabilitiesResponse(true);
    return response({ jsonrpc: '2.0', id: 1, result: { structuredContent: toolResponse } });
  };
  const baseArgv = ['--url', 'http://127.0.0.1:4321/mcp', '--credential-file', tokenFile, '--tool', 'bridge_cancel', '--args-file', argsFile];

  const prior = process.env.DSH_MCP_TOKEN;
  process.env.DSH_MCP_TOKEN = 'decoy-environment-token';
  try {
    let out = '';
    let err = '';
    const code = await operatorMain(baseArgv, { fetchImpl: fakeFetch, stdout: (text) => { out += text; }, stderr: (text) => { err += text; } });
    assert.equal(code, 0, err);
    assert.equal(calls.length, 2, 'exactly capabilities then the requested mutation');
    for (const call of calls) {
      assert.equal(call.options.headers.Authorization, `Bearer ${token}`, 'the dedicated file token must be used');
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.url, 'http://127.0.0.1:4321/mcp');
    }
    assert.equal(JSON.parse(calls[1].options.body).params.name, 'bridge_cancel');
    assert.equal(JSON.parse(calls[1].options.body).params.arguments.override.reason, 'inspect');
    assert.equal(out.includes(token), false, 'stdout must never contain the token');
    assert.equal(out.includes('[redacted]'), true, 'server-echoed token must be redacted');
    assert.equal(err, '');
  } finally {
    if (prior === undefined) delete process.env.DSH_MCP_TOKEN;
    else process.env.DSH_MCP_TOKEN = prior;
  }

  // Non-loopback and URL userinfo are refused before any network call.
  const noFetch = async () => { throw new Error('network must not be called'); };
  for (const url of ['http://example.com/mcp', 'http://user:pass@127.0.0.1:4321/mcp', 'ftp://127.0.0.1/mcp']) {
    let err = '';
    const code = await operatorMain(['--url', url, '--credential-file', tokenFile, '--tool', 'bridge_cancel', '--args-file', argsFile], { fetchImpl: noFetch, stdout: () => {}, stderr: (text) => { err += text; } });
    assert.equal(code, 2);
    assert.match(err, /E_URL/);
  }
  assert.equal(isLoopbackUrl('http://localhost:1/mcp'), true);
  assert.equal(isLoopbackUrl('https://[::1]:1/mcp'), true);

  // Read-only/unknown tools and missing or overlong reasons fail before the bridge.
  for (const [tool, args] of [['bridge_check', { taskId: 't', override: { reason: 'x' } }], ['bridge_cancel', { taskId: 't' }], ['bridge_cancel', { taskId: 't', override: { reason: '   ' } }], ['bridge_cancel', { taskId: 't', override: { reason: 'x'.repeat(501) } }]]) {
    const file = path.join(sandbox, `bad-${tool}-${Math.random().toString(16).slice(2)}.json`);
    await writeFile(file, JSON.stringify(args));
    let err = '';
    let called = false;
    const code = await operatorMain(['--url', 'http://127.0.0.1:1/mcp', '--credential-file', tokenFile, '--tool', tool, '--args-file', file], { fetchImpl: async () => { called = true; }, stdout: () => {}, stderr: (text) => { err += text; } });
    assert.equal(code, 2, `${tool} should be refused`);
    assert.equal(called, false, `${tool} must not reach the bridge`);
    assert.match(err, /E_ARGS/);
  }

  // A non-admin capabilities identity is refused after the first call.
  let adminErr = '';
  let adminCalls = 0;
  const code = await operatorMain(baseArgv, { fetchImpl: async () => { adminCalls += 1; return capabilitiesResponse(false); }, stdout: () => {}, stderr: (text) => { adminErr += text; } });
  assert.equal(code, 1);
  assert.equal(adminCalls, 1);
  assert.match(adminErr, /E_IDENTITY/);

  // A server error that echoes the token is redacted.
  let echoErr = '';
  const echoFetch = async () => response({
    jsonrpc: '2.0',
    id: 1,
    result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'TASK_NOT_OWNED', message: `bad ${token}` }) }] },
  });
  const echoCode = await operatorMain(baseArgv, { fetchImpl: echoFetch, stdout: () => {}, stderr: (text) => { echoErr += text; } });
  assert.equal(echoCode, 1);
  assert.equal(echoErr.includes(token), false, 'stderr must never contain the token');
  assert.match(echoErr, /\[redacted\]/);

  // Redirect/HTTP failures are bridge errors; redirect:error was asserted above.
  const redirectCode = await operatorMain(baseArgv, { fetchImpl: async () => response({}, 302), stdout: () => {}, stderr: () => {} });
  assert.equal(redirectCode, 1);

  // A bad credential file is a local failure, not a bridge call.
  let credentialCalls = 0;
  const credentialCode = await operatorMain(['--url', 'http://127.0.0.1:1/mcp', '--credential-file', path.join(sandbox, 'missing.token'), '--tool', MUTATION_TOOLS[0], '--args-file', argsFile], { fetchImpl: async () => { credentialCalls += 1; }, stdout: () => {}, stderr: () => {} });
  assert.equal(credentialCode, 2);
  assert.equal(credentialCalls, 0);
  assert.ok(MUTATION_TOOLS.length >= 13);
});

test('operator redacts nested quoted and backslash tokens before serializing success and error output', async (t) => {
  const sandbox = testDir(t, 'controller-deploy');
  const token = `${'q'.repeat(20)}"\\${'z'.repeat(8)}`;
  assert.match(token, /^[\x21-\x7e]{24,512}$/);
  const tokenFile = path.join(sandbox, 'operator.token');
  const argsFile = path.join(sandbox, 'args.json');
  await writeFile(tokenFile, token);
  await writeFile(argsFile, `${JSON.stringify({ taskId: 'task-1', override: { reason: 'nested' } })}\n`);
  const escaped = JSON.stringify(token).slice(1, -1);
  const argv = ['--url', 'http://127.0.0.1:4321/mcp', '--credential-file', tokenFile, '--tool', 'bridge_cancel', '--args-file', argsFile];

  let calls = 0;
  const successFetch = async () => {
    calls += 1;
    if (calls === 1) return capabilitiesResponse(true);
    return response({
      jsonrpc: '2.0',
      id: 1,
      result: {
        structuredContent: {
          accepted: true,
          echo: token,
          nested: { list: [`before ${token} after`, { deep: token, count: 2 }], empty: [] },
          [`key-${token}`]: token,
        },
      },
    });
  };
  let out = '';
  let err = '';
  const code = await operatorMain(argv, { fetchImpl: successFetch, stdout: (text) => { out += text; }, stderr: (text) => { err += text; } });
  assert.equal(code, 0, err);
  assert.equal(calls, 2, 'exactly capabilities then the requested mutation');
  assert.equal(out.includes(token), false, 'stdout must not contain the raw token');
  assert.equal(out.includes(escaped), false, 'stdout must not contain the JSON-escaped token');
  assert.deepEqual(JSON.parse(out), {
    accepted: true,
    echo: '[redacted]',
    nested: { list: ['before [redacted] after', { deep: '[redacted]', count: 2 }], empty: [] },
    'key-[redacted]': '[redacted]',
  });

  let errorCalls = 0;
  const errorFetch = async () => {
    errorCalls += 1;
    if (errorCalls === 1) return capabilitiesResponse(true);
    return response({
      jsonrpc: '2.0',
      id: 1,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'TASK_NOT_OWNED', message: `refused ${token}` }) }] },
    });
  };
  let errorText = '';
  const errorCode = await operatorMain(argv, { fetchImpl: errorFetch, stdout: () => {}, stderr: (text) => { errorText += text; } });
  assert.equal(errorCode, 1);
  assert.equal(errorCalls, 2);
  assert.equal(errorText.includes(token), false, 'stderr must not contain the raw token');
  assert.equal(errorText.includes(escaped), false, 'stderr must not contain the JSON-escaped token');
  assert.match(errorText, /\[redacted\]/);
});
