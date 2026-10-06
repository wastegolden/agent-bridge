// test/long-task.test.mjs
//
// Targeted tests for the first runnable long-task supervisor (contract
// long-supervisor-first-edition-v1). They exercise the pure decisions AND the real
// orchestration over a REAL TaskStore, with a stub BridgeService standing in for the
// host seam so scheduling, retry, cancellation, unknown handling and callbacks are
// observable deterministically.
//
// The stub mirrors the two service behaviours the orchestrator depends on:
//   * a submitted task occupies `task:<id>` in the SHARED reservation ledger until a
//     verified stop, so `reserveSlots`/capacity gates are really exercised;
//   * a settlement is reported back through `onTaskSettled`, exactly like
//     `BridgeService.finish`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { TaskStore } from '../src/store.mjs'
import { BridgeService } from '../src/service.mjs'
import { validatePacket } from '../src/contracts.mjs'
import { BridgeSupervisor, HostReservationLedger } from '../src/supervisor.mjs'
import {
  MAX_PROJECT_SUMMARY_CHARS,
  SupervisorProjectRuntime,
  aggregateDigest,
  aggregateProject,
  attenuateWorkerRequest,
  buildProjectPrompt,
  createProjectRecord,
  normalizeProjectConfig,
  projectCallbackEventId,
  projectDeadlineRemaining,
  resolveProjectGrant,
  workerAttemptKey
} from '../src/long-task.mjs'

const HERE = import.meta.dirname
const MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })

/** One stub service: real TaskStore writes, real ledger accounting, real settle hooks. */
class StubService {
  constructor(store, { ledger, now } = {}) {
    this.store = store
    this.ledger = ledger ?? null
    // The stub mirrors the real service's clock: a deterministic injected clock must be
    // used for project admission too, never a hidden real Date.now.
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.projects = null
    this.submitted = []
    this.cancelled = []
  }

  attachProjects(projects) {
    this.projects = projects
    return this
  }

  #reserve(id) {
    if (this.ledger === null) return
    this.ledger.reserve({ key: `task:${id}`, kind: 'root', taskId: id })
  }

  async submitProject(packet, config, callbackBinding = { grantId: 'grant-1', targetId: 'target-1', boundAt: 1 }) {
    const p = validatePacket(packet)
    const grant = resolveProjectGrant(p.project, config)
    const record = createProjectRecord({ packet: p, grant, now: this.now() })
    const result = this.store.submit(p, { effectiveModel: { ...MODEL }, callbackBinding, project: record })
    if (result.created) {
      this.#reserve(result.task.id)
      // Mirror the real service admission: the deadline is armed and the supervisor's
      // effective budget is clamped exactly once, right after persistence.
      if (this.projects && typeof this.projects.admitProject === 'function') this.projects.admitProject(result.task.id)
    }
    return result.task
  }

  async submit(packet) {
    const p = validatePacket(packet)
    const result = this.store.submit(p, { effectiveModel: p.model ?? { ...MODEL } })
    if (result.created) {
      this.submitted.push({ id: result.task.id, packet: p })
      this.#reserve(result.task.id)
      if (p.workspace) {
        this.store.update(result.task.id, {
          workspace: {
            taskId: result.task.id,
            path: path.join(p.workspace.repository, '.worktrees', result.task.id),
            branch: `task/${result.task.id}`,
            baseCommit: 'a'.repeat(40),
            repository: p.workspace.repository
          }
        })
      }
    }
    const task = this.store.get(result.task.id)
    return { id: task.id, status: task.status, sessionId: task.status === 'queued' ? null : `session-${task.id}`, workspace: task.workspace ?? null }
  }

  async cancel(id, reason) {
    const task = this.store.get(id)
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return { accepted: false, alreadyFinished: true }
    this.cancelled.push({ id, reason })
    this.store.update(id, { status: 'cancelled', phase: 'cancelled', stopConfirmed: true, activeJobs: 0, endedAt: Date.now() })
    this.#release(id)
    await this.projects.onTaskSettled(this.store.get(id))
    return { accepted: true, stopConfirmed: true }
  }

  async settle(id, patch) {
    this.store.update(id, patch)
    // Mirror BridgeService's positive-stop fence: this verification seam must not
    // release an unknown job count before the runtime can observe it.
    const settled = this.store.get(id)
    if (['completed', 'failed', 'cancelled'].includes(settled.status) &&
        settled.stopConfirmed === true && settled.activeJobs === 0 &&
        !(Number.isInteger(settled.activeChildren) && settled.activeChildren > 0)) this.#release(id)
    await this.projects.onTaskSettled(this.store.get(id))
  }

  #release(id) {
    if (this.ledger === null) return
    const key = `task:${id}`
    if (this.ledger.has(key)) this.ledger.release(key, { stopConfirmed: true, reason: 'stub settlement' })
  }
}

