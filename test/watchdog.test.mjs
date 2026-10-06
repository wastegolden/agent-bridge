// test/watchdog.test.mjs
//
// Targeted regressions for the optional one-shot deadline watchdog: strict config and
// binding validation, the real host MCP wire shape, the single-timer replay fence and the
// exclusive check claim, the strict numeric-zero stop rule (including the `failed`
// outcome class), enqueue-once behaviour, existing-callback suppression, and carrier
// stdout/JSON-RPC compatibility. Nothing here sends anything externally: the check
// request, the clock, the sleep, the spawn and the outbox are all injected seams.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_GRACE_MS,
  MAX_TIMER_MS,
  WatchdogConfigError,
  WATCHDOG_CONFIG_ENV,
  computeDeadline,
  decodeToolResultValue,
  isLocalAbsolutePath,
  isSuccessfulSubmitReply,
  normalizeWatchdogConfig,
  planWatchdogArm,
  resolveGrantTimeoutMs,
} from '../src/watchdog-config.mjs';
import {
  claimReceipt,
  normalizeReceipt,
  readReceipt,
  receiptFilePath,
  writeArmReceipt,
} from '../src/watchdog-receipts.mjs';
import {
  armWatchdog,
  isPositiveStop,
  isQuietStop,
  runWatchdogCheck,
  watchdogEventId,
} from '../src/watchdog.mjs';
import {
  createCarrier,
  loadCarrierWatchdogConfig,
  resolveCarrierToken,
} from '../src/bridge-carrier.mjs';
import { main as sidecarMain } from '../bin/watchdog-sidecar.mjs';

const TARGET = 'chat-thread-1';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A valid operator configuration for the injected test environment. */
function validConfig(overrides = {}) {
  const root = overrides.root ?? tempDir('dsh-watchdog-');
  const raw = {
    enabled: true,
    targetId: TARGET,
    callerThreadId: TARGET,
    stateRoot: path.join(root, 'state'),
    receiptRoot: path.join(root, 'receipts'),
    endpoint: 'http://127.0.0.1:3080/mcp/codex-bridge-v1',
    credentialFile: path.join(root, 'bridge-token'),
    graceMs: 2000,
    checkTimeoutMs: 5000,
    ...overrides.raw,
  };
  const config = normalizeWatchdogConfig(raw, { env: { CODEX_THREAD_ID: TARGET, ...(overrides.env ?? {}) } });
  return { raw, config, root };
}

/**
 * The REAL host tool result wrapper: `structuredContent` carries the task view and
 * `content` mirrors it as JSON text. `result.task` does not exist on the real wire.
 */
function mcpToolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** A real-shaped root task view (id + attemptId + callback, no parent/child markers). */
function rootView(overrides = {}) {
  return {
    id: 't-1',
    attemptId: 'a-1',
    createdAt: 1000,
    callback: { grantId: 'g-1', targetId: TARGET },
    children: [],
    project: { grant: { timeoutMs: 60_000 } },
    ...overrides,
  };
}

/** A minimal in-memory outbox double with the accepted record shape. */
function fakeOutbox({ records = [], onEnqueue = null } = {}) {
  const store = [...records];
  return {
    records: store,
    listEvents: async () => [...store],
    enqueue: async (event) => {
      onEnqueue?.(event);
      const existing = store.find((record) => record.eventId === event.eventId);
      if (existing !== undefined) return { ok: true, duplicate: true, event: existing };
      const record = { ...event, state: 'pending' };
      store.push(record);
      return { ok: true, duplicate: false, event: record };
    },
    close: async () => ({ ok: true }),
  };
}

async function armedReceipt(root, { taskId, attemptId, deadlineAt = 5000, targetId = TARGET } = {}) {
  const filePath = receiptFilePath({ receiptRoot: path.join(root, 'receipts'), taskId, attemptId });
  await writeArmReceipt({ filePath, record: { taskId, attemptId, state: 'armed', targetId, deadlineAt, checks: 0 } });
  return filePath;
}

// ---------------------------------------------------------------------------
// strict validation, binding and the real host wire
// ---------------------------------------------------------------------------

test('watchdog config accepts only the documented keys, absolute local paths and a loopback endpoint', () => {
  const { config } = validConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.targetId, TARGET);
  assert.equal(config.graceMs, 2000);

  const hostile = [
    { command: 'node' },
    { serverPath: 'C:/x.mjs' },
    { tool: 'bridge_check' },
    { token: 'secret' },
    { endpoint: 'https://example.com/mcp' },
    { endpoint: 'file:///etc/passwd' },
    { endpoint: 'http://user:pw@127.0.0.1:3080/mcp' },
    { stateRoot: 'relative/state' },
    { receiptRoot: 'relative/receipts' },
    { credentialFile: 'relative/token' },
    // UNC/remote paths are refused on every platform, even though path.isAbsolute accepts them.
    { stateRoot: '\\\\server\\share\\state' },
    { receiptRoot: '//server/share/receipts' },
    { credentialFile: '\\\\?\\C:\\token' },
    { graceMs: -1 },
    { graceMs: 60001 },
    { graceMs: 1.5 },
    { checkTimeoutMs: 5 },
    { checkTimeoutMs: 999999 },
    { callerThreadId: 'someone-else' },
    { enabled: 'yes' },
  ];
  for (const rawOverrides of hostile) {
    assert.throws(
      () => normalizeWatchdogConfig({ ...validConfig().raw, ...rawOverrides }, { env: { CODEX_THREAD_ID: TARGET } }),
      (error) => error instanceof WatchdogConfigError,
      `expected a refusal for ${JSON.stringify(rawOverrides)}`,
    );
  }
  assert.equal(normalizeWatchdogConfig(undefined, { env: {} }).enabled, false);
  assert.equal(normalizeWatchdogConfig({ enabled: false }, { env: {} }).enabled, false);
});

test('path locality and deadline arithmetic refuse UNC/remote, non-finite, overflow and huge waits', () => {
  assert.equal(isLocalAbsolutePath(path.join(tempDir('dsh-watchdog-path-'), 'x')), true);
  assert.equal(isLocalAbsolutePath('relative/x'), false);
  assert.equal(isLocalAbsolutePath('\\\\server\\share\\x'), false);
  assert.equal(isLocalAbsolutePath('//server/share/x'), false);

  assert.equal(computeDeadline({ createdAt: 1000, timeoutMs: 60_000, graceMs: 2000 }).deadlineAt, 63_000);
  assert.equal(computeDeadline({ createdAt: 0, timeoutMs: 10, graceMs: 0 }).ok, false);
  assert.equal(computeDeadline({ createdAt: 1000, timeoutMs: Number.POSITIVE_INFINITY, graceMs: 0 }).ok, false);
  assert.equal(computeDeadline({ createdAt: 1000, timeoutMs: 86_400_001, graceMs: 0 }).reason, 'timeout-out-of-range');
  assert.equal(computeDeadline({ createdAt: Number.MAX_SAFE_INTEGER, timeoutMs: 1, graceMs: 0 }).reason, 'deadline-overflow');
  assert.equal(computeDeadline({ createdAt: 1000.5, timeoutMs: 10, graceMs: 0 }).ok, false);
});

