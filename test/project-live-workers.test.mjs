// test/project-live-workers.test.mjs
//
// Targeted regressions for two production defects described in
// deployment-20260930/watchdog-brief.md:
//
//  * A1 — exactly exhausted STARTS with already-admitted workers still RUNNING was
//    treated as an exhausted remaining plan, so the project emitted a false
//    `serious-issue`/blocked callback (`clean-stop-unproven`) before its real completion.
//  * The narrow late-cancel race and the project reconciliation gap: a delayed
//    cancellation error/outcome must never overwrite a newer attempt or a positively
//    settled SAME attempt, an unproven project root must stay honestly blocked with its
//    occupancy, and `bridge_reconcile` must consume real inspector evidence without
//    replaying a model round.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskStore } from '../src/store.mjs';
import { BridgeService } from '../src/service.mjs';
import { validatePacket } from '../src/contracts.mjs';
import { BridgeSupervisor, HostReservationLedger } from '../src/supervisor.mjs';
import {
  SupervisorProjectRuntime,
  createProjectRecord,
  normalizeProjectConfig,
  resolveProjectGrant,
} from '../src/long-task.mjs';

const MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Read every persisted event for one task through the store's REAL bounded cursor. The
 * store accepts at most 1000 rows per page, so the fixture pages instead of asking for an
 * invalid limit; the actual saved events are still checked.
 */
function readEvents(store, taskId) {
  const out = [];
  let after = 0;
  for (;;) {
    const page = store.events(taskId, { after, limit: 1000 });
    out.push(...page);
    const lastSeq = page[page.length - 1]?.seq;
    if (page.length < 1000 || !Number.isSafeInteger(lastSeq) || lastSeq <= after) return out;
    after = lastSeq;
  }
}

/**
 * A project packet carrying N workers and N fundable starts, like production. The
 * supervisor round is granted 15 tool calls and the worker envelope 10 each against a
 * 60-call project grant, so all three workers are genuinely funded CONCURRENTLY (the
 * existing full-grant reservation rule is preserved: a worker may still hold its whole
 * allowance, it is simply a bounded 10-call allowance here).
 */
