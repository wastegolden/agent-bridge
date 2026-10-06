// src/supervisor.mjs
//
// Controlled supervisor state for the DSH Codex Bridge (contract
// `supervisor-event-wake-v1`).
//
// This module owns three things and nothing else:
//
//  1. `HostReservationLedger` — ONE authoritative admission ledger shared by
//     `BridgeService.drain` and every supervisor/adapter instance that can spawn
//     child sessions. It counts every active ROOT task and every active CHILD,
//     including work whose stop is unconfirmed ("ambiguous") — unknown work keeps
//     its slot until a later, observed stop proof releases it. Admission is
//     synchronous and happens BEFORE any async host call; release requires
//     `stopConfirmed: true` and throws otherwise, so a slot can never be dropped
//     on an unproven stop. At saturation callers refuse or stay queued; no wait
//     path acquires a slot, so a waiting parent cannot deadlock the ledger.
//
//  2. Child-grant attenuation (`childGrantFor`) — a child request is validated
//     against the IMMUTABLE parent grant. Any widening (roots, tools, network,
//     model route, budget, depth, child count, callback target) is REJECTED with
//     `supervisor/grant-widened`; nothing is silently intersected or clamped.
//     Only after that validation does the adapter create a real child session.
//
//  3. `BridgeSupervisor` — the durable child ledger, descendant cancellation
//     with stop proof, recovery that marks unconfirmed child work `unknown`
//     without replay, the trusted callback-target snapshot resolved at
//     submission (never at send time), and the notification sink invoked with
//     persist-before-send, `taskId+attemptId+eventId` dedup, and a fail-closed
//     `unsupported` outcome when no sink is injected.
//
// Nothing here performs a host mutation, spawns a process, or emits a network
// call. The adapter and command-job modules own those seams.

import path from 'node:path'
import { createHash } from 'node:crypto'
import { SUPERVISOR_PROJECT_TOOLS } from './long-task.mjs'

const MAX_LEDGER_LIMIT = 1024
const SHARED_LEDGERS = new Map()
const CASE_INSENSITIVE_PATHS = process.platform === 'win32'
/**
 * The wire vocabulary the shared callback sink accepts. `blocked` is deliberately
 * absent: the distinction between `blocked` and `needs-input` is carried by the
 * durable `replyKind`, never by a new wire kind the outbox cannot accept.
 */
const REPLY_SUMMARY_PREFIX = Object.freeze({ 'needs-input': '[needs-input]', blocked: '[blocked]' })
/** Upper bound for a generated event identity, comfortably inside the outbox's 128-char fence. */
const MAX_EVENT_ID_CHARS = 128
/**
 * Raw worker reply limit (unchanged contract) and the integrated WIRE summary bound.
 * The raw summary is validated BEFORE the controller prefix is added, and the prefixed
 * summary is then checked against the wire bound: an over-long reply is refused, never
 * silently truncated. The longest prefix (`[needs-input] `) is 14 characters.
 */
const MAX_RAW_REPLY_CHARS = 8000
const MAX_WIRE_REPLY_CHARS = 8192
const TERMINAL_CHILD_STATES = new Set(['completed', 'failed', 'cancelled'])
const LIVE_CHILD_STATES = new Set(['reserved', 'starting', 'running', 'cancelling'])
const NOTIFICATION_KINDS = new Set(['completed', 'failed', 'cancelled', 'needs-input'])
const REPLY_KINDS = new Set(['needs-input', 'blocked'])
const BUDGET_KEYS = ['timeoutMs', 'maxToolCalls', 'maxOutputChars']
const REQUEST_KEYS = new Set([
  'childKey',
  'objective',
  'label',
  'acceptance',
  'tools',
  'readRoots',
  'writeRoots',
  'allowNetwork',
  'model',
  'budgets',
  'maxChildren'
])

/**
 * Tools a child session may never receive, whatever the parent grant says.
 * Native delegation and shell are unbounded for a bounded task; the bridge's own
 * child/job/reply tools are parent-only (depth 1, roots reply, jobs are
 * profile-granted); `run_code` re-exposes every visible tool; the remaining
 * names are the adapter's recorded unbounded-capability set.
 */
const CHILD_FORBIDDEN_TOOLS = new Set([
  'bash',
  'pwsh',
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'send_message',
  'interrupt_agent',
  'list_subagent_models',
  'list_agents',
  'ralph',
  'workflow',
  'run_code',
  'skill',
  'job_list',
  'create_goal',
  'update_goal',
  'dsh_child_spawn',
  'dsh_child_wait',
  'dsh_child_result',
  'dsh_child_cancel',
  'dsh_child_list',
  'dsh_job_start',
  'dsh_bridge_reply',
  // Supervisor-only long-task tools: a child or worker session must never manage a
  // project plan, and a nested plan would be a privilege escalation.
  ...SUPERVISOR_PROJECT_TOOLS
])

/** Domain failure with a stable `.code`. */
export function supervisorError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = safe(details)
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