function makeEnv({ ledgerLimit = 16, config = {}, now, setTimer, clearTimer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-longtask-'))
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-longtask-repo-'))
  const store = new TaskStore({ directory: dir, ownerId: 'owner-longtask' })
  const ledger = new HostReservationLedger({ limit: ledgerLimit, id: `longtask-${Math.random()}` })
  const sinkCalls = []
  const supervisor = new BridgeSupervisor({
    ledger,
    ownerId: 'owner-longtask',
    config: { notificationSink: (event) => { sinkCalls.push(event); return { ok: true, event: { state: 'pending' } } } }
  })
  const workspaces = {
    inspect: async () => ({ head: 'b'.repeat(40), dirty: true, changedPaths: ['src/changed.js'] })
  }
  const projectConfig = normalizeProjectConfig({ enabled: true, ...config })
  const service = new StubService(store, { ledger, now })
  // The injected clock AND the injected timer seams must reach the runtime, otherwise a
  // "deterministic" deadline test silently uses production timers and a real clock.
  const runtime = new SupervisorProjectRuntime({ store, service, workspaces, supervisor, config: projectConfig, now, setTimer, clearTimer })
  service.attachProjects(runtime)
  return { dir, repository, store, ledger, supervisor, workspaces, projectConfig, service, runtime, sinkCalls }
}

function projectPacket(repository, projectOverrides = {}, scopeOverrides = {}, idempotencyKey = 'project-1') {
  return {
    schemaVersion: 1,
    idempotencyKey,
    revision: 1,
    projectId: 'pj-1',
    title: 'long project',
    objective: 'split the bounded work across workers',
    cwd: repository,
    role: 'investigate',
    acceptance: ['every worker is bounded and reported'],
    scope: { readRoots: [repository], writeRoots: [], allowedTools: ['read', 'glob', 'grep'], allowShell: false, allowNetwork: false, allowDelegation: false, ...scopeOverrides },
    materials: [],
    contractVersion: 'v1',
    rootCallback: { grantId: 'grant-1' },
    project: {
      maxWorkers: 8,
      maxConcurrentWorkers: 3,
      maxRepairAttempts: 2,
      maxTotalRetries: 64,
      maxWorkerStarts: 64,
      maxTotalToolCalls: 10000,
      timeoutMs: 3600000,
      reserveSlots: 1,
      workerScope: { readRoots: [repository], writeRoots: [repository], allowedTools: ['read', 'write', 'edit'], allowNetwork: false },
      workspace: { repository, baseRef: 'HEAD' },
      ...projectOverrides
    }
  }
}

// Every supervisor-round fixture omits the attemptId argument: `onSupervisorFinished` then
// binds the round to the task's REAL store-minted `task.attemptId` (`attemptId ?? task.attemptId`),
// which is the exact identity its stop proof must match. A synthetic attempt id would model a
// superseded attempt and is therefore unproven — never a positive stop.

/** Declare three workers and freeze, exactly like a supervisor round. */
async function planThree(env, taskId) {
  const { runtime } = env
  assert.equal(runtime.workerCreate({ taskId, args: { workerKey: 'reader-a', objective: 'read a', role: 'review', tools: ['read'] } }).state, 'queued')
  runtime.workerCreate({ taskId, args: { workerKey: 'reader-b', objective: 'read b', role: 'review', tools: ['read'] } })
  runtime.workerCreate({ taskId, args: { workerKey: 'writer-c', objective: 'write c', role: 'implement', tools: ['read', 'write', 'edit'], writeRoots: [env.repository] } })
  const frozen = runtime.planFinalize({ taskId })
  assert.equal(frozen.frozen, true)
  assert.equal(frozen.workerCount, 3)
}

// ---------------------------------------------------------------------------
// pure: host config and attenuation
// ---------------------------------------------------------------------------

test('normalizeProjectConfig defaults to disabled and refuses unknown or out-of-range settings', () => {
  assert.equal(normalizeProjectConfig(undefined).enabled, false)
  assert.equal(normalizeProjectConfig({ enabled: true, maxWorkers: 4 }).maxWorkers, 4)
  // A lowered worker ceiling carries its dependent concurrency default with it ...
  assert.equal(normalizeProjectConfig({ enabled: true, maxWorkers: 2 }).maxConcurrentWorkers, 2)
  // ... while an explicit pair is still refused when contradictory, never clamped.
  assert.throws(() => normalizeProjectConfig({ enabled: true, maxConcurrentWorkers: 5, maxWorkers: 4 }), { code: 'project/invalid-config' })
  // The host always reserves at least one coordinator slot; reserving more stays legal.
  assert.equal(normalizeProjectConfig({ enabled: true }).reserveSlots, 15)
  assert.equal(normalizeProjectConfig({ enabled: true, reserveSlots: 1 }).reserveSlots, 1)
  assert.throws(() => normalizeProjectConfig({ enabled: true, reserveSlots: 0 }), { code: 'project/invalid-config' })
  assert.throws(() => normalizeProjectConfig({ enabled: 'yes' }), { code: 'project/invalid-config' })
  assert.throws(() => normalizeProjectConfig({ enabled: true, maxRepairAttempts: 3 }), { code: 'project/invalid-config' })
  assert.throws(() => normalizeProjectConfig({ enabled: true, extra: 1 }), { code: 'project/invalid-config' })
})

test('resolveProjectGrant refuses a disabled host, raises above caps, and refuses unbounded worker tools', () => {
  const project = {
    maxWorkers: 4, maxConcurrentWorkers: 2, maxRepairAttempts: 2, maxTotalRetries: 8, maxWorkerStarts: 8,
    maxTotalToolCalls: 100, timeoutMs: 1000, reserveSlots: 1,
    workerScope: { readRoots: [HERE], writeRoots: [], allowedTools: ['read'], allowNetwork: false, budgets: { timeoutMs: 10, maxToolCalls: 2, maxOutputChars: 10 } }
  }
  assert.throws(() => resolveProjectGrant(project, normalizeProjectConfig(undefined)), { code: 'project/unsupported' })
  const strict = normalizeProjectConfig({ enabled: true, maxWorkers: 2 })
  assert.throws(() => resolveProjectGrant(project, strict), { code: 'project/host-cap' })
  const permissive = normalizeProjectConfig({ enabled: true })
  assert.equal(resolveProjectGrant(project, permissive).maxWorkers, 4)
  assert.throws(
    () => resolveProjectGrant({ ...project, workerScope: { ...project.workerScope, allowedTools: ['bash'] } }, permissive),
    { code: 'project/scope-unsupported' }
  )
})

test('attenuateWorkerRequest refuses every widening and grants only an attenuated worker', () => {
  const grant = resolveProjectGrant(
    {
      maxWorkers: 4, maxConcurrentWorkers: 2, maxRepairAttempts: 2, maxTotalRetries: 8, maxWorkerStarts: 8,
      maxTotalToolCalls: 100, timeoutMs: 1000, reserveSlots: 1,
      workerScope: { readRoots: [HERE], writeRoots: [], allowedTools: ['read', 'glob'], allowNetwork: false, budgets: { timeoutMs: 100, maxToolCalls: 4, maxOutputChars: 100 } }
    },
    normalizeProjectConfig({ enabled: true })
  )
  const context = { workerKeys: [], projectCwd: HERE }
  const ok = attenuateWorkerRequest(grant, { workerKey: 'w1', objective: 'read', tools: ['read'] }, context)
  assert.deepEqual(ok.tools, ['read'])
  assert.equal(ok.required, true)
  for (const [request, code] of [
    [{ workerKey: 'w1', objective: 'o', model: MODEL }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', targetId: 'chat' }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', depth: 1 }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', tools: ['bash'] }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', tools: ['subagent'] }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', tools: ['dsh_supervisor_worker_create'] }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', readRoots: [path.dirname(HERE)] }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', allowNetwork: true }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', budgets: { maxToolCalls: 50 } }, 'project/grant-widened'],
    [{ workerKey: 'w1', objective: 'o', writeRoots: [HERE] }, 'project/grant-widened'],
    [{ workerKey: 'bad key!', objective: 'o' }, 'project/invalid-request'],
    [{ workerKey: 'w1', objective: 'o', role: 'admin' }, 'project/invalid-request']
  ]) {
    assert.throws(() => attenuateWorkerRequest(grant, request, context), { code }, `expected ${code} for ${JSON.stringify(request)}`)
  }
  // A writer envelope without a repository can never become a writer task.
  const writerGrant = resolveProjectGrant(
    {
      maxWorkers: 4, maxConcurrentWorkers: 2, maxRepairAttempts: 2, maxTotalRetries: 8, maxWorkerStarts: 8,
      maxTotalToolCalls: 100, timeoutMs: 1000, reserveSlots: 1,
      workerScope: { readRoots: [HERE], writeRoots: [HERE], allowedTools: ['read', 'write'], allowNetwork: false, budgets: { timeoutMs: 100, maxToolCalls: 4, maxOutputChars: 100 } }
    },
    normalizeProjectConfig({ enabled: true })
  )
  assert.throws(
    () => attenuateWorkerRequest(writerGrant, { workerKey: 'w1', objective: 'o', role: 'implement', tools: ['write'] }, context),
    { code: 'project/workspace-required' }
  )
})

// ---------------------------------------------------------------------------
// pure: aggregation decisions
// ---------------------------------------------------------------------------

test('aggregateProject is the completion/retry/failure gate', () => {
  const worker = (key, required, attempts, extra = {}) => ({ workerKey: key, required, attempts, ...extra })
  const succeeded = { attempt: 1, state: 'succeeded' }
  assert.equal(aggregateProject({ workers: [worker('a', true, [succeeded]), worker('b', false, [{ attempt: 1, state: 'failed' }])], maxRepairAttempts: 0 }).status, 'completed')
  assert.equal(aggregateProject({ workers: [worker('a', true, [{ attempt: 1, state: 'running' }])] }).status, 'pending')
  assert.equal(aggregateProject({ workers: [worker('a', true, [{ attempt: 1, state: 'failed' }])], maxRepairAttempts: 2 }).status, 'pending')
  assert.equal(aggregateProject({ workers: [worker('a', true, [{ attempt: 1, state: 'unknown' }])] }).status, 'unknown')
  const exhausted = aggregateProject({ workers: [worker('a', true, [{ attempt: 1, state: 'failed' }, { attempt: 2, state: 'failed' }])], maxRepairAttempts: 1 })
  assert.equal(exhausted.status, 'failed')
  assert.deepEqual(exhausted.requiredFailed, ['a'])
  assert.equal(aggregateProject({ workers: [worker('a', true, [{ attempt: 1, state: 'failed', retryBlocked: true }])], maxRepairAttempts: 2 }).status, 'failed')
  assert.equal(aggregateProject({ workers: [worker('a', true, [], { cancelledBeforeDispatch: true })] }).status, 'failed')
  const cancelledAttempt = aggregateProject({ workers: [worker('a', true, [{ attempt: 1, state: 'cancelled', cancelRequested: true }])] })
  assert.equal(cancelledAttempt.status, 'failed')
  assert.deepEqual(cancelledAttempt.cancelled, ['a'])
  const optional = aggregateProject({ workers: [worker('a', true, [succeeded]), worker('b', false, [{ attempt: 1, state: 'failed' }])], maxRepairAttempts: 0 })
  assert.equal(optional.status, 'completed')
  assert.deepEqual(optional.optionalDegraded, ['b'])
})

