import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { testDir } from './helpers/test-root.mjs';
import { createBridgeClient } from '../src/peer/bridge-client.mjs';
import { PeerPolicyError } from '../src/peer/chain.mjs';
import { closeoutRootTask } from '../src/peer/closeout.mjs';
import { normalizePeerConfig } from '../src/peer/config.mjs';
import { appendIndexEvent, INDEX_FILE, readIndex } from '../src/peer/records.mjs';
import { createPeerServer } from '../src/peer/server.mjs';
import { sweepRecords } from '../src/peer/sweeper.mjs';

const A = 'root-a';
const B = 'root-b';
const NOW = 1_800_000_000_000;
const CODEX_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const DSH = { harness: 'dsh', id: 'session-1', source: 'task-1', revision: 4, submittedBy: A };
const CODEX = { harness: 'codex', id: CODEX_ID, source: 'job-1' };
const CLAUDE = { harness: 'claude-code', id: CLAUDE_ID, source: 'job-2' };
const rawIndex = (stateDir) => readFile(path.join(stateDir, INDEX_FILE), 'utf8');
const events = async (stateDir) => (await rawIndex(stateDir)).trim().split('\n').map(JSON.parse);
const sweep = (stateDir, bridge, extra = {}) => sweepRecords({ stateDir, bridge, now: () => NOW, dryRun: false, ...extra });
const response = (value) => ({ status: 200, text: async () => JSON.stringify({ result: { structuredContent: value } }) });

function bridgeFor(self, dossiers = {}) {
  const calls = [];
  return {
    calls,
    controllerIdentity: async () => { calls.push(['identity']); return { enabled: true, self, admin: self === 'operator' }; },
    dossier: async (id) => { calls.push(['dossier', id]); assert.ok(Object.hasOwn(dossiers, id)); return dossiers[id]; },
    resultText: async () => 'Stored answer',
    archive: async (id, revision) => { calls.push(['archive', id, revision]); return { archived: true }; },
    cleanup: async (id, options) => { calls.push(['cleanup', id, options]); return { cleaned: true }; },
  };
}

async function seed(stateDir, { recordId = 'record-1', owner = A, legacy = false, sessions = [DSH], missing = false, ...rest } = {}) {
  await mkdir(stateDir, { recursive: true });
  const recordPath = path.join(stateDir, `${recordId}.md`);
  if (!missing) await writeFile(recordPath, '# retained evidence\n');
  await appendIndexEvent(stateDir, {
    kind: 'record', recordId, ...(legacy ? {} : { owner }), path: recordPath,
    eligibleAt: NOW - 1, closedAt: NOW - 1000, keep: false, sessions, ...rest,
  });
}

async function failures(stateDir, { recordId = 'record-1', session = DSH, count = 3, state = 'failed' } = {}) {
  for (let i = 0; i < count; i += 1) {
    await appendIndexEvent(stateDir, { kind: 'session', recordId, harness: session.harness, id: session.id, state, note: 'old foreign scan' });
  }
}

test('closeout stores credential owner and dossier submittedBy in Markdown, index and replay', async (t) => {
  const root = testDir(t, 'f5-closeout');
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, '.git'), { recursive: true });
  const stateDir = path.join(root, 'state');
  const bridge = bridgeFor(A, { 'task-1': {
    taskId: 'task-1', status: 'completed', sessionId: DSH.id, revision: 4,
    submittedBy: A, controller: 'codex', acknowledgement: { resultCollected: true },
  } });
  const spec = {
    stateDir, bridge, rootTask: 'root', context: { self: 'codex', chain: ['claude-code', 'codex'] }, now: () => NOW,
    jobs: { list: async () => [], wait: async () => null, result: async () => null },
    input: { title: 'Ownership', outcome: 'accepted', conclusion: 'Verified', projectRoot, bridgeTaskIds: ['task-1'] },
  };
  const result = await closeoutRootTask(spec);
  assert.equal(result.owner, A);
  assert.deepEqual(result.sessions, [DSH]);
  const markdown = await readFile(result.path, 'utf8');
  const header = JSON.parse(markdown.match(/```json agent-bridge-record\n([\s\S]+?)\n```/)[1]);
  assert.equal(header.owner, A);
  assert.equal(header.controller, 'codex');
  assert.equal(header.sessions[0].submittedBy, A);
  const folded = (await readIndex(stateDir)).get(result.recordId);
  assert.equal(folded.owner, A);
  assert.equal(folded.sessions.get(`dsh\0${DSH.id}`).submittedBy, A);
  assert.equal(folded.sessions.get(`dsh\0${DSH.id}`).revision, 4);
  const before = await rawIndex(stateDir);
  const replay = await closeoutRootTask({ ...spec, bridge: { ...bridge, controllerIdentity: async () => ({ self: B }) } });
  assert.equal(replay.owner, A);
  assert.equal(replay.reused, true);
  assert.equal(await rawIndex(stateDir), before);
});

