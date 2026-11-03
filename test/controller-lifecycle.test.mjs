// D2 lifecycle regressions: integrated real store + real service + real HTTP entry.
//
// Three integrated cases:
//   1. Supervisor workers inherit the PARENT's credential principal and client-declared
//      via (including the historical null principal), and that identity is still
//      enforced by the dispatcher afterwards.
//   2. A real multi-round follow-up on a historical (submittedBy:null) task: replay,
//      conflict, stale afterAttemptId and immutable null ownership, with durable
//      override audits, over the real HTTP entry.
//   3. Real peer credential/client flow: root delegate credential verification, child
//      environment injection for both delegation directions, the admin spawn guard, and
//      a carrier request that reaches the real HTTP bridge as the root principal.
//
// test/controller-service.test.mjs and test/followup-service.test.mjs cover the pure
// service seams; this file deliberately binds those seams to the actual MCP transport,
// controller registry and authorization order.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createDispatcher, createMcpHandler } from '../src/mcp.mjs';
import { TaskStore } from '../src/store.mjs';
import { BridgeService } from '../src/service.mjs';
import { loadControllerRegistry } from '../src/controller-auth.mjs';
import { validatePacket } from '../src/contracts.mjs';
import { BridgeSupervisor, HostReservationLedger } from '../src/supervisor.mjs';
import {
  SupervisorProjectRuntime,
  createProjectRecord,
  normalizeProjectConfig,
  resolveProjectGrant,
} from '../src/long-task.mjs';
import { createBridgeClient } from '../src/peer/bridge-client.mjs';
import { childEnvironment } from '../src/peer/cli.mjs';
import { normalizePeerConfig } from '../src/peer/config.mjs';
import { createPeerJobs } from '../src/peer/jobs.mjs';
import { createPeerServer } from '../src/peer/server.mjs';
import { createCarrier } from '../src/bridge-carrier.mjs';

const TEMP_ROOT = 'F:/temp/agent-bridge-upstream';
const MODEL = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
const OVERRIDE = { reason: '  Inspect historical task  ' };
const TOKEN = {
  'claude-code': `claude-lifecycle-${'a'.repeat(40)}`,
  codex: `codex-lifecycle-${'b'.repeat(40)}`,
  operator: `operator-lifecycle-${'c'.repeat(40)}`,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'condition timed out') {
  for (let index = 0; index < 500; index += 1) {
    if (await check()) return;
    await sleep(5);
  }
  assert.fail(label);
}

function packet(directory, key, extra = {}) {
  return {
    schemaVersion: 1, idempotencyKey: key, revision: 1, projectId: 'lifecycle',
    title: key, objective: 'read one file', cwd: directory, role: 'investigate',
    acceptance: ['evidence'],
    scope: { readRoots: [directory], writeRoots: [], allowedTools: ['read'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [], contractVersion: '1', ...extra,
  };
}

function projectPacket(directory, key) {
  return validatePacket(packet(directory, key, {
    role: 'investigate',
    project: {
      maxWorkers: 2, maxConcurrentWorkers: 2, maxRepairAttempts: 1, maxTotalRetries: 2,
      maxWorkerStarts: 4, maxTotalToolCalls: 1000, timeoutMs: 3_600_000, reserveSlots: 1,
      workerScope: { readRoots: [directory], allowedTools: ['read'], allowNetwork: false },
    },
  }));
}

function makeAdapter(counters = {}) {
  const catalog = [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }];
  return {
    models: async () => catalog,
    capabilities: async () => ({ lifecycle: { followup: { supported: true } } }),
    preflight: async () => ({ ok: true }),
    start: async task => ({ sessionId: `session-${task.id}`, requestId: `request-${task.id}-${task.attempt}`, effectiveModel: task.effectiveModel, effectivePolicy: {} }),
    followup: async task => ({ sessionId: task.sessionId, requestId: `request-follow-${task.id}-${task.attempt}`, effectiveModel: task.effectiveModel, effectivePolicy: {} }),
    reconsider: async task => ({ sessionId: task.sessionId, requestId: `request-clarify-${task.id}-${task.attempt}`, effectiveModel: task.effectiveModel, effectivePolicy: {} }),
    cancel: async () => ({ accepted: true, stopConfirmed: true, remaining: [] }),
    inspect: async () => ({ status: 'unknown', stopConfirmed: false }),
    cleanup: async () => ({ cleaned: true }),
    archive: async task => ({ archived: true, uiHidden: true, sessionId: task.sessionId ?? null }),
    ...counters,
  };
}

function bridgeFixture(t, { kick = false } = {}) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(TEMP_ROOT, 'controller-lifecycle-'));
  const store = new TaskStore({ directory, ownerId: 'owner' });
  const counters = { start: 0, followup: 0, reconsider: 0 };
  const adapter = makeAdapter();
  for (const name of ['start', 'followup', 'reconsider']) {
    const original = adapter[name];
    adapter[name] = async (...args) => { counters[name] += 1; return original(...args); };
  }
  const service = new BridgeService({ store, adapter, maxConcurrent: 4 });
  if (!kick) service.kick = () => {};
  const controllers = ['claude-code', 'codex', 'operator'].map(id => {
    const tokenFile = path.join(directory, `${id}.token`);
    fs.writeFileSync(tokenFile, TOKEN[id]);
    return { id, tokenFile, admin: id === 'operator' };
  });
  const registry = loadControllerRegistry(controllers);
  t.after(() => {
    service.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, service, adapter, counters, registry };
}

