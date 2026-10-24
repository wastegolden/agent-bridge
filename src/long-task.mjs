// src/long-task.mjs
//
// First runnable long-task supervisor (contract `long-supervisor-first-edition-v1`).
//
// One discoverable `bridge_submit` packet carrying `project` creates ONE real Flash
// supervisor session. That session declares bounded workers through supervisor-only
// tools (`dsh_supervisor_*`), freezes the plan once, and ends its model round. From
// then on this module owns the project deterministically:
//
//   * scheduling: ready workers become REAL bounded bridge tasks (the same
//     TaskStore/BridgeService/WorkspaceManager/shared-16-ledger path as any other
//     task), one writer per fresh bridge-owned worktree;
//   * ordinary retries: at most `maxRepairAttempts` (<=2) repairs per logical
//     worker, counted against project-wide start/retry/tool/time budgets, and only
//     after the previous attempt proved its stop;
//   * honest aggregation: only verified stopped work can complete or cleanly fail a
//     project; unverified owned work keeps its reservation and leaves the project
//     `unknown`/`project.status:'blocked'`, never a fabricated stop;
//   * one durable callback per outcome class through the existing trusted outbox and
//     the immutable submission-time callback binding. Worker settlements never wake
//     the coordinator.
//
// Design rules:
//   - Persist before dispatch. Worker definitions and the attempt's deterministic
//     idempotency key are stored before `service.submit`; an interrupted dispatch is
//     ambiguous and is never replayed after a restart.
//   - Never fabricate capacity: an unconfirmed stop is `unknown`, and no retry
//     starts without a positive stop proof.
//   - Pure decisions (`aggregateProject`, attenuation, event ids) are separated from
//     host effects so they can be tested without a host.
//   - No timers and no host listeners: every transition is event-driven from the
//     service hooks below, so `close()` cannot leak a handle.
//
// CLI/model/text never carries authority here: the supervisor cannot name a
// destination, thread, token, model route or another root, and workers cannot
// delegate, use a shell, start jobs, or receive supervisor/child tools.

import path from 'node:path'
import { createHash } from 'node:crypto'
import { TERMINAL, digest, fail, isWithin, resolvedPath } from './contracts.mjs'

export const PROJECT_SCHEMA_VERSION = 1
export const PROJECT_TERMINAL = new Set(['completed', 'failed', 'cancelled'])
export const PROJECT_WAITING = 'supervising'
/** Distinct control states of a pause request: never reported as paused until proven. */
export const PROJECT_PAUSING = 'pausing'
export const PROJECT_PAUSED = 'paused'
export const MAX_PROJECT_SUMMARY_CHARS = 2000
export const MAX_ROUNDS = 8
export const WORKER_ATTEMPT_STATES = Object.freeze(['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'])
/**
 * Bounded per-worker excerpt of a REAL settled result carried into the next round prompt.
 * It is a snapshot of `task.result.text` of the actual owned worker task, never a summary
 * invented for the prompt; the full result stays available through `worker_result`.
 */
export const WORKER_RESULT_EXCERPT_CHARS = 512
/** Largest number of workers whose real result excerpt may appear in one round prompt. */
export const MAX_PROMPT_RESULT_WORKERS = 16
/**
 * Bounded per-operation history of explicit resume requests. Every accepted or refused
 * requestId keeps its FIRST recorded outcome for the life of the project; the oldest ones
 * are never silently evicted in a way that would let their retry be read as a new command.
 * At capacity an unknown requestId is typed-refused before any mutation or admission.
 */
export const RESUME_REQUEST_HISTORY_LIMIT = 128
export const PAUSE_REQUEST_HISTORY_LIMIT = 128

/**
 * Supervisor-only model-facing tools. Registered additively per project grant. The two
 * decision tools are granted ONLY on a recurrent project (packet.project.maxRounds >= 2),
 * so a legacy plan-once packet keeps its exact historical tool surface.
 */
export const SUPERVISOR_PROJECT_TOOLS = Object.freeze([
  'dsh_supervisor_worker_create',
  'dsh_supervisor_plan_finalize',
  'dsh_supervisor_worker_list',
  'dsh_supervisor_worker_result',
  'dsh_supervisor_worker_cancel',
  'dsh_supervisor_project_status',
  'dsh_supervisor_project_complete',
  'dsh_supervisor_project_block'
])

/** Tools granted only when the resolved project grant opted into bounded recurrence. */
export const SUPERVISOR_RECURRENT_TOOLS = Object.freeze([
  'dsh_supervisor_project_complete',
  'dsh_supervisor_project_block'
])

/** Tool name -> runtime handler. Keeps the adapter's dispatch table tiny. */
export const SUPERVISOR_TOOL_HANDLERS = Object.freeze({
  dsh_supervisor_worker_create: 'workerCreate',
  dsh_supervisor_plan_finalize: 'planFinalize',
  dsh_supervisor_worker_list: 'workerList',
  dsh_supervisor_worker_result: 'workerResult',
  dsh_supervisor_worker_cancel: 'workerCancel',
  dsh_supervisor_project_status: 'projectStatus',
  dsh_supervisor_project_complete: 'projectComplete',
  dsh_supervisor_project_block: 'projectBlock'
})

/**
 * Tools a worker may never receive, whatever the worker envelope says. Shell and
 * native delegation are unbounded for a bounded task; the bridge/supervisor tools are
 * grant-admitted on the supervisor only.
 */
export const WORKER_FORBIDDEN_TOOLS = Object.freeze(new Set([
  'bash', 'pwsh',
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'send_message',
  'interrupt_agent', 'list_subagent_models', 'list_agents', 'ralph', 'workflow', 'run_code',
  'skill', 'job_list', 'create_goal', 'update_goal', 'apply_patch',
  'dsh_child_spawn', 'dsh_child_wait', 'dsh_child_result', 'dsh_child_cancel', 'dsh_child_list',
  'dsh_job_start', 'dsh_bridge_reply',
  ...SUPERVISOR_PROJECT_TOOLS
]))

const WORKER_REQUEST_KEYS = new Set([
  'workerKey', 'objective', 'label', 'acceptance', 'role', 'tools',
  'readRoots', 'writeRoots', 'allowNetwork', 'budgets', 'required', 'dependsOn'
])
const WORKER_ROLES = new Set(['investigate', 'implement', 'review', 'integrate'])
const BUDGET_KEYS = ['timeoutMs', 'maxToolCalls', 'maxOutputChars']
const PROJECT_CONFIG_KEYS = ['enabled', 'maxWorkers', 'maxConcurrentWorkers', 'maxRepairAttempts', 'maxTotalRetries', 'maxWorkerStarts', 'maxTotalToolCalls', 'projectTimeoutMs', 'reserveSlots', 'summaryChars', 'maxRounds', 'pause']
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
/**
 * Adapter-local refusal codes that prove nothing crossed the host boundary. A resumed
 * recurrent round refused with one of these keeps its pause checkpoint instead of
 * failing the project; nothing is replayed and no new session is adopted.
 */
const LOCAL_ROUND_REFUSALS = Object.freeze(new Set([
  'adapter/recovery-unsafe',
  'adapter/host-state-unknown',
  'adapter/host-not-settled',
  'adapter/round-budget-widened',
  'adapter/round-unstopped',
  'adapter/unknown-task',
  'adapter/attempt-in-flight',
  'adapter/project-required',
  'adapter/project-not-recurrent',
  'adapter/project-unsupported',
  'adapter/not-owned',
  'adapter/session-mismatch',
  'adapter/revision-mismatch',
  'adapter/task-cleaned',
  'ROUND_UNSUPPORTED'
]))

/**
 * Host policy caps. The DEFAULTS are the absolute host ceilings, not the values a
 * project runs with: a packet that omits a field gets the conservative request
 * defaults applied by `src/contracts.mjs`, and the operator lowers these only when
 * they want a smaller host cap. Host policy may never raise a request. `maxRounds`
 * defaults to the single historical planning round, so bounded recurrence and
 * pause/resume are opt-in on the host AND on the packet; `pause` additionally gates
 * the control-plane pause/resume API.
 */
export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  enabled: false,
  maxWorkers: 16,
  maxConcurrentWorkers: 16,
  maxRepairAttempts: 2,
  maxTotalRetries: 64,
  maxWorkerStarts: 64,
  maxTotalToolCalls: 100000,
  projectTimeoutMs: 86400000,
  reserveSlots: 15,
  summaryChars: MAX_PROJECT_SUMMARY_CHARS,
  maxRounds: 1,
  pause: false
})

/** Domain failure with a stable `.code` (`project/*`). */
export function projectError(code, message, details) {
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

function safe(value, seen = new Set(), depth = 0) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined
  if (depth > 10) return '[depth-limit]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => (safe(item, seen, depth + 1) ?? null))
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

function boundedText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function pathInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function insideAny(roots, target) {
  return roots.some((root) => pathInside(root, target))
}

/* ------------------------------------------------------------------ config */

/**
 * Normalize the operator `supervisorProjects` host option. Absent/`enabled:false`
 * keeps every legacy path byte-identical: a packet carrying `project` is then refused
 * with a typed host refusal instead of silently running without the runtime.
 * @param {unknown} raw - host config block.
 * @returns {object} frozen normalized config.
 */
export function normalizeProjectConfig(raw) {
  if (raw === undefined || raw === null) return Object.freeze({ ...DEFAULT_PROJECT_CONFIG })
  if (!isPlainObject(raw)) throw projectError('project/invalid-config', 'supervisorProjects must be a plain object when present', { field: 'supervisorProjects' })
  for (const key of Object.keys(raw)) {
    if (!PROJECT_CONFIG_KEYS.includes(key)) {
      throw projectError('project/invalid-config', `supervisorProjects.${key} is not a permitted field`, { field: `supervisorProjects.${key}` })
    }
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw projectError('project/invalid-config', 'supervisorProjects.enabled must be a boolean when present', { field: 'supervisorProjects.enabled' })
  }
  const int = (key, min, max) => {
    const value = raw[key]
    if (value === undefined) return DEFAULT_PROJECT_CONFIG[key]
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw projectError('project/invalid-config', `supervisorProjects.${key} must be an integer within ${min}..${max}`, { field: `supervisorProjects.${key}` })
    }
    return value
  }
  const maxWorkers = int('maxWorkers', 1, 16)
  // Dependent default, never a silent clamp: when the operator lowers `maxWorkers` and
  // omits `maxConcurrentWorkers`, the concurrency request follows the smaller worker
  // ceiling. An EXPLICIT contradictory pair is still refused below.
  const maxConcurrentWorkers = raw.maxConcurrentWorkers === undefined
    ? Math.min(DEFAULT_PROJECT_CONFIG.maxConcurrentWorkers, maxWorkers)
    : int('maxConcurrentWorkers', 1, 16)
  const config = {
    enabled: raw.enabled === true,
    maxWorkers,
    maxConcurrentWorkers,
    maxRepairAttempts: int('maxRepairAttempts', 0, 2),
    maxTotalRetries: int('maxTotalRetries', 0, 64),
    maxWorkerStarts: int('maxWorkerStarts', 1, 64),
    maxTotalToolCalls: int('maxTotalToolCalls', 1, 100000),
    projectTimeoutMs: int('projectTimeoutMs', 1000, 86400000),
    // The host always keeps at least ONE shared-ledger slot free for the coordinator:
    // reserving more is safe as long as it stays feasible inside the shared 16 slots.
    reserveSlots: int('reserveSlots', 1, 15),
    summaryChars: int('summaryChars', 256, 8000),
    // Host recurrence ceiling and pause gate. 1 keeps the historical plan-once project
    // and refuses every pause/resume request; 2..8 is the explicit host opt-in.
    maxRounds: int('maxRounds', 1, MAX_ROUNDS),
    pause: raw.pause === undefined ? false : raw.pause === true
  }
  if (raw.pause !== undefined && typeof raw.pause !== 'boolean') {
    throw projectError('project/invalid-config', 'supervisorProjects.pause must be a boolean when present', { field: 'supervisorProjects.pause' })
  }
  if (config.pause === true && config.maxRounds < 2) {
    throw projectError('project/invalid-config', 'supervisorProjects.pause requires supervisorProjects.maxRounds >= 2: pause/resume is only meaningful for a recurrent project', { field: 'supervisorProjects.pause' })
  }
  if (config.maxConcurrentWorkers > config.maxWorkers) {
    throw projectError('project/invalid-config', 'supervisorProjects.maxConcurrentWorkers must not exceed maxWorkers', { field: 'supervisorProjects.maxConcurrentWorkers' })
  }
  return Object.freeze(config)
}

/**
 * Validate the host caps against one already-normalized `packet.project` block and
 * return the immutable project grant. Host policy may only LOWER a request; a larger
 * request is refused, never clamped.
 * @param {object} project - normalized `packet.project`.
 * @param {object} config - `normalizeProjectConfig` result.
 * @returns {object} frozen grant.
 */
export function resolveProjectGrant(project, config) {
  if (!isPlainObject(project)) throw projectError('project/invalid', 'packet.project must be a plain object', {})
  if (config?.enabled !== true) {
    throw projectError('project/unsupported', 'packet.project is granted but supervisorProjects.enabled is not true for this host', {})
  }
  for (const [field, cap] of [
    ['maxWorkers', config.maxWorkers],
    ['maxConcurrentWorkers', config.maxConcurrentWorkers],
    ['maxRepairAttempts', config.maxRepairAttempts],
    ['maxTotalRetries', config.maxTotalRetries],
    ['maxWorkerStarts', config.maxWorkerStarts],
    ['maxTotalToolCalls', config.maxTotalToolCalls],
    ['timeoutMs', config.projectTimeoutMs],
    ['reserveSlots', config.reserveSlots]
  ]) {
    const requested = project[field]
    if (!Number.isSafeInteger(requested)) throw projectError('project/invalid', `packet.project.${field} must be an integer`, { field })
    if (requested > cap) {
      throw projectError('project/host-cap', `packet.project.${field}=${requested} exceeds the host supervisorProjects cap ${cap}`, { field, requested, cap })
    }
  }
  const scope = project.workerScope
  if (!isPlainObject(scope)) throw projectError('project/invalid', 'packet.project.workerScope must be a plain object', {})
  // Recurrence is resolved here, not in packet normalization: an ABSENT packet
  // `maxRounds` means the historical single planning round, and the host ceiling may
  // only lower an explicit request (over-cap is refused, never clamped).
  const requestedMaxRounds = project.maxRounds === undefined ? 1 : project.maxRounds
  if (!Number.isSafeInteger(requestedMaxRounds) || requestedMaxRounds < 1 || requestedMaxRounds > MAX_ROUNDS) {
    throw projectError('project/invalid', `packet.project.maxRounds must be an integer 1..${MAX_ROUNDS}`, { field: 'maxRounds' })
  }
  const hostMaxRounds = Number.isInteger(config.maxRounds) && config.maxRounds >= 1 && config.maxRounds <= MAX_ROUNDS ? config.maxRounds : 1
  if (requestedMaxRounds > hostMaxRounds) {
    throw projectError('project/host-cap', `packet.project.maxRounds=${requestedMaxRounds} exceeds the host supervisorProjects cap ${hostMaxRounds}`, { field: 'maxRounds', requested: requestedMaxRounds, cap: hostMaxRounds })
  }
  const recurrent = requestedMaxRounds >= 2
  for (const name of scope.allowedTools) {
    if (WORKER_FORBIDDEN_TOOLS.has(name)) {
      throw projectError('project/scope-unsupported', `project.workerScope.allowedTools names "${name}", which can never be bounded to a worker task`, { tool: name })
    }
  }
  return Object.freeze({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    maxWorkers: project.maxWorkers,
    maxConcurrentWorkers: project.maxConcurrentWorkers,
    maxRepairAttempts: project.maxRepairAttempts,
    maxTotalRetries: project.maxTotalRetries,
    maxWorkerStarts: project.maxWorkerStarts,
    maxTotalToolCalls: project.maxTotalToolCalls,
    timeoutMs: project.timeoutMs,
    reserveSlots: project.reserveSlots,
    maxRounds: requestedMaxRounds,
    recurrent,
    // The control-plane pause/resume API is only granted to an explicitly recurrent
    // packet on a host that also enabled it; a legacy packet never gains it.
    pause: recurrent && config.pause === true,
    workerScope: Object.freeze({
      readRoots: Object.freeze([...scope.readRoots]),
      writeRoots: Object.freeze([...scope.writeRoots]),
      allowedTools: Object.freeze([...scope.allowedTools]),
      allowNetwork: scope.allowNetwork === true,
      budgets: Object.freeze({
        timeoutMs: scope.budgets?.timeoutMs ?? 600000,
        maxToolCalls: scope.budgets?.maxToolCalls ?? 100,
        maxOutputChars: scope.budgets?.maxOutputChars ?? 200000
      })
    }),
    ...(project.workspace === undefined ? {} : { workspace: Object.freeze({ repository: project.workspace.repository, baseRef: project.workspace.baseRef }) })
  })
}

/**
 * The durable project record persisted on the supervisor task BEFORE any worker can
 * exist. Every later transition mutates only this record, so a restart can always tell
 * what was declared and what crossed a dispatch boundary.
 * @param {{packet: object, grant: object, now?: number}} spec - resolved grant + packet.
 * @returns {object} fresh project record.
 */
export function createProjectRecord({ packet, grant, now } = {}) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: packet.projectId,
    status: 'planning',
    grant,
    frozenAt: null,
    startedAt: null,
    endedAt: null,
    waitedAt: null,
    cancelRequested: false,
    cancelReason: null,
    workers: [],
    rounds: [],
    // Bounded recurrence bookkeeping. `roundsUsed` is the monotone count of RECORDED
    // proven-stopped rounds; `pendingRound` is the persisted intent/allocation of the
    // round currently crossing (or about to cross) the host boundary, and is the ONLY
    // thing that makes the round in flight: it is cleared exactly when its own stop
    // proof is recorded. `roundBaselineToolCalls` is the cumulative `stats.toolCalls`
    // snapshot taken before a round dispatch, so the round's spend is a delta and the
    // cumulative store counter is never summed twice.
    roundsUsed: 0,
    pendingRound: null,
    roundBaselineToolCalls: null,
    decision: null,
    // Durable pause/resume checkpoint. `control.pause.state` is `none|pausing|paused`
    // and `pausing` is never reported as `paused`; `control.resume` records the last
    // explicit resume request and its outcome so a replay is answerable.
    control: {
      pause: { requestId: null, state: 'none', requestedAt: null, reason: null, pausedAt: null, resumedAt: null },
      resuming: null,
      resume: null
    },
    // Project-wide budget ledger. `toolSpend` is observed released WORKER spend, and
    // `supervisorToolSpend` (present only once a round has been charged) is observed
    // SUPERVISOR round spend; `supervisorReserved` is the full allowance of the
    // in-flight round. Each term is counted exactly once (see `#toolBound`).
    budgets: { starts: 0, retries: 0, toolSpend: 0, supervisorToolCalls: null, supervisorReserved: 0 },
    deadlines: { armed: false, expired: false, firedAt: null },
    callbacks: {},
    aggregate: null,
    seriousIssue: null,
    ownedUnstopped: 0,
    createdAt: Number.isFinite(now) ? now : 0
  }
}

/* ------------------------------------------------- worker attenuation */
/**
 * Validate one supervisor-supplied worker request against the immutable project
 * grant and return the worker definition. Any widening (roots, tools, network,
 * budgets, model route, callback, children, depth) is REFUSED with
 * `project/grant-widened`; nothing is clamped and no worker is created.
 *
 * @param {object} grant - resolved project grant.
 * @param {object} request - untrusted model arguments.
 * @param {{workerKeys?: string[], projectCwd: string, frozen?: boolean}} [context] - plan context.
 * @returns {object} normalized worker definition.
 */
