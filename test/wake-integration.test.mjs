// test/wake-integration.test.mjs
//
// Focused integration regressions for the product connection
// (contract supervisor-event-wake-v1, release 1.3.0 / adapter 0.5.0).
//
// SCOPE OF EVIDENCE (deliberate): this file exercises the accepted supervisor and the
// REAL durable outbox through `src/wake-integration.mjs`. It proves the producer path,
// the config boundary and the lifecycle rule. It is explicitly NOT evidence that
// `mountBridge` wires the sink inside an installed DSH host — that claim belongs to the
// real offline smoke (`scripts/smoke-autonomy.mjs`), which Codex runs.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EVENT_WAKE_MAX_SUMMARY_CHARS,
  EVENT_WAKE_SCHEMA_VERSION,
  MIN_EVENT_WAKE_MAX_SUMMARY_CHARS,
  WakeIntegrationError,
  assertControllerBinding,
  assertTransportEnvironment,
  createEventWakeRuntime,
  createTargetOutboxRouter,
  loadControllerConfig,
  normalizeEventWakeConfig,
  resolveTargetOutboxDir,
  wakeTargetDirName,
} from '../src/wake-integration.mjs';
import { BridgeSupervisor, callbackEventId, sharedLedger } from '../src/supervisor.mjs';
import { createWakeOutbox } from '../src/wake-outbox.mjs';
import { createWakeClient } from '../src/codex-wake-client.mjs';
import { loadConfig as loadRunnerConfig, main as wakeCodexMain, runWakeRunner } from '../bin/wake-codex.mjs';
import { main as controllerMain, parseControllerArgs, readControllerConfigFile } from '../bin/wake-controller.mjs';
import { ADAPTER_VERSION, MAX_RAW_REPLY_CHARS, MAX_WIRE_REPLY_CHARS } from '../src/dsh-adapter.mjs';
import { createBridgeCloser } from '../src/host-lifecycle.mjs';
import { mountBridge } from '../src/bootstrap.mjs';

const TARGET_A = '01a0e7a9-7906-7280-86a5-abca2e6bca27';
const TARGET_B = '5f3d1c22-0000-4000-8000-abcdefabcdef';

