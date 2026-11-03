// D2 permission regressions: the complete p0b-v1 section 9 matrix through the REAL
// HTTP entry (createMcpHandler), a real SQLite TaskStore and the real BridgeService.
//
// Unlike test/controller-mcp.test.mjs (which drives most matrix cells through the
// dispatcher with business seams stubbed), this file enters through fetch(), resolves
// the principal from a real controller registry and lets the real service mutate real
// task records. Only the workspace manager, the long-task pause/resume runtime and the
// host adapter are bounded fakes, because those are external side-effect counters here
// (git worktrees and model sessions are not part of an identity regression).
//
// Complementing evidence that this file deliberately does not duplicate:
//   * controller-mcp.test.mjs: dispatcher-level matrix, oversized override list,
//     synchronous followup/clarify audit timing, HTTP submit/list/via cases.
//   * controller-auth.test.mjs: registry format/cardinality, via header parser and
//     bootstrap ordering.
//   * controller-store/service/lifecycle tests: store-level immutability, supervisor
//     identity inheritance and real followup round preservation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';

import { loadControllerRegistry } from '../src/controller-auth.mjs';
import { createMcpHandler, TOOLS } from '../src/mcp.mjs';
import { TaskStore } from '../src/store.mjs';
import { BridgeService } from '../src/service.mjs';
import { digest, validatePacket } from '../src/contracts.mjs';

// Contract section 10: every test temporary directory lives outside the worktree.
const TEMP_ROOT = 'F:/temp/agent-bridge-upstream';

const ROSTER = [
  { id: 'claude-code', admin: false, token: `claude-code-test-${'a'.repeat(40)}` },
  { id: 'codex', admin: false, token: `codex-test-${'b'.repeat(40)}` },
  { id: 'operator', admin: true, token: `operator-test-${'c'.repeat(40)}` },
  { id: 'legacy', admin: false, token: `legacy-test-${'d'.repeat(40)}` },
  { id: 'legacy-admin', admin: true, token: `legacy-admin-test-${'e'.repeat(36)}` },
];
const TOKEN = Object.fromEntries(ROSTER.map(entry => [entry.id, entry.token]));
const ADMIN = Object.fromEntries(ROSTER.map(entry => [entry.id, entry.admin]));
const IDS = ROSTER.map(entry => entry.id).sort();

const TASK_READS = ['bridge_check', 'bridge_result', 'bridge_dossier'];
const ALL_READS = [...TASK_READS, 'bridge_list', 'bridge_models', 'bridge_capabilities'];
const MUTATES = TOOLS.filter(tool => tool.category === 'mutate').map(tool => tool.name);
const OVERRIDE = { reason: '  Inspect task  ' };
const PERMISSION_CODES = new Set(['TASK_NOT_OWNED', 'OVERRIDE_NOT_PERMITTED', 'OVERRIDE_REASON_REQUIRED']);

// Every mutate tool's seeded precondition. `completed` carries a settled session and a
// result so reads, followup, reconcile, cleanup and archive are genuinely eligible.
const STATE = {
  bridge_approve: 'awaiting',
  bridge_clarify: 'awaiting',
  bridge_followup: 'completed',
  bridge_cancel: 'queued',
  bridge_pause: 'project',
  bridge_resume: 'project',
  bridge_reconcile: 'completed',
  bridge_acknowledge: 'terminal',
  bridge_cleanup: 'completed',
  bridge_archive: 'archive',
  bridge_workspace_review: 'workspace',
  bridge_workspace_refresh: 'workspace',
  bridge_workspace_integrate: 'reviewed-workspace',
};