export function attenuateWorkerRequest(grant, request, context = {}) {
  if (!isPlainObject(grant)) throw projectError('project/invalid', 'a resolved project grant is required', {})
  if (!isPlainObject(request)) throw projectError('project/invalid-request', 'a worker request must be a plain object', {})
  for (const key of Object.keys(request)) {
    if (!WORKER_REQUEST_KEYS.has(key)) {
      throw projectError('project/grant-widened', `worker request field "${key}" is not permitted: a worker cannot set it`, { field: key })
    }
  }
  const workerKey = nonBlank(request.workerKey) ? request.workerKey.trim() : ''
  if (workerKey.length === 0 || workerKey.length > 200 || !SAFE_ID_RE.test(workerKey)) {
    throw projectError('project/invalid-request', 'workerKey must be a nonblank identifier of at most 200 characters ([A-Za-z0-9][A-Za-z0-9._:-]*)', { field: 'workerKey' })
  }
  if (!nonBlank(request.objective) || request.objective.length > 20000) {
    throw projectError('project/invalid-request', 'objective must be a nonblank string of at most 20000 characters', { field: 'objective' })
  }
  const label = request.label === undefined ? boundedText(request.objective, 120) : request.label
  if (!nonBlank(label) || label.length > 200) throw projectError('project/invalid-request', 'label must be a nonblank string of at most 200 characters', { field: 'label' })
  let acceptance = ['Complete the bounded worker objective and report evidence and explicit unknowns.']
  if (request.acceptance !== undefined) {
    if (!Array.isArray(request.acceptance) || request.acceptance.length === 0 || request.acceptance.length > 32 || request.acceptance.some((item) => !nonBlank(item))) {
      throw projectError('project/invalid-request', 'acceptance must be a nonempty array of at most 32 nonblank strings', { field: 'acceptance' })
    }
    acceptance = [...request.acceptance]
  }
  const role = request.role === undefined ? 'implement' : request.role
  if (typeof role !== 'string' || !WORKER_ROLES.has(role)) {
    throw projectError('project/invalid-request', `role must be one of ${[...WORKER_ROLES].join('|')}`, { field: 'role' })
  }

  const envelope = grant.workerScope
  const projectCwd = context.projectCwd
  const projectWorkspace = grant.workspace ?? null

  let tools
  if (request.tools === undefined) {
    tools = envelope.allowedTools.filter((name) => !WORKER_FORBIDDEN_TOOLS.has(name))
  } else {
    if (!Array.isArray(request.tools) || request.tools.some((name) => !nonBlank(name))) {
      throw projectError('project/invalid-request', 'tools must be an array of nonblank tool names', { field: 'tools' })
    }
    for (const name of request.tools) {
      if (!envelope.allowedTools.includes(name)) {
        throw projectError('project/grant-widened', `worker requested tool "${name}" outside the project worker envelope`, { field: 'tools', tool: name })
      }
      if (WORKER_FORBIDDEN_TOOLS.has(name)) {
        throw projectError('project/grant-widened', `worker requested tool "${name}", which is never available to a worker task`, { field: 'tools', tool: name })
      }
    }
    tools = [...new Set(request.tools)]
  }
  if (tools.length === 0) throw projectError('project/invalid-request', 'the worker would receive no usable tool', { field: 'tools' })

  const roots = (field, requested, allowed) => {
    if (requested === undefined) return [...allowed]
    if (!Array.isArray(requested) || requested.some((root) => typeof root !== 'string' || !root.trim())) {
      throw projectError('project/invalid-request', `${field} must be an array of absolute paths`, { field })
    }
    const out = []
    for (const root of requested) {
      if (!path.isAbsolute(root)) throw projectError('project/invalid-request', `${field} entries must be absolute paths`, { field })
      // A worker may name an envelope root through another spelling (8.3 short name,
      // junction or symlink alias). Canonicalize it BEFORE the containment check, so the
      // fence compares real locations and the worker receives the canonical root.
      let resolved
      try {
        resolved = resolvedPath(root)
      } catch {
        throw projectError('project/invalid-request', `${field} entry "${root}" cannot be resolved`, { field, root })
      }
      if (!insideAny(allowed, resolved)) {
        throw projectError('project/grant-widened', `worker requested ${field} entry "${root}" outside the project worker envelope`, { field, root: resolved })
      }
      out.push(resolved)
    }
    return out
  }
  const readOnlyRole = role === 'investigate' || role === 'review'
  const readRoots = roots('readRoots', request.readRoots, envelope.readRoots)
  // A read-only role ATTENUATES an omitted writeRoots to none instead of inheriting the
  // full writer envelope: inheriting it would hand a review/investigate worker writable
  // roots and mutation tools it never asked for. An EXPLICIT writeRoots is still
  // refused for such a role, and every widening check is unchanged.
  const writeRoots = roots('writeRoots', request.writeRoots, readOnlyRole && request.writeRoots === undefined ? [] : envelope.writeRoots)
  if (readOnlyRole && writeRoots.length > 0) {
    throw projectError('project/invalid-request', `role "${role}" is read-only and must not declare writeRoots`, { field: 'writeRoots' })
  }

  let allowNetwork = envelope.allowNetwork
  if (request.allowNetwork !== undefined) {
    if (typeof request.allowNetwork !== 'boolean') throw projectError('project/invalid-request', 'allowNetwork must be a boolean', { field: 'allowNetwork' })
    if (request.allowNetwork === true && envelope.allowNetwork !== true) {
      throw projectError('project/grant-widened', 'worker requested network access the project worker envelope does not hold', { field: 'allowNetwork' })
    }
    allowNetwork = request.allowNetwork
  }

  const capBudgets = envelope.budgets
  const budgets = { ...capBudgets }
  if (request.budgets !== undefined) {
    if (!isPlainObject(request.budgets)) throw projectError('project/invalid-request', 'budgets must be a plain object', { field: 'budgets' })
    for (const key of Object.keys(request.budgets)) {
      if (!BUDGET_KEYS.includes(key)) throw projectError('project/grant-widened', `worker budget field "${key}" is not permitted`, { field: `budgets.${key}` })
      const value = request.budgets[key]
      if (!Number.isSafeInteger(value) || value < 1) throw projectError('project/invalid-request', `budgets.${key} must be a positive integer`, { field: `budgets.${key}` })
      if (value > capBudgets[key]) throw projectError('project/grant-widened', `worker budget ${key}=${value} exceeds the project worker budget ${capBudgets[key]}`, { field: `budgets.${key}` })
      budgets[key] = value
    }
  }

  if (request.required !== undefined && typeof request.required !== 'boolean') {
    throw projectError('project/invalid-request', 'required must be a boolean when present', { field: 'required' })
  }
  const required = request.required !== false

  let dependsOn = []
  if (request.dependsOn !== undefined) {
    if (!Array.isArray(request.dependsOn) || request.dependsOn.some((key) => !nonBlank(key))) {
      throw projectError('project/invalid-request', 'dependsOn must be an array of declared worker keys', { field: 'dependsOn' })
    }
    dependsOn = [...new Set(request.dependsOn.map((key) => key.trim()))]
    if (dependsOn.includes(workerKey)) throw projectError('project/invalid-request', 'a worker cannot depend on itself', { field: 'dependsOn' })
    const known = new Set(Array.isArray(context.workerKeys) ? context.workerKeys : [])
    for (const key of dependsOn) {
      if (!known.has(key)) throw projectError('project/invalid-request', `dependsOn names undeclared worker "${key}"`, { field: 'dependsOn', workerKey: key })
    }
  }

  let workspace = projectWorkspace === null ? null : { repository: projectWorkspace.repository, baseRef: projectWorkspace.baseRef }
  if (writeRoots.length > 0) {
    if (workspace === null) {
      throw projectError('project/workspace-required', 'a worker with writeRoots requires packet.project.workspace: every writer needs its own owned worktree', { field: 'writeRoots' })
    }
    for (const root of [...readRoots, ...writeRoots]) {
      if (!isWithin(workspace.repository, root)) {
        throw projectError('project/grant-widened', `worker root "${root}" is outside project.workspace.repository and cannot be isolated per writer`, { field: 'writeRoots' })
      }
    }
    if (!readRoots.some((root) => isWithin(root, workspace.repository))) {
      throw projectError('project/workspace-required', 'a writer worker must cover project.workspace.repository inside its readRoots so its packet cwd is a covered repository root', { field: 'readRoots' })
    }
  } else {
    workspace = null
    if (!insideAny(readRoots, projectCwd)) {
      throw projectError('project/invalid-request', 'worker readRoots must cover the project cwd so the worker session has a declared working directory', { field: 'readRoots' })
    }
  }

  if (context.frozen === true && context.recurrent !== true) {
    throw projectError('project/plan-frozen', 'the project plan is already frozen; workers cannot be added after dsh_supervisor_plan_finalize', {})
  }
  // A recurrent project appends workers between rounds, but only inside the same
  // immutable envelope and hard worker cap: the plan is append-only, never rewritable.
  const existing = Array.isArray(context.workerKeys) ? context.workerKeys : []
  if (existing.length >= grant.maxWorkers) {
    throw projectError('project/worker-limit', `the plan already declares ${existing.length} worker(s); packet.project.maxWorkers is ${grant.maxWorkers}`, { maxWorkers: grant.maxWorkers })
  }

  return {
    workerKey,
    objective: request.objective,
    label,
    acceptance,
    role,
    tools,
    readRoots,
    writeRoots,
    allowNetwork,
    budgets,
    required,
    dependsOn,
    workspace
  }
}

/**
 * The immutable declaration fields of one normalized worker. Two requests with the
 * same workerKey are an identical replay only when this projection is equal; a
 * changed projection is a conflict, never a silent mutation of a frozen definition.
 * @param {object} worker - normalized worker (or persisted worker entry).
 * @returns {object} bounded declaration projection.
 */
function workerDeclaration(worker) {
  return {
    workerKey: worker.workerKey,
    objective: worker.objective,
    label: worker.label,
    acceptance: worker.acceptance,
    role: worker.role,
    tools: worker.tools,
    readRoots: worker.readRoots,
    writeRoots: worker.writeRoots,
    allowNetwork: worker.allowNetwork,
    budgets: worker.budgets,
    required: worker.required,
    dependsOn: worker.dependsOn,
    workspace: worker.workspace
  }
}

/** Deterministic, bounded idempotency key for one logical worker attempt. */
export function workerAttemptKey(projectTaskId, workerKey, attempt) {
  const hex = createHash('sha256').update(JSON.stringify(['worker', projectTaskId, workerKey, attempt])).digest('hex')
  return `pw-${hex}`
}

/**
 * Remaining project time from the persisted admission anchor. Planning, capacity-waiting
 * and dispatch time all count against the same deadline. A worker is never granted more
 * runtime than the project has left, so no bounded worker outlives its project.
 * @param {object} project - persisted project record.
 * @param {number} now - current clock value.
 * @returns {number} remaining milliseconds (0 when already elapsed).
 */
export function projectDeadlineRemaining(project, now) {
  const timeout = Number.isInteger(project?.grant?.timeoutMs) ? project.grant.timeoutMs : 0
  const created = Number.isFinite(project?.createdAt) ? project.createdAt : now
  return Math.max(0, timeout - Math.max(0, now - created))
}

/**
 * Deterministic callback identity. The outbox dedups `eventId` globally, so the id
 * binds the project task, its attempt, the outcome class and the aggregate content.
 */
export function projectCallbackEventId({ taskId, attemptId, outcomeClass, aggregateHash }) {
  if (!nonBlank(taskId) || !nonBlank(attemptId) || !nonBlank(outcomeClass)) {
    throw projectError('project/invalid-notification', 'a project callback identity requires taskId, attemptId and an outcome class', {})
  }
  const digestHex = createHash('sha256').update(JSON.stringify([taskId.trim(), attemptId.trim(), outcomeClass.trim(), String(aggregateHash ?? '')])).digest('hex')
  return `project-${digestHex}`.slice(0, 128)
}

/** Stable digest of the aggregate content used to bind a callback. */
export function aggregateDigest(workers) {
  const shape = (Array.isArray(workers) ? workers : []).map((worker) => ({
    workerKey: worker?.workerKey ?? null,
    required: worker?.required !== false,
    state: worker?.state ?? 'queued',
    attempts: Array.isArray(worker?.attempts) ? worker.attempts.length : 0
  }))
  return digest(shape)
}

/**
 * Pure aggregation decision over persisted worker/attempt state.
 *
 * `attempt.retryBlocked === true` marks a retry the project budget refused; it is
 * treated as exhausted so a budget refusal can never look like a pending plan.
 * `worker.cancelledBeforeDispatch === true` is an explicit controller cancellation.
 *
 * @param {{workers?: object[], maxRepairAttempts?: number}} spec - plan state.
 * @returns {{status: 'pending'|'completed'|'failed'|'unknown', retryable: object[], unknown: string[], requiredFailed: string[], optionalDegraded: string[], cancelled: string[], reasons: string[]}}
 */
export function aggregateProject({ workers = [], maxRepairAttempts = 2 } = {}) {
  const retryable = []
  const unknown = []
  const requiredFailed = []
  const optionalDegraded = []
  const cancelled = []
  const reasons = []
  let pending = false

  for (const worker of workers) {
    const key = worker?.workerKey ?? '(unnamed)'
    if (worker?.cancelledBeforeDispatch === true) {
      cancelled.push(key)
      if (worker.required !== false) requiredFailed.push(key)
      else optionalDegraded.push(key)
      continue
    }
    const attempts = Array.isArray(worker?.attempts) ? worker.attempts : []
    const last = attempts[attempts.length - 1]
    if (last === undefined) {
      pending = true
      continue
    }
    const state = last.state
    if (state === 'unknown') {
      unknown.push(key)
      continue
    }
    if (state === 'queued' || state === 'dispatching' || state === 'running') {
      pending = true
      continue
    }
    if (state === 'succeeded') continue
    if (state === 'cancelled' && last.cancelRequested === true) {
      cancelled.push(key)
      if (worker.required !== false) requiredFailed.push(key)
      else optionalDegraded.push(key)
      continue
    }
    // An ordinary failure (failed, or a non-controller cancellation such as a timeout).
    const repairs = attempts.length - 1
    const canRetry = repairs < maxRepairAttempts && last.retryBlocked !== true
    if (canRetry) {
      retryable.push({ workerKey: key, nextAttempt: attempts.length + 1 })
      continue
    }
    if (worker.required !== false) {
      requiredFailed.push(key)
      reasons.push(`${key} exhausted its bounded repair attempts (${repairs}/${maxRepairAttempts})`)
    } else {
      optionalDegraded.push(key)
    }
  }

  const base = { retryable, unknown, requiredFailed, optionalDegraded, cancelled, reasons }
  if (unknown.length > 0) return { status: 'unknown', ...base, reasons: [...reasons, `unverified owned work: ${unknown.join(', ')}`] }
  if (requiredFailed.length > 0) return { status: 'failed', ...base }
  if (retryable.length > 0) return { status: 'pending', ...base }
  if (pending) return { status: 'pending', ...base }
  return { status: 'completed', ...base }
}

/** Bounded, stable aggregate summary text (no timestamps, no volatile values). */
export function aggregateSummary(project, decision, extra = []) {
  const lines = [`project ${project.projectId ?? ''} ${project.status}: ${decision.status}`.trim()]
  for (const worker of project.workers ?? []) {
    const last = Array.isArray(worker.attempts) ? worker.attempts[worker.attempts.length - 1] : undefined
    const inspect = last?.inspect
    const artifact = inspect === undefined || inspect === null ? 'no-workspace' : inspect.dirty === true ? `dirty:${(inspect.changedPaths ?? []).length}` : inspect.head ? `head:${String(inspect.head).slice(0, 12)}` : 'inspect-unknown'
    lines.push(`- ${worker.workerKey} [${worker.required === false ? 'optional' : 'required'}] ${worker.state} attempts=${(worker.attempts ?? []).length} artifact=${artifact}`)
  }
  if (decision.requiredFailed.length > 0) lines.push(`required failed: ${decision.requiredFailed.join(', ')}`)
  if (decision.unknown.length > 0) lines.push(`unverified: ${decision.unknown.join(', ')}`)
  if (decision.optionalDegraded.length > 0) lines.push(`optional degraded: ${decision.optionalDegraded.join(', ')}`)
  for (const reason of [...decision.reasons, ...extra]) lines.push(`reason: ${reason}`)
  return lines.join('\n').slice(0, MAX_PROJECT_SUMMARY_CHARS)
}

/** Supervisor-round prompt for a project packet. Used by `src/service.mjs`. */
export function buildProjectPrompt(packet, model, grant, taskId) {
  const scope = packet.project.workerScope
  return [
    `[dsh-long-task supervisor] project ${packet.projectId} task ${taskId ?? packet.id ?? '(unknown)'} revision ${packet.revision}`,
    `title: ${packet.title}`,
    `objective: ${packet.objective}`,
    `route (immutable, inherited by every worker): ${model?.provider ?? '?'}/${model?.model ?? '?'}${model?.reasoningEffort ? ` effort=${model.reasoningEffort}` : ''}`,
    'You are the supervisor of ONE long project. Your single model round must declare the complete bounded worker plan with the supervisor-only tools below, then call dsh_supervisor_plan_finalize. The host then schedules, retries (bounded) and aggregates deterministically; you cannot wait for workers, merge branches, wake anyone, or choose any destination.',
    'Worker envelope (the ONLY roots/tools/network a worker may request; every request that widens it is refused, never clamped):',
    `  readRoots: ${scope.readRoots.join(', ') || '(none)'}`,
    `  writeRoots: ${scope.writeRoots.join(', ') || '(none)'}`,
    `  allowedTools: ${scope.allowedTools.join(', ') || '(none)'}`,
    `  allowNetwork: ${scope.allowNetwork === true}`,
    ...(grant.workspace ? [`  workspace: every writer gets a fresh owned worktree from ${grant.workspace.repository}@${grant.workspace.baseRef}`] : []),
    `budgets: maxWorkers=${grant.maxWorkers} maxConcurrentWorkers=${grant.maxConcurrentWorkers} maxRepairAttempts=${grant.maxRepairAttempts} maxWorkerStarts=${grant.maxWorkerStarts} maxTotalToolCalls=${grant.maxTotalToolCalls} timeoutMs=${grant.timeoutMs}`,
    'Acceptance:',
    ...packet.acceptance.map((item, index) => `  ${index + 1}. ${item}`),
    'Rules: declare at least one worker (declare three or more when the objective splits); give each worker one bounded responsibility, explicit acceptance and only the tools/roots it needs; mark a worker required=false only if the project genuinely survives its failure; never name a model, callback, thread, token or depth; workers cannot delegate. After dsh_supervisor_plan_finalize the plan is frozen and your round ends.',
    `Supervisor tools: ${SUPERVISOR_PROJECT_TOOLS.join(', ')}.`
  ].join('\n')
}

/** Deterministic, bounded dispatch identity of one bounded supervisor round. */
export function roundDispatchKey(projectTaskId, roundIndex) {
  const hex = createHash('sha256').update(JSON.stringify(['round', projectTaskId, roundIndex])).digest('hex')
  return `pr-${hex}`
}

/**
 * Supervisor-round REVIEW prompt for a recurrent project. It carries only REAL,
 * persisted evidence: the aggregate decision of the completed wave, each worker's
 * last attempt state with its verified stop flag, and a bounded slice of its actual
 * result text. The model is told it may append bounded workers inside the immutable
 * envelope, record an explicit complete/block decision, or do neither (which requests
 * one more bounded round). Waiting for workers is host-driven: the model round ends and
 * the host schedules/waits, so no polling or busy-wait token spend is possible here.
 */
export function buildRoundPrompt(packet, task) {
  const project = task.project
  const grant = project.grant
  const scope = packet.project?.workerScope ?? project.grant.workerScope
  // The line describes the WAVE of workers that just settled, NOT the whole project: the
  // project legitimately stays pending for another bounded round after a COMPLETED wave.
  // The status is therefore re-derived here from the same settled worker evidence the
  // persisted state holds, instead of reading a possibly stale whole-project aggregate.
  const decision = aggregateProject({ workers: project.workers, maxRepairAttempts: grant.maxRepairAttempts })
  // A round minted to finish an UNFROZEN plan (a resumed planning checkpoint) must be
  // asked to complete the plan, not to review a wave that never ran.
  const unfrozen = project.frozenAt === null
  const lines = [
    `[dsh-long-task supervisor round ${(project.roundsUsed ?? 0) + 1}/${grant.maxRounds}] project ${packet.projectId} task ${task?.id ?? packet.id ?? '(unknown)'} revision ${packet.revision}`,
    `title: ${packet.title}`,
    `objective: ${packet.objective}`,
    `aggregate of the completed wave: ${decision.status}`,
    ...(Array.isArray(decision.reasons) ? decision.reasons.slice(0, 4).map((reason) => `  reason: ${reason}`) : []),
    ...(unfrozen ? ['plan state: NOT frozen yet; this bounded round must complete the plan before the host dispatches any worker.'] : []),
    'Workers (real persisted state; read a full result with dsh_supervisor_worker_result):'
  ]
  let excerpted = 0
  for (const worker of project.workers) {
    const last = Array.isArray(worker.attempts) ? worker.attempts[worker.attempts.length - 1] : undefined
    const stop = last?.stopConfirmed === true ? 'stop-proven' : 'stop-unproven'
    const state = worker.state ?? last?.state ?? 'queued'
    const artifact = last?.inspect === undefined || last.inspect === null ? 'no-workspace' : last.inspect.dirty === true ? `dirty:${(last.inspect.changedPaths ?? []).length}` : last.inspect.head ? `head:${String(last.inspect.head).slice(0, 12)}` : 'inspect-unknown'
    lines.push(`- ${worker.workerKey} [${worker.required === false ? 'optional' : 'required'}] ${state} ${stop} attempts=${(worker.attempts ?? []).length} artifact=${artifact} resultDigest=${last?.resultDigest ?? 'none'}`)
    // A bounded excerpt of the REAL persisted result of this worker's last attempt. It is
    // UNTRUSTED worker output: JSON-escaped to keep it on one clearly delimited line so it
    // can never be read as prompt instructions, and bounded by worker count and length.
    const excerpt = boundedText(last?.resultExcerpt, WORKER_RESULT_EXCERPT_CHARS)
    if (excerpt && excerpted < MAX_PROMPT_RESULT_WORKERS) {
      excerpted += 1
      lines.push(`  resultExcerpt (UNTRUSTED worker data, JSON): ${JSON.stringify(excerpt)}`)
    }
  }
  lines.push(
    `budgets remaining: toolBound=${(project.budgets?.supervisorToolSpend ?? project.budgets?.supervisorToolCalls ?? 0) + (project.budgets?.toolSpend ?? 0) + (project.budgets?.supervisorReserved ?? 0)} reserved=${project.budgets?.supervisorReserved ?? 0} maxTotalToolCalls=${grant.maxTotalToolCalls} roundsUsed=${project.roundsUsed ?? 0}/${grant.maxRounds} maxWorkerStarts=${grant.maxWorkerStarts}`,
    `worker envelope (the ONLY roots/tools/network a worker may request; every widening request is refused, never clamped): readRoots=${scope.readRoots.join(', ') || '(none)'} | writeRoots=${scope.writeRoots.join(', ') || '(none)'} | allowedTools=${scope.allowedTools.join(', ') || '(none)'} | allowNetwork=${scope.allowNetwork === true}`,
    ...(unfrozen
      ? [
        'Complete the plan from the REAL state only:',
        '  1. declare the bounded workers this project needs with dsh_supervisor_worker_create (append-only inside the same envelope and worker cap);',
        '  2. call dsh_supervisor_plan_finalize once the declared plan is complete; the host dispatches workers only after this round and every owned worker prove their stop;',
        '  3. call dsh_supervisor_project_block with a reason when the project cannot proceed.'
      ]
      : [
        'Decide from the REAL results only:',
        '  1. append bounded workers with dsh_supervisor_worker_create when more work is genuinely needed (append-only inside the same envelope and worker cap);',
        '  2. call dsh_supervisor_project_complete when the whole project objective is met; it only RECORDS the decision, and the host finalizes only after this round and every owned worker prove their stop;',
        '  3. call dsh_supervisor_project_block with a reason when the project cannot proceed;',
        '  4. do neither to request one more bounded round when rounds remain.'
      ]),
    'Never wait or poll for workers in this round: end the round and the host schedules them. Never name a model, callback, thread, token or destination, and never claim a completion the persisted evidence does not show.',
    `Supervisor tools: ${SUPERVISOR_PROJECT_TOOLS.join(', ')}.`
  )
  return lines.join('\n')
}

/* ------------------------------------------------------------------ runtime */

/**
 * Host-owned deterministic orchestrator for one supervisor project. Every transition
 * is driven by the service hooks (`onSupervisorFinished`, `onTaskSettled`,
 * `requestProjectCancel`, `recoverProject`) or by a supervisor tool call; there are no
 * timers and no host listeners, so `close()` cannot leak a handle.
 */
export class SupervisorProjectRuntime {
  #store
  #service = null
  #workspaces = null
  #supervisor = null
  #config
  #now
  #setTimer
  #clearTimer
  #chains = new Map()
  #timers = new Map()
  #deadlineExpiry = new Set()
  #closed = false
  #lastError = null

