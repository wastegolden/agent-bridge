/**
 * Lifecycle fence regressions (FAKE-HOST ONLY).
 *
 * Bounded regressions for the two independently reviewed lifecycle defects
 * (lifecycle contract 20260925.2 / repair task
 * upgrade-20260925-adapter-lifecycle-repair1):
 *
 *  1. `#recoverTask` caches a recovered record before `reconsider` validates the
 *     durable previous-request binding, the workspace cwd and the restored guard.
 *     A first refusal left that record cached, so a repeated `reconsider` skipped
 *     every recovery check and could dispatch without a guard or with a
 *     mismatched cwd. Recovery trust must be re-proven on EVERY reconsider of a
 *     recovered record, including after `inspect()` or a prior failed recovery.
 *  2. `#ownedQueueItemsStrict` delegated to the permissive, owned-only queue
 *     helper: a missing/non-array `nextTurn`/`nextStep` read as empty, and
 *     same-session items with another (or no) `rpcId` were ignored. Strict
 *     lifecycle proof must read both arrays from the CURRENT
 *     `agents.get(sessionId)`, treat a malformed list as UNKNOWN, and block ANY
 *     queued session item.
 *
 * These tests drive the real `DshAdapter` through a minimal fake host that
 * implements only the documented 0.1.5-rc.2 seams needed here. No real host runs,
 * no model is prompted and no tool body executes; filesystem paths are real
 * existing directories. Evidence class: MOCK. No live-host claim is made.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DshAdapter } from '../src/dsh-adapter.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Existing directory used as the task cwd. */
const ROOT = HERE
/** Parent of the task cwd: a real, different existing directory. */
const OUTSIDE = path.dirname(HERE)

const TOOLS = ['read', 'write', 'edit', 'todo_write']
const FLASH = { provider: 'deepseek-official', model: 'deepseek-flash' }

// ---------------------------------------------------------------------------
// minimal fake host
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake DSH host exposing only the seams these regressions need.
 * @param {object} [options] - host variations.
 * @returns {object} `{ctx, agents, calls, inboxOf, emit, ...}`.
 */
function createFakeHost(options = {}) {
  const listeners = new Map()
  const agents = new Map()
  const archivedSessions = []
  const calls = { create: [], prompt: [], inspect: [] }
  const durableEvents = Array.isArray(options.durableEvents) ? options.durableEvents : []
  const durableCwd = options.durableCwd ?? ROOT
  const jobs = options.jobs ?? []
  let sessionSeq = 0

  function makeAgent(sessionId, cwd) {
    const scopedTools = {
      schemas: () => TOOLS.map((name) => ({ name })),
      restrict: () => () => {},
      guard: () => {
        if (options.guardFails === true) throw new Error('guard unsupported in this host')
        return () => {}
      }
    }
    return {
      id: sessionId,
      status: options.initialStatus ?? 'running',
      session: { id: sessionId, header: { id: sessionId, cwd }, append() {} },
      inbox: { nextTurn: [], nextStep: [] },
      cancel() {
        this.inbox.nextTurn.length = 0
        this.inbox.nextStep.length = 0
      },
      ctx: {
        get(name) {
          if (name !== 'tools') return undefined
          return options.scopedToolsUnavailable === true ? undefined : scopedTools
        },
        on(event) {
          if (event !== 'tools/pre-execute') return undefined
          return options.listenerUnavailable === true ? undefined : () => {}
        }
      }
    }
  }

  const sessionController = {
    async create(request) {
      calls.create.push({ cwd: request.cwd })
      sessionSeq += 1
      const sessionId = `session-${sessionSeq}`
      agents.set(sessionId, makeAgent(sessionId, request.cwd))
      return { sessionId }
    },
    async selectModel(request) {
      return { selected: { provider: request.provider, model: request.model } }
    },
    async prompt(request) {
      calls.prompt.push({
        sessionId: request.sessionId,
        requestId: request.requestId,
        text: request.content !== undefined && request.content[0] !== undefined ? request.content[0].text : undefined
      })
      return { accepted: true }
    },
    async inspect(sessionId) {
      calls.inspect.push(sessionId)
      if (options.inspectFails === true) throw new Error('session not found')
      return { meta: { id: sessionId, cwd: durableCwd, createdAt: 1, isSeeded: false }, inheritedEventCount: 0, events: durableEvents }
    }
  }

  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'tools') return { schemas: () => TOOLS.map((tool) => ({ name: tool })) }
      if (name === 'sessionController') return sessionController
      if (name === 'jobs') return { list: () => jobs, kill: () => 'requested' }
      if (name === 'sessionPersistence') return {}
      if (name === 'sandboxPolicy') return {}
      if (name === 'fs') return { sandboxMode: 'workspace-write' }
      if (name === 'sessionQuery') return {}
      if (name === 'workspaceRegistry') {
        return {
          archiveSession: async (sessionId) => {
            archivedSessions.push(sessionId)
            return { archived: true }
          }
        }
      }
      return undefined
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    }
  }

  const api = {
    ctx,
    agents,
    calls,
    archivedSessions,
    inboxOf(sessionId) {
      return agents.get(sessionId).inbox
    },
    /** Swap in a fresh live agent for a session (the old object goes stale). */
    replaceAgent(sessionId, cwd = ROOT) {
      agents.delete(sessionId)
      const agent = makeAgent(sessionId, cwd)
      agents.set(sessionId, agent)
      return agent
    },
    emit(sessionId, event) {
      for (const listener of listeners.get('session/event') ?? []) {
        listener({ id: sessionId }, { time: Date.now(), ...event })
      }
    }
  }
  return api
}

