import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { testDir } from './helpers/test-root.mjs';
import { blockingProcesses, createWindowsAdapter, main, parseArgs, planClientSwitch, switchClients } from '../scripts/switch-controller-clients.mjs';
import { identityLayout } from '../scripts/deploy-local.mjs';

const LEGACY = 'legacy-secret-for-client-switch-test';
const PROCESS = 'process-secret-for-client-switch-test';
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const slash = (value) => value.replaceAll('\\', '/');

async function fixture(t) {
  const dir = testDir(t, 'client-switch');
  const config = { deployRoot: path.join(dir, '部署 source'), nodePath: process.execPath, bridgeUrl: 'http://127.0.0.1:3080/mcp/test',
    identity: { credentialDirectory: path.join(dir, '凭据 files'), migrationBackupDirectory: path.join(dir, 'db-backups') },
    codexPluginDir: path.join(dir, 'codex-source') };
  const layout = identityLayout(config);
  const options = { config, claudeHome: path.join(dir, '.claude'), codexHome: path.join(dir, '.codex'), backupRoot: path.join(dir, 'backups') };
  const claudeDir = path.join(options.claudeHome, 'plugins/cache/agent-bridge-local/agent-bridge/2.0.0');
  const codexDir = path.join(options.codexHome, 'plugins/cache/personal/agent-bridge/2.0.0');
  const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : json(value)); };
  const sourceDir = path.join(config.deployRoot, 'plugin');
  const template = JSON.parse(await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const codexTemplate = JSON.parse(await readFile(new URL('../.codex-mcp.json', import.meta.url), 'utf8'));
  const codexManifest = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  await put(path.join(sourceDir, '.claude-plugin/plugin.json'), template);
  await put(path.join(sourceDir, '.codex-mcp.json'), codexTemplate);
  await put(path.join(sourceDir, '.codex-plugin/plugin.json'), codexManifest);
  await put(path.join(sourceDir, 'bin/bridge.mjs'), '// fixture');
  await put(path.join(sourceDir, 'bin/peer-mcp.mjs'), '// fixture');
  await put(path.join(sourceDir, 'src/runtime.mjs'), '// current runtime');
  await put(path.join(sourceDir, 'skills/example/SKILL.md'), 'current skill');
  await put(path.join(sourceDir, 'dsh-host/index.cjs'), '// current host entry');
  await put(path.join(sourceDir, 'package.json'), { name: 'agent-bridge', version: '2.0.0' });
  const oldManifest = structuredClone(template);
  oldManifest.mcpServers.dsh_project = { type: 'http', url: 'http://127.0.0.1:1/old', headers: { Authorization: `Bearer ${LEGACY}` } };
  oldManifest.mcpServers.agent_peer.env = { KEEP_ENV: 'keep', dsh_mcp_token: LEGACY, AGENT_BRIDGE_CHAIN: 'old-root' };
  oldManifest.mcpServers.unrelated = { command: 'keep' };
  oldManifest.userConfig.custom = { type: 'string', default: 'keep' };
  await put(path.join(claudeDir, '.claude-plugin/plugin.json'), oldManifest);
  await put(path.join(options.claudeHome, 'plugins/installed_plugins.json'), { version: 2, plugins: { 'agent-bridge@agent-bridge-local': [{ scope: 'user', installPath: claudeDir, version: template.version }] } });
  const settingsPath = path.join(options.claudeHome, 'settings.json');
  await put(settingsPath, { model: 'keep', enabledPlugins: { 'agent-bridge@agent-bridge-local': true, other: true },
    pluginConfigs: { 'agent-bridge@agent-bridge-local': { outsideOptions: 123, options: { custom: 'keep', peer_config: 'old', dsh_bridge_url: 'old' } }, other: { options: { keep: true } } } });
  await put(path.join(options.codexHome, 'config.toml'), '# preserve bytes\n[plugins."agent-bridge@personal"]\nenabled = true\n[other]\nvalue = "keep"\n');
  for (const target of [codexDir, config.codexPluginDir]) {
    await put(path.join(target, '.codex-plugin/plugin.json'), codexManifest);
    await put(path.join(target, '.codex-mcp.json'), { top: 'keep', mcpServers: {
      dsh_project: { url: 'old', bearer_token_env_var: 'DSH_MCP_TOKEN', tool_timeout_sec: 99, env: { DSH_MCP_TOKEN: LEGACY } },
      agent_peer: { command: 'old', env: { KEEP_ENV: 'keep', dsh_bridge_credential_file: 'old', DSH_BRIDGE_DISABLED: '1' } }, unrelated: { command: 'keep' } } });
  }
  for (const id of ['claude', 'codex']) {
    await put(layout.tokenFiles[id], `${id}-fixture-token-never-changed`);
    await put(layout.peerFiles[id], { schemaVersion: 1, stateDir: path.join(dir, 'state'), peers: { keep: { executable: 'keep' } }, custom: true,
      bridge: { url: 'http://127.0.0.1:1/old', credentialFile: 'old', timeoutMs: 999 } });
  }
  const state = { Machine: { exists: false, value: null }, User: { exists: true, value: LEGACY }, Process: { exists: true, value: PROCESS } };
  const calls = [];
  const logs = [];
  let processes = [];
  const adapter = {
    readEnvironment: async (scope) => structuredClone(state[scope]),
    writeEnvironment: async (scope, value) => { calls.push({ scope, value: structuredClone(value) }); state[scope] = structuredClone(value); },
    listProcesses: async () => processes,
    restrictBackup: async (directory) => { assert.deepEqual(await readdir(directory), [], 'ACL established before any secret backup bytes'); calls.push({ acl: directory }); },
  };
  return { dir, config, layout, options, sourceDir, claudeDir, codexDir, settingsPath, put, state, calls, logs, adapter,
    deps: { adapter, log: (line) => logs.push(line), now: () => new Date('2026-11-04T01:02:03Z') },
    setProcesses: (value) => { processes = value; } };
}

