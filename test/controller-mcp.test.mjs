import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { loadControllerRegistry } from '../src/controller-auth.mjs';
import { createDispatcher, createMcpHandler, TOOLS, validateToolPolicies } from '../src/mcp.mjs';
import { TaskStore } from '../src/store.mjs';
import { BridgeService } from '../src/service.mjs';
import { validatePacket } from '../src/contracts.mjs';

const ids = ['claude-code', 'codex', 'legacy', 'operator'];
const context = (id = 'codex', admin = false, via = null) => ({ principal: { id, admin }, via, controllerIds: ids });
const override = { reason: '  Inspect task  ' };
const tokens = Object.fromEntries(ids.map(id => [id, `${id}-`.padEnd(64, 'x')]));

function packet(directory, key, extra = {}) {
  return { schemaVersion: 1, idempotencyKey: key, revision: 1, projectId: 'identity', title: key, objective: 'read one file', cwd: directory, role: 'investigate', acceptance: ['evidence'], scope: { readRoots: [directory], writeRoots: [], allowedTools: ['read'], allowShell: false, allowNetwork: false, allowDelegation: false }, materials: [], contractVersion: '1', ...extra };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-mcp-'));
  const store = new TaskStore({ directory, ownerId: 'owner' });
  const counts = { adapter: 0, workspace: 0, business: 0 };
  const adapter = {
    models: async () => [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
    capabilities: async () => ({ existing: true, lifecycle: { followup: { supported: true } }, controllerIdentity: { self: 'untrusted-adapter' } }),
    preflight: async () => { counts.adapter++; return { ok: true }; },
    followup: async () => { counts.adapter++; }, reconsider: async () => { counts.adapter++; },
  };
  const service = new BridgeService({ store, adapter });
  service.kick = () => {};
  const seed = (submittedBy, key = `seed-${store.list().length}`, extra = {}) => {
    const task = store.submit(validatePacket(packet(directory, key, extra)), { submittedBy, via: null }).task;
    return store.update(task.id, { status: 'completed', sessionId: `s-${task.id}`, requestId: 'request', dispatchReceiptAt: 1, workspace: { repository: directory, head: 'head' }, review: { passed: true, head: 'head' }, result: { text: 'original answer', evidence: [], checks: [], uncertainties: [] } });
  };
  const controllers = ids.map(id => {
    const tokenFile = path.join(directory, `${id}.token`);
    fs.writeFileSync(tokenFile, tokens[id]);
    return { id, tokenFile, admin: id === 'operator' };
  });
  const registry = loadControllerRegistry(controllers);
  const marker = path.join(directory, 'workspace-marker');
  fs.writeFileSync(marker, 'unchanged');
  const snapshot = () => ({ tasks: store.list({ includeArchived: true }), events: store.db.prepare('SELECT * FROM events ORDER BY seq').all(), marker: fs.readFileSync(marker, 'utf8'), counts: { ...counts } });
  t.after(() => { service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, seed, counts, marker, snapshot, controllers, registry };
}

function argsFor(name, task, directory) {
  const base = { taskId: task.id };
  switch (name) {
    case 'bridge_submit': return { packet: packet(directory, 'submitted') };
    case 'bridge_approve': return { ...base, revision: 1, understandingHash: 'hash' };
    case 'bridge_clarify': return { ...base, revision: 1, understandingHash: 'hash', clarificationId: 'clarify-1', text: 'clarify' };
    case 'bridge_followup': return { ...base, revision: 1, afterAttemptId: task.attemptId, followupId: 'follow-1', text: 'follow' };
    case 'bridge_pause': case 'bridge_resume': return { ...base, requestId: 'request' };
    case 'bridge_acknowledge': case 'bridge_archive': return { ...base, revision: 1 };
    case 'bridge_cleanup': return { ...base, dryRun: true };
    case 'bridge_workspace_review': return { ...base, head: 'head', contractVersion: '1', passed: true, checks: [] };
    case 'bridge_workspace_refresh': return { ...base, targetRepository: directory, expectedTargetHead: 'head' };
    case 'bridge_workspace_integrate': return { ...base, targetRepository: directory, contractVersion: '1' };
    case 'bridge_list': case 'bridge_models': case 'bridge_capabilities': return {};
    default: return base;
  }
}

function recordBusiness(f) {
  const mutation = (id, options) => {
    assert.equal(Object.hasOwn(options ?? {}, 'override'), false);
    f.counts.business++;
    f.counts.adapter++;
    f.store.update(id, { businessCalls: f.counts.business });
    return { accepted: true, cleaned: false, eligible: true, replay: false };
  };
  for (const name of ['approve', 'clarify', 'followup', 'cancel', 'pause', 'resume', 'reconcile', 'acknowledge', 'cleanup', 'archive']) f.service[name] = mutation;
  f.service.workspaces = Object.fromEntries(['review', 'refresh', 'integrate'].map(name => [name, (workspace, options) => {
    assert.equal(Object.hasOwn(options, 'override'), false);
    f.counts.workspace++;
    fs.writeFileSync(f.marker, String(f.counts.workspace));
    return { passed: true, head: 'head', refreshed: false, accepted: true, merged: false };
  }]));
}

test('all 20 policies are explicit and invalid registries fail at dispatcher construction', () => {
  assert.deepEqual(Object.fromEntries(['read', 'submit', 'mutate'].map(category => [category, TOOLS.filter(t => t.category === category).length])), { read: 6, submit: 1, mutate: 13 });
  for (const tools of [[{ name: 'missing' }], [{ name: 'unknown', category: 'execute' }], [TOOLS[0], TOOLS[0]]]) assert.throws(() => validateToolPolicies(tools), { code: 'TOOL_POLICY_INVALID' });
  TOOLS.push({ name: 'unclassified' });
  try { assert.throws(() => createDispatcher({}), { code: 'TOOL_POLICY_INVALID' }); }
  finally { TOOLS.pop(); }
  for (const tool of TOOLS) assert.equal(Object.hasOwn(tool.inputSchema.properties, 'override'), tool.category === 'mutate');
});

const callers = [context('claude-code'), context('codex'), context('operator', true), context('legacy'), context('legacy', true), context('claude-code', false, { chain: ['claude-code', 'codex'], rootTask: 'root' }), context('codex', false, { chain: ['codex', 'claude-code'], rootTask: 'root' })];
for (const [index, caller] of callers.entries()) {
  test(`permission matrix row ${index + 1} ${caller.principal.id} admin=${caller.principal.admin} via=${Boolean(caller.via)}`, async t => {
    const f = fixture(t);
    recordBusiness(f);
    const call = createDispatcher(f.service);
    const owner = caller.principal.id;
    const foreign = owner === 'codex' ? 'claude-code' : 'codex';
    const parents = [owner, foreign, null].map((id, i) => f.seed(id, `parent-${i}`));
    const targets = [...parents, ...parents.map((parent, i) => f.seed(parent.submittedBy, `internal-${i}`, { parentTaskId: parent.id }))];
    for (const tool of TOOLS) for (const target of targets) for (const supplied of [false, true]) {
      if (tool.name === 'bridge_workspace_integrate') f.store.update(target.id, { review: { passed: true, head: 'head' } });
      const args = { ...argsFor(tool.name, target, f.directory), ...(supplied ? { override } : {}) };
      let code;
      if (supplied && (tool.category !== 'mutate' || !caller.principal.admin)) code = 'OVERRIDE_NOT_PERMITTED';
      else if (tool.category === 'mutate' && target.submittedBy !== owner && !supplied) code = caller.principal.admin ? 'OVERRIDE_REASON_REQUIRED' : 'TASK_NOT_OWNED';
      const before = f.snapshot();
      if (code) {
        await assert.rejects(call(tool.name, args, caller), { code }, `${tool.name}, owner ${target.submittedBy}, override ${supplied}`);
        assert.deepEqual(f.snapshot(), before, 'denied calls preserve bodies, events, rounds, workspace and adapter counts');
      } else {
        const result = await call(tool.name, args, caller);
        if (tool.category === 'submit') assert.equal(result.submittedBy, owner);
        if (tool.category === 'mutate') {
          assert.equal(f.counts.business + f.counts.workspace, before.counts.business + before.counts.workspace + 1);
          const events = f.store.events(target.id, { limit: 1000 });
          if (supplied) {
            const [intent, outcome] = events.slice(-2);
            assert.equal(intent.type, 'task/override');
            assert.equal(intent.actor, owner);
            assert.equal(intent.submittedBy, target.submittedBy);
            assert.equal(intent.reason, 'Inspect task');
            assert.equal(intent.tool, tool.name);
            assert.deepEqual(intent.via, caller.via);
            assert.equal(outcome.type, 'task/override-result');
            assert.equal(outcome.operationId, intent.operationId);
            assert.equal(outcome.outcome, 'returned');
          } else assert.equal(f.snapshot().events.length, before.events.length);
        }
      }
    }
  });
}

test('override validation precedes target reads and never leaks arbitrary override data', async t => {
  const f = fixture(t), task = f.seed('codex'), call = createDispatcher(f.service);
  const invalid = [null, [], 'reason', 1, {}, { reason: '' }, { reason: ' \t' }, { reason: 5 }, { reason: 'x'.repeat(501) }, { reason: 'ok', extra: true }];
  const before = f.snapshot();
  for (const value of invalid) {
    await assert.rejects(call('bridge_cancel', { taskId: task.id, override: value }, context()), { code: 'OVERRIDE_NOT_PERMITTED' });
    const code = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => k === 'reason') && (value.reason === undefined || typeof value.reason === 'string' && !value.reason.trim()) ? 'OVERRIDE_REASON_REQUIRED' : 'INVALID_ARGUMENTS';
    await assert.rejects(call('bridge_cancel', { taskId: 'missing', override: value }, context('operator', true)), { code });
  }
  await assert.rejects(call('bridge_cancel', { taskId: 'missing', override }, context('operator', true)), { code: 'TASK_NOT_FOUND' });
  await assert.rejects(call('bridge_cancel', { taskId: 'missing' }, context()), { code: 'TASK_NOT_FOUND' });
  await assert.rejects(call('bridge_cancel', { taskId: 5, override }, context()), { code: 'INVALID_ARGUMENTS' });
  for (const caller of [undefined, {}, { ...context(), principal: {} }, { ...context(), principal: { id: 'codex' } }]) await assert.rejects(call('bridge_capabilities', {}, caller), { code: 'AUTH_UNAVAILABLE' });
  assert.throws(() => createMcpHandler(f.service), { code: 'AUTH_UNAVAILABLE' });
  assert.deepEqual(f.snapshot(), before);
  recordBusiness(f);
  await call('bridge_cancel', { taskId: task.id, override: { reason: 'x'.repeat(500) } }, context('operator', true));
  assert.equal(f.store.events(task.id).at(-2).reason.length, 500);
  const foreignStore = new TaskStore({ directory: f.directory, ownerId: 'different-bridge' });
  const foreignTask = foreignStore.submit(validatePacket(packet(f.directory, 'foreign-bridge')), { submittedBy: 'codex', via: null }).task;
  foreignStore.close();
  await assert.rejects(call('bridge_cancel', { taskId: foreignTask.id, override }, context('operator', true)), { code: 'TASK_NOT_FOUND' });
});

test('override audit intent is durable before synchronous followup and result captures failures', async t => {
  const f = fixture(t), task = f.seed('codex'), call = createDispatcher(f.service);
  let entered = false;
  f.service.followup = (id, options) => {
    entered = true;
    assert.deepEqual(Object.keys(options).sort(), ['afterAttemptId', 'followupId', 'revision', 'text']);
    assert.equal(f.store.events(id).at(-1).type, 'task/override');
    throw Object.assign(new Error('real business gate'), { code: 'FOLLOWUP_CONFLICT' });
  };
  const pending = call('bridge_followup', { ...argsFor('bridge_followup', task, f.directory), override }, context('operator', true));
  assert.equal(entered, true, 'no asynchronous boundary before the service entry');
  await assert.rejects(pending, { code: 'FOLLOWUP_CONFLICT' });
  assert.equal(f.store.events(task.id).at(-1).code, 'FOLLOWUP_CONFLICT');
  assert.equal(f.store.events(task.id).at(-1).outcome, 'threw');
  const event = f.store.event.bind(f.store);
  f.store.event = () => { throw new Error('audit disk failure'); };
  entered = false;
  await assert.rejects(call('bridge_followup', { ...argsFor('bridge_followup', task, f.directory), override }, context('operator', true)), { code: 'OVERRIDE_AUDIT_FAILED' });
  assert.equal(entered, false);
  f.store.event = (id, entry) => { if (entry.type === 'task/override-result') throw new Error('result disk failure'); return event(id, entry); };
  await assert.rejects(call('bridge_followup', { ...argsFor('bridge_followup', task, f.directory), override }, context('operator', true)), { code: 'OVERRIDE_AUDIT_INCOMPLETE' });
  assert.equal(entered, true);
  assert.equal(f.store.events(task.id).at(-1).type, 'task/override');
  f.service.followup = () => ({ accepted: false });
  await assert.rejects(call('bridge_followup', { ...argsFor('bridge_followup', task, f.directory), override }, context('operator', true)), { code: 'OVERRIDE_AUDIT_INCOMPLETE' });
  f.store.event = event;
  await call('bridge_followup', { ...argsFor('bridge_followup', task, f.directory), override }, context('operator', true));
  // S4 C9: a follow-up's audit outcome records only `replay`; task-level `accepted` is not copied.
  const last = f.store.events(task.id).at(-1);
  assert.equal(last.type, 'task/override-result');
  assert.equal(last.outcome, 'returned');
  assert.equal(Object.hasOwn(last, 'accepted'), false);
});

test('real followup replay is authorized first, retains history and audits new/current attempts', async t => {
  const f = fixture(t), call = createDispatcher(f.service);
  for (const submittedBy of ['codex', null]) {
    const task = f.seed(submittedBy);
    const args = { ...argsFor('bridge_followup', task, f.directory), override };
    const first = await call('bridge_followup', args, context('operator', true));
    assert.notEqual(first.attemptId, task.attemptId);
    assert.equal(f.store.get(task.id).submittedBy, submittedBy);
    const intent = f.store.events(task.id).find(e => e.type === 'task/override');
    assert.equal(intent.attemptId, task.attemptId);
    assert.equal(f.store.events(task.id).at(-1).attemptId, first.attemptId);
    assert.equal(f.service.result(task.id, { attemptId: task.attemptId }).text, 'original answer');
    const before = f.snapshot();
    const { override: ignored, ...plain } = args;
    await assert.rejects(call('bridge_followup', plain, context('claude-code')), { code: 'TASK_NOT_OWNED' });
    assert.deepEqual(f.snapshot(), before);
    const replay = await call('bridge_followup', { ...args, override: { reason: 'new reason' } }, context('operator', true, { chain: ['dsh'], rootTask: null }));
    assert.equal(replay.followup.replay, true);
    assert.equal(f.store.events(task.id).at(-1).replay, true);
    assert.equal(f.store.get(task.id).followups.length, 1);
    await assert.rejects(call('bridge_followup', { ...args, text: 'changed' }, context('operator', true)), { code: 'FOLLOWUP_IDEMPOTENCY_CONFLICT' });
    await assert.rejects(call('bridge_followup', { ...args, followupId: 'new-id' }, context('operator', true)), { code: 'FOLLOWUP_CONFLICT' });
    assert.equal(f.store.get(task.id).followups.length, 1);
  }
});

test('real clarification replay is authorized first and strips override before synchronous entry', async t => {
  const f = fixture(t), task = f.seed('codex');
  f.store.update(task.id, { status: 'awaiting_approval', understandingHash: 'hash' });
  const call = createDispatcher(f.service), args = { ...argsFor('bridge_clarify', task, f.directory), override };
  const pending = call('bridge_clarify', args, context('operator', true));
  assert.equal(f.store.get(task.id).clarifications.length, 1);
  await pending;
  const before = f.snapshot();
  const { override: ignored, ...plain } = args;
  await assert.rejects(call('bridge_clarify', plain, context('claude-code')), { code: 'TASK_NOT_OWNED' });
  assert.deepEqual(f.snapshot(), before);
  const replay = await call('bridge_clarify', args, context('operator', true));
  assert.equal(replay.clarificationReplay, true);
  assert.equal(f.store.events(task.id).at(-1).replay, true);
});

test('administrator overrides preserve real followup lifecycle gates and audit each rejected operation', async t => {
  const f = fixture(t), call = createDispatcher(f.service);
  const cases = [
    { extra: { role: 'implement' }, code: 'FOLLOWUP_ROLE_FORBIDDEN' },
    { extra: { metadata: { supervisorProject: 'project' } }, code: 'FOLLOWUP_UNSUPPORTED_TASK' },
    { extra: { understandingRequired: true }, code: 'FOLLOWUP_UNSUPPORTED_TASK' },
    { args: { revision: 2 }, code: 'FOLLOWUP_CONFLICT' },
    { args: { afterAttemptId: 'stale' }, code: 'FOLLOWUP_CONFLICT' },
    { changes: { archivedAt: 1 }, code: 'FOLLOWUP_ARCHIVED' },
    { changes: { stopConfirmed: false }, code: 'SESSION_NOT_READY' },
    { changes: { activeJobs: 1 }, code: 'SESSION_NOT_READY' },
    { changes: { activeChildren: 1 }, code: 'SESSION_NOT_READY' },
  ];
  for (const [index, entry] of cases.entries()) {
    const task = f.seed('codex', `gate-${index}`, entry.extra);
    if (entry.changes) f.store.update(task.id, entry.changes);
    const before = f.store.get(task.id);
    await assert.rejects(call('bridge_followup', { ...argsFor('bridge_followup', task, f.directory), ...entry.args, override }, context('operator', true)), { code: entry.code });
    assert.deepEqual(f.store.get(task.id), before);
    const [intent, outcome] = f.store.events(task.id).slice(-2);
    assert.equal(intent.type, 'task/override');
    assert.equal(outcome.operationId, intent.operationId);
    assert.equal(outcome.outcome, 'threw');
    assert.equal(outcome.code, entry.code);
  }
  assert.equal(f.counts.adapter, 0);
});

test('pause and resume audits capture operation outcomes separately from task acceptance', async t => {
  const f = fixture(t), task = f.seed('codex');
  f.store.update(task.id, { accepted: false, project: { grant: { pause: true } } });
  f.service.projects = {
    pauseRequest: () => ({ accepted: true, replay: true }),
    resumeRequest: () => ({ accepted: false, replay: true, code: 'project/budget-exhausted' }),
  };
  const call = createDispatcher(f.service);
  await call('bridge_pause', { taskId: task.id, requestId: 'pause', override }, context('operator', true));
  const pause = f.store.events(task.id).at(-1);
  assert.equal(pause.accepted, true);
  assert.equal(pause.replay, true);
  assert.equal(pause.outcome, 'returned');
  await call('bridge_resume', { taskId: task.id, requestId: 'resume', override }, context('operator', true));
  const resume = f.store.events(task.id).at(-1);
  assert.equal(resume.accepted, false);
  assert.equal(resume.replay, true);
  assert.equal(resume.code, 'project/budget-exhausted');
  assert.equal(resume.outcome, 'returned');
});

test('archive returned errors retain their code and returned audit outcome', async t => {
  const f = fixture(t), task = f.seed('codex');
  f.store.update(task.id, { resultCollected: true, artifactState: 'preserved' });
  f.service.adapter.archive = async () => { throw Object.assign(new Error('host archive unavailable'), { code: 'HOST_ARCHIVE_UNAVAILABLE' }); };
  const result = await createDispatcher(f.service)('bridge_archive', { taskId: task.id, revision: 1, override }, context('operator', true));
  assert.equal(result.archived, false);
  const audit = f.store.events(task.id).at(-1);
  assert.equal(audit.archived, false);
  assert.equal(audit.code, 'HOST_ARCHIVE_UNAVAILABLE');
  assert.equal(audit.outcome, 'returned');
});

async function serve(t, f, registry = f.registry) {
  const server = http.createServer(createMcpHandler(f.service, { registry }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (name, args = {}, { id = 'codex', headers = {}, raw, token = tokens[id] } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, body: raw ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return { status: response.status, body: await response.json() };
  };
}

test('HTTP unknown credentials cover every tool and override/ownership cell without side effects', async t => {
  const f = fixture(t), request = await serve(t, f);
  const own = f.seed('codex'), foreign = f.seed('claude-code'), historical = f.seed(null);
  const targets = [own, foreign, historical, ...[own, foreign, historical].map(parent => f.seed(parent.submittedBy, undefined, { parentTaskId: parent.id }))];
  const before = f.snapshot();
  for (const tool of TOOLS) for (const target of targets) for (const supplied of [false, true]) {
    const response = await request(tool.name, { ...argsFor(tool.name, target, f.directory), ...(supplied ? { override } : {}) }, { token: 'unknown', headers: { 'X-Agent-Bridge-Root-Task': 'invalid-combination' } });
    assert.deepEqual(response, { status: 401, body: { error: 'unauthorized' } });
  }
  assert.deepEqual(f.snapshot(), before);
});

test('HTTP capabilities preserve existing fields and concurrent callers keep request-local identity', async t => {
  const f = fixture(t), request = await serve(t, f);
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => {
    const id = ids[i % ids.length];
    return request('bridge_capabilities', {}, { id }).then(response => ({ id, response }));
  }));
  for (const { id, response } of responses) {
    assert.equal(response.status, 200);
    const value = response.body.result.structuredContent;
    assert.equal(value.existing, true);
    assert.deepEqual(value.lifecycle.followup, { supported: true });
    assert.deepEqual(value.controllerIdentity, { enabled: true, schemaVersion: 1, self: id, admin: id === 'operator', controllers: ids, ownership: 'credential-principal', delegation: 'inherit-root-credential', legacyTaskOwner: null, override: { requiredForForeignTasks: true, reasonMaxChars: 500 }, via: { source: 'client-declared', authorizes: false } });
    for (const token of Object.values(tokens)) assert.equal(JSON.stringify(response.body).includes(token), false);
    assert.equal(JSON.stringify(response.body).includes('tokenFile'), false);
  }
});

test('HTTP binds real submissions, namespaces idempotency and keeps first via despite forged hints', async t => {
  const f = fixture(t), request = await serve(t, f);
  const parent = f.seed('claude-code');
  const p = packet(f.directory, 'same-key', { parentTaskId: parent.id, metadata: { controller: 'operator', submittedBy: 'operator' } });
  const headers = { 'X-Agent-Bridge-Chain': 'claude-code>codex', 'X-Agent-Bridge-Root-Task': 'root' };
  const [a, b] = await Promise.all(['codex', 'claude-code'].map(id => request('bridge_submit', { packet: p }, { id, headers })));
  const codex = a.body.result.structuredContent, claude = b.body.result.structuredContent;
  assert.equal(codex.submittedBy, 'codex');
  assert.equal(claude.submittedBy, 'claude-code');
  assert.notEqual(codex.id, claude.id);
  const replay = (await request('bridge_submit', { packet: p })).body.result.structuredContent;
  assert.equal(replay.id, codex.id);
  assert.deepEqual(replay.via, { chain: ['claude-code', 'codex'], rootTask: 'root' });
  const root = (await request('bridge_submit', { packet: packet(f.directory, 'root') })).body.result.structuredContent;
  assert.equal(root.via, null);
  const conflict = (await request('bridge_submit', { packet: { ...p, title: 'changed' } })).body.result;
  assert.equal(JSON.parse(conflict.content[0].text).code, 'IDEMPOTENCY_CONFLICT');
  const denied = await request('bridge_cancel', { taskId: claude.id }, { headers });
  assert.equal(denied.status, 200);
  assert.deepEqual(JSON.parse(denied.body.result.content[0].text), { code: 'TASK_NOT_OWNED', message: 'Task is owned by another controller', details: { field: 'taskId', expected: 'task owned by authenticated controller' } });
  for (const submittedBy of ['codex', 'claude-code', 'retired-controller', null]) {
    const result = (await request('bridge_list', { submittedBy })).body.result.structuredContent;
    assert.ok(result.tasks.every(task => task.submittedBy === submittedBy));
  }
  for (const submittedBy of [5, '', 'Bad-ID']) {
    assert.equal(JSON.parse((await request('bridge_list', { submittedBy })).body.result.content[0].text).code, 'INVALID_ARGUMENTS');
  }
});

test('HTTP via errors precede tools, JSON errors precede via, and retired legacy credentials return 401', async t => {
  const f = fixture(t), request = await serve(t, f);
  const historical = f.seed(null);
  const bad = await request('unknown-tool', {}, { headers: { 'X-Agent-Bridge-Root-Task': 'alone' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'VIA_INVALID');
  assert.equal(bad.body.error, 'invalid via');
  assert.deepEqual(Object.keys(bad.body.details).sort(), ['expected', 'field']);
  const json = await request('unknown-tool', {}, { raw: '{', headers: { 'X-Agent-Bridge-Chain': 'bad' } });
  assert.equal(json.body.error.code, -32700);
  const duplicate = await request('bridge_capabilities', {}, { headers: { 'X-Agent-Bridge-Chain': 'codex, codex' } });
  assert.equal(duplicate.status, 400);
  const retired = await serve(t, f, loadControllerRegistry(f.controllers.filter(c => c.id !== 'legacy')));
  assert.deepEqual(await retired('bridge_result', { taskId: historical.id }, { id: 'legacy' }), { status: 401, body: { error: 'unauthorized' } });
  assert.equal((await retired('bridge_result', { taskId: historical.id })).body.result.structuredContent.text, 'original answer');
});
