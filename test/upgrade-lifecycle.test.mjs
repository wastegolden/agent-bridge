// Independent lifecycle acceptance tests for contract 20260925.2
// (evidence/upgrade-20260925/LIFECYCLE-CONTRACT.md).
//
// Public surface only: BridgeService (src/service.mjs), TaskStore (src/store.mjs),
// createDispatcher (src/mcp.mjs), plus the legacy digest helper from src/contracts.mjs.
// No product file or existing test is modified, and no candidate implementation is
// inspected. Every test is self-contained, uses a temp directory and a fake adapter,
// and is bounded by TEST.timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store.mjs';
import { BridgeService } from '../src/service.mjs';
import { createDispatcher } from '../src/mcp.mjs';
import { digest } from '../src/contracts.mjs';

const TEST = { timeout: 20000 };
const CLARIFY_REJECTION_CODES = ['CLARIFICATION_CONFLICT', 'SESSION_NOT_READY', 'CLARIFICATION_UNSUPPORTED'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label = 'condition', { tries = 400, interval = 5 } = {}) {
  for (let i = 0; i < tries; i++) {
    let ok = false;
    try { ok = await check(); } catch { ok = false; }
    if (ok) return;
    await sleep(interval);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function isDomainError(error) {
  return !!error && typeof error.code === 'string' && error.code.length > 0;
}

// Contract names the error codes for some rejections but leaves the mapping for
// others to the implementation ("as appropriate"). Where the code is not fixed we
// assert a real domain rejection plus the absence of the forbidden side effect.
async function rejectsWithCode(run, label) {
  let caught;
  try { await run(); } catch (error) { caught = error; }
  assert.ok(caught, `${label}: expected a domain rejection`);
  assert.ok(isDomainError(caught), `${label}: expected a nonblank error code, got ${caught && caught.code}`);
  return caught;
}

function makePacket(root, key, extra = {}) {
  return {
    schemaVersion: 1, idempotencyKey: key, revision: 1, projectId: 'lifecycle', title: key,
    objective: 'bounded lifecycle check', cwd: root, role: 'investigate',
    acceptance: ['observable lifecycle invariant'],
    scope: { readRoots: [root], writeRoots: [], allowedTools: ['read_file'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [], contractVersion: '20260925.1', ...extra,
  };
}

function makeAdapter(overrides = {}) {
  const calls = { start: [], continue: [], reconsider: [], cancel: [], inspect: [], cleanup: [], archive: [] };
  const callbacks = new Map();
  const adapter = {
    models: async () => [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
    capabilities: async () => ({}),
    preflight: async () => ({ ok: true, requestedTools: ['read_file'], enforceableTools: ['read_file'], availableTools: ['read_file'], availabilityVerified: true, sessionVisibilityPending: true }),
    start: async (task, cb) => {
      calls.start.push(task); callbacks.set(task.attemptId, cb);
      return { sessionId: `session-${task.id}`, requestId: `request-${task.attemptId}`, effectiveModel: task.effectiveModel, effectivePolicy: { fileScope: 'hard' } };
    },
    continue: async (task, _understanding, cb) => {
      calls.continue.push(task); callbacks.set(task.attemptId, cb);
      return { sessionId: task.sessionId, requestId: `request-${task.attemptId}`, effectiveModel: task.effectiveModel, effectivePolicy: { fileScope: 'hard' } };
    },
    reconsider: async (task, cb) => {
      calls.reconsider.push(task); callbacks.set(task.attemptId, cb);
      return { sessionId: task.sessionId, requestId: `request-${task.attemptId}`, effectiveModel: task.effectiveModel, effectivePolicy: { fileScope: 'hard' }, mode: 'understanding' };
    },
    cancel: async task => { calls.cancel.push(task); return { accepted: true, stopConfirmed: true, remaining: [] }; },
    cleanup: async task => { calls.cleanup.push(task); return { cleaned: true }; },
    archive: async task => { calls.archive.push(task); return { archived: true, uiHidden: true, sessionId: task.sessionId, workspacePreserved: true, evidencePreserved: true }; },
  };
  Object.assign(adapter, overrides);
  return { adapter, calls, callbacks };
}

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lifecycle-'));
  const store = new TaskStore({ directory, ownerId: 'owner' });
  const { adapter, calls, callbacks } = makeAdapter(options.adapter);
  // The fake host observation is derived from the persisted record, so an archive
  // implementation that inspects a settled task receives a truthful stopped state.
  adapter.inspect = async task => {
    calls.inspect.push(task);
    try {
      const current = store.get(task.id);
      return { status: current.status, stopConfirmed: current.stopConfirmed === true, activeJobs: current.activeJobs === 0 ? 0 : null, sessionId: current.sessionId };
    } catch {
      return { status: 'unknown', stopConfirmed: false, activeJobs: null };
    }
  };
  const service = new BridgeService({ store, adapter, maxConcurrent: 2, ...(options.service ?? {}) });
  const writes = { workspaceCreate: 0, workspaceRemove: 0 };
  service.workspaces = {
    create: async ({ taskId }) => { writes.workspaceCreate++; return { taskId, path: directory, branch: 'owned', baseCommit: 'base', repository: directory }; },
    remove: async () => { writes.workspaceRemove++; return { removed: true }; },
  };
  const f = {
    directory, store, adapter, calls, callbacks, service, writes,
    packet: (key, extra = {}) => makePacket(directory, key, extra),
    submit: (key, extra = {}) => service.submit(makePacket(directory, key, extra)),
    async settleUnderstanding(id, attemptId, text) {
      await until(() => callbacks.has(attemptId), `attempt ${attemptId} to be dispatched`);
      callbacks.get(attemptId).onResult({ status: 'completed', text, stopConfirmed: true, activeJobs: 0 });
      await until(() => { const task = store.get(id); return task.status === 'awaiting_approval' && task.dispatchReceiptAt != null; }, 'awaiting_approval with a persisted dispatch receipt');
    },
    async settleExecution(id, attemptId, text) {
      await until(() => callbacks.has(attemptId), `attempt ${attemptId} to be dispatched`);
      callbacks.get(attemptId).onResult({ status: 'completed', text, finalText: text, stopConfirmed: true, activeJobs: 0 });
      await until(() => ['completed', 'failed', 'cancelled', 'unknown'].includes(store.get(id).status), 'terminal status');
    },
    close() { try { service.close(); } catch {} try { store.close(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); },
  };
  return f;
}

function assertLifecycleApi(service) {
  assert.equal(typeof service.clarify, 'function', 'BridgeService.clarify must be a public method');
  assert.equal(typeof service.archive, 'function', 'BridgeService.archive must be a public method');
}

async function completedTask(f, key, { packet = {}, artifactState, pinned } = {}) {
  const task = await f.submit(key, packet);
  await f.settleExecution(task.id, task.attemptId, `result-${key}`);
  f.service.acknowledge(task.id, {
    revision: 1, accepted: true,
    ...(artifactState ? { artifactState } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
  });
  return f.store.get(task.id);
}

async function rejectedArchive(f, id, revision, label) {
  const before = f.calls.archive.length;
  const error = await rejectsWithCode(() => f.service.archive(id, { revision }), label);
  const record = f.store.get(id);
  assert.equal(record.sessionArchivedAt ?? null, null, `${label}: no archive timestamp may be stored`);
  assert.equal(record.archive ?? null, null, `${label}: no archive evidence may be stored`);
  assert.equal(record.archivedAt ?? null, null, `${label}: the physical cleanup marker must stay unset`);
  assert.equal(f.calls.archive.length, before, `${label}: adapter.archive must not be called`);
  return error;
}

// ---------------------------------------------------------------------------
// Service preflight
// ---------------------------------------------------------------------------

test('preflight rejection or throw creates no task, workspace or dispatch', TEST, async () => {
  const f = fixture();
  try {
    for (const mode of ['reject', 'throw']) {
      f.adapter.preflight = mode === 'reject'
        ? async () => ({ ok: false, reason: 'adapter/tool-unavailable', availableTools: [], availabilityVerified: true, sessionVisibilityPending: true })
        : async () => { const error = new Error('host tool probe failed'); error.code = 'adapter/preflight-error'; throw error; };
      const error = await rejectsWithCode(() => f.submit(`preflight-${mode}`), `preflight ${mode}`);
      assert.ok(isDomainError(error));
      assert.deepEqual(f.store.list(), [], `preflight ${mode}: no task row may be created`);
      assert.equal(f.calls.start.length, 0, `preflight ${mode}: no session may be started`);
      assert.equal(f.writes.workspaceCreate, 0, `preflight ${mode}: no worktree may be created`);
    }
    // The rejected key was never persisted, so a corrected preflight may reuse it.
    f.adapter.preflight = async () => ({ ok: true, requestedTools: ['read_file'], enforceableTools: ['read_file'], availableTools: ['read_file'], availabilityVerified: true, sessionVisibilityPending: true });
    const task = await f.submit('preflight-reject');
    assert.equal(f.store.list().length, 1);
    await until(() => f.calls.start.length === 1, 'dispatch after a corrected preflight');
    assert.equal(f.store.get(task.id).preflight.ok, true);
  } finally {
    f.close();
  }
});

test('an adapter without preflight stays compatible and is recorded as unsupported', TEST, async () => {
  const f = fixture();
  try {
    delete f.adapter.preflight;
    const task = await f.submit('preflight-optional');
    const stored = f.store.get(task.id);
    assert.deepEqual(stored.preflight, { supported: false, reason: 'adapter-preflight-unavailable' });
    assert.notEqual(stored.preflight.ok, true, 'missing preflight must never be reported as ok');
    await f.settleExecution(task.id, task.attemptId, 'optional preflight result');
    assert.equal(f.store.get(task.id).status, 'completed');
    // An accepted idempotent submission is reusable without another dispatch.
    const again = await f.submit('preflight-optional');
    assert.equal(again.id, task.id);
    assert.equal(f.calls.start.length, 1);
    assert.equal(f.store.get(task.id).attempt, 1);
  } finally {
    f.close();
  }
});

test('successful preflight evidence is retained as detached JSON on the new task', TEST, async () => {
  const evidence = { ok: true, requestedTools: ['read_file'], enforceableTools: ['read_file'], availableTools: ['read_file'], availabilityVerified: true, sessionVisibilityPending: true };
  const f = fixture({ adapter: { preflight: async () => JSON.parse(JSON.stringify(evidence)) } });
  try {
    const task = await f.submit('preflight-ok');
    const stored = f.store.get(task.id);
    assert.deepEqual(stored.preflight, evidence);
    assert.equal(stored.preflight.ok, true);
    await until(() => f.calls.start.length === 1, 'dispatch after successful preflight');
  } finally {
    f.close();
  }
});

// ---------------------------------------------------------------------------
// Understanding clarification
// ---------------------------------------------------------------------------

test('clarification requires a reconsider-capable adapter', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const task = await f.submit('clarify-unsupported', { understandingRequired: true });
    await f.settleUnderstanding(task.id, task.attemptId, 'U0');
    const before = f.store.get(task.id);
    delete f.adapter.reconsider;
    const error = await rejectsWithCode(
      () => f.service.clarify(task.id, { taskId: task.id, revision: before.revision, understandingHash: before.understandingHash, clarificationId: 'c1', text: 'more context' }),
      'clarify without reconsider',
    );
    assert.equal(error.code, 'CLARIFICATION_UNSUPPORTED');
    assert.equal((f.store.get(task.id).clarifications ?? []).length, 0);
    assert.equal(f.calls.reconsider.length, 0);
  } finally {
    f.close();
  }
});

test('clarify keeps the same session, mints a new attempt and preserves the immutable submission', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const task = await f.submit('clarify-main', { understandingRequired: true });
    await f.settleUnderstanding(task.id, task.attemptId, 'U0');
    const before = f.store.get(task.id);
    const eventsBefore = f.store.events(task.id).length;

    const result = await f.service.clarify(task.id, { taskId: task.id, revision: before.revision, understandingHash: before.understandingHash, clarificationId: 'c1', text: 'bounded additional context' });
    const after = f.store.get(task.id);

    // The returned view is the post-transaction snapshot: queued for a fresh
    // understanding attempt, before any normal queued dispatch advances it.
    assert.equal(result.id, task.id);
    assert.notEqual(result.clarificationReplay, true);
    assert.equal(result.status, 'queued');
    assert.equal(result.phase, 'queued');
    assert.equal(result.continuationKind, 'clarification');
    assert.equal(result.executionApproved, false);
    assert.equal(result.dispatchStarted, false);
    assert.equal(result.dispatchReceiptAt ?? null, null);
    assert.equal(result.requestId ?? null, null);
    assert.equal(result.understanding ?? null, null);
    assert.equal(result.understandingHash ?? null, null);
    assert.equal(result.review ?? null, null);
    assert.equal(result.understandingGeneration, 1, 'the understanding generation increments from the default 0');
    assert.equal(result.attemptId, after.attemptId);

    assert.equal(after.sessionId, before.sessionId, 'clarification must stay in the owned session');
    assert.notEqual(after.attemptId, before.attemptId, 'clarification must mint a fresh attempt');
    assert.equal(after.attempt, before.attempt + 1);
    assert.equal(after.revision, before.revision, 'revision is immutable across clarification');
    assert.deepEqual(after.packet, before.packet, 'the original packet is immutable across clarification');
    assert.equal(after.requestHash, before.requestHash, 'the original submission hash is immutable');
    assert.equal(after.result?.text ?? '', '', 'clarification resets the previous result');

    assert.equal(after.clarifications.length, 1);
    const entry = after.clarifications[0];
    for (const field of ['clarificationId', 'text', 'requestHash', 'generation', 'createdAt', 'previousUnderstanding', 'previousUnderstandingHash', 'previousResult', 'previousAttempt']) {
      assert.ok(field in entry, `clarification entry must expose ${field}`);
    }
    assert.equal(entry.clarificationId, 'c1');
    assert.equal(entry.text, 'bounded additional context');
    assert.ok(typeof entry.requestHash === 'string' && entry.requestHash.length > 0);
    assert.equal(entry.generation, 1);
    assert.ok(Number.isSafeInteger(entry.createdAt));
    assert.equal(entry.previousUnderstanding, before.understanding);
    assert.equal(entry.previousUnderstandingHash, before.understandingHash);
    for (const field of ['attemptId', 'requestId', 'sessionId', 'revision', 'phase', 'status', 'dispatchReceiptAt', 'effectiveModel']) {
      assert.deepEqual(entry.previousAttempt[field], before[field], `previousAttempt.${field} must be the trusted prior snapshot`);
    }
    assert.ok(Array.isArray(after.attemptHistory) && after.attemptHistory.length >= (before.attemptHistory?.length ?? 0) + 1);
    assert.ok(f.store.events(task.id).length > eventsBefore, 'clarify appends an event transactionally');

    await until(() => f.calls.reconsider.length === 1, 'clarification dispatch through reconsider');
    assert.equal(f.calls.start.length, 1, 'clarification must never start a second session');
    assert.equal(f.calls.continue.length, 0, 'clarification understanding must never use continue');
    const reconsidered = f.calls.reconsider[0];
    assert.equal(reconsidered.id, task.id);
    assert.equal(reconsidered.sessionId, before.sessionId);
    assert.equal(reconsidered.attemptId, after.attemptId);
    assert.equal(reconsidered.continuationKind, 'clarification');
    assert.deepEqual(reconsidered.packet, before.packet);

    await until(() => f.callbacks.has(after.attemptId), 'clarification attempt callbacks');
    f.callbacks.get(after.attemptId).onResult({ status: 'completed', text: 'U1', stopConfirmed: true, activeJobs: 0 });
    await until(() => f.store.get(task.id).status === 'awaiting_approval', 'clarified understanding');
    assert.equal(f.calls.continue.length, 0, 'no execution may dispatch before approval');
    const gated = f.store.get(task.id);
    assert.equal(gated.understanding, 'U1');
    assert.equal(gated.understandingGeneration, 1);
    assert.notEqual(gated.understandingHash, before.understandingHash);

    f.service.approve(task.id, { revision: gated.revision, understandingHash: gated.understandingHash });
    await until(() => f.calls.continue.length === 1, 'approved execution dispatch');
    assert.equal(f.calls.continue[0].sessionId, before.sessionId);
    assert.equal(f.store.get(task.id).continuationKind ?? null, null, 'continuationKind is cleared at approval');

    // The original submission remains idempotent and must not redispatch.
    const startCount = f.calls.start.length;
    const reconsiderCount = f.calls.reconsider.length;
    const resubmitted = await f.service.submit(f.packet('clarify-main', { understandingRequired: true }));
    assert.equal(resubmitted.id, task.id);
    assert.equal(f.calls.start.length, startCount);
    assert.equal(f.calls.reconsider.length, reconsiderCount);
  } finally {
    f.close();
  }
});

test('a new generation rejects the old understanding hash even when the text is identical', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const task = await f.submit('old-hash', { understandingRequired: true });
    await f.settleUnderstanding(task.id, task.attemptId, 'IDENTICAL UNDERSTANDING');
    const generation0 = f.store.get(task.id);
    assert.equal(generation0.understandingGeneration ?? 0, 0);
    assert.equal(generation0.understandingHash, digest(generation0.understanding), 'generation 0 preserves the legacy digest');

    await f.service.clarify(task.id, { taskId: task.id, revision: generation0.revision, understandingHash: generation0.understandingHash, clarificationId: 'c1', text: 'same scope, more context' });
    const next = f.store.get(task.id);
    assert.equal(next.understandingGeneration, 1);
    await until(() => f.callbacks.has(next.attemptId), 'clarification attempt callbacks');
    f.callbacks.get(next.attemptId).onResult({ status: 'completed', text: 'IDENTICAL UNDERSTANDING', stopConfirmed: true, activeJobs: 0 });
    await until(() => f.store.get(task.id).status === 'awaiting_approval', 'clarified understanding');
    const generation1 = f.store.get(task.id);

    assert.equal(generation1.understanding, 'IDENTICAL UNDERSTANDING');
    assert.notEqual(generation1.understandingHash, generation0.understandingHash, 'identical text in a later generation must not revive the old hash');
    assert.notEqual(generation1.understandingHash, digest('IDENTICAL UNDERSTANDING'));
    assert.throws(() => f.service.approve(task.id, { revision: generation1.revision, understandingHash: generation0.understandingHash }), { code: 'APPROVAL_CONFLICT' });
    assert.throws(() => f.service.approve(task.id, { revision: generation1.revision, understandingHash: '0'.repeat(64) }), { code: 'APPROVAL_CONFLICT' });
    assert.equal(f.calls.continue.length, 0, 'a rejected approval must not dispatch execution');

    f.service.approve(task.id, { revision: generation1.revision, understandingHash: generation1.understandingHash });
    await until(() => f.calls.continue.length === 1, 'approved execution dispatch');
    assert.equal(f.calls.continue[0].sessionId, generation0.sessionId);
    assert.equal(f.calls.reconsider.length, 1, 'approval must not re-enter the clarification path');
  } finally {
    f.close();
  }
});