  constructor({ store, service, workspaces, supervisor, config, now, setTimer, clearTimer } = {}) {
    if (store === undefined || store === null || typeof store.get !== 'function') {
      throw projectError('project/invalid-runtime', 'SupervisorProjectRuntime requires a TaskStore', {})
    }
    this.#store = store
    this.#service = service ?? null
    this.#workspaces = workspaces ?? null
    this.#supervisor = supervisor ?? null
    this.#config = config === undefined ? normalizeProjectConfig(undefined) : (config?.enabled === undefined && config?.maxWorkers === undefined ? normalizeProjectConfig(config) : config)
    this.#now = typeof now === 'function' ? now : () => Date.now()
    // The ONE host timer this runtime owns: the per-project admission deadline. Tests
    // inject a deterministic timer seam; production uses a real unref'd timer.
    this.#setTimer = typeof setTimer === 'function' ? setTimer : (fn, ms) => {
      const timer = setTimeout(fn, ms)
      if (typeof timer.unref === 'function') timer.unref()
      return timer
    }
    this.#clearTimer = typeof clearTimer === 'function' ? clearTimer : (timer) => clearTimeout(timer)
  }

  /** Late-bind the host services after the service itself is constructed. */
  attach({ service, workspaces, supervisor } = {}) {
    if (service !== undefined) this.#service = service
    if (workspaces !== undefined) this.#workspaces = workspaces
    if (supervisor !== undefined) this.#supervisor = supervisor
    return this
  }

  get config() {
    return this.#config
  }

  /**
   * Real-service ADMISSION, invoked exactly once by the owning BridgeService right
   * after the project task is persisted and before it is dispatched. It bounds a silent
   * or capacity-queued planner (the deadline is armed from the persisted
   * `project.createdAt`) and clamps the supervisor's EFFECTIVE packet budget to the
   * project grant WITHOUT touching the immutable original request: `task.packet` and
   * the stored request hash stay identical, only `task.effectivePacket` is narrowed.
   * @param {string} taskId - project task id.
   * @returns {object} bounded admission report.
   */
  admitProject(taskId) {
    let task
    try {
      task = this.#store.get(taskId)
    } catch (error) {
      this.#record(error)
      return { admitted: false, reason: 'unreadable' }
    }
    if (!task?.project) return { admitted: false, reason: 'not-a-project' }
    if (PROJECT_TERMINAL.has(task.project.status)) return { admitted: false, reason: 'terminal' }
    const grant = task.project.grant
    const original = task.packet
    const effective = isPlainObject(task.effectivePacket) ? { ...task.effectivePacket } : { ...original }
    const budget = { ...(isPlainObject(effective.budget) ? effective.budget : original.budget) }
    const rawTimeout = Number.isSafeInteger(budget.timeoutMs) && budget.timeoutMs > 0 ? budget.timeoutMs : grant.timeoutMs
    const rawTools = Number.isSafeInteger(budget.maxToolCalls) && budget.maxToolCalls > 0 ? budget.maxToolCalls : grant.maxTotalToolCalls
    // The supervisor's own model round is bounded by the SAME project grant as its
    // workers; an unclamped effective packet could spend far more than the project was
    // granted. The immutable `task.packet` is never rewritten.
    budget.timeoutMs = Math.max(1, Math.min(rawTimeout, grant.timeoutMs))
    budget.maxToolCalls = Math.max(1, Math.min(rawTools, grant.maxTotalToolCalls))
    task = this.#store.update(taskId, { effectivePacket: { ...effective, budget } })
    this.#armDeadline(taskId)
    this.#store.event(taskId, {
      type: 'project/admitted',
      deadlineMs: grant.timeoutMs,
      effectiveTimeoutMs: budget.timeoutMs,
      effectiveMaxToolCalls: budget.maxToolCalls
    })
    return { admitted: true, taskId, deadlineMs: grant.timeoutMs, timeoutMs: budget.timeoutMs, maxToolCalls: budget.maxToolCalls }
  }

  /** Honest capability report; never claims a live runner or a proven delivery. */
  status() {
    // The report describes the ACTUAL host opt-in: a host that keeps maxRounds at the
    // default 1 advertises the historical plan-once surface only and never claims
    // recurrence, the decision tools or pause.
    const recurrent = (this.#config.maxRounds ?? 1) >= 2
    const toolNames = recurrent ? [...SUPERVISOR_PROJECT_TOOLS] : SUPERVISOR_PROJECT_TOOLS.filter((name) => !SUPERVISOR_RECURRENT_TOOLS.includes(name))
    return {
      supported: this.#service !== null,
      enabled: this.#config.enabled === true,
      tools: toolNames,
      maxWorkers: this.#config.maxWorkers,
      maxConcurrentWorkers: this.#config.maxConcurrentWorkers,
      maxRepairAttempts: this.#config.maxRepairAttempts,
      maxTotalRetries: this.#config.maxTotalRetries,
      maxWorkerStarts: this.#config.maxWorkerStarts,
      maxTotalToolCalls: this.#config.maxTotalToolCalls,
      projectTimeoutMs: this.#config.projectTimeoutMs,
      reserveSlots: this.#config.reserveSlots,
      maxRounds: this.#config.maxRounds,
      firstEdition: {
        singleRound: !recurrent,
        recurrentReasoning: recurrent,
        resumeRunningWorkersAfterRestart: false,
        automaticMerge: false,
        artifactResolution: 'codex-review',
        workerSubstrate: 'bridge-task'
      },
      recurrence: {
        enabled: recurrent,
        maxRounds: this.#config.maxRounds,
        pause: recurrent && this.#config.pause === true,
        tools: recurrent ? [...SUPERVISOR_RECURRENT_TOOLS] : [],
        modelPolling: false,
        resumeRunningWorkersAfterRestart: false
      },
      lastError: this.#lastError
    }
  }

  /** Await every in-flight project transition (tests and shutdown). */
  async whenIdle(taskId) {
    for (let round = 0; round < 20; round += 1) {
      const chains = taskId === undefined ? [...this.#chains.values()] : [this.#chains.get(taskId)].filter(Boolean)
      if (chains.length === 0) {
        await new Promise((resolve) => setImmediate(resolve))
        const stillEmpty = taskId === undefined ? this.#chains.size === 0 : !this.#chains.has(taskId)
        if (stillEmpty) return
        continue
      }
      await Promise.allSettled(chains)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async close() {
    this.#closed = true
    for (const taskId of [...this.#timers.keys()]) this.#clearDeadline(taskId)
    this.#timers.clear()
    this.#deadlineExpiry.clear()
    await this.whenIdle()
  }

  // -- supervisor tools ----------------------------------------------------

  /**
   * Declare one bounded worker in the open plan. Idempotent per `workerKey`.
   * @param {{taskId: string, attemptId?: string, args?: object}} spec - bound caller.
   * @returns {object} bounded worker view.
   */
  workerCreate({ taskId, attemptId, args } = {}) {
    const task = this.#requireProject(taskId)
    this.#requireCurrentAttempt(task, attemptId)
    const project = task.project
    const request = isPlainObject(args) ? args : {}
    const workerKey = nonBlank(request.workerKey) ? request.workerKey.trim() : ''
    // Replay is answered from the FROZEN plan BEFORE the planning guard: an identical
    // re-create reuses the immutable worker even after plan_finalize (the runtime is
    // idempotent for the supervisor's own retries), while a changed re-declaration is a
    // conflict instead of a silent mutation of a frozen definition.
    const existing = project.workers.find((worker) => worker.workerKey === workerKey)
    if (existing !== undefined) {
      const declared = attenuateWorkerRequest(project.grant, request, {
        workerKeys: project.workers.filter((candidate) => candidate.workerKey !== workerKey).map((candidate) => candidate.workerKey),
        projectCwd: task.packet.cwd,
        frozen: false
      })
      if (digest(workerDeclaration(existing)) !== digest(workerDeclaration(declared))) {
        throw projectError('project/replay-conflict', `worker "${workerKey}" is already declared with a different definition and a frozen worker definition is immutable`, { workerKey })
      }
      return { ...this.#workerView(existing), idempotentReplay: true }
    }
    // The project deadline is armed at ADMISSION, before any worker is declared: a
    // silent or hung planner is bounded by the same clock as the workers.
    this.#armDeadline(taskId)
    if (this.#admissionBlocked(project)) {
      throw projectError('project/paused', `the project is ${this.#controlState(project)}: no worker may be added while admission is held`, { control: this.#controlState(project) })
    }
    // Legacy: workers are declarable only while the plan is open. A recurrent project
    // additionally allows APPEND-ONLY declarations between rounds, inside the same
    // immutable envelope and the same hard worker cap.
    if (project.status !== 'planning' && project.frozenAt !== null && project.grant.recurrent !== true) {
      throw projectError('project/plan-frozen', 'the project plan is already frozen or running; workers cannot be added now', { projectStatus: project.status })
    }
    const worker = attenuateWorkerRequest(project.grant, request, {
      workerKeys: project.workers.map((candidate) => candidate.workerKey),
      projectCwd: task.packet.cwd,
      frozen: project.frozenAt !== null,
      recurrent: project.grant.recurrent === true
    })
    const entry = {
      ...worker,
      workerId: worker.workerKey,
      state: 'queued',
      attempts: [],
      cancelRequested: false,
      cancelledBeforeDispatch: false,
      declaredAt: this.#now()
    }
    project.workers.push(entry)
    this.#save(taskId, project, 'project/worker-declared', { workerKey: entry.workerKey, role: entry.role, required: entry.required })
    return { ...this.#workerView(entry), idempotentReplay: false }
  }

  /**
   * Freeze the plan. After this the declared required/optional rule is fixed; the
   * host starts scheduling when the supervisor's model round positively stops.
   * @param {{taskId: string, args?: object}} spec - bound caller.
   * @returns {object} frozen plan view.
   */
  planFinalize({ taskId, attemptId } = {}) {
    const task = this.#requireProject(taskId)
    this.#requireCurrentAttempt(task, attemptId)
    const project = task.project
    this.#armDeadline(taskId)
    // Freezing is NOT admission. An already-declared draft may be finalized even while
    // admission is held (`pausing`/`paused`) or while a bounded planning-continuation round
    // is in flight: freezing closes the plan, it never admits or starts a worker, never
    // resumes the project and never rewrites a held control state. It is allowed only while
    // the plan is genuinely open — `planning`, a held pause, or a dispatching planning
    // continuation — never on a terminal, cancelled, blocked or unknown project, and never
    // twice.
    const freezeable = project.status === 'planning' || project.status === PROJECT_PAUSING || project.status === PROJECT_PAUSED || project.status === 'dispatching'
    if (project.frozenAt === null && project.cancelRequested !== true && !PROJECT_TERMINAL.has(project.status) && freezeable) {
      if (project.workers.length === 0) {
        throw projectError('project/empty-plan', 'a project plan must declare at least one bounded worker before it is frozen', {})
      }
      project.frozenAt = this.#now()
      if (project.status === 'planning') project.status = 'frozen'
      this.#save(taskId, project, 'project/plan-frozen', { workers: project.workers.length })
      return { frozen: true, status: project.status, workerCount: project.workers.length, workers: project.workers.map((worker) => this.#workerView(worker)), idempotentReplay: false }
    }
    return {
      frozen: project.frozenAt !== null,
      status: project.status,
      workerCount: project.workers.length,
      workers: project.workers.map((worker) => this.#workerView(worker)),
      idempotentReplay: true
    }
  }

  /** Bounded worker inventory of the project. */
  workerList({ taskId } = {}) {
    const task = this.#requireProject(taskId)
    const project = task.project
    return {
      projectId: project.projectId,
      status: project.status,
      frozen: project.frozenAt !== null,
      maxWorkers: project.grant.maxWorkers,
      workers: project.workers.map((worker) => this.#workerView(worker))
    }
  }

  /** Bounded result slice of one worker's latest attempt. */
  workerResult({ taskId, args } = {}) {
    const task = this.#requireProject(taskId)
    const project = task.project
    const request = isPlainObject(args) ? args : {}
    const worker = this.#requireWorker(project, request.workerId)
    const offset = Number.isSafeInteger(request.offset) && request.offset >= 0 ? request.offset : 0
    const limit = Number.isSafeInteger(request.limit) && request.limit >= 1 ? Math.min(request.limit, 20000) : 20000
    const attempt = worker.attempts[worker.attempts.length - 1]
    if (attempt === undefined || !nonBlank(attempt.taskId)) {
      return {
        workerId: worker.workerKey,
        state: worker.state,
        attempt: attempt?.attempt ?? 0,
        taskId: null,
        text: '',
        offset,
        nextOffset: 0,
        totalChars: 0,
        hasMore: false,
        evidence: [],
        uncertainties: ['this worker has no dispatched task yet'],
        inspect: attempt?.inspect ?? null
      }
    }
    let settled
    try {
      settled = this.#store.get(attempt.taskId)
    } catch (error) {
      return {
        workerId: worker.workerKey,
        state: 'unknown',
        attempt: attempt.attempt,
        taskId: attempt.taskId,
        text: '',
        offset,
        nextOffset: 0,
        totalChars: 0,
        hasMore: false,
        evidence: [],
        uncertainties: [`worker task ${attempt.taskId} is not readable: ${String((error && error.message) || error)}`],
        inspect: attempt.inspect ?? null
      }
    }
    const text = typeof settled.result?.text === 'string' ? settled.result.text : ''
    return {
      workerId: worker.workerKey,
      state: worker.state,
      attempt: attempt.attempt,
      taskId: attempt.taskId,
      status: settled.status,
      stopConfirmed: settled.stopConfirmed === true,
      text: text.slice(offset, offset + limit),
      offset,
      nextOffset: Math.min(text.length, offset + limit),
      totalChars: text.length,
      hasMore: offset + limit < text.length,
      evidence: Array.isArray(settled.result?.evidence) ? settled.result.evidence : [],
      uncertainties: Array.isArray(settled.result?.uncertainties) ? settled.result.uncertainties : [],
      inspect: attempt.inspect ?? null
    }
  }

  /**
   * Cancel one worker. An explicit controller cancellation is recorded so the
   * orchestrator can never respawn it as an ordinary failure.
   */
  async workerCancel({ taskId, attemptId, args } = {}) {
    const task = this.#requireProject(taskId)
    this.#requireCurrentAttempt(task, attemptId)
    const project = task.project
    const request = isPlainObject(args) ? args : {}
    const worker = this.#requireWorker(project, request.workerId)
    const reason = boundedText(request.reason, 200) || 'supervisor requested cancellation'
    worker.cancelRequested = true
    const attempt = worker.attempts[worker.attempts.length - 1]
    if (attempt === undefined || !nonBlank(attempt.taskId)) {
      worker.cancelledBeforeDispatch = true
      worker.state = 'cancelled'
      this.#save(taskId, project, 'project/worker-cancelled', { workerKey: worker.workerKey, dispatched: false })
      return { workerId: worker.workerKey, cancelRequested: true, dispatched: false, state: 'cancelled' }
    }
    attempt.cancelRequested = true
    this.#save(taskId, project, 'project/worker-cancel-requested', { workerKey: worker.workerKey, attempt: attempt.attempt })
    let outcome = null
    try {
      outcome = await this.#service.cancel(attempt.taskId, `supervisor worker cancel: ${reason}`)
    } catch (error) {
      outcome = { error: { code: (error && error.code) || 'CANCEL_ERROR', message: boundedText(String((error && error.message) || error), 300) } }
    }
    return {
      workerId: worker.workerKey,
      cancelRequested: true,
      dispatched: true,
      taskId: attempt.taskId,
      cancel: safe(outcome)
    }
  }

  /** Bounded project status for the supervisor's own round. */
  projectStatus({ taskId } = {}) {
    const task = this.#requireProject(taskId)
    const project = task.project
    return {
      projectId: project.projectId,
      status: project.status,
      taskStatus: task.status,
      frozen: project.frozenAt !== null,
      round: project.rounds[project.rounds.length - 1] ?? null,
      recurrence: {
        maxRounds: project.grant.maxRounds ?? 1,
        roundsUsed: project.roundsUsed ?? 0,
        pendingRound: isPlainObject(project.pendingRound) ? { index: project.pendingRound.index, attemptId: project.pendingRound.attemptId ?? null, state: project.pendingRound.state ?? null } : null,
        decision: project.decision ?? null,
        pause: project.grant.pause === true ? this.#controlState(project) : 'unsupported'
      },
      workers: project.workers.map((worker) => ({ workerId: worker.workerKey, state: worker.state, required: worker.required !== false, attempts: worker.attempts.length })),
      budgets: safe(project.budgets),
      seriousIssue: project.seriousIssue ?? null,
      aggregate: project.aggregate ?? null,
      callbacks: safe(project.callbacks ?? {})
    }
  }

  /**
   * Record (never finalize) the project's complete decision for this round. The host
   * finalizes only after THIS model round and every genuinely owned attempt prove their
   * stop, the aggregate is completed, no required worker is unfinished, and the
   * cumulative budgets hold; recording a decision can therefore never mask an unknown
   * or live worker. Idempotent for the same decision.
   */
  projectComplete({ taskId, attemptId, args } = {}) {
    const task = this.#requireProject(taskId)
    this.#requireCurrentAttempt(task, attemptId)
    const project = task.project
    if (project.grant.recurrent !== true) {
      throw projectError('project/not-recurrent', 'dsh_supervisor_project_complete is only granted to a recurrent project (packet.project.maxRounds >= 2)', {})
    }
    if (this.#admissionBlocked(project)) throw projectError('project/paused', `the project is ${this.#controlState(project)}; resume it before recording a decision`, {})
    if (project.frozenAt === null) throw projectError('project/plan-not-frozen', 'freeze the plan with dsh_supervisor_plan_finalize before recording a project decision', {})
    const request = isPlainObject(args) ? args : {}
    const summary = boundedText(request.summary, MAX_PROJECT_SUMMARY_CHARS) || null
    const existing = project.decision
    if (existing?.kind === 'complete') return { ...existing, idempotentReplay: true }
    if (existing?.kind === 'block') throw projectError('project/decision-conflict', 'this project already recorded a blocked decision', { decision: existing })
    project.decision = { kind: 'complete', summary, round: (project.roundsUsed ?? 0) + 1, at: this.#now() }
    this.#save(taskId, project, 'project/decision-recorded', { kind: 'complete' })
    return { recorded: true, ...project.decision, finalized: false, note: 'the host finalizes only after this round and every owned attempt prove their stop' }
  }

  /**
   * Record the project's blocked decision for this round. The runtime settles it
   * honestly (capacity-retaining `blocked`) once the round and owned work are proven
   * stopped; it never fabricates a failure or a completion.
   */
  projectBlock({ taskId, attemptId, args } = {}) {
    const task = this.#requireProject(taskId)
    this.#requireCurrentAttempt(task, attemptId)
    const project = task.project
    if (project.grant.recurrent !== true) {
      throw projectError('project/not-recurrent', 'dsh_supervisor_project_block is only granted to a recurrent project (packet.project.maxRounds >= 2)', {})
    }
    if (this.#admissionBlocked(project)) throw projectError('project/paused', `the project is ${this.#controlState(project)}; resume it before recording a decision`, {})
    const request = isPlainObject(args) ? args : {}
    if (!nonBlank(request.reason)) throw projectError('project/invalid-request', 'reason must be a nonblank string', { field: 'reason' })
    const reason = boundedText(request.reason, MAX_PROJECT_SUMMARY_CHARS)
    const existing = project.decision
    if (existing?.kind === 'block' && existing.reason === reason) return { ...existing, idempotentReplay: true }
    if (existing?.kind === 'complete') throw projectError('project/decision-conflict', 'this project already recorded a complete decision', { decision: existing })
    project.decision = { kind: 'block', reason, round: (project.roundsUsed ?? 0) + 1, at: this.#now() }
    this.#save(taskId, project, 'project/decision-recorded', { kind: 'block' })
    return { recorded: true, ...project.decision, finalized: false, note: 'the host settles this only after this round and every owned attempt prove their stop' }
  }

  // -- durable pause/resume checkpoint -------------------------------------

  /**
   * Persist a pause request SYNCHRONOUSLY and hold all new admission (no worker attempt,
   * no supervisor round). Owned work is allowed to finish naturally; the project becomes
   * `paused` only once the current round and EVERY owned attempt prove a positive stop
   * with no dispatch pending. Idempotent by `requestId`; it is never a cancellation.
   */
  pauseRequest({ taskId, requestId, reason } = {}) {
    const task = this.#requireProject(taskId)
    const project = task.project
    if (project.grant.pause !== true) {
      throw projectError('project/pause-unsupported', 'this project did not opt into pause/resume: host supervisorProjects.pause and packet.project.maxRounds >= 2 are both required', {})
    }
    const control = isPlainObject(project.control) ? project.control : {}
    const existing = isPlainObject(control.pause) ? control.pause : null
    const requestKey = nonBlank(requestId) ? requestId.trim() : null
    const history = Array.isArray(control.pauseHistory) ? [...control.pauseHistory] : []
    // Preserve the newest legacy receipt before another control cycle replaces it.
    if (nonBlank(existing?.requestId) && !history.some(item => item?.requestId === existing.requestId)) history.push({ ...existing })
    const recorded = requestKey === null ? null : (existing?.requestId === requestKey ? existing : history.find(item => item?.requestId === requestKey))
    if (recorded) {
      return { accepted: true, replay: true, state: recorded.state, paused: recorded.state === PROJECT_PAUSED, taskId }
    }
    if (requestKey !== null && history.length >= PAUSE_REQUEST_HISTORY_LIMIT) return { accepted: false, replay: false, code: 'project/request-history-full', status: task.status, taskId }
    if (PROJECT_TERMINAL.has(project.status)) return { accepted: false, state: 'terminal', status: project.status, reason: 'the project already settled' }
    if (existing !== null && (existing.state === PROJECT_PAUSING || existing.state === PROJECT_PAUSED)) {
      if (requestKey !== null) {
        history.push({ ...existing, requestId: requestKey })
        project.control = { ...control, pauseHistory: history }
        this.#save(taskId, project, 'project/pause-replayed', { requestId: requestKey })
      }
      return { accepted: true, replay: true, alreadyRequested: true, state: existing.state, paused: existing.state === PROJECT_PAUSED, taskId }
    }
    const pause = { requestId: requestKey, state: PROJECT_PAUSING, requestedAt: this.#now(), reason: boundedText(reason, 200) || null, pausedAt: null, resumedAt: null }
    if (requestKey !== null) history.push({ ...pause })
    project.control = {
      ...control,
      pause,
      pauseHistory: history,
      resuming: null
    }
    // The persisted PHASE reflects the control state as honestly as the task status.
    project.status = PROJECT_PAUSING
    this.#save(taskId, project, 'project/pause-requested', { requestId: project.control.pause.requestId })
    // The task leaves any terminal-adjacent phase for the honest non-terminal pausing
    // state; it is never reported as paused before the proof holds.
    this.#store.update(taskId, { status: PROJECT_PAUSING, phase: 'project', endedAt: null })
    this.#settlePause(taskId)
    const settled = this.#store.get(taskId)
    return { accepted: true, replay: false, state: this.#controlState(settled.project), paused: this.#controlState(settled.project) === PROJECT_PAUSED, taskId }
  }

  /**
   * Resume a paused checkpoint after re-reading the real stop, ownership and dispatch
   * evidence. Unknown, mismatched or missing proof, an elapsed immutable deadline, or an
   * exhausted cumulative budget is refused with a typed code and the checkpoint is
   * retained. The SAME project record continues: no task copy, no budget reset and no
   * deadline extension. Idempotent by `requestId`.
   */
  resumeRequest({ taskId, requestId, reason } = {}) {
    const task = this.#requireProject(taskId)
    const project = task.project
    if (project.grant.pause !== true) {
      throw projectError('project/pause-unsupported', 'this project did not opt into pause/resume: host supervisorProjects.pause and packet.project.maxRounds >= 2 are both required', {})
    }
    const control = isPlainObject(project.control) ? project.control : {}
    // A matching resume requestId ALWAYS replays its ORIGINAL outcome, whatever the
    // project has since done. `requestId` binds the task and the operation, and `reason`
    // is first-request audit text only: a later same-id retry with an omitted or
    // different reason returns the same outcome with `replay: true` and makes NO new
    // transition. This lookup must precede the terminal and pause-state gates because a
    // successful resume clears the pause state and the project may then complete, so
    // either gate would otherwise hide the recorded replay (or throw project/not-paused).
    const prior = isPlainObject(control.resume) ? control.resume : null
    const history = Array.isArray(control.resumeHistory) ? control.resumeHistory : []
    const known = nonBlank(requestId)
    const requestKey = known ? requestId.trim() : null
    // The newest legacy field is authoritative for its own id (a later async local refusal
    // rewrites it in place); the bounded history covers every other recorded id, so an
    // older accepted OR refused requestId can never be replayed as a new command.
    const recorded = requestKey === null
      ? null
      : (prior !== null && prior.requestId === requestKey ? prior : (history.find((item) => item?.requestId === requestKey) ?? null))
    if (recorded !== null) {
      return { accepted: recorded.outcome === 'resumed', replay: true, resumed: recorded.outcome === 'resumed', outcome: recorded.outcome, code: recorded.code ?? null, status: this.#store.get(taskId).status }
    }
    // A NEW request id at the bounded history capacity is typed-refused BEFORE any
    // mutation or admission: known ids still replay above, an unknown one is never read
    // as a fresh command.
    if (known && history.length >= RESUME_REQUEST_HISTORY_LIMIT) {
      return { accepted: false, resumed: false, replay: false, code: 'project/request-history-full', status: this.#store.get(taskId).status }
    }
    if (PROJECT_TERMINAL.has(project.status)) return { accepted: false, resumed: false, reason: 'terminal', status: project.status }
    const pause = isPlainObject(control.pause) ? control.pause : null
    if (pause === null || (pause.state !== PROJECT_PAUSING && pause.state !== PROJECT_PAUSED)) {
      throw projectError('project/not-paused', 'the project has no pause checkpoint to resume', { state: pause?.state ?? 'none' })
    }
    this.#settlePause(taskId)
    const fresh = this.#store.get(taskId)
    const freshProject = fresh.project
    const resumeRecord = (outcome, code) => {
      this.#recordResumeRequest(freshProject, { requestId, outcome, code, reason, roundIndex: freshProject.roundsUsed ?? 0 })
      this.#save(taskId, freshProject, outcome === 'resumed' ? 'project/resumed' : 'project/resume-refused', { code: code ?? null })
      return this.#store.get(taskId)
    }
    // The immutable project deadline keeps running through the pause: an elapsed
    // deadline is never extended, and the armed timer converges the expiry honestly.
    if (this.#deadlineElapsed(freshProject)) {
      resumeRecord('refused', 'project/deadline-exceeded')
      this.#kick(taskId)
      return { accepted: false, resumed: false, code: 'project/deadline-exceeded', status: this.#store.get(taskId).status }
    }
    // A cancellation request is NOT a resume: a project the controller has already asked
    // to cancel never reopens admission from a pause checkpoint. The checkpoint and its
    // typed refusal are retained, and the durable cancel path still converges on real
    // stop proofs through the serialized evaluation.
    if (freshProject.cancelRequested === true) {
      resumeRecord('refused', 'project/cancel-requested')
      this.#kick(taskId)
      return { accepted: false, resumed: false, code: 'project/cancel-requested', status: this.#store.get(taskId).status }
    }
    // Real ownership/stop evidence on the fresh record BEFORE any admission. A stopped
    // root never certifies its workers: both the round and every owned attempt must hold
    // a positive true/0/0 proof and no dispatch may be pending.
    if (!this.#pauseProven(fresh, freshProject)) {
      const live = this.#cleanStopProof(fresh, freshProject).live.length
      // The refusal is DURABLE: it is recorded before returning, so an identical retry
      // after the proof finally arrives replays this exact refusal instead of starting
      // work. A NEW requestId may then explicitly resume.
      resumeRecord('refused', 'project/resume-unproven')
      return { accepted: false, resumed: false, code: 'project/resume-unproven', status: this.#store.get(taskId).status, live }
    }
    const roundsUsed = freshProject.roundsUsed ?? 0
    const canRound = freshProject.grant.recurrent === true && roundsUsed < freshProject.grant.maxRounds && this.#remainingToolAllowance(freshProject) > 0
    const canComplete = freshProject.decision?.kind === 'complete' && this.#requiredAllSucceeded(freshProject)
    const canBlock = freshProject.decision?.kind === 'block'
    if (!canRound && !canComplete && !canBlock) {
      const code = this.#remainingToolAllowance(freshProject) <= 0 ? 'project/budget-exhausted' : 'project/rounds-exhausted'
      resumeRecord('refused', code)
      return { accepted: false, resumed: false, code, status: this.#store.get(taskId).status }
    }
    freshProject.control = {
      ...(isPlainObject(freshProject.control) ? freshProject.control : {}),
      pause: { ...freshProject.control.pause, state: 'none', resumedAt: this.#now() },
      // The resumed round must be able to retain the checkpoint if it is refused
      // locally by the adapter (no prompt crossed the boundary).
      resuming: { requestId: nonBlank(requestId) ? requestId.trim() : null, at: this.#now(), roundIndex: roundsUsed + 1 }
    }
    this.#recordResumeRequest(freshProject, { requestId, outcome: 'resumed', code: null, reason, roundIndex: roundsUsed })
    freshProject.seriousIssue = null
    // A project whose FIRST dispatch never crossed the host boundary is continued by
    // re-queuing the SAME task (the real drain starts round 1); an already-dispatched
    // project returns to its waiting boundary and the runtime decides the next step.
    const neverDispatched = fresh.dispatchStarted !== true && fresh.dispatchPending !== true && !nonBlank(fresh.sessionId) && !Number.isFinite(fresh.dispatchReceiptAt)
    freshProject.status = neverDispatched ? (freshProject.frozenAt === null ? 'planning' : 'frozen') : 'dispatching'
    this.#save(taskId, freshProject, 'project/resumed', { requestId: nonBlank(requestId) ? requestId.trim() : null, roundIndex: roundsUsed })
    this.#store.update(taskId, { status: neverDispatched ? 'queued' : PROJECT_WAITING, phase: 'project', endedAt: null, error: null })
    // A real timer is re-armed on the SAME immutable anchor; nothing is extended.
    this.#armDeadline(taskId)
    if (neverDispatched && this.#service !== null && typeof this.#service.kick === 'function') this.#service.kick()
    this.#kick(taskId)
    return { accepted: true, resumed: true, state: neverDispatched ? 'queued' : 'running', roundIndex: roundsUsed, status: neverDispatched ? 'queued' : PROJECT_WAITING }
  }

  // -- service hooks -------------------------------------------------------

  /**
   * A supervisor model round finished. The session stop is recorded, the model
   * reservation is released, and the project either waits as `supervising` or fails
   * closed. The task status is NEVER mapped straight to `completed` here: only
   * verified stopped owned work may complete a project.
   */
  async onSupervisorFinished(id, result = {}, attemptId) {
    try {
      const task = this.#store.get(id)
      if (!task.project) return
      const project = task.project
      if (PROJECT_TERMINAL.has(project.status)) return
      // A delayed callback from a SUPERSEDED round never mutates the current attempt.
      if (nonBlank(attemptId) && task.attemptId !== attemptId) {
        this.#save(id, project, 'project/round-callback-stale', { attemptId: attemptId ?? null, currentAttemptId: task.attemptId })
        return
      }
      const resolvedChildren = this.#resolveRoundChildren(id, result)
      const pending = isPlainObject(project.pendingRound) ? project.pendingRound : null
      const resuming = isPlainObject(project.control?.resuming) ? project.control.resuming : null
      const errorCode = result?.error?.code
      // A locally refused resumed round proves nothing crossed the host boundary: keep the
      // checkpoint instead of failing a project whose ownership could not be re-proven.
      const resumeRefused = pending !== null && resuming !== null && nonBlank(errorCode) && LOCAL_ROUND_REFUSALS.has(errorCode)
      const stats = Number.isInteger(task.stats?.toolCalls) ? task.stats.toolCalls : null
      const baseline = pending !== null ? (Number.isInteger(pending.baselineToolCalls) ? pending.baselineToolCalls : 0) : 0
      const granted = pending !== null && Number.isInteger(pending.grantedToolCalls) ? pending.grantedToolCalls : null
      const round = {
        index: (project.roundsUsed ?? 0) + 1,
        attemptId: attemptId ?? task.attemptId ?? null,
        dispatchKey: pending?.dispatchKey ?? null,
        kind: pending === null ? 'plan' : 'review',
        status: typeof result.status === 'string' ? result.status : 'unknown',
        stopConfirmed: result.stopConfirmed === true,
        activeJobs: Number.isInteger(result.activeJobs) ? result.activeJobs : null,
        activeChildren: resolvedChildren.activeChildren,
        activeChildrenSource: resolvedChildren.activeChildrenSource,
        text: boundedText(result.finalText !== undefined ? result.finalText : result.text, 4000),
        at: this.#now(),
        baselineToolCalls: baseline,
        grantedToolCalls: granted,
        actualToolCalls: null,
        charged: false
      }
      const stoppedClean = this.#roundStopped(round)
      if (stoppedClean && !resumeRefused) {
        // Charge the round's OWN spend exactly once, only with its own stop proof.
        const charge = this.#chargeRound(project, { pending, stats, baseline, granted })
        round.actualToolCalls = charge.actual
        round.charged = true
        project.roundsUsed = round.index
        project.pendingRound = null
        project.roundBaselineToolCalls = null
      }
      project.rounds = [...project.rounds, round].slice(-8)
      if (resumeRefused) {
        await this.#retainPausedCheckpoint(id, project, { pending, resuming, code: errorCode, message: boundedText(String(result?.error?.message ?? ''), 300) })
        return
      }
      if (task.status === 'cancelling' || round.status === 'cancelled') {
        this.#save(id, project, 'project/round-cancelled', {})
        await this.requestProjectCancel(id, 'supervisor round cancelled')
        return
      }
      if (!stoppedClean) {
        await this.#block(id, project, { code: 'supervisor-round-unstopped', message: `the supervisor round settled ${round.status} with stopConfirmed=${round.stopConfirmed} and activeJobs=${round.activeJobs}` })
        return
      }
      if (round.status !== 'completed') {
        // The round stopped positively but did not complete: the model reservation is
        // released, and the project is a clean stopped failure with no owned worker work.
        this.#releaseModelReservation(id)
        await this.#failCleanly(id, project, { code: 'supervisor-round-failed', message: `the supervisor round settled ${round.status} with a confirmed stop` })
        return
      }
      if (project.frozenAt === null) {
        const heldState = this.#controlState(project)
        // A pause checkpoint outranks the plain `plan-not-frozen` failure: when control
        // already holds admission and the model round POSITIVELY stopped with zero owned
        // work, the honest transition is a retained paused PLANNING checkpoint, never a
        // fabricated unknown/blocked project. The shared tail below records the round,
        // persists the real true/0/0 proof and settles `pausing` -> `paused`.
        if (heldState !== PROJECT_PAUSING && heldState !== PROJECT_PAUSED) {
          this.#releaseModelReservation(id)
          await this.#block(id, project, { code: 'plan-not-frozen', message: 'the supervisor round ended without dsh_supervisor_plan_finalize; no worker is dispatched' })
          return
        }
        project.seriousIssue = null
      } else if (project.status === 'planning') {
        project.status = 'frozen'
      }
      this.#releaseModelReservation(id)
      if (project.control && isPlainObject(project.control.resuming)) project.control = { ...project.control, resuming: null }
      if (project.startedAt === null) project.startedAt = this.#now()
      project.waitedAt = this.#now()
      // Only the LEGACY (single planning round) path keeps the historical observed
      // `supervisorToolCalls` baseline and its own over-budget gate: recurrent rounds are
      // charged above against their persisted reservation, and their cumulative overspend
      // is decided by `#evaluate`'s central `#toolBound` check.
      const supervisorCalls = Number.isInteger(task.stats?.toolCalls) ? task.stats.toolCalls : null
      const roundLimit = project.grant.maxTotalToolCalls
      if (pending === null) {
        if (supervisorCalls !== null && supervisorCalls > roundLimit) {
          project.budgets = { ...project.budgets, supervisorToolCalls: supervisorCalls }
          this.#save(id, project, 'project/round-over-budget', { supervisorToolCalls: supervisorCalls, maxTotalToolCalls: roundLimit })
          await this.#failCleanly(id, project, { code: 'supervisor-tool-budget-exceeded', message: `the supervisor round consumed ${supervisorCalls} of the ${roundLimit} granted tool calls` })
          return
        }
        project.budgets = { ...project.budgets, supervisorToolCalls: supervisorCalls }
      }
      this.#save(id, project, 'project/round-ended', { status: project.status, supervisorToolCalls: supervisorCalls, round: round.index, actualToolCalls: round.actualToolCalls })
      // A pause request holds the project in its own distinct state: the task status is
      // never reported as a fresh `supervising` round boundary while admission is held.
      const heldState = this.#controlState(project)
      this.#store.update(id, {
        status: heldState === 'none' ? PROJECT_WAITING : heldState,
        phase: 'project',
        stopConfirmed: true,
        activeJobs: 0,
        activeChildren: 0,
        result: { text: round.text, evidence: [{ source: 'dsh-host', kind: 'supervisor-round', attemptId: round.attemptId, status: round.status, stopConfirmed: true }], checks: [], uncertainties: [] }
      })
      this.#settlePause(id)
      this.#kick(id)
    } catch (error) {
      this.#record(error)
    }
  }

  /**
   * Restore the durable pause checkpoint after a resumed round was refused LOCALLY by
   * the adapter (no prompt crossed the boundary). The reservation and the checkpoint are
   * retained, the task stays a non-terminal `paused` record, and nothing is replayed.
   */
  async #retainPausedCheckpoint(id, project, { pending, resuming, code, message }) {
    const granted = Number.isInteger(pending?.grantedToolCalls) ? pending.grantedToolCalls : 0
    project.pendingRound = null
    project.roundBaselineToolCalls = null
    project.budgets = {
      ...project.budgets,
      supervisorReserved: Math.max(0, (Number.isInteger(project.budgets?.supervisorReserved) ? project.budgets.supervisorReserved : 0) - granted)
    }
    project.control = {
      ...(isPlainObject(project.control) ? project.control : {}),
      pause: { ...(isPlainObject(project.control?.pause) ? project.control.pause : {}), state: PROJECT_PAUSED, pausedAt: project.control?.pause?.pausedAt ?? this.#now() },
      resuming: null
    }
    // The refused resume updates THAT request's own durable receipt (both the legacy
    // newest field and its history entry), so a later replay returns the real refusal.
    this.#recordResumeRequest(project, { requestId: resuming.requestId ?? null, outcome: 'refused', code: code ?? 'adapter/round-refused', roundIndex: project.roundsUsed ?? 0 })
    project.seriousIssue = { code: 'project/resume-refused', message: `the resumed round was refused locally (${code}): ${message || 'no further detail'}`, at: this.#now() }
    this.#save(id, project, 'project/resume-refused', { code: code ?? 'adapter/round-refused' })
    this.#store.update(id, { status: PROJECT_PAUSED, phase: 'project', stopConfirmed: true, activeJobs: 0, activeChildren: 0, error: { code: code ?? 'adapter/round-refused', message: boundedText(String(message ?? ''), 300) } })
    const current = this.#store.get(id)
    const aggregate = isPlainObject(current.project.aggregate) ? current.project.aggregate : {}
    const summary = aggregateSummary(
      current.project,
      { requiredFailed: [], unknown: [], optionalDegraded: [], cancelled: [], retryable: [], reasons: [], ...aggregate },
      [`resume refused: ${code}`]
    )
    await this.#notify(id, 'serious-issue', 'failed', summary)
  }

  /**
   * One bridge task settled. Worker tasks feed the project; anything else is ignored.
   * Never throws into the service settlement path.
   */
  async onTaskSettled(task) {
    try {
      if (!isPlainObject(task) || task.project) return
      const parentId = task.packet?.parentTaskId
      if (!nonBlank(parentId)) return
      let parent
      try {
        parent = this.#store.get(parentId)
      } catch {
        return
      }
      if (!parent?.project) return
      const project = parent.project
      let worker = null
      let attempt = null
      const packetKey = nonBlank(task.packet?.idempotencyKey) ? task.packet.idempotencyKey : null
      for (const candidate of project.workers) {
        // Identity is the real task id OR the deterministic attempt key the runtime
        // wrote before dispatch. The key match closes the settle-during-submit race and
        // survives a restart where the persisted taskId never made it to disk.
        const found = candidate.attempts.find((entry) => entry.taskId === task.id || (packetKey !== null && entry.idempotencyKey === packetKey))
        if (found !== undefined) {
          worker = candidate
          attempt = found
          break
        }
      }
      if (worker === null || attempt === null) return
      if (!nonBlank(attempt.taskId)) attempt.taskId = task.id
      const { stopped } = this.#applyAttemptState(attempt, worker, task)
      // An explicit controller cancellation is never an ordinary failure, whatever path
      // requested it (the supervisor tool or `bridge_cancel` on the worker task itself).
      if (attempt.state === 'cancelled' && isPlainObject(task.cancellationRequested)) attempt.cancelRequested = true
      attempt.resultChars = typeof task.result?.text === 'string' ? task.result.text.length : 0
      attempt.resultDigest = digest({ status: task.status, stopConfirmed: task.stopConfirmed === true, text: boundedText(task.result?.text, 4000) })
      // A bounded snapshot of the REAL result of the ACTUAL owned worker task, captured at
      // settlement so the next bounded round can see what the completed wave produced. The
      // full text is never copied into the project record; `worker_result` remains the
      // authoritative full-result API.
      attempt.resultExcerpt = boundedText(task.result?.text, WORKER_RESULT_EXCERPT_CHARS) || null
      let inspect = null
      if (stopped) {
        // Artifact evidence must come from the REAL owned workspace of this attempt:
        // the base HEAD alone is not the changes commit, and a dirty tree must be
        // reported with its paths instead of being read as "no changes".
        if (task.workspace !== undefined && task.workspace !== null) inspect = await this.#inspectWorkspace(task.workspace)
        else if (worker.workspace !== null) inspect = { outcome: 'missing-workspace', reason: 'the writer task settled without a bridge-owned workspace record' }
      }
      // The WHOLE settlement is merged onto the freshest persisted snapshot by immutable
      // attempt identity, so a slow workspace inspection can never erase a concurrent
      // settlement's state or its dirty-workspace proof.
      const key = attempt.idempotencyKey
      this.#mutate(parentId, (fresh) => {
        const targetWorker = fresh.project.workers.find((candidate) => candidate.workerKey === worker.workerKey)
        const target = targetWorker?.attempts.find((entry) => entry.idempotencyKey === key)
        if (target === undefined) return fresh
        // Link the REAL identity as well as the state: an early settlement must persist
        // taskId/sessionId so a later receipt merge, aggregation, cancellation or
        // recovery can always resolve the owned task.
        if (!nonBlank(target.taskId) && nonBlank(attempt.taskId)) target.taskId = attempt.taskId
        if (!nonBlank(target.sessionId) && nonBlank(attempt.sessionId)) target.sessionId = attempt.sessionId
        if (target.dispatchedAt === undefined && attempt.dispatchedAt !== undefined) target.dispatchedAt = attempt.dispatchedAt
        target.state = attempt.state
        target.stopConfirmed = attempt.stopConfirmed === true
        target.activeJobs = attempt.activeJobs
        if (attempt.activeChildren !== undefined) target.activeChildren = attempt.activeChildren
        if (attempt.activeChildrenSource !== undefined) target.activeChildrenSource = attempt.activeChildrenSource
        target.cancelRequested = attempt.cancelRequested === true
        target.resultChars = attempt.resultChars
        target.resultDigest = attempt.resultDigest
        if (attempt.resultExcerpt !== undefined) target.resultExcerpt = attempt.resultExcerpt
        if (attempt.settledAt !== undefined) target.settledAt = attempt.settledAt
        if (attempt.ambiguity !== undefined) target.ambiguity = attempt.ambiguity
        if (inspect !== null) target.inspect = inspect
        targetWorker.state = attempt.state
        return fresh
      }, 'project/attempt-settled', { workerKey: worker.workerKey, attempt: attempt.attempt, state: attempt.state, stopConfirmed: stopped })
      // Release the reserved allowance only with this attempt's verified stop proof.
      if (stopped) this.#releaseToolAllowance(parentId, worker.workerKey, attempt.attempt, true)
      // A settled worker is exactly the evidence that can complete a pause proof: a
      // `pausing` project becomes `paused` here only with that proof, never earlier.
      this.#settlePause(parentId)
      // Enqueue the next transition; NEVER await it here. A real (or stub) host may fire
      // this settle callback INLINE from inside the very transition chain that is
      // cancelling this worker, and awaiting that chain would deadlock on itself.
      this.#kick(parentId)
    } catch (error) {
      this.#record(error)
    }
  }

  /**
   * Controller cancellation of the project (or of its supervisor round). Every live
   * worker is cancelled; the project reaches `cancelled` only when every owned stop is
   * proven, otherwise it is honestly `unknown`/blocked with capacity retained.
   * A controller-requested cancellation does NOT generate a wake callback.
   */
  async requestProjectCancel(id, reason) {
    try {
      const task = this.#store.get(id)
      if (!task.project) return { accepted: false, reason: 'not-a-project' }
      const project = task.project
      if (PROJECT_TERMINAL.has(project.status)) return { accepted: false, alreadyFinished: true }
      project.cancelRequested = true
      project.cancelReason = boundedText(reason, 200) || 'controller requested'
      this.#save(id, project, 'project/cancel-requested', { reason: project.cancelReason })
      const cancelled = []
      for (const item of this.#unstopped(task)) {
        if (!nonBlank(item.taskId)) continue
        try {
          await this.#service.cancel(item.taskId, `supervisor project cancel: ${project.cancelReason}`)
        } catch (error) {
          cancelled.push({ taskId: item.taskId, error: (error && error.code) || 'CANCEL_ERROR' })
          continue
        }
        cancelled.push({ taskId: item.taskId })
      }
      const after = this.#store.get(id)
      // The SAME central positive-root-and-workers proof as failure/completion decides a
      // terminal cancellation: the supervisor round's verified stop FIRST, then every
      // owned attempt. A cancellation request is never a stop, and a missing child count
      // is never inferred as zero.
      const proof = this.#cleanStopProof(after, after.project)
      const remaining = proof.live
      if (proof.round.stopped !== true) {
        await this.#block(id, after.project, { code: 'supervisor-round-cancel-unconfirmed', message: 'the supervisor round has no verified stop proof; the model reservation is retained' })
        return { accepted: true, confirmed: false, roundStopped: false, cancelled }
      }
      if (remaining.length > 0) {
        // Cancellation with work that has no verified stop is NEVER certified as a clean
        // terminal: the task stays unknown, the project blocked, capacity is retained and
        // the task remains cancel/reconcile capable. A cancel request is not a stop.
        await this.#block(id, after.project, { code: 'project-cancel-unconfirmed', message: `cancellation left ${remaining.length} owned worker task(s) without a verified stop` })
        return { accepted: true, confirmed: false, remaining: remaining.length, cancelled }
      }
      const current = this.#store.get(id)
      current.project.status = 'cancelled'
      current.project.cancelRequested = true
      current.project.endedAt = this.#now()
      current.project.aggregate = { status: 'cancelled', at: current.project.endedAt }
      // The supervisor round is positively stopped in every path that reaches a clean
      // cancellation, so its own model slot is released (a no-op if already released).
      this.#releaseModelReservation(id)
      this.#clearDeadline(id)
      this.#save(id, current.project, 'project/cancelled', { reason: current.project.cancelReason })
      this.#store.update(id, {
        status: 'cancelled',
        phase: 'project',
        stopConfirmed: true,
        activeJobs: 0,
        activeChildren: 0,
        endedAt: this.#now(),
        result: { text: `project cancelled by the controller: ${current.project.cancelReason}`, evidence: [], checks: [], uncertainties: [] }
      })
      return { accepted: true, confirmed: true, cancelled }
    } catch (error) {
      this.#record(error)
      return { accepted: false, reason: (error && error.code) || 'PROJECT_CANCEL_ERROR' }
    }
  }

  /**
   * Host restart reconciliation. Fail closed: an unverified round or an ambiguous
   * dispatch is blocked without replay; a verified `supervising` project with fully
   * persisted worker state resumes its deterministic scheduling from the store.
   */
  async recoverProject(task) {
    try {
      const project = task?.project
      if (!project) return { resumed: false, reason: 'not-a-project' }
      // The recovered root's occupancy is settled from genuine proof BEFORE any resume/block
      // decision and before anything could be dispatched: a missing or unproven round keeps
      // exactly one adopted slot (idempotent, over-limit allowed), a strictly proven-stopped
      // round holds none. This runs on the same shared ledger the live service admits from.
      const proof = this.#recoveryProof(task, project)
      // Binding-classify the project's OWNED attempts ONCE: the same classification settles
      // the root occupancy and is the fail-closed input the shared clean-stop proof consumes.
      // A store-readable task id alone is never ownership: the persisted worker packet must
      // genuinely bind it to THIS project and to this worker/attempt.
      const owned = this.#recoveryOwnedWork(task)
      const rootReservation = this.#settleRecoveredRoot(task, proof, owned)
      if (PROJECT_TERMINAL.has(project.status)) return { resumed: false, reason: 'terminal', rootReservation }
      // A persisted round whose dispatch is NOT provably stopped is an ambiguous dispatch:
      // it is never replayed, its reservation is retained and the project fails closed.
      const pending = isPlainObject(project.pendingRound) ? project.pendingRound : null
      if (pending !== null && nonBlank(pending.attemptId)) {
        await this.#block(task.id, project, {
          code: 'host-restart-round-ambiguous',
          message: `the host restarted with supervisor round ${pending.index ?? '?'} dispatched but not provably stopped; nothing is replayed and its reservation is retained`
        })
        return { resumed: false, reason: 'host-restart-round-ambiguous', round: pending.index ?? null, rootReservation }
      }
      // A round that was planned but never minted never crossed the host boundary: the
      // reservation is released honestly instead of holding capacity forever.
      if (pending !== null && !nonBlank(pending.attemptId)) {
        const granted = Number.isInteger(pending.grantedToolCalls) ? pending.grantedToolCalls : 0
        const fresh = this.#store.get(task.id)
        fresh.project.pendingRound = null
        fresh.project.roundBaselineToolCalls = null
        fresh.project.budgets = {
          ...fresh.project.budgets,
          supervisorReserved: Math.max(0, (Number.isInteger(fresh.project.budgets?.supervisorReserved) ? fresh.project.budgets.supervisorReserved : 0) - granted)
        }
        this.#save(task.id, fresh.project, 'project/round-plan-abandoned', { round: pending.index ?? null, reason: 'host-restart-planned-only' })
      }
      // A durable pause checkpoint is NEVER auto-resumed at startup. It stays in its own
      // distinct state (pausing/paused) with its reservation settled from real proofs; an
      // explicit bridge_resume is the only path that may continue it, and it re-proves
      // ownership, stop and budget on the fresh record before any admission.
      if (this.#admissionBlocked(this.#store.get(task.id).project)) {
        this.#settlePause(task.id)
        // The deadline keeps counting through the pause: re-arm a REAL timer on the
        // immutable anchor so an expiry still converges without a resume.
        this.#armDeadline(task.id)
        return { resumed: false, reason: 'paused-checkpoint', state: this.#controlState(this.#store.get(task.id).project), rootReservation }
      }
      // Fail closed: a project that is not a verified waiting project, carries an untracked
      // ambiguous dispatch, carries unreadable or misbound owned work, or has NO strictly
      // proven stopped supervisor round is blocked with its occupancy retained. Nothing is
      // redispatched, and neither a worker nor a supervisor round starts under that
      // ambiguity — even when a historical status says supervising.
      if (task.status !== PROJECT_WAITING || owned.unaccounted.length > 0 || proof.round.stopped !== true) {
        await this.#block(task.id, project, {
          code: 'host-restart',
          message: `the host restarted without a proven stopped supervisor round (task ${task.status}, unaccountedOwned=${owned.unaccounted.length}, round=${proof.round.reason}); no work is redispatched and owned capacity is retained`
        })
        return { resumed: false, reason: 'host-restart-fail-closed', ambiguous: owned.unaccounted.length, round: proof.round.reason, rootReservation }
      }
      // Re-arm the admission deadline with a REAL timer owned by THIS process: a
      // persisted `deadlines.armed` flag from the crashed process is not live ownership.
      this.#armDeadline(task.id)
      await this.#kick(task.id)
      return { resumed: true, rootReservation }
    } catch (error) {
      this.#record(error)
      return { resumed: false, reason: (error && error.code) || 'PROJECT_RECOVER_ERROR' }
    }
  }

  /**
   * The central clean-stop proof, made total for RECOVERY: a malformed persisted project
   * (missing worker/attempt arrays) must not throw the root settlement away. An unreadable
   * proof is the honest UNPROVEN value, so the caller adopts the root and blocks.
   * @param {object} task - persisted project task record.
   * @param {object} project - its project record.
   * @returns {{round: object, live: Array, clean: boolean}}
   */
  #recoveryProof(task, project) {
    try {
      return this.#cleanStopProof(task, project)
    } catch {
      return { round: { stopped: false, live: false, unknown: true, reason: 'proof-unavailable' }, live: [], clean: false }
    }
  }

  /**
   * Reconcile ONE recovered project's own root reservation with the shared ledger. The proof
   * is the SAME central round proof every other transition uses: a round that is positively
   * stopped (a recorded round with a confirmed stop and explicit numeric-zero jobs AND
   * children, a never-dispatched queued round, or a positively stopped terminal root) holds
   * no slot by itself. Anything else — a missing round, a null/nonzero count, a live,
   * ambiguous or unproven root — is ADOPTED so the work stays counted even when the ledger
   * is saturated; adoption is idempotent by key and never double counts a repeated recovery.
   * A positively stopped round may release its OWN slot only when no UNACCOUNTED owned work
   * remains: genuinely bound owned workers count through their own `task:<workerTaskId>`
   * entries (adopted idempotently here, exactly as the ordinary recovery branch does), while
   * an untracked ambiguous dispatch, an unreadable binding or a readable task that does not
   * genuinely belong to this project keeps a stable root placeholder. Owned work is never
   * replayed or dispatched here.
   * @param {object} task - the persisted project task record.
   * @param {{round: object}} proof - result of `#cleanStopProof(task, project)`.
   * @param {{unaccounted: Array, accounted: Array}} [owned] - `#recoveryOwnedWork(task)`.
   * @returns {{action: string, reason: string, counts: object|null}}
   */
  #settleRecoveredRoot(task, proof, owned) {
    const supervisor = this.#supervisor
    // Validate the ledger SEAM by the methods this settlement actually needs. The real
    // shared ledger is a `HostReservationLedger` CLASS INSTANCE, not a plain object, so a
    // structural `isPlainObject` test silently rejected every real ledger and left an
    // unproved project root uncounted after a restart.
    const ledger = supervisor === null || supervisor === undefined ? null : supervisor.ledger
    if (ledger === null || typeof ledger !== 'object') return { action: 'none', reason: 'no-ledger', counts: null }
    // A partial/legacy ledger stub is never asked to adopt or release what it cannot do;
    // the live shared ledger always implements both.
    if (typeof ledger.adopt !== 'function' || typeof ledger.release !== 'function' || typeof ledger.has !== 'function') {
      return { action: 'none', reason: 'ledger-incomplete', counts: null }
    }
    const key = `task:${task.id}`
    const readCounts = () => (typeof ledger.counts === 'function' ? ledger.counts() : null)
    const classified = isPlainObject(owned) ? owned : this.#recoveryOwnedWork(task)
    const unaccounted = Array.isArray(classified.unaccounted) ? classified.unaccounted : []
    const accounted = Array.isArray(classified.accounted) ? classified.accounted : []
    if (proof?.round?.stopped === true) {
      // Known owned workers whose real task records are recoverable count through their OWN
      // ledger entries, never through a phantom project root slot.
      for (const item of accounted) {
        const workerKey = `task:${item.taskId}`
        if (ledger.has(workerKey) === true) continue
        ledger.adopt({
          key: workerKey,
          kind: 'root',
          taskId: item.taskId,
          attemptId: nonBlank(item.settled?.attemptId) ? item.settled.attemptId : null,
          label: item.settled?.packet?.title,
          reason: `recovered owned worker (${item.state})`
        })
      }
      if (unaccounted.length === 0) {
        if (ledger.has(key) === true) {
          ledger.release(key, { stopConfirmed: true, reason: `recovered project root positively stopped (${proof.round.reason})` })
          return { action: 'released', reason: proof.round.reason, counts: readCounts() }
        }
        return { action: 'absent', reason: proof.round.reason, counts: readCounts() }
      }
      // A positively stopped round still cannot free its own model reservation while
      // unresolved owned work is unaccounted for: the root placeholder stays (idempotent,
      // over-limit allowed) so the project can never become clean or free capacity around
      // unknown or foreign work.
      const states = [...new Set(unaccounted.map((item) => item.state))].join(', ')
      ledger.adopt({
        key,
        kind: 'root',
        taskId: task.id,
        attemptId: task.attemptId,
        label: task.packet?.title,
        reason: `recovered project root with unaccounted owned work (${unaccounted.length}: ${states})`
      })
      return { action: 'adopted', reason: proof.round.reason, counts: readCounts() }
    }
    // The adopted root is bound to the CURRENT task identity (the real store-minted
    // attemptId), never to a superseded round's stale label: the round is unproven here, so
    // it must not own the live occupancy.
    ledger.adopt({
      key,
      kind: 'root',
      taskId: task.id,
      attemptId: task.attemptId,
      label: task.packet?.title,
      reason: `recovered project root without a proven stopped round (${proof?.round?.reason ?? 'round-unproven'})`
    })
    return { action: 'adopted', reason: proof?.round?.reason ?? 'round-unproven', counts: readCounts() }
  }

  /**
   * Classify the recovered project's OWNED attempts for host recovery and the shared clean
   * stop proof. A store-readable task id alone is NOT ownership: it may name an unrelated
   * task of the same bridge, and its stop proof must never release, cancel or complete this
   * project. The persisted worker packet must genuinely bind the record to THIS project and
   * to the exact worker/attempt that claims it (`#workerPacket` lineage).
   *
   * unaccounted: an untracked ambiguous dispatch (blank task id in `dispatching`/`running`),
   *   an unreadable record, or a mismatched/missing binding — regardless of the foreign
   *   record's status.
   * accounted: a genuinely bound, readable attempt that is not yet demonstrably stopped; it
   *   counts through its own ledger entry.
   * A genuinely bound, demonstrably stopped attempt is resolved and needs no entry.
   * @param {object} task - the persisted project task record.
   * @returns {{unaccounted: Array, accounted: Array}}
   */
  #recoveryOwnedWork(task) {
    const unaccounted = []
    const accounted = []
    const workers = Array.isArray(task?.project?.workers) ? task.project.workers : []
    for (const worker of workers) {
      const attempts = Array.isArray(worker?.attempts) ? worker.attempts : []
      for (const attempt of attempts) {
        if (!nonBlank(attempt?.taskId)) {
          if (attempt?.state === 'dispatching' || attempt?.state === 'running') {
            unaccounted.push({ workerKey: worker.workerKey, attempt: attempt.attempt, taskId: null, state: 'ambiguous-dispatch' })
          }
          continue
        }
        let settled
        try {
          settled = this.#store.get(attempt.taskId)
        } catch {
          unaccounted.push({ workerKey: worker.workerKey, attempt: attempt.attempt, taskId: attempt.taskId, state: 'unreadable' })
          continue
        }
        if (!this.#workerPacketBinds(settled, task, worker, attempt)) {
          unaccounted.push({ workerKey: worker.workerKey, attempt: attempt.attempt, taskId: attempt.taskId, state: 'unbound' })
          continue
        }
        if (this.#attemptStopped(settled)) continue
        accounted.push({ workerKey: worker.workerKey, attempt: attempt.attempt, taskId: attempt.taskId, state: settled.status, settled })
      }
    }
    return { unaccounted, accounted }
  }

  /**
   * Whether a store-readable task record is the worker its parent attempt really owns,
   * proven by the persisted `#workerPacket` lineage: `parentTaskId`,
   * `metadata.supervisorProject`, `metadata.workerKey` and `metadata.attempt` must all match
   * this project and this exact worker/attempt. A missing or mismatched binding is never
   * ownership: the foreign record's status and stop proof say nothing about this project.
   * @param {object} settled - the persisted task record named by the attempt.
   * @param {object} task - the persisted project task record.
   * @param {object} worker - the owning project worker entry.
   * @param {object} attempt - the owning worker attempt entry.
   * @returns {boolean}
   */
  #workerPacketBinds(settled, task, worker, attempt) {
    const packet = settled?.packet
    if (!isPlainObject(packet)) return false
    if (packet.parentTaskId !== task.id) return false
    const metadata = packet.metadata
    if (!isPlainObject(metadata)) return false
    if (metadata.supervisorProject !== task.id) return false
    if (metadata.workerKey !== worker.workerKey) return false
    if (metadata.attempt !== attempt.attempt) return false
    return true
  }

  /**
   * Re-evaluate one project from persisted state without replaying a model round and
   * without redispatched ambiguous work (used by `bridge_reconcile`).
   * @param {string} id - project task id.
   * @param {{observation?: object}} [options] - real inspector evidence for the owned root.
   * @returns {Promise<object>} bounded evaluation report.
   */
  async reevaluate(id, options = {}) {
    try {
      const task = this.#store.get(id)
      if (!task.project) return { evaluated: false, reason: 'not-a-project' }
      // A durable pause checkpoint is preserved through reconciliation: the distinct
      // pausing/paused state is retained, no inspector observation is consumed into the
      // round proof, and a stopped root never certifies its workers. Only the armed
      // deadline/cancellation paths may settle it, and those converge from real stops.
      if (this.#admissionBlocked(task.project)) {
        this.#settlePause(id)
        const held = this.#store.get(id)
        return { evaluated: true, status: held.status, control: this.#controlState(held.project), held: true }
      }
      // Real inspector evidence is CONSUMED (never invented) before any transition: it is
      // recorded as bounded evidence and qualifies as proof ONLY with an explicit numeric
      // zero for both jobs and children. Anything else stays unproven, and the runtime's
      // fail-closed round/attempt proof keeps the project blocked with its occupancy.
      const observation = isPlainObject(options) && isPlainObject(options.observation) ? options.observation : null
      let consumed = false
      if (observation !== null) {
        const proven = this.#observationProvesStop(observation)
        const evidence = {
          status: typeof observation.status === 'string' ? observation.status : 'unknown',
          stopConfirmed: observation.stopConfirmed === true,
          activeJobs: Number.isInteger(observation.activeJobs) ? observation.activeJobs : null,
          activeChildren: Number.isInteger(observation.activeChildren) ? observation.activeChildren : null,
          proven,
          at: this.#now()
        }
        task.project.reconcileObserved = evidence
        this.#save(task.id, task.project, 'project/reconcile-observed', { status: evidence.status, proven })
        if (proven !== true) {
          const fresh = this.#store.get(id)
          const cleanProof = this.#cleanStopProof(fresh, fresh.project)
          // A terminal record that ALREADY holds valid stop proof — the round AND the task
          // record itself — is never revoked by a later unavailable inspector.
          if (PROJECT_TERMINAL.has(fresh.project.status) && cleanProof.clean === true && this.#rootPositivelyStopped(fresh)) {
            return { evaluated: true, status: fresh.project.status, inspectorProven: false, retained: true }
          }
          // An old terminal STRING without valid proof is not a stop: it becomes the honest
          // unknown/blocked state with its occupancy retained. A project that is merely
          // expected live (a planning/running planner, no terminal claim) is left as is.
          if (PROJECT_TERMINAL.has(fresh.project.status)) {
            await this.#block(id, fresh.project, { code: 'reconcile-stop-unproven', message: `inspector evidence did not prove a stop for the current attempt; ${cleanProof.live.length} unstopped owned task(s) retained` })
            return { evaluated: true, status: 'blocked', inspectorProven: false }
          }
          return { evaluated: true, status: fresh.project.status, inspectorProven: false }
        }
        // A positive inspector proof is consumed into the proof of the round bound to the
        // EXACT current attempt, then every owned piece of work is re-evaluated. It never
        // marks a worker attempt stopped and never fabricates a missing count.
        const boundAttemptId = nonBlank(options.attemptId) ? options.attemptId : task.attemptId
        this.#consumeInspectorProof(id, observation, boundAttemptId)
        consumed = true
      }
      const afterProof = this.#store.get(id)
      // A consumed proof releases the project's own root slot ONLY under the central clean
      // proof: the round bound to the exact current attempt must be stopped AND every owned
      // attempt must be verifiably stopped. A root observation never certifies a worker
      // stop, so untracked/ambiguous owned work keeps its occupancy until genuine owned
      // proof resolves it (the helper is a no-op when the key is not held).
      if (consumed && this.#cleanStopProof(afterProof, afterProof.project).clean === true) this.#releaseModelReservation(id)
      // A consumed real proof is re-evaluated deterministically against the EXISTING
      // cancellation: the central proof decides, no model round and no worker dispatch is
      // replayed, and only a proven stop releases the root reservation.
      if (consumed && afterProof.project.cancelRequested === true && !PROJECT_TERMINAL.has(afterProof.project.status)) {
        const outcome = await this.requestProjectCancel(id, afterProof.project.cancelReason)
        return { evaluated: true, status: this.#store.get(id).project.status, cancelled: outcome?.confirmed === true, consumed: true }
      }
      if (PROJECT_TERMINAL.has(afterProof.project.status)) return { evaluated: false, reason: 'terminal' }
      // Reconciliation is a fail-closed boundary for the SAME binding-classified owned work
      // recovery consumes: an untracked ambiguous dispatch, an unreadable binding or a
      // readable task that does not genuinely belong to this project must not reach the
      // scheduler, where the foreign record's derived state could dispatch or clean around
      // work this project does not own. A consumed root observation never certifies it, so
      // the project stays honestly blocked with its retained occupancy and nothing runs.
      const unaccounted = this.#recoveryOwnedWork(afterProof).unaccounted
      if (unaccounted.length > 0) {
        await this.#block(id, afterProof.project, {
          code: 'reconcile-unaccounted-owned',
          message: `reconciliation retained ${unaccounted.length} unaccounted owned attempt(s); the root reservation is retained and no work is dispatched on a foreign or unverified stop proof`
        })
        return { evaluated: true, status: 'blocked', unaccounted: unaccounted.length }
      }
      if (afterProof.status === 'unknown' && afterProof.project.frozenAt !== null) {
        // Re-enter the honest waiting state so the deterministic scheduler can converge
        // on real stop proofs; an unresolved unknown simply blocks again.
        this.#store.update(id, { status: PROJECT_WAITING, phase: 'project' })
      }
      if (this.#deadlineExceeded(afterProof.project)) {
        // Reconciliation is also a deadline boundary: expiry converges on real stop
        // proofs instead of leaving a queued project waiting forever.
        await this.#expireDeadline(id)
        return { evaluated: true, status: this.#store.get(id).project.status, deadlineExpired: true }
      }
      await this.#kick(id)
      return { evaluated: true, status: this.#store.get(id).project.status }
    } catch (error) {
      this.#record(error)
      return { evaluated: false, reason: (error && error.code) || 'PROJECT_ERROR' }
    }
  }

  /**
   * Consume ONE positive inspector observation into the exact current attempt's round
   * proof on the freshest persisted snapshot. Only the round's own stop proof is written
   * (status + explicit numeric zeros); no worker attempt is certified and no count is
   * fabricated. A project already terminal with a STRICTLY proven aggregate root is left
   * untouched; an unproven terminal string never keeps its terminal status, so the caller
   * deterministically re-evaluates it. Stale evidence for a superseded attempt is dropped
   * here as well as at the service await boundary.
   */
  #consumeInspectorProof(taskId, observation, boundAttemptId) {
    this.#mutate(taskId, (fresh) => {
      const current = fresh.project
      // Stale-evidence fence: the proof is bound to the attempt that was current when the
      // inspection began. A newer attempt landing meanwhile makes this observation stale.
      if (nonBlank(boundAttemptId) && fresh.attemptId !== boundAttemptId) return fresh
      // A terminal is retained only with the STRICT aggregate root proof; a terminal string
      // with a false stop flag or a null/absent count is not proof and is never preserved.
      const retained = PROJECT_TERMINAL.has(current.status) && this.#cleanStopProof(fresh, current).clean === true && this.#rootPositivelyStopped(fresh)
      if (retained) return fresh
      const rounds = Array.isArray(current.rounds) ? [...current.rounds] : []
      const lastIndex = rounds.length - 1
      const proofPatch = {
        status: typeof observation.status === 'string' ? observation.status : 'cancelled',
        stopConfirmed: true,
        activeJobs: 0,
        activeChildren: 0,
        activeChildrenSource: 'host-reported',
        source: 'reconcile',
        at: this.#now()
      }
      if (lastIndex >= 0 && rounds[lastIndex]?.attemptId === boundAttemptId) rounds[lastIndex] = { ...rounds[lastIndex], ...proofPatch }
      else rounds.push({ attemptId: boundAttemptId, ...proofPatch })
      current.rounds = rounds.slice(-8)
      // The root proof is now real: drop the stale blocked OR unproven terminal state and
      // let the deterministic scheduler re-evaluate every owned worker from persisted
      // evidence. An unproven terminal string is never preserved as proof.
      current.status = current.frozenAt === null ? 'frozen' : 'dispatching'
      current.seriousIssue = null
      current.endedAt = null
      return fresh
    }, 'project/reconcile-consumed', { status: typeof observation.status === 'string' ? observation.status : 'cancelled' })
  }

  /**
   * Whether real inspector evidence is a POSITIVE stop: a terminal status with an
   * explicit confirmed stop AND explicit numeric zero jobs and children. Missing/null
   * counts stay unknown — they are never coerced into zeros.
   */
  #observationProvesStop(observation) {
    if (!isPlainObject(observation)) return false
    const status = typeof observation.status === 'string' ? observation.status : 'unknown'
    if (!TERMINAL.has(status)) return false
    if (observation.stopConfirmed !== true) return false
    if (!this.#countIsZero(observation.activeJobs)) return false
    if (!this.#countIsZero(observation.activeChildren)) return false
    return true
  }

  // -- orchestration -------------------------------------------------------

  #requireProject(taskId) {
    if (!nonBlank(taskId)) throw projectError('project/invalid-request', 'a project taskId is required', {})
    let task
    try {
      task = this.#store.get(taskId)
    } catch (error) {
      throw projectError('project/unknown-task', `project task "${taskId}" is not readable: ${String((error && error.message) || error)}`, {})
    }
    if (!task?.project) throw projectError('project/not-a-project', `task "${taskId}" carries no project plan`, {})
    return task
  }

  /**
   * The CURRENT-round attempt fence for every mutating supervisor tool call: a delayed
   * tool call that belongs to a superseded round can never declare, finalize, cancel or
   * decide anything for the live one. A blank attemptId (legacy adapter) is accepted so
   * the historical single-round path is unchanged.
   */
  #requireCurrentAttempt(task, attemptId) {
    if (!nonBlank(attemptId)) return true
    if (task.attemptId !== attemptId) {
      throw projectError('project/stale-attempt', 'this supervisor tool call belongs to a superseded round attempt and cannot mutate the current one', { attemptId, currentAttemptId: task.attemptId })
    }
    return true
  }

  #requireWorker(project, workerId) {    const key = nonBlank(workerId) ? workerId.trim() : ''
    const worker = project.workers.find((candidate) => candidate.workerKey === key || candidate.workerId === key)
    if (worker === undefined) throw projectError('project/unknown-worker', `worker "${key}" is not declared in this project`, { workerId: key })
    return worker
  }

  #workerView(worker) {
    const last = worker.attempts[worker.attempts.length - 1]
    return {
      workerId: worker.workerKey,
      workerKey: worker.workerKey,
      label: worker.label,
      role: worker.role,
      required: worker.required !== false,
      dependsOn: [...worker.dependsOn],
      state: worker.state,
      attempts: worker.attempts.length,
      taskId: last?.taskId ?? null,
      workspace: worker.workspace === null ? null : { repository: worker.workspace.repository, baseRef: worker.workspace.baseRef },
      inspect: last?.inspect ?? null,
      stopConfirmed: last?.stopConfirmed === true,
      cancelRequested: worker.cancelRequested === true
    }
  }

  #save(taskId, project, eventType, extra) {
    this.#store.update(taskId, { project })
    if (nonBlank(eventType)) {
      this.#store.event(taskId, { type: eventType, projectStatus: project.status, ...(isPlainObject(extra) ? safe(extra) : {}) })
    }
  }

  #record(error) {
    this.#lastError = { code: (error && error.code) || 'PROJECT_ERROR', message: boundedText(String((error && error.message) || error), 300), at: this.#now() }
  }

  /** Chain one deterministic transition per project; never overlapping. */
  #kick(taskId) {
    if (this.#closed || this.#service === null || this.#service === undefined) return Promise.resolve()
    const previous = this.#chains.get(taskId) ?? Promise.resolve()
    const next = previous.then(() => this.#tick(taskId)).catch((error) => {
      this.#record(error)
    })
    this.#chains.set(taskId, next)
    return next
  }

  /**
   * Any bridge task settled: re-kick every waiting project so a project is never
   * stalled behind capacity held by unrelated tasks. Never throws.
   */
  onAnySettled() {
    if (this.#closed || this.#service === null) return
    try {
      for (const task of this.#store.list()) {
        if (!task.project) continue
        if (PROJECT_TERMINAL.has(task.project.status)) continue
        if (task.project.status === 'planning') continue
        if (task.status === PROJECT_WAITING || task.project.status === 'dispatching' || task.project.status === 'blocked') this.#kick(task.id)
      }
    } catch (error) {
      this.#record(error)
    }
  }

  async #tick(taskId) {
    const task = this.#store.get(taskId)
    if (!task.project) return
    if (PROJECT_TERMINAL.has(task.project.status)) return
    // A fired deadline is a serialized transition boundary consumed BEFORE the planning
    // guard: otherwise a silent planner parks an expired project in `planning` forever
    // because `#tick` would return before ever reading `#deadlineExpiry`. The deadline
    // stays armed through `pausing`/`paused` too, so an expiry converges on real stop
    // proofs without waiting for anyone to resume.
    if (this.#deadlineExpiry.has(taskId) || task.project.deadlines?.expired === true) {
      await this.#expireDeadline(taskId)
    }
    const after = this.#store.get(taskId)
    if (!after.project || PROJECT_TERMINAL.has(after.project.status) || after.project.status === 'planning') return
    // While admission is held or a round is in flight only the serialized evaluation
    // runs: it settles the pause proof, consumes the deadline/cancellation evidence and
    // never dispatches a worker or a round.
    if (this.#admissionBlocked(after.project) || isPlainObject(after.project.pendingRound)) {
      await this.#evaluate(after)
      return
    }
    await this.#dispatch(after)
    const latest = this.#store.get(taskId)
    await this.#evaluate(latest)
  }

  /** Start every ready initial attempt or repair within the frozen plan and budgets. */
  async #dispatch(task) {
    let current = this.#store.get(task.id)
    if (!current.project || !['frozen', 'dispatching'].includes(current.project.status)) return
    if (current.project.cancelRequested === true) return
    // No worker is admitted while admission is held (pausing/paused) or while the
    // supervisor's own round is in flight: workers declared INSIDE a round only become
    // schedulable after that round proves its stop.
    if (this.#admissionBlocked(current.project) || isPlainObject(current.project.pendingRound)) return
    for (const declared of current.project.workers) {
      if (this.#closed) return
      // Re-read the freshest snapshot for EVERY decision and every awaited submit, so a
      // concurrent settlement, budget credit or refusal can never be overwritten by a
      // stale task/project/worker captured at the top of the pass.
      current = this.#store.get(task.id)
      if (!current.project || !['frozen', 'dispatching'].includes(current.project.status)) return
      const worker = current.project.workers.find((candidate) => candidate.workerKey === declared.workerKey)
      if (worker === undefined) continue
      if (worker.cancelRequested) continue
      if (!this.#dependenciesSatisfied(worker, current.project)) continue
      const spec = this.#attemptSpec(worker, current.project)
      if (spec === null) continue
      if (!this.#startBudgetAllows(current.project)) {
        // A start/retry/time/tool budget the project cannot fund is exhausted, never
        // pending: anything never started settles instead of waiting forever.
        this.#refuseAttempt(current, worker, spec.attempt, this.#deadlineElapsed(current.project) ? 'project-deadline-exceeded' : 'project-start-budget')
        break
      }
      if (this.#remainingToolAllowance(current.project) <= 0) {
        // Unstopped work temporarily holds the whole grant. Nothing is refused outright:
        // that work's verified stop releases the unused allowance and this pass is
        // re-kicked then; a truly spent grant was already refused above.
        break
      }
      const inFlight = this.#inFlight(current.project)
      if (inFlight >= current.project.grant.maxConcurrentWorkers) break
      const free = this.#supervisor !== null ? this.#supervisor.ledger.counts().free : current.project.grant.maxConcurrentWorkers
      if (free <= current.project.grant.reserveSlots) break
      await this.#dispatchAttempt(current, worker, spec.attempt, spec.kind)
    }
    const latest = this.#store.get(task.id)
    if (latest.project && latest.project.status === 'frozen' && latest.project.workers.length > 0) {
      latest.project.status = 'dispatching'
      this.#save(task.id, latest.project, 'project/dispatching', {})
    }
  }

  // -- bounded recurrent rounds & durable control --------------------------

  /** The per-round supervisor tool request, bounded by the granted project total. */
  #roundToolRequest(task, project) {
    const effective = isPlainObject(task.effectivePacket) ? task.effectivePacket : task.packet
    const budget = Number.isInteger(effective?.budget?.maxToolCalls) && effective.budget.maxToolCalls > 0 ? effective.budget.maxToolCalls : null
    const cap = project.grant.maxTotalToolCalls
    return Math.max(1, budget === null ? cap : Math.min(budget, cap))
  }

  #controlState(project) {
    const pause = project?.control?.pause
    return isPlainObject(pause) && typeof pause.state === 'string' ? pause.state : 'none'
  }

  /**
   * Record the authoritative outcome of ONE explicit resume requestId on the project.
   * It writes BOTH the legacy newest `control.resume` field and a bounded per-operation
   * history, replacing any earlier entry for the same id so a later async local refusal
   * (or a repeated request) can never be replayed as its superseded outcome. The FIRST
   * request reason wins because an id is only recorded when it is first processed.
   */
  #recordResumeRequest(project, { requestId, outcome, code = null, reason = null, roundIndex = null } = {}) {
    const id = nonBlank(requestId) ? requestId.trim() : null
    const prior = Array.isArray(project.control?.resumeHistory) ? project.control.resumeHistory : []
    const previous = id === null ? null : (prior.find((item) => item?.requestId === id) ?? null)
    const entry = {
      requestId: id,
      at: this.#now(),
      outcome,
      code: code ?? null,
      roundIndex: Number.isInteger(roundIndex) ? roundIndex : (project.roundsUsed ?? 0),
      // The FIRST reason recorded for an id is the audit text and is never replaced by a
      // later same-id transition (an async local refusal keeps the original reason).
      reason: boundedText(reason, 200) || previous?.reason || null
    }
    const history = id === null
      ? prior.slice(-RESUME_REQUEST_HISTORY_LIMIT)
      : [...prior.filter((item) => item?.requestId !== id), entry].slice(-RESUME_REQUEST_HISTORY_LIMIT)
    project.control = {
      ...(isPlainObject(project.control) ? project.control : {}),
      resume: { ...entry },
      resumeHistory: history
    }
    return entry
  }

  /** Whether new admission (worker attempt or supervisor round) is held by control. */
  #admissionBlocked(project) {
    const state = this.#controlState(project)
    return state === PROJECT_PAUSING || state === PROJECT_PAUSED
  }

  /**
   * The durable pause proof. A `pausing` project may become `paused` only when no
   * supervisor round is in flight, no dispatch receipt is pending, the current round is
   * POSITIVELY stopped and EVERY genuinely owned attempt is positively stopped: a
   * stopped root never certifies its workers.
   */
  #pauseProven(task, project) {
    if (isPlainObject(project.pendingRound)) return false
    if (task?.dispatchPending === true) return false
    const proof = this.#cleanStopProof(task, project)
    if (proof.live.length > 0) return false
    if (proof.round.stopped === true) return true
    // A project paused BEFORE its first dispatch keeps its honest never-dispatched proof
    // even after the task status moved to the non-terminal `pausing` state (which is why
    // `#roundLiveness` alone can no longer classify it as `never-dispatched`).
    const neverDispatched = task?.dispatchStarted !== true && task?.dispatchPending !== true && !nonBlank(task?.sessionId) && !Number.isFinite(task?.dispatchReceiptAt)
    return neverDispatched && (Array.isArray(project.rounds) ? project.rounds.length : 0) === 0
  }

  /** Flip `pausing` to the honest `paused` state only once the whole proof holds. */
  #settlePause(taskId) {
    const task = this.#store.get(taskId)
    const project = task.project
    if (!project || PROJECT_TERMINAL.has(project.status)) return false
    if (this.#controlState(project) !== PROJECT_PAUSING) return false
    if (!this.#pauseProven(task, project)) return false
    project.control = { ...project.control, pause: { ...project.control.pause, state: PROJECT_PAUSED, pausedAt: project.control.pause.pausedAt ?? this.#now() } }
    project.status = PROJECT_PAUSED
    this.#save(taskId, project, 'project/paused', { requestId: project.control.pause.requestId })
    this.#store.update(taskId, { status: PROJECT_PAUSED, phase: 'project' })
    return true
  }

  /** Every required worker succeeded; a complete decision can never hide one that did not. */
  #requiredAllSucceeded(project) {
    for (const worker of project.workers) {
      if (worker.required === false) continue
      if (worker.state !== 'succeeded') return false
    }
    return true
  }

  /**
   * Mint and dispatch ONE more bounded supervisor round on the SAME owned session. The
   * round's allowance and the narrowed effective packet are persisted BEFORE any await or
   * host dispatch, the new attempt is minted through a checked CAS against the exact
   * proven-stopped current attempt, and the real adapter `nextRound` seam re-proves
   * ownership, terminal true/0/0 and the guarded live agent before any prompt.
   * @param {string} taskId - project task id.
   * @param {object} project - current project record at a stopped round boundary.
   * @returns {Promise<{started: boolean, reason?: string, round?: number, allowance?: number}>} planning verdict.
   */
  async #startRound(taskId, project) {
    if (project.grant.recurrent !== true) return { started: false, reason: 'not-recurrent' }
    if (this.#admissionBlocked(project)) return { started: false, reason: 'paused' }
    if (isPlainObject(project.pendingRound)) return { started: false, reason: 'round-in-flight' }
    if (project.cancelRequested === true) return { started: false, reason: 'cancelled' }
    if ((project.roundsUsed ?? 0) >= project.grant.maxRounds) return { started: false, reason: 'round-cap' }
    if (this.#deadlineElapsed(project)) return { started: false, reason: 'deadline' }
    if (project.decision?.kind === 'complete') return { started: false, reason: 'decision-complete' }
    if (project.decision?.kind === 'block') return { started: false, reason: 'decision-block' }
    const task = this.#store.get(taskId)
    const proof = this.#cleanStopProof(task, project)
    if (proof.round.stopped !== true || proof.live.length > 0) return { started: false, reason: 'round-unproven' }
    const remaining = this.#remainingToolAllowance(project)
    if (remaining <= 0) return { started: false, reason: 'project-tool-budget' }
    const allowance = Math.max(1, Math.min(this.#roundToolRequest(task, project), remaining))
    const baseline = Number.isInteger(task.stats?.toolCalls) ? task.stats.toolCalls : 0
    const index = (project.roundsUsed ?? 0) + 1
    const dispatchKey = roundDispatchKey(taskId, index)
    let expectedAttemptId = null
    let planned = false
    // Persist intent + the FULL reservation before anything awaited or dispatched.
    this.#mutate(taskId, (fresh) => {
      if (isPlainObject(fresh.project.pendingRound)) return fresh
      if ((fresh.project.roundsUsed ?? 0) + 1 !== index) return fresh
      if (this.#remainingToolAllowance(fresh.project) <= 0) return fresh
      fresh.project.pendingRound = { index, dispatchKey, attemptId: null, state: 'planned', baselineToolCalls: baseline, grantedToolCalls: allowance, plannedAt: this.#now() }
      fresh.project.roundBaselineToolCalls = baseline
      fresh.project.budgets = {
        ...fresh.project.budgets,
        supervisorReserved: (Number.isInteger(fresh.project.budgets?.supervisorReserved) ? fresh.project.budgets.supervisorReserved : 0) + allowance
      }
      expectedAttemptId = fresh.attemptId
      planned = true
      return fresh
    }, 'project/round-planned', { round: index, allowance, baselineToolCalls: baseline, dispatchKey })
    if (planned !== true) return { started: false, reason: 'plan-conflict' }
    // Narrow the effective packet DOWNWARD only: the round allowance and the REMAINING
    // project wall time. The immutable packet and the cumulative original deadline are
    // never rewritten.
    this.#mutate(taskId, (fresh) => {
      const effective = isPlainObject(fresh.effectivePacket) ? fresh.effectivePacket : { ...fresh.packet }
      const budget = isPlainObject(effective.budget) ? { ...effective.budget } : { ...fresh.packet.budget }
      const remainingMs = Math.max(1, projectDeadlineRemaining(fresh.project, this.#now()))
      const currentMs = Number.isInteger(budget.timeoutMs) && budget.timeoutMs > 0 ? budget.timeoutMs : remainingMs
      const currentCalls = Number.isInteger(budget.maxToolCalls) && budget.maxToolCalls > 0 ? budget.maxToolCalls : allowance
      budget.timeoutMs = Math.max(1, Math.min(currentMs, remainingMs))
      budget.maxToolCalls = Math.max(1, Math.min(currentCalls, allowance))
      fresh.effectivePacket = { ...effective, budget }
      return fresh
    }, 'project/round-budget-narrowed', { round: index, allowance })
    let minted = null
    try {
      minted = this.#store.beginRound(taskId, { expectedAttemptId, expectedRoundIndex: project.roundsUsed ?? 0, expectedDispatchKey: dispatchKey })
    } catch (error) {
      this.#record(error)
      // Nothing crossed the host boundary: release the reservation so a later pass can
      // re-plan it honestly (a refused round is never left half-promised).
      this.#mutate(taskId, (fresh) => {
        if (!isPlainObject(fresh.project.pendingRound) || fresh.project.pendingRound.dispatchKey !== dispatchKey) return fresh
        const reserved = Number.isInteger(fresh.project.budgets?.supervisorReserved) ? fresh.project.budgets.supervisorReserved : 0
        fresh.project.pendingRound = null
        fresh.project.roundBaselineToolCalls = null
        fresh.project.budgets = { ...fresh.project.budgets, supervisorReserved: Math.max(0, reserved - allowance) }
        return fresh
      }, 'project/round-plan-abandoned', { round: index })
      return { started: false, reason: (error && error.code) || 'ROUND_CONFLICT' }
    }
    this.#mutate(taskId, (fresh) => {
      if (isPlainObject(fresh.project.pendingRound) && fresh.project.pendingRound.dispatchKey === dispatchKey) {
        fresh.project.pendingRound.attemptId = minted.attemptId
        fresh.project.pendingRound.state = 'dispatching'
      }
      return fresh
    }, 'project/round-dispatched', { round: index, attemptId: minted.attemptId })
    // The queued task is dispatched by the REAL BridgeService drain, which selects the
    // adapter's `nextRound` seam for a `supervisor-round` continuation.
    if (this.#service !== null && typeof this.#service.kick === 'function') this.#service.kick()
    return { started: true, round: index, allowance, attemptId: minted.attemptId }
  }

  /** The next attempt a worker is allowed to start, or null. */
  #attemptSpec(worker, project) {    const attempts = worker.attempts
    if (attempts.length === 0) return worker.state === 'queued' ? { attempt: 1, kind: 'initial' } : null
    const last = attempts[attempts.length - 1]
    if (last.retryBlocked === true) return null
    const ordinaryFailure = last.state === 'failed' || (last.state === 'cancelled' && last.cancelRequested !== true)
    if (!ordinaryFailure) return null
    if (last.stopConfirmed !== true) return null
    if (worker.cancelRequested) return null
    if (attempts.length >= 1 + project.grant.maxRepairAttempts) return null
    return { attempt: attempts.length + 1, kind: 'repair' }
  }

  #dependenciesSatisfied(worker, project) {
    for (const key of worker.dependsOn) {
      const dependency = project.workers.find((candidate) => candidate.workerKey === key)
      if (dependency === undefined || dependency.state !== 'succeeded') return false
    }
    return true
  }

  #inFlight(project) {
    return project.workers.reduce((count, worker) => {
      const last = worker.attempts[worker.attempts.length - 1]
      // `unknown` occupancy counts exactly like live work: unverified owned work keeps
      // its slot and blocks admission; it is never replaced by a fresh attempt.
      return count + (last !== undefined && (last.state === 'dispatching' || last.state === 'running' || last.state === 'unknown') ? 1 : 0)
    }, 0)
  }

  /**
   * Project-wide budget preflight for a scheduling pass. Every check happens BEFORE an
   * attempt is persisted or submitted, so a pass can never overshoot a cap. Only a
   * TRULY exhausted tool spend blocks here: allowance merely reserved by work that has
   * not stopped yet must be allowed to be released by that work's verified stop.
   */
  #startBudgetAllows(project) {
    if (project.budgets.starts >= project.grant.maxWorkerStarts) return false
    if (this.#deadlineElapsed(project)) return false
    if (this.#toolSpendExhausted(project)) return false
    return true
  }

  /**
   * Whether the project still owns an attempt that was admitted and has NOT settled:
   * `dispatching`/`running` (or `unknown`, which keeps its slot). Such work is alive by
   * definition, so it can still settle and must never be turned into an exhausted plan.
   */
  #hasLiveWork(project) {
    for (const worker of project.workers) {
      const last = worker.attempts[worker.attempts.length - 1]
      if (last === undefined) continue
      if (last.state === 'dispatching' || last.state === 'running' || last.state === 'unknown') return true
    }
    return false
  }

  /**
   * Whether incomplete work exists that the current budgets genuinely cannot fund: a
   * worker that was never started, or a prior ordinary failure whose bounded repair the
   * start/retry budget can no longer pay for. A live attempt is deliberately NOT
   * unfunded work — it was already funded and is settling.
   */
  #hasUnfundedWork(project) {
    for (const worker of project.workers) {
      if (worker.cancelledBeforeDispatch === true) continue
      if (worker.state === 'succeeded') continue
      const last = worker.attempts[worker.attempts.length - 1]
      if (last === undefined) return true
      if (last.retryBlocked === true) continue
      const ordinaryFailure = last.state === 'failed' || (last.state === 'cancelled' && last.cancelRequested !== true)
      if (ordinaryFailure && worker.attempts.length < 1 + project.grant.maxRepairAttempts) return true
    }
    return false
  }

  /**
   * Persist-before-dispatch, then submit one real bounded bridge task. The attempt is
   * planned on the FRESH persisted snapshot and every cap is re-checked there, so a
   * whole scheduling pass can never overshoot a start/retry/tool budget. On success the
   * REAL receipt identity is merged back onto the freshest snapshot by immutable attempt
   * key, so it is never lost and never clobbers a concurrent settlement.
   * @returns {Promise<{started: boolean, reason?: string}>} planning verdict.
   */
  async #startAttempt(task, worker, attemptNumber, budgetReason) {
    const idempotencyKey = workerAttemptKey(task.id, worker.workerKey, attemptNumber)
    let planned = null
    let refusal = null
    this.#mutate(task.id, (fresh) => {
      const target = fresh.project.workers.find((candidate) => candidate.workerKey === worker.workerKey)
      if (target === undefined) return fresh
      if (target.attempts.some((entry) => entry.idempotencyKey === idempotencyKey)) return fresh
      if (fresh.project.cancelRequested === true) return fresh
      if (fresh.project.budgets.starts >= fresh.project.grant.maxWorkerStarts) {
        refusal = attemptNumber > 1 ? 'project-retry-budget' : 'project-start-budget'
        return fresh
      }
      if (attemptNumber > 1 && fresh.project.budgets.retries >= fresh.project.grant.maxTotalRetries) {
        refusal = 'project-retry-budget'
        return fresh
      }
      if (this.#toolSpendExhausted(fresh.project)) {
        refusal = 'project-tool-budget'
        return fresh
      }
      const remaining = this.#remainingToolAllowance(fresh.project)
      if (remaining <= 0) {
        refusal = 'project-tool-reserved'
        return fresh
      }
      const allowance = Math.max(1, Math.min(target.budgets.maxToolCalls, remaining))
      target.attempts.push({
        attempt: attemptNumber,
        idempotencyKey,
        state: 'dispatching',
        taskId: null,
        sessionId: null,
        startedAt: this.#now(),
        cancelRequested: false,
        stopConfirmed: false,
        // The FULL unspent allowance is persisted before the submit crosses the host
        // boundary, so a crash or an ambiguous insertion can never re-promise it.
        grantedToolCalls: allowance
      })
      target.state = 'dispatching'
      fresh.project.budgets = {
        ...fresh.project.budgets,
        starts: fresh.project.budgets.starts + 1,
        retries: fresh.project.budgets.retries + (attemptNumber > 1 ? 1 : 0)
      }
      if (fresh.project.startedAt === null) fresh.project.startedAt = this.#now()
      planned = { allowance, packet: this.#workerPacket(fresh, target, idempotencyKey, allowance) }
      return fresh
    }, 'project/attempt-planned', { workerKey: worker.workerKey, attempt: attemptNumber, idempotencyKey, ...(budgetReason === undefined ? {} : { reason: budgetReason }) })
    if (planned === null) return { started: false, reason: refusal ?? 'project-start-budget' }
    let view
    try {
      view = await this.#service.submit(planned.packet)
    } catch (error) {
      await this.#resolveSubmitFailure(task.id, worker.workerKey, { attempt: attemptNumber, idempotencyKey, grantedToolCalls: planned.allowance }, error)
      return { started: true }
    }
    const taskId = nonBlank(view?.id) ? view.id : null
    const sessionId = nonBlank(view?.sessionId) ? view.sessionId : null
    const dispatchedAt = this.#now()
    // Identity-merge the REAL receipt onto the freshest snapshot: a settlement that
    // landed while submit was awaited keeps its state, and the real taskId is persisted
    // before aggregation, cancellation or recovery can observe this attempt.
    this.#mutate(task.id, (fresh) => {
      const target = fresh.project.workers.find((candidate) => candidate.workerKey === worker.workerKey)
      const attempt = target?.attempts.find((entry) => entry.idempotencyKey === idempotencyKey)
      if (attempt === undefined) return fresh
      if (!nonBlank(attempt.taskId) && nonBlank(taskId)) attempt.taskId = taskId
      if (!nonBlank(attempt.sessionId) && nonBlank(sessionId)) attempt.sessionId = sessionId
      if (attempt.dispatchedAt === undefined) attempt.dispatchedAt = dispatchedAt
      // Never downgrade an attempt a settlement already resolved: the derived real-task
      // state may only (re)open an attempt that is still dispatching/running.
      if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(attempt.state)) {
        const synced = this.#syncAttempt(fresh.id, target, attempt)
        // Never assume "running": the attempt state is always derived from the REAL task
        // record, and a settlement that landed during the await already set it.
        if (synced === null && attempt.state === 'dispatching') target.state = 'dispatching'
      }
      return fresh
    }, 'project/attempt-started', { workerKey: worker.workerKey, attempt: attemptNumber, taskId })
    return { started: true }
  }

  /**
   * An ambiguous `service.submit` failure. The deterministic idempotency key either
   * resolves to a REAL inserted task (link it, keep it unknown, retain its slot and its
   * tool allowance) or proves nothing crossed the boundary (a clean, non-retryable
   * refusal). Unreadable evidence is never a clean failure.
   */
  async #resolveSubmitFailure(taskId, workerKey, record, error) {
    const code = (error && error.code) || 'WORKER_SUBMIT_FAILED'
    const message = boundedText(String((error && error.message) || error), 300)
    let found = null
    let lookupFailed = false
    try {
      if (this.#store !== null && typeof this.#store.find === 'function') found = this.#store.find(record.idempotencyKey)
    } catch {
      lookupFailed = true
    }
    const inserted = found !== null && found !== undefined && isPlainObject(found.task) && nonBlank(found.task.id)
    if (inserted) {
      const fresh = this.#store.get(taskId)
      const worker = fresh.project.workers.find((candidate) => candidate.workerKey === workerKey)
      const attempt = worker?.attempts.find((entry) => entry.idempotencyKey === record.idempotencyKey)
      if (attempt === undefined) return
      attempt.taskId = found.task.id
      // The transport outcome is unknown: no stop proof exists, so the attempt is NOT
      // stopped, the allowance stays reserved and the project must not settle cleanly.
      attempt.state = 'unknown'
      attempt.stopConfirmed = false
      attempt.activeJobs = null
      attempt.activeChildren = null
      attempt.activeChildrenSource = null
      attempt.ambiguity = `submit failed after inserting task ${found.task.id}: ${code}`
      attempt.error = { code, message }
      this.#save(taskId, fresh.project, 'project/attempt-ambiguous-submit', { workerKey, attempt: attempt.attempt, taskId: found.task.id, code })
      await this.#block(taskId, this.#store.get(taskId).project, {
        code: 'ambiguous-submit',
        message: `worker submit threw ${code} after task ${found.task.id} was inserted; the real identity is retained and no retry or clean failure is fabricated`
      })
      return
    }
    const fresh = this.#store.get(taskId)
    const worker = fresh.project.workers.find((candidate) => candidate.workerKey === workerKey)
    const attempt = worker?.attempts.find((entry) => entry.idempotencyKey === record.idempotencyKey)
    if (attempt === undefined) return
    if (lookupFailed) {
      attempt.state = 'unknown'
      attempt.stopConfirmed = false
      attempt.activeJobs = null
      attempt.activeChildren = null
      attempt.activeChildrenSource = null
      attempt.ambiguity = `submit threw ${code} and the idempotency receipt could not be read`
      attempt.error = { code, message }
      this.#save(taskId, fresh.project, 'project/attempt-ambiguous-submit', { workerKey, attempt: attempt.attempt, code })
      await this.#block(taskId, this.#store.get(taskId).project, {
        code: 'ambiguous-submit-unreadable',
        message: `worker submit threw ${code} and the idempotency receipt is unreadable; the outcome stays unknown`
      })
      return
    }
    // Proven pre-insertion refusal: no task crossed the boundary, so this is a clean,
    // deterministic and non-retryable failure.
    attempt.state = 'failed'
    attempt.stopConfirmed = true
    attempt.activeJobs = 0
    // No task crossed the boundary, so this attempt genuinely owns zero children.
    attempt.activeChildren = 0
    attempt.activeChildrenSource = 'pre-dispatch-refusal'
    attempt.toolAllowanceReleased = true
    attempt.retryBlocked = true
    attempt.settledAt = this.#now()
    attempt.error = { code, message }
    worker.state = 'failed'
    this.#save(taskId, fresh.project, 'project/attempt-refused', { workerKey, attempt: attempt.attempt, code })
  }

  #workerPacket(task, worker, idempotencyKey, toolAllowance) {
    const grant = task.project.grant
    const writer = worker.writeRoots.length > 0
    const cwd = writer && grant.workspace !== undefined ? grant.workspace.repository : task.packet.cwd
    // A worker may never outlive the project: its own deadline is clamped to the
    // remaining project deadline so a bounded worker cannot run past it.
    const remainingMs = Math.max(1, projectDeadlineRemaining(task.project, this.#now()))
    const model = isPlainObject(task.effectiveModel)
      ? {
          provider: task.effectiveModel.provider,
          model: task.effectiveModel.model,
          ...(typeof task.effectiveModel.reasoningEffort === 'string' ? { reasoningEffort: task.effectiveModel.reasoningEffort } : {})
        }
      : undefined
    return {
      schemaVersion: 1,
      idempotencyKey,
      revision: 1,
      projectId: task.packet.projectId,
      title: boundedText(`${task.packet.projectId} worker ${worker.workerKey}`, 200),
      objective: worker.objective,
      cwd,
      role: worker.role,
      acceptance: [...worker.acceptance],
      scope: {
        readRoots: [...worker.readRoots],
        writeRoots: [...worker.writeRoots],
        allowedTools: [...worker.tools],
        allowShell: false,
        allowNetwork: worker.allowNetwork === true,
        allowDelegation: false
      },
      materials: [],
      contractVersion: task.packet.contractVersion,
      parentTaskId: task.id,
      ...(model === undefined ? {} : { model }),
      ...(worker.workspace === null ? {} : { workspace: { repository: worker.workspace.repository, baseRef: worker.workspace.baseRef } }),
      budget: {
        timeoutMs: Math.max(1, Math.min(worker.budgets.timeoutMs, remainingMs)),
        maxToolCalls: Math.max(1, toolAllowance),
        maxOutputChars: worker.budgets.maxOutputChars
      },
      metadata: { supervisorProject: task.id, workerKey: worker.workerKey, attempt: worker.attempts.length }
    }
  }

  async #inspectWorkspace(workspace) {
    if (this.#workspaces === null || typeof this.#workspaces.inspect !== 'function') {
      return { outcome: 'unsupported', reason: 'no workspace manager is configured on this host' }
    }
    try {
      const state = await this.#workspaces.inspect(workspace)
      return {
        head: typeof state?.head === 'string' ? state.head : null,
        dirty: state?.dirty === true,
        changedPaths: Array.isArray(state?.changedPaths) ? state.changedPaths.slice(0, 200) : []
      }
    } catch (error) {
      return { outcome: 'unknown', error: { code: (error && error.code) || 'INSPECT_ERROR', message: boundedText(String((error && error.message) || error), 300) } }
    }
  }

  /**
   * The honest attempt state for one REAL worker task. A live/unsettled task is
   * `dispatching`/`running`; a terminal task is `succeeded` only with a verified stop,
   * otherwise `unknown`. Nothing here ever assumes a state the host did not report: a
   * missing/null stop count is NOT zero and never yields a clean terminal.
   */
  #attemptStateFor(task) {
    const status = typeof task?.status === 'string' ? task.status : 'unknown'
    const stopped = this.#attemptStopped(task)
    if (status === 'completed' && stopped) return { stopped, state: 'succeeded' }
    if (status === 'failed' && stopped) return { stopped, state: 'failed' }
    if (status === 'cancelled' && stopped) return { stopped, state: 'cancelled' }
    if (status === 'queued') return { stopped: false, state: 'dispatching' }
    if (status === 'starting' || status === 'running' || status === 'cancelling') return { stopped: false, state: 'running' }
    return { stopped: false, state: 'unknown' }
  }

  /** Apply the real task state to one attempt record (shared by settle and dispatch). */
  #applyAttemptState(attempt, worker, task) {
    const { stopped, state } = this.#attemptStateFor(task)
    attempt.state = state
    attempt.stopConfirmed = stopped
    attempt.activeJobs = Number.isInteger(task?.activeJobs) ? task.activeJobs : null
    // The owned task's REAL child count is snapshotted with its provenance, exactly like
    // `activeJobs`: the central owned-stop proof reads this same field, and a missing or
    // non-numeric count is unknown (null), NEVER a zero. This makes the genuine true/0/0
    // proof of every owned attempt readable from the public project view without
    // inferring anything.
    attempt.activeChildren = Number.isInteger(task?.activeChildren) ? task.activeChildren : null
    attempt.activeChildrenSource = Number.isInteger(task?.activeChildren) ? 'owned-task' : null
    if (stopped) attempt.settledAt = this.#now()
    if (state === 'unknown' && TERMINAL.has(task?.status)) {
      attempt.ambiguity = `terminal ${task.status} with stopConfirmed=${task.stopConfirmed} activeJobs=${task.activeJobs}`
    }
    worker.state = state
    return { stopped, state }
  }

  /** Re-read the real worker task for one attempt and persist its honest state. */
  #syncAttempt(taskId, worker, attempt) {
    if (!nonBlank(attempt.taskId)) return null
    let settled
    try {
      settled = this.#store.get(attempt.taskId)
    } catch {
      return null
    }
    return { task: settled, ...this.#applyAttemptState(attempt, worker, settled) }
  }

  /** Attempts whose bridge task is not demonstrably stopped (or never dispatched). */
  #unstopped(task) {
    const out = []
    for (const worker of task.project.workers) {
      for (const attempt of worker.attempts) {
        if (!nonBlank(attempt.taskId)) {
          if (attempt.state === 'dispatching' || attempt.state === 'running') {
            out.push({ workerKey: worker.workerKey, attempt: attempt.attempt, taskId: null, state: 'ambiguous-dispatch' })
          }
          continue
        }
        let settled
        try {
          settled = this.#store.get(attempt.taskId)
        } catch {
          out.push({ workerKey: worker.workerKey, attempt: attempt.attempt, taskId: attempt.taskId, state: 'unreadable' })
          continue
        }
        const stopped = this.#attemptStopped(settled)
        if (!stopped) out.push({ workerKey: worker.workerKey, attempt: attempt.attempt, taskId: attempt.taskId, state: settled.status })
      }
    }
    return out
  }

  /** Aggregate and settle honestly. */
  async #evaluate(task) {
    const project = task.project
    if (PROJECT_TERMINAL.has(project.status) || project.status === 'planning') return
    // The worker state is always DERIVED from its last attempt, so a missed or reordered
    // hook can never leave a worker looking live or dead for the wrong reason.
    for (const worker of project.workers) {
      const last = worker.attempts[worker.attempts.length - 1]
      if (last !== undefined) worker.state = last.state
      else if (worker.cancelledBeforeDispatch === true) worker.state = 'cancelled'
      else worker.state = 'queued'
    }
    // An attempt with a verified stop releases its reserved tool allowance (credited to
    // observed spend); unknown/unreadable work keeps its reservation forever.
    for (const worker of project.workers) {
      for (const attempt of worker.attempts) {
        if (attempt.toolAllowanceReleased === true) continue
        if (!nonBlank(attempt.taskId)) continue
        let settled = null
        try {
          settled = this.#store.get(attempt.taskId)
        } catch {
          settled = null
        }
        if (settled !== null && this.#attemptStopped(settled)) this.#releaseToolAllowance(task.id, worker.workerKey, attempt.attempt, true)
      }
    }
    // A deadline cannot be scheduled around: expired capacity-queued or live work
    // converges instead of staying pending forever. Arming is idempotent by LIVE timer
    // ownership (a persisted flag from a previous process is re-armed here), and the
    // fresh snapshot is read AFTER arming so no stale project is saved back over it.
    this.#armDeadline(task.id)
    const refreshed = this.#store.get(task.id)
    const current = refreshed.project
    const deadlineExceeded = this.#deadlineElapsed(current)
    if (deadlineExceeded) {
      current.deadlines = { armed: current.deadlines?.armed === true, expired: true, firedAt: current.deadlines?.firedAt ?? this.#now() }
      current.seriousIssue = current.seriousIssue ?? { code: 'project-deadline-exceeded', message: `the project deadline elapsed since admission`, at: this.#now() }
      const deadlineLive = this.#unstopped(refreshed)
      if (deadlineLive.length > 0) {
        this.#save(task.id, current, 'project/deadline-cancel', { live: deadlineLive.length })
        await this.#cancelLive(task, deadlineLive, 'project deadline exceeded')
        return
      }
      await this.#failCleanly(task.id, current, { code: 'project-deadline-exceeded', message: `the project deadline of ${current.grant.timeoutMs}ms elapsed since admission` })
      return
    }
    // A controller cancellation converges on real stop proofs; an unconfirmed stop
    // stays blocked/unknown with its capacity retained.
    if (current.cancelRequested === true) {
      // The SAME central proof as a clean failure/completion: a terminal cancellation is
      // recorded only when the supervisor round and every owned attempt carry a positive
      // stop proof. A request is not a stop.
      const proof = this.#cleanStopProof(refreshed, current)
      if (proof.round.stopped !== true) {
        await this.#block(task.id, current, { code: 'supervisor-round-cancel-unconfirmed', message: 'cancellation was requested but the supervisor round has no verified stop proof' })
        return
      }
      if (proof.live.length > 0) {
        // Unverified owned work is never turned into a terminal cancellation: the task
        // stays unknown, the project blocked, capacity is retained and the project
        // remains cancel/reconcile capable until every stop is proven.
        await this.#block(task.id, current, { code: 'project-cancel-unconfirmed', message: `cancellation left ${proof.live.length} owned worker task(s) without a verified stop` })
        return
      }
      current.status = 'cancelled'
      current.endedAt = this.#now()
      current.ownedUnstopped = 0
      this.#clearDeadline(task.id)
      this.#save(task.id, current, 'project/cancelled', { reason: current.cancelReason })
      this.#store.update(task.id, { status: 'cancelled', phase: 'project', stopConfirmed: true, activeJobs: 0, activeChildren: 0, endedAt: this.#now() })
      return
    }
    // A pause request only ever becomes the honest non-terminal `paused` state behind the
    // full central proof (current round AND every owned attempt true/0/0, no pending
    // dispatch). It is never a completion, a failure or a cancellation, and it is checked
    // AFTER the deadline/cancellation branches so a real expiry still converges.
    if (this.#admissionBlocked(current)) {
      const settledPause = this.#settlePause(task.id)
      const held = this.#store.get(task.id).project
      // The distinct pausing/paused state is preserved on the task record too, so a
      // settlement of unrelated work can never report the held project as supervising.
      const state = this.#controlState(held)
      this.#store.update(task.id, { status: state === PROJECT_PAUSED ? PROJECT_PAUSED : PROJECT_PAUSING, phase: 'project' })
      this.#save(task.id, held, 'project/control-held', { state, settled: settledPause === true })
      return
    }
    // A supervisor round crossing the host boundary is live work: only its own stop proof
    // may settle it, and no other round or terminal decision may be started meanwhile.
    if (isPlainObject(current.pendingRound)) {
      this.#save(task.id, current, 'project/round-in-flight', { round: current.pendingRound.index, attemptId: current.pendingRound.attemptId ?? null })
      return
    }
    // Work the project budget cannot fund is EXHAUSTED, never pending. The refusal is
    // persisted on the attempt so aggregation can converge without a silent wait.
    const sweep = this.#budgetSweep(current)
    if (sweep.mutated) this.#save(task.id, current, 'project/budget-exhausted', { reasons: sweep.reasons.slice(0, 8) })
    const decision = aggregateProject({ workers: current.workers, maxRepairAttempts: current.grant.maxRepairAttempts })
    const live = this.#unstopped(refreshed)
    // The shared tool cap is a HARD bound: a completed aggregate above it is never a
    // clean success. Stop proofs decide whether that is failed or honestly unknown.
    const overspent = this.#toolBound(current) > current.grant.maxTotalToolCalls
    if (overspent) current.budgetExhausted = { code: 'project-tool-budget-exhausted', toolBound: this.#toolBound(current), maxTotalToolCalls: current.grant.maxTotalToolCalls, at: this.#now() }
    current.aggregate = { status: decision.status, at: this.#now(), reasons: decision.reasons.slice(0, 16) }
    if (overspent) {
      if (live.length > 0) {
        await this.#block(task.id, current, { code: 'project-tool-budget-exhausted', message: `observed plus reserved tool calls exceed the granted ${current.grant.maxTotalToolCalls}` })
        return
      }
      await this.#failCleanly(task.id, current, { code: 'project-tool-budget-exhausted', message: `the project spent ${this.#toolBound(current)} tool calls against a grant of ${current.grant.maxTotalToolCalls}` })
      return
    }
    if (decision.status === 'unknown') {
      await this.#block(task.id, current, { code: 'unknown-worker-work', message: `owned work without a verified stop: ${decision.unknown.join(', ')}` })
      return
    }
    if (decision.status === 'failed') {
      if (live.length > 0) {
        // Required work failed; converge by cancelling the rest, then settle only when
        // every owned stop is proven. A cancellation request is not a stop.
        this.#save(task.id, current, 'project/failing', { live: live.length })
        await this.#cancelLive(task, live, 'project cannot complete: a required worker is exhausted')
        return
      }
      await this.#failCleanly(task.id, current, { code: 'required-worker-exhausted', message: decision.reasons.join('; ') || 'a required worker exhausted its bounded repairs' })
      return
    }
    if (decision.status === 'completed') {
      if (live.length > 0) {
        this.#save(task.id, current, 'project/waiting', { live: live.length })
        return
      }
      if (current.grant.recurrent === true) {
        // A completed first wave is NEVER the whole multi-round goal. The project
        // settles only on an explicit complete decision with every required worker
        // succeeded; a block decision blocks honestly; otherwise one more bounded
        // review round consumes the real results, and an exhausted round cap is an
        // honest failure rather than a fabricated completion.
        if (current.decision?.kind === 'complete' && this.#requiredAllSucceeded(current)) {
          await this.#complete(task.id, current, decision)
          return
        }
        if (current.decision?.kind === 'block') {
          await this.#block(task.id, current, { code: 'supervisor-project-blocked', message: current.decision.reason || 'the supervisor recorded a blocked decision' })
          return
        }
        const roundsLeft = (current.roundsUsed ?? 0) < current.grant.maxRounds
        const allowanceLeft = this.#remainingToolAllowance(current) > 0
        let started = null
        if (roundsLeft && allowanceLeft) {
          started = await this.#startRound(task.id, current)
          if (started.started === true) {
            this.#save(task.id, this.#store.get(task.id).project, 'project/round-started', { round: started.round, allowance: started.allowance })
            return
          }
          this.#save(task.id, current, 'project/round-not-started', { reason: started.reason ?? 'unknown', roundsUsed: current.roundsUsed ?? 0 })
          if (started.reason === 'round-unproven' || started.reason === 'plan-conflict' || started.reason === 'round-in-flight') return
        }
        if (current.decision?.kind === 'complete') {
          await this.#failCleanly(task.id, current, { code: 'project-unfinished-required', message: 'the complete decision was recorded but not every required worker succeeded' })
          return
        }
        const stopReason = started?.reason ?? (allowanceLeft !== true ? 'project-tool-budget' : roundsLeft !== true ? 'round-cap' : 'unknown')
        if (stopReason === 'project-tool-budget') {
          await this.#failCleanly(task.id, current, { code: 'project-tool-budget-exhausted', message: `no remaining tool allowance can fund another supervisor round; the project reached ${this.#toolBound(current)} of ${current.grant.maxTotalToolCalls}` })
          return
        }
        if (stopReason === 'deadline') {
          await this.#failCleanly(task.id, current, { code: 'project-deadline-exceeded', message: `the project deadline of ${current.grant.timeoutMs}ms elapsed since admission; no further round is started` })
          return
        }
        await this.#failCleanly(task.id, current, { code: 'supervisor-rounds-exhausted', message: `the project used all ${current.grant.maxRounds} granted supervisor round(s) (${stopReason ?? 'round-cap'}) without a complete decision; the first wave is not reported as the whole goal` })
        return
      }
      await this.#complete(task.id, current, decision)
      return
    }
    // Still pending: if no immutable budget can fund the remaining work, the project
    // settles honestly instead of waiting forever on queued workers — but ONLY once no
    // admitted work is still live. An exhausted START cap while every already admitted
    // worker is still LIVE is not an exhausted remaining plan: `budgets.starts` counts
    // admissions, so the cap can equal the number of running workers while nothing is
    // left to start. Failing or gating here would emit a false serious-issue callback
    // (`clean-stop-unproven`) before the real completion.
    if (!this.#startBudgetAllows(current)) {
      if (this.#hasLiveWork(current)) {
        this.#save(task.id, current, 'project/live-work-settling', { live: live.length, retryable: decision.retryable.length, unfunded: this.#hasUnfundedWork(current) })
        return
      }
      await this.#failCleanly(task.id, current, { code: 'project-budget-exhausted', message: sweep.reasons.join('; ') || 'the project budget cannot fund the remaining plan' })
      return
    }
    this.#save(task.id, current, 'project/pending', { retryable: decision.retryable.length, live: live.length })
  }

  /**
   * Mark every attempt/worker the project budget cannot fund, so aggregation sees an
   * exhausted plan instead of pending work.
   * @param {object} project - current project record.
   * @returns {{mutated: boolean, reasons: string[]}} sweep verdict.
   */
  #budgetSweep(project) {
    const reasons = []
    let mutated = false
    // An exhausted immutable cap with admitted work still LIVE is NOT an exhausted
    // remaining plan: that work was already funded and can still settle (and release its
    // reserved allowance). Marking unfunded work permanently refused now would flip the
    // aggregate to `failed` and drive a cancellation/clean-stop gate while merely
    // expected-live work still runs. The sweep therefore waits, and the next evaluation
    // after a verified settlement records the honest refusal.
    if (this.#hasLiveWork(project)) return { mutated, reasons }
    for (const worker of project.workers) {
      if (worker.cancelRequested) continue
      const attempts = worker.attempts
      if (attempts.length === 0) {
        // A never-started worker is exhausted only by a spent grant, an unfundable start
        // or an elapsed deadline. Allowance merely reserved by unstopped work is NOT
        // exhaustion: that work's verified stop may still release it.
        if (this.#deadlineElapsed(project) || this.#toolSpendExhausted(project) || project.budgets.starts >= project.grant.maxWorkerStarts) {
          reasons.push(`${worker.workerKey} was never started: the project budget cannot fund it`)
          mutated = true
        }
        continue
      }
      const last = attempts[attempts.length - 1]
      if (last.retryBlocked === true) continue
      const ordinaryFailure = last.state === 'failed' || (last.state === 'cancelled' && last.cancelRequested !== true)
      if (!ordinaryFailure) continue
      if (attempts.length >= 1 + project.grant.maxRepairAttempts) continue
      if (project.budgets.retries >= project.grant.maxTotalRetries) {
        last.retryBlocked = true
        last.budgetRefused = 'project-retry-budget'
        reasons.push(`${worker.workerKey} exhausted the project retry budget (${project.budgets.retries}/${project.grant.maxTotalRetries})`)
        mutated = true
        continue
      }
      if (!this.#startBudgetAllows(project)) {
        last.retryBlocked = true
        last.budgetRefused = this.#deadlineElapsed(project) ? 'project-deadline-exceeded' : 'project-start-budget'
        reasons.push(`${worker.workerKey} cannot be repaired: the project budget is exhausted`)
        mutated = true
      }
    }
    return { mutated, reasons }
  }

  /* ------------------------------------------- positive stop proofs & deadlines */

  /**
   * A stop count is proven only when the host reported an EXPLICIT numeric zero. A
   * missing/null/unknown count is never coerced to zero; anything else (including a
   * positive count) means the stop is not proven.
   * @param {unknown} value - host-reported count.
   * @returns {boolean} true only for an explicit numeric zero.
   */
  #countIsZero(value) {
    return Number.isInteger(value) && value === 0
  }

  /**
   * Resolve the round's OWNED child count and provenance BEFORE its stop proof is
   * persisted. An explicit host value (including an explicit `null` = unknown) is recorded
   * verbatim; a merely OMITTED count is resolved from the real wired child manager, and
   * only a host with NO child manager at all may treat zero children as the legacy
   * authoritative value. A configured manager that cannot inspect — because it throws OR
   * because its inspector is missing — stays unknown; a missing inspector is never a zero,
   * or a phantom stopped round could release root capacity. The provenance names the
   * component actually consulted.
   * @param {string} taskId - the project task id.
   * @param {object} result - the settlement/round result.
   * @returns {{activeChildren: number|null, activeChildrenSource: string}}
   */
  #resolveRoundChildren(taskId, result) {
    const source = nonBlank(result?.activeChildrenSource) ? boundedText(result.activeChildrenSource, 40) : 'host-reported'
    const reported = result?.activeChildren
    if (reported !== undefined) {
      if (reported === null) return { activeChildren: null, activeChildrenSource: source }
      return { activeChildren: Number.isInteger(reported) && reported >= 0 ? reported : null, activeChildrenSource: source }
    }
    if (this.#supervisor === null) return { activeChildren: 0, activeChildrenSource: 'legacy-no-child-manager' }
    if (typeof this.#supervisor.liveChildren !== 'function') return { activeChildren: null, activeChildrenSource: 'owned-manager-unavailable' }
    try {
      return { activeChildren: this.#supervisor.liveChildren(taskId).length, activeChildrenSource: 'owned-manager' }
    } catch {
      return { activeChildren: null, activeChildrenSource: 'owned-manager-unavailable' }
    }
  }

  /**
   * Attempt-level stop proof: terminal status plus explicit numeric-zero jobs AND children.
   * An explicit `null` (and any absent/non-numeric count) is unknown, never zero.
   */
  #attemptStopped(task) {
    const status = typeof task?.status === 'string' ? task.status : 'unknown'
    if (!TERMINAL.has(status)) return false
    if (task?.stopConfirmed !== true) return false
    if (!this.#countIsZero(task?.activeJobs)) return false
    if (!this.#countIsZero(task?.activeChildren)) return false
    return true
  }

  /** Supervisor-round stop proof: flagged stop plus explicit numeric-zero jobs AND children. */
  #roundStopped(round) {
    if (!isPlainObject(round)) return false
    if (round.stopConfirmed !== true) return false
    if (!this.#countIsZero(round.activeJobs)) return false
    if (!this.#countIsZero(round.activeChildren)) return false
    return true
  }

  /** The last recorded supervisor round, or null. */
  #lastRound(project) {
    const rounds = Array.isArray(project?.rounds) ? project.rounds : []
    return rounds[rounds.length - 1] ?? null
  }

  /**
   * Liveness of the supervisor's OWN model round. A recorded round is authoritative: it
   * is stopped only with explicit numeric-zero job AND child counts. With NO recorded
   * round, the only clean case is work that positively never crossed the host boundary
   * (queued, no dispatch marker, no session receipt) or a terminal record that is
   * positively stopped with explicit numeric zeros for both counts; a running/starting/
   * dispatched or ambiguous root is unknown, never clean.
   * @param {object} task - the project task record.
   * @param {object} project - its project record.
   * @returns {{stopped: boolean, live: boolean, unknown: boolean, reason: string}}
   */
  #roundLiveness(task, project) {
    const last = this.#lastRound(project)
    if (last !== null) {
      // The recorded round's stop proof binds the EXACT current attempt: its attemptId must
      // be nonblank and equal to the task's real store-minted identity. A round whose
      // identity is missing or belongs to a superseded attempt proves nothing about the
      // current attempt, so it is unproven — never a synthetic stop.
      const boundToCurrentAttempt = nonBlank(last.attemptId) && last.attemptId === task?.attemptId
      const stopped = boundToCurrentAttempt && this.#roundStopped(last)
      return {
        stopped,
        live: false,
        unknown: stopped !== true,
        reason: boundToCurrentAttempt ? 'recorded-round' : 'round-attempt-unproven'
      }
    }
    const status = typeof task?.status === 'string' ? task.status : 'unknown'
    const dispatched = task?.dispatchStarted === true || task?.dispatchPending === true || nonBlank(task?.sessionId) || Number.isFinite(task?.dispatchReceiptAt)
    if (status === 'queued' && dispatched !== true) {
      return { stopped: true, live: false, unknown: false, reason: 'never-dispatched' }
    }
    if (TERMINAL.has(status) && task?.stopConfirmed === true && this.#countIsZero(task?.activeJobs) && this.#countIsZero(task?.activeChildren)) {
      return { stopped: true, live: false, unknown: false, reason: 'terminal-stop' }
    }
    if (status === 'starting' || status === 'running' || status === 'cancelling') {
      return { stopped: false, live: true, unknown: true, reason: 'round-live' }
    }
    return { stopped: false, live: false, unknown: true, reason: 'round-unproven' }
  }

  /**
   * The central clean-terminal guard: a clean completion/failure/cancellation requires
   * BOTH the supervisor round's positive stop proof AND every owned attempt's positive
   * stop proof. Callers never assume either.
   * @param {object} task - fresh project task record.
   * @param {object} project - its project record.
   * @returns {{round: object, live: Array, clean: boolean}}
   */
  #cleanStopProof(task, project) {
    const round = this.#roundLiveness(task, project)
    const live = this.#unstopped(task)
    // Binding-checked unaccounted owned work joins the central proof. `#unstopped` alone
    // treats ANY readable stopped record as a resolved owned stop, so a foreign task whose
    // id an attempt merely claims (or an unreadable one) could otherwise complete, cancel
    // or release this project on a stop proof that says nothing about it. Merged here by
    // worker/attempt identity so the same unresolved piece is never counted twice.
    const seen = new Set(live.map((item) => `${item.workerKey}|${item.attempt}`))
    for (const item of this.#recoveryOwnedWork(task).unaccounted) {
      const identity = `${item.workerKey}|${item.attempt}`
      if (seen.has(identity)) continue
      seen.add(identity)
      live.push(item)
    }
    return { round, live, clean: round.stopped === true && live.length === 0 }
  }

  /**
   * Whether a ROOT task record itself carries a POSITIVE stop: terminal status, confirmed
   * stop and an EXPLICIT numeric zero for both jobs and children. Used to decide whether a
   * later unavailable inspector may be ignored; a missing/null child count is unknown and
   * never counts as proof.
   */
  #rootPositivelyStopped(task) {
    const status = typeof task?.status === 'string' ? task.status : 'unknown'
    if (!TERMINAL.has(status)) return false
    if (task?.stopConfirmed !== true) return false
    if (!this.#countIsZero(task?.activeJobs)) return false
    if (!this.#countIsZero(task?.activeChildren)) return false
    return true
  }

  /** Time elapsed since project ADMISSION (planning time counts). Never negative. */
  #elapsed(project) {
    const created = Number.isFinite(project?.createdAt) ? project.createdAt : this.#now()
    return Math.max(0, this.#now() - created)
  }

  #deadlineExceeded(project) {
    return this.#elapsed(project) >= project.grant.timeoutMs
  }

  /**
   * The project deadline is over, whether by elapsed wall time or by an expiry already
   * fired and persisted by this or a previous process. A late start is refused in both
   * cases: once the deadline has fired, no queued worker may still be admitted.
   */
  #deadlineElapsed(project) {
    return this.#deadlineExceeded(project) || project?.deadlines?.expired === true
  }

  /** Arm the single per-project admission deadline. Idempotent per live timer. */
  #armDeadline(taskId) {
    if (this.#closed) return
    if (taskId === undefined || taskId === null) return
    let project
    try {
      project = this.#store.get(taskId)?.project
    } catch {
      return
    }
    if (!project || PROJECT_TERMINAL.has(project.status)) return
    // Live timer ownership in THIS process is the only proof a deadline is armed. A
    // persisted `deadlines.armed` flag left by a previous process is never trusted, so
    // recovery re-arms every active project with a real timer.
    if (this.#timers.has(taskId)) return
    const remaining = project.grant.timeoutMs - this.#elapsed(project)
    const delay = remaining > 0 ? remaining : 0
    const timer = this.#setTimer(() => {
      this.#deadlineExpiry.add(taskId)
      void this.#kick(taskId)
    }, delay)
    this.#timers.set(taskId, timer)
    this.#mutate(taskId, (fresh) => {
      fresh.project.deadlines = {
        ...(isPlainObject(fresh.project.deadlines) ? fresh.project.deadlines : {}),
        armed: true,
        expired: fresh.project.deadlines?.expired === true,
        firedAt: fresh.project.deadlines?.firedAt ?? null
      }
      return fresh
    }, 'project/deadline-armed', { delayMs: delay })
  }

  #clearDeadline(taskId) {
    const timer = this.#timers.get(taskId)
    if (timer !== undefined) {
      this.#clearTimer(timer)
      this.#timers.delete(taskId)
    }
    this.#deadlineExpiry.delete(taskId)
  }

  /**
   * Mark the project deadline expired once, stop the ACTUAL supervisor round and every
   * live owned worker through the service, and let the serialized transition converge on
   * real stop proofs. Timer expiry alone never certifies a stop; this method never
   * awaits its own chain.
   */
  async #expireDeadline(taskId) {
    this.#deadlineExpiry.delete(taskId)
    const task = this.#store.get(taskId)
    const project = task.project
    if (!project || PROJECT_TERMINAL.has(project.status)) return
    project.deadlines = { armed: true, expired: true, firedAt: project.deadlines?.firedAt ?? this.#now() }
    project.seriousIssue = { code: 'project-deadline-exceeded', message: `the project deadline of ${project.grant.timeoutMs}ms elapsed since admission`, at: this.#now() }
    // A planner that never froze the plan is time-bounded too: the project stops waiting
    // on a silent supervisor and settles honestly instead of hanging in `planning`.
    if (project.status === 'planning') {
      project.status = project.frozenAt === null && project.workers.length === 0 ? 'frozen' : 'dispatching'
    }
    this.#save(taskId, project, 'project/deadline-expired', { timeoutMs: project.grant.timeoutMs })
    // Stop the ACTUAL supervisor round through the service when it is live; the round's
    // real stop callback (or its honest unknown) is what later evaluation consumes.
    const current = this.#store.get(taskId)
    if (this.#service !== null && this.#roundLiveness(current, current.project).live === true) {
      try {
        await this.#service.cancel(taskId, 'project deadline exceeded')
      } catch {
        // The unconfirmed stop is handled by the next evaluation; nothing is fabricated.
      }
    }
    if (this.#service === null) return
    const live = this.#unstopped(this.#store.get(taskId))
    for (const item of live) {
      if (!nonBlank(item.taskId)) continue
      try {
        await this.#service.cancel(item.taskId, 'project deadline exceeded')
      } catch {
        // The unconfirmed stop is handled by the next evaluation; nothing is fabricated.
      }
    }
  }

  /* ------------------------------------------------ shared tool-call allowance */

  /**
   * Observed SUPERVISOR round spend, counted exactly once: the cumulative
   * `budgets.supervisorToolSpend` once a round has been charged. A LEGACY record that
   * only carries the historical `supervisorToolCalls` observation is read through that
   * key instead — never in addition to it.
   */
  #supervisorSpend(project) {
    const budgets = project?.budgets ?? {}
    if (Number.isInteger(budgets.supervisorToolSpend)) return budgets.supervisorToolSpend
    return Number.isInteger(budgets.supervisorToolCalls) ? budgets.supervisorToolCalls : 0
  }

  /**
   * The full allowance of the round currently crossing the host boundary, or 0 when no
   * round is reserved. `budgets.supervisorReserved` is persisted BEFORE any dispatch, so
   * a crash can never re-promise the same calls.
   */
  #supervisorReserved(project) {
    const reserved = project?.budgets?.supervisorReserved
    if (Number.isInteger(reserved)) return reserved
    return Number.isInteger(project?.pendingRound?.grantedToolCalls) ? project.pendingRound.grantedToolCalls : 0
  }

  /**
   * Canonical OBSERVED spend, counted exactly ONCE per item: supervisor round spend plus
   * each stop-proven worker attempt's actual calls (credited at release). Live/unverified
   * work is represented by its own full reservation in `#toolBound` below, never by a
   * second copy of its observed calls.
   */
  #toolSpend(project) {
    const released = Number.isInteger(project.budgets?.toolSpend) ? project.budgets.toolSpend : 0
    return this.#supervisorSpend(project) + released
  }

  /**
   * Calls already promised to work that has not proven a stop (or never started): the
   * in-flight supervisor round's full allowance plus every unstopped worker attempt's
   * full granted cap. Each outstanding reservation is counted exactly once, and an item
   * moves from its reserved bucket to its spend bucket exactly once at its own verified
   * stop, so nothing is double charged and nothing is dropped.
   */
  #reservedToolCalls(project) {
    let total = 0
    for (const worker of project.workers) {
      for (const attempt of worker.attempts) {
        // Every attempt that has NOT proven a stop keeps its whole allowance reserved,
        // whatever its live/queued/dispatching/unknown state is.
        if (attempt.toolAllowanceReleased === true) continue
        total += Number.isInteger(attempt.grantedToolCalls) ? attempt.grantedToolCalls : 0
      }
    }
    return total
  }

  /** The always-safe hard bound: observed spend plus every outstanding reservation. */
  #toolBound(project) {
    return this.#toolSpend(project) + this.#supervisorReserved(project) + this.#reservedToolCalls(project)
  }

  /** Remaining unreserved allowance the grant can still promise, or 0. */
  #remainingToolAllowance(project) {
    return Math.max(0, project.grant.maxTotalToolCalls - this.#toolBound(project))
  }

  /**
   * Whether the spend ALONE has reached the grant: no outstanding reservation can ever
   * release enough to fund new work. This is the only tool-budget condition that may
   * refuse a queued worker outright.
   */
  #toolSpendExhausted(project) {
    return this.#toolSpend(project) >= project.grant.maxTotalToolCalls
  }

  /**
   * Release one attempt's reserved allowance with its verified stop proof, crediting the
   * observed spend. Without a stop proof nothing is released.
   */
  #releaseToolAllowance(taskId, workerKey, attemptNumber, stopConfirmed) {
    if (stopConfirmed !== true) return false
    let released = false
    this.#mutate(taskId, (fresh) => {
      const worker = fresh.project.workers.find((candidate) => candidate.workerKey === workerKey)
      const attempt = worker?.attempts.find((entry) => entry.attempt === attemptNumber)
      if (attempt === undefined || attempt.toolAllowanceReleased === true) return fresh
      attempt.toolAllowanceReleased = true
      // A stop-proven attempt credits its ACTUAL spend exactly once. A missing or
      // unreadable stats receipt is charged the FULL granted cap instead of zero, so the
      // released reservation is never recycled as free budget.
      const granted = Number.isInteger(attempt.grantedToolCalls) && attempt.grantedToolCalls > 0 ? attempt.grantedToolCalls : 0
      let calls = granted
      if (nonBlank(attempt.taskId)) {
        try {
          const observed = Number(this.#store.get(attempt.taskId).stats?.toolCalls)
          if (Number.isInteger(observed) && observed >= 0) calls = observed
        } catch {
          // Unreadable receipt: charge the FULL granted cap once, never zero.
        }
      }
      fresh.project.budgets = { ...fresh.project.budgets, toolSpend: (Number.isInteger(fresh.project.budgets?.toolSpend) ? fresh.project.budgets.toolSpend : 0) + calls }
      released = true
      return fresh
    }, null, null)
    return released
  }

  /**
   * Charge ONE positively stopped supervisor round exactly once. The round's spend is a
   * DELTA of the cumulative store counter (`stats.toolCalls - round.baselineToolCalls`),
   * so an already cumulative total is never summed twice. Unreadable stats conservatively
   * consume the FULL reserved cap. The reservation moves to observed spend in the same
   * single write, so no call is counted in both buckets.
   * @returns {{actual: number|null, spend: number, reserved: number}} charge verdict.
   */
  #chargeRound(project, { pending, stats, baseline, granted }) {
    const observedBefore = this.#supervisorSpend(project)
    let actual = null
    if (stats !== null) actual = Math.max(0, stats - baseline)
    else if (granted !== null) actual = granted
    if (actual === null) {
      // A legacy round with an unreadable receipt keeps the historical shape: the
      // observation is recorded as unknown and no calls are fabricated.
      project.budgets = { ...project.budgets, supervisorToolCalls: null }
      return { actual: null, spend: observedBefore, reserved: this.#supervisorReserved(project) }
    }
    const reserved = this.#supervisorReserved(project)
    const nextReserved = granted === null ? reserved : Math.max(0, reserved - granted)
    project.budgets = {
      ...project.budgets,
      supervisorToolSpend: observedBefore + actual,
      supervisorReserved: nextReserved,
      // Historical observation field (informational only): `#supervisorSpend` prefers the
      // cumulative `supervisorToolSpend` and never adds this key on top of it.
      supervisorToolCalls: stats !== null ? stats : (project.budgets?.supervisorToolCalls ?? null)
    }
    return { actual, spend: observedBefore + actual, reserved: nextReserved }
  }

  /**
   * One deterministic dispatch of a ready worker: every budget is checked BEFORE the
   * attempt is persisted or submitted, so a scheduling pass can never overshoot a cap.
   */
  async #dispatchAttempt(task, worker, attemptNumber, kind) {
    const verdict = await this.#startAttempt(task, worker, attemptNumber)
    if (verdict.started === true) return
    // A temporary reservation is NOT exhaustion: the unstopped work that holds the
    // allowance can still release it with a verified stop, so the worker stays pending
    // instead of being marked permanently refused.
    if (verdict.reason === 'project-tool-reserved') return
    this.#refuseAttempt(task, worker, attemptNumber, verdict.reason ?? (kind === 'repair' ? 'project-retry-budget' : 'project-start-budget'))
  }

  /** Persist a budget refusal so the next aggregation treats it as exhausted. */
  #refuseAttempt(task, worker, attemptNumber, reason) {
    const current = this.#store.get(task.id)
    const fresh = current.project.workers.find((candidate) => candidate.workerKey === worker.workerKey)
    if (fresh === undefined) return
    if (attemptNumber > 1) {
      // A repair the worker proved it may start cannot be funded: mark the ALREADY-FAILED
      // prior attempt retryBlocked so aggregation sees exhaustion. A synthetic second
      // attempt would hide the real failure behind a fabricated identity.
      const last = fresh.attempts[fresh.attempts.length - 1]
      if (last !== undefined && last.retryBlocked !== true) {
        last.retryBlocked = true
        last.budgetRefused = reason
        this.#save(task.id, current.project, 'project/attempt-budget-refused', { workerKey: worker.workerKey, attempt: last.attempt, reason })
      }
      return
    }
    // A never-started worker: record the refusal as an explicit failed attempt so the
    // plan settles instead of waiting forever on work the project can no longer fund.
    if (fresh.attempts.length >= attemptNumber) return
    if (fresh.cancelledBeforeDispatch === true) return
    fresh.attempts.push({
      attempt: attemptNumber,
      idempotencyKey: workerAttemptKey(task.id, worker.workerKey, attemptNumber),
      state: 'failed',
      taskId: null,
      sessionId: null,
      cancelRequested: false,
      stopConfirmed: true,
      activeJobs: 0,
      retryBlocked: true,
      budgetRefused: reason,
      settledAt: this.#now(),
      error: { code: 'PROJECT_BUDGET_REFUSED', message: `${reason}: the project budget cannot fund this worker` }
    })
    fresh.state = 'failed'
    this.#save(task.id, current.project, 'project/attempt-budget-refused', { workerKey: fresh.workerKey, attempt: attemptNumber, reason })
  }

  /** In-place store edit on the freshest persisted snapshot; never clobbers it. */
  #mutate(taskId, fn, eventType, extra) {
    const next = this.#store.update(taskId, (latest) => fn(latest))
    if (nonBlank(eventType)) {
      this.#store.event(taskId, { type: eventType, projectStatus: next?.project?.status ?? null, ...(isPlainObject(extra) ? safe(extra) : {}) })
    }
    return next
  }

  async #cancelLive(task, live, reason) {
    for (const item of live) {
      // This cancellation is the ORCHESTRATOR converging on an already-decided failure:
      // it must never look like an ordinary failure that could be retried. The mark is
      // applied to a FRESH snapshot so a settlement that landed meanwhile is preserved.
      const current = this.#store.get(task.id)
      const worker = current.project.workers.find((candidate) => candidate.workerKey === item.workerKey)
      const attempt = worker?.attempts.find((entry) => entry.attempt === item.attempt)
      if (attempt !== undefined && attempt.retryBlocked !== true) {
        attempt.retryBlocked = true
        this.#save(task.id, current.project, 'project/live-cancel-requested', { workerKey: item.workerKey, attempt: item.attempt })
      }
      if (!nonBlank(item.taskId)) continue
      try {
        await this.#service.cancel(item.taskId, reason)
      } catch {
        // The unconfirmed stop is handled by the next evaluation; nothing is fabricated.
      }
    }
  }

  #releaseModelReservation(id) {
    if (this.#supervisor === null) return false
    const key = `task:${id}`
    if (!this.#supervisor.ledger.has(key)) return false
    return this.#supervisor.ledger.release(key, { stopConfirmed: true, reason: 'supervisor model round positively stopped; the project continues' })
  }

  /** Non-terminal, capacity-retaining blocked state: never a fabricated stop. */
  async #block(id, project, issue) {
    project.status = 'blocked'
    project.seriousIssue = { code: issue.code, message: boundedText(issue.message, 500), at: this.#now() }
    project.endedAt = null
    // Owned work that was never verified keeps EVERY held reservation counted, including
    // the supervisor's own slot when the round's stop was not proven.
    const key = `task:${id}`
    if (this.#supervisor !== null && this.#supervisor.ledger.has(key)) {
      this.#supervisor.ledger.markUnknown(key, `project blocked: ${issue.code}`)
    }
    const task = this.#store.get(id)
    const live = this.#unstopped({ ...task, project })
    project.ownedUnstopped = live.length
    const decision = project.aggregate ?? { status: 'unknown', requiredFailed: [], unknown: project.workers.map((worker) => worker.workerKey), optionalDegraded: [], cancelled: [], reasons: [] }
    const summary = aggregateSummary(project, { requiredFailed: [], unknown: [], optionalDegraded: [], cancelled: [], reasons: [], retryable: [], ...decision }, [`serious issue ${issue.code}: ${issue.message}`])
    this.#save(id, project, 'project/serious-issue', { code: issue.code, ownedUnstopped: live.length })
    this.#store.update(id, {
      status: 'unknown',
      phase: 'project',
      stopConfirmed: false,
      activeJobs: 0,
      activeChildren: 0,
      result: { text: summary, evidence: live.slice(0, 32), checks: [], uncertainties: [`project blocked: ${issue.code}`] }
    })
    await this.#notify(id, 'serious-issue', 'failed', summary)
  }

  /** Clean stopped failure: every owned stop is proven. */
  async #failCleanly(id, project, issue) {
    // A clean terminal is never fabricated from caller assumptions: the supervisor round
    // AND every owned attempt must carry a positive stop proof. Otherwise this fails
    // closed into the honest, capacity-retaining blocked state.
    const task = this.#store.get(id)
    const proof = this.#cleanStopProof(task, project)
    if (proof.clean !== true) {
      await this.#block(id, project, { code: 'clean-stop-unproven', message: `refusing a clean failure: round ${proof.round.reason} with ${proof.live.length} unstopped owned task(s)` })
      return
    }
    project.status = 'failed'
    project.seriousIssue = { code: issue.code, message: boundedText(issue.message, 500), at: this.#now() }
    project.endedAt = this.#now()
    project.ownedUnstopped = 0
    this.#clearDeadline(id)
    const decision = project.aggregate ?? { status: 'failed' }
    const summary = aggregateSummary(project, { requiredFailed: [], unknown: [], optionalDegraded: [], cancelled: [], retryable: [], reasons: [], ...decision }, [`failed: ${issue.message}`])
    this.#save(id, project, 'project/failed', { code: issue.code })
    this.#store.update(id, {
      status: 'failed',
      phase: 'project',
      stopConfirmed: true,
      activeJobs: 0,
      activeChildren: 0,
      endedAt: this.#now(),
      result: { text: summary, evidence: [], checks: [], uncertainties: [] }
    })
    await this.#notify(id, 'completion', 'failed', summary)
  }

  async #complete(id, project, decision) {
    // The same central proof as a clean failure: a completion is only recorded when the
    // supervisor round and every owned attempt carry positive stop proof.
    const completedTask = this.#store.get(id)
    const proof = this.#cleanStopProof(completedTask, project)
    if (proof.clean !== true) {
      await this.#block(id, project, { code: 'clean-stop-unproven', message: `refusing a clean completion: round ${proof.round.reason} with ${proof.live.length} unstopped owned task(s)` })
      return
    }
    project.status = 'completed'
    project.endedAt = this.#now()
    project.ownedUnstopped = 0
    this.#clearDeadline(id)
    const summary = aggregateSummary(project, { requiredFailed: [], unknown: [], optionalDegraded: [], cancelled: [], retryable: [], reasons: [], ...decision })
    const evidence = []
    const uncertainties = []
    for (const worker of project.workers) {
      const last = worker.attempts[worker.attempts.length - 1]
      evidence.push({
        workerKey: worker.workerKey,
        attempt: last?.attempt ?? 0,
        taskId: last?.taskId ?? null,
        stopConfirmed: last?.stopConfirmed === true,
        resultDigest: last?.resultDigest ?? null,
        inspect: last?.inspect ?? null
      })
      if (last?.inspect?.dirty === true) uncertainties.push(`worker ${worker.workerKey} left uncommitted changes: ${(last.inspect.changedPaths ?? []).join(', ')}`)
      if (last?.inspect?.outcome === 'unknown' || last?.inspect?.outcome === 'unsupported') uncertainties.push(`worker ${worker.workerKey} workspace state is ${last.inspect.outcome}`)
      if (worker.required === false && worker.state !== 'succeeded') uncertainties.push(`optional worker ${worker.workerKey} did not succeed (${worker.state})`)
    }
    this.#save(id, project, 'project/completed', { workers: project.workers.length })
    this.#store.update(id, {
      status: 'completed',
      phase: 'project',
      stopConfirmed: true,
      activeJobs: 0,
      activeChildren: 0,
      endedAt: this.#now(),
      result: { text: summary, evidence, checks: [], uncertainties }
    })
    await this.#notify(id, 'completion', 'completed', summary)
  }

  /** One durable callback per outcome class through the immutable binding. */
  async #notify(id, outcomeClass, wireKind, summary) {
    const task = this.#store.get(id)
    const project = task.project
    if (project.callbacks?.[outcomeClass] !== undefined) return project.callbacks[outcomeClass]
    const aggregateHash = aggregateDigest(project.workers)
    const eventId = projectCallbackEventId({ taskId: id, attemptId: task.attemptId, outcomeClass, aggregateHash })
    const boundedSummary = boundedText(summary, this.#config.summaryChars ?? MAX_PROJECT_SUMMARY_CHARS)
    project.callbacks = { ...(project.callbacks ?? {}), [outcomeClass]: { eventId, wireKind, summary: boundedSummary, at: this.#now(), delivery: 'pending' } }
    this.#save(id, project, 'project/callback-planned', { outcomeClass, eventId })
    const binding = isPlainObject(task.callbackBinding) ? task.callbackBinding : null
    if (binding === null || !nonBlank(binding.targetId)) {
      project.callbacks[outcomeClass] = { ...project.callbacks[outcomeClass], delivery: 'ungranted', outcome: 'ungranted' }
      this.#save(id, project, 'project/callback-ungranted', { outcomeClass })
      return project.callbacks[outcomeClass]
    }
    if (this.#supervisor === null || typeof this.#supervisor.notifyProjectOutcome !== 'function') {
      project.callbacks[outcomeClass] = { ...project.callbacks[outcomeClass], delivery: 'unsupported', outcome: 'unsupported' }
      this.#save(id, project, 'project/callback-unsupported', { outcomeClass })
      return project.callbacks[outcomeClass]
    }
    let verdict
    try {
      verdict = await this.#supervisor.notifyProjectOutcome({ task: this.#store.get(id), outcome: outcomeClass, wireKind, summary: boundedSummary, eventId })
    } catch (error) {
      verdict = { outcome: 'unknown', delivery: 'unknown', error: { code: (error && error.code) || 'NOTIFY_ERROR', message: boundedText(String((error && error.message) || error), 300) } }
    }
    const current = this.#store.get(id)
    current.project.callbacks[outcomeClass] = {
      ...current.project.callbacks[outcomeClass],
      outcome: verdict?.outcome ?? 'unknown',
      delivery: verdict?.delivery ?? 'unknown',
      delivered: verdict?.delivered === true,
      ...(verdict?.error === undefined ? {} : { error: verdict.error })
    }
    this.#save(id, current.project, 'project/callback', { outcomeClass, outcome: verdict?.outcome ?? 'unknown', delivery: verdict?.delivery ?? 'unknown' })
    return current.project.callbacks[outcomeClass]
  }
}

export default SupervisorProjectRuntime
