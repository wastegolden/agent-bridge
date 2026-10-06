// test/supervisor.test.mjs
//
// Falsifiable tests for the controlled supervisor contract
// (`supervisor-event-wake-v1`): the shared authoritative reservation ledger, the
// immutable-parent-grant attenuation rule, the durable child ledger, descendant
// cancellation with stop proof, the trusted callback snapshot, persist-before-send
// notification with dedup, restart recovery, and the service drain integration.
//
// Evidence class: in-process unit tests with fake stores/adapters only. No real
// DSH host, no model, no prompt, no shell, no process spawn.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { HostReservationLedger, BridgeSupervisor, sharedLedger, childGrantFor, pathInside, callbackEventId } from '../src/supervisor.mjs'
import { TaskStore } from '../src/store.mjs'
import { validatePacket } from '../src/contracts.mjs'
import { BridgeService } from '../src/service.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTSIDE = path.dirname(HERE)

function freshLedger(limit = 2) {
  return sharedLedger(`supervisor-test-${randomUUID()}`, { limit })
}

function makePacket(root, key) {
  return {
    schemaVersion: 1,
    idempotencyKey: key,
    revision: 1,
    projectId: 'supervisor-project',
    title: key,
    objective: 'bounded read',
    cwd: root,
    role: 'investigate',
    acceptance: ['evidence'],
    scope: { readRoots: [root], writeRoots: [], allowedTools: ['read_file'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [],
    contractVersion: '1'
  }
}

function parentGrant(overrides = {}) {
  return {
    readRoots: [HERE],
    writeRoots: [],
    allowNetwork: false,
    allowedTools: ['read', 'write', 'bash'],
    model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    budgets: { timeoutMs: 1000, maxToolCalls: 10, maxOutputChars: 1000 },
    maxChildren: 2,
    depth: 0,
    callbackTargetId: null,
    ...overrides
  }
}

function wideningCode(fn) {
  try {
    fn()
  } catch (error) {
    return error.code
  }
  return null
}

/* ------------------------------------------------------------------ ledger */

test('the shared ledger admits up to its limit, refuses saturation and never releases without stop proof', () => {
  const ledger = new HostReservationLedger({ limit: 2, id: 'unit' })
  assert.equal(ledger.counts().free, 2)
  const first = ledger.reserve({ key: 'task:a', kind: 'root', taskId: 'a' })
  assert.equal(first.ok, true)
  assert.equal(first.reused, false)
  const again = ledger.reserve({ key: 'task:a', kind: 'root', taskId: 'a' })
  assert.equal(again.ok, true)
  assert.equal(again.reused, true, 're-reserving the same key must not consume a second slot')
  assert.equal(ledger.reserve({ key: 'task:b', kind: 'root', taskId: 'b' }).ok, true)
  const saturated = ledger.reserve({ key: 'task:c', kind: 'root', taskId: 'c' })
  assert.equal(saturated.ok, false)
  assert.equal(saturated.reason, 'saturated')
  assert.equal(saturated.counts.used, 2, 'a saturation refusal must register nothing')

  assert.throws(() => ledger.release('task:a', { stopConfirmed: false }), { code: 'supervisor/no-stop-proof' })
  assert.equal(ledger.has('task:a'), true, 'an unproven stop keeps the slot')
  assert.equal(ledger.release('task:a', { stopConfirmed: true }), true)
  assert.equal(ledger.counts().used, 1)
})

test('unknown work is marked ambiguous, keeps its slot, and can be adopted beyond the limit', () => {
  const ledger = new HostReservationLedger({ limit: 1, id: 'unit-ambiguous' })
  ledger.reserve({ key: 'task:a', kind: 'root', taskId: 'a' })
  ledger.markUnknown('task:a', 'stop unconfirmed')
  assert.equal(ledger.counts().used, 1)
  assert.equal(ledger.counts().unknown, 1)
  assert.equal(ledger.counts().free, 0, 'unknown work still consumes capacity')

  // Recovery adopts work that ALREADY exists even when the ledger is saturated.
  ledger.adopt({ key: 'child:a:c1', kind: 'child', taskId: 'a', childId: 'c1', reason: 'recovered' })
  assert.equal(ledger.counts().used, 2)
  assert.equal(ledger.counts().free, 0, 'free clamps at zero; capacity is never fabricated')
  assert.equal(ledger.counts().children, 1)
  assert.equal(ledger.counts().unknown, 2)
  assert.equal(ledger.get('child:a:c1').recovered, true)
})

test('the same ledger id returns one shared ledger with one authoritative limit', () => {
  const id = `shared-${randomUUID()}`
  const first = sharedLedger(id, { limit: 3 })
  const second = sharedLedger(id, { limit: 3 })
  assert.equal(first, second)
  first.reserve({ key: 'task:x', kind: 'root' })
  assert.equal(second.counts().used, 1, 'a second supervisor sees the first reservation')
  assert.deepEqual(first.declaredLimits, [3], 'the first declaration is authoritative')
  // A later declaration of a DIFFERENT limit is a typed configuration conflict,
  // never a silent resize or a first-limit-wins absorption.
  let conflict
  try {
    sharedLedger(id, { limit: 99 })
  } catch (error) {
    conflict = error
  }
  assert.equal(conflict?.code, 'supervisor/ledger-limit-conflict')
  assert.equal(conflict.details.declaredLimit, 3)
  assert.equal(conflict.details.requestedLimit, 99)
  assert.deepEqual(conflict.details.declaredLimits, [3, 99])
  assert.equal(first.limit, 3, 'the conflicting declaration must not change the live ledger')
  assert.equal(second.counts().used, 1)
  assert.equal(pathInside(HERE, path.join(HERE, 'x')), true)
  assert.equal(pathInside(HERE, OUTSIDE), false)
})

/* --------------------------------------------------- child grant attenuation */

test('child grants are attenuated and every widening request is rejected, never clamped', () => {
  const grant = parentGrant()
  const accepted = childGrantFor(grant, { childKey: 'c1', objective: 'o', tools: ['read'], budgets: { timeoutMs: 500, maxToolCalls: 5 } })
  assert.deepEqual(accepted.tools, ['read'])
  assert.deepEqual(accepted.budgets, { timeoutMs: 500, maxToolCalls: 5, maxOutputChars: 1000 })
  assert.equal(accepted.depth, 1)
  assert.deepEqual(accepted.readRoots, [HERE], 'an omitted root inherits the parent grant')
  assert.equal(accepted.callbackTargetId, null, 'a child never inherits a root wake target')

  const cases = [
    { request: { childKey: 'w1', objective: 'o', readRoots: [OUTSIDE] }, field: 'readRoots' },
    { request: { childKey: 'w2', objective: 'o', writeRoots: [OUTSIDE] }, field: 'writeRoots' },
    { request: { childKey: 'w3', objective: 'o', allowNetwork: true }, field: 'allowNetwork' },
    { request: { childKey: 'w4', objective: 'o', model: { provider: 'deepseek-official', model: 'other' } }, field: 'model' },
    { request: { childKey: 'w5', objective: 'o', budgets: { timeoutMs: 2000 } }, field: 'budgets.timeoutMs' },
    { request: { childKey: 'w6', objective: 'o', budgets: { maxToolCalls: 11 } }, field: 'budgets.maxToolCalls' },
    { request: { childKey: 'w7', objective: 'o', tools: ['ghost'] }, field: 'tools' },
    { request: { childKey: 'w8', objective: 'o', tools: ['bash'] }, field: 'tools' },
    { request: { childKey: 'w9', objective: 'o', tools: ['dsh_child_spawn'] }, field: 'tools' },
    { request: { childKey: 'w10', objective: 'o', maxChildren: 3 }, field: 'maxChildren' },
    { request: { childKey: 'w11', objective: 'o', depth: 1 }, field: 'depth' }
  ]
  for (const entry of cases) {
    let error
    try {
      childGrantFor(grant, entry.request, { maxDepth: 1, maxChildrenPerTask: 1 })
    } catch (failure) {
      error = failure
    }
    assert.ok(error, `${entry.field} widening must be rejected`)
    assert.equal(error.code, 'supervisor/grant-widened', `${entry.field} widening must be rejected`)
    assert.equal(error.details.field, entry.field)
  }
  // Depth is capped at 1 for soundness.
  assert.equal(wideningCode(() => childGrantFor({ ...grant, depth: 1 }, { childKey: 'd', objective: 'o' }, { maxDepth: 1 })), 'supervisor/depth-exceeded')
})

/* ------------------------------------------------------------- child ledger */

test('the child ledger is idempotent by childKey, bounds live children and refuses saturation without registering', () => {
  const ledger = freshLedger(1)
  const supervisor = new BridgeSupervisor({ ledger, ownerId: 'owner', config: { childSessions: { enabled: true, maxChildrenPerTask: 2 } } })
  const first = supervisor.registerChild({ childId: 'c1', childKey: 'k1', taskId: 't1', attemptId: 'a1', state: 'starting' })
  assert.equal(first.created, true)
  const replay = supervisor.registerChild({ childId: 'c2', childKey: 'k1', taskId: 't1', attemptId: 'a1', state: 'starting' })
  assert.equal(replay.created, false)
  assert.equal(replay.child.childId, 'c1', 'a duplicate childKey returns the same child')
  assert.equal(supervisor.findChildByKey('t1', 'a1', 'k1').childId, 'c1')

  const reserved = supervisor.reserveChild({ taskId: 't1', attemptId: 'a1', childId: 'c1' })
  assert.equal(reserved.ok, true)
  const saturated = supervisor.reserveChild({ taskId: 't1', attemptId: 'a1', childId: 'c2' })
  assert.equal(saturated.ok, false)
  assert.equal(saturated.code, 'supervisor/saturated')
  assert.equal(supervisor.ledger.counts().children, 1, 'a saturation refusal registers no child')

  // An unconfirmed release keeps the slot and marks the child unknown.
  assert.equal(supervisor.releaseChild({ taskId: 't1', childId: 'c1', stopConfirmed: false, reason: 'unproven' }), false)
  assert.equal(supervisor.findChild('c1').state, 'unknown')
  assert.equal(supervisor.ledger.get('child:t1:c1').ambiguous, true)
  assert.equal(supervisor.releaseChild({ taskId: 't1', childId: 'c1', stopConfirmed: true }), true)
  assert.equal(supervisor.ledger.counts().children, 0)
})

test('descendant cancellation releases only proven stops and keeps unproven children counted', async () => {
  const ledger = freshLedger(4)
  const supervisor = new BridgeSupervisor({ ledger, ownerId: 'owner', config: { childSessions: { enabled: true, maxChildrenPerTask: 4 } } })
  supervisor.registerChild({ childId: 'c1', childKey: 'k1', taskId: 't1', attemptId: 'a1', state: 'running' })
  supervisor.registerChild({ childId: 'c2', childKey: 'k2', taskId: 't1', attemptId: 'a1', state: 'running' })
  supervisor.reserveChild({ taskId: 't1', attemptId: 'a1', childId: 'c1' })
  supervisor.reserveChild({ taskId: 't1', attemptId: 'a1', childId: 'c2' })
  assert.equal(ledger.counts().children, 2)

  const report = await supervisor.cancelDescendants({
    taskId: 't1',
    reason: 'parent cancelled',
    cancelChild: async (child) => (child.childId === 'c1' ? { stopConfirmed: true, state: 'cancelled' } : { stopConfirmed: false, outcome: 'unknown' })
  })
  assert.equal(report.cancelled.length, 2)
  assert.equal(report.unconfirmed, 1)
  assert.equal(ledger.has('child:t1:c1'), false, 'a proven stop releases the slot')
  assert.equal(ledger.has('child:t1:c2'), true, 'an unproven stop keeps the slot')
  assert.equal(ledger.get('child:t1:c2').ambiguous, true)
  assert.equal(supervisor.findChild('c2').state, 'unknown')
})

/* -------------------------------------------------------- callback snapshot */

test('the trusted callback snapshot resolves at submission and is refused for an unknown or undesignated grant', () => {
  const supervisor = new BridgeSupervisor({
    ledger: freshLedger(2),
    ownerId: 'owner',
    config: { rootCallbackGrants: { root: { targetId: 'thread-1', taskKeys: ['key-a'] } } }
  })
  const snapshot = supervisor.callbackSnapshot({ grantId: 'root', taskKey: 'key-a' })
  assert.equal(snapshot.grantId, 'root')
  assert.equal(snapshot.targetId, 'thread-1')
  assert.equal(Number.isFinite(snapshot.boundAt), true)
  assert.equal(wideningCode(() => supervisor.callbackSnapshot({ grantId: 'root', taskKey: 'key-b' })), 'supervisor/callback-ungranted')
  assert.equal(wideningCode(() => supervisor.callbackSnapshot({ grantId: 'ghost' })), 'supervisor/callback-ungranted')
})

/* --------------------------------------------------- event identity (outbox) */

test('callback event identity is the full immutable tuple: deterministic, collision-free and Windows-safe', async () => {
  const ids = [
    callbackEventId({ taskId: 'task-a', attemptId: 'attempt-1', logicalId: 'settled:completed', prefix: 'settled' }),
    callbackEventId({ taskId: 'task-b', attemptId: 'attempt-1', logicalId: 'settled:completed', prefix: 'settled' }),
    callbackEventId({ taskId: 'task-a', attemptId: 'attempt-2', logicalId: 'settled:completed', prefix: 'settled' }),
    callbackEventId({ taskId: 'task-a', attemptId: 'attempt-1', logicalId: 'settled:failed', prefix: 'settled' })
  ]
  assert.equal(ids[0], callbackEventId({ taskId: 'task-a', attemptId: 'attempt-1', logicalId: 'settled:completed', prefix: 'settled' }), 'the same tuple replays the same id')
  assert.equal(new Set(ids).size, 4, 'a different task, attempt or logical id must never collide')
  for (const id of ids) {
    assert.ok(id.length <= 128, 'the id must stay inside the outbox character fence')
    assert.match(id, /^settled-[0-9a-f]{64}$/, 'a Windows-safe lowercase hex id, never a path-like string')
  }
  assert.throws(() => callbackEventId({ taskId: 'task-a', attemptId: '', logicalId: 'x' }), { code: 'supervisor/invalid-notification' })

  // The generated ids actually differ across two tasks/attempts for the two
  // logical kinds the outbox dedups globally.
  const seen = []
  const supervisor = new BridgeSupervisor({
    ledger: freshLedger(4),
    ownerId: 'owner',
    persist: { event: (taskId, entry) => ({ seq: 1, ...entry }) },
    config: { notificationSink: (event) => { seen.push(event); return { delivered: true } } }
  })
  const binding = { grantId: 'root', targetId: 'thread-1', boundAt: 1 }
  await supervisor.notifySettlement({ task: { id: 't1', attemptId: 'a1', stopConfirmed: true, callbackBinding: binding }, status: 'completed', summary: 'one' })
  await supervisor.notifySettlement({ task: { id: 't2', attemptId: 'a1', stopConfirmed: true, callbackBinding: binding }, status: 'completed', summary: 'two' })
  await supervisor.notifyReply({ task: { id: 't1', attemptId: 'a1', callbackBinding: binding }, attemptId: 'a1', replyId: 'r1', kind: 'needs-input', summary: 'needs input' })
  assert.equal(seen.length, 3)
  assert.equal(new Set(seen.map((event) => event.eventId)).size, 3, 'two tasks and a reply cannot share one outbox identity')
})

/* --------------------------------------------------------------- notifications */

test('notifications persist before send, carry exactly the documented fields, dedup and never claim an unproven delivery', async () => {
  const order = []
  const seen = []
  const supervisor = new BridgeSupervisor({
    ledger: freshLedger(2),
    ownerId: 'owner',
    persist: { event: (taskId, event) => { order.push('persist'); return { seq: 7, ...event } } },
    // An explicit POSITIVE delivery acknowledgement is the only thing that makes
    // `delivered` true; an enqueue acceptance is asserted in the next test.
    config: { notificationSink: (event) => { order.push('send'); seen.push(event); return { delivered: true } } }
  })
  const event = { taskId: 't1', attemptId: 'a1', eventId: 'settled:completed', targetId: 'thread-1', kind: 'completed', summary: 'done', resultIds: ['r1'] }
  const first = await supervisor.emitNotification(event)
  assert.equal(first.delivered, true)
  assert.equal(first.outcome, 'delivered')
  assert.equal(first.persistedSeq, 7)
  assert.equal(order[0], 'persist')
  assert.equal(order[1], 'send', 'the event identity must be durable BEFORE the sink is invoked')
  assert.ok(order.slice(2).every((entry) => entry === 'persist'), 'the interpreted outcome is persisted after the send')
  assert.deepEqual(Object.keys(seen[0]).sort(), ['attemptId', 'eventId', 'kind', 'resultIds', 'summary', 'targetId', 'taskId'])
  assert.deepEqual(seen[0].resultIds, ['r1'])

  const replay = await supervisor.emitNotification(event)
  assert.equal(replay.outcome, 'duplicate')
  assert.equal(seen.length, 1, 'an ambiguous or repeated event is never blindly sent twice')

  const second = await supervisor.emitNotification({ ...event, eventId: 'settled:failed' })
  assert.equal(second.delivered, true)
  assert.equal(second.outcome, 'delivered')
})

test('an enqueue acknowledgement is queued, an absent or malformed acknowledgement is unknown, and a refusal is preserved', async () => {
  const event = (suffix) => ({ taskId: `t-${suffix}`, attemptId: `a-${suffix}`, eventId: `e-${suffix}`, targetId: 'thread-1', kind: 'completed', summary: 'x' })

  const enqueuedSeen = []
  const queued = new BridgeSupervisor({
    ledger: freshLedger(2),
    ownerId: 'owner',
    persist: { event: (taskId, entry) => ({ seq: 1, ...entry }) },
    config: { notificationSink: (wire) => { enqueuedSeen.push(wire); return { ok: true, event: { state: 'pending' } } } }
  })
  const accepted = await queued.emitNotification(event('queued'))
  assert.equal(accepted.delivered, false, 'an outbox acceptance is NOT delivery')
  assert.equal(accepted.outcome, 'queued')
  assert.equal(accepted.delivery, 'queued')
  const queuedReplay = await queued.emitNotification(event('queued'))
  assert.equal(queuedReplay.outcome, 'duplicate', 'a queued event is never sent twice')
  assert.equal(enqueuedSeen.length, 1)

  const malformed = new BridgeSupervisor({ ledger: freshLedger(2), ownerId: 'owner', config: { notificationSink: () => undefined } })
  const unknown = await malformed.emitNotification(event('unknown'))
  assert.equal(unknown.delivered, false, 'an undefined acknowledgement proves nothing')
  assert.equal(unknown.outcome, 'unknown')

  const refused = new BridgeSupervisor({
    ledger: freshLedger(2),
    ownerId: 'owner',
    config: { notificationSink: () => ({ ok: false, error: { code: 'OUTBOX_CLOSED' } }) }
  })
  const refusal = await refused.emitNotification(event('refused'))
  assert.equal(refusal.delivered, false)
  assert.equal(refusal.outcome, 'refused')
  assert.equal(refusal.ack.error.code, 'OUTBOX_CLOSED', 'an explicit refusal is preserved verbatim, never softened into a delivery')

  const delivered = new BridgeSupervisor({ ledger: freshLedger(2), ownerId: 'owner', config: { notificationSink: () => 'delivered' } })
  const positive = await delivered.emitNotification(event('delivered'))
  assert.equal(positive.delivered, true)
  assert.equal(positive.outcome, 'delivered', 'only a positive delivery acknowledgement claims delivery')
})

test('a failing sink is contained as an unknown outcome and is not replayed; an absent sink is unsupported', async () => {
  const supervisor = new BridgeSupervisor({
    ledger: freshLedger(2),
    ownerId: 'owner',
    config: { notificationSink: () => { throw new Error('transport exploded') } }
  })
  const event = { taskId: 't1', attemptId: 'a1', eventId: 'e1', targetId: 'thread-1', kind: 'failed', summary: 'x' }
  const failed = await supervisor.emitNotification(event)
  assert.equal(failed.delivered, false)
  assert.equal(failed.outcome, 'unknown')
  assert.equal(failed.detail.code, 'supervisor/sink-failed')
  const replay = await supervisor.emitNotification(event)
  assert.equal(replay.outcome, 'duplicate', 'an ambiguous send stays unknown and is never replayed')

  const noSink = new BridgeSupervisor({ ledger: freshLedger(2), ownerId: 'owner', config: {} })
  const unsupported = await noSink.emitNotification({ ...event, taskId: 't2' })
  assert.equal(unsupported.delivered, false)
  assert.equal(unsupported.outcome, 'unsupported', 'no sink is explicitly unsupported, never a successful delivery')
  assert.equal(noSink.notificationsStatus().supported, false)
})

test('settlement refuses without stop proof or with a live child and uses the persisted target, not the live config', async () => {
  const seen = []
  const persisted = []
  const supervisor = new BridgeSupervisor({
    ledger: freshLedger(4),
    ownerId: 'owner',
    persist: { event: (taskId, entry) => { persisted.push({ taskId, ...entry }); return { seq: persisted.length, ...entry } } },
    // The LIVE config points somewhere else; the persisted snapshot must win.
    config: { rootCallbackGrants: { root: { targetId: 'config-target' } }, notificationSink: (event) => { seen.push(event); return { delivered: true } } }
  })
  const task = { id: 't1', attemptId: 'a1', stopConfirmed: true, callbackBinding: { grantId: 'root', targetId: 'persisted-target', boundAt: 1 } }
  const sent = await supervisor.notifySettlement({ task, status: 'completed', summary: 'done' })
  assert.equal(sent.delivered, true)
  assert.equal(sent.outcome, 'delivered')
  assert.equal(seen[0].targetId, 'persisted-target')
  assert.equal(seen[0].kind, 'completed')

  const unstopped = await supervisor.notifySettlement({ task: { ...task, stopConfirmed: false }, status: 'completed', summary: 'x' })
  assert.equal(unstopped.outcome, 'not-stopped')
  await assert.rejects(() => supervisor.notifySettlement({ task, status: 'running', summary: 'x' }), { code: 'supervisor/invalid-notification' })

  supervisor.registerChild({ childId: 'c1', childKey: 'k1', taskId: 't1', attemptId: 'a1', state: 'running' })
  supervisor.reserveChild({ taskId: 't1', attemptId: 'a1', childId: 'c1' })
  const blocked = await supervisor.notifySettlement({ task, status: 'failed', summary: 'x' })
  assert.equal(blocked.outcome, 'children-live', 'completion requires no live children')

  // A reply is distinct from terminal completion: it never becomes a settlement.
  const reply = await supervisor.notifyReply({ task, attemptId: 'a1', replyId: 'r1', kind: 'blocked', summary: 'need input' })
  assert.equal(reply.delivered, true)
  assert.equal(reply.replyKind, 'blocked')
  assert.equal(seen.at(-1).kind, 'needs-input', 'needs-input stays the shared wire kind for a nonterminal reply')
  assert.deepEqual(
    Object.keys(seen.at(-1)).sort(),
    ['attemptId', 'eventId', 'kind', 'summary', 'targetId', 'taskId'],
    'the shared sink contract gains no new reply field'
  )
  assert.equal(seen.at(-1).summary, '[blocked] need input', 'the controller-generated prefix survives to the recipient')
  const durableReply = persisted.find((entry) => entry.type === 'task/notification' && entry.eventId === reply.eventId)
  assert.ok(durableReply, 'the reply identity is durable before send')
  assert.equal(durableReply.replyKind, 'blocked', 'the durable task/notification record keeps the reply kind')
  assert.equal(durableReply.kind, 'needs-input')
  assert.equal(durableReply.summary, '[blocked] need input')
  const replyReplay = await supervisor.notifyReply({ task, attemptId: 'a1', replyId: 'r1', kind: 'blocked', summary: 'need input' })
  assert.equal(replyReplay.outcome, 'duplicate')

  // The default kind and the other explicit reply kind keep their own prefix.
  const needsInput = await supervisor.notifyReply({ task, attemptId: 'a1', replyId: 'r2', summary: 'which one' })
  assert.equal(needsInput.replyKind, 'needs-input')
  assert.equal(seen.at(-1).kind, 'needs-input')
  assert.equal(seen.at(-1).summary, '[needs-input] which one')
})

/* ----------------------------------------------------------------- recovery */

test('recovery marks persisted child work unknown, adopts its reservation and adopts sent notification identities', () => {
  const ledger = freshLedger(2)
  const supervisor = new BridgeSupervisor({ ledger, ownerId: 'owner', config: {} })
  const task = { id: 't1', children: [{ childId: 'c1', attemptId: 'a1', state: 'running' }] }
  const events = [{ type: 'task/notification', eventId: 'settled:completed', attemptId: 'a1' }]
  const report = supervisor.recoverTask(task, events)
  assert.equal(report.children.length, 1)
  assert.equal(report.children[0].state, 'unknown')
  assert.equal(report.children[0].stopConfirmed, false)
  assert.equal(report.reservations, 1)
  assert.equal(report.adoptions, 1)
  assert.equal(ledger.has('child:t1:c1'), true, 'recovered unknown child work stays counted')
  assert.equal(ledger.get('child:t1:c1').ambiguous, true)
  // The adopted notification identity is never re-sent.
  return supervisor
    .emitNotification({ taskId: 't1', attemptId: 'a1', eventId: 'settled:completed', targetId: 'x', kind: 'completed', summary: 's' })
    .then((outcome) => assert.equal(outcome.outcome, 'duplicate'))
})

/* ------------------------------------------------------- service integration */

test('BridgeService shares the one ledger: saturation queues work and only a proven stop releases a slot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-supervisor-svc-'))
  const store = new TaskStore({ directory, ownerId: 'owner' })
  const ledger = freshLedger(1)
  const supervisor = new BridgeSupervisor({ ledger, ownerId: 'owner', config: {} })
  let startCalls = 0
  const adapter = {
    async models() {
      return [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }]
    },
    async start() {
      startCalls += 1
      return new Promise(() => {})
    },
    async cancel() {
      return { stopConfirmed: true, remaining: [] }
    }
  }
  const service = new BridgeService({ store, adapter, maxConcurrent: 4, supervisor })
  service.kick = () => {} // drive drain deterministically
  try {
    const model = { provider: 'deepseek-official', model: 'deepseek-flash' }
    const a = store.submit(validatePacket(makePacket(HERE, 'svc-a')), { effectiveModel: model })
    const b = store.submit(validatePacket(makePacket(HERE, 'svc-b')), { effectiveModel: model })

    await service.drain()
    assert.equal(startCalls, 1, 'the configured limit admits exactly one root')
    assert.equal(ledger.counts().used, 1)
    assert.equal(store.get(b.task.id).status, 'queued', 'saturation leaves the next task queued, never deadlocked')

    // A proven stop releases the slot.
    service.finish(a.task.id, { status: 'completed', text: 'done', stopConfirmed: true, activeJobs: 0 }, store.get(a.task.id).attemptId)
    assert.equal(ledger.counts().used, 0)
    assert.equal(store.get(a.task.id).status, 'completed')

    // The queue advances, and an UNPROVEN settlement keeps its slot ambiguous.
    await service.drain()
    assert.equal(startCalls, 2)
    assert.equal(ledger.counts().used, 1)
    service.finish(b.task.id, { status: 'completed', text: 'maybe done', stopConfirmed: false, activeJobs: 0 }, store.get(b.task.id).attemptId)
    assert.equal(store.get(b.task.id).status, 'unknown', 'an unconfirmed stop is never recorded as terminal')
    assert.equal(ledger.counts().used, 1, 'unknown work keeps its reservation')
    assert.equal(ledger.counts().unknown, 1, 'the unreserved tally is counts().unknown; the per-entry field is ambiguous')

    // A settlement that reports a live child is also never terminal.
    const c = store.submit(validatePacket(makePacket(HERE, 'svc-c')), { effectiveModel: model })
    service.finish(a.task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 }, store.get(a.task.id).attemptId)
    await service.drain()
    service.finish(c.task.id, { status: 'completed', text: 'parent done', stopConfirmed: true, activeJobs: 0, activeChildren: 1 }, store.get(c.task.id).attemptId)
    assert.equal(store.get(c.task.id).status, 'unknown', 'a live child blocks a terminal status')
  } finally {
    service.close()
    store.close()
  }
})

