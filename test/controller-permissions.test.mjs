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
import { makeTestDir } from './helpers/test-root.mjs';

// R6: the test-root helper decides the temporary root; no drive-letter or
// directory-existence choice lives in test code.

// The roster every fixture configures. `legacy` is a real controller ID; the legacy
// administrator row reconfigures the SAME id with admin:true instead of inventing a
// differently named administrator principal (contract section 2).
const BASE_ROSTER = [
  { id: 'claude-code', admin: false, token: `claude-code-test-${'a'.repeat(40)}` },
  { id: 'codex', admin: false, token: `codex-test-${'b'.repeat(40)}` },
  { id: 'operator', admin: true, token: `operator-test-${'c'.repeat(40)}` },
  { id: 'legacy', admin: false, token: `legacy-test-${'d'.repeat(40)}` },
];
const TOKEN = Object.fromEntries(BASE_ROSTER.map(entry => [entry.id, entry.token]));

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

function fixture(t, roster = BASE_ROSTER) {
  const directory = makeTestDir('controller-permissions');
  const store = new TaskStore({ directory, ownerId: 'owner' });
  const counts = { adapter: 0, preflight: 0, workspace: 0, project: 0, followup: 0, reconsider: 0 };
  const catalog = [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }];
  const adapter = {
    models: async () => { counts.adapter += 1; return catalog; },
    capabilities: async () => { counts.adapter += 1; return { existing: true, lifecycle: { followup: { supported: true } } }; },
    preflight: async () => { counts.preflight += 1; return { ok: true }; },
    inspect: async () => { counts.adapter += 1; return { status: 'unknown', stopConfirmed: false }; },
    archive: async task => { counts.adapter += 1; return { archived: true, uiHidden: true, sessionId: task.sessionId ?? null }; },
    cleanup: async () => { counts.adapter += 1; return { cleaned: true }; },
    followup: async () => { counts.adapter += 1; counts.followup += 1; },
    reconsider: async () => { counts.adapter += 1; counts.reconsider += 1; },
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
  const controllers = roster.map(entry => {
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
  return { directory, store, service, counts, marker, registry, controllers, ids: roster.map(entry => entry.id).sort() };
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
// The legacy administrator is the REAL id `legacy` configured admin:true, never a
// differently named administrator principal.
const ROWS = [
  { label: 'claude-code', id: 'claude-code', admin: false, via: null },
  { label: 'codex', id: 'codex', admin: false, via: null },
  { label: 'operator admin', id: 'operator', admin: true, via: null },
  { label: 'legacy ordinary', id: 'legacy', admin: false, via: null },
  { label: 'legacy admin (id legacy, admin:true)', id: 'legacy', admin: true, via: null },
  // Delegate inheritance: the token authenticates the ROOT controller, while the
  // chain records the client-declared submission provenance (contract R1). Both
  // directions are exercised: Claude->Codex and Codex->Claude.
  { label: 'delegate Claude->Codex', id: 'claude-code', admin: false, via: { chain: ['claude-code', 'codex'], rootTask: 'delegate-root' } },
  { label: 'delegate Codex->Claude', id: 'codex', admin: false, via: { chain: ['codex', 'claude-code'], rootTask: 'delegate-root' } },
];

function rosterFor(row) {
  return BASE_ROSTER.map(entry => ({
    ...entry,
    // `operator` is always the role administrator; `legacy` is admin only in the legacy
    // administrator row, which proves the real id can be configured either way.
    admin: entry.id === 'operator' ? true : entry.id === 'legacy' ? row.id === 'legacy' && row.admin === true : false,
  }));
}

function ownCategory(category) {
  return category === 'own' || category === 'internal-own';
}

function expectedPermission(row, category, supplied) {
  if (supplied && !row.admin) return 'OVERRIDE_NOT_PERMITTED';
  if (ownCategory(category)) return null;
  if (!row.admin) return supplied ? 'OVERRIDE_NOT_PERMITTED' : 'TASK_NOT_OWNED';
  return supplied ? null : 'OVERRIDE_REASON_REQUIRED';
}

// Contract section 4 fixes a field/expected pair per permission code. Keep the exact
// pair, not just the code, so a wrong field cannot ride along with a right code.
const PERMISSION_DETAILS = {
  TASK_NOT_OWNED: { field: 'taskId', expected: 'task owned by authenticated controller' },
  OVERRIDE_NOT_PERMITTED: { field: 'override', expected: 'admin override on a mutate tool' },
  OVERRIDE_REASON_REQUIRED: { field: 'override.reason', expected: 'nonblank string, maximum 500 characters' },
};
// Both INVALID_ARGUMENTS override shapes are explicit: a malformed override object names
// `override`, while a malformed reason names `override.reason`.
const INVALID_OVERRIDE_DETAILS = {
  override: { field: 'override', expected: 'object with only reason' },
  'override.reason': { field: 'override.reason', expected: 'nonblank string, maximum 500 characters' },
};

function assertPermission(response, code, details = PERMISSION_DETAILS[code]) {
  assert.ok(details, `no expected field/expected registered for ${code}`);
  const outcome = outcomeOf(response);
  assert.equal(response.status, 200, `expected HTTP 200 for ${code}`);
  assert.equal(outcome.error?.code, code, JSON.stringify(outcome));
  assert.deepEqual(outcome.error.details, details, `${code} must report its contract field/expected`);
  assert.equal(typeof outcome.error.message, 'string');
  assert.ok(outcome.error.details.expected.length <= 120, `${code} details must stay bounded`);
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
  // One snapshot + stable seq: the durable intent must precede its own outcome.
  assert.ok(intent.seq < outcome.seq, `${tool} override intent seq ${intent.seq} did not precede outcome seq ${outcome.seq}`);
  assert.ok(events.indexOf(intent) < events.indexOf(outcome), `${tool} override events are out of order`);
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
    assert.equal(typeof result.value.eligible, 'boolean', 'cleanup dry-run must compute the retention decision');
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

// Business evidence must not be satisfied by the override audit events themselves: the
// first authorized override on a fresh foreign/historical/internal target has to show a
// real business effect (state, business event, or a host/workspace/project call count).
function businessEvents(events) {
  return events.filter(event => event.type !== 'task/override' && event.type !== 'task/override-result');
}

function assertFreshOverride(f, tool, task, before, response) {
  const result = outcomeOf(response);
  assert.equal(result.error, undefined, `${tool} authorized override must reach its business path: ${JSON.stringify(result.error)}`);
  const after = targetSnapshot(f, task);
  const beforeBusiness = businessEvents(before.events);
  const afterBusiness = businessEvents(after.events);
  if (tool === 'bridge_cleanup') {
    assert.equal(result.value.dryRun, true);
    assert.equal(result.value.taskId, task.id);
    assert.equal(typeof result.value.eligible, 'boolean', 'cleanup dry-run must compute the retention decision');
    return result;
  }
  if (tool === 'bridge_pause' || tool === 'bridge_resume') {
    assert.ok(after.counts.project > before.counts.project, `${tool} override did not reach the project runtime`);
    assert.equal(result.value[tool === 'bridge_pause' ? 'pause' : 'resume'].accepted, true);
    return result;
  }
  if (tool === 'bridge_reconcile') {
    assert.ok(after.counts.adapter > before.counts.adapter, 'reconcile override did not inspect the host');
    assert.equal(result.value.observation.status, 'unknown');
    return result;
  }
  if (tool.startsWith('bridge_workspace_')) {
    assert.ok(after.counts.workspace > before.counts.workspace, `${tool} override did not reach the workspace manager`);
    assert.notEqual(after.marker, before.marker);
    return result;
  }
  assert.ok(
    digest(f.store.get(task.id)) !== digest(before.body)
      || afterBusiness.length > beforeBusiness.length
      || after.counts.adapter > before.counts.adapter,
    `${tool} authorized override produced no business state or call-count effect`,
  );
  return result;
}

function roundsOf(task, key) {
  return Array.isArray(task[key]) ? task[key].length : 0;
}

for (const [index, row] of ROWS.entries()) {
  test(`section 9 matrix row ${index + 1}: ${row.label}`, async t => {
    const roster = rosterFor(row);
    const f = fixture(t, roster);
    const request = await serve(t, f);
    const headers = headersOf(row);
    const principal = { id: row.id, admin: row.admin };
    const foreignId = foreignOf(row.id);
    // The legacy administrator row is the real controller id `legacy` with admin:true;
    // every other row keeps that same id as an ordinary principal.
    assert.equal(f.controllers.find(controller => controller.id === 'legacy').admin, row.id === 'legacy' ? row.admin : false);
    assert.equal(f.controllers.find(controller => controller.id === 'operator').admin, true);
    const seed = (submittedBy, key, extra = {}) => f.store.submit(validatePacket(packet(f.directory, key, extra)), { submittedBy, via: null }).task;
    const parents = {
      own: seed(row.id, `parent-own-${index}`),
      foreign: seed(foreignId, `parent-foreign-${index}`),
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
        category === 'own' ? row.id : category === 'historical' ? null : foreignId,
        `target-${index}-${state}-${key}`,
      );
    };

    // Completion accounting: fail-fast must not let an omitted cell look proven. Every
    // dimension is counted and asserted against the frozen matrix sizes at the end.
    const completion = {
      taskReads: 0, taskReadDenials: 0, globalReads: 0, globalReadDenials: 0, listFilters: 0,
      mutateCells: 0, submitCells: 0,
      byCategory: Object.fromEntries(CATEGORIES.map(category => [category, 0])),
      byTool: Object.fromEntries(MUTATES.map(tool => [tool, 0])),
    };
    const coverMutate = (tool, category) => {
      completion.mutateCells += 1;
      completion.byTool[tool] += 1;
      completion.byCategory[category] += 1;
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
        completion.taskReads += 1;
        const beforeDenied = targetSnapshot(f, target);
        assertPermission(await request(tool, { ...argsFor(tool, target, f.directory), override: OVERRIDE }, { id: row.id, headers }), 'OVERRIDE_NOT_PERMITTED');
        assert.deepEqual(targetSnapshot(f, target), beforeDenied, `${tool} read override denial changed state`);
        completion.taskReadDenials += 1;
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
        assert.deepEqual(value.controllerIdentity.controllers, f.ids);
      }
      const beforeDenied = globalSnapshot(f);
      assertPermission(await request(tool, { override: OVERRIDE }, { id: row.id, headers }), 'OVERRIDE_NOT_PERMITTED');
      assert.deepEqual(globalSnapshot(f), beforeDenied);
      completion.globalReads += 1;
      completion.globalReadDenials += 1;
    }

    // bridge_list.submittedBy: omitted, own, foreign and historical are all readable,
    // and an effective filter returns only that namespace.
    const listedAll = outcomeOf(await request('bridge_list', { includeArchived: true }, { id: row.id, headers }));
    assert.equal(listedAll.error, undefined);
    assert.ok(listedAll.value.tasks.some(task => task.submittedBy === row.id), 'list omitted filter lost the own principal');
    assert.ok(listedAll.value.tasks.some(task => task.submittedBy === foreignId), 'list omitted filter lost the foreign principal');
    assert.ok(listedAll.value.tasks.some(task => task.submittedBy === null), 'list omitted filter lost historical ownership');
    completion.listFilters += 1;
    for (const [label, filter] of [[row.id, row.id], [foreignId, foreignId], ['historical', null]]) {
      const listed = outcomeOf(await request('bridge_list', { submittedBy: filter, includeArchived: true }, { id: row.id, headers }));
      assert.equal(listed.error, undefined, `bridge_list submittedBy=${label} refused`);
      assert.ok(listed.value.tasks.length > 0, `bridge_list submittedBy=${label} returned no task`);
      assert.ok(listed.value.tasks.every(task => task.submittedBy === filter), `bridge_list submittedBy=${label} leaked another identity`);
      completion.listFilters += 1;
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
            coverMutate(tool, category);
            continue;
          }
          if (!supplied) {
            // Ordinary allowed mutation: it must reach the real business seam and leave
            // a real state/event/call-count effect, not just a permission decision.
            assertAllowedMutation(f, tool, target, before, response);
            coverMutate(tool, category);
            continue;
          }
          assert.equal(response.status, 200);
          const { outcome } = assertAudit(f, target, response, row, tool);
          assert.equal(PERMISSION_CODES.has(outcomeOf(response).error?.code), false);
          if (ownCategory(category)) {
            // The own category already had its ordinary allowed request above, so this
            // is the second authorized request: prove a true replay where the tool has
            // one, and retain the real business gate everywhere else.
            if (tool === 'bridge_followup') {
              const replay = outcomeOf(response);
              assert.equal(replay.error, undefined);
              assert.equal(replay.value.followup.replay, true, 'the admin own override is the same follow-up replay');
              assert.equal(outcome.replay, true);
              assert.equal(replay.value.followup.attemptId, before.body.attemptId);
              assert.equal(f.store.get(target.id).attemptId, before.body.attemptId, 'a follow-up replay must not mint an attempt');
              assert.equal(roundsOf(f.store.get(target.id), 'followups'), roundsOf(before.body, 'followups'), 'a follow-up replay must not mint a round');
            } else if (tool === 'bridge_clarify') {
              const replay = outcomeOf(response);
              assert.equal(replay.error, undefined);
              assert.equal(replay.value.clarificationReplay, true, 'the admin own override is the same clarification replay');
              assert.equal(outcome.replay, true);
              assert.equal(f.store.get(target.id).attemptId, before.body.attemptId, 'a clarification replay must not mint an attempt');
              assert.equal(roundsOf(f.store.get(target.id), 'clarifications'), roundsOf(before.body, 'clarifications'), 'a clarification replay must not mint a clarification');
            } else if (tool === 'bridge_approve') {
              // The earlier ordinary approval already consumed the awaiting task: the
              // second authorized request still enters the business gate and fails
              // there, with the failure recorded in its own audit outcome.
              assert.equal(outcome.outcome, 'threw');
              assert.equal(outcome.code, 'APPROVAL_CONFLICT');
              assert.equal(outcomeOf(response).error?.code, 'APPROVAL_CONFLICT');
            } else {
              assert.equal(outcome.outcome, 'returned', `${tool} second authorized request unexpectedly failed: ${JSON.stringify(outcomeOf(response).error)}`);
              assert.equal(outcomeOf(response).error, undefined);
            }
          } else {
            // First authorized request on a fresh foreign/historical/internal target:
            // prove real business invocation + state/call-count effect linked to audit.
            assertFreshOverride(f, tool, target, before, response);
            // The linked outcome event records the applicable business result fields.
            if (tool === 'bridge_archive') assert.equal(outcome.archived, true, 'archive outcome must record the business result');
            if (tool === 'bridge_pause' || tool === 'bridge_resume') assert.equal(outcome.accepted, true, `${tool} outcome must record the accepted request`);
            if (tool === 'bridge_cleanup') assert.equal(typeof outcome.eligible, 'boolean', 'cleanup dry-run outcome must record the retention decision');
            if (tool === 'bridge_followup') {
              const first = outcomeOf(response);
              assert.equal(first.value.followup.replay, false, 'the first authorized follow-up is a new round, not a replay');
              assert.equal(outcome.replay, false);
              assert.notEqual(first.value.followup.attemptId, before.body.attemptId, 'a first follow-up must mint a new attempt');
              assert.equal(roundsOf(f.store.get(target.id), 'followups'), roundsOf(before.body, 'followups') + 1, 'a first follow-up must mint exactly one round');
              assert.equal(f.store.get(target.id).attemptId, first.value.followup.attemptId);
            }
            if (tool === 'bridge_clarify') {
              const first = outcomeOf(response);
              assert.equal(first.value.clarificationReplay, undefined, 'a first clarification is not a replay');
              assert.equal(outcome.replay, undefined);
              assert.notEqual(f.store.get(target.id).attemptId, before.body.attemptId, 'a first clarification must mint a new attempt');
              assert.equal(roundsOf(f.store.get(target.id), 'clarifications'), roundsOf(before.body, 'clarifications') + 1, 'a first clarification must mint exactly one clarification');
            }
          }
          coverMutate(tool, category);
        }
      }
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
    completion.submitCells += 1;
    const beforeDeniedSubmit = globalSnapshot(f);
    assertPermission(await request('bridge_submit', { packet: packet(f.directory, `${keyName}-denied`), override: OVERRIDE }, { id: row.id, headers }), 'OVERRIDE_NOT_PERMITTED');
    assert.deepEqual(globalSnapshot(f), beforeDeniedSubmit);
    completion.submitCells += 1;

    // The matrix authorizes and mutates records but never runs a model turn: round
    // counts move while the real host dispatch counters stay at zero.
    assert.equal(f.counts.followup, 0, 'no matrix mutation may dispatch a follow-up turn');
    assert.equal(f.counts.reconsider, 0, 'no matrix mutation may dispatch a clarification turn');

    // Completion evidence: no cell can be silently omitted without failing the row.
    assert.equal(completion.taskReads, CATEGORIES.length * TASK_READS.length);
    assert.equal(completion.taskReadDenials, CATEGORIES.length * TASK_READS.length);
    assert.equal(completion.globalReads, 3);
    assert.equal(completion.globalReadDenials, 3);
    assert.equal(completion.listFilters, 4);
    assert.equal(completion.mutateCells, CATEGORIES.length * MUTATES.length * 2);
    assert.equal(completion.submitCells, 2);
    for (const category of CATEGORIES) assert.equal(completion.byCategory[category], MUTATES.length * 2, `category ${category} incomplete`);
    for (const tool of MUTATES) assert.equal(completion.byTool[tool], CATEGORIES.length * 2, `tool ${tool} incomplete`);
    assert.equal(new Set([...TASK_READS, ...['bridge_list', 'bridge_models', 'bridge_capabilities']]).size, 6);
    t.diagnostic(`row ${row.label}: ${completion.taskReads} task-reads + ${completion.taskReadDenials} task-read denials + ${completion.globalReads} global reads + ${completion.globalReadDenials} global denials + ${completion.listFilters} list filters + ${completion.mutateCells} mutate cells (13 tools x 6 categories x +/-) + ${completion.submitCells} submit cells; controllers=${f.ids.join(',')}; admin=${row.admin}; via=${JSON.stringify(row.via)}`);
  });
}