/** Claim a queued prompt and settle its turn (the host's own durable history). */
function claimAndSettle(host, sessionId, requestId, turn = 1) {
  host.emit(sessionId, { type: 'turn/start', seq: turn * 10 + 1, data: { turn } })
  host.emit(sessionId, {
    type: 'user/message',
    seq: turn * 10 + 2,
    data: { id: `m-${turn}`, turn, source: { kind: 'user', rpcId: requestId } }
  })
  host.emit(sessionId, { type: 'turn/end', seq: turn * 10 + 3, data: { turn, reason: { kind: 'completed' } } })
}

// ---------------------------------------------------------------------------
// packet / envelope fixtures
// ---------------------------------------------------------------------------

const BASE_PACKET = {
  schemaVersion: 1,
  idempotencyKey: 'fence-key',
  revision: 1,
  projectId: 'fence-proj',
  title: 'lifecycle fence',
  objective: 'exercise the lifecycle fences',
  cwd: ROOT,
  role: 'implement',
  acceptance: ['the fence holds'],
  scope: {
    readRoots: [ROOT],
    writeRoots: [ROOT],
    allowedTools: TOOLS,
    allowShell: false,
    allowNetwork: false,
    allowDelegation: false
  },
  materials: [],
  contractVersion: 'v1'
}

function makePacket(overrides = {}) {
  const { scope, ...rest } = overrides
  return { ...BASE_PACKET, ...rest, scope: { ...BASE_PACKET.scope, ...(scope ?? {}) } }
}

/** A normal (non-recovered) task envelope. */
function makeEnvelope(overrides = {}) {
  const packet = makePacket(overrides.packet)
  return {
    id: overrides.id ?? 'task-fence-1',
    revision: overrides.revision ?? packet.revision,
    attemptId: overrides.attemptId ?? 'attempt-f1',
    packet,
    prompt: overrides.prompt ?? 'ROOT PROMPT',
    effectiveModel: overrides.effectiveModel ?? { ...FLASH },
    ...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId })
  }
}

/**
 * The single immutable understanding packet shared by `start` and the matching
 * `reconsider` envelope. `reconsider` refuses a changed packet, so both sides
 * must normalize to the same digest.
 */
const UNDERSTANDING_PACKET = makePacket({ understandingRequired: true })

/** Durable host history: our bound request `req-r` was claimed and completed. */
const BOUND_TURN_SETTLED = [
  { type: 'model/selection', seq: 0, time: 0, data: { provider: FLASH.provider, model: FLASH.model } },
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { id: 'm-r', turn: 1, source: { kind: 'user', rpcId: 'req-r' } } },
  { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }
]

/** Same settled turn with NO durable model evidence at all. */
const BOUND_TURN_NO_MODEL = [
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { id: 'm-r', turn: 1, source: { kind: 'user', rpcId: 'req-r' } } },
  { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }
]