test('closeout identity outage refuses new writes', async (t) => {
  const root = testDir(t, 'f5-closeout-unavailable');
  const bridge = bridgeFor(A, { 'task-1': { status: 'completed', acknowledgement: { resultCollected: true } } });
  bridge.controllerIdentity = async () => { throw new PeerPolicyError('PEER_BRIDGE_UNAVAILABLE', 'offline'); };
  await assert.rejects(closeoutRootTask({
    stateDir: path.join(root, 'state'), bridge, rootTask: 'root',
    jobs: { list: async () => [], wait: async () => null, result: async () => null },
    input: { title: 'Outage', outcome: 'accepted', conclusion: 'Stored later', projectRoot: root, bridgeTaskIds: ['task-1'] },
  }), { code: 'PEER_BRIDGE_UNAVAILABLE' });
  await assert.rejects(stat(path.join(root, 'state', INDEX_FILE)), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, '.agent-bridge')), { code: 'ENOENT' });
});

test('read-only identity accepts admin, delegates still refuse it, credentials remain private', async () => {
  const calls = [];
  const client = createBridgeClient({
    url: 'http://127.0.0.1:3199/mcp', env: { DSH_MCP_TOKEN: 'test-token' },
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return response({ controllerIdentity: { enabled: true, self: 'operator', admin: true } });
    },
  });
  assert.deepEqual(await client.controllerIdentity(), { enabled: true, self: 'operator', admin: true });
  await assert.rejects(client.prepareDelegateCredential(), { code: 'PEER_BRIDGE_ADMIN_DELEGATION_FORBIDDEN' });
  assert.ok(calls.every((call) => call.params.name === 'bridge_capabilities'));
  assert.equal(JSON.stringify(calls).includes('test-token'), false);
});

test('B scans four times without events; A can still clean its DSH and peer sessions', async (t) => {
  const stateDir = testDir(t, 'f5-two-roots');
  await seed(stateDir, { sessions: [DSH, CODEX] });
  const before = await rawIndex(stateDir);
  const b = bridgeFor(B);
  for (let i = 0; i < 4; i += 1) {
    const report = await sweep(stateDir, b, { fsImpl: { stat: async () => assert.fail('foreign record stat') } });
    assert.deepEqual(report.actions, []);
    assert.equal(report.deferred[0].note, 'record owned by another controller');
    assert.equal(await rawIndex(stateDir), before);
  }
  assert.deepEqual(b.calls, Array.from({ length: 4 }, () => ['identity']));
  const deleted = [];
  const a = bridgeFor(A);
  const report = await sweep(stateDir, a, { codexThreads: {
    archive: async (id) => deleted.push(['archive', id]), remove: async (id) => deleted.push(['remove', id]),
  } });
  assert.deepEqual(report.actions.map((a) => a.state), ['archived', 'deleted']);
  assert.deepEqual(a.calls, [['identity'], ['archive', 'task-1', 4], ['cleanup', 'task-1', { dryRun: false }]]);
  assert.deepEqual(deleted, [['archive', CODEX_ID], ['remove', CODEX_ID]]);
});

test('foreign records write no events through missing-file, reference, invalid-id or retry branches', async (t) => {
  const stateDir = testDir(t, 'f5-foreign-branches');
  await seed(stateDir, { recordId: 'missing', missing: true, sessions: [DSH, CODEX, CLAUDE] });
  await seed(stateDir, { recordId: 'referenced' });
  await seed(stateDir, { recordId: 'kept', keep: true });
  await seed(stateDir, { recordId: 'invalid', sessions: [{ harness: 'codex', id: '../invalid' }] });
  await seed(stateDir, { recordId: 'exhausted' });
  await failures(stateDir, { recordId: 'exhausted' });
  const before = await rawIndex(stateDir);
  const report = await sweep(stateDir, bridgeFor(B), {
    retry: { recordIds: ['exhausted'], reason: 'wrong root must not reset' },
    fsImpl: { stat: async () => assert.fail('stat'), appendFile: async () => assert.fail('event') },
  });
  assert.deepEqual(report.actions, []);
  assert.deepEqual(report.retries, []);
  assert.equal(report.deferred.length, 5);
  assert.equal(await rawIndex(stateDir), before);
});

