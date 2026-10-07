/**
 * Bounded DSH runtime adapter (CONTRACTS.md section "DSH adapter seam",
 * integration interface fixed by the root's `src/service.mjs`).
 *
 * `new DshAdapter(ctx, options)` builds a host-side adapter that drives real
 * DeepSeek Harness sessions through the installed host services and enforces a
 * task packet's declared scope BEFORE any tool body runs. Every enforcement
 * claim here is grounded in an installed 0.1.5-rc.2 seam; see
 * `evidence/adapter-worker.md` for exact files, lines and quoted source.
 *
 * Design rules honoured here:
 *  - Fail closed. A packet whose scope cannot be enforced is rejected before a
 *    session is created; nothing is silently widened and nothing is fabricated.
 *  - Host state is authority. The model never supplies execution evidence; every
 *    reported fact is read from host services, durable session history, or
 *    observed host events.
 *  - Enforcement is agent-scoped only. A guard or restriction registered on the
 *    plain host context would mask every agent in the process, so this adapter
 *    refuses to register one and fails closed instead.
 *  - Paths are fenced on CANONICAL paths. `realpathSync.native` resolves symlinks
 *    and Windows junctions; a target that does not exist yet is resolved through
 *    its nearest existing ancestor. Unresolvable and dangling-symlink paths are
 *    denied rather than trusted.
 *  - JSON only across the boundary. Every returned value and every emitted event
 *    is a detached JSON-safe snapshot.
 *
 * Real enforcement seams used (installed source, see evidence file):
 *  - `@deepseek-ai/dsh-tools` monotonic guard registered through `agent.ctx`
 *    (`tools.guard`) — evaluated after `tools/pre-execute` and before the tool
 *    body; no listener can force-allow a denied call.
 *  - `tools.restrict({allow, deny})` through `agent.ctx` — removes non-allowlisted
 *    tools from the agent's visibility AND from dispatch resolution.
 *  - `agent.ctx.on('tools/pre-execute', ...)` — ordered waterfall fallback when
 *    `tools.guard` is unavailable.
 *  - `sessionController.prompt/selectModel/cancel/inspect/updateQueue` and the
 *    `session/event` feed for request binding, effective model, complete text,
 *    durable inspection, queue-item removal and observed stop confirmation.
 *  - `agents.create(...)` plus the CHILD AGENT'S OWN lifecycle API for bridge-owned
 *    child sessions: `childAgent.followup(createUserMessage(...))` is the only
 *    sanctioned delivery for a session with `origin: 'subagent'` (generic
 *    `sessionController.prompt`/`cancel` refuse it with the installed host's
 *    `session/agent-busy` "owned by subagent routing"), and `childAgent.cancel(...)`
 *    is the matching stop request. The returned owned `AgentHandle.dispose()` remains
 *    the teardown seam.
 *  - `ctx.jobs.list/get/kill` for owned background jobs (ownership verified per
 *    call against `JobSnapshot.ownerSession`).
 *  - `session.append('sandbox/mode', ...)` (the documented single write path) to
 *    pin a write-free task to `read-only`, enforced by the real filesystem sandbox.
 *  - `ctx.workspaceRegistry.archiveSession` for durable UI hiding of sessions the
 *    adapter owns and has observed as settled.
 *
 * @module dsh-codex-bridge/dsh-adapter
 */

import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { childGrantFor, callbackEventId } from './supervisor.mjs'
import { startCommandJob } from './command-jobs.mjs'
import { SUPERVISOR_PROJECT_TOOLS, SUPERVISOR_RECURRENT_TOOLS, SUPERVISOR_TOOL_HANDLERS, resolveProjectGrant } from './long-task.mjs'

/** Adapter implementation version (independent of the contract version). */
export const ADAPTER_VERSION = '0.5.0'
/**
 * Raw worker reply limit for `dsh_bridge_reply`. It is the pre-existing contract and
 * is validated BEFORE the controller-generated `[kind] ` prefix is added, so the
 * prefixed wire summary always fits the integration fence below.
 */
export const MAX_RAW_REPLY_CHARS = 8000
/**
 * Wire summary bound of the integrated producer path (`eventWake` passes this value
 * into the accepted wake outbox). The longest controller prefix (`[needs-input] `)
 * is 14 characters, so every accepted raw reply fits; a raw reply that could not fit
 * is REFUSED, never silently sliced.
 */
export const MAX_WIRE_REPLY_CHARS = 8192

/**
 * Flash default from AGENTS.md: the default delegated implementation route.
 * `options.defaultModel` overrides it; a route is never silently substituted.
 */
export const DEFAULT_MODEL = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' })

/** Requested budget defaults from CONTRACTS.md (TaskPacket, optional `budget`). */
export const DEFAULT_BUDGETS = Object.freeze({ timeoutMs: 600000, maxToolCalls: 100, maxOutputChars: 200000 })

/** Bounded wait for observed stop confirmation after a cancel request. */
export const DEFAULT_STOP_CONFIRM_TIMEOUT_MS = 5000

/** Poll interval for bounded stop confirmation. */
const CONFIRM_POLL_MS = 20

/** Hard cap on the adapter's in-memory event buffer per task (durable log remains complete). */
const MAX_BUFFERED_EVENTS = 5000

const ROLES = new Set(['investigate', 'implement', 'review', 'integrate'])

/**
 * Recursive-delegation tools in the installed `standard` agent preset. All of
 * them are denied for every bounded task: CONTRACTS.md fixes
 * `scope.allowDelegation: false`, and AGENTS.md forbids recursive delegation.
 */
export const DELEGATION_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'send_message',
  'interrupt_agent',
  'list_subagent_models',
  'list_agents',
  'ralph',
  'workflow'
])

/** Shell tools whose capability cannot be bounded to a task scope (see `capabilities()`). */
export const SHELL_TOOLS = Object.freeze(['bash', 'pwsh'])

/** Tools that reach the network; gated by `scope.allowNetwork` at tool level only. */
export const NETWORK_TOOLS = Object.freeze(['web_search', 'web_fetch'])

/**
 * The fixed model-facing delegation-scope statement the installed in-process child
 * driver registers in every child's creation window (the `SUBAGENT_DELEGATION_CONTEXT`
 * contribution of `@deepseek-ai/dsh-subagent`). Kept verbatim so a child composed by
 * this adapter states the same delegation boundary to its model.
 */
const SUBAGENT_DELEGATION_CONTEXT =
  'You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.'

/** Model-facing path argument names per filesystem tool (installed tool-fs / tool-fs-search). */
const FS_PATH_ARGS = Object.freeze({
  read: Object.freeze(['file_path', 'path']),
  read_image: Object.freeze(['file_path', 'path']),
  glob: Object.freeze(['path']),
  grep: Object.freeze(['path', 'paths']),
  write: Object.freeze(['file_path', 'path']),
  edit: Object.freeze(['file_path', 'path']),
  str_replace_editor: Object.freeze(['path', 'file_path'])
})

/** Filesystem tools that only read (checked against `scope.readRoots`). */
const FS_READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep'])

/** Filesystem tools that may mutate (checked against `scope.writeRoots`, plus the OS sandbox). */
const FS_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/**
 * Read tools whose path argument is OPTIONAL and defaults to the session cwd
 * (`glob`/`grep` run in `workdir` when no path is given). With no explicit path
 * claim the fence is applied to the default base, so a path-less search cannot
 * read outside `scope.readRoots`.
 */
const DEFAULT_BASE_READ_TOOLS = new Set(['glob', 'grep'])

/**
 * Tools the adapter can bound to the task without further authority: they touch
 * only the session's own model-visible state, never the filesystem, the network,
 * the job registry, or another agent.
 */
export const SAFE_SESSION_TOOLS = Object.freeze(['todo_write', 'present', 'ask_user_question', 'get_goal'])

/**
 * Installed tools whose capability cannot be bounded to a task scope in v1, with
 * the reason. They are rejected at plan time and denied by the guard, never
 * silently allowed as generic "other" tools.
 */
export const FORBIDDEN_TOOLS = Object.freeze({
  skill:
    'the skill tool loads SKILL.md bodies from skill roots that are outside the task\'s declared read roots, so its reads cannot be bounded',
  job_list:
    'ctx.jobs.list(caller) returns unowned jobs as well as the task\'s own, so its output cannot be bounded to the task scope',
  create_goal: 'creating a goal starts autonomous continuation rounds that outlive this bounded attempt',
  update_goal: 'updating a goal can arm or extend autonomous continuation rounds beyond this bounded attempt'
})

/** Tools that address one background job; the guard verifies per-call ownership. */
export const OWNED_JOB_TOOL_ARGS = Object.freeze({ job_output: 'job_id', job_kill: 'job_id' })

/**
 * Bridge-owned child-session tools (contract `supervisor-event-wake-v1`).
 *
 * They are registered into the AUTHORIZED PARENT agent's own scoped tool layer
 * only when the packet carries an explicit `scope.childSessions` grant and the
 * host enables child sessions. Native recursive delegation is never whitelisted:
 * these tools are the only delegation surface, they bind every call to the
 * executing agent's own task/attempt, and they are never offered to a child
 * (depth 1) or to an ordinary worker.
 */
export const CHILD_SESSION_TOOLS = Object.freeze([
  'dsh_child_spawn',
  'dsh_child_wait',
  'dsh_child_result',
  'dsh_child_cancel',
  'dsh_child_list'
])

/** Bridge-owned job tool: starts one granted, operator-approved command profile. */
export const BRIDGE_JOB_TOOLS = Object.freeze(['dsh_job_start'])

/** Bridge-owned root reply tool: needs-input reports to the trusted callback target. */
export const BRIDGE_REPLY_TOOLS = Object.freeze(['dsh_bridge_reply'])

/**
 * Supervisor-only long-task tools (contract `long-supervisor-first-edition-v1`).
 * They are registered into the AUTHORIZED SUPERVISOR agent's own scoped layer only when
 * the packet carries `project` AND the host enables `supervisorProjects`. Workers,
 * children and ordinary tasks never receive them: a nested plan would be a privilege
 * escalation, and a worker must not be able to reach the project manager.
 */
export const SUPERVISOR_PROJECT_TOOL_NAMES = Object.freeze([...SUPERVISOR_PROJECT_TOOLS])

const CHILD_SESSION_SET = new Set(CHILD_SESSION_TOOLS)
const BRIDGE_JOB_SET = new Set(BRIDGE_JOB_TOOLS)
const BRIDGE_REPLY_SET = new Set(BRIDGE_REPLY_TOOLS)
const SUPERVISOR_PROJECT_SET = new Set(SUPERVISOR_PROJECT_TOOL_NAMES)
const BRIDGE_TOOL_NAMES = new Set([...CHILD_SESSION_TOOLS, ...BRIDGE_JOB_TOOLS, ...BRIDGE_REPLY_TOOLS, ...SUPERVISOR_PROJECT_TOOL_NAMES])

const DELEGATION_SET = new Set(DELEGATION_TOOLS)
const SHELL_SET = new Set(SHELL_TOOLS)
const NETWORK_SET = new Set(NETWORK_TOOLS)
const SAFE_SESSION_SET = new Set(SAFE_SESSION_TOOLS)
const FORBIDDEN_REASONS = new Map(Object.entries(FORBIDDEN_TOOLS))
const OWNED_JOB_SET = new Set(Object.keys(OWNED_JOB_TOOL_ARGS))

/**
 * Every tool name this adapter classifies without a host catalog or coordinator
 * override, kept in the order the capability report has always listed refused
 * names (delegation, shell, `run_code`, forbidden, then the bounded kinds).
 * `run_code` is included because plan admission always refuses the reserved PTC
 * transport, which would re-expose every visible tool. This is the "static
 * names" half of the capability denied union; catalog names and classification
 * override names are added to it at report time.
 */
const STATIC_TOOL_NAMES = Object.freeze([
  ...DELEGATION_TOOLS,
  ...SHELL_TOOLS,
  'run_code',
  ...FORBIDDEN_REASONS.keys(),
  ...Object.keys(FS_PATH_ARGS),
  ...SAFE_SESSION_TOOLS,
  ...Object.keys(OWNED_JOB_TOOL_ARGS),
  ...NETWORK_TOOLS,
  ...CHILD_SESSION_TOOLS,
  ...BRIDGE_JOB_TOOLS,
  ...BRIDGE_REPLY_TOOLS,
  ...SUPERVISOR_PROJECT_TOOL_NAMES
])

const ESCALATION_ARG = 'sandbox_permissions'

/** Root-visible terminal status vocabulary (root `src/contracts.mjs` TERMINAL). */
const ROOT_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** Terminal child-session states. */
const CHILD_TERMINAL = new Set(['completed', 'failed', 'cancelled'])

// ---------------------------------------------------------------------------
// errors and small utilities
// ---------------------------------------------------------------------------

/**
 * Domain failure carrying a stable `.code`, per CONTRACTS.md.
 * @param {string} code - stable machine code.
 * @param {string} message - human-readable message (no secrets).
 * @param {object} [details] - JSON-safe structured detail.
 * @returns {Error} error with `code` and optional `details`.
 */
function adapterError(code, message, details) {
  const error = new Error(message)
  error.code = code
  error.dispatched = false
  if (details !== undefined) error.details = jsonSafe(details)
  return error
}

/**
 * Detach an arbitrary host value into a JSON-safe snapshot.
 * Cycles become `"[circular]"`, non-finite numbers become `null`, functions and
 * symbols are dropped, and the traversal depth is bounded. The input is never
 * mutated and no host object identity crosses the boundary.
 * @param {unknown} value - value to detach.
 * @returns {unknown} fresh JSON-safe value.
 */
export function jsonSafe(value, seen = new Set(), depth = 0) {
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
        const detached = jsonSafe(item, seen, depth + 1)
        out.push(detached === undefined ? null : detached)
      }
      return out
    }
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
    const out = {}
    for (const key of Object.keys(value)) {
      const detached = jsonSafe(value[key], seen, depth + 1)
      if (detached !== undefined) out[key] = detached
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/**
 * Whether a value is a JSON-style plain object.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for plain records.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Run a callback and contain any failure, reporting it through `onError`.
 * @param {() => unknown} fn - callback.
 * @param {(error: unknown) => void} [onError] - contained-failure sink.
 * @returns {unknown} the callback result, or `undefined` when it threw.
 */
function contained(fn, onError) {
  try {
    return fn()
  } catch (error) {
    if (onError !== undefined) onError(error)
    return undefined
  }
}

/**
 * Await a callback's promise, returning `fallback` when it rejects.
 * @param {() => Promise<unknown>} fn - async callback.
 * @param {unknown} fallback - value for a rejection.
 * @returns {Promise<unknown>} settled value.
 */
async function settleAsync(fn, fallback) {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/**
 * Bounded sleep.
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Minimal JSON-safe description of one queued session item for lifecycle
 * reporting. Every element counts as queued work regardless of `source.rpcId`
 * ownership, and a malformed element is still reported (with `id:null`) rather
 * than dropped, so an unexpected queue entry can never read as an empty queue.
 *
 * @param {unknown} message - queued inbox entry.
 * @param {'queued'|'steering'} placement - source list.
 * @returns {{id:string|null, placement:string, rpcId:string|null}} description.
 */
function strictQueueItem(message, placement) {
  return {
    id: isPlainObject(message) && typeof message.id === 'string' ? message.id : null,
    placement,
    rpcId:
      isPlainObject(message) && isPlainObject(message.source) && typeof message.source.rpcId === 'string' ? message.source.rpcId : null
  }
}

/** Case-insensitive on win32, case-sensitive elsewhere. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32'

/**
 * Whether `target` is `root` itself or nested inside it (both canonical).
 * @param {string} root - canonical root.
 * @param {string} target - canonical candidate.
 * @returns {boolean} containment verdict.
 */
export function isInside(root, target) {
  const rel = path.relative(root, target)
  if (rel === '') return true
  const verdict = rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  if (!verdict && CASE_INSENSITIVE_PATHS) {
    const lower = path.relative(root.toLowerCase(), target.toLowerCase())
    return lower === '' || (lower !== '..' && !lower.startsWith(`..${path.sep}`) && !path.isAbsolute(lower))
  }
  return verdict
}

/**
 * Whether two path spellings denote the same location (case-folded on win32).
 * @param {string} left - path.
 * @param {string} right - path.
 * @returns {boolean} verdict.
 */
export function isSamePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = path.resolve(left)
  const b = path.resolve(right)
  return CASE_INSENSITIVE_PATHS ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Whether a canonical path lies inside any of the given canonical roots.
 * @param {readonly string[]} roots - canonical roots.
 * @param {string} target - canonical candidate.
 * @returns {boolean} verdict.
 */
export function isInsideAny(roots, target) {
  for (const root of roots) if (isInside(root, target)) return true
  return false
}

/** Distinguishes "does not exist" from "cannot be inspected". */
const UNRESOLVABLE = Symbol('unresolvable-lstat')

function lstatOrSentinel(target) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return null
    return UNRESOLVABLE
  }
}

function realpathOrNull(target) {
  try {
    return realpathSync.native(target)
  } catch {
    return null
  }
}

/**
 * Canonicalize a model-supplied path for the security fence.
 *
 * - An existing target is resolved with `realpathSync.native`, which resolves
 *   symlinks AND Windows directory junctions, so a link that leaves the declared
 *   roots is detected.
 * - A target that does not exist yet is resolved through its NEAREST EXISTING
 *   ANCESTOR (also native-realpathed) with the remaining segments appended.
 * - A path whose nearest existing ancestor cannot be resolved (dangling symlink,
 *   reparse point, permission failure) is DENIED, never trusted.
 *
 * @param {string} rawPath - path spelling from a tool argument (untrusted).
 * @param {string} base - absolute base directory for relative paths.
 * @returns {{ok: true, path: string, existed: boolean, anchor: string} | {ok: false, code: string, reason: string}} verdict.
 */
export function canonicalTarget(rawPath, base) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { ok: false, code: 'EMPTY_PATH', reason: 'empty path' }
  }
  const trimmed = rawPath.trim()
  const absolute = path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(base, trimmed))
  const tail = []
  let cursor = absolute
  for (;;) {
    const info = lstatOrSentinel(cursor)
    if (info === UNRESOLVABLE) {
      return { ok: false, code: 'UNREADABLE_PATH', reason: `cannot inspect "${cursor}"` }
    }
    if (info !== null) {
      const real = realpathOrNull(cursor)
      if (real === null) {
        return {
          ok: false,
          code: 'UNRESOLVABLE_PATH',
          reason: `"${cursor}" exists but its real target cannot be resolved (dangling symlink or reparse point)`
        }
      }
      return {
        ok: true,
        path: tail.length === 0 ? real : path.join(real, ...tail),
        existed: tail.length === 0,
        anchor: real
      }
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return { ok: false, code: 'NO_ANCESTOR', reason: `"${absolute}" has no existing ancestor` }
    tail.unshift(path.basename(cursor))
    cursor = parent
  }
}

/**
 * Canonicalize a declared scope root. Roots are expected to be absolute; a root
 * that cannot be canonicalized is a fail-closed condition.
 * @param {string} root - declared root.
 * @param {string} base - fallback base (unused for absolute roots).
 * @returns {{ok: true, path: string} | {ok: false, code: string, reason: string}} verdict.
 */
export function canonicalRoot(root, base) {
  return canonicalTarget(root, base)
}

// ---------------------------------------------------------------------------
// task packet validation (all public inputs are untrusted)
// ---------------------------------------------------------------------------

function failField(field, message) {
  return adapterError('adapter/invalid-packet', `invalid task packet field "${field}": ${message}`, { field })
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw failField(field, 'expected a non-blank string')
  return value
}

function requireNonBlank(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw failField(field, 'expected a non-blank string')
  return value
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw failField(field, 'expected a boolean')
  return value
}

function requireStringArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw failField(field, 'expected an array of strings')
  if (!allowEmpty && value.length === 0) throw failField(field, 'expected a non-empty array')
  for (let i = 0; i < value.length; i += 1) requireNonBlank(value[i], `${field}[${i}]`)
  return value.slice()
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw failField(field, 'expected a positive integer')
  return value
}

/**
 * Validate a TaskPacket per CONTRACTS.md and return a detached, normalized copy.
 * No host state is touched here; this is pure untrusted-input validation.
 *
 * CONTRACTS.md's TaskPacket has no `id`; identity is the (id, revision) pair and
 * the packet's stable caller-minted identity is its `idempotencyKey`. A caller
 * that already owns a task record (the root store does) may pass `id`/`taskId`,
 * and that value wins over the derived one.
 *
 * @param {unknown} input - candidate packet.
 * @param {{contractVersion?: string}} [adapterOptions] - adapter-level expectation.
 * @returns {object} normalized packet.
 */
export function validateTaskPacket(input, adapterOptions = {}) {
  if (!isPlainObject(input)) throw adapterError('adapter/invalid-packet', 'task packet must be a plain object', {})
  if (input.schemaVersion !== 1) throw failField('schemaVersion', 'expected literal 1')

  const idempotencyKey = requireNonBlank(input.idempotencyKey, 'idempotencyKey')
  if (idempotencyKey.length > 200) throw failField('idempotencyKey', 'must be at most 200 characters')
  const explicitId =
    input.id !== undefined
      ? requireNonBlank(input.id, 'id')
      : input.taskId !== undefined
        ? requireNonBlank(input.taskId, 'taskId')
        : undefined
  const id = explicitId ?? idempotencyKey
  const revision = requirePositiveInteger(input.revision, 'revision')
  const projectId = requireNonBlank(input.projectId, 'projectId')
  const title = requireNonBlank(input.title, 'title')
  const objective = requireNonBlank(input.objective, 'objective')
  const cwd = requireNonBlank(input.cwd, 'cwd')
  if (!path.isAbsolute(cwd)) throw failField('cwd', 'must be an absolute path')
  const role = requireNonBlank(input.role, 'role')
  if (!ROLES.has(role)) throw failField('role', `must be one of ${[...ROLES].join('|')}`)
  const acceptance = requireStringArray(input.acceptance, 'acceptance', { allowEmpty: false })
  for (let i = 0; i < acceptance.length; i += 1) requireNonBlank(acceptance[i], `acceptance[${i}]`)

  if (!isPlainObject(input.scope)) throw failField('scope', 'expected a plain object')
  const scope = input.scope
  const readRoots = requireStringArray(scope.readRoots, 'scope.readRoots')
  const writeRoots = requireStringArray(scope.writeRoots, 'scope.writeRoots')
  const allowedTools = requireStringArray(scope.allowedTools, 'scope.allowedTools')
  const allowShell = requireBoolean(scope.allowShell, 'scope.allowShell')
  const allowNetwork = requireBoolean(scope.allowNetwork, 'scope.allowNetwork')
  if (scope.allowDelegation !== false) {
    throw failField('scope.allowDelegation', 'must be literal false: recursive delegation is not permitted')
  }

  if (!Array.isArray(input.materials)) throw failField('materials', 'expected an array')
  const materials = input.materials.map((material, index) => {
    if (!isPlainObject(material)) throw failField(`materials[${index}]`, 'expected a plain object')
    const out = {}
    if (material.path !== undefined) out.path = requireNonBlank(material.path, `materials[${index}].path`)
    if (material.text !== undefined) {
      requireString(material.text, `materials[${index}].text`)
      out.text = material.text
    }
    if (material.version !== undefined) out.version = requireNonBlank(material.version, `materials[${index}].version`)
    if (material.sha256 !== undefined) out.sha256 = requireNonBlank(material.sha256, `materials[${index}].sha256`)
    return out
  })

  const contractVersion = requireNonBlank(input.contractVersion, 'contractVersion')
  const expected = adapterOptions.contractVersion
  if (expected !== undefined && contractVersion !== expected) {
    throw adapterError(
      'adapter/contract-version',
      `task packet contractVersion "${contractVersion}" does not match this adapter's "${expected}"`,
      { expected, received: contractVersion }
    )
  }

  let model
  if (input.model !== undefined) {
    if (!isPlainObject(input.model)) throw failField('model', 'expected a plain object')
    model = {
      provider: requireNonBlank(input.model.provider, 'model.provider'),
      model: requireNonBlank(input.model.model, 'model.model')
    }
    if (input.model.reasoningEffort !== undefined) {
      model.reasoningEffort = requireNonBlank(input.model.reasoningEffort, 'model.reasoningEffort')
    }
  }

  let budget
  if (input.budget !== undefined) {
    if (!isPlainObject(input.budget)) throw failField('budget', 'expected a plain object')
    budget = {}
    for (const key of ['timeoutMs', 'maxToolCalls', 'maxOutputChars']) {
      if (input.budget[key] === undefined) continue
      budget[key] = requirePositiveInteger(input.budget[key], `budget.${key}`)
    }
  }

  let workspace
  if (input.workspace !== undefined) {
    if (!isPlainObject(input.workspace)) throw failField('workspace', 'expected a plain object')
    workspace = {
      repository: requireNonBlank(input.workspace.repository, 'workspace.repository'),
      baseRef: requireNonBlank(input.workspace.baseRef, 'workspace.baseRef')
    }
    if (input.workspace.branchName !== undefined) {
      workspace.branchName = requireNonBlank(input.workspace.branchName, 'workspace.branchName')
    }
  }

  let retention
  if (input.retention !== undefined) {
    if (!isPlainObject(input.retention)) throw failField('retention', 'expected a plain object')
    const successDays = input.retention.successDays
    const failureDays = input.retention.failureDays
    if (typeof successDays !== 'number' || !Number.isFinite(successDays) || successDays < 0) {
      throw failField('retention.successDays', 'expected a finite non-negative number')
    }
    if (typeof failureDays !== 'number' || !Number.isFinite(failureDays) || failureDays < 0) {
      throw failField('retention.failureDays', 'expected a finite non-negative number')
    }
    retention = { successDays, failureDays }
  }

  let metadata
  if (input.metadata !== undefined) {
    if (!isPlainObject(input.metadata)) throw failField('metadata', 'expected a plain object')
    metadata = jsonSafe(input.metadata)
  }

  // Additive optional grants (contract supervisor-event-wake-v1). They are
  // validated and CARRIED here, never dropped: the adapter's plan enforcement
  // reads them, and a malformed or widening grant is refused.
  let childSessions
  if (scope.childSessions !== undefined && scope.childSessions !== null) {
    const raw = scope.childSessions
    if (!isPlainObject(raw) || raw.enabled !== true) throw failField('scope.childSessions.enabled', 'must be exactly true to opt in')
    for (const key of Object.keys(raw)) {
      if (!['enabled', 'maxChildren', 'toolNames'].includes(key)) throw failField(`scope.childSessions.${key}`, 'is not a permitted field')
    }
    childSessions = { enabled: true }
    if (raw.maxChildren !== undefined) {
      if (!Number.isInteger(raw.maxChildren) || raw.maxChildren < 1 || raw.maxChildren > 16) {
        throw failField('scope.childSessions.maxChildren', 'expected an integer 1..16')
      }
      childSessions.maxChildren = raw.maxChildren
    }
    if (raw.toolNames !== undefined) {
      requireStringArray(raw.toolNames, 'scope.childSessions.toolNames')
      for (const name of raw.toolNames) {
        if (!allowedTools.includes(name)) throw failField('scope.childSessions.toolNames', `names "${name}" outside scope.allowedTools`)
      }
      childSessions.toolNames = [...raw.toolNames]
    }
  }

  let backgroundJobs
  if (scope.backgroundJobs !== undefined && scope.backgroundJobs !== null) {
    const raw = scope.backgroundJobs
    if (!isPlainObject(raw) || raw.enabled !== true) throw failField('scope.backgroundJobs.enabled', 'must be exactly true to opt in')
    for (const key of Object.keys(raw)) {
      if (!['enabled', 'profileIds', 'maxJobs'].includes(key)) throw failField(`scope.backgroundJobs.${key}`, 'is not a permitted field')
    }
    requireStringArray(raw.profileIds, 'scope.backgroundJobs.profileIds', { allowEmpty: false })
    const ids = raw.profileIds.map((id, index) => requireNonBlank(id, `scope.backgroundJobs.profileIds[${index}]`))
    if (new Set(ids).size !== ids.length) throw failField('scope.backgroundJobs.profileIds', 'must not repeat')
    backgroundJobs = { enabled: true, profileIds: ids }
    if (raw.maxJobs !== undefined) {
      if (!Number.isInteger(raw.maxJobs) || raw.maxJobs < 1 || raw.maxJobs > 16) {
        throw failField('scope.backgroundJobs.maxJobs', 'expected an integer 1..16')
      }
      backgroundJobs.maxJobs = raw.maxJobs
    }
  }

  let rootCallback
  if (input.rootCallback !== undefined && input.rootCallback !== null) {
    if (!isPlainObject(input.rootCallback)) throw failField('rootCallback', 'expected a plain object')
    for (const key of Object.keys(input.rootCallback)) {
      if (key !== 'grantId') throw failField(`rootCallback.${key}`, 'is not a permitted field')
    }
    const grantId = requireNonBlank(input.rootCallback.grantId, 'rootCallback.grantId')
    if (grantId.length > 200) throw failField('rootCallback.grantId', 'must be at most 200 characters')
    rootCallback = { grantId }
  }

  // Additive long-task supervisor grant. The adapter carries the (already
  // contract-normalized) block verbatim; deep validation happens in
  // `#planEnforcement` against host policy, before any session or worktree exists.
  let project
  if (input.project !== undefined && input.project !== null) {
    if (!isPlainObject(input.project)) throw failField('project', 'expected a plain object')
    project = jsonSafe(input.project)
  }

  return {
    schemaVersion: 1,
    id,
    idempotencyKey,
    revision,
    projectId,
    title,
    objective,
    cwd: path.resolve(cwd),
    role,
    acceptance,
    scope: {
      readRoots,
      writeRoots,
      allowedTools,
      allowShell,
      allowNetwork,
      allowDelegation: false,
      ...(childSessions === undefined ? {} : { childSessions }),
      ...(backgroundJobs === undefined ? {} : { backgroundJobs })
    },
    materials,
    contractVersion,
    ...(rootCallback === undefined ? {} : { rootCallback }),
    ...(project === undefined ? {} : { project }),
    ...(input.parentTaskId === undefined ? {} : { parentTaskId: requireNonBlank(input.parentTaskId, 'parentTaskId') }),
    ...(input.dependencies === undefined ? {} : { dependencies: requireStringArray(input.dependencies, 'dependencies') }),
    ...(model === undefined ? {} : { model }),
    ...(budget === undefined ? {} : { budget }),
    ...(input.understandingRequired === undefined
      ? {}
      : { understandingRequired: requireBoolean(input.understandingRequired, 'understandingRequired') }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(retention === undefined ? {} : { retention }),
    ...(metadata === undefined ? {} : { metadata })
  }
}

// ---------------------------------------------------------------------------
// tool classification
// ---------------------------------------------------------------------------

/**
 * Classify one tool name into the adapter's enforcement vocabulary.
 * `"unclassified"` means the adapter cannot bound the tool's capability, which
 * is a fail-closed condition unless the coordinator registers it explicitly.
 * @param {string} name - registered tool name.
 * @param {Map<string,string>} [overrides] - coordinator-supplied classifications.
 * @returns {'delegation'|'shell'|'network'|'fs'|'owned-jobs'|'forbidden'|'other'|'unclassified'} class.
 */
export function classifyTool(name, overrides = new Map()) {
  const override = overrides.get(name)
  if (override !== undefined) return override
  if (DELEGATION_SET.has(name)) return 'delegation'
  if (SHELL_SET.has(name)) return 'shell'
  if (NETWORK_SET.has(name)) return 'network'
  if (FS_PATH_ARGS[name] !== undefined) return 'fs'
  if (OWNED_JOB_SET.has(name)) return 'owned-jobs'
  if (CHILD_SESSION_SET.has(name)) return 'child-session'
  if (BRIDGE_JOB_SET.has(name)) return 'bridge-jobs'
  if (BRIDGE_REPLY_SET.has(name)) return 'bridge-reply'
  if (SUPERVISOR_PROJECT_SET.has(name)) return 'supervisor-project'
  if (FORBIDDEN_REASONS.has(name)) return 'forbidden'
  if (SAFE_SESSION_SET.has(name)) return 'other'
  return 'unclassified'
}

/**
 * Extract the path claims one tool call makes, for the path fence.
 * @param {string} name - tool name.
 * @param {object|undefined} args - parsed, frozen tool arguments.
 * @returns {{path: string, mode: 'read'|'write'}[]} claimed paths.
 */
export function toolPathClaims(name, args) {
  const keys = FS_PATH_ARGS[name]
  if (keys === undefined || args === undefined || args === null || typeof args !== 'object') return []
  const mode = FS_WRITE_TOOLS.has(name) ? 'write' : FS_READ_TOOLS.has(name) ? 'read' : 'none'
  if (mode === 'none') return []
  const claims = []
  const push = (raw) => {
    if (typeof raw === 'string' && raw.trim().length > 0) claims.push({ path: raw, mode })
  }
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') push(value)
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') push(entry)
        else if (isPlainObject(entry) && typeof entry.path === 'string') push(entry.path)
      }
    }
  }
  return claims
}

/**
 * Map an observed turn-end kind onto the root's terminal status vocabulary.
 * @param {string} kind - normalized turn-end kind.
 * @returns {'completed'|'failed'|'cancelled'} root status.
 */
export function mapTerminalStatus(kind) {
  if (kind === 'completed') return 'completed'
  if (kind === 'aborted') return 'cancelled'
  return 'failed'
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

/**
 * Bounded DSH adapter. Use `new DshAdapter(ctx, options)`.
 */
export class DshAdapter {
  #ctx
  #options
  #records = new Map()
  #recordsBySession = new Map()
  #childBySession = new Map()
  #childById = new Map()
  #supervisor
  #commandJobs
  #projects
  #disposers = []
  #orphans = []
  #disposed = false
  #sequence = 0
  #listenerFailures = 0
  #lastListenerFailure
  #classificationOverrides
  /**
   * Sessions this INSTANCE has successfully UI-archived. Adapter-local fencing
   * only: the record itself is never mutated by `archive()`, but a clarification
   * attempt must not run against a session the coordinator already hid.
   */
  #archivedSessions = new Set()

  /**
   * @param {object} ctx - cordis host context exposing `get(name)` and `on(event, listener)`.
   * @param {object} [options] - adapter options.
   */
  constructor(ctx, options = {}) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') {
      throw adapterError('adapter/invalid-host', 'DshAdapter requires a host context with ctx.get(name)', {})
    }
    if (!isPlainObject(options)) throw adapterError('adapter/invalid-options', 'options must be a plain object', {})
    if (options.defaultModel !== undefined && !isPlainObject(options.defaultModel)) {
      throw adapterError('adapter/invalid-options', 'options.defaultModel must be a plain object', {})
    }
    this.#ctx = ctx
    this.#options = {
      defaultModel: options.defaultModel === undefined ? { ...DEFAULT_MODEL } : { ...options.defaultModel },
      defaultBudgets: { ...DEFAULT_BUDGETS, ...(isPlainObject(options.defaultBudgets) ? options.defaultBudgets : {}) },
      stopConfirmTimeoutMs: Number.isInteger(options.stopConfirmTimeoutMs)
        ? options.stopConfirmTimeoutMs
        : DEFAULT_STOP_CONFIRM_TIMEOUT_MS,
      ownerId: typeof options.ownerId === 'string' && options.ownerId.length > 0 ? options.ownerId : undefined,
      allowRecoverySession: options.allowRecoverySession === true,
      agentPreset: typeof options.agentPreset === 'string' && options.agentPreset.length > 0 ? options.agentPreset : undefined,
      contractVersion:
        typeof options.contractVersion === 'string' && options.contractVersion.length > 0 ? options.contractVersion : undefined,
      allowUnclassifiedTools: options.allowUnclassifiedTools === true,
      allowForbiddenTools: options.allowForbiddenTools === true,
      toolClassifications: isPlainObject(options.toolClassifications) ? options.toolClassifications : {},
      // Operator long-task policy. Absent/disabled refuses packet.project with a typed
      // host refusal instead of silently running a project without the runtime.
      supervisorProjects: options.supervisorProjects === undefined ? undefined : options.supervisorProjects,
      archiveOnCleanup: options.archiveOnCleanup !== false,
      maxBufferedEvents:
        Number.isInteger(options.maxBufferedEvents) && options.maxBufferedEvents > 0
          ? options.maxBufferedEvents
          : MAX_BUFFERED_EVENTS,
      buildPrompt: typeof options.buildPrompt === 'function' ? options.buildPrompt : undefined,
      buildExecutionPrompt: typeof options.buildExecutionPrompt === 'function' ? options.buildExecutionPrompt : undefined
    }
    this.#classificationOverrides = new Map(
      Object.entries(this.#options.toolClassifications).filter(([name, kind]) => typeof name === 'string' && typeof kind === 'string')
    )
    // Controlled supervisor state is INJECTED (bootstrap owns one shared ledger
    // and one supervisor per bridge owner). Absence keeps the historical
    // behaviour exactly: no child sessions, no bridge jobs, no callback wake.
    this.#supervisor =
      options.supervisor !== undefined && options.supervisor !== null && typeof options.supervisor.childSessionsStatus === 'function'
        ? options.supervisor
        : undefined
    this.#commandJobs =
      options.commandJobs !== undefined && options.commandJobs !== null && typeof options.commandJobs.resolve === 'function'
        ? options.commandJobs
        : undefined
    // The long-task project runtime is injected (bootstrap owns one per bridge owner).
    // Absence keeps the historical behaviour: packet.project is refused before any
    // task or session exists.
    this.#projects =
      options.projects !== undefined && options.projects !== null && typeof options.projects.workerCreate === 'function'
        ? options.projects
        : undefined
    this.#subscribeHost()
  }

  // -- host plumbing ------------------------------------------------------

  #subscribeHost() {
    const on = this.#ctx.on
    if (typeof on !== 'function') return
    const subscribe = (event, listener) => {
      const disposer = contained(
        () => on.call(this.#ctx, event, listener),
        () => undefined
      )
      if (typeof disposer === 'function') this.#disposers.push(disposer)
    }
    subscribe('session/event', (session, event) => {
      contained(() => this.#onSessionEvent(session, event))
    })
    subscribe('agent/status', (payload) => {
      contained(() => this.#onAgentStatus(payload))
    })
    subscribe('subagent/start', (name, info, parent) => {
      contained(() => this.#onSubagentStart(name, info, parent))
    })
  }

  #service(name) {
    return contained(() => this.#ctx.get(name), () => undefined)
  }

  #requireService(name, code = 'adapter/host-unavailable') {
    const service = this.#service(name)
    if (service === undefined || service === null) {
      throw adapterError(code, `required DSH host service "${name}" is unavailable`, { service: name })
    }
    return service
  }

  /**
   * Resolve the AGENT-SCOPED tools service. Registering a guard or restriction
   * through the plain host context would mask every agent in the process, so the
   * scoped lookup is mandatory and a failure is fail-closed.
   */
  #scopedTools(agent) {
    const agentCtx = agent !== undefined && agent !== null ? contained(() => agent.ctx, () => undefined) : undefined
    if (agentCtx === undefined || agentCtx === null || typeof agentCtx.get !== 'function') return undefined
    return contained(() => agentCtx.get('tools'), () => undefined)
  }

  #now() {
    return Date.now()
  }

  #nextSequence() {
    this.#sequence += 1
    return this.#sequence
  }

  // -- event emission -----------------------------------------------------

  #emit(record, attempt, type, payload = {}) {
    const event = {
      type,
      timestamp: this.#now(),
      taskId: record.taskId,
      revision: record.revision,
      attemptId: attempt === undefined ? undefined : attempt.attemptId,
      ...(payload.seq === undefined ? {} : { seq: payload.seq }),
      ...jsonSafe(payload)
    }
    record.events.push(event)
    if (record.events.length > this.#options.maxBufferedEvents) {
      const drop = record.events.splice(0, record.events.length - this.#options.maxBufferedEvents)
      record.eventsDropped += drop.length
    }
    record.updatedAt = event.timestamp
    const hooks = attempt !== undefined && attempt.hooks !== undefined ? attempt.hooks : record.hooks
    this.#deliver(hooks, 'onEvent', event)
    return event
  }

  #deliver(hooks, method, value) {
    if (hooks === undefined || hooks === null) return
    const fn = hooks[method]
    if (typeof fn !== 'function') return
    try {
      const result = fn(jsonSafe(value))
      if (result !== undefined && result !== null && typeof result.then === 'function') {
        result.then(undefined, () => undefined)
      }
    } catch (error) {
      // A listener failure is contained and counted; it never breaks the adapter.
      this.#listenerFailures += 1
      this.#lastListenerFailure = String((error && error.message) || error)
    }
  }

  // -- host event handling ------------------------------------------------

  #onSessionEvent(session, event) {
    const sessionId = session !== undefined && session !== null ? session.id : undefined
    if (typeof sessionId !== 'string' || event === null || typeof event !== 'object') return
    const record = this.#recordsBySession.get(sessionId)
    if (record === undefined) {
      // A bridge-owned child session: its events settle the child ledger, never
      // the parent task's attempts.
      const child = this.#childBySession.get(sessionId)
      if (child !== undefined) this.#onChildSessionEvent(child, event)
      return
    }
    const type = event.type
    const data = event.data
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    const time = typeof event.time === 'number' ? event.time : undefined
    record.lastEventTime = time === undefined ? this.#now() : time
    record.lastSeq = seq === undefined ? record.lastSeq : seq

    if (type === 'turn/start' && isPlainObject(data)) {
      record.openTurn = data.turn
      return
    }
    if (type === 'user/message' && isPlainObject(data)) {
      const rpcId = isPlainObject(data.source) ? data.source.rpcId : undefined
      const attempt = record.attempts.find((candidate) => candidate.requestId === rpcId && !candidate.claimed)
      if (attempt === undefined) return
      attempt.claimed = true
      attempt.messageId = typeof data.id === 'string' ? data.id : undefined
      // An explicit numeric turn on the claim is the host's own binding and wins;
      // only when the host omits it may the currently open turn be used.
      attempt.boundTurn =
        typeof data.turn === 'number' ? data.turn : typeof record.openTurn === 'number' ? record.openTurn : undefined
      attempt.state = 'running'
      attempt.claimedAt = this.#now()
      this.#emit(record, attempt, 'attempt/claimed', { seq, time, turn: attempt.boundTurn, messageId: attempt.messageId })
      return
    }
    if (type === 'model/selection' && isPlainObject(data)) {
      record.durableModel = {
        provider: data.provider,
        model: data.model,
        ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: data.reasoningEffort })
      }
      return
    }
    if (type === 'assistant/message' && isPlainObject(data)) {
      const text = extractMessageText(data.message)
      // ONLY an attempt explicitly bound to THIS turn may speak for the task.
      // A message from a foreign/unclaimed turn is a preserved observation; it is
      // never folded into another attempt's assistantText/finalText (the reply).
      const target = record.attempts.find(
        (candidate) => candidate.boundTurn !== undefined && candidate.boundTurn === data.turn && !candidate.terminal
      )
      if (target !== undefined) {
        if (text.length > 0) {
          target.assistantText = target.assistantText.length === 0 ? text : `${target.assistantText}\n${text}`
        }
        // The last assistant message is the handoff even when it is empty.
        target.finalText = text
        if (data.interrupted === true) target.interrupted = true
      } else {
        record.unboundAssistantMessages.push({ seq, time, turn: data.turn, step: data.step, text })
        if (record.unboundAssistantMessages.length > this.#options.maxBufferedEvents) {
          record.unboundAssistantMessages.splice(0, record.unboundAssistantMessages.length - this.#options.maxBufferedEvents)
        }
      }
      if (isPlainObject(data.usage)) record.lastUsage = jsonSafe(data.usage)
      this.#emit(record, target, 'assistant/message', {
        seq,
        time,
        turn: data.turn,
        step: data.step,
        text,
        interrupted: data.interrupted === true,
        unbound: target === undefined
      })
      return
    }
    if (type === 'tool/call' && isPlainObject(data)) {
      const attempt = record.attempts.find((candidate) => !candidate.terminal)
      if (attempt !== undefined) attempt.toolCallEvents += 1
      // The guard already announced every admitted call with `tool/start`
      // (the root counts those). Only a call the guard never saw is announced
      // here, so a single dispatch is never counted twice.
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      const alreadyAnnounced = callId !== undefined && record.announcedCallIds.has(callId)
      if (!alreadyAnnounced) {
        if (callId !== undefined) record.announcedCallIds.add(callId)
        this.#emit(record, attempt, 'tool/start', {
          seq,
          time,
          turn: data.turn,
          step: data.step,
          name: data.name,
          callId,
          source: 'durable-event'
        })
      }
      return
    }
    if (type === 'tool/result' && isPlainObject(data)) {
      const attempt = record.attempts.find((candidate) => !candidate.terminal)
      if (attempt !== undefined) attempt.toolResultEvents += 1
      this.#emit(record, attempt, 'tool/end', {
        seq,
        time,
        turn: data.turn,
        step: data.step,
        isError: isPlainObject(data.error),
        error: data.error
      })
      return
    }
    if (type === 'turn/end' && isPlainObject(data)) {
      // The ended turn is no longer "open": a later claim without an explicit
      // turn must not inherit it.
      if (record.openTurn === data.turn) record.openTurn = undefined
      const attempt = record.attempts.find(
        (candidate) => candidate.boundTurn !== undefined && candidate.boundTurn === data.turn && !candidate.terminal
      )
      if (attempt === undefined) return
      const reason = normalizeTurnEndReason(data.reason)
      this.#terminalize(record, attempt, { kind: reason.kind, detail: reason.detail, seq, time })
      return
    }
    if (type === 'sandbox/mode' && isPlainObject(data)) {
      record.sandboxModeEvents.push(jsonSafe(data))
    }
  }

  #onAgentStatus(payload) {
    if (!isPlainObject(payload)) return
    const agent = payload.agent
    const sessionId = agent !== undefined && agent !== null ? agent.id : undefined
    if (typeof sessionId !== 'string') return
    const record = this.#recordsBySession.get(sessionId)
    if (record === undefined) return
    record.agentStatus = payload.status === 'running' ? 'running' : 'idle'
  }

  #onSubagentStart(name, info, parent) {
    const sessionId = parent !== undefined && parent !== null ? parent.id : undefined
    if (typeof sessionId !== 'string') return
    const record = this.#recordsBySession.get(sessionId)
    if (record === undefined) return
    // The guard denies delegation tools; if a child still started, record the
    // violation as observable evidence instead of pretending it cannot happen.
    record.delegationViolations.push({ timestamp: this.#now(), provider: typeof name === 'string' ? name : undefined, info: jsonSafe(info) })
    this.#emit(record, record.current, 'policy/violation', {
      violation: 'delegation-started',
      detail: 'a subagent run started for a task whose allowDelegation is false'
    })
  }

  // -- controlled supervisor: child sessions, bridge jobs, root reply -------

  /**
   * The child-session creation seam this host offers. `agents.create` is the ONLY
   * supported seam: it composes the unpublished child scope (so enforcement exists
   * before publication), records real parent/delegation-depth lineage, and returns
   * an owned AgentHandle with a real `dispose()`. `sessionController.create`
   * exposes no per-session dispose, so a child created through it could never
   * release its reservation — that mode is refused, never advertised as cleanable.
   */
  #childCreateSeam() {
    if (this.#supervisor === undefined) return null
    const agents = this.#service('agents')
    if (agents !== null && agents !== undefined && typeof agents.create === 'function') return { mode: 'agents.create' }
    return null
  }

  /** Truthful reason the child seam is unavailable (capability report + refusal). */
  #childSeamUnavailableReason() {
    return 'no child-session creation seam with an owned, disposable AgentHandle is available; sessionController.create exposes no per-session dispose, so a child created through it could never release its reservation'
  }

  /** Truthful bridge-grant support for the capability report and tool admission. */
  #bridgeGrantStatus() {
    const supervisor = this.#supervisor
    const childBase = supervisor !== undefined ? supervisor.childSessionsStatus() : { supported: false, enabled: false, reason: 'no supervisor is configured' }
    const seam = this.#childCreateSeam()
    const jobs = this.#service('jobs')
    // Registry presence and controller reachability are DIFFERENT claims. The
    // installed registry exposes no side-effect-free probe for "an attached
    // controller serves this owner" (attachController is the only seam and
    // probing it would mutate the process), so controller status is honestly
    // `unknown` and a start may still refuse with a typed manager refusal.
    const jobsRegistryReady = jobs !== null && jobs !== undefined && typeof jobs.start === 'function'
    const controllerStatus = 'unknown'
    const jobsBase = supervisor !== undefined ? supervisor.commandJobsStatus() : { supported: false, enabled: false, reason: 'no supervisor is configured' }
    const replyBase = supervisor !== undefined ? supervisor.notificationsStatus() : { supported: false, reason: 'no supervisor is configured' }
    // The long-task supervisor is supported only when the operator enabled it AND a
    // runtime is injected; its capability report is the runtime's own honest status.
    const projectRuntimeStatus =
      this.#projects !== undefined && typeof this.#projects.status === 'function'
        ? this.#projects.status()
        : { supported: false, enabled: false, reason: 'no long-task supervisor runtime is configured on this host' }
    const projects = {
      ...projectRuntimeStatus,
      supported: this.#projects !== undefined && projectRuntimeStatus.enabled === true,
      // The advertised tool surface is the runtime's ACTUAL granted surface: a host that
      // kept maxRounds at the default 1 advertises the historical plan-once tools only.
      tools: Array.isArray(projectRuntimeStatus.tools) ? projectRuntimeStatus.tools : [...SUPERVISOR_PROJECT_TOOL_NAMES],
      reason:
        this.#projects === undefined
          ? 'no long-task supervisor runtime is configured on this host'
          : projectRuntimeStatus.enabled === true
            ? null
            : 'host supervisorProjects.enabled is not true'
    }
    return {
      children: {
        ...childBase,
        supported: childBase.supported === true && seam !== null,
        lineage: seam === null ? null : seam.mode,
        reason: childBase.supported !== true ? childBase.reason : seam === null ? this.#childSeamUnavailableReason() : null
      },
      jobs: {
        ...jobsBase,
        supported: jobsBase.supported === true && jobsRegistryReady,
        jobsRegistryReady,
        controllerStatus,
        controllerUnknown: true,
        controllerReason:
          'the installed jobs registry exposes no side-effect-free controller probe; no fake producer is started to test it, so an accepted job grant may still refuse at start with a typed jobs/manager-unavailable',
        // The typed manager refusal is preserved as the fail-closed behaviour.
        refusal: 'jobs/manager-unavailable (fail-closed, never retried under another identity)'
      },
      reply: { ...replyBase },
      projects
    }
  }
  /** One model-facing tool definition for the bridge-owned tools. */
  #toolDefinition({ name, description, parameters, execute }) {
    return {
      name,
      description,
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }]
      },
      execute
    }
  }

  #childToolParameters() {
    const budget = {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', minimum: 1 },
        maxToolCalls: { type: 'integer', minimum: 1 },
        maxOutputChars: { type: 'integer', minimum: 1 }
      }
    }
    return {
      spawn: {
        type: 'object',
        additionalProperties: false,
        required: ['childKey', 'objective'],
        properties: {
          childKey: { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-chosen idempotency key for this child under this attempt. Replaying it returns the same child and never starts a second one.' },
          objective: { type: 'string', minLength: 1, maxLength: 20000 },
          label: { type: 'string', minLength: 1, maxLength: 200 },
          acceptance: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1 } },
          tools: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Optional subset of this task allowlist. Any name outside it is refused, never clamped.' },
          readRoots: { type: 'array', items: { type: 'string', minLength: 1 } },
          writeRoots: { type: 'array', items: { type: 'string', minLength: 1 } },
          allowNetwork: { type: 'boolean' },
          model: {
            type: 'object',
            additionalProperties: false,
            required: ['provider', 'model'],
            properties: { provider: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 }, reasoningEffort: { type: 'string', minLength: 1 } }
          },
          budgets: budget,
          maxChildren: { type: 'integer', minimum: 1 }
        }
      },
      childRef: {
        type: 'object',
        additionalProperties: false,
        required: ['childId'],
        properties: { childId: { type: 'string', minLength: 1, maxLength: 200 } }
      }
    }
  }

  /**
   * Bridge-owned tool definitions for one record/plan. Registered into the
   * AUTHORIZED PARENT agent's own scoped layer only; a definition closure holds
   * the parent record, and every call revalidates `exec.agent` against it.
   */
  #bridgeToolDefinitions(record, plan) {
    const grants = plan.grants ?? { childSessions: { enabled: false }, backgroundJobs: { enabled: false }, rootCallback: null, supervisorProject: null }
    const params = this.#childToolParameters()
    const defs = []
    if (grants.childSessions?.enabled === true) {
      defs.push(
        this.#toolDefinition({
          name: 'dsh_child_spawn',
          description:
            'Start one controlled child session of this task (depth 1). The child scope is attenuated to this task and any widening request is refused, never clamped. Children cannot delegate, use a shell, start bridge jobs or wake the root.',
          parameters: params.spawn,
          execute: (args, exec) => this.#childSpawn(record, exec, args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_child_wait',
          description: 'Wait a bounded time for one owned child of this task to settle. Never cancels and never holds a concurrency slot.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['childId'],
            properties: { childId: { type: 'string', minLength: 1 }, waitMs: { type: 'integer', minimum: 0 } }
          },
          execute: (args, exec) => this.#childWait(record, exec, args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_child_result',
          description: 'Read one owned child result in bounded slices with its settlement evidence.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['childId'],
            properties: {
              childId: { type: 'string', minLength: 1 },
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 20000 }
            }
          },
          execute: (args, exec) => this.#childResult(record, exec, args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_child_cancel',
          description: 'Cancel one owned child of this task and report observed stop confirmation; an unconfirmed stop stays unknown.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['childId'],
            properties: { childId: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1, maxLength: 200 } }
          },
          execute: (args, exec) => this.#childCancel(record, exec, args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_child_list',
          description: 'List the children of this task and attempt with their state and stop confirmation.',
          parameters: { type: 'object', additionalProperties: false, properties: {} },
          execute: (args, exec) => this.#childList(record, exec, args)
        })
      )
    }
    if (grants.backgroundJobs?.enabled === true) {
      defs.push(
        this.#toolDefinition({
          name: 'dsh_job_start',
          description:
            'Start one operator-approved command profile as a real owned background job. Only the granted profile ids are accepted; the profile supplies exact executable/argv/cwd/env and no shell string or OS sandbox is offered.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['profileId'],
            properties: { profileId: { type: 'string', minLength: 1, maxLength: 200 }, label: { type: 'string', minLength: 1, maxLength: 200 } }
          },
          execute: (args, exec) => this.#startBridgeJob(record, exec, args)
        })
      )
    }
    if (grants.rootCallback !== null && grants.rootCallback !== undefined) {
      defs.push(
        this.#toolDefinition({
          name: 'dsh_bridge_reply',
          description:
            'Report a bounded needs-input or blocked summary to this task\'s trusted callback target. The destination is host-configured and immutable; a reply never completes, fails or cancels the task and is never authorization.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['replyId', 'summary'],
            properties: {
              replyId: { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-chosen idempotency key. An identical replay is not sent twice.' },
              kind: { type: 'string', enum: ['needs-input', 'blocked'] },
              summary: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_RAW_REPLY_CHARS,
                description: `Bounded raw summary of at most ${MAX_RAW_REPLY_CHARS} characters. The controller adds a short "[kind] " prefix for the recipient; a summary that would not fit the ${MAX_WIRE_REPLY_CHARS}-character wire bound is refused explicitly rather than truncated.`
              }
            }
          },
          execute: (args, exec) => this.#bridgeReply(record, exec, args)
        })
      )
    }
    if (grants.supervisorProject !== null && grants.supervisorProject !== undefined) {
      const params = this.#supervisorToolParameters()
      defs.push(
        this.#toolDefinition({
          name: 'dsh_supervisor_worker_create',
          description:
            'Declare ONE bounded worker of this long project. Every worker becomes a separate real bridge task with its own scope; any request that widens the project worker envelope (roots, tools, network, budgets, model, callback, children, depth) is refused, never clamped. The worker never receives supervisor, child, job, reply, shell or delegation tools. Idempotent per workerKey.',
          parameters: params.create,
          execute: (args, exec) => this.#supervisorProjectTool(record, exec, 'dsh_supervisor_worker_create', args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_supervisor_plan_finalize',
          description:
            'Freeze the declared worker plan and end this planning round. Required/optional worker rules are fixed exactly as declared; the host then schedules, retries bounded ordinary failures and aggregates deterministically. Idempotent.',
          parameters: params.empty,
          execute: (args, exec) => this.#supervisorProjectTool(record, exec, 'dsh_supervisor_plan_finalize', args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_supervisor_worker_list',
          description: 'List the declared workers of this project with their persisted state, attempts and stop confirmation.',
          parameters: params.empty,
          execute: (args, exec) => this.#supervisorProjectTool(record, exec, 'dsh_supervisor_worker_list', args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_supervisor_worker_result',
          description: 'Read one owned worker result in bounded slices with its settlement and workspace evidence.',
          parameters: params.result,
          execute: (args, exec) => this.#supervisorProjectTool(record, exec, 'dsh_supervisor_worker_result', args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_supervisor_worker_cancel',
          description:
            'Cancel one owned worker and report the observed stop. An explicit cancellation is recorded so the orchestrator can never respawn that worker as an ordinary failure.',
          parameters: params.cancel,
          execute: (args, exec) => this.#supervisorProjectTool(record, exec, 'dsh_supervisor_worker_cancel', args)
        })
      )
      defs.push(
        this.#toolDefinition({
          name: 'dsh_supervisor_project_status',
          description: 'Read the bounded aggregate status of this project: phase, workers, budgets and the persisted callback outcome.',
          parameters: params.empty,
          execute: (args, exec) => this.#supervisorProjectTool(record, exec, 'dsh_supervisor_project_status', args)
        })
      )
      // The two decision tools exist ONLY on a recurrent project (packet.project.maxRounds
      // >= 2), so a legacy plan-once packet keeps its exact historical tool surface.
      if (grants.supervisorProject.recurrent === true) {
        defs.push(
          this.#toolDefinition({
            name: 'dsh_supervisor_project_complete',
            description:
              'Record that the WHOLE project objective is met, based on the real persisted worker results of this round. It only records the decision: the host finalizes only after this model round and every genuinely owned attempt prove their stop, the aggregate is completed and no required worker is unfinished. It can never finalize early and never hides unknown or live work.',
            parameters: params.complete,
            execute: (args, exec) => this.#supervisorProjectTool(record, exec, 'dsh_supervisor_project_complete', args)
          })
        )
        defs.push(
          this.#toolDefinition({
            name: 'dsh_supervisor_project_block',
            description:
              'Record that this project cannot proceed, with a bounded reason. The host settles the project as an honest capacity-retaining blocked state once this round and every owned attempt prove their stop; it never fabricates a failure or a completion.',
            parameters: params.block,
            execute: (args, exec) => this.#supervisorProjectTool(record, exec, 'dsh_supervisor_project_block', args)
          })
        )
      }
    }
    return defs
  }

  /** Discovery-only parameter shapes for the supervisor-only long-task tools. */
  #supervisorToolParameters() {
    const budget = {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', minimum: 1 },
        maxToolCalls: { type: 'integer', minimum: 1 },
        maxOutputChars: { type: 'integer', minimum: 1 }
      }
    }
    return {
      empty: { type: 'object', additionalProperties: false, properties: {} },
      create: {
        type: 'object',
        additionalProperties: false,
        required: ['workerKey', 'objective'],
        properties: {
          workerKey: { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-chosen idempotency key of this logical worker. Replaying it returns the same worker and never declares a second one.' },
          objective: { type: 'string', minLength: 1, maxLength: 20000 },
          label: { type: 'string', minLength: 1, maxLength: 200 },
          acceptance: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1 } },
          role: { type: 'string', enum: ['investigate', 'implement', 'review', 'integrate'] },
          tools: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Optional subset of the project worker envelope. Any name outside it is refused, never clamped.' },
          readRoots: { type: 'array', items: { type: 'string', minLength: 1 } },
          writeRoots: { type: 'array', items: { type: 'string', minLength: 1 } },
          allowNetwork: { type: 'boolean' },
          budgets: budget,
          required: { type: 'boolean', description: 'Fixed at plan freeze. A required worker that cannot succeed fails the project; an optional one degrades the aggregate honestly.' },
          dependsOn: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Declared worker keys that must succeed before this worker is scheduled.' }
        }
      },
      result: {
        type: 'object',
        additionalProperties: false,
        required: ['workerId'],
        properties: {
          workerId: { type: 'string', minLength: 1, maxLength: 200 },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 20000 }
        }
      },
      cancel: {
        type: 'object',
        additionalProperties: false,
        required: ['workerId'],
        properties: {
          workerId: { type: 'string', minLength: 1, maxLength: 200 },
          reason: { type: 'string', minLength: 1, maxLength: 200 }
        }
      },
      complete: {
        type: 'object',
        additionalProperties: false,
        properties: { summary: { type: 'string', minLength: 1, maxLength: 2000 } }
      },
      block: {
        type: 'object',
        additionalProperties: false,
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } }
      }
    }
  }

  /**
   * Dispatch one supervisor-only tool call for the AUTHORIZED supervisor agent. The
   * grant, the caller identity and the live attempt are revalidated here; the project
   * runtime owns every decision and never receives host authority the model could widen.
   */
  async #supervisorProjectTool(record, exec, name, args) {
    const { attempt } = this.#authorizedParent(exec, name)
    const projects = this.#projects
    if (projects === undefined) throw adapterError('adapter/project-unsupported', 'no long-task supervisor runtime is configured on this host', { tool: name })
    const grant = attempt.plan?.grants?.supervisorProject
    if (grant === null || grant === undefined) throw adapterError('adapter/project-unsupported', `tool "${name}" requires the packet.project grant`, { tool: name })
    const handler = SUPERVISOR_TOOL_HANDLERS[name]
    if (typeof projects[handler] !== 'function') {
      throw adapterError('adapter/project-unsupported', `the long-task supervisor runtime exposes no ${handler} handler`, { tool: name })
    }
    const value = await projects[handler]({ taskId: record.taskId, attemptId: attempt.attemptId, args: isPlainObject(args) ? args : {} })
    return jsonSafe(value)
  }

  /**
   * Register the bridge-owned tools into the authorized parent agent's own
   * scoped registry and PROVE they are visible to that agent before its prompt
   * runs. An enabled grant whose tools cannot be installed fails closed.
   */
  #registerBridgeTools(record, plan) {
    const defs = this.#bridgeToolDefinitions(record, plan)
    if (defs.length === 0) return []
    const scopedTools = record.scopedTools ?? this.#scopedTools(record.agent)
    if (scopedTools === undefined || scopedTools === null || typeof scopedTools.register !== 'function') {
      throw adapterError('adapter/child-unsupported', 'the agent-scoped tools registry exposes no register(); the granted bridge tools cannot be installed', {
        taskId: record.taskId
      })
    }
    const registered = []
    for (const definition of defs) {
      try {
        const disposer = scopedTools.register(definition)
        if (typeof disposer === 'function') record.disposers.push(disposer)
        registered.push(definition.name)
      } catch (error) {
        throw adapterError('adapter/child-unsupported', `failed to register bridge tool "${definition.name}": ${String((error && error.message) || error)}`, {
          taskId: record.taskId,
          tool: definition.name
        })
      }
    }
    record.bridgeTools = registered
    record.bridgeToolsRegistered = true
    if (typeof scopedTools.schemas === 'function') {
      const visible = contained(
        () => scopedTools.schemas(record.agent),
        () => undefined
      )
      if (!Array.isArray(visible)) {
        throw adapterError('adapter/child-unsupported', 'tools.schemas(agent) did not return an array after bridge tool registration', {
          taskId: record.taskId
        })
      }
      const names = new Set(visible.filter((schema) => isPlainObject(schema) && typeof schema.name === 'string').map((schema) => schema.name))
      const missing = registered.filter((name) => !names.has(name))
      if (missing.length > 0) {
        throw adapterError('adapter/child-unsupported', `bridge tool(s) are not visible to the authorized parent agent: ${missing.join(', ')}`, {
          taskId: record.taskId,
          missing
        })
      }
    }
    this.#emit(record, record.current, 'bridge/tools-registered', { tools: registered })
    return registered
  }

  /** No-op when nothing is granted or the tools are already installed for this record. */
  #ensureBridgeTools(record, plan) {
    if (record.bridgeToolsRegistered === true) return record.bridgeTools ?? []
    const grants = plan?.grants
    if (grants === undefined) return []
    const enabled =
      grants.childSessions?.enabled === true ||
      grants.backgroundJobs?.enabled === true ||
      (grants.rootCallback !== null && grants.rootCallback !== undefined) ||
      (grants.supervisorProject !== null && grants.supervisorProject !== undefined)
    if (!enabled) return []
    return this.#registerBridgeTools(record, plan)
  }

  /**
   * Authoritative caller binding: bridge tools may only be called by the exact
   * agent this adapter created for the task, on its live current attempt.
   */
  #authorizedParent(exec, name) {
    const agent = exec !== undefined && exec !== null ? exec.agent : undefined
    const sessionId = agent !== undefined && agent !== null ? agent.id : undefined
    if (typeof sessionId !== 'string') {
      throw adapterError('adapter/unauthorized-caller', `tool "${name}" requires an executing agent`, { tool: name })
    }
    const record = this.#recordsBySession.get(sessionId)
    if (record === undefined) {
      throw adapterError('adapter/unauthorized-caller', `tool "${name}" may only be called by a session this adapter owns for a bridge task`, { tool: name })
    }
    if (record.agent !== undefined && record.agent !== null && agent !== record.agent) {
      throw adapterError('adapter/unauthorized-caller', `tool "${name}" was called by an agent that is not the authorized agent of task "${record.taskId}"`, {
        tool: name,
        taskId: record.taskId
      })
    }
    const attempt = record.current
    if (attempt === undefined || attempt.terminal === true) {
      throw adapterError('adapter/unauthorized-caller', `tool "${name}" is not usable: task "${record.taskId}" has no live attempt`, {
        tool: name,
        taskId: record.taskId
      })
    }
    return { record, attempt }
  }

  #parentGrant(record, attempt, childGrants) {
    const plan = attempt.plan
    return {
      readRoots: [...plan.readRoots],
      writeRoots: [...plan.writeRoots],
      allowNetwork: plan.allowNetwork === true,
      allowedTools: Array.isArray(childGrants.toolNames) && childGrants.toolNames.length > 0 ? [...childGrants.toolNames] : [...plan.allowedTools],
      model: isPlainObject(attempt.effectiveModel) ? { ...attempt.effectiveModel } : null,
      budgets: { ...plan.budgets },
      maxChildren: childGrants.maxChildren,
      depth: 0,
      callbackTargetId: null
    }
  }

  #childSnapshot(child) {
    if (child === undefined || child === null) return null
    const runtime = this.#childById.get(child.childId)
    return {
      childId: child.childId,
      childKey: child.childKey ?? null,
      taskId: child.taskId,
      attemptId: child.attemptId,
      sessionId: child.sessionId ?? null,
      state: child.state,
      depth: child.depth ?? 1,
      lineage: child.lineage ?? null,
      stopConfirmed: child.stopConfirmed === true,
      summary: typeof child.summary === 'string' ? child.summary.slice(0, 500) : '',
      // Truthful child-budget and resource state: what was actually admitted,
      // whether the deadline fired, and whether teardown proved the stop.
      budgets: {
        toolStarts: runtime?.toolStarts ?? 0,
        maxToolCalls: runtime?.grant?.budgets?.maxToolCalls ?? null,
        deadlineMs: runtime?.deadlineMs ?? null,
        deadlineSource: runtime?.deadlineSource ?? null,
        retainedLimit: runtime?.output?.limit ?? null,
        retainedTruncated: runtime?.output?.truncated === true,
        exhausted: runtime?.budgetExhausted ?? null
      },
      teardown: {
        state: runtime?.teardownState ?? 'unknown',
        outcome: runtime?.teardownOutcome ?? null,
        failure: runtime?.teardownFailure ?? null
      },
      // Truthful child enforcement evidence: the mandatory dispatch seam, whether the
      // inherited-plane presentation mask call actually returned, and its notes. This
      // never claims the child's own scoped registrations were hidden.
      enforcement: {
        guardInstalled: runtime?.guardInstalled === true,
        restrictApplied: runtime?.restrictApplied === true,
        dispatchMechanism: runtime?.dispatchMechanism ?? null,
        // The creation-time route the host really published, verified before the
        // first delivery. `routeVerified` is never true for a tolerated refusal.
        routeVerified: runtime?.routeVerified === true,
        modelRoute: runtime?.modelRoute ?? null,
        compositionJoined: runtime?.compositionJoined === true,
        // The seam that really delivered the child prompt and the seam that accepted
        // its stop request. Generic session routing never appears here for a
        // subagent-owned child, because it refuses that identity.
        driveMechanism: runtime?.driveMechanism ?? null,
        stopMechanism: runtime?.stopMechanism ?? null,
        notes: Array.isArray(runtime?.enforcementNotes) ? [...runtime.enforcementNotes] : []
      }
    }
  }

  #requireChild(record, args, toolName) {
    const supervisor = this.#supervisor
    if (supervisor === undefined) throw adapterError('adapter/child-unsupported', 'no supervisor is configured', { tool: toolName })
    const childId = isPlainObject(args) && typeof args.childId === 'string' ? args.childId.trim() : ''
    if (childId.length === 0) throw adapterError('supervisor/invalid-request', `tool "${toolName}" requires a nonblank childId`, { field: 'childId' })
    const child = supervisor.findChild(childId)
    if (child === undefined || child.taskId !== record.taskId) {
      throw adapterError('adapter/unauthorized-caller', `child "${childId}" is not owned by task "${record.taskId}"`, { childId, tool: toolName })
    }
    const attempt = record.current
    if (attempt !== undefined && child.attemptId !== attempt.attemptId) {
      throw adapterError('adapter/attempt-conflict', `child "${childId}" belongs to attempt ${child.attemptId}, not the live attempt ${attempt.attemptId}`, {
        childId,
        childAttemptId: child.attemptId,
        attemptId: attempt.attemptId
      })
    }
    return child
  }

  async #childSpawn(record, exec, args) {
    const { attempt } = this.#authorizedParent(exec, 'dsh_child_spawn')
    const supervisor = this.#supervisor
    const childGrants = attempt.plan?.grants?.childSessions
    if (supervisor === undefined || childGrants === undefined || childGrants.enabled !== true) {
      throw adapterError('adapter/child-unsupported', 'this task has no approved childSessions grant', { taskId: record.taskId })
    }
    if (!isPlainObject(args)) throw adapterError('supervisor/invalid-request', 'dsh_child_spawn arguments must be an object', {})
    const taskId = record.taskId
    const childKey = typeof args.childKey === 'string' ? args.childKey.trim() : ''
    if (childKey.length === 0) throw adapterError('supervisor/invalid-request', 'childKey is required', { field: 'childKey' })

    // Idempotency: the same key under this attempt returns the same child and
    // never starts a second session.
    const existing = supervisor.findChildByKey(taskId, attempt.attemptId, childKey)
    if (existing !== undefined) return jsonSafe({ ...this.#childSnapshot(existing), idempotentReplay: true })

    // Grant attenuation FIRST: any widening is rejected, never clamped, and only
    // then may a real child session be created.
    const childPlan = attempt.plan
    const childGrant = childGrantFor(this.#parentGrant(record, attempt, childGrants), args, {
      maxDepth: 1,
      maxChildrenPerTask: childGrants.maxChildren,
      canonicalize: (raw) => canonicalTarget(raw, childPlan.cwd)
    })

    const live = supervisor.childrenOf(taskId, { liveOnly: true })
    if (live.length >= childGrants.maxChildren) {
      throw adapterError('supervisor/child-limit', `task "${taskId}" already has ${live.length} live child session(s); the grant allows ${childGrants.maxChildren}`, {
        childCount: live.length,
        maxChildren: childGrants.maxChildren
      })
    }

    // Refuse a host with no owned, disposable child seam BEFORE any reservation
    // or session exists: no slot is created and no child can be leaked.
    const seam = this.#childCreateSeam()
    if (seam === null) throw adapterError('adapter/child-unsupported', this.#childSeamUnavailableReason(), {})

    const childId = randomUUID()
    // Reserve SYNCHRONOUSLY before any async host call; saturation refuses
    // boundedly instead of deadlocking a parent wait.
    const reserved = supervisor.reserveChild({ taskId, attemptId: attempt.attemptId, childId, label: childGrant.label })
    if (reserved.ok !== true) {
      throw adapterError('supervisor/saturated', reserved.reason, { counts: reserved.counts, code: reserved.code })
    }
    const runtime = {
      childId,
      childKey,
      taskId,
      attemptId: attempt.attemptId,
      requestId: `dsc-${this.#nextSequence()}-${childId}`.slice(0, 200),
      boundTurn: undefined,
      claimed: false,
      // Retained output is bounded by the child's OWN maxOutputChars grant. The
      // cap applies to adapter-retained text only; the child model transcript is
      // never truncated.
      output: { text: '', truncated: false, dropped: 0, limit: Number.isInteger(childGrant.budgets?.maxOutputChars) ? childGrant.budgets.maxOutputChars : null },
      finalText: '',
      terminal: false,
      stopConfirmed: false,
      // The single in-flight settlement for this child. The child's own `turn/end`
      // and the parent's descendant-cancel path can both request settlement of the
      // SAME child; the second caller awaits this memoized promise instead of
      // returning early, so `child/teardown` + `child/settled` are emitted exactly
      // once and before the parent task can settle.
      settlement: undefined,
      sessionId: null,
      agent: null,
      lineage: seam === null ? null : seam.mode,
      grant: childGrant,
      disposers: [],
      // Truthful child enforcement evidence. `guardInstalled` is the dispatch seam
      // that must exist before the first prompt; `restrictApplied` records only
      // whether the global/inherited presentation mask call returned, never that
      // the child's own scoped registrations were hidden.
      guardInstalled: false,
      restrictApplied: false,
      dispatchMechanism: null,
      // The creation-time route requested for this child and the route the host
      // really PUBLISHED on the live agent. `routeVerified` is set only by an exact
      // provider/model/reasoningEffort match, before any delivery.
      requestedRoute: null,
      routeVerified: false,
      modelRoute: null,
      // Whether the child really joined its parent's composed agent plane inside
      // its own creation window (never a claim about restrictions).
      compositionJoined: false,
      enforcementNotes: [],
      // Monotonic budget accounting: distinct admitted tool starts only, never a
      // replay of the same callId, and never reset by a wait or an idempotent
      // spawn replay.
      toolStarts: 0,
      advertisedCallIds: new Set(),
      budgetExhausted: null,
      deadlineTimer: undefined,
      deadlineMs: null,
      deadlineSource: null,
      teardownState: 'pending',
      teardownOutcome: null,
      teardownFailure: null,
      // Set only when #releaseChildSlotIfStopped really released the ledger slot.
      // A repeated teardown of a child whose stop was never proven must never
      // report the slot as released.
      slotReleaseProven: false
    }
    this.#childById.set(childId, runtime)
    // Durable BEFORE the async create: an interrupted start is recovered as
    // unknown and is never replayed.
    supervisor.registerChild({
      childId,
      childKey,
      taskId,
      attemptId: attempt.attemptId,
      parentSessionId: record.sessionId,
      depth: 1,
      state: 'starting',
      lineage: runtime.lineage,
      grant: {
        allowedTools: [...childGrant.tools],
        readRoots: [...childGrant.readRoots],
        writeRoots: [...childGrant.writeRoots],
        allowNetwork: childGrant.allowNetwork,
        budgets: { ...childGrant.budgets },
        maxChildren: childGrant.maxChildren,
        depth: 1
      }
    })
    this.#emit(record, attempt, 'child/starting', { childId, childKey, depth: 1, lineage: runtime.lineage })

    try {
      await this.#createChildSession(record, attempt, childGrant, runtime)
    } catch (error) {
      const published = typeof runtime.sessionId === 'string'
      if (!published) {
        // No child session was published: the reservation is released with the
        // real proof (there is no live agent for the generated id) and the child
        // is recorded failed, never silently successful.
        supervisor.setChildState(childId, {
          state: 'failed',
          stopConfirmed: true,
          failure: { code: (error && error.code) || 'CHILD_CREATE_FAILED', message: String((error && error.message) || error) }
        })
        this.#childById.delete(childId)
        supervisor.releaseChild({ taskId, childId, stopConfirmed: true, reason: 'no child session was published' })
        this.#emit(record, attempt, 'child/failed', { childId, code: (error && error.code) || 'CHILD_CREATE_FAILED' })
        throw adapterError('supervisor/child-create-failed', `child session creation failed before publication: ${String((error && error.message) || error)}`, {
          childId,
          outcome: 'failed'
        })
      }
      // The child identity is PUBLISHED but its start failed. Teardown is
      // attempted against the id that really exists; the slot is released only on
      // observed absence of a live agent for that id, never on an assumption.
      const abandonment = await this.#abandonPublishedChild(runtime, String((error && error.message) || error))
      if (abandonment.slotReleased === true) {
        throw adapterError('supervisor/child-create-failed', `child session "${runtime.sessionId}" was published but could not be started and was torn down: ${String((error && error.message) || error)}`, {
          childId,
          sessionId: runtime.sessionId,
          outcome: 'failed'
        })
      }
      throw adapterError(
        'supervisor/child-create-ambiguous',
        `child session "${runtime.sessionId}" was published but could not be started: ${String((error && error.message) || error)}; the child is recorded unknown and is never replayed`,
        { childId, sessionId: runtime.sessionId, outcome: 'unknown', teardown: abandonment.teardownOutcome }
      )
    }

    // Identity tracking and budgets are registered BEFORE the first prompt (they
    // are installed inside #createChildSession), so a host that emits a complete
    // owned child turn synchronously is attributed, not lost.
    const settledChild = supervisor.findChild(childId)
    const settled = runtime.terminal === true || (settledChild !== undefined && CHILD_TERMINAL.has(settledChild.state)) || (settledChild !== undefined && settledChild.state === 'unknown')
    if (!settled) {
      supervisor.setChildState(childId, { state: 'running', sessionId: runtime.sessionId, requestId: runtime.requestId, lineage: runtime.lineage })
    }
    this.#emit(record, attempt, 'child/spawned', { childId, sessionId: runtime.sessionId, lineage: runtime.lineage, earlySettlement: settled })
    return jsonSafe({ ...this.#childSnapshot(supervisor.findChild(childId)), idempotentReplay: false })
  }

  /**
   * Track a published child identity and install its enforcement/budget tracking.
   * Called the moment a session id exists — BEFORE the first prompt — so early
   * host events (turn/start, tool/call, turn/end) are attributed to the child and
   * its budgets are already live.
   */
  #publishChildIdentity(runtime, sessionId, agent, handle) {
    runtime.sessionId = sessionId
    if (agent !== undefined && agent !== null) runtime.agent = agent
    if (handle !== undefined && handle !== null) runtime.handle = handle
    this.#childBySession.set(sessionId, runtime)
    this.#armChildDeadline(runtime)
    return runtime
  }

  /**
   * Arm the child deadline for a published child. The child can never outlive the
   * parent attempt's remaining deadline: the effective budget is the child's own
   * `timeoutMs` clamped by the parent's remaining time. On fire the owned child is
   * cancelled but its slot is RETAINED until an observed stop proof.
   */
  #armChildDeadline(runtime) {
    if (runtime.deadlineTimer !== undefined) return
    const own = Number.isInteger(runtime.grant?.budgets?.timeoutMs) ? runtime.grant.budgets.timeoutMs : null
    const parentRemaining = this.#parentRemainingDeadlineMs(runtime)
    const candidates = [own, parentRemaining].filter((value) => Number.isInteger(value) && value > 0)
    if (candidates.length === 0) return
    const effective = Math.min(...candidates)
    runtime.deadlineMs = effective
    runtime.deadlineSource = parentRemaining !== null && parentRemaining <= (own ?? Number.POSITIVE_INFINITY) ? 'parent-remaining' : 'child-budget'
    const timer = setTimeout(() => {
      contained(() => {
        if (runtime.terminal === true || runtime.teardownState === 'disposed') return
        runtime.budgetExhausted = { budget: 'timeoutMs', limit: effective, source: runtime.deadlineSource, at: this.#now() }
        const record = this.#records.get(runtime.taskId)
        if (record !== undefined) this.#emit(record, record.current, 'child/timeout', { childId: runtime.childId, sessionId: runtime.sessionId, timeoutMs: effective, source: runtime.deadlineSource })
        void this.#cancelChildOnBudget(runtime)
      })
    }, effective)
    if (typeof timer.unref === 'function') timer.unref()
    runtime.deadlineTimer = timer
  }

  /** Remaining ms of the owning root attempt's timeout budget, or null when unbounded. */
  #parentRemainingDeadlineMs(runtime) {
    const record = this.#records.get(runtime.taskId)
    const attempt = record !== undefined && record.current !== undefined ? record.current : undefined
    const timeoutMs = attempt?.plan?.budgets?.timeoutMs
    if (attempt === undefined || !Number.isInteger(timeoutMs) || timeoutMs <= 0) return null
    const startedAt = Number.isFinite(attempt.startedAt) ? attempt.startedAt : record.createdAt
    return Math.max(1, startedAt + timeoutMs - this.#now())
  }

  /**
   * Cooperative child timeout: cancel the owned child, then confirm its stop. The
   * slot is released only on observed proof; otherwise the child stays counted
   * and marked unknown.
   */
  async #cancelChildOnBudget(runtime) {
    const supervisor = this.#supervisor
    if (supervisor === undefined) return
    this.#requestChildStop(runtime)
    const child = supervisor.findChild(runtime.childId)
    if (child === undefined) return
    if (runtime.terminal === true) return
    const confirmation = await this.#confirmChildStopped(child, runtime)
    if (confirmation.confirmed === true) {
      this.#settleChild(runtime, 'cancelled', { kind: 'aborted', detail: `child budget timeoutMs=${runtime.deadlineMs} exceeded`, budget: true })
      return
    }
    this.#markChildUnknown(runtime, `child budget timeoutMs=${runtime.deadlineMs} exceeded and the stop was not observed`)
  }

  /** Bounded retained output: append text up to the child's maxOutputChars grant. */
  #retainChildOutput(runtime, text) {
    if (typeof text !== 'string' || text.length === 0) return
    const limit = runtime.output.limit
    const separator = runtime.output.text.length === 0 ? '' : '\n'
    if (!Number.isInteger(limit) || limit <= 0) {
      runtime.output.text = `${runtime.output.text}${separator}${text}`
      return
    }
    if (runtime.output.text.length >= limit) {
      runtime.output.truncated = true
      runtime.output.dropped += text.length
      return
    }
    const room = limit - runtime.output.text.length - separator.length
    if (room <= 0) {
      runtime.output.truncated = true
      runtime.output.dropped += text.length
      return
    }
    if (text.length <= room) {
      runtime.output.text = `${runtime.output.text}${separator}${text}`
      return
    }
    runtime.output.text = `${runtime.output.text}${separator}${text.slice(0, room)}`
    runtime.output.truncated = true
    runtime.output.dropped += text.length - room
  }

  #markChildUnknown(runtime, reason) {
    const supervisor = this.#supervisor
    if (supervisor === undefined) return null
    return supervisor.markChildUnknown(runtime.childId, reason)
  }

  /**
   * Tear down ONE published child exactly once: lift its scoped enforcement, then
   * dispose the owned AgentHandle. Persisted result data is never touched. A
   * throwing teardown is reported honestly and the child stays `unknown` with its
   * slot retained — an unproven stop is never converted into a release.
   *
   * @returns {Promise<{state: string, slotReleased: boolean, outcome: string, detail?: object}>} teardown verdict.
   */
  async #teardownChild(runtime, reason) {
    if (runtime.teardownState === 'disposed') {
      return { state: runtime.teardownState, slotReleased: runtime.slotReleaseProven === true, outcome: runtime.teardownOutcome ?? 'already-disposed', idempotent: true }
    }
    if (runtime.teardownState === 'failed') {
      return { state: runtime.teardownState, slotReleased: false, outcome: 'failed', detail: runtime.teardownFailure ?? undefined, idempotent: true }
    }
    runtime.teardownState = 'disposing'
    const supervisor = this.#supervisor
    const failures = []
    for (const disposer of runtime.disposers.splice(0)) {
      try {
        disposer()
      } catch (error) {
        failures.push({ stage: 'disposer', message: String((error && error.message) || error) })
      }
    }
    const handle = runtime.handle
    const ownsIdentity = typeof runtime.sessionId === 'string' && handle !== undefined && handle !== null
    if (ownsIdentity && typeof handle.dispose === 'function') {
      try {
        await handle.dispose()
      } catch (error) {
        failures.push({ stage: 'agent-dispose', message: String((error && error.message) || error) })
      }
    } else {
      // No owned AgentHandle exists for a published session. This should be
      // unreachable now that the only supported seam is `agents.create` (which
      // returns a disposable handle); if it ever happens, refuse to claim a
      // cleanup that cannot be performed rather than release the slot.
      if (typeof runtime.sessionId === 'string' && !ownsIdentity) {
        failures.push({ stage: 'teardown-seam', message: 'no owned AgentHandle exists for this published child session, so no supported dispose seam can prove its stop' })
      }
    }
    // A self-check that never mutates: is a live agent still registered for this
    // identity? Only observed absence is proof of teardown.
    const liveAgent = this.#liveAgentFor(runtime.sessionId)
    const record = this.#records.get(runtime.taskId)
    if (failures.length > 0) {
      runtime.teardownState = 'failed'
      runtime.teardownOutcome = 'failed'
      runtime.teardownFailure = { reason: reason ?? null, failures }
      if (supervisor !== undefined) this.#markChildUnknown(runtime, `child teardown failed: ${failures.map((entry) => entry.stage).join(', ')}`)
      if (record !== undefined) this.#emit(record, record.current, 'child/teardown-failed', { childId: runtime.childId, sessionId: runtime.sessionId, failures, liveAgent: liveAgent !== undefined })
      return { state: 'failed', slotReleased: false, outcome: 'failed', detail: { failures, liveAgent: liveAgent !== undefined } }
    }
    runtime.teardownState = 'disposed'
    runtime.teardownOutcome = 'disposed'
    // The reported result reflects what #releaseChildSlotIfStopped ACTUALLY did:
    // a live agent that survived teardown keeps the slot and stays unproven.
    const slotReleased = supervisor !== undefined ? this.#releaseChildSlotIfStopped(runtime, liveAgent) === true : false
    runtime.slotReleaseProven = slotReleased
    if (record !== undefined) {
      this.#emit(record, record.current, 'child/teardown', {
        childId: runtime.childId,
        sessionId: runtime.sessionId,
        mechanism: ownsIdentity ? 'AgentHandle.dispose' : 'scoped-enforcement-only',
        liveAgent: liveAgent !== undefined,
        slotReleased
      })
    }
    return { state: 'disposed', slotReleased, outcome: 'disposed' }
  }

  /** Live agent for one session id, via the host registry only (never a guess). */
  #liveAgentFor(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    const agents = this.#service('agents')
    if (agents === null || agents === undefined || typeof agents.get !== 'function') return undefined
    return contained(() => agents.get(sessionId), () => undefined)
  }

  /**
   * Release the ledger slot for a child whose teardown completed, but only when no
   * live agent remains for its published identity. A surviving agent means the
   * stop is NOT proven, so the slot is retained and the child marked unknown.
   */
  #releaseChildSlotIfStopped(runtime, liveAgent) {
    const supervisor = this.#supervisor
    if (supervisor === undefined) return false
    if (liveAgent !== undefined && liveAgent !== null) {
      this.#markChildUnknown(runtime, 'child teardown completed but a live agent is still registered for its session')
      return false
    }
    supervisor.releaseChild({ taskId: runtime.taskId, childId: runtime.childId, stopConfirmed: true, reason: 'child teardown proven: no live agent remains' })
    return true
  }

  /**
   * Abandon a child whose start failed AFTER its identity was published. The owned
   * handle (when one exists) is disposed; the slot is released only on observed
   * absence of a live agent. A partial publication is therefore never misreported
   * as "no publication" with a released slot.
   */
  async #abandonPublishedChild(runtime, detail) {
    const teardown = await this.#teardownChild(runtime, `start failed after publication: ${detail}`)
    const liveAgent = this.#liveAgentFor(runtime.sessionId)
    if (teardown.state === 'disposed' && liveAgent === undefined && this.#supervisor !== undefined) {
      this.#supervisor.setChildState(runtime.childId, {
        state: 'failed',
        stopConfirmed: true,
        sessionId: runtime.sessionId,
        failure: { code: 'CHILD_CREATE_AMBIGUOUS_TORN_DOWN', message: detail }
      })
      const record = this.#records.get(runtime.taskId)
      if (record !== undefined) this.#emit(record, record.current, 'child/failed', { childId: runtime.childId, sessionId: runtime.sessionId, code: 'CHILD_CREATE_AMBIGUOUS_TORN_DOWN' })
      return { slotReleased: true, teardownOutcome: teardown.outcome }
    }
    if (this.#supervisor !== undefined) {
      this.#supervisor.setChildState(runtime.childId, { state: 'starting', sessionId: runtime.sessionId, lineage: runtime.lineage })
      this.#markChildUnknown(runtime, 'child session was published but start did not complete')
    }
    const record = this.#records.get(runtime.taskId)
    if (record !== undefined) this.#emit(record, record.current, 'child/unknown', { childId: runtime.childId, sessionId: runtime.sessionId })
    return { slotReleased: false, teardownOutcome: teardown.outcome }
  }

  /**
   * Create the real child session with attenuation installed BEFORE its first
   * prompt. The child's grant is exactly the validated attenuated grant; its model
   * route is fixed as a creation-time `agentOptions` and verified from the PUBLISHED
   * live agent before any delivery. Generic session routing is never used for this
   * `origin: 'subagent'` identity.
   */
  async #createChildSession(record, attempt, grant, runtime) {
    const agents = this.#service('agents')
    const seam = this.#childCreateSeam()
    if (seam === null) throw adapterError('adapter/child-unsupported', 'no child-session creation seam is available', {})
    const sessionId = randomUUID()
    const installChildEnforcement = (scopedTools, childAgent, childSessionId) => {
      if (scopedTools === undefined || scopedTools === null) {
        throw adapterError('adapter/child-unsupported', 'the child scope exposes no tools registry, so its grant cannot be enforced', {})
      }
      const childPlan = {
        allowedTools: new Set(grant.tools),
        classes: new Map(grant.tools.map((name) => [name, classifyTool(name, this.#classificationOverrides)])),
        cwd: attempt.plan.cwd,
        readRoots: grant.readRoots,
        writeRoots: grant.writeRoots,
        allowNetwork: grant.allowNetwork,
        budgets: grant.budgets
      }
      // The child's monotonic guard is MANDATORY and is installed FIRST, before the
      // first prompt and before any presentation mask is attempted. The guard is the
      // seam that actually fences dispatch; a failing global-only mask must never be
      // able to reject a safely guarded child. `scopedTools` comes only from the
      // setup-provided child `agentCtx`; the parent's registry is never substituted.
      if (typeof scopedTools.guard !== 'function') {
        throw adapterError('adapter/child-unsupported', 'the child scope exposes no monotonic guard, so its grant cannot be enforced', {})
      }
      const guardDisposer = scopedTools.guard(this.#makeChildGuard(childPlan, childSessionId))
      if (typeof guardDisposer === 'function') runtime.disposers.push(guardDisposer)
      runtime.guardInstalled = true
      runtime.dispatchMechanism = 'scoped-monotonic-guard'
      // Presentation-only mask, attempted AFTER the guard and never allowed to fail
      // the child. `tools.restrict()` accepts only inherited/global names: tools an
      // agent plane registers in the child's OWN scope layer cannot be named, and
      // even a successful restriction never masks the scope's own registrations. The
      // outcome is recorded as-is; it is never reported as "tools hidden".
      if (typeof scopedTools.restrict === 'function') {
        try {
          const restrictDisposer = scopedTools.restrict({ allow: [...grant.tools] })
          if (typeof restrictDisposer === 'function') runtime.disposers.push(restrictDisposer)
          runtime.restrictApplied = true
          runtime.enforcementNotes.push(
            'tools.restrict() applied to the inherited/global tool plane only; the child scope\'s own registrations are not restricted'
          )
        } catch (error) {
          runtime.enforcementNotes.push(
            `tools.restrict() failed; presentation mask not applied (dispatch stays guarded by the child monotonic guard): ${String((error && error.message) || error)}`
          )
        }
      } else {
        runtime.enforcementNotes.push('tools.restrict() is unavailable on the child scope; presentation mask not applied (dispatch stays guarded by the child monotonic guard)')
      }
      if (grant.writeRoots.length === 0) {
        contained(() => {
          const session = childAgent !== undefined && childAgent !== null ? childAgent.session : undefined
          if (session !== undefined && session !== null && typeof session.append === 'function') session.append('sandbox/mode', { mode: 'read-only' })
        }, () => undefined)
      }
    }

    const requested = isPlainObject(grant.model) ? grant.model : attempt.effectiveModel
    if (!isPlainObject(requested) || typeof requested.provider !== 'string' || typeof requested.model !== 'string') {
      throw adapterError('adapter/model-route', 'a complete child model route is required', { sessionId: runtime.sessionId })
    }
    // The child's route is fixed at CREATION time. The installed factory records the
    // creation-time `agentOptions` verbatim on the live agent, and that published value
    // is the only supported route evidence for this identity: generic session routing
    // (`sessionController.selectModel`) refuses an `origin: 'subagent'` session with
    // `session/agent-busy` ("owned by subagent routing"), so asking it here could never
    // confirm the child route and a tolerated refusal would be no proof at all.
    const requestedRoute = {
      provider: requested.provider,
      model: requested.model,
      ...(typeof requested.reasoningEffort === 'string' && requested.reasoningEffort.length > 0
        ? { reasoningEffort: requested.reasoningEffort }
        : {})
    }
    runtime.requestedRoute = requestedRoute

    if (seam.mode === 'agents.create' && agents !== null && agents !== undefined && typeof agents.create === 'function') {
      const handle = await agents.create({
        sessionId,
        parentAgent: record.agent,
        meta: { cwd: attempt.plan.cwd, parentSession: record.sessionId, origin: 'subagent', delegationDepth: 1 },
        // The supported creation-time route the installed in-process driver uses
        // (`resolveChildAgentOptions` -> `agents.create({ agentOptions })`), including
        // the explicit reasoning effort, so the child loop owns its provider/model
        // before the child-owned followup is delivered. `subagentDepth` mirrors the
        // official resolution for a depth-1 child.
        agentOptions: { ...requestedRoute, subagentDepth: 1 },
        setup: (agentCtx, childAgent) => {
          // The child guard must be scoped to the CHILD. If a setup handed back the
          // parent's own composition context, a guard registered through it would be
          // scoped onto the parent (narrowing the parent plane), so refuse rather than
          // mis-scope enforcement. `setup`'s agentCtx is the child's context even when
          // the async current initiator is the parent.
          const parentCtx = contained(() => record.agent?.ctx, () => undefined)
          if (agentCtx !== undefined && parentCtx !== undefined && agentCtx === parentCtx) {
            throw adapterError('adapter/child-unsupported', 'the child setup exposed the parent agent context, so the child guard could not be scoped to the child', {})
          }
          // Compose the child exactly where the installed in-process driver does:
          // inside this creation window, still before the guard and the first delivery.
          this.#composeChildScope(agentCtx, parentCtx, runtime)
          const scopedTools = agentCtx !== null && agentCtx !== undefined && typeof agentCtx.get === 'function'
            ? contained(() => agentCtx.get('tools'), () => undefined)
            : undefined
          installChildEnforcement(scopedTools, childAgent, sessionId)
        }
      })
      const childAgent = handle !== undefined && handle !== null ? handle.agent : undefined
      // The published identity is tracked BEFORE it is validated, so a later
      // rejection can never be misreported as "nothing was published".
      this.#publishChildIdentity(runtime, sessionId, childAgent, handle)
      if (childAgent === undefined || childAgent === null || childAgent.id !== sessionId) {
        throw adapterError('adapter/child-unsupported', 'agents.create did not publish a live child agent with the requested identity', { sessionId })
      }
      runtime.lineage = 'agents.create'
    } else {
      // `sessionController.create` is deliberately NOT a fallback: it exposes no
      // per-session dispose, so a child created through it could never prove its
      // stop or release its reservation. Refuse rather than advertise a seam that
      // cannot be cleaned up.
      throw adapterError('adapter/child-unsupported', this.#childSeamUnavailableReason(), { lineage: seam === null ? null : seam.mode })
    }

    // The route the host really PUBLISHED for this child is verified before its first
    // delivery. A missing or different provider/model/reasoningEffort fails closed:
    // there is no fallback and no acceptance by code/message match.
    this.#verifyChildRoute(runtime)

    const prompt = this.#composeChildPrompt(record, grant)
    // DRIVE the published child through its OWN agent. This session carries
    // `origin: 'subagent'`, and the installed api-session-controller refuses generic
    // routing for such an identity (`session/agent-busy`: "owned by subagent
    // routing"), which is exactly how a real published child used to fail to start
    // and had to be torn down. `followup` is the delivery seam the installed
    // in-process subagent driver itself uses, and it preserves the adapter's own
    // request binding because `createUserMessage` keeps `source.rpcId`: the child's
    // `user/message` event still claims exactly THIS child runtime. The identity is
    // never downgraded to an ordinary session to bypass DSH ownership.
    const childAgent = runtime.agent
    if (childAgent === undefined || childAgent === null || typeof childAgent.followup !== 'function') {
      throw adapterError('adapter/child-unsupported', 'the published child agent exposes no followup seam, so the child session cannot be driven', {
        sessionId: runtime.sessionId
      })
    }
    // A concrete delivery, never a swallowed one: `contained(...)` used to swallow a
    // synchronous throw from `followup` and return `undefined`, which this seam then
    // read as a successful drive. A thrown delivery is a real failure with its own
    // typed error, so the caller tears the published child down truthfully instead of
    // reporting a child that was never started.
    let drive
    try {
      drive = childAgent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user', rpcId: runtime.requestId } }))
    } catch (error) {
      runtime.driveFailed = true
      throw adapterError('adapter/child-drive-failed', `the published child could not be driven through its own agent: ${String((error && error.message) || error)}`, {
        sessionId: runtime.sessionId
      })
    }
    if (drive !== undefined) {
      throw adapterError('adapter/child-drive-ambiguous', 'the child followup seam returned a value instead of accepting the message synchronously', {
        sessionId: runtime.sessionId
      })
    }
    runtime.driveMechanism = 'child-agent.followup'
    return { sessionId: runtime.sessionId, lineage: runtime.lineage }
  }

  /**
   * Join one child to its parent's composed agent plane inside the child's own
   * scoped creation window, exactly where the installed in-process driver applies
   * `applyChildComposition(childCtx, parent, ...)`: the child joins its parent's
   * mount through `agentPresets.composeFrom(childCtx, parent.ctx)` so the
   * agent-plane tools, prompt sections and the fixed delegation-scope statement
   * exist in the CHILD's scope before its first delivery. The join is registered
   * through the child context only — the parent plane is never touched.
   *
   * A host that exposes no join seam is refused here rather than silently started:
   * a child that cannot join its parent's composition would run with an empty tool
   * plane, so the attenuated grant below could never actually be exercised. This is
   * fail-closed, never a fallback to an uncomposed child.
   *
   * @param {object} childCtx - scoped creation context handed to `setup`.
   * @param {object} parentCtx - the delegating parent agent's context.
   * @param {object} runtime - child runtime for truthful composition evidence.
   */
  #composeChildScope(childCtx, parentCtx, runtime) {
    if (childCtx === undefined || childCtx === null || typeof childCtx.get !== 'function') {
      throw adapterError('adapter/child-unsupported', 'the child setup exposed no scoped context, so its parent composition could not be joined', {})
    }
    const presets = contained(() => childCtx.get('agentPresets'), () => undefined)
    if (presets === undefined || presets === null || typeof presets.composeFrom !== 'function') {
      throw adapterError('adapter/child-unsupported', 'the child scope exposes no agent-preset join (the applyChildComposition seam), so the child would run without its parent tool plane', {})
    }
    if (parentCtx === undefined || parentCtx === null) {
      throw adapterError('adapter/child-unsupported', 'the parent agent exposes no context, so the child composition could not join its preset', {})
    }
    presets.composeFrom(childCtx, parentCtx)
    runtime.compositionJoined = true
    // The same fixed delegation-scope contribution the installed driver registers on
    // every in-process child. A host without a system-prompt projection still has a
    // composed tool plane, so this is recorded, never fatal.
    const systemPrompt = childCtx.systemPrompt
    if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.context === 'function') {
      systemPrompt.context({
        name: 'subagent:delegation',
        order: typeof systemPrompt.getContextOrder === 'function' ? systemPrompt.getContextOrder('SUBAGENT_DELEGATION') : undefined,
        text: SUBAGENT_DELEGATION_CONTEXT
      })
      runtime.delegationContextRegistered = true
    } else {
      runtime.enforcementNotes.push('the child scope exposes no system-prompt projection; the fixed delegation-scope statement was not registered')
    }
  }

  /**
   * Verify the route the host really PUBLISHED for a child BEFORE its first delivery.
   *
   * The installed factory stores the creation-time `agentOptions` verbatim on the live
   * agent (`Agent.options`), so that published value is the supported route evidence
   * for an `origin: 'subagent'` identity. `sessionController.selectModel` is
   * deliberately never consulted: the installed controller refuses every generic
   * operation on a subagent-owned session, so a tolerated refusal would confirm
   * nothing. A missing or different provider/model/reasoningEffort fails closed.
   *
   * @param {object} runtime - published child runtime carrying `requestedRoute`.
   * @returns {object} the verified route.
   */
  #verifyChildRoute(runtime) {
    const fail = (detail) => {
      throw adapterError('adapter/model-route-unverified', `the published child did not carry the requested model route: ${detail}`, {
        sessionId: runtime !== undefined && runtime !== null ? runtime.sessionId : null
      })
    }
    if (runtime === undefined || runtime === null) return fail('no child runtime exists')
    const expected = runtime.requestedRoute
    if (!isPlainObject(expected) || typeof expected.provider !== 'string' || typeof expected.model !== 'string') {
      return fail('no complete provider/model route was requested')
    }
    const options = runtime.agent !== undefined && runtime.agent !== null ? runtime.agent.options : undefined
    if (!isPlainObject(options)) {
      return fail('the published child exposes no agent options, so the route could not be verified')
    }
    if (options.provider !== expected.provider || options.model !== expected.model) {
      return fail(`expected ${String(expected.provider)}/${String(expected.model)}, saw ${String(options.provider)}/${String(options.model)}`)
    }
    const publishedEffort = typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0 ? options.reasoningEffort : undefined
    const expectedEffort = typeof expected.reasoningEffort === 'string' && expected.reasoningEffort.length > 0 ? expected.reasoningEffort : undefined
    if (publishedEffort !== expectedEffort) {
      return fail(`expected reasoningEffort ${String(expectedEffort)}, saw ${String(publishedEffort)}`)
    }
    runtime.routeVerified = true
    runtime.modelRoute = { ...expected }
    return runtime.modelRoute
  }

  /**
   * Request one child stop through the seam that actually owns the child.
   *
   * A published child is an `origin: 'subagent'` session, so the installed generic
   * session routing refuses `sessionController.cancel` for it exactly as it refuses
   * `prompt` (`session/agent-busy`: "owned by subagent routing"). The child's own
   * agent is therefore tried first, and the generic controller is only a fallback
   * for a child whose live agent this adapter no longer holds. Either way this is a
   * REQUEST only: `#confirmChildStopped` still has to observe the stop before the
   * child settles or its ledger slot is released.
   *
   * @param {object} runtime - live child runtime.
   * @returns {boolean} whether some host seam accepted the stop request.
   */
  #requestChildStop(runtime) {
    const childAgent = runtime !== undefined && runtime !== null ? runtime.agent : undefined
    if (childAgent !== undefined && childAgent !== null && typeof childAgent.cancel === 'function') {
      try {
        childAgent.cancel({ kind: 'parent' })
        runtime.stopMechanism = 'child-agent.cancel'
        runtime.stopRequested = true
        return true
      } catch {
        // Fall through to the generic seam below; the stop stays unproven either way.
      }
    }
    const controller = this.#service('sessionController')
    if (
      runtime !== undefined &&
      runtime !== null &&
      typeof runtime.sessionId === 'string' &&
      controller !== null &&
      controller !== undefined &&
      typeof controller.cancel === 'function'
    ) {
      try {
        controller.cancel({ sessionId: runtime.sessionId })
        runtime.stopMechanism = 'sessionController.cancel'
        runtime.stopRequested = true
        return true
      } catch {
        // Contained: only an observed stop may settle the child.
      }
    }
    return false
  }

  /** Truthful, observable record of which seam accepted one child stop request. */
  #emitChildStopRequested(record, child, runtime) {
    if (record === undefined || record === null || runtime === undefined || runtime === null) return
    this.#emit(record, record.current, 'child/stop-requested', {
      childId: child.childId,
      sessionId: runtime.sessionId,
      mechanism: runtime.stopMechanism ?? null
    })
  }

  #composeChildPrompt(record, grant) {
    return [
      `[dsh-adapter controlled child] parent task ${record.taskId} (depth 1)`,
      `objective: ${grant.objective}`,
      `cwd: ${grant.readRoots[0] ?? ''}`,
      `read roots: ${grant.readRoots.join(', ') || '(none)'}`,
      `write roots: ${grant.writeRoots.join(', ') || '(none)'}`,
      `allowed tools: ${grant.tools.join(', ') || '(none)'}`,
      `network: ${grant.allowNetwork ? 'allowed within the parent grant' : 'NOT allowed'}`,
      'acceptance:',
      ...grant.acceptance.map((item, index) => `  ${index + 1}. ${item}`),
      'You are a bounded child session. Delegation, shell tools and the native subagent tool are unavailable to you.',
      'Work only inside the roots and tools above and report facts, inferences and unknowns separately.'
    ].join('\n')
  }

  /**
   * Monotonic guard for a child session: the attenuated grant is the whole
   * authority, bridge tools are parent-only, shell/delegation are always denied,
   * paths are fenced to the child's own canonical roots, and the child's budget is
   * enforced HERE — synchronously, before any execution:
   *
   *  - one billable admission per DISTINCT `callId`, so a replayed tool/start
   *    event or a repeated call id is never charged twice;
   *  - the child's own `maxToolCalls` cap AND the owning root attempt's shared
   *    cap (a child tool start consumes one unit of the parent's tool budget);
   *  - a child that has exhausted its tool budget is denied regardless of waits or
   *    idempotent spawn replays (budgets live in the runtime, never re-resolved).
   */
  #makeChildGuard(childPlan, childSessionId) {
    return (exec) => {
      const name = exec !== undefined && exec !== null && typeof exec.name === 'string' ? exec.name : ''
      if (DELEGATION_SET.has(name)) return `[dsh-adapter] recursive-delegation tool "${name}" is disabled for a child session`
      if (SHELL_SET.has(name)) return `[dsh-adapter] shell tool "${name}" is disabled for a child session: it cannot be bounded`
      if (BRIDGE_TOOL_NAMES.has(name)) return `[dsh-adapter] bridge tool "${name}" is parent-only; a depth-1 child session cannot delegate, start bridge jobs or wake the root`
      if (!childPlan.allowedTools.has(name)) return `[dsh-adapter] tool "${name}" is not in this child session's attenuated grant`
      const kind = childPlan.classes.get(name) ?? classifyTool(name, this.#classificationOverrides)
      if (kind === 'owned-jobs') return `[dsh-adapter] owned-job tool "${name}" is unavailable to a child session`
      if (!childPlan.allowNetwork && (kind === 'network' || NETWORK_SET.has(name))) {
        return `[dsh-adapter] network tool "${name}" is disabled: the child grant denies network`
      }
      if (kind === 'forbidden' || FORBIDDEN_REASONS.has(name)) return `[dsh-adapter] tool "${name}" cannot be bounded to a child session`
      if (kind === 'unclassified' && !this.#options.allowUnclassifiedTools) {
        return `[dsh-adapter] tool "${name}" is unclassified and cannot be bounded for a child session`
      }
      const args = isPlainObject(exec.arguments) ? exec.arguments : undefined
      if (args !== undefined && args[ESCALATION_ARG] !== undefined) return '[dsh-adapter] sandbox escalation is denied for a child session'
      const claims = toolPathClaims(name, args)
      for (const claim of claims) {
        const canonical = canonicalTarget(claim.path, childPlan.cwd)
        if (!canonical.ok) return `[dsh-adapter] path "${claim.path}" cannot be safely resolved for child tool "${name}": ${canonical.reason}`
        if (claim.mode === 'write') {
          if (childPlan.writeRoots.length === 0) return `[dsh-adapter] write tool "${name}" denied: this child grant has no writeRoots`
          if (!isInsideAny(childPlan.writeRoots, canonical.path)) return `[dsh-adapter] write target "${claim.path}" resolves outside this child grant's writeRoots`
        } else if (!isInsideAny(childPlan.readRoots, canonical.path)) {
          return `[dsh-adapter] read target "${claim.path}" resolves outside this child grant's readRoots`
        }
      }
      if (claims.length === 0 && DEFAULT_BASE_READ_TOOLS.has(name) && !isInsideAny(childPlan.readRoots, childPlan.cwd)) {
        return `[dsh-adapter] tool "${name}" without an explicit path reads a cwd outside this child grant's readRoots`
      }
      return this.#admitChildToolStart(childSessionId, name, exec)
    }
  }

  /**
   * Charge ONE admitted child tool start against the child cap and the owning root
   * attempt's shared cap. Returns `undefined` when admitted, or the denial reason.
   */
  #admitChildToolStart(childSessionId, name, exec) {
    const runtime = typeof childSessionId === 'string' ? this.#childBySession.get(childSessionId) : undefined
    if (runtime === undefined) return undefined
    const callId = exec !== undefined && exec !== null && typeof exec.callId === 'string' && exec.callId.length > 0 ? exec.callId : undefined
    if (callId !== undefined && runtime.advertisedCallIds.has(callId)) return undefined
    const childCap = Number.isInteger(runtime.grant?.budgets?.maxToolCalls) ? runtime.grant.budgets.maxToolCalls : null
    if (childCap !== null && runtime.toolStarts >= childCap) {
      runtime.budgetExhausted = runtime.budgetExhausted ?? { budget: 'maxToolCalls', limit: childCap, scope: 'child', at: this.#now() }
      this.#recordChildBudgetDenial(runtime, { budget: 'maxToolCalls', limit: childCap, scope: 'child', name })
      return `[dsh-adapter] child tool-call budget exhausted (budgets.maxToolCalls=${childCap})`
    }
    const record = this.#records.get(runtime.taskId)
    const attempt = record !== undefined && record.current !== undefined ? record.current : undefined
    const sharedCap = attempt?.plan?.budgets?.maxToolCalls
    if (Number.isInteger(sharedCap) && record.toolCallsAdmitted >= sharedCap) {
      runtime.budgetExhausted = runtime.budgetExhausted ?? { budget: 'maxToolCalls', limit: sharedCap, scope: 'root-shared', at: this.#now() }
      this.#recordChildBudgetDenial(runtime, { budget: 'maxToolCalls', limit: sharedCap, scope: 'root-shared', name })
      return `[dsh-adapter] tool-call budget exhausted (budget.maxToolCalls=${sharedCap}); this child shares its parent's tool budget`
    }
    runtime.toolStarts += 1
    if (callId !== undefined) runtime.advertisedCallIds.add(callId)
    if (record !== undefined) {
      record.toolCallsAdmitted += 1
      // The root announced set stays ROOT-ONLY. A child identity is namespaced by
      // its own runtime.advertisedCallIds, so writing the bare provider callId
      // here would suppress a later genuine ROOT durable-only tool/start with the
      // same id (undercounting the shared root budget and losing the evidence).
      this.#emit(record, attempt, 'child/tool-start', {
        childId: runtime.childId,
        sessionId: runtime.sessionId,
        name,
        callId: callId ?? null,
        childToolStarts: runtime.toolStarts,
        sharedToolStarts: record.toolCallsAdmitted
      })
    }
    return undefined
  }

  #recordChildBudgetDenial(runtime, detail) {
    const record = this.#records.get(runtime.taskId)
    if (record === undefined) return
    this.#emit(record, record.current, 'child/budget-denied', { childId: runtime.childId, sessionId: runtime.sessionId, ...jsonSafe(detail) })
  }

  /** Child session events settle the child ledger; they never touch the parent attempt. */
  #onChildSessionEvent(child, event) {
    const type = event.type
    const data = event.data
    if (type === 'turn/start' && isPlainObject(data)) {
      child.boundTurn = data.turn
      return
    }
    if (type === 'user/message' && isPlainObject(data)) {
      const rpcId = isPlainObject(data.source) ? data.source.rpcId : undefined
      if (rpcId !== child.requestId || child.claimed) return
      child.claimed = true
      if (typeof data.turn === 'number') child.boundTurn = data.turn
      this.#supervisor?.setChildState(child.childId, { state: 'running' })
      return
    }
    if (type === 'assistant/message' && isPlainObject(data)) {
      if (child.boundTurn === undefined || data.turn !== child.boundTurn) return
      const text = extractMessageText(data.message)
      this.#retainChildOutput(child, text)
      child.finalText = text
      return
    }
    if (type === 'turn/end' && isPlainObject(data)) {
      if (child.terminal || child.boundTurn === undefined || data.turn !== child.boundTurn) return
      const reason = normalizeTurnEndReason(data.reason)
      const state = reason.kind === 'completed' ? 'completed' : reason.kind === 'aborted' ? 'cancelled' : 'failed'
      void this.#settleChild(child, state, reason)
    }
  }

  /**
   * Record one observed child settlement, tear down the owned child exactly once,
   * and release its slot only with proof. The persisted child state and retained
   * result data survive teardown; a throwing teardown leaves the child `unknown`
   * and keeps its slot.
   *
   * Settlement is MEMOIZED per child runtime. A child's own `turn/end` starts the
   * settlement; the parent's descendant-cancel path reaches settlement for the
   * same child only AFTER that turn/end marked it terminal (that observation is
   * its stop proof). Returning early for the second caller used to let the parent
   * task settle while the one in-flight `child/teardown` + `child/settled`
   * emission was still pending, so a post-settlement task event gate dropped the
   * only settlement evidence. Every settle path now AWAITS the same in-flight
   * settlement and observes the same real teardown verdict exactly once.
   *
   * @returns {Promise<object|undefined>} the single teardown verdict, or
   *   `undefined` when there is nothing to settle (no runtime, or already
   *   terminal without a recorded settlement).
   */
  #settleChild(child, state, reason) {
    if (child === undefined || child === null) return Promise.resolve(undefined)
    if (child.settlement !== undefined) return child.settlement
    if (child.terminal === true) return Promise.resolve(undefined)
    const settlement = this.#runChildSettlement(child, state, reason)
    child.settlement = settlement
    return settlement
  }

  /**
   * Await one child settlement and report a real verdict. It is bounded by the
   * adapter's stop-confirm budget like every other observed stop, and it never lets
   * an unexpected rejection escape: a settlement that does not produce a real
   * outcome in that window is an explicit unproven (`pending`) verdict, never a
   * clean stop and never an unbounded block on the caller. The in-flight settlement
   * still runs to completion and still emits its one outcome.
   */
  async #awaitChildSettlement(child, state, reason) {
    const bound = Number.isInteger(this.#options.stopConfirmTimeoutMs) ? Math.max(0, this.#options.stopConfirmTimeoutMs) : 0
    const outcome = this.#settleChild(child, state, reason).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, message: String((error && error.message) || error) })
    )
    if (bound > 0) {
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), bound)
        if (typeof timer.unref === 'function') timer.unref()
      })
      const raced = await Promise.race([outcome, timeout])
      clearTimeout(timer)
      if (raced === undefined) return { state: 'pending', slotReleased: false, outcome: 'unknown', pending: true }
      return raced.ok === true
        ? raced.value
        : { state: 'failed', slotReleased: false, outcome: 'failed', detail: { stage: 'settlement', message: raced.message } }
    }
    const result = await outcome
    return result.ok === true
      ? result.value
      : { state: 'failed', slotReleased: false, outcome: 'failed', detail: { stage: 'settlement', message: result.message } }
  }

  /** The exactly-once settlement body: terminalize, tear down, then emit once. */
  async #runChildSettlement(child, state, reason) {
    child.terminal = true
    child.stopConfirmed = true
    if (child.deadlineTimer !== undefined) {
      clearTimeout(child.deadlineTimer)
      child.deadlineTimer = undefined
    }
    const supervisor = this.#supervisor
    const summary = this.#childSummary(child, state)
    if (supervisor !== undefined) {
      supervisor.setChildState(child.childId, {
        state,
        stopConfirmed: true,
        summary,
        stopReason: reason?.kind ?? null,
        channel: reason?.detail ?? null
      })
    }
    let teardown
    try {
      teardown = await this.#teardownChild(child, `child ${state}`)
    } catch (error) {
      // A throwing teardown is unproven: the slot stays held and the child is
      // recorded unknown with the real failure, never a false clean stop.
      const failure = { stage: 'teardown', message: String((error && error.message) || error) }
      child.teardownState = 'failed'
      child.teardownOutcome = 'failed'
      child.teardownFailure = failure
      child.stopConfirmed = false
      if (supervisor !== undefined) supervisor.setChildState(child.childId, { state: 'unknown', stopConfirmed: false, summary, teardownFailure: failure })
      teardown = { state: 'failed', slotReleased: false, outcome: 'failed', detail: failure }
    }
    if (teardown.slotReleased !== true && supervisor !== undefined) {
      // Teardown could not prove the stop: the child stays counted and ambiguous,
      // and its recorded state must not look live.
      supervisor.setChildState(child.childId, { state: 'unknown', stopConfirmed: false, summary, teardownFailure: teardown.detail ?? teardown.outcome })
      child.stopConfirmed = teardown.outcome === 'disposed'
    }
    const parent = this.#records.get(child.taskId)
    if (parent !== undefined) this.#emit(parent, undefined, 'child/settled', { childId: child.childId, state, stopReason: reason?.kind ?? null, teardown: teardown.outcome })
    return teardown
  }

  /** Bounded child summary text derived from retained (already capped) output. */
  #childSummary(child, state) {
    const retained = typeof child.output?.text === 'string' ? child.output.text : ''
    const text = state === 'completed' ? child.finalText || retained : retained
    const cap = Number.isInteger(child.output?.limit) && child.output.limit > 0 ? child.output.limit : 2000
    return text.slice(0, Math.min(2000, cap))
  }

  async #childWait(record, exec, args) {
    const { attempt } = this.#authorizedParent(exec, 'dsh_child_wait')
    const supervisor = this.#supervisor
    if (supervisor === undefined) throw adapterError('adapter/child-unsupported', 'no supervisor is configured', {})
    const child = this.#requireChild(record, args, 'dsh_child_wait')
    const cap = supervisor.config.childSessions.maxWaitTimeoutMs
    const requested = isPlainObject(args) && Number.isInteger(args.waitMs) ? args.waitMs : supervisor.config.childSessions.waitTimeoutMs
    const waitMs = Math.max(0, Math.min(requested, cap))
    const started = this.#now()
    const deadline = started + waitMs
    let snapshot = supervisor.findChild(child.childId)
    while (snapshot !== undefined && !CHILD_TERMINAL.has(snapshot.state) && this.#now() < deadline) {
      if (exec !== undefined && exec !== null && exec.signal !== undefined && exec.signal.aborted === true) {
        throw adapterError('adapter/aborted', 'the child wait was cancelled by the caller', { childId: child.childId })
      }
      await sleep(Math.min(100, Math.max(1, deadline - this.#now())))
      snapshot = supervisor.findChild(child.childId)
    }
    return jsonSafe({
      ...this.#childSnapshot(snapshot),
      attemptIdBound: attempt.attemptId,
      waitedMs: Math.min(waitMs, this.#now() - started),
      waitBoundMs: waitMs,
      settled: snapshot !== undefined && CHILD_TERMINAL.has(snapshot.state)
    })
  }

  async #childResult(record, exec, args) {
    const { attempt } = this.#authorizedParent(exec, 'dsh_child_result')
    const supervisor = this.#supervisor
    if (supervisor === undefined) throw adapterError('adapter/child-unsupported', 'no supervisor is configured', {})
    const child = this.#requireChild(record, args, 'dsh_child_result')
    const offset = isPlainObject(args) && Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0
    const limit = isPlainObject(args) && Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 20000) : 8000
    const runtime = this.#childById.get(child.childId)
    const text = runtime !== undefined && runtime.output.text.length > 0 ? runtime.output.text : child.summary ?? ''
    const slice = text.slice(offset, offset + limit)
    return jsonSafe({
      childId: child.childId,
      taskId: child.taskId,
      attemptId: child.attemptId,
      sessionId: child.sessionId ?? null,
      state: child.state,
      stopConfirmed: child.stopConfirmed === true,
      text: slice,
      offset,
      nextOffset: Math.min(text.length, offset + limit),
      totalChars: text.length,
      hasMore: offset + limit < text.length,
      // Retained output is bounded by the child's own maxOutputChars grant; the
      // truncation is reported, never hidden.
      retained: {
        limit: runtime?.output.limit ?? null,
        truncated: runtime?.output.truncated === true,
        droppedChars: runtime?.output.dropped ?? 0
      },
      budgets: {
        toolStarts: runtime?.toolStarts ?? 0,
        maxToolCalls: runtime?.grant?.budgets?.maxToolCalls ?? null,
        deadlineMs: runtime?.deadlineMs ?? null,
        deadlineSource: runtime?.deadlineSource ?? null,
        exhausted: runtime?.budgetExhausted ?? null
      },
      teardown: runtime === undefined ? null : { state: runtime.teardownState, outcome: runtime.teardownOutcome ?? null },
      // Truthful child enforcement evidence (same vocabulary as #childSnapshot):
      // mandatory dispatch seam, the inherited-plane mask outcome, and the exact
      // delivery/stop seams that were really used.
      enforcement: {
        guardInstalled: runtime?.guardInstalled === true,
        restrictApplied: runtime?.restrictApplied === true,
        dispatchMechanism: runtime?.dispatchMechanism ?? null,
        routeVerified: runtime?.routeVerified === true,
        modelRoute: runtime?.modelRoute ?? null,
        compositionJoined: runtime?.compositionJoined === true,
        driveMechanism: runtime?.driveMechanism ?? null,
        stopMechanism: runtime?.stopMechanism ?? null,
        notes: Array.isArray(runtime?.enforcementNotes) ? [...runtime.enforcementNotes] : []
      },
      evidence: [
        {
          source: 'dsh-bridge-child',
          kind: 'child-settlement',
          childId: child.childId,
          sessionId: child.sessionId ?? null,
          state: child.state,
          stopReason: child.stopReason ?? null,
          currentAttemptId: attempt.attemptId
        }
      ],
      uncertainties:
        child.state === 'unknown'
          ? ['the child stop is unconfirmed; its work may or may not still be running']
          : child.state === 'starting'
            ? ['the child session was created but has not been observed running yet']
            : []
    })
  }

  async #childCancel(record, exec, args) {
    this.#authorizedParent(exec, 'dsh_child_cancel')
    const supervisor = this.#supervisor
    if (supervisor === undefined) throw adapterError('adapter/child-unsupported', 'no supervisor is configured', {})
    const child = this.#requireChild(record, args, 'dsh_child_cancel')
    const reason = isPlainObject(args) && typeof args.reason === 'string' && args.reason.trim().length > 0 ? args.reason.trim() : 'cancelled by parent'
    if (CHILD_TERMINAL.has(child.state)) {
      return jsonSafe({ ...this.#childSnapshot(child), cancelled: false, alreadyFinished: true, outcome: child.state })
    }
    if (child.state === 'unknown') {
      return jsonSafe({ ...this.#childSnapshot(child), cancelled: false, stopConfirmed: false, outcome: 'unknown' })
    }
    const runtime = this.#childById.get(child.childId)
    const accepted = this.#requestChildStop(runtime)
    if (accepted) this.#emitChildStopRequested(record, child, runtime)
    const confirmation = await this.#confirmChildStopped(child, runtime)
    if (confirmation.confirmed === true) {
      // Await the (possibly already in-flight) settlement and report the REAL
      // teardown verdict: a failed/unproven teardown is never a confirmed stop.
      const teardown = await this.#awaitChildSettlement(runtime ?? { ...child, terminal: false, output: { text: child.summary ?? '', truncated: false, dropped: 0, limit: null }, finalText: '' }, 'cancelled', { kind: 'aborted', detail: reason })
      if (teardown !== undefined && teardown !== null && teardown.slotReleased === true) {
        return jsonSafe({ ...this.#childSnapshot(supervisor.findChild(child.childId)), cancelled: true, accepted, stopConfirmed: true, observed: confirmation.observed, settlementOutcome: teardown.outcome })
      }
      return jsonSafe({
        ...this.#childSnapshot(supervisor.findChild(child.childId)),
        cancelled: false,
        accepted,
        stopConfirmed: false,
        outcome: 'unknown',
        observed: confirmation.observed,
        settlementOutcome: teardown?.outcome ?? 'unknown'
      })
    }
    if (runtime !== undefined) this.#markChildUnknown(runtime, 'child cancellation was not confirmed')
    else supervisor.markChildUnknown(child.childId, 'child cancellation was not confirmed')
    return jsonSafe({
      ...this.#childSnapshot(supervisor.findChild(child.childId)),
      cancelled: false,
      accepted,
      stopConfirmed: false,
      outcome: 'unknown',
      observed: confirmation.observed
    })
  }

  async #childList(record, exec) {
    this.#authorizedParent(exec, 'dsh_child_list')
    const supervisor = this.#supervisor
    if (supervisor === undefined) throw adapterError('adapter/child-unsupported', 'no supervisor is configured', {})
    const attempt = record.current
    const children = supervisor.childrenOf(record.taskId, { attemptId: attempt?.attemptId })
    return jsonSafe({ taskId: record.taskId, attemptId: attempt?.attemptId ?? null, children: children.map((child) => this.#childSnapshot(child)) })
  }

  /** Observed child stop proof: live agent idle/absent and no live job owned by the child session. */
  async #confirmChildStopped(child, runtime) {
    const deadline = this.#now() + Math.max(0, this.#options.stopConfirmTimeoutMs)
    let observed = []
    for (;;) {
      const sessionId = runtime !== undefined && typeof runtime.sessionId === 'string' ? runtime.sessionId : child.sessionId
      const agents = this.#service('agents')
      const live = agents !== null && agents !== undefined && typeof agents.get === 'function' && typeof sessionId === 'string' ? contained(() => agents.get(sessionId), () => undefined) : undefined
      const liveJobs = this.#liveJobsForSession(sessionId)
      const status = live !== undefined && live !== null ? contained(() => live.status, () => undefined) : undefined
      // A recovered child with no in-process runtime has no observed settlement:
      // its stop is unknown until a real turn/end is seen, so it never confirms.
      const attemptSettled = runtime !== undefined && runtime.terminal === true
      observed = [
        live === undefined || live === null ? 'agent-absent' : status === 'idle' ? 'agent-idle' : 'agent-running',
        attemptSettled ? 'child-attempt-settled' : 'child-attempt-active',
        `live-jobs:${liveJobs.length}`
      ]
      const confirmed = (live === undefined || live === null || status === 'idle') && attemptSettled && liveJobs.length === 0
      if (confirmed || this.#now() >= deadline) return { confirmed, observed }
      await sleep(Math.min(CONFIRM_POLL_MS, Math.max(1, deadline - this.#now())))
    }
  }

  /** Live jobs owned by one session id (bridge jobs and native jobs alike). */
  #liveJobsForSession(sessionId) {
    const jobs = this.#service('jobs')
    if (typeof sessionId !== 'string' || jobs === null || jobs === undefined || typeof jobs.list !== 'function') return []
    const listed = contained(
      () => jobs.list(sessionId),
      () => undefined
    )
    if (!Array.isArray(listed)) return []
    return listed.filter((job) => isPlainObject(job) && (job.owner === sessionId || job.ownerSession === sessionId) && (job.status === 'running' || job.status === 'stopping'))
  }

  /** Used by descendent cancellation from the parent stop path. */
  async #cancelChildRuntime(child) {
    const runtime = this.#childById.get(child.childId)
    const accepted = this.#requestChildStop(runtime)
    if (accepted) this.#emitChildStopRequested(this.#records.get(child.taskId), child, runtime)
    const confirmation = await this.#confirmChildStopped(child, runtime)
    if (confirmation.confirmed === true) {
      // AWAIT the one in-flight child settlement (normally owned by the child's own
      // `turn/end`). Returning early here let the parent task settle while the only
      // `child/teardown` + `child/settled` emission was still pending, and a
      // post-settlement task event gate then dropped that settlement evidence.
      const teardown = await this.#awaitChildSettlement(
        runtime ?? { ...child, terminal: false, output: { text: child.summary ?? '', truncated: false, dropped: 0, limit: null }, finalText: '' },
        'cancelled',
        { kind: 'aborted', detail: 'parent cancelled' }
      )
      // Capacity is released only for a PROVEN teardown outcome. A failed or
      // unproven teardown keeps the child counted and ambiguous.
      if (teardown !== undefined && teardown !== null && teardown.slotReleased === true) {
        return { stopConfirmed: true, state: 'cancelled', settlementOutcome: teardown.outcome }
      }
      return { stopConfirmed: false, state: 'unknown', outcome: 'unknown', settlementOutcome: teardown?.outcome ?? 'unknown', observed: confirmation.observed }
    }
    if (runtime !== undefined) this.#markChildUnknown(runtime, 'descendant cancellation was not confirmed')
    return { stopConfirmed: false, outcome: 'unknown', observed: confirmation.observed }
  }

  async #startBridgeJob(record, exec, args) {
    const { attempt } = this.#authorizedParent(exec, 'dsh_job_start')
    const grants = attempt.plan?.grants?.backgroundJobs
    if (grants === undefined || grants.enabled !== true) {
      throw adapterError('adapter/job-unsupported', 'this task has no approved backgroundJobs grant', { taskId: record.taskId })
    }
    const registry = this.#commandJobs
    if (registry === undefined) throw adapterError('adapter/job-unsupported', 'no operator command-profile registry is configured', {})
    const profileId = isPlainObject(args) && typeof args.profileId === 'string' ? args.profileId.trim() : ''
    if (profileId.length === 0) throw adapterError('jobs/invalid-job', 'profileId is required', { field: 'profileId' })
    if (!grants.profileIds.includes(profileId)) {
      throw adapterError('adapter/job-profile-ungranted', `command profile "${profileId}" is not granted to this task`, { profileId })
    }
    const live = this.#liveJobsForSession(record.sessionId)
    if (live.length >= grants.maxJobs) {
      throw adapterError('supervisor/job-limit', `task "${record.taskId}" already has ${live.length} live background job(s); the grant allows ${grants.maxJobs}`, {
        liveJobs: live.length,
        maxJobs: grants.maxJobs
      })
    }
    let started
    try {
      started = startCommandJob({
        ctx: this.#ctx,
        registry,
        profileId,
        owner: record.sessionId,
        label: isPlainObject(args) && typeof args.label === 'string' ? args.label : undefined
      })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'jobs/controller-unavailable') {
        throw adapterError('adapter/job-unsupported', error.message, { cause: error.code })
      }
      throw error
    }
    // Durable job identity BEFORE any further work: a restart can never reattach
    // or replay it, and recovery reports it unknown.
    const entry = { jobId: started.jobId, profileId, state: 'running', stopConfirmed: false, startedAt: this.#now() }
    record.commandJobs = [...(record.commandJobs ?? []), entry]
    this.#supervisor?.persist?.update?.(record.taskId, { commandJobs: record.commandJobs })
    this.#emit(record, attempt, 'job/started', { jobId: started.jobId, profileId, isolation: started.isolation })
    return jsonSafe({ ...started, evidence: [{ source: 'dsh-bridge-job', kind: 'job-start', jobId: started.jobId, profileId, isolation: started.isolation }] })
  }

  async #bridgeReply(record, exec, args) {
    const { attempt } = this.#authorizedParent(exec, 'dsh_bridge_reply')
    const supervisor = this.#supervisor
    const grant = attempt.plan?.grants?.rootCallback
    if (supervisor === undefined || grant === null || grant === undefined) {
      throw adapterError('adapter/reply-unsupported', 'this task has no trusted root callback grant', { taskId: record.taskId })
    }
    if (!isPlainObject(args) || typeof args.replyId !== 'string' || args.replyId.trim().length === 0) {
      throw adapterError('supervisor/invalid-reply', 'replyId must be a nonblank string', { field: 'replyId' })
    }
    const kind = args.kind === undefined ? 'needs-input' : args.kind
    if (kind !== 'needs-input' && kind !== 'blocked') throw adapterError('supervisor/invalid-reply', 'kind must be needs-input or blocked', { field: 'kind' })
    if (typeof args.summary !== 'string' || args.summary.trim().length === 0) {
      throw adapterError('supervisor/invalid-reply', 'summary must be a nonblank string', { field: 'summary' })
    }
    // The raw worker bound is validated BEFORE prefixing and is never widened. The
    // controller-generated prefix is added only when the result still fits the
    // integration wire bound; otherwise the reply is REFUSED. It is never sliced,
    // because silent truncation would report a delivery of text the model never wrote.
    if (args.summary.length > MAX_RAW_REPLY_CHARS) {
      throw adapterError(
        'supervisor/invalid-reply',
        `summary must be at most ${MAX_RAW_REPLY_CHARS} characters (got ${args.summary.length})`,
        { field: 'summary' }
      )
    }
    // The shared sink contract is unchanged (the wire kind stays `needs-input`);
    // the durable `replyKind` and the controller-generated `[blocked]` /
    // `[needs-input]` summary prefix carry the distinction to the recipient.
    const summary = `[${kind}] ${args.summary}`
    if (summary.length > MAX_WIRE_REPLY_CHARS) {
      throw adapterError(
        'supervisor/invalid-reply',
        `the prefixed reply summary would be ${summary.length} characters, above the ${MAX_WIRE_REPLY_CHARS}-character integrated wire bound; shorten the summary (it is never truncated)`,
        { field: 'summary' }
      )
    }
    const result = await supervisor.emitNotification({
      taskId: record.taskId,
      attemptId: attempt.attemptId,
      eventId: callbackEventId({ taskId: record.taskId, attemptId: attempt.attemptId, logicalId: `reply:${args.replyId.trim()}`, prefix: 'reply' }),
      targetId: grant.targetId,
      kind: 'needs-input',
      summary,
      replyKind: kind
    })
    this.#emit(record, attempt, 'task/reply', {
      replyId: args.replyId.trim(),
      replyKind: kind,
      outcome: result.outcome,
      delivery: result.delivery ?? 'unknown',
      eventId: result.eventId
    })
    return jsonSafe({
      taskId: record.taskId,
      attemptId: attempt.attemptId,
      replyId: args.replyId.trim(),
      replyKind: kind,
      eventId: result.eventId,
      delivered: result.delivered === true,
      delivery: result.delivery ?? 'unknown',
      outcome: result.outcome
    })
  }

  #terminalize(record, attempt, { kind, detail, seq, time }) {
    if (attempt === undefined || attempt.terminal) return
    attempt.terminal = true
    attempt.stopReason = kind
    attempt.stopDetail = detail
    attempt.rootStatus = mapTerminalStatus(kind)
    attempt.state = attempt.rootStatus
    attempt.endedAt = this.#now()
    if (attempt.timeoutTimer !== undefined) {
      clearTimeout(attempt.timeoutTimer)
      attempt.timeoutTimer = undefined
    }
    record.stopConfirmed = true
    const activeJobs = this.#ownedLiveJobs(record).length
    // A live child is owned work exactly like a live job: it is reported so the
    // service never records a settled task while a descendant is still running.
    const activeChildren = this.#supervisor !== undefined ? this.#supervisor.liveChildren(record.taskId).length : 0
    const result = this.#attemptResult(record, attempt, { activeJobs, activeChildren, seq, time })
    record.lastResult = result
    this.#emit(record, attempt, 'attempt/terminal', { seq, time, status: attempt.rootStatus, stopReason: kind, stopDetail: detail })
    this.#deliver(attempt.hooks !== undefined ? attempt.hooks : record.hooks, 'onResult', result)
  }

  /**
   * Build the `onResult` payload in the root's vocabulary
   * (`{status,text,stopConfirmed,activeJobs,evidence?,checks?,uncertainties?}`).
   */
  #attemptResult(record, attempt, { activeJobs, activeChildren = 0, seq, time }) {
    const uncertainties = []
    if (!record.enforcementMechanisms.includes('restrict')) {
      uncertainties.push('the agent tool presentation was not filtered (tools.restrict unavailable); dispatch stayed guarded')
    }
    if (record.sandboxModeOverride === null && record.packet.scope.writeRoots.length === 0) {
      uncertainties.push('the session sandbox mode could not be pinned to read-only for a write-free task')
    }
    if (record.routeVerified !== true) uncertainties.push('the host did not verify the effective model route')
    if (record.agentPresetMatched === false) uncertainties.push('the host selected a different agent preset than requested')
    if (activeJobs > 0) uncertainties.push(`${activeJobs} background job(s) owned by this task were still live at settlement`)
    if (activeChildren > 0) uncertainties.push(`${activeChildren} child session(s) of this task were still live at settlement`)
    if (attempt.timedOut === true) uncertainties.push('this attempt was stopped by the task timeout budget')
    return {
      taskId: record.taskId,
      revision: record.revision,
      attemptId: attempt.attemptId,
      sessionId: record.sessionId,
      requestId: attempt.requestId,
      mode: attempt.mode,
      status: attempt.rootStatus,
      adapterStatus: attempt.state,
      text: attempt.assistantText,
      finalText: attempt.rootStatus === 'completed' ? attempt.finalText ?? attempt.assistantText : undefined,
      stopConfirmed: record.stopConfirmed === true,
      activeJobs,
      // Reported only when children exist so a childless task's payload keeps its
      // historical shape.
      ...(activeChildren > 0 ? { activeChildren } : {}),
      stopReason: attempt.stopReason,
      stopDetail: attempt.stopDetail,
      interrupted: attempt.interrupted === true,
      seq,
      time,
      finishedAt: attempt.endedAt,
      evidence: [
        {
          source: 'dsh-host',
          kind: 'attempt-settlement',
          sessionId: record.sessionId,
          requestId: attempt.requestId,
          attemptId: attempt.attemptId,
          turn: attempt.boundTurn ?? null,
          lastSeq: record.lastSeq ?? null,
          hostEvents: record.events.length,
          hostEventsDropped: record.eventsDropped,
          toolStarts: record.toolCallsAdmitted,
          toolResults: attempt.toolResultEvents,
          stopDetail:attempt.stopDetail??null
        }
      ],
      checks: [],
      uncertainties
    }
  }

  #mapTerminalAttemptStatus(kind) {
    return mapTerminalStatus(kind)
  }

  // -- enforcement planning ----------------------------------------------

  #planEnforcement(packet, options = {}) {
    const { scope } = packet
    const cwdCanonical = canonicalTarget(packet.cwd, packet.cwd)
    if (!cwdCanonical.ok) {
      throw adapterError('adapter/scope-unsupported', `the task cwd cannot be canonicalized: ${cwdCanonical.reason}`, {
        code: cwdCanonical.code
      })
    }
    const cwd = cwdCanonical.path

    if (scope.allowShell) {
      throw adapterError(
        'adapter/shell-unsupported',
        'scope.allowShell: true cannot be enforced by this adapter: the installed DSH sandbox vocabulary bounds FILE effects only ' +
          '(read-only | workspace-write | danger-full-access) and states that "Network and process visibility are outside this vocabulary", ' +
          "so an arbitrary shell cannot be bounded to this task's allowedTools/readRoots/writeRoots/allowNetwork",
        { requested: true, evidence: 'dsh-sandbox lib/types/index.d.ts SandboxMode doc comment' }
      )
    }

    const readRoots = []
    for (const root of scope.readRoots) {
      const canonical = canonicalRoot(root, cwd)
      if (!canonical.ok) {
        throw adapterError('adapter/scope-unsupported', `scope.readRoots entry "${root}" cannot be canonicalized: ${canonical.reason}`, {
          code: canonical.code,
          root
        })
      }
      readRoots.push(canonical.path)
    }
    const writeRoots = []
    for (const root of scope.writeRoots) {
      const canonical = canonicalRoot(root, cwd)
      if (!canonical.ok) {
        throw adapterError('adapter/scope-unsupported', `scope.writeRoots entry "${root}" cannot be canonicalized: ${canonical.reason}`, {
          code: canonical.code,
          root
        })
      }
      if (!isInside(cwd, canonical.path)) {
        throw adapterError(
          'adapter/scope-unsupported',
          `scope.writeRoots entry "${canonical.path}" is outside the task workspace "${cwd}"; the real filesystem sandbox is rooted at the ` +
            'session cwd, so this write scope cannot be enforced',
          { writeRoot: canonical.path, workspace: cwd }
        )
      }
      writeRoots.push(canonical.path)
    }

    const { classes } = this.#classifyAllowedTools(scope.allowedTools, scope)

    const allowedTools = new Set(scope.allowedTools)
    for (const name of allowedTools) {
      const kind = classes.get(name)
      if (kind === 'delegation') {
        throw adapterError('adapter/scope-unsupported', `scope.allowedTools names recursive-delegation tool "${name}"`, { tool: name })
      }
      if (kind === 'shell') {
        throw adapterError('adapter/scope-unsupported', `scope.allowedTools names shell tool "${name}" while allowShell is false`, {
          tool: name
        })
      }
      if (kind === 'network' && !scope.allowNetwork) {
        throw adapterError('adapter/scope-unsupported', `scope.allowedTools names network tool "${name}" while allowNetwork is false`, {
          tool: name
        })
      }
      if ((kind === 'forbidden' || FORBIDDEN_REASONS.has(name)) && !this.#options.allowForbiddenTools) {
        // A by-name forbidden tool has a recorded reason; a tool a coordinator
        // override re-labelled as `forbidden` does not, so fall back to a
        // concrete refusal instead of emitting "undefined".
        const reason =
          FORBIDDEN_REASONS.get(name) ?? 'the coordinator classified it as forbidden, so its capability is treated as unbounded'
        throw adapterError(
          'adapter/scope-unsupported',
          `scope.allowedTools names tool "${name}", which cannot be bounded to a task scope in v1: ${reason}`,
          { tool: name, reason }
        )
      }
    }

    const budgets = {
      timeoutMs: packet.budget?.timeoutMs ?? this.#options.defaultBudgets.timeoutMs,
      maxToolCalls: packet.budget?.maxToolCalls ?? this.#options.defaultBudgets.maxToolCalls,
      maxOutputChars: packet.budget?.maxOutputChars ?? this.#options.defaultBudgets.maxOutputChars
    }

    // -- additive optional grants (contract supervisor-event-wake-v1) -------
    // Absence is the historical behaviour. Presence must be supported by this
    // host and is refused (never silently dropped, clamped or widened) when the
    // host cannot enforce it.
    const bridgeStatus = this.#bridgeGrantStatus()

    let rootCallback = null
    if (packet.rootCallback !== undefined) {
      const persisted = options.callbackBinding
      if (
        isPlainObject(persisted) &&
        persisted.grantId === packet.rootCallback.grantId &&
        typeof persisted.targetId === 'string' &&
        persisted.targetId.length > 0
      ) {
        // The persisted submission snapshot is authoritative: send paths never
        // re-resolve the grant, so a later config change cannot retarget a task.
        rootCallback = {
          grantId: persisted.grantId,
          targetId: persisted.targetId,
          boundAt: Number.isFinite(persisted.boundAt) ? persisted.boundAt : null
        }
      } else {
        if (this.#supervisor === undefined) {
          throw adapterError('adapter/reply-unsupported', 'rootCallback requires a configured supervisor with trusted callback grants', {})
        }
        try {
          rootCallback = this.#supervisor.callbackSnapshot({ grantId: packet.rootCallback.grantId, taskKey: packet.idempotencyKey })
        } catch (error) {
          throw adapterError('adapter/callback-ungranted', String((error && error.message) || error), { grantId: packet.rootCallback.grantId })
        }
      }
    }

    let childSessions = { enabled: false, maxChildren: 0, toolNames: [] }
    if (packet.scope.childSessions !== undefined) {
      if (bridgeStatus.children.supported !== true) {
        throw adapterError(
          'adapter/child-unsupported',
          `scope.childSessions is granted but this host cannot offer child sessions: ${bridgeStatus.children.reason ?? 'unsupported'}`,
          { reason: bridgeStatus.children.reason ?? null }
        )
      }
      const requestedChildren = packet.scope.childSessions.maxChildren
      const hostChildrenCap = bridgeStatus.children.maxChildrenPerTask
      if (Number.isInteger(requestedChildren) && requestedChildren > hostChildrenCap) {
        throw adapterError('adapter/child-unsupported', `scope.childSessions.maxChildren=${requestedChildren} exceeds the host child limit ${hostChildrenCap}`, {
          requested: requestedChildren,
          host: hostChildrenCap
        })
      }
      childSessions = {
        enabled: true,
        maxChildren: Number.isInteger(requestedChildren) ? requestedChildren : hostChildrenCap,
        toolNames: Array.isArray(packet.scope.childSessions.toolNames) ? [...packet.scope.childSessions.toolNames] : [...allowedTools]
      }
    }

    let backgroundJobs = { enabled: false, profileIds: [], maxJobs: 0 }
    if (packet.scope.backgroundJobs !== undefined) {
      const registry = this.#commandJobs
      if (registry === undefined) {
        throw adapterError('adapter/job-unsupported', 'scope.backgroundJobs is granted but no operator command-profile registry is configured', {})
      }
      // A profile that is not granted on this host is a REQUEST error, refused
      // before any host-support question and long before a job could exist.
      const grantIds = packet.scope.backgroundJobs.profileIds
      for (const id of grantIds) {
        if (typeof registry.has !== 'function' || !registry.has(id)) {
          throw adapterError('adapter/job-profile-ungranted', `command profile "${id}" is not granted on this host`, { profileId: id })
        }
      }
      if (bridgeStatus.jobs.supported !== true) {
        throw adapterError(
          'adapter/job-unsupported',
          `scope.backgroundJobs is granted but this host cannot enforce the profile contract: ${bridgeStatus.jobs.reason ?? 'unsupported'}`,
          { reason: bridgeStatus.jobs.reason ?? null }
        )
      }
      const requestedJobs = packet.scope.backgroundJobs.maxJobs
      const hostJobsCap = bridgeStatus.jobs.maxJobsPerTask ?? 2
      if (Number.isInteger(requestedJobs) && requestedJobs > hostJobsCap) {
        throw adapterError('adapter/job-unsupported', `scope.backgroundJobs.maxJobs=${requestedJobs} exceeds the host job limit ${hostJobsCap}`, {
          requested: requestedJobs,
          host: hostJobsCap
        })
      }
      backgroundJobs = {
        enabled: true,
        profileIds: [...grantIds],
        maxJobs: Number.isInteger(requestedJobs) ? requestedJobs : hostJobsCap
      }
    }

    // -- long-task supervisor grant (`packet.project`) ----------------------
    // A project packet plans an immutable WORKER ENVELOPE; host enablement and host
    // caps are enforced here, before any task, worktree or session exists.
    let supervisorProject = null
    if (packet.project !== undefined) {
      if (writeRoots.length > 0) {
        throw adapterError('adapter/invalid-project', 'a supervisor-project packet must not declare its own scope.writeRoots; worker writes are declared inside packet.project.workerScope', { field: 'scope.writeRoots' })
      }
      if (scope.childSessions !== undefined || scope.backgroundJobs !== undefined) {
        throw adapterError('adapter/invalid-project', 'a supervisor-project packet must not grant childSessions or backgroundJobs; its workers are declared through supervisor-only tools', {})
      }
      if (bridgeStatus.projects.supported !== true) {
        throw adapterError('adapter/project-unsupported', `packet.project is granted but this host cannot supervise a long project: ${bridgeStatus.projects.reason ?? 'unsupported'}`, {
          reason: bridgeStatus.projects.reason ?? null
        })
      }
      if (this.#projects === undefined) {
        throw adapterError('adapter/project-unsupported', 'packet.project requires an injected long-task supervisor runtime', {})
      }
      try {
        supervisorProject = resolveProjectGrant(packet.project, this.#projects.config ?? this.#options.supervisorProjects)
      } catch (error) {
        const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : null
        const mapped =
          code === 'project/unsupported' ? 'adapter/project-unsupported'
            : code === 'project/host-cap' ? 'adapter/project-host-cap'
              : code === 'project/scope-unsupported' ? 'adapter/scope-unsupported'
                : 'adapter/invalid-project'
        throw adapterError(mapped, String((error && error.message) || error), { code })
      }
    }

    return {
      allowedTools,
      classes,
      cwd,
      readRoots,
      writeRoots,
      allowNetwork: scope.allowNetwork,
      budgets,
      grants: { childSessions, backgroundJobs, rootCallback, supervisorProject },
      denyNames: [...DELEGATION_TOOLS, ...SHELL_TOOLS, ...FORBIDDEN_REASONS.keys()].filter((name) => !allowedTools.has(name))
    }
  }

  /**
   * Classify a requested tool allowlist with the SAME fences `#planEnforcement`
   * uses. Extracted so plan enforcement and `#toolAdmission` (the single
   * capability/preflight report path, which additionally applies the guard's
   * by-name refusals) cannot drift: one classification, one closed-open boundary.
   *
   * Every failure below is the pre-existing fail-closed condition for a tool whose
   * capability the adapter cannot bound to a task scope. Order is significant:
   * `run_code` first, then the unclassified/forbidden boundary, then delegation,
   * shell and the network permission gate, exactly as `start` enforced them.
   *
   * @param {readonly string[]} names - requested tool names (`scope.allowedTools`).
   * @param {{allowNetwork?: boolean, allowShell?: boolean}} scope - the packet scope the names came from.
   * @returns {{classes: Map<string,string>, executable: string[]}} classification verdict.
   */
  #classifyAllowedTools(names, scope) {
    const allowNetwork = scope?.allowNetwork === true
    const allowShell = scope?.allowShell === true
    const overrides = this.#classificationOverrides
    const classes = new Map()
    const unclassified = []
    for (const name of names) {
      if (name === 'run_code') {
        throw adapterError(
          'adapter/scope-unsupported',
          'scope.allowedTools must not name the reserved PTC transport "run_code": it cannot be restricted and would re-expose every visible tool',
          { tool: name }
        )
      }
      const kind = classifyTool(name, overrides)
      classes.set(name, kind)
      if (kind === 'supervisor-project') {
        throw adapterError(
          'adapter/scope-unsupported',
          `scope.allowedTools must not name the supervisor-only tool "${name}": it is granted by packet.project and registered additively on the authorized supervisor only`,
          { tool: name }
        )
      }
      if (kind === 'unclassified' && !this.#options.allowUnclassifiedTools) unclassified.push(name)
    }
    if (unclassified.length > 0) {
      throw adapterError(
        'adapter/scope-unsupported',
        `scope.allowedTools names tool(s) this adapter cannot bound: ${unclassified.join(', ')}; ` +
          'register them through options.toolClassifications or drop them from the packet',
        { unclassified }
      )
    }

    for (const name of classes.keys()) {
      const kind = classes.get(name)
      if (kind === 'delegation') {
        throw adapterError('adapter/scope-unsupported', `scope.allowedTools names recursive-delegation tool "${name}"`, { tool: name })
      }
      if (kind === 'shell') {
        throw adapterError('adapter/scope-unsupported', `scope.allowedTools names shell tool "${name}" while allowShell is false`, {
          tool: name
        })
      }
      if (kind === 'network' && !allowNetwork) {
        throw adapterError('adapter/scope-unsupported', `scope.allowedTools names network tool "${name}" while allowNetwork is false`, {
          tool: name
        })
      }
      if ((kind === 'forbidden' || FORBIDDEN_REASONS.has(name)) && !this.#options.allowForbiddenTools) {
        // A by-name forbidden tool has a recorded reason; a tool a coordinator
        // override re-labelled as `forbidden` does not, so fall back to a
        // concrete refusal instead of emitting "undefined".
        const reason =
          FORBIDDEN_REASONS.get(name) ?? 'the coordinator classified it as forbidden, so its capability is treated as unbounded'
        throw adapterError(
          'adapter/scope-unsupported',
          `scope.allowedTools names tool "${name}", which cannot be bounded to a task scope in v1: ${reason}`,
          { tool: name, reason }
        )
      }
    }

    const executable = []
    for (const name of classes.keys()) {
      const kind = classes.get(name)
      const runnable =
        kind === 'fs' ||
        kind === 'other' ||
        kind === 'owned-jobs' ||
        (kind === 'network' && allowNetwork) ||
        (kind === 'shell' && allowShell)
      if (runnable) executable.push(name)
    }
    return { classes, executable }
  }

  #ownershipCheck(record, toolName, args) {
    const jobId = isPlainObject(args) ? args[OWNED_JOB_TOOL_ARGS[toolName]] : undefined
    if (typeof jobId !== 'string' || jobId.trim().length === 0) {
      return `tool "${toolName}" requires an explicit job id; ownership cannot be verified`
    }
    const jobs = this.#service('jobs')
    if (jobs === null || jobs === undefined || typeof jobs.get !== 'function') {
      return `tool "${toolName}" denied: ctx.jobs.get is unavailable, so job ownership cannot be verified`
    }
    let snapshot
    try {
      // The installed JobRegistry fences access by the CALLER'S session id
      // (`list/get/read/readAt/kill/wait(id, caller?: SessionId, …)`), never by an
      // agent object.
      snapshot = jobs.get(jobId, record.sessionId)
    } catch (error) {
      return `tool "${toolName}" denied: job "${jobId}" is unknown or not visible to this task (${String((error && error.message) || error)})`
    }
    if (!isPlainObject(snapshot)) return `tool "${toolName}" denied: job "${jobId}" has no readable snapshot`
    // `JobView.owner` is the installed field; `ownerSession` is the legacy
    // spelling kept only for older host doubles. An unowned job is not owned by
    // this task and is denied.
    const owner = snapshot.owner ?? snapshot.ownerSession
    if (owner !== record.sessionId) {
      return `tool "${toolName}" denied: job "${jobId}" is not owned by this task`
    }
    return undefined
  }

  #makeGuard(record, plan) {
    // The guard is installed once per task and resolves the live attempt at call
    // time, so `continue()` attempts are covered without a second registration.
    return (exec) => {
      const name = exec !== undefined && exec !== null && typeof exec.name === 'string' ? exec.name : ''
      const callId = exec !== undefined && exec !== null && typeof exec.callId === 'string' ? exec.callId : undefined
      const deny = (reason, extra) => {
        const detail = jsonSafe(extra ?? {})
        record.violations.push({ timestamp: this.#now(), tool: name, reason, ...detail })
        this.#emit(record, record.current, 'policy/violation', { violation: 'tool-denied', tool: name, reason, ...detail })
        return `[dsh-adapter] ${reason}`
      }
      const kind = plan.classes.get(name) ?? classifyTool(name, this.#classificationOverrides)
      // Bridge-owned tools are admitted by their TASK GRANT, not by the packet
      // allowlist. Without the grant they are denied by name here even if a
      // classification override re-labels them (defence in depth).
      const bridgeKind = CHILD_SESSION_SET.has(name) ? 'child' : BRIDGE_JOB_SET.has(name) ? 'job' : BRIDGE_REPLY_SET.has(name) ? 'reply' : SUPERVISOR_PROJECT_SET.has(name) ? 'supervisor' : undefined
      let bridgeGranted = false
      if (bridgeKind !== undefined) {
        const grants = plan.grants
        const granted =
          bridgeKind === 'child'
            ? grants?.childSessions?.enabled === true
            : bridgeKind === 'job'
              ? grants?.backgroundJobs?.enabled === true
              : bridgeKind === 'supervisor'
                ? grants?.supervisorProject !== null && grants?.supervisorProject !== undefined
                : grants?.rootCallback !== null && grants?.rootCallback !== undefined
        if (!granted) {
          const grantName =
            bridgeKind === 'child' ? 'childSessions' : bridgeKind === 'job' ? 'backgroundJobs' : bridgeKind === 'supervisor' ? 'packet.project' : 'rootCallback'
          return deny(`bridge tool "${name}" is task-granted and this task has no approved ${grantName} grant`)
        }
        bridgeGranted = true
      }
      if (record.current?.mode === 'understanding' && !FS_READ_TOOLS.has(name) && bridgeKind !== 'reply') {
        return deny('Understanding phase permits read tools only until controller approval')
      }
      if (!bridgeGranted && !plan.allowedTools.has(name)) return deny(`tool "${name}" is not in this task's allowedTools`)
      if (kind === 'delegation' || DELEGATION_SET.has(name)) return deny(`recursive-delegation tool "${name}" is disabled for this task`)
      if (kind === 'shell' || SHELL_SET.has(name)) {
        return deny(`shell tool "${name}" is disabled: this adapter cannot bound an arbitrary shell to the task scope`)
      }
      if (!plan.allowNetwork && (kind === 'network' || NETWORK_SET.has(name))) {
        return deny(`network tool "${name}" is disabled: scope.allowNetwork is false`)
      }
      if (kind === 'forbidden' || (FORBIDDEN_REASONS.has(name) && !this.#options.allowForbiddenTools)) {
        if (!this.#options.allowForbiddenTools) {
          return deny(`tool "${name}" cannot be bounded to this task scope: ${FORBIDDEN_REASONS.get(name)}`)
        }
      }

      const args = isPlainObject(exec.arguments) ? exec.arguments : undefined
      if (args !== undefined && args[ESCALATION_ARG] !== undefined) {
        return deny('sandbox escalation is denied: a bounded task may not widen its own sandbox mode')
      }

      if (kind === 'owned-jobs') {
        const ownershipFailure = this.#ownershipCheck(record, name, args)
        if (ownershipFailure !== undefined) return deny(ownershipFailure)
      }

      // The guard resolves the LIVE attempt's plan at call time and honours a per-round
      // budget base, so a bounded recurrent round is fenced by ITS OWN narrowed allowance
      // instead of the previous (larger) round plan. Every legacy attempt has base 0 and
      // `record.current.plan === plan`, so the historical cumulative check and its exact
      // message are unchanged.
      const activePlan = isPlainObject(record.current?.plan) ? record.current.plan : plan
      const roundBase = Number.isInteger(record.current?.roundBudgetBase) ? record.current.roundBudgetBase : 0
      if (record.toolCallsAdmitted - roundBase >= activePlan.budgets.maxToolCalls) {
        return deny(`tool-call budget exhausted (budget.maxToolCalls=${activePlan.budgets.maxToolCalls})`)
      }
      const claims = toolPathClaims(name, args)
      for (const claim of claims) {
        const canonical = canonicalTarget(claim.path, plan.cwd)
        if (!canonical.ok) {
          return deny(`path "${claim.path}" cannot be safely resolved for tool "${name}": ${canonical.reason}`, {
            code: canonical.code
          })
        }
        if (claim.mode === 'write') {
          if (plan.writeRoots.length === 0) return deny(`write tool "${name}" denied: this task declares no writeRoots`)
          if (!isInsideAny(plan.writeRoots, canonical.path)) {
            return deny(`write target "${claim.path}" resolves outside this task's writeRoots`, { target: canonical.path })
          }
        } else if (!isInsideAny(plan.readRoots, canonical.path)) {
          return deny(`read target "${claim.path}" resolves outside this task's readRoots`, { target: canonical.path })
        }
      }
      if (claims.length === 0 && DEFAULT_BASE_READ_TOOLS.has(name)) {
        // glob/grep default to the session cwd when no path is given.
        if (!isInsideAny(plan.readRoots, plan.cwd)) {
          return deny(`tool "${name}" without an explicit path reads the session cwd, which is outside this task's readRoots`)
        }
      }

      record.toolCallsAdmitted += 1
      const wasAnnounced=callId!==undefined&&record.announcedCallIds.has(callId)
      if (callId !== undefined) record.announcedCallIds.add(callId)
      if(!wasAnnounced)this.#emit(record, record.current, 'tool/start', { name, callId, source: 'guard', toolCallIndex: record.toolCallsAdmitted })
      return undefined
    }
  }

  /**
   * Verify that every allowlisted tool is actually visible to this agent before
   * installing any enforcement. Runs after session creation (when the agent's
   * scope first exists) and fails closed when a requested capability is absent.
   */
  #verifyVisibleTools(record, plan) {
    const scopedTools = this.#scopedTools(record.agent)
    if (scopedTools === undefined) {
      throw adapterError(
        'adapter/enforcement-unavailable',
        'the agent-scoped tools service is unavailable; a bounded task cannot be started without an agent-scoped enforcement seam',
        { orphanSessionId: record.sessionId, service: 'tools' }
      )
    }
    if (typeof scopedTools.schemas !== 'function') {
      throw adapterError('adapter/enforcement-unavailable', 'the agent-scoped tools registry does not expose schemas(agent)', {
        service: 'tools',
        orphanSessionId: record.sessionId
      })
    }
    const visible = contained(
      () => scopedTools.schemas(record.agent),
      () => undefined
    )
    if (!Array.isArray(visible)) {
      throw adapterError('adapter/enforcement-unavailable', 'tools.schemas(agent) did not return a schema array', {
        service: 'tools',
        orphanSessionId: record.sessionId
      })
    }
    const available = new Set()
    for (const schema of visible) {
      if (isPlainObject(schema) && typeof schema.name === 'string') available.add(schema.name)
    }
    const missing = [...plan.allowedTools].filter((name) => !available.has(name))
    if (missing.length > 0) {
      throw adapterError(
        'adapter/scope-unsupported',
        `scope.allowedTools names tool(s) not available to this session: ${missing.join(', ')}`,
        { missing, available: [...available].sort(), orphanSessionId: record.sessionId }
      )
    }
    record.availableTools = [...available].sort()
    record.scopedTools = scopedTools
    return scopedTools
  }

  #attachEnforcement(record, plan) {
    const scopedTools = record.scopedTools ?? this.#scopedTools(record.agent)
    const mechanisms = []

    if (scopedTools !== undefined && typeof scopedTools.restrict === 'function') {
      const available = new Set(record.availableTools ?? [])
      const deny = [...new Set([...plan.denyNames, ...NETWORK_TOOLS])].filter(
        (name) => available.has(name) && !plan.allowedTools.has(name)
      )
      const filter = { allow: [...plan.allowedTools] }
      // An allowlist already excludes every other tool. Agent-local aliases may
      // be visible in schemas but absent from the global names accepted by deny.
      try {
        const disposer = scopedTools.restrict(filter)
        if (typeof disposer === 'function') record.disposers.push(disposer)
        mechanisms.push('restrict')
      } catch (error) {
        record.enforcementNotes.push(`tools.restrict() failed, guard-only enforcement remains: ${String((error && error.message) || error)}`)
      }
    } else {
      record.enforcementNotes.push('tools.restrict() is unavailable; presentation is unfiltered (dispatch stays guarded)')
    }

    const guard = this.#makeGuard(record, plan)
    let guardInstalled = false
    if (scopedTools !== undefined && typeof scopedTools.guard === 'function') {
      try {
        const disposer = scopedTools.guard(guard)
        if (typeof disposer === 'function') record.disposers.push(disposer)
        guardInstalled = true
        mechanisms.push('guard')
      } catch (error) {
        record.enforcementNotes.push(`tools.guard() failed: ${String((error && error.message) || error)}`)
      }
    }

    if (!guardInstalled) {
      const agentCtx = contained(() => record.agent.ctx, () => undefined)
      if (agentCtx !== undefined && agentCtx !== null && typeof agentCtx.on === 'function') {
        const listener = (exec, next) => {
          const reason = guard(exec)
          if (reason !== undefined) return { kind: 'deny', reason }
          return next()
        }
        const disposer = contained(() => agentCtx.on('tools/pre-execute', listener), () => undefined)
        if (typeof disposer === 'function') {record.disposers.push(disposer);mechanisms.push('pre-execute');guardInstalled=true}
      }
    }

    if (!guardInstalled) {
      throw adapterError(
        'adapter/enforcement-unavailable',
        'no agent-scoped pre-dispatch enforcement seam is available (tools.guard and agent-scoped tools/pre-execute both unavailable); ' +
          'a bounded task cannot be started without one',
        { orphanSessionId: record.sessionId, service: 'tools' }
      )
    }
    record.enforcementMechanisms = mechanisms

    // Pin a write-free task to the read-only sandbox mode through the documented
    // single write path. Failure is contained but reported: the path fence still
    // denies writes, and the OS fence then stays at the session default.
    if (plan.writeRoots.length === 0) {
      const session = contained(() => record.agent.session, () => undefined)
      const appended = contained(
        () => {
          if (session === undefined || session === null || typeof session.append !== 'function') return false
          session.append('sandbox/mode', { mode: 'read-only' })
          return true
        },
        () => false
      )
      record.sandboxModeOverride = appended === true ? 'read-only' : null
      if (appended !== true) {
        record.enforcementNotes.push('could not pin the session sandbox mode to read-only (session.append unavailable)')
      }
    }
  }

  // -- prompt composition (bare-packet convenience path only) -------------

  #composeUnderstandingPrompt(packet, model) {
    if (this.#options.buildPrompt !== undefined) {
      const text = this.#options.buildPrompt(packet, { model, skills: [] })
      if (typeof text !== 'string' || text.length === 0) {
        throw adapterError('adapter/prompt-composition', 'options.buildPrompt returned no text', {})
      }
      return text
    }
    return [
      `[dsh-adapter understanding gate] task ${packet.id} revision ${packet.revision}`,
      `title: ${packet.title}`,
      `objective: ${packet.objective}`,
      `role: ${packet.role}`,
      `cwd: ${packet.cwd}`,
      `scope.readRoots: ${packet.scope.readRoots.join(', ') || '(none)'}`,
      `scope.writeRoots: ${packet.scope.writeRoots.join(', ') || '(none)'}`,
      `scope.allowedTools: ${packet.scope.allowedTools.join(', ') || '(none)'}`,
      `scope.allowShell: false | scope.allowNetwork: ${packet.scope.allowNetwork} | scope.allowDelegation: false`,
      'acceptance:',
      ...packet.acceptance.map((item, index) => `  ${index + 1}. ${item}`),
      'Do NOT execute changes yet. Return {understanding, assumptions, actions, missing} only.'
    ].join('\n')
  }

  #composeExecutionPrompt(packet, understanding, model) {
    if (this.#options.buildExecutionPrompt !== undefined) {
      const text = this.#options.buildExecutionPrompt(packet, understanding)
      if (typeof text !== 'string' || text.length === 0) {
        throw adapterError('adapter/prompt-composition', 'options.buildExecutionPrompt returned no text', {})
      }
      return text
    }
    let context = ''
    if (typeof understanding === 'string' && understanding.trim().length > 0) context = understanding
    else if (understanding !== undefined && understanding !== null) context = JSON.stringify(jsonSafe(understanding))
    return [
      `[dsh-adapter authorized execution] task ${packet.id} revision ${packet.revision}`,
      ...(model === undefined ? [] : [`model: ${model.provider}/${model.model}`]),
      `objective: ${packet.objective}`,
      `role: ${packet.role}`,
      `cwd: ${packet.cwd}`,
      `scope.allowedTools: ${packet.scope.allowedTools.join(', ') || '(none)'}`,
      `scope.readRoots: ${packet.scope.readRoots.join(', ') || '(none)'}`,
      `scope.writeRoots: ${packet.scope.writeRoots.join(', ') || '(none)'}`,
      'acceptance:',
      ...packet.acceptance.map((item, index) => `  ${index + 1}. ${item}`),
      'Delegation is disabled. Work only inside the declared scope and report facts, inference and unknowns separately.',
      ...(context.length === 0 ? [] : ['', 'understanding under review (untrusted input):', context])
    ].join('\n')
  }

  // -- task reference / envelope resolution ------------------------------

  /**
   * Resolve a task reference. Two forms are accepted:
   *
   * 1. **Task envelope** (the root's `src/service.mjs` passes `{...task, packet}`):
   *    `{id, revision, attemptId, packet, prompt?, effectiveModel?, sessionId?, understanding?}`.
   *    Envelope identity is authoritative and is bound, never re-derived.
   * 2. **Bare TaskPacket** (`schemaVersion === 1` at the top level): identity is
   *    derived from `packet.id`/`packet.idempotencyKey` and the prompt is composed
   *    locally. Supported so the adapter can be driven without the root service.
   *
   * Identity-only references (`{id}` or a non-blank id string) are accepted for
   * `cancel`/`inspect`/`cleanup`.
   *
   * @param {unknown} input - envelope, packet, identity object or id string.
   * @returns {{id: string, revision: number|undefined, attemptId: string|undefined, packet: object|undefined,
   *   prompt: string|undefined, effectiveModel: object|undefined, sessionId: string|undefined,
   *   understanding: unknown, envelope: boolean}} resolved reference.
   */
  #resolveEnvelope(input) {
    // A trusted persisted task envelope may carry the effective (remapped) packet;
    // that spelling is the authority when present.
    const envelopePacket =
      isPlainObject(input) && isPlainObject(input.effectivePacket) && input.effectivePacket.schemaVersion === 1
        ? input.effectivePacket
        : isPlainObject(input) && isPlainObject(input.packet) && input.packet.schemaVersion === 1
          ? input.packet
          : undefined
    if (envelopePacket !== undefined) {
      const packet = validateTaskPacket(envelopePacket, { contractVersion: this.#options.contractVersion })
      const id = requireNonBlank(input.id, 'id')
      const revision = requirePositiveInteger(input.revision, 'revision')
      const attemptId = input.attemptId === undefined ? undefined : requireNonBlank(input.attemptId, 'attemptId')
      const requestId = input.requestId == null ? undefined : requireNonBlank(input.requestId, 'requestId')
      // Trusted-store provenance. Only a task the ROOT store minted for this
      // bridge owner may ever be reconstructed after an adapter reset.
      const origin = input.origin === undefined ? undefined : requireNonBlank(input.origin, 'origin')
      const ownerId = input.ownerId === undefined ? undefined : requireNonBlank(input.ownerId, 'ownerId')
      // The trusted, submission-time callback target snapshot. When present it is
      // the ONLY destination authority for this task's replies; send paths never
      // re-resolve the grant.
      const callbackBinding = isPlainObject(input.callbackBinding) ? jsonSafe(input.callbackBinding) : undefined
      let prompt
      if (input.prompt !== undefined) prompt = requireString(input.prompt, 'prompt')
      let sessionId
      if (input.sessionId !== undefined && input.sessionId !== null) sessionId = requireNonBlank(input.sessionId, 'sessionId')
      // Service-private clarification history (trusted-store provenance, lifecycle
      // contract 20260925.2). Only the last entry's `previousAttempt` snapshot may
      // ever bind reset recovery to an owned session; a session id invented in the
      // envelope itself is verified against that snapshot instead of being adopted.
      const clarifications = Array.isArray(input.clarifications)
        ? input.clarifications.filter((entry) => isPlainObject(entry)).map((entry) => jsonSafe(entry))
        : undefined
      const previousAttempt = isPlainObject(input.previousAttempt) ? jsonSafe(input.previousAttempt) : undefined
      // Service-persisted UI-archive evidence. `sessionArchivedAt` is the UI hide
      // marker and `archivedAt` is the (separate) physical-cleanup marker; either
      // proves the session is hidden when the adapter has no local memory of it.
      const archivedSpelling =
        typeof input.sessionArchivedAt === 'number' && Number.isFinite(input.sessionArchivedAt)
          ? input.sessionArchivedAt
          : typeof input.archivedAt === 'number' && Number.isFinite(input.archivedAt)
            ? input.archivedAt
            : undefined
      let effectiveModel
      if (input.effectiveModel !== undefined && input.effectiveModel !== null) {
        if (!isPlainObject(input.effectiveModel)) throw failField('effectiveModel', 'expected a plain object')
        effectiveModel = {
          provider: requireNonBlank(input.effectiveModel.provider, 'effectiveModel.provider'),
          model: requireNonBlank(input.effectiveModel.model, 'effectiveModel.model'),
          ...(input.effectiveModel.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: requireNonBlank(input.effectiveModel.reasoningEffort, 'effectiveModel.reasoningEffort') })
        }
      }
      return {
        id,
        revision,
        attemptId,
        requestId,
        origin,
        ownerId,
        callbackBinding,
        confirmedCancellation:input.status==='cancelled'&&input.stopConfirmed===true&&Array.isArray(input.result?.evidence)&&input.result.evidence.some(e=>e.source==='dsh-host'&&e.kind==='attempt-settlement'&&e.requestId===requestId&&e.attemptId===attemptId&&e.stopDetail==='host-idle-after-cancel'),
        clarifications,
        previousAttempt,
        sessionArchivedAt: archivedSpelling,
        packet,
        prompt,
        effectiveModel,
        sessionId,
        understanding: input.understanding,
        envelope: true
      }
    }
    if (isPlainObject(input) && input.schemaVersion === 1) {
      const packet = validateTaskPacket(input, { contractVersion: this.#options.contractVersion })
      return {
        id: packet.id,
        revision: packet.revision,
        attemptId: undefined,
        requestId: undefined,
        origin: undefined,
        ownerId: undefined,
        packet,
        prompt: undefined,
        effectiveModel: undefined,
        sessionId: undefined,
        understanding: undefined,
        envelope: false
      }
    }
    if (typeof input === 'string' && input.trim().length > 0) {
      return {
        id: input.trim(),
        revision: undefined,
        attemptId: undefined,
        requestId: undefined,
        origin: undefined,
        ownerId: undefined,
        packet: undefined,
        prompt: undefined,
        effectiveModel: undefined,
        sessionId: undefined,
        understanding: undefined,
        envelope: false
      }
    }
    if (isPlainObject(input) && typeof input.id === 'string' && input.id.trim().length > 0) {
      if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision <= 0)) {
        throw failField('revision', 'expected a positive integer')
      }
      return {
        id: input.id.trim(),
        revision: input.revision,
        attemptId: undefined,
        requestId: typeof input.requestId === 'string' && input.requestId.length > 0 ? input.requestId : undefined,
        origin: undefined,
        ownerId: undefined,
        packet: undefined,
        prompt: undefined,
        effectiveModel: undefined,
        sessionId: typeof input.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : undefined,
        understanding: undefined,
        envelope: false
      }
    }
    throw adapterError('adapter/invalid-packet', 'expected a task envelope, a TaskPacket, or an identity object {id, revision?}', {})
  }

  /**
   * Whether a reference is a ROOT-store task this bridge owns and may act on
   * after an adapter reset. Everything else is refused: never adopt an arbitrary
   * session, never act on another owner's task.
   * @param {object} ref - resolved reference.
   * @returns {{trusted: boolean, reason?: string}} verdict.
   */
  #trustedPersistedTask(ref) {
    const expected = this.#options.ownerId
    if (typeof expected !== 'string' || expected.length === 0) {
      return { trusted: false, reason: 'no ownerId is configured for this adapter, so a persisted task cannot be trusted' }
    }
    if (ref.envelope !== true || ref.packet === undefined) return { trusted: false, reason: 'not a persisted task envelope' }
    if (ref.origin !== 'codex-bridge') return { trusted: false, reason: `task origin "${ref.origin ?? '(absent)'}" is not "codex-bridge"` }
    if (ref.ownerId !== expected) return { trusted: false, reason: 'task ownerId does not match this adapter owner' }
    if (ref.sessionId === undefined) return { trusted: false, reason: 'task has no sessionId' }
    if (ref.requestId === undefined) return { trusted: false, reason: 'task has no requestId to bind the attempt to' }
    if (ref.attemptId === undefined) return { trusted: false, reason: 'task has no attemptId' }
    return { trusted: true }
  }

  #requireRecord(ref) {
    const record = this.#records.get(ref.id)
    if (record === undefined) {
      throw adapterError('adapter/unknown-task', `no task "${ref.id}" is known to this adapter`, { taskId: ref.id })
    }
    return record
  }

  /**
   * Ownership fence for envelope-carrying calls: a call may only act on the
   * session this adapter created for that task.
   */
  #assertOwnership(record, ref) {
    if (ref.sessionId !== undefined && ref.sessionId !== record.sessionId) {
      throw adapterError('adapter/session-mismatch', `task "${ref.id}" is bound to session "${record.sessionId}", not "${ref.sessionId}"`, {
        taskId: ref.id,
        boundSessionId: record.sessionId,
        receivedSessionId: ref.sessionId
      })
    }
    if (ref.revision !== undefined && ref.revision !== record.revision) {
      throw adapterError('adapter/revision-mismatch', `task "${ref.id}" is known at revision ${record.revision}, not ${ref.revision}`, {
        taskId: ref.id,
        knownRevision: record.revision
      })
    }
  }

  // -- attempt lifecycle --------------------------------------------------

  #newAttempt(record, mode, hooks, providedAttemptId) {
    const index = record.attempts.length
    const attemptId = providedAttemptId ?? `${record.taskId}@${record.revision}#${index}`
    const attempt = {
      index,
      attemptId,
      requestId: `dsa-${this.#nextSequence()}-${record.taskId}`.slice(0, 200),
      mode,
      state: 'created',
      hooks,
      claimed: false,
      boundTurn: undefined,
      assistantText: '',
      finalText: '',
      interrupted: false,
      toolCallEvents: 0,
      toolResultEvents: 0,
      cancelRequested: false,
      terminal: false,
      rootStatus: undefined,
      startedAt: this.#now()
    }
    record.attempts.push(attempt)
    record.current = attempt
    return attempt
  }

  #armTimeout(record, attempt, plan) {
    // Currency fence at arm time: a settled attempt, or an attempt a newer one has
    // already replaced, is never given a timeout that could cancel live work.
    if (attempt === undefined || attempt.terminal === true || record.current !== attempt) return
    if (plan === undefined || plan === null || plan.budgets === undefined) return
    const timeoutMs = plan.budgets.timeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return
    const timer = setTimeout(() => {
      contained(() => {
        // Currency fence at fire time: an old timer must never cancel a newer
        // attempt, and a settled attempt is never re-terminalized.
        if (attempt.terminal === true || record.current !== attempt) return
        attempt.timedOut = true
        this.#emit(record, attempt, 'attempt/timeout', { timeoutMs })
        void this.#stop(record, { reason: `budget.timeoutMs=${timeoutMs} exceeded` })
      })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    attempt.timeoutTimer = timer
  }

  async #submit(record, attempt, text) {
    const controller = this.#requireService('sessionController')
    const signal = typeof AbortController === 'function' ? new AbortController().signal : undefined
    attempt.state = 'submitting'
    try {
      await controller.prompt(
        { requestId: attempt.requestId, sessionId: record.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        signal
      )
    } catch (error) {
      attempt.state = 'unknown'
      attempt.rootStatus = 'unknown'
      attempt.error = String((error && error.message) || error)
      attempt.terminal = false
      record.stopConfirmed = false
      const rejection = adapterError('adapter/prompt-rejected', `prompt dispatch outcome is unknown for task "${record.taskId}": ${attempt.error}`, {
        sessionId: record.sessionId,
        requestId: attempt.requestId
      })
      rejection.dispatched = true
      throw rejection
    }
    if (!attempt.terminal) attempt.state = 'queued'
    attempt.submittedAt = this.#now()
    this.#emit(record, attempt, 'attempt/queued', { mode: attempt.mode })
  }

  #resolveRequestedRoute(ref, packet) {
    const source = ref.effectiveModel ?? packet.model ?? this.#options.defaultModel
    if (!isPlainObject(source) || typeof source.provider !== 'string' || typeof source.model !== 'string') {
      throw adapterError('adapter/model-route', 'a complete {provider, model} route is required', {})
    }
    return {
      provider: source.provider,
      model: source.model,
      ...(typeof source.reasoningEffort === 'string' && source.reasoningEffort.length > 0
        ? { reasoningEffort: source.reasoningEffort }
        : {})
    }
  }

  // -- tool contract (classification support vs probed host catalog) ------

  /**
   * The by-name refusals the ENFORCEMENT STACK applies regardless of a
   * classification override.
   *
   * Plan admission deliberately stays permissive here: a coordinator override
   * that re-labels `pwsh` or `subagent` as `other` is admitted at plan time and
   * the monotonic guard then denies the dispatch by name (defence in depth; see
   * the guard test for shell/network overrides). The capability report must
   * therefore consult this predicate, or it would advertise a tool the guard
   * rejects — exactly the "never advertise shell/delegation that the guard
   * rejects" boundary.
   *
   * `run_code` needs no entry: `#classifyAllowedTools` refuses it by name before
   * any classification is consulted. `allowNetwork` mirrors the guard's network
   * gate, which only denies when the packet denies network.
   *
   * @param {string} name - tool name.
   * @param {boolean} allowNetwork - the admission context's network permission.
   * @returns {{reason: string, code: string}|undefined} refusal, when the guard
   *   unconditionally denies this name in that context.
   */
  #guardNameRefusal(name, allowNetwork) {
    if (DELEGATION_SET.has(name)) {
      return {
        reason: `recursive-delegation tool "${name}" is disabled for every bounded task`,
        code: 'adapter/scope-unsupported'
      }
    }
    if (SHELL_SET.has(name)) {
      return {
        reason:
          `shell tool "${name}" is disabled: this adapter cannot bound an arbitrary shell to the task scope, and the guard denies it by ` +
          'name even when a classification override re-labels it',
        code: 'adapter/scope-unsupported'
      }
    }
    if (!allowNetwork && NETWORK_SET.has(name)) {
      return {
        reason:
          `network tool "${name}" is disabled: scope.allowNetwork is false, and the guard denies it by name even when a classification ` +
          'override re-labels it',
        code: 'adapter/scope-unsupported'
      }
    }
    return undefined
  }

  /**
   * The single plan-admission verdict for one tool name.
   *
   * Every capability report path (`#enforceableToolNames`, `#deniedToolReport`,
   * `#toolBoundaryReport`/`preflight`) resolves a name through this method
   * instead of a second, approximate kind filter, so a report can never advertise
   * a name the plan refuses, and the guard's by-name refusals are reported as
   * denials with their reason rather than hidden. The verdict is:
   *
   *   1. the real plan decision from `#classifyAllowedTools` — the same function
   *      `#planEnforcement` runs, including its by-name `FORBIDDEN_REASONS`
   *      refusal, which a classification override cannot bypass — and then
   *   2. the guard's by-name hard refusals (`#guardNameRefusal`), which the plan
   *      intentionally leaves to the guard but a report must not hide.
   *
   * `allowNetwork: true` is the capability context because `scope.allowNetwork`
   * is a per-packet permission, not an unconditional refusal: network tools stay
   * conditionally supported. `allowShell` is always false because
   * `scope.allowShell: true` is refused outright, so no shell tool is ever
   * enforceable.
   *
   * Only the adapter's own fail-closed refusal (`adapter/scope-unsupported`) is
   * translated into a denial. Any other throw is an internal defect and
   * propagates to the caller instead of being reported as an unenforceable tool.
   *
   * @param {string} name - tool name to admit or refuse.
   * @param {{allowNetwork?: boolean}} [permission] - capability permission context.
   * @returns {{admitted: boolean, toolClass: string, reason?: string, code?: string}} verdict.
   */
  #toolAdmission(name, permission = {}) {
    const allowNetwork = permission.allowNetwork === true
    const toolClass = classifyTool(name, this.#classificationOverrides)
    // Bridge-owned tools are granted per task, so their admission verdict is the
    // host's ability to enforce that grant, never a packet allowlist entry.
    if (BRIDGE_TOOL_NAMES.has(name)) {
      const status = this.#bridgeGrantStatus()
      const support = CHILD_SESSION_SET.has(name) ? status.children : BRIDGE_JOB_SET.has(name) ? status.jobs : SUPERVISOR_PROJECT_SET.has(name) ? status.projects : status.reply
      if (support.supported === true) return { admitted: true, toolClass }
      return {
        admitted: false,
        toolClass,
        code: 'adapter/scope-unsupported',
        reason: `tool "${name}" is task-granted and this host cannot offer it: ${support.reason ?? 'unsupported'}`
      }
    }
    try {
      const { classes } = this.#classifyAllowedTools([name], { allowNetwork, allowShell: false })
      const guardRefusal = this.#guardNameRefusal(name, allowNetwork)
      if (guardRefusal !== undefined) {
        return { admitted: false, toolClass, reason: guardRefusal.reason, code: guardRefusal.code }
      }
      return { admitted: true, toolClass: classes.get(name) ?? toolClass }
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'adapter/scope-unsupported') throw error
      const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : undefined
      return {
        admitted: false,
        toolClass,
        reason: message ?? `tool "${name}" is refused by this adapter's plan fence`,
        code: 'adapter/scope-unsupported'
      }
    }
  }

  /**
   * Names the adapter can bind to a task scope, from the admission the
   * enforcement stack actually applies (plan admission plus the guard's by-name
   * refusals, including coordinator overrides). This is classification support
   * only; it is never a claim that a name is registered on this host or visible
   * to any agent, and a listed tool still needs its own permission gate (network)
   * or per-call ownership check (jobs).
   *
   * A name survives only when `#toolAdmission` admits it, so a coordinator
   * override that reclassifies a BUILT-IN name into a refused kind — or that
   * re-labels a shell/delegation name as `other` — removes it here instead of
   * leaving it advertised while the guard would deny the dispatch. Shell tools,
   * delegation tools and `run_code` are therefore never listed; `network` and
   * `owned-jobs` names are listed conditionally and keep their existing
   * permission/ownership gates.
   * @returns {string[]} sorted names.
   */
  #enforceableToolNames() {
    const candidates = new Set([...STATIC_TOOL_NAMES, ...this.#classificationOverrides.keys()])
    const enforceable = []
    for (const name of candidates) {
      const verdict = this.#toolAdmission(name, { allowNetwork: true })
      // A name with no bounded classification is executable only through the
      // coordinator's `allowUnclassifiedTools` opt-in; it is not classification
      // support, so it is not advertised as enforceable here (it stays out of the
      // denied list too, matching plan admission).
      if (verdict.admitted && verdict.toolClass !== 'unclassified') enforceable.push(name)
    }
    return enforceable.sort()
  }

  /**
   * Per-tool boundary verdicts for the requested names, resolved through
   * `#toolAdmission` (the same plan admission `start` applies) rather than a
   * second kind filter. Each name gets exactly one verdict, so `denied` lists
   * every requested name the enforcement stack would refuse — with the concrete
   * reason — while `executable` lists the names that survive.
   * @param {readonly string[]} names - requested tool names.
   * @param {{allowNetwork?: boolean, allowShell?: boolean}} scope - declared scope.
   * @returns {{executable: string[], denied: {name: string, reason: string, code: string, toolClass: string}[]}} report.
   */
  #toolBoundaryReport(names, scope) {
    const allowNetwork = scope?.allowNetwork === true
    const executable = []
    const denied = []
    for (const name of names) {
      const verdict = this.#toolAdmission(name, { allowNetwork })
      if (verdict.admitted) executable.push(name)
      else denied.push({ name, reason: verdict.reason, code: verdict.code, toolClass: verdict.toolClass })
    }
    return { executable, denied }
  }

  /**
   * Query the host tool registry schemas WITHOUT creating a session, executing a
   * tool or mutating anything.
   *
   * The installed `tools.schemas(scope?)` is a SCOPE PRESENTATION view, not a
   * complete catalog: an omitted scope resolves to the GLOBAL layer alone
   * (`scopeChainOf(undefined)` is empty), and the preset/agent plane is merged
   * only for a supplied scope. There is no public complete all-scopes catalog, so
   * an agentless probe can never prove that a per-agent/preset tool is PRESENT or
   * — critically — ABSENT. It is therefore reported as unverified
   * (`{verified: false, names: null}`) instead of being promoted to a complete,
   * possibly empty, catalog that would fabricate availability or tool absence.
   * Real availability is proved only against a REAL created agent inside
   * `#verifyVisibleTools`, before any prompt.
   *
   * When an actual agent is supplied, that agent's scoped view is probed. A
   * catalog only counts as verified when the WHOLE array has the expected shape.
   * A malformed entry (`null`, `{name: 42}`, a blank name, a non-object) means the
   * registry contract is not trustworthy, so the probe reports
   * `{verified: false, names: null}` instead of silently dropping the entry and
   * claiming a verified (possibly empty) catalog. An empty array of valid entries
   * is a genuinely verified empty catalog for that scope.
   * @param {object} [agent] - a REAL created agent whose scoped view is probed.
   * @returns {Promise<{verified: boolean, names: string[]|null, reason?: string}>} probe verdict.
   */
  async #probeToolCatalog(agent) {
    if (agent === undefined || agent === null) {
      return { verified: false, names: null, reason: 'agentless-global-view-is-not-a-complete-catalog' }
    }
    // Only the AGENT-SCOPED registry is bound to a real agent's visibility — the
    // same seam `#verifyVisibleTools` proves. The host registry with an agent
    // passed as a scope would still be a presentation view, never a complete one.
    const tools = this.#scopedTools(agent)
    if (tools === null || tools === undefined || typeof tools.schemas !== 'function') {
      return { verified: false, names: null, reason: 'agent-scoped-tools-unavailable' }
    }
    const schemas = await settleAsync(() => tools.schemas(agent), undefined)
    if (!Array.isArray(schemas)) return { verified: false, names: null, reason: 'tools-schemas-not-an-array' }
    const names = new Set()
    for (const schema of schemas) {
      if (!isPlainObject(schema) || typeof schema.name !== 'string' || schema.name.trim().length === 0) {
        return { verified: false, names: null, reason: 'malformed-schema-entry' }
      }
      names.add(schema.name)
    }
    return { verified: true, names: [...names].sort() }
  }

  /**
   * The capability surface's denied list, over the union of
   *   - the statically classified names (delegation, shell, `run_code`, forbidden),
   *   - the classification override names, and
   *   - the verified live host catalog names,
   * where every name is decided by `#toolAdmission`. Because the decision is the
   * same plan admission the report's enforceable list uses, a name is never
   * advertised as enforceable and denied at once, and a name a classification
   * override re-labels into a refused kind (`read` as `forbidden`/`shell`/
   * `delegation`, `skill` as `other`) is denied WITH its concrete reason. A
   * catalog-only name with no bounded classification (e.g. `apply_patch`) is
   * denied with the explicit "registered but unbounded" reason. When the catalog
   * is unverified (`names === null`) only the static and override names are
   * reported; when the coordinator opts into unclassified tools the discovered
   * names are not denied, matching plan enforcement.
   * @param {string[]|null} catalogNames - verified host catalog names, or null.
   * @returns {{name: string, reason: string, code: string, toolClass: string}[]} denied tools.
   */
  #deniedToolReport(catalogNames) {
    const candidates = new Set([...STATIC_TOOL_NAMES, ...this.#classificationOverrides.keys()])
    if (catalogNames !== null) for (const name of catalogNames) candidates.add(name)
    const { denied } = this.#toolBoundaryReport([...candidates], { allowNetwork: true })
    if (catalogNames === null) return denied
    for (const entry of denied) {
      // A statically classified or coordinator-overridden name keeps the concrete
      // plan reason; only a catalog-only name with no bounded classification gets
      // the explicit "registered on this host but unbounded" reason.
      if (classifyTool(entry.name) !== 'unclassified' || this.#classificationOverrides.has(entry.name)) continue
      entry.reason = `tool "${entry.name}" is registered on this host but this adapter cannot bound its capability (unclassified), so it is denied`
    }
    return denied
  }

  // -- public API ---------------------------------------------------------

  /**
   * Report the enforcement seams this adapter can actually use on this host.
   * Every flag is derived from the live context; nothing is assumed.
   * @returns {Promise<object>} JSON-safe capability report.
   */
  async capabilities() {
    const ctx = this.#ctx
    const probe = (name) => {
      const service = this.#service(name)
      return service === undefined || service === null ? null : service
    }
    const has = (service, method) => service !== null && typeof service[method] === 'function'
    const tools = probe('tools')
    const sessionController = probe('sessionController')
    const llm = probe('llm')
    const jobs = probe('jobs')
    const workspaceRegistry = probe('workspaceRegistry')
    const sessionPersistence = probe('sessionPersistence')
    const sandboxPolicy = probe('sandboxPolicy')
    const sandbox = probe('sandbox')
    const fs = probe('fs')
    const agents = probe('agents')
    // Computed once: the notification status is the producer's own report (an
    // injected sink or the integrated outbox), never a re-derived guess.
    const notificationStatus =
      this.#supervisor !== undefined
        ? this.#supervisor.notificationsStatus()
        : { supported: false, reason: 'no supervisor is configured' }

    const agentScopedGuard = has(tools, 'guard')
    const agentScopedPreExecute = tools !== null && typeof ctx.on === 'function'
    // Without a tools registry there is nothing to gate, so no support is claimed.
    const pushSupported = tools !== null && (agentScopedGuard || agentScopedPreExecute)
    const scopedRestrictSupported = has(tools, 'restrict')
    const fsOsFence = fs !== null && typeof fs.sandboxMode === 'string' ? fs.sandboxMode : null

    // No agent exists on the capability path, and the public tool registry exposes
    // only a scope PRESENTATION view: `schemas()` with no scope is the GLOBAL layer
    // alone, never a complete all-scopes catalog. The agentless probe is therefore
    // always reported as unverified (`availableTools: null`,
    // `availabilityVerified: false`) rather than being promoted to a complete —
    // possibly empty — catalog that would fabricate availability or tool absence.
    // `enforceableTools` is classification support and stays independent of the
    // probe; `deniedTools` records the statically classified unsupported names and
    // their concrete reasons. `sessionVisibilityPending` stays true until `start`
    // proves the requested names against the REAL created agent.
    const catalog = await this.#probeToolCatalog()
    const toolContract = {
      enforceableTools: this.#enforceableToolNames(),
      availableTools: catalog.names,
      availabilityVerified: catalog.verified === true,
      deniedTools: this.#deniedToolReport(catalog.names),
      sessionVisibilityPending: true
    }

    // Lifecycle support (contract 20260925.2): UI archive is reported truthfully —
    // it is an archive-set write, never durable session deletion — and the missing
    // seam is reported as unsupported instead of assumed.
    const archiveSupported = has(workspaceRegistry, 'archiveSession')
    const lifecycle = {
      reconsider: {
        supported: true,
        mode: 'understanding',
        session: 'existing owned session only; never creates a session or adopts another session',
        model: 'reuses the verified effective route; never selects or falls back to a different model',
        mechanism: 'sessionController.prompt on the owned session using the controller-built task.prompt',
        gates: [
          'codex-bridge origin and matching ownerId',
          'exact revision, sessionId and immutable packet digest',
          'record is neither cleaned up nor UI-archived',
          'previous attempt is terminal',
          'host idleness positively known with no queued items and no owned live jobs'
        ],
        recovery: 'trusted persisted clarifications[].previousAttempt only; a missing or mismatched snapshot is refused'
      },
      archive: {
        supported: archiveSupported,
        mechanism: archiveSupported ? 'workspaceRegistry.archiveSession (durable UI archive set)' : null,
        uiHideOnly: true,
        idempotent: true,
        preserves: ['workspace/worktree', 'result/evidence', 'retention clock', 'enforcement guard'],
        gates: [
          'bridge-owned exact revision',
          'terminal completed|failed|cancelled attempt',
          'record stopConfirmed',
          'positively known idle host with no queued items and no owned live jobs'
        ],
        successShape: { archived: true, uiHidden: true, sessionId: '<string>', workspacePreserved: true, evidencePreserved: true },
        failureShapes: {
          unsupported: { archived: false, supported: false },
          unknown: { archived: false, outcome: 'unknown', retryable: true }
        }
      },
      durableSessionDeletion: false,
      durableSessionDeletionReason:
        'the installed SessionPersistence abstract surface is create/open/flush/stat/list only and SessionQuery is observe/search/list only; there is no durable session deletion API'
    }

    return jsonSafe({
      adapterVersion: ADAPTER_VERSION,
      contractVersion: this.#options.contractVersion ?? null,
      interface: {
        constructor: 'new DshAdapter(ctx, options)',
        taskEnvelope: ['id', 'revision', 'attemptId', 'packet', 'prompt', 'effectiveModel', 'sessionId?', 'understanding?', 'clarifications?'],
        barePacketAccepted: true,
        envelopeIdentityBound: true,
        resultShape: ['status', 'text', 'stopConfirmed', 'activeJobs', 'evidence', 'checks', 'uncertainties']
      },
      toolContract,
      lifecycle,
      host: {
        tools: tools !== null,
        sessionController: sessionController !== null,
        llm: llm !== null,
        jobs: jobs !== null,
        agents: agents !== null,
        workspaceRegistry: workspaceRegistry !== null,
        sessionPersistence: sessionPersistence !== null,
        sessionQuery: probe('sessionQuery') !== null,
        sandboxPolicy: sandboxPolicy !== null,
        sandbox: sandbox !== null,
        fs: fs !== null,
        fsSandboxMode: fsOsFence
      },
      models: {
        supported: has(llm, 'listProviders') && has(llm, 'listModels'),
        shape: 'Array<{provider, models:[{id, name?, description?, reasoningEfforts?}]}>',
        discovery: 'ctx.llm.listProviders() + ctx.llm.listModels(provider); efforts via ctx.llm.resolveModelInfo',
        defaultRoute: { ...this.#options.defaultModel },
        silentFallback: false
      },
      enforcement: {
        failClosed: true,
        requiresAgentScopedTools: true,
        toolAllowlist: {
          supported: pushSupported,
          mechanisms: [
            agentScopedGuard ? 'tools.guard (agent-scoped, monotonic, evaluated after tools/pre-execute and before the tool body)' : null,
            scopedRestrictSupported ? 'tools.restrict (agent-scoped visibility + dispatch resolution)' : null,
            agentScopedPreExecute ? "agent-scoped 'tools/pre-execute' waterfall (ordered fallback)" : null
          ].filter(Boolean),
          note: 'enforcement is registered through agent.ctx only; a host-context registration would mask every agent and is refused'
        },
        pathFence: {
          supported: true,
          mechanism: 'realpathSync.native on the target, or on its nearest existing ancestor when the target does not exist yet',
          rejects: ['symlink escapes', 'Windows junction/reparse escapes', 'dangling symlinks', 'unreadable/unresolvable paths'],
          readRoots: 'canonical containment in scope.readRoots; path-less glob/grep are checked against the session cwd',
          writeRoots: 'canonical containment in scope.writeRoots, backed by the OS filesystem sandbox at the session cwd',
          osWriteFence: fsOsFence,
          residual: 'TOCTOU between the synchronous check and the open is bounded by the OS session sandbox for writes; reads have no OS fence'
        },
        delegation: {
          supported: true,
          mechanisms: [
            'allowedTools allowlist',
            'monotonic guard denial of subagent|subagent_fork|send_message|interrupt_agent|list_agents|ralph|workflow',
            'subagent/start observation'
          ],
          note: 'the installed subagent registry exposes no per-agent refuse hook; tool denial is the seam'
        },
        forbiddenTools: {
          tools: Object.keys(FORBIDDEN_TOOLS),
          reasons: { ...FORBIDDEN_TOOLS },
          behavior: 'rejected at plan time and denied by the guard; never allowed as generic "other" tools',
          override: 'options.allowForbiddenTools (coordinator-only, default false)',
          overrideEnabled: this.#options.allowForbiddenTools === true
        },
        ownedJobTools: {
          tools: Object.keys(OWNED_JOB_TOOL_ARGS),
          mechanism:
            'ctx.jobs.get(job_id, sessionId) + JobView.owner (legacy ownerSession double) === task sessionId, verified per call with the calling session id as the ONLY identity',
          behavior: 'denied when ownership cannot be verified or ctx.jobs.get is unavailable; an authorization refusal is never retried under another identity'
        },
        shell: {
          supported: false,
          reason:
            'the installed sandbox vocabulary bounds FILE effects only and states "Network and process visibility are outside this vocabulary", so an arbitrary shell cannot be bounded to a task scope',
          behavior: 'scope.allowShell: true is rejected with adapter/shell-unsupported before a session is created'
        },
        network: {
          supported: 'tool-level-only',
          behavior: 'network tools are denied unless scope.allowNetwork is true AND the tool is in allowedTools; no network boundary is claimed',
          tools: [...NETWORK_TOOLS]
        },
        sandboxEscalation: {
          denied: true,
          note: 'calls carrying sandbox_permissions/justification are denied so a bounded task cannot widen its own sandbox'
        },
        budgets: {
          timeoutMs: { mechanism: 'timer + cooperative cancel (queue removal, turn cancel, owned job kill)', enforced: 'cooperative' },
          maxToolCalls: { mechanism: 'monotonic guard counter; calls beyond the cap are denied', enforced: 'hard' },
          maxOutputChars: {
            mechanism: null,
            enforced: 'advisory',
            reason: 'no installed seam truncates model-facing output without corrupting the transcript; reported as requested only'
          },
          // Child budgets are enforced by the child's own guard, not advertised
          // from the root's mechanism set.
          child: {
            maxToolCalls: {
              enforced: 'hard',
              mechanism:
                'child scoped guard counts distinct admitted tool starts synchronously before execution; also charged against the owning root attempt shared cap (one unit per distinct callId, never double counted on replay)'
            },
            timeoutMs: {
              enforced: 'cooperative',
              mechanism: 'per-child deadline timer clamped by the parent attempt remaining deadline; fires cooperative cancel and retains the slot until observed stop proof'
            },
            maxOutputChars: {
              enforced: 'bounded-retention',
              mechanism: 'adapter-retained child text is capped at the child grant maxOutputChars; truncation is reported (retained.truncated/droppedChars) and the model transcript is untouched'
            },
            teardown: {
              mechanism: 'owned AgentHandle.dispose + scoped enforcement disposers, exactly once',
              unprovenStop: 'a throwing teardown or a surviving live agent keeps the child unknown with its reservation retained',
              fallbackSeam: 'the sessionController.create fallback owns no AgentHandle and exposes no dispose; that mode reports the missing teardown seam instead of claiming cleanup'
            }
          }
        }
      },
      events: {
        supported: typeof ctx.on === 'function',
        sources: ['session/event', 'agent/status', 'subagent/start', 'guard (tool/start)'],
        types: ['attempt/queued', 'attempt/claimed', 'attempt/started', 'assistant/message', 'tool/start', 'tool/end', 'attempt/terminal', 'attempt/timeout', 'policy/violation', 'cancel/requested', 'cancel/settled', 'cleanup/performed'],
        fields: ['type', 'timestamp', 'taskId', 'revision', 'attemptId', 'seq (when available)'],
        toolStartCounter: 'tool/start is emitted exactly once per admitted dispatch (guard-first, durable-event fallback)',
        bufferedEventsCap: this.#options.maxBufferedEvents,
        completeHistory: 'sessionController.inspect(sessionId) durable log'
      },
      cancellation: {
        turnCancel: has(sessionController, 'cancel'),
        queueRemove: has(sessionController, 'updateQueue'),
        inboxClear: agents !== null,
        jobKill: has(jobs, 'kill'),
        stopConfirmation: 'observed session/event turn/end + agent/status idle + queue/job re-read',
        hostCancelIsNotConfirmation: true
      },
      persistence: {
        read: has(sessionController, 'inspect') ? 'sessionController.inspect (durable)' : null,
        delete: false,
        deleteReason:
          'the installed SessionPersistence abstract surface is create/open/flush/stat/list only and SessionQuery is observeSession/searchSessions/searchEvents/listSessions/listEvents only — there is no durable session deletion API',
        uiHide: has(workspaceRegistry, 'archiveSession') ? 'workspaceRegistry.archiveSession (durable archive set)' : null,
        uiHideIsDurable: has(workspaceRegistry, 'archiveSession'),
        uiHideScope: 'only sessions this adapter created for an owned, settled task (stopConfirmed, no live attempt, no queued items, no live owned jobs)',
        unarchive: false,
        unarchiveReason: 'the installed workspace registry exposes no unarchive entry point; archive is effectively one-way'
      },
      listenerFailures: this.#listenerFailures,
      lastListenerFailure: this.#lastListenerFailure ?? null,
      orphanSessions: jsonSafe(this.#orphans),
      // Controlled supervisor surface (contract supervisor-event-wake-v1).
      supervisor: {
        ...this.#bridgeGrantStatus(),
        ledger: this.#supervisor !== undefined ? this.#supervisor.ledger.snapshot() : null,
        depthLimit: 1,
        childTools: [...CHILD_SESSION_TOOLS],
        jobTools: [...BRIDGE_JOB_TOOLS],
        replyTools: [...BRIDGE_REPLY_TOOLS],
        projectTools: [...SUPERVISOR_PROJECT_TOOL_NAMES],
        notification: notificationStatus,
        // A configured producer is NOT evidence of a reachable destination, and an
        // injected sink is NOT the integrated outbox. `source` names the one that was
        // actually configured; runner availability, live transport and acknowledgement
        // stay `unknown` until an actual controller run observes a positive
        // exact-target acknowledgement.
        producer: {
          configured: notificationStatus.supported === true,
          source:
            notificationStatus.producerSource ??
            (notificationStatus.integratedOutbox === true
              ? 'integrated-outbox'
              : notificationStatus.supported === true
                ? 'injected-sink'
                : null),
          integratedOutbox: notificationStatus.integratedOutbox === true,
          runnerAvailable: notificationStatus.runnerAvailable ?? 'unknown',
          liveTransport: notificationStatus.liveTransport ?? 'unknown',
          liveAck: notificationStatus.liveAck ?? 'unknown',
          note:
            'a configured producer proves only that events are durably queued (integrated outbox) or handed to the injected sink; delivery requires the trusted controller runner plus a positive acknowledgement of the exact granted target'
        },
        note:
          'bridge-owned tools are registered into the authorized parent agent only; native subagent, shell and run_code stay denied for every task and child, and no OS sandbox is claimed for profile-granted jobs'
      }
    })
  }

  /**
   * List provider routes and models usable by DSH sessions, in the shape the root
   * passes to `resolveModel` as `catalog`.
   * @returns {Promise<Array<object>>} JSON-safe catalog array.
   */
  async models() {
    const llm = this.#requireService('llm')
    if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      throw adapterError('adapter/models-unavailable', 'the llm service does not expose listProviders/listModels', {})
    }
    const providers = llm.listProviders() || []
    const out = []
    for (const provider of providers) {
      const id = provider !== undefined && provider !== null ? provider.id : undefined
      if (typeof id !== 'string') continue
      const row = { provider: id, models: [] }
      const models = (await settleAsync(() => llm.listModels(id), undefined)) ?? null
      if (models === null) {
        row.error = 'listModels failed for this provider; it contributes no catalog entries'
        out.push(row)
        continue
      }
      for (const model of models) {
        if (model === undefined || model === null || typeof model.id !== 'string') continue
        const entry = { id: model.id, name: typeof model.name === 'string' ? model.name : model.id }
        if (typeof model.description === 'string') entry.description = model.description
        if (typeof llm.resolveModelInfo === 'function') {
          const resolved = await settleAsync(() => llm.resolveModelInfo(id, model.id), undefined)
          const reasoning = resolved !== undefined && resolved !== null && isPlainObject(resolved.reasoning) ? resolved.reasoning : undefined
          if (reasoning !== undefined && Array.isArray(reasoning.efforts)) {
            const ids = reasoning.efforts
              .map((effort) => (isPlainObject(effort) && typeof effort.id === 'string' ? effort.id : undefined))
              .filter(Boolean)
            if (ids.length > 0) entry.reasoningEfforts = ids
            if (typeof reasoning.defaultEffort === 'string') entry.defaultReasoningEffort = reasoning.defaultEffort
          }
        }
        row.models.push(entry)
      }
      out.push(row)
    }
    return jsonSafe(out)
  }

  /**
   * Non-mutating tool preflight for a task packet.
   *
   * Performs exactly the static checks `start()` performs before it mutates
   * anything, in the same order and with the same fences: packet validation, the
   * enforcement plan (cwd/roots canonicalization, `allowShell` refusal, scope.writeRoots
   * containment, `run_code`/unclassified/forbidden/delegation/shell/network
   * classification), then the boundary-tool verdict for the requested names.
   *
   * It NEVER creates a session, submits a prompt, executes a tool, mutates the
   * registry, installs a guard/restriction, or resolves a model route; the returned
   * value contains only the boundary tool names and the availability verdict (no plan
   * Sets, hooks or model guesses). Preflight has no agent yet, and the public tool
   * registry exposes only a scope presentation view (`schemas()` with no scope is the
   * GLOBAL layer alone), so availability can never be proved here: `availableTools`
   * is `null`, `availabilityVerified` is `false`, and `sessionVisibilityPending` is
   * always `true`. Consequently preflight NEVER rejects a requested name on catalog
   * grounds — a global (even non-empty) view cannot prove a per-agent/preset tool is
   * absent. `start()` proves the requested names against the REAL agent-scoped view
   * before any prompt.
   *
   * @param {unknown} packet - TaskPacket (or the root task envelope carrying one).
   * @returns {Promise<object>} JSON-safe `{ok, requestedTools, enforceableTools, availableTools, availabilityVerified, sessionVisibilityPending}`.
   * @throws {Error} the same fail-closed errors as `start()` (`adapter/invalid-packet`, `adapter/contract-version`,
   *   `adapter/shell-unsupported`, `adapter/scope-unsupported`).
   */
  async preflight(packet) {
    if (this.#disposed) throw adapterError('adapter/disposed', 'this adapter has been disposed', {})
    const ref = this.#resolveEnvelope(packet)
    if (ref.packet === undefined) throw adapterError('adapter/invalid-packet', 'preflight requires a task packet', {})
    // Same static enforcement planning as start: no host mutation happens before
    // an unenforceable scope is refused.
    const plan = this.#planEnforcement(ref.packet, { callbackBinding: ref.callbackBinding })
    const requestedTools = [...plan.allowedTools].sort()

    // Non-mutating availability verdict. There is no agent at preflight time, and
    // the public tool registry exposes only a scope PRESENTATION view: `schemas()`
    // with no scope resolves to the GLOBAL layer alone, never a complete
    // all-scopes catalog. Even a non-empty global view therefore cannot prove a
    // requested per-agent/preset tool is present, and cannot prove one is absent,
    // so nothing is rejected here on catalog grounds. Unsupported boundaries were
    // already refused by `#planEnforcement`/`#toolBoundaryReport` above; real
    // availability stays pending until `#verifyVisibleTools` proves the requested
    // names against the REAL created agent, before any prompt.
    const catalog = await this.#probeToolCatalog()

    const { executable, denied } = this.#toolBoundaryReport(requestedTools, ref.packet.scope)
    if (denied.length > 0) {
      throw adapterError('adapter/scope-unsupported', denied.map((entry) => entry.reason).join('; '), { denied })
    }
    return jsonSafe({
      ok: true,
      requestedTools,
      enforceableTools: executable.slice().sort(),
      availableTools: catalog.names,
      availabilityVerified: catalog.verified === true,
      sessionVisibilityPending: true
    })
  }

  /**
   * Start one bounded attempt for a task envelope (or a bare packet).
   * @param {object} task - task envelope `{id,revision,attemptId,packet,prompt,effectiveModel}` or a TaskPacket.
   * @param {{onEvent?: Function, onResult?: Function}} [hooks] - host callbacks.
   * @returns {Promise<object>} `{sessionId, requestId, effectiveModel, effectivePolicy, ...}` (store-safe receipt).
   */
  async start(task, hooks = {}) {
    if (this.#disposed) throw adapterError('adapter/disposed', 'this adapter has been disposed', {})
    const ref = this.#resolveEnvelope(task)
    if (ref.packet === undefined) throw adapterError('adapter/invalid-packet', 'start requires a task packet', {})
    const packet = ref.packet
    this.#assertCwd(packet)

    const existing = this.#records.get(ref.id)
    if (existing !== undefined) {
      if (existing.revision !== ref.revision) {
        throw adapterError('adapter/duplicate-task', `task "${ref.id}" already has an attempt at revision ${existing.revision}`, {
          taskId: ref.id,
          reason: 'different-revision',
          knownRevision: existing.revision,
          receivedRevision: ref.revision
        })
      }
      if (existing.requestDigest !== digestPacket(packet)) {
        throw adapterError('adapter/duplicate-task', `task "${ref.id}" was already started with a different packet`, {
          taskId: ref.id,
          reason: 'different-packet'
        })
      }
      return jsonSafe({ ...existing.startResult, idempotentReplay: true })
    }

    // Static enforcement planning happens before any host mutation, so an
    // unenforceable scope never creates a session. A packet carrying the
    // additive grants is planned against the trusted submission snapshot.
    const plan = this.#planEnforcement(packet, { callbackBinding: ref.callbackBinding })
    const earlyTools = this.#service('tools')
    if (earlyTools === undefined || earlyTools === null) {
      throw adapterError('adapter/enforcement-unavailable', 'the DSH tools registry is unavailable; per-task tool scope cannot be enforced', {})
    }
    if (typeof earlyTools.schemas !== 'function') {
      throw adapterError('adapter/enforcement-unavailable', 'the DSH tools registry does not expose schemas(); the task allowlist cannot be resolved', {})
    }

    const requestedModel = this.#resolveRequestedRoute(ref, packet)
    const controller = this.#requireService('sessionController')
    if (typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
      throw adapterError('adapter/host-unavailable', 'the sessionController service lacks create/prompt', {})
    }

    const record = {
      taskId: ref.id,
      revision: ref.revision,
      requestDigest: digestPacket(packet),
      packet,
      attempts: [],
      current: undefined,
      events: [],
      eventsDropped: 0,
      violations: [],
      delegationViolations: [],
      enforcementNotes: [],
      disposers: [],
      sandboxModeEvents: [],
      sandboxModeOverride: null,
      enforcementMechanisms: [],
      availableTools: undefined,
      scopedTools: undefined,
      bridgeTools: [],
      bridgeToolsRegistered: false,
      callbackBinding: ref.callbackBinding,
      commandJobs: [],
      announcedCallIds: new Set(),
      toolCallsAdmitted: 0,
      unboundAssistantMessages: [],
      stopInFlight: undefined,
      routeVerified: false,
      agentPreset: null,
      agentPresetMatched: null,
      hooks: isPlainObject(hooks) ? hooks : {},
      createdAt: this.#now(),
      updatedAt: this.#now(),
      sessionId: undefined,
      agent: undefined,
      agentStatus: undefined,
      openTurn: undefined,
      lastSeq: undefined,
      lastEventTime: undefined,
      durableModel: undefined,
      lastUsage: undefined,
      stopConfirmed: false,
      cleanedUp: false,
      uiHidden: false,
      uiHideMechanism: null,
      cleanedAt: undefined,
      startResult: undefined
    }

    const createRequest = { cwd: packet.cwd }
    if (this.#options.agentPreset !== undefined) createRequest.agentPreset = this.#options.agentPreset
    let created
    try {
      created = await controller.create(createRequest)
    } catch (error) {
      throw adapterError('adapter/session-create-failed', `session create failed: ${String((error && error.message) || error)}`, {
        code: isPlainObject(error) && typeof error.code === 'string' ? error.code : undefined
      })
    }
    const sessionId = created !== undefined && created !== null && typeof created.sessionId === 'string' ? created.sessionId : undefined
    if (sessionId === undefined) {
      throw adapterError('adapter/session-create-failed', 'session create returned no sessionId', {})
    }
    record.sessionId = sessionId
    // The title names the harness that actually submitted this task: the persisted
    // controller hint is used only when it is exactly one of the two known harnesses,
    // otherwise the neutral `controller` label keeps the title honest.
    const controllerLabel = packet.metadata?.controller === 'codex' || packet.metadata?.controller === 'claude-code' ? packet.metadata.controller : 'controller'
    if(typeof controller.rename==='function')await controller.rename({sessionId,title:`[agent-bridge·${controllerLabel}] ${packet.title}`})
    record.agentPreset = created.agentPreset ?? null
    record.agentPresetMatched = this.#options.agentPreset === undefined ? null : created.agentPreset === this.#options.agentPreset

    const agents = this.#service('agents')
    const agent = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined || agent === null) {
      this.#orphans.push({ sessionId, taskId: ref.id, reason: 'no live agent registered after create', at: this.#now() })
      throw adapterError('adapter/session-unavailable', `session "${sessionId}" was created but no live agent is registered for it`, { sessionId })
    }
    record.agent = agent

    try {
      this.#verifyVisibleTools(record, plan)
      this.#attachEnforcement(record, plan)
      // Bridge-owned tools are installed into the authorized parent agent's own
      // scoped layer only, after the restriction/guard, and their visibility is
      // proven before the prompt runs.
      this.#ensureBridgeTools(record, plan)
    } catch (error) {
      this.#orphans.push({
        sessionId,
        taskId: ref.id,
        reason: String((error && error.code) || 'enforcement-failed'),
        at: this.#now()
      })
      throw error
    }

    // Model selection: the host resolves and validates the route; the effective
    // route is always the host's answer, never the request echoed back.
    let effectiveModel = requestedModel
    if (typeof controller.selectModel === 'function') {
      let selected
      try {
        selected = await controller.selectModel({
          sessionId,
          provider: requestedModel.provider,
          model: requestedModel.model,
          ...(requestedModel.reasoningEffort === undefined ? {} : { reasoningEffort: requestedModel.reasoningEffort })
        })
      } catch (error) {
        this.#orphans.push({ sessionId, taskId: ref.id, reason: 'model route rejected', at: this.#now() })
        throw adapterError(
          'adapter/model-route-rejected',
          `host rejected model route ${requestedModel.provider}/${requestedModel.model}: ${String((error && error.message) || error)}`,
          { sessionId, orphanSessionId: sessionId, code: isPlainObject(error) && typeof error.code === 'string' ? error.code : undefined }
        )
      }
      const selectedRoute = selected !== undefined && selected !== null ? selected.selected : undefined
      if (isPlainObject(selectedRoute) && typeof selectedRoute.provider === 'string' && typeof selectedRoute.model === 'string') {
        effectiveModel = {
          provider: selectedRoute.provider,
          model: selectedRoute.model,
          ...(typeof selectedRoute.reasoningEffort === 'string' ? { reasoningEffort: selectedRoute.reasoningEffort } : {})
        }
        record.routeVerified = true
      }
    } else {
      record.enforcementNotes.push('sessionController.selectModel is unavailable; the requested route is unverified')
    }

    if(!record.routeVerified||effectiveModel.provider!==requestedModel.provider||effectiveModel.model!==requestedModel.model||(requestedModel.reasoningEffort!==undefined&&effectiveModel.reasoningEffort!==requestedModel.reasoningEffort)){
      this.#orphans.push({sessionId,taskId:ref.id,reason:'effective model not verified',at:this.#now()})
      throw adapterError('adapter/model-route-unverified','Host did not confirm the exact requested model and effort',{sessionId})
    }
    const understandingRequired = packet.understandingRequired === true
    const attempt = this.#newAttempt(
      record,
      understandingRequired ? 'understanding' : 'execution',
      record.hooks,
      ref.attemptId
    )
    attempt.effectiveModel = effectiveModel
    attempt.plan = plan

    const promptText =
      ref.prompt !== undefined
        ? ref.prompt
        : understandingRequired
          ? this.#composeUnderstandingPrompt(packet, effectiveModel)
          : this.#composeExecutionPrompt(packet, undefined, effectiveModel)

    const effectivePolicy = this.#effectivePolicy(record, plan)

    this.#records.set(ref.id, record)
    this.#recordsBySession.set(sessionId, record)

    await this.#submit(record, attempt, promptText)
    this.#armTimeout(record, attempt, plan)

    const result = {
      sessionId,
      requestId: attempt.requestId,
      effectiveModel,
      effectivePolicy,
      taskId: record.taskId,
      revision: record.revision,
      attemptId: attempt.attemptId,
      mode: attempt.mode,
      idempotentReplay: false
    }
    record.startResult = result
    this.#emit(record, attempt, 'attempt/started', { mode: attempt.mode, requestId: attempt.requestId })
    return jsonSafe(result)
  }

  /**
   * Submit the authorized execution attempt for a task whose understanding gate
   * has finished (or that was submitted without one).
   * @param {object} task - task envelope or bare packet.
   * @param {unknown} understanding - the reviewed understanding (untrusted input).
   * @param {{onEvent?: Function, onResult?: Function}} [hooks] - host callbacks.
   * @returns {Promise<object>} store-safe receipt, as `start()`.
   */
  async continue(task, understanding, hooks = {}) {
    if (this.#disposed) throw adapterError('adapter/disposed', 'this adapter has been disposed', {})
    const ref = this.#resolveEnvelope(task)
    if (ref.packet === undefined) throw adapterError('adapter/invalid-packet', 'continue requires a task packet', {})
    let record = this.#records.get(ref.id)
    let recoveryReport = null
    if (record === undefined) {
      // After an adapter reset, continue may only proceed on a trusted persisted
      // task whose request binding and durable turn are proven, and only when the
      // enforcement guard could actually be restored. Otherwise refuse: the
      // understanding phase is NEVER replayed.
      const recovery = await this.#recoverTask(ref)
      record = recovery.record
      recoveryReport = recovery.report
      if (record === undefined) {
        throw adapterError('adapter/unknown-task', `task "${ref.id}" has no trusted recoverable record: ${recovery.report.reason}`, {
          taskId: ref.id,
          reason: recovery.report.reason
        })
      }
      if (record.enforcementRestored !== true) {
        throw adapterError(
          'adapter/recovery-unsafe',
          `cannot safely continue task "${ref.id}" after an adapter reset: ${recovery.report.enforcementError ?? 'the guard could not be restored'}; ` +
            'the previous attempt was not replayed and no new session was adopted',
          {
            taskId: ref.id,
            enforcementRestored: false,
            boundTurn: recovery.report.bound?.turn ?? null,
            boundClaimed: recovery.report.bound?.claimed === true,
            boundTerminal: recovery.report.bound?.terminal === true
          }
        )
      }
    }
    this.#assertOwnership(record, ref)
    if (record.cleanedUp) throw adapterError('adapter/task-cleaned', `task "${ref.id}" has been cleaned up`, { taskId: ref.id })
    const previous = record.current
    if (previous !== undefined && !previous.terminal) {
      throw adapterError('adapter/attempt-in-flight', `attempt ${previous.attemptId} is still in flight for task "${ref.id}"`, {
        taskId: ref.id,
        attemptId: previous.attemptId
      })
    }

    // A cached recovery is not proof that its durable binding or restored guard
    // is still trusted. Recheck on every execution continuation, as reconsider does.
    if (record.recovered === true) {
      const trust = await this.#recoveryTrust(record)
      if (trust.ok !== true) {
        throw adapterError(
          'adapter/recovery-unsafe',
          `cannot safely continue task "${ref.id}" after an adapter reset: ${trust.reason}; ` +
            'the previous attempt was not replayed and no new session was adopted',
          { taskId: ref.id, dispatched: false, ...(trust.details ?? {}) }
        )
      }
    }
    // Check after the last await and before attempt mutation: prompt may resume
    // an absent agent, but the guard belongs only to the original agent object.
    const guardedAgent = this.#guardedLiveAgentProof(record)
    if (guardedAgent.ok !== true) {
      throw adapterError(
        guardedAgent.known ? 'adapter/host-not-settled' : 'adapter/host-state-unknown',
        `task "${ref.id}" cannot continue: ${guardedAgent.reason}`,
        {
          taskId: ref.id,
          blockers: guardedAgent.blocker === null ? [] : [guardedAgent.blocker],
          unknown: guardedAgent.unknown === null ? [] : [guardedAgent.unknown],
          observed: [guardedAgent.observed],
          dispatched: false
        }
      )
    }

    const attempt = this.#newAttempt(record, 'execution', isPlainObject(hooks) ? hooks : record.hooks, ref.attemptId)
    attempt.understanding = jsonSafe(understanding)
    attempt.effectiveModel = previous === undefined ? ref.effectiveModel : previous.effectiveModel ?? ref.effectiveModel
    // Plan fallback: a recovered record carries its plan on the record, not on the
    // recovered attempt, so the shared timeout/policy path still works after reset.
    attempt.plan = previous?.plan ?? record.plan
    if (attempt.plan !== undefined) this.#ensureBridgeTools(record, attempt.plan)
    const promptText =
      ref.prompt !== undefined
        ? ref.prompt
        : this.#composeExecutionPrompt(record.packet, understanding, attempt.effectiveModel)
    await this.#submit(record, attempt, promptText)
    if (attempt.plan !== undefined) this.#armTimeout(record, attempt, attempt.plan)
    return jsonSafe({
      sessionId: record.sessionId,
      requestId: attempt.requestId,
      effectiveModel: attempt.effectiveModel,
      effectivePolicy: this.#effectivePolicy(record, attempt.plan ?? record.plan),
      taskId: record.taskId,
      revision: record.revision,
      attemptId: attempt.attemptId,
      mode: attempt.mode,
      idempotentReplay: false
    })
  }

  /**
   * Submit ONE more bounded supervisor ROUND for an owned long-task project on the SAME
   * session. Project-only: it refuses any other task. Before any prompt it re-proves
   * (a) the previous attempt is terminal with a RECOMPUTED true/0/0 stop (live jobs and
   * live children counted now, never taken from a stored payload), (b) ownership of the
   * session, and (c) a live agent that is EXACTLY the guarded one. After an adapter reset
   * it binds the durable turn through `#recoverTask` and refuses when the guard cannot be
   * restored.
   *
   * The round is fenced by ITS OWN lowered plan: `maxToolCalls`/`timeoutMs` may only
   * shrink relative to the previous round (an increase is `adapter/round-budget-widened`),
   * and `attempt.roundBudgetBase` makes the root guard count only this round's calls while
   * `record.toolCallsAdmitted` stays the monotone cumulative counter children/evidence use.
   * Every LOCAL refusal is thrown with `dispatched:false`; an ambiguous prompt outcome
   * keeps `dispatched:true` through `#submit`.
   *
   * @param {object} task - task envelope carrying the project packet, the round prompt and a NEW attemptId.
   * @param {{onEvent?: Function, onResult?: Function}} [hooks] - host callbacks.
   * @returns {Promise<object>} store-safe receipt, as `start()`.
   */
  async nextRound(task, hooks = {}) {
    if (this.#disposed) throw adapterError('adapter/disposed', 'this adapter has been disposed', { dispatched: false })
    const ref = this.#resolveEnvelope(task)
    if (ref.packet === undefined) throw adapterError('adapter/invalid-packet', 'nextRound requires a task packet', { dispatched: false })
    if (!isPlainObject(ref.packet.project)) {
      throw adapterError('adapter/project-required', 'nextRound is only available to a packet carrying the long-task project grant', { taskId: ref.id, dispatched: false })
    }
    let record = this.#records.get(ref.id)
    let recoveryReport = null
    if (record === undefined) {
      // After an adapter reset only a trusted persisted task whose durable binding and
      // restorable guard are PROVEN may continue. Otherwise refuse and keep the
      // checkpoint: never replay, never adopt a caller-manufactured session.
      const recovery = await this.#recoverTask(ref)
      record = recovery.record
      recoveryReport = recovery.report
      if (record === undefined) {
        throw adapterError('adapter/unknown-task', `task "${ref.id}" has no trusted recoverable record for another round: ${recovery.report.reason}`, { taskId: ref.id, reason: recovery.report.reason, dispatched: false })
      }
      if (record.enforcementRestored !== true) {
        throw adapterError(
          'adapter/recovery-unsafe',
          `cannot safely continue task "${ref.id}" in another round after an adapter reset: ${recovery.report.enforcementError ?? 'the guard could not be restored'}; the previous attempt was not replayed and no new session was adopted`,
          { taskId: ref.id, dispatched: false, enforcementRestored: false }
        )
      }
    }
    if (!isPlainObject(record.packet?.project)) {
      throw adapterError('adapter/project-required', `task "${ref.id}" was not started as a long-task project`, { taskId: ref.id, dispatched: false })
    }
    // Every check below is a LOCAL refusal: no prompt has crossed the boundary yet, so any
    // error from them is stamped `dispatched:false` and the runtime keeps the checkpoint.
    try {
      this.#assertOwnership(record, ref)
    } catch (error) {
      if (error && typeof error === 'object' && error.dispatched === undefined) error.dispatched = false
      throw error
    }
    if (record.cleanedUp) throw adapterError('adapter/task-cleaned', `task "${ref.id}" has been cleaned up`, { taskId: ref.id, dispatched: false })
    const previous = record.current
    if (previous === undefined || previous.terminal !== true) {
      throw adapterError('adapter/attempt-in-flight', `attempt ${previous?.attemptId ?? '(none)'} is still in flight for task "${ref.id}"`, { taskId: ref.id, attemptId: previous?.attemptId ?? null, dispatched: false })
    }
    // A cached recovery is never proof: re-prove the durable binding and the restored
    // guard on every round, exactly as `continue` does for an execution continuation.
    if (record.recovered === true) {
      const trust = await this.#recoveryTrust(record)
      if (trust.ok !== true) {
        throw adapterError('adapter/recovery-unsafe', `cannot safely continue task "${ref.id}" in another round after an adapter reset: ${trust.reason}`, { taskId: ref.id, dispatched: false, ...(trust.details ?? {}) })
      }
    }
    // Recurrence is an ADMISSION-TIME grant, never something the narrowed round envelope
    // can introduce. The grant resolved when this task was admitted (kept on the current
    // attempt's plan, or on the recovered record's plan) must be recurrent, and the
    // mounted host policy plus the ORIGINAL normalized packet must still opt in. A legacy
    // project, a host that no longer opts in, or a missing/unsupported host policy is a
    // LOCAL refusal before any prompt — never a reason to widen or to trust `ref.packet`.
    const admittedPlan = isPlainObject(previous.plan) ? previous.plan : isPlainObject(record.plan) ? record.plan : null
    const admittedGrant = isPlainObject(admittedPlan?.grants?.supervisorProject) ? admittedPlan.grants.supervisorProject : null
    if (admittedGrant === null || admittedGrant.recurrent !== true) {
      throw adapterError('adapter/project-not-recurrent', `task "${ref.id}" was not admitted as a bounded recurrent project (packet.project.maxRounds >= 2), so another supervisor round is refused locally`, { taskId: ref.id, dispatched: false })
    }
    let hostGrant
    try {
      hostGrant = resolveProjectGrant(record.packet.project, this.#projects?.config ?? this.#options.supervisorProjects)
    } catch (error) {
      throw adapterError('adapter/project-unsupported', `task "${ref.id}" cannot start another round: the host can no longer re-prove the original recurrent grant (${String((error && error.message) || error)})`, {
        taskId: ref.id,
        dispatched: false,
        code: isPlainObject(error) && typeof error.code === 'string' ? error.code : null
      })
    }
    if (hostGrant.recurrent !== true) {
      throw adapterError('adapter/project-not-recurrent', `task "${ref.id}" cannot start another round: the host policy no longer opts into bounded recurrence`, { taskId: ref.id, dispatched: false })
    }
    // Positive stop proof, RECOMPUTED now with the STRICT probes: terminal status plus an
    // idle (or positively absent) live agent, readable queue lists, a readable owned-job
    // inspector and a positively present readable owned-child inspector, all zero. A
    // missing/throwing/non-array seam is UNKNOWN and refuses; it is never read as zero.
    const proof = this.#freshSettledProof(record, { requireChildManager: true })
    const terminalStatus = previous.rootStatus === 'completed' || previous.rootStatus === 'failed' || previous.rootStatus === 'cancelled'
    if (!terminalStatus || record.stopConfirmed !== true || proof.settled !== true) {
      const code = proof.settled === true ? 'adapter/round-unstopped' : proof.known === true ? 'adapter/host-not-settled' : 'adapter/host-state-unknown'
      throw adapterError(code, `the previous attempt is not positively stopped (terminal=${terminalStatus}, stopConfirmed=${record.stopConfirmed === true}, unknown=${proof.unknown.join('; ') || 'none'}, blockers=${proof.blockers.join('; ') || 'none'})`, {
        taskId: ref.id,
        dispatched: false,
        observed: proof.observed,
        unknown: proof.unknown,
        blockers: proof.blockers,
        liveJobs: proof.liveJobs,
        liveChildren: proof.liveChildren
      })
    }
    // The guarded live agent must still be the very object the guard was installed on.
    const guardedAgent = this.#guardedLiveAgentProof(record)
    if (guardedAgent.ok !== true) {
      throw adapterError(guardedAgent.known ? 'adapter/host-not-settled' : 'adapter/host-state-unknown', `task "${ref.id}" cannot start another round: ${guardedAgent.reason}`, {
        taskId: ref.id,
        dispatched: false,
        blockers: guardedAgent.blocker === null ? [] : [guardedAgent.blocker],
        unknown: guardedAgent.unknown === null ? [] : [guardedAgent.unknown],
        observed: [guardedAgent.observed]
      })
    }
    // The round plan is derived from the envelope's NARROWED packet, so the guard really
    // enforces this round's allowance rather than the previous round's larger plan.
    let plan
    try {
      plan = this.#planEnforcement(ref.packet, { callbackBinding: record.callbackBinding })
    } catch (error) {
      if (error && typeof error === 'object' && error.dispatched === undefined) error.dispatched = false
      throw error
    }
    const previousPlan = previous.plan ?? record.plan
    if (isPlainObject(previousPlan) && isPlainObject(previousPlan.budgets)) {
      if (plan.budgets.maxToolCalls > previousPlan.budgets.maxToolCalls) {
        throw adapterError('adapter/round-budget-widened', `round tool allowance ${plan.budgets.maxToolCalls} exceeds the previous round's ${previousPlan.budgets.maxToolCalls}; a round budget may only shrink`, { taskId: ref.id, field: 'maxToolCalls', dispatched: false })
      }
      if (plan.budgets.timeoutMs > previousPlan.budgets.timeoutMs) {
        throw adapterError('adapter/round-budget-widened', `round timeout ${plan.budgets.timeoutMs} exceeds the previous round's ${previousPlan.budgets.timeoutMs}; a round budget may only shrink`, { taskId: ref.id, field: 'timeoutMs', dispatched: false })
      }
    }

    const attempt = this.#newAttempt(record, 'execution', isPlainObject(hooks) ? hooks : record.hooks, ref.attemptId)
    // The model route is inherited from the owned session; no new route is selected,
    // requested or substituted for a continuation round.
    attempt.effectiveModel = previous.effectiveModel ?? ref.effectiveModel
    attempt.plan = plan
    record.plan = plan
    // Only THIS round's admitted calls count against the round plan; the monotone
    // cumulative counter stays intact for children, evidence and the historical paths.
    attempt.roundBudgetBase = record.toolCallsAdmitted
    if (attempt.plan !== undefined) this.#ensureBridgeTools(record, attempt.plan)
    const promptText = ref.prompt !== undefined ? ref.prompt : this.#composeProjectRoundPrompt(record.packet, attempt.effectiveModel)
    await this.#submit(record, attempt, promptText)
    this.#armTimeout(record, attempt, plan)
    return jsonSafe({
      sessionId: record.sessionId,
      requestId: attempt.requestId,
      effectiveModel: attempt.effectiveModel,
      effectivePolicy: this.#effectivePolicy(record, attempt.plan ?? record.plan),
      taskId: record.taskId,
      revision: record.revision,
      attemptId: attempt.attemptId,
      mode: attempt.mode,
      roundRecovery: recoveryReport === null ? null : { recovered: true, reason: recoveryReport.reason, enforcementRestored: recoveryReport.enforcementRestored === true },
      idempotentReplay: false
    })
  }

  /** Bare-packet fallback round prompt; the controller normally supplies `prompt`. */
  #composeProjectRoundPrompt(packet, model) {
    return [
      `[dsh-long-task supervisor round] project ${packet.projectId} task ${packet.id}`,
      `title: ${packet.title}`,
      `objective: ${packet.objective}`,
      `route (immutable): ${model?.provider ?? '?'}/${model?.model ?? '?'}${model?.reasoningEffort ? ` effort=${model.reasoningEffort}` : ''}`,
      'Read the real persisted worker results with dsh_supervisor_worker_result, then append bounded workers, record an explicit complete/block decision, or end the round to request one more bounded round. Never wait or poll for workers.',
      `Supervisor tools: ${SUPERVISOR_PROJECT_TOOLS.join(', ')}.`
    ].join('\n')
  }

  /**
   * Create a NEW understanding attempt in the EXISTING owned session (lifecycle
   * contract 20260925.2).
   *
   * This method never creates a session, never selects or falls back to a different
   * model, and never runs execution-prompt logic. It reuses the enforcement plan
   * already bound to the record with `mode:'understanding'`, so the agent-scoped
   * guard permits read tools only until the controller approves execution.
   *
   * After an adapter reset, recovery binds ONLY the trusted persisted
   * `clarifications[].previousAttempt` snapshot merged with the current
   * owner/origin/immutable-packet/revision/session provenance. A missing snapshot, a
   * mismatched session, or an unrestorable guard is refused with `dispatched:false`:
   * no replay, no adoption of a caller-manufactured session, no new session.
   *
   * @param {object} task - task envelope (the controller-built `prompt` is used verbatim when present).
   * @param {{onEvent?: Function, onResult?: Function}} [hooks] - host callbacks.
   * @returns {Promise<object>} store-safe receipt with the SAME sessionId and a NEW requestId/attemptId.
   */
  async reconsider(task, hooks = {}) {
    if (this.#disposed) throw adapterError('adapter/disposed', 'this adapter has been disposed', {})
    const ref = this.#resolveEnvelope(task)
    if (ref.packet === undefined) throw adapterError('adapter/invalid-packet', 'reconsider requires a task packet', {})

    let record = this.#records.get(ref.id)
    let recoveryReport = null
    if (record === undefined) {
      // Adapter reset: bind the owned session from the trusted persisted history,
      // never from the envelope's own sessionId claim.
      const binding = this.#persistedPreviousAttempt(ref)
      if (binding.ok !== true) {
        throw adapterError('adapter/recovery-unsafe', `cannot recover task "${ref.id}" for a clarification attempt: ${binding.reason}`, {
          taskId: ref.id,
          reason: binding.reason,
          dispatched: false
        })
      }
      const recoveryRef = {
        ...ref,
        sessionId: binding.previous.sessionId,
        requestId: binding.previous.requestId,
        attemptId: binding.previous.attemptId,
        effectiveModel: binding.previous.effectiveModel ?? ref.effectiveModel
      }
      const recovery = await this.#recoverTask(recoveryRef)
      record = recovery.record
      recoveryReport = recovery.report
      if (record === undefined) {
        throw adapterError('adapter/recovery-unsafe', `task "${ref.id}" has no trusted recoverable record: ${recovery.report.reason}`, {
          taskId: ref.id,
          reason: recovery.report.reason,
          dispatched: false
        })
      }
    }
    // Durable previous-request binding, workspace cwd, bound route and restored
    // guard are re-proven on EVERY reconsider of a recovered record — including a
    // record `#recoverTask` cached during a previous call or a prior `inspect()`.
    // A cached record is never itself evidence of trust, so a first refusal can
    // never be laundered into a dispatch by repeating the call. Missing or
    // unreadable evidence refuses: nothing is replayed and no session is adopted.
    if (record.recovered === true) {
      const trust = await this.#recoveryTrust(record)
      if (trust.ok !== true) {
        throw adapterError(
          'adapter/recovery-unsafe',
          `cannot start a clarification attempt for task "${ref.id}" after an adapter reset: ${trust.reason}; ` +
            'the previous attempt was not replayed and no new session was adopted',
          { taskId: ref.id, dispatched: false, ...(trust.details ?? {}) }
        )
      }
    }

    this.#assertProvenance(record, ref)
    this.#assertOwnership(record, ref)
    if (record.cleanedUp === true) throw adapterError('adapter/task-cleaned', `task "${ref.id}" has been cleaned up`, { taskId: ref.id })
    if (record.uiHidden === true || this.#archivedSessions.has(record.sessionId) || ref.sessionArchivedAt !== undefined) {
      throw adapterError('adapter/task-archived', `task "${ref.id}" is UI-archived; a clarification attempt requires a visible owned session`, {
        taskId: ref.id
      })
    }
    // Immutable packet fence: a clarification explains the authorized task and can
    // never change its scope, acceptance, role, cwd or identity.
    if (digestPacket(ref.packet) !== record.requestDigest) {
      throw adapterError('adapter/packet-changed', `task "${ref.id}" was started with a different immutable packet`, {
        taskId: ref.id,
        reason: 'different-packet'
      })
    }

    // Idempotent replay of an already-minted clarification attemptId: return the
    // stored receipt without dispatching a second prompt. The same id bound to a
    // non-clarification attempt is a conflict, never a silent re-dispatch.
    if (ref.attemptId !== undefined) {
      const existingAttempt = record.attempts.find((candidate) => candidate.attemptId === ref.attemptId)
      if (existingAttempt !== undefined && existingAttempt.continuation !== 'clarification') {
        throw adapterError('adapter/attempt-conflict', `attemptId "${ref.attemptId}" is already bound to a non-clarification attempt for task "${ref.id}"`, {
          taskId: ref.id,
          attemptId: ref.attemptId
        })
      }
      if (existingAttempt !== undefined) {
        return jsonSafe(this.#attemptReceipt(record, existingAttempt, { idempotentReplay: true }))
      }
    }

    const previous = record.current
    if (previous !== undefined && !previous.terminal) {
      throw adapterError('adapter/attempt-in-flight', `attempt ${previous.attemptId} is still in flight for task "${ref.id}"`, {
        taskId: ref.id,
        attemptId: previous.attemptId
      })
    }

    // Route fence: a clarification never changes the model route already bound to
    // the task, and it never selects a fallback.
    const requested = this.#resolveRequestedRoute(ref, ref.packet)
    const knownRoute = previous?.effectiveModel ?? record.durableModel
    if (isPlainObject(knownRoute) && (knownRoute.provider !== requested.provider || knownRoute.model !== requested.model)) {
      throw adapterError(
        'adapter/model-route-mismatch',
        `task "${ref.id}" is bound to route ${knownRoute.provider}/${knownRoute.model}, not ${requested.provider}/${requested.model}`,
        { taskId: ref.id, bound: { provider: knownRoute.provider, model: knownRoute.model }, requested }
      )
    }

    // Fresh host proof: idle, queue and jobs must each be POSITIVELY known and
    // settled. An unprobed/missing/throwing seam is unknown and refuses; it is never
    // read as zero.
    const proof = this.#freshSettledProof(record)
    // Guarded-identity fence (lifecycle repair 20260925.2, second round). The
    // settled proof above accepts an ABSENT live agent as idle, but the host's
    // `sessionController.prompt` resolves/resumes such a session, and the same
    // session may meanwhile have been rebound to a NEW agent object. In both cases
    // the guard attached to `record.agent` would not cover the agent that runs the
    // clarification. Require the CURRENT live agent to be positively known and
    // identical to the guarded `record.agent` before clearing `stopConfirmed`,
    // minting an attempt or dispatching. The check is synchronous and last, so no
    // await can make the proof stale between it and `#submit`. Archive keeps its own
    // (separate) eligibility: a positively absent agent with a valid durable record
    // stays archivable.
    const guardedAgent = this.#guardedLiveAgentProof(record)
    const blockers = [...proof.blockers, ...(guardedAgent.blocker === null ? [] : [guardedAgent.blocker])]
    const unknown = [...proof.unknown, ...(guardedAgent.unknown === null ? [] : [guardedAgent.unknown])]
    if (proof.settled !== true || guardedAgent.ok !== true) {
      const code = unknown.length > 0 ? 'adapter/host-state-unknown' : 'adapter/host-not-settled'
      throw adapterError(
        code,
        `task "${ref.id}" cannot start a clarification attempt: ${blockers.length > 0 ? blockers.join(', ') : unknown.join('; ')}`,
        { taskId: ref.id, blockers, unknown, observed: [...proof.observed, guardedAgent.observed], dispatched: false }
      )
    }

    // Reuse the plan already enforced for this record (prior attempt first, then the
    // recovered record). The plan is deterministic over the immutable packet, so a
    // final recompute cannot widen any fence.
    const plan = previous?.plan ?? record.plan ?? this.#planEnforcement(ref.packet, { callbackBinding: ref.callbackBinding })
    const effectiveModel = previous?.effectiveModel ?? ref.effectiveModel ?? requested
    const promptText =
      typeof ref.prompt === 'string' && ref.prompt.length > 0
        ? ref.prompt
        : this.#composeUnderstandingPrompt(ref.packet, effectiveModel)

    // The record is no longer settled once this new attempt may dispatch.
    record.stopConfirmed = false
    const attempt = this.#newAttempt(record, 'understanding', isPlainObject(hooks) ? hooks : record.hooks, ref.attemptId)
    attempt.effectiveModel = effectiveModel
    attempt.plan = plan
    attempt.continuation = 'clarification'
    this.#ensureBridgeTools(record, plan)

    await this.#submit(record, attempt, promptText)
    this.#armTimeout(record, attempt, plan)
    this.#emit(record, attempt, 'attempt/started', { mode: attempt.mode, requestId: attempt.requestId })
    return jsonSafe(this.#attemptReceipt(record, attempt, { idempotentReplay: false, recovery: recoveryReport }))
  }

  /**
   * Cancel this task's queued items, active turn and owned background jobs, then
   * confirm stopping from observed host state.
   * @param {object} task - task envelope, TaskPacket, or id.
   * @returns {Promise<object>} `{accepted, stopConfirmed, remaining, ...}`.
   */
  async cancel(task) {
    if (this.#disposed) throw adapterError('adapter/disposed', 'this adapter has been disposed', {})
    const ref = this.#resolveEnvelope(task)
    let record = this.#records.get(ref.id)
    if (record === undefined) {
      const recovery = await this.#recoverTask(ref)
      record = recovery.record
      if (record === undefined) {
        throw adapterError('adapter/unknown-task', `task "${ref.id}" has no trusted recoverable record: ${recovery.report.reason}`, {
          taskId: ref.id,
          reason: recovery.report.reason
        })
      }
    }
    this.#assertOwnership(record, ref)
    return this.#stop(record, { reason: 'cancelled by coordinator' })
  }

  async #stop(record, { reason }) {
    if (record.stopInFlight !== undefined) return record.stopInFlight
    const run = this.#runStop(record, reason)
    record.stopInFlight = run
    try {
      return await run
    } finally {
      record.stopInFlight = undefined
    }
  }

  async #runStop(record, reason) {
    const sessionId = record.sessionId
    const agent = record.agent
    const actions = []
    let accepted = false

    const current = record.current
    if (current !== undefined && !current.terminal) current.cancelRequested = true

    const controller = this.#service('sessionController')
    const jobs = this.#service('jobs')

    // 1. Remove this task's still-pending queue items.
    let pending = this.#pendingQueueItems(record)
    for (const item of pending) {
      if (controller !== null && controller !== undefined && typeof controller.updateQueue === 'function') {
        try {
          controller.updateQueue({ sessionId, itemId: item.id, action: { kind: 'remove' } })
          accepted = true
          actions.push({ kind: 'queue-remove', itemId: item.id, accepted: true })
        } catch (error) {
          actions.push({ kind: 'queue-remove', itemId: item.id, accepted: false, error: String((error && error.message) || error) })
        }
      } else {
        actions.push({ kind: 'queue-remove', itemId: item.id, accepted: false, error: 'sessionController.updateQueue unavailable' })
      }
    }
    pending = this.#pendingQueueItems(record)
    if (pending.length > 0 && agent !== undefined && agent !== null && typeof agent.cancel === 'function') {
      // Clear the dedicated session's remaining inbox work durably, then re-read.
      try {
        agent.cancel({ kind: 'user' })
        accepted = true
        actions.push({ kind: 'inbox-clear', accepted: true })
      } catch (error) {
        actions.push({ kind: 'inbox-clear', accepted: false, error: String((error && error.message) || error) })
      }
      pending = this.#pendingQueueItems(record)
    }
    if (pending.length === 0 && current !== undefined && !current.claimed && !current.terminal) {
      // A prompt removed before it was ever claimed can never produce turn/end;
      // record the host-confirmed removal instead of waiting for an event.
      this.#terminalize(record, current, { kind: 'aborted', detail: 'queue-removed' })
    }

    // 2. Cancel the active turn of the live agent.
    const activeTurn = record.attempts.find((attempt) => !attempt.terminal && attempt.claimed)
    if (activeTurn !== undefined || (current !== undefined && !current.terminal)) {
      if (controller !== null && controller !== undefined && typeof controller.cancel === 'function') {
        try {
          controller.cancel({ sessionId })
          accepted = true
          actions.push({ kind: 'turn-cancel', accepted: true })
        } catch (error) {
          actions.push({ kind: 'turn-cancel', accepted: false, error: String((error && error.message) || error) })
        }
      } else if (agent !== undefined && agent !== null && typeof agent.cancel === 'function') {
        try {
          agent.cancel({ kind: 'user' })
          accepted = true
          actions.push({ kind: 'agent-cancel', accepted: true })
        } catch (error) {
          actions.push({ kind: 'agent-cancel', accepted: false, error: String((error && error.message) || error) })
        }
      } else {
        actions.push({ kind: 'turn-cancel', accepted: false, error: 'no cancel entry point available' })
      }
    }

    // 2b. Cancel every live descendant child BEFORE this task's own jobs. A
    // child's reservation is released only on observed stop proof; an
    // unconfirmed child is marked unknown and keeps its slot.
    if (this.#supervisor !== undefined) {
      const descendants = await this.#supervisor.cancelDescendants({
        taskId: record.taskId,
        reason: reason ?? 'parent cancelled',
        cancelChild: (child) => this.#cancelChildRuntime(child)
      })
      if (descendants.cancelled.length > 0) actions.push({ kind: 'descendant-cancel', ...descendants })
    }

    // 3. Cancel owned background jobs. The installed registry fences by the
    // calling session id, so the owner string is the only caller identity used.
    for (const job of this.#ownedLiveJobs(record)) {
      if (jobs !== null && jobs !== undefined && typeof jobs.kill === 'function') {
        try {
          jobs.kill(job.id, record.sessionId, reason)
          accepted = true
          actions.push({ kind: 'job-kill', jobId: job.id, accepted: true })
        } catch (error) {
          actions.push({ kind: 'job-kill', jobId: job.id, accepted: false, error: String((error && error.message) || error) })
        }
      } else {
        actions.push({ kind: 'job-kill', jobId: job.id, accepted: false, error: 'ctx.jobs.kill unavailable' })
      }
    }

    this.#emit(record, current, 'cancel/requested', { accepted, reason })

    // Some DSH early-cancel paths end the step without appending turn/end.
    // whenIdle() covers the entire driver and maintenance activity, unlike a
    // status label or cancel acknowledgement. Verify its quiescence plus queues/jobs.
    if(accepted&&current?.claimed&&!current.terminal&&typeof agent?.whenIdle==='function'){
      const idle=await Promise.race([Promise.resolve().then(()=>agent.whenIdle()).then(()=>true,()=>false),sleep(this.#options.stopConfirmTimeoutMs).then(()=>false)]);
      if(idle&&agent.status==='idle'&&this.#pendingQueueItems(record).length===0&&this.#ownedLiveJobs(record).length===0){
        this.#terminalize(record,current,{kind:'aborted',detail:'host-idle-after-cancel'});
        actions.push({kind:'driver-quiescence',confirmed:true,mechanism:'agent.whenIdle'});
      }
    }

    // 4. Bounded observation-based stop confirmation.
    const confirmation = await this.#confirmStopped(record)
    record.stopConfirmed = confirmation.confirmed
    this.#emit(record, current, 'cancel/settled', { accepted, stopConfirmed: confirmation.confirmed, observed: confirmation.observed })

    return jsonSafe({
      taskId: record.taskId,
      revision: record.revision,
      sessionId,
      accepted,
      stopConfirmed: confirmation.confirmed,
      remaining: confirmation.remaining,
      actions,
      observed: confirmation.observed
    })
  }

  async #confirmStopped(record) {
    const timeoutMs = this.#options.stopConfirmTimeoutMs
    const deadline = this.#now() + Math.max(0, timeoutMs)
    let state = this.#stopState(record)
    while (!state.confirmed && this.#now() < deadline) {
      await sleep(Math.min(CONFIRM_POLL_MS, Math.max(1, deadline - this.#now())))
      state = this.#stopState(record)
    }
    return state
  }

  #stopState(record) {
    const agents = this.#service('agents')
    const live = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(record.sessionId) : undefined
    const pending = this.#pendingQueueItems(record)
    const liveJobs = this.#ownedLiveJobs(record)
    const current = record.current
    const attemptSettled = current === undefined || current.terminal
    // Live children are real owned work: the task is not stopped while one is
    // running. The observation string is added only when children exist so a
    // childless task keeps its historical stop report exactly.
    const liveChildren = this.#supervisor !== undefined ? this.#supervisor.liveChildren(record.taskId) : []
    const remaining = []
    for (const item of pending) remaining.push({ kind: 'queued-item', itemId: item.id, placement: item.placement })
    for (const job of liveJobs) remaining.push({ kind: 'job', jobId: job.id, status: job.status })
    for (const child of liveChildren) remaining.push({ kind: 'live-child', childId: child.childId, state: child.state })
    if (!attemptSettled) remaining.push({ kind: 'active-attempt', attemptId: current.attemptId, state: current.state })
    // A RECOVERED record may confirm stopping only from this task's own durable
    // `turn/end`; an absent live agent on its own is not evidence that the turn ran
    // and finished. Never fake stop confirmation for a recovered task.
    const recoveredUnproven = record.recovered === true && record.durableBoundTerminal !== true
    if (recoveredUnproven) {
      remaining.push({
        kind: 'durable-bound-turn-not-terminal',
        boundTurn: record.durableBoundTurn ?? null,
        durableEvidence: record.durableBoundKnown === true ? 'no-explicit-bound-turn-end' : 'no-claimed-bound-turn'
      })
    }
    const childObservation = liveChildren.length > 0 ? [`live-children:${liveChildren.length}`] : []

    if (live === undefined || live === null) {
      // No live agent remains: no driver can be running this session's work.
      const confirmed = pending.length === 0 && liveJobs.length === 0 && liveChildren.length === 0 && !recoveredUnproven
      return { confirmed, remaining, observed: [...(confirmed ? ['agent-absent'] : ['agent-absent', 'work-remaining']), ...childObservation] }
    }
    const status = contained(() => live.status, () => undefined)
    const idle = status === 'idle'
    const confirmed = idle && attemptSettled && pending.length === 0 && liveJobs.length === 0 && liveChildren.length === 0 && !recoveredUnproven
    return {
      confirmed,
      remaining,
      observed: [
        idle ? 'agent-idle' : 'agent-running',
        attemptSettled ? 'attempt-settled' : 'attempt-active',
        `queued-items:${pending.length}`,
        `live-jobs:${liveJobs.length}`,
        ...(record.recovered === true ? [`recovered:${recoveredUnproven ? 'unproven' : 'durable-terminal'}`] : []),
        ...childObservation
      ]
    }
  }

  #pendingQueueItems(record) {
    const agent = record.agent
    if (agent === undefined || agent === null) return []
    const inbox = contained(() => agent.inbox, () => undefined)
    if (inbox === undefined || inbox === null) return []
    const out = []
    const collect = (list, placement) => {
      if (!Array.isArray(list)) return
      for (const message of list) {
        if (message === undefined || message === null) continue
        const source = contained(() => message.source, () => undefined)
        const rpcId = source !== undefined && source !== null && typeof source.rpcId === 'string' ? source.rpcId : undefined
        const owned = rpcId !== undefined && record.attempts.some((attempt) => attempt.requestId === rpcId)
        if (!owned) continue
        if (typeof message.id !== 'string') continue
        out.push({ id: message.id, placement, rpcId })
      }
    }
    collect(inbox.nextTurn, 'queued')
    collect(inbox.nextStep, 'steering')
    return out
  }

  /**
   * Every session id whose live jobs count against this task: the task's own
   * session plus each live child session (a child is real owned work and must
   * block a clean settlement).
   */
  #recordSessionIds(record) {
    const ids = typeof record.sessionId === 'string' ? [record.sessionId] : []
    if (this.#supervisor !== undefined) {
      for (const child of this.#supervisor.childrenOf(record.taskId, { liveOnly: true })) {
        if (typeof child.sessionId === 'string' && child.sessionId.length > 0 && !ids.includes(child.sessionId)) ids.push(child.sessionId)
      }
    }
    return ids
  }

  #ownedLiveJobs(record) {
    const jobs = this.#service('jobs')
    if (jobs === null || jobs === undefined || typeof jobs.list !== 'function') return []
    const seen = new Set()
    const out = []
    for (const sessionId of this.#recordSessionIds(record)) {
      const listed = contained(
        () => jobs.list(sessionId),
        () => undefined
      )
      if (!Array.isArray(listed)) continue
      for (const job of listed) {
        if (!isPlainObject(job)) continue
        const owner = job.owner ?? job.ownerSession
        if (owner !== sessionId) continue
        if (job.status !== 'running' && job.status !== 'stopping') continue
        if (seen.has(job.id)) continue
        seen.add(job.id)
        out.push({ id: job.id, status: job.status, kind: job.kind, label: job.label })
      }
    }
    return out
  }

  // -- lifecycle proof (fresh host idle/queue/jobs, strict) ---------------

  /**
   * Strict host-idleness probe for lifecycle decisions.
   *
   * A missing/throwing `agents` seam is UNKNOWN, never idle. A live agent must
   * report `idle`; an absent live agent is a positive `agent-absent` observation
   * (the same evidence the stop path already trusts — no driver can be running a
   * session that has no agent).
   *
   * @param {object} record - adapter record with a sessionId.
   * @returns {{known:boolean, idle:boolean|null, live:boolean, status:string|null, reason:string|null}} proof.
   */
  #hostIdleProof(record) {
    const agents = this.#service('agents')
    if (agents === null || agents === undefined || typeof agents.get !== 'function') {
      return { known: false, idle: null, live: false, status: null, reason: 'ctx.agents.get is unavailable, so host idleness is unknown' }
    }
    let live
    try {
      live = agents.get(record.sessionId)
    } catch (error) {
      return {
        known: false,
        idle: null,
        live: false,
        status: null,
        reason: `ctx.agents.get threw: ${String((error && error.message) || error)}`
      }
    }
    if (live === undefined || live === null) return { known: true, idle: true, live: false, status: null, reason: null }
    const status = contained(() => live.status, () => undefined)
    if (status === 'idle') return { known: true, idle: true, live: true, status, reason: null }
    if (status === 'running') return { known: true, idle: false, live: true, status, reason: null }
    return {
      known: false,
      idle: null,
      live: true,
      status: status === undefined ? null : String(status),
      reason: `the live agent status "${status ?? '(unreadable)'}" does not prove idleness`
    }
  }

  /**
   * Strict queue probe for lifecycle decisions.
   *
   * Unlike `#pendingQueueItems` (the owned-only cancellation/cleanup helper, which
   * reports a total), this probe must never accept a malformed or unreadable queue
   * as empty:
   *
   *  - it reads `ctx.agents.get(sessionId)` FRESH, never the possibly stale
   *    `record.agent` captured at recovery time;
   *  - both `inbox.nextTurn` and `inbox.nextStep` must be readable ARRAYS — a
   *    missing or non-array list is UNKNOWN, not zero;
   *  - ANY queued session item blocks a lifecycle dispatch, not only items whose
   *    `source.rpcId` this task owns: a foreign or rpcId-less queued message is
   *    still work the session has not drained;
   *  - a queue list whose iteration throws, or an entry whose `id`/`source`
   *    getter throws while it is described, is UNKNOWN — never an empty or
   *    settled queue. A raw pre-dispatch getter error is never leaked.
   *
   * @param {object} record - adapter record with a sessionId.
   * @returns {{known:boolean, items:Array<object>|null, reason:string|null}} proof.
   */
  #ownedQueueItemsStrict(record) {
    const agents = this.#service('agents')
    if (agents === null || agents === undefined || typeof agents.get !== 'function') {
      return { known: false, items: null, reason: 'ctx.agents.get is unavailable, so queued work is unknown' }
    }
    let live
    try {
      live = agents.get(record.sessionId)
    } catch (error) {
      return { known: false, items: null, reason: `ctx.agents.get threw while reading the queue: ${String((error && error.message) || error)}` }
    }
    // No live agent exists: nothing can be queued against this session, which is a
    // positive observation, not an unprobed seam.
    if (live === undefined || live === null) return { known: true, items: [], reason: null }
    let inbox
    try {
      inbox = live.inbox
    } catch (error) {
      return { known: false, items: null, reason: `the live agent inbox could not be read: ${String((error && error.message) || error)}` }
    }
    if (inbox === undefined || inbox === null || typeof inbox !== 'object') {
      return { known: false, items: null, reason: 'the live agent exposes no readable inbox, so queued work is unknown' }
    }
    let nextTurn
    let nextStep
    try {
      nextTurn = inbox.nextTurn
    } catch (error) {
      return { known: false, items: null, reason: `the live agent nextTurn queue could not be read: ${String((error && error.message) || error)}` }
    }
    try {
      nextStep = inbox.nextStep
    } catch (error) {
      return { known: false, items: null, reason: `the live agent nextStep queue could not be read: ${String((error && error.message) || error)}` }
    }
    if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) {
      return {
        known: false,
        items: null,
        reason: 'the live agent inbox does not expose both a nextTurn and a nextStep array, so queued work is unknown'
      }
    }
    const items = []
    // Describing an entry reads `id`/`source.rpcId`, and iterating either list
    // reads its iterator; a host getter/proxy can throw from either read. A raw
    // pre-dispatch getter error must never escape to the caller as an untyped
    // Error (the service would then conservatively record an unknown dispatch
    // outcome despite zero prompts), so any read failure degrades this probe to
    // UNKNOWN instead.
    try {
      for (const message of nextTurn) items.push(strictQueueItem(message, 'queued'))
      for (const message of nextStep) items.push(strictQueueItem(message, 'steering'))
    } catch (error) {
      return {
        known: false,
        items: null,
        reason: `the live agent queue entries could not be read: ${String((error && error.message) || error)}`
      }
    }
    return { known: true, items, reason: null }
  }

  /**
   * Strict owned-job probe. A missing `jobs` service/method, a throw, or a
   * non-array answer is UNKNOWN; only a real list settles the question.
   *
   * @param {object} record - adapter record.
   * @returns {{known:boolean, jobs:Array<object>|null, reason:string|null}} proof.
   */
  #ownedLiveJobsStrict(record) {
    const jobs = this.#service('jobs')
    if (jobs === null || jobs === undefined) {
      return { known: false, jobs: null, reason: 'ctx.jobs is unavailable, so owned background jobs are unknown' }
    }
    if (typeof jobs.list !== 'function') {
      return { known: false, jobs: null, reason: 'ctx.jobs.list is unavailable, so owned background jobs are unknown' }
    }
    const seen = new Set()
    const live = []
    for (const sessionId of this.#recordSessionIds(record)) {
      let listed
      try {
        listed = jobs.list(sessionId)
      } catch (error) {
        return { known: false, jobs: null, reason: `ctx.jobs.list threw: ${String((error && error.message) || error)}` }
      }
      if (!Array.isArray(listed)) return { known: false, jobs: null, reason: 'ctx.jobs.list did not return an array' }
      for (const job of listed) {
        if (!isPlainObject(job)) continue
        const owner = job.owner ?? job.ownerSession
        if (owner !== sessionId) continue
        if (job.status !== 'running' && job.status !== 'stopping') continue
        if (seen.has(job.id)) continue
        seen.add(job.id)
        live.push({ id: job.id, status: job.status, kind: job.kind, label: job.label })
      }
    }
    return { known: true, jobs: live, reason: null }
  }

  /**
   * Strict owned-child probe. Live children are owned work exactly like jobs, so the
   * inspector itself must be READABLE before its answer can prove anything:
   *
   *  - a host with NO owned-child manager at all is the historical legacy case (no
   *    child session can exist), a positive zero — unless the caller demands a
   *    positively present manager (`requireManager: true`, used by the round dispatch
   *    path where a recurrent project always has one);
   *  - a present manager whose `liveChildren` inspector is missing, throws, or returns
   *    a non-array answer is UNKNOWN, never zero.
   *
   * @param {object} record - adapter record.
   * @param {{requireManager?: boolean}} [options] - whether an absent manager is unknown.
   * @returns {{known:boolean, children:Array<object>|null, reason:string|null}} proof.
   */
  #ownedLiveChildrenStrict(record, { requireManager = false } = {}) {
    const supervisor = this.#supervisor
    if (supervisor === undefined || supervisor === null) {
      return requireManager
        ? { known: false, children: null, reason: 'no owned-child manager is configured, so live children are unknown' }
        : { known: true, children: [], reason: null }
    }
    if (typeof supervisor.liveChildren !== 'function') {
      return { known: false, children: null, reason: 'the owned-child manager exposes no liveChildren inspector, so live children are unknown' }
    }
    let children
    try {
      children = supervisor.liveChildren(record.taskId)
    } catch (error) {
      return { known: false, children: null, reason: `the owned-child inspector threw: ${String((error && error.message) || error)}` }
    }
    if (!Array.isArray(children)) {
      return { known: false, children: null, reason: 'the owned-child inspector did not return an array, so live children are unknown' }
    }
    return { known: true, children, reason: null }
  }

  /**
   * Fresh, positive proof that the owned session is idle with no queued work, no live
   * owned jobs and no live owned children. Unknown probes are collected separately from
   * real blockers so a caller can distinguish "not settled" from "cannot tell" and never
   * read an unprobed seam as zero.
   *
   * @param {object} record - adapter record.
   * @param {{requireChildManager?: boolean}} [options] - pass `requireChildManager: true`
   *   on a dispatch path that must prove a positively present owned-child manager.
   * @returns {{known:boolean, settled:boolean, unknown:string[], blockers:string[],
   *   idle:object, queuedItems:Array<object>|null, liveJobs:Array<object>|null,
   *   liveChildren:Array<object>, observed:string[]}} proof.
   */
  #freshSettledProof(record, { requireChildManager = false } = {}) {
    const idle = this.#hostIdleProof(record)
    const queue = this.#ownedQueueItemsStrict(record)
    const jobs = this.#ownedLiveJobsStrict(record)
    const children = this.#ownedLiveChildrenStrict(record, { requireManager: requireChildManager })
    const liveChildren = children.known === true ? children.children : []
    const unknown = []
    const blockers = []
    if (idle.known !== true) unknown.push(`host-idle:${idle.reason}`)
    else if (idle.idle !== true) blockers.push('host-not-idle')
    if (queue.known !== true) unknown.push(`queue:${queue.reason}`)
    else if (queue.items.length > 0) blockers.push('queued-items')
    if (jobs.known !== true) unknown.push(`jobs:${jobs.reason}`)
    else if (jobs.jobs.length > 0) blockers.push('live-jobs')
    if (children.known !== true) unknown.push(`children:${children.reason}`)
    else if (liveChildren.length > 0) blockers.push(`live-children:${liveChildren.length}`)
    return {
      known: unknown.length === 0,
      settled: unknown.length === 0 && blockers.length === 0,
      unknown,
      blockers,
      idle,
      queuedItems: queue.items,
      liveJobs: jobs.jobs,
      liveChildren,
      observed: [
        idle.known !== true ? 'idle-unknown' : idle.live === false ? 'agent-absent' : idle.idle === true ? 'agent-idle' : 'agent-running',
        queue.known !== true ? 'queue-unknown' : `queued-items:${queue.items.length}`,
        jobs.known !== true ? 'jobs-unknown' : `live-jobs:${jobs.jobs.length}`,
        children.known !== true ? 'children-unknown' : `live-children:${liveChildren.length}`
      ]
    }
  }

  /**
   * Fresh positive proof that the live agent currently registered for the record's
   * session is EXACTLY the agent the enforcement guard was installed on
   * (`record.agent`), so a lifecycle dispatch really runs guarded.
   *
   * `#freshSettledProof` deliberately treats an ABSENT live agent as positively
   * idle (that is the same evidence the stop path trusts), and the real
   * `sessionController.prompt` seam resolves/resumes a session that has no live
   * agent. A dispatch is therefore only safe when a fresh read of
   * `ctx.agents.get(record.sessionId)` returns the very object the guard was
   * registered on: an absent agent would be resumed unguarded, and a
   * same-session replacement is a different object the old guard does not cover.
   * An unreadable seam is UNKNOWN. All three refuse.
   *
   * This is intentionally SEPARATE from `#freshSettledProof` and is only applied
   * on the dispatch path: `archive` keeps its own eligibility, where a positively
   * absent agent with a valid durable record is still archivable.
   *
   * @param {object} record - adapter record carrying the guarded `agent`.
   * @returns {{ok:boolean, known:boolean, blocker:string|null, unknown:string|null,
   *   reason:string|null, observed:string}} proof.
   */
  #guardedLiveAgentProof(record) {
    const guarded = record.agent
    if (guarded === undefined || guarded === null) {
      return {
        ok: false,
        known: true,
        blocker: 'guarded-agent-absent',
        unknown: null,
        reason: 'the record carries no guarded live agent, so the clarification cannot be proven to run under the enforcement guard',
        observed: 'guarded-agent-absent'
      }
    }
    const agents = this.#service('agents')
    if (agents === null || agents === undefined || typeof agents.get !== 'function') {
      return {
        ok: false,
        known: false,
        blocker: null,
        unknown: 'guarded-agent-unknown',
        reason: 'ctx.agents.get is unavailable, so the guarded live agent is unknown',
        observed: 'guarded-agent-unknown'
      }
    }
    let live
    try {
      live = agents.get(record.sessionId)
    } catch (error) {
      return {
        ok: false,
        known: false,
        blocker: null,
        unknown: 'guarded-agent-unknown',
        reason: `ctx.agents.get threw while re-proving the guarded agent: ${String((error && error.message) || error)}`,
        observed: 'guarded-agent-unknown'
      }
    }
    if (live === undefined || live === null) {
      return {
        ok: false,
        known: true,
        blocker: 'guarded-agent-absent',
        unknown: null,
        reason:
          'no live agent is registered for the owned session, so the restored enforcement guard would not cover the agent a dispatch would resume',
        observed: 'guarded-agent-absent'
      }
    }
    if (live !== guarded) {
      return {
        ok: false,
        known: true,
        blocker: 'guarded-agent-replaced',
        unknown: null,
        reason: 'the live agent for the owned session is not the guarded agent, so the restored enforcement guard would not cover it',
        observed: 'guarded-agent-replaced'
      }
    }
    return { ok: true, known: true, blocker: null, unknown: null, reason: null, observed: 'guarded-agent-live' }
  }

  /**
   * Ownership/provenance fence for lifecycle calls on a persisted envelope: a task
   * this bridge did not mint, or one owned by another owner, may never be adopted.
   *
   * @param {object} record - adapter record.
   * @param {object} ref - resolved reference.
   */
  #assertProvenance(record, ref) {
    if (ref.envelope !== true) return
    const expected = this.#options.ownerId
    if (ref.origin !== undefined && ref.origin !== 'codex-bridge') {
      throw adapterError('adapter/not-owned', `task "${ref.id}" origin "${ref.origin}" is not "codex-bridge"`, { taskId: ref.id })
    }
    if (typeof expected === 'string' && expected.length > 0) {
      if (ref.ownerId === undefined) {
        throw adapterError('adapter/not-owned', `task "${ref.id}" carries no ownerId, so bridge ownership cannot be proven`, { taskId: ref.id })
      }
      if (ref.ownerId !== expected) {
        throw adapterError('adapter/not-owned', `task "${ref.id}" is owned by another bridge owner`, { taskId: ref.id })
      }
    }
  }

  /**
   * Resolve the trusted persisted clarification snapshot used to rebind an owned
   * session after an adapter reset. It reads ONLY `clarifications[].previousAttempt`
   * (or an equivalent top-level `previousAttempt`) from a codex-bridge task owned by
   * this adapter, and verifies it against the current revision/session. A missing or
   * malformed snapshot is refused — never replaced by a caller-supplied session.
   *
   * @param {object} ref - resolved persisted-envelope reference.
   * @returns {{ok:true, previous:object}|{ok:false, reason:string}} binding verdict.
   */
  #persistedPreviousAttempt(ref) {
    const expected = this.#options.ownerId
    if (typeof expected !== 'string' || expected.length === 0) {
      return { ok: false, reason: 'no ownerId is configured for this adapter, so persisted history cannot be trusted' }
    }
    if (ref.envelope !== true || ref.packet === undefined) return { ok: false, reason: 'not a persisted task envelope' }
    if (ref.origin !== 'codex-bridge') return { ok: false, reason: `task origin "${ref.origin ?? '(absent)'}" is not "codex-bridge"` }
    if (ref.ownerId !== expected) return { ok: false, reason: 'task ownerId does not match this adapter owner' }
    const list = Array.isArray(ref.clarifications) ? ref.clarifications : []
    let snapshot
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index]
      if (isPlainObject(entry) && isPlainObject(entry.previousAttempt)) {
        snapshot = entry.previousAttempt
        break
      }
    }
    if (snapshot === undefined && isPlainObject(ref.previousAttempt)) snapshot = ref.previousAttempt
    if (snapshot === undefined) {
      return { ok: false, reason: 'no trusted clarifications[].previousAttempt history is present, so the owned session cannot be rebound' }
    }
    const problems = []
    const sessionId = typeof snapshot.sessionId === 'string' && snapshot.sessionId.length > 0 ? snapshot.sessionId : undefined
    const requestId = typeof snapshot.requestId === 'string' && snapshot.requestId.length > 0 ? snapshot.requestId : undefined
    const attemptId = typeof snapshot.attemptId === 'string' && snapshot.attemptId.length > 0 ? snapshot.attemptId : undefined
    if (sessionId === undefined) problems.push('previousAttempt.sessionId')
    if (requestId === undefined) problems.push('previousAttempt.requestId')
    if (attemptId === undefined) problems.push('previousAttempt.attemptId')
    if (!Number.isInteger(snapshot.revision) || snapshot.revision <= 0) problems.push('previousAttempt.revision')
    if (problems.length > 0) return { ok: false, reason: `trusted previousAttempt is incomplete (${problems.join(', ')})` }
    if (snapshot.revision !== ref.revision) {
      return { ok: false, reason: `previousAttempt.revision ${snapshot.revision} does not match the requested revision ${ref.revision}` }
    }
    if (ref.sessionId !== undefined && ref.sessionId !== sessionId) {
      return { ok: false, reason: 'the requested sessionId does not match the trusted previousAttempt.sessionId' }
    }
    let effectiveModel
    if (isPlainObject(snapshot.effectiveModel) && typeof snapshot.effectiveModel.provider === 'string' && typeof snapshot.effectiveModel.model === 'string') {
      effectiveModel = {
        provider: snapshot.effectiveModel.provider,
        model: snapshot.effectiveModel.model,
        ...(typeof snapshot.effectiveModel.reasoningEffort === 'string' ? { reasoningEffort: snapshot.effectiveModel.reasoningEffort } : {})
      }
    }
    return { ok: true, previous: { sessionId, requestId, attemptId, revision: snapshot.revision, effectiveModel } }
  }

  /**
   * Re-enforce the trusted recovery checks for a lifecycle dispatch on a RECOVERED
   * record (lifecycle repair 20260925.2). `#recoverTask` caches its record before a
   * caller validates it, so a cached record is NEVER by itself evidence of trust:
   * every reconsider of a recovered record must positively re-prove
   *
   *  - the durable previous request was actually claimed,
   *  - the durable session workspace is the immutable packet cwd,
   *  - the durable session model is the route bound to the previous attempt,
   *  - the agent-scoped enforcement guard is restored and still installed,
   *
   * and then re-read the durable binding/workspace from the host so the cached
   * record is not the sole proof. Missing or unreadable evidence refuses (fail
   * closed); nothing is replayed and no session is adopted.
   *
   * @param {object} record - adapter record (only recovered records are verified).
   * @returns {Promise<{ok:boolean, reason?:string, details?:object}>} verdict.
   */
  async #recoveryTrust(record) {
    if (record.recovered !== true) return { ok: true }
    const proof = isPlainObject(record.recoveryProof) ? record.recoveryProof : undefined
    if (proof === undefined) {
      return { ok: false, reason: 'the recovered record carries no trusted recovery proof' }
    }
    if (proof.boundClaimed !== true) {
      return {
        ok: false,
        reason: `durable host history shows no claimed turn for the trusted previous request "${proof.requestId ?? '(absent)'}"`,
        details: { requestId: proof.requestId ?? null, claimed: false }
      }
    }
    if (proof.cwdMatches !== true) {
      return {
        ok: false,
        reason: 'the durable session workspace does not match the immutable packet cwd',
        details: { cwdMatches: proof.cwdMatches ?? null }
      }
    }
    if (proof.modelMatches !== true) {
      return {
        ok: false,
        reason: 'the durable session model does not match the route bound to the previous attempt',
        details: { modelMatches: false, effectiveModel: proof.effectiveModel ?? null }
      }
    }
    if (proof.enforcementRestored !== true || record.enforcementRestored !== true || record.enforcementMechanisms.length === 0) {
      return {
        ok: false,
        reason: `the enforcement guard is not restored on the recovered session: ${proof.enforcementError ?? 'the guard could not be restored'}`,
        details: {
          enforcementRestored: false,
          boundTurn: proof.boundTurn ?? null,
          boundClaimed: proof.boundClaimed === true,
          boundTerminal: proof.boundTerminal === true
        }
      }
    }
    // The record is cached; re-read the host so a stale record can never carry a
    // dispatch on its own. Unreadable durable evidence is refused, not assumed.
    const durable = await this.#inspectDurable(proof.sessionId, false, proof.requestId)
    if (durable.available !== true) {
      return {
        ok: false,
        reason: `the durable host history for request "${proof.requestId}" is unreadable: ${durable.reason ?? 'inspect unavailable'}`,
        details: { requestId: proof.requestId ?? null }
      }
    }
    const bound = isPlainObject(durable.bound) ? durable.bound : undefined
    if (bound === undefined || bound.claimed !== true) {
      return {
        ok: false,
        reason: `durable host history no longer shows the trusted previous request "${proof.requestId}" claimed`,
        details: { requestId: proof.requestId ?? null, claimed: false }
      }
    }
    const headerCwd = durable.header !== undefined && durable.header !== null ? durable.header.cwd : undefined
    if (typeof headerCwd !== 'string' || isSamePath(headerCwd, record.packet.cwd) !== true) {
      return { ok: false, reason: 'the fresh durable session workspace does not match the immutable packet cwd', details: { cwdMatches: false } }
    }
    const actualModel = bound.model ?? durable.model ?? null
    const expectedModel = proof.effectiveModel ?? null
    const modelMatches =
      actualModel !== null &&
      expectedModel !== null &&
      actualModel.provider === expectedModel.provider &&
      actualModel.model === expectedModel.model
    if (modelMatches !== true) {
      return {
        ok: false,
        reason: 'the fresh durable session model does not match the route bound to the previous attempt',
        details: { modelMatches: false, effectiveModel: expectedModel }
      }
    }
    return { ok: true }
  }

  /**
   * Store-safe attempt receipt in the shape `start`/`continue` already return.
   *
   * @param {object} record - adapter record.
   * @param {object} attempt - attempt to report.
   * @param {{idempotentReplay?:boolean, recovery?:object|null}} [extra] - extras.
   * @returns {object} detached receipt.
   */
  #attemptReceipt(record, attempt, extra = {}) {
    return {
      sessionId: record.sessionId,
      requestId: attempt.requestId,
      effectiveModel: attempt.effectiveModel ?? null,
      effectivePolicy: this.#effectivePolicy(record, attempt.plan ?? record.plan),
      taskId: record.taskId,
      revision: record.revision,
      attemptId: attempt.attemptId,
      mode: attempt.mode,
      idempotentReplay: extra.idempotentReplay === true,
      ...(extra.recovery === undefined || extra.recovery === null ? {} : { recovery: extra.recovery })
    }
  }

  /**
   * Inspect a task from durable host history plus adapter-local facts.
   *
   * Returns a root-compatible view: `status` is one of the root's terminal words
   * when the attempt is settled, `stopConfirmed` and `activeJobs` are the exact
   * settlement gate the root re-checks, and `text` is the complete text so a
   * recovered completion is not lost. For a task this adapter instance has no
   * local record of, the report is `known:false` with `status:'unknown'` (never a
   * fabricated terminal claim), plus whatever durable history is readable.
   *
   * @param {object} task - task envelope, TaskPacket, or id.
   * @param {{includeEvents?: boolean}} [options] - extra detail.
   * @returns {Promise<object>} JSON-safe inspection.
   */
  async inspect(task, options = {}) {
    const ref = this.#resolveEnvelope(task)
    const record = this.#records.get(ref.id)
    if (record === undefined) {
      // Adapter reset: recover ONLY from the ROOT store's trusted persisted
      // envelope plus durable evidence bound to this task's requestId.
      const recovery = await this.#recoverTask(ref)
      if (recovery.record === undefined) {
        const durable = await this.#inspectDurable(ref.sessionId, options.includeEvents === true, ref.requestId)
        return jsonSafe({
          taskId: ref.id,
          revision: ref.revision ?? null,
          sessionId: ref.sessionId ?? null,
          projectId: null,
          known: false,
          recovered: false,
          status: 'unknown',
          adapterStatus: 'no-local-record',
          stopConfirmed: false,
          activeJobs: null,
          text: durable.available === true && isPlainObject(durable.bound) ? durable.bound.text : '',
          evidence: [],
          checks: [],
          uncertainties: [
            `this adapter has no local record for this task and it cannot be recovered: ${recovery.report.reason}`,
            'nothing is replayed and no terminal or settlement claim is made'
          ],
          reason: 'unknown-task',
          recovery: recovery.report,
          attempts: [],
          enforcement: null,
          events: { buffered: 0, dropped: 0, lastSeq: null, lastEventTime: null },
          durable
        })
      }
      this.#emit(recovery.record, recovery.record.current, 'attempt/recovered', { reason: recovery.report.reason })
      const recovered = await this.inspect(ref, options)
      return jsonSafe({ ...recovered, recovered: true, recovery: recovery.report })
    }

    const requestId = record.current !== undefined ? record.current.requestId : ref.requestId
    const durable = await this.#inspectDurable(record.sessionId, options.includeEvents === true, requestId)
    const agents = this.#service('agents')
    const liveAgent =
      agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(record.sessionId) : undefined
    const current = record.current
    // A RECOVERED record may report a root terminal status only when recovery
    // proved our own bound turn ended AND no work is in flight
    // (`record.stopConfirmed`); otherwise the status stays `unknown`.
    const adapterStatus =
      record.recovered === true && record.stopConfirmed !== true
        ? 'unknown'
        : current === undefined
          ? 'created'
          : current.state==='unknown'?'unknown':current.terminal
            ? current.state
            : !current.claimed
              ? 'queued'
              : 'running'
    const activeJobs = this.#ownedLiveJobs(record).length
    const effectiveModel =
      (durable.available === true ? durable.model : null) ?? record.durableModel ?? (current === undefined ? null : current.effectiveModel ?? null)
    const boundText = durable.available === true && isPlainObject(durable.bound) && typeof durable.bound.text === 'string' ? durable.bound.text : ''

    return jsonSafe({
      taskId: record.taskId,
      revision: record.revision,
      sessionId: record.sessionId,
      projectId: record.packet.projectId,
      known: true,
      recovered: record.recovered === true,
      status: adapterStatus,
      adapterStatus,
      live: liveAgent !== undefined && liveAgent !== null,
      agentStatus: record.agentStatus ?? null,
      stopConfirmed: record.stopConfirmed,
      activeJobs,
      // The task reply is this task's bound-attempt text, else the current
      // attempt's text. The whole-session transcript is NEVER promoted to the
      // task text; it remains available only in `durable.text` (diagnostic).
      text: boundText.length > 0 ? boundText : current !== undefined && current.assistantText.length > 0 ? current.assistantText : '',
      finalText: durable.bound?.stopReason === 'completed' ? durable.bound.finalText : current?.rootStatus === 'completed' ? current.finalText : undefined,
      evidence: [],
      checks: [],
      uncertainties: [],
      cleanedUp: record.cleanedUp,
      currentAttemptId: current === undefined ? null : current.attemptId,
      currentRequestId: current === undefined ? null : current.requestId,
      effectiveModel,
      effectivePolicy: this.#effectivePolicy(record, current === undefined ? undefined : current.plan),
      pendingQueueItems: this.#pendingQueueItems(record),
      ownedLiveJobs: this.#ownedLiveJobs(record),
      attempts: record.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        requestId: attempt.requestId,
        mode: attempt.mode,
        state: attempt.state,
        rootStatus: attempt.rootStatus ?? null,
        terminal: attempt.terminal,
        claimed: attempt.claimed,
        boundTurn: attempt.boundTurn ?? null,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt ?? null,
        stopReason: attempt.stopReason ?? null,
        stopDetail: attempt.stopDetail ?? null,
        textLength: attempt.assistantText.length,
        timedOut: attempt.timedOut === true
      })),
      lastResult: record.lastResult ?? null,
      usage: record.lastUsage ?? null,
      unboundAssistantMessages: record.unboundAssistantMessages ?? [],
      durable,
      enforcement: {
        mechanisms: record.enforcementMechanisms,
        notes: record.enforcementNotes,
        sandboxModeOverride: record.sandboxModeOverride,
        sandboxModeEvents: record.sandboxModeEvents,
        toolViolations: record.violations,
        delegationViolations: record.delegationViolations,
        availableTools: record.availableTools ?? null,
        agentPreset: record.agentPreset ?? null,
        agentPresetMatched: record.agentPresetMatched ?? null,
        toolCallsAdmitted: record.toolCallsAdmitted
      },
      events: {
        buffered: record.events.length,
        dropped: record.eventsDropped,
        lastSeq: record.lastSeq ?? null,
        lastEventTime: record.lastEventTime ?? null
      },
      listenerFailures: this.#listenerFailures
    })
  }

  async #inspectDurable(sessionId, includeEvents, requestId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { available: false, reason: 'no session is bound to this task' }
    }
    const controller = this.#service('sessionController')
    if (controller === null || controller === undefined || typeof controller.inspect !== 'function') {
      return { available: false, reason: 'sessionController.inspect unavailable' }
    }
    try {
      const inspection = await controller.inspect(sessionId)
      return this.#projectDurable(inspection, includeEvents, requestId)
    } catch (error) {
      return { available: false, reason: String((error && error.message) || error) }
    }
  }

  /**
   * Reconstruct an adapter record for a task after an adapter reset, using ONLY
   * the ROOT store's trusted persisted envelope plus durable host evidence.
   *
   * Rules: the envelope must be `origin:'codex-bridge'` and belong to this
   * adapter's `ownerId`; the attempt is the turn claimed by
   * `user/message source.rpcId === task.requestId`; the root terminal status is
   * claimed only for that turn's explicit `turn/end` AND only when no work is in
   * flight (live agent idle/absent, no task-owned queued item, no live owned job).
   * Otherwise the status stays `unknown` and nothing is replayed.
   *
   * @param {object} ref - resolved reference.
   * @returns {Promise<{record: object|undefined, report: object}>} recovery outcome.
   */
  async #recoverTask(ref) {
    const trust = this.#trustedPersistedTask(ref)
    if (!trust.trusted) {
      return {
        record: undefined,
        report: {
          recovered: false,
          trusted: false,
          reason: trust.reason,
          status: 'unknown',
          stopConfirmed: false,
          activeJobs: null
        }
      }
    }
    const durable = await this.#inspectDurable(ref.sessionId, false, ref.requestId)
    const agents = this.#service('agents')
    const agent = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(ref.sessionId) : undefined
    const session = { id: ref.sessionId, append() {}, header: durable.available === true ? durable.header ?? undefined : undefined }

    // Record skeleton first: pending-queue and job probes need the sessionId.
    const record = {
      taskId: ref.id,
      revision: ref.revision,
      requestDigest: digestPacket(ref.packet),
      packet: ref.packet,
      attempts: [],
      current: undefined,
      events: [],
      eventsDropped: 0,
      violations: [],
      delegationViolations: [],
      enforcementNotes: [],
      disposers: [],
      sandboxModeEvents: [],
      sandboxModeOverride: null,
      enforcementMechanisms: [],
      availableTools: undefined,
      scopedTools: undefined,
      bridgeTools: [],
      bridgeToolsRegistered: false,
      callbackBinding: ref.callbackBinding,
      commandJobs: [],
      announcedCallIds: new Set(),
      toolCallsAdmitted: 0,
      unboundAssistantMessages: [],
      stopInFlight: undefined,
      routeVerified: false,
      agentPreset: durable.available === true ? durable.header?.agentPreset ?? null : null,
      agentPresetMatched: null,
      hooks: {},
      createdAt: this.#now(),
      updatedAt: this.#now(),
      sessionId: ref.sessionId,
      agent,
      recovered: true,
      recoveredAt: this.#now(),
      enforcementRestored: false,
      agentStatus: undefined,
      openTurn: undefined,
      lastSeq: durable.available === true ? durable.lastSeq : undefined,
      lastEventTime: durable.available === true ? durable.lastTime : undefined,
      durableModel: durable.available === true ? durable.model : undefined,
      lastUsage: undefined,
      stopConfirmed: false,
      cleanedUp: false,
      uiHidden: false,
      uiHideMechanism: null,
      cleanedAt: undefined,
      startResult: undefined
    }
    if (agent !== undefined && agent !== null && session.header === undefined) {
      const header = contained(() => agent.session?.header, () => undefined)
      if (header !== undefined) session.header = header
    }

    const bound = durable.available === true && isPlainObject(durable.bound) ? durable.bound : undefined
    const attempt = {
      index: 0,
      attemptId: ref.attemptId,
      requestId: ref.requestId,
      mode: ref.packet.understandingRequired === true ? 'understanding' : 'execution',
      state: bound !== undefined && bound.terminal ? mapTerminalStatus(bound.stopReason) : 'unknown',
      hooks: {},
      claimed: bound !== undefined && bound.claimed === true,
      boundTurn: bound !== undefined && typeof bound.turn === 'number' ? bound.turn : undefined,
      assistantText: bound !== undefined ? bound.text : '',
      finalText: bound !== undefined ? bound.finalText : '',
      interrupted: false,
      toolCallEvents: bound !== undefined ? bound.toolCalls : 0,
      toolResultEvents: 0,
      cancelRequested: false,
      terminal: bound !== undefined && bound.terminal === true,
      rootStatus: bound !== undefined && bound.terminal ? mapTerminalStatus(bound.stopReason) : undefined,
      startedAt: durable.available === true && typeof durable.header?.createdAt === 'number' ? durable.header.createdAt : this.#now(),
      recovered: true
    }
    record.attempts.push(attempt)
    record.current = attempt

    // cwd check against durable meta (never trust the envelope's own claim alone).
    const headerCwd = durable.available === true ? durable.header?.cwd : undefined
    const cwdMatches = typeof headerCwd === 'string' ? isSamePath(headerCwd, ref.packet.cwd) : null

    // Enforcement: restore the guard when the agent scope is live. Otherwise the
    // recovered record is explicitly unguarded and callers must refuse to continue.
    let enforcementRestored = false
    let enforcementError = null
    const plan = this.#planEnforcement(ref.packet)
    if (agent !== undefined && agent !== null) {
      try {
        this.#verifyVisibleTools(record, plan)
        this.#attachEnforcement(record, plan)
        enforcementRestored = true
      } catch (error) {
        enforcementError = String((error && error.message) || error)
      }
    } else {
      enforcementError = 'no live agent is registered for this session, so the guard cannot be restored'
    }
    record.enforcementRestored = enforcementRestored
    record.plan = plan

    const pending = this.#pendingQueueItems(record)
    const liveJobs = this.#ownedLiveJobs(record)
    const agentStatus = agent !== undefined && agent !== null ? contained(() => agent.status, () => undefined) : undefined
    const inFlight = liveJobs.length > 0 || pending.length > 0 || agentStatus === 'running'
    const boundTerminal = bound !== undefined && (bound.terminal === true || (bound.claimed===true&&ref.confirmedCancellation===true))
    if(ref.confirmedCancellation===true&&bound?.claimed){attempt.terminal=true;attempt.state='cancelled';attempt.rootStatus='cancelled';attempt.stopDetail='host-idle-after-cancel';}
    const actualModel=bound?.model??durable.model;
    const expectedModel=ref.effectiveModel;
    const modelMatches=actualModel&&expectedModel&&actualModel.provider===expectedModel.provider&&actualModel.model===expectedModel.model;
    const terminal = boundTerminal && !inFlight && cwdMatches===true && modelMatches===true
    record.stopConfirmed = terminal
    record.durableBoundTerminal = boundTerminal && cwdMatches===true && modelMatches===true
    record.durableBoundKnown = bound !== undefined
    record.durableBoundTurn = bound !== undefined ? bound.turn : null

    // Trusted recovery evidence, pinned to the request/revision/workspace this
    // record was recovered for. Lifecycle callers must re-prove these positives on
    // EVERY reconsider of a recovered record; the cached record itself is never
    // evidence of trust (see `#recoveryTrust`).
    record.recoveryProof = {
      sessionId: ref.sessionId,
      requestId: ref.requestId,
      attemptId: ref.attemptId,
      revision: ref.revision,
      boundClaimed: bound !== undefined && bound.claimed === true,
      boundTurn: bound !== undefined && typeof bound.turn === 'number' ? bound.turn : null,
      boundTerminal: boundTerminal === true,
      cwdMatches: cwdMatches,
      modelMatches: modelMatches === true,
      effectiveModel:
        expectedModel === undefined ? null : { provider: expectedModel.provider ?? null, model: expectedModel.model ?? null },
      enforcementRestored: enforcementRestored === true,
      enforcementError: enforcementError
    }

    this.#records.set(ref.id, record)
    if (typeof ref.sessionId === 'string') this.#recordsBySession.set(ref.sessionId, record)

    return {
      record,
      report: {
        recovered: true,
        trusted: true,
        reason: terminal ? 'durable-bound-turn-settled' : boundTerminal ? 'work-in-flight' : bound !== undefined && bound.claimed ? 'bound-turn-not-terminal' : 'no-bound-turn-evidence',
        status: terminal ? attempt.rootStatus : 'unknown',
        adapterStatus: attempt.state,
        stopConfirmed: terminal,
        activeJobs: liveJobs.length,
        enforcementRestored,
        enforcementError,
        cwdMatches,
        modelMatches:modelMatches===true,
        bound,
        pendingQueueItems: pending,
        ownedLiveJobs: liveJobs,
        agentStatus: agentStatus ?? null
      }
    }
  }

  #projectDurable(inspection, includeEvents, requestId) {
    if (!isPlainObject(inspection)) return { available: false, reason: 'inspection was not a plain object' }
    const events = Array.isArray(inspection.events) ? inspection.events : []
    const assistantParts = []
    let turns = 0
    let toolCalls = 0
    let toolResults = 0
    let lastStopReason = null
    let lastStopDetail = null
    let lastSeq = null
    let lastTime = null
    let model = null
    for (const event of events) {
      if (!isPlainObject(event)) continue
      if (typeof event.seq === 'number') lastSeq = event.seq
      if (typeof event.time === 'number') lastTime = event.time
      const data = isPlainObject(event.data) ? event.data : undefined
      if (event.type === 'assistant/message' && data !== undefined) {
        const text = extractMessageText(data.message)
        if (text.length > 0) assistantParts.push(text)
      } else if (event.type === 'turn/end' && data !== undefined) {
        const reason = normalizeTurnEndReason(data.reason)
        lastStopReason = reason.kind
        lastStopDetail = reason.detail
        if (typeof data.turn === 'number' && data.turn > turns) turns = data.turn
      } else if (event.type === 'tool/call') {
        toolCalls += 1
      } else if (event.type === 'tool/result') {
        toolResults += 1
      } else if (event.type === 'model/selection' && data !== undefined && typeof data.provider === 'string' && typeof data.model === 'string') {
        model = {
          provider: data.provider,
          model: data.model,
          ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {})
        }
      }
    }
    const meta = isPlainObject(inspection.meta) ? inspection.meta : undefined
    // Request-bound attempt projection: the ONLY durable evidence that may speak
    // for this attempt is the turn claimed by `user/message source.rpcId ===
    // requestId`. Another turn's ending, and the whole-session transcript, are
    // reported separately and never as this attempt's result.
    const bound = {
      requestId: typeof requestId === 'string' && requestId.length > 0 ? requestId : null,
      claimed: false,
      claimedSeq: null,
      turn: null,
      text: '',
      finalText: '',
      toolCalls: 0,
      stopReason: null,
      stopDetail: null,
      terminal: false,
      seq: null,
      time: null,
      model: null
    }
    if (typeof requestId === 'string' && requestId.length > 0) {
      for (const event of events) {
        if (!isPlainObject(event) || event.type !== 'user/message') continue
        const data = isPlainObject(event.data) ? event.data : undefined
        const source = data !== undefined && isPlainObject(data.source) ? data.source : undefined
        if (source === undefined || source.rpcId !== requestId) continue
        if (bound.claimed) continue
        bound.claimed = true
        bound.claimedSeq = typeof event.seq === 'number' ? event.seq : null
        if (data !== undefined && typeof data.turn === 'number') bound.turn = data.turn
      }
      if (bound.claimed && bound.turn === null) {
        // Fall back to the last turn that opened at or before the claim.
        for (const event of events) {
          if (!isPlainObject(event) || event.type !== 'turn/start') continue
          if (typeof event.seq !== 'number' || bound.claimedSeq === null || event.seq > bound.claimedSeq) continue
          const data = isPlainObject(event.data) ? event.data : undefined
          if (data !== undefined && typeof data.turn === 'number') bound.turn = data.turn
        }
      }
      if (bound.turn !== null) {
        for (const event of events) {
          if (!isPlainObject(event)) continue
          const data = isPlainObject(event.data) ? event.data : undefined
          if (data === undefined || data.turn !== bound.turn) continue
          if (event.type === 'assistant/message') {
            const text = extractMessageText(data.message)
            if (text.length > 0) bound.text = bound.text.length === 0 ? text : `${bound.text}\n${text}`
            // The last assistant message is the handoff even when it is empty.
            bound.finalText = text
          } else if (event.type === 'tool/call') {
            bound.toolCalls += 1
          } else if (event.type === 'model/selection' && typeof data.provider === 'string' && typeof data.model === 'string') {
            bound.model = { provider: data.provider, model: data.model }
          } else if (event.type === 'turn/end') {
            const reason = normalizeTurnEndReason(data.reason)
            bound.terminal = true
            bound.stopReason = reason.kind
            bound.stopDetail = reason.detail
            bound.seq = typeof event.seq === 'number' ? event.seq : null
            bound.time = typeof event.time === 'number' ? event.time : null
          }
        }
      }
    }
    return {
      available: true,
      source: 'sessionController.inspect',
      header:
        meta === undefined
          ? null
          : {
              id: meta.id ?? null,
              cwd: meta.cwd ?? null,
              createdAt: meta.createdAt ?? null,
              parentSession: meta.parentSession ?? null,
              agentPreset: meta.agentPreset ?? null,
              delegationDepth: meta.delegationDepth ?? null,
              origin: meta.origin ?? null,
              isSeeded: meta.isSeeded === true
            },
      inheritedEventCount: typeof inspection.inheritedEventCount === 'number' ? inspection.inheritedEventCount : null,
      eventCount: events.length,
      turns,
      toolCalls,
      toolResults,
      lastStopReason,
      lastStopDetail,
      lastSeq,
      lastTime,
      model,
      bound,
      text: assistantParts.join('\n'),
      ...(includeEvents ? { events: events.map((event) => jsonSafe(event)) } : {})
    }
  }

  #effectivePolicy(record, plan) {
    if (plan === undefined) return { enforced: false, reason: 'no enforcement plan is bound to this task' }
    const mechanisms = record.enforcementMechanisms
    const fs = this.#service('fs')
    const osWriteFence = fs !== null && fs !== undefined && typeof fs.sandboxMode === 'string' ? fs.sandboxMode : null
    return {
      enforced: mechanisms.length > 0,
      requested: {
        role: record.packet.role,
        allowedTools: [...plan.allowedTools],
        readRoots: plan.readRoots,
        writeRoots: plan.writeRoots,
        allowShell: false,
        allowNetwork: plan.allowNetwork,
        allowDelegation: false
      },
      enforcement: {
        mechanisms,
        allowlist: 'deny-by-default monotonic guard over every registry-mediated tool dispatch',
        visibilityFiltered: mechanisms.includes('restrict'),
        recursiveDelegation: 'denied (tool allowlist + guard)',
        forbiddenTools: 'denied (unbounded capability in v1)',
        ownedJobTools: 'per-call ownership verified against JobSnapshot.ownerSession',
        shell: 'denied (unsupported)',
        network: plan.allowNetwork ? 'tool-level gate only' : 'denied',
        sandboxEscalation: 'denied',
        pathFence: 'canonical paths via realpathSync.native (nearest existing ancestor for new targets)',
        sandboxModeOverride: record.sandboxModeOverride,
        osWriteFence,
        childSessions:
          plan.grants?.childSessions?.enabled === true
            ? `bridge-owned dsh_child_* tools registered on the authorized parent only, depth 1, max ${plan.grants.childSessions.maxChildren}`
            : 'denied (no childSessions grant)',
        backgroundJobs:
          plan.grants?.backgroundJobs?.enabled === true
            ? `operator profiles only (${plan.grants.backgroundJobs.profileIds.join(', ')}); profile allowlist is not an OS sandbox`
            : 'denied (no backgroundJobs grant)',
        rootCallback: plan.grants?.rootCallback ? `bound to trusted grant "${plan.grants.rootCallback.grantId}"` : 'not granted',
        supervisorProject: plan.grants?.supervisorProject
          ? `supervisor-only dsh_supervisor_* tools registered on the authorized supervisor; workers are separate bounded tasks (max ${plan.grants.supervisorProject.maxWorkers} workers, maxConcurrent ${plan.grants.supervisorProject.maxConcurrentWorkers}, maxRepairAttempts ${plan.grants.supervisorProject.maxRepairAttempts})`
          : 'denied (no packet.project grant)',
        notes: record.enforcementNotes
      },
      budgets: {
        requested: plan.budgets,
        timeoutMs: { enforced: 'cooperative', mechanism: 'timer + cancel' },
        maxToolCalls: { enforced: 'hard', mechanism: 'guard counter (root and child starts share this attempt budget)' },
        maxOutputChars: {
          enforced: 'advisory',
          reason: 'no installed seam truncates model-facing output without corrupting the transcript'
        },
        child: {
          maxToolCalls: { enforced: 'hard', mechanism: 'child scoped guard counter + shared root attempt counter' },
          timeoutMs: { enforced: 'cooperative', mechanism: 'per-child deadline timer capped by the parent remaining deadline' },
          maxOutputChars: { enforced: 'bounded-retention', mechanism: 'adapter-retained child text capped; truncation reported' }
        }
      }
    }
  }

  #assertCwd(packet) {
    let stat
    try {
      stat = statSync(packet.cwd)
    } catch (error) {
      throw adapterError('adapter/invalid-packet', `cwd "${packet.cwd}" does not exist: ${String((error && error.message) || error)}`, {
        field: 'cwd'
      })
    }
    if (!stat.isDirectory()) {
      throw adapterError('adapter/invalid-packet', `cwd "${packet.cwd}" is not a directory`, { field: 'cwd' })
    }
  }

  /**
   * Report one task's live adapter state without touching the host.
   * @param {string} taskId - task id.
   * @returns {object|null} JSON-safe summary, or null when unknown.
   */
  status(taskId) {
    const record = this.#records.get(taskId)
    if (record === undefined) return null
    return jsonSafe({
      taskId,
      revision: record.revision,
      sessionId: record.sessionId,
      attempts: record.attempts.length,
      currentAttemptId: record.current === undefined ? null : record.current.attemptId,
      currentState: record.current === undefined ? null : record.current.state,
      stopConfirmed: record.stopConfirmed,
      cleanedUp: record.cleanedUp,
      events: record.events.length,
      eventsDropped: record.eventsDropped
    })
  }

  /**
   * Sessions this adapter created but could not bind (a bounded task failed
   * after `session.create` and before admission). No prompt was submitted for
   * any of them, so no work ran and no authority was granted; the installed host
   * exposes no session-disposal API, so they cannot be destroyed from here.
   * @returns {object[]} JSON-safe orphan records.
   */
  orphans() {
    return jsonSafe(this.#orphans)
  }

  /**
   * UI-archive an owned, settled session (lifecycle contract 20260925.2).
   *
   * The ONLY host mutation is `workspaceRegistry.archiveSession(sessionId)`. This
   * method never cleans up, deletes a worktree or session persistence, releases a
   * guard, kills a job, or modifies the record, its attempts, `endedAt`, `cleanedUp`
   * or the result/evidence. Its only adapter-local effect is remembering the hidden
   * sessionId so `reconsider` can deny a UI-archived session. It also never invents
   * a live-host capability: a missing
   * archive seam returns `supported:false`, and a host exception or an unproven
   * state returns a non-success result with no success marker. A success marker is
   * returned only after the host call resolves.
   *
   * @param {object} task - task envelope, TaskPacket, or identity reference with the exact revision.
   * @returns {Promise<object>} archive outcome (JSON-safe).
   */
  async archive(task) {
    if (this.#disposed) throw adapterError('adapter/disposed', 'this adapter has been disposed', {})
    const ref = this.#resolveEnvelope(task)
    if (ref.revision === undefined) {
      throw adapterError('adapter/revision-required', 'archive requires the exact positive task revision', { taskId: ref.id })
    }
    let record = this.#records.get(ref.id)
    if (record === undefined) {
      const recovery = await this.#recoverTask(ref)
      record = recovery.record
    }
    if (record === undefined) {
      return jsonSafe({
        taskId: ref.id,
        revision: ref.revision,
        sessionId: ref.sessionId ?? null,
        supported: true,
        archived: false,
        uiHidden: false,
        outcome: 'unknown',
        retryable: false,
        reason: 'unknown-task',
        workspacePreserved: true,
        evidencePreserved: true
      })
    }
    this.#assertProvenance(record, ref)
    this.#assertOwnership(record, ref)

    const current = record.current
    const terminalStatus =
      current !== undefined && current.terminal === true && ROOT_TERMINAL.has(current.rootStatus) ? current.rootStatus : undefined
    const proof = this.#freshSettledProof(record)
    const blockers = [...proof.blockers]
    const unknown = [...proof.unknown]
    if (terminalStatus === undefined) blockers.push('attempt-not-terminal')
    if (record.stopConfirmed !== true) blockers.push('stop_unconfirmed')

    if (unknown.length > 0 || blockers.length > 0) {
      // No success marker here: an unproven or unknown state stays unresolved.
      return jsonSafe({
        taskId: record.taskId,
        revision: record.revision,
        sessionId: record.sessionId,
        supported: true,
        archived: false,
        uiHidden: false,
        outcome: unknown.length > 0 ? 'unknown' : 'unresolved',
        retryable: unknown.length > 0,
        reason: unknown.length > 0 ? 'host-state-unknown' : 'not-settled',
        status: terminalStatus ?? null,
        blockers,
        unknown,
        observed: proof.observed,
        workspacePreserved: true,
        evidencePreserved: true
      })
    }

    const registry = this.#service('workspaceRegistry')
    if (registry === null || registry === undefined || typeof registry.archiveSession !== 'function') {
      return jsonSafe({
        taskId: record.taskId,
        revision: record.revision,
        sessionId: record.sessionId,
        supported: false,
        archived: false,
        uiHidden: false,
        outcome: 'unsupported',
        retryable: false,
        reason: 'ctx.workspaceRegistry.archiveSession is unavailable in this host',
        workspacePreserved: true,
        evidencePreserved: true
      })
    }

    try {
      await registry.archiveSession(record.sessionId)
    } catch (error) {
      // The call may or may not have applied the archive; the outcome is unknown and
      // no success marker is set.
      return jsonSafe({
        taskId: record.taskId,
        revision: record.revision,
        sessionId: record.sessionId,
        supported: true,
        archived: false,
        uiHidden: false,
        outcome: 'unknown',
        retryable: true,
        reason: 'workspaceRegistry.archiveSession threw',
        error: String((error && error.message) || error),
        workspacePreserved: true,
        evidencePreserved: true
      })
    }

    // Host success: the session is UI-hidden in the workspace registry. Nothing
    // else is touched — the worktree, result, events, retention clock and guard
    // remain exactly as they were.
    this.#archivedSessions.add(record.sessionId)
    return jsonSafe({
      archived: true,
      uiHidden: true,
      sessionId: record.sessionId,
      workspacePreserved: true,
      evidencePreserved: true
    })
  }

  /**
   * Release this task's adapter-owned enforcement and hide its session from the
   * host's grouping surfaces. Refuses while work could still be running
   * (unconfirmed stop, live attempt, queued items, live owned jobs) so cleanup
   * can never orphan active work, and refuses a session this adapter did not
   * create for this task. Durable deletion is NOT available in the installed
   * host and is always reported as unsupported rather than faked.
   * @param {object} task - task envelope, TaskPacket, or id.
   * @returns {Promise<object>} JSON-safe cleanup report (`cleaned` is the root's gate).
   */
  async cleanup(task) {
    if (this.#disposed) throw adapterError('adapter/disposed', 'this adapter has been disposed', {})
    const ref = this.#resolveEnvelope(task)
    const persistenceCleanup = {
      supported: false,
      deleted: false,
      reason:
        'the installed SessionPersistence abstract surface is create/open/flush/stat/list only; there is no durable session deletion API'
    }
    let record = this.#records.get(ref.id)
    if(record===undefined){const recovery=await this.#recoverTask(ref);record=recovery.record;}
    if (record === undefined) {
      return jsonSafe({
        taskId: ref.id,
        supported: true,
        cleaned: false,
        performed: false,
        reason: 'unknown-task',
        uiHidden: false,
        persistenceDeleted: false,
        persistenceCleanup
      })
    }
    const base = {
      taskId: record.taskId,
      revision: record.revision,
      sessionId: record.sessionId,
      supported: true,
      persistenceDeleted: false,
      persistenceCleanup
    }

    if (ref.sessionId !== undefined && ref.sessionId !== record.sessionId) {
      return jsonSafe({
        ...base,
        cleaned: false,
        performed: false,
        reason: 'not-owned',
        detail: `this adapter created session "${record.sessionId}" for task "${record.taskId}", not "${ref.sessionId}"`,
        uiHidden: false
      })
    }
    if (record.cleanedUp) {
      return jsonSafe({
        ...base,
        cleaned: true,
        performed: false,
        reason: 'already-cleaned',
        uiHidden: record.uiHidden === true,
        uiHideMechanism: record.uiHideMechanism ?? null
      })
    }

    const pending = this.#pendingQueueItems(record)
    const liveJobs = this.#ownedLiveJobs(record)
    const liveChildren = this.#supervisor !== undefined ? this.#supervisor.liveChildren(record.taskId) : []
    const attemptActive = record.current !== undefined && !record.current.terminal
    const blockers = []
    if (!record.stopConfirmed) blockers.push('stop_unconfirmed')
    if (attemptActive) blockers.push('active_attempt')
    if (pending.length > 0) blockers.push('queued_items')
    if (liveJobs.length > 0) blockers.push('active_jobs')
    if (liveChildren.length > 0) blockers.push('active_children')
    if (blockers.length > 0) {
      return jsonSafe({
        ...base,
        cleaned: false,
        performed: false,
        reason: 'not-stopped',
        blockers,
        uiHidden: false,
        detail: {
          pendingQueueItems: pending,
          ownedLiveJobs: liveJobs,
          liveChildren: liveChildren.map((child) => ({ childId: child.childId, state: child.state })),
          activeAttemptId: attemptActive ? record.current.attemptId : null
        }
      })
    }

    // Hide the session FIRST, while the guard is still installed: `cleaned:true`
    // may only be returned after a REAL durable archive success. On failure the
    // enforcement is preserved and the caller may retry cleanup.
    let uiHidden = false
    let uiHideMechanism = null
    let uiHideError = null
    const registry = this.#service('workspaceRegistry')
    if (!this.#options.archiveOnCleanup) {
      uiHideError = 'archiveOnCleanup is disabled by adapter options'
    } else if (registry === null || registry === undefined || typeof registry.archiveSession !== 'function') {
      uiHideError = 'ctx.workspaceRegistry.archiveSession is unavailable in this host'
    } else {
      try {
        await registry.archiveSession(record.sessionId)
        uiHidden = true
        uiHideMechanism = 'workspaceRegistry.archiveSession'
      } catch (error) {
        uiHideError = String((error && error.message) || error)
      }
    }
    if (uiHidden !== true) {
      return jsonSafe({
        ...base,
        cleaned: false,
        performed: false,
        reason: 'archive-failed',
        uiHidden: false,
        uiHideError,
        retryable: true,
        guardPreserved: true,
        persistenceDeleted: false,
        detail: 'cleanup made no destructive change: enforcement stays installed and no job was killed, so cleanup can be retried'
      })
    }

    const jobs = this.#service('jobs')
    const killedJobs = []
    for (const job of liveJobs) {
      const outcome = contained(
        () => (jobs !== null && jobs !== undefined && typeof jobs.kill === 'function' ? jobs.kill(job.id, record.sessionId, 'cleanup') : undefined),
        () => undefined
      )
      killedJobs.push({ jobId: job.id, result: outcome ?? 'unavailable' })
    }

    let released = 0
    for (const disposer of record.disposers) {
      contained(disposer, () => undefined)
      released += 1
    }
    record.disposers = []
    record.enforcementMechanisms = []
    if (record.current !== undefined && record.current.timeoutTimer !== undefined) {
      clearTimeout(record.current.timeoutTimer)
      record.current.timeoutTimer = undefined
    }

    record.cleanedUp = true
    record.uiHidden = uiHidden
    record.uiHideMechanism = uiHideMechanism
    record.cleanedAt = this.#now()
    this.#emit(record, undefined, 'cleanup/performed', {
      uiHidden,
      uiHideMechanism,
      uiHideError,
      enforcementDisposersReleased: released
    })

    return jsonSafe({
      ...base,
      cleaned: true,
      performed: true,
      reason: 'cleaned',
      uiHidden,
      uiHideMechanism,
      uiHideError,
      unarchiveSupported: false,
      unarchiveReason: 'the installed workspace registry exposes no unarchive entry point; the archive set is durable and one-way',
      released: { enforcementDisposers: released, jobsKilled: killedJobs },
      cleanedAt: record.cleanedAt
    })
  }

  /**
   * Release adapter-owned resources. No host session is destroyed.
   * @returns {object} JSON-safe summary.
   */
  dispose() {
    if (this.#disposed) return jsonSafe({ disposed: true, alreadyDisposed: true })
    this.#disposed = true
    // Owned child runtime resources are released here: scoped enforcement is
    // lifted synchronously and every owned AgentHandle is disposed (the promise is
    // contained, never awaited). The stop of a child that was still live stays
    // UNPROVEN until observed, so its reservation is retained and the child is
    // recorded unknown — an unproven stop is never converted into a release.
    // Teardown is only INITIATED here: `handle.dispose()` returns a promise that
    // is contained, never awaited, so `completed` is counted only when a dispose
    // promise has already settled or is not thenable. `initiated`/`pending` say
    // what was started; `childrenTornDown` is the OBSERVED-completed count, never
    // the initiation count.
    let childrenTeardownInitiated = 0
    let childrenTeardownPending = 0
    let childrenTeardownCompleted = 0
    let childTeardownFailures = 0
    for (const [, runtime] of this.#childById.entries()) {
      if (runtime.deadlineTimer !== undefined) {
        clearTimeout(runtime.deadlineTimer)
        runtime.deadlineTimer = undefined
      }
      const live = runtime.terminal !== true
      if (live && this.#supervisor !== undefined) {
        contained(() => this.#markChildUnknown(runtime, 'adapter disposed before the child stop was confirmed'), () => undefined)
      }
      if (runtime.teardownState === 'disposed') {
        if (runtime.slotReleaseProven === true) childrenTeardownCompleted += 1
        continue
      }
      for (const disposer of runtime.disposers.splice(0)) {
        contained(disposer, () => undefined)
      }
      const handle = runtime.handle
      if (handle !== undefined && handle !== null && typeof handle.dispose === 'function') {
        contained(
          () => {
            const pending = handle.dispose()
            childrenTeardownInitiated += 1
            if (pending !== undefined && pending !== null && typeof pending.then === 'function') {
              childrenTeardownPending += 1
              pending.then(undefined, () => undefined)
            } else {
              childrenTeardownCompleted += 1
            }
          },
          () => {
            childTeardownFailures += 1
          }
        )
      } else if (typeof runtime.sessionId === 'string') {
        // No owned handle exists for a published session: report it rather than
        // claiming a teardown that cannot happen.
        childTeardownFailures += 1
      }
      runtime.teardownState = runtime.teardownState === 'disposed' ? 'disposed' : 'disposing'
    }
    this.#childBySession.clear()
    let released = 0
    for (const record of this.#records.values()) {
      for (const disposer of record.disposers) {
        contained(disposer, () => undefined)
        released += 1
      }
      record.disposers = []
      if (record.current !== undefined && record.current.timeoutTimer !== undefined) {
        clearTimeout(record.current.timeoutTimer)
        record.current.timeoutTimer = undefined
      }
    }
    for (const disposer of this.#disposers) contained(disposer, () => undefined)
    this.#disposers = []
    this.#archivedSessions.clear()
    return jsonSafe({
      disposed: true,
      records: this.#records.size,
      enforcementDisposersReleased: released,
      childrenTeardownInitiated,
      childrenTeardownPending,
      childrenTeardownCompleted,
      // Compatibility field: now the OBSERVED-completed count, not the initiation
      // count the finding objected to.
      childrenTornDown: childrenTeardownCompleted,
      childTeardownFailures,
      childStopsProven: false
    })
  }
}

/**
 * Stable digest of the enforced parts of a packet, used to detect a duplicate
 * `start` for the same task identity.
 * @param {object} packet - validated packet.
 * @returns {string} digest.
 */
function digestPacket(packet) {
  return JSON.stringify(
    jsonSafe({
      id: packet.id,
      revision: packet.revision,
      cwd: packet.cwd,
      role: packet.role,
      scope: packet.scope,
      objective: packet.objective
    })
  )
}

/**
 * Extract plain text from one user/assistant message value.
 * @param {unknown} message - message-shaped value.
 * @returns {string} joined text blocks.
 */
export function extractMessageText(message) {
  if (message === undefined || message === null || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Normalize a `turn/end` reason into a stable `{kind, detail}` pair.
 * The reason map is merge-extensible, so unknown kinds are surfaced verbatim
 * instead of being dropped or thrown on.
 * @param {unknown} reason - `turn/end` data reason.
 * @returns {{kind: string, detail: string|null}} normalized reason.
 */
export function normalizeTurnEndReason(reason) {
  if (reason === undefined || reason === null) return { kind: 'unknown', detail: null }
  const kind =
    typeof reason === 'string' && reason.length > 0 ? reason : isPlainObject(reason) && typeof reason.kind === 'string' ? reason.kind : 'unknown'
  let detail = null
  if (kind === 'aborted') {
    const nested = isPlainObject(reason) ? reason.reason : undefined
    detail =
      typeof nested === 'string' && nested.length > 0 ? nested : isPlainObject(nested) && typeof nested.kind === 'string' ? nested.kind : 'legacy'
  } else if (kind === 'error') {
    const failure = isPlainObject(reason) ? reason.error : undefined
    if (isPlainObject(failure)) detail = typeof failure.code === 'string' ? failure.code : typeof failure.message === 'string' ? failure.message : null
  }
  return { kind, detail }
}

export default DshAdapter
