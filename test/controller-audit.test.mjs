import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { BRIDGE_VERSION, TOOLS, createDispatcher, createMcpHandler } from '../src/mcp.mjs';
import { BridgeService } from '../src/service.mjs';
import { TaskStore } from '../src/store.mjs';
import { validatePacket } from '../src/contracts.mjs';
import { PROJECT_WAITING, PROJECT_PAUSING, PROJECT_PAUSED } from '../src/long-task.mjs';
import { testDir } from './helpers/test-root.mjs';

const owner = { principal: { id: 'codex', admin: false }, controllerIds: ['codex', 'operator'], via: null };
const admin = { ...owner, principal: { id: 'operator', admin: true } };
const override = { reason: 'Inspect operation outcome' };

function fixture(t) {
  let store, service;
  t.after(() => { service?.close(); store?.close(); });
  const directory = testDir(t, 'controller-audit');
  store = new TaskStore({ directory, ownerId: 'audit-host' });
  const adapter = {
    followup() { assert.fail('unexpected follow-up dispatch'); },
    reconsider() { assert.fail('unexpected clarification dispatch'); },
    cancel() { assert.fail('unexpected adapter cancellation'); },
  };
  service = new BridgeService({ store, adapter });
  service.kick = () => {};
  const seed = (patch = {}) => {
    const packet = validatePacket({ schemaVersion: 1, idempotencyKey: `seed-${store.list().length}`, revision: 1,
      projectId: 'audit', title: 'Inspect audit', objective: 'read one file', cwd: directory, role: 'investigate',
      acceptance: ['evidence'], scope: { readRoots: [directory], writeRoots: [], allowedTools: ['read'],
        allowShell: false, allowNetwork: false, allowDelegation: false }, materials: [], contractVersion: '1' });
    const task = store.submit(packet, { submittedBy: 'codex', via: null }).task;
    return store.update(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0,
      sessionId: 'session', requestId: 'request', dispatchReceiptAt: 1, accepted: true, error: { code: 'OLD_TASK_ERROR' }, ...patch });
  };
  return { directory, store, service, adapter, seed, call: createDispatcher(service) };
}

function audit(store, id) {
  const events = store.events(id, { limit: 1000 });
  const intent = events.findLast(event => event.type === 'task/override');
  const outcome = events.findLast(event => event.type === 'task/override-result');
  assert.ok(intent);
  assert.ok(outcome);
  assert.equal(outcome.operationId, intent.operationId);
  assert.equal(outcome.attemptId, store.get(id).attemptId);
  // Compare the complete semantic payload, including absence of unrelated fields.
  const { type, operationId, attemptId, seq, timestamp, taskId, ...payload } = outcome;
  return payload;
}

const cases = [
  { tool: 'bridge_approve', method: 'approve', args: { revision: 1, understandingHash: 'hash' }, fields: [] },
  { tool: 'bridge_clarify', method: 'clarify', args: { revision: 1, understandingHash: 'hash', clarificationId: 'c', text: 'clarify' }, fields: ['replay'] },
  { tool: 'bridge_followup', method: 'followup', args: { revision: 1, afterAttemptId: 'attempt', followupId: 'f', text: 'follow up' }, fields: ['replay'] },
  { tool: 'bridge_cancel', method: 'cancel', args: {}, nested: 'cancel', fields: ['accepted'], code: true },
  { tool: 'bridge_pause', method: 'pause', args: { requestId: 'p' }, nested: 'pause', fields: ['accepted', 'replay'], code: true },
  { tool: 'bridge_resume', method: 'resume', args: { requestId: 'r' }, nested: 'resume', fields: ['accepted', 'replay'], code: true },
  { tool: 'bridge_reconcile', method: 'reconcile', args: {}, fields: [] },
  { tool: 'bridge_acknowledge', method: 'acknowledge', args: { revision: 1 }, fields: ['accepted'] },
  { tool: 'bridge_archive', method: 'archive', args: { revision: 1 }, fields: ['archived'], code: true },
  { tool: 'bridge_cleanup', method: 'cleanup', args: { dryRun: true }, fields: ['cleaned', 'eligible'], code: true },
  { tool: 'bridge_workspace_review', method: 'review', workspace: true, args: { head: 'head', contractVersion: '1', passed: true }, fields: ['passed'], code: true },
  { tool: 'bridge_workspace_refresh', method: 'refresh', workspace: true, args: { expectedTargetHead: 'head' }, fields: ['refreshed'], code: true },
  { tool: 'bridge_workspace_integrate', method: 'integrate', workspace: true, args: { contractVersion: '1' }, fields: ['accepted', 'merged'], code: true },
];