test('global references from foreign kept records still protect owned sessions', async (t) => {
  const stateDir = testDir(t, 'f5-global-reference');
  await seed(stateDir);
  await seed(stateDir, { recordId: 'foreign-kept', owner: B, keep: true });
  const bridge = bridgeFor(A);
  const report = await sweep(stateDir, bridge);
  assert.equal(report.actions[0].note, 'session still referenced by another record');
  assert.deepEqual(bridge.calls, [['identity']]);
  assert.deepEqual((await events(stateDir)).filter((e) => e.kind === 'session').map((e) => e.recordId), ['record-1']);
});

for (const mode of ['no-bridge', 'missing-credential', 'credential-file', 'transport', 'http-auth', 'invalid-identity']) {
  test(`identity ${mode} is report-only, including referenced and missing records`, async (t) => {
    const stateDir = testDir(t, `f5-${mode}`);
    await seed(stateDir, { missing: true });
    await seed(stateDir, { recordId: 'kept', keep: true });
    const bridge = mode === 'no-bridge' ? null : createBridgeClient({
      url: 'http://localhost:3199/mcp', env: ['missing-credential', 'credential-file'].includes(mode) ? {} : { DSH_MCP_TOKEN: 'test-token' },
      credentialFile: mode === 'credential-file' ? path.join(stateDir, 'absent-token') : null,
      fetchImpl: async () => {
        if (mode === 'transport') throw new Error('offline');
        if (mode === 'http-auth') return { status: 401 };
        if (mode === 'invalid-identity') return response({});
        assert.fail('unexpected network request');
      },
    });
    const before = await rawIndex(stateDir);
    for (let i = 0; i < 4; i += 1) {
      const report = await sweep(stateDir, bridge, { fsImpl: { stat: async () => assert.fail('stat before identity') } });
      assert.deepEqual(report.deferred.map((entry) => entry.recordId), ['record-1', 'kept']);
      assert.equal(report.actions.length, 0);
    }
    assert.equal(await rawIndex(stateDir), before);
  });
}

test('unavailable Codex and absent Claude root remain pending and clean after availability returns', async (t) => {
  const stateDir = testDir(t, 'f5-client-outage');
  await seed(stateDir, { sessions: [CODEX, CLAUDE] });
  const bridge = bridgeFor(A);
  const projects = path.join(stateDir, 'projects');
  const before = await rawIndex(stateDir);
  for (let i = 0; i < 4; i += 1) {
    const report = await sweep(stateDir, bridge, { claudeProjectsDir: projects });
    assert.deepEqual(report.actions.map((a) => a.state), ['deferred', 'deferred']);
  }
  assert.equal(await rawIndex(stateDir), before);
  const project = path.join(projects, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, `${CLAUDE_ID}.jsonl`), 'session');
  const deleted = [];
  const report = await sweep(stateDir, bridge, { claudeProjectsDir: projects,
    codexThreads: { archive: async () => {}, remove: async (id) => deleted.push(id) } });
  assert.deepEqual(report.actions.map((a) => a.state), ['deleted', 'deleted']);
  assert.deepEqual(deleted, [CODEX_ID]);
  await assert.rejects(stat(path.join(project, `${CLAUDE_ID}.jsonl`)), { code: 'ENOENT' });
});