test('worker attempt keys and project callback ids are deterministic and bounded', () => {
  assert.equal(workerAttemptKey('t', 'w', 1), workerAttemptKey('t', 'w', 1))
  assert.notEqual(workerAttemptKey('t', 'w', 1), workerAttemptKey('t', 'w', 2))
  assert.ok(workerAttemptKey('t', 'w', 3).length <= 200)
  const id = projectCallbackEventId({ taskId: 't', attemptId: 'a', outcomeClass: 'completion', aggregateHash: aggregateDigest([{ workerKey: 'w' }]) })
  assert.ok(id.length <= 128)
  assert.equal(id, projectCallbackEventId({ taskId: 't', attemptId: 'a', outcomeClass: 'completion', aggregateHash: aggregateDigest([{ workerKey: 'w' }]) }))
  assert.notEqual(id, projectCallbackEventId({ taskId: 't', attemptId: 'a', outcomeClass: 'serious-issue', aggregateHash: 'x' }))
})

test('projectDeadlineRemaining is anchored at admission and clamps a worker to the project', () => {
  const project = { createdAt: 1000, grant: { timeoutMs: 5000 } }
  assert.equal(projectDeadlineRemaining(project, 1000), 5000)
  assert.equal(projectDeadlineRemaining(project, 3500), 2500)
  assert.equal(projectDeadlineRemaining(project, 6000), 0)
  assert.equal(projectDeadlineRemaining(project, 9000), 0)
})

test('buildProjectPrompt names the supervisor tools, the envelope and the immutable route', () => {
  const prompt = buildProjectPrompt(
    { projectId: 'pj', id: 't1', revision: 1, title: 'T', objective: 'O', acceptance: ['A'], project: { workerScope: { readRoots: ['/r'], writeRoots: [], allowedTools: ['read'], allowNetwork: false } } },
    MODEL,
    { maxWorkers: 8, maxConcurrentWorkers: 3, maxRepairAttempts: 2, maxWorkerStarts: 24, maxTotalToolCalls: 10000, timeoutMs: 1000, workspace: { repository: '/repo', baseRef: 'HEAD' } }
  )
  assert.match(prompt, /dsh_supervisor_worker_create/)
  assert.match(prompt, /dsh_supervisor_plan_finalize/)
  assert.match(prompt, /deepseek-official\/deepseek-flash effort=high/)
  assert.match(prompt, /\/repo@HEAD/)
})

// ---------------------------------------------------------------------------
// runtime over a real store
// ---------------------------------------------------------------------------

test('a frozen three-worker plan creates three real bounded worker tasks, one writer worktree each', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  await planThree(env, task.id)

  // Idempotent replay: the same workerKey never declares a second worker.
  const replay = env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'reader-a', objective: 'read a', role: 'review', tools: ['read'] } })
  assert.equal(replay.idempotentReplay, true)
  assert.equal(env.store.get(task.id).project.workers.length, 3)
  assert.equal(env.runtime.planFinalize({ taskId: task.id }).idempotentReplay, true)

  // The planning round stops positively: the model reservation is released and the
  // project waits as `supervising` instead of consuming a phantom root slot.
  assert.equal(env.ledger.has(`task:${task.id}`), true)
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0, finalText: 'plan declared' })
  await env.runtime.whenIdle(task.id)
  const waiting = env.store.get(task.id)
  assert.equal(waiting.status, 'supervising')
  assert.equal(env.ledger.has(`task:${task.id}`), false)

  const workers = waiting.project.workers
  assert.equal(env.service.submitted.length, 3)
  const keys = env.service.submitted.map((entry) => entry.packet.idempotencyKey)
  assert.equal(new Set(keys).size, 3)
  const writer = workers.find((worker) => worker.workerKey === 'writer-c')
  assert.equal(writer.attempts.length, 1)
  assert.ok(env.service.submitted.find((entry) => entry.id === writer.attempts[0].taskId).packet.workspace, 'the writer packet must request its own owned worktree')
  const reader = workers.find((worker) => worker.workerKey === 'reader-a')
  assert.equal(env.service.submitted.find((entry) => entry.id === reader.attempts[0].taskId).packet.workspace, undefined, 'a read-only worker shares the read-only base instead of a worktree')
  for (const entry of env.service.submitted) {
    assert.deepEqual(entry.packet.model, MODEL, 'every worker inherits the exact supervisor route')
    assert.equal(entry.packet.rootCallback, undefined, 'a worker can never name a callback destination')
    assert.equal(entry.packet.parentTaskId, task.id)
    assert.equal(entry.packet.scope.allowDelegation, false)
  }

  // Settle all three; only verified stopped work may complete the project.
  for (const worker of workers) {
    await env.service.settle(worker.attempts[0].taskId, { status: 'completed', stopConfirmed: true, activeJobs: 0, result: { text: `${worker.workerKey} done`, evidence: [], uncertainties: [] } })
  }
  await env.runtime.whenIdle(task.id)
  const completed = env.store.get(task.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.project.status, 'completed')
  assert.equal(completed.stopConfirmed, true)
  assert.equal(completed.result.uncertainties.some((entry) => entry.includes('uncommitted changes')), true, 'dirty writer evidence is retained, not hidden')
  assert.match(completed.result.text, /writer-c/)
  // Exactly one completion callback; a second completion attempt is a no-op.
  assert.equal(env.sinkCalls.length, 1)
  assert.equal(completed.project.callbacks.completion.outcome, 'queued')
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.sinkCalls.length, 1)
})

test('an ordinary failed worker is repaired under the cap; exhaustion fails the project cleanly', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { maxRepairAttempts: 1, maxTotalRetries: 4, maxWorkerStarts: 8 }), env.projectConfig)
  await planThree(env, task.id)
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)

  const worker = () => env.store.get(task.id).project.workers.find((candidate) => candidate.workerKey === 'reader-a')
  const first = worker().attempts[0].taskId
  await env.service.settle(first, { status: 'failed', stopConfirmed: true, activeJobs: 0, result: { text: 'first attempt failed' } })
  await env.runtime.whenIdle(task.id)
  const repaired = worker()
  assert.equal(repaired.attempts.length, 2, 'one ordinary failure is repaired under the cap')
  assert.notEqual(repaired.attempts[1].taskId, first)
  assert.equal(env.store.get(task.id).project.budgets.retries, 1)

  await env.service.settle(repaired.attempts[1].taskId, { status: 'failed', stopConfirmed: true, activeJobs: 0, result: { text: 'repair failed' } })
  await env.runtime.whenIdle(task.id)
  // The remaining live workers are cancelled to converge, and only a fully stopped
  // failure may become terminal `failed`.
  for (const candidate of env.store.get(task.id).project.workers) {
    const last = candidate.attempts[candidate.attempts.length - 1]
    if (last.taskId && env.store.get(last.taskId).status === 'queued') {
      await env.service.settle(last.taskId, { status: 'failed', stopConfirmed: true, activeJobs: 0, result: { text: 'stopped' } })
    }
  }
  await env.runtime.whenIdle(task.id)
  const failed = env.store.get(task.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.stopConfirmed, true)
  assert.equal(failed.project.status, 'failed')
  assert.equal(env.sinkCalls.length, 1)
  assert.equal(env.sinkCalls[0].kind, 'failed')
  assert.equal(worker().attempts.length, 2, 'the repair cap is never exceeded')
})