/** JSON-safe detached snapshot (same rules as the adapter's boundary). */
function safe(value, seen = new Set(), depth = 0) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined
  if (depth > 12) return '[depth-limit]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = []
      for (const item of value) {
        const detached = safe(item, seen, depth + 1)
        out.push(detached === undefined ? null : detached)
      }
      return out
    }
    const out = {}
    for (const key of Object.keys(value)) {
      const detached = safe(value[key], seen, depth + 1)
      if (detached !== undefined) out[key] = detached
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/**
 * Deterministic, Windows-safe event identity for the callback outbox.
 *
 * The outbox dedups `eventId` GLOBALLY, so an id derived from only the logical
 * kind (`settled:completed`, `reply:<replyId>`) collides across tasks and
 * attempts. The id is the SHA-256 of the full immutable identity tuple
 * `[taskId, attemptId, logicalId]`, which replays identically for the same tuple
 * and cannot collide for a different task, attempt or logical id. The result is
 * lowercase hex (no path separators, no reserved characters) and well inside the
 * 128-character fence.
 *
 * @param {{taskId: string, attemptId: string, logicalId: string, prefix?: string}} tuple - immutable identity.
 * @returns {string} deterministic event id.
 */
export function callbackEventId({ taskId, attemptId, logicalId, prefix } = {}) {
  if (!nonBlank(taskId) || !nonBlank(attemptId) || !nonBlank(logicalId)) {
    throw supervisorError('supervisor/invalid-notification', 'an event identity requires a nonblank taskId, attemptId and logical id', {})
  }
  const digest = createHash('sha256').update(JSON.stringify([taskId.trim(), attemptId.trim(), logicalId.trim()])).digest('hex')
  const head = nonBlank(prefix) ? `${prefix.trim().replace(/[^A-Za-z0-9._-]/g, '-')}-` : ''
  const id = `${head}${digest}`
  if (id.length > MAX_EVENT_ID_CHARS) {
    throw supervisorError('supervisor/invalid-notification', `generated event id exceeds ${MAX_EVENT_ID_CHARS} characters`, {})
  }
  return id
}

/**
 * Interpret one sink acknowledgement. An ENQUEUE acknowledgement means the event
 * was accepted (queued), not that it reached the recipient. Only an explicit
 * positive DELIVERY acknowledgement is `delivered`; malformed or absent
 * acknowledgements stay `unknown` so nothing is claimed and nothing is replayed.
 *
 * @param {unknown} ack - value returned by the injected sink.
 * @returns {{delivered: boolean, outcome: 'delivered'|'queued'|'unknown', ack: object}} verdict.
 */
function interpretSinkAck(ack) {
  if (ack === null || ack === undefined) return { delivered: false, outcome: 'unknown', ack: { shape: ack === null ? 'null' : 'undefined' } }
  if (typeof ack === 'boolean') {
    return ack === true ? { delivered: false, outcome: 'queued', ack: { shape: 'boolean', queued: true } } : { delivered: false, outcome: 'unknown', ack: { shape: 'boolean', queued: false } }
  }
  if (typeof ack === 'string') {
    const normalized = ack.trim().toLowerCase()
    if (normalized === 'delivered' || normalized === 'sent') return { delivered: true, outcome: 'delivered', ack: { shape: 'string', value: normalized } }
    if (normalized === 'queued' || normalized === 'accepted' || normalized === 'pending') {
      return { delivered: false, outcome: 'queued', ack: { shape: 'string', value: normalized } }
    }
    return { delivered: false, outcome: 'unknown', ack: { shape: 'string', value: normalized.slice(0, 64) } }
  }
  if (!isPlainObject(ack)) return { delivered: false, outcome: 'unknown', ack: { shape: typeof ack } }
  const detail = { shape: 'object' }
  // An explicit refusal is preserved verbatim, never softened into a delivery.
  if (ack.ok === false || isPlainObject(ack.error)) {
    return { delivered: false, outcome: 'refused', ack: safe({ ...ack, ...(isPlainObject(ack.error) ? { error: ack.error } : {}) }) }
  }
  const state = isPlainObject(ack.event) && typeof ack.event.state === 'string' ? ack.event.state.toLowerCase() : null
  if (state !== null) detail.eventState = state
  if (ack.delivered === true || ack.sent === true || ack.acked === true || state === 'delivered' || state === 'sent' || state === 'acked') {
    return { delivered: true, outcome: 'delivered', ack: detail }
  }
  if (ack.queued === true || ack.accepted === true || ack.ok === true || state === 'pending' || state === 'queued' || state === 'accepted') {
    return { delivered: false, outcome: 'queued', ack: detail }
  }
  return { delivered: false, outcome: 'unknown', ack: detail }
}

/**
 * Bounded, prefixed notification summary. The `[blocked]` / `[needs-input]`
 * distinction is generated by the controller and survives into the recipient's
 * text without adding a wire kind the shared sink cannot accept.
 */
function prefixedSummary(replyKind, summary) {
  const prefix = REPLY_SUMMARY_PREFIX[replyKind] ?? ''
  return `${prefix} ${summary}`.trim()
}

/** Run `fn`, swallowing any failure (state must never be broken by bookkeeping). */
function contained(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback === undefined ? undefined : fallback()
  }
}

/** Detach a sink acknowledgement for reporting; never throws on hostile shapes. */
function jsonAck(ack) {
  return contained(() => safe(ack), () => ({ shape: 'unreportable' }))
}

/** Whether `target` is `root` or nested inside it (case-folded on win32). */
export function pathInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const rel = path.relative(root, target)
  if (rel === '') return true
  const inside = rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  if (inside) return true
  if (!CASE_INSENSITIVE_PATHS) return false
  const lower = path.relative(root.toLowerCase(), target.toLowerCase())
  return lower === '' || (lower !== '..' && !lower.startsWith(`..${path.sep}`) && !path.isAbsolute(lower))
}

function insideAny(roots, target) {
  for (const root of roots) if (pathInside(root, target)) return true
  return false
}

/**
 * The one authoritative admission ledger. Instances are shared by ledger id so
 * two supervisors for the same bridge owner cannot each hold their own budget.
 */
export class HostReservationLedger {
  #limit
  #entries = new Map()
  #sequence = 0