test('switch CLI defaults to dry-run for apply and rollback and rejects conflicting modes', () => {
  assert.equal(parseArgs(['--config', 'deploy.json']).dryRun, true);
  assert.equal(parseArgs(['--rollback', 'backup']).dryRun, true);
  assert.equal(parseArgs(['--rollback', 'backup', '--apply']).dryRun, false);
  assert.throws(() => parseArgs(['--config', 'a', '--apply', '--dry-run']));
  assert.throws(() => parseArgs(['--config', 'a', '--rollback', 'b']));
  assert.throws(() => parseArgs(['--config']));
});

test('dry-run locates installed caches, lists changes, and creates no backup or mutation', async (t) => {
  const f = await fixture(t);
  const before = await planClientSwitch(f.config, f.options);
  const result = await switchClients(f.options, f.deps);
  assert.equal(result.dryRun, true);
  assert.equal(result.locations.claudeDir, f.claudeDir);
  assert.equal(result.locations.codexDir, f.codexDir);
  assert.ok(result.changedFiles.includes(f.settingsPath));
  assert.deepEqual(f.calls, []);
  assert.equal(await stat(f.options.backupRoot).catch(() => null), null);
  assert.deepEqual((await planClientSwitch(f.config, f.options)).originals, before.originals);
  assert.equal(JSON.stringify(f.logs).includes(LEGACY), false);
});