function projectPacket(repository, projectOverrides = {}, idempotencyKey = 'project-1') {
  return {
    schemaVersion: 1,
    idempotencyKey,
    revision: 1,
    projectId: 'pj-live',
    title: 'long project',
    objective: 'split the bounded work across workers',
    cwd: repository,
    role: 'investigate',
    acceptance: ['every worker is bounded and reported'],
    scope: { readRoots: [repository], writeRoots: [], allowedTools: ['read', 'glob', 'grep'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [],
    contractVersion: 'v1',
    rootCallback: { grantId: 'grant-1' },
    budget: { timeoutMs: 600_000, maxToolCalls: 15, maxOutputChars: 200_000 },
    project: {
      maxWorkers: 3,
      maxConcurrentWorkers: 3,
      maxRepairAttempts: 0,
      maxTotalRetries: 0,
      maxWorkerStarts: 3,
      maxTotalToolCalls: 60,
      timeoutMs: 3_600_000,
      reserveSlots: 1,
      workerScope: { readRoots: [repository], writeRoots: [repository], allowedTools: ['read', 'write', 'edit'], allowNetwork: false, budgets: { timeoutMs: 600_000, maxToolCalls: 10, maxOutputChars: 200_000 } },
      workspace: { repository, baseRef: 'HEAD' },
      ...projectOverrides,
    },
  };
}

/**
 * One real project runtime attached to a small host-service double over a REAL
 * TaskStore. The double mirrors only the two seams the runtime depends on: a submit that
 * persists a real worker task and reserves its ledger slot, and a cancel that settles it.
 */
function makeEnv({ config = {}, adapterOverrides = {} } = {}) {
  const dir = makeDir('dsh-live-');
  const repository = makeDir('dsh-live-repo-');
  const store = new TaskStore({ directory: dir, ownerId: 'owner-live' });
  const ledger = new HostReservationLedger({ limit: 16, id: 'live' });
  const sinkCalls = [];
  const supervisor = new BridgeSupervisor({
    ledger,
    ownerId: 'owner-live',
    config: { notificationSink: (event) => { sinkCalls.push(event); return { ok: true, event: { state: 'pending' } }; } },
  });
  const projectConfig = normalizeProjectConfig({ enabled: true, ...config });
  const submitted = [];

  let runtime = null;
  const double = {
    ledger,
    async submit(packet) {
      const p = validatePacket(packet);
      const result = store.submit(p, { effectiveModel: p.model ?? { ...MODEL } });
      if (result.created) {
        submitted.push({ id: result.task.id, packet: p });
        ledger.reserve({ key: `task:${result.task.id}`, kind: 'root', taskId: result.task.id });
        if (p.workspace) {
          store.update(result.task.id, {
            workspace: {
              taskId: result.task.id,
              path: path.join(p.workspace.repository, '.worktrees', result.task.id),
              branch: `task/${result.task.id}`,
              baseCommit: 'a'.repeat(40),
              repository: p.workspace.repository,
            },
          });
        }
      }
      const task = store.get(result.task.id);
      return { id: task.id, status: task.status, sessionId: `session-${task.id}`, workspace: task.workspace ?? null };
    },
    async cancel(id) {
      const task = store.get(id);
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return { accepted: false, alreadyFinished: true };
      store.update(id, { status: 'cancelled', phase: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0, endedAt: Date.now() });
      if (ledger.has(`task:${id}`)) ledger.release(`task:${id}`, { stopConfirmed: true, reason: 'double settlement' });
      await runtime.onTaskSettled(store.get(id));
      return { accepted: true, stopConfirmed: true };
    },
  };
  const adapter = {
    models: async () => [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
    inspect: async () => ({ status: 'unknown', stopConfirmed: false, activeJobs: null, activeChildren: null }),
    ...adapterOverrides,
  };
  const workspaces = { inspect: async () => ({ head: 'b'.repeat(40), dirty: false, changedPaths: [], outcome: 'supported' }) };
  runtime = new SupervisorProjectRuntime({ store, service: double, workspaces, supervisor, config: projectConfig });
  const service = new BridgeService({ store, adapter, projects: runtime, maxConcurrent: 4 });
  runtime.attach({ service: double, workspaces, supervisor });

  const submitProject = async (packet) => {
    const p = validatePacket(packet);
    const grant = resolveProjectGrant(p.project, projectConfig);
    const record = createProjectRecord({ packet: p, grant, now: Date.now() });
    const result = store.submit(p, {
      effectiveModel: { ...MODEL },
      callbackBinding: { grantId: 'grant-1', targetId: 'target-1', boundAt: 1 },
      project: record,
    });
    if (result.created) ledger.reserve({ key: `task:${result.task.id}`, kind: 'root', taskId: result.task.id });
    return result.task;
  };

  return { dir, repository, store, service, runtime, supervisor, submitted, sinkCalls, ledger, projectConfig, adapter, submitProject };
}

function planThree(env, taskId) {
  const { runtime } = env;
  assert.equal(runtime.workerCreate({ taskId, args: { workerKey: 'reader-a', objective: 'read a', role: 'review', tools: ['read'], budgets: { maxToolCalls: 10 } } }).state, 'queued');
  runtime.workerCreate({ taskId, args: { workerKey: 'reader-b', objective: 'read b', role: 'review', tools: ['read'], budgets: { maxToolCalls: 10 } } });
  runtime.workerCreate({ taskId, args: { workerKey: 'writer-c', objective: 'write c', role: 'implement', tools: ['read', 'write', 'edit'], writeRoots: [env.repository], budgets: { maxToolCalls: 10 } } });
  const frozen = runtime.planFinalize({ taskId });
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.workerCount, 3);
}

/** Settle one owned worker task with a positive stop, exactly like the real service. */
async function settleWorker(env, taskId, status = 'completed') {
  env.store.update(taskId, {
    status,
    phase: status,
    stopConfirmed: true,
    activeJobs: 0,
    activeChildren: 0,
    endedAt: Date.now(),
    result: { text: 'done', evidence: [], checks: [], uncertainties: [] },
  });
  if (env.ledger.has(`task:${taskId}`)) env.ledger.release(`task:${taskId}`, { stopConfirmed: true, reason: 'test settlement' });
  await env.runtime.onTaskSettled(env.store.get(taskId));
  await env.runtime.whenIdle(env.store.get(taskId).packet.parentTaskId);
}

// ---------------------------------------------------------------------------
// A1: exactly exhausted starts with already running workers
// ---------------------------------------------------------------------------

test('exactly exhausted worker starts with running workers produce no false failure callback, then complete normally', async (t) => {
  const env = makeEnv();
  t.after(() => env.store.close());
  const task = await env.submitProject(projectPacket(env.repository, { maxWorkerStarts: 3, maxConcurrentWorkers: 3 }));
  planThree(env, task.id);
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 });
  assert.equal(await waitFor(() => env.submitted.length === 3), true, 'all three fundable starts are dispatched');

  const running = env.store.get(task.id);
  assert.equal(running.project.budgets.starts, 3);
  assert.equal(running.project.grant.maxWorkerStarts, 3);
  assert.deepEqual(
    running.project.workers.map((worker) => worker.attempts[0]?.state),
    ['dispatching', 'dispatching', 'dispatching'],
    'every admitted worker is live at the exhausted start cap'
  );
  // An exactly exhausted start cap with only admitted live work WAITS: the transition is
  // recorded and no failure/serious-issue is planned while the workers are still running.
  const settling = readEvents(env.store, task.id).filter((event) => event.type === 'project/live-work-settling');
  assert.ok(settling.length >= 1, 'the exhausted start cap with live workers records a settling wait');
  assert.deepEqual(env.sinkCalls, [], 'no callback is emitted while the admitted workers are still live');

  for (const entry of [...env.submitted]) await settleWorker(env, entry.id);
  await env.runtime.whenIdle(task.id);

  const settled = env.store.get(task.id);
  assert.equal(settled.project.status, 'completed', 'the project completes normally');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.project.budgets.starts, 3, 'the start cap is exactly consumed by admitted work');
  const falseAlarms = readEvents(env.store, task.id).filter((event) => ['project/failing', 'project/budget-exhausted', 'project/serious-issue'].includes(event.type));
  assert.deepEqual(falseAlarms, [], 'an exactly exhausted start cap with live workers never emits a failure transition');
  const serious = readEvents(env.store, task.id).filter((event) => event.type === 'project/serious-issue');
  assert.deepEqual(serious, [], 'no blocked/serious-issue transition is recorded');
  assert.equal(settled.project.callbacks?.['serious-issue'], undefined, 'no false failure callback is planned');
  assert.equal(settled.project.callbacks?.completion?.delivery, 'queued', 'the real completion callback has a positive enqueue acknowledgement');
  const kinds = env.sinkCalls.map((event) => event.kind);
  assert.deepEqual(kinds, ['completed'], 'the only notification is the single completion');
});

