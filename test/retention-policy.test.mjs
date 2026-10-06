import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRetention } from '../src/retention-policy.mjs';

const DAY = 86_400_000;
const NOW = 40 * DAY;
const POLICY = Object.freeze({ ownerId: 'owner-a', successDays: 7, failureDays: 30 });
const TASK = Object.freeze({
  ownerId: 'owner-a',
  origin: 'codex-bridge',
  id: 'task-1',
  status: 'completed',
  endedAt: DAY,
  resultCollected: true,
  pinned: false,
  stopConfirmed: true,
  activeJobs: 0,
  artifactState: 'none',
});

function expected(reasons, eligibleAt) {
  return { eligible: reasons.length === 0, reasons, eligibleAt };
}

function check(task, policy, now, reasons, eligibleAt, label) {
  assert.deepEqual(evaluateRetention(task, policy, now), expected(reasons, eligibleAt), label);
}

function without(object, field) {
  const copy = { ...object };
  delete copy[field];
  return copy;
}

test('each terminal status uses its own window with inclusive expiry', () => {
  for (const [status, days] of [['completed', 7], ['failed', 30], ['cancelled', 30]]) {
    const task = { ...TASK, status };
    const expiry = task.endedAt + days * DAY;
    check(task, POLICY, expiry - 1, ['retention_pending'], expiry, status);
    check(task, POLICY, expiry, [], expiry, status);
    check(task, POLICY, expiry + 1, [], expiry, status);
  }
});

test('zero durations, epoch timestamps, and fractional days are supported', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    check({ ...TASK, status, endedAt: 0 }, { ...POLICY, successDays: 0, failureDays: 0 }, 0, [], 0);
  }
  const policy = { ...POLICY, successDays: 0.5, failureDays: 1.5 };
  for (const [status, days] of [['completed', 0.5], ['failed', 1.5], ['cancelled', 1.5]]) {
    const task = { ...TASK, status, endedAt: 0 };
    check(task, policy, days * DAY - 1, ['retention_pending'], days * DAY);
    check(task, policy, days * DAY, [], days * DAY);
  }
});

test('ownership and identity require exact primitive strings', () => {
  for (const ownerId of [undefined, null, '', ' \t\n', 0, true, new String('owner-a'), 'owner-b', ' owner-a']) {
    check({ ...TASK, ownerId }, POLICY, NOW, ['foreign_owner'], 8 * DAY);
  }
  for (const ownerId of [undefined, null, '', ' \t\n', 0, true, new String('owner-a')]) {
    check({ ...TASK, ownerId }, { ...POLICY, ownerId }, NOW, ['invalid_policy', 'foreign_owner'], null);
  }
  check(TASK, without(POLICY, 'ownerId'), NOW, ['invalid_policy', 'foreign_owner'], null);
  for (const id of [undefined, null, '', ' \t\n', 0, {}, new String('task-1')]) {
    check({ ...TASK, id }, POLICY, NOW, ['invalid_identity'], 8 * DAY);
  }
  for (const origin of [undefined, null, '', 'Codex-bridge', 'codex-bridge ', new String('codex-bridge')]) {
    check({ ...TASK, origin }, POLICY, NOW, ['invalid_identity'], 8 * DAY);
  }
  check({ ...TASK, ownerId: ' owner-a ', id: ' task-1 ' }, { ...POLICY, ownerId: ' owner-a ' }, NOW, [], 8 * DAY);
});

test('unknown and in-flight statuses block and suppress eligibleAt', () => {
  for (const status of [undefined, null, '', 'running', 'queued', 'stopping', 'Completed', 'completed ', 0, {}, new String('completed')]) {
    check({ ...TASK, status }, POLICY, NOW, ['nonterminal'], null);
  }
});

test('malformed times fail closed without coercion', () => {
  for (const now of [undefined, null, NaN, Infinity, -Infinity, -1, 1.5, '100', true, {}, 1n, Symbol('now')]) {
    check(TASK, POLICY, now, ['invalid_time'], null);
    check({ ...TASK, endedAt: -1 }, POLICY, now, ['invalid_time', 'invalid_end'], null);
  }
  for (const endedAt of [undefined, null, NaN, Infinity, -Infinity, -1, 1.5, '0', false, {}, 0n, Symbol('end')]) {
    check({ ...TASK, endedAt }, POLICY, NOW, ['invalid_end'], null);
  }
  check({ ...TASK, endedAt: NOW + 1 }, POLICY, NOW, ['invalid_end'], null);
  check({ ...TASK, endedAt: NOW + 1 }, POLICY, NaN, ['invalid_time'], null);
  check({ ...TASK, endedAt: NOW }, POLICY, NOW, ['retention_pending'], NOW + 7 * DAY);
});