/**
 * Persisted clarification envelope: the immutable original packet plus the
 * trusted `clarifications[last].previousAttempt` snapshot a reset adapter may
 * recover from.
 * @param {object} [overrides] - envelope overrides.
 * @returns {object} envelope.
 */
function lifecycleEnvelope(overrides = {}) {
  const packet = makePacket(overrides.packet ?? { understandingRequired: true, idempotencyKey: overrides.id ?? 'fence-key' })
  const sessionId = overrides.sessionId ?? 'session-1'
  const revision = overrides.revision ?? packet.revision
  return {
    id: overrides.id ?? 'task-fence-rec',
    revision,
    attemptId: overrides.attemptId ?? 'attempt-c2',
    origin: overrides.origin ?? 'codex-bridge',
    ownerId: overrides.ownerId ?? 'owner-1',
    packet,
    prompt: overrides.prompt ?? 'CLARIFICATION PROMPT',
    effectiveModel: overrides.effectiveModel ?? { ...FLASH },
    sessionId,
    clarifications: overrides.clarifications ?? [
      {
        clarificationId: 'clar-1',
        text: 'also cover the boundary case',
        requestHash: 'hash-1',
        generation: 1,
        createdAt: 1,
        previousUnderstanding: null,
        previousUnderstandingHash: null,
        previousResult: null,
        previousAttempt: {
          attemptId: 'attempt-r',
          requestId: 'req-r',
          sessionId,
          revision,
          phase: 'understanding',
          status: 'completed',
          dispatchReceiptAt: 1,
          effectiveModel: { ...FLASH }
        }
      }
    ]
  }
}

/** Assert a refusal with a specific code that never dispatched anything. */
async function expectRefusal(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code)
    assert.equal(error.dispatched, false)
    return true
  })
}

// ---------------------------------------------------------------------------
// defect 1: recovery trust on every reconsider of a recovered record
// ---------------------------------------------------------------------------

test('repeated reconsider after a cwd-mismatch recovery refuses every time and never dispatches', async () => {
  const host = createFakeHost({ durableEvents: BOUND_TURN_SETTLED, initialStatus: 'idle', durableCwd: OUTSIDE })
  await host.ctx.get('sessionController').create({ cwd: ROOT }) // the owned live session-1
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const envelope = lifecycleEnvelope({ id: 'task-fence-cwd' })

  // First call: recovery refuses on the workspace cwd, but caches the record.
  await expectRefusal(adapter.reconsider(envelope, {}), 'adapter/recovery-unsafe')
  assert.equal(host.calls.prompt.length, 0)
  assert.equal(host.calls.create.length, 1)

  // An inspect against the cached record must not launder trust.
  const seen = await adapter.inspect(envelope)
  assert.equal(seen.known, true)
  assert.equal(seen.recovered, true)

  // Every repeated call must re-prove the cwd and refuse again.
  await expectRefusal(adapter.reconsider(envelope, {}), 'adapter/recovery-unsafe')
  await expectRefusal(adapter.reconsider(lifecycleEnvelope({ id: 'task-fence-cwd', attemptId: 'attempt-c3' }), {}), 'adapter/recovery-unsafe')
  assert.equal(host.calls.prompt.length, 0, 'a refused recovered record must never dispatch')
  assert.equal(host.calls.create.length, 1, 'recovery must never create a session')
})

test('an inspect-cached recovered record cannot be laundered into a reconsider dispatch', async () => {
  const host = createFakeHost({ durableEvents: BOUND_TURN_SETTLED, initialStatus: 'idle', durableCwd: OUTSIDE })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  // A recoverable envelope: the persisted attempt identity is present, so
  // `inspect` can recover and cache the record on its own.
  const envelope = { ...lifecycleEnvelope({ id: 'task-fence-inspect' }), requestId: 'req-r', attemptId: 'attempt-r' }

  // inspect() recovers the record (cwd mismatch) and caches it without dispatching.
  const seen = await adapter.inspect(envelope)
  assert.equal(seen.known, true)
  assert.equal(seen.recovered, true)
  assert.equal(host.calls.prompt.length, 0)

  // A reconsider on that already-cached record must still re-prove the cwd.
  await expectRefusal(adapter.reconsider(envelope, {}), 'adapter/recovery-unsafe')
  await expectRefusal(adapter.reconsider(envelope, {}), 'adapter/recovery-unsafe')
  assert.equal(host.calls.prompt.length, 0)
  assert.equal(host.calls.create.length, 1)
})