test('clarify validates input, replays identically and confines duplicate keys by conflict', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const task = await f.submit('clarify-replay', { understandingRequired: true });
    await f.settleUnderstanding(task.id, task.attemptId, 'U0');
    const base = f.store.get(task.id);
    const good = { taskId: task.id, revision: base.revision, understandingHash: base.understandingHash, clarificationId: 'c1', text: 'context' };

    const created = await f.service.clarify(task.id, good);
    assert.notEqual(created.clarificationReplay, true);
    const afterCreate = f.store.get(task.id);
    assert.equal(afterCreate.clarifications.length, 1);
    const attemptAfterCreate = afterCreate.attempt;

    const replay = await f.service.clarify(task.id, { ...good });
    assert.equal(replay.clarificationReplay, true, 'an identical replay must be reported');
    assert.equal(replay.id, task.id);
    assert.equal(f.store.get(task.id).attempt, attemptAfterCreate, 'a replay must not mint another attempt');
    assert.equal(f.store.get(task.id).clarifications.length, 1);

    const conflict = await rejectsWithCode(() => f.service.clarify(task.id, { ...good, text: 'different content' }), 'same clarificationId with different content');
    assert.equal(conflict.code, 'CLARIFICATION_CONFLICT');
    assert.equal(f.store.get(task.id).clarifications.length, 1);

    const invalid = [
      ['blank text', { ...good, text: '' }],
      ['oversized text', { ...good, text: 'x'.repeat(20001) }],
      ['zero revision', { ...good, revision: 0 }],
      ['fractional revision', { ...good, revision: 1.5 }],
      ['blank understandingHash', { ...good, understandingHash: '' }],
      ['blank clarificationId', { ...good, clarificationId: '' }],
      ['oversized clarificationId', { ...good, clarificationId: 'i'.repeat(201) }],
    ];
    for (const [label, bad] of invalid) {
      await rejectsWithCode(() => f.service.clarify(task.id, bad), `invalid clarify args: ${label}`);
      assert.equal(f.store.get(task.id).clarifications.length, 1, 'invalid input must not append a clarification');
      assert.equal(f.store.get(task.id).attempt, attemptAfterCreate, 'invalid input must not mint an attempt');
    }

    // Replay still succeeds after the task status has advanced.
    const current = f.store.get(task.id);
    await until(() => f.callbacks.has(current.attemptId), 'clarification attempt callbacks');
    f.callbacks.get(current.attemptId).onResult({ status: 'completed', text: 'U1', stopConfirmed: true, activeJobs: 0 });
    await until(() => f.store.get(task.id).status === 'awaiting_approval', 'clarified understanding');
    const approved = f.store.get(task.id);
    assert.equal(approved.attempt, attemptAfterCreate, 'the clarification attempt is unchanged before approval');
    f.service.approve(task.id, { revision: approved.revision, understandingHash: approved.understandingHash });
    await until(() => f.calls.continue.length === 1, 'execution after approval');

    // A normal approve legitimately mints the execution attempt. The replay
    // invariant is therefore measured against the state immediately before the
    // replay, not against the pre-approval clarification attempt.
    const dispatched = f.store.get(task.id);
    assert.equal(dispatched.attempt, approved.attempt + 1, 'approval advances exactly one execution attempt');
    assert.equal(dispatched.attempt, attemptAfterCreate + 1);
    assert.notEqual(dispatched.attemptId, approved.attemptId, 'approval mints a fresh execution attemptId');

    const beforeReplay = f.store.get(task.id);
    const lateReplay = await f.service.clarify(task.id, { ...good });
    const afterReplay = f.store.get(task.id);
    assert.equal(lateReplay.clarificationReplay, true, 'a replay returns the same task after its status advanced');
    assert.equal(afterReplay.attemptId, beforeReplay.attemptId, 'an advanced replay must not mint another attemptId');
    assert.equal(afterReplay.attempt, beforeReplay.attempt, 'an advanced replay must not mint another attempt');
    assert.equal(afterReplay.revision, beforeReplay.revision, 'an advanced replay keeps the immutable revision');
    assert.equal(afterReplay.clarifications.length, 1, 'an advanced replay must not append another clarification');
    assert.equal(f.calls.reconsider.length, 1);

    // Compare-and-swap: two simultaneous new clarifications cannot both win.
    const casTask = await f.submit('clarify-cas', { understandingRequired: true });
    await f.settleUnderstanding(casTask.id, casTask.attemptId, 'U0');
    const casBase = f.store.get(casTask.id);
    const make = (id, text) => ({ taskId: casTask.id, revision: casBase.revision, understandingHash: casBase.understandingHash, clarificationId: id, text });
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => f.service.clarify(casTask.id, make('cas-a', 'A'))),
      Promise.resolve().then(() => f.service.clarify(casTask.id, make('cas-b', 'B'))),
    ]);
    assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1, 'exactly one simultaneous clarification may win');
    const losers = settled.filter(r => r.status === 'rejected');
    assert.equal(losers.length, 1);
    assert.ok(CLARIFY_REJECTION_CODES.includes(losers[0].reason.code), `unexpected contention code ${losers[0].reason.code}`);
    const casAfter = f.store.get(casTask.id);
    assert.equal(casAfter.clarifications.length, 1, 'only one clarification entry may be appended');
    assert.equal(casAfter.attempt, casBase.attempt + 1, 'exactly one new attempt may be minted');

    // Repeated submission keys still conflict on different content.
    const idem = await rejectsWithCode(() => f.service.submit(f.packet('clarify-cas', { understandingRequired: true, title: 'changed' })), 'idempotency conflict');
    assert.equal(idem.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    f.close();
  }
});

