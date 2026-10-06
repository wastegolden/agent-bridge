// test/command-jobs.test.mjs
//
// Falsifiable tests for the controlled background-job contract
// (`supervisor-event-wake-v1`): operator-approved profiles only, exact
// executable/argv/cwd/env with shell:false, real owned `ctx.jobs.start`
// producers, observed stop proof, ownership refusals that are never retried
// under another identity, restart ambiguity and honest isolation flags.
//
// Evidence class: in-process unit tests with an in-memory jobs registry double
// and an injected spawn double. No real process is started, no shell is used,
// no DSH host is touched.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMMAND_JOB_KIND,
  CommandProfileRegistry,
  commandJobsCapability,
  recoverCommandJobs,
  startCommandJob,
  stopCommandJob
} from '../src/command-jobs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function baseProfile(overrides = {}) {
  return {
    id: 'echo',
    executable: process.execPath,
    argv: ['-e', 'process.exit(0)'],
    cwd: HERE,
    env: { CI: '1' },
    timeoutMs: 1000,
    maxOutputBytes: 4096,
    ...overrides
  }
}

function expectCode(fn, code) {
  let error
  try {
    fn()
  } catch (failure) {
    error = failure
  }
  assert.ok(error, `expected a failure with code ${code}`)
  assert.equal(error.code, code)
  assert.equal(JSON.stringify(error.details ?? {}).includes('SECRET_TOKEN'), false, 'no credential value may leak into an error')
  return error
}

/** In-memory jobs registry double implementing the installed owned contract. */
function fakeJobs() {
  const jobs = new Map()
  const calls = []
  let sequence = 0
  const api = {
    start(spec) {
      calls.push({ kind: 'start', spec })
      sequence += 1
      const id = `command-${sequence}`
      const record = { id, owner: spec.owner, status: 'running', spec, hooks: null }
      record.hooks = spec.run({ id, append() {}, updateProgress() {} })
      jobs.set(id, record)
      return id
    },
    get(id, caller) {
      calls.push({ kind: 'get', id, caller })
      const record = jobs.get(id)
      if (record === undefined) throw Object.assign(new Error('unknown job'), { code: 'job/not-found' })
      if (caller !== record.owner) throw Object.assign(new Error('foreign job'), { code: 'job/foreign' })
      return { id: record.id, owner: record.owner, status: record.status, kind: record.spec.kind }
    },
    kill(id, caller, reason) {
      calls.push({ kind: 'kill', id, caller, reason })
      const record = jobs.get(id)
      if (record === undefined || caller !== record.owner) throw Object.assign(new Error('foreign job'), { code: 'job/foreign' })
      record.hooks.cancel(reason)
      return 'requested'
    },
    async wait(id, timeoutMs, caller) {
      calls.push({ kind: 'wait', id, caller, timeoutMs })
      const record = jobs.get(id)
      if (record === undefined || caller !== record.owner) throw Object.assign(new Error('foreign job'), { code: 'job/foreign' })
      if (record.noSettle === true) throw Object.assign(new Error('wait timed out'), { code: 'job/timeout' })
      const outcome = await record.hooks.done
      record.status = outcome.status
      return { id: record.id, owner: record.owner, status: outcome.status }
    },
    /** Test-only pump over the producer's declared output sources. */
    read(id) {
      const record = jobs.get(id)
      let text = ''
      for (const source of record.spec.output ?? []) text += source.read(0).text
      return text
    }
  }
  return { calls, jobs, ctx: { get: (name) => (name === 'jobs' ? api : undefined) }, api }
}

/** Spawn double: never starts a process. */
function fakeSpawn(behaviour = {}) {
  const calls = []
  const spawnImpl = (executable, argv, options) => {
    calls.push({ executable, argv, options })
    const listeners = new Map()
    const child = {
      stdout: { on: (event, listener) => { if (event === 'data') listeners.set('stdout', listener); return child } },
      stderr: { on: (event, listener) => { if (event === 'data') listeners.set('stderr', listener); return child } },
      on: (event, listener) => {
        listeners.set(event, listener)
        return child
      },
      kill: () => {
        if (behaviour.killCloses === true) listeners.get('close')?.(null, 'SIGTERM')
        return true
      }
    }
    if (behaviour.output !== undefined) queueMicrotask(() => listeners.get('stdout')?.(behaviour.output))
    if (behaviour.closesOnItsOwn === true) queueMicrotask(() => listeners.get('close')?.(0, null))
    return child
  }
  return { calls, spawnImpl }
}