test('an explicit worker cancellation is never respawned and fails the project only on verified stops', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  await planThree(env, task.id)
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)

  const worker = () => env.store.get(task.id).project.workers.find((candidate) => candidate.workerKey === 'reader-a')
  const target = worker().attempts[0].taskId
  const cancel = await env.runtime.workerCancel({ taskId: task.id, args: { workerId: 'reader-a', reason: 'no longer needed' } })
  assert.equal(cancel.cancelRequested, true)
  await env.runtime.whenIdle(task.id)
  assert.equal(worker().attempts.length, 1, 'an explicit cancellation is never retried as an ordinary failure')
  assert.equal(env.store.get(target).status, 'cancelled')

  // Other live workers are converged, then the required cancellation fails the project.
  for (const candidate of env.store.get(task.id).project.workers) {
    const last = candidate.attempts[candidate.attempts.length - 1]
    if (last.taskId && ['queued', 'running', 'starting'].includes(env.store.get(last.taskId).status)) {
      await env.service.settle(last.taskId, { status: 'failed', stopConfirmed: true, activeJobs: 0, result: { text: 'stopped for convergence' } })
    }
  }
  await env.runtime.whenIdle(task.id)
  const settled = env.store.get(task.id)
  assert.equal(settled.status, 'failed')
  assert.equal(settled.project.status, 'failed')
  assert.equal(settled.stopConfirmed, true)
})

test('unverified owned work blocks the project, keeps its reservations and never redispatches', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  await planThree(env, task.id)
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  const worker = () => env.store.get(task.id).project.workers.find((candidate) => candidate.workerKey === 'reader-a')
  const target = worker().attempts[0].taskId
  // The host reports an ambiguous outcome: a terminal status WITHOUT a verified stop.
  await env.service.settle(target, { status: 'unknown', stopConfirmed: false, activeJobs: null, result: { text: 'ambiguous' } })
  await env.runtime.whenIdle(task.id)

  const blocked = env.store.get(task.id)
  assert.equal(blocked.status, 'unknown', 'blocked is an honest unknown, not a fabricated clean failure')
  assert.equal(blocked.stopConfirmed, false)
  assert.equal(blocked.project.status, 'blocked')
  assert.equal(blocked.project.seriousIssue.code, 'unknown-worker-work')
  assert.equal(blocked.project.ownedUnstopped >= 1, true)
  assert.equal(worker().attempts.length, 1, 'unknown work is never redispatched')
  assert.equal(env.sinkCalls.length, 1, 'a serious issue notifies without a clean settlement')
  assert.equal(env.sinkCalls[0].kind, 'failed')
  assert.equal(blocked.project.callbacks['serious-issue'].outcome, 'queued')
  // Cancel/reconcile stay possible: reconciliation never replays the model round.
  const report = await env.runtime.reevaluate(task.id)
  assert.equal(report.evaluated, true)
  assert.equal(env.service.submitted.length, 3, 'reconciliation dispatches nothing new')
})

test('capacity is reserved: the shared ledger and reserveSlots bound concurrent workers', async (t) => {
  const env = makeEnv({ ledgerLimit: 2 })
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { reserveSlots: 1, maxConcurrentWorkers: 3 }), env.projectConfig)
  await planThree(env, task.id)
  // The project round released its own model slot, leaving 2 free. reserveSlots=1 means
  // exactly ONE worker may start; the second would take the last coordinator slot.
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 1, 'a worker must not take the reserved coordinator slot')
  assert.equal(env.ledger.counts().free, 1, 'the reserved slot stays free while the worker runs')
  assert.equal(env.store.get(task.id).project.status, 'dispatching')
  assert.equal(env.store.get(task.id).status, 'supervising')
})

test('a restart refuses ambiguous dispatch and lets a terminal project record survive', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  await planThree(env, task.id)
  // Simulate a crash between "persist the attempt" and "a real task exists".
  const project = env.store.get(task.id).project
  project.workers[0].attempts.push({ attempt: 1, idempotencyKey: 'pw-x', state: 'dispatching', taskId: null, cancelRequested: false, stopConfirmed: false })
  project.workers[0].state = 'dispatching'
  env.store.update(task.id, { project })

  const freshService = new StubService(env.store, { ledger: env.ledger })
  const fresh = new SupervisorProjectRuntime({ store: env.store, service: freshService, workspaces: env.workspaces, supervisor: env.supervisor, config: env.projectConfig })
  freshService.attachProjects(fresh)
  const report = await fresh.recoverProject(env.store.get(task.id))
  assert.equal(report.resumed, false)
  assert.equal(report.reason, 'host-restart-fail-closed')
  const blocked = env.store.get(task.id)
  assert.equal(blocked.status, 'unknown')
  assert.equal(blocked.project.status, 'blocked')
  assert.equal(blocked.project.seriousIssue.code, 'host-restart')

  // A terminal project record survives a restart and is never re-evaluated.
  env.store.update(task.id, { status: 'completed', project: { ...blocked.project, status: 'completed' } })
  const terminal = await fresh.recoverProject(env.store.get(task.id))
  assert.equal(terminal.reason, 'terminal')
})

test('worker task submission is idempotent per logical attempt', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  await planThree(env, task.id)
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  const key = env.service.submitted[0].packet.idempotencyKey
  assert.equal(key, workerAttemptKey(task.id, 'reader-a', 1))
  const replay = await env.service.submit(env.service.submitted[0].packet)
  assert.equal(replay.id, env.service.submitted[0].id, 'the same attempt key resolves to the same task')
  assert.equal(env.store.list().filter((candidate) => candidate.id === replay.id).length, 1)
})

// ---------------------------------------------------------------------------
// repair-1 negative regressions: the seven independently reproduced defects
// (candidate-1-boundary-repro.mjs) plus the budget/deadline/race invariants.
// ---------------------------------------------------------------------------

/** Find one persisted worker by key. */
function workerOf(store, taskId, workerKey) {
  return store.get(taskId).project.workers.find((worker) => worker.workerKey === workerKey)
}

test('a supervisor round without an explicit numeric stop count never releases its model slot or dispatches', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: 'bounded work', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: task.id })
  // The host reports a terminal round WITHOUT a numeric activeJobs count: that is not
  // proof of a stop, so the reservation is retained and no worker may be dispatched.
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: null })
  await env.runtime.whenIdle(task.id)
  const after = env.store.get(task.id)
  assert.equal(after.project.status, 'blocked')
  assert.equal(after.project.seriousIssue.code, 'supervisor-round-unstopped')
  assert.equal(after.status, 'unknown')
  assert.equal(after.stopConfirmed, false)
  assert.equal(env.ledger.has(`task:${task.id}`), true, 'an unproven round keeps its model reservation')
  assert.equal(env.service.submitted.length, 0, 'no worker may start behind an unproven supervisor round')

  // A positive activeChildren count is the same class of unproven stop.
  const second = await env.service.submitProject(projectPacket(env.repository, {}, {}, 'project-2'), env.projectConfig)
  env.runtime.workerCreate({ taskId: second.id, args: { workerKey: 'w1', objective: 'bounded work', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: second.id })
  await env.runtime.onSupervisorFinished(second.id, { status: 'completed', stopConfirmed: true, activeJobs: 0, activeChildren: 1 })
  await env.runtime.whenIdle(second.id)
  assert.equal(env.store.get(second.id).project.status, 'blocked')
  assert.equal(env.ledger.has(`task:${second.id}`), true)
})