test('a never-startable worker still fails honestly at the same exhausted start cap', async (t) => {
  const env = makeEnv();
  t.after(() => env.store.close());
  const task = await env.submitProject(projectPacket(env.repository, { maxWorkers: 2, maxConcurrentWorkers: 2, maxWorkerStarts: 1 }, 'project-live-2'));
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'bounded a', role: 'review', tools: ['read'] } });
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'bounded b', role: 'review', tools: ['read'] } });
  env.runtime.planFinalize({ taskId: task.id });
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 });
  assert.equal(await waitFor(() => env.submitted.length === 1), true, 'only the single fundable start is dispatched');

  await settleWorker(env, env.submitted[0].id);
  await env.runtime.whenIdle(task.id);

  const settled = env.store.get(task.id);
  assert.ok(['failed', 'unknown'].includes(settled.status), `unfunded work settles honestly, got ${settled.status}`);
  assert.notEqual(settled.project.status, 'pending');
  const workerB = settled.project.workers.find((worker) => worker.workerKey === 'b');
  assert.equal(workerB.attempts[0]?.budgetRefused, 'project-start-budget', 'the unfunded worker records the real refusal');
});

// ---------------------------------------------------------------------------
// late cancel outcomes must not overwrite a newer attempt or a settled same attempt
// ---------------------------------------------------------------------------