test('the profile registry refuses shell strings, relative executables, claimed isolation and unverifiable pins', () => {
  expectCode(() => new CommandProfileRegistry({ profiles: [baseProfile({ command: 'rm -rf /' })] }), 'jobs/invalid-profile')
  expectCode(() => new CommandProfileRegistry({ profiles: [baseProfile({ executable: 'node' })] }), 'jobs/invalid-profile')
  expectCode(() => new CommandProfileRegistry({ profiles: [baseProfile({ argv: 'not-an-array' })] }), 'jobs/invalid-profile')
  expectCode(() => new CommandProfileRegistry({ profiles: [baseProfile({ cwd: 'relative' })] }), 'jobs/invalid-profile')
  expectCode(() => new CommandProfileRegistry({ profiles: [baseProfile({ env: { 'BAD KEY': 'x' } })] }), 'jobs/invalid-profile')
  expectCode(() => new CommandProfileRegistry({ profiles: [baseProfile({ timeoutMs: 0 })] }), 'jobs/invalid-profile')
  expectCode(() => new CommandProfileRegistry({ profiles: [baseProfile({ isolation: { network: true } })] }), 'jobs/isolation-unenforceable')
  expectCode(
    () => new CommandProfileRegistry({ profiles: [baseProfile({ pinnedInputs: [{ path: path.join(HERE, 'missing.txt'), sha256: 'a'.repeat(64) }] })] }),
    'jobs/pinned-input-unavailable'
  )
  expectCode(
    () => new CommandProfileRegistry({ profiles: [baseProfile({ cwd: os.tmpdir() })], allowedRoots: [HERE] }),
    'jobs/invalid-profile'
  )

  // A real pinned input with a mismatched digest is refused before any job.
  const pinPath = path.join(HERE, 'command-jobs.test.mjs')
  expectCode(
    () => new CommandProfileRegistry({ profiles: [baseProfile({ pinnedInputs: [{ path: pinPath, sha256: 'b'.repeat(64) }] })] }),
    'jobs/pinned-input-changed'
  )
})

test('the profile listing reports env NAMES only and honest isolation flags', () => {
  const registry = new CommandProfileRegistry({ profiles: [baseProfile({ env: { CI: '1', SECRET_TOKEN: 'do-not-print' } })] })
  const listed = registry.listSafe()
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0].envKeys, ['CI', 'SECRET_TOKEN'])
  assert.equal(JSON.stringify(listed).includes('do-not-print'), false, 'env values are never echoed')
  assert.equal(listed[0].isolation.process, false)
  assert.equal(listed[0].isolation.filesystem, false)
  assert.equal(listed[0].isolation.network, false)
  assert.match(listed[0].note, /not an OS sandbox/i)
  expectCode(() => registry.resolve('ghost'), 'jobs/profile-unknown')
})

test('starting a job refuses a host without a jobs registry and a registry that cannot start work', () => {
  const registry = new CommandProfileRegistry({ profiles: [baseProfile()] })
  const spawn = fakeSpawn({})
  expectCode(() => startCommandJob({ ctx: { get: () => undefined }, registry, profileId: 'echo', owner: 's1', spawnImpl: spawn.spawnImpl }), 'jobs/controller-unavailable')
  expectCode(() => startCommandJob({ ctx: { get: () => ({}) }, registry, profileId: 'echo', owner: 's1', spawnImpl: spawn.spawnImpl }), 'jobs/controller-unavailable')
  expectCode(() => startCommandJob({ ctx: fakeJobs().ctx, registry, profileId: 'ghost', owner: 's1', spawnImpl: spawn.spawnImpl }), 'jobs/profile-unknown')
  expectCode(() => startCommandJob({ ctx: fakeJobs().ctx, registry, profileId: 'echo', owner: '', spawnImpl: spawn.spawnImpl }), 'jobs/invalid-owner')

  const throwing = { get: () => ({ start: () => { throw Object.assign(new Error('no controller for this owner'), { code: 'jobs/no-controller' }) } }) }
  expectCode(() => startCommandJob({ ctx: throwing, registry, profileId: 'echo', owner: 's1', spawnImpl: spawn.spawnImpl }), 'jobs/manager-unavailable')
})