function packet(directory, key, extra = {}) {
  return {
    schemaVersion: 1, idempotencyKey: key, revision: 1, projectId: 'permissions',
    title: key, objective: 'read one file', cwd: directory, role: 'investigate',
    acceptance: ['evidence'],
    scope: { readRoots: [directory], writeRoots: [], allowedTools: ['read'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [], contractVersion: '1', ...extra,
  };
}

function fixture(t) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(TEMP_ROOT, 'controller-permissions-'));
  const store = new TaskStore({ directory, ownerId: 'owner' });
  const counts = { adapter: 0, preflight: 0, workspace: 0, project: 0 };
  const catalog = [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }];
  const adapter = {
    models: async () => { counts.adapter += 1; return catalog; },
    capabilities: async () => { counts.adapter += 1; return { existing: true, lifecycle: { followup: { supported: true } } }; },
    preflight: async () => { counts.preflight += 1; return { ok: true }; },
    inspect: async () => { counts.adapter += 1; return { status: 'unknown', stopConfirmed: false }; },
    archive: async task => { counts.adapter += 1; return { archived: true, uiHidden: true, sessionId: task.sessionId ?? null }; },
    cleanup: async () => { counts.adapter += 1; return { cleaned: true }; },
    followup: async () => { counts.adapter += 1; },
    reconsider: async () => { counts.adapter += 1; },
  };
  const service = new BridgeService({ store, adapter });
  // The matrix exercises authorization, not dispatch: no drain may run a model turn.
  service.kick = () => {};
  const marker = path.join(directory, 'worktree-marker');
  fs.writeFileSync(marker, 'unchanged');
  const count = () => { counts.workspace += 1; fs.writeFileSync(marker, String(counts.workspace)); };
  service.workspaces = {
    review: async (workspace, options) => {
      assert.equal(Object.hasOwn(options, 'override'), false);
      count();
      return { passed: true, head: 'head', contractVersion: '1', checks: [] };
    },
    refresh: async (workspace, options) => {
      assert.equal(Object.hasOwn(options, 'override'), false);
      count();
      return { refreshed: false, adopted: true, head: 'head' };
    },
    integrate: async (workspace, options) => {
      assert.equal(Object.hasOwn(options, 'override'), false);
      count();
      return { accepted: true, merged: false, head: 'head' };
    },
    remove: async () => { count(); return { removed: true }; },
  };
  service.projects = {
    status: () => ({ supported: true, enabled: true }),
    pauseRequest: () => { counts.project += 1; return { accepted: true, replay: false }; },
    resumeRequest: () => { counts.project += 1; return { accepted: true, replay: false }; },
    onTaskSettled: async () => {},
    onAnySettled: () => {},
    requestProjectCancel: async () => ({ accepted: true, stopConfirmed: true }),
  };
  const controllers = ROSTER.map(entry => {
    const tokenFile = path.join(directory, `${entry.id}.token`);
    fs.writeFileSync(tokenFile, entry.token);
    return { id: entry.id, tokenFile, admin: entry.admin };
  });
  const registry = loadControllerRegistry(controllers);
  t.after(() => {
    service.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, service, counts, marker, registry, controllers };
}

