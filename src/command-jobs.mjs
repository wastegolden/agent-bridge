// src/command-jobs.mjs
//
// Controlled background jobs for the DSH Codex Bridge (contract
// `supervisor-event-wake-v1`).
//
// A bridge job is started from an OPERATOR-APPROVED command profile: an exact
// executable path, an exact argv array, an exact cwd, an exact environment map
// and a bounded timeout/output cap. There is no shell string, no model-supplied
// argument, no PATH search and no second identity: `spawn(executable, argv,
// {shell:false, ...})` receives literally what the profile declares.
//
// Isolation is reported HONESTLY. This module does not create an OS sandbox; a
// profile that claims one is refused (`jobs/isolation-unenforceable`) instead of
// being advertised as confined. The capability report states that an approved
// profile allowlist is not a sandbox.
//
// Jobs are real owned producers on `ctx.jobs.start(spec)`: the registry owns
// identity, lifecycle and the output ring, `owner` is the real sessionId, and
// access is fenced by that owner for every read/kill. When the host has no
// jobs registry/controller, the module refuses with a precise capability error
// and never fakes a job.
//
// Stop proof is observed, never inferred: `stopCommandJob` kills and then waits
// for the registry's terminal projection; an unconfirmed stop is `unknown`. The
// process-local registry does not prove persistence after a restart, so
// `recoverCommandJobs` marks unfinished persisted jobs `unknown` and never
// reattaches or replays them.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

/** Registered job kind (`<kind>-N` id prefix). The registry treats kinds as opaque. */
export const COMMAND_JOB_KIND = 'command'

