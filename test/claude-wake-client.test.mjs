// test/claude-wake-client.test.mjs
//
// Focused regressions for the Claude Code delivery path:
//   * src/claude-wake-client.mjs — the transport-free client that hands the
//     accepted wake message to a trusted controller session and never claims a
//     delivery;
//   * bin/wake-claude.mjs — the trusted-controller entrypoint that reuses the
//     accepted durable outbox and runner loop with exactly the documented modes.
//
// Only Node built-ins are used. Every temp directory lives under os.tmpdir() and
// is removed in a finally block.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_WAKE_ACK_CODE, createClaudeWakeClient } from '../src/claude-wake-client.mjs';
import {
  EVENT_WAKE_CLAIM_LEASE_MS,
  EVENT_WAKE_MAX_SUMMARY_CHARS,
  WakeIntegrationError,
  resolveTargetOutboxDir,
} from '../src/wake-integration.mjs';
import { createWakeOutbox } from '../src/wake-outbox.mjs';
import {
  CLAUDE_CONTROLLER_USAGE,
  loadClaudeControllerConfig,
  main,
  parseClaudeControllerArgs,
} from '../bin/wake-claude.mjs';

const TARGET = 'claude-code:main';
const AUTHORITY = Object.freeze({ root: true, source: 'test-controller' });

function event(overrides = {}) {
  return {
    eventId: 'evt-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    targetId: TARGET,
    kind: 'completed',
    summary: 'task finished',
    resultIds: ['result-1'],
    ...overrides,
  };
}

function capture() {
  const chunks = [];
  return {
    stream: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

async function tempDir(label) {
  return await mkdtemp(path.join(tmpdir(), label));
}

function openOutbox(dir) {
  return createWakeOutbox({
    dir,
    authority: AUTHORITY,
    allowedTargetIds: [TARGET],
    maxSummaryChars: EVENT_WAKE_MAX_SUMMARY_CHARS,
  });
}

async function writeConfig(root, extra = {}) {
  const configPath = path.join(root, 'controller.json');
  await writeFile(configPath, `${JSON.stringify({ stateRoot: root, targetId: TARGET, ...extra })}\n`, 'utf8');
  return configPath;
}

/* ------------------------------------------------------------------- client */

test('(a) deliver hands the event to the controller session and reports an unknown outcome', async () => {
  const emitted = [];
  const client = createClaudeWakeClient({
    authority: AUTHORITY,
    allowedTargetIds: [TARGET],
    maxSummaryChars: EVENT_WAKE_MAX_SUMMARY_CHARS,
    emit: (text) => {
      emitted.push(text);
    },
  });

  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(client.allowedTargetIds, [TARGET]);

  const built = client.buildMessage(event());
  assert.ok(built.includes('evt-1'));
  assert.ok(built.includes('task finished'));

  const result = await client.deliver(event());
  assert.equal(result.outcome, 'unknown');
  assert.notEqual(result.outcome, 'delivered');
  assert.equal(result.code, CLAUDE_WAKE_ACK_CODE);
  assert.equal(result.hostError, null);
  assert.match(result.message, /explicit controller acknowledgement/);

  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].includes('evt-1'), 'the wire header names the event id');
  assert.ok(emitted[0].includes('UNTRUSTED RESULT DATA'), 'the untrusted-data boundary wording is present');
  assert.ok(emitted[0].includes('task finished'), 'the summary is present');

  assert.deepEqual(await client.close(), { ok: true });
});

test('(b) an unauthorized target is refused and nothing is emitted', async () => {
  const emitted = [];
  const client = createClaudeWakeClient({
    authority: AUTHORITY,
    allowedTargetIds: [TARGET],
    maxSummaryChars: EVENT_WAKE_MAX_SUMMARY_CHARS,
    emit: (text) => {
      emitted.push(text);
    },
  });

  const refused = await client.deliver(event({ targetId: 'claude-code:other' }));
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, 'E_TARGET');
  assert.equal(refused.hostError, null);
  assert.equal(emitted.length, 0, 'a refused event must never be emitted');

  const malformed = await client.deliver({ ...event({ eventId: 'evt-2' }), summary: 42 });
  assert.equal(malformed.outcome, 'refused');
  assert.equal(malformed.code, 'E_ARGS');
  assert.equal(emitted.length, 0);

  await client.close();
});