test('watchdog arming decodes the REAL MCP wrapper, requires the caller grant, a root and an exact attempt', () => {
  const { config } = validConfig();
  // A different real CODEX_THREAD_ID is never accepted.
  assert.throws(
    () => normalizeWatchdogConfig(validConfig().raw, { env: { CODEX_THREAD_ID: 'other-chat' } }),
    (error) => error.code === 'watchdog/caller-mismatch',
  );
  // A missing real CODEX_THREAD_ID is never accepted either.
  assert.throws(
    () => normalizeWatchdogConfig(validConfig().raw, { env: {} }),
    (error) => error.code === 'watchdog/caller-unavailable',
  );

  const view = rootView();
  const wire = { jsonrpc: '2.0', id: 11, result: mcpToolResult(view) };
  assert.equal(isSuccessfulSubmitReply({ method: 'tools/call', name: 'bridge_submit', id: 11, result: wire.result }), true);
  assert.deepEqual(decodeToolResultValue(wire.result), view);

  const armed = planWatchdogArm({ config, result: wire.result });
  assert.equal(armed.arm, true);
  assert.equal(armed.taskId, 't-1');
  assert.equal(armed.attemptId, 'a-1');
  assert.equal(armed.timeoutMs, 60_000);
  assert.equal(armed.deadlineAt, 1_000 + 60_000 + DEFAULT_GRACE_MS);

  // An ordinary accepted submit view exposes NO packet/effectivePacket: the exact budget of
  // the successfully validated REQUEST must be supplied, and without it arming refuses.
  const ordinary = rootView({ project: undefined });
  assert.equal(planWatchdogArm({ config, result: mcpToolResult(ordinary) }).arm, false);
  assert.equal(planWatchdogArm({ config, result: mcpToolResult(ordinary) }).reason, 'no-project-grant-or-explicit-budget');
  const withBudget = planWatchdogArm({ config, result: mcpToolResult(ordinary), requestBudgetTimeoutMs: 30_000 });
  assert.equal(withBudget.arm, true);
  assert.equal(withBudget.timeoutMs, 30_000);
  assert.equal(withBudget.deadlineAt, 1_000 + 30_000 + DEFAULT_GRACE_MS);

  // Wrong target, a worker/child (parent marker), an already-owning root, a missing
  // attempt, a refusal envelope and a legacy nested `task` shape never arm.
  assert.equal(planWatchdogArm({ config, result: mcpToolResult(rootView({ callback: { grantId: 'g-1', targetId: 'other' } })) }).arm, false);
  assert.equal(planWatchdogArm({ config, result: mcpToolResult(rootView({ parentTaskId: 'root-0' })) }).reason, 'not-a-root-task');
  assert.equal(planWatchdogArm({ config, result: mcpToolResult(rootView({ children: [{ childId: 'c-1' }] })) }).reason, 'not-a-root-task');
  assert.equal(planWatchdogArm({ config, result: mcpToolResult(rootView({ attemptId: undefined })) }).reason, 'no-attempt-id');
  assert.equal(planWatchdogArm({ config, result: { isError: true, content: [{ type: 'text', text: '{"code":"INVALID_PACKET"}' }] } }).arm, false);
  assert.equal(isSuccessfulSubmitReply({ method: 'tools/call', name: 'bridge_submit', id: 11, result: { isError: true } }), false);
  assert.equal(isSuccessfulSubmitReply({ method: 'tools/call', name: 'bridge_submit', id: null, result: mcpToolResult(view) }), false);
  assert.equal(resolveGrantTimeoutMs({ project: { grant: { timeoutMs: 1234 } } }), 1234);

  // A bounded RECURRENT project binds its real project identity at arming and uses the
  // immutable PROJECT anchor for the deadline, keeping the outer task anchor for identity.
  const recurrent = rootView({ project: { projectId: 'proj-1', createdAt: 5000, grant: { timeoutMs: 30_000, recurrent: true, maxRounds: 3 }, roundsUsed: 0, rounds: [] } });
  const bound = planWatchdogArm({ config, result: mcpToolResult(recurrent) });
  assert.equal(bound.arm, true);
  assert.equal(bound.createdAt, 5000, 'the PROJECT anchor, never the outer task createdAt (1000), anchors the deadline');
  assert.equal(bound.deadlineAt, 5000 + 30_000 + DEFAULT_GRACE_MS);
  assert.equal(bound.project.projectId, 'proj-1');
  assert.equal(bound.project.projectCreatedAt, 5000);
  assert.equal(bound.project.taskCreatedAt, 1000);
  assert.equal(bound.project.attemptId, 'a-1');
  assert.equal(bound.project.recurrent, true);
  assert.equal(bound.project.targetId, TARGET);
  // An ordinary or legacy (non-recurrent) project carries NO binding, so its receipt
  // bytes and semantics stay exactly as before.
  assert.equal(Object.hasOwn(planWatchdogArm({ config, result: mcpToolResult(rootView()) }), 'project'), false);
  assert.equal(Object.hasOwn(planWatchdogArm({ config, result: mcpToolResult(rootView({ project: { grant: { timeoutMs: 5000 } } })) }), 'project'), false);
});

test('an identical submission replay can never create a second receipt', async () => {
  const { config, root } = validConfig();
  const receipts = path.join(root, 'receipts');
  const filePath = receiptFilePath({ receiptRoot: receipts, taskId: 't-1', attemptId: 'a-1' });
  const record = { taskId: 't-1', attemptId: 'a-1', state: 'armed', targetId: config.targetId, deadlineAt: config.graceMs + 1000, checks: 0 };
  await writeArmReceipt({ filePath, record });
  await assert.rejects(
    () => writeArmReceipt({ filePath, record: { ...record, deadlineAt: 99_999 } }),
    (error) => error.code === 'watchdog/receipt-exists',
    'the second arm must lose the exclusive create',
  );
  const read = await readReceipt({ filePath });
  assert.equal(read.record.deadlineAt, config.graceMs + 1000, 'the original receipt is preserved');
  assert.equal(fs.readdirSync(receipts).length, 1);
});

// ---------------------------------------------------------------------------
// strict numeric stop counts and the one-check behaviour
// ---------------------------------------------------------------------------