test('clarify is refused while the dispatch receipt is not yet persisted', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const entered = deferred();
    const receiptGate = deferred();
    f.adapter.start = async (task, cb) => {
      f.calls.start.push(task);
      f.callbacks.set(task.attemptId, cb);
      entered.resolve();
      return receiptGate.promise;
    };
    const task = await f.submit('receipt-race', { understandingRequired: true });
    await entered.promise;
    f.callbacks.get(task.attemptId).onResult({ status: 'completed', text: 'U0', stopConfirmed: true, activeJobs: 0 });
    await until(() => f.store.get(task.id).status === 'awaiting_approval', 'understanding before the receipt arrives');
    const pending = f.store.get(task.id);
    assert.equal(pending.dispatchStarted, true, 'dispatch-pending evidence is persisted');
    assert.equal(pending.dispatchReceiptAt ?? null, null, 'the receipt is not yet persisted');

    const error = await rejectsWithCode(
      () => f.service.clarify(task.id, { taskId: task.id, revision: pending.revision, understandingHash: pending.understandingHash, clarificationId: 'c1', text: 'more context' }),
      'clarify before the receipt',
    );
    assert.ok(['SESSION_NOT_READY', 'CLARIFICATION_CONFLICT'].includes(error.code), `expected a receipt-not-ready rejection, got ${error.code}`);
    assert.equal((f.store.get(task.id).clarifications ?? []).length, 0, 'no clarification may be created without a persisted receipt');
    assert.equal(f.calls.reconsider.length, 0);

    // Once the receipt is persisted the same clarification becomes eligible.
    receiptGate.resolve({ sessionId: `session-${task.id}`, requestId: 'request-late', effectiveModel: pending.effectiveModel, effectivePolicy: { fileScope: 'hard' } });
    await until(() => f.store.get(task.id).dispatchReceiptAt != null, 'late receipt persistence');
    await f.service.clarify(task.id, { taskId: task.id, revision: pending.revision, understandingHash: pending.understandingHash, clarificationId: 'c1', text: 'more context' });
    assert.equal(f.store.get(task.id).clarifications.length, 1);
  } finally {
    f.close();
  }
});

