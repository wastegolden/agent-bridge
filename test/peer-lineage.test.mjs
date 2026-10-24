import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readChainContext, planPeerCall } from '../src/peer/chain.mjs';
import { applyLineage, clearActive, findLedgerAncestor, readProcessTable, recordActive } from '../src/peer/lineage.mjs';

async function withState(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-lineage-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// pid 300 = agent-peer server in a codex peer; 200 = codex.exe (spawned by a claude
// root's peer job); 150 = an intermediate launcher; 100 = the root's peer server.
const table = (createdAt = 1_000_000) => new Map([
  [300, { ppid: 150, createdAt: createdAt + 2000 }],
  [150, { ppid: 200, createdAt: createdAt + 1000 }],
  [200, { ppid: 100, createdAt }],
  [100, { ppid: 1, createdAt: createdAt - 60_000 }],
]);

test('an env-stripped peer server recovers its chain from the ledger', async () => {
  await withState(async (stateDir) => {
    await recordActive(stateDir, { pid: 200, jobId: 'peer-1', chain: ['claude-code', 'codex'], target: 'codex', startedAt: 1_000_000 });
    const ancestor = await findLedgerAncestor({ stateDir, pid: 300, table: table() });
    assert.deepEqual(ancestor.chain, ['claude-code', 'codex']);
    assert.equal(ancestor.ancestorPid, 200);
    assert.equal(ancestor.hops, 2);
    // Codex dropped AGENT_BRIDGE_CHAIN: without the ledger this server would be a root.
    const stripped = { AGENT_BRIDGE_SELF: 'codex' };
    assert.equal(readChainContext(stripped).isRoot, true);
    const { env, source } = applyLineage(stripped, ancestor);
    assert.equal(source, 'ledger');
    const context = readChainContext(env);
    assert.equal(context.isRoot, false);
    assert.throws(() => planPeerCall(context, { target: 'claude-code', mode: 'review' }), { code: 'PEER_CYCLE' });
  });
});

test('the ledger also restores a filtered root task, and refuses a different one', async () => {
  await withState(async (stateDir) => {
    await recordActive(stateDir, { pid: 200, jobId: 'peer-1', chain: ['claude-code', 'codex'], target: 'codex', startedAt: 1_000_000, rootTask: 'session-abc' });
    const ancestor = await findLedgerAncestor({ stateDir, pid: 300, table: table() });
    assert.equal(ancestor.rootTask, 'session-abc');
    assert.equal(readChainContext(applyLineage({ AGENT_BRIDGE_SELF: 'codex' }, ancestor).env).rootTask, 'session-abc');
    assert.throws(() => applyLineage({ AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_ROOT_TASK: 'other' }, ancestor), { code: 'PEER_CHAIN_INVALID' });
  });
});

test('a disagreeing inherited chain or self is refused', async () => {
  await withState(async (stateDir) => {
    await recordActive(stateDir, { pid: 200, jobId: 'peer-1', chain: ['claude-code', 'codex'], target: 'codex', startedAt: 1_000_000 });
    const ancestor = await findLedgerAncestor({ stateDir, pid: 300, table: table() });
    assert.throws(() => applyLineage({ AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'codex' }, ancestor), { code: 'PEER_CHAIN_INVALID' });
    assert.throws(() => applyLineage({ AGENT_BRIDGE_SELF: 'claude-code' }, ancestor), { code: 'PEER_CHAIN_INVALID' });
    assert.equal(applyLineage({ AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'claude-code>codex' }, ancestor).source, 'environment+ledger');
  });
});

test('no ledger ancestor leaves the environment untouched; reused pids fail safe', async () => {
  await withState(async (stateDir) => {
    assert.equal(await findLedgerAncestor({ stateDir, pid: 300, table: table() }), null);
    assert.equal(applyLineage({ AGENT_BRIDGE_SELF: 'claude-code' }, null).source, 'environment');
    // A stale entry for a pid whose process started long after the recorded spawn is ignored.
    await recordActive(stateDir, { pid: 200, jobId: 'peer-old', chain: ['claude-code', 'codex'], target: 'codex', startedAt: 1_000_000 - 3_600_000 });
    assert.equal(await findLedgerAncestor({ stateDir, pid: 300, table: table() }), null);
    await clearActive(stateDir, 200);
    assert.deepEqual(await readdir(path.join(stateDir, 'active')), []);
  });
});

test('the real process table contains this process and its parent', () => {
  const live = readProcessTable();
  assert.ok(live.has(process.pid));
  assert.equal(live.get(process.pid).ppid, process.ppid);
});

// The Windows query the module sends; copied so an accidental rewrite of the flags,
// the query or the process-table shape is caught by the tests below.
const WINDOWS_QUERY = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress';
const WINDOWS_STDOUT = '[{"ProcessId":10,"ParentProcessId":1,"CreationDate":"/Date(1000)/"}]';

function windowsSpawnStub() {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: WINDOWS_STDOUT };
  };
  return { calls, spawnSyncImpl };
}

test('the Windows read spawns absolute PowerShell with a filled environment', () => {
  const { calls, spawnSyncImpl } = windowsSpawnStub();
  const source = { PATH: 'C:\\x', SystemRoot: 'C:\\Win' };
  const table = readProcessTable({ spawnSyncImpl, platform: 'win32', env: source });

  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, 'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY]);

  assert.equal(options.env.PATH, 'C:\\x');
  assert.equal(options.env.SystemRoot, 'C:\\Win');
  assert.equal(options.env.windir, 'C:\\Win');
  assert.equal(options.env.ComSpec, 'C:\\Win\\System32\\cmd.exe');
  for (const name of ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT']) {
    assert.equal(typeof options.env[name], 'string', `${name} must be filled`);
    assert.notEqual(options.env[name], '', `${name} must not be empty`);
  }
  assert.deepEqual(Object.keys(options.env).sort(), ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'windir', 'ComSpec', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT'].sort());

  // The caller's environment is read, not written through.
  assert.deepEqual(source, { PATH: 'C:\\x', SystemRoot: 'C:\\Win' });

  assert.equal(table.size, 1);
  assert.deepEqual(table.get(10), { ppid: 1, createdAt: 1000 });
});

test('a case-variant system variable counts as present and is not duplicated', () => {
  const { calls, spawnSyncImpl } = windowsSpawnStub();
  readProcessTable({ spawnSyncImpl, platform: 'win32', env: { SYSTEMROOT: 'D:\\W', TEMP: 'T:\\keep' } });

  const { command, options } = calls[0];
  assert.ok(command.startsWith('D:\\W\\'), command);
  assert.equal(command, 'D:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(options.env.SYSTEMROOT, 'D:\\W');
  assert.equal(Object.hasOwn(options.env, 'SystemRoot'), false);
  assert.equal(options.env.TEMP, 'T:\\keep');
  assert.equal(typeof options.env.TMP, 'string');
  assert.notEqual(options.env.TMP, '');
  assert.equal(Object.keys(options.env).filter((key) => key.toLowerCase() === 'systemroot').length, 1);
  assert.equal(Object.keys(options.env).filter((key) => key.toLowerCase() === 'temp').length, 1);
});