test('runtime transport/auth/client errors report deferred without failure events', async (t) => {
  const stateDir = testDir(t, 'f5-runtime-outage');
  await seed(stateDir, { sessions: [DSH, CODEX, CLAUDE] });
  const bridge = bridgeFor(A);
  bridge.archive = async () => { throw new PeerPolicyError('PEER_BRIDGE', 'HTTP 401', { code: null }); };
  const before = await rawIndex(stateDir);
  const report = await sweep(stateDir, bridge, {
    codexThreads: { archive: async () => { throw new PeerPolicyError('PEER_CODEX_APP_SERVER', 'spawn EPERM', { method: 'initialize' }); } },
    claudeProjectsDir: path.join(stateDir, 'projects'),
    fsImpl: { stat: async (file) => {
      if (file.endsWith('projects')) throw Object.assign(new Error('temporarily denied'), { code: 'EACCES' });
      return stat(file);
    } },
  });
  assert.deepEqual(report.actions.map((a) => a.state), ['deferred', 'deferred', 'deferred']);
  assert.equal(await rawIndex(stateDir), before);
});

test('legacy DSH sessions use dossier submittedBy; null and foreign sessions remain untouched', async (t) => {
  const stateDir = testDir(t, 'f5-legacy');
  await seed(stateDir, { legacy: true, sessions: [
    { harness: 'dsh', id: 'owned', source: 'owned-task', revision: 2 },
    { harness: 'dsh', id: 'foreign', source: 'foreign-task', revision: 2 },
    { harness: 'dsh', id: 'legacy-null', source: 'null-task', revision: 2 },
  ] });
  const dossiers = { 'owned-task': { submittedBy: A }, 'foreign-task': { submittedBy: B }, 'null-task': { submittedBy: null } };
  const bridge = bridgeFor(A, dossiers);
  const report = await sweep(stateDir, bridge);
  assert.deepEqual(report.actions.map((a) => [a.id, a.state]), [['owned', 'archived']]);
  assert.deepEqual(report.deferred.map((a) => a.id), ['foreign', 'legacy-null']);
  assert.match(report.deferred[1].note, /operator/);
  assert.deepEqual(bridge.calls.filter((c) => c[0] === 'archive'), [['archive', 'owned-task', 2]]);
  assert.deepEqual((await events(stateDir)).filter((e) => e.kind === 'session').map((e) => e.id), ['owned']);
  const folded = (await readIndex(stateDir)).get('record-1');
  assert.equal(Object.hasOwn(folded, 'owner'), false);
  const before = await rawIndex(stateDir);
  await sweep(stateDir, bridgeFor('operator', dossiers), { retry: { recordIds: ['record-1'], reason: 'no implicit operator override' } });
  assert.equal(await rawIndex(stateDir), before);
});

test('legacy foreign dossier filtering precedes record stat and all event branches', async (t) => {
  const stateDir = testDir(t, 'f5-legacy-foreign');
  await seed(stateDir, { legacy: true, missing: true, sessions: [{ ...DSH, submittedBy: B }] });
  await failures(stateDir);
  const before = await rawIndex(stateDir);
  const bridge = bridgeFor(B, { 'task-1': { submittedBy: A } });
  const report = await sweep(stateDir, bridge, {
    retry: { recordIds: ['record-1'], reason: 'must verify dossier' },
    fsImpl: { stat: async () => assert.fail('foreign dossier record stat') },
  });
  assert.deepEqual(report.retries, []);
  assert.deepEqual(report.actions, []);
  assert.equal(await rawIndex(stateDir), before);
});

test('legacy B scans preserve A cleanup, including audited recovery of historical exhaustion', async (t) => {
  const stateDir = testDir(t, 'f5-legacy-recovery');
  const { submittedBy, ...legacySession } = DSH;
  await seed(stateDir, { legacy: true, sessions: [legacySession] });
  const dossiers = { 'task-1': { submittedBy: A } };
  const before = await rawIndex(stateDir);
  for (let i = 0; i < 4; i += 1) await sweep(stateDir, bridgeFor(B, dossiers));
  assert.equal(await rawIndex(stateDir), before);
  await failures(stateDir);
  const recovered = await sweep(stateDir, bridgeFor(A, dossiers), {
    retry: { recordIds: ['record-1'], reason: 'Repair legacy cross-root failures' },
  });
  assert.equal(recovered.actions[0].state, 'archived');
  assert.equal(recovered.retries[0].previousFailures, 3);
});