test('unknown credentials cover every tool, ownership cell and override variant without touching state', async t => {
  const f = fixture(t);
  const request = await serve(t, f);
  const seed = (submittedBy, key, extra = {}) => f.store.submit(validatePacket(packet(f.directory, key, extra)), { submittedBy, via: null }).task;
  const own = seed('codex', 'own');
  const foreign = seed('claude-code', 'foreign');
  const historical = seed(null, 'historical');
  const parents = [own, foreign, historical];
  // Derived internal targets add the parent-own / parent-foreign / parent-null ownership
  // variants; an unknown token must be refused for those too, not only the three roots.
  const targets = [
    ...parents,
    ...parents.map((parent, index) => f.store.submit(
      validatePacket(packet(f.directory, `internal-unknown-${index}`, { parentTaskId: parent.id })),
      { submittedBy: parent.submittedBy, via: parent.via },
    ).task),
  ];
  for (const task of targets) applyState(f, task, 'completed');
  let cells = 0;
  const byTool = Object.fromEntries(TOOLS.map(tool => [tool.name, 0]));
  for (const tool of TOOLS) {
    for (const target of targets) {
      for (const supplied of [false, true]) {
        const args = { ...argsFor(tool.name, target, f.directory), ...(supplied ? { override: OVERRIDE } : {}) };
        const before = globalSnapshot(f);
        // A malformed via combination must still be answered by authentication first.
        const response = await request(tool.name, args, { token: 'unknown-token' + 'z'.repeat(32), headers: { 'X-Agent-Bridge-Root-Task': 'invalid-alone' } });
        assert.deepEqual(response, { status: 401, body: { error: 'unauthorized' } }, tool.name);
        assert.deepEqual(globalSnapshot(f), before);
        cells += 1;
        byTool[tool.name] += 1;
      }
    }
  }
  assert.equal(targets.length, 6, 'unknown-token coverage must include the derived ownership variants');
  assert.equal(cells, TOOLS.length * targets.length * 2);
  for (const tool of TOOLS) assert.equal(byTool[tool.name], targets.length * 2, `${tool.name} unknown-token cell omitted`);
});