test('both policy durations are validated even when unused', () => {
  const invalid = [undefined, null, NaN, Infinity, -Infinity, -1, '7', true, {}, 7n, Symbol('days'), Number.MAX_VALUE, Number.MAX_SAFE_INTEGER];
  for (const status of ['completed', 'failed', 'cancelled']) {
    for (const field of ['successDays', 'failureDays']) {
      for (const value of invalid) {
        check({ ...TASK, status }, { ...POLICY, [field]: value }, NOW, ['invalid_policy'], null, `${status}: ${field}`);
      }
      check({ ...TASK, status }, without(POLICY, field), NOW, ['invalid_policy'], null);
    }
  }
});

test('expiry arithmetic must produce a safe integer', () => {
  const end = Number.MAX_SAFE_INTEGER - DAY;
  check({ ...TASK, endedAt: end }, { ...POLICY, successDays: 1 }, Number.MAX_SAFE_INTEGER, [], Number.MAX_SAFE_INTEGER);
  check({ ...TASK, endedAt: end + 1 }, { ...POLICY, successDays: 1 }, Number.MAX_SAFE_INTEGER, ['invalid_policy'], null);
  check({ ...TASK, endedAt: Number.MAX_SAFE_INTEGER }, { ...POLICY, successDays: 0 }, Number.MAX_SAFE_INTEGER, [], Number.MAX_SAFE_INTEGER);
});

test('collection and stop confirmation must be exactly true', () => {
  for (const [field, reason] of [['resultCollected', 'uncollected'], ['stopConfirmed', 'stop_unconfirmed']]) {
    for (const value of [undefined, null, false, 0, 1, 'true', {}, new Boolean(true)]) {
      check({ ...TASK, [field]: value }, POLICY, NOW, [reason], 8 * DAY);
    }
    check(without(TASK, field), POLICY, NOW, [reason], 8 * DAY);
  }
});

test('pinned accepts false or absence and blocks all other supplied values', () => {
  check(without(TASK, 'pinned'), POLICY, NOW, [], 8 * DAY);
  check(TASK, POLICY, NOW, [], 8 * DAY);
  for (const pinned of [true, undefined, null, 0, 1, '', 'false', {}, new Boolean(false), Symbol('pin')]) {
    check({ ...TASK, pinned }, POLICY, NOW, ['pinned'], 8 * DAY);
  }
});

test('active jobs requires numeric zero without coercion', () => {
  for (const activeJobs of [undefined, null, false, true, '0', 0n, 1, -1, 0.5, NaN, Infinity, {}, [], new Number(0)]) {
    check({ ...TASK, activeJobs }, POLICY, NOW, ['active_jobs'], 8 * DAY);
  }
  check(without(TASK, 'activeJobs'), POLICY, NOW, ['active_jobs'], 8 * DAY);
  check({ ...TASK, activeJobs: -0 }, POLICY, NOW, [], 8 * DAY);
});

test('artifacts require one of the four explicit resolved states', () => {
  for (const artifactState of ['none', 'merged', 'preserved', 'discarded']) {
    check({ ...TASK, artifactState }, POLICY, NOW, [], 8 * DAY);
  }
  for (const artifactState of [undefined, null, '', 'pending', 'unknown', 'None', 'none ', false, 0, {}, new String('none')]) {
    check({ ...TASK, artifactState }, POLICY, NOW, ['artifacts_unresolved'], 8 * DAY);
  }
  check(without(TASK, 'artifactState'), POLICY, NOW, ['artifacts_unresolved'], 8 * DAY);
});

test('all applicable blockers are returned once in the prescribed order', () => {
  check({
    ownerId: 'other', origin: 'other', id: ' ', status: 'running',
    endedAt: -1, resultCollected: false, pinned: true,
    stopConfirmed: false, activeJobs: 2, artifactState: 'pending',
  }, { ownerId: '', successDays: -1, failureDays: NaN }, NaN, [
    'invalid_policy', 'invalid_time', 'foreign_owner', 'invalid_identity',
    'nonterminal', 'invalid_end', 'uncollected', 'pinned',
    'stop_unconfirmed', 'active_jobs', 'artifacts_unresolved',
  ], null);

  check({
    ...TASK, ownerId: 'other', origin: 'other', id: '', endedAt: NOW,
    resultCollected: false, pinned: true, stopConfirmed: false,
    activeJobs: 1, artifactState: 'pending',
  }, POLICY, NOW, [
    'foreign_owner', 'invalid_identity', 'uncollected', 'pinned',
    'stop_unconfirmed', 'active_jobs', 'artifacts_unresolved', 'retention_pending',
  ], NOW + 7 * DAY);
});