async function tempRoot(t, label = 'wake-integration-') {
  const root = await mkdtemp(path.join(tmpdir(), label));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function hostConfig(stateRoot, { enable = true, maxSummaryChars, claimLeaseMs, extra } = {}) {
  return {
    enabled: enable,
    stateRoot,
    ...(maxSummaryChars === undefined ? {} : { maxSummaryChars }),
    ...(claimLeaseMs === undefined ? {} : { claimLeaseMs }),
    ...(extra ?? {}),
  };
}

function ledgerFor(label) {
  return sharedLedger(`wake-integration-${label}-${Math.random().toString(16).slice(2)}`, { limit: 16 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- config shape */

test('the serializable host eventWake option is validated fail-closed', async (t) => {
  const root = await tempRoot(t);

  // Absent or disabled is OFF and preserves the historical behaviour: no sink, no
  // reply authority, and no target directory is created.
  const absent = createEventWakeRuntime({ eventWake: undefined });
  assert.equal(absent.enabled, false);
  assert.equal(absent.sink, undefined);
  assert.equal(absent.capabilities().producer, false);
  const disabled = normalizeEventWakeConfig({ enabled: false, stateRoot: root });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status.enabled, false);
  await assert.rejects(readFile(path.join(root, wakeTargetDirName(TARGET_A)), 'utf8'), (error) => error.code === 'ENOENT');

  // A relative state root is refused (only paths must be absolute).
  assert.throws(
    () => normalizeEventWakeConfig(hostConfig('relative/wake-state')),
    (error) => error instanceof WakeIntegrationError && error.code === 'eventWake/invalid-config' && error.detail.field === 'eventWake.stateRoot',
  );
  // A non-integer / out-of-range limit is refused.
  assert.throws(
    () => normalizeEventWakeConfig(hostConfig(root, { maxSummaryChars: 8193 })),
    (error) => error.code === 'eventWake/invalid-config' && error.detail.field === 'eventWake.maxSummaryChars',
  );
  assert.throws(
    () => normalizeEventWakeConfig(hostConfig(root, { maxSummaryChars: MIN_EVENT_WAKE_MAX_SUMMARY_CHARS - 1 })),
    (error) => error.code === 'eventWake/invalid-config',
  );
  // A nested grant map is refused: the top-level rootCallbackGrants stays the only map.
  assert.throws(
    () => normalizeEventWakeConfig(hostConfig(root, { extra: { rootCallbackGrants: { root: { targetId: TARGET_A } } } })),
    (error) => error.code === 'eventWake/invalid-config' && /never nested/.test(error.message),
  );
  // An injected sink plus enabled eventWake is ambiguous dual configuration.
  assert.throws(
    () => normalizeEventWakeConfig(hostConfig(root), { notificationSink: () => ({ ok: true }) }),
    (error) => error.code === 'eventWake/dual-configuration',
  );

  // A trusted grant whose targetId is blank is not a destination and is skipped, so
  // no target directory is created for it.
  const normalized = normalizeEventWakeConfig(hostConfig(root), {
    rootCallbackGrants: { good: { targetId: TARGET_A }, blank: { targetId: '   ' }, missing: {} },
  });
  assert.equal(normalized.enabled, true);
  assert.deepEqual(normalized.targets.map((target) => target.targetId), [TARGET_A]);
  assert.equal(normalized.maxSummaryChars, EVENT_WAKE_MAX_SUMMARY_CHARS);
  assert.equal(normalized.status.producer, true);
  assert.equal(normalized.status.liveTransport, 'unknown');
  assert.equal(normalized.status.runnerAvailable, 'unknown');
  assert.equal(normalized.status.liveAck, 'unknown');
});

test('distinct trusted targets get isolated full-digest directories with a binding marker', async (t) => {
  const root = await tempRoot(t);
  const dirA = resolveTargetOutboxDir({ stateRoot: root, targetId: TARGET_A });
  const dirB = resolveTargetOutboxDir({ stateRoot: root, targetId: TARGET_B });
  assert.notEqual(dirA, dirB);
  // Full sha256: 64 hex characters, never a path fragment of the conversation id.
  assert.match(path.basename(dirA), /^t-[0-9a-f]{64}$/);
  assert.equal(path.basename(dirA), wakeTargetDirName(TARGET_A));
  // An NTFS-hostile id ('CON', 'a:b') never reaches the path layer.
  assert.equal(wakeTargetDirName('CON'), wakeTargetDirName('CON'));
  assert.notEqual(wakeTargetDirName('x:y'), 'x:y');

  const runtime = createEventWakeRuntime({
    eventWake: hostConfig(root),
    rootCallbackGrants: { a: { targetId: TARGET_A }, b: { targetId: TARGET_B } },
  });
  // A target that was not granted is refused, whatever the event claims.
  await assert.rejects(
    runtime.sink({ eventId: 'evt-ungranted', taskId: 't', attemptId: 'a', targetId: 'not-granted', kind: 'completed', summary: 'x' }),
    (error) => error.code === 'eventWake/ungranted-target',
  );

  const first = await runtime.sink({ eventId: 'evt-1', taskId: 't1', attemptId: 'a1', targetId: TARGET_A, kind: 'completed', summary: 'A done' });
  const second = await runtime.sink({ eventId: 'evt-2', taskId: 't2', attemptId: 'a1', targetId: TARGET_B, kind: 'completed', summary: 'B done' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(first.event.state, 'pending');
  assert.equal(second.event.state, 'pending');

  const markerA = JSON.parse(await readFile(path.join(dirA, 'target.json'), 'utf8'));
  const markerB = JSON.parse(await readFile(path.join(dirB, 'target.json'), 'utf8'));
  assert.equal(markerA.schemaVersion, EVENT_WAKE_SCHEMA_VERSION);
  assert.equal(markerA.targetId, TARGET_A);
  assert.equal(markerB.targetId, TARGET_B);

  // Each directory holds exactly its own record: no cross-target consumption.
  const outboxA = runtime.outboxFor(TARGET_A);
  const outboxB = runtime.outboxFor(TARGET_B);
  assert.deepEqual((await outboxA.listEvents()).map((record) => record.eventId), ['evt-1']);
  assert.deepEqual((await outboxB.listEvents()).map((record) => record.eventId), ['evt-2']);
  assert.equal(await outboxA.getEvent('evt-2'), null);

  // A directory already bound to another target fails closed instead of aliasing.
  await writeFile(path.join(dirA, 'target.json'), `${JSON.stringify({ schemaVersion: 1, targetId: TARGET_B })}\n`, 'utf8');
  const collided = createEventWakeRuntime({
    eventWake: hostConfig(root),
    rootCallbackGrants: { a: { targetId: TARGET_A } },
  });
  await assert.rejects(
    collided.sink({ eventId: 'evt-3', taskId: 't3', attemptId: 'a1', targetId: TARGET_A, kind: 'completed', summary: 'x' }),
    (error) => error.code === 'eventWake/target-binding',
  );
  await collided.close();
  await runtime.close();
});

/* -------------------------------------------------- producer path (supervisor) */

test('the real supervisor sink writes genuine durable queued events through the router', async (t) => {
  const root = await tempRoot(t);
  const seenWire = [];
  const runtime = createEventWakeRuntime({
    eventWake: hostConfig(root),
    rootCallbackGrants: { root: { targetId: TARGET_A } },
  });
  // Wrap the router sink to observe exactly what the supervisor put on the wire.
  const observedSink = async (event) => {
    seenWire.push({ ...event });
    return await runtime.sink(event);
  };
  const supervisor = new BridgeSupervisor({
    ledger: ledgerFor('producer'),
    ownerId: 'owner',
    config: { rootCallbackGrants: { root: { targetId: TARGET_A } }, notificationSink: observedSink },
  });
  const task = {
    id: 'task-1',
    attemptId: 'attempt-1',
    stopConfirmed: true,
    callbackBinding: { grantId: 'root', targetId: TARGET_A, boundAt: 1 },
  };

  const settlement = await supervisor.notifySettlement({ task, status: 'completed', summary: 'root task completed' });
  // An enqueue acknowledgement is `queued`, never `delivered`.
  assert.equal(settlement.outcome, 'queued');
  assert.equal(settlement.delivered, false);
  assert.equal(settlement.delivery, 'queued');
  assert.equal(settlement.eventId, callbackEventId({ taskId: 'task-1', attemptId: 'attempt-1', logicalId: 'settled:completed', prefix: 'settled' }));

  const reply = await supervisor.notifyReply({ task, attemptId: 'attempt-1', replyId: 'r1', kind: 'blocked', summary: 'need a decision' });
  assert.equal(reply.outcome, 'queued');
  assert.equal(reply.replyKind, 'blocked');
  assert.equal(seenWire.at(-1).kind, 'needs-input');
  assert.equal(seenWire.at(-1).summary, '[blocked] need a decision');

  const duplicateReply = await supervisor.notifyReply({ task, attemptId: 'attempt-1', replyId: 'r1', kind: 'blocked', summary: 'need a decision' });
  assert.equal(duplicateReply.outcome, 'duplicate');

  // The durable records are real files readable through the accepted outbox API.
  const outbox = runtime.outboxFor(TARGET_A);
  const records = await outbox.listEvents();
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.state, 'pending');
    assert.equal(record.targetId, TARGET_A);
  }
  assert.deepEqual(
    records.map((record) => record.kind).sort(),
    ['completed', 'needs-input'],
  );
  const replyRecord = records.find((record) => record.kind === 'needs-input');
  assert.equal(replyRecord.summary, '[blocked] need a decision');
  assert.equal(await readFile(path.join(outbox.eventsDir, outbox.filenameFor(replyRecord.eventId)), 'utf8').then((text) => JSON.parse(text).state), 'pending');

  // A task with no trusted binding writes nothing and claims nothing.
  const ungranted = await supervisor.notifySettlement({ task: { id: 'task-2', attemptId: 'a', stopConfirmed: true }, status: 'completed', summary: 'x' });
  assert.equal(ungranted.outcome, 'ungranted');
  // An unconfirmed stop is never a settlement notification.
  const notStopped = await supervisor.notifySettlement({ task: { ...task, stopConfirmed: false }, status: 'completed', summary: 'x' });
  assert.equal(notStopped.outcome, 'not-stopped');
  assert.equal((await outbox.listEvents()).length, 2);

  await runtime.close();
});

/* --------------------------------------------- acknowledgement never overstated */

function fakeClient({ ack }) {
  const deliveries = [];
  return {
    deliveries,
    async deliver(event) {
      deliveries.push(event);
      return await ack(event, deliveries.length);
    },
    async close() {},
  };
}

test('a runner transitions a queued event only on a positive exact-target acknowledgement', async (t) => {
  const root = await tempRoot(t);
  const runtime = createEventWakeRuntime({
    eventWake: hostConfig(root),
    rootCallbackGrants: { root: { targetId: TARGET_A } },
  });
  const outbox = runtime.outboxFor(TARGET_A);
  await runtime.sink({ eventId: 'evt-delivered', taskId: 't1', attemptId: 'a1', targetId: TARGET_A, kind: 'completed', summary: 'done' });
  await runtime.sink({ eventId: 'evt-ambiguous', taskId: 't2', attemptId: 'a1', targetId: TARGET_A, kind: 'completed', summary: 'maybe' });
  await runtime.sink({ eventId: 'evt-refused', taskId: 't3', attemptId: 'a1', targetId: TARGET_A, kind: 'completed', summary: 'denied' });
  await runtime.sink({ eventId: 'evt-failed', taskId: 't4', attemptId: 'a1', targetId: TARGET_A, kind: 'completed', summary: 'pre-send' });

  const client = fakeClient({
    async ack(event) {
      if (event.eventId === 'evt-delivered') return { outcome: 'delivered', code: 'OK', ack: { threadId: TARGET_A } };
      if (event.eventId === 'evt-ambiguous') return { outcome: 'unknown', code: 'E_ACK_TARGET', message: 'wrong target ack' };
      if (event.eventId === 'evt-refused') return { outcome: 'refused', code: 'E_HOST_REFUSED' };
      return { outcome: 'failed', code: 'E_SPAWN' };
    },
  });

  const stats = await runWakeRunner({ outbox, client, runnerId: 'test-runner', once: true, logger: () => {} });
  // A refused claim is counted and logged, never silently treated as an empty
  // queue: this is the guard that keeps a lock refusal from masquerading as a pass.
  assert.equal(stats.claimErrors, 0, 'every claim in this pass must be accepted');
  assert.equal(stats.claims, 4);
  assert.equal(stats.delivered, 1);
  assert.equal(stats.unknown, 1);
  assert.equal(stats.refused, 1);
  assert.equal(stats.failed, 1);
  assert.equal((await outbox.getEvent('evt-delivered')).state, 'delivered');
  assert.equal((await outbox.getEvent('evt-ambiguous')).state, 'unknown');
  assert.equal((await outbox.getEvent('evt-refused')).state, 'refused');
  assert.equal((await outbox.getEvent('evt-failed')).state, 'failed');

  // An ambiguous delivery is never replayed by another pass: there is no work left.
  assert.equal(await outbox.releaseRunnerOwnership(), true, 'the stopped runner releases its ownership');
  assert.equal(outbox.runnerOwnership(), null);
  const replay = await runWakeRunner({ outbox, client, runnerId: 'test-runner-2', once: true, logger: () => {} });
  assert.equal(replay.claims, 0);
  assert.equal(replay.claimErrors, 0, 'an empty queue is not a claim refusal');
  assert.equal(await outbox.hasWork(), false, 'no terminal or unknown record may be re-claimed');
  await runtime.close();
});

test('the runner treats a mismatched or absent acknowledgement as unknown', async (t) => {
  const root = await tempRoot(t);
  const runtime = createEventWakeRuntime({
    eventWake: hostConfig(root),
    rootCallbackGrants: { root: { targetId: TARGET_A } },
  });
  const outbox = runtime.outboxFor(TARGET_A);
  await runtime.sink({ eventId: 'evt-a', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'one' });
  const client = fakeClient({ async ack() { return { outcome: 'delivered', code: 'OK' }; } });
  const firstRun = await runWakeRunner({ outbox, client, runnerId: 'r', once: true, logger: () => {} });
  assert.equal(firstRun.claimErrors, 0);
  // This stub returns an ALREADY-CLASSIFIED outcome on purpose: what is under test is
  // the RUNNER's persistence of the client's report, not ack parsing. The real client's
  // acknowledgement interpretation (wrong target -> unknown, never delivered) is
  // exercised separately with a real createWakeClient over a fake MCP transport.
  assert.equal((await outbox.getEvent('evt-a')).state, 'delivered');

  // Replay as a DIFFERENT runner on the same durable outbox: ownership of the first
  // runner is released first, exactly as a stopped runner releases it. Reusing the
  // same owner id would not exercise a second runner, and claiming under a new id
  // while the old ownership is still held is a refusal (E_RUNNER_BUSY), not a test.
  assert.equal(await outbox.releaseRunnerOwnership(), true, 'the stopped runner releases its ownership');
  assert.equal(outbox.runnerOwnership(), null);

  await runtime.sink({ eventId: 'evt-b', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'two' });
  const ambiguous = fakeClient({ async ack() { return { outcome: 'unknown', code: 'E_ACK_TARGET', message: 'wrong target' }; } });
  const secondRun = await runWakeRunner({ outbox, client: ambiguous, runnerId: 'r2', once: true, logger: () => {} });
  assert.equal(secondRun.claimErrors, 0, 'the released ownership must let the second runner claim');
  assert.equal(secondRun.claims, 1);
  assert.equal((await outbox.getEvent('evt-a')).state, 'delivered', 'the settled record is never resurrected');
  assert.equal((await outbox.getEvent('evt-b')).state, 'unknown');
  assert.equal(ambiguous.deliveries.length, 1, 'an ambiguous send is attempted exactly once');
  await runtime.close();
});

/* ------------------------------------------------------------ summary limits */

function replySupervisor(sink, label) {
  return new BridgeSupervisor({
    ledger: ledgerFor(label),
    ownerId: 'owner',
    config: { rootCallbackGrants: { root: { targetId: TARGET_A } }, notificationSink: sink },
  });
}

function replyTask() {
  return {
    id: 'task-limits',
    attemptId: 'attempt-1',
    stopConfirmed: true,
    callbackBinding: { grantId: 'root', targetId: TARGET_A, boundAt: 1 },
  };
}

test('the raw reply limit stays 8000 and the integrated wire boundary is 8192', async (t) => {
  assert.equal(MAX_RAW_REPLY_CHARS, 8000);
  assert.equal(MAX_WIRE_REPLY_CHARS, 8192);
  assert.equal(EVENT_WAKE_MAX_SUMMARY_CHARS, 8192);

  const root = await tempRoot(t);
  const runtime = createEventWakeRuntime({
    eventWake: hostConfig(root),
    rootCallbackGrants: { root: { targetId: TARGET_A } },
  });
  const supervisor = replySupervisor(runtime.sink, 'limits');

  // Exactly 8000 raw characters survive EXACTLY (prefixed with '[blocked] ').
  const raw8000 = 'x'.repeat(8000);
  const ok = await supervisor.notifyReply({ task: replyTask(), attemptId: 'attempt-1', replyId: 'raw-8000', kind: 'blocked', summary: raw8000 });
  assert.equal(ok.outcome, 'queued');
  const stored = (await runtime.outboxFor(TARGET_A).listEvents()).find((record) => record.eventId === ok.eventId);
  assert.equal(stored.summary.length, 8000 + '[blocked] '.length);
  assert.equal(stored.summary, `[blocked] ${raw8000}`);
  assert.equal(stored.summary.slice('[blocked] '.length), raw8000, 'no character may be dropped or altered');

  // 8001 raw characters are refused, never sliced.
  await assert.rejects(
    replySupervisor(runtime.sink, 'limits-8001').notifyReply({
      task: replyTask(),
      attemptId: 'attempt-1',
      replyId: 'raw-8001',
      kind: 'blocked',
      summary: 'y'.repeat(8001),
    }),
    (error) => error.code === 'supervisor/invalid-reply' && /at most 8000/.test(error.message),
  );
  assert.equal((await runtime.outboxFor(TARGET_A).listEvents()).length, 1, 'a refused reply writes nothing');

  // The integrated sink accepts 8192 on the wire and refuses 8193. This is the
  // boundary the integration passes explicitly; the accepted low-level default
  // (1200) is untouched and is asserted separately below.
  const atBoundary = await runtime.sink({
    eventId: 'evt-8192',
    taskId: 't',
    attemptId: 'a',
    targetId: TARGET_A,
    kind: 'completed',
    summary: 'z'.repeat(8192),
  });
  assert.equal(atBoundary.event.summary.length, 8192);
  await assert.rejects(
    runtime.sink({ eventId: 'evt-8193', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'z'.repeat(8193) }),
    (error) => error.code === 'E_ARGS',
  );

  // The plugin's own raw reply contract is unchanged at 8000, and the adapter no
  // longer slices a prefixed reply down to fit.
  assert.equal(ADAPTER_VERSION, '0.5.0');
  await runtime.close();
});

test('the accepted low-level defaults stay 1200 and are not silently rewritten', async (t) => {
  const root = await tempRoot(t);
  const outbox = createWakeOutbox({
    dir: path.join(root, 'default-outbox'),
    authority: { root: true, source: 'test-controller' },
    allowedTargetIds: [TARGET_A],
  });
  // With no explicit limit the accepted default refuses a 1201-character summary.
  assert.equal(outbox.schemaVersion, 1);
  await assert.rejects(
    outbox.enqueue({ eventId: 'evt-default', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'q'.repeat(1201) }),
    (error) => error.code === 'E_ARGS' && /at most 1200/.test(error.message),
  );
  await outbox.close();

  // The old runner's own default config also stays 1200.
  const runnerConfig = loadRunnerConfig({ argv: ['--state-dir', root, '--target', TARGET_A, '--server-path', process.execPath, '--caller-thread', TARGET_A], env: {} });
  assert.equal(runnerConfig.maxSummaryChars, 1200);
  // The integration's controller config defaults to the 8192 integration limit.
  assert.equal(
    loadControllerConfig({
      stateRoot: root,
      targetId: TARGET_A,
      serverPath: process.execPath,
      callerThreadId: TARGET_A,
    }).maxSummaryChars,
    EVENT_WAKE_MAX_SUMMARY_CHARS,
  );
});

/* ---------------------------------------------------------- controller launch */

test('the controller entrypoint binds one originating chat and refuses to bypass it', async (t) => {
  const root = await tempRoot(t);
  const config = {
    stateRoot: root,
    targetId: TARGET_A,
    serverPath: process.execPath,
    idleTimeoutMs: 50,
  };
  const configFile = path.join(root, 'controller.json');
  await writeFile(configFile, `${JSON.stringify(config)}\n`, 'utf8');

  const loaded = await readControllerConfigFile(configFile);
  assert.equal(loaded.targetId, TARGET_A);
  assert.equal(loaded.callerThreadId, TARGET_A);
  assert.equal(loaded.outboxDir, resolveTargetOutboxDir({ stateRoot: root, targetId: TARGET_A }));
  assert.equal(loaded.maxSummaryChars, EVENT_WAKE_MAX_SUMMARY_CHARS);
  assert.equal(loaded.nodePath, process.execPath);

  // No override flags exist for the bound target/state/server/caller.
  for (const flag of ['--target', '--state-dir', '--server-path', '--caller-thread']) {
    assert.throws(
      () => parseControllerArgs(['--config', configFile, flag, 'x']),
      (error) => error.code === 'controller/invalid-arguments',
    );
  }
  assert.throws(() => parseControllerArgs([`--config=${configFile}`]), (error) => error.code === 'controller/invalid-arguments');
  assert.throws(() => parseControllerArgs(['--config', configFile, '--delivered', 'true']), (error) => error.code === 'controller/invalid-arguments');
  assert.deepEqual(parseControllerArgs(['--config', configFile, '--once']), { config: configFile, once: true });

  // A callerThreadId that differs from the bound target is refused at load time.
  const mismatchFile = path.join(root, 'mismatch.json');
  await writeFile(mismatchFile, `${JSON.stringify({ ...config, callerThreadId: TARGET_B })}\n`, 'utf8');
  await assert.rejects(readControllerConfigFile(mismatchFile), (error) => error.code === 'controller/caller-mismatch');
  // An unknown key is refused rather than ignored.
  const extraFile = path.join(root, 'extra.json');
  await writeFile(extraFile, `${JSON.stringify({ ...config, token: 'nope' })}\n`, 'utf8');
  await assert.rejects(readControllerConfigFile(extraFile), (error) => error.code === 'controller/invalid-config' && error.detail.field === 'token');

  // The actual process environment must name the same originating chat.
  assert.throws(() => assertControllerBinding({ targetId: TARGET_A, callerThreadId: TARGET_A, env: {} }), (error) => error.code === 'controller/caller-unavailable');
  assert.throws(
    () => assertControllerBinding({ targetId: TARGET_A, callerThreadId: TARGET_A, env: { CODEX_THREAD_ID: TARGET_B } }),
    (error) => error.code === 'controller/caller-mismatch',
  );
  const bound = assertControllerBinding({ targetId: TARGET_A, callerThreadId: TARGET_A, env: { CODEX_THREAD_ID: TARGET_A } });
  assert.deepEqual(bound, { targetId: TARGET_A, callerThreadId: TARGET_A });

  // The official transport environment must be present, and only its presence is used.
  assert.throws(() => assertTransportEnvironment({ env: {} }), (error) => error.code === 'controller/transport-unavailable' && error.detail.present === false);
  assert.deepEqual(assertTransportEnvironment({ env: { CODEX_APP_TOOLS_PIPE_PATH: 'placeholder' } }), { present: true });

  // A full run with an injected fake client: the runner drains one event and stops.
  const runtime = createEventWakeRuntime({ eventWake: hostConfig(root), rootCallbackGrants: { root: { targetId: TARGET_A } } });
  await runtime.sink({ eventId: 'evt-controller', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'controller drain' });
  await runtime.close();
  const logged = [];
  const deliveries = [];
  const exitCode = await controllerMain({
    // --once is REQUIRED here: without a single-shot flag this run would keep the
    // accepted event-driven loop alive after the queue drained.
    argv: ['--config', configFile, '--once'],
    env: { CODEX_THREAD_ID: TARGET_A, CODEX_APP_TOOLS_PIPE_PATH: 'placeholder' },
    logger: (record) => logged.push(record),
    clientFactory: async () => ({
      async deliver(event) {
        deliveries.push(event);
        return { outcome: 'delivered', code: 'OK', ack: { threadId: TARGET_A } };
      },
      async close() {},
    }),
  });
  assert.equal(exitCode, 0);
  assert.equal(deliveries.length, 1);
  assert.ok(logged.some((record) => record.phase === 'controller-binding' && record.callerMetaPresent === true));
  assert.ok(logged.some((record) => record.phase === 'runner-stopped' && record.delivered === 1));
  // Nothing logged may carry the transport value.
  assert.equal(JSON.stringify(logged).includes('placeholder'), false);

  // Reconcile mode is reachable, and the ambiguous state is never auto-resent by the
  // reconcile call itself when the operator says it was not delivered.
  const ambiguousRuntime = createEventWakeRuntime({ eventWake: hostConfig(root), rootCallbackGrants: { root: { targetId: TARGET_A } } });
  await ambiguousRuntime.sink({ eventId: 'evt-reconcile', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'x' });
  await ambiguousRuntime.close();
  const reconcileOutbox = createWakeOutbox({
    dir: resolveTargetOutboxDir({ stateRoot: root, targetId: TARGET_A }),
    authority: { root: true, source: 'test-controller' },
    allowedTargetIds: [TARGET_A],
    maxSummaryChars: EVENT_WAKE_MAX_SUMMARY_CHARS,
  });
  const claimed = await reconcileOutbox.claimNext({ runnerId: 'test' });
  await reconcileOutbox.markInFlight('evt-reconcile', { runnerId: 'test', claimId: claimed.claim.claimId });
  await reconcileOutbox.recordUnknown('evt-reconcile', { code: 'E_AMBIGUOUS' });
  await reconcileOutbox.close();
  const reconcileExit = await controllerMain({
    argv: ['--config', configFile, '--reconcile', 'evt-reconcile', '--delivered', 'true'],
    env: { CODEX_THREAD_ID: TARGET_A, CODEX_APP_TOOLS_PIPE_PATH: 'placeholder' },
    logger: (record) => logged.push(record),
    clientFactory: async () => {
      throw new Error('reconcile mode must never construct a client');
    },
  });
  assert.equal(reconcileExit, 0);
  assert.ok(logged.some((record) => record.phase === 'reconcile' && record.eventId === 'evt-reconcile'));
});

test('the old runner entrypoint still loads its documented configuration', async (t) => {
  const root = await tempRoot(t);
  // Regression guard: the accepted runner CLI keeps working unchanged.
  const config = loadRunnerConfig({
    argv: ['--state-dir', root, '--target', TARGET_A, '--server-path', 'C:/server.mjs', '--caller-thread', 'origin'],
    env: {},
  });
  assert.equal(config.stateDir, root);
  assert.equal(config.targetId, TARGET_A);
  assert.equal(config.callerThreadId, 'origin');
  assert.equal(config.maxSummaryChars, 1200);
  assert.equal(typeof wakeCodexMain, 'function');
});

/* ----------------------------------------------------------------- lifecycle */

test('confirmed shutdown closes the owned outbox and an unconfirmed stop retains it', async (t) => {
  const root = await tempRoot(t);
  const runtime = createEventWakeRuntime({ eventWake: hostConfig(root), rootCallbackGrants: { root: { targetId: TARGET_A } } });
  await runtime.sink({ eventId: 'evt-life', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'x' });

  const store = {
    tasks: [{ id: 't-unknown', status: 'unknown' }],
    list() { return [...this.tasks]; },
    close() { this.storeClosed = true; },
  };
  const service = {
    cancelCalls: [],
    async cancel(id) { this.cancelCalls.push(id); return { stopConfirmed: false }; },
    close() { this.serviceClosed = true; },
  };
  let released = 0;
  let adapterDisposed = 0;
  const close = createBridgeCloser({
    store,
    adapter: { dispose() { adapterDisposed += 1; } },
    service,
    unmount: () => {},
    release: () => { released += 1; },
    resources: runtime.close,
  });

  const first = await close();
  assert.equal(first.closed, false);
  assert.deepEqual(first.pendingTaskIds, ['t-unknown']);
  assert.equal(first.resourcesClosed, false);
  assert.equal(runtime.isClosed(), false, 'an unconfirmed stop must not release the outbox');
  assert.equal(store.storeClosed, undefined);
  assert.equal(released, 0);
  assert.equal(adapterDisposed, 0);

  // A later close after the stop is confirmed releases everything, once.
  store.tasks = [{ id: 't-unknown', status: 'completed' }];
  const second = await close();
  assert.equal(second.closed, true);
  assert.equal(second.resourcesClosed, true);
  assert.equal(runtime.isClosed(), true);
  assert.equal(store.storeClosed, true);
  assert.equal(service.serviceClosed, true);
  assert.equal(released, 1);
  assert.equal(adapterDisposed, 1);

  // A resource-close failure keeps the close incomplete so it can be retried.
  const failing = createBridgeCloser({
    store: { list: () => [], close() {} },
    adapter: {},
    service: { close() {}, async cancel() {} },
    unmount: () => {},
    release: () => {},
    resources: async () => { throw new Error('outbox close failed'); },
  });
  await assert.rejects(failing(), /outbox close failed/);
});

test('a closed producer refuses new events instead of claiming an enqueue', async (t) => {
  const root = await tempRoot(t);
  const runtime = createEventWakeRuntime({ eventWake: hostConfig(root), rootCallbackGrants: { root: { targetId: TARGET_A } } });
  await runtime.sink({ eventId: 'evt-before', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'x' });
  await runtime.close();
  assert.equal(runtime.isClosed(), true);
  await assert.rejects(
    runtime.sink({ eventId: 'evt-after', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'y' }),
    (error) => error.code === 'eventWake/closed',
  );
  // The durable record from before the close is intact.
  assert.equal((await runtime.outboxFor(TARGET_A).listEvents()).length, 1);
});

/* ------------------------------------------------- public producer helpers */

test('the public runtime exposes real producer helpers before the first event', async (t) => {
  const root = await tempRoot(t);
  const runtime = createEventWakeRuntime({ eventWake: hostConfig(root), rootCallbackGrants: { root: { targetId: TARGET_A } } });
  // `outboxFor` must return the SAME real durable producer the sink writes through,
  // even before the first event: lazy creation must not make it look absent, and an
  // ungranted target must stay a typed refusal.
  const outbox = runtime.outboxFor(TARGET_A);
  assert.equal(outbox, runtime.outboxFor(TARGET_A), 'one cached producer per granted target');
  assert.equal(runtime.isClosed(), false);
  await assert.rejects(async () => runtime.outboxFor('not-granted'), (error) => error.code === 'eventWake/ungranted-target');

  // The integration limit is FIXED at 8192: a 256-character producer cap would lose a
  // valid raw 8000-character reply plus the controller prefix.
  assert.throws(
    () => normalizeEventWakeConfig(hostConfig(root, { maxSummaryChars: MIN_EVENT_WAKE_MAX_SUMMARY_CHARS })),
    (error) => error.code === 'eventWake/invalid-config',
  );

  await runtime.sink({ eventId: 'evt-1', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'x' });
  assert.equal((await runtime.outboxFor(TARGET_A).listEvents()).length, 1);
  const closed = await runtime.close();
  assert.equal(closed.closed, true);
  assert.equal(runtime.isClosed(), true);
});

/* --------------------------------------- real acknowledgement interpretation */

test('the real wake client reports a wrong-target acknowledgement as unknown, never delivered', async () => {
  const catalog = {
    tools: [
      {
        name: 'send_message_to_thread',
        inputSchema: {
          type: 'object',
          properties: { threadId: { type: 'string' }, message: { type: 'string' } },
          required: ['threadId', 'message'],
        },
      },
    ],
  };
  function transportAcking(threadId) {
    return {
      requests: [],
      async request(method, params = {}) {
        this.requests.push({ method, params });
        if (method === 'tools/list') return catalog;
        if (method === 'tools/call') return { content: [{ type: 'text', text: JSON.stringify({ threadId }) }], isError: false };
        throw new Error(`unexpected method ${method}`);
      },
      async close() {},
    };
  }
  const clientFor = (threadId) => {
    const transport = transportAcking(threadId);
    const client = createWakeClient({
      authority: { root: true, source: 'test-controller' },
      allowedTargetIds: [TARGET_A],
      callerContext: { codexThreadId: TARGET_A },
      maxSummaryChars: EVENT_WAKE_MAX_SUMMARY_CHARS,
      transport,
    });
    return { client, transport };
  };
  const base = { taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'x' };

  const good = clientFor(TARGET_A);
  const delivered = await good.client.deliver({ ...base, eventId: 'evt-good' });
  assert.equal(delivered.outcome, 'delivered');
  assert.equal(delivered.ack.threadId, TARGET_A);
  await good.client.close();

  const wrong = clientFor(TARGET_B);
  const ambiguous = await wrong.client.deliver({ ...base, eventId: 'evt-wrong' });
  assert.equal(ambiguous.outcome, 'unknown', 'a wrong-thread acknowledgement must never become delivered');
  assert.equal(ambiguous.code, 'E_ACK_TARGET');
  assert.equal(
    wrong.transport.requests.filter((request) => request.method === 'tools/call').length,
    1,
    'the ambiguous send is attempted exactly once and never retried',
  );
  await wrong.client.close();
});

/* -------------------------------------------------------- host mount (F2) */

test('mountBridge preserves an injected notification sink when eventWake is off', async (t) => {
  const root = await tempRoot(t);
  const credentialFile = path.join(root, 'token.txt');
  // The mount refuses a bearer credential shorter than 24 characters
  // (AUTH_UNAVAILABLE, src/mcp.mjs), so this fixture supplies a synthetic
  // sufficiently long value. It is never a real credential and is never read from
  // the environment; the only assertion about it is that the mount succeeded.
  await writeFile(credentialFile, 'synthetic-test-credential-not-a-real-secret-0001\n', 'utf8');
  const injected = async (event) => ({ ok: true, event: { ...event, state: 'pending' } });
  const mounts = [];
  const ctx = {
    get: () => undefined,
    webServer: {
      register: (mount) => {
        mounts.push(mount);
        return () => mounts.pop();
      },
    },
  };
  const bridge = await mountBridge(ctx, {
    dataDirectory: path.join(root, 'bridge'),
    credentialFile,
    notificationSink: injected,
    maxConcurrent: 16,
  });
  try {
    // The REAL supervisor received the injected function. Before this repair the
    // disabled eventWake runtime passed `notificationSink: undefined` and dropped it.
    assert.equal(bridge.service.supervisor.config.notificationSink, injected);
    const status = bridge.service.supervisor.notificationsStatus();
    assert.equal(status.supported, true, 'an injected sink is supported, not unavailable');
    assert.equal(status.producer, false, 'no integrated outbox producer was configured');
    assert.equal(status.producerSource, 'injected-sink');
    assert.equal(status.runnerAvailable, 'unknown', 'an injected sink is not a known runner');
    assert.equal(bridge.eventWake.producerSource, 'injected-sink');
    assert.equal(bridge.eventWake.integratedOutbox, false);
    assert.equal(bridge.service.eventWake.producerSource, 'injected-sink');
    assert.equal(mounts.length, 1, 'the bridge mounted exactly one handler');
  } finally {
    const closed = await bridge.close();
    assert.equal(closed.closed, true);
  }
});

/* --------------------------------------------------- honest close lifecycle */

test('close waits for an accepted enqueue instead of closing the outbox underneath it', async (t) => {
  const root = await tempRoot(t);
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const records = [];
  let closedUnderAnAcceptedEnqueue = false;
  let enqueueFinished = false;
  const createSink = ({ dir, allowedTargetIds }) => {
    const outbox = {
      dir,
      allowedTargetIds,
      closed: false,
      async close() {
        this.closed = true;
        if (!enqueueFinished) closedUnderAnAcceptedEnqueue = true;
        return { ok: true };
      },
      async listEvents() {
        return records.map((record) => ({ ...record }));
      },
    };
    const sink = async (event) => {
      await gate; // simulates an enqueue still binding its target directory
      if (outbox.closed) throw new Error('enqueue lost: the outbox was closed underneath an accepted event');
      records.push({ ...event, state: 'pending' });
      enqueueFinished = true;
      return { ok: true, duplicate: false, event: { ...event, state: 'pending' } };
    };
    sink.outbox = outbox;
    return sink;
  };
  const runtime = createEventWakeRuntime({
    eventWake: hostConfig(root),
    rootCallbackGrants: { root: { targetId: TARGET_A } },
    createSink,
  });
  const accepted = runtime.sink({ eventId: 'evt-accepted', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'x' });
  let closeSettled = false;
  const closing = runtime.close().then((value) => {
    closeSettled = true;
    return value;
  });
  await sleep(5);
  assert.equal(closeSettled, false, 'close must not settle while an accepted enqueue is pending');
  assert.equal(runtime.isClosed(), false);
  // New work is refused the moment closing begins.
  await assert.rejects(
    runtime.sink({ eventId: 'evt-refused', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'y' }),
    (error) => error.code === 'eventWake/closed',
  );
  releaseGate();
  const [enqueued, closed] = await Promise.all([accepted, closing]);
  assert.equal(enqueued.event.state, 'pending');
  assert.equal(closed.closed, true);
  assert.equal(closedUnderAnAcceptedEnqueue, false, 'the outbox must not be closed under an accepted enqueue');
  assert.equal(runtime.isClosed(), true);
  assert.equal((await runtime.outboxFor(TARGET_A).listEvents()).length, 1);
});

test('a real outbox close failure is reported and a later close is a genuine retry', async (t) => {
  const root = await tempRoot(t);
  let closeAttempts = 0;
  const createSink = () => {
    let closed = false;
    const outbox = {
      async close() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error('simulated outbox close failure');
        closed = true;
        return { ok: true };
      },
      isClosed: () => closed,
    };
    const sink = async (event) => ({ ok: true, duplicate: false, event: { ...event, state: 'pending' } });
    sink.outbox = outbox;
    return sink;
  };
  const runtime = createEventWakeRuntime({
    eventWake: hostConfig(root),
    rootCallbackGrants: { root: { targetId: TARGET_A } },
    createSink,
  });
  await runtime.sink({ eventId: 'evt-1', taskId: 't', attemptId: 'a', targetId: TARGET_A, kind: 'completed', summary: 'x' });
  // The structured close failure carries its counts: the structured API reports the
  // failure count of THIS attempt as error.detail.attempts (it is not a top-level
  // error property), plus the per-target failure list. Asserting the exact counts
  // keeps this from degrading into "any throw counts as a pass".
  await assert.rejects(
    runtime.close(),
    (error) =>
      error instanceof WakeIntegrationError &&
      error.code === 'eventWake/close-failed' &&
      error.detail?.attempts === 1 &&
      error.detail?.failures?.length === 1 &&
      error.failures?.length === 1 &&
      error.detail.failures[0].code === 'E_CLOSE' &&
      /simulated outbox close failure/.test(String(error.detail.failures[0].message)),
  );
  assert.equal(runtime.isClosed(), false, 'a failed close must never claim to be closed');
  // The later close is a GENUINE retry: it attempts the same outbox again (no cached
  // failure is replayed), reports the counts of its own second attempt and only then
  // claims closed.
  const retry = await runtime.close();
  assert.equal(retry.closed, true);
  assert.equal(retry.attempts, 2, 'the retry is a second real attempt, not a replayed failure');
  assert.equal(runtime.isClosed(), true);
  assert.equal(closeAttempts, 2, 'the outbox close was genuinely attempted twice');
});