test('repeated reconsider after a failed guard restore refuses every time and never dispatches', async () => {
  const host = createFakeHost({
    durableEvents: BOUND_TURN_SETTLED,
    initialStatus: 'idle',
    guardFails: true,
    listenerUnavailable: true
  })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const envelope = lifecycleEnvelope({ id: 'task-fence-guard' })

  await expectRefusal(adapter.reconsider(envelope, {}), 'adapter/recovery-unsafe')
  assert.equal(host.calls.prompt.length, 0)

  // The cached record must not skip the guard fence on a repeat.
  await expectRefusal(adapter.reconsider(envelope, {}), 'adapter/recovery-unsafe')
  assert.equal(host.calls.prompt.length, 0, 'an unguarded recovered session must never be dispatched to')
  assert.equal(host.calls.create.length, 1)
})

test('a recovered reconsider refuses when the durable route is not positively proven', async () => {
  const host = createFakeHost({ durableEvents: BOUND_TURN_NO_MODEL, initialStatus: 'idle' })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const envelope = lifecycleEnvelope({ id: 'task-fence-model' })

  await expectRefusal(adapter.reconsider(envelope, {}), 'adapter/recovery-unsafe')
  await expectRefusal(adapter.reconsider(envelope, {}), 'adapter/recovery-unsafe')
  assert.equal(host.calls.prompt.length, 0)
})

test('a verified recovered session stays usable and a repeated clarification never re-dispatches', async () => {
  const host = createFakeHost({ durableEvents: BOUND_TURN_SETTLED, initialStatus: 'idle' })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const envelope = lifecycleEnvelope({ id: 'task-fence-ok' })

  const receipt = await adapter.reconsider(envelope, {})
  assert.equal(receipt.sessionId, 'session-1')
  assert.equal(receipt.attemptId, 'attempt-c2')
  assert.equal(receipt.mode, 'understanding')
  assert.equal(receipt.idempotentReplay, false)
  assert.equal(host.calls.prompt.length, 1)
  assert.equal(host.calls.create.length, 1)
  assert.equal(host.calls.prompt[0].text, 'CLARIFICATION PROMPT')
  assert.equal(host.calls.inspect.length >= 1, true, 'recovery and the trust re-check both read durable evidence')

  // The same clarification attempt replayed on the verified recovered session
  // returns the stored receipt and never dispatches a second prompt.
  const replay = await adapter.reconsider(envelope, {})
  assert.equal(replay.idempotentReplay, true)
  assert.equal(replay.attemptId, 'attempt-c2')
  assert.equal(replay.requestId, receipt.requestId)
  assert.equal(host.calls.prompt.length, 1, 'a repeated valid clarification must not re-dispatch')
})

// ---------------------------------------------------------------------------
// defect 2: strict queue shape and any-item blocking
// ---------------------------------------------------------------------------

/** A settled understanding task (known-empty queue) on a live idle session. */
async function settledUnderstanding(host, adapter, id) {
  const started = await adapter.start(makeEnvelope({ id, prompt: 'UNDERSTANDING PROMPT', packet: UNDERSTANDING_PACKET }))
  claimAndSettle(host, started.sessionId, started.requestId, 1)
  return started
}

test('lifecycle refuses a malformed or missing queue array instead of reading it as empty', async () => {
  const mutations = [
    ['missing nextStep', (inbox) => { delete inbox.nextStep }],
    ['missing nextTurn', (inbox) => { delete inbox.nextTurn }],
    ['non-array nextTurn', (inbox) => { inbox.nextTurn = { length: 0 } }],
    ['non-array nextStep', (inbox) => { inbox.nextStep = 'not-an-array' }]
  ]
  for (const [label, mutate] of mutations) {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    const started = await settledUnderstanding(host, adapter, `task-fence-shape`)
    mutate(host.inboxOf(started.sessionId))
    await expectRefusal(adapter.reconsider(lifecycleEnvelope({ id: 'task-fence-shape', packet: UNDERSTANDING_PACKET, attemptId: 'attempt-c2' }), {}), 'adapter/host-state-unknown')
    assert.equal(host.calls.prompt.length, 1, `${label}: no clarification may dispatch`)
  }
})