test('a positive stop requires explicit numeric zero jobs AND children, and only completed/cancelled is quiet', () => {
  const base = { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0 };
  assert.equal(isPositiveStop(base), true);
  assert.equal(isQuietStop(base), true);
  assert.equal(isPositiveStop({ ...base, activeChildren: null }), false, 'a missing child count is unknown, never zero');
  assert.equal(isPositiveStop({ ...base, activeChildren: undefined }), false);
  assert.equal(isPositiveStop({ ...base, activeChildren: '0' }), false);
  assert.equal(isPositiveStop({ ...base, activeJobs: null }), false);
  assert.equal(isPositiveStop({ ...base, stopConfirmed: 'true' }), false);
  assert.equal(isPositiveStop({ ...base, status: 'cancelling' }), false);
  assert.equal(isPositiveStop({ ...base, status: 'cancelled' }), true);
  // A failed task is a POSITIVE stop but never a QUIET one: without a callback it must surface.
  assert.equal(isPositiveStop({ ...base, status: 'failed' }), true);
  assert.equal(isQuietStop({ ...base, status: 'failed' }), false);
});

test('expiry performs exactly one check and enqueues exactly one bounded needs-input event', async () => {
  const { config, root } = validConfig({ raw: { graceMs: 0 } });
  const filePath = await armedReceipt(root, { taskId: 't-2', attemptId: 'a-2' });
  let checks = 0;
  const enqueued = [];
  const outbox = fakeOutbox({ onEnqueue: (event) => enqueued.push(event) });
  const result = await runWatchdogCheck({
    config,
    taskId: 't-2',
    attemptId: 'a-2',
    receiptPath: filePath,
    now: () => 5_000,
    sleep: async () => undefined,
    request: async () => {
      checks += 1;
      return { jsonrpc: '2.0', id: 'watchdog-t-2', result: mcpToolResult({ id: 't-2', attemptId: 'a-2', status: 'running', stopConfirmed: false, activeJobs: 1, activeChildren: 0 }) };
    },
    createOutbox: () => outbox,
    logger: () => undefined,
  });
  assert.equal(checks, 1, 'exactly one state check');
  assert.equal(result.outcome, 'unresolved');
  assert.equal(enqueued.length, 1, 'exactly one needs-input event');
  assert.equal(enqueued[0].kind, 'needs-input');
  assert.equal(enqueued[0].taskId, 't-2');
  assert.equal(enqueued[0].attemptId, 'a-2');
  assert.equal(enqueued[0].targetId, TARGET);
  assert.equal(enqueued[0].eventId, watchdogEventId({ taskId: 't-2', attemptId: 'a-2' }));
  assert.ok(enqueued[0].summary.length <= 800);
  assert.equal(result.receipt.checks, 1);
  assert.equal(result.receipt.state, 'enqueued');
  assert.equal(result.receipt.eventState, 'pending');
  assert.equal(result.receipt.enqueuedEventId, enqueued[0].eventId);
});

test('an unreachable bridge is an anomaly that still enqueues once and is never a delivered claim', async () => {
  const { config, root } = validConfig({ raw: { graceMs: 0 } });
  const filePath = await armedReceipt(root, { taskId: 't-3', attemptId: 'a-3', deadlineAt: 1 });
  const outbox = fakeOutbox();
  const result = await runWatchdogCheck({
    config,
    taskId: 't-3',
    attemptId: 'a-3',
    receiptPath: filePath,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => {
      throw new Error('ECONNREFUSED');
    },
    createOutbox: () => outbox,
    logger: () => undefined,
  });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(outbox.records.length, 1);
  assert.equal(result.receipt.eventState, 'pending', 'enqueued is not delivered');
  assert.notEqual(result.receipt.eventState, 'delivered');
});

test('a positive stop is quiet, and an existing same-attempt callback is preserved with its state', async () => {
  const { config, root } = validConfig();
  const positivePath = await armedReceipt(root, { taskId: 't-4', attemptId: 'a-4', deadlineAt: 1 });
  let enqueues = 0;
  const quietOutbox = fakeOutbox({ onEnqueue: () => { enqueues += 1; } });
  const positive = await runWatchdogCheck({
    config,
    taskId: 't-4',
    attemptId: 'a-4',
    receiptPath: positivePath,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => ({ result: mcpToolResult({ id: 't-4', attemptId: 'a-4', status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0 }) }),
    createOutbox: () => quietOutbox,
    logger: () => undefined,
  });
  assert.equal(positive.outcome, 'positive-stop');
  assert.equal(enqueues, 0, 'a clean completion needs no callback');
  assert.equal(positive.receipt.state, 'resolved');

  const coveredPath = await armedReceipt(root, { taskId: 't-5', attemptId: 'a-5', deadlineAt: 1 });
  // An existing SAME-attempt record in an ambiguous state must be preserved, not resent.
  const existing = { eventId: 'evt-existing', taskId: 't-5', attemptId: 'a-5', targetId: TARGET, kind: 'failed', summary: 'already reported', state: 'unknown' };
  let resends = 0;
  const coveredOutbox = fakeOutbox({ records: [existing], onEnqueue: () => { resends += 1; } });
  const covered = await runWatchdogCheck({
    config,
    taskId: 't-5',
    attemptId: 'a-5',
    receiptPath: coveredPath,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => ({ result: mcpToolResult({ id: 't-5', attemptId: 'a-5', status: 'running', stopConfirmed: false, activeJobs: 2, activeChildren: 0 }) }),
    createOutbox: () => coveredOutbox,
    logger: () => undefined,
  });
  assert.equal(covered.outcome, 'existing-callback');
  assert.equal(resends, 0, 'an existing callback is never resent');
  assert.equal(covered.receipt.existingEventId, 'evt-existing');
  assert.equal(covered.receipt.existingEventState, 'unknown', 'ambiguity is recorded even when reusing a callback');
  assert.notEqual(covered.receipt.state, 'enqueued');
});