test('a stale previous-attempt callback cannot disturb the clarification attempt', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const task = await f.submit('stale-callback', { understandingRequired: true });
    const firstAttempt = task.attemptId;
    await f.settleUnderstanding(task.id, firstAttempt, 'U0');
    const stale = f.callbacks.get(firstAttempt);
    assert.ok(stale, 'the first attempt callback must exist');

    const before = f.store.get(task.id);
    await f.service.clarify(task.id, { taskId: task.id, revision: before.revision, understandingHash: before.understandingHash, clarificationId: 'c1', text: 'context' });
    const current = f.store.get(task.id);
    assert.notEqual(current.attemptId, firstAttempt);

    stale.onResult({ status: 'failed', text: 'STALE RESULT', stopConfirmed: true, activeJobs: 0 });
    stale.onEvent({ type: 'assistant/message', text: 'STALE EVENT' });
    await sleep(20);

    const after = f.store.get(task.id);
    assert.ok(!['failed', 'unknown'].includes(after.status), 'a stale result must not settle the new attempt');
    assert.equal(after.result?.text ?? '', '', 'stale result text must not be recorded');
    assert.equal(f.store.events(task.id).some(event => event.text === 'STALE EVENT'), false, 'a stale event must not be recorded');

    await until(() => f.callbacks.has(after.attemptId), 'new attempt callbacks');
    f.callbacks.get(after.attemptId).onResult({ status: 'completed', text: 'U1', stopConfirmed: true, activeJobs: 0 });
    await until(() => f.store.get(task.id).status === 'awaiting_approval', 'new attempt awaiting approval');
    assert.equal(f.store.get(task.id).understanding, 'U1');
  } finally {
    f.close();
  }
});