/** Profile env key shape accepted from operator configuration. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

const ISOLATION_NOTE =
  'exact operator executable/argv/cwd/env profile executed with shell:false; an approved profile allowlist is NOT an OS sandbox and no process, filesystem or network isolation is claimed'

/** Domain failure with a stable `.code`. */
export function jobError(code, message, details) {
  const error = new Error(message)
  error.code = code
  // Marks a bridge-authored refusal so a host-supplied `jobs/*` error is never
  // mistaken for one and is wrapped instead.
  error.bridgeJobError = true
  if (details !== undefined) error.details = details
  return error
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function message(error) {
  return String((error && error.message) || error)
}

/**
 * Bounded chunk log behind one job output source. Chunks keep their absolute
 * byte offsets; retention drops whole chunks from the head and a read below the
 * retained window is reported lossy instead of erroring.
 */
class ChunkLog {
  #chunks = []
  #total = 0
  #earliest = 0
  #maxBytes

  constructor(maxBytes) {
    this.#maxBytes = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 65536
  }

  get total() {
    return this.#total
  }

  get earliest() {
    return this.#earliest
  }

  append(text) {
    if (typeof text !== 'string' || text.length === 0) return
    const bytes = Buffer.byteLength(text, 'utf8')
    this.#chunks.push({ at: this.#total, text })
    this.#total += bytes
    while (this.#total - this.#earliest > this.#maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift()
      this.#earliest = dropped.at + Buffer.byteLength(dropped.text, 'utf8')
    }
  }

  /** Non-consuming read from an absolute offset. */
  read(fromByte) {
    const from = Number.isInteger(fromByte) && fromByte >= 0 ? fromByte : 0
    const start = Math.max(from, this.#earliest)
    const parts = []
    for (const chunk of this.#chunks) {
      const end = chunk.at + Buffer.byteLength(chunk.text, 'utf8')
      if (end > start) parts.push(chunk.text)
    }
    return { text: parts.join(''), nextOffset: this.#total, lossy: from < this.#earliest }
  }
}

function isolationOf(profile) {
  return {
    process: false,
    filesystem: false,
    network: false,
    note: ISOLATION_NOTE,
    declared: isPlainObject(profile.isolation) ? { ...profile.isolation } : { process: false, filesystem: false, network: false }
  }
}

function normalizeProfile(profile, index, allowedRoots) {
  const field = `profiles[${index}]`
  if (!isPlainObject(profile)) throw jobError('jobs/invalid-profile', `${field} must be a plain object`, { field })
  if (profile.command !== undefined || profile.shell !== undefined || profile.rawShell !== undefined) {
    throw jobError('jobs/invalid-profile', `${field} must not carry a shell command string; profiles declare executable+argv only`, { field })
  }
  if (!nonBlank(profile.id) || profile.id.length > 200) {
    throw jobError('jobs/invalid-profile', `${field}.id must be a nonblank string of at most 200 characters`, { field: `${field}.id` })
  }
  if (!nonBlank(profile.executable) || profile.executable.includes('\n') || !path.isAbsolute(profile.executable)) {
    throw jobError('jobs/invalid-profile', `${field}.executable must be an absolute executable path without a PATH search`, {
      field: `${field}.executable`
    })
  }
  if (!Array.isArray(profile.argv) || profile.argv.some((arg) => typeof arg !== 'string' || arg.includes('\u0000'))) {
    throw jobError('jobs/invalid-profile', `${field}.argv must be an array of strings without NUL`, { field: `${field}.argv` })
  }
  if (!nonBlank(profile.cwd) || profile.cwd.includes('\n') || !path.isAbsolute(profile.cwd)) {
    throw jobError('jobs/invalid-profile', `${field}.cwd must be an absolute directory path`, { field: `${field}.cwd` })
  }
  let stat
  try {
    stat = fs.statSync(profile.cwd)
  } catch (error) {
    throw jobError('jobs/invalid-profile', `${field}.cwd cannot be read: ${message(error)}`, { field: `${field}.cwd` })
  }
  if (!stat.isDirectory()) throw jobError('jobs/invalid-profile', `${field}.cwd is not a directory`, { field: `${field}.cwd` })
  if (Array.isArray(allowedRoots) && allowedRoots.length > 0) {
    const inside = allowedRoots.some((root) => {
      const rel = path.relative(root, profile.cwd)
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    })
    if (!inside) {
      throw jobError('jobs/invalid-profile', `${field}.cwd "${profile.cwd}" is outside the configured command roots`, {
        field: `${field}.cwd`
      })
    }
  }
  if (!isPlainObject(profile.env)) {
    throw jobError('jobs/invalid-profile', `${field}.env must be an exact plain object of string values`, { field: `${field}.env` })
  }
  const env = {}
  for (const [key, value] of Object.entries(profile.env)) {
    if (!ENV_KEY.test(key)) throw jobError('jobs/invalid-profile', `${field}.env key "${key}" is not a valid environment name`, { field: `${field}.env` })
    if (typeof value !== 'string' || value.includes('\u0000')) {
      throw jobError('jobs/invalid-profile', `${field}.env["${key}"] must be a string without NUL`, { field: `${field}.env` })
    }
    env[key] = value
  }
  if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 600000) {
    throw jobError('jobs/invalid-profile', `${field}.timeoutMs must be an integer 1..600000`, { field: `${field}.timeoutMs` })
  }
  if (!Number.isInteger(profile.maxOutputBytes) || profile.maxOutputBytes < 1024 || profile.maxOutputBytes > 10_000_000) {
    throw jobError('jobs/invalid-profile', `${field}.maxOutputBytes must be an integer 1024..10000000`, { field: `${field}.maxOutputBytes` })
  }
  const pinnedInputs = []
  if (profile.pinnedInputs !== undefined) {
    if (!Array.isArray(profile.pinnedInputs)) {
      throw jobError('jobs/invalid-profile', `${field}.pinnedInputs must be an array`, { field: `${field}.pinnedInputs` })
    }
    for (const [inputIndex, input] of profile.pinnedInputs.entries()) {
      if (!isPlainObject(input) || !nonBlank(input.path) || !path.isAbsolute(input.path) || typeof input.sha256 !== 'string') {
        throw jobError('jobs/invalid-profile', `${field}.pinnedInputs[${inputIndex}] requires an absolute path and a sha256`, {
          field: `${field}.pinnedInputs`
        })
      }
      const claimed = input.sha256.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(claimed)) {
        throw jobError('jobs/invalid-profile', `${field}.pinnedInputs[${inputIndex}].sha256 must be a 64 character hex digest`, {
          field: `${field}.pinnedInputs`
        })
      }
      let actual
      try {
        actual = createHash('sha256').update(fs.readFileSync(input.path)).digest('hex')
      } catch (error) {
        throw jobError('jobs/pinned-input-unavailable', `${field}.pinnedInputs[${inputIndex}] cannot be read: ${message(error)}`, {
          field: `${field}.pinnedInputs`
        })
      }
      if (actual !== claimed) {
        throw jobError('jobs/pinned-input-changed', `${field}.pinnedInputs[${inputIndex}] hash does not match the approved pin`, {
          field: `${field}.pinnedInputs`
        })
      }
      pinnedInputs.push({ path: input.path, sha256: claimed })
    }
  }
  if (isPlainObject(profile.isolation)) {
    for (const key of ['process', 'filesystem', 'network']) {
      if (profile.isolation[key] === true) {
        throw jobError('jobs/isolation-unenforceable', `${field}.isolation.${key} claims an OS confinement this deployment cannot enforce`, {
          field: `${field}.isolation.${key}`
        })
      }
    }
  }
  return Object.freeze({
    id: profile.id,
    executable: profile.executable,
    argv: [...profile.argv],
    cwd: profile.cwd,
    env: Object.freeze({ ...env }),
    timeoutMs: profile.timeoutMs,
    maxOutputBytes: profile.maxOutputBytes,
    pinnedInputs: Object.freeze(pinnedInputs),
    isolation: Object.freeze({ process: false, filesystem: false, network: false })
  })
}

/**
 * Operator-approved command profiles. Constructed from trusted host config; a
 * model can only NAME an id, never supply a command.
 */
export class CommandProfileRegistry {
  #profiles = new Map()

  /**
   * @param {{profiles?: object[], allowedRoots?: string[]}} config - approved profiles and optional cwd roots.
   */
  constructor({ profiles = [], allowedRoots = [] } = {}) {
    if (!Array.isArray(profiles)) throw jobError('jobs/invalid-profile', 'profiles must be an array', {})
    if (!Array.isArray(allowedRoots) || allowedRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
      throw jobError('jobs/invalid-config', 'allowedRoots must be an array of absolute paths', {})
    }
    this.allowedRoots = [...allowedRoots]
    profiles.forEach((profile, index) => {
      const normalized = normalizeProfile(profile, index, this.allowedRoots)
      if (this.#profiles.has(normalized.id)) throw jobError('jobs/invalid-profile', `duplicate command profile id "${normalized.id}"`, {})
      this.#profiles.set(normalized.id, normalized)
    })
  }

  get ids() {
    return [...this.#profiles.keys()]
  }

  has(id) {
    return nonBlank(id) && this.#profiles.has(id)
  }

  /** Resolve one granted profile or refuse with `jobs/profile-unknown`. */
  resolve(id) {
    if (!nonBlank(id) || !this.#profiles.has(id)) {
      throw jobError('jobs/profile-unknown', `command profile "${id}" is not granted on this host`, { profileId: id ?? null })
    }
    const profile = this.#profiles.get(id)
    return { ...profile, argv: [...profile.argv], env: { ...profile.env } }
  }

  /** JSON-safe profile listing; env VALUES are never echoed, only their names. */
  listSafe() {
    return [...this.#profiles.values()].map((profile) => ({
      id: profile.id,
      executable: profile.executable,
      argv: [...profile.argv],
      cwd: profile.cwd,
      envKeys: Object.keys(profile.env).sort(),
      timeoutMs: profile.timeoutMs,
      maxOutputBytes: profile.maxOutputBytes,
      pinnedInputs: profile.pinnedInputs.map((input) => ({ path: input.path, sha256: input.sha256 })),
      isolation: isolationOf(profile),
      note: ISOLATION_NOTE
    }))
  }
}

function requireJobs(ctx) {
  const jobs = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') {
    throw jobError('jobs/controller-unavailable', 'ctx.jobs.start is unavailable: this host cannot start an owned background job', {})
  }
  return jobs
}