test('a FAILED stop without a callback surfaces exactly one needs-input; an existing one is reused', async () => {
  const { config, root } = validConfig();
  const failedPath = await armedReceipt(root, { taskId: 't-f1', attemptId: 'a-f1', deadlineAt: 1 });
  const enqueued = [];
  const failed = await runWatchdogCheck({
    config,
    taskId: 't-f1',
    attemptId: 'a-f1',
    receiptPath: failedPath,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => ({ result: mcpToolResult({ id: 't-f1', attemptId: 'a-f1', status: 'failed', stopConfirmed: true, activeJobs: 0, activeChildren: 0 }) }),
    createOutbox: () => fakeOutbox({ onEnqueue: (event) => enqueued.push(event) }),
    logger: () => undefined,
  });
  assert.equal(failed.outcome, 'unresolved', 'a failed task with no callback is not quiet');
  assert.equal(failed.receipt.state, 'enqueued');
  assert.equal(failed.receipt.reason, 'failed-without-callback');
  assert.equal(enqueued.length, 1);

  const coveredPath = await armedReceipt(root, { taskId: 't-f2', attemptId: 'a-f2', deadlineAt: 1 });
  const existing = { eventId: 'evt-f2', taskId: 't-f2', attemptId: 'a-f2', targetId: TARGET, kind: 'failed', summary: 'already reported', state: 'pending' };
  let resends = 0;
  const covered = await runWatchdogCheck({
    config,
    taskId: 't-f2',
    attemptId: 'a-f2',
    receiptPath: coveredPath,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => ({ result: mcpToolResult({ id: 't-f2', attemptId: 'a-f2', status: 'failed', stopConfirmed: true, activeJobs: 0, activeChildren: 0 }) }),
    createOutbox: () => fakeOutbox({ records: [existing], onEnqueue: () => { resends += 1; } }),
    logger: () => undefined,
  });
  assert.equal(covered.outcome, 'existing-callback');
  assert.equal(resends, 0);
  assert.equal(covered.receipt.existingEventId, 'evt-f2');
});

test('a check reply for another task/attempt is never evidence, never quiet and never a different target', async () => {
  const { config, root } = validConfig();
  const filePath = await armedReceipt(root, { taskId: 't-6', attemptId: 'a-6', deadlineAt: 1 });
  const enqueued = [];
  const result = await runWatchdogCheck({
    config,
    taskId: 't-6',
    attemptId: 'a-6',
    receiptPath: filePath,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => ({ result: mcpToolResult({ id: 'other-task', attemptId: 'other-attempt', status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0 }) }),
    createOutbox: () => fakeOutbox({ onEnqueue: (event) => enqueued.push(event) }),
    logger: () => undefined,
  });
  assert.notEqual(result.outcome, 'positive-stop');
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.receipt.reason, 'check-identity-mismatch');
  assert.equal(result.receipt.observed, 'completed', 'the mismatched observation is recorded, never used as this attempt proof');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].taskId, 't-6', 'the event is for the pinned attempt, never the mismatched one');
  assert.equal(enqueued[0].targetId, TARGET);
});

test('a legitimate recurrent lineage is quiet and reuses its current callback; broken lineage/target/anchor/counts stay an anomaly', async () => {
  const { config, root } = validConfig({ raw: { graceMs: 0 } });
  const recurrentInitial = (id) => rootView({
    id,
    attemptId: 'a-1',
    project: { projectId: `proj-${id}`, createdAt: 1000, grant: { timeoutMs: 60_000, recurrent: true, maxRounds: 3 }, roundsUsed: 0, rounds: [] },
  });
  const armFor = async (view) => {
    const plan = planWatchdogArm({ config, result: mcpToolResult(view) });
    assert.equal(plan.arm, true, 'a recurrent project arms with its binding');
    assert.equal(plan.project?.attemptId, 'a-1', 'the binding keeps the armed first attempt');
    const receiptPath = receiptFilePath({ receiptRoot: config.receiptRoot, taskId: view.id, attemptId: view.attemptId });
    const armed = await armWatchdog({ config, plan, receiptPath, now: () => 1000 });
    assert.equal(armed.armed, true);
    // The binding must survive the REAL normalized receipt round-trip, not just memory.
    const persisted = await readReceipt({ filePath: receiptPath });
    assert.equal(persisted.record.project?.attemptId, 'a-1');
    assert.equal(persisted.record.project?.deadlineAt, plan.deadlineAt);
    return { plan, receiptPath };
  };
  const stoppedRound = (attemptId, index) => ({ index, attemptId, status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0 });
  const lineageView = (view, { status = 'completed', projectStatus = status, rounds, workers = [], attemptId = 'a-2' } = {}) => ({
    ...view,
    attemptId,
    status,
    stopConfirmed: true,
    activeJobs: 0,
    activeChildren: 0,
    project: { ...view.project, status: projectStatus, roundsUsed: 2, rounds: rounds ?? [stoppedRound('a-1', 1), stoppedRound(attemptId, 2)], workers },
  });
  const check = (view, receiptPath, observation, outbox) => runWatchdogCheck({
    config,
    taskId: view.id,
    attemptId: view.attemptId,
    receiptPath,
    now: () => 61_000,
    sleep: async () => undefined,
    request: async () => ({ result: mcpToolResult(observation) }),
    createOutbox: () => outbox,
    logger: () => undefined,
  });

  // 1. A genuine completion at a later attempt is QUIET: no extra wake is fabricated.
  const completedView = recurrentInitial('t-r1');
  const completedArm = await armFor(completedView);
  const quietOutbox = fakeOutbox();
  const completed = await check(completedView, completedArm.receiptPath, lineageView(completedView), quietOutbox);
  assert.equal(completed.outcome, 'positive-stop');
  assert.equal(quietOutbox.records.length, 0, 'a legitimately completed recurrent project is quiet');

  // 2. A real current failed aggregate callback is REUSED under the current attempt id.
  const failedView = recurrentInitial('t-r2');
  const failedArm = await armFor(failedView);
  const existing = { eventId: 'aggregate-current', taskId: failedView.id, attemptId: 'a-2', targetId: TARGET, kind: 'failed', summary: 'already reported', state: 'delivered' };
  const failedOutbox = fakeOutbox({ records: [existing] });
  const failed = await check(failedView, failedArm.receiptPath, lineageView(failedView, { status: 'failed', projectStatus: 'failed' }), failedOutbox);
  assert.equal(failed.outcome, 'existing-callback');
  assert.equal(failedOutbox.records.length, 1, 'the current aggregate callback is reused, never duplicated');
  assert.equal(failed.receipt.existingEventId, 'aggregate-current');

  // 3. A changed attempt with NO callback is a genuine current failure: exactly ONE
  //    needs-input, addressed to the CURRENT attempt, never the stopped armed one.
  const bareView = recurrentInitial('t-r3');
  const bareArm = await armFor(bareView);
  const bareOutbox = fakeOutbox();
  const bare = await check(bareView, bareArm.receiptPath, lineageView(bareView, { status: 'failed', projectStatus: 'failed' }), bareOutbox);
  assert.equal(bare.outcome, 'unresolved');
  assert.equal(bareOutbox.records.length, 1);
  assert.equal(bareOutbox.records[0].attemptId, 'a-2');

  // 4. Missing, broken or mismatched proof is NEVER quiet and keeps the ARMED attempt.
  const negatives = [
    ['broken lineage', (view) => lineageView(view, { rounds: [stoppedRound('unrelated-first', 1), stoppedRound('a-2', 2)] })],
    ['changed callback target', (view) => ({ ...lineageView(view), callback: { grantId: 'g-1', targetId: 'a-different-target' } })],
    ['changed project anchor', (view) => { const base = lineageView(view); return { ...base, project: { ...base.project, createdAt: 1001 } }; }],
    ['changed grant timeout', (view) => { const base = lineageView(view); return { ...base, project: { ...base.project, grant: { ...base.project.grant, timeoutMs: 30_000 } } }; }],
    ['unknown owned child count', (view) => lineageView(view, { workers: [{ workerKey: 'w1', state: 'succeeded', attempts: [{ attempt: 1, stopConfirmed: true, activeJobs: 0 }] }] })],
    ['unproven middle round', (view) => {
      const base = lineageView(view, { attemptId: 'a-3', rounds: [stoppedRound('a-1', 1), { ...stoppedRound('a-2', 2), activeChildren: null }, stoppedRound('a-3', 3)] });
      base.project.roundsUsed = 3;
      return base;
    }],
    ['duplicate round identity', (view) => lineageView(view, { rounds: [stoppedRound('a-1', 1), stoppedRound('a-1', 2)] })],
    ['unproven older worker attempt', (view) => lineageView(view, { workers: [{ attempts: [{ stopConfirmed: false, activeJobs: null, activeChildren: null }, { stopConfirmed: true, activeJobs: 0, activeChildren: 0 }] }] })],
    ['changed maxRounds grant', (view) => { const base = lineageView(view); base.project.grant = { ...base.project.grant, maxRounds: 8 }; return base; }],
    ['changed outer task anchor', (view) => ({ ...lineageView(view), createdAt: 1001 })],
  ];
  for (let index = 0; index < negatives.length; index += 1) {
    const [label, makeObservation] = negatives[index];
    const view = recurrentInitial(`t-rn${index}`);
    const { receiptPath } = await armFor(view);
    const outbox = fakeOutbox();
    const result = await check(view, receiptPath, makeObservation(view), outbox);
    assert.notEqual(result.outcome, 'positive-stop', `${label}: never quiet`);
    assert.equal(outbox.records.length, 1, `${label}: exactly one bounded anomaly event`);
    assert.equal(outbox.records[0].attemptId, 'a-1', `${label}: the event keeps the armed attempt identity`);
  }
});