test('a worker terminal state with a missing stop count stays unknown instead of completing the project', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: 'bounded work', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  const dispatched = workerOf(env.store, task.id, 'w1').attempts[0].taskId
  // completed status WITHOUT a numeric activeJobs count: not a verified stop.
  await env.service.settle(dispatched, { status: 'completed', stopConfirmed: true, activeJobs: null, result: { text: 'done?' } })
  await env.runtime.whenIdle(task.id)
  const blocked = env.store.get(task.id)
  assert.equal(blocked.project.status, 'blocked')
  assert.equal(blocked.status, 'unknown')
  assert.notEqual(blocked.status, 'completed')
  assert.equal(blocked.stopConfirmed, false)
  assert.equal(workerOf(env.store, task.id, 'w1').state, 'unknown')
  assert.equal(env.ledger.has(`task:${dispatched}`), true, 'the unverified worker keeps its slot')
})

test('a zero project retry cap refuses the repair before any repair task is submitted', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { maxTotalRetries: 0 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: 'bounded work', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 1)
  await env.service.settle(env.service.submitted[0].id, { status: 'failed', stopConfirmed: true, activeJobs: 0, result: { text: 'ordinary failure' } })
  await env.runtime.whenIdle(task.id)
  const failed = env.store.get(task.id)
  assert.equal(failed.project.status, 'failed')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.stopConfirmed, true)
  assert.equal(env.service.submitted.length, 1, 'a zero retry cap never dispatches a repair')
  assert.equal(workerOf(env.store, task.id, 'w1').attempts.length, 1)
  assert.equal(failed.project.budgets.retries, 0)
  assert.equal(failed.project.workers[0].attempts[0].retryBlocked, true)
})

test('the project tool budget is reserved before dispatch: never reused by a parallel worker, never exceeded', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { maxTotalToolCalls: 6, maxConcurrentWorkers: 2, reserveSlots: 1 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'bounded a', role: 'implement', tools: ['read'], writeRoots: [env.repository], budgets: { maxToolCalls: 3 } } })
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'bounded b', role: 'implement', tools: ['read'], writeRoots: [env.repository], budgets: { maxToolCalls: 3 } } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  // Both workers run at the same time, each with its own real allowance.
  assert.equal(env.service.submitted.length, 2)
  const allowances = env.service.submitted.map((entry) => entry.packet.budget.maxToolCalls)
  assert.deepEqual(allowances, [3, 3], 'the shared cap funds two parallel allowances exactly')
  const sum = allowances[0] + allowances[1]
  assert.ok(sum <= 6, 'the outstanding allowances never exceed the grant')

  // Both use their FULL grant: the aggregate may complete because spend is within cap.
  await env.service.settle(env.service.submitted[0].id, { status: 'completed', stopConfirmed: true, activeJobs: 0, stats: { toolCalls: 3 }, result: { text: 'a done' } })
  await env.service.settle(env.service.submitted[1].id, { status: 'completed', stopConfirmed: true, activeJobs: 0, stats: { toolCalls: 3 }, result: { text: 'b done' } })
  await env.runtime.whenIdle(task.id)
  const completed = env.store.get(task.id)
  assert.equal(completed.project.status, 'completed')
  assert.equal(completed.stopConfirmed, true)
  assert.equal(completed.project.budgets.toolSpend, 6, 'the released spend is credited exactly once per attempt')
})

test('spending above the shared tool grant never produces a clean completion', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { maxTotalToolCalls: 3, maxConcurrentWorkers: 2 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: 'bounded', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 1)
  await env.service.settle(env.service.submitted[0].id, { status: 'completed', stopConfirmed: true, activeJobs: 0, stats: { toolCalls: 5 }, result: { text: 'over budget' } })
  await env.runtime.whenIdle(task.id)
  const after = env.store.get(task.id)
  assert.notEqual(after.project.status, 'completed', 'a spend above the grant is never a clean completion')
  assert.equal(after.status, 'failed')
  assert.equal(after.project.seriousIssue.code, 'project-tool-budget-exhausted')
})

test('a project deadline armed at admission stops a hung planner and a running worker', async (t) => {
  // Planning is bounded BEFORE any management tool exists: the deadline is armed by real
  // service ADMISSION, not deferred to the first dsh_supervisor_* call.
  let now = 1000
  let planningTimer = null
  let planningArms = 0
  const planningEnv = makeEnv({ now: () => now, setTimer: (fn, ms) => { planningArms += 1; planningTimer = { fn, ms }; return planningArms }, clearTimer: () => {} })
  t.after(() => planningEnv.store.close())
  const planning = await planningEnv.service.submitProject(projectPacket(planningEnv.repository), planningEnv.projectConfig)
  assert.ok(planningTimer !== null, 'one host timer per project, armed at ADMISSION before any worker tool')
  assert.equal(planningArms, 1, 'admission arms exactly one live deadline timer')
  assert.ok(planningTimer.ms > 0)
  planningEnv.runtime.workerCreate({ taskId: planning.id, args: { workerKey: 'w1', objective: 'bounded', role: 'implement', tools: ['read'], writeRoots: [planningEnv.repository] } })
  assert.equal(planningArms, 1, 'a worker tool never re-arms an already live deadline')
  now += 1001
  planningTimer.fn()
  await planningEnv.runtime.whenIdle(planning.id)
  const hung = planningEnv.store.get(planning.id)
  assert.equal(hung.project.deadlines.expired, true)
  assert.equal(hung.project.status, 'failed')
  assert.equal(hung.status, 'failed')
  assert.notEqual(hung.status, 'supervising')

  // A live worker cannot be left supervising forever either.
  let now2 = 1000
  let liveTimer = null
  const liveEnv = makeEnv({ now: () => now2, setTimer: (fn) => { liveTimer = fn; return 1 }, clearTimer: () => {} })
  t.after(() => liveEnv.store.close())
  const task = await liveEnv.service.submitProject(projectPacket(liveEnv.repository), liveEnv.projectConfig)
  liveEnv.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: 'bounded', role: 'implement', tools: ['read'], writeRoots: [liveEnv.repository] } })
  liveEnv.runtime.planFinalize({ taskId: task.id })
  await liveEnv.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await liveEnv.runtime.whenIdle(task.id)
  assert.equal(liveEnv.service.submitted.length, 1)
  now2 += 1001
  liveTimer()
  await liveEnv.runtime.whenIdle(task.id)
  const expired = liveEnv.store.get(task.id)
  assert.equal(expired.project.deadlines.expired, true)
  assert.equal(expired.status, 'failed')
  assert.equal(expired.project.seriousIssue.code, 'project-deadline-exceeded')
  assert.ok(liveEnv.service.cancelled.length >= 1, 'the live worker is cancelled at the deadline')
})

test('a cancelled supervisor round without a verified stop never fabricates a clean cancelled parent', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: 'bounded', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  await env.runtime.onSupervisorFinished(task.id, { status: 'cancelled', stopConfirmed: false, activeJobs: 1 })
  await env.runtime.whenIdle(task.id)
  const after = env.store.get(task.id)
  assert.notEqual(after.status, 'cancelled')
  assert.equal(after.stopConfirmed, false)
  assert.equal(after.project.status, 'blocked')
  assert.equal(env.ledger.has(`task:${task.id}`), true, 'an unstopped round keeps its model reservation')
  assert.equal(env.service.submitted.length, 0)
})