test('a persisted clarification survives store reopen with the immutable submission and trusted snapshot', TEST, async () => {
  const f = fixture();
  let reopened;
  try {
    assertLifecycleApi(f.service);
    const task = await f.submit('clarify-reopen', { understandingRequired: true });
    await f.settleUnderstanding(task.id, task.attemptId, 'U0');
    const before = f.store.get(task.id);
    const eventsBefore = f.store.events(task.id).length;
    await f.service.clarify(task.id, { taskId: task.id, revision: before.revision, understandingHash: before.understandingHash, clarificationId: 'c1', text: 'context' });
    await until(() => f.calls.reconsider.length === 1, 'clarification dispatch');
    await until(() => f.store.get(task.id).status === 'running', 'clarification attempt running');
    await sleep(20);
    const snapshot = f.store.get(task.id);

    f.service.close();
    f.store.close();
    reopened = new TaskStore({ directory: f.directory, ownerId: 'owner' });
    const loaded = reopened.get(task.id);

    assert.deepEqual(loaded.packet, snapshot.packet);
    assert.equal(loaded.requestHash, snapshot.requestHash);
    assert.equal(loaded.revision, snapshot.revision);
    assert.equal(loaded.attemptId, snapshot.attemptId);
    assert.equal(loaded.attempt, snapshot.attempt);
    assert.equal(loaded.sessionId, snapshot.sessionId);
    assert.equal(loaded.understandingGeneration, 1);
    assert.deepEqual(loaded.clarifications, snapshot.clarifications);
    assert.ok(Array.isArray(loaded.attemptHistory) && loaded.attemptHistory.length >= 1);
    assert.ok(reopened.events(task.id).length >= eventsBefore, 'clarification events survive reopen');
    assert.ok(reopened.list().some(entry => entry.id === task.id));

    const previous = loaded.clarifications[0].previousAttempt;
    assert.equal(previous.attemptId, before.attemptId);
    assert.equal(previous.requestId, before.requestId);
    assert.equal(previous.sessionId, before.sessionId);
    assert.equal(previous.revision, before.revision);
    assert.equal(previous.status, before.status);
    assert.equal(previous.phase, before.phase);
    assert.equal(previous.dispatchReceiptAt, before.dispatchReceiptAt);
    assert.deepEqual(previous.effectiveModel, before.effectiveModel);
  } finally {
    try { reopened?.close(); } catch {}
    f.close();
  }
});