async function serve(t, f) {
  const server = http.createServer(createMcpHandler(f.service, { registry: f.registry }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (name, args = {}, { id = 'codex', headers = {}, token = TOKEN[id] } = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, url, server };
}

function outcomeOf(response) {
  if (response.status !== 200) return { status: response.status, body: response.body };
  const result = response.body?.result;
  if (result?.isError === true) return { error: JSON.parse(result.content[0].text) };
  return { value: result?.structuredContent };
}

/* ------------------------------------------------------------------ *
 * 1. Supervisor-inherited identity
 * ------------------------------------------------------------------ */

async function supervisorFixture(t, submittedBy, via) {
  const f = bridgeFixture(t);
  const config = normalizeProjectConfig({ enabled: true, reserveSlots: 1 });
  const supervisor = new BridgeSupervisor({ ownerId: 'owner', ledger: new HostReservationLedger({ limit: 16, id: `lifecycle-${submittedBy ?? 'historical'}-${Math.random()}` }) });
  const runtime = new SupervisorProjectRuntime({ store: f.store, service: f.service, supervisor, config });
  t.after(() => runtime.close());
  const p = projectPacket(f.directory, `project-${submittedBy ?? 'null'}`);
  const project = createProjectRecord({ packet: p, grant: resolveProjectGrant(p.project, config), now: Date.now() });
  const parent = f.store.submit(p, { submittedBy, via, effectiveModel: MODEL, project }).task;
  runtime.admitProject(parent.id);
  runtime.workerCreate({ taskId: parent.id, args: { workerKey: 'reader', objective: 'read bounded input', role: 'review', tools: ['read'] } });
  runtime.planFinalize({ taskId: parent.id });
  await runtime.onSupervisorFinished(parent.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 });
  await runtime.whenIdle(parent.id);
  const attempt = f.store.get(parent.id).project.workers[0].attempts[0];
  return { ...f, runtime, parent, attempt, call: createDispatcher(f.service) };
}

for (const [label, submittedBy, via] of [
  ['codex root credential', 'codex', { chain: ['claude-code', 'codex'], rootTask: 'supervisor-root' }],
  ['historical null credential', null, null],
]) {
  test(`supervisor worker inherits parent identity ${label} and keeps it immutable`, async t => {
    const f = await supervisorFixture(t, submittedBy, via);
    assert.ok(f.attempt.taskId, 'the supervisor worker task was never persisted');
    const child = f.store.get(f.attempt.taskId);
    assert.equal(child.submittedBy, submittedBy);
    assert.deepEqual(child.via, via);
    assert.equal(child.effectiveModel.provider, MODEL.provider);
    assert.equal(f.store.list({ submittedBy }).some(task => task.id === child.id), true);

    // The inherited identity is authoritatively enforced by the dispatcher afterwards.
    const context = (id, admin) => ({ principal: { id, admin }, via: null, controllerIds: ['claude-code', 'codex', 'operator'] });
    await assert.rejects(f.call('bridge_cancel', { taskId: child.id }, context('claude-code', false)), { code: 'TASK_NOT_OWNED' });
    await assert.rejects(f.call('bridge_cancel', { taskId: child.id }, context('operator', true)), { code: 'OVERRIDE_REASON_REQUIRED' });
    // The parent principal itself may cancel its worker without an override.
    const own = child.submittedBy;
    if (own === null) {
      const result = await f.call('bridge_cancel', { taskId: child.id, override: OVERRIDE }, context('operator', true));
      assert.equal(result.submittedBy, null);
    } else {
      const result = await f.call('bridge_cancel', { taskId: child.id }, context(own, false));
      assert.equal(result.submittedBy, submittedBy);
    }
    assert.equal(f.store.get(child.id).submittedBy, submittedBy);
    assert.deepEqual(f.store.get(child.id).via, via);
  });
}

/* ------------------------------------------------------------------ *
 * 2. Real follow-up lifecycle on a historical null-owned task
 * ------------------------------------------------------------------ */

test('historical null ownership survives a real HTTP follow-up with replay, conflict and stale CAS', async t => {
  const f = bridgeFixture(t, { kick: true });
  const { request } = await serve(t, f);
  const callbacks = new Map();
  f.adapter.start = async task => {
    f.counters.start += 1;
    callbacks.set(task.attemptId, task);
    return { sessionId: `session-${task.id}`, requestId: `request-${task.id}-${task.attempt}`, effectiveModel: task.effectiveModel, effectivePolicy: {} };
  };
  f.adapter.followup = async task => {
    f.counters.followup += 1;
    callbacks.set(task.attemptId, task);
    return { sessionId: task.sessionId, requestId: `request-follow-${task.id}-${task.attempt}`, effectiveModel: task.effectiveModel, effectivePolicy: {} };
  };
  const done = (id, text) => {
    const task = f.store.get(id);
    const callback = callbacks.get(task.attemptId);
    assert.ok(callback, `no host callback registered for attempt ${task.attemptId}`);
    // The real service start() wires onResult to finish(); the adapter seam only
    // records the attempt, so drive the settlement through the service directly.
    f.service.finish(id, { status: 'completed', text, stopConfirmed: true, activeJobs: 0, activeChildren: 0 }, task.attemptId);
  };

  // Historical tasks are created by an internal/host path: submittedBy:null, via:null.
  const submitted = await f.service.submit(packet(f.directory, 'historical-rounds'), { submittedBy: null, via: null });
  const id = submitted.id;
  await until(() => f.service.get(id).status === 'running', 'historical task never dispatched');
  const a0 = f.store.get(id).attemptId;
  const sessionId = f.store.get(id).sessionId;
  done(id, 'first answer');
  await until(() => f.service.get(id).status === 'completed', 'historical task never completed');
  assert.equal(f.store.get(id).result.text, 'first answer');

  const args = { taskId: id, revision: 1, afterAttemptId: a0, followupId: 'history-f1', text: 'what changed?' };
  const first = await request('bridge_followup', { ...args, override: OVERRIDE }, { id: 'operator' });
  const created = outcomeOf(first);
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const a1 = created.value.followup.attemptId;
  assert.equal(created.value.followup.replay, false);
  assert.equal(created.value.followup.round, 1);
  assert.notEqual(a1, a0);
  assert.equal(created.value.submittedBy, null, 'a follow-up must never adopt the operator identity');
  assert.equal(created.value.via, null);
  const minted = f.store.get(id);
  assert.equal(minted.submittedBy, null);
  assert.equal(minted.via, null);
  assert.equal(minted.followups.length, 1);
  assert.equal(minted.followups[0].boundAttempt.attemptId, a0);
  assert.equal(minted.followups[0].boundAttempt.sessionId, sessionId);
  const firstOutcome = f.store.events(id).filter(event => event.type === 'task/override-result').at(-1);
  const firstIntent = f.store.events(id).find(event => event.type === 'task/override' && event.operationId === firstOutcome.operationId);
  assert.equal(firstIntent.actor, 'operator');
  assert.equal(firstIntent.submittedBy, null);
  assert.equal(firstIntent.attemptId, a0);
  assert.equal(firstOutcome.attemptId, a1);
  assert.ok(f.store.events(id).indexOf(firstIntent) < f.store.events(id).indexOf(firstOutcome));

  await until(() => f.service.get(id).status === 'running', 'follow-up never dispatched');
  const dispatched = f.store.get(id);
  assert.equal(dispatched.continuationKind, 'followup');
  assert.equal(dispatched.sessionId, sessionId);
  assert.equal(dispatched.submittedBy, null);
  assert.equal(dispatched.packet.role, 'investigate');
  done(id, 'second answer');
  await until(() => f.service.get(id).status === 'completed', 'follow-up never completed');
  assert.equal(f.service.result(id).text, 'second answer');
  assert.equal(f.service.result(id).attemptId, a1);
  assert.equal(f.service.result(id, { attemptId: a0 }).text, 'first answer');
  assert.equal(f.service.result(id, { attemptId: a0 }).round, 0);
  assert.equal(f.service.dossier(id).rounds.length, 2);

  // Replay with the same id and content: same original attempt, no new round, new audit.
  const beforeReplay = f.counters.followup;
  const replay = outcomeOf(await request('bridge_followup', { ...args, override: { reason: 'replay with a new reason' } }, { id: 'operator', headers: { 'X-Agent-Bridge-Chain': 'dsh' } }));
  assert.equal(replay.error, undefined);
  assert.equal(replay.value.followup.replay, true);
  assert.equal(replay.value.followup.attemptId, a1);
  assert.equal(f.store.get(id).followups.length, 1);
  assert.equal(f.counters.followup, beforeReplay, 'a replay must never dispatch again');
  const replayOutcome = f.store.events(id).filter(event => event.type === 'task/override-result').at(-1);
  const replayIntent = f.store.events(id).find(event => event.type === 'task/override' && event.operationId === replayOutcome.operationId);
  assert.equal(replayIntent.actor, 'operator');
  assert.equal(replayIntent.submittedBy, null);
  assert.equal(replayOutcome.replay, true);
  assert.equal(f.store.get(id).submittedBy, null);

  // Same followupId with different content conflicts through the HTTP entry.
  const conflict = outcomeOf(await request('bridge_followup', { ...args, text: 'different question', override: OVERRIDE }, { id: 'operator' }));
  assert.equal(conflict.error?.code, 'FOLLOWUP_IDEMPOTENCY_CONFLICT');
  assert.equal(f.store.get(id).followups.length, 1);
  assert.equal(f.counters.followup, beforeReplay);
  const conflictOutcome = f.store.events(id).filter(event => event.type === 'task/override-result').at(-1);
  const conflictIntent = f.store.events(id).find(event => event.type === 'task/override' && event.operationId === conflictOutcome.operationId);
  assert.equal(conflictIntent.submittedBy, null);
  assert.equal(conflictOutcome.outcome, 'threw');
  assert.equal(conflictOutcome.code, 'FOLLOWUP_IDEMPOTENCY_CONFLICT');

  // A stale afterAttemptId (the replaced round) is refused by the store CAS.
  const stale = outcomeOf(await request('bridge_followup', { taskId: id, revision: 1, afterAttemptId: a0, followupId: 'history-f2', text: 'stale?', override: OVERRIDE }, { id: 'operator' }));
  assert.equal(stale.error?.code, 'FOLLOWUP_CONFLICT');
  assert.equal(f.store.get(id).followups.length, 1);
  assert.equal(f.store.get(id).attemptId, a1);

  // Authorization still precedes every replay/CAS lookup for ordinary callers.
  const snapshot = { task: f.store.get(id), events: f.store.events(id, { limit: 1000 }), followups: f.counters.followup };
  assert.equal(outcomeOf(await request('bridge_followup', args, { id: 'codex' })).error?.code, 'TASK_NOT_OWNED');
  assert.equal(outcomeOf(await request('bridge_followup', args, { id: 'operator' })).error?.code, 'OVERRIDE_REASON_REQUIRED');
  assert.deepEqual(f.store.get(id), snapshot.task);
  assert.deepEqual(f.store.events(id, { limit: 1000 }), snapshot.events);
  assert.equal(f.counters.followup, snapshot.followups);

  // Reads remain open to every authenticated principal, including the old round.
  const old = outcomeOf(await request('bridge_result', { taskId: id, attemptId: a0 }, { id: 'codex' }));
  assert.equal(old.error, undefined);
  assert.equal(old.value.text, 'first answer');
  assert.equal(old.value.submittedBy, null);
});

/* ------------------------------------------------------------------ *
 * 3. Real peer credential/client flow and admin spawn guard
 * ------------------------------------------------------------------ */

function fakePeerJobs(t, directory, logged) {
  const spawned = [];
  const starts = [];
  const jobs = createPeerJobs({
    stateDir: path.join(directory, 'peer-state'),
    logger: entry => logged.push(entry),
    killTree: async pid => { const entry = spawned.find(item => item.child.pid === pid); entry?.child?.emit('close', 0); return { ok: true }; },
    spawnImpl: (command, args, options) => {
      const child = new EventEmitter();
      child.pid = 910_000 + spawned.length;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.target = options.env.AGENT_BRIDGE_SELF;
      spawned.push({ command, args, options, child });
      return child;
    },
  });
  return {
    spawned,
    starts,
    jobs: {
      ...jobs,
      start: spec => {
        const { env: childEnv, ...publicSpec } = spec;
        starts.push(publicSpec);
        return jobs.start(spec);
      },
    },
    finish(child) {
      if (child.target === 'codex') {
        child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'lifecycle-session' })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`);
      } else {
        child.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 'lifecycle-session' })}\n`);
      }
      child.emit('close', 0, null);
    },
  };
}