test('switch preserves unrelated settings, writes two root paths/URLs, and keeps delegate forwarding', async (t) => {
  const f = await fixture(t);
  const plan = await planClientSwitch(f.config, f.options);
  const result = await switchClients({ ...f.options, dryRun: false }, f.deps);
  const backup = JSON.parse(await readFile(path.join(result.backupDirectory, 'backup.json'), 'utf8'));
  assert.deepEqual(backup.files, plan.originals);
  assert.deepEqual(backup.environment, { User: { exists: true, value: LEGACY }, Process: { exists: true, value: PROCESS } });
  assert.equal(f.calls[0].acl, result.backupDirectory);
  assert.deepEqual(f.state.User, { exists: false, value: null });
  assert.deepEqual(f.state.Process, { exists: false, value: null });
  const settings = JSON.parse(await readFile(f.settingsPath, 'utf8'));
  assert.equal(settings.model, 'keep');
  assert.equal(settings.pluginConfigs['agent-bridge@agent-bridge-local'].outsideOptions, 123);
  assert.equal(settings.pluginConfigs['agent-bridge@agent-bridge-local'].options.custom, 'keep');
  assert.deepEqual(settings.pluginConfigs.other, { options: { keep: true } });
  assert.equal(settings.pluginConfigs['agent-bridge@agent-bridge-local'].options.bridge_credential_file, slash(f.layout.tokenFiles.claude));
  for (const [id, file] of [['claude', path.join(f.claudeDir, '.claude-plugin/plugin.json')], ['codex', path.join(f.codexDir, '.mcp.json')]]) {
    const value = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(value.mcpServers.unrelated, { command: 'keep' });
    for (const name of ['dsh_project', 'agent_peer']) {
      const entry = value.mcpServers[name];
      assert.equal(entry.env.DSH_BRIDGE_CREDENTIAL_FILE, slash(f.layout.tokenFiles[id]));
      assert.equal(entry.env.DSH_BRIDGE_URL, f.config.bridgeUrl);
      assert.equal(Object.keys(entry.env).some((key) => /^(DSH_MCP_TOKEN|AGENT_BRIDGE_CHAIN|AGENT_BRIDGE_ROOT_TASK)$/i.test(key)), false);
      assert.equal(entry.url, undefined);
      assert.equal(entry.headers, undefined);
      if (id === 'codex') assert.ok(entry.env_vars.includes('DSH_MCP_TOKEN'));
    }
    assert.equal(value.mcpServers.agent_peer.env.KEEP_ENV, 'keep');
  }
  for (const id of ['claude', 'codex']) {
    const peer = JSON.parse(await readFile(f.layout.peerFiles[id], 'utf8'));
    assert.equal(peer.bridge.url, f.config.bridgeUrl);
    assert.equal(peer.bridge.credentialFile, slash(f.layout.tokenFiles[id]));
    assert.equal(peer.bridge.timeoutMs, 999);
    assert.equal(peer.custom, true);
    assert.equal(await readFile(f.layout.tokenFiles[id], 'utf8'), `${id}-fixture-token-never-changed`);
  }
  assert.equal((await readFile(path.join(f.codexDir, '.mcp.json'), 'utf8')).includes(LEGACY), false);
  assert.equal(JSON.stringify({ result, logs: f.logs }).includes(LEGACY), false);
  assert.equal(JSON.stringify({ result, logs: f.logs }).includes(PROCESS), false);
});

test('a directory marketplace source the Claude app loads directly is switched and rolled back with the cache', async (t) => {
  const f = await fixture(t);
  const marketplaceDir = path.join(f.dir, 'claude marketplace');
  const claudeSource = path.join(marketplaceDir, 'agent-bridge');
  const catalogPath = path.join(marketplaceDir, '.claude-plugin/marketplace.json');
  const catalog = { name: 'agent-bridge-local', owner: { name: 'keep' }, plugins: [{ name: 'agent-bridge', source: './agent-bridge', version: '1.7.0' }, { name: 'other', source: './other', version: '9' }] };
  await f.put(catalogPath, catalog);
  const oldSource = JSON.parse(await readFile(path.join(f.claudeDir, '.claude-plugin/plugin.json'), 'utf8'));
  await f.put(path.join(claudeSource, '.claude-plugin/plugin.json'), oldSource);
  await f.put(path.join(claudeSource, 'bin/bridge.mjs'), '// old 1.7.0 runtime');
  const settings = JSON.parse(await readFile(f.settingsPath, 'utf8'));
  settings.extraKnownMarketplaces = { 'agent-bridge-local': { source: { source: 'directory', path: marketplaceDir } } };
  await f.put(f.settingsPath, settings);
  const catalogBefore = await readFile(catalogPath);
  const manifestBefore = await readFile(path.join(claudeSource, '.claude-plugin/plugin.json'));

  const plan = await planClientSwitch(f.config, f.options);
  assert.equal(plan.locations.claudeSourceDir, claudeSource);
  assert.ok(plan.processRoots.includes(claudeSource));
  const result = await switchClients({ ...f.options, dryRun: false }, f.deps);
  assert.ok(f.logs.some((line) => line === `Located Claude marketplace source: ${claudeSource}`));
  const manifest = JSON.parse(await readFile(path.join(claudeSource, '.claude-plugin/plugin.json'), 'utf8'));
  for (const name of ['dsh_project', 'agent_peer']) {
    const entry = manifest.mcpServers[name];
    assert.equal(entry.type, 'stdio');
    assert.equal(entry.headers, undefined);
    assert.equal(entry.url, undefined);
    assert.equal(entry.env.DSH_BRIDGE_CREDENTIAL_FILE, slash(f.layout.tokenFiles.claude));
  }
  assert.equal(JSON.stringify(manifest).includes(LEGACY), false);
  assert.equal(await readFile(path.join(claudeSource, 'bin/bridge.mjs'), 'utf8'), '// fixture');
  assert.equal(await readFile(path.join(claudeSource, 'src/runtime.mjs'), 'utf8'), '// current runtime');
  const switched = JSON.parse(await readFile(catalogPath, 'utf8'));
  assert.equal(switched.plugins[0].version, manifest.version);
  assert.deepEqual(switched.plugins[1], catalog.plugins[1]);
  assert.deepEqual(switched.owner, catalog.owner);

  await switchClients({ rollback: result.backupDirectory, dryRun: false }, f.deps);
  assert.deepEqual(await readFile(catalogPath), catalogBefore);
  assert.deepEqual(await readFile(path.join(claudeSource, '.claude-plugin/plugin.json')), manifestBefore);
  assert.equal(await readFile(path.join(claudeSource, 'bin/bridge.mjs'), 'utf8'), '// old 1.7.0 runtime');
  assert.equal(await stat(path.join(claudeSource, 'src/runtime.mjs')).catch(() => null), null);
});