test('an ordinary/legacy arm writes a receipt with NO project binding, byte-identical to its normalized record', async () => {
  const { config, root } = validConfig();
  const plan = planWatchdogArm({ config, result: mcpToolResult(rootView()) });
  assert.equal(plan.arm, true);
  assert.equal(Object.hasOwn(plan, 'project'), false, 'a non-recurrent project never binds');
  const receiptPath = receiptFilePath({ receiptRoot: config.receiptRoot, taskId: plan.taskId, attemptId: plan.attemptId });
  const armed = await armWatchdog({ config, plan, receiptPath, now: () => 1000 });
  assert.equal(armed.armed, true);
  const raw = fs.readFileSync(receiptPath, 'utf8');
  assert.ok(!raw.includes('"project"'), 'a binding-absent receipt never gains a project key');
  assert.equal(raw, `${JSON.stringify(normalizeReceipt(armed.receipt))}\n`, 'legacy receipt bytes are exactly the pre-change normalized record');
  assert.equal(Object.hasOwn(normalizeReceipt(armed.receipt), 'project'), false);
});

test('a receipt that is not armed for this exact attempt refuses a second check without rewriting it', async () => {
  const { config, root } = validConfig();
  // Simulate the persisted `checking` state that a crashed first process left behind.
  const checking = receiptFilePath({ receiptRoot: path.join(root, 'receipts'), taskId: 't-8', attemptId: 'a-8' });
  await writeArmReceipt({ filePath: checking, record: { taskId: 't-8', attemptId: 'a-8', state: 'checking', targetId: TARGET, deadlineAt: 1, checks: 1 } });
  let checks = 0;
  const result = await runWatchdogCheck({
    config,
    taskId: 't-8',
    attemptId: 'a-8',
    receiptPath: checking,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => {
      checks += 1;
      return { result: mcpToolResult({ id: 't-8', attemptId: 'a-8', status: 'running' }) };
    },
    createOutbox: () => fakeOutbox(),
    logger: () => undefined,
  });
  assert.equal(checks, 0, 'an ambiguous receipt never runs another check');
  assert.equal(result.outcome, 'refused');
  assert.equal(result.receipt.state, 'ambiguous');
  const persisted = await readReceipt({ filePath: checking });
  assert.equal(persisted.record.state, 'checking', 'the persisted receipt is left untouched');
});

test('an identical duplicate arm preserves the first receipt and its live owner (no second spawn/check)', async () => {
  const { config, root } = validConfig();
  const filePath = receiptFilePath({ receiptRoot: path.join(root, 'receipts'), taskId: 't-9', attemptId: 'a-9' });
  const plan = { arm: true, taskId: 't-9', attemptId: 'a-9', targetId: TARGET, timeoutMs: 60_000, createdAt: 1000, deadlineAt: 63_000 };
  const spawned = [];
  const spawnSidecar = () => { spawned.push(Date.now()); return { ok: true, pid: 1 }; };
  const first = await armWatchdog({ config, plan, env: { CODEX_THREAD_ID: TARGET }, now: () => 1000, receiptPath: filePath, spawnSidecar, logger: () => undefined });
  assert.equal(first.armed, true);
  assert.equal(spawned.length, 1);
  const second = await armWatchdog({ config, plan, env: { CODEX_THREAD_ID: TARGET }, now: () => 1001, receiptPath: filePath, spawnSidecar, logger: () => undefined });
  assert.equal(second.armed, false);
  assert.equal(second.reason, 'duplicate-arm');
  assert.equal(spawned.length, 1, 'a replay never spawns a second sidecar');
  const preserved = await readReceipt({ filePath });
  assert.equal(preserved.record.state, 'armed', 'the FIRST receipt and its live owner are untouched');
  assert.equal(preserved.record.checks, 0);
});