// ---------------------------------------------------------------------------
// UI archive
// ---------------------------------------------------------------------------

test('archive rejects unknown, mismatched, active, uncollected and unresolved tasks without side effects', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const unknown = await rejectsWithCode(() => f.service.archive(randomUUID(), { revision: 1 }), 'unknown task');
    assert.equal(unknown.code, 'TASK_NOT_FOUND');

    const ready = await completedTask(f, 'archive-revision');
    await rejectedArchive(f, ready.id, 2, 'revision mismatch');

    const active = await f.submit('archive-active', { understandingRequired: true });
    await until(() => f.callbacks.has(active.attemptId), 'active task dispatch');
    await rejectedArchive(f, active.id, 1, 'active task');

    // A completed task that was never collected must not be archived.
    const uncollectedTask = await f.submit('archive-uncollected');
    await f.settleExecution(uncollectedTask.id, uncollectedTask.attemptId, 'uncollected result');
    const uncollected = f.store.get(uncollectedTask.id);
    assert.equal(uncollected.status, 'completed');
    assert.equal(uncollected.resultCollected, false, 'a completed task stays uncollected until acknowledged');
    await rejectedArchive(f, uncollected.id, 1, 'uncollected result');

    const implement = await completedTask(f, 'archive-unresolved', { packet: { role: 'implement' } });
    assert.equal(implement.artifactState, 'unresolved');
    await rejectedArchive(f, implement.id, 1, 'unresolved artifacts');

    assert.equal(f.store.list().length, 4, 'a rejected archive must create or delete nothing');
  } finally {
    f.close();
  }
});