test('a directory marketplace entry that escapes the marketplace or is ambiguous is refused before any change', async (t) => {
  for (const plugins of [[{ name: 'agent-bridge', source: '../outside' }], [{ name: 'agent-bridge', source: './a' }, { name: 'agent-bridge', source: './b' }], [{ name: 'agent-bridge', source: { source: 'github', repo: 'x/y' } }]]) {
    const f = await fixture(t);
    const marketplaceDir = path.join(f.dir, 'market');
    await f.put(path.join(marketplaceDir, '.claude-plugin/marketplace.json'), { name: 'agent-bridge-local', plugins });
    const settings = JSON.parse(await readFile(f.settingsPath, 'utf8'));
    settings.extraKnownMarketplaces = { 'agent-bridge-local': { source: { source: 'directory', path: marketplaceDir } } };
    await f.put(f.settingsPath, settings);
    await assert.rejects(planClientSwitch(f.config, f.options), /Claude directory marketplace entry/);
  }
});

test('rerun is idempotent, absent variables succeed, and timestamp collisions preserve first backup', async (t) => {
  const f = await fixture(t);
  const first = await switchClients({ ...f.options, dryRun: false }, f.deps);
  const backupFile = path.join(first.backupDirectory, 'backup.json');
  const original = await readFile(backupFile);
  const count = f.calls.length;
  const second = await switchClients({ ...f.options, dryRun: false }, f.deps);
  assert.deepEqual(second.changedFiles, []);
  assert.equal(second.backupDirectory, null);
  assert.equal(f.calls.length, count);
  f.state.User = { exists: true, value: 'new-fixture-secret' };
  const third = await switchClients({ ...f.options, dryRun: false }, f.deps);
  assert.notEqual(third.backupDirectory, first.backupDirectory);
  assert.deepEqual(await readFile(backupFile), original);
  assert.equal((await readdir(f.options.backupRoot)).length, 2);
});