async function serve(t, f) {
  const server = http.createServer(createMcpHandler(f.service, { registry: f.registry }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return async (name, args = {}, { id = 'codex', headers = {}, token = TOKEN[id], raw } = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: raw ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { status: response.status, body: await response.json() };
  };
}

/** The structured outcome of one tools/call, including the MCP tool-domain error. */
function outcomeOf(response) {
  if (response.status !== 200) return { status: response.status, body: response.body };
  const result = response.body?.result;
  if (result?.isError === true) return { error: JSON.parse(result.content[0].text) };
  return { value: result?.structuredContent };
}

function globalSnapshot(f) {
  const tasks = f.store.db.prepare('SELECT id, body FROM tasks ORDER BY rowid').all();
  const events = f.store.db.prepare('SELECT seq, body FROM events ORDER BY seq').all();
  return {
    taskBodies: digest(tasks.map(row => row.body)),
    eventBodies: digest(events.map(row => row.body)),
    taskCount: tasks.length,
    marker: fs.readFileSync(f.marker, 'utf8'),
    counts: { ...f.counts },
  };
}

function targetSnapshot(f, task) {
  return {
    body: f.store.get(task.id),
    events: f.store.events(task.id, { limit: 1000 }),
    ...globalSnapshot(f),
  };
}

function applyState(f, task, kind) {
  const id = task.id;
  const sessionId = `session-${id}`;
  switch (kind) {
    case 'read':
    case 'completed':
      f.store.update(id, {
        status: 'completed', phase: 'completed', sessionId, requestId: `request-${id}`,
        dispatchStarted: true, dispatchReceiptAt: 1000, stopConfirmed: true, activeJobs: 0, activeChildren: 0,
        endedAt: Date.now() - 8 * 86_400_000, resultCollected: true, artifactState: 'none',
        stats: { toolCalls: 2 },
        effectiveModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
        result: { text: 'original answer', evidence: [{ source: 'dsh-host', kind: 'attempt-settlement', status: 'completed' }], checks: [], uncertainties: [] },
      });
      break;
    case 'terminal':
      f.store.update(id, {
        status: 'completed', phase: 'completed', sessionId, requestId: `request-${id}`,
        dispatchStarted: true, dispatchReceiptAt: 1000, stopConfirmed: true, activeJobs: 0, activeChildren: 0,
        endedAt: Date.now() - 8 * 86_400_000, artifactState: 'none',
        result: { text: 'terminal answer', evidence: [], checks: [], uncertainties: [] },
      });
      break;
    case 'awaiting':
      f.store.update(id, {
        status: 'awaiting_approval', phase: 'awaiting_approval', understanding: 'the plan',
        understandingHash: 'hash', sessionId, requestId: `request-${id}`, dispatchStarted: true,
        dispatchReceiptAt: 1000, dispatchPending: false, stopConfirmed: true, activeJobs: 0, activeChildren: 0,
      });
      break;
    case 'queued':
      // A queued task cancelled before dispatch is the real structural-zero path.
      f.store.update(id, { status: 'queued', phase: 'queued' });
      break;
    case 'project':
      f.store.update(id, {
        status: 'waiting', phase: 'project', project: { grant: { pause: true }, roundsUsed: 0, rounds: [] },
        stopConfirmed: true, activeJobs: 0, activeChildren: 0,
      });
      break;
    case 'workspace':
      f.store.update(id, {
        status: 'completed', phase: 'completed', sessionId, requestId: `request-${id}`,
        dispatchStarted: true, dispatchReceiptAt: 1000, stopConfirmed: true, activeJobs: 0, activeChildren: 0,
        resultCollected: true, artifactState: 'unresolved',
        workspace: { taskId: id, path: path.join(f.directory, `ws-${id}`), repository: f.directory, head: 'head', baseCommit: 'head', branch: 'task/test' },
      });
      break;
    case 'reviewed-workspace':
      applyState(f, f.store.get(id), 'workspace');
      f.store.update(id, { review: { passed: true, head: 'head', contractVersion: '1' } });
      break;
    case 'archive':
      f.store.update(id, {
        status: 'completed', phase: 'completed', sessionId, requestId: `request-${id}`,
        dispatchStarted: true, dispatchReceiptAt: 1000, stopConfirmed: true, activeJobs: 0, activeChildren: 0,
        resultCollected: true, artifactState: 'none',
      });
      break;
    default:
      throw new Error(`unknown seed state ${kind}`);
  }
}

function argsFor(name, task, directory) {
  const base = { taskId: task.id };
  switch (name) {
    case 'bridge_approve': return { ...base, revision: 1, understandingHash: 'hash' };
    case 'bridge_clarify': return { ...base, revision: 1, understandingHash: 'hash', clarificationId: 'clarify-1', text: 'clarify the plan' };
    case 'bridge_followup': return { ...base, revision: 1, afterAttemptId: task.attemptId, followupId: 'follow-1', text: 'what did you find?' };
    case 'bridge_cancel': return base;
    case 'bridge_pause': case 'bridge_resume': return { ...base, requestId: 'request-1' };
    case 'bridge_reconcile': return base;
    case 'bridge_acknowledge': return { ...base, revision: 1, accepted: false, artifactState: 'none' };
    case 'bridge_cleanup': return { ...base, dryRun: true };
    case 'bridge_archive': return { ...base, revision: 1 };
    case 'bridge_workspace_review': return { ...base, head: 'head', contractVersion: '1', passed: true, checks: [] };
    case 'bridge_workspace_refresh': return { ...base, targetRepository: directory, expectedTargetHead: 'head' };
    case 'bridge_workspace_integrate': return { ...base, targetRepository: directory, contractVersion: '1' };
    case 'bridge_list': case 'bridge_models': case 'bridge_capabilities': return {};
    case 'bridge_check': case 'bridge_result': case 'bridge_dossier': return base;
    default: return base;
  }
}

const CATEGORIES = ['own', 'foreign', 'historical', 'internal-own', 'internal-foreign', 'internal-null'];

function foreignOf(id) {
  return id === 'codex' ? 'claude-code' : 'codex';
}

function headersOf(row) {
  if (!row.via) return {};
  return {
    'X-Agent-Bridge-Chain': row.via.chain.join('>'),
    ...(row.via.rootTask === null ? {} : { 'X-Agent-Bridge-Root-Task': row.via.rootTask }),
  };
}

// One row of the frozen section 9 matrix. Each row runs against its own fresh real
// store/server so concurrent rows cannot share tasks, counters or worktree markers.
const ROWS = [
  { id: 'claude-code', admin: false, via: null },
  { id: 'codex', admin: false, via: null },
  { id: 'operator', admin: true, via: null },
  { id: 'legacy', admin: false, via: null },
  { id: 'legacy-admin', admin: true, via: null },
  // Delegate inheritance: the token authenticates the ROOT controller, while the
  // chain records the client-declared submission provenance (contract R1).
  { id: 'claude-code', admin: false, via: { chain: ['claude-code', 'codex'], rootTask: 'delegate-root' } },
  { id: 'codex', admin: false, via: { chain: ['codex', 'claude-code'], rootTask: 'delegate-root' } },
];

function ownCategory(category) {
  return category === 'own' || category === 'internal-own';
}

function expectedPermission(row, category, supplied) {
  if (supplied && !row.admin) return 'OVERRIDE_NOT_PERMITTED';
  if (ownCategory(category)) return null;
  if (!row.admin) return supplied ? 'OVERRIDE_NOT_PERMITTED' : 'TASK_NOT_OWNED';
  return supplied ? null : 'OVERRIDE_REASON_REQUIRED';
}

function assertPermission(response, code) {
  const outcome = outcomeOf(response);
  assert.equal(response.status, 200, `expected HTTP 200 for ${code}`);
  assert.equal(outcome.error?.code, code, JSON.stringify(outcome));
  assert.equal(outcome.error.details.field, code === 'TASK_NOT_OWNED' ? 'taskId' : code === 'OVERRIDE_REASON_REQUIRED' ? 'override.reason' : 'override');
  assert.ok(outcome.error.details.expected.length <= 120);
}

function assertAudit(f, task, response, row, tool) {
  const events = f.store.events(task.id, { limit: 1000 });
  const outcome = events.at(-1);
  // A successful business path may append its own event (archive does), so correlate
  // the intent by operationId instead of assuming it is exactly two events back.
  const intent = [...events].reverse().find(event => event.type === 'task/override' && event.operationId === outcome?.operationId);
  assert.equal(intent?.type, 'task/override', `${tool} override intent missing`);
  assert.equal(intent.actor, row.id);
  assert.equal(intent.submittedBy, task.submittedBy);
  assert.equal(intent.tool, tool);
  assert.equal(intent.reason, 'Inspect task');
  assert.deepEqual(intent.via, row.via ?? null);
  assert.equal(intent.revision, f.store.get(task.id).revision);
  assert.equal(outcome?.type, 'task/override-result');
  assert.equal(outcome.operationId, intent.operationId);
  assert.equal(outcome.attemptId, f.store.get(task.id).attemptId);
  const result = outcomeOf(response);
  if (result.error) {
    assert.equal(outcome.outcome, 'threw');
    assert.equal(outcome.code, result.error.code);
    assert.equal(PERMISSION_CODES.has(result.error.code), false, `${tool} must pass authorization`);
  } else {
    assert.equal(outcome.outcome, 'returned');
  }
  return { intent, outcome };
}

function assertAllowedMutation(f, tool, task, before, response) {
  const result = outcomeOf(response);
  assert.equal(result.error, undefined, `${tool} should reach its business path: ${JSON.stringify(result.error)}`);
  const after = targetSnapshot(f, task);
  if (tool === 'bridge_cleanup') {
    assert.equal(result.value.dryRun, true);
    assert.equal(result.value.taskId, task.id);
    return;
  }
  if (tool === 'bridge_pause' || tool === 'bridge_resume') {
    assert.ok(after.counts.project > before.counts.project, `${tool} did not reach the project runtime`);
    assert.equal(result.value[tool === 'bridge_pause' ? 'pause' : 'resume'].accepted, true);
    return;
  }
  if (tool === 'bridge_reconcile') {
    assert.ok(after.counts.adapter > before.counts.adapter, 'reconcile did not inspect the host');
    assert.equal(result.value.observation.status, 'unknown');
    return;
  }
  if (tool.startsWith('bridge_workspace_')) {
    assert.ok(after.counts.workspace > before.counts.workspace, `${tool} did not reach the workspace manager`);
    assert.notEqual(after.marker, before.marker);
    return;
  }
  assert.ok(
    after.taskBodies !== before.taskBodies || after.eventBodies !== before.eventBodies,
    `${tool} was authorized but produced no state change or event`,
  );
}

for (const [index, row] of ROWS.entries()) {
  test(`section 9 matrix row ${index + 1}: ${row.id} admin=${row.admin} delegate=${Boolean(row.via)}`, async t => {
    const f = fixture(t);
    const request = await serve(t, f);
    const headers = headersOf(row);
    const principal = { id: row.id, admin: row.admin };
    const seed = (submittedBy, key, extra = {}) => f.store.submit(validatePacket(packet(f.directory, key, extra)), { submittedBy, via: null }).task;
    const parents = {
      own: seed(row.id, `parent-own-${index}`),
      foreign: seed(foreignOf(row.id), `parent-foreign-${index}`),
      null: seed(null, `parent-null-${index}`),
    };
    let key = 0;
    const seedTarget = (category, state) => {
      key += 1;
      const parent = category === 'internal-own' ? parents.own : category === 'internal-foreign' ? parents.foreign : category === 'internal-null' ? parents.null : null;
      if (category.startsWith('internal')) {
        return f.store.submit(validatePacket(packet(f.directory, `internal-${index}-${key}`, { parentTaskId: parent.id })), { submittedBy: parent.submittedBy, via: parent.via }).task;
      }
      return seed(
        category === 'own' ? row.id : category === 'historical' ? null : foreignOf(row.id),
        `target-${index}-${state}-${key}`,
      );
    };

    // Read columns: every read tool is open to every authenticated principal; an
    // override on a read never reaches the service and never changes anything.
    for (const category of CATEGORIES) {
      const target = seedTarget(category, 'read');
      applyState(f, target, 'read');
      for (const tool of TASK_READS) {
        const before = targetSnapshot(f, target);
        const allowed = await request(tool, argsFor(tool, target, f.directory), { id: row.id, headers });
        const trusted = outcomeOf(allowed);
        assert.equal(allowed.status, 200);
        assert.equal(trusted.error, undefined, `${tool} read refused`);
        const value = tool === 'bridge_check' ? trusted.value.task : trusted.value;
        assert.equal(value.submittedBy, target.submittedBy);
        assert.deepEqual(value.via, target.via);
        assert.deepEqual(targetSnapshot(f, target), before, `${tool} read changed state`);
        const beforeDenied = targetSnapshot(f, target);
        assertPermission(await request(tool, { ...argsFor(tool, target, f.directory), override: OVERRIDE }, { id: row.id, headers }), 'OVERRIDE_NOT_PERMITTED');
        assert.deepEqual(targetSnapshot(f, target), beforeDenied, `${tool} read override denial changed state`);
      }
    }

    // Mutate columns: own / foreign / historical / internal {own,foreign,null} ×
    // {no override, override}. Denials must leave bodies, events, rounds, the worktree
    // marker and every adapter/workspace/project counter byte-identical.
    for (const category of CATEGORIES) {
      for (const tool of MUTATES) {
        const target = seedTarget(category, STATE[tool]);
        applyState(f, target, STATE[tool]);
        for (const supplied of [false, true]) {
          const args = { ...argsFor(tool, target, f.directory), ...(supplied ? { override: OVERRIDE } : {}) };
          const expected = expectedPermission(row, category, supplied);
          const before = targetSnapshot(f, target);
          const response = await request(tool, args, { id: row.id, headers });
          if (expected) {
            assertPermission(response, expected);
            assert.deepEqual(targetSnapshot(f, target), before, `${tool} denial left observable changes`);
            continue;
          }
          if (!supplied) {
            assertAllowedMutation(f, tool, target, before, response);
            continue;
          }
          assert.equal(response.status, 200);
          const { outcome } = assertAudit(f, target, response, row, tool);
          if (tool === 'bridge_followup') assert.equal(outcome.replay, true, 'the second admin follow-up is the same request replay');
          if (tool === 'bridge_clarify') assert.equal(outcome.replay, true);
          assert.equal(PERMISSION_CODES.has(outcomeOf(response).error?.code), false);
        }
      }
    }

    // Non-target read tools: always readable, but an override on any read is P.
    for (const tool of ['bridge_list', 'bridge_models', 'bridge_capabilities']) {
      const allowed = await request(tool, {}, { id: row.id, headers });
      assert.equal(allowed.status, 200);
      assert.equal(outcomeOf(allowed).error, undefined);
      if (tool === 'bridge_capabilities') {
        const value = outcomeOf(allowed).value;
        assert.equal(value.existing, true);
        assert.equal(value.controllerIdentity.self, principal.id);
        assert.equal(value.controllerIdentity.admin, principal.admin);
        assert.deepEqual(value.controllerIdentity.controllers, IDS);
      }
      const beforeDenied = globalSnapshot(f);
      assertPermission(await request(tool, { override: OVERRIDE }, { id: row.id, headers }), 'OVERRIDE_NOT_PERMITTED');
      assert.deepEqual(globalSnapshot(f), beforeDenied);
    }

    // Submit column: every authenticated principal may submit and the task is bound to
    // that principal with the client-declared via; an override on submit is P.
    const keyName = `submit-${index}`;
    const submitted = await request('bridge_submit', { packet: packet(f.directory, keyName) }, { id: row.id, headers });
    assert.equal(submitted.status, 200);
    const created = outcomeOf(submitted);
    assert.equal(created.error, undefined);
    assert.equal(created.value.submittedBy, principal.id);
    assert.deepEqual(created.value.via, row.via ?? null);
    assert.equal(f.store.get(created.value.id).submittedBy, principal.id);
    const beforeDeniedSubmit = globalSnapshot(f);
    assertPermission(await request('bridge_submit', { packet: packet(f.directory, `${keyName}-denied`), override: OVERRIDE }, { id: row.id, headers }), 'OVERRIDE_NOT_PERMITTED');
    assert.deepEqual(globalSnapshot(f), beforeDeniedSubmit);
  });
}

test('unknown credentials cover every tool, ownership cell and override variant without touching state', async t => {
  const f = fixture(t);
  const request = await serve(t, f);
  const seed = (submittedBy, key, extra = {}) => f.store.submit(validatePacket(packet(f.directory, key, extra)), { submittedBy, via: null }).task;
  const own = seed('codex', 'own');
  const foreign = seed('claude-code', 'foreign');
  const historical = seed(null, 'historical');
  for (const task of [own, foreign, historical]) applyState(f, task, 'completed');
  const targets = [own, foreign, historical];
  for (const tool of TOOLS) {
    for (const target of targets) {
      for (const supplied of [false, true]) {
        const args = { ...argsFor(tool.name, target, f.directory), ...(supplied ? { override: OVERRIDE } : {}) };
        const before = globalSnapshot(f);
        // A malformed via combination must still be answered by authentication first.
        const response = await request(tool.name, args, { token: 'unknown-token' + 'z'.repeat(32), headers: { 'X-Agent-Bridge-Root-Task': 'invalid-alone' } });
        assert.deepEqual(response, { status: 401, body: { error: 'unauthorized' } }, tool.name);
        assert.deepEqual(globalSnapshot(f), before);
      }
    }
  }
});

test('malformed, empty, mistyped, extra-key and overlong overrides are validated before target reads', async t => {
  const f = fixture(t);
  const request = await serve(t, f);
  const own = f.store.submit(validatePacket(packet(f.directory, 'override-own')), { submittedBy: 'operator', via: null }).task;
  const foreign = f.store.submit(validatePacket(packet(f.directory, 'override-foreign')), { submittedBy: 'codex', via: null }).task;
  for (const task of [own, foreign]) applyState(f, task, 'completed');
  const cases = [
    [{}, 'OVERRIDE_REASON_REQUIRED'],
    [{ reason: '' }, 'OVERRIDE_REASON_REQUIRED'],
    [{ reason: ' \t ' }, 'OVERRIDE_REASON_REQUIRED'],
    [{ reason: 5 }, 'INVALID_ARGUMENTS'],
    [{ reason: 'x'.repeat(501) }, 'INVALID_ARGUMENTS'],
    [{ reason: 'ok', extra: true }, 'INVALID_ARGUMENTS'],
    [null, 'INVALID_ARGUMENTS'],
    [[], 'INVALID_ARGUMENTS'],
    ['reason', 'INVALID_ARGUMENTS'],
    [1, 'INVALID_ARGUMENTS'],
  ];
  for (const [value, code] of cases) {
    const before = targetSnapshot(f, own);
    const response = await request('bridge_cancel', { taskId: own.id, override: value }, { id: 'operator' });
    assertPermission(response, code);
    assert.deepEqual(targetSnapshot(f, own), before, `invalid override ${JSON.stringify(value)} changed state`);
    // Non-admins are refused as P for ANY override shape, including malformed ones.
    assertPermission(await request('bridge_cancel', { taskId: own.id, override: value }, { id: 'codex' }), 'OVERRIDE_NOT_PERMITTED');
    // Override validation precedes the target read, so a missing task keeps the same code.
    assertPermission(await request('bridge_cancel', { taskId: 'missing', override: value }, { id: 'operator' }), code);
  }
  // A read or submit carrying an override is P even for an administrator.
  assertPermission(await request('bridge_result', { taskId: own.id, override: {} }, { id: 'operator' }), 'OVERRIDE_NOT_PERMITTED');
  assertPermission(await request('bridge_submit', { packet: packet(f.directory, 'override-submit'), override: {} }, { id: 'operator' }), 'OVERRIDE_NOT_PERMITTED');
  // A valid 500-character reason is trimmed and persisted exactly once.
  const boundary = await request('bridge_cancel', { taskId: foreign.id, override: { reason: 'x'.repeat(500) } }, { id: 'operator' });
  assert.equal(outcomeOf(boundary).error, undefined);
  assert.equal(f.store.events(foreign.id).at(-2).reason.length, 500);
  const trimmed = await request('bridge_cancel', { taskId: foreign.id, override: { reason: '  Inspect task  ' } }, { id: 'operator' });
  assert.equal(outcomeOf(trimmed).error, undefined);
  assert.equal(f.store.events(foreign.id).at(-2).reason, 'Inspect task');
});

test('administrator override survives business-gate failure with durable intent and a failure outcome', async t => {
  const f = fixture(t);
  const request = await serve(t, f);
  const historical = f.store.submit(validatePacket(packet(f.directory, 'gate-history')), { submittedBy: null, via: null }).task;
  applyState(f, historical, 'completed');

  // followup is synchronous after authorization: the intent audit is already durable
  // when the business CAS throws, and the outcome event records the exact code.
  const before = targetSnapshot(f, historical);
  const { intent, outcome } = assertAudit(
    f, historical,
    await request('bridge_followup', { taskId: historical.id, revision: 1, afterAttemptId: 'stale-attempt', followupId: 'gate-1', text: 'question', override: OVERRIDE }, { id: 'operator' }),
    { id: 'operator', admin: true, via: null },
    'bridge_followup',
  );
  assert.equal(outcome.outcome, 'threw');
  assert.equal(outcome.code, 'FOLLOWUP_CONFLICT');
  assert.equal(intent.reason, 'Inspect task');
  assert.deepEqual(f.store.get(historical.id).followups, undefined, 'a refused override must mint no round');
  assert.equal(f.store.get(historical.id).submittedBy, null);
  assert.equal(f.store.events(historical.id).filter(event => event.type === 'task/override').length, 1);
  assert.ok(before.events.length < f.store.events(historical.id).length);

  // Archive gates fail after the durable intent too: uncollected historical results
  // cannot be hidden, and the failure is audited, not silently dropped.
  const uncollected = f.store.submit(validatePacket(packet(f.directory, 'gate-archive')), { submittedBy: null, via: null }).task;
  applyState(f, uncollected, 'terminal');
  const archived = await request('bridge_archive', { taskId: uncollected.id, revision: 1, override: OVERRIDE }, { id: 'operator' });
  assert.equal(outcomeOf(archived).error?.code, 'ARCHIVE_CONFLICT');
  const events = f.store.events(uncollected.id);
  assert.equal(events.at(-2).type, 'task/override');
  assert.equal(events.at(-1).type, 'task/override-result');
  assert.equal(events.at(-1).code, 'ARCHIVE_CONFLICT');
  assert.equal(events.at(-1).outcome, 'threw');
  assert.equal(events.at(-1).operationId, events.at(-2).operationId);
});

test('idempotency namespaces are per principal and independent of via and forged identity hints', async t => {
  const f = fixture(t);
  const request = await serve(t, f);
  const shared = packet(f.directory, 'same-key');
  const headersA = { 'X-Agent-Bridge-Chain': 'claude-code>codex', 'X-Agent-Bridge-Root-Task': 'root-a' };
  const headersB = { 'X-Agent-Bridge-Chain': 'codex>claude-code', 'X-Agent-Bridge-Root-Task': 'root-b' };
  const [a, b] = await Promise.all([
    request('bridge_submit', { packet: shared }, { id: 'codex', headers: headersA }),
    request('bridge_submit', { packet: shared }, { id: 'claude-code', headers: headersB }),
  ]);
  const codexTask = outcomeOf(a).value;
  const claudeTask = outcomeOf(b).value;
  assert.notEqual(codexTask.id, claudeTask.id);
  assert.equal(codexTask.submittedBy, 'codex');
  assert.equal(claudeTask.submittedBy, 'claude-code');
  assert.deepEqual(codexTask.via, { chain: ['claude-code', 'codex'], rootTask: 'root-a' });
  assert.deepEqual(claudeTask.via, { chain: ['codex', 'claude-code'], rootTask: 'root-b' });

  // The first submission's via is immutable: later replay, even from a different chain,
  // returns the same task and never rewrites provenance.
  const replayFromOtherChain = outcomeOf(await request('bridge_submit', { packet: shared }, { id: 'codex', headers: headersB })).value;
  assert.equal(replayFromOtherChain.id, codexTask.id);
  assert.deepEqual(replayFromOtherChain.via, codexTask.via);
  const replayFromRoot = outcomeOf(await request('bridge_submit', { packet: shared }, { id: 'codex' })).value;
  assert.equal(replayFromRoot.id, codexTask.id);
  assert.deepEqual(replayFromRoot.via, codexTask.via);
  assert.equal((await request('bridge_submit', { packet: { ...shared, title: 'changed' } }, { id: 'codex' })).body.result.isError, true);
  assert.equal(outcomeOf(await request('bridge_submit', { packet: { ...shared, title: 'changed' } }, { id: 'codex' })).error.code, 'IDEMPOTENCY_CONFLICT');

  // metadata, parentTaskId and a client-declared chain cannot donate another identity.
  const foreignParent = f.store.submit(validatePacket(packet(f.directory, 'foreign-parent')), { submittedBy: 'claude-code', via: null }).task;
  const forged = outcomeOf(await request('bridge_submit', {
    packet: packet(f.directory, 'forged', {
      parentTaskId: foreignParent.id,
      metadata: { controller: 'operator', submittedBy: 'operator', rootTask: 'root-a' },
    }),
  }, { id: 'codex', headers: headersA })).value;
  assert.equal(forged.submittedBy, 'codex');
  assert.deepEqual(forged.via, { chain: ['claude-code', 'codex'], rootTask: 'root-a' });
  assert.notEqual(forged.id, foreignParent.id);

  // That forged-parent task stays codex-owned: claude-code cannot mutate it, and the
  // operator must justify a foreign mutation with an override.
  assertPermission(await request('bridge_cancel', { taskId: forged.id }, { id: 'claude-code' }), 'TASK_NOT_OWNED');
  assertPermission(await request('bridge_cancel', { taskId: forged.id }, { id: 'operator' }), 'OVERRIDE_REASON_REQUIRED');
  const audited = await request('bridge_cancel', { taskId: forged.id, override: OVERRIDE }, { id: 'operator' });
  assert.equal(outcomeOf(audited).error, undefined);
  assert.equal(f.store.get(forged.id).submittedBy, 'codex');

  // Forged or malformed via headers are rejected at the HTTP entry with VIA_INVALID.
  for (const badHeaders of [
    { 'X-Agent-Bridge-Root-Task': 'alone' },
    { 'X-Agent-Bridge-Chain': 'operator' },
    { 'X-Agent-Bridge-Chain': 'codex>unknown' },
    { 'X-Agent-Bridge-Chain': 'codex>claude-code>dsh>codex>claude-code>dsh' },
    { 'X-Agent-Bridge-Chain': 'codex>' },
  ]) {
    const bad = await request('bridge_capabilities', {}, { id: 'codex', headers: badHeaders });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'VIA_INVALID');
    assert.deepEqual(Object.keys(bad.body.details).sort(), ['expected', 'field']);
  }
});

test('concurrent HTTP principals keep request-local identity and leak no credential', async t => {
  const f = fixture(t);
  const request = await serve(t, f);
  const ownCodex = f.store.submit(validatePacket(packet(f.directory, 'concurrent-codex')), { submittedBy: 'codex', via: null }).task;
  const ownClaude = f.store.submit(validatePacket(packet(f.directory, 'concurrent-claude')), { submittedBy: 'claude-code', via: null }).task;
  applyState(f, ownCodex, 'queued');
  applyState(f, ownClaude, 'queued');
  const foreignCodex = f.store.submit(validatePacket(packet(f.directory, 'concurrent-codex-foreign')), { submittedBy: 'codex', via: null }).task;
  applyState(f, foreignCodex, 'queued');

  const calls = [];
  for (let index = 0; index < 12; index += 1) {
    calls.push(request('bridge_capabilities', {}, { id: 'codex' }).then(response => ({ kind: 'codex-capabilities', response })));
    calls.push(request('bridge_capabilities', {}, { id: 'claude-code' }).then(response => ({ kind: 'claude-capabilities', response })));
    calls.push(request('bridge_capabilities', {}, { id: 'operator' }).then(response => ({ kind: 'operator-capabilities', response })));
    calls.push(request('bridge_result', { taskId: ownCodex.id }, { id: 'claude-code' }).then(response => ({ kind: 'foreign-read', response })));
    calls.push(request('bridge_cancel', { taskId: ownCodex.id }, { id: 'claude-code' }).then(response => ({ kind: 'foreign-mutate', response })));
    calls.push(request('bridge_cancel', { taskId: ownClaude.id, override: OVERRIDE }, { id: 'codex' }).then(response => ({ kind: 'nonadmin-override', response })));
    calls.push(request('bridge_capabilities', {}, { token: 'unknown-token' + 'q'.repeat(32) }).then(response => ({ kind: 'unknown', response })));
  }
  calls.push(request('bridge_cancel', { taskId: ownCodex.id }, { id: 'codex' }).then(response => ({ kind: 'codex-own', response })));
  calls.push(request('bridge_cancel', { taskId: ownClaude.id }, { id: 'claude-code' }).then(response => ({ kind: 'claude-own', response })));

  const responses = await Promise.all(calls);
  for (const { kind, response } of responses) {
    if (kind === 'unknown') { assert.deepEqual(response, { status: 401, body: { error: 'unauthorized' } }); continue; }
    assert.equal(response.status, 200, kind);
    const outcome = outcomeOf(response);
    if (kind.endsWith('capabilities')) {
      const expected = kind === 'claude-capabilities' ? 'claude-code' : kind.split('-')[0];
      assert.equal(outcome.value.controllerIdentity.self, expected);
      assert.equal(outcome.value.controllerIdentity.admin, expected === 'operator');
    } else if (kind === 'foreign-mutate') {
      assert.equal(outcome.error?.code, 'TASK_NOT_OWNED');
    } else if (kind === 'nonadmin-override') {
      assert.equal(outcome.error?.code, 'OVERRIDE_NOT_PERMITTED');
    } else if (kind === 'foreign-read') {
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.value.taskId, ownCodex.id);
    } else {
      assert.equal(outcome.error, undefined, kind);
    }
    for (const token of Object.values(TOKEN)) assert.equal(JSON.stringify(response.body).includes(token), false);
    assert.equal(JSON.stringify(response.body).includes('tokenFile'), false);
  }
  assert.equal(f.store.get(ownCodex.id).status, 'cancelled');
  assert.equal(f.store.get(ownClaude.id).status, 'cancelled');
  assert.equal(f.store.get(foreignCodex.id).status, 'queued');
});

test('the frozen tool catalogue is exactly 6 read, 1 submit and 13 mutate tools', () => {
  assert.deepEqual(
    Object.fromEntries(['read', 'submit', 'mutate'].map(category => [category, TOOLS.filter(tool => tool.category === category).length])),
    { read: 6, submit: 1, mutate: 13 },
  );
  assert.equal(ALL_READS.length, 6);
  assert.deepEqual(new Set(MUTATES), new Set([
    'bridge_approve', 'bridge_clarify', 'bridge_followup', 'bridge_cancel', 'bridge_pause', 'bridge_resume',
    'bridge_reconcile', 'bridge_acknowledge', 'bridge_archive', 'bridge_cleanup',
    'bridge_workspace_review', 'bridge_workspace_refresh', 'bridge_workspace_integrate',
  ]));
});