test('lifecycle blocks any queued session item, including foreign and rpcId-less messages', async () => {
  const queued = [
    ['foreign rpcId', (inbox) => inbox.nextTurn.push({ id: 'm-foreign', source: { kind: 'user', rpcId: 'someone-else-request' } })],
    ['no rpcId', (inbox) => inbox.nextTurn.push({ id: 'm-nosource', content: 'unowned' })],
    ['steering placement', (inbox) => inbox.nextStep.push({ id: 'm-step', source: { kind: 'user', rpcId: 'foreign-step' } })],
    ['malformed entry', (inbox) => inbox.nextTurn.push(null)]
  ]
  for (const [label, enqueue] of queued) {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    const started = await settledUnderstanding(host, adapter, 'task-fence-queue')
    enqueue(host.inboxOf(started.sessionId))
    await assert.rejects(adapter.reconsider(lifecycleEnvelope({ id: 'task-fence-queue', packet: UNDERSTANDING_PACKET, attemptId: 'attempt-c2' }), {}), (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      const blockers = error.details !== undefined && Array.isArray(error.details.blockers) ? error.details.blockers : []
      assert.ok(blockers.includes('queued-items'), `${label}: queued-items blocker`)
      return true
    })
    assert.equal(host.calls.prompt.length, 1, `${label}: a queued session item must block the clarification`)
  }
})

test('lifecycle proof reads the CURRENT live queue, not a stale record.agent', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstanding(host, adapter, 'task-fence-fresh')

  // The cached record still points at the original agent (empty queue). The
  // CURRENT live agent for the session already holds a same-session item.
  const replacement = host.replaceAgent(started.sessionId)
  replacement.inbox.nextTurn.push({ id: 'm-late', source: { kind: 'user', rpcId: 'late-request' } })

  await assert.rejects(adapter.reconsider(lifecycleEnvelope({ id: 'task-fence-fresh', packet: UNDERSTANDING_PACKET, attemptId: 'attempt-c2' }), {}), (error) => {
    assert.equal(error.code, 'adapter/host-not-settled')
    assert.equal(error.dispatched, false)
    const details = error.details !== undefined && error.details !== null ? error.details : {}
    const blockers = Array.isArray(details.blockers) ? details.blockers : []
    // The CURRENT queued work blocks, and the stricter guarded-agent identity
    // proof additionally reports the replacement as a bounded refusal.
    assert.ok(blockers.includes('queued-items'), 'current queued work must block')
    assert.ok(blockers.includes('guarded-agent-replaced'), 'the replaced guarded agent must be detected')
    return true
  })
  assert.equal(host.calls.prompt.length, 1, 'the stale empty inbox must not authorise a dispatch')
  assert.equal(host.calls.create.length, 1, 'no session is created for a replacement refusal')
  assert.equal(replacement.inbox.nextTurn.length, 1, 'the queued item is left alone')
})

test('cancellation stays owned-only and leaves foreign queued items alone', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstanding(host, adapter, 'task-fence-cancel')
  host.inboxOf(started.sessionId).nextTurn.push({ id: 'm-foreign', source: { kind: 'user', rpcId: 'not-ours' } })

  const outcome = await adapter.cancel(makeEnvelope({ id: 'task-fence-cancel', sessionId: started.sessionId }))
  assert.equal(outcome.stopConfirmed, true)
  assert.equal(
    outcome.actions.some((action) => action.kind === 'queue-remove' && action.itemId === 'm-foreign'),
    false,
    'the owned-only cancellation helper must not claim a foreign queued item'
  )
  assert.equal(host.inboxOf(started.sessionId).nextTurn.length, 1, 'a foreign item is not cancelled by this task')
  assert.equal(host.calls.prompt.length, 1)
})

test('lifecycle accepts a positively known-empty queue', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstanding(host, adapter, 'task-fence-empty')
  const inbox = host.inboxOf(started.sessionId)
  assert.deepEqual(inbox.nextTurn, [])
  assert.deepEqual(inbox.nextStep, [])

  const receipt = await adapter.reconsider(lifecycleEnvelope({ id: 'task-fence-empty', packet: UNDERSTANDING_PACKET, attemptId: 'attempt-c2' }), {})
  assert.equal(receipt.mode, 'understanding')
  assert.equal(receipt.sessionId, started.sessionId)
  assert.equal(host.calls.prompt.length, 2, 'the clarification dispatches on a known-empty queue')
})