function peerTransport(t, directory) {
  const logged = [];
  const fake = fakePeerJobs(t, directory, logged);
  return { ...fake, logged };
}

async function peerServer(t, { directory, stateDir, self, token, url }) {
  const config = normalizePeerConfig({
    schemaVersion: 1,
    stateDir,
    peers: { codex: { executable: process.execPath, threadSection: null }, 'claude-code': { executable: process.execPath } },
    records: { enabled: false },
    bridge: { url },
  });
  const harness = peerTransport(t, directory);
  const server = createPeerServer({
    config,
    jobs: harness.jobs,
    startSweepTimer: false,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AGENT_BRIDGE_SELF: self, DSH_MCP_TOKEN: token },
    logger: entry => harness.logged.push(entry),
  });
  // One cleanup hook owns both orders: close the peer server before deleting its
  // state directory (the DB directory belongs to another fixture and cleans itself).
  t.after(async () => {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { ...harness, config, server };
}

function peerDirectory(prefix) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
}

test('both delegate directions inject the verified root credential and submit through the real bridge', async t => {
  const bridge = bridgeFixture(t);
  const { request, url } = await serve(t, bridge);
  for (const [rootId, target] of [['claude-code', 'codex'], ['codex', 'claude-code']]) {
    const directory = peerDirectory(`controller-lifecycle-peer-${rootId}-`);
    const peer = await peerServer(t, { directory, stateDir: path.join(directory, 'state'), self: rootId, token: TOKEN[rootId], url });
    const asked = await peer.server.call('peer_ask', {
      target, mode: 'delegate', prompt: 'perform the bounded test', cwd: directory,
      rootTask: `root-${rootId}`, waitMs: 0,
    });
    assert.equal(asked.job.bridge.state, 'enabled');
    assert.equal(peer.spawned.length, 1, 'the delegate process was not spawned');
    const launched = peer.spawned[0];
    assert.equal(launched.options.env.DSH_MCP_TOKEN, TOKEN[rootId], 'the child receives the root credential');
    assert.equal(launched.options.env.DSH_BRIDGE_DELEGATED, '1');
    assert.equal(launched.options.env.DSH_BRIDGE_CREDENTIAL_FILE, undefined);
    assert.equal(launched.options.env.AGENT_BRIDGE_CHAIN, `${rootId}>${target}`);
    assert.equal(launched.options.env.AGENT_BRIDGE_ROOT_TASK, `root-${rootId}`);
    assert.equal(JSON.stringify({ starts: peer.starts, args: launched.args }).includes(TOKEN[rootId]), false);

    // The spawned child speaks through the carrier with exactly that environment and a
    // fake transport that reaches the REAL bridge HTTP entry.
    const writes = [];
    const carrier = createCarrier({
      env: launched.options.env,
      endpoint: url,
      fetchImpl: globalThis.fetch,
      readFileImpl: async () => assert.fail('a delegated carrier must not read a local credential file'),
      stdout: { write: text => writes.push(text) },
      watchdogEnabled: false,
    });
    const reply = await carrier.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'bridge_submit', arguments: { packet: packet(directory, `delegate-${rootId}`) } },
    }));
    assert.equal(reply.code, 200);
    const decoded = JSON.parse(writes[0]);
    const task = decoded.result.structuredContent;
    assert.equal(task.submittedBy, rootId);
    assert.deepEqual(task.via, { chain: [rootId, target], rootTask: `root-${rootId}` });
    assert.equal(bridge.store.get(task.id).submittedBy, rootId);
    assert.deepEqual(bridge.store.get(task.id).via, { chain: [rootId, target], rootTask: `root-${rootId}` });

    // Being the delegate does not transfer authority to the target harness.
    assert.equal(outcomeOf(await request('bridge_cancel', { taskId: task.id }, { id: target })).error?.code, 'TASK_NOT_OWNED');
    assert.equal(outcomeOf(await request('bridge_cancel', { taskId: task.id }, { id: 'operator' })).error?.code, 'OVERRIDE_REASON_REQUIRED');
    const audited = outcomeOf(await request('bridge_cancel', { taskId: task.id, override: OVERRIDE }, { id: 'operator' }));
    assert.equal(audited.error, undefined);
    assert.equal(bridge.store.get(task.id).submittedBy, rootId);

    // prepareDelegateCredential verifies with the SAME token it returns and never
    // reports administrator identity as delegable.
    const client = createBridgeClient({
      url, env: { DSH_MCP_TOKEN: TOKEN[rootId] }, readFileImpl: async () => assert.fail('no file fallback'),
      fetchImpl: globalThis.fetch,
    });
    const prepared = await client.prepareDelegateCredential();
    assert.deepEqual(prepared, { token: TOKEN[rootId], principal: { id: rootId, admin: false } });

    peer.finish(launched.child);
  }
});

