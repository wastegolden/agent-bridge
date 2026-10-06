// test/recurrent-supervisor.test.mjs
//
// Targeted tests for the bounded RECURRENT supervisor + durable pause/resume checkpoint
// (contract bounded-recurrent-supervisor-v1). They exercise the real runtime over a REAL
// TaskStore with a service double that mirrors the two seams the runtime depends on:
// `kick()` (the drain that dispatches a freshly queued round) and `onTaskSettled` /
// `onSupervisorFinished` (the real settlement callbacks). No model is invoked, no shell,
// no network: the round boundaries are driven explicitly so every transition is observable.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { TaskStore } from '../src/store.mjs'
import { BridgeService } from '../src/service.mjs'
import { digest, validatePacket } from '../src/contracts.mjs'
import { BridgeSupervisor, HostReservationLedger } from '../src/supervisor.mjs'
import { TOOLS } from '../src/mcp.mjs'
import {
  PROJECT_PAUSING,
  PROJECT_PAUSED,
  PROJECT_WAITING,
  SupervisorProjectRuntime,
  buildRoundPrompt,
  createProjectRecord,
  normalizeProjectConfig,
  resolveProjectGrant
} from '../src/long-task.mjs'

const MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })

/** One service double: real TaskStore writes, real ledger accounting, real settle hooks. */
class RoundService {
  constructor(store, { ledger, now } = {}) {
    this.store = store
    this.ledger = ledger ?? null
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.projects = null
    this.submitted = []
    this.cancelled = []
    this.kicks = 0
    this.roundRequests = []
  }

  attachProjects(projects) {
    this.projects = projects
    return this
  }

  #reserve(id) {
    if (this.ledger === null) return
    this.ledger.reserve({ key: `task:${id}`, kind: 'root', taskId: id })
  }

  #release(id) {
    if (this.ledger === null) return
    const key = `task:${id}`
    if (this.ledger.has(key)) this.ledger.release(key, { stopConfirmed: true, reason: 'stub settlement' })
  }

  async submitProject(packet, config, callbackBinding = { grantId: 'grant-1', targetId: 'target-1', boundAt: 1 }) {
    const p = validatePacket(packet)
    const grant = resolveProjectGrant(p.project, config)
    const record = createProjectRecord({ packet: p, grant, now: this.now() })
    const result = this.store.submit(p, { effectiveModel: { ...MODEL }, callbackBinding, project: record })
    if (result.created) {
      this.#reserve(result.task.id)
      if (this.projects && typeof this.projects.admitProject === 'function') this.projects.admitProject(result.task.id)
    }
    return result.task
  }

  /** The real bounded WORKER task path: a durable bridge task per worker attempt. */
  async submit(packet) {
    const p = validatePacket(packet)
    const result = this.store.submit(p, { effectiveModel: p.model ?? { ...MODEL } })
    if (result.created) this.submitted.push({ id: result.task.id, packet: p })
    const task = this.store.get(result.task.id)
    return { id: task.id, status: task.status, sessionId: null, workspace: null }
  }

  /** The runtime asks the drain to pick up a freshly queued round. */
  kick() {
    this.kicks += 1
    for (const task of this.store.list()) {
      if (task.continuationKind !== 'supervisor-round' || task.status !== 'queued') continue
      if (this.roundRequests.some((entry) => entry.attemptId === task.attemptId)) continue
      this.roundRequests.push({ taskId: task.id, attemptId: task.attemptId, round: task.project.pendingRound?.index ?? null })
    }
  }

  /** Mirror the REAL adapter+service accepting this round on the SAME owned session. */
  acceptRound(taskId) {
    const task = this.store.get(taskId)
    assert.equal(task.continuationKind, 'supervisor-round', 'only a minted round is dispatched')
    this.store.update(taskId, {
      status: 'running',
      phase: 'project',
      dispatchStarted: true,
      dispatchPending: false,
      dispatchReceiptAt: this.now(),
      sessionId: 'session-1'
    })
    return task.attemptId
  }

  /** The round's model turn ended with a positively proven stop. */
  finishRound(taskId, { status = 'completed', text = 'round done', toolCalls, unreadableStats = false } = {}) {
    const task = this.store.get(taskId)
    if (unreadableStats) this.store.update(taskId, { stats: {} })
    else if (Number.isInteger(toolCalls)) this.store.update(taskId, { stats: { ...task.stats, toolCalls } })
    const current = this.store.get(taskId)
    return this.projects.onSupervisorFinished(taskId, { status, text, finalText: text, stopConfirmed: true, activeJobs: 0, activeChildren: 0 }, current.attemptId)
  }

  /** A LOCAL adapter refusal: nothing crossed the host boundary. */
  failRoundLocally(taskId, code) {
    const task = this.store.get(taskId)
    return this.projects.onSupervisorFinished(taskId, { status: 'failed', text: 'refused', error: { code, message: code }, stopConfirmed: true, activeJobs: 0, activeChildren: 0 }, task.attemptId)
  }

  async cancel(id, reason) {
    const task = this.store.get(id)
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return { accepted: false, alreadyFinished: true }
    this.cancelled.push({ id, reason })
    this.store.update(id, { status: 'cancelled', phase: 'cancelled', stopConfirmed: true, activeJobs: 0, endedAt: this.now() })
    this.#release(id)
    await this.projects.onTaskSettled(this.store.get(id))
    return { accepted: true, stopConfirmed: true }
  }

  /** One worker task settled, exactly like BridgeService.finish's worker path. */
  async settle(id, { status = 'completed', text = 'worker done', toolCalls = 0 } = {}) {
    const task = this.store.get(id)
    this.store.update(id, {
      status,
      phase: status,
      stopConfirmed: true,
      activeJobs: 0,
      activeChildren: 0,
      stats: { ...task.stats, toolCalls },
      result: { text, evidence: [], checks: [], uncertainties: [] }
    })
    this.#release(id)
    await this.projects.onTaskSettled(this.store.get(id))
  }
}