function cancelRaceService({ cancelImpl, supervisor = null }) {
  const dir = makeDir('dsh-cancel-');
  const store = new TaskStore({ directory: dir, ownerId: 'owner-cancel' });
  const adapter = {
    models: async () => [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
    inspect: async () => ({ status: 'unknown', stopConfirmed: false, activeJobs: null, activeChildren: null }),
    cancel: cancelImpl,
  };
  const service = new BridgeService({ store, adapter, supervisor });
  // A REAL validated packet: the store requires the canonical fields (dependencies,
  // schemaVersion, budget) that only validatePacket normalizes.
  const task = store.submit(validatePacket({
    schemaVersion: 1,
    idempotencyKey: 'cancel-race-1',
    revision: 1,
    projectId: 'pj-cancel',
    title: 'cancel race',
    objective: 'exercise a delayed cancel outcome',
    cwd: dir,
    role: 'investigate',
    acceptance: ['bounded'],
    scope: { readRoots: [dir], writeRoots: [], allowedTools: ['read'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [],
    contractVersion: 'v1',
    budget: { timeoutMs: 1000, maxToolCalls: 2, maxOutputChars: 1000 },
  }), { effectiveModel: { ...MODEL } }).task;
  // A genuinely DISPATCHED live task: a bare dispatchStarted/sessionId marker over a
  // queued status lets the pre-dispatch branch swallow the cancel, so the delayed cancel
  // outcome never reaches adapter.cancel at all.
  store.update(task.id, { status: 'running', phase: 'running', dispatchStarted: true, sessionId: 'session-cancel-1' });
  return { store, service, taskId: task.id };
}

function unknownTaskError() {
  const error = new Error('task has no trusted recoverable record: task has no sessionId');
  error.code = 'adapter/unknown-task';
  return error;
}

test('a late cancel error never overwrites a SAME attempt that already settled positively', async (t) => {
  let released;
  let entered = false;
  const gate = new Promise((resolve) => { released = resolve; });
  const env = cancelRaceService({ cancelImpl: async () => { entered = true; await gate; throw unknownTaskError(); } });
  t.after(() => env.store.close());
  const pending = env.service.cancel(env.taskId, 'project deadline exceeded');
  assert.equal(entered, true, 'the delayed cancel really entered the adapter before the race is released');
  // The real host stop proof lands while the delayed cancel is still in flight.
  env.service.finish(env.taskId, { status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0, text: 'stopped' });
  const mid = env.store.get(env.taskId);
  assert.equal(mid.status, 'cancelled');
  assert.equal(mid.stopConfirmed, true);
  released();
  await assert.rejects(() => pending, (error) => error.code === 'adapter/unknown-task');
  const after = env.store.get(env.taskId);
  assert.equal(after.stopConfirmed, true, 'the numeric-zero stop proof is retained');
  assert.equal(after.activeJobs, 0);
  assert.equal(after.activeChildren, 0);
  assert.equal(after.cancelError, undefined, 'a stale cancel error is never written over a positive stop');
});

test('a late cancel error is never written onto a newer attempt', async (t) => {
  let released;
  let entered = false;
  const gate = new Promise((resolve) => { released = resolve; });
  const env = cancelRaceService({ cancelImpl: async () => { entered = true; await gate; throw unknownTaskError(); } });
  t.after(() => env.store.close());
  const pending = env.service.cancel(env.taskId, 'project deadline exceeded');
  assert.equal(entered, true, 'the delayed cancel really entered the adapter before the newer attempt lands');
  // A new attempt is minted while the delayed cancel is in flight. attemptId advances
  // only through the store's own attempt boundary, never through a plain update.
  const before = env.store.get(env.taskId);
  const nextAttemptId = 'attempt-2';
  env.store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(
    JSON.stringify({ ...before, attemptId: nextAttemptId, attempt: 2 }),
    env.taskId,
  );
  released();
  await assert.rejects(() => pending, (error) => error.code === 'adapter/unknown-task');
  const after = env.store.get(env.taskId);
  assert.equal(after.attemptId, nextAttemptId);
  assert.equal(after.cancelError, undefined, 'the stale cancel error is dropped for the newer attempt');
  assert.equal(after.stopConfirmed, before.stopConfirmed, 'the newer attempt is otherwise untouched');
});

test('a late cancel error for an unproven same attempt is still recorded', async (t) => {
  let released;
  let entered = false;
  const gate = new Promise((resolve) => { released = resolve; });
  const env = cancelRaceService({ cancelImpl: async () => { entered = true; await gate; throw unknownTaskError(); } });
  t.after(() => env.store.close());
  const pending = env.service.cancel(env.taskId, 'project deadline exceeded');
  assert.equal(entered, true, 'the delayed cancel really entered the adapter');
  released();
  await assert.rejects(() => pending, (error) => error.code === 'adapter/unknown-task');
  const after = env.store.get(env.taskId);
  assert.equal(after.cancelError?.code, 'adapter/unknown-task', 'a genuine unproven cancel failure is still recorded');
  assert.equal(after.stopConfirmed, false);
});

// ---------------------------------------------------------------------------
// reconciliation consumes real inspector evidence without replaying a model round
// ---------------------------------------------------------------------------

test('a cancellation with a missing child count uses the authoritative manager, but an unknown one is never zero', async (t) => {
  // Legacy path: no owned-child manager at all, so zero children is authoritative and the
  // ordinary cancel terminal behaviour is preserved byte-for-byte.
  const legacy = cancelRaceService({ cancelImpl: async () => ({ stopConfirmed: true, remaining: [] }) });
  t.after(() => legacy.store.close());
  legacy.service.finish(legacy.taskId, { status: 'cancelled', stopConfirmed: true, activeJobs: 0 });
  const legacyAfter = legacy.store.get(legacy.taskId);
  assert.equal(legacyAfter.status, 'cancelled', 'legacy cancel with a proven child manager stays terminal');
  assert.equal(legacyAfter.activeChildren, 0);
  assert.equal(legacyAfter.activeChildrenSource, 'legacy-no-child-manager', 'a real no-manager host records its provenance');

  // An explicitly UNKNOWN child count is never inferred as zero: the record stays an
  // honest unknown with its stop unproven.
  const unknown = cancelRaceService({ cancelImpl: async () => ({ stopConfirmed: true, remaining: [] }) });
  t.after(() => unknown.store.close());
  unknown.service.finish(unknown.taskId, { status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: null });
  const unknownAfter = unknown.store.get(unknown.taskId);
  assert.equal(unknownAfter.status, 'unknown', 'a null child count is unknown, never zero');
  assert.equal(unknownAfter.activeChildren, null);
  assert.equal(unknownAfter.stopConfirmed, false);
  assert.equal(unknownAfter.activeChildrenSource, 'host-reported', 'the explicit host null is recorded as host-reported');
  assert.equal(unknown.service.get(unknown.taskId).activeChildren, null, 'the PUBLIC view keeps the explicit unknown as null, never 0');
});

test('project reconcile consults the real inspector and keeps an unproven root blocked with occupancy', async (t) => {
  const env = makeEnv();
  t.after(() => env.store.close());
  const task = await env.submitProject(projectPacket(env.repository, { maxWorkerStarts: 3, maxConcurrentWorkers: 3 }, 'project-reconcile-1'));
  planThree(env, task.id);
  let inspectCalls = 0;
  env.service.adapter.inspect = async () => {
    inspectCalls += 1;
    return { status: 'unknown', stopConfirmed: false, activeJobs: null, activeChildren: null, known: false, reason: 'unknown-task' };
  };
  // A terminal string with an UNPROVEN round: the recorded round has no numeric child
  // count, which is unknown and must never be coerced into a zero.
  const project = env.store.get(task.id).project;
  project.rounds = [{ attemptId: 'round-1', status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: null, at: Date.now() }];
  project.status = 'blocked';
  project.seriousIssue = { code: 'clean-stop-unproven', message: 'refusing a clean failure', at: Date.now() };
  env.store.update(task.id, { status: 'unknown', stopConfirmed: false, activeJobs: 0, activeChildren: 0, project });

  await env.service.reconcile(task.id);

  assert.equal(inspectCalls, 1, 'reconcile consults the real inspector exactly once');
  const after = env.store.get(task.id);
  assert.equal(after.project.status, 'blocked', 'the unproven project root stays honestly blocked');
  assert.equal(after.status, 'unknown', 'a terminal string alone is never a stop');
  assert.equal(after.stopConfirmed, false);
  assert.equal(after.project.reconcileObserved?.proven, false, 'the null child count is recorded as unproven');
  assert.equal(after.project.reconcileObserved?.activeChildren, null, 'a missing child count is never coerced to zero');
  assert.equal(after.project.rounds.at(-1)?.source, undefined, 'unproven evidence never rewrites the recorded round proof');
  assert.deepEqual(env.submitted, [], 'reconciliation replays no worker dispatch');
  assert.equal(env.ledger.has(`task:${task.id}`), true, 'the unproven root keeps its occupancy');
});

test('project reconcile accepts only explicit numeric-zero inspector evidence as a proven stop', async (t) => {
  const env = makeEnv();
  t.after(() => env.store.close());
  const task = await env.submitProject(projectPacket(env.repository, {}, 'project-reconcile-2'));
  const base = env.store.get(task.id).project;
  env.store.update(task.id, { status: 'unknown', stopConfirmed: false, project: { ...base, status: 'blocked' } });
  // Missing child count: consumed as evidence, recorded unproven, never a stop.
  env.service.adapter.inspect = async () => ({ status: 'cancelled', stopConfirmed: true, activeJobs: 0 });
  await env.service.reconcile(task.id);
  assert.equal(env.store.get(task.id).project.reconcileObserved?.proven, false);
  // Explicit numeric zeros for BOTH counts: a real positive stop, consumed into the round
  // bound to the exact current attempt (no worker proof is inferred from it).
  env.service.adapter.inspect = async () => ({ status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0 });
  await env.service.reconcile(task.id);
  const after = env.store.get(task.id);
  assert.equal(after.project.reconcileObserved?.proven, true, 'explicit numeric zero jobs and children is a proven stop');
  const consumed = after.project.rounds.at(-1);
  assert.equal(consumed?.source, 'reconcile', 'the positive proof is consumed into a round bound to the current attempt');
  assert.equal(consumed?.attemptId, after.attemptId, 'the consumed round is bound to the exact current attempt');
  assert.equal(consumed?.stopConfirmed, true);
  assert.equal(consumed?.activeJobs, 0);
  assert.equal(consumed?.activeChildren, 0);
  assert.equal(consumed?.activeChildrenSource, 'host-reported', 'the consumed zero is the inspector-reported host value');
});

test('a terminal project string without valid proof is forced unknown/blocked, while valid proof is retained', async (t) => {
  const env = makeEnv();
  t.after(() => env.store.close());
  const task = await env.submitProject(projectPacket(env.repository, {}, 'project-reconcile-3'));
  const current = env.store.get(task.id);
  // An old terminal STRING with an unproven round (no numeric child count) and a false
  // stop flag: the inspector cannot prove a stop, so the record must not stay terminal.
  env.store.update(task.id, {
    status: 'cancelled',
    stopConfirmed: false,
    project: {
      ...current.project,
      status: 'cancelled',
      rounds: [{ attemptId: current.attemptId, status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: null, at: Date.now() }],
    },
  });
  env.service.adapter.inspect = async () => ({ status: 'unknown', stopConfirmed: false, activeJobs: null, activeChildren: null, reason: 'unknown-task' });
  await env.service.reconcile(task.id);
  const blocked = env.store.get(task.id);
  assert.equal(blocked.project.status, 'blocked', 'a terminal string without valid proof is never kept');
  assert.equal(blocked.status, 'unknown');
  assert.equal(blocked.stopConfirmed, false, 'no stop is fabricated from a terminal string');
  assert.equal(blocked.project.reconcileObserved?.proven, false);

  // A project that ALREADY holds valid persisted stop proof is not revoked by a later
  // unavailable inspector.
  const env2 = makeEnv();
  t.after(() => env2.store.close());
  const task2 = await env2.submitProject(projectPacket(env2.repository, {}, 'project-reconcile-4'));
  const current2 = env2.store.get(task2.id);
  env2.store.update(task2.id, {
    status: 'completed',
    stopConfirmed: true,
    activeJobs: 0,
    activeChildren: 0,
    project: {
      ...current2.project,
      status: 'completed',
      rounds: [{ attemptId: current2.attemptId, status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() }],
    },
  });
  env2.service.adapter.inspect = async () => { throw unknownTaskError(); };
  await env2.service.reconcile(task2.id);
  const retained = env2.store.get(task2.id);
  assert.equal(retained.project.status, 'completed', 'valid persisted stop proof is retained when the inspector is unavailable');
  assert.equal(retained.stopConfirmed, true);
});

test('an omitted child count resolves from the real owned-child manager, and an uninspectable manager stays unknown', async (t) => {
  const ledger = { has: () => false, counts: () => ({ free: 8 }) };
  const live = cancelRaceService({ cancelImpl: async () => ({ stopConfirmed: true, remaining: [] }), supervisor: { ledger, liveChildren: () => [{ childId: 'c1' }] } });
  t.after(() => live.store.close());
  live.service.finish(live.taskId, { status: 'cancelled', stopConfirmed: true, activeJobs: 0 });
  const liveAfter = live.store.get(live.taskId);
  assert.equal(liveAfter.status, 'unknown', 'a live owned child is never a proven stop');
  assert.equal(liveAfter.stopConfirmed, false, 'the aggregate stop flag is never claimed from a live child');
  assert.equal(liveAfter.activeChildren, 1);
  assert.equal(liveAfter.activeChildrenSource, 'owned-manager');

  const blind = cancelRaceService({ cancelImpl: async () => ({ stopConfirmed: true, remaining: [] }), supervisor: { ledger, liveChildren: () => { throw new Error('cannot inspect children'); } } });
  t.after(() => blind.store.close());
  blind.service.finish(blind.taskId, { status: 'cancelled', stopConfirmed: true, activeJobs: 0 });
  const blindAfter = blind.store.get(blind.taskId);
  assert.equal(blindAfter.status, 'unknown');
  assert.equal(blindAfter.stopConfirmed, false);
  assert.equal(blindAfter.activeChildren, null, 'a configured manager that cannot inspect stays unknown');
  assert.equal(blindAfter.activeChildrenSource, 'owned-manager-unavailable');
  assert.equal(blind.service.get(blind.taskId).activeChildren, null, 'the PUBLIC view keeps an uninspectable manager unknown, never 0');
});

test('a terminal project with real positive inspector proof is consumed into the exact attempt and converges its cancellation', async (t) => {
  const env = makeEnv();
  t.after(() => env.store.close());
  const task = await env.submitProject(projectPacket(env.repository, {}, 'project-reconcile-terminal-1'));
  const current = env.store.get(task.id);
  env.store.update(task.id, {
    status: 'cancelled',
    phase: 'project',
    stopConfirmed: false,
    activeJobs: 0,
    activeChildren: 0,
    endedAt: Date.now(),
    project: {
      ...current.project,
      status: 'cancelled',
      cancelRequested: true,
      cancelReason: 'controller requested',
      rounds: [{ attemptId: current.attemptId, status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: null, at: Date.now() }],
    },
  });
  assert.equal(env.ledger.has(`task:${task.id}`), true, 'the unproven terminal still holds its model reservation');
  // Direct terminal-unproven -> real positive: WITHOUT first passing through the
  // unavailable/blocked observation.
  env.service.adapter.inspect = async () => ({ status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0 });
  await env.service.reconcile(task.id);
  const after = env.store.get(task.id);
  assert.equal(after.status, 'cancelled', 'the existing cancellation converges on the real proof');
  assert.equal(after.stopConfirmed, true);
  assert.equal(after.activeJobs, 0);
  assert.equal(after.activeChildren, 0);
  const consumed = after.project.rounds.at(-1);
  assert.equal(consumed?.attemptId, current.attemptId, 'the proof is bound to the exact current attempt');
  assert.equal(consumed?.source, 'reconcile');
  assert.equal(consumed?.stopConfirmed, true);
  assert.equal(consumed?.activeJobs, 0);
  assert.equal(consumed?.activeChildren, 0);
  assert.equal(consumed?.activeChildrenSource, 'host-reported');
  assert.equal(env.ledger.has(`task:${task.id}`), false, 'the proven root releases the real model reservation');
  assert.deepEqual(env.submitted, [], 'reconciliation never dispatches or replays a round');
});

test('reconcile keeps occupancy when owned work has no verified stop', async (t) => {
  const env = makeEnv();
  t.after(() => env.store.close());
  const task = await env.submitProject(projectPacket(env.repository, { maxWorkerStarts: 1 }, 'project-reconcile-terminal-2'));
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: 'bounded work', role: 'review', tools: ['read'] } });
  env.runtime.planFinalize({ taskId: task.id });
  const current = env.store.get(task.id);
  const project = {
    ...current.project,
    status: 'cancelled',
    cancelRequested: true,
    cancelReason: 'controller requested',
    rounds: [{ attemptId: current.attemptId, status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: null, at: Date.now() }],
    workers: current.project.workers.map((worker) => ({
      ...worker,
      attempts: [{ attempt: 1, state: 'dispatching', taskId: null, idempotencyKey: 'ambiguous-1', grantedToolCalls: 0, toolAllowanceReleased: false }],
    })),
  };
  env.store.update(task.id, { status: 'cancelled', phase: 'project', stopConfirmed: false, activeJobs: 0, activeChildren: 0, endedAt: Date.now(), project });
  env.service.adapter.inspect = async () => ({ status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0 });
  await env.service.reconcile(task.id);
  const after = env.store.get(task.id);
  assert.equal(after.project.status, 'blocked', 'unproven owned work is never certified as a stopped cancellation');
  assert.equal(after.status, 'unknown');
  assert.equal(after.stopConfirmed, false);
  assert.equal(after.project.seriousIssue?.code, 'project-cancel-unconfirmed');
  assert.equal(env.ledger.has(`task:${task.id}`), true, 'the unproven owned work keeps the root occupancy');
  assert.deepEqual(env.submitted, [], 'reconciliation never dispatches owned work');
});
