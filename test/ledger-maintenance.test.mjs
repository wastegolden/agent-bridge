// test/ledger-maintenance.test.mjs
//
// First-edition maintenance: the two observed root-reservation accounting defects,
// exercised against the REAL BridgeService, the REAL shared HostReservationLedger and
// the REAL SupervisorProjectRuntime.
//
//  * Defect 1 (A1) — cancelling an idle awaiting-approval task with genuine true/0/0
//    proof recorded a terminal cancelled record but never settled its root reservation.
//  * Defect 2 (A2/A3) — service.recover branched into recoverProject before the ordinary
//    root adoption, so an unknown/unproved project root had no reservation after restart.
//  * Repair round 2 — #settleRecoveredRoot released the root for a positively stopped round
//    even when owned work was unaccounted (untracked ambiguous dispatch, unreadable binding,
//    or a readable task that does not genuinely belong to the project), leaking capacity.
//    The `repair2/*` cases below exercise that against the real shared ledger.
//
// Every assertion here targets a behavior that is absent on the base revision:
//  - before the fix, `ledger.has('task:<id>')` stayed true after an awaiting-approval
//    cancellation (A1), and
//  - before the fix, `ledger.has('task:<id>')` stayed false after recovering an unproved
//    project root (A2), and a configured-but-missing child inspector produced a numeric
//    zero (m3), which could certify a phantom stopped round.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail('condition timed out');
    await sleep(10);
  }
}
function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function packet(root, key, extra = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: key,
    revision: 1,
    projectId: 'pj-maint',
    title: key,
    objective: 'bounded read used to exercise reservation accounting',
    cwd: root,
    role: 'investigate',
    acceptance: ['evidence'],
    scope: { readRoots: [root], writeRoots: [], allowedTools: ['read'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [],
    contractVersion: 'v1',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Defect 1: pre-dispatch / approval cancellation settles its own root key
// ---------------------------------------------------------------------------

/**
 * A real BridgeService over a real TaskStore and a real HostReservationLedger.
 * `supervisorMode` is the child-inspection seam under test:
 *   full     — a real BridgeSupervisor (callable liveChildren)
 *   blind    — configured, but liveChildren is MISSING (m3's corrected case)
 *   throwing — configured, liveChildren throws
 *   live     — configured, reports one live owned child
 *   none     — no child manager at all (legacy authoritative zero)
 */
function makeCancelEnv({ supervisorMode = 'full', ledgerLimit = 4, adapterOverrides = {} } = {}) {
  const dir = makeDir('dsh-maint-cancel-');
  const store = new TaskStore({ directory: dir, ownerId: 'owner-maint-cancel' });
  const ledger = new HostReservationLedger({ limit: ledgerLimit, id: `maint-cancel-${randomUUID()}` });
  const starts = [];
  const callbacks = new Map();
  const adapter = {
    models: async () => [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
    capabilities: async () => ({}),
    start: async (task, cb) => {
      starts.push(task);
      callbacks.set(task.id, cb);
      return { sessionId: `session-${task.id}`, requestId: `request-${task.id}`, effectiveModel: task.effectiveModel, effectivePolicy: { fileScope: 'hard' } };
    },
    continue: async (task, understanding, cb) => adapter.start(task, cb),
    cancel: async () => ({ accepted: true, stopConfirmed: true, remaining: [] }),
    inspect: async () => ({ status: 'unknown', stopConfirmed: false, activeJobs: null, activeChildren: null }),
    cleanup: async () => ({ cleaned: true }),
    ...adapterOverrides,
  };
  let supervisor = null;
  if (supervisorMode === 'full') supervisor = new BridgeSupervisor({ ledger, ownerId: 'owner-maint-cancel' });
  else if (supervisorMode === 'blind') supervisor = { ledger };
  else if (supervisorMode === 'throwing') supervisor = { ledger, liveChildren: () => { throw new Error('owned-child manager unavailable'); } };
  else if (supervisorMode === 'live') supervisor = { ledger, liveChildren: () => [{ childId: 'child-1' }] };
  const service = new BridgeService({ store, adapter, supervisor, maxConcurrent: 4 });
  // Count every release so "exactly once" is observable, not narrated.
  const released = [];
  const release = ledger.release.bind(ledger);
  ledger.release = (key, options) => {
    released.push(key);
    return release(key, options);
  };
  const settleUnderstanding = (id, text = 'only read file A') => callbacks.get(id).onResult({ status: 'completed', text, stopConfirmed: true, activeJobs: 0 });
  return {
    dir,
    store,
    ledger,
    adapter,
    service,
    starts,
    released,
    settleUnderstanding,
    key: (id) => `task:${id}`,
    close() {
      service.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Drive one gated task to a genuine awaiting-approval record with true/0/0. */
async function driveToAwaitingApproval(env, key) {
  const task = await env.service.submit(packet(env.dir, key, { understandingRequired: true }));
  await until(() => env.starts.length >= 1 && env.starts.at(-1).id === task.id);
  env.settleUnderstanding(task.id);
  await until(() => env.service.get(task.id).status === 'awaiting_approval');
  return task.id;
}

test('A1: cancelling an idle awaiting-approval task with genuine true/0/0 releases its root reservation exactly once', async (t) => {
  const env = makeCancelEnv();
  t.after(() => env.close());
  const id = await driveToAwaitingApproval(env, 'maint-a1-approval-cancel');
  const held = env.ledger.get(env.key(id));
  assert.ok(held, 'the understanding round holds the root reservation while awaiting approval');
  assert.equal(held.ambiguous, true, 'the unsettled awaiting round is marked unknown, never silently released');
  const before = env.service.get(id);
  assert.equal(before.stopConfirmed, true);
  assert.equal(before.activeJobs, 0);
  assert.equal(before.activeChildren, 0);

  const cancelled = await env.service.cancel(id, 'operator cancelled the gate');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stopConfirmed, true);
  assert.equal(env.ledger.has(env.key(id)), false, 'the actual root reservation is released immediately');
  assert.deepEqual(env.released, [env.key(id)], 'released exactly once, for its own key');
  assert.equal(env.ledger.counts().free, env.ledger.limit, 'no unrelated slot was disturbed');

  const again = await env.service.cancel(id, 'duplicate cancellation');
  assert.equal(again.status, 'cancelled');
  assert.deepEqual(env.released, [env.key(id)], 'a duplicate cancellation settles nothing a second time');
  assert.equal(env.ledger.has(env.key(id)), false);
});

test('A1/A3: unproven, null or nonzero pre-dispatch evidence never manufactures a stop or a release', async (t) => {
  // (a) a persisted null job count is unknown, never zero.
  const nullJobs = makeCancelEnv();
  t.after(() => nullJobs.close());
  const a = await driveToAwaitingApproval(nullJobs, 'maint-null-jobs');
  nullJobs.store.update(a, { activeJobs: null });
  const aOut = await nullJobs.service.cancel(a, 'unknown job count');
  assert.equal(aOut.status, 'unknown');
  assert.equal(aOut.stopConfirmed, false);
  assert.equal(aOut.activeJobs, null);
  assert.equal(nullJobs.ledger.has(nullJobs.key(a)), true, 'an unknown job count keeps the root slot');
  assert.deepEqual(nullJobs.released, [], 'no release without genuine proof');

  // (b) a nonzero job count is live work.
  const busyJobs = makeCancelEnv();
  t.after(() => busyJobs.close());
  const b = await driveToAwaitingApproval(busyJobs, 'maint-busy-jobs');
  busyJobs.store.update(b, { activeJobs: 2 });
  const bOut = await busyJobs.service.cancel(b, 'live jobs');
  assert.equal(bOut.status, 'unknown');
  assert.equal(bOut.activeJobs, 2);
  assert.equal(busyJobs.ledger.has(busyJobs.key(b)), true, 'a nonzero job count keeps the root slot');

  // (c) a false persisted stop flag is not proof.
  const falseStop = makeCancelEnv();
  t.after(() => falseStop.close());
  const c = await driveToAwaitingApproval(falseStop, 'maint-false-stop');
  falseStop.store.update(c, { stopConfirmed: false });
  const cOut = await falseStop.service.cancel(c, 'unconfirmed stop');
  assert.equal(cOut.status, 'unknown');
  assert.equal(cOut.stopConfirmed, false);
  assert.equal(falseStop.ledger.has(falseStop.key(c)), true, 'an unconfirmed stop keeps the root slot');

  // (d) a CONFIGURED child manager whose inspector is missing is unknown, not zero.
  const blind = makeCancelEnv();
  t.after(() => blind.close());
  const d = await driveToAwaitingApproval(blind, 'maint-blind-inspector');
  blind.service.supervisor = { ledger: blind.ledger };
  const dOut = await blind.service.cancel(d, 'configured manager without an inspector');
  assert.equal(dOut.status, 'unknown');
  assert.equal(blind.store.get(d).activeChildren, null);
  assert.equal(blind.store.get(d).activeChildrenSource, 'owned-manager-unavailable');
  // The PUBLIC view (bridge_check/bridge_cancel/bridge_list) must preserve the explicit
  // unknown as null instead of turning it into a fabricated numeric zero.
  assert.equal(blind.service.get(d).activeChildren, null, 'the public view preserves unknown as null');
  assert.equal(blind.service.get(d).activeChildrenSource, 'owned-manager-unavailable');
  assert.equal((await blind.service.wait(d, { waitMs: 0 })).task.activeChildren, null, 'the bridge_check wait view keeps null too');
  assert.equal(blind.ledger.has(blind.key(d)), true, 'a missing inspector never releases capacity');

  // (e) a CONFIGURED inspector that throws stays unknown too.
  const throwing = makeCancelEnv();
  t.after(() => throwing.close());
  const e = await driveToAwaitingApproval(throwing, 'maint-throwing-inspector');
  throwing.service.supervisor = { ledger: throwing.ledger, liveChildren: () => { throw new Error('unavailable'); } };
  const eOut = await throwing.service.cancel(e, 'throwing inspector');
  assert.equal(eOut.status, 'unknown');
  assert.equal(throwing.store.get(e).activeChildren, null);
  assert.equal(throwing.store.get(e).activeChildrenSource, 'owned-manager-unavailable');
  assert.equal(throwing.service.get(e).activeChildren, null, 'a throwing inspector is unknown in the public view as well');
  assert.equal(throwing.ledger.has(throwing.key(e)), true);

  // (f) a live owned child is live work.
  const live = makeCancelEnv();
  t.after(() => live.close());
  const f = await driveToAwaitingApproval(live, 'maint-live-child');
  live.service.supervisor = { ledger: live.ledger, liveChildren: () => [{ childId: 'child-1' }] };
  const fOut = await live.service.cancel(f, 'live owned child');
  assert.equal(fOut.status, 'unknown');
  assert.equal(live.store.get(f).activeChildren, 1);
  assert.equal(live.store.get(f).activeChildrenSource, 'owned-manager');
  assert.equal(live.ledger.has(live.key(f)), true, 'a live owned child keeps the root slot');
});

test('A4: historical safe ordinary queued cancellation is preserved, and a dispatched queued session is not structural', async (t) => {
  // Legacy host with NO child manager: a genuinely never-dispatched queued task still
  // cancels with the legacy authoritative zero, exactly as before.
  const legacy = makeCancelEnv({ supervisorMode: 'none' });
  t.after(() => legacy.close());
  const created = legacy.store.submit(validatePacket(packet(legacy.dir, 'maint-legacy-queued')), { effectiveModel: { ...MODEL } });
  assert.equal(legacy.store.get(created.task.id).status, 'queued');
  const outcome = await legacy.service.cancel(created.task.id, 'controller requested');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.stopConfirmed, true);
  assert.equal(outcome.activeJobs, 0);
  assert.equal(outcome.activeChildren, 0);
  assert.equal(outcome.activeChildrenSource, 'legacy-no-child-manager');

  // A queued record that DID cross the host boundary (session/dispatch evidence) is not
  // structural: missing proof keeps it unknown instead of manufacturing a stop.
  const dispatched = makeCancelEnv();
  t.after(() => dispatched.close());
  const queued = dispatched.store.submit(validatePacket(packet(dispatched.dir, 'maint-queued-dispatched')), { effectiveModel: { ...MODEL } });
  dispatched.store.update(queued.task.id, { dispatchStarted: true, sessionId: 'session-queued', stopConfirmed: false, activeJobs: null });
  const qOut = await dispatched.service.cancel(queued.task.id, 'queued but previously dispatched');
  assert.equal(qOut.status, 'unknown');
  assert.equal(qOut.stopConfirmed, false);
  assert.equal(qOut.activeJobs, null);
});

test('A3: a late cancel error from a superseded attempt never touches the newer attempt reservation', async (t) => {
  const env = makeCancelEnv();
  t.after(() => env.close());
  let release;
  let entered = false;
  const gate = new Promise((resolve) => { release = resolve; });
  env.adapter.cancel = async () => { entered = true; await gate; const error = new Error('task has no trusted recoverable record'); error.code = 'adapter/unknown-task'; throw error; };
  const task = await env.service.submit(packet(env.dir, 'maint-stale-attempt'));
  await until(() => env.service.get(task.id).status === 'running' || env.service.get(task.id).status === 'starting');
  const key = env.key(task.id);
  assert.equal(env.ledger.has(key), true, 'the live attempt holds its root reservation');

  const pending = env.service.cancel(task.id, 'stale attempt race');
  assert.equal(entered, true, 'the delayed cancel really entered the adapter');
  // A newer attempt is minted and re-binds the SAME root key (approved-continuation reuse)
  // while the old cancel is still in flight.
  const before = env.store.get(task.id);
  env.store.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(
    JSON.stringify({ ...before, attemptId: 'attempt-newer', attempt: 2 }),
    task.id,
  );
  env.ledger.release(key, { stopConfirmed: true, reason: 'test rebind of the superseded attempt' });
  env.ledger.reserve({ key, kind: 'root', taskId: task.id, attemptId: 'attempt-newer' });
  const releasesBefore = env.released.length;

  release();
  await assert.rejects(() => pending, (error) => error.code === 'adapter/unknown-task');
  const current = env.ledger.get(key);
  assert.ok(current, 'the newer attempt keeps its reservation');
  assert.equal(current.attemptId, 'attempt-newer');
  assert.equal(current.ambiguous, false, 'the stale cancel never marks the newer reservation unknown');
  assert.equal(env.released.length, releasesBefore, 'the stale cancel releases nothing');
  assert.equal(env.store.get(task.id).cancelError, undefined, 'the stale cancel error is dropped');
});

// ---------------------------------------------------------------------------
// Defect 2: project-root recovery adopts/retains exactly once, releases on proof
// ---------------------------------------------------------------------------

function makeProjectEnv({ supervisorMode = 'full', ledgerLimit = 4 } = {}) {
  const dir = makeDir('dsh-maint-proj-');
  const repository = makeDir('dsh-maint-repo-');
  const store = new TaskStore({ directory: dir, ownerId: 'owner-maint-proj' });
  const ledger = new HostReservationLedger({ limit: ledgerLimit, id: `maint-proj-${randomUUID()}` });
  const starts = [];
  const adapter = {
    models: async () => [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
    capabilities: async () => ({}),
    start: async (task, cb) => { starts.push(task); return { sessionId: `session-${task.id}`, requestId: `request-${task.id}`, effectiveModel: task.effectiveModel, effectivePolicy: { fileScope: 'hard' } }; },
    continue: async (task, understanding, cb) => adapter.start(task, cb),
    cancel: async () => ({ accepted: true, stopConfirmed: true, remaining: [] }),
    inspect: async () => ({ status: 'unknown', stopConfirmed: false, activeJobs: null, activeChildren: null }),
    cleanup: async () => ({ cleaned: true }),
  };
  const supervisor = supervisorMode === 'full' ? new BridgeSupervisor({ ledger, ownerId: 'owner-maint-proj' }) : { ledger };
  const projectConfig = normalizeProjectConfig({ enabled: true });
  const workspaces = { inspect: async () => ({ head: 'b'.repeat(40), dirty: false, changedPaths: [], outcome: 'supported' }) };
  const runtime = new SupervisorProjectRuntime({ store, service: null, workspaces, supervisor, config: projectConfig });
  const service = new BridgeService({ store, adapter, projects: runtime, supervisor, maxConcurrent: 4 });
  runtime.attach({ service, workspaces, supervisor });
  return {
    dir,
    repository,
    store,
    ledger,
    supervisor,
    projectConfig,
    workspaces,
    runtime,
    service,
    adapter,
    starts,
    key: (id) => `task:${id}`,
    close() {
      service.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

/** Persist one project task exactly as an owning service would, in a chosen state. */
function submitProjectTask(env, { key, status = 'unknown', projectStatus = 'blocked', round, roundAttemptId, workers = [], reserve = false } = {}) {
  const project = {
    maxWorkers: 4,
    maxConcurrentWorkers: 2,
    maxWorkerStarts: 4,
    maxTotalToolCalls: 100,
    timeoutMs: 3600000,
    reserveSlots: 1,
    workerScope: { readRoots: [env.repository], writeRoots: [], allowedTools: ['read'], allowNetwork: false },
    workspace: { repository: env.repository, baseRef: 'HEAD' },
  };
  const packetWithProject = validatePacket({ ...packet(env.repository, key), project });
  const grant = resolveProjectGrant(packetWithProject.project, env.projectConfig);
  const record = createProjectRecord({ packet: packetWithProject, grant, now: Date.now() });
  record.status = projectStatus;
  record.frozenAt = Date.now();
  record.deadlines = { armed: false, expired: false };
  record.workers = workers;
  const result = env.store.submit(packetWithProject, {
    effectiveModel: { ...MODEL },
    callbackBinding: { grantId: 'grant-1', targetId: 'target-1', boundAt: 1 },
    project: record,
  });
  // A recorded round belongs to the EXACT attempt that was current when it was recorded, so
  // a positive-stop fixture persists the REAL store-minted `task.attemptId`. The task's own
  // immutable attempt identity is never rewritten. An explicit `roundAttemptId` models a
  // round recorded for a genuinely different (superseded) attempt, which proves nothing
  // about the current one.
  if (round !== undefined) {
    const persisted = env.store.get(result.task.id);
    env.store.update(result.task.id, {
      project: { ...persisted.project, rounds: [{ ...round, attemptId: roundAttemptId ?? persisted.attemptId }] },
    });
  }
  env.store.update(result.task.id, { status, stopConfirmed: false, activeJobs: 0, activeChildren: 0 });
  if (reserve) env.ledger.reserve({ key: `task:${result.task.id}`, kind: 'root', taskId: result.task.id });
  return env.store.get(result.task.id);
}

test('A2: recovery adopts an unproved project root exactly once, over limit, and dispatches nothing', async (t) => {
  const env = makeProjectEnv({ ledgerLimit: 1 });
  t.after(() => env.close());
  const task = submitProjectTask(env, {
    key: 'maint-a2-unproved',
    // The helper binds the recorded round to the real store-minted attemptId; the round is
    // still UNPROVED because its child count is explicitly null, never zero.
    round: { status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: null, at: Date.now() },
  });
  // The shared ledger is already saturated by unrelated owned work: recovery must still
  // count the recovered root (over-limit recovery is honest, not a saturation refusal).
  env.ledger.adopt({ key: 'task:unrelated', kind: 'root', taskId: 'unrelated', reason: 'fixture occupancy' });
  assert.equal(env.ledger.counts().limit, 1);
  assert.equal(env.ledger.counts().used, 1);

  await env.service.recover();
  const after = env.store.get(task.id);
  assert.ok(env.ledger instanceof HostReservationLedger, 'the settlement runs against the REAL shared ledger class, not a plain-object stub');
  const recovery = after.projectRecovery;
  assert.equal(recovery.rootReservation.action, 'adopted', 'the real ledger seam adopts the unproved root');
  assert.equal(recovery.round, 'recorded-round', 'the attempt binding holds, but the explicit null child count leaves the round unproven');
  assert.equal(after.status, 'unknown');
  assert.equal(after.project.status, 'blocked');
  assert.equal(after.project.seriousIssue.code, 'host-restart');
  assert.equal(env.ledger.has(env.key(task.id)), true, 'the unproved root is adopted into the shared ledger');
  assert.equal(env.ledger.get(env.key(task.id)).ambiguous, true);
  assert.equal(env.ledger.get(env.key(task.id)).attemptId, after.attemptId, 'the adopted root is bound to the real current attempt identity');
  assert.equal(env.ledger.counts().used, 2, 'adoption over the limit counts exactly once');
  assert.deepEqual(env.starts, [], 'recovery dispatched nothing');
  assert.equal(env.store.list().filter((candidate) => !candidate.project).length, 0, 'no worker task was created');

  await env.service.recover();
  assert.equal(env.ledger.counts().used, 2, 'idempotent recovery never double counts');
  assert.equal(env.ledger.has(env.key(task.id)), true);
});

test('A3: a strictly stopped waiting round holds no phantom root, while a previously dispatched session without proof fails closed', async (t) => {
  // (a) a strictly proven stopped round in a waiting project: the root slot is NOT held.
  const stopped = makeProjectEnv();
  t.after(() => stopped.close());
  const t1 = submitProjectTask(stopped, {
    key: 'maint-a3-stopped-round',
    status: 'supervising',
    projectStatus: 'frozen',
    // A POSITIVE round, bound by the helper to the real store-minted current attemptId.
    round: { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() },
    workers: [],
  });
  const report1 = await stopped.runtime.recoverProject(stopped.store.get(t1.id));
  assert.equal(report1.resumed, true, 'a verified waiting project keeps its deterministic flow');
  assert.equal(report1.rootReservation.action, 'absent');
  assert.equal(stopped.ledger.has(stopped.key(t1.id)), false, 'a stopped waiting round holds no phantom root slot');
  assert.deepEqual(stopped.starts, [], 'recovery itself dispatched nothing');

  // (b) a previously dispatched session with NO recorded round is never "never-dispatched".
  const missing = makeProjectEnv();
  t.after(() => missing.close());
  const t2 = submitProjectTask(missing, { key: 'maint-a3-missing-round', status: 'supervising', projectStatus: 'frozen', workers: [] });
  missing.store.update(t2.id, { dispatchStarted: true, dispatchPending: false, sessionId: 'session-lost', dispatchReceiptAt: Date.now() });
  const report2 = await missing.runtime.recoverProject(missing.store.get(t2.id));
  assert.equal(report2.resumed, false);
  assert.equal(report2.reason, 'host-restart-fail-closed');
  assert.equal(report2.round, 'round-unproven');
  assert.equal(missing.store.get(t2.id).project.status, 'blocked');
  assert.equal(missing.ledger.has(missing.key(t2.id)), true, 'an unproved dispatched session keeps its root slot');
  assert.deepEqual(missing.starts, [], 'no worker or supervisor round starts under that ambiguity');

  // (c) a genuinely never-dispatched queued project holds nothing at all.
  const never = makeProjectEnv();
  t.after(() => never.close());
  const t3 = submitProjectTask(never, { key: 'maint-a3-never-dispatched', status: 'queued', projectStatus: 'planning', workers: [] });
  const report3 = await never.runtime.recoverProject(never.store.get(t3.id));
  assert.equal(report3.rootReservation.action, 'absent');
  assert.equal(never.ledger.has(never.key(t3.id)), false, 'never-dispatched work holds no root slot');
});

test('A3: a positive round from a superseded attempt never resumes or completes the current attempt', async (t) => {
  const env = makeProjectEnv();
  t.after(() => env.close());
  // The genuine current attempt identity is minted by the store and is NEVER rewritten: the
  // recorded round merely carries a different (superseded) attempt identity.
  const supersededAttemptId = randomUUID();
  const task = submitProjectTask(env, {
    key: 'maint-stale-positive-round',
    status: 'supervising',
    projectStatus: 'frozen',
    roundAttemptId: supersededAttemptId,
    round: { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() },
    workers: [],
  });
  // A live/pending current dispatch: the persisted marker is part of the fail-closed fence.
  env.store.update(task.id, { dispatchStarted: true, dispatchPending: true, sessionId: 'session-current', dispatchReceiptAt: Date.now() });
  const current = env.store.get(task.id);
  const staleRound = current.project.rounds.at(-1);
  assert.equal(staleRound.attemptId, supersededAttemptId, 'the recorded round belongs to a different attempt');
  assert.notEqual(staleRound.attemptId, current.attemptId);
  assert.equal(staleRound.stopConfirmed, true, 'the superseded round really is a POSITIVE round');
  assert.equal(current.attemptId, task.attemptId, 'the task attempt identity is immutable and was never rewritten');

  const report = await env.runtime.recoverProject(env.store.get(task.id));
  assert.equal(report.resumed, false, 'an unbound positive round never resumes the current attempt');
  assert.equal(report.reason, 'host-restart-fail-closed');
  assert.equal(report.round, 'round-attempt-unproven', 'a mismatched attempt identity is unproven, not a synthetic stop');
  const after = env.store.get(task.id);
  assert.equal(after.status, 'unknown');
  assert.equal(after.project.status, 'blocked', 'no completion is ever synthesized from a superseded round');
  assert.equal(after.project.seriousIssue.code, 'host-restart');
  assert.equal(after.dispatchPending, true, 'the current pending dispatch fence is preserved');
  assert.equal(env.ledger.has(env.key(task.id)), true, 'the unproven current root is adopted into the shared ledger');
  assert.equal(env.ledger.get(env.key(task.id)).attemptId, after.attemptId, 'adoption binds the genuine current attempt identity');
  assert.deepEqual(env.starts, [], 'nothing is dispatched under the stale round');

  // A repeated recovery is idempotent and still refuses.
  const again = await env.runtime.recoverProject(env.store.get(task.id));
  assert.equal(again.resumed, false);
  assert.equal(env.ledger.counts().used, 1, 'the same root is counted exactly once');
});

test('A3: a configured child manager with a missing inspector can never certify a stopped round', async (t) => {
  const env = makeProjectEnv({ supervisorMode: 'blind' });
  t.after(() => env.close());
  const task = submitProjectTask(env, { key: 'maint-blind-round', status: 'running', projectStatus: 'planning', workers: [], reserve: true });
  assert.equal(env.ledger.has(env.key(task.id)), true, 'the live round holds its slot');
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 }, task.attemptId);
  const round = env.store.get(task.id).project.rounds.at(-1);
  assert.equal(round.activeChildren, null, 'a missing inspector is unknown, never zero');
  assert.equal(round.activeChildrenSource, 'owned-manager-unavailable');
  const after = env.store.get(task.id);
  assert.equal(after.project.status, 'blocked');
  assert.equal(after.project.seriousIssue.code, 'supervisor-round-unstopped');
  assert.equal(env.ledger.has(env.key(task.id)), true, 'the phantom stop never released the root');
  assert.equal(env.ledger.get(env.key(task.id)).ambiguous, true);
});

test('A2/A3: valid reconciliation releases the adopted root, invalid evidence preserves it', async (t) => {
  const env = makeProjectEnv();
  t.after(() => env.close());
  const task = submitProjectTask(env, {
    key: 'maint-reconcile-root',
    round: { status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: null, at: Date.now() },
  });
  await env.service.recover();
  assert.equal(env.ledger.has(env.key(task.id)), true, 'recovery adopted the unproved root');

  // Invalid evidence: an unavailable/null inspector is not proof, so the adopted root stays.
  env.adapter.inspect = async () => ({ status: 'unknown', stopConfirmed: false, activeJobs: null, activeChildren: null, reason: 'unknown-task' });
  await env.service.reconcile(task.id);
  assert.equal(env.store.get(task.id).project.reconcileObserved?.proven, false);
  assert.equal(env.ledger.has(env.key(task.id)), true, 'unproven evidence preserves the adopted root');

  // Valid evidence: explicit numeric zeros for BOTH counts release the adopted root.
  env.adapter.inspect = async () => ({ status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0 });
  await env.service.reconcile(task.id);
  const observed = env.store.get(task.id).project.reconcileObserved;
  assert.equal(observed?.proven, true, 'explicit numeric-zero jobs and children is a proven stop');
  assert.equal(env.ledger.has(env.key(task.id)), false, 'a valid reconciliation releases the adopted root');
});

test('A4: recovery preserves genuine task adoption and notification dedupe for ordinary work', async (t) => {
  const env = makeProjectEnv();
  t.after(() => env.close());
  // One ordinary recovered task: the non-project branch must keep adopting its root.
  const ordinary = env.store.submit(validatePacket(packet(env.repository, 'maint-ordinary')), { effectiveModel: { ...MODEL } });
  env.store.update(ordinary.task.id, { status: 'running', phase: 'running', dispatchStarted: true, sessionId: 'session-ordinary', stopConfirmed: false, activeJobs: null });
  await env.service.recover();
  assert.equal(env.ledger.has(env.key(ordinary.task.id)), true, 'an active ordinary task is still adopted');
  assert.equal(env.store.get(ordinary.task.id).activeChildren, 0, 'the real owned-child manager reports zero');
  assert.deepEqual(env.starts, [], 'recovery redispatches nothing');
});

// ---------------------------------------------------------------------------
// Repair round 2: a positively stopped round may free its own model reservation ONLY
// when every unresolved owned attempt is genuinely accounted elsewhere. Untracked
// ambiguous dispatch, unreadable bindings and readable-but-foreign bindings keep a
// stable root placeholder and block recovery/reconciliation; genuinely bound workers
// count through their own ledger entries.
// ---------------------------------------------------------------------------

/** One persisted worker attempt exactly as the runtime writes it before dispatch. */
function attemptEntry({ attempt = 1, state = 'dispatching', taskId = null } = {}) {
  return {
    attempt,
    idempotencyKey: `pw-${attempt}`,
    state,
    taskId,
    sessionId: null,
    startedAt: Date.now(),
    cancelRequested: false,
    stopConfirmed: false,
    grantedToolCalls: 1,
    toolAllowanceReleased: false,
  };
}

/** The frozen-plan worker envelope the recovery classifier walks. */
function workerEntry(workerKey, attempts) {
  return {
    workerKey,
    workerId: workerKey,
    required: true,
    state: attempts[attempts.length - 1]?.state ?? 'queued',
    dependsOn: [],
    attempts,
  };
}

/**
 * Persist one REAL task whose packet claims to be a worker, written exactly as
 * `#workerPacket` writes the lineage (`parentTaskId` + `metadata`). Callers deliberately
 * pass a mismatched or missing binding to model an unrelated task that merely happens to
 * be store-readable.
 */
function submitClaimedWorker(env, projectTask, {
  key,
  parentTaskId = projectTask.id,
  metadata = { supervisorProject: projectTask.id, workerKey: 'w1', attempt: 1 },
  status = 'running',
  stopConfirmed = false,
  activeJobs = null,
  activeChildren = null,
} = {}) {
  const submitted = env.store.submit(
    validatePacket(packet(env.repository, key, { parentTaskId, metadata })),
    { effectiveModel: { ...MODEL } }
  );
  env.store.update(submitted.task.id, { status, stopConfirmed, activeJobs, activeChildren });
  return env.store.get(submitted.task.id);
}

/** Replace the persisted project's worker plan (worker tasks are submitted separately). */
function setProjectWorkers(env, taskId, workers) {
  const current = env.store.get(taskId);
  env.store.update(taskId, { project: { ...current.project, workers } });
  return env.store.get(taskId);
}

test('repair2/a: a stopped bound round with an untracked ambiguous dispatch keeps one root slot and dispatches nothing', async (t) => {
  const env = makeProjectEnv();
  t.after(() => env.close());
  const task = submitProjectTask(env, {
    key: 'maint-r2-ambiguous',
    status: 'supervising',
    projectStatus: 'dispatching',
    round: { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() },
    workers: [workerEntry('w1', [attemptEntry({ attempt: 1, state: 'dispatching', taskId: null })])],
  });
  assert.equal(env.ledger.counts().used, 0, 'the restart starts from an empty in-memory ledger');

  await env.service.recover();
  const after = env.store.get(task.id);
  const recovery = after.projectRecovery;
  assert.equal(recovery.round, 'recorded-round', 'the recorded round is genuinely bound to the current attempt');
  assert.equal(recovery.rootReservation.action, 'adopted', 'the stopped round cannot free its slot around untracked owned work');
  assert.equal(recovery.rootReservation.counts.used, 1);
  assert.equal(after.status, 'unknown');
  assert.equal(after.stopConfirmed, false);
  assert.equal(after.project.status, 'blocked');
  assert.equal(after.project.seriousIssue.code, 'host-restart');
  assert.equal(env.ledger.has(env.key(task.id)), true, 'the stable root placeholder is held exactly once');
  assert.equal(env.ledger.get(env.key(task.id)).ambiguous, true);
  assert.equal(env.ledger.get(env.key(task.id)).attemptId, after.attemptId, 'the placeholder binds the real current attempt identity');
  assert.equal(env.ledger.counts().used, 1);
  assert.equal(env.ledger.counts().roots, 1);
  assert.deepEqual(env.starts, [], 'recovery dispatched no supervisor round');
  assert.equal(env.store.list().filter((candidate) => !candidate.project).length, 0, 'no worker task was created');

  // Repeated recovery is idempotent: the same root is never counted twice.
  await env.service.recover();
  assert.equal(env.ledger.counts().used, 1, 'repeated recovery never double counts the root');
  assert.equal(env.ledger.has(env.key(task.id)), true);
  assert.equal(env.store.get(task.id).project.status, 'blocked');
});

test('repair2/b: a stopped bound round releases its own slot while a genuinely bound live worker keeps its own reservation', async (t) => {
  // (b1) same-process race: the worker's own reservation is already held.
  const preHeld = makeProjectEnv();
  t.after(() => preHeld.close());
  const t1 = submitProjectTask(preHeld, {
    key: 'maint-r2-worker-preheld',
    status: 'supervising',
    projectStatus: 'frozen',
    round: { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() },
    workers: [],
  });
  const w1 = submitClaimedWorker(preHeld, t1, {
    key: 'maint-r2-worker-preheld-w1',
    metadata: { supervisorProject: t1.id, workerKey: 'w1', attempt: 1 },
    status: 'running',
  });
  setProjectWorkers(preHeld, t1.id, [workerEntry('w1', [attemptEntry({ attempt: 1, state: 'running', taskId: w1.id })])]);
  preHeld.ledger.reserve({ key: `task:${w1.id}`, kind: 'root', taskId: w1.id, attemptId: w1.attemptId });
  const heldBefore = preHeld.ledger.get(`task:${w1.id}`);
  const resumed = await preHeld.runtime.recoverProject(preHeld.store.get(t1.id));
  assert.equal(resumed.resumed, true, 'a stopped waiting round with accounted live work still resumes its deterministic flow');
  assert.equal(preHeld.ledger.has(preHeld.key(t1.id)), false, 'the stopped round holds no phantom root slot');
  assert.equal(preHeld.ledger.has(`task:${w1.id}`), true, 'the genuinely bound worker keeps its own reservation');
  assert.equal(preHeld.ledger.get(`task:${w1.id}`).attemptId, heldBefore.attemptId, 'the worker reservation identity is untouched');
  assert.equal(preHeld.ledger.counts().used, 1, 'only the worker occupies a slot');
  assert.deepEqual(preHeld.starts, [], 'recovery dispatched nothing');

  // (b2) a real restart: the in-memory ledger is empty, so the worker is counted through
  // its OWN entry without forcing a phantom project root slot.
  const fresh = makeProjectEnv();
  t.after(() => fresh.close());
  const t2 = submitProjectTask(fresh, {
    key: 'maint-r2-worker-fresh',
    status: 'supervising',
    projectStatus: 'frozen',
    round: { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() },
    workers: [],
  });
  const w2 = submitClaimedWorker(fresh, t2, {
    key: 'maint-r2-worker-fresh-w1',
    metadata: { supervisorProject: t2.id, workerKey: 'w1', attempt: 1 },
    status: 'running',
  });
  setProjectWorkers(fresh, t2.id, [workerEntry('w1', [attemptEntry({ attempt: 1, state: 'running', taskId: w2.id })])]);
  assert.equal(fresh.ledger.counts().used, 0);
  const report = await fresh.runtime.recoverProject(fresh.store.get(t2.id));
  assert.equal(report.rootReservation.action, 'absent', 'the stopped round releases its own slot');
  assert.equal(fresh.ledger.has(fresh.key(t2.id)), false, 'no phantom project root slot');
  assert.equal(fresh.ledger.has(`task:${w2.id}`), true, 'the recoverable owned worker counts through its own ledger entry');
  assert.equal(fresh.ledger.get(`task:${w2.id}`).taskId, w2.id);
  assert.equal(fresh.ledger.get(`task:${w2.id}`).attemptId, w2.attemptId);
  assert.equal(fresh.ledger.counts().used, 1, 'exactly one slot: the worker, never a phantom root');
  assert.deepEqual(fresh.starts, [], 'recovery dispatched nothing');
});

test('repair2/b2: a readable but wrongly bound stopped record neither releases nor completes the recovered project', async (t) => {
  const env = makeProjectEnv();
  t.after(() => env.close());
  const task = submitProjectTask(env, {
    key: 'maint-r2-misbound',
    status: 'supervising',
    projectStatus: 'blocked',
    round: { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() },
    workers: [],
  });
  // A REAL task of THIS bridge that does NOT belong to this project and is POSITIVELY
  // stopped: its stop proof must never release, cancel or complete the recovered project.
  const foreign = submitClaimedWorker(env, task, {
    key: 'maint-r2-misbound-foreign',
    parentTaskId: task.id,
    metadata: { supervisorProject: 'some-other-project', workerKey: 'w1', attempt: 1 },
    status: 'completed',
    stopConfirmed: true,
    activeJobs: 0,
    activeChildren: 0,
  });
  assert.equal(foreign.stopConfirmed, true, 'the foreign record really is positively stopped');
  setProjectWorkers(env, task.id, [workerEntry('w1', [attemptEntry({ attempt: 1, state: 'succeeded', taskId: foreign.id })])]);

  await env.service.recover();
  const after = env.store.get(task.id);
  assert.equal(after.projectRecovery.rootReservation.action, 'adopted', 'the misbound record forces a stable root placeholder');
  assert.equal(after.projectRecovery.ambiguous, 1);
  assert.equal(after.status, 'unknown');
  assert.equal(after.stopConfirmed, false);
  assert.equal(after.project.status, 'blocked');
  assert.equal(after.project.seriousIssue.code, 'host-restart');
  assert.equal(env.ledger.has(env.key(task.id)), true, 'the project root is retained');
  assert.equal(env.ledger.has(`task:${foreign.id}`), false, 'the unrelated task is never adopted');
  assert.equal(env.ledger.counts().used, 1);
  assert.deepEqual(env.starts, [], 'recovery dispatched nothing');

  // A real positive inspector proof for the round still cannot certify foreign owned work.
  env.adapter.inspect = async () => ({ status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0 });
  await env.service.reconcile(task.id);
  const reconciled = env.store.get(task.id);
  assert.equal(reconciled.status, 'unknown');
  assert.equal(reconciled.stopConfirmed, false);
  assert.equal(reconciled.project.status, 'blocked');
  assert.equal(reconciled.project.seriousIssue.code, 'reconcile-unaccounted-owned');
  assert.equal(env.ledger.has(env.key(task.id)), true, 'reconciliation retains the root on a foreign stop proof');
  assert.equal(env.ledger.has(`task:${foreign.id}`), false);
  assert.equal(env.ledger.counts().used, 1);
  assert.deepEqual(env.starts, [], 'reconciliation dispatched nothing');

  const report = await env.runtime.reevaluate(task.id, {
    observation: { status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0 },
    attemptId: env.store.get(task.id).attemptId,
  });
  assert.equal(report.evaluated, true);
  assert.equal(report.status, 'blocked');
  assert.equal(report.unaccounted, 1);
  assert.equal(env.ledger.has(env.key(task.id)), true, 'reevaluation retains the root too');
  assert.deepEqual(env.starts, [], 'reevaluation dispatched nothing');
});

test('repair2/b3: every broken worker-packet binding field stays unaccounted', async (t) => {
  const variants = [
    ['missing metadata', (id) => ({ parentTaskId: id, metadata: null })],
    ['foreign supervisorProject', (id) => ({ parentTaskId: id, metadata: { supervisorProject: 'some-other-project', workerKey: 'w1', attempt: 1 } })],
    ['foreign workerKey', (id) => ({ parentTaskId: id, metadata: { supervisorProject: id, workerKey: 'other-worker', attempt: 1 } })],
    ['stale attempt', (id) => ({ parentTaskId: id, metadata: { supervisorProject: id, workerKey: 'w1', attempt: 2 } })],
    ['foreign parentTaskId', (id) => ({ parentTaskId: 'some-other-project', metadata: { supervisorProject: id, workerKey: 'w1', attempt: 1 } })],
  ];
  for (const [index, [name, build]] of variants.entries()) {
    const env = makeProjectEnv();
    t.after(() => env.close());
    const slug = `maint-r2-bind-${index}`;
    const task = submitProjectTask(env, {
      key: slug,
      status: 'supervising',
      projectStatus: 'blocked',
      round: { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() },
      workers: [],
    });
    const foreign = submitClaimedWorker(env, task, {
      key: `${slug}-foreign`,
      ...build(task.id),
      status: 'completed',
      stopConfirmed: true,
      activeJobs: 0,
      activeChildren: 0,
    });
    setProjectWorkers(env, task.id, [workerEntry('w1', [attemptEntry({ attempt: 1, state: 'succeeded', taskId: foreign.id })])]);

    await env.service.recover();
    const after = env.store.get(task.id);
    assert.equal(after.projectRecovery.rootReservation.action, 'adopted', `${name}: a broken binding forces the root placeholder`);
    assert.equal(after.stopConfirmed, false, `${name}: the foreign stop never confirms this project`);
    assert.equal(after.project.status, 'blocked', `${name}: the project stays blocked`);
    assert.equal(env.ledger.has(env.key(task.id)), true, `${name}: the root is retained`);
    assert.equal(env.ledger.has(`task:${foreign.id}`), false, `${name}: the foreign task is never adopted`);
    assert.equal(env.ledger.counts().used, 1, `${name}: exactly the project root is counted`);
    assert.deepEqual(env.starts, [], `${name}: nothing is dispatched`);
  }
});

test('repair2/c: unknown evidence never releases the retained root, genuine owned stop proof does', async (t) => {
  const env = makeProjectEnv();
  t.after(() => env.close());
  const task = submitProjectTask(env, {
    key: 'maint-r2-release',
    status: 'supervising',
    projectStatus: 'blocked',
    round: { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() },
    workers: [],
  });
  const foreign = submitClaimedWorker(env, task, {
    key: 'maint-r2-release-foreign',
    parentTaskId: task.id,
    metadata: { supervisorProject: 'some-other-project', workerKey: 'w1', attempt: 1 },
    status: 'completed',
    stopConfirmed: true,
    activeJobs: 0,
    activeChildren: 0,
  });
  setProjectWorkers(env, task.id, [workerEntry('w1', [attemptEntry({ attempt: 1, state: 'succeeded', taskId: foreign.id })])]);
  await env.service.recover();
  assert.equal(env.ledger.has(env.key(task.id)), true, 'the misbound stop proof never freed the root');

  // Unknown evidence (a missing child count) is never proof: the adopted root stays.
  env.adapter.inspect = async () => ({ status: 'cancelled', stopConfirmed: true, activeJobs: 0 });
  await env.service.reconcile(task.id);
  assert.equal(env.store.get(task.id).project.reconcileObserved?.proven, false, 'a missing child count is never coerced to zero');
  assert.equal(env.ledger.has(env.key(task.id)), true, 'unknown evidence preserves the adopted root');
  assert.equal(env.store.get(task.id).stopConfirmed, false);

  // Genuine owned stop evidence: the attempt is re-bound to a REAL stopped worker of THIS
  // project, so the central clean proof may release the root.
  const real = submitClaimedWorker(env, task, {
    key: 'maint-r2-release-real',
    parentTaskId: task.id,
    metadata: { supervisorProject: task.id, workerKey: 'w1', attempt: 1 },
    status: 'completed',
    stopConfirmed: true,
    activeJobs: 0,
    activeChildren: 0,
  });
  setProjectWorkers(env, task.id, [workerEntry('w1', [attemptEntry({ attempt: 1, state: 'succeeded', taskId: real.id })])]);
  env.adapter.inspect = async () => ({ status: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0 });
  await env.service.reconcile(task.id);
  assert.equal(env.store.get(task.id).project.reconcileObserved?.proven, true);
  assert.equal(env.ledger.has(env.key(task.id)), false, 'genuine correctly bound owned stop proof releases the root');
});