test('a submit failure BEFORE insertion is a clean refusal; AFTER insertion keeps the real child and its slot', async (t) => {
  // Pre-insertion: nothing crossed the boundary, so the refusal is clean and terminal.
  const pre = makeEnv()
  t.after(() => pre.store.close())
  const preTask = await pre.service.submitProject(projectPacket(pre.repository), pre.projectConfig)
  pre.runtime.workerCreate({ taskId: preTask.id, args: { workerKey: 'w1', objective: 'bounded', role: 'implement', tools: ['read'], writeRoots: [pre.repository] } })
  pre.runtime.planFinalize({ taskId: preTask.id })
  const originalPre = pre.service.submit.bind(pre.service)
  pre.service.submit = async () => { throw (() => { const error = new Error('refused before insertion'); error.code = 'PRE_INSERTION_REFUSAL'; return error })() }
  await pre.runtime.onSupervisorFinished(preTask.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await pre.runtime.whenIdle(preTask.id)
  const preAfter = pre.store.get(preTask.id)
  assert.equal(preAfter.status, 'failed')
  assert.equal(preAfter.project.status, 'failed')
  assert.equal(preAfter.stopConfirmed, true)
  assert.equal(pre.service.submitted.length, 0)
  assert.equal(workerOf(pre.store, preTask.id, 'w1').attempts[0].state, 'failed')
  assert.equal(workerOf(pre.store, preTask.id, 'w1').attempts[0].taskId, null)
  // The supervisor round POSITIVELY stopped (line above asserts the clean stop), so the
  // round's own model reservation is released exactly as the approved stop rule requires:
  // a pre-insertion refusal fabricates no WORKER task and no worker stop, but it must not
  // pin the supervisor's own model slot after its round has positively stopped.
  assert.equal(pre.ledger.has(`task:${preTask.id}`), false, 'a positively stopped supervisor round releases its own model reservation')

  // Post-insertion: a real child exists and owns a slot. It must be linked and retained.
  const post = makeEnv()
  t.after(() => post.store.close())
  const postTask = await post.service.submitProject(projectPacket(post.repository), post.projectConfig)
  post.runtime.workerCreate({ taskId: postTask.id, args: { workerKey: 'w1', objective: 'bounded', role: 'implement', tools: ['read'], writeRoots: [post.repository] } })
  post.runtime.planFinalize({ taskId: postTask.id })
  const original = post.service.submit.bind(post.service)
  post.service.submit = async (packet) => { await original(packet); throw new Error('transport failure AFTER task insertion') }
  await post.runtime.onSupervisorFinished(postTask.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await post.runtime.whenIdle(postTask.id)
  const inserted = post.service.submitted[0].id
  const attempt = workerOf(post.store, postTask.id, 'w1').attempts[0]
  assert.equal(attempt.taskId, inserted, 'the real inserted task identity is retained')
  assert.equal(attempt.state, 'unknown')
  assert.equal(attempt.stopConfirmed, false)
  const postAfter = post.store.get(postTask.id)
  assert.notEqual(postAfter.status, 'failed')
  assert.equal(postAfter.project.status, 'blocked')
  assert.equal(postAfter.project.seriousIssue.code, 'unknown-worker-work')
  assert.ok(post.store.events(postTask.id).some((event) =>
    event.type === 'project/serious-issue' && event.code === 'ambiguous-submit'),
  'the original submit ambiguity remains in durable evidence after aggregate evaluation')
  assert.match(attempt.ambiguity, /submit failed after inserting task/)
  assert.equal(attempt.error.message, 'transport failure AFTER task insertion')
  assert.equal(postAfter.stopConfirmed, false)
  assert.equal(post.ledger.has(`task:${inserted}`), true, 'the inserted child keeps its slot')
  assert.equal(postAfter.project.budgets.retries, 0, 'an ambiguous insertion is never retried')
})

test('a delayed workspace inspection retains every concurrent settlement and its dirty proof', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  let releaseInspect = () => {}
  const barrier = new Promise((resolve) => { releaseInspect = resolve })
  let inspectCalls = 0
  env.workspaces.inspect = async () => {
    inspectCalls += 1
    if (inspectCalls === 1) await barrier
    return { head: 'c'.repeat(40), dirty: true, changedPaths: ['src/changed.js'] }
  }
  const task = await env.service.submitProject(projectPacket(env.repository, { maxConcurrentWorkers: 2 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'bounded a', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'bounded b', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 2)
  const first = workerOf(env.store, task.id, 'a').attempts[0].taskId
  const second = workerOf(env.store, task.id, 'b').attempts[0].taskId
  // The first settlement blocks in inspect; the second settles while it is still delayed.
  const firstSettle = env.service.settle(first, { status: 'completed', stopConfirmed: true, activeJobs: 0, result: { text: 'a done' } })
  await env.service.settle(second, { status: 'completed', stopConfirmed: true, activeJobs: 0, result: { text: 'b done' } })
  releaseInspect()
  await firstSettle
  await env.runtime.whenIdle(task.id)
  const project = env.store.get(task.id).project
  const states = Object.fromEntries(project.workers.map((worker) => [worker.workerKey, worker.state]))
  assert.deepEqual(states, { a: 'succeeded', b: 'succeeded' }, 'the delayed inspection never clobbers the concurrent settlement')
  for (const worker of project.workers) {
    const attempt = worker.attempts[0]
    assert.equal(attempt.inspect?.dirty, true, `${worker.workerKey} keeps its dirty workspace proof`)
    assert.deepEqual(attempt.inspect?.changedPaths, ['src/changed.js'])
    assert.ok(attempt.resultDigest, `${worker.workerKey} keeps its result digest`)
  }
  assert.equal(env.store.get(task.id).status, 'completed')
})

test('start and tool budget exhaustion settles queued workers instead of waiting forever', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  // Only one start is fundable, so the second queued worker can never run.
  const task = await env.service.submitProject(projectPacket(env.repository, { maxWorkerStarts: 1, maxConcurrentWorkers: 3 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'bounded a', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'bounded b', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 1, 'the unfundable third start is never dispatched')
  const settled = env.store.get(task.id)
  assert.ok(['failed', 'unknown'].includes(settled.status), `a never-startable plan must settle, got ${settled.status}`)
  assert.notEqual(settled.project.status, 'pending')
  assert.equal(workerOf(env.store, task.id, 'b').attempts.length, 1)
  assert.equal(workerOf(env.store, task.id, 'b').attempts[0].budgetRefused, 'project-start-budget')
})

test('the packet contract refuses reserveSlots below one and read-only roles attenuate writes', async () => {
  const packet = projectPacket(HERE, { reserveSlots: 0 })
  assert.throws(() => validatePacket(packet), { code: 'INVALID_PACKET' })
  const grant = resolveProjectGrant(
    {
      maxWorkers: 4, maxConcurrentWorkers: 2, maxRepairAttempts: 2, maxTotalRetries: 8, maxWorkerStarts: 8,
      maxTotalToolCalls: 100, timeoutMs: 1000, reserveSlots: 1,
      workerScope: { readRoots: [HERE], writeRoots: [HERE], allowedTools: ['read', 'write', 'edit'], allowNetwork: false },
      workspace: { repository: HERE, baseRef: 'HEAD' }
    },
    normalizeProjectConfig({ enabled: true })
  )
  const context = { workerKeys: [], projectCwd: HERE }
  assert.throws(() => attenuateWorkerRequest(grant, { workerKey: 'r', objective: 'o', role: 'review', tools: ['read'], writeRoots: [HERE] }, context), { code: 'project/invalid-request' })
  const review = attenuateWorkerRequest(grant, { workerKey: 'r', objective: 'o', role: 'review', tools: ['read'] }, context)
  assert.deepEqual(review.writeRoots, [], 'a read-only role attenuates inherited write roots instead of receiving them')
  assert.equal(review.workspace, null, 'a read-only worker needs no writer worktree')
  const writer = attenuateWorkerRequest(grant, { workerKey: 'w', objective: 'o', role: 'implement', tools: ['write'], writeRoots: [HERE] }, context)
  assert.deepEqual(writer.writeRoots, [HERE])
  assert.deepEqual(writer.workspace, { repository: HERE, baseRef: 'HEAD' })
  assert.throws(() => attenuateWorkerRequest({ ...grant, workspace: undefined },
    { workerKey: 'w', objective: 'o', role: 'implement', tools: ['write'], writeRoots: [HERE] }, context),
  { code: 'project/workspace-required' })
})

test('the callback summary stays bounded and the project status tool reports honestly', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const longObjective = 'x'.repeat(600)
  const packet = projectPacket(env.repository)
  packet.objective = longObjective
  const task = await env.service.submitProject(packet, env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: longObjective, role: 'review', tools: ['read'] } })
  env.runtime.planFinalize({ taskId: task.id })
  const status = env.runtime.projectStatus({ taskId: task.id })
  assert.equal(status.status, 'frozen')
  assert.equal(status.workers.length, 1)
  assert.equal(status.frozen, true)
  const list = env.runtime.workerList({ taskId: task.id })
  assert.deepEqual(list.workers.map((worker) => worker.workerId), ['w1'])
  const empty = env.runtime.workerResult({ taskId: task.id, args: { workerId: 'w1' } })
  assert.equal(empty.totalChars, 0)
  assert.match(empty.uncertainties[0], /no dispatched task/)
  assert.throws(() => env.runtime.workerResult({ taskId: task.id, args: { workerId: 'nope' } }), { code: 'project/unknown-worker' })
  assert.throws(() => env.runtime.workerCreate({ taskId: 'missing', args: { workerKey: 'x', objective: 'y' } }), { code: 'project/unknown-task' })

  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0, finalText: 'y'.repeat(9000) })
  await env.runtime.whenIdle(task.id)
  const dispatched = env.store.get(task.id).project.workers[0].attempts[0].taskId
  await env.service.settle(dispatched, { status: 'completed', stopConfirmed: true, activeJobs: 0, result: { text: 'z'.repeat(9000) } })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.sinkCalls[0].summary.length <= MAX_PROJECT_SUMMARY_CHARS, true)
})