test('audit result coverage enumerates every mutate tool', () => {
  assert.deepEqual(cases.map(c => c.tool).sort(), TOOLS.filter(tool => tool.category === 'mutate').map(tool => tool.name).sort());
});

for (const c of cases) {
  for (const value of [true, false]) {
    test(`${c.tool} audits only its own fields (${value}) and preserves ordinary returns`, async t => {
      const f = fixture(t);
      const task = f.seed({ workspace: { repository: f.directory, head: 'head' }, review: { head: 'head', passed: true } });
      const flags = Object.fromEntries(['accepted', 'merged', 'archived', 'cleaned', 'eligible', 'replay', 'passed', 'refreshed'].map(key => [key, value]));
      const operation = { ...flags, code: 'CURRENT_OPERATION', error: { code: 'CURRENT_FALLBACK' } };
      const result = { ...operation, workspace: task.workspace, followup: { replay: value }, clarificationReplay: value };
      if (c.nested) {
        Object.assign(result, { accepted: !value, replay: !value, code: 'OLD_PROJECTION_CODE', error: { code: 'OLD_TASK_ERROR' }, [c.nested]: operation });
      }
      if (!c.code) result.error = { code: 'OLD_TASK_ERROR' };
      const calls = [];
      const business = (...args) => { calls.push(args); return result; };
      if (c.workspace) f.service.workspaces = { [c.method]: business };
      else f.service[c.method] = business;
      const args = { taskId: task.id, ...c.args, ...(c.workspace && c.method !== 'review' ? { targetRepository: f.directory } : {}) };
      const before = structuredClone(result);
      assert.strictEqual(await f.call(c.tool, { ...args, override }, admin), result);
      assert.deepEqual(audit(f.store, task.id), { outcome: 'returned', ...Object.fromEntries(c.fields.map(key => [key, value])), ...(c.code ? { code: 'CURRENT_OPERATION' } : {}) });
      assert.deepEqual(result, before, 'audit extraction must not mutate the public return value');
      const events = f.store.events(task.id);
      assert.strictEqual(await f.call(c.tool, args, owner), result);
      assert.deepEqual(f.store.events(task.id), events, 'ordinary calls create no override audit');
      assert.deepEqual(calls[1], calls[0], 'override is stripped without changing business arguments');
      assert.equal(JSON.stringify(calls).includes('Inspect operation outcome'), false);

      if (c.code) {
        delete operation.code;
        delete result.code;
        assert.strictEqual(await f.call(c.tool, { ...args, override }, admin), result);
        assert.equal(audit(f.store, task.id).code, 'CURRENT_FALLBACK', 'current operation error.code is preserved');
        delete operation.error;
        if (!c.nested) delete result.error;
        await f.call(c.tool, { ...args, override }, admin);
        assert.equal(Object.hasOwn(audit(f.store, task.id), 'code'), false, 'task error is not an operation error');
      }
    });
  }
}