test('the check claim is exclusive: a held marker refuses without a check and is never reclaimed', async () => {
  const { config, root } = validConfig();
  const filePath = await armedReceipt(root, { taskId: 't-10', attemptId: 'a-10', deadlineAt: 1 });
  const claim = await claimReceipt({ filePath, taskId: 't-10', attemptId: 'a-10', targetId: TARGET, now: () => 1 });
  assert.equal(claim.claimed, true);
  const secondClaim = await claimReceipt({ filePath, taskId: 't-10', attemptId: 'a-10', targetId: TARGET, now: () => 2 });
  assert.equal(secondClaim.claimed, false);
  assert.equal(secondClaim.reason, 'claim-held');
  let checks = 0;
  const result = await runWatchdogCheck({
    config,
    taskId: 't-10',
    attemptId: 'a-10',
    receiptPath: filePath,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => { checks += 1; return { result: mcpToolResult({ id: 't-10', attemptId: 'a-10', status: 'running' }) }; },
    createOutbox: () => fakeOutbox(),
    logger: () => undefined,
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.receipt.reason, 'check-claim-held');
  assert.equal(checks, 0, 'a held claim never runs a check');
  const persisted = await readReceipt({ filePath });
  assert.equal(persisted.record.state, 'armed', 'the claim never rewrites the receipt by itself');
});

test('an outbox that cannot be listed fails closed with bounded unavailable evidence and no enqueue', async () => {
  const { config, root } = validConfig();
  const filePath = await armedReceipt(root, { taskId: 't-11', attemptId: 'a-11', deadlineAt: 1 });
  let enqueues = 0;
  const result = await runWatchdogCheck({
    config,
    taskId: 't-11',
    attemptId: 'a-11',
    receiptPath: filePath,
    now: () => 1,
    sleep: async () => undefined,
    request: async () => ({ result: mcpToolResult({ id: 't-11', attemptId: 'a-11', status: 'running', stopConfirmed: false, activeJobs: 1, activeChildren: 0 }) }),
    createOutbox: () => ({ enqueue: async () => { enqueues += 1; return { ok: true }; }, close: async () => ({ ok: true }) }),
    logger: () => undefined,
  });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.receipt.state, 'unavailable');
  assert.equal(result.receipt.reason, 'WATCHDOG_OUTBOX_LOOKUP_UNSUPPORTED');
  assert.equal(enqueues, 0, 'no event is enqueued as though "no event" had been proven');
});

test('an unsupported huge wait is refused rather than handed to a timer that fires early', async () => {
  const { config, root } = validConfig();
  const filePath = receiptFilePath({ receiptRoot: path.join(root, 'receipts'), taskId: 't-12', attemptId: 'a-12' });
  await writeArmReceipt({ filePath, record: { taskId: 't-12', attemptId: 'a-12', state: 'armed', targetId: TARGET, deadlineAt: 1000 + MAX_TIMER_MS + 1, checks: 0 } });
  let checks = 0;
  const result = await runWatchdogCheck({
    config,
    taskId: 't-12',
    attemptId: 'a-12',
    receiptPath: filePath,
    now: () => 1000,
    sleep: async () => undefined,
    request: async () => { checks += 1; return { result: mcpToolResult({ id: 't-12', attemptId: 'a-12', status: 'running' }) }; },
    createOutbox: () => fakeOutbox(),
    logger: () => undefined,
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.receipt.reason, 'unsupported-wait');
  assert.equal(checks, 0);
});

// ---------------------------------------------------------------------------
// carrier compatibility and the optional hook
// ---------------------------------------------------------------------------

function carrierHarness({ responses, env = {}, watchdogEnabled = true, spawned = [] } = {}) {
  const writes = [];
  const queue = [...responses];
  const stdout = { write: (chunk) => { writes.push(chunk); return true; } };
  const carrier = createCarrier({
    stdout,
    env,
    // The missing credential path yields no token; the REAL config file (when opted in) is
    // read from disk so the harness exercises the actual loader.
    credentialFile: path.join(tempDir('dsh-carrier-token-'), 'missing-token'),
    readFileImpl: async (value) => fs.readFileSync(value, 'utf8'),
    fetchImpl: async () => queue.shift(),
    watchdogEnabled,
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { pid: 4242, on: () => undefined, unref: () => undefined };
    },
    logger: () => undefined,
  });
  return { carrier, writes, spawned };
}

test('the carrier preserves its measured JSON-RPC stdout behaviour, including 202, errors and id-less 200 replies', async () => {
  const { carrier, writes } = carrierHarness({
    responses: [
      { status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } }) },
      { status: 202, ok: true },
      { status: 500, ok: false },
      // Measured behaviour: a successful 200 reply is forwarded EVEN when the input had no id.
      { status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: null, result: { forwarded: true } }) },
      // A transport fault with no id yields NO error reply.
      { status: 500, ok: false },
    ],
    watchdogEnabled: false,
  });
  const first = await carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }));
  assert.equal(first.replied, true);
  assert.deepEqual(writes, ['{"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n']);
  const accepted = await carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'bridge_submit' } }));
  assert.equal(accepted.replied, false);
  assert.equal(writes.length, 1, 'a 202 produces no reply');
  const failed = await carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
  assert.equal(failed.code, -32000);
  assert.deepEqual(JSON.parse(writes[1]), { jsonrpc: '2.0', id: 9, error: { code: -32000, message: 'DSH bridge HTTP 500' } });
  // A notification has no id: the host answers notifications with 202, but a 200 body is
  // still forwarded exactly as measured. The protocol is never rewritten to silence it.
  const notification = await carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(notification.replied, true);
  assert.equal(writes.length, 3);
  assert.deepEqual(JSON.parse(writes[2]), { jsonrpc: '2.0', id: null, result: { forwarded: true } });
  const notificationFailure = await carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(notificationFailure.replied, false);
  assert.equal(writes.length, 3, 'a transport fault with no id writes no error reply');
  const invalid = await carrier.handleLine('{not json');
  assert.equal(invalid.code, -32700);
  assert.deepEqual(JSON.parse(writes[3]), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
});

test('the carrier token resolution keeps DSH_MCP_TOKEN first and the credential file second', async () => {
  assert.equal(await resolveCarrierToken({ env: { DSH_MCP_TOKEN: 'env-token' }, readFileImpl: async () => 'file-token' }), 'env-token');
  assert.equal(await resolveCarrierToken({ env: {}, credentialFile: 'C:/x', readFileImpl: async () => 'file-token\n' }), 'file-token');
  assert.equal(await resolveCarrierToken({ env: {}, credentialFile: 'C:/x', readFileImpl: async () => { throw new Error('ENOENT'); } }), null);
});