test('rollback restores exact file bytes, deletes newly created files, and restores existence plus empty values', async (t) => {
  const f = await fixture(t);
  f.state.User = { exists: true, value: '' };
  f.state.Process = { exists: false, value: null };
  const original = await planClientSwitch(f.config, f.options);
  const applied = await switchClients({ ...f.options, dryRun: false }, f.deps);
  await switchClients({ rollback: applied.backupDirectory }, f.deps);
  assert.equal(f.state.User.exists, false, 'rollback defaults to no mutation');
  await switchClients({ rollback: applied.backupDirectory, dryRun: false }, f.deps);
  assert.deepEqual(f.state.User, { exists: true, value: '' });
  assert.deepEqual(f.state.Process, { exists: false, value: null });
  for (const record of original.originals) {
    const content = await readFile(record.path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    assert.equal(content?.toString('base64') ?? null, record.content, record.path);
  }
  const calls = f.calls.length;
  await switchClients({ rollback: applied.backupDirectory, dryRun: false }, f.deps);
  assert.equal(f.calls.length, calls, 'repeated rollback does not rewrite environment');
});

for (const stage of ['file', 'User', 'Process']) {
  test(`partial failure at ${stage} rolls back every attempted file/environment mutation without leaking errors`, async (t) => {
    const f = await fixture(t);
    const before = await planClientSwitch(f.config, f.options);
    const initialEnvironment = structuredClone(f.state);
    const writeEnvironment = f.adapter.writeEnvironment;
    let failed = false;
    let writes = 0;
    f.adapter.writeEnvironment = async (scope, value) => {
      await writeEnvironment(scope, value);
      if (!failed && scope === stage) { failed = true; throw new Error(LEGACY); }
    };
    const write = async (file, bytes) => {
      await writeFile(file, bytes);
      if (!failed && stage === 'file' && ++writes === 2) { failed = true; throw new Error(LEGACY); }
    };
    await assert.rejects(switchClients({ ...f.options, dryRun: false }, { ...f.deps, write }), (error) => {
      assert.match(error.message, /all attempted changes were rolled back/);
      assert.ok(error.backupDirectory);
      assert.equal(error.message.includes(LEGACY), false);
      return true;
    });
    assert.deepEqual((await planClientSwitch(f.config, f.options)).originals, before.originals);
    assert.deepEqual(f.state, initialEnvironment);
    assert.equal(JSON.stringify(f.logs).includes(LEGACY), false);
  });
}

test('failed automatic restore retains backup and attempts remaining restorations', async (t) => {
  const f = await fixture(t);
  const originalWrite = f.adapter.writeEnvironment;
  f.adapter.writeEnvironment = async (scope, value) => {
    if (scope === 'Process' && !value.exists) throw new Error(PROCESS);
    if (scope === 'User' && value.exists) throw new Error(LEGACY);
    return originalWrite(scope, value);
  };
  let backupDirectory;
  await assert.rejects(switchClients({ ...f.options, dryRun: false }, f.deps), (error) => {
    assert.match(error.message, /rollback was incomplete/);
    backupDirectory = error.backupDirectory;
    return true;
  });
  assert.ok((await stat(path.join(backupDirectory, 'backup.json'))).isFile());
  f.adapter.writeEnvironment = originalWrite;
  await switchClients({ rollback: backupDirectory, dryRun: false }, f.deps);
  assert.deepEqual(f.state.User, { exists: true, value: LEGACY });
});

test('Machine variable existence including an empty value rejects before any writes', async (t) => {
  const f = await fixture(t);
  for (const value of ['', LEGACY]) {
    f.state.Machine = { exists: true, value };
    await assert.rejects(switchClients({ ...f.options, dryRun: false }, f.deps), /Machine-level/);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(await stat(f.options.backupRoot).catch(() => null), null);
});

test('running apps, orphan MCP processes and descendants refuse apply and dry-run', async (t) => {
  const f = await fixture(t);
  for (const name of ['Claude.exe', 'Codex.exe', 'ChatGPT.exe']) {
    f.setProcesses([{ pid: 11, parentPid: 1, name }]);
    await assert.rejects(switchClients(f.options, f.deps), /fully quit/);
  }
  f.setProcesses([{ pid: 12, parentPid: 1, name: 'node.exe', commandLine: 'node "D:/old-agent/bin/peer-mcp.mjs"' }]);
  await assert.rejects(switchClients({ ...f.options, dryRun: false }, f.deps), /fully quit/);
  assert.deepEqual(blockingProcesses([{ pid: 1, name: 'claude.exe' }, { pid: 2, parentPid: 1, name: 'child.exe' }, { pid: 3, parentPid: 2, name: 'helper.exe' }, { pid: 4, name: 'node.exe', commandLine: 'node unrelated.js' }]), [1, 2, 3]);
  assert.deepEqual(f.calls, []);
});

test('ambiguous Codex caches require an explicit installed path and older installed versions are upgraded under backup', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(path.dirname(f.codexDir), 'old-version'));
  await assert.rejects(planClientSwitch(f.config, f.options), /ambiguous/);
  assert.equal((await planClientSwitch(f.config, { ...f.options, codexCacheDir: f.codexDir })).locations.codexDir, f.codexDir);
  await assert.rejects(planClientSwitch(f.config, { ...f.options, codexCacheDir: f.dir }), /within its plugin cache/);
  const manifestPath = path.join(f.claudeDir, '.claude-plugin/plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '1.7.0';
  await f.put(manifestPath, manifest);
  const options = { ...f.options, codexCacheDir: f.codexDir, dryRun: false };
  const result = await switchClients(options, f.deps);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).version, '2.0.0');
  assert.equal(await readFile(path.join(f.claudeDir, 'src/runtime.mjs'), 'utf8'), '// current runtime');
  await switchClients({ rollback: result.backupDirectory, dryRun: false }, f.deps);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).version, '1.7.0');
  assert.equal(await stat(path.join(f.claudeDir, 'src/runtime.mjs')).catch(() => null), null);
});