test('a started job is a real owned producer with exact profile argv, cwd, env and shell:false', async () => {
  const registry = new CommandProfileRegistry({ profiles: [baseProfile({ argv: ['-e', 'process.stdout.write("ok")'], env: { CI: '1' }, maxOutputBytes: 2048 })] })
  const fake = fakeJobs()
  const spawn = fakeSpawn({ output: 'ok', closesOnItsOwn: true })
  const started = startCommandJob({ ctx: fake.ctx, registry, profileId: 'echo', owner: 'session-1', label: 'probe', spawnImpl: spawn.spawnImpl })
  assert.match(started.jobId, /^command-\d+$/)
  assert.equal(started.profileId, 'echo')
  assert.equal(started.owner, 'session-1')
  assert.equal(started.outputLimitBytes, 2048)
  assert.equal(started.isolation.filesystem, false)
  assert.match(started.isolation.note, /not an OS sandbox/i)

  const spec = fake.calls.find((entry) => entry.kind === 'start').spec
  assert.equal(spec.kind, COMMAND_JOB_KIND)
  assert.equal(spec.owner, 'session-1')
  assert.equal(spec.outputLimitBytes, 2048)
  assert.deepEqual(spec.output.map((source) => source.channel), ['stdout', 'stderr'], 'the ring is fed by declared pull sources')

  assert.equal(spawn.calls[0].executable, process.execPath)
  assert.deepEqual(spawn.calls[0].argv, ['-e', 'process.stdout.write("ok")'])
  assert.equal(spawn.calls[0].options.cwd, HERE)
  assert.deepEqual(spawn.calls[0].options.env, { CI: '1' })
  assert.equal(spawn.calls[0].options.shell, false)
  assert.deepEqual(spawn.calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.match(fake.api.read(started.jobId), /ok/, 'the produced bytes reach the job ring')
  const stopped = await stopCommandJob({ ctx: fake.ctx, jobId: started.jobId, owner: 'session-1', profileId: 'echo' })
  assert.equal(stopped.stopConfirmed, true)
  assert.ok(['completed', 'killed'].includes(stopped.outcome))
})

test('stop proof is observed: a proven exit confirms, an unsettled wait stays unknown', async () => {
  const registry = new CommandProfileRegistry({ profiles: [baseProfile()] })
  const proven = fakeJobs()
  const spawn = fakeSpawn({ killCloses: true })
  const started = startCommandJob({ ctx: proven.ctx, registry, profileId: 'echo', owner: 's1', spawnImpl: spawn.spawnImpl })
  const confirmed = await stopCommandJob({ ctx: proven.ctx, jobId: started.jobId, owner: 's1' })
  assert.equal(confirmed.requested, true)
  assert.equal(confirmed.status, 'killed')
  assert.equal(confirmed.stopConfirmed, true)

  const unproven = fakeJobs()
  const stuck = startCommandJob({ ctx: unproven.ctx, registry, profileId: 'echo', owner: 's1', spawnImpl: fakeSpawn({}).spawnImpl })
  unproven.jobs.get(stuck.jobId).noSettle = true
  const unknown = await stopCommandJob({ ctx: unproven.ctx, jobId: stuck.jobId, owner: 's1', timeoutMs: 1 })
  assert.equal(unknown.stopConfirmed, false, 'an unconfirmed stop is never reported as a stop')
  assert.equal(unknown.outcome, 'unknown')
  assert.equal(unknown.status, null)
})

test('a foreign job is refused as jobs/not-owned and never retried under another identity', async () => {
  const registry = new CommandProfileRegistry({ profiles: [baseProfile()] })
  const fake = fakeJobs()
  const started = startCommandJob({ ctx: fake.ctx, registry, profileId: 'echo', owner: 'session-1', spawnImpl: fakeSpawn({}).spawnImpl })
  await assert.rejects(() => stopCommandJob({ ctx: fake.ctx, jobId: started.jobId, owner: 'session-9' }), { code: 'jobs/not-owned' })
  const gets = fake.calls.filter((entry) => entry.kind === 'get')
  assert.equal(gets.length, 1, 'the refusal must not be retried under another identity')
  assert.equal(gets[0].caller, 'session-9')
  assert.equal(fake.calls.some((entry) => entry.kind === 'kill'), false, 'a non-owner never reaches a kill')
})

test('recovery marks persisted unfinished jobs unknown and never reattaches them', () => {
  const records = [
    { jobId: 'command-1', profileId: 'echo', state: 'running', stopConfirmed: false },
    { jobId: 'command-2', profileId: 'echo', state: 'settled', stopConfirmed: true },
    { jobId: 'command-3', profileId: 'echo', state: 'unknown' }
  ]
  const recovery = recoverCommandJobs(records)
  assert.equal(recovery.length, 2)
  assert.deepEqual(recovery.map((entry) => entry.jobId), ['command-1', 'command-3'])
  for (const entry of recovery) {
    assert.equal(entry.state, 'unknown')
    assert.equal(entry.stopConfirmed, false)
    assert.equal(entry.recovery, 'unknown')
    assert.match(entry.reason, /never reattached/)
  }
})

test('the capability report is truthful about an unenforceable or absent job path', () => {
  const registry = new CommandProfileRegistry({ profiles: [baseProfile()] })
  const absent = commandJobsCapability({ ctx: { get: () => undefined }, registry, enabled: true })
  assert.equal(absent.supported, false)
  assert.match(absent.refusal, /ctx\.jobs/)
  assert.equal(absent.isolation.process, false)
  assert.match(absent.enforced, /not an OS sandbox/i)

  const disabled = commandJobsCapability({ ctx: fakeJobs().ctx, registry, enabled: false })
  assert.equal(disabled.supported, false)
  assert.match(disabled.refusal, /enabled is false/)

  const supported = commandJobsCapability({ ctx: fakeJobs().ctx, registry, enabled: true })
  assert.equal(supported.supported, true)
  assert.equal(supported.refusal, null)
  assert.equal(supported.profiles.length, 1)
})