test('the optional hook arms one detached windowless sidecar from the REAL wire, and refuses children/target mismatches', async () => {
  const root = tempDir('dsh-watchdog-carrier-');
  const configPath = path.join(root, 'watchdog.json');
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    targetId: TARGET,
    callerThreadId: TARGET,
    stateRoot: path.join(root, 'state'),
    receiptRoot: path.join(root, 'receipts'),
    endpoint: 'http://127.0.0.1:3080/mcp/codex-bridge-v1',
    credentialFile: path.join(root, 'bridge-token'),
    graceMs: 2000,
    checkTimeoutMs: 5000,
  }));
  const env = { CODEX_THREAD_ID: TARGET, [WATCHDOG_CONFIG_ENV]: configPath };
  const projectView = rootView();
  const submitResult = { jsonrpc: '2.0', id: 11, result: mcpToolResult(projectView) };
  const spawned = [];
  const { carrier } = carrierHarness({
    responses: [{ status: 200, ok: true, text: async () => JSON.stringify(submitResult) }],
    env,
    spawned,
  });
  await carrier.start();
  await carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'bridge_submit', arguments: { packet: {} } } }));
  await carrier.whenIdle();
  assert.equal(spawned.length, 1, 'exactly one sidecar');
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.windowsHide, true);
  assert.equal(spawned[0].options.stdio, 'ignore');
  assert.deepEqual(spawned[0].options.env, { CODEX_THREAD_ID: TARGET, [WATCHDOG_CONFIG_ENV]: configPath });
  const taskFlag = spawned[0].args.indexOf('--task');
  const attemptFlag = spawned[0].args.indexOf('--attempt');
  assert.ok(taskFlag >= 0 && spawned[0].args[taskFlag + 1] === projectView.id, 'the armed sidecar carries the exact real root task id');
  assert.ok(attemptFlag >= 0 && spawned[0].args[attemptFlag + 1] === projectView.attemptId, 'the armed sidecar carries the exact real attempt id');
  assert.ok(spawned[0].args.includes('--created-at') && spawned[0].args.includes('1000'));
  assert.ok(spawned[0].args.includes('--timeout-ms') && spawned[0].args.includes('60000'));
  assert.ok(spawned[0].args.includes('--deadline') && spawned[0].args.includes('63000'));
  assert.ok(!spawned[0].args.some((arg) => String(arg).includes('bridge-token')), 'no credential path or value reaches argv');
  assert.equal(carrier.watchdogState().armed, 1);

  // A bounded recurrent project carries the immutable PROJECT anchor to the real spawned
  // sidecar and its binding survives to the on-disk receipt (not in-memory only).
  const recurrentView = rootView({ id: 'task-r', attemptId: 'attempt-r', project: { projectId: 'proj-r', createdAt: 4000, grant: { timeoutMs: 60_000, recurrent: true, maxRounds: 3 }, roundsUsed: 0, rounds: [] } });
  const spawnedRecurrent = [];
  const recurrentHarness = carrierHarness({
    responses: [{ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 17, result: mcpToolResult(recurrentView) }) }],
    env,
    spawned: spawnedRecurrent,
  });
  await recurrentHarness.carrier.start();
  await recurrentHarness.carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'bridge_submit', arguments: { packet: {} } } }));
  await recurrentHarness.carrier.whenIdle();
  assert.equal(spawnedRecurrent.length, 1);
  assert.ok(spawnedRecurrent[0].args.includes('--created-at') && spawnedRecurrent[0].args.includes('4000'), 'the PROJECT anchor reaches the sidecar');
  assert.ok(spawnedRecurrent[0].args.includes('--deadline') && spawnedRecurrent[0].args.includes(String(4000 + 60_000 + 2000)));
  const recurrentReceipt = await readReceipt({ filePath: receiptFilePath({ receiptRoot: path.join(root, 'receipts'), taskId: 'task-r', attemptId: 'attempt-r' }) });
  assert.equal(recurrentReceipt.record.project?.attemptId, 'attempt-r');
  assert.equal(recurrentReceipt.record.project?.projectCreatedAt, 4000);
  assert.equal(recurrentReceipt.record.project?.deadlineAt, 4000 + 60_000 + 2000);

  // An ordinary accepted submit has no project grant: only the EXPLICIT validated request
  // budget arms it, and an omitted budget refuses.
  const ordinary = rootView({ id: 'task-3', attemptId: 'attempt-3', project: undefined, createdAt: 2000 });
  const spawnedOrdinary = [];
  const third = carrierHarness({
    responses: [{ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 13, result: mcpToolResult(ordinary) }) }],
    env,
    spawned: spawnedOrdinary,
  });
  await third.carrier.start();
  await third.carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'bridge_submit', arguments: { packet: { budget: { timeoutMs: 30000 } } } } }));
  await third.carrier.whenIdle();
  assert.equal(spawnedOrdinary.length, 1, 'the explicit validated request budget arms an ordinary root');
  assert.ok(spawnedOrdinary[0].args.includes('--timeout-ms') && spawnedOrdinary[0].args.includes('30000'));

  const spawnedNoBudget = [];
  const fourth = carrierHarness({
    responses: [{ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 14, result: mcpToolResult({ ...ordinary, id: 'task-4', attemptId: 'attempt-4' }) }) }],
    env,
    spawned: spawnedNoBudget,
  });
  await fourth.carrier.start();
  await fourth.carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'bridge_submit', arguments: { packet: {} } } }));
  await fourth.carrier.whenIdle();
  assert.equal(spawnedNoBudget.length, 0, 'an ordinary root with no explicit budget never arms');

  // A child/non-submit result and a mismatched target never arm.
  const spawned2 = [];
  const second = carrierHarness({ responses: [{ status: 200, ok: true, text: async () => JSON.stringify({ result: { isError: true } }) }], env, spawned: spawned2 });
  await second.carrier.start();
  await second.carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'bridge_submit' } }));
  await second.carrier.whenIdle();
  assert.equal(spawned2.length, 0, 'a refused submit never arms');

  const spawnedChild = [];
  const child = carrierHarness({
    responses: [{ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 15, result: mcpToolResult(rootView({ id: 'task-5', attemptId: 'attempt-5', parentTaskId: 'root-1' })) }) }],
    env,
    spawned: spawnedChild,
  });
  await child.carrier.start();
  await child.carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'bridge_submit' } }));
  await child.carrier.whenIdle();
  assert.equal(spawnedChild.length, 0, 'a worker/child attempt never arms');

  const spawned3 = [];
  const mismatched = carrierHarness({
    responses: [{ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 16, result: mcpToolResult(rootView({ id: 'task-6', attemptId: 'attempt-6', callback: { grantId: 'g-1', targetId: 'someone-else' } })) }) }],
    env,
    spawned: spawned3,
  });
  await mismatched.carrier.start();
  await mismatched.carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'bridge_submit' } }));
  await mismatched.carrier.whenIdle();
  assert.equal(spawned3.length, 0, 'a target mismatch never arms');
});