  /**
   * @param {{limit: number, id?: string}} options - positive integer admission limit.
   */
  constructor({ limit, id } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw supervisorError('supervisor/invalid-ledger', `ledger limit must be an integer 1..${MAX_LEDGER_LIMIT}`, { limit })
    }
    this.id = nonBlank(id) ? id.trim() : null
    this.#limit = limit
  }

  /** Configured admission limit (never changed by a second declaration). */
  get limit() {
    return this.#limit
  }

  /** Number of held reservations. */
  get size() {
    return this.#entries.size
  }

  has(key) {
    return this.#entries.has(key)
  }

  get(key) {
    const entry = this.#entries.get(key)
    return entry === undefined ? undefined : { ...entry }
  }

  /**
   * Reserve one slot SYNCHRONOUSLY. Idempotent by key: re-reserving an existing
   * key returns the same reservation (`reused: true`) without consuming a second
   * slot. At the limit it returns `{ok:false, reason:'saturated'}` and registers
   * nothing.
   * @param {{key: string, kind?: 'root'|'child', taskId?: string, attemptId?: string, childId?: string, label?: string}} spec - reservation identity.
   * @returns {{ok: boolean, reused?: boolean, reservation?: object, counts: object, reason?: string, limit?: number}} admission verdict.
   */
  reserve({ key, kind, taskId, attemptId, childId, label } = {}) {
    if (!nonBlank(key)) throw supervisorError('supervisor/invalid-reservation', 'reservation key must be a nonblank string', {})
    const existing = this.#entries.get(key)
    if (existing !== undefined) return { ok: true, reused: true, reservation: { ...existing }, counts: this.counts() }
    if (this.#entries.size >= this.#limit) return { ok: false, reason: 'saturated', counts: this.counts(), limit: this.#limit }
    this.#sequence += 1
    const reservation = {
      key,
      kind: kind === 'child' ? 'child' : 'root',
      taskId: nonBlank(taskId) ? taskId : null,
      attemptId: nonBlank(attemptId) ? attemptId : null,
      childId: nonBlank(childId) ? childId : null,
      label: nonBlank(label) ? label : null,
      ambiguous: false,
      ambiguousReason: null,
      seq: this.#sequence,
      reservedAt: Date.now()
    }
    this.#entries.set(key, reservation)
    return { ok: true, reused: false, reservation: { ...reservation }, counts: this.counts() }
  }

  /**
   * Adopt work that ALREADY EXISTS into the ledger (recovery only). It never
   * admits new work and may exceed the limit: unknown/unconfirmed work must stay
   * counted even when the ledger is saturated, and `counts().free` clamps at 0.
   */
  adopt({ key, kind, taskId, attemptId, childId, label, reason } = {}) {
    if (!nonBlank(key)) throw supervisorError('supervisor/invalid-reservation', 'adoption key must be a nonblank string', {})
    const existing = this.#entries.get(key)
    if (existing !== undefined) {
      existing.ambiguous = true
      if (nonBlank(reason)) existing.ambiguousReason = reason
      return { ...existing }
    }
    this.#sequence += 1
    const entry = {
      key,
      kind: kind === 'child' ? 'child' : 'root',
      taskId: nonBlank(taskId) ? taskId : null,
      attemptId: nonBlank(attemptId) ? attemptId : null,
      childId: nonBlank(childId) ? childId : null,
      label: nonBlank(label) ? label : null,
      ambiguous: true,
      ambiguousReason: nonBlank(reason) ? reason : null,
      recovered: true,
      seq: this.#sequence,
      reservedAt: Date.now()
    }
    this.#entries.set(key, entry)
    return { ...entry }
  }

  /**
   * Mark a held reservation ambiguous (unknown/unconfirmed work). The slot stays
   * held and counted; only an observed stop proof may release it.
   */
  markUnknown(key, reason) {
    const entry = this.#entries.get(key)
    if (entry === undefined) return false
    entry.ambiguous = true
    entry.ambiguousReason = nonBlank(reason) ? reason : null
    return true
  }

  /**
   * Release one reservation. Refuses without `stopConfirmed: true`: an
   * unconfirmed stop keeps its slot so capacity is never fabricated.
   */
  release(key, { stopConfirmed, reason } = {}) {
    if (stopConfirmed !== true) {
      throw supervisorError('supervisor/no-stop-proof', `reservation "${key}" cannot be released without confirmed stop`, {
        key,
        reason: nonBlank(reason) ? reason : null
      })
    }
    return this.#entries.delete(key)
  }

  /** Root/child/unknown tallies. */
  counts() {
    let roots = 0
    let children = 0
    let unknown = 0
    for (const entry of this.#entries.values()) {
      if (entry.kind === 'child') children += 1
      else roots += 1
      if (entry.ambiguous) unknown += 1
    }
    return { used: this.#entries.size, free: Math.max(0, this.#limit - this.#entries.size), limit: this.#limit, roots, children, unknown }
  }

  /** JSON-safe snapshot for capability reports. */
  snapshot() {
    return safe({ id: this.id, limit: this.#limit, ...this.counts(), reservations: [...this.#entries.values()] })
  }
}

/**
 * Get or create the process-shared ledger for one id. The first declaration's
 * limit is authoritative. A later declaration of a DIFFERENT limit on the same
 * id is a configuration conflict (`supervisor/ledger-limit-conflict`), never a
 * silent first-limit-wins: two mounts disagreeing about capacity is a real
 * misconfiguration and must be reported, not absorbed.
 * @param {string} id - bridge owner id (all compositions of one owner share it).
 * @param {{limit: number}} options - admission limit, required on first call.
 * @returns {HostReservationLedger} the shared ledger.
 */
export function sharedLedger(id, { limit } = {}) {
  const key = nonBlank(id) ? id.trim() : 'default'
  const existing = SHARED_LEDGERS.get(key)
  if (existing !== undefined) {
    if (Number.isInteger(limit) && limit !== existing.limit) {
      throw supervisorError(
        'supervisor/ledger-limit-conflict',
        `shared ledger "${key}" was already declared with limit ${existing.limit}; a second declaration of limit ${limit} is a configuration conflict, not a resize`,
        { ledgerId: key, declaredLimit: existing.limit, requestedLimit: limit, declaredLimits: [...(existing.declaredLimits ?? [existing.limit]), limit] }
      )
    }
    return existing
  }
  const ledger = new HostReservationLedger({ limit, id: key })
  ledger.declaredLimits = [limit]
  SHARED_LEDGERS.set(key, ledger)
  return ledger
}

/** Test/teardown helper: forget one shared ledger id (never releases slots of a live ledger). */
export function forgetSharedLedger(id) {
  return SHARED_LEDGERS.delete(nonBlank(id) ? id.trim() : 'default')
}

function resolveRoot(field, raw, host) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw supervisorError('supervisor/invalid-request', `${field} entries must be nonblank strings`, { field })
  }
  if (typeof host.canonicalize === 'function') {
    const verdict = host.canonicalize(raw)
    if (verdict === undefined || verdict === null || verdict.ok === false) {
      throw supervisorError('supervisor/invalid-root', `${field} entry "${raw}" cannot be canonicalized`, { field, root: raw })
    }
    return typeof verdict === 'string' ? verdict : verdict.path
  }
  if (!path.isAbsolute(raw)) throw supervisorError('supervisor/invalid-root', `${field} entry "${raw}" must be absolute`, { field, root: raw })
  return path.resolve(raw)
}

function attenuateRoots(field, requested, parentRoots, host) {
  const parent = Array.isArray(parentRoots) ? parentRoots : []
  if (requested === undefined) return [...parent]
  if (!Array.isArray(requested)) {
    throw supervisorError('supervisor/invalid-request', `${field} must be an array of absolute paths`, { field })
  }
  const out = []
  for (const raw of requested) {
    const canonical = resolveRoot(field, raw, host)
    if (!insideAny(parent, canonical)) {
      throw supervisorError('supervisor/grant-widened', `child requested ${field} entry "${raw}" outside the immutable parent grant`, {
        field,
        root: canonical
      })
    }
    out.push(canonical)
  }
  return out
}

function sameRoute(candidate, parent) {
  if (!isPlainObject(candidate) || !isPlainObject(parent)) return false
  return (
    candidate.provider === parent.provider &&
    candidate.model === parent.model &&
    (candidate.reasoningEffort ?? null) === (parent.reasoningEffort ?? null)
  )
}

function attenuateBudgets(requested, parentBudgets) {
  const parent = isPlainObject(parentBudgets) ? parentBudgets : {}
  const out = {}
  for (const key of BUDGET_KEYS) if (Number.isInteger(parent[key]) && parent[key] > 0) out[key] = parent[key]
  if (requested === undefined) return out
  if (!isPlainObject(requested)) throw supervisorError('supervisor/invalid-request', 'budgets must be a plain object', { field: 'budgets' })
  for (const key of Object.keys(requested)) {
    if (!BUDGET_KEYS.includes(key)) {
      throw supervisorError('supervisor/grant-widened', `child budget field "${key}" is not permitted`, { field: `budgets.${key}` })
    }
    const value = requested[key]
    if (!Number.isInteger(value) || value < 1) {
      throw supervisorError('supervisor/invalid-request', `budgets.${key} must be a positive integer`, { field: `budgets.${key}` })
    }
    const cap = parent[key]
    if (Number.isInteger(cap) && value > cap) {
      throw supervisorError('supervisor/grant-widened', `child budget ${key}=${value} exceeds the parent grant ${cap}`, {
        field: `budgets.${key}`,
        requested: value,
        granted: cap
      })
    }
    out[key] = value
  }
  return out
}

/**
 * Validate one child request against the immutable parent grant and return the
 * ATTENUATED child grant. Any widening throws `supervisor/grant-widened`; a
 * forbidden tool or an impossible depth throws its own typed code. Nothing is
 * clamped: an invalid request never produces a child.
 *
 * @param {object} parentGrant - canonical parent grant (`readRoots`, `writeRoots`, `allowNetwork`, `allowedTools`, `model`, `budgets`, `maxChildren`, `depth`, `callbackTargetId`).
 * @param {object} request - model-supplied child request (untrusted shape).
 * @param {{maxDepth?: number, maxChildrenPerTask?: number, canonicalize?: Function}} [host] - host child policy.
 * @returns {object} attenuated child grant.
 */
export function childGrantFor(parentGrant, request, host = {}) {
  if (!isPlainObject(parentGrant)) throw supervisorError('supervisor/invalid-grant', 'parent grant must be a plain object', {})
  if (!isPlainObject(request)) throw supervisorError('supervisor/invalid-request', 'child request must be a plain object', {})
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) {
      throw supervisorError('supervisor/grant-widened', `child request field "${key}" is not permitted: children cannot set it`, { field: key })
    }
  }

  const maxDepth = Number.isInteger(host.maxDepth) ? host.maxDepth : 1
  const parentDepth = Number.isInteger(parentGrant.depth) ? parentGrant.depth : 0
  const depth = parentDepth + 1
  if (depth > maxDepth) {
    throw supervisorError('supervisor/depth-exceeded', `child depth ${depth} exceeds the approved maximum ${maxDepth}`, { depth, maxDepth })
  }

  if (!nonBlank(request.childKey) || request.childKey.trim().length > 200) {
    throw supervisorError('supervisor/invalid-request', 'childKey must be a nonblank string of at most 200 characters', { field: 'childKey' })
  }
  const childKey = request.childKey.trim()
  if (!nonBlank(request.objective) || request.objective.length > 20000) {
    throw supervisorError('supervisor/invalid-request', 'objective must be a nonblank string of at most 20000 characters', { field: 'objective' })
  }
  const objective = request.objective
  let label = objective.slice(0, 120)
  if (request.label !== undefined) {
    if (!nonBlank(request.label) || request.label.length > 200) {
      throw supervisorError('supervisor/invalid-request', 'label must be a nonblank string of at most 200 characters', { field: 'label' })
    }
    label = request.label
  }
  let acceptance = ['Complete the bounded child objective and report evidence and explicit unknowns.']
  if (request.acceptance !== undefined) {
    if (!Array.isArray(request.acceptance) || request.acceptance.length === 0 || request.acceptance.length > 32) {
      throw supervisorError('supervisor/invalid-request', 'acceptance must be a nonempty array of at most 32 nonblank strings', { field: 'acceptance' })
    }
    for (const item of request.acceptance) {
      if (!nonBlank(item)) throw supervisorError('supervisor/invalid-request', 'acceptance entries must be nonblank strings', { field: 'acceptance' })
    }
    acceptance = [...request.acceptance]
  }

  const parentTools = new Set(Array.isArray(parentGrant.allowedTools) ? parentGrant.allowedTools : [])
  let tools
  if (request.tools === undefined) {
    tools = [...parentTools]
  } else {
    if (!Array.isArray(request.tools)) {
      throw supervisorError('supervisor/invalid-request', 'tools must be an array of tool names', { field: 'tools' })
    }
    for (const name of request.tools) {
      if (!nonBlank(name)) throw supervisorError('supervisor/invalid-request', 'tools entries must be nonblank strings', { field: 'tools' })
      if (!parentTools.has(name)) {
        throw supervisorError('supervisor/grant-widened', `child requested tool "${name}" outside the immutable parent grant`, { field: 'tools', tool: name })
      }
      if (CHILD_FORBIDDEN_TOOLS.has(name)) {
        throw supervisorError('supervisor/grant-widened', `child requested tool "${name}", which is never available to a child session`, { field: 'tools', tool: name })
      }
    }
    tools = [...new Set(request.tools)]
  }

  const readRoots = attenuateRoots('readRoots', request.readRoots, parentGrant.readRoots, host)
  const writeRoots = attenuateRoots('writeRoots', request.writeRoots, parentGrant.writeRoots, host)

  let allowNetwork = parentGrant.allowNetwork === true
  if (request.allowNetwork !== undefined) {
    if (typeof request.allowNetwork !== 'boolean') {
      throw supervisorError('supervisor/invalid-request', 'allowNetwork must be a boolean', { field: 'allowNetwork' })
    }
    if (request.allowNetwork === true && parentGrant.allowNetwork !== true) {
      throw supervisorError('supervisor/grant-widened', 'child requested network access that the parent grant does not hold', { field: 'allowNetwork' })
    }
    if (request.allowNetwork === false) allowNetwork = false
  }

  let model = isPlainObject(parentGrant.model) ? { ...parentGrant.model } : null
  if (request.model !== undefined) {
    if (!sameRoute(request.model, parentGrant.model)) {
      throw supervisorError('supervisor/grant-widened', 'child requested a model route different from the immutable parent grant', { field: 'model' })
    }
    model = { ...parentGrant.model }
  }

  const budgets = attenuateBudgets(request.budgets, parentGrant.budgets)

  const hostChildrenCap = Number.isInteger(host.maxChildrenPerTask) ? host.maxChildrenPerTask : 1
  const grantChildrenCap = Number.isInteger(parentGrant.maxChildren) ? parentGrant.maxChildren : hostChildrenCap
  let maxChildren = Math.min(hostChildrenCap, grantChildrenCap)
  if (request.maxChildren !== undefined) {
    if (!Number.isInteger(request.maxChildren) || request.maxChildren < 1) {
      throw supervisorError('supervisor/invalid-request', 'maxChildren must be a positive integer', { field: 'maxChildren' })
    }
    if (request.maxChildren > maxChildren) {
      throw supervisorError('supervisor/grant-widened', `child requested maxChildren=${request.maxChildren} above the grant ${maxChildren}`, {
        field: 'maxChildren',
        granted: maxChildren
      })
    }
    maxChildren = request.maxChildren
  }

  return {
    childKey,
    objective,
    label,
    acceptance,
    tools,
    readRoots,
    writeRoots,
    allowNetwork,
    model,
    budgets,
    maxChildren,
    depth,
    callbackTargetId: nonBlank(parentGrant.callbackTargetId) ? parentGrant.callbackTargetId : null
  }
}