test('active Codex config wins over a stale inactive target and unrelated unique settings survive', async (t) => {
  const f = await fixture(t);
  await f.put(path.join(f.codexDir, '.mcp.json'), { top: 'stale', extra: true, mcpServers: { unrelated: { command: 'stale' }, inactiveExtra: { command: 'keep-extra' } } });
  await switchClients({ ...f.options, dryRun: false }, f.deps);
  const result = JSON.parse(await readFile(path.join(f.codexDir, '.mcp.json'), 'utf8'));
  assert.equal(result.top, 'keep');
  assert.equal(result.extra, true);
  assert.deepEqual(result.mcpServers.unrelated, { command: 'keep' });
  assert.deepEqual(result.mcpServers.inactiveExtra, { command: 'keep-extra' });
});

test('the switching process is excluded from residual process detection', () => {
  assert.deepEqual(blockingProcesses([{ pid: 22, name: 'node.exe', commandLine: 'node F:/deploy/plugin/scripts/switch-controller-clients.mjs' }], ['F:/deploy/plugin'], 22), []);
});

test('prepared package supplies runtime without changing the old deployment or preparation source', async (t) => {
  const f = await fixture(t);
  const preparedPlugin = path.join(f.dir, 'plugin.prepared-fixture');
  await cp(f.sourceDir, preparedPlugin, { recursive: true });
  await f.put(path.join(f.sourceDir, 'src/runtime.mjs'), '// old deployment');
  const sourceManifest = await readFile(path.join(preparedPlugin, '.claude-plugin/plugin.json'));
  const result = await switchClients({ ...f.options, preparedPlugin, dryRun: false }, f.deps);
  const mcp = JSON.parse(await readFile(path.join(f.codexDir, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.dsh_project.args[0], slash(path.join(preparedPlugin, 'bin/bridge.mjs')));
  assert.equal(await readFile(path.join(f.claudeDir, 'src/runtime.mjs'), 'utf8'), '// current runtime');
  assert.equal(await readFile(path.join(f.sourceDir, 'src/runtime.mjs'), 'utf8'), '// old deployment');
  assert.deepEqual(await readFile(path.join(preparedPlugin, '.claude-plugin/plugin.json')), sourceManifest);
  await switchClients({ rollback: result.backupDirectory, dryRun: false }, f.deps);
});

test('source files reused as Codex mutation targets remain included in rollback', async (t) => {
  const f = await fixture(t);
  f.config.codexPluginDir = f.sourceDir;
  const files = ['.codex-plugin/plugin.json', '.codex-mcp.json'];
  const before = await Promise.all(files.map((file) => readFile(path.join(f.sourceDir, file))));
  const result = await switchClients({ ...f.options, dryRun: false }, f.deps);
  const backup = JSON.parse(await readFile(path.join(result.backupDirectory, 'backup.json'), 'utf8'));
  for (const file of files) assert.equal(backup.files.find((record) => record.path === path.join(f.sourceDir, file)).restore, true);
  await switchClients({ rollback: result.backupDirectory, dryRun: false }, f.deps);
  for (let i = 0; i < files.length; i += 1) assert.deepEqual(await readFile(path.join(f.sourceDir, files[i])), before[i]);
  assert.equal(await stat(path.join(f.sourceDir, '.mcp.json')).catch(() => null), null);
});

test('a configured Codex source not yet installed is created under backup while the actual cache is still required', async (t) => {
  const f = await fixture(t);
  f.config.codexPluginDir = path.join(f.dir, 'new-codex-source');
  const result = await switchClients({ ...f.options, dryRun: false }, f.deps);
  const manifestPath = path.join(f.config.codexPluginDir, '.codex-plugin/plugin.json');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).mcpServers, './.mcp.json');
  const mcp = JSON.parse(await readFile(path.join(f.config.codexPluginDir, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.dsh_project.env.DSH_BRIDGE_CREDENTIAL_FILE, slash(f.layout.tokenFiles.codex));
  await switchClients({ rollback: result.backupDirectory, dryRun: false }, f.deps);
  assert.equal(await stat(manifestPath).catch(() => null), null);
});

test('explicit rollback attempts environment restoration even when a file restore fails', async (t) => {
  const f = await fixture(t);
  const result = await switchClients({ ...f.options, dryRun: false }, f.deps);
  await assert.rejects(switchClients({ rollback: result.backupDirectory, dryRun: false }, { ...f.deps,
    write: async () => { throw new Error(LEGACY); } }), /rollback was incomplete/);
  assert.deepEqual(f.state.User, { exists: true, value: LEGACY });
  assert.deepEqual(f.state.Process, { exists: true, value: PROCESS });
  await switchClients({ rollback: result.backupDirectory, dryRun: false }, f.deps);
});

test('ACL failure occurs before backup secrets or client mutations and CLI errors are redacted', async (t) => {
  const f = await fixture(t);
  const configPath = path.join(f.dir, 'deploy.json');
  await f.put(configPath, f.config);
  f.adapter.restrictBackup = async () => { throw new Error(LEGACY); };
  const output = [];
  const code = await main(['--config', configPath, '--apply', '--claude-home', f.options.claudeHome, '--codex-home', f.options.codexHome, '--backup-root', f.options.backupRoot],
    { adapter: f.adapter, stdout: (line) => output.push(line), stderr: (line) => output.push(line) });
  assert.equal(code, 1);
  assert.equal(output.join('').includes(LEGACY), false);
  const [backup] = await readdir(f.options.backupRoot);
  assert.deepEqual(await readdir(path.join(f.options.backupRoot, backup)), []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.User.value, LEGACY);
});

test('Windows adapter uses mock process environment and stdin for secret writes; child env contains no bridge secrets', () => {
  const env = { PATH: 'keep', dsh_mcp_token: PROCESS, DSH_BRIDGE_CREDENTIAL_FILE: 'keep-out-of-child', OTHER: 'keep' };
  const calls = [];
  const adapter = createWindowsAdapter({ platform: 'win32', env, spawnImpl: (command, args, options) => {
    calls.push({ command, args, options });
    if (args.at(-1).includes('GetValueNames')) return { status: 0, stdout: json({ exists: true, value: LEGACY }) };
    if (args.at(-1).includes('Get-CimInstance')) return { status: 0, stdout: '[]' };
    return { status: 0, stdout: '' };
  } });
  assert.deepEqual(adapter.readEnvironment('Process'), { exists: true, value: PROCESS });
  assert.deepEqual(adapter.readEnvironment('User'), { exists: true, value: LEGACY });
  adapter.writeEnvironment('User', { exists: true, value: LEGACY });
  adapter.writeEnvironment('User', { exists: true, value: '' });
  adapter.writeEnvironment('User', { exists: false, value: null });
  adapter.writeEnvironment('Process', { exists: false, value: null });
  assert.equal(env.dsh_mcp_token, undefined);
  assert.equal(env.OTHER, 'keep');
  adapter.writeEnvironment('Process', { exists: true, value: PROCESS });
  assert.equal(env.DSH_MCP_TOKEN, PROCESS);
  assert.deepEqual(adapter.listProcesses(), []);
  adapter.restrictBackup('X:/mock/backup');
  for (const call of calls) {
    assert.equal(JSON.stringify(call.args).includes(LEGACY), false);
    assert.equal(JSON.stringify(call.options.env).includes(PROCESS), false);
    assert.equal(call.options.env.DSH_BRIDGE_CREDENTIAL_FILE, undefined);
    assert.equal(call.options.windowsHide, true);
  }
  assert.ok(calls.some((call) => call.options.input.includes(LEGACY)));
  const failing = createWindowsAdapter({ platform: 'win32', env: {}, spawnImpl: () => ({ status: 1, stderr: LEGACY }) });
  assert.throws(() => failing.readEnvironment('Machine'), (error) => !error.message.includes(LEGACY));
});