test('an unreadable Claude projects listing remains pending', async (t) => {
  const stateDir = testDir(t, 'f5-claude-listing');
  await seed(stateDir, { sessions: [CLAUDE] });
  const projects = path.join(stateDir, 'projects');
  await mkdir(projects);
  const before = await rawIndex(stateDir);
  const report = await sweep(stateDir, bridgeFor(A), {
    claudeProjectsDir: projects,
    fsImpl: { readdir: async () => { throw Object.assign(new Error('directory unavailable'), { code: 'ENOENT' }); } },
  });
  assert.equal(report.actions[0].state, 'deferred');
  assert.equal(await rawIndex(stateDir), before);
});

test('legacy dossier outage defers both absent and null record ownership without events', async (t) => {
  const stateDir = testDir(t, 'f5-unknown-owner');
  await seed(stateDir, { legacy: true });
  await seed(stateDir, { recordId: 'unknown-record', owner: null });
  const bridge = bridgeFor(A);
  bridge.dossier = async () => { throw new Error('bridge unavailable'); };
  const before = await rawIndex(stateDir);
  const report = await sweep(stateDir, bridge, { fsImpl: { stat: async () => assert.fail('unverified ownership') } });
  assert.equal(report.deferred.length, 2);
  assert.equal(await rawIndex(stateDir), before);
});

test('owned peer-only records still require their owner and never fall back to local cleanup', async (t) => {
  const stateDir = testDir(t, 'f5-owned-local');
  await seed(stateDir, { sessions: [CODEX] });
  const before = await rawIndex(stateDir);
  for (const bridge of [null, bridgeFor(B)]) {
    const report = await sweep(stateDir, bridge, { fsImpl: { stat: async () => assert.fail('owned record stat without its principal') } });
    assert.deepEqual(report.actions, []);
    assert.equal(report.deferred.length, 1);
    assert.equal(await rawIndex(stateDir), before);
  }
  const deleted = [];
  const report = await sweep(stateDir, bridgeFor(A), {
    codexThreads: { archive: async () => {}, remove: async (id) => deleted.push(id) },
  });
  assert.equal(report.actions[0].state, 'deleted');
  assert.deepEqual(deleted, [CODEX_ID]);
});

test('peer-only closeout without a bridge is cleaned by another root through cleanup_run', async (t) => {
  const root = testDir(t, 'f5-peer-only-closeout');
  const stateDir = path.join(root, 'state');
  const projectRoot = path.join(root, 'project');
  const projects = path.join(root, 'claude-projects');
  await mkdir(path.join(projectRoot, '.git'), { recursive: true });
  await mkdir(path.join(projects, 'project'), { recursive: true });
  const claudeFile = path.join(projects, 'project', `${CLAUDE_ID}.jsonl`);
  await writeFile(claudeFile, 'session');
  const jobIds = ['peer-1800000000000-abcdef01', 'peer-1800000000000-abcdef02'];
  const jobRecords = [CODEX, CLAUDE].map((session, i) => ({
    jobId: jobIds[i], status: 'completed', target: session.harness, sessionId: session.id, cwd: projectRoot,
  }));
  const jobs = { list: async () => jobRecords, wait: async (id) => jobRecords.find((job) => job.jobId === id),
    result: async () => ({ finalMessage: 'Stored peer result' }), close: async () => {} };
  const config = normalizePeerConfig({ schemaVersion: 1, stateDir, peers: {}, records: { claudeProjectsDir: projects } });
  const writer = createPeerServer({ config, jobs, env: { AGENT_BRIDGE_SELF: 'codex' },
    bridgeClient: null, startSweepTimer: false, now: () => NOW });
  t.after(() => writer.close());
  const closed = await writer.call('record_closeout', {
    title: 'Peer only', outcome: 'accepted', conclusion: 'Captured', projectRoot, peerJobIds: jobIds,
  });
  assert.equal(closed.owner, null);
  const folded = (await readIndex(stateDir)).get(closed.recordId);
  assert.equal(folded.owner, null);
  assert.deepEqual([...folded.sessions.values()].map((session) => session.harness), ['codex', 'claude-code']);
  const calls = [];
  const cleaner = createPeerServer({ config, jobs, env: { AGENT_BRIDGE_SELF: 'claude-code' },
    bridgeClient: null, startSweepTimer: false, now: () => NOW + 4 * 86_400_000,
    codexThreadsFactory: () => ({ archive: async (id) => calls.push(['archive', id]),
      remove: async (id) => calls.push(['remove', id]), close: async () => calls.push(['close']) }),
  });
  t.after(() => cleaner.close());
  const report = await cleaner.call('cleanup_run', { dryRun: false });
  assert.deepEqual(report.actions.map((action) => action.state), ['deleted', 'deleted']);
  assert.deepEqual(report.deferred, []);
  assert.deepEqual(calls, [['archive', CODEX_ID], ['remove', CODEX_ID], ['close']]);
  await assert.rejects(stat(claudeFile), { code: 'ENOENT' });
  assert.equal((await events(stateDir)).filter((event) => event.state === 'deleted').length, 2);
});