test('administrator bridge credentials are refused before any delegate spawn or child environment', async t => {
  const bridge = bridgeFixture(t);
  const { url } = await serve(t, bridge);
  const directory = peerDirectory('controller-lifecycle-admin-guard-');
  const peer = await peerServer(t, { directory, stateDir: path.join(directory, 'state'), self: 'claude-code', token: TOKEN.operator, url });
  await assert.rejects(
    peer.server.call('peer_ask', {
      target: 'codex', mode: 'delegate', prompt: 'must not spawn', cwd: directory, rootTask: 'root-admin', waitMs: 0,
    }),
    { code: 'PEER_BRIDGE_ADMIN_DELEGATION_FORBIDDEN' },
  );
  assert.equal(peer.spawned.length, 0, 'an admin credential must be refused before spawn');
  assert.equal(peer.starts.length, 0);
  // consult/review are read-only and never receive bridge credentials either.
  const plan = { childEnv: { AGENT_BRIDGE_CHAIN: 'claude-code>codex', AGENT_BRIDGE_SELF: 'codex' } };
  const reviewEnv = childEnvironment({ DSH_MCP_TOKEN: TOKEN.operator }, plan.childEnv, { mode: 'review' });
  assert.equal(reviewEnv.DSH_MCP_TOKEN, undefined);
  assert.equal(reviewEnv.DSH_BRIDGE_DISABLED, '1');
  const delegateEnv = childEnvironment({ DSH_MCP_TOKEN: TOKEN.operator }, plan.childEnv, {
    mode: 'delegate', bridgeCredential: { token: TOKEN['claude-code'], principal: { id: 'claude-code', admin: false } },
  });
  assert.equal(delegateEnv.DSH_MCP_TOKEN, TOKEN['claude-code']);
  assert.equal(delegateEnv.DSH_BRIDGE_DELEGATED, '1');
  assert.equal(JSON.stringify(delegateEnv).includes(TOKEN.operator), false);
});