function normalizeConfig(config = {}) {
  const childSessions = isPlainObject(config.childSessions) ? config.childSessions : {}
  const maxDepth = childSessions.maxDepth === undefined ? 1 : childSessions.maxDepth
  if (maxDepth !== 1) {
    throw supervisorError('supervisor/invalid-config', 'child depth is restricted to 1 for soundness; maxDepth must be 1', { maxDepth })
  }
  return {
    childSessions: {
      enabled: childSessions.enabled === true,
      maxDepth: 1,
      maxChildrenPerTask: Number.isInteger(childSessions.maxChildrenPerTask) && childSessions.maxChildrenPerTask > 0
        ? childSessions.maxChildrenPerTask
        : 1,
      waitTimeoutMs: Number.isInteger(childSessions.waitTimeoutMs) && childSessions.waitTimeoutMs > 0 ? childSessions.waitTimeoutMs : 30000,
      maxWaitTimeoutMs:
        Number.isInteger(childSessions.maxWaitTimeoutMs) && childSessions.maxWaitTimeoutMs > 0 ? childSessions.maxWaitTimeoutMs : 60000
    },
    commandJobs: {
      enabled: isPlainObject(config.commandJobs) ? config.commandJobs.enabled === true : config.commandJobs === true,
      maxJobsPerTask:
        isPlainObject(config.commandJobs) && Number.isInteger(config.commandJobs.maxJobsPerTask) && config.commandJobs.maxJobsPerTask > 0
          ? config.commandJobs.maxJobsPerTask
          : 2,
      profiles: isPlainObject(config.commandJobs) && config.commandJobs.profiles !== undefined ? config.commandJobs.profiles : null
    },
    rootCallbackGrants: isPlainObject(config.rootCallbackGrants) ? config.rootCallbackGrants : {},
    notificationSink: typeof config.notificationSink === 'function' ? config.notificationSink : undefined
  }
}