test('malformed, empty, mistyped, extra-key and overlong overrides are validated before target reads', async t => {
  const f = fixture(t);
  const request = await serve(t, f);
  const own = f.store.submit(validatePacket(packet(f.directory, 'override-own')), { submittedBy: 'operator', via: null }).task;
  const foreign = f.store.submit(validatePacket(packet(f.directory, 'override-foreign')), { submittedBy: 'codex', via: null }).task;
  for (const task of [own, foreign]) applyState(f, task, 'completed');
  const cases = [
    [{}, 'OVERRIDE_REASON_REQUIRED', INVALID_OVERRIDE_DETAILS['override.reason']],
    [{ reason: '' }, 'OVERRIDE_REASON_REQUIRED', INVALID_OVERRIDE_DETAILS['override.reason']],
    [{ reason: ' \t ' }, 'OVERRIDE_REASON_REQUIRED', INVALID_OVERRIDE_DETAILS['override.reason']],
    [{ reason: 5 }, 'INVALID_ARGUMENTS', INVALID_OVERRIDE_DETAILS['override.reason']],
    [{ reason: 'x'.repeat(501) }, 'INVALID_ARGUMENTS', INVALID_OVERRIDE_DETAILS['override.reason']],
    [{ reason: 'ok', extra: true }, 'INVALID_ARGUMENTS', INVALID_OVERRIDE_DETAILS.override],
    [null, 'INVALID_ARGUMENTS', INVALID_OVERRIDE_DETAILS.override],
    [[], 'INVALID_ARGUMENTS', INVALID_OVERRIDE_DETAILS.override],
    ['reason', 'INVALID_ARGUMENTS', INVALID_OVERRIDE_DETAILS.override],
    [1, 'INVALID_ARGUMENTS', INVALID_OVERRIDE_DETAILS.override],
  ];
  for (const [value, code, details] of cases) {
    const before = targetSnapshot(f, own);
    const response = await request('bridge_cancel', { taskId: own.id, override: value }, { id: 'operator' });
    assertPermission(response, code, details);
    assert.deepEqual(targetSnapshot(f, own), before, `invalid override ${JSON.stringify(value)} changed state`);
    // Non-admins are refused as P for ANY override shape, including malformed ones.
    assertPermission(await request('bridge_cancel', { taskId: own.id, override: value }, { id: 'codex' }), 'OVERRIDE_NOT_PERMITTED');
    // Override validation precedes the target read, so a missing task keeps the same code.
    assertPermission(await request('bridge_cancel', { taskId: 'missing', override: value }, { id: 'operator' }), code, details);
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