// ---------------------------------------------------------------------------
// defect 3 (repair round 2): the guard's agent identity must still be the LIVE
// agent, and a throwing queue entry getter must never escape as a raw error
// ---------------------------------------------------------------------------

/** Blockers reported by a typed refusal. */
function blockersOf(error) {
  const details = error.details !== undefined && error.details !== null ? error.details : {}
  return Array.isArray(details.blockers) ? details.blockers : []
}

test('lifecycle refuses an absent guarded live agent before any prompt or state mutation', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstanding(host, adapter, 'task-fence-absent')
  const before = await adapter.inspect(makeEnvelope({ id: 'task-fence-absent' }))

  // The live agent for the owned session disappears. A real host would RESUME it
  // on `sessionController.prompt`, so the restored guard would not cover it.
  host.agents.delete(started.sessionId)
  assert.equal(host.agents.get(started.sessionId), undefined, 'the live agent is positively absent')

  await assert.rejects(
    adapter.reconsider(lifecycleEnvelope({ id: 'task-fence-absent', packet: UNDERSTANDING_PACKET, attemptId: 'attempt-c2' }), {}),
    (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(blockersOf(error).includes('guarded-agent-absent'), 'the absent guarded agent must block')
      return true
    }
  )
  assert.equal(host.calls.prompt.length, 1, 'an absent live agent is never prompted')
  assert.equal(host.calls.create.length, 1, 'no session is created or resumed for the refusal')

  const after = await adapter.inspect(makeEnvelope({ id: 'task-fence-absent' }))
  assert.equal(after.attempts.length, before.attempts.length, 'no attempt is minted before the refusal')
  assert.equal(after.currentAttemptId, before.currentAttemptId, 'the current attempt is untouched')
  assert.equal(after.stopConfirmed, before.stopConfirmed, 'stopConfirmed is not cleared')
  assert.equal(after.status, before.status, 'the reported status is unchanged')
})

test('lifecycle refuses a replaced live agent with an empty queue before any prompt or state mutation', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstanding(host, adapter, 'task-fence-replaced')
  const before = await adapter.inspect(makeEnvelope({ id: 'task-fence-replaced' }))

  const guarded = host.agents.get(started.sessionId)
  const replacement = host.replaceAgent(started.sessionId)
  assert.notEqual(replacement, guarded, 'the live agent object really was replaced')
  assert.deepEqual(replacement.inbox.nextTurn, [], 'the replacement queue is empty')
  assert.deepEqual(replacement.inbox.nextStep, [], 'the replacement steering queue is empty')

  await assert.rejects(
    adapter.reconsider(lifecycleEnvelope({ id: 'task-fence-replaced', packet: UNDERSTANDING_PACKET, attemptId: 'attempt-c2' }), {}),
    (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(blockersOf(error).includes('guarded-agent-replaced'), 'the replaced guarded agent must block')
      return true
    }
  )
  assert.equal(host.calls.prompt.length, 1, 'a replaced, unguarded agent is never prompted')
  assert.equal(host.calls.create.length, 1, 'no replacement session is created')

  const after = await adapter.inspect(makeEnvelope({ id: 'task-fence-replaced' }))
  assert.equal(after.attempts.length, before.attempts.length, 'no attempt is minted before the refusal')
  assert.equal(after.currentAttemptId, before.currentAttemptId, 'the current attempt is untouched')
  assert.equal(after.stopConfirmed, before.stopConfirmed, 'stopConfirmed is not cleared')
})

test('lifecycle accepts a clarification while the live agent is still the guarded one', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstanding(host, adapter, 'task-fence-control')
  const guarded = host.agents.get(started.sessionId)

  const receipt = await adapter.reconsider(
    lifecycleEnvelope({ id: 'task-fence-control', packet: UNDERSTANDING_PACKET, attemptId: 'attempt-c2' }),
    {}
  )
  assert.equal(receipt.mode, 'understanding')
  assert.equal(receipt.sessionId, started.sessionId)
  assert.equal(host.calls.prompt.length, 2, 'the unchanged guarded agent remains a valid dispatch target')
  assert.equal(host.calls.create.length, 1)
  assert.equal(host.agents.get(started.sessionId), guarded, 'the guard-bearing agent is still the live one')
})