/**
 * Supervisor state for one bridge owner. Pure bookkeeping plus the injected
 * optional notification sink; it never touches a host service.
 */
export class BridgeSupervisor {
  #children = new Map()
  #childKeys = new Map()
  #sent = new Set()
  /** Trusted-controller producer status attached at mount time (capability metadata only). */
  #notificationStatus = null

  /**
   * @param {{ledger: HostReservationLedger, ownerId?: string, persist?: {event?: Function, update?: Function}, config?: object}} options - ledger, owner, optional store bridge, host policy.
   */
  constructor({ ledger, ownerId, persist, config } = {}) {
    if (!(ledger instanceof HostReservationLedger)) {
      throw supervisorError('supervisor/invalid-ledger', 'BridgeSupervisor requires a HostReservationLedger instance', {})
    }
    this.ledger = ledger
    this.ownerId = nonBlank(ownerId) ? ownerId : null
    this.persist = {
      event: persist !== undefined && typeof persist.event === 'function' ? persist.event : undefined,
      update: persist !== undefined && typeof persist.update === 'function' ? persist.update : undefined
    }
    this.config = normalizeConfig(config)
  }

  /** Whether child sessions can be offered and with which lineage guarantee. */
  childSessionsStatus() {
    const base = {
      enabled: this.config.childSessions.enabled,
      maxDepth: 1,
      maxChildrenPerTask: this.config.childSessions.maxChildrenPerTask,
      tools: ['dsh_child_spawn', 'dsh_child_wait', 'dsh_child_result', 'dsh_child_cancel', 'dsh_child_list']
    }
    if (!this.config.childSessions.enabled) {
      return { ...base, supported: false, lineage: null, reason: 'host childSessions.enabled is false' }
    }
    return { ...base, supported: true, lineage: this.lineageMode ?? null, reason: null }
  }

  /** Whether profile-granted command jobs are offered. */
  commandJobsStatus() {
    const profiles = this.config.commandJobs.profiles
    const supported = this.config.commandJobs.enabled && profiles !== null && typeof profiles.listSafe === 'function'
    return {
      supported,
      enabled: this.config.commandJobs.enabled,
      maxJobsPerTask: this.config.commandJobs.maxJobsPerTask,
      profiles: supported ? profiles.listSafe() : [],
      isolation: { process: false, filesystem: false, network: false },
      enforced:
        'exact operator executable/argv/cwd/env profile executed with shell:false; an approved profile allowlist is NOT an OS sandbox and no process, filesystem or network isolation is claimed',
      reason: supported ? null : this.config.commandJobs.enabled ? 'no operator command-profile registry is configured' : 'host commandJobs.enabled is false'
    }
  }