/**
 * Start one real owned command job from a granted, operator-approved profile.
 * The ledger slot is not the job's concern: this function performs no bridge
 * admission (the caller reserves first).
 *
 * @param {{ctx: object, registry: CommandProfileRegistry, profileId: string, owner: string, label?: string, spawnImpl?: Function}} spec - job request; `owner` is the real sessionId.
 * @returns {{jobId: string, profileId: string, owner: string, label: string, isolation: object, outputLimitBytes: number, timeoutMs: number}} job identity.
 */
export function startCommandJob({ ctx, registry, profileId, owner, label, spawnImpl } = {}) {
  if (!nonBlank(owner)) throw jobError('jobs/invalid-owner', 'a real owning sessionId is required to start a job', {})
  if (registry === undefined || registry === null || typeof registry.resolve !== 'function') {
    throw jobError('jobs/registry-unavailable', 'no operator command-profile registry is configured', {})
  }
  const jobs = requireJobs(ctx)
  const profile = registry.resolve(profileId)
  const spawn = typeof spawnImpl === 'function' ? spawnImpl : nodeSpawn
  const stdout = new ChunkLog(profile.maxOutputBytes)
  const stderr = new ChunkLog(profile.maxOutputBytes)
  let settled = false
  let killed = false
  let exitCode = null
  let exitSignal = null
  let failure = null
  let timeoutTimer = null
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  const finish = (detail) => {
    if (settled) return
    settled = true
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
    const status = killed ? 'killed' : failure !== null ? 'failed' : exitCode === 0 ? 'completed' : 'failed'
    resolveDone({
      status,
      detail:
        detail ??
        (failure !== null ? failure : killed ? 'killed' : exitCode === 0 ? 'exit code: 0' : `exit code: ${exitCode ?? 'unknown'}${exitSignal === null ? '' : ` (${exitSignal})`}`)
    })
  }

  const jobLabel = nonBlank(label) ? label.slice(0, 200) : `${profile.id} (${path.basename(profile.executable)})`
  let jobId
  try {
    jobId = jobs.start({
      kind: COMMAND_JOB_KIND,
      label: jobLabel,
      owner,
      outputLimitBytes: profile.maxOutputBytes,
      output: [
        { channel: 'stdout', read: (from) => stdout.read(from) },
        { channel: 'stderr', read: (from) => stderr.read(from) }
      ],
      run(job) {
        let child
        try {
          child = spawn(profile.executable, [...profile.argv], {
            cwd: profile.cwd,
            env: { ...profile.env },
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          })
        } catch (error) {
          failure = `spawn failed: ${message(error)}`
          finish()
          return { cancel() {}, done }
        }
        if (child === undefined || child === null) {
          failure = 'spawn produced no process handle'
          finish()
          return { cancel() {}, done }
        }
        if (typeof child.stdout?.on === 'function') child.stdout.on('data', (chunk) => stdout.append(String(chunk)))
        if (typeof child.stderr?.on === 'function') child.stderr.on('data', (chunk) => stderr.append(String(chunk)))
        if (typeof child.on === 'function') {
          child.on('error', (error) => {
            failure = `spawn failed: ${message(error)}`
            finish()
          })
          child.on('close', (code, signal) => {
            exitCode = typeof code === 'number' ? code : null
            exitSignal = typeof signal === 'string' ? signal : null
            finish()
          })
        }
        timeoutTimer = setTimeout(() => {
          killed = true
          try {
            if (typeof child.kill === 'function') child.kill()
          } catch {
            // A throwing kill leaves the outcome ambiguous; the job settles as
            // killed only because the deadline fired, and stop proof stays the
            // caller's concern.
          }
          finish(`timeout after ${profile.timeoutMs}ms`)
        }, profile.timeoutMs)
        if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()
        job.updateProgress('running')
        return {
          cancel(reason) {
            killed = true
            try {
              if (typeof child.kill === 'function') child.kill()
            } catch {
              // contained: the registry still settles the record and stop proof
              // is observed by stopCommandJob, never inferred here.
            }
            finish(nonBlank(reason) ? `cancelled: ${reason}` : 'cancelled')
          },
          done
        }
      }
    })
  } catch (error) {
    // A bridge-authored refusal (unknown profile, unavailable controller, …)
    // propagates unchanged. EVERY host error, including one that carries a
    // `jobs/*` code, is wrapped as manager-unavailable: the bridge never claims
    // a job exists when the registry refused to start it.
    if (error !== null && typeof error === 'object' && error.bridgeJobError === true) throw error
    throw jobError('jobs/manager-unavailable', `ctx.jobs refused to start an owned job: ${message(error)}`, {
      hostCode: error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null
    })
  }
  if (!nonBlank(jobId) || typeof jobId !== 'string') {
    throw jobError('jobs/manager-unavailable', 'ctx.jobs.start returned no job id', {})
  }
  return {
    jobId,
    profileId: profile.id,
    owner,
    label: jobLabel,
    isolation: isolationOf(profile),
    outputLimitBytes: profile.maxOutputBytes,
    timeoutMs: profile.timeoutMs
  }
}