// ---------------------------------------------------------------------------
// repair-2 regressions: real service admission, receipt identity, canonical
// allowance, frozen replay, reentrancy and unknown cancellation.
// ---------------------------------------------------------------------------

/** Poll a predicate without ever blocking the event loop unboundedly. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A real BridgeService + project runtime over a fake host seam (no model is called). */
function makeRealEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-longtask-real-'))
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-longtask-realrepo-'))
  const store = new TaskStore({ directory: dir, ownerId: 'owner-real' })
  const starts = []
  const cancelled = []
  const timers = []
  const adapter = {
    models: async () => [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
    capabilities: async () => ({}),
    start: async (task) => {
      starts.push(task)
      return { sessionId: `fake-${task.id}`, requestId: `fake-${task.id}`, effectiveModel: task.effectiveModel }
    },
    cancel: async () => {
      cancelled.push({ at: Date.now() })
      return { accepted: true, stopConfirmed: true, remaining: [] }
    }
  }
  const projectConfig = normalizeProjectConfig({ enabled: true })
  const runtime = new SupervisorProjectRuntime({
    store,
    config: projectConfig,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {}
  })
  const service = new BridgeService({ store, adapter, projects: runtime, maxConcurrent: 4 })
  runtime.attach({ service })
  return { dir, repository, store, service, runtime, starts, cancelled, timers, projectConfig }
}

function realProjectPacket(repository, overrides = {}, idempotencyKey = 'real-project-1') {
  return {
    schemaVersion: 1,
    idempotencyKey,
    revision: 1,
    projectId: 'real-pj',
    title: 'real project',
    objective: 'bounded supervisor round',
    cwd: repository,
    role: 'investigate',
    acceptance: ['the project is bounded'],
    scope: { readRoots: [repository], writeRoots: [], allowedTools: ['read'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [],
    contractVersion: 'v1',
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    budget: { timeoutMs: 10000, maxToolCalls: 10, maxOutputChars: 1000 },
    project: {
      maxWorkers: 2,
      maxConcurrentWorkers: 1,
      maxRepairAttempts: 0,
      maxTotalRetries: 0,
      maxWorkerStarts: 1,
      maxTotalToolCalls: 2,
      timeoutMs: 1000,
      reserveSlots: 1,
      workerScope: { readRoots: [repository], writeRoots: [], allowedTools: ['read'], allowNetwork: false },
      ...overrides
    }
  }
}

test('the real service admission arms the deadline and clamps the supervisor budget before any tool', async (t) => {
  const env = makeRealEnv()
  t.after(() => { env.service.close(); env.runtime.close(); env.store.close() })
  const submitted = await env.service.submit(realProjectPacket(env.repository))
  // Admission happens after persistence and before dispatch: exactly one live timer is
  // armed even though no dsh_supervisor_* tool has been called.
  assert.equal(env.timers.length, 1, 'exactly one deadline timer is armed at admission')
  assert.ok(env.timers[0].ms > 0 && env.timers[0].ms <= 1000, 'the armed delay is bounded by the granted project timeout')
  const persisted = env.store.get(submitted.id)
  assert.equal(persisted.effectivePacket.budget.maxToolCalls, 2, 'the supervisor effective tool budget is clamped to the grant')
  assert.ok(persisted.effectivePacket.budget.timeoutMs <= 1000, 'the supervisor effective timeout is clamped to the grant')
  assert.equal(persisted.packet.budget.maxToolCalls, 10, 'the immutable original request tool budget is preserved')
  assert.equal(persisted.packet.budget.timeoutMs, 10000, 'the immutable original request timeout is preserved')

  assert.ok(await waitFor(() => env.starts.length === 1), 'the admitted project is dispatched by the real service')
  assert.equal(env.starts[0].effectivePacket.budget.maxToolCalls, 2, 'the adapter receives the clamped effective packet')
  // A silent planner expires: the timer drives the serialized transition and the project
  // converges instead of hanging in planning forever.
  for (const timer of env.timers) timer.fn()
  const converged = await waitFor(() => ['completed', 'failed', 'cancelled', 'blocked'].includes(env.store.get(submitted.id).project.status))
  assert.equal(converged, true, 'the expired project converges to an honest final state')
  const after = env.store.get(submitted.id)
  assert.notEqual(after.project.status, 'planning')
  assert.notEqual(after.status, 'running')
  assert.ok(env.cancelled.length >= 1, 'expiry cancels the ACTUAL supervisor round through the service')
})

test('a project task settlement still kicks the shared drain', async (t) => {
  const env = makeRealEnv()
  t.after(() => { env.service.close(); env.runtime.close(); env.store.close() })
  const submitted = await env.service.submit(realProjectPacket(env.repository))
  assert.ok(await waitFor(() => env.starts.length === 1))
  let kicks = 0
  const original = env.service.kick.bind(env.service)
  env.service.kick = () => { kicks += 1; original() }
  env.service.finish(submitted.id, { status: 'completed', stopConfirmed: true, activeJobs: 0, finalText: 'round ended without a frozen plan' })
  assert.ok(kicks >= 1, 'a project finish must still kick the shared drain')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.notEqual(env.store.get(submitted.id).project.status, 'running')
})

test('an identical frozen worker replay is reused while a changed definition conflicts', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'read a', role: 'review', tools: ['read'] } })
  env.runtime.planFinalize({ taskId: task.id })
  const replay = env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'read a', role: 'review', tools: ['read'] } })
  assert.equal(replay.idempotentReplay, true, 'an identical replay of a frozen plan returns the existing worker')
  assert.equal(env.store.get(task.id).project.workers.length, 1)
  assert.throws(
    () => env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'read something else', role: 'review', tools: ['read'] } }),
    { code: 'project/replay-conflict' },
    'a changed re-declaration must conflict, never mutate the frozen definition'
  )
  assert.throws(
    () => env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'new worker', role: 'review', tools: ['read'] } }),
    { code: 'project/plan-frozen' },
    'a genuinely new worker after freeze is still refused'
  )
  assert.equal(env.store.get(task.id).project.workers.length, 1)
})