/* --------------------------------------- recovery beyond the first event page */

test('recovery adopts notification identities beyond the first 1000 events and never re-sends them', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-supervisor-recover-'))
  const store = new TaskStore({ directory, ownerId: 'owner' })
  const ledger = freshLedger(4)
  const supervisor = new BridgeSupervisor({ ledger, ownerId: 'owner', config: {} })
  const adapter = {
    async models() {
      return [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }]
    },
    async inspect() {
      return { status: 'unknown', stopConfirmed: false, activeJobs: 0 }
    }
  }
  const service = new BridgeService({ store, adapter, maxConcurrent: 4, supervisor })
  service.kick = () => {}
  try {
    const model = { provider: 'deepseek-official', model: 'deepseek-flash' }
    const submitted = store.submit(validatePacket(makePacket(HERE, 'recover-paged')), { effectiveModel: model })
    const taskId = submitted.task.id
    const attemptId = submitted.task.attemptId
    // recover() only reconsiders ACTIVE work, so mark the persisted task active
    // exactly as an interrupted dispatch would leave it.
    store.update(taskId, { status: 'running' })
    // More than one 1000-event page, with the notification identity on the LAST
    // event — beyond the old single oldest-1000 read.
    for (let i = 0; i < 1005; i += 1) store.event(taskId, { type: 'task/progress', i })
    store.event(taskId, { type: 'task/notification', eventId: 'settled:completed', attemptId })

    await service.recover()

    assert.equal(store.get(taskId).notificationAdoptions, 1, 'the >1000th notification identity was adopted by recover()')
    const outcome = await supervisor.emitNotification({
      taskId,
      attemptId,
      eventId: 'settled:completed',
      targetId: 'x',
      kind: 'completed',
      summary: 's'
    })
    assert.equal(outcome.outcome, 'duplicate', 'an adopted identity beyond page one is never re-sent')
  } finally {
    service.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('recovery records an explicit unknown when a later event page cannot be read', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-supervisor-recover-fail-'))
  const store = new TaskStore({ directory, ownerId: 'owner' })
  const ledger = freshLedger(4)
  const supervisor = new BridgeSupervisor({ ledger, ownerId: 'owner', config: {} })
  const adapter = {
    async models() {
      return [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }]
    },
    async inspect() {
      return { status: 'unknown', stopConfirmed: false, activeJobs: 0 }
    }
  }
  const service = new BridgeService({ store, adapter, maxConcurrent: 4, supervisor })
  service.kick = () => {}
  try {
    const model = { provider: 'deepseek-official', model: 'deepseek-flash' }
    const submitted = store.submit(validatePacket(makePacket(HERE, 'recover-page-fail')), { effectiveModel: model })
    const taskId = submitted.task.id
    store.update(taskId, { status: 'running' })
    // Exactly one full page, so the loop must attempt a second read.
    for (let i = 0; i < 1000; i += 1) store.event(taskId, { type: 'task/progress', i })
    const original = store.events.bind(store)
    let reads = 0
    store.events = (...args) => {
      reads += 1
      if (reads === 2) throw new Error('cursor read failed')
      return original(...args)
    }

    await service.recover()

    const recovered = store.get(taskId)
    assert.equal(reads, 2, 'recovery must keep reading until the page is short')
    assert.equal(recovered.notificationRecovery?.outcome, 'unknown', 'a page read failure must stay explicit, never silent')
    assert.match(recovered.notificationRecovery.error, /cursor read failed/)
  } finally {
    service.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