/**
 * Stop one owned job with observed stop proof.
 *
 * The owner string is the ONLY caller identity used. An authorization refusal
 * from `ctx.jobs.get` ends the call as `jobs/not-owned`; it is never retried
 * under another identity.
 *
 * @param {{ctx: object, jobId: string, owner: string, reason?: string, timeoutMs?: number, profileId?: string}} spec - stop request.
 * @returns {Promise<{jobId: string, requested: boolean, status: string|null, stopConfirmed: boolean, outcome: string, detail?: object}>} stop verdict.
 */
export async function stopCommandJob({ ctx, jobId, owner, reason = 'cancelled by coordinator', timeoutMs = 5000, profileId } = {}) {
  const jobs = requireJobs(ctx)
  if (!nonBlank(jobId)) throw jobError('jobs/invalid-job', 'jobId must be a nonblank string', {})
  if (!nonBlank(owner)) throw jobError('jobs/invalid-owner', 'a real owning sessionId is required to stop a job', {})
  const bound = Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 5000

  let snapshot
  try {
    snapshot = jobs.get(jobId, owner)
  } catch (error) {
    throw jobError('jobs/not-owned', `job "${jobId}" is not owned by the calling session`, { jobId, cause: message(error) })
  }
  if (!isPlainObject(snapshot)) throw jobError('jobs/not-owned', `job "${jobId}" has no readable snapshot for the calling session`, { jobId })
  const snapshotOwner = typeof snapshot.owner === 'string' ? snapshot.owner : typeof snapshot.ownerSession === 'string' ? snapshot.ownerSession : null
  if (snapshotOwner !== null && snapshotOwner !== owner) {
    throw jobError('jobs/not-owned', `job "${jobId}" is owned by another session`, { jobId })
  }

  let requested = 'already-finished'
  try {
    if (typeof jobs.kill === 'function') requested = jobs.kill(jobId, owner, reason)
  } catch (error) {
    return {
      jobId,
      requested: false,
      status: null,
      stopConfirmed: false,
      outcome: 'unknown',
      detail: { code: 'jobs/kill-failed', message: message(error) }
    }
  }

  let settled = null
  if (typeof jobs.wait === 'function') {
    try {
      settled = await jobs.wait(jobId, bound, owner)
    } catch {
      settled = null
    }
  }
  const terminal = isPlainObject(settled) && ['completed', 'killed', 'failed'].includes(settled.status) ? settled.status : null
  return {
    jobId,
    profileId: nonBlank(profileId) ? profileId : null,
    requested: requested === 'requested',
    status: terminal,
    stopConfirmed: terminal !== null,
    outcome: terminal ?? 'unknown',
    isolation: { process: false, filesystem: false, network: false, note: ISOLATION_NOTE }
  }
}