test('archive hides the session, preserves evidence and never cleans or deletes', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const task = await completedTask(f, 'archive-ok');
    const before = f.store.get(task.id);
    const eventsBefore = f.store.events(task.id).length;

    const result = await f.service.archive(task.id, { revision: 1 });
    assert.equal(result.taskId, task.id);
    assert.equal(result.revision, 1);
    assert.equal(result.archived, true);
    assert.equal(result.uiHidden, true);
    assert.equal(result.workspacePreserved, true);
    assert.equal(result.evidencePreserved, true);
    assert.ok(Number.isSafeInteger(result.sessionArchivedAt));

    const record = f.store.get(task.id);
    assert.equal(record.sessionArchivedAt, result.sessionArchivedAt);
    assert.equal(record.archivedAt ?? null, null, 'UI archive must not claim physical cleanup');
    assert.equal(record.endedAt, before.endedAt, 'archive must not modify endedAt');
    assert.equal(record.result.text, before.result.text, 'archive must retain the result');
    assert.notEqual(record.archive ?? null, null, 'archive evidence must be persisted');
    assert.equal(record.cleanedUp ?? false, false);

    assert.equal(f.calls.archive.length, 1);
    assert.equal(f.calls.archive[0].id, task.id);
    assert.equal(f.calls.archive[0].sessionId, before.sessionId);
    assert.equal(f.calls.cleanup.length, 0, 'archive must never call cleanup');
    assert.equal(f.calls.cancel.length, 0, 'archive must never kill jobs or sessions');
    assert.equal(f.writes.workspaceRemove, 0, 'archive must never delete a workspace');
    assert.ok(f.store.events(task.id).length >= eventsBefore, 'archive retains events');

    assert.equal(f.store.list().some(entry => entry.id === task.id), false, 'default list hides the archived session');
    assert.equal(f.store.list({ includeArchived: true }).some(entry => entry.id === task.id), true, 'includeArchived exposes it');

    const repeat = await f.service.archive(task.id, { revision: 1 });
    assert.equal(repeat.archived, true);
    assert.equal(f.store.get(task.id).sessionArchivedAt, result.sessionArchivedAt, 'a repeat archive must not reset the retention clock');
    assert.equal(f.calls.cleanup.length, 0);
    assert.equal(f.writes.workspaceRemove, 0);
  } finally {
    f.close();
  }
});

test('archive preserves an owned workspace and its resolved artifact state', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const task = await f.submit('archive-workspace', { workspace: { repository: f.directory, baseRef: 'HEAD' } });
    await f.settleExecution(task.id, task.attemptId, 'workspace result');
    assert.equal(f.writes.workspaceCreate, 1, 'the owned worktree is created before dispatch');
    f.service.acknowledge(task.id, { revision: 1, accepted: true, artifactState: 'preserved' });
    const before = f.store.get(task.id);
    assert.ok(before.workspace);

    const result = await f.service.archive(task.id, { revision: 1 });
    assert.equal(result.archived, true);
    assert.equal(result.workspacePreserved, true);
    const record = f.store.get(task.id);
    assert.deepEqual(record.workspace, before.workspace, 'the owned workspace must be preserved');
    assert.equal(record.artifactState, 'preserved');
    assert.equal(f.writes.workspaceRemove, 0, 'archive must not remove the worktree');
    assert.equal(f.calls.cleanup.length, 0);
    assert.equal(record.archivedAt ?? null, null);
  } finally {
    f.close();
  }
});

test('a UI-hidden task remains explicitly cleanable and cleanup records the legacy marker', TEST, async () => {
  const f = fixture({ service: { retention: { successDays: 0, failureDays: 0 } } });
  try {
    assertLifecycleApi(f.service);
    const task = await completedTask(f, 'cleanup-hidden');
    const archived = await f.service.archive(task.id, { revision: 1 });
    assert.ok(Number.isSafeInteger(archived.sessionArchivedAt));

    const cleaned = await f.service.cleanup(task.id, { dryRun: false });
    assert.equal(cleaned.cleaned, true);
    assert.equal(f.calls.cleanup.length, 1, 'a hidden eligible task is still cleaned by explicit taskId');
    const record = f.store.get(task.id);
    assert.ok(Number.isSafeInteger(record.archivedAt), 'physical cleanup sets the legacy archivedAt');
    assert.equal(record.sessionArchivedAt, archived.sessionArchivedAt, 'cleanup must not reset the UI archive marker');
    assert.ok(record.result.text.length > 0, 'cleanup retains the result');
    assert.equal(f.store.list().some(entry => entry.id === task.id), false, 'either marker hides the task');
    assert.equal(f.store.list({ includeArchived: true }).some(entry => entry.id === task.id), true);

    const again = await f.service.cleanup(task.id, { dryRun: false });
    assert.equal(again.cleaned, true);
    assert.equal(f.calls.cleanup.length, 1, 'an already cleaned task must not call the host again');
  } finally {
    f.close();
  }
});