test('(c) an emit failure is failed/E_EMIT and is never reported as delivered', async () => {
  const syncClient = createClaudeWakeClient({
    authority: AUTHORITY,
    allowedTargetIds: [TARGET],
    maxSummaryChars: EVENT_WAKE_MAX_SUMMARY_CHARS,
    emit: () => {
      throw new Error('stdout closed');
    },
  });
  const syncResult = await syncClient.deliver(event());
  assert.equal(syncResult.outcome, 'failed');
  assert.equal(syncResult.code, 'E_EMIT');
  assert.ok(syncResult.message.includes('stdout closed'));
  assert.equal(syncResult.hostError, null);
  assert.notEqual(syncResult.outcome, 'delivered');

  const asyncClient = createClaudeWakeClient({
    authority: AUTHORITY,
    allowedTargetIds: [TARGET],
    maxSummaryChars: EVENT_WAKE_MAX_SUMMARY_CHARS,
    emit: async () => {
      throw new Error('async emit failed');
    },
  });
  const asyncResult = await asyncClient.deliver(event());
  assert.equal(asyncResult.outcome, 'failed');
  assert.equal(asyncResult.code, 'E_EMIT');
  assert.ok(asyncResult.message.includes('async emit failed'));
});

test('(d) construction requires a root authority and an emit function', () => {
  assert.throws(
    () => createClaudeWakeClient({ authority: AUTHORITY, allowedTargetIds: [TARGET] }),
    (error) => error.code === 'E_ARGS',
  );
  assert.throws(
    () => createClaudeWakeClient({ authority: AUTHORITY, allowedTargetIds: [TARGET], emit: 'not-a-function' }),
    (error) => error.code === 'E_ARGS',
  );
  assert.throws(
    () => createClaudeWakeClient({ authority: { root: false, source: 'worker' }, allowedTargetIds: [TARGET], emit: () => {} }),
    (error) => error.code === 'E_AUTHORITY',
  );
  assert.throws(
    () => createClaudeWakeClient({ authority: AUTHORITY, allowedTargetIds: [], emit: () => {} }),
    (error) => error.code === 'E_ARGS',
  );
});

/* ----------------------------------------------------------- controller cfg */