function makeEnv({ config = {}, ledgerLimit = 16, clock = { value: 1_700_000_000_000 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recurrent-'))
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recurrent-repo-'))
  const store = new TaskStore({ directory: dir, ownerId: 'owner-recurrent' })
  const ledger = new HostReservationLedger({ limit: ledgerLimit, id: `recurrent-${Math.random()}` })
  const sinkCalls = []
  const supervisor = new BridgeSupervisor({
    ledger,
    ownerId: 'owner-recurrent',
    config: { notificationSink: (event) => { sinkCalls.push(event); return { ok: true, event: { state: 'pending' } } } }
  })
  const workspaces = { inspect: async () => ({ head: 'b'.repeat(40), dirty: false, changedPaths: [] }) }
  const projectConfig = normalizeProjectConfig({ enabled: true, ...config })
  const now = () => clock.value
  // A deterministic timer seam: expiry is driven by the injected clock, never by a real
  // wall-clock timer, so every deadline assertion is reproducible.
  const setTimer = (fn, ms) => ({ fn, ms })
  const clearTimer = () => {}
  const service = new RoundService(store, { ledger, now })
  const runtime = new SupervisorProjectRuntime({ store, service, workspaces, supervisor, config: projectConfig, now, setTimer, clearTimer })
  service.attachProjects(runtime)
  return { dir, repository, store, ledger, supervisor, workspaces, projectConfig, service, runtime, sinkCalls, clock }
}

function projectPacket(repository, projectOverrides = {}, idempotencyKey = 'project-1') {
  return {
    schemaVersion: 1,
    idempotencyKey,
    revision: 1,
    projectId: 'pj-recurrent',
    title: 'recurrent project',
    objective: 'deliver the bounded goal across rounds',
    cwd: repository,
    role: 'investigate',
    acceptance: ['every round consumes real worker results'],
    scope: { readRoots: [repository], writeRoots: [], allowedTools: ['read', 'glob', 'grep'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [],
    contractVersion: 'bounded-recurrent-supervisor-v1',
    rootCallback: { grantId: 'grant-1' },
    project: {
      maxWorkers: 8,
      maxConcurrentWorkers: 3,
      maxRepairAttempts: 2,
      maxTotalRetries: 64,
      maxWorkerStarts: 64,
      maxTotalToolCalls: 10000,
      timeoutMs: 3_600_000,
      reserveSlots: 1,
      workerScope: {
        readRoots: [repository],
        writeRoots: [repository],
        allowedTools: ['read', 'write', 'edit'],
        allowNetwork: false,
        budgets: { timeoutMs: 600000, maxToolCalls: 2, maxOutputChars: 200000 }
      },
      workspace: { repository, baseRef: 'HEAD' },
      ...projectOverrides
    }
  }
}

async function planTwo(env, taskId) {
  const { runtime } = env
  runtime.workerCreate({ taskId, args: { workerKey: 'reader-a', objective: 'read a', role: 'review', tools: ['read'] } })
  runtime.workerCreate({ taskId, args: { workerKey: 'reader-b', objective: 'read b', role: 'review', tools: ['read'] } })
  const frozen = runtime.planFinalize({ taskId })
  assert.equal(frozen.workerCount, 2)
}

function workerTasks(env, taskId) {
  return env.store.get(taskId).project.workers.map((worker) => worker.attempts[0]?.taskId ?? null)
}

/**
 * Bounded poll for an ASYNCHRONOUSLY scheduled transition (the runtime schedules work on
 * its own serialized chain, so a test must never assume a transition is already recorded
 * the instant a control call returns). A timeout throws with the current state attached,
 * so a genuinely missing transition is a real failure with evidence, never a silent pass.
 */
async function waitForState(read, predicate, { timeoutMs = 5000, label = 'state' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (predicate(value)) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value?.project ?? value ?? null).slice(0, 400)}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------
// legacy compatibility
// ---------------------------------------------------------------------------

test('a legacy project packet keeps its exact normalized bytes, digest and duplicate submission', async () => {
  const env = makeEnv()
  const packet = projectPacket(env.repository)
  const normalized = validatePacket(packet)
  assert.equal(Object.hasOwn(normalized.project, 'maxRounds'), false, 'an absent maxRounds is never injected into the normalized packet')

  const task = await env.service.submitProject(packet, env.projectConfig)
  assert.equal(task.requestHash, digest(validatePacket(packet)), 'the stored SQL idempotency hash is unchanged for a legacy packet')
  const stored = env.store.get(task.id)
  assert.equal(Object.hasOwn(stored.packet.project, 'maxRounds'), false)
  assert.equal(stored.project.grant.maxRounds, 1)
  assert.notEqual(stored.project.grant.recurrent, true)
  assert.equal(stored.project.grant.pause, false)

  // Repeating the identical submission after the upgrade reuses the SAME task, attempt
  // and hash: no second task, no redispatch, no conflict.
  const again = await env.service.submitProject(packet, env.projectConfig)
  assert.equal(again.id, task.id)
  const after = env.store.get(task.id)
  assert.equal(after.attemptId, stored.attemptId)
  assert.equal(after.attempt, stored.attempt)
  assert.equal(after.requestHash, stored.requestHash)

  // Defaults stay off: the historical plan-once capability and tool surface only.
  const status = env.runtime.status()
  assert.equal(status.firstEdition.singleRound, true)
  assert.equal(status.firstEdition.recurrentReasoning, false)
  assert.equal(status.recurrence.enabled, false)
  assert.equal(status.tools.includes('dsh_supervisor_project_complete'), false)
  assert.equal(status.tools.includes('dsh_supervisor_project_block'), false)
  assert.ok(status.tools.includes('dsh_supervisor_worker_create'))
  await env.runtime.close()
})

test('maxRounds is bounded to 1..8 on the packet and refused above the host cap', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recurrent-repo-'))
  assert.throws(() => validatePacket(projectPacket(repository, { maxRounds: 9 })), { code: 'INVALID_PACKET' })
  assert.throws(() => validatePacket(projectPacket(repository, { maxRounds: 0 })), { code: 'INVALID_PACKET' })
  const normalized = validatePacket(projectPacket(repository, { maxRounds: 4 }))
  assert.equal(normalized.project.maxRounds, 4)
  // A host at the default ceiling refuses an explicit recurrence request instead of clamping.
  assert.throws(() => resolveProjectGrant(normalized.project, normalizeProjectConfig({ enabled: true })), { code: 'project/host-cap' })
  const granted = resolveProjectGrant(normalized.project, normalizeProjectConfig({ enabled: true, maxRounds: 4 }))
  assert.equal(granted.maxRounds, 4)
  assert.equal(granted.recurrent, true)
  assert.equal(granted.pause, false, 'pause stays off unless the host enables it')
})

test('bridge_pause and bridge_resume are advertised with bounded required arguments', () => {
  const pause = TOOLS.find((entry) => entry.name === 'bridge_pause')
  const resume = TOOLS.find((entry) => entry.name === 'bridge_resume')
  assert.ok(pause)
  assert.ok(resume)
  assert.deepEqual(pause.inputSchema.required, ['taskId', 'requestId'])
  assert.deepEqual(resume.inputSchema.required, ['taskId', 'requestId'])
  assert.deepEqual(Object.keys(pause.inputSchema.properties).sort(), ['reason', 'requestId', 'taskId'])
})

// ---------------------------------------------------------------------------
// two genuine guarded rounds
// ---------------------------------------------------------------------------

test('two genuine rounds consume real worker results and the first wave never completes the goal', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)

  await env.service.finishRound(task.id, { text: 'plan frozen', toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  let project = env.store.get(task.id).project
  assert.equal(project.roundsUsed, 1)
  assert.equal(project.pendingRound, null)
  assert.equal(env.store.get(task.id).status, PROJECT_WAITING)
  assert.notEqual(project.status, 'completed', 'a completed first wave is not the whole goal')

  // The workers are REAL bounded bridge tasks; settle them with real results.
  const [a, b] = workerTasks(env, task.id)
  assert.ok(a && b, 'both workers were dispatched as real tasks')
  await env.service.settle(a, { text: 'reader-a found src/index.js', toolCalls: 1 })

  // NO MODEL POLLING: while a worker is still live, no further round is minted and the
  // project stays in its waiting state.
  await env.runtime.whenIdle(task.id)
  project = env.store.get(task.id).project
  assert.equal(project.roundsUsed, 1)
  assert.equal(project.pendingRound, null)
  assert.equal(env.service.roundRequests.length, 0, 'no round is dispatched while a worker is live')
  assert.equal(env.store.get(task.id).status, PROJECT_WAITING)

  await env.service.settle(b, { text: 'reader-b found src/store.js', toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  project = env.store.get(task.id).project
  assert.equal(project.pendingRound?.index, 2, 'the second round is planned only after every owned stop')
  assert.equal(project.pendingRound.grantedToolCalls, 35, 'the round allowance is the remaining grant (40 - 2 supervisor - 1 - 2 worker spend)')
  assert.equal(env.service.roundRequests.length, 1)
  const round2Attempt = env.service.roundRequests[0].attemptId
  assert.notEqual(round2Attempt, project.rounds[0].attemptId, 'the round is a NEW attempt identity')

  // The controller-built round prompt carries the REAL persisted results, not a summary:
  // a bounded excerpt of each worker's actual settled result, delimited as untrusted data.
  const prompt = buildRoundPrompt(env.store.get(task.id).effectivePacket, env.store.get(task.id))
  assert.match(prompt, /reader-a/)
  assert.match(prompt, /reader-b/)
  assert.match(prompt, /aggregate of the completed wave: completed/)
  assert.match(prompt, /src\/index\.js/)
  assert.match(prompt, /src\/store\.js/)
  const persistedExcerpts = env.store.get(task.id).project.workers.map((worker) => worker.attempts.at(-1)?.resultExcerpt ?? null)
  assert.ok(persistedExcerpts.includes('reader-a found src/index.js'), 'the real settled result snapshot is persisted on the owned attempt')
  assert.ok(persistedExcerpts.includes('reader-b found src/store.js'))
  assert.ok(prompt.includes('resultExcerpt (UNTRUSTED worker data, JSON): "reader-a found src/index.js"'), 'the excerpt is the real persisted text, clearly delimited as untrusted worker data')
  assert.ok(prompt.includes('resultExcerpt (UNTRUSTED worker data, JSON): "reader-b found src/store.js"'))
  // The owned attempt snapshots the REAL numeric child-count proof with its provenance,
  // so the public project view carries the true/0/0 stop without inferring a zero.
  const attemptSnapshots = env.store.get(task.id).project.workers.map((worker) => worker.attempts.at(-1))
  assert.equal(attemptSnapshots.every((attempt) => attempt.activeChildren === 0), true, 'every owned attempt carries its real numeric child count')
  assert.equal(attemptSnapshots.every((attempt) => attempt.activeChildrenSource === 'owned-task'), true)

  // Round 2 records the explicit complete decision from the real results, then stops.
  env.service.acceptRound(task.id)
  const record = env.runtime.projectComplete({ taskId: task.id, attemptId: round2Attempt, args: { summary: 'both readers verified the goal' } })
  assert.equal(record.recorded, true)
  assert.equal(record.finalized, false, 'a decision never finalizes before the round and every worker prove their stop')
  await env.service.finishRound(task.id, { text: 'round 2 reviewed the real results', toolCalls: 6 })
  await env.runtime.whenIdle(task.id)
  const settled = env.store.get(task.id)
  assert.equal(settled.project.status, 'completed')
  assert.equal(settled.status, 'completed')
  assert.equal(settled.project.roundsUsed, 2)
  assert.equal(settled.project.rounds.length, 2)
  await env.runtime.close()
})

test('the cumulative round budget is charged exactly once and a near-exhausted allowance is refused', async () => {
  const env = makeEnv({ config: { maxRounds: 4 } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 10 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)

  // Round 1 charges its cumulative observation once (baseline 0).
  await env.service.finishRound(task.id, { text: 'round 1', toolCalls: 3 })
  await env.runtime.whenIdle(task.id)
  let project = env.store.get(task.id).project
  assert.equal(project.budgets.supervisorToolSpend, 3)
  assert.equal(project.budgets.supervisorReserved, 0)

  // Workers reserve their full allowance (2 each), then credit their ACTUAL spend.
  const [a, b] = workerTasks(env, task.id)
  await env.service.settle(a, { toolCalls: 1 })
  await env.service.settle(b, { toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  project = env.store.get(task.id).project
  assert.equal(project.budgets.toolSpend, 3, 'worker spend is counted once')
  assert.equal(project.budgets.supervisorToolSpend, 3, 'supervisor spend is counted once and never added twice')

  // Round 2 gets exactly the remaining allowance (10 - 3 observed - 3 worker spend = 4).
  assert.equal(project.pendingRound?.index, 2)
  assert.equal(project.pendingRound.grantedToolCalls, 4)
  assert.equal(project.budgets.supervisorReserved, 4)
  assert.equal(env.store.get(task.id).effectivePacket.budget.maxToolCalls, 4, 'the round envelope is narrowed downward')

  // Round 2 charges its DELTA (cumulative 7 - baseline 3 = 4) exactly once.
  env.service.acceptRound(task.id)
  await env.service.finishRound(task.id, { text: 'round 2', toolCalls: 7 })
  await env.runtime.whenIdle(task.id)
  const settled = env.store.get(task.id)
  project = settled.project
  assert.equal(project.rounds[1].actualToolCalls, 4)
  assert.equal(project.rounds[1].charged, true)
  assert.equal(project.budgets.supervisorToolSpend, 7)
  assert.equal(project.budgets.supervisorReserved, 0)
  assert.equal(project.budgets.toolSpend, 3)
  // The bound is now exactly the cap: a third round would overspend, so the project
  // settles honestly instead of promising calls it does not have.
  assert.equal(project.status, 'failed')
  assert.equal(project.seriousIssue.code, 'project-tool-budget-exhausted')
  await env.runtime.close()
})

test('unreadable round stats conservatively consume the whole reserved cap', async () => {
  const env = makeEnv({ config: { maxRounds: 4 } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 10 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)
  await env.service.finishRound(task.id, { text: 'round 1', toolCalls: 3 })
  await env.runtime.whenIdle(task.id)
  const [a, b] = workerTasks(env, task.id)
  await env.service.settle(a, { toolCalls: 1 })
  await env.service.settle(b, { toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  const planned = env.store.get(task.id).project.pendingRound
  assert.equal(planned.grantedToolCalls, 4)

  env.service.acceptRound(task.id)
  await env.service.finishRound(task.id, { text: 'round 2', unreadableStats: true })
  await env.runtime.whenIdle(task.id)
  const project = env.store.get(task.id).project
  assert.equal(project.rounds[1].actualToolCalls, 4, 'a missing receipt charges the FULL reserved cap, never zero')
  assert.equal(project.budgets.supervisorToolSpend, 7)
  assert.equal(project.status, 'failed')
  await env.runtime.close()
})

test('a delayed callback from a superseded round never mutates the current round', async () => {
  const env = makeEnv({ config: { maxRounds: 4 } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)
  await env.service.finishRound(task.id, { text: 'round 1', toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  const round1Attempt = env.store.get(task.id).project.rounds[0].attemptId
  const [a, b] = workerTasks(env, task.id)
  await env.service.settle(a, { toolCalls: 1 })
  await env.service.settle(b, { toolCalls: 1 })
  await env.runtime.whenIdle(task.id)
  const before = env.store.get(task.id)
  assert.equal(before.project.pendingRound?.index, 2)

  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', text: 'stale round', stopConfirmed: true, activeJobs: 0, activeChildren: 0 }, round1Attempt)
  const after = env.store.get(task.id)
  assert.equal(after.project.roundsUsed, 1, 'the stale round is never recorded as the current one')
  assert.equal(after.project.pendingRound.index, 2)
  assert.equal(after.attemptId, before.attemptId)
  assert.equal(after.project.rounds.at(-1).text, 'round 1')
  const stale = env.store.events(task.id).filter((event) => event.type === 'project/round-callback-stale')
  assert.equal(stale.length, 1)
  await env.runtime.close()
})

test('the round cap is honoured without scheduling an extra decision round', async () => {
  const env = makeEnv({ config: { maxRounds: 2 } })
  const packet = projectPacket(env.repository, { maxRounds: 2, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)
  await env.service.finishRound(task.id, { text: 'round 1', toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  const [a, b] = workerTasks(env, task.id)
  await env.service.settle(a, { toolCalls: 1 })
  await env.service.settle(b, { toolCalls: 1 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.store.get(task.id).project.pendingRound?.index, 2)
  assert.equal(env.service.roundRequests.length, 1)

  env.service.acceptRound(task.id)
  await env.service.finishRound(task.id, { text: 'round 2 without a decision', toolCalls: 5 })
  await env.runtime.whenIdle(task.id)
  const settled = env.store.get(task.id)
  assert.equal(settled.project.roundsUsed, 2)
  assert.equal(settled.project.status, 'failed', 'no decision round is scheduled at the cap and no completion is fabricated')
  assert.equal(settled.project.seriousIssue.code, 'supervisor-rounds-exhausted')
  assert.equal(env.service.roundRequests.length, 1)
  await env.runtime.close()
})

// ---------------------------------------------------------------------------
// durable pause/resume
// ---------------------------------------------------------------------------

test('pause persists synchronously, blocks new admission and becomes paused only with the full proof', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)
  await env.service.finishRound(task.id, { text: 'round 1', toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  const [a, b] = workerTasks(env, task.id)
  assert.ok(a && b)

  const requested = env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-1' })
  assert.equal(requested.accepted, true)
  assert.equal(requested.state, PROJECT_PAUSING)
  assert.equal(requested.paused, false, 'pausing is never reported as paused')
  assert.equal(env.store.get(task.id).status, PROJECT_PAUSING)
  const anchor = env.store.get(task.id).project.createdAt

  // New admission is held immediately: no worker may be declared, no round is minted.
  assert.throws(() => env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'late', objective: 'late' } }), { code: 'project/paused' })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.roundRequests.length, 0, 'a pause request never dispatches a round')
  assert.equal(env.store.get(task.id).project.pendingRound, null)

  // One live worker is still enough to keep the honest pausing state.
  await env.service.settle(a, { toolCalls: 1 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.store.get(task.id).status, PROJECT_PAUSING)
  assert.equal(env.store.get(task.id).project.control.pause.state, PROJECT_PAUSING)

  await env.service.settle(b, { toolCalls: 1 })
  await env.runtime.whenIdle(task.id)
  const paused = env.store.get(task.id)
  assert.equal(paused.status, PROJECT_PAUSED)
  assert.equal(paused.project.control.pause.state, PROJECT_PAUSED)
  assert.equal(typeof paused.project.control.pause.pausedAt, 'number')
  assert.equal(paused.project.budgets.supervisorToolSpend, 2, 'the pause preserves the cumulative budget')
  assert.equal(paused.project.roundsUsed, 1)
  assert.equal(paused.project.createdAt, anchor, 'the immutable deadline anchor survives the pause')

  // An identical replay starts nothing new and returns the same state.
  const replay = env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-1' })
  assert.equal(replay.replay, true)
  assert.equal(replay.state, PROJECT_PAUSED)
  await env.runtime.close()
})

test('a project paused before its first dispatch is honestly paused, and resume continues the same record', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)
  const originalCreatedAt = env.store.get(task.id).project.createdAt
  const originalTimeout = env.store.get(task.id).project.grant.timeoutMs

  const requested = env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-first' })
  assert.equal(requested.state, PROJECT_PAUSED, 'never-dispatched work is a proven stop')
  assert.equal(env.store.get(task.id).status, PROJECT_PAUSED)

  // The real service gate refuses pause/resume on a project that did not opt in. The
  // service MUST be built over the store/runtime that actually owns the task, otherwise
  // the ownership fence reports TASK_NOT_FOUND instead of the real pause refusal.
  const service = new BridgeService({ store: env.store, adapter: { models: async () => [] }, workspaces: {}, projects: env.runtime })
  const legacyEnv = makeEnv()
  const legacyPacket = projectPacket(legacyEnv.repository, {}, 'legacy-pause')
  const legacyTask = await legacyEnv.service.submitProject(legacyPacket, legacyEnv.projectConfig)
  const legacyService = new BridgeService({ store: legacyEnv.store, adapter: { models: async () => [] }, workspaces: {}, projects: legacyEnv.runtime })
  await assert.rejects(() => legacyService.pause(legacyTask.id, { requestId: 'x' }), { code: 'PROJECT_PAUSE_UNSUPPORTED' })
  await assert.rejects(() => service.pause(task.id, { requestId: '' }), { code: 'INVALID_PAUSE' })
  await legacyEnv.runtime.close()

  const resumed = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-1' })
  assert.equal(resumed.accepted, true)
  assert.equal(resumed.resumed, true)
  await env.runtime.whenIdle(task.id)
  const after = env.store.get(task.id)
  assert.equal(after.id, task.id, 'resume continues the SAME task record')
  assert.equal(after.project.createdAt, originalCreatedAt, 'the immutable deadline anchor is never rewritten')
  assert.equal(after.project.grant.timeoutMs, originalTimeout, 'the remaining time is never extended')
  assert.equal(after.project.control.pause.state, 'none')
  // A never-dispatched plan is CONTINUED (its two real workers are submitted) rather than
  // replaced by a new round: resume is not a re-plan.
  assert.equal(env.service.submitted.length, 2, 'the paused plan dispatches its real workers on resume')
  assert.equal(env.service.roundRequests.length, 0, 'no extra round is minted for an unstarted plan')

  // A replay of the same resume request starts nothing new.
  const replay = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-1' })
  assert.equal(replay.replay, true)
  assert.equal(replay.resumed, true)
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 2)
  assert.equal(env.service.roundRequests.length, 0)
  await env.runtime.close()
})

test('resume refuses an elapsed immutable deadline and an exhausted budget, keeping the checkpoint', async () => {
  const expired = makeEnv({ config: { maxRounds: 4, pause: true } })
  const expiredPacket = projectPacket(expired.repository, { maxRounds: 4, maxTotalToolCalls: 40, timeoutMs: 1000 })
  const expiredTask = await expired.service.submitProject(expiredPacket, expired.projectConfig)
  await planTwo(expired, expiredTask.id)
  const expiredAnchor = expired.store.get(expiredTask.id).project.createdAt
  expired.runtime.pauseRequest({ taskId: expiredTask.id, requestId: 'pause-1' })
  expired.clock.value += 5000
  const refused = expired.runtime.resumeRequest({ taskId: expiredTask.id, requestId: 'resume-1' })
  assert.equal(refused.accepted, false)
  assert.equal(refused.resumed, false)
  assert.equal(refused.code, 'project/deadline-exceeded')
  await expired.runtime.whenIdle(expiredTask.id)
  const expiredAfter = expired.store.get(expiredTask.id)
  assert.equal(expiredAfter.project.control.resume.outcome, 'refused')
  assert.equal(expiredAfter.project.createdAt, expiredAnchor, 'the anchor is never reset by a refusal')
  assert.equal(expiredAfter.project.deadlines.expired, true, 'the armed deadline converges without a resume')
  assert.equal(['failed', 'unknown', 'blocked'].includes(expiredAfter.project.status), true)
  await expired.runtime.close()

  // A durable checkpoint whose cumulative budget is already spent refuses an explicit
  // resume and keeps the (hand-built, restart-like) paused state instead of re-promising
  // calls it does not have.
  const spent = makeEnv({ config: { maxRounds: 4, pause: true } })
  const spentPacket = projectPacket(spent.repository, { maxRounds: 4, maxTotalToolCalls: 6 })
  const spentTask = await spent.service.submitProject(spentPacket, spent.projectConfig)
  await planTwo(spent, spentTask.id)
  const current = spent.store.get(spentTask.id)
  spent.store.update(spentTask.id, {
    status: PROJECT_PAUSED,
    phase: 'project',
    project: {
      ...current.project,
      roundsUsed: 1,
      rounds: [{ index: 1, attemptId: current.attemptId, status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, at: Date.now() }],
      budgets: { ...current.project.budgets, supervisorToolSpend: 6, supervisorReserved: 0 },
      control: { pause: { requestId: 'pause-2', state: PROJECT_PAUSED, requestedAt: Date.now(), reason: null, pausedAt: Date.now(), resumedAt: null }, resuming: null, resume: null }
    }
  })
  const spentResult = spent.runtime.resumeRequest({ taskId: spentTask.id, requestId: 'resume-2' })
  assert.equal(spentResult.accepted, false)
  assert.equal(spentResult.code, 'project/budget-exhausted')
  assert.equal(spent.store.get(spentTask.id).project.control.pause.state, PROJECT_PAUSED, 'a refused resume keeps the checkpoint')
  assert.equal(spent.store.get(spentTask.id).project.control.resume.outcome, 'refused')
  await spent.runtime.close()
})

test('a resumed round refused locally by the adapter retains the checkpoint and never replays', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)
  // The REAL drain marks this round as dispatched before its model turn settles; the
  // fixture must mirror that, or the later resume is misclassified as never-dispatched.
  env.store.update(task.id, { dispatchStarted: true, dispatchPending: false, dispatchReceiptAt: env.clock.value, sessionId: 'session-1' })
  await env.service.finishRound(task.id, { text: 'round 1', toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  const [a, b] = workerTasks(env, task.id)
  await env.service.settle(a, { toolCalls: 1 })
  // The pause is requested while one real worker is still live, so the project must stay
  // honestly `pausing` until that worker proves its stop.
  env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-1' })
  await env.service.settle(b, { toolCalls: 1 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.store.get(task.id).status, PROJECT_PAUSED)
  const resumed = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-1' })
  assert.equal(resumed.resumed, true)
  await env.runtime.whenIdle(task.id)
  // The resumed round is scheduled on the runtime's own async chain: wait for the ACTUAL
  // recorded pending round and its reservation instead of assuming they already exist.
  const scheduled = await waitForState(
    () => env.store.get(task.id).project,
    (project) => project.pendingRound?.index === 2 && project.budgets.supervisorReserved > 0,
    { label: 'the resumed round to be planned and reserved' }
  )
  assert.ok(scheduled.budgets.supervisorReserved > 0, 'the resumed round holds its full reservation')
  env.service.acceptRound(task.id)

  await env.service.failRoundLocally(task.id, 'adapter/recovery-unsafe')
  await env.runtime.whenIdle(task.id)
  const held = env.store.get(task.id)
  assert.equal(held.status, PROJECT_PAUSED)
  assert.equal(held.project.control.pause.state, PROJECT_PAUSED)
  assert.equal(held.project.control.resume.outcome, 'refused')
  assert.equal(held.project.control.resume.code, 'adapter/recovery-unsafe')
  assert.equal(held.project.pendingRound, null)
  assert.equal(held.project.budgets.supervisorReserved, 0, 'a boundary that never opened releases its reservation')
  assert.equal(held.project.rounds.at(-1).charged, false)
  assert.equal(held.project.roundsUsed, 1)
  assert.equal(['completed', 'failed', 'cancelled'].includes(held.project.status), false, 'a refused resume is never a fabricated terminal')
  await env.runtime.close()
})

// ---------------------------------------------------------------------------
// restart recovery
// ---------------------------------------------------------------------------

test('restart never auto-resumes a pause checkpoint and blocks an ambiguous round dispatch', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)
  env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-1' })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.store.get(task.id).status, PROJECT_PAUSED)
  await env.runtime.close()

  // A fresh process (new runtime over the same store) reconciles conservatively.
  const restarted = new SupervisorProjectRuntime({ store: env.store, service: env.service, workspaces: env.workspaces, supervisor: env.supervisor, config: env.projectConfig, now: () => env.clock.value, setTimer: () => ({}), clearTimer: () => {} })
  env.service.attachProjects(restarted)
  const report = await restarted.recoverProject(env.store.get(task.id))
  assert.equal(report.resumed, false)
  assert.equal(report.reason, 'paused-checkpoint')
  assert.equal(env.store.get(task.id).status, PROJECT_PAUSED, 'no auto-resume at startup')
  // The explicit resume path still works on the recovered process.
  const resumed = restarted.resumeRequest({ taskId: task.id, requestId: 'resume-after-restart' })
  assert.equal(resumed.resumed, true)
  await restarted.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 2, 'the recovered plan continues by dispatching its real workers')
  assert.equal(env.store.get(task.id).project.pendingRound, null)
  await restarted.close()

  // An ambiguous round dispatch (minted but not provably stopped) fails closed.
  const other = makeEnv({ config: { maxRounds: 4 } })
  const otherPacket = projectPacket(other.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const otherTask = await other.service.submitProject(otherPacket, other.projectConfig)
  await planTwo(other, otherTask.id)
  await other.service.finishRound(otherTask.id, { text: 'round 1', toolCalls: 2 })
  await other.runtime.whenIdle(otherTask.id)
  const [a, b] = workerTasks(other, otherTask.id)
  await other.service.settle(a, { toolCalls: 1 })
  await other.service.settle(b, { toolCalls: 1 })
  await other.runtime.whenIdle(otherTask.id)
  assert.equal(other.store.get(otherTask.id).project.pendingRound?.index, 2)
  await other.runtime.close()
  const otherRestarted = new SupervisorProjectRuntime({ store: other.store, service: other.service, workspaces: other.workspaces, supervisor: other.supervisor, config: other.projectConfig, now: () => other.clock.value, setTimer: () => ({}), clearTimer: () => {} })
  other.service.attachProjects(otherRestarted)
  const ambiguous = await otherRestarted.recoverProject(other.store.get(otherTask.id))
  assert.equal(ambiguous.resumed, false)
  assert.equal(ambiguous.reason, 'host-restart-round-ambiguous')
  assert.equal(other.store.get(otherTask.id).project.status, 'blocked')
  assert.equal(other.store.get(otherTask.id).project.pendingRound?.index, 2, 'the ambiguous reservation is retained')
  await otherRestarted.close()
})

// ---------------------------------------------------------------------------
// checked CAS: only a positively proven stop may mint the next round
// ---------------------------------------------------------------------------

test('beginRound is a checked CAS: an absent, unproven or ambiguous previous round always refuses with the identity untouched', async () => {
  const env = makeEnv({ config: { maxRounds: 4 } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  const before = env.store.get(task.id)
  // The REAL store-minted attempt identity that a genuinely dispatched-and-stopped
  // previous round records, never a fabricated one.
  const stoppedRound = (overrides = {}) => ({ index: 1, attemptId: before.attemptId, status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 0, ...overrides })
  const withProject = (patch) => {
    const current = env.store.get(task.id)
    const project = { ...current.project, rounds: [stoppedRound()], ...(patch.project ?? {}) }
    return env.store.update(task.id, { status: PROJECT_WAITING, phase: 'project', ...patch, project })
  }
  const attemptOf = () => env.store.get(task.id).attemptId
  const conflict = (label, options) => {
    assert.throws(() => env.store.beginRound(task.id, options), { code: 'ROUND_CONFLICT' }, label)
    assert.equal(attemptOf(), before.attemptId, `${label}: a refusal never rewrites identity`)
  }
  const base = { expectedAttemptId: before.attemptId, expectedRoundIndex: 0 }
  const boundIntent = (intent, project = {}) => withProject({
    stopConfirmed: true,
    activeJobs: 0,
    activeChildren: 0,
    project: { ...env.store.get(task.id).project, pendingRound: intent, ...project }
  })

  // The REAL store-submitted identity, but the current round carries no confirmed stop.
  withProject({ stopConfirmed: false })
  conflict('an unconfirmed stop refuses', base)

  // An unknown (null) child count is never read as zero.
  withProject({ stopConfirmed: true, activeJobs: 0, activeChildren: null })
  conflict('an unknown child count refuses', base)

  // A stop with no legitimately bound pending-round intent proves no planned round.
  withProject({ activeChildren: 0 })
  conflict('a missing bound intent refuses', base)

  boundIntent({ index: 3, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' })
  conflict('a pending round that is not the exact next round refuses', base)
  boundIntent({ index: 1, dispatchKey: 'pr-other', attemptId: null, state: 'planned' })
  conflict('a pending round from another dispatch refuses', { ...base, expectedDispatchKey: 'pr-cas' })

  // A continuation with NO recorded previous round refuses: a never-dispatched first
  // round is not a continuation and must use the normal start/resume path.
  boundIntent({ index: 1, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' }, { rounds: [] })
  conflict('an absent previous round refuses', { ...base, expectedDispatchKey: 'pr-cas' })

  // The previous round must be READABLE and carry the EXACT matching attempt identity,
  // a terminal status and its own explicit true/0/0 stop. Every one of these is a
  // distinct, independently observed refusal.
  boundIntent({ index: 1, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' }, { rounds: [stoppedRound({ attemptId: undefined })] })
  conflict('a previous round with no attempt identity refuses', { ...base, expectedDispatchKey: 'pr-cas' })
  boundIntent({ index: 1, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' }, { rounds: [stoppedRound({ attemptId: 'a-superseded' })] })
  conflict('a previous round for a different attempt refuses', { ...base, expectedDispatchKey: 'pr-cas' })
  boundIntent({ index: 1, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' }, { rounds: [stoppedRound({ status: 'unknown' })] })
  conflict('a non-terminal previous round refuses', { ...base, expectedDispatchKey: 'pr-cas' })
  boundIntent({ index: 1, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' }, { rounds: [stoppedRound({ stopConfirmed: false })] })
  conflict('a previous round with no verified stop refuses', { ...base, expectedDispatchKey: 'pr-cas' })
  boundIntent({ index: 1, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' }, { rounds: [stoppedRound({ activeJobs: null })] })
  conflict('a previous round with an unknown job count refuses', { ...base, expectedDispatchKey: 'pr-cas' })
  boundIntent({ index: 1, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' }, { rounds: [stoppedRound({ activeChildren: null })] })
  conflict('a previous round with an unknown child count refuses', { ...base, expectedDispatchKey: 'pr-cas' })

  // Valid control: the real dispatched-and-stopped previous round plus explicit
  // true/0/0 and the exact bound intent mints ONE new attempt.
  boundIntent({ index: 1, dispatchKey: 'pr-cas', attemptId: null, state: 'planned' }, { rounds: [stoppedRound()] })
  const minted = env.store.beginRound(task.id, { ...base, expectedDispatchKey: 'pr-cas' })
  assert.equal(minted.continuationKind, 'supervisor-round')
  assert.notEqual(minted.attemptId, before.attemptId, 'the valid round is a NEW attempt identity')
  assert.equal(minted.stopConfirmed, true, 'the proven stop is carried, not invented')
  assert.equal(minted.activeJobs, 0)
  assert.equal(minted.activeChildren, 0)
  assert.equal(minted.requestHash, before.requestHash, 'the immutable request hash is preserved')
  assert.equal(minted.revision, before.revision)
  assert.throws(() => env.store.beginRound(task.id, { ...base, expectedDispatchKey: 'pr-cas' }), { code: 'ROUND_CONFLICT' }, 'a duplicate dispatch conflicts instead of minting a second round')
  await env.runtime.close()
})

test('an older pause id survives two control cycles and never pauses the newer round again', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  try {
    const task = await env.service.submitProject(projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 }), env.projectConfig)
    env.store.update(task.id, { status: 'running', phase: 'project', dispatchStarted: true, dispatchPending: false, dispatchReceiptAt: env.clock.value, sessionId: 'session-1' })
    await planTwo(env, task.id)
    await env.service.finishRound(task.id, { toolCalls: 2 })
    await env.runtime.whenIdle(task.id)
    const [a, b] = workerTasks(env, task.id)
    env.runtime.pauseRequest({ taskId: task.id, requestId: 'old-pause' })
    await env.service.settle(a, { toolCalls: 1 })
    await env.service.settle(b, { toolCalls: 1 })
    await env.runtime.whenIdle(task.id)
    assert.equal(env.store.get(task.id).status, 'paused')
    assert.equal(env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-one' }).accepted, true)
    await env.runtime.whenIdle(task.id)
    env.service.acceptRound(task.id)
    env.runtime.pauseRequest({ taskId: task.id, requestId: 'new-pause' })
    await env.service.finishRound(task.id, { toolCalls: 3 })
    await env.runtime.whenIdle(task.id)
    assert.equal(env.store.get(task.id).status, 'paused')
    assert.equal(env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-two' }).accepted, true)
    await env.runtime.whenIdle(task.id)
    const before = env.store.get(task.id)
    const events = env.store.events(task.id).length
    const replay = env.runtime.pauseRequest({ taskId: task.id, requestId: 'old-pause' })
    assert.equal(replay.replay, true)
    assert.deepEqual(env.store.get(task.id), before)
    assert.equal(env.store.events(task.id).length, events)
  } finally {
    await env.runtime.close()
    env.store.close()
  }
})

test('pause receipt history keeps known ids at capacity and refuses new ids without mutation', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  try {
    const task = await env.service.submitProject(projectPacket(env.repository, { maxRounds: 4 }), env.projectConfig)
    env.runtime.pauseRequest({ taskId: task.id, requestId: 'first-pause' })
    const project = env.store.get(task.id).project
    project.control.pauseHistory = Array.from({ length: 128 }, (_, i) => ({ ...project.control.pause, requestId: i === 0 ? 'first-pause' : `pause-${i}` }))
    env.store.update(task.id, { project })
    const before = env.store.get(task.id)
    assert.equal(env.runtime.pauseRequest({ taskId: task.id, requestId: 'first-pause' }).replay, true)
    assert.equal(env.runtime.pauseRequest({ taskId: task.id, requestId: 'new-id' }).code, 'project/request-history-full')
    assert.deepEqual(env.store.get(task.id), before)
  } finally {
    await env.runtime.close()
    env.store.close()
  }
})

test('pause requestId binds the operation: a replay with a different reason returns the first outcome and makes no new transition', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)

  const first = env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-once', reason: 'first pause reason' })
  assert.equal(first.state, PROJECT_PAUSED)
  const checkpoint = env.store.get(task.id).project.control.pause
  const transitions = () => env.store.events(task.id).filter((event) => event.type === 'project/pause-requested').length
  const before = transitions()

  const replay = env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-once', reason: 'a different later reason' })
  assert.equal(replay.replay, true)
  assert.equal(replay.state, PROJECT_PAUSED)
  const after = env.store.get(task.id).project.control.pause
  assert.equal(after.pausedAt, checkpoint.pausedAt, 'a replay never moves the checkpoint')
  assert.equal(after.reason, 'first pause reason', 'the first request reason wins')
  assert.equal(transitions(), before, 'a replay writes no second transition')
  await env.runtime.close()
})

test('a successful resume replays immediately and after completion, and never schedules again', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)

  env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-replay' })
  assert.equal(env.store.get(task.id).status, PROJECT_PAUSED)
  const resumed = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-replay', reason: 'first resume reason' })
  assert.equal(resumed.resumed, true)
  await env.runtime.whenIdle(task.id)
  const settled = env.store.get(task.id)
  const anchor = settled.project.createdAt
  const spend = settled.project.budgets.supervisorToolSpend
  const roundsUsed = settled.project.roundsUsed
  const submitted = env.service.submitted.length
  assert.equal(settled.project.control.resume.reason, 'first resume reason')

  // Immediate replay: the pause state is already 'none', which used to be read as
  // project/not-paused BEFORE the recorded replay was consulted.
  const immediate = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-replay' })
  assert.equal(immediate.replay, true)
  assert.equal(immediate.resumed, true)
  assert.equal(immediate.outcome, 'resumed')
  await env.runtime.whenIdle(task.id)
  const afterImmediate = env.store.get(task.id)
  assert.equal(afterImmediate.project.control.pause.state, 'none', 'a replay never re-pauses')
  assert.equal(afterImmediate.project.control.resume.reason, 'first resume reason', 'the first request reason wins')
  assert.equal(afterImmediate.project.createdAt, anchor)
  assert.equal(afterImmediate.project.budgets.supervisorToolSpend, spend)
  assert.equal(afterImmediate.project.roundsUsed, roundsUsed)
  assert.equal(env.service.submitted.length, submitted, 'a replay never dispatches another worker')

  // Terminal replay: a resume that succeeded before the project completed still returns
  // its recorded outcome instead of the terminal short-circuit.
  const completed = env.store.get(task.id)
  env.store.update(task.id, { status: 'completed', phase: 'project', project: { ...completed.project, status: 'completed' } })
  const terminalReplay = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-replay', reason: 'yet another later reason' })
  assert.equal(terminalReplay.replay, true)
  assert.equal(terminalReplay.resumed, true)
  assert.equal(terminalReplay.outcome, 'resumed')
  assert.equal(terminalReplay.status, 'completed')
  assert.equal(env.service.submitted.length, submitted, 'a terminal replay schedules nothing')
  await env.runtime.close()
})

// ---------------------------------------------------------------------------
// durable idempotent resume refusal + planning-phase pause checkpoint
// ---------------------------------------------------------------------------

test('a resume refused while owned work is still live is durable: the same requestId replays the refusal and never reopens admission', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  // Mirror the REAL drain: the round crossed the host boundary before its model turn
  // settled, or a later resume would be misclassified as never-dispatched.
  env.store.update(task.id, { dispatchStarted: true, dispatchPending: false, dispatchReceiptAt: env.clock.value, sessionId: 'session-1' })
  await planTwo(env, task.id)
  await env.service.finishRound(task.id, { text: 'round 1', toolCalls: 2 })
  await env.runtime.whenIdle(task.id)
  const [a, b] = workerTasks(env, task.id)
  assert.ok(a && b, 'two real stored workers are live')

  env.runtime.pauseRequest({ taskId: task.id, requestId: 'pause-early' })
  // A real resume request while both owned workers are live cannot be proven: the refusal
  // MUST be persisted before it is returned.
  const refusal = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-early', reason: 'first reason' })
  assert.equal(refusal.accepted, false)
  assert.equal(refusal.code, 'project/resume-unproven')
  const stored = env.store.get(task.id).project.control.resume
  assert.equal(stored?.requestId, 'resume-early', 'the refusal receipt is persisted BEFORE returning')
  assert.equal(stored?.outcome, 'refused')
  assert.equal(stored?.code, 'project/resume-unproven')
  assert.equal(stored?.reason, 'first reason', 'the first request reason wins')

  await env.service.settle(a, { toolCalls: 1 })
  await env.service.settle(b, { toolCalls: 1 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.store.get(task.id).status, PROJECT_PAUSED)
  const before = env.store.get(task.id)
  const roundsBefore = env.service.roundRequests.length
  const submittedBefore = env.service.submitted.length

  // The identical retry AFTER the proof arrives replays the refusal: no start, no round,
  // no spend, no deadline or budget movement.
  const replay = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-early', reason: 'a later different reason' })
  assert.equal(replay.replay, true)
  assert.equal(replay.accepted, false)
  assert.equal(replay.outcome, 'refused')
  assert.equal(replay.code, 'project/resume-unproven')
  await env.runtime.whenIdle(task.id)
  const afterReplay = env.store.get(task.id)
  assert.equal(afterReplay.status, PROJECT_PAUSED, 'a refused replay never reopens admission')
  assert.equal(env.service.roundRequests.length, roundsBefore, 'a refused replay starts no round')
  assert.equal(env.service.submitted.length, submittedBefore, 'a refused replay starts no worker')
  assert.equal(afterReplay.project.budgets.supervisorToolSpend, before.project.budgets.supervisorToolSpend, 'a refused replay spends nothing')
  assert.equal(afterReplay.project.createdAt, before.project.createdAt, 'a refused replay never moves the deadline anchor')

  // A NEW requestId may then explicitly resume the PROVEN checkpoint.
  const fresh = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-after-proof' })
  assert.equal(fresh.accepted, true)
  assert.equal(fresh.resumed, true)
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.roundRequests.length, roundsBefore + 1, 'the new request resumes with exactly one bounded round')

  // An OLDER id retried after a NEWER control request can never be read as a new command.
  const roundsAfterResume = env.service.roundRequests.length
  const stale = env.runtime.resumeRequest({ taskId: task.id, requestId: 'resume-early', reason: 'stale retry' })
  assert.equal(stale.replay, true)
  assert.equal(stale.accepted, false)
  assert.equal(stale.code, 'project/resume-unproven')
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.roundRequests.length, roundsAfterResume, 'an older id can never reopen admission after a newer request')
  await env.runtime.close()
})

test('the bounded resume request history replays known ids and typed-refuses an unknown id at capacity', async () => {
  const env = makeEnv({ config: { maxRounds: 4, pause: true } })
  const packet = projectPacket(env.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const task = await env.service.submitProject(packet, env.projectConfig)
  await planTwo(env, task.id)
  const current = env.store.get(task.id)
  const history = Array.from({ length: 128 }, (_, index) => ({
    requestId: `r-${index}`,
    at: 1,
    outcome: index === 0 ? 'resumed' : 'refused',
    code: index === 0 ? null : 'project/resume-unproven',
    roundIndex: 0,
    reason: `reason-${index}`
  }))
  env.store.update(task.id, {
    status: PROJECT_PAUSED,
    phase: 'project',
    project: {
      ...current.project,
      control: {
        pause: { requestId: 'pause-cap', state: PROJECT_PAUSED, requestedAt: 1, reason: null, pausedAt: 1, resumedAt: null },
        resuming: null,
        resume: history[4],
        resumeHistory: history
      }
    }
  })
  // A KNOWN id still replays its recorded refusal from the bounded history.
  const replay = env.runtime.resumeRequest({ taskId: task.id, requestId: 'r-4', reason: 'a different later reason' })
  assert.equal(replay.replay, true)
  assert.equal(replay.accepted, false)
  assert.equal(replay.outcome, 'refused')
  assert.equal(replay.code, 'project/resume-unproven')
  // A NEW id at capacity is typed-refused BEFORE any mutation or admission.
  const before = env.store.get(task.id)
  const full = env.runtime.resumeRequest({ taskId: task.id, requestId: 'brand-new', reason: 'new' })
  assert.equal(full.accepted, false)
  assert.equal(full.replay, false)
  assert.equal(full.code, 'project/request-history-full')
  const after = env.store.get(task.id)
  assert.equal(after.project.control.resumeHistory.length, 128, 'a capacity refusal evicts nothing')
  assert.equal(after.project.control.pause.state, PROJECT_PAUSED, 'a capacity refusal keeps the checkpoint')
  assert.equal(after.status, PROJECT_PAUSED)
  assert.equal(after.project.createdAt, before.project.createdAt)
  assert.equal(after.project.budgets.supervisorToolSpend, before.project.budgets.supervisorToolSpend)
  await env.runtime.close()
})

test('a pause during the planning round retains an honest paused planning checkpoint and resumes explicitly', async () => {
  // Case A: an actually dispatched planning round that stopped true/0/0 with NO draft.
  const empty = makeEnv({ config: { maxRounds: 4, pause: true } })
  const emptyPacket = projectPacket(empty.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const emptyTask = await empty.service.submitProject(emptyPacket, empty.projectConfig)
  empty.store.update(emptyTask.id, { status: 'running', phase: 'project', dispatchStarted: true, dispatchPending: false, dispatchReceiptAt: empty.clock.value, sessionId: 'session-1', stopConfirmed: false })
  const requested = empty.runtime.pauseRequest({ taskId: emptyTask.id, requestId: 'planning-pause' })
  assert.equal(requested.state, PROJECT_PAUSING)
  await empty.service.finishRound(emptyTask.id, { text: 'nothing declared', toolCalls: 2 })
  await empty.runtime.whenIdle(emptyTask.id)
  const afterEmpty = empty.store.get(emptyTask.id)
  assert.equal(afterEmpty.status, PROJECT_PAUSED, 'a positive planning stop under pause is an honest pause')
  assert.equal(afterEmpty.project.status, PROJECT_PAUSED)
  assert.equal(afterEmpty.project.frozenAt, null, 'the plan genuinely was never frozen')
  assert.equal(afterEmpty.stopConfirmed, true, 'the real root stop is preserved, never fabricated as unknown')
  assert.equal(afterEmpty.activeJobs, 0)
  assert.equal(afterEmpty.activeChildren, 0)
  assert.equal(afterEmpty.project.seriousIssue, null, 'no bogus plan-not-frozen issue is recorded')
  assert.equal(afterEmpty.project.roundsUsed, 1, 'the genuinely stopped planning round is recorded exactly once')
  assert.equal(empty.service.submitted.length, 0, 'no worker is admitted while paused')
  assert.equal(empty.service.roundRequests.length, 0)

  // An explicit resume continues the SAME unfrozen planning state with ONE guarded round
  // under the same immutable identity, grant and deadline.
  const anchor = afterEmpty.project.createdAt
  const resumed = empty.runtime.resumeRequest({ taskId: emptyTask.id, requestId: 'resume-planning' })
  assert.equal(resumed.accepted, true)
  assert.equal(resumed.resumed, true)
  await empty.runtime.whenIdle(emptyTask.id)
  assert.equal(empty.service.roundRequests.length, 1, 'an unfrozen planning checkpoint resumes with one bounded planning round')
  const minted = empty.store.get(emptyTask.id)
  assert.notEqual(minted.attemptId, emptyTask.attemptId, 'the continuation is a NEW attempt identity')
  assert.equal(minted.project.createdAt, anchor, 'the deadline anchor is never rewritten')
  assert.equal(minted.project.grant.timeoutMs, emptyTask.project.grant.timeoutMs)
  assert.equal(empty.service.submitted.length, 0, 'a planning continuation admits no worker by itself')

  // The minted planning continuation genuinely finishes the SAME unfrozen plan: the
  // declared worker is dispatched only after the continuation round proves its stop.
  empty.service.acceptRound(emptyTask.id)
  empty.runtime.workerCreate({ taskId: emptyTask.id, args: { workerKey: 'reader-a', objective: 'read a', role: 'review', tools: ['read'] } })
  const frozenContinuation = empty.runtime.planFinalize({ taskId: emptyTask.id })
  assert.equal(frozenContinuation.frozen, true, 'the resumed planning round completes the unfrozen plan')
  await empty.service.finishRound(emptyTask.id, { text: 'plan completed', toolCalls: 2 })
  await empty.runtime.whenIdle(emptyTask.id)
  assert.equal(empty.service.submitted.length, 1, 'the completed plan dispatches its declared worker')
  await empty.runtime.close()

  // Case B: a draft declared BEFORE the pause is finalized AFTER the pause request.
  const draft = makeEnv({ config: { maxRounds: 4, pause: true } })
  const draftPacket = projectPacket(draft.repository, { maxRounds: 4, maxTotalToolCalls: 40 })
  const draftTask = await draft.service.submitProject(draftPacket, draft.projectConfig)
  draft.runtime.workerCreate({ taskId: draftTask.id, args: { workerKey: 'reader-a', objective: 'read a', role: 'review', tools: ['read'] } })
  draft.store.update(draftTask.id, { status: 'running', phase: 'project', dispatchStarted: true, dispatchPending: false, dispatchReceiptAt: draft.clock.value, sessionId: 'session-1', stopConfirmed: false })
  draft.runtime.pauseRequest({ taskId: draftTask.id, requestId: 'planning-pause' })
  const frozen = draft.runtime.planFinalize({ taskId: draftTask.id, attemptId: draftTask.attemptId })
  assert.equal(frozen.frozen, true, 'an already-declared draft finalizes while admission is held')
  assert.equal(frozen.workerCount, 1)
  await draft.service.finishRound(draftTask.id, { text: 'draft frozen', toolCalls: 2 })
  await draft.runtime.whenIdle(draftTask.id)
  const afterDraft = draft.store.get(draftTask.id)
  assert.equal(afterDraft.status, PROJECT_PAUSED)
  assert.equal(afterDraft.project.status, PROJECT_PAUSED)
  assert.equal(afterDraft.project.frozenAt !== null, true, 'the draft plan stays frozen')
  assert.equal(afterDraft.project.seriousIssue, null)
  assert.equal(afterDraft.project.workers.length, 1, 'the declared draft is never silently lost')
  assert.equal(draft.service.submitted.length, 0, 'freezing under pause starts nothing')
  assert.equal(draft.service.roundRequests.length, 0)

  // Only the explicit resume dispatches the frozen draft, exactly once.
  const draftResume = draft.runtime.resumeRequest({ taskId: draftTask.id, requestId: 'resume-draft' })
  assert.equal(draftResume.accepted, true)
  await draft.runtime.whenIdle(draftTask.id)
  assert.equal(draft.service.submitted.length, 1, 'the frozen draft is dispatched only on explicit resume')
  assert.equal(draft.service.roundRequests.length, 0, 'an already-frozen plan resumes without a new supervisor round')
  await draft.runtime.close()
})