test('pinned archived evidence stays protected from physical cleanup', TEST, async () => {
  const f = fixture({ service: { retention: { successDays: 0, failureDays: 0 } } });
  try {
    assertLifecycleApi(f.service);
    const task = await completedTask(f, 'archive-pinned', { pinned: true });
    const archived = await f.service.archive(task.id, { revision: 1 });
    assert.ok(Number.isSafeInteger(archived.sessionArchivedAt), 'pinned evidence may still be UI-hidden');

    const decision = await f.service.cleanup(task.id, { dryRun: false });
    assert.equal(decision.eligible, false);
    assert.ok(decision.reasons.includes('pinned'));
    assert.equal(f.calls.cleanup.length, 0, 'pinned evidence must never be physically cleaned');
    assert.equal(f.store.get(task.id).archivedAt ?? null, null);
  } finally {
    f.close();
  }
});

test('archive is refused while cleanup holds the shared task exclusion', TEST, async () => {
  const f = fixture({ service: { retention: { successDays: 0, failureDays: 0 } } });
  try {
    assertLifecycleApi(f.service);
    const task = await completedTask(f, 'exclusion-cleanup-first');
    const entered = deferred();
    const hold = deferred();
    f.adapter.cleanup = async () => { entered.resolve(); await hold.promise; return { cleaned: true }; };
    const pending = f.service.cleanup(task.id, { dryRun: false });
    await entered.promise;

    const error = await rejectsWithCode(() => f.service.archive(task.id, { revision: 1 }), 'archive during cleanup');
    assert.equal(error.code, 'CLEANUP_BUSY');
    assert.equal(f.calls.archive.length, 0, 'a busy archive must not reach the adapter');
    assert.equal(f.store.get(task.id).sessionArchivedAt ?? null, null);

    hold.resolve();
    const cleaned = await pending;
    assert.equal(cleaned.cleaned, true);
  } finally {
    f.close();
  }
});

test('cleanup is refused while archive holds the shared task exclusion', TEST, async () => {
  const f = fixture({ service: { retention: { successDays: 0, failureDays: 0 } } });
  try {
    assertLifecycleApi(f.service);
    const task = await completedTask(f, 'exclusion-archive-first');
    const entered = deferred();
    const hold = deferred();
    f.adapter.archive = async () => { entered.resolve(); await hold.promise; return { archived: true, uiHidden: true, sessionId: task.sessionId, workspacePreserved: true, evidencePreserved: true }; };
    const pending = f.service.archive(task.id, { revision: 1 });
    await entered.promise;

    const error = await rejectsWithCode(() => f.service.cleanup(task.id, { dryRun: false }), 'cleanup during archive');
    assert.equal(error.code, 'CLEANUP_BUSY');
    assert.equal(f.calls.cleanup.length, 0, 'a busy cleanup must not reach the adapter');
    assert.equal(f.store.get(task.id).archivedAt ?? null, null);

    hold.resolve();
    const archived = await pending;
    assert.equal(archived.archived, true);
  } finally {
    f.close();
  }
});

// ---------------------------------------------------------------------------
// Dispatcher plumbing
// ---------------------------------------------------------------------------

test('bridge_clarify and bridge_archive route through the public dispatcher', TEST, async () => {
  const f = fixture();
  try {
    assertLifecycleApi(f.service);
    const dispatch = createDispatcher(f.service);

    const task = await f.submit('dispatch-clarify', { understandingRequired: true });
    await f.settleUnderstanding(task.id, task.attemptId, 'U0');
    const gate = f.store.get(task.id);
    const view = await dispatch('bridge_clarify', { taskId: task.id, revision: gate.revision, understandingHash: gate.understandingHash, clarificationId: 'd1', text: 'clarified context' });
    assert.equal(view.id, task.id);
    assert.notEqual(view.clarificationReplay, true);
    assert.equal(view.status, 'queued');
    assert.equal(view.continuationKind, 'clarification');
    assert.equal(f.store.get(task.id).clarifications.length, 1);
    await until(() => f.calls.reconsider.length === 1, 'clarification dispatch through the dispatcher');

    // Bad dispatcher arguments must not mutate task state.
    const before = f.store.get(task.id);
    await rejectsWithCode(() => dispatch('bridge_clarify', { taskId: task.id, revision: before.revision, understandingHash: before.understandingHash, clarificationId: 'd2' }), 'bridge_clarify without text');
    assert.equal(f.store.get(task.id).clarifications.length, 1);

    const done = await completedTask(f, 'dispatch-archive');
    const archived = await dispatch('bridge_archive', { taskId: done.id, revision: 1 });
    assert.equal(archived.archived, true);
    assert.equal(archived.taskId, done.id);
    assert.ok(Number.isSafeInteger(archived.sessionArchivedAt));
    assert.equal(f.store.list().some(entry => entry.id === done.id), false);
  } finally {
    f.close();
  }
});