test('nonobjects are evaluated as empty objects', () => {
  const values = [undefined, null, false, 1, 'task', 0n, Symbol('object'), () => {}];
  const taskReasons = [
    'foreign_owner', 'invalid_identity', 'nonterminal', 'invalid_end',
    'uncollected', 'stop_unconfirmed', 'active_jobs', 'artifacts_unresolved',
  ];
  for (const value of values) {
    check(value, POLICY, NOW, taskReasons, null);
    check(TASK, value, NOW, ['invalid_policy', 'foreign_owner'], null);
  }
  check({}, {}, NOW, ['invalid_policy', ...taskReasons], null);
});

test('throwing known accessors become blockers', () => {
  const fields = [
    ['ownerId', 'foreign_owner'], ['origin', 'invalid_identity'],
    ['id', 'invalid_identity'], ['status', 'nonterminal'],
    ['endedAt', 'invalid_end'], ['resultCollected', 'uncollected'],
    ['pinned', 'pinned'], ['stopConfirmed', 'stop_unconfirmed'],
    ['activeJobs', 'active_jobs'], ['artifactState', 'artifacts_unresolved'],
  ];
  for (const [field, reason] of fields) {
    const task = { ...TASK };
    Object.defineProperty(task, field, { get() { throw new Error('untrusted accessor'); } });
    check(task, POLICY, NOW, [reason], field === 'status' || field === 'endedAt' ? null : 8 * DAY);
  }
  for (const field of ['ownerId', 'successDays', 'failureDays']) {
    const policy = { ...POLICY };
    Object.defineProperty(policy, field, { get() { throw new Error('untrusted policy'); } });
    check(TASK, policy, NOW, field === 'ownerId' ? ['invalid_policy', 'foreign_owner'] : ['invalid_policy'], null);
  }
});

test('throwing and revoked proxies fail closed without escaping exceptions', () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile = [
    revoked.proxy,
    new Proxy({}, { has() { throw new Error('has'); } }),
    new Proxy(TASK, { get() { throw new Error('get'); } }),
  ];
  for (const value of hostile) {
    const result = evaluateRetention(value, POLICY, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.eligibleAt, null);
    assert.ok(result.reasons.includes('foreign_owner'));
    assert.ok(result.reasons.includes('nonterminal'));
    assert.ok(result.reasons.includes('pinned'));
    assert.ok(result.reasons.includes('active_jobs'));
  }
  check(TASK, revoked.proxy, NOW, ['invalid_policy', 'foreign_owner'], null);
});

test('unknown fields are ignored, known getters are read once, and coercion is never used', () => {
  const task = { ...TASK };
  const policy = { ...POLICY };
  for (const object of [task, policy]) {
    Object.defineProperty(object, 'extra', { get() { throw new Error('unknown field read'); } });
  }
  let reads = 0;
  Object.defineProperty(task, 'endedAt', { get() { reads += 1; return DAY; } });
  check(task, policy, NOW, [], 8 * DAY);
  assert.equal(reads, 1);

  const noCoercion = Object.freeze({
    [Symbol.toPrimitive]() { throw new Error('coercion'); },
    valueOf() { throw new Error('coercion'); },
    toString() { throw new Error('coercion'); },
  });
  check({ ...TASK, activeJobs: noCoercion }, POLICY, NOW, ['active_jobs'], 8 * DAY);
  check(TASK, { ...POLICY, successDays: noCoercion }, NOW, ['invalid_policy'], null);
  check(TASK, POLICY, noCoercion, ['invalid_time'], null);
});

test('frozen and null-prototype inputs work without mutation or shared results', () => {
  const task = Object.freeze(Object.assign(Object.create(null), TASK));
  const policy = Object.freeze(Object.assign(Object.create(null), POLICY));
  const taskBefore = Object.getOwnPropertyDescriptors(task);
  const policyBefore = Object.getOwnPropertyDescriptors(policy);
  check(task, policy, NOW, [], 8 * DAY);
  assert.deepEqual(Object.getOwnPropertyDescriptors(task), taskBefore);
  assert.deepEqual(Object.getOwnPropertyDescriptors(policy), policyBefore);

  const first = evaluateRetention(TASK, POLICY, DAY);
  first.reasons.push('modified');
  first.eligibleAt = null;
  check(TASK, POLICY, DAY, ['retention_pending'], 8 * DAY);
  check(TASK, POLICY, NOW, [], 8 * DAY);
});