test('a throwing queue entry getter is a typed refusal, never a raw error, and never archives', async () => {
  const entries = [
    [
      'id getter',
      () => {
        const entry = {}
        Object.defineProperty(entry, 'id', {
          configurable: true,
          get() {
            throw new Error('id unavailable')
          }
        })
        return entry
      }
    ],
    [
      'source getter',
      () => {
        const entry = { id: 'm-bad' }
        Object.defineProperty(entry, 'source', {
          configurable: true,
          get() {
            throw new Error('source unavailable')
          }
        })
        return entry
      }
    ],
    [
      'source.rpcId getter',
      () => {
        const source = {}
        Object.defineProperty(source, 'rpcId', {
          configurable: true,
          get() {
            throw new Error('rpcId unavailable')
          }
        })
        return { id: 'm-bad', source }
      }
    ]
  ]
  for (const [label, makeEntry] of entries) {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    const started = await settledUnderstanding(host, adapter, 'task-fence-throwing')
    host.inboxOf(started.sessionId).nextTurn.push(makeEntry())

    await assert.rejects(
      adapter.reconsider(lifecycleEnvelope({ id: 'task-fence-throwing', packet: UNDERSTANDING_PACKET, attemptId: 'attempt-c2' }), {}),
      (error) => {
        assert.equal(error.code, 'adapter/host-state-unknown', `${label}: a typed refusal, not a raw error`)
        assert.equal(error.dispatched, false, `${label}: dispatched is false`)
        return true
      }
    )
    assert.equal(host.calls.prompt.length, 1, `${label}: no clarification prompt`)
    assert.equal(host.calls.create.length, 1, `${label}: no session created`)

    // Archive must stay a non-success RESULT (no raw pre-dispatch throw).
    const archive = await adapter.archive(makeEnvelope({ id: 'task-fence-throwing', revision: 1 }))
    assert.equal(archive.archived, false, `${label}: archive stays a non-success result`)
    assert.equal(archive.uiHidden, false, `${label}: nothing is hidden`)
    assert.equal(archive.outcome, 'unknown', `${label}: the unknown queue keeps the archive unresolved`)
  }
})

test('archive still hides a settled session whose live agent is positively absent', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstanding(host, adapter, 'task-fence-arch-absent')
  // Archive keeps its OWN absent-agent eligibility: the dispatch-only guarded
  // agent fence must not be inherited by archive.
  host.agents.delete(started.sessionId)

  const out = await adapter.archive(makeEnvelope({ id: 'task-fence-arch-absent', revision: 1 }))
  assert.equal(out.archived, true, 'a positively absent agent with a settled durable record stays archivable')
  assert.equal(out.uiHidden, true)
  assert.deepEqual(host.archivedSessions, [started.sessionId])
  assert.equal(host.calls.prompt.length, 1, 'archive never prompts')
})