/**
 * Recovery view for persisted command-job records. The process-local registry
 * proves nothing after a restart, so an unfinished job is reported `unknown`
 * and is never reattached, re-read or replayed.
 * @param {object[]} records - persisted `{jobId, profileId, state?, stopConfirmed?}` records.
 * @returns {object[]} recovery verdicts.
 */
export function recoverCommandJobs(records) {
  const out = []
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record) || !nonBlank(record.jobId)) continue
    if (record.state === 'settled' && record.stopConfirmed === true) continue
    out.push({
      jobId: record.jobId,
      profileId: nonBlank(record.profileId) ? record.profileId : null,
      state: 'unknown',
      stopConfirmed: false,
      recovery: 'unknown',
      reason:
        'the process-local job registry does not prove persistence after a restart, so this job is reported unknown and is never reattached'
    })
  }
  return out
}

/** Truthful capability report for the command-job path. */
export function commandJobsCapability({ ctx, registry, enabled = false, maxJobsPerTask = 2 } = {}) {
  const jobs = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
  const registryReady = registry !== undefined && registry !== null && typeof registry.listSafe === 'function'
  const jobsReady = jobs !== undefined && jobs !== null && typeof jobs.start === 'function'
  const supported = enabled && registryReady && jobsReady
  return {
    supported,
    enabled,
    maxJobsPerTask,
    jobsRegistry: jobsReady,
    profiles: registryReady ? registry.listSafe() : [],
    isolation: { process: false, filesystem: false, network: false },
    enforced: ISOLATION_NOTE,
    refusal: supported
      ? null
      : !enabled
        ? 'host commandJobs.enabled is false'
        : !registryReady
          ? 'no operator command-profile registry is configured'
          : 'ctx.jobs has no start() producer, so no owned job path exists in this host'
  }
}

export default CommandProfileRegistry