test('released spend is counted once: a parallel reservation never double counts or blocks', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { maxTotalToolCalls: 6, maxConcurrentWorkers: 2, reserveSlots: 1 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'bounded a', role: 'implement', tools: ['read'], writeRoots: [env.repository], budgets: { maxToolCalls: 3 } } })
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'bounded b', role: 'implement', tools: ['read'], writeRoots: [env.repository], budgets: { maxToolCalls: 3 } } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 2)
  // Every REAL submitted worker task is persisted on its attempt before aggregation.
  assert.deepEqual(
    env.store.get(task.id).project.workers.map((worker) => worker.attempts[0].taskId),
    env.service.submitted.map((entry) => entry.id),
    'every submitted worker receipt identity is persisted'
  )
  const first = env.service.submitted[0].id
  await env.service.settle(first, { status: 'completed', stopConfirmed: true, activeJobs: 0, stats: { toolCalls: 2 }, result: { text: 'a done' } })
  await env.runtime.whenIdle(task.id)
  const mid = env.store.get(task.id).project
  assert.equal(mid.budgets.toolSpend, 2, 'the released spend is credited exactly once')
  assert.equal(mid.budgetExhausted, undefined, 'a released 2 plus a reserved 3 is not an overspend of 6')
  assert.notEqual(mid.status, 'blocked', 'the second worker may still release its reservation')
  const second = env.store.get(task.id).project.workers.find((worker) => worker.workerKey === 'b').attempts[0].taskId
  await env.service.settle(second, { status: 'completed', stopConfirmed: true, activeJobs: 0, stats: { toolCalls: 3 }, result: { text: 'b done' } })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.store.get(task.id).status, 'completed')
})

test('a temporary allowance reservation waits for release instead of refusing the queued worker', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { maxTotalToolCalls: 3, maxConcurrentWorkers: 2, reserveSlots: 1 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'bounded a', role: 'implement', tools: ['read'], writeRoots: [env.repository], budgets: { maxToolCalls: 3 } } })
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'bounded b', role: 'implement', tools: ['read'], writeRoots: [env.repository], budgets: { maxToolCalls: 3 } } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  // Worker a holds the whole grant; b is neither started nor permanently refused.
  assert.equal(env.service.submitted.length, 1)
  assert.equal(workerOf(env.store, task.id, 'b').attempts.length, 0, 'a temporary reservation never fabricates a refusal')
  assert.notEqual(env.store.get(task.id).status, 'failed')
  // a's verified stop releases the unused allowance and b is funded with the remainder.
  await env.service.settle(env.service.submitted[0].id, { status: 'completed', stopConfirmed: true, activeJobs: 0, stats: { toolCalls: 1 }, result: { text: 'a done' } })
  await env.runtime.whenIdle(task.id)
  assert.equal(env.service.submitted.length, 2, 'the queued worker starts once allowance is released')
  const resumed = env.service.submitted.find((entry) => entry.packet.idempotencyKey === workerAttemptKey(task.id, 'b', 1))
  assert.ok(resumed, 'worker b is dispatched with a real deterministic key')
  assert.equal(resumed.packet.budget.maxToolCalls, 2, 'only the released remainder is re-granted')
  assert.equal(workerOf(env.store, task.id, 'b').attempts[0].retryBlocked, undefined)
})

test('unknown cancellation stays blocked, keeps capacity and never fabricates a clean terminal', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { maxConcurrentWorkers: 2, reserveSlots: 1 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'bounded a', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'bounded b', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  const first = workerOf(env.store, task.id, 'a').attempts[0].taskId
  const second = workerOf(env.store, task.id, 'b').attempts[0].taskId
  await env.service.settle(first, { status: 'completed', stopConfirmed: true, activeJobs: 0, result: { text: 'a done' } })
  await env.runtime.whenIdle(task.id)
  // The host cannot confirm the stop of b and the task is already an honest unknown.
  env.service.cancel = async () => ({ accepted: true, stopConfirmed: false })
  const project = env.store.get(task.id).project
  env.store.update(task.id, { status: 'unknown', project: { ...project, status: 'blocked' } })
  const cancel = await env.runtime.requestProjectCancel(task.id, 'synthetic unknown stop test')
  assert.equal(cancel.confirmed, false, 'a cancellation with unverified owned work is never confirmed')
  assert.equal(cancel.unverified, undefined, 'no unverified terminal cancellation is fabricated')
  const after = env.store.get(task.id)
  assert.equal(after.status, 'unknown')
  assert.equal(after.stopConfirmed, false)
  assert.equal(after.project.status, 'blocked')
  assert.equal(env.ledger.has(`task:${second}`), true, 'the unverified worker keeps its slot')
})

test('an inline worker settlement during cancellation never deadlocks the project chain', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  // The stub fires onTaskSettled INLINE from cancel exactly like a synchronous host seam.
  const task = await env.service.submitProject(projectPacket(env.repository, { maxRepairAttempts: 0, maxConcurrentWorkers: 2, reserveSlots: 1 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'a', objective: 'bounded a', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'b', objective: 'bounded b', role: 'implement', tools: ['read'], writeRoots: [env.repository] } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  const first = workerOf(env.store, task.id, 'a').attempts[0].taskId
  // a's ordinary failure under a zero repair cap makes the project cancel the live b.
  await env.service.settle(first, { status: 'failed', stopConfirmed: true, activeJobs: 0, result: { text: 'a failed' } })
  await env.runtime.whenIdle(task.id)
  const settled = env.store.get(task.id)
  assert.equal(settled.status, 'failed', 'the chain converges instead of awaiting itself')
  assert.equal(settled.project.status, 'failed')
})

test('an unreadable stop-proof receipt charges the full granted allowance, never zero', async (t) => {
  const env = makeEnv()
  t.after(() => env.store.close())
  const task = await env.service.submitProject(projectPacket(env.repository, { maxTotalToolCalls: 4, reserveSlots: 1 }), env.projectConfig)
  env.runtime.workerCreate({ taskId: task.id, args: { workerKey: 'w1', objective: 'bounded', role: 'implement', tools: ['read'], writeRoots: [env.repository], budgets: { maxToolCalls: 2 } } })
  env.runtime.planFinalize({ taskId: task.id })
  await env.runtime.onSupervisorFinished(task.id, { status: 'completed', stopConfirmed: true, activeJobs: 0 })
  await env.runtime.whenIdle(task.id)
  const dispatched = workerOf(env.store, task.id, 'w1').attempts[0].taskId
  const settledTask = env.store.get(dispatched)
  const originalGet = env.store.get.bind(env.store)
  env.store.get = (id) => {
    if (id === dispatched) throw new Error('receipt unreadable')
    return originalGet(id)
  }
  await env.runtime.onTaskSettled({ ...settledTask, status: 'completed', stopConfirmed: true, activeJobs: 0, result: { text: 'done' } })
  await env.runtime.whenIdle(task.id)
  const project = env.store.get(task.id).project
  assert.equal(project.budgets.toolSpend, 2, 'an unreadable receipt is charged its FULL granted cap, never zero')
})