// Native takeover: the execution continuation needs the same current-agent and
// recovered-trust proofs as clarification, before minting an execution attempt.
for (const defect of ['absent', 'replaced']) {
  test(`native continue refuses an ${defect} guarded agent without mutating the attempt`, async (t) => {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    t.after(() => adapter.dispose())
    const id = `native-continue-${defect}`
    const started = await settledUnderstanding(host, adapter, id)
    const before = await adapter.inspect(makeEnvelope({ id }))
    const guarded = host.agents.get(started.sessionId)
    if (defect === 'absent') host.agents.delete(started.sessionId)
    else {
      const replacement = host.replaceAgent(started.sessionId)
      assert.notEqual(replacement, guarded)
      assert.deepEqual(replacement.inbox, { nextTurn: [], nextStep: [] })
    }
    await assert.rejects(adapter.continue(makeEnvelope({
      id, sessionId: started.sessionId, attemptId: 'native-execution', packet: UNDERSTANDING_PACKET
    }), 'approved'), (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(blockersOf(error).includes(`guarded-agent-${defect}`))
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
    assert.equal(host.calls.create.length, 1)
    const after = await adapter.inspect(makeEnvelope({ id }))
    assert.equal(after.attempts.length, before.attempts.length)
    assert.equal(after.currentAttemptId, before.currentAttemptId)
    assert.equal(after.stopConfirmed, before.stopConfirmed)
    assert.equal(after.status, before.status)
  })
}

test('native continue keeps the same guarded live agent usable', async (t) => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  t.after(() => adapter.dispose())
  const id = 'native-continue-positive'
  const started = await settledUnderstanding(host, adapter, id)
  const guarded = host.agents.get(started.sessionId)
  const receipt = await adapter.continue(makeEnvelope({
    id, sessionId: started.sessionId, attemptId: 'native-execution', packet: UNDERSTANDING_PACKET
  }), 'approved')
  assert.equal(receipt.mode, 'execution')
  assert.equal(receipt.attemptId, 'native-execution')
  assert.equal(receipt.sessionId, started.sessionId)
  assert.notEqual(receipt.requestId, started.requestId)
  assert.equal(host.agents.get(started.sessionId), guarded)
  assert.equal(host.calls.prompt.length, 2)
  assert.equal(host.calls.create.length, 1)
})

for (const [defect, options] of [
  ['cwd-mismatch', { durableCwd: OUTSIDE }],
  ['guard-unrestorable', { guardFails: true, listenerUnavailable: true }],
  ['missing-model', { durableEvents: BOUND_TURN_NO_MODEL }]
]) {
  test(`native continue refuses ${defect} recovery on first call and cached retries`, async (t) => {
    const host = createFakeHost({ initialStatus: 'idle', durableEvents: BOUND_TURN_SETTLED, ...options })
    await host.ctx.get('sessionController').create({ cwd: ROOT })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    t.after(() => adapter.dispose())
    const envelope = { ...lifecycleEnvelope({ id: `native-recovery-${defect}` }), requestId: 'req-r', attemptId: 'attempt-r' }
    await expectRefusal(adapter.continue(envelope, 'approved'), 'adapter/recovery-unsafe')
    const before = await adapter.inspect(envelope)
    assert.equal(before.recovered, true)
    await expectRefusal(adapter.continue(envelope, 'approved'), 'adapter/recovery-unsafe')
    const after = await adapter.inspect(envelope)
    assert.equal(after.attempts.length, before.attempts.length)
    assert.equal(after.currentAttemptId, before.currentAttemptId)
    assert.equal(host.calls.prompt.length, 0)
    assert.equal(host.calls.create.length, 1)
  })
}

test('native continue rechecks durable trust after inspect cached a valid recovery', async (t) => {
  const host = createFakeHost({ initialStatus: 'idle', durableEvents: BOUND_TURN_SETTLED })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  t.after(() => adapter.dispose())
  const envelope = { ...lifecycleEnvelope({ id: 'native-recovery-fresh' }), requestId: 'req-r', attemptId: 'attempt-r' }
  const before = await adapter.inspect(envelope)
  assert.equal(before.recovered, true)
  const controller = host.ctx.get('sessionController')
  const inspect = controller.inspect
  controller.inspect = async (...args) => {
    const result = await inspect(...args)
    return { ...result, meta: { ...result.meta, cwd: OUTSIDE } }
  }
  await expectRefusal(adapter.continue(envelope, 'approved'), 'adapter/recovery-unsafe')
  const after = await adapter.inspect(envelope)
  assert.equal(after.attempts.length, before.attempts.length)
  assert.equal(after.currentAttemptId, before.currentAttemptId)
  assert.equal(host.calls.prompt.length, 0)
  assert.equal(host.calls.create.length, 1)
})

test('native continue permits a trusted recovered guarded session', async (t) => {
  const host = createFakeHost({ initialStatus: 'idle', durableEvents: BOUND_TURN_SETTLED })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  t.after(() => adapter.dispose())
  const envelope = { ...lifecycleEnvelope({ id: 'native-recovery-positive' }), requestId: 'req-r', attemptId: 'attempt-r' }
  const guarded = host.agents.get('session-1')
  const receipt = await adapter.continue(envelope, 'approved')
  assert.equal(receipt.mode, 'execution')
  assert.equal(receipt.sessionId, 'session-1')
  assert.equal(host.agents.get('session-1'), guarded)
  assert.equal(host.calls.prompt.length, 1)
  assert.equal(host.calls.create.length, 1)
})
