import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-Command']);
  assert.equal(args.at(-1), [
    "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'", "$PSModuleAutoLoadingPreference = 'None'",
    "Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
    "Import-Module ($PSHOME + '\\Modules\\CimCmdlets\\CimCmdlets.psd1')", WINDOWS_QUERY,
  ].join('; '));

  assert.equal(options.env.PATH, 'C:\\x');
  assert.equal(options.env.SystemRoot, 'C:\\Win');
  assert.equal(options.env.windir, 'C:\\Win');
  assert.equal(options.env.ComSpec, 'C:\\Win\\System32\\cmd.exe');
  for (const name of ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT']) {
    assert.equal(typeof options.env[name], 'string', `${name} must be filled`);
    assert.notEqual(options.env[name], '', `${name} must not be empty`);
  }
  assert.deepEqual(Object.keys(options.env).sort(), ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'windir', 'ComSpec', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT',
    'ProgramFiles', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramW6432', 'ProgramData', 'ALLUSERSPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PSModulePath',
    ...(Object.hasOwn(options.env, 'USERNAME') ? ['USERNAME'] : [])].sort());
  assert.equal(options.env.PSModulePath, 'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 20_000);

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

test('Windows defaults follow supplied profile and system paths and preserve caller values', () => {
  const { calls, spawnSyncImpl } = windowsSpawnStub();
  const source = { systemroot: 'D:\\Windows', userprofile: 'E:\\People\\runner', programfiles: 'P:\\Programs',
    programdata: 'Q:\\Shared', psMODULEpath: '', temp: '', username: 'operator', processor_architecture: 'custom' };
  const before = { ...source };
  readProcessTable({ spawnSyncImpl, platform: 'win32', env: source });
  const { env } = calls[0].options;
  for (const [name, value] of Object.entries(source)) {
    assert.equal(env[name], value);
    assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === name.toLowerCase()).length, 1);
  }
  assert.equal(env.LOCALAPPDATA, 'E:\\People\\runner\\AppData\\Local');
  assert.equal(env.APPDATA, 'E:\\People\\runner\\AppData\\Roaming');
  assert.equal(env.HOMEDRIVE, 'E:');
  assert.equal(env.HOMEPATH, '\\People\\runner');
  assert.equal(env.ProgramW6432, 'P:\\Programs');
  assert.equal(env.CommonProgramFiles, 'P:\\Programs\\Common Files');
  assert.equal(env.ALLUSERSPROFILE, 'Q:\\Shared');
  assert.deepEqual(source, before);
});

test('Windows process read fails closed on timeout, launch failure and unusable output', () => {
  for (const result of [
    { status: null, error: { code: 'ETIMEDOUT' }, stdout: WINDOWS_STDOUT },
    { status: null, error: { code: 'ENOENT' } },
    { status: 1, stdout: WINDOWS_STDOUT },
    { status: 0, error: { code: 'ENOBUFS' }, stdout: WINDOWS_STDOUT },
    { status: 0, stdout: '' },
    { status: 0, stdout: '[]' },
    { status: 0, stdout: 'null' },
    { status: 0, stdout: '[{"ProcessId":10}]' },
  ]) {
    assert.throws(() => readProcessTable({ platform: 'win32', env: {}, spawnSyncImpl: () => result }), { code: 'PEER_LINEAGE_UNAVAILABLE' });
  }
});

test('Windows process rows can lack a creation date', () => {
  const table = readProcessTable({ platform: 'win32', env: {}, spawnSyncImpl: () => ({
    status: 0, stdout: '{"ProcessId":0,"ParentProcessId":0,"CreationDate":null}',
  }) });
  assert.deepEqual(table.get(0), { ppid: 0, createdAt: null });
});

test('the Windows helper loads inbox modules with a filtered environment and custom module path', { skip: process.platform !== 'win32' }, () => {
  // Exercise real PowerShell startup without requiring WMI access in the test sandbox.
  const code = `
    import { spawnSync } from 'node:child_process';
    import { readProcessTable } from ${JSON.stringify(new URL('../src/peer/lineage.mjs', import.meta.url).href)};
    const table = readProcessTable({ spawnSyncImpl(command, args, options) {
      const source = "[pscustomobject]@{ProcessId=10;ParentProcessId=1;CreationDate='/Date(1000)/'}";
      const result = spawnSync(command, args.map((arg) => arg.replace('Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate', source)), options);
      if (result.status !== 0) throw new Error(result.stderr || result.error?.code);
      return result;
    }});
    console.log(JSON.stringify([...table]));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PSModulePath: 'Z:\\nonexistent-modules' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 25_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [[10, { ppid: 1, createdAt: 1000 }]]);
});