for (const legacy of [false, true]) {
  test(`mixed ownerless records (${legacy ? 'absent' : 'null'} owner) clean local sessions under either root or bridge outage`, async (t) => {
    const root = testDir(t, 'f5-mixed-local');
    for (const self of [A, B, null]) {
      const stateDir = path.join(root, self ?? 'unavailable');
      const unowned = { ...DSH, id: 'null-session', source: 'null-task', submittedBy: null };
      await seed(stateDir, { owner: null, legacy, sessions: [{ ...DSH, submittedBy: B }, unowned, CODEX, CLAUDE] });
      const bridge = self === null ? null : bridgeFor(self, { 'task-1': { submittedBy: A }, 'null-task': { submittedBy: null } });
      const projects = path.join(stateDir, 'projects');
      await mkdir(path.join(projects, 'project'), { recursive: true });
      const claudeFile = path.join(projects, 'project', `${CLAUDE_ID}.jsonl`);
      await writeFile(claudeFile, 'session');
      const removed = [];
      const report = await sweep(stateDir, bridge, { claudeProjectsDir: projects,
        codexThreads: { archive: async () => {}, remove: async (id) => removed.push(id) } });
      assert.deepEqual(removed, [CODEX_ID]);
      await assert.rejects(stat(claudeFile), { code: 'ENOENT' });
      const changed = (await events(stateDir)).filter((event) => event.kind === 'session');
      assert.deepEqual(changed.map((event) => event.id), self === A ? [DSH.id, CODEX_ID, CLAUDE_ID] : [CODEX_ID, CLAUDE_ID]);
      assert.equal(report.deferred.length, self === A ? 1 : 2);
      if (self !== null) assert.match(report.deferred.at(-1).note, /operator/);
      const before = await rawIndex(stateDir);
      await sweep(stateDir, bridge);
      assert.equal(await rawIndex(stateDir), before, 'deferred DSH sessions write no events on later scans');
    }
  });
}

test('ownerless local clients stay pending while unavailable and support an audited retry without a bridge', async (t) => {
  const stateDir = testDir(t, 'f5-local-retry');
  await seed(stateDir, { owner: null, sessions: [CODEX, CLAUDE] });
  const before = await rawIndex(stateDir);
  const report = await sweep(stateDir, null);
  assert.deepEqual(report.actions.map((action) => action.state), ['deferred', 'deferred']);
  assert.equal(await rawIndex(stateDir), before);
  await failures(stateDir, { session: CODEX, count: 1, state: 'skipped' });
  const recovered = await sweep(stateDir, null, { retry: { recordIds: ['record-1'], reason: 'Restore local cleanup after client repair' },
    codexThreads: { archive: async () => {}, remove: async () => {} } });
  assert.equal(recovered.actions[0].state, 'deleted');
  assert.equal(recovered.retries[0].controller, null);
  const audit = (await events(stateDir)).find((event) => event.retry)?.retry;
  assert.equal(audit.source, 'cleanup_run');
  assert.equal(audit.reason, 'Restore local cleanup after client repair');
  assert.equal(audit.controller, null);
});