const cancellationCases = [
  ...['completed', 'failed', 'cancelled'].map(status => ({ name: `terminal ${status}`, patch: { status }, cancel: { accepted: false, alreadyFinished: true }, status })),
  ...[PROJECT_WAITING, PROJECT_PAUSING, PROJECT_PAUSED].map(status => ({ name: `project ${status}`, patch: { status, project: { status } }, project: true, cancel: { accepted: true, confirmed: true, cancelled: [] }, status: 'cancelled' })),
  { name: 'queued before dispatch', patch: { status: 'queued', sessionId: null, dispatchReceiptAt: null }, cancel: { accepted: true }, status: 'cancelled' },
  { name: 'queued without stop proof', patch: { status: 'queued', dispatchStarted: true, activeJobs: 1, stopConfirmed: false }, cancel: { accepted: true }, status: 'unknown' },
  { name: 'awaiting approval with stop proof', patch: { status: 'awaiting_approval' }, cancel: { accepted: true }, status: 'cancelled' },
  { name: 'not dispatched without running handle', patch: { status: 'starting', dispatchStarted: false }, cancel: { accepted: true }, status: 'cancelled' },
  { name: 'not dispatched with running handle', patch: { status: 'starting', dispatchStarted: false, stopConfirmed: false }, running: true, cancel: { accepted: true }, status: 'cancelling' },
  { name: 'dispatched confirmed', patch: { status: 'running', dispatchStarted: true }, adapter: true, cancel: { accepted: true, stopConfirmed: true, remaining: [] }, status: 'cancelled' },
  { name: 'dispatched unconfirmed', patch: { status: 'running', dispatchStarted: true }, adapter: true, cancel: { accepted: false, stopConfirmed: false, remaining: ['job'], code: 'CURRENT_CANCEL' }, status: 'cancelling' },
];

for (const c of cancellationCases) {
  for (const overridden of [true, false]) {
    test(`cancel ${c.name}, override=${overridden}, has a distinct operation result`, async t => {
      const f = fixture(t), task = f.seed({ accepted: !c.cancel.accepted, ...c.patch });
      let projectCalls = 0, adapterCalls = 0;
      if (c.project) f.service.projects = {
        async requestProjectCancel(id, reason) {
          projectCalls++;
          assert.equal(id, task.id); assert.equal(reason, 'stop');
          f.store.update(id, { status: 'cancelled' });
          return c.cancel;
        },
      };
      if (c.adapter) f.adapter.cancel = async current => { adapterCalls++; assert.equal(current.id, task.id); return c.cancel; };
      if (c.running) f.service.running.set(task.id, {});
      const result = await f.call('bridge_cancel', { taskId: task.id, reason: 'stop', ...(overridden ? { override } : {}) }, overridden ? admin : owner);
      assert.deepEqual(result.cancel, c.cancel);
      assert.equal(result.status, c.status);
      assert.equal(result.accepted, !c.cancel.accepted, 'task acknowledgement remains in the task projection');
      assert.equal(Object.hasOwn(result, 'alreadyFinished'), false);
      assert.deepEqual(result.error, f.store.get(task.id).error, 'the task projection stays intact');
      assert.equal(projectCalls, Number(Boolean(c.project)));
      assert.equal(adapterCalls, Number(Boolean(c.adapter)));
      if (overridden) assert.deepEqual(audit(f.store, task.id), { outcome: 'returned', accepted: c.cancel.accepted, ...(c.cancel.code ? { code: c.cancel.code } : {}) });
      else assert.equal(f.store.events(task.id).some(event => event.type.startsWith('task/override')), false);
    });
  }
}