  /** Whether a notification sink is injected. */
  notificationsStatus() {
    const sink = this.config.notificationSink
    const base = {
      supported: typeof sink === 'function',
      // A configured producer proves a producer, never a live destination. When the
      // host mount supplies the integrated producer status it is reported verbatim;
      // otherwise availability stays explicitly unverified instead of `false`.
      liveTransport: 'unknown',
      runnerAvailable: 'unknown',
      liveAck: 'unknown',
      reason: typeof sink === 'function' ? null : 'no notification sink is injected; callback wake is unsupported'
    }
    if (this.#notificationStatus === null) return base
    return { ...base, ...this.#notificationStatus }
  }

  /**
   * Attach the trusted-controller producer status computed at mount time (for example
   * by the integrated `eventWake` outbox router). It is capability metadata only: it
   * cannot widen the sink, the grants or any task grant.
   */
  setNotificationStatus(status) {
    this.#notificationStatus = isPlainObject(status) ? safe(status) : null
    return this.notificationsStatus()
  }

  /**
   * Resolve a trusted callback grant snapshot at SUBMISSION time. The snapshot
   * is persisted on the task; send paths use the persisted snapshot and never
   * re-resolve the grant, so a later config change cannot retarget an existing
   * task.
   * @param {{grantId: string, taskKey?: string}} request - grant id and optional designated-root key.
   * @returns {{grantId: string, targetId: string, boundAt: number}} snapshot.
   */
  callbackSnapshot({ grantId, taskKey } = {}) {
    if (!nonBlank(grantId)) throw supervisorError('supervisor/callback-ungranted', 'a nonblank callback grant id is required', {})
    const grants = this.config.rootCallbackGrants
    const grant = Object.hasOwn(grants, grantId) ? grants[grantId] : undefined
    if (!isPlainObject(grant) || !nonBlank(grant.targetId)) {
      throw supervisorError('supervisor/callback-ungranted', `root callback grant "${grantId}" is not configured on this host`, { grantId })
    }
    if (Array.isArray(grant.taskKeys) && grant.taskKeys.length > 0) {
      const requestedKey = nonBlank(taskKey) ? taskKey : null
      if (requestedKey === null || !grant.taskKeys.includes(requestedKey)) {
        throw supervisorError('supervisor/callback-ungranted', `root callback grant "${grantId}" is not designated for this task`, { grantId })
      }
    }
    return { grantId, targetId: grant.targetId, boundAt: Date.now() }
  }

  /**
   * Persist-before-send notification. The event identity is recorded before the
   * sink is invoked; the dedup key `taskId:attemptId:eventId` is marked before
   * the send so an ambiguous outcome is never blindly replayed.
   *
   * The sink's acknowledgement is INTERPRETED, never assumed: an enqueue
   * acknowledgement (`{ok:true,event:{state:'pending'}}`) means the event is
   * queued/accepted, NOT delivered to the recipient. Only an explicit positive
   * delivery acknowledgement sets `delivered:true`; a malformed or absent
   * acknowledgement stays `unknown`, and an explicit refusal is preserved.
   *
   * @param {{taskId: string, attemptId: string, eventId: string, targetId: string, kind: string, summary: string, resultIds?: string[], replyKind?: string}} event - complete event.
   * @returns {Promise<{delivered: boolean, outcome: string, delivery: string, eventId: string, dedupKey?: string, detail?: object, replyKind?: string}>} delivery verdict.
   */
  async emitNotification(event = {}) {
    const taskId = nonBlank(event.taskId) ? event.taskId : null
    const attemptId = nonBlank(event.attemptId) ? event.attemptId : null
    const eventId = nonBlank(event.eventId) ? event.eventId : null
    const targetId = nonBlank(event.targetId) ? event.targetId : null
    const kind = NOTIFICATION_KINDS.has(event.kind) ? event.kind : null
    const summary = typeof event.summary === 'string' ? event.summary : null
    const replyKind = REPLY_KINDS.has(event.replyKind) ? event.replyKind : null
    if (taskId === null || attemptId === null || eventId === null || targetId === null || kind === null || summary === null) {
      throw supervisorError('supervisor/invalid-notification', 'a notification requires taskId, attemptId, eventId, targetId, a known kind and a string summary', {})
    }
    const dedupKey = `${taskId}:${attemptId}:${eventId}`
    if (this.#sent.has(dedupKey)) return { delivered: false, outcome: 'duplicate', delivery: 'not-attempted', eventId, dedupKey }

    const stored = {
      eventId,
      taskId,
      attemptId,
      targetId,
      kind,
      summary,
      ...(replyKind === null ? {} : { replyKind }),
      ...(Array.isArray(event.resultIds) ? { resultIds: event.resultIds.map((id) => String(id)) } : {})
    }
    // The shared SINK contract is unchanged: exactly the documented wire fields
    // (taskId, attemptId, eventId, targetId, kind, summary, resultIds). The
    // `blocked`/`needs-input` distinction is carried by the DURABLE record above
    // and by the controller-generated summary prefix, never by an extra field the
    // parallel callback module might reject.
    const wire = {
      eventId,
      taskId,
      attemptId,
      targetId,
      kind,
      summary,
      ...(Array.isArray(stored.resultIds) ? { resultIds: stored.resultIds } : {})
    }
    // The identity is persisted BEFORE the sink is invoked; an ambiguous send is
    // therefore never replayed even if the process dies mid-send.
    const persistEvent = (payload) => {
      if (this.persist.event === undefined) return null
      return this.persist.event(taskId, { type: 'task/notification', ...payload })
    }

    let persisted = null
    try {
      persisted = persistEvent(stored)
    } catch (error) {
      return {
        delivered: false,
        outcome: 'unknown',
        delivery: 'not-attempted',
        eventId,
        dedupKey,
        ...(replyKind === null ? {} : { replyKind }),
        detail: { code: 'supervisor/persist-failed', message: String((error && error.message) || error) }
      }
    }
    this.#sent.add(dedupKey)
    const sink = this.config.notificationSink
    if (typeof sink !== 'function') {
      return { delivered: false, outcome: 'unsupported', delivery: 'not-attempted', eventId, dedupKey, persistedSeq: persisted?.seq ?? null, ...(replyKind === null ? {} : { replyKind }) }
    }
    let ack
    try {
      ack = sink({ ...wire })
      if (ack !== undefined && ack !== null && typeof ack.then === 'function') ack = await ack
    } catch (error) {
      // Ambiguous: the sink may or may not have accepted the event. The dedup key
      // stays marked, so this is never blindly replayed.
      return {
        delivered: false,
        outcome: 'unknown',
        delivery: 'unknown',
        eventId,
        dedupKey,
        persistedSeq: persisted?.seq ?? null,
        ...(replyKind === null ? {} : { replyKind }),
        detail: { code: 'supervisor/sink-failed', message: String((error && error.message) || error) }
      }
    }
    const verdict = interpretSinkAck(ack)
    // The interpreted acknowledgement is durable too: a restart can tell a queued
    // event from a delivered one without re-sending anything.
    contained(() => persistEvent({ ...stored, deliveryOutcome: verdict.outcome, delivery: verdict.delivered ? 'delivered' : verdict.outcome }))
    return {
      delivered: verdict.delivered,
      outcome: verdict.outcome,
      delivery: verdict.delivered ? 'delivered' : verdict.outcome,
      eventId,
      dedupKey,
      persistedSeq: persisted?.seq ?? null,
      ack: jsonAck(verdict.ack),
      ...(replyKind === null ? {} : { replyKind })
    }
  }

  /** Adopt a persisted notification event into the dedup set (recovery). */
  adoptPersistedEvent(taskId, event) {
    if (!isPlainObject(event) || event.type !== 'task/notification') return false
    if (!nonBlank(taskId) || !nonBlank(event.eventId) || !nonBlank(event.attemptId)) return false
    this.#sent.add(`${taskId}:${event.attemptId}:${event.eventId}`)
    return true
  }

  /**
   * Emit one settlement event for a terminal, stopped task whose callback grant
   * is bound. Refuses while any child is still live or the stop is unconfirmed:
   * completion requires an actually settled task.
   * @param {{task: object, status: string, summary: string, resultIds?: string[]}} spec - settlement facts.
   * @returns {Promise<object>} delivery verdict.
   */
  async notifySettlement({ task, status, summary, resultIds } = {}) {
    if (!isPlainObject(task)) throw supervisorError('supervisor/invalid-notification', 'settlement requires the owned task record', {})
    const binding = isPlainObject(task.callbackBinding) ? task.callbackBinding : null
    if (binding === null || !nonBlank(binding.targetId)) {
      return { delivered: false, outcome: 'ungranted', delivery: 'not-attempted', eventId: null }
    }
    if (!['completed', 'failed', 'cancelled'].includes(status)) {
      throw supervisorError('supervisor/invalid-notification', `settlement status "${status}" is not terminal`, { status })
    }
    if (task.stopConfirmed !== true) {
      return { delivered: false, outcome: 'not-stopped', delivery: 'not-attempted', eventId: null }
    }
    if (this.liveChildren(task.id).length > 0) {
      return { delivered: false, outcome: 'children-live', delivery: 'not-attempted', eventId: null }
    }
    // The event id is the immutable (taskId, attemptId, logical id) tuple: every
    // task and attempt gets its own identity, so the global outbox dedup cannot
    // collapse two different settlements into one event.
    return this.emitNotification({
      taskId: task.id,
      attemptId: task.attemptId,
      eventId: callbackEventId({ taskId: task.id, attemptId: task.attemptId, logicalId: `settled:${status}`, prefix: 'settled' }),
      targetId: binding.targetId,
      kind: status,
      summary: typeof summary === 'string' ? summary : '',
      ...(Array.isArray(resultIds) ? { resultIds } : {})
    })
  }

  /**
   * Emit one LONG-TASK PROJECT outcome event through the SAME durable sink, dedup and
   * persist-before-send path as a settlement, but without requiring a clean task stop:
   * a serious-issue report is independent of clean settlement and must be able to
   * report an honest unknown/blocked shape without fabricating a stop. The caller owns
   * the stable event identity (one per outcome class) and the bounded summary.
   *
   * @param {{task: object, outcome: string, wireKind: string, summary: string, eventId: string, resultIds?: string[]}} spec - project notification facts.
   * @returns {Promise<object>} delivery verdict.
   */
  async notifyProjectOutcome({ task, outcome, wireKind, summary, eventId, resultIds } = {}) {
    if (!isPlainObject(task)) {
      throw supervisorError('supervisor/invalid-notification', 'a project notification requires the owned task record', {})
    }
    const binding = isPlainObject(task.callbackBinding) ? task.callbackBinding : null
    if (binding === null || !nonBlank(binding.targetId)) {
      return { delivered: false, outcome: 'ungranted', delivery: 'not-attempted', eventId: null }
    }
    if (!nonBlank(eventId)) {
      throw supervisorError('supervisor/invalid-notification', 'a project notification requires a stable eventId', {})
    }
    if (!['completed', 'failed'].includes(wireKind)) {
      throw supervisorError('supervisor/invalid-notification', `a project notification wire kind must be completed|failed, received "${wireKind}"`, { wireKind })
    }
    if (typeof summary !== 'string' || summary.trim().length === 0 || summary.length > MAX_RAW_REPLY_CHARS) {
      throw supervisorError('supervisor/invalid-notification', `a project summary must be a nonblank string of at most ${MAX_RAW_REPLY_CHARS} characters`, {})
    }
    return this.emitNotification({
      taskId: task.id,
      attemptId: task.attemptId,
      eventId,
      targetId: binding.targetId,
      kind: wireKind,
      summary,
      ...(Array.isArray(resultIds) ? { resultIds } : {})
    })
  }

  /**
   * Emit one needs-input reply. Never terminal: the task status is untouched.
   *
   * `blocked` and `needs-input` stay the shared sink's `needs-input` wire kind
   * (the outbox vocabulary has no `blocked`); the distinction is persisted as
   * `replyKind` and rendered as an explicit controller-generated prefix in the
   * bounded summary, so it survives to the recipient.
   *
   * @param {{task: object, attemptId: string, replyId: string, kind?: string, summary: string}} spec - reply facts.
   * @returns {Promise<object>} delivery verdict.
   */
  async notifyReply({ task, attemptId, replyId, kind, summary } = {}) {
    if (!isPlainObject(task)) throw supervisorError('supervisor/invalid-notification', 'a reply requires the owned task record', {})
    if (!nonBlank(replyId) || replyId.length > 200) {
      throw supervisorError('supervisor/invalid-reply', 'replyId must be a nonblank string of at most 200 characters', { field: 'replyId' })
    }
    const replyKind = kind === undefined ? 'needs-input' : kind
    if (!REPLY_KINDS.has(replyKind)) {
      throw supervisorError('supervisor/invalid-reply', `reply kind must be one of ${[...REPLY_KINDS].join('|')}`, { field: 'kind' })
    }
    if (typeof summary !== 'string' || summary.trim().length === 0 || summary.length > MAX_RAW_REPLY_CHARS) {
      throw supervisorError('supervisor/invalid-reply', `summary must be a nonblank string of at most ${MAX_RAW_REPLY_CHARS} characters`, { field: 'summary' })
    }
    // The raw bound above is the worker contract. The controller-generated prefix is
    // added next and the RESULT is checked against the integration wire bound, so a
    // reply can never be silently sliced down to fit a transport.
    const wireSummary = prefixedSummary(replyKind, summary)
    if (wireSummary.length > MAX_WIRE_REPLY_CHARS) {
      throw supervisorError(
        'supervisor/invalid-reply',
        `the prefixed reply summary would be ${wireSummary.length} characters, above the ${MAX_WIRE_REPLY_CHARS}-character integrated wire bound; shorten the summary (it is never truncated)`,
        { field: 'summary' }
      )
    }
    const binding = isPlainObject(task.callbackBinding) ? task.callbackBinding : null
    if (binding === null || !nonBlank(binding.targetId)) {
      return { delivered: false, outcome: 'ungranted', delivery: 'not-attempted', eventId: null, replyKind }
    }
    const effectiveAttempt = nonBlank(attemptId) ? attemptId : task.attemptId
    const result = await this.emitNotification({
      taskId: task.id,
      attemptId: effectiveAttempt,
      eventId: callbackEventId({ taskId: task.id, attemptId: effectiveAttempt, logicalId: `reply:${replyId}`, prefix: 'reply' }),
      targetId: binding.targetId,
      kind: 'needs-input',
      summary: wireSummary,
      replyKind
    })
    return { ...result, replyKind }
  }

  // -- child ledger -------------------------------------------------------

  /** Register a child ledger entry. Duplicate `childKey` returns the existing child. */
  registerChild(entry = {}) {
    const taskId = nonBlank(entry.taskId) ? entry.taskId : null
    const attemptId = nonBlank(entry.attemptId) ? entry.attemptId : null
    const childKey = nonBlank(entry.childKey) ? entry.childKey.trim() : null
    const childId = nonBlank(entry.childId) ? entry.childId : null
    if (taskId === null || attemptId === null || childKey === null || childId === null) {
      throw supervisorError('supervisor/invalid-child', 'a child entry requires taskId, attemptId, childKey and childId', {})
    }
    const key = `${taskId}:${attemptId}:${childKey}`
    const existingId = this.#childKeys.get(key)
    if (existingId !== undefined) {
      const existing = this.#children.get(existingId)
      if (existing !== undefined) return { created: false, child: { ...existing } }
    }
    const child = {
      childId,
      childKey,
      taskId,
      attemptId,
      parentSessionId: nonBlank(entry.parentSessionId) ? entry.parentSessionId : null,
      sessionId: nonBlank(entry.sessionId) ? entry.sessionId : null,
      requestId: nonBlank(entry.requestId) ? entry.requestId : null,
      depth: Number.isInteger(entry.depth) ? entry.depth : 1,
      state: LIVE_CHILD_STATES.has(entry.state) ? entry.state : 'reserved',
      lineage: nonBlank(entry.lineage) ? entry.lineage : null,
      grant: isPlainObject(entry.grant) ? safe(entry.grant) : null,
      summary: typeof entry.summary === 'string' ? entry.summary : '',
      assistantText: '',
      finalText: '',
      boundTurn: undefined,
      stopConfirmed: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.#children.set(childId, child)
    this.#childKeys.set(key, childId)
    this.#persistTaskChildren(taskId)
    if (this.persist.event !== undefined) {
      try {
        this.persist.event(taskId, { type: 'child/registered', childId, attemptId, childKey, depth: child.depth, state: child.state })
      } catch {
        // A durable event failure must not fabricate a registered child; the
        // in-memory ledger still holds the reservation and the caller's persist
        // helper reports the failure through its own path.
      }
    }
    return { created: true, child: { ...child } }
  }

  findChildByKey(taskId, attemptId, childKey) {
    const key = `${taskId}:${attemptId}:${childKey}`
    const childId = this.#childKeys.get(key)
    if (childId === undefined) return undefined
    const child = this.#children.get(childId)
    return child === undefined ? undefined : { ...child }
  }

  findChild(childId) {
    const child = this.#children.get(childId)
    return child === undefined ? undefined : { ...child }
  }

  /** Children of one task, optionally limited to one attempt or to live work. */
  childrenOf(taskId, { attemptId, liveOnly = false } = {}) {
    const out = []
    for (const child of this.#children.values()) {
      if (child.taskId !== taskId) continue
      if (attemptId !== undefined && child.attemptId !== attemptId) continue
      if (liveOnly && TERMINAL_CHILD_STATES.has(child.state)) continue
      out.push({ ...child })
    }
    return out
  }

  /** Live (non-terminal) children of one task. */
  liveChildren(taskId) {
    return this.childrenOf(taskId, { liveOnly: true })
  }

  /** Update one child entry; `updatedAt` always advances. */
  setChildState(childId, changes = {}) {
    const child = this.#children.get(childId)
    if (child === undefined) throw supervisorError('supervisor/unknown-child', `child "${childId}" is unknown`, { childId })
    Object.assign(child, changes, { updatedAt: Date.now() })
    if (Array.isArray(changes.disposers)) child.disposers = changes.disposers
    this.#persistTaskChildren(child.taskId)
    return { ...child }
  }

  /**
   * Reserve the ledger slot for one child SYNCHRONOUSLY, before any async host
   * call. Saturation is returned, never waited on.
   */
  reserveChild({ taskId, attemptId, childId, label } = {}) {
    const verdict = this.ledger.reserve({
      key: `child:${taskId}:${childId}`,
      kind: 'child',
      taskId,
      attemptId,
      childId,
      label
    })
    if (!verdict.ok) {
      return {
        ok: false,
        code: 'supervisor/saturated',
        reason: `global concurrency limit ${verdict.limit} is saturated; retry after an active task or child reaches a confirmed stop`,
        counts: verdict.counts
      }
    }
    return { ok: true, reservation: verdict.reservation, counts: verdict.counts }
  }

  /**
   * Release a child slot. An unconfirmed stop keeps the slot AND moves the child
   * snapshot to `unknown`, so the child ledger, the capability report and the
   * ledger cannot disagree about a live-looking child whose stop is unproven.
   */
  releaseChild({ taskId, childId, stopConfirmed, reason } = {}) {
    const key = `child:${taskId}:${childId}`
    if (stopConfirmed !== true) {
      const detail = nonBlank(reason) ? reason : 'child stop is not confirmed'
      this.ledger.markUnknown(key, detail)
      // The snapshot is only re-marked when a child entry exists: the ledger key
      // is authoritative and may outlive the in-memory child (recovery).
      if (this.#children.has(childId)) this.markChildUnknown(childId, detail)
      return false
    }
    return this.ledger.release(key, { stopConfirmed: true, reason })
  }

  /** Mark one child unknown (ambiguous) and keep its slot. */
  markChildUnknown(childId, reason) {
    const child = this.setChildState(childId, { state: 'unknown', stopConfirmed: false, ambiguity: nonBlank(reason) ? reason : 'unconfirmed' })
    this.ledger.markUnknown(`child:${child.taskId}:${childId}`, reason)
    if (this.persist.event !== undefined) {
      try {
        this.persist.event(child.taskId, { type: 'child/unknown', childId, attemptId: child.attemptId, reason: child.ambiguity })
      } catch {
        // contained: the in-memory ambiguity is the authority here
      }
    }
    return child
  }

  /**
   * Cancel every live descendant of one task. A child is released only when the
   * injected cancel callback proves its stop; otherwise it is marked unknown and
   * keeps its slot. Children are cancelled newest-first.
   */
  async cancelDescendants({ taskId, reason, cancelChild } = {}) {
    const live = this.liveChildren(taskId).reverse()
    const results = []
    for (const child of live) {
      let outcome = { stopConfirmed: false, outcome: 'unknown' }
      if (typeof cancelChild === 'function') {
        try {
          outcome = (await cancelChild(child)) ?? outcome
        } catch (error) {
          outcome = { stopConfirmed: false, outcome: 'unknown', error: String((error && error.message) || error) }
        }
      }
      if (outcome.stopConfirmed === true) {
        this.setChildState(child.childId, { state: outcome.state ?? 'cancelled', stopConfirmed: true, summary: child.summary })
        this.releaseChild({ taskId, childId: child.childId, stopConfirmed: true, reason })
        results.push({ childId: child.childId, state: outcome.state ?? 'cancelled', stopConfirmed: true })
      } else {
        this.markChildUnknown(child.childId, nonBlank(reason) ? reason : 'descendant cancellation unconfirmed')
        results.push({ childId: child.childId, state: 'unknown', stopConfirmed: false, outcome: outcome.outcome ?? 'unknown' })
      }
    }
    return { cancelled: results, unconfirmed: results.filter((entry) => entry.stopConfirmed !== true).length }
  }

  /**
   * Recover one persisted task: every non-terminal persisted child becomes
   * `unknown` without replay, and missing reservations are re-held so unknown
   * work stays counted. Persisted notification identities are adopted so an
   * already-sent event is never re-sent after a restart.
   * @param {object} task - persisted task record.
   * @param {object[]} [events] - persisted task events (bounded read).
   * @returns {{children: object[], adoptions: number, reservations: number}} recovery report.
   */
  recoverTask(task, events = []) {
    let adoptions = 0
    for (const event of events) if (this.adoptPersistedEvent(task?.id, event)) adoptions += 1
    const persisted = Array.isArray(task?.children) ? task.children : []
    const children = []
    let reservations = 0
    for (const entry of persisted) {
      if (!isPlainObject(entry) || !nonBlank(entry.childId)) continue
      const key = `child:${task.id}:${entry.childId}`
      if (this.#children.has(entry.childId)) {
        const current = this.#children.get(entry.childId)
        if (!TERMINAL_CHILD_STATES.has(current.state)) {
          this.markChildUnknown(entry.childId, 'recovered after restart: child stop is unconfirmed')
          children.push({ ...this.#children.get(entry.childId) })
        }
        continue
      }
      if (!TERMINAL_CHILD_STATES.has(entry.state)) {
        // Adopt (not reserve): the child already exists on disk, so it must stay
        // counted even when the ledger is saturated. It is never replayed.
        this.ledger.adopt({
          key,
          kind: 'child',
          taskId: task.id,
          attemptId: entry.attemptId,
          childId: entry.childId,
          reason: 'recovered after restart: child stop is unconfirmed'
        })
        reservations += 1
        children.push({ ...entry, state: 'unknown', stopConfirmed: false, recovery: 'unknown' })
      }
    }
    return { children: safe(children), adoptions, reservations }
  }

  /** JSON-safe child ledger summary for capability reports and views. */
  snapshot(taskId) {
    const children = taskId === undefined ? [...this.#children.values()] : this.childrenOf(taskId)
    return safe({
      ownerId: this.ownerId,
      ledger: this.ledger.snapshot(),
      children: children.map((child) => ({
        childId: child.childId,
        taskId: child.taskId,
        attemptId: child.attemptId,
        state: child.state,
        depth: child.depth,
        sessionId: child.sessionId,
        lineage: child.lineage,
        stopConfirmed: child.stopConfirmed
      }))
    })
  }

  #persistTaskChildren(taskId) {
    if (this.persist.update === undefined) return
    try {
      this.persist.update(taskId, {
        children: [...this.#children.values()]
          .filter((child) => child.taskId === taskId)
          .map((child) => ({
            childId: child.childId,
            childKey: child.childKey,
            attemptId: child.attemptId,
            sessionId: child.sessionId,
            depth: child.depth,
            state: child.state,
            lineage: child.lineage,
            stopConfirmed: child.stopConfirmed,
            summary: child.summary
          }))
      })
    } catch {
      // Contained: the caller's store reports its own failures; the supervisor
      // never fabricates a persisted child.
    }
  }
}

export default BridgeSupervisor