test('the watchdog is inert without the opt-in environment variable and never damages the reply', async () => {
  const spawned = [];
  const { carrier, writes } = carrierHarness({
    responses: [{ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 21, result: mcpToolResult(rootView({ id: 'task-9', attemptId: 'attempt-9' })) }) }],
    env: {},
    spawned,
  });
  await carrier.start();
  const verdict = await carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'bridge_submit' } }));
  await carrier.whenIdle();
  assert.equal(verdict.replied, true);
  assert.equal(spawned.length, 0, 'no opt-in means no watchdog');
  assert.equal(JSON.parse(writes[0]).result.structuredContent.id, 'task-9');
});

test('an invalid optional watchdog configuration or a non-local config PATH is refused without touching the transport', async () => {
  const root = tempDir('dsh-watchdog-bad-');
  const configPath = path.join(root, 'watchdog.json');
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, targetId: TARGET, callerThreadId: TARGET, stateRoot: 'relative', receiptRoot: 'relative', endpoint: 'https://remote.example/mcp', credentialFile: 'relative', command: 'node' }));
  const seen = [];
  const config = await loadCarrierWatchdogConfig({ env: { CODEX_THREAD_ID: TARGET, [WATCHDOG_CONFIG_ENV]: configPath }, logger: (event) => seen.push(event) });
  assert.equal(config.enabled, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, 'watchdog-config');
  assert.ok(!JSON.stringify(seen).includes('remote.example'), 'the diagnostic never echoes configured values');

  let reads = 0;
  const relative = await loadCarrierWatchdogConfig({ env: { [WATCHDOG_CONFIG_ENV]: 'relative/watchdog.json' }, readFileImpl: async () => { reads += 1; return '{}'; }, logger: () => undefined });
  assert.equal(relative.enabled, false, 'the config PATH itself must be absolute and local');
  assert.equal(reads, 0, 'a non-local config path is refused before any read');
  const unc = await loadCarrierWatchdogConfig({ env: { [WATCHDOG_CONFIG_ENV]: '\\\\server\\share\\watchdog.json' }, readFileImpl: async () => { reads += 1; return '{}'; }, logger: () => undefined });
  assert.equal(unc.enabled, false);
  assert.equal(reads, 0);
});

test('the sidecar refuses a config target that is not the pinned receipt target, without a check', async () => {
  const root = tempDir('dsh-watchdog-sidecar-');
  const config = {
    enabled: true,
    targetId: TARGET,
    callerThreadId: TARGET,
    stateRoot: path.join(root, 'state'),
    receiptRoot: path.join(root, 'receipts'),
    endpoint: 'http://127.0.0.1:3080/mcp/codex-bridge-v1',
    credentialFile: path.join(root, 'token'),
    graceMs: 0,
    checkTimeoutMs: 5000,
  };
  const configPath = path.join(root, 'watchdog.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const filePath = receiptFilePath({ receiptRoot: config.receiptRoot, taskId: 't-s', attemptId: 'a-s' });
  await writeArmReceipt({ filePath, record: { taskId: 't-s', attemptId: 'a-s', state: 'armed', targetId: 'a-different-target', deadlineAt: 2000, checks: 0 } });
  let checks = 0;
  const code = await sidecarMain({
    argv: ['--task', 't-s', '--attempt', 'a-s', '--created-at', '1000', '--timeout-ms', '1000', '--deadline', '2000'],
    env: { CODEX_THREAD_ID: TARGET, [WATCHDOG_CONFIG_ENV]: configPath },
    readFileImpl: async (value) => fs.readFileSync(value, 'utf8'),
    logger: () => undefined,
    fetchImpl: async () => { checks += 1; return { ok: true, json: async () => ({}) }; },
    sleep: async () => undefined,
    now: () => 1000,
  });
  assert.equal(code, 3, 'a pinned-target mismatch is a usage-style refusal');
  assert.equal(checks, 0, 'no check is performed for a mismatched target');
});

test('the real sidecar path reads a bound receipt and keeps a legitimate recurrent lineage quiet', async () => {
  const root = tempDir('dsh-watchdog-sidecar-recurrent-');
  const config = {
    enabled: true,
    targetId: TARGET,
    callerThreadId: TARGET,
    stateRoot: path.join(root, 'state'),
    receiptRoot: path.join(root, 'receipts'),
    endpoint: 'http://127.0.0.1:3080/mcp/codex-bridge-v1',
    credentialFile: path.join(root, 'token'),
    graceMs: 0,
    checkTimeoutMs: 5000,
  };
  const configPath = path.join(root, 'watchdog.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(config.credentialFile, 'token-value\n');
  const view = rootView({ id: 't-sc', attemptId: 'a-1', project: { projectId: 'proj-sc', createdAt: 1000, grant: { timeoutMs: 60_000, recurrent: true, maxRounds: 3 }, roundsUsed: 0, rounds: [] } });
  const plan = planWatchdogArm({ config, result: mcpToolResult(view) });
  assert.equal(plan.arm, true);
  const receiptPath = receiptFilePath({ receiptRoot: config.receiptRoot, taskId: plan.taskId, attemptId: plan.attemptId });
  const armed = await armWatchdog({ config, plan, receiptPath, now: () => 1000 });
  assert.equal(armed.armed, true);
  const stopped = (attemptId, index) => ({ index, attemptId, status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0 });
  const final = {
    ...view,
    attemptId: 'a-2',
    status: 'completed',
    stopConfirmed: true,
    activeJobs: 0,
    activeChildren: 0,
    project: { ...view.project, status: 'completed', roundsUsed: 2, rounds: [stopped('a-1', 1), stopped('a-2', 2)], workers: [] },
  };
  const enqueued = [];
  const outbox = fakeOutbox({ onEnqueue: (event) => enqueued.push(event) });
  const code = await sidecarMain({
    argv: ['--task', 't-sc', '--attempt', 'a-1', '--created-at', '1000', '--timeout-ms', '60000', '--deadline', String(plan.deadlineAt)],
    env: { CODEX_THREAD_ID: TARGET, [WATCHDOG_CONFIG_ENV]: configPath },
    readFileImpl: async (value) => fs.readFileSync(value, 'utf8'),
    logger: () => undefined,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: mcpToolResult({ task: final }) }) }),
    sleep: async () => undefined,
    now: () => plan.deadlineAt,
    createOutbox: () => outbox,
  });
  assert.equal(code, 0, 'a quiet resolved check is a normal exit');
  assert.equal(enqueued.length, 0, 'a legitimate completed recurrent project stays quiet through the real sidecar path');
  const persisted = await readReceipt({ filePath: receiptPath });
  assert.equal(persisted.record.state, 'resolved');
  assert.equal(persisted.record.outcome, 'positive-stop');
});