test('(e) the controller config accepts only the documented keys and agrees on the outbox dir', async () => {
  const root = await tempDir('claude-wake-config-');
  try {
    assert.throws(
      () => loadClaudeControllerConfig({ stateRoot: root, targetId: TARGET, token: 'nope' }),
      (error) => error instanceof WakeIntegrationError && error.code === 'controller/invalid-config' && error.detail?.field === 'token',
    );
    assert.throws(
      () => loadClaudeControllerConfig({ stateRoot: 'relative/wake', targetId: TARGET }),
      (error) => error.code === 'controller/invalid-config' && error.detail?.field === 'stateRoot',
    );
    assert.throws(
      () => loadClaudeControllerConfig({ stateRoot: root, targetId: TARGET, maxSummaryChars: 8191 }),
      (error) => error.code === 'controller/invalid-config' && error.detail?.field === 'maxSummaryChars',
    );
    assert.throws(() => loadClaudeControllerConfig(null), (error) => error.code === 'controller/invalid-config');
    assert.throws(() => loadClaudeControllerConfig([]), (error) => error.code === 'controller/invalid-config');
    assert.throws(
      () => loadClaudeControllerConfig({ stateRoot: root, targetId: '   ' }),
      (error) => error.code === 'controller/invalid-config',
    );
    assert.throws(
      () => loadClaudeControllerConfig({ stateRoot: root, targetId: 'bad\nid' }),
      (error) => error.code === 'controller/invalid-config',
    );
    assert.throws(
      () => loadClaudeControllerConfig({ stateRoot: root, targetId: 'x'.repeat(201) }),
      (error) => error.code === 'controller/invalid-config',
    );
    assert.throws(
      () => loadClaudeControllerConfig({ stateRoot: root, targetId: TARGET, claimLeaseMs: 0 }),
      (error) => error.code === 'controller/invalid-config' && error.detail?.field === 'claimLeaseMs',
    );
    assert.throws(
      () => loadClaudeControllerConfig({ stateRoot: root, targetId: TARGET, requireSessionBinding: 'yes' }),
      (error) => error.code === 'controller/invalid-config' && error.detail?.field === 'requireSessionBinding',
    );

    const loaded = loadClaudeControllerConfig({ stateRoot: root, targetId: TARGET });
    assert.equal(loaded.stateRoot, path.resolve(root));
    assert.equal(loaded.targetId, TARGET);
    assert.equal(loaded.claimLeaseMs, EVENT_WAKE_CLAIM_LEASE_MS);
    assert.equal(loaded.maxSummaryChars, EVENT_WAKE_MAX_SUMMARY_CHARS);
    assert.equal(loaded.requireSessionBinding, false);
    assert.equal(loaded.outboxDir, resolveTargetOutboxDir({ stateRoot: root, targetId: TARGET }));

    const explicit = loadClaudeControllerConfig({
      stateRoot: root,
      targetId: TARGET,
      claimLeaseMs: 5000,
      maxSummaryChars: EVENT_WAKE_MAX_SUMMARY_CHARS,
      requireSessionBinding: true,
    });
    assert.equal(explicit.claimLeaseMs, 5000);
    assert.equal(explicit.requireSessionBinding, true);
    assert.equal(explicit.outboxDir, resolveTargetOutboxDir({ stateRoot: root, targetId: TARGET }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mode parsing requires exactly one mode flag and refuses anything else', () => {
  assert.equal(typeof CLAUDE_CONTROLLER_USAGE, 'string');
  assert.match(CLAUDE_CONTROLLER_USAGE, /--wait/);

  for (const argv of [
    [],
    ['--wait'],
    ['--config', 'C:/c.json'],
    ['--config', 'C:/c.json', '--wait', '--follow'],
    ['--config', 'C:/c.json', '--ack', 'e1', '--status'],
    ['--config', 'C:/c.json', '--status', '--timeout-ms', '10'],
    ['--config', 'C:/c.json', '--ack', 'e1', '--requeue'],
    ['--config', 'C:/c.json', '--nope'],
    ['--config', 'C:/c.json', '--wait', '--timeout-ms', '0'],
    ['--config', 'C:/c.json', 'positional'],
    ['--config=C:/c.json'],
  ]) {
    assert.throws(
      () => parseClaudeControllerArgs(argv),
      (error) => error.code === 'controller/invalid-arguments',
      `expected a refusal for ${JSON.stringify(argv)}`,
    );
  }

  const waiting = parseClaudeControllerArgs(['--config', 'C:/c.json', '--wait']);
  assert.equal(waiting.mode, 'wait');
  assert.equal(waiting.timeoutMs, 3_600_000);
  const timed = parseClaudeControllerArgs(['--config', 'C:/c.json', '--wait', '--timeout-ms', '250']);
  assert.equal(timed.timeoutMs, 250);
  const nack = parseClaudeControllerArgs(['--config', 'C:/c.json', '--nack', 'evt-1', '--requeue']);
  assert.equal(nack.mode, 'nack');
  assert.equal(nack.eventId, 'evt-1');
  assert.equal(nack.requeue, true);
  const ack = parseClaudeControllerArgs(['--config', 'C:/c.json', '--ack', 'evt-1']);
  assert.equal(ack.mode, 'ack');
  assert.equal(ack.eventId, 'evt-1');
  assert.equal(ack.requeue, false);
  const status = parseClaudeControllerArgs(['--config', 'C:/c.json', '--status']);
  assert.equal(status.mode, 'status');
  assert.equal(status.eventId, null);
});

/* ------------------------------------------------------------- end to end */

test('(f) the controller wait mode drains, acknowledges and then times out', async () => {
  const root = await tempDir('claude-wake-e2e-');
  const outboxDir = resolveTargetOutboxDir({ stateRoot: root, targetId: TARGET });
  let reader = null;
  try {
    const configPath = await writeConfig(root);
    const setup = openOutbox(outboxDir);
    await setup.enqueue(event());
    await setup.close();

    // 1) One wait pass hands the event over and prints the acknowledgement hint.
    const first = capture();
    const firstDiagnostics = capture();
    const waitCode = await main({
      argv: ['--config', configPath, '--wait', '--timeout-ms', '5000'],
      env: {},
      stdout: first.stream,
      stderr: firstDiagnostics.stream,
    });
    assert.equal(waitCode, 0);
    const firstText = first.text();
    assert.ok(firstText.includes('evt-1'), firstText);
    assert.ok(firstText.includes('[dsh-bridge-ack] eventId=evt-1'), firstText);
    assert.ok(firstText.includes('task finished'), firstText);
    assert.equal(firstText.includes('"phase"'), false, 'diagnostics must never be written to stdout');
    assert.ok(firstDiagnostics.text().includes('"phase":"runner-stopped"'), firstDiagnostics.text());

    // 2) The explicit acknowledgement is what turns the ambiguous hand-off into a
    //    delivered record.
    const ack = capture();
    const ackCode = await main({
      argv: ['--config', configPath, '--ack', 'evt-1'],
      env: {},
      stdout: ack.stream,
      stderr: capture().stream,
    });
    assert.equal(ackCode, 0);
    assert.deepEqual(JSON.parse(ack.text().trim()), { phase: 'ack', eventId: 'evt-1', state: 'delivered' });

    reader = openOutbox(outboxDir);
    assert.equal((await reader.getEvent('evt-1')).state, 'delivered');
    await reader.close();
    reader = null;

    // 3) A second wait finds no work and reports the documented timeout code.
    const second = capture();
    const secondCode = await main({
      argv: ['--config', configPath, '--wait', '--timeout-ms', '300'],
      env: {},
      stdout: second.stream,
      stderr: capture().stream,
    });
    assert.equal(secondCode, 3);
    assert.equal(second.text(), '');
  } finally {
    if (reader !== null) await reader.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('(g) requireSessionBinding refuses a mismatch or a missing session id without stdout', async () => {
  const root = await tempDir('claude-wake-bind-');
  try {
    const configPath = await writeConfig(root, { requireSessionBinding: true });

    const mismatched = capture();
    const mismatchedErr = capture();
    const mismatchCode = await main({
      argv: ['--config', configPath, '--wait', '--timeout-ms', '200'],
      env: { CLAUDE_CODE_SESSION_ID: 'a-different-session' },
      stdout: mismatched.stream,
      stderr: mismatchedErr.stream,
    });
    assert.equal(mismatchCode, 1);
    assert.equal(mismatched.text(), '', 'a refused binding must emit nothing to stdout');
    assert.ok(mismatchedErr.text().includes('controller/caller-mismatch'), mismatchedErr.text());
    assert.equal(mismatchedErr.text().includes('a-different-session'), false, 'the env value is never printed');

    const missing = capture();
    const missingErr = capture();
    const missingCode = await main({
      argv: ['--config', configPath, '--status'],
      env: {},
      stdout: missing.stream,
      stderr: missingErr.stream,
    });
    assert.equal(missingCode, 1);
    assert.equal(missing.text(), '');
    assert.ok(missingErr.text().includes('controller/caller-unavailable'), missingErr.text());

    // A matching binding passes the gate and reaches the requested mode.
    const matched = capture();
    const matchedCode = await main({
      argv: ['--config', configPath, '--status'],
      env: { CLAUDE_CODE_SESSION_ID: TARGET },
      stdout: matched.stream,
      stderr: capture().stream,
    });
    assert.equal(matchedCode, 0);
    assert.equal(JSON.parse(matched.text().trim()).phase, 'status');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the status and nack modes report the durable counts and settle the record', async () => {
  const root = await tempDir('claude-wake-modes-');
  const outboxDir = resolveTargetOutboxDir({ stateRoot: root, targetId: TARGET });
  let setup = null;
  try {
    const configPath = await writeConfig(root);
    setup = openOutbox(outboxDir);
    await setup.enqueue(event());
    const claim = await setup.claimNext({ runnerId: 'setup' });
    await setup.markInFlight(claim.eventId, { runnerId: 'setup', claimId: claim.claim.claimId });
    await setup.recordUnknown('evt-1', { code: 'E_AMBIGUOUS' });
    await setup.close();
    setup = null;

    const status = capture();
    const statusCode = await main({
      argv: ['--config', configPath, '--status'],
      env: {},
      stdout: status.stream,
      stderr: capture().stream,
    });
    assert.equal(statusCode, 0);
    const counts = JSON.parse(status.text().trim());
    assert.equal(counts.phase, 'status');
    assert.equal(counts.unknown, 1);
    assert.equal(counts.pending, 0);

    const nack = capture();
    const nackCode = await main({
      argv: ['--config', configPath, '--nack', 'evt-1'],
      env: {},
      stdout: nack.stream,
      stderr: capture().stream,
    });
    assert.equal(nackCode, 0);
    assert.deepEqual(JSON.parse(nack.text().trim()), { phase: 'nack', eventId: 'evt-1', state: 'failed' });
  } finally {
    if (setup !== null) await setup.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