for (const kind of ['clarify', 'followup']) {
  test(`real ${kind} replay excludes historical error and acknowledgement without changing the return`, async t => {
    const f = fixture(t);
    const task = f.seed(kind === 'clarify' ? { status: 'awaiting_approval', understandingHash: 'hash' } : {});
    const args = kind === 'clarify'
      ? { taskId: task.id, revision: 1, understandingHash: 'hash', clarificationId: 'clarify-once', text: 'Clarify scope' }
      : { taskId: task.id, revision: 1, afterAttemptId: task.attemptId, followupId: 'follow-once', text: 'Explain evidence' };
    const first = await f.call(`bridge_${kind}`, { ...args, override }, admin);
    assert.notEqual(first.attemptId, task.attemptId);
    assert.deepEqual(audit(f.store, task.id), { outcome: 'returned', ...(kind === 'followup' ? { replay: false } : {}) });
    f.store.update(task.id, { status: 'failed', accepted: true, error: { code: 'OLD_ATTEMPT_ERROR' } });
    const state = f.store.get(task.id);
    const replay = await f.call(`bridge_${kind}`, { ...args, override }, admin);
    assert.deepEqual(audit(f.store, task.id), { outcome: 'returned', replay: true });
    assert.equal(replay.accepted, true);
    assert.equal(replay.error.code, 'OLD_ATTEMPT_ERROR');
    assert.deepEqual(f.store.get(task.id), state, 'replaying must not advance or rewrite a round');
    const events = f.store.events(task.id);
    assert.deepEqual(await f.call(`bridge_${kind}`, args, owner), replay);
    assert.deepEqual(f.store.events(task.id), events);
  });
}

test('real acknowledgement and returned archive error keep their operation semantics', async t => {
  const f = fixture(t), task = f.seed();
  for (const accepted of [false, true]) {
    const result = await f.call('bridge_acknowledge', { taskId: task.id, revision: 1, accepted, override }, admin);
    assert.equal(result.accepted, accepted);
    assert.deepEqual(audit(f.store, task.id), { outcome: 'returned', accepted });
  }
  f.adapter.archive = async () => { throw Object.assign(new Error('archive failed now'), { code: 'CURRENT_ARCHIVE_ERROR' }); };
  const archived = await f.call('bridge_archive', { taskId: task.id, revision: 1, override }, admin);
  assert.equal(archived.archived, false);
  assert.equal(archived.error.code, 'CURRENT_ARCHIVE_ERROR');
  assert.deepEqual(audit(f.store, task.id), { outcome: 'returned', archived: false, code: 'CURRENT_ARCHIVE_ERROR' });
});

test('thrown cancellation errors audit the current error and preserve rejection identity', async t => {
  const f = fixture(t), task = f.seed({ status: 'running', dispatchStarted: true });
  const failure = Object.assign(new Error('cancel failed now'), { code: 'CURRENT_CANCEL_ERROR' });
  f.adapter.cancel = async () => { throw failure; };
  await assert.rejects(f.call('bridge_cancel', { taskId: task.id, override }, admin), error => error === failure);
  assert.deepEqual(audit(f.store, task.id), { outcome: 'threw', code: 'CURRENT_CANCEL_ERROR' });
  const events = f.store.events(task.id).filter(event => event.type.startsWith('task/override'));
  await assert.rejects(f.call('bridge_cancel', { taskId: task.id }, owner), error => error === failure);
  assert.deepEqual(f.store.events(task.id).filter(event => event.type.startsWith('task/override')), events);
});

test('bridge version 2.0.0 is advertised by capabilities and MCP initialization', async () => {
  assert.equal(BRIDGE_VERSION, '2.0.0');
  const service = { adapter: { capabilities: async () => ({ adapterVersion: '0.6.0' }) } };
  const capabilities = await createDispatcher(service)('bridge_capabilities', {}, owner);
  assert.equal(capabilities.version, '2.0.0');
  assert.equal(capabilities.adapterVersion, '0.6.0');
  const handler = createMcpHandler(service, { registry: { ids: owner.controllerIds, authenticate: () => owner.principal } });
  const request = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))]);
  Object.assign(request, { method: 'POST', headers: { host: '127.0.0.1' } });
  let response;
  await handler(request, {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { response = JSON.parse(body); },
  });
  assert.equal(response.result.serverInfo.version, '2.0.0');
});