test('explicit retry audits prior state and resets exhausted failures across later sweeps', async (t) => {
  const stateDir = testDir(t, 'f5-retry');
  await seed(stateDir);
  await failures(stateDir);
  const bridge = bridgeFor(A);
  const retry = { recordIds: ['record-1'], reason: 'Recover C10 cross-root retry exhaustion' };
  const before = await rawIndex(stateDir);
  assert.deepEqual((await sweep(stateDir, bridge)).actions, []);
  const dry = await sweep(stateDir, bridge, { dryRun: true, retry });
  assert.equal(dry.retries[0].state, 'planned');
  assert.equal(dry.actions[0].state, 'planned');
  assert.equal(await rawIndex(stateDir), before);
  bridge.archive = async () => { throw new PeerPolicyError('PEER_BRIDGE', 'task still active', { code: 'TASK_NOT_SETTLED' }); };
  assert.equal((await sweep(stateDir, bridge, { retry })).actions[0].state, 'failed');
  assert.equal((await sweep(stateDir, bridge)).actions[0].state, 'failed');
  assert.equal((await sweep(stateDir, bridge)).actions[0].state, 'failed');
  assert.deepEqual((await sweep(stateDir, bridge)).actions, []);
  let entries = await events(stateDir);
  const reset = entries.find((e) => e.state === 'pending');
  assert.deepEqual(reset.retry, { source: 'cleanup_run', controller: A, reason: retry.reason, previousState: 'failed', previousFailures: 3 });
  assert.equal(entries.filter((e) => e.state === 'failed').length, 6, 'original failures remain available for audit');
  const fixed = await sweep(stateDir, bridgeFor(A), { retry });
  assert.equal(fixed.actions[0].state, 'archived');
  const folded = (await readIndex(stateDir)).get('record-1').sessions.get(`dsh\0${DSH.id}`);
  assert.equal(folded.state, 'archived');
  assert.equal(folded.retry.controller, A);
  entries = await events(stateDir);
  assert.equal(entries.filter((e) => e.state === 'pending').length, 2);
});

test('retry of historical skipped entries persists pending through temporary outage', async (t) => {
  const stateDir = testDir(t, 'f5-retry-skipped');
  await seed(stateDir, { sessions: [CODEX] });
  await failures(stateDir, { session: CODEX, count: 1, state: 'skipped' });
  const report = await sweep(stateDir, bridgeFor(A), { retry: { recordIds: ['record-1'], reason: 'Client is returning' } });
  assert.equal(report.actions[0].state, 'deferred');
  assert.equal((await readIndex(stateDir)).get('record-1').sessions.get(`codex\0${CODEX_ID}`).state, 'pending');
  assert.equal((await events(stateDir)).length, 3);
  const recovered = await sweep(stateDir, bridgeFor(A), { codexThreads: { archive: async () => {}, remove: async () => {} } });
  assert.equal(recovered.actions[0].state, 'deleted');
});

test('retry preserves keep, retention, missing-file, reference, archived and deleted gates', async (t) => {
  const stateDir = testDir(t, 'f5-retry-gates');
  for (const recordId of ['kept', 'future', 'missing', 'referenced', 'archived', 'deleted']) {
    await seed(stateDir, { recordId, keep: recordId === 'kept', missing: recordId === 'missing',
      eligibleAt: recordId === 'future' ? NOW + 1 : NOW - 1,
      sessions: [{ ...DSH, id: recordId === 'referenced' ? 'kept' : recordId }],
    });
    await failures(stateDir, { recordId, session: { ...DSH, id: recordId === 'referenced' ? 'kept' : recordId },
      count: 1, state: ['archived', 'deleted'].includes(recordId) ? recordId : 'skipped' });
  }
  const bridge = bridgeFor(A);
  const report = await sweep(stateDir, bridge, { retry: {
    recordIds: ['kept', 'future', 'missing', 'referenced', 'archived', 'deleted'], reason: 'Explicit recovery preserves safety gates',
  } });
  assert.deepEqual(report.retries.map((r) => r.recordId), ['missing', 'referenced']);
  assert.deepEqual(report.actions.map((a) => a.note), ['record file missing', 'session still referenced by another record']);
  assert.deepEqual(bridge.calls, [['identity']]);
});

test('retry validates explicit IDs and mandatory bounded reason before IO', async (t) => {
  const stateDir = testDir(t, 'f5-invalid-retry');
  for (const retry of [{}, { recordIds: [], reason: 'why' }, { recordIds: ['record-1'], reason: ' ' },
    { recordIds: ['record-1'], reason: 'x'.repeat(501) }, { recordIds: ['record-1'], reason: 'why', actor: B }]) {
    await assert.rejects(sweep(stateDir, null, { retry, fsImpl: { readFile: async () => assert.fail('read before input validation') } }), { code: 'PEER_ARGS_INVALID' });
  }
});

