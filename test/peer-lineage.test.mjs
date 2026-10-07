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