test('cleanup_run forwards optional retry, exposes ownership and preserves default dry-run', async (t) => {
  const stateDir = testDir(t, 'f5-server');
  await seed(stateDir);
  await failures(stateDir);
  const bridge = bridgeFor(A);
  const server = createPeerServer({
    env: { AGENT_BRIDGE_SELF: 'codex' }, config: normalizePeerConfig({ schemaVersion: 1, stateDir, peers: {} }),
    bridgeClient: bridge, startSweepTimer: false, now: () => NOW, logger: () => {},
  });
  t.after(() => server.close());
  const rpc = async (name, args = {}) => {
    const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(reply.result?.isError, undefined, JSON.stringify(reply));
    return reply.result.structuredContent;
  };
  const before = await rawIndex(stateDir);
  const retry = { recordIds: ['record-1'], reason: 'Operator-reviewed recovery request' };
  const plan = await rpc('cleanup_run', { retry });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.retries[0].state, 'planned');
  assert.equal(await rawIndex(stateDir), before);
  assert.equal((await rpc('cleanup_run', { dryRun: false, retry })).actions[0].state, 'archived');
  const listed = await rpc('record_list');
  assert.equal(listed.records[0].owner, A);
  assert.equal(listed.records[0].sessions[0].submittedBy, A);
  assert.equal(listed.records[0].sessions[0].retry.reason, retry.reason);
  const tools = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const schema = tools.result.tools.find((tool) => tool.name === 'cleanup_run').inputSchema;
  assert.deepEqual(schema.properties.retry.required, ['recordIds', 'reason']);
});

test('a Claude sibling directory that cannot be removed yet keeps the session findable and is cleaned later', async (t) => {
  const stateDir = testDir(t, 'f5-claude-partial');
  await seed(stateDir, { sessions: [CLAUDE] });
  const bridge = bridgeFor(A);
  const projects = path.join(stateDir, 'projects');
  const project = path.join(projects, 'project');
  await mkdir(path.join(project, CLAUDE_ID), { recursive: true });
  await writeFile(path.join(project, CLAUDE_ID, 'tool-output.txt'), 'busy');
  await writeFile(path.join(project, `${CLAUDE_ID}.jsonl`), 'session');
  const before = await rawIndex(stateDir);
  const busy = async (target) => {
    if (path.basename(target) === CLAUDE_ID) throw Object.assign(new Error('directory in use'), { code: 'EBUSY' });
    assert.fail(`unexpected rm of ${target} while the sibling directory is busy`);
  };
  const first = await sweep(stateDir, bridge, { claudeProjectsDir: projects, fsImpl: { rm: busy } });
  assert.deepEqual(first.actions.map((a) => a.state), ['deferred']);
  assert.equal(await rawIndex(stateDir), before, 'a deferred partial deletion writes no index event');
  assert.ok((await stat(path.join(project, `${CLAUDE_ID}.jsonl`))).isFile(), 'the locator file survives the failed attempt');
  const second = await sweep(stateDir, bridge, { claudeProjectsDir: projects });
  assert.deepEqual(second.actions.map((a) => a.state), ['deleted']);
  await assert.rejects(stat(path.join(project, CLAUDE_ID)), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(project, `${CLAUDE_ID}.jsonl`)), { code: 'ENOENT' });
});

test('a peer-only closeout still writes its record, ownerless, while the bridge identity is unavailable', async (t) => {
  const root = testDir(t, 'f5-closeout-peer-only-outage');
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, '.git'), { recursive: true });
  const stateDir = path.join(root, 'state');
  const bridge = bridgeFor(A);
  bridge.controllerIdentity = async () => { throw new PeerPolicyError('PEER_BRIDGE_UNAVAILABLE', 'offline'); };
  const job = { jobId: 'peer-1793700000000-0123abcd', rootTask: 'root', status: 'completed', target: 'codex', mode: 'consult', sessionId: CODEX_ID, cwd: projectRoot };
  const result = await closeoutRootTask({
    stateDir, bridge, rootTask: 'root', context: { self: 'claude-code', chain: ['claude-code'] }, now: () => NOW,
    jobs: { list: async () => [job.jobId], wait: async () => job, result: async () => ({ finalMessage: 'answer' }) },
    input: { title: 'Peer only', outcome: 'accepted', conclusion: 'Done', projectRoot },
  });
  assert.equal(result.owner, null);
  assert.equal((await readIndex(stateDir)).get(result.recordId).owner, null);
});
