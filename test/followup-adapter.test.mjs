/**
 * Follow-up adapter tests (FAKE-HOST ONLY) — contract `bridge-followup-plan-v1`.
 *
 * These cases drive the real `DshAdapter` through the same bounded fake host used by
 * `test/dsh-adapter.test.mjs` (copied here, never edited there; no exports exist to
 * share). No real DSH host runs, no model is prompted and no tool body executes;
 * filesystem paths are real existing directories. Evidence class: MOCK.
 *
 * Covered adapter rows of plan §5:
 *  - same-session execution-mode dispatch with no create/selectModel, writes denied;
 *  - the reused reconsider refusal gates (in-flight, foreign session, changed
 *    packet/route, cleaned, archived, unsettled host, live job, absent/replaced
 *    guarded agent) with `dispatched:false` and no prompt;
 *  - restart recovery from `followups[].boundAttempt` for completed and
 *    confirmed-cancelled predecessors, and refusal for a missing/mismatched one;
 *  - refusal-then-success across a restart with the carried `boundAttempt`;
 *  - the per-attempt tool budget and the child shared cap base;
 *  - a running follow-up recovered after a restart keeps execution mode.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { DshAdapter } from '../src/dsh-adapter.mjs'
import { BridgeSupervisor, sharedLedger } from '../src/supervisor.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Existing directory used as the task cwd. */
const ROOT = HERE
/** Parent of the task cwd: outside the default read/write roots. */
const OUTSIDE = path.dirname(HERE)

const FLASH = { provider: 'deepseek-official', model: 'deepseek-flash' }

const ALL_TOOLS = [
  'read',
  'write',
  'edit',
  'read_image',
  'glob',
  'grep',
  'str_replace_editor',
  'todo_write',
  'present',
  'ask_user_question',
  'skill',
  'get_goal',
  'create_goal',
  'update_goal',
  'job_list',
  'job_output',
  'job_kill',
  'web_search',
  'web_fetch',
  'pwsh',
  'bash',
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
]

// ---------------------------------------------------------------------------
// fake host (copied from test/dsh-adapter.test.mjs; that file is never edited)
// ---------------------------------------------------------------------------

/**
 * Build a bounded fake DSH host implementing the documented seams.
 * @param {object} [options] - host variations.
 * @returns {object} `{ctx, ...control surface}`.
 */
function createFakeHost(options = {}) {
  const listeners = new Map()
  const calls = {
    create: [],
    rename: [],
    selectModel: [],
    prompt: [],
    followup: [],
    cancel: [],
    agentCancel: [],
    updateQueue: [],
    inspect: [],
    archived: [],
    jobsKilled: [],
    jobGet: [],
    restrictions: [],
    registered: [],
    globalToolCalls: [],
    composeFrom: [],
    systemPromptContexts: []
  }
  const agents = new Map()
  const scopedGuards = []
  const registered = []
  const scopedPreExecute = []
  const appended = new Map()
  const availableTools = options.availableTools ?? ALL_TOOLS
  const jobs = options.jobs ?? []
  let sessionSeq = 0
  let messageSeq = 0
  let seqSeq = 0

  const hostTools = {
    schemas: () => availableTools.map((name) => ({ name })),
    restrict: () => {
      calls.globalToolCalls.push('restrict')
      return () => {}
    },
    guard: () => {
      calls.globalToolCalls.push('guard')
      return () => {}
    }
  }

  function dispatch(event, ...args) {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }

  function subagentOwnershipRefusal(sessionId) {
    const agent = agents.get(sessionId)
    if (agent === undefined || agent.session?.header?.origin !== 'subagent') return null
    return Object.assign(
      new Error(`session "${sessionId}" is owned by subagent routing`),
      { code: 'session/agent-busy', reason: 'use subagent delivery for this child session' }
    )
  }

  function makeAgent(sessionId, cwd, isChild = false, agentOptions = {}) {
    const agent = {
      id: sessionId,
      status: options.initialStatus ?? 'running',
      options: { ...(agentOptions.hostAgentOptions ?? {}) },
      session: {
        id: sessionId,
        header: {
          id: sessionId,
          cwd,
          ...(agentOptions.origin === undefined ? {} : { origin: agentOptions.origin }),
          ...(agentOptions.delegationDepth === undefined ? {} : { delegationDepth: agentOptions.delegationDepth })
        },
        append(type, data) {
          const list = appended.get(sessionId) ?? []
          list.push({ type, data: jsonSafe(data) })
          appended.set(sessionId, list)
        }
      },
      inbox: { nextTurn: [], nextStep: [] },
      followup(message) {
        calls.followup.push({ sessionId, message: jsonSafe(message) })
        if (options.followupThrows === true) throw Object.assign(new Error('followup refused by the host'), { code: 'session/agent-busy' })
        agent.inbox.nextTurn.push(message)
        if (typeof agentOptions.onFollowup === 'function') agentOptions.onFollowup(agent, message)
      },
      cancel(cause, cancelOptions) {
        calls.agentCancel.push({ sessionId, cause, options: cancelOptions })
        agent.inbox.nextTurn.length = 0
        agent.inbox.nextStep.length = 0
      },
      ctx: {
        get(name) {
          if (name !== 'tools') return undefined
          if (options.scopedToolsUnavailable === true) return undefined
          if (isChild && options.childToolsUnavailable === true) return undefined
          const ownRegistrations = () => registered.filter((entry) => entry.sessionId === sessionId).map((entry) => ({ name: entry.definition.name }))
          const scoped = {
            schemas: () => [...availableTools.map((tool) => ({ name: tool })), ...ownRegistrations()],
            register(definition) {
              const entry = { sessionId, definition }
              registered.push(entry)
              calls.registered.push({ sessionId, name: definition?.name ?? null })
              return () => {
                const index = registered.indexOf(entry)
                if (index >= 0) registered.splice(index, 1)
              }
            },
            restrict(filter) {
              if (options.restrictFails === true) throw new Error('restriction rejected by the registry')
              if (isChild && options.childRestrictFails === true) {
                throw new Error('tools.restrict() names unknown global tool "read"; known global tools: (none)')
              }
              calls.restrictions.push({ sessionId, filter: jsonSafe(filter) })
              return () => {}
            },
            guard(fn) {
              if (options.guardThrows === true) throw new Error('guard unsupported in this host')
              if (isChild && options.childGuardThrows === true) throw new Error('guard unsupported in this child scope')
              scopedGuards.push({ sessionId, fn })
              return () => {
                const index = scopedGuards.findIndex((entry) => entry.fn === fn)
                if (index >= 0) scopedGuards.splice(index, 1)
              }
            }
          }
          if (isChild && options.childGuardUnavailable === true) delete scoped.guard
          return scoped
        },
        on(event, fn) {
          if (event === 'tools/pre-execute') {
            if (options.scopedListenerUnavailable === true) return undefined
            scopedPreExecute.push({ sessionId, fn })
          }
          return () => {}
        }
      }
    }
    return agent
  }

  const sessionController = {
    async create(request) {
      calls.create.push(jsonSafe(request))
      if (options.createFails === true) throw Object.assign(new Error('create rejected'), { code: 'gateway/internal' })
      sessionSeq += 1
      const sessionId = options.forcedSessionId ?? `session-${sessionSeq}`
      agents.set(sessionId, makeAgent(sessionId, request.cwd))
      const value = { sessionId }
      if (options.createAgentPreset !== undefined) value.agentPreset = options.createAgentPreset
      else if (request.agentPreset !== undefined) value.agentPreset = request.agentPreset
      return value
    },
    async rename(request) {
      calls.rename.push(jsonSafe(request))
    },
    async selectModel(request) {
      calls.selectModel.push(jsonSafe(request))
      const ownership = subagentOwnershipRefusal(request.sessionId)
      if (ownership !== null) throw ownership
      if (options.rejectModel === true) throw Object.assign(new Error('unknown model route'), { code: 'model/not-found' })
      return {
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort })
        }
      }
    },
    async prompt(request, signal) {
      calls.prompt.push({ ...jsonSafe(request), hasThrowIfAborted: !!(signal && typeof signal.throwIfAborted === 'function') })
      const ownership = subagentOwnershipRefusal(request.sessionId)
      if (ownership !== null) throw ownership
      if (options.promptFails === true) throw new Error('session already has an in-flight submission')
      const agent = agents.get(request.sessionId)
      messageSeq += 1
      agent.inbox.nextTurn.push({
        id: `msg-${messageSeq}`,
        source: { kind: 'user', rpcId: request.requestId },
        content: request.content
      })
      return { accepted: true }
    },
    cancel(request) {
      calls.cancel.push(jsonSafe(request))
      const ownership = subagentOwnershipRefusal(request.sessionId)
      if (ownership !== null) throw ownership
      if (options.cancelFails === true) throw Object.assign(new Error('session not found (not attached)'), { code: 'session/not-found' })
      if (typeof options.onCancel === 'function') options.onCancel(api, request)
      return { accepted: true }
    },
    updateQueue(request) {
      calls.updateQueue.push(jsonSafe(request))
      const ownership = subagentOwnershipRefusal(request.sessionId)
      if (ownership !== null) throw ownership
      if (options.updateQueueFails === true) throw new Error('item is no longer pending')
      const agent = agents.get(request.sessionId)
      for (const list of [agent.inbox.nextTurn, agent.inbox.nextStep]) {
        const index = list.findIndex((message) => message.id === request.itemId)
        if (index >= 0) {
          list.splice(index, 1)
          return { accepted: true }
        }
      }
      throw new Error('item is no longer pending')
    },
    async inspect(sessionId) {
      calls.inspect.push(sessionId)
      if (options.inspectFails === true) throw new Error('session not found')
      return {
        meta: { id: sessionId, cwd: ROOT, createdAt: 1, isSeeded: false },
        inheritedEventCount: 0,
        events: options.durableEvents ?? []
      }
    }
  }

  const services = {
    sessionController,
    llm:
      options.llm ??
      {
        listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
        listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }]
      },
    jobs: {
      list: (caller) => {
        calls.jobListCaller = caller === undefined ? null : typeof caller === 'string' ? caller : caller.id
        return jobs
      },
      get: (id, caller) => {
        calls.jobGet.push({ id, caller: caller === undefined ? null : typeof caller === 'string' ? caller : caller.id })
        if (options.jobsGetFails === true) throw Object.assign(new Error(`job "${id}" not found`), { code: 'job/not-found' })
        const job = jobs.find((entry) => entry.id === id)
        if (job === undefined) throw Object.assign(new Error(`job "${id}" not found`), { code: 'job/not-found' })
        return { ...job }
      },
      kill: (id, caller, reason) => {
        calls.jobsKilled.push({ id, caller: caller === undefined ? null : typeof caller === 'string' ? caller : caller.id, reason })
        const job = jobs.find((entry) => entry.id === id)
        if (job !== undefined) job.status = 'killed'
        return 'requested'
      }
    },
    agents: {
      get: (id) => agents.get(id),
      async create(request) {
        calls.agentCreate = calls.agentCreate ?? []
        calls.agentCreate.push(jsonSafe({ sessionId: request.sessionId, meta: request.meta ?? null, agentOptions: request.agentOptions ?? null }))
        const agent = makeAgent(request.sessionId, request.meta?.cwd ?? ROOT, true, {
          origin: request.meta?.origin,
          delegationDepth: request.meta?.delegationDepth,
          hostAgentOptions: options.createIgnoresAgentOptions === true ? {} : { ...(request.agentOptions ?? {}), ...(options.createChildRouteOverride ?? {}) }
        })
        const parentCtx = request.parentAgent !== undefined && request.parentAgent !== null ? request.parentAgent.ctx : undefined
        const setupCtx = {
          get(name) {
            if (name === 'tools') return agent.ctx.get('tools')
            if (name === 'agentPresets') {
              if (options.childPresetsUnavailable === true) return undefined
              if (options.childComposeFromUnavailable === true) return { composedPreset: () => 'standard', resolve: async () => ({ id: 'standard' }) }
              return {
                composedPreset: () => 'standard',
                composeFrom(childCtx, joinParentCtx) {
                  calls.composeFrom.push({
                    childSessionId: request.sessionId,
                    childCtxIsScoped: childCtx === setupCtx,
                    parentCtxIsParent: parentCtx !== undefined && joinParentCtx === parentCtx,
                    joinedTools: ['read']
                  })
                }
              }
            }
            return undefined
          },
          systemPrompt: {
            context(contribution) {
              calls.systemPromptContexts.push({ childSessionId: request.sessionId, contribution: jsonSafe(contribution) })
              return () => {}
            },
            getContextOrder(name) {
              return name === 'SUBAGENT_DELEGATION' ? 100 : 0
            }
          }
        }
        const setupCtxForCall = options.childSetupUsesParentCtx === true && parentCtx !== undefined ? parentCtx : setupCtx
        if (typeof request.setup === 'function') await request.setup(setupCtxForCall, agent)
        agents.set(request.sessionId, agent)
        return { agent, dispose: async () => { agents.delete(request.sessionId) } }
      }
    },
    workspaceRegistry: {
      archiveSession: async (id) => {
        calls.archived.push(id)
      }
    },
    sessionPersistence: {},
    sandboxPolicy: {},
    fs: { sandboxMode: options.fsSandboxMode ?? 'workspace-write' },
    sessionQuery: {}
  }
  if (options.noWorkspaceRegistry === true) delete services.workspaceRegistry
  if (options.noJobs === true) delete services.jobs
  if (options.noFs === true) delete services.fs
  if (options.noLlm === true) delete services.llm

  const ctx = {
    get(name) {
      if (name === 'tools') return options.noTools === true ? undefined : hostTools
      return services[name]
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
    calls,
    agents,
    scopedGuards,
    scopedPreExecute,
    jobs,
    appended,
    registered,
    registeredDefinition(sessionId, name) {
      const entry = registered.find((candidate) => candidate.sessionId === sessionId && candidate.definition?.name === name)
      return entry === undefined ? undefined : entry.definition
    },
    dispatch,
    emitSession(sessionId, event) {
      seqSeq += 1
      dispatch('session/event', { id: sessionId }, { seq: event.seq ?? seqSeq, time: event.time ?? Date.now(), ...event })
    },
    emitTurnStart(sessionId, turn) {
      api.emitSession(sessionId, { type: 'turn/start', data: { turn } })
    },
    emitUserMessage(sessionId, requestId, turn) {
      messageSeq += 1
      api.emitSession(sessionId, {
        type: 'user/message',
        data: { id: `msg-claimed-${messageSeq}`, turn, source: { kind: 'user', rpcId: requestId } }
      })
    },
    emitAssistant(sessionId, turn, text) {
      api.emitSession(sessionId, {
        type: 'assistant/message',
        data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }
      })
    },
    emitToolCall(sessionId, turn, name, callId = 'call-1') {
      api.emitSession(sessionId, { type: 'tool/call', data: { turn, step: 1, callId, name, arguments: '{}' } })
    },
    emitToolResult(sessionId, turn) {
      api.emitSession(sessionId, { type: 'tool/result', data: { turn, step: 1, message: { role: 'user' } } })
    },
    emitTurnEnd(sessionId, turn, reason) {
      api.emitSession(sessionId, { type: 'turn/end', data: { turn, reason } })
    },
    emitModelSelection(sessionId, provider, model, reasoningEffort) {
      api.emitSession(sessionId, {
        type: 'model/selection',
        data: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
      })
    },
    setStatus(sessionId, status) {
      const agent = agents.get(sessionId)
      if (agent !== undefined) agent.status = status
      dispatch('agent/status', { agent, status })
    },
    deleteAgent(sessionId) {
      agents.delete(sessionId)
    },
    inboxOf(sessionId) {
      return agents.get(sessionId).inbox
    },
    runTool(sessionId, name, args, callId = 'call-1') {
      const exec = { name, arguments: args, agent: agents.get(sessionId), callId, rootCallId: callId }
      const guard = [...scopedGuards].reverse().find((entry) => entry.sessionId === sessionId)
      if (guard !== undefined) {
        const reason = guard.fn(exec)
        if (reason !== undefined) return { allowed: false, reason }
      }
      const listener = [...scopedPreExecute].reverse().find((entry) => entry.sessionId === sessionId)
      if (listener !== undefined) {
        const decision = listener.fn(exec, () => ({ kind: 'allow' }))
        if (decision !== undefined && decision.kind === 'deny') return { allowed: false, reason: decision.reason }
      }
      return { allowed: true }
    }
  }
  return api
}

/** `jsonSafe` copy: only the fake host's registration/event snapshots need it. */
function jsonSafe(value, seen = new Set(), depth = 0) {
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

/** Simulate the host claiming a queued prompt. */
function claim(host, sessionId, requestId, turn = 1) {
  host.emitTurnStart(sessionId, turn)
  host.emitUserMessage(sessionId, requestId, turn)
  const inbox = host.inboxOf(sessionId)
  for (const list of [inbox.nextTurn, inbox.nextStep]) {
    const index = list.findIndex((message) => message.source.rpcId === requestId)
    if (index >= 0) list.splice(index, 1)
  }
}

function supervisorFor(options = {}) {
  const ledger = sharedLedger(`followup-adapter-supervisor-${randomUUID()}`, { limit: options.limit ?? 8 })
  return new BridgeSupervisor({
    ledger,
    ownerId: 'owner-1',
    config: {
      childSessions: options.childSessions ?? { enabled: true, maxChildrenPerTask: 2, maxDepth: 1, waitTimeoutMs: 50, maxWaitTimeoutMs: 100 },
      commandJobs: options.commandJobs ?? { enabled: false },
      rootCallbackGrants: options.rootCallbackGrants ?? {},
      notificationSink: options.notificationSink
    }
  })
}

const BASE_PACKET = {
  schemaVersion: 1,
  idempotencyKey: 'followup-key-1',
  revision: 1,
  projectId: 'followup-proj-1',
  title: 'bounded follow-up task',
  objective: 'do the bounded read-only thing',
  cwd: ROOT,
  role: 'investigate',
  acceptance: ['acceptance one'],
  scope: {
    readRoots: [ROOT],
    writeRoots: [ROOT],
    allowedTools: ['read', 'write', 'edit', 'todo_write'],
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

/**
 * Build the root's task envelope. `payloadOnly: true` is used for follow-up envelopes
 * that the adapter must refuse; the extra persisted fields are added by
 * `followupEnvelope`.
 * @param {object} [overrides] - envelope/packet overrides.
 * @returns {object} envelope.
 */
function makeEnvelope(overrides = {}) {
  const packet = makePacket(overrides.packet)
  return {
    id: overrides.id ?? 'task-followup-1',
    revision: overrides.revision ?? packet.revision,
    attemptId: overrides.attemptId ?? 'attempt-followup-1',
    packet,
    prompt: overrides.prompt ?? 'ROOT BUILD PROMPT: do the bounded thing',
    effectiveModel: overrides.effectiveModel ?? { ...FLASH },
    ...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
    ...(overrides.status === undefined ? {} : { status: overrides.status })
  }
}

// ---------------------------------------------------------------------------
// follow-up fixtures
// ---------------------------------------------------------------------------

/**
 * The trusted predecessor snapshot the store persists as
 * `followups[].boundAttempt` (plan §4 store step 3).
 * @param {object} [overrides] - snapshot overrides.
 * @returns {object} boundAttempt.
 */
function boundAttempt(overrides = {}) {
  return {
    attemptId: 'attempt-prev-1',
    requestId: 'req-prev-1',
    sessionId: 'session-1',
    revision: 1,
    effectiveModel: { ...FLASH },
    status: 'completed',
    stopConfirmed: true,
    settlementEvidence: [],
    ...overrides
  }
}

/**
 * Persisted follow-up envelope (`{...task, packet}`) for a store-minted follow-up
 * attempt: the `followups[]` entry carries this attemptId and the trusted
 * `boundAttempt` predecessor snapshot.
 * @param {object} [overrides] - envelope/entry overrides.
 * @returns {object} envelope.
 */
function followupEnvelope(overrides = {}) {
  const packet = makePacket(overrides.packet ?? { understandingRequired: true })
  const revision = overrides.revision ?? packet.revision
  const attemptId = overrides.attemptId ?? 'attempt-followup-2'
  const bound = overrides.boundAttempt ?? boundAttempt({ revision })
  const entry = {
    followupId: overrides.followupId ?? 'fu-1',
    requestHash: 'hash-fu-1',
    text: 'what about the boundary case',
    revision,
    afterAttemptId: 'attempt-prev-1',
    attemptId,
    round: 1,
    createdAt: 1,
    boundAttempt: bound
  }
  return {
    id: overrides.id ?? 'task-followup-1',
    revision,
    attemptId,
    origin: overrides.origin ?? 'codex-bridge',
    ownerId: overrides.ownerId ?? 'owner-1',
    packet,
    prompt: overrides.prompt ?? 'FOLLOW-UP: what about the boundary case',
    effectiveModel: overrides.effectiveModel ?? { ...FLASH },
    sessionId: overrides.sessionId ?? 'session-1',
    continuationKind: overrides.continuationKind ?? 'followup',
    status: overrides.status ?? 'queued',
    stopConfirmed: false,
    followups: overrides.followups ?? [entry],
    ...(overrides.requestId === undefined ? {} : { requestId: overrides.requestId }),
    ...(overrides.extra ?? {})
  }
}

/** Durable host history: the bound predecessor request was claimed and completed. */
const PREDECESSOR_SETTLED = [
  { type: 'model/selection', seq: 0, time: 0, data: { provider: FLASH.provider, model: FLASH.model } },
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { id: 'm-prev', turn: 1, source: { kind: 'user', rpcId: 'req-prev-1' } } },
  {
    type: 'assistant/message',
    seq: 3,
    time: 3,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'FIRST ANSWER' }] } }
  },
  { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }
]

/** Same bound predecessor, claimed but with NO turn/end (cancelled by idle proof). */
const PREDECESSOR_CLAIMED_ONLY = [
  { type: 'model/selection', seq: 0, time: 0, data: { provider: FLASH.provider, model: FLASH.model } },
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { id: 'm-prev', turn: 1, source: { kind: 'user', rpcId: 'req-prev-1' } } },
  {
    type: 'assistant/message',
    seq: 3,
    time: 3,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'PARTIAL ANSWER' }] } }
  }
]

/** The host settlement evidence a confirmed cancelled attempt persists in `result.evidence`. */
function hostIdleSettlement(overrides = {}) {
  return {
    source: 'dsh-host',
    kind: 'attempt-settlement',
    sessionId: 'session-1',
    requestId: 'req-prev-1',
    attemptId: 'attempt-prev-1',
    turn: 1,
    stopDetail: 'host-idle-after-cancel',
    ...overrides
  }
}

/**
 * Pre-create the one live owned session the durable fixture belongs to.
 * @param {object} host - fake host.
 * @param {string} [status] - live agent status.
 * @returns {Promise<string>} session id.
 */
async function ownedLiveSession(host, status = 'idle') {
  const created = await host.ctx.get('sessionController').create({ cwd: ROOT })
  host.setStatus(created.sessionId, status)
  return created.sessionId
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('capabilities advertises the follow-up lifecycle exactly as the plan fixes it', async () => {
  const adapter = new DshAdapter(createFakeHost().ctx)
  assert.equal(typeof adapter.followup, 'function')
  const caps = await adapter.capabilities()
  const followup = caps.lifecycle.followup
  assert.equal(followup.supported, true)
  assert.equal(followup.mode, 'execution')
  assert.deepEqual(followup.roles, ['investigate', 'review'])
  assert.equal(followup.session, 'existing owned session only')
  assert.equal(followup.model, 'reuses the bound route')
  assert.equal(followup.budget, 'each follow-up gets the original packet budget (per-attempt base)')
  assert.deepEqual(followup.excludes, ['packet.project', 'project workers', 'unapproved understanding gate'])
  assert.ok(Array.isArray(followup.gates) && followup.gates.length === 5)
  assert.match(followup.recovery, /followups\[\]\.boundAttempt only/)
  assert.match(followup.recovery, /guarded-agent-absent/)
  assert.deepEqual(followup.limits, { followupIdMaxChars: 200, textMaxChars: 20000 })
  // The clarification lifecycle stays exactly as it was.
  assert.equal(caps.lifecycle.reconsider.mode, 'understanding')
})

// ---------------------------------------------------------------------------
// same-session execution-mode dispatch
// ---------------------------------------------------------------------------

test('followup dispatches a new execution attempt in the same session without create/selectModel and keeps writes denied', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const packet = {
    understandingRequired: true,
    scope: { writeRoots: [], allowedTools: ['read', 'write', 'todo_write'] }
  }
  const started = await adapter.start(makeEnvelope({ id: 'task-fu-dispatch', attemptId: 'attempt-prev-1', packet }))
  claim(host, started.sessionId, started.requestId, 1)
  host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })

  const before = { create: host.calls.create.length, prompt: host.calls.prompt.length, selectModel: host.calls.selectModel.length }
  const receipt = await adapter.followup(
    followupEnvelope({ id: 'task-fu-dispatch', attemptId: 'attempt-followup-2', packet, prompt: 'FOLLOW-UP PROMPT: continue' }),
    {}
  )

  assert.equal(receipt.sessionId, started.sessionId, 'the follow-up runs in the SAME owned session')
  assert.equal(receipt.attemptId, 'attempt-followup-2')
  assert.notEqual(receipt.requestId, started.requestId)
  assert.equal(receipt.mode, 'execution')
  assert.equal(receipt.idempotentReplay, false)
  assert.deepEqual(receipt.effectiveModel, FLASH)
  assert.equal(host.calls.create.length, before.create, 'a follow-up never creates a session')
  assert.equal(host.calls.selectModel.length, before.selectModel, 'a follow-up never selects a model')
  assert.equal(host.calls.prompt.length, before.prompt + 1)
  assert.equal(host.calls.prompt[before.prompt].sessionId, started.sessionId)
  assert.equal(host.calls.prompt[before.prompt].content[0].text, 'FOLLOW-UP PROMPT: continue')

  // Execution mode keeps the packet's allowed read tool; it never re-installs the
  // understanding fence.
  assert.equal(host.runTool(started.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-read').allowed, true)
  const write = host.runTool(started.sessionId, 'write', { file_path: path.join(ROOT, 'a.txt') }, 'call-write')
  assert.equal(write.allowed, false)
  assert.match(write.reason, /writeRoots/, 'the packet declares no writeRoots, so the write stays denied')

  const inspected = await adapter.inspect(makeEnvelope({ id: 'task-fu-dispatch' }))
  assert.equal(inspected.currentAttemptId, 'attempt-followup-2')
  assert.equal(inspected.attempts.at(-1).mode, 'execution')
  assert.equal(inspected.attempts.at(-1).continuation, undefined, 'continuation is internal and never leaked')
})

test('followup replays an already-minted attemptId without a second prompt and refuses a whole-task attemptId', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const packet = {}
  const started = await adapter.start(makeEnvelope({ id: 'task-fu-replay', attemptId: 'attempt-prev-1', packet }))
  claim(host, started.sessionId, started.requestId, 1)
  host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })

  const envelope = followupEnvelope({ id: 'task-fu-replay', attemptId: 'attempt-followup-2', packet })
  const receipt = await adapter.followup(envelope, {})
  assert.equal(receipt.mode, 'execution')
  const promptsAfterFirst = host.calls.prompt.length

  const replay = await adapter.followup(envelope, {})
  assert.equal(replay.idempotentReplay, true)
  assert.equal(replay.attemptId, 'attempt-followup-2')
  assert.equal(replay.requestId, receipt.requestId)
  assert.equal(host.calls.prompt.length, promptsAfterFirst, 'a replayed follow-upId never dispatches a second prompt')

  // The whole-task attemptId is bound to an attempt of the OTHER continuation.
  const conflict = followupEnvelope({ id: 'task-fu-replay', attemptId: 'attempt-prev-1', packet, prompt: 'CONFLICT PROBE' })
  await assert.rejects(adapter.followup(conflict, {}), (error) => {
    assert.equal(error.code, 'adapter/attempt-conflict')
    assert.equal(error.dispatched, false)
    return true
  })
  assert.equal(host.calls.prompt.length, promptsAfterFirst)
})

// ---------------------------------------------------------------------------
// reused refusal gates (dispatched:false, no prompt)
// ---------------------------------------------------------------------------

test('followup refuses an in-flight attempt, a foreign session, a changed packet and a changed route before any prompt', async () => {
  // In-flight attempt.
  {
    const host = createFakeHost()
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const packet = {}
    await adapter.start(makeEnvelope({ id: 'task-fu-flight', attemptId: 'attempt-prev-1', packet }))
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-flight', attemptId: 'attempt-followup-2', packet }), {}), (error) => {
      assert.equal(error.code, 'adapter/attempt-in-flight')
      assert.equal(error.dispatched, false)
      return true
    })
    assert.equal(host.calls.prompt.length, 1, 'no follow-up prompt is sent while the previous attempt is in flight')
    assert.equal(host.calls.create.length, 1)
  }
  // A session this adapter never bound to the task.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const packet = {}
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-session', attemptId: 'attempt-prev-1', packet }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    await assert.rejects(
      adapter.followup(followupEnvelope({ id: 'task-fu-session', attemptId: 'attempt-followup-2', packet, sessionId: 'someone-elses-session' }), {}),
      (error) => {
        assert.equal(error.code, 'adapter/session-mismatch')
        assert.equal(error.dispatched, false)
        return true
      }
    )
    assert.equal(host.calls.prompt.length, 1)
  }
  // A packet that is not the immutable original.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-packet', attemptId: 'attempt-prev-1' }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    await assert.rejects(
      adapter.followup(
        followupEnvelope({ id: 'task-fu-packet', attemptId: 'attempt-followup-2', packet: { objective: 'a different objective' } }),
        {}
      ),
      (error) => {
        assert.equal(error.code, 'adapter/packet-changed')
        assert.equal(error.dispatched, false)
        return true
      }
    )
    assert.equal(host.calls.prompt.length, 1)
  }
  // A route that is not the one the host verified for this task.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const packet = {}
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-route', attemptId: 'attempt-prev-1', packet }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    await assert.rejects(
      adapter.followup(
        followupEnvelope({
          id: 'task-fu-route',
          attemptId: 'attempt-followup-2',
          packet,
          effectiveModel: { provider: 'deepseek-official', model: 'deepseek-v4-astra', reasoningEffort: 'xhigh' }
        }),
        {}
      ),
      (error) => {
        assert.equal(error.code, 'adapter/model-route-mismatch')
        assert.equal(error.dispatched, false)
        return true
      }
    )
    assert.equal(host.calls.prompt.length, 1)
    assert.equal(host.calls.selectModel.length, 1)
  }
})

test('followup refuses a cleaned or archived task and requires a nonempty controller-built prompt', async () => {
  // Cleaned task.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-cleaned', attemptId: 'attempt-prev-1' }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    const cleaned = await adapter.cleanup(makeEnvelope({ id: 'task-fu-cleaned' }))
    assert.equal(cleaned.cleaned, true)
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-cleaned', attemptId: 'attempt-followup-2' }), {}), (error) => {
      assert.equal(error.code, 'adapter/task-cleaned')
      assert.equal(error.dispatched, false)
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // UI-archived task.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-archived', attemptId: 'attempt-prev-1' }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    const archived = await adapter.archive({ ...makeEnvelope({ id: 'task-fu-archived' }), ownerId: 'owner-1', origin: 'codex-bridge' })
    assert.equal(archived.archived, true)
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-archived', attemptId: 'attempt-followup-2' }), {}), (error) => {
      assert.equal(error.code, 'adapter/task-archived')
      assert.equal(error.dispatched, false)
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // Missing / blank controller-built prompt.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-prompt', attemptId: 'attempt-prev-1' }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    for (const prompt of [undefined, '']) {
      const envelope = followupEnvelope({ id: 'task-fu-prompt', attemptId: 'attempt-followup-2' })
      if (prompt === undefined) delete envelope.prompt
      else envelope.prompt = prompt
      await assert.rejects(adapter.followup(envelope, {}), (error) => {
        assert.equal(error.code, 'adapter/invalid-packet')
        assert.equal(error.dispatched, false)
        return true
      })
      assert.equal(host.calls.prompt.length, 1, 'a prompt-less follow-up never dispatches')
    }
  }
})

test('followup refuses an unsettled host, a live owned job, an absent guarded agent and a replaced one', async () => {
  // Live agent still running after the turn end: the host is not positively idle.
  {
    const host = createFakeHost({ initialStatus: 'running' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const packet = {}
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-running', attemptId: 'attempt-prev-1', packet }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-running', attemptId: 'attempt-followup-2', packet }), {}), (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(Array.isArray(error.details.blockers) && error.details.blockers.includes('host-not-idle'))
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // An owned live job blocks the follow-up.
  {
    const host = createFakeHost({ initialStatus: 'idle', jobs: [{ id: 'bash-1', ownerSession: 'session-1', status: 'running' }] })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const packet = {}
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-jobs', attemptId: 'attempt-prev-1', packet }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-jobs', attemptId: 'attempt-followup-2', packet }), {}), (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(error.details.blockers.includes('live-jobs'))
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // The live agent for the owned session disappears: prompt would resume it unguarded.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const packet = {}
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-absent', attemptId: 'attempt-prev-1', packet }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    host.deleteAgent(started.sessionId)
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-absent', attemptId: 'attempt-followup-2', packet }), {}), (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(error.details.blockers.includes('guarded-agent-absent'))
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // The session was rebound to a different live agent object.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const packet = {}
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-replaced', attemptId: 'attempt-prev-1', packet }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    const guarded = host.agents.get(started.sessionId)
    const replacement = { ...guarded, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
    host.agents.set(started.sessionId, replacement)
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-replaced', attemptId: 'attempt-followup-2', packet }), {}), (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(error.details.blockers.includes('guarded-agent-replaced'))
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
    assert.notEqual(host.agents.get(started.sessionId), guarded)
  }
})

// ---------------------------------------------------------------------------
// reused refusal gates: queued work and live child sessions
// ---------------------------------------------------------------------------

test('followup reuses the reconsider blockers for queued work and live child sessions', async () => {
  // A queued item (even one this task does not own) blocks the follow-up.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    const packet = {}
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-queued', attemptId: 'attempt-prev-1', packet }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    host.inboxOf(started.sessionId).nextTurn.push({ id: 'm-late', source: { kind: 'user', rpcId: 'someone-else-request' } })
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-queued', attemptId: 'attempt-followup-2', packet }), {}), (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(error.details.blockers.includes('queued-items'))
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // A live owned child session blocks the follow-up.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const supervisor = supervisorFor()
    const adapter = new DshAdapter(host.ctx, { supervisor, ownerId: 'owner-1' })
    const packet = {
      scope: {
        writeRoots: [],
        allowedTools: ['read', 'todo_write'],
        childSessions: { enabled: true, maxChildren: 1, toolNames: ['todo_write'] }
      }
    }
    const started = await adapter.start(makeEnvelope({ id: 'task-fu-child-live', attemptId: 'attempt-prev-1', packet }))
    claim(host, started.sessionId, started.requestId, 1)
    const parentAgent = host.agents.get(started.sessionId)
    await host
      .registeredDefinition(started.sessionId, 'dsh_child_spawn')
      .execute(
        { childKey: 'c1', objective: 'child work', tools: ['todo_write'] },
        { agent: parentAgent, arguments: { childKey: 'c1', objective: 'child work', tools: ['todo_write'] } }
      )
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    await assert.rejects(adapter.followup(followupEnvelope({ id: 'task-fu-child-live', attemptId: 'attempt-followup-2', packet }), {}), (error) => {
      assert.equal(error.code, 'adapter/host-not-settled')
      assert.equal(error.dispatched, false)
      assert.ok(error.details.blockers.some((blocker) => String(blocker).startsWith('live-children')))
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
})

// ---------------------------------------------------------------------------
// restart recovery from followups[].boundAttempt
// ---------------------------------------------------------------------------

test('followup after an adapter reset recovers from followups[].boundAttempt for a completed predecessor', async () => {
  const host = createFakeHost({ durableEvents: PREDECESSOR_SETTLED, initialStatus: 'idle' })
  await ownedLiveSession(host)
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })

  const envelope = followupEnvelope({
    id: 'task-fu-recover-completed',
    attemptId: 'attempt-followup-2',
    packet: { understandingRequired: true, objective: 'the original immutable objective', scope: { writeRoots: [] } }
  })
  const receipt = await adapter.followup(envelope, {})

  assert.equal(receipt.sessionId, 'session-1')
  assert.equal(receipt.attemptId, 'attempt-followup-2')
  assert.equal(receipt.mode, 'execution')
  assert.notEqual(receipt.requestId, 'req-prev-1')
  assert.equal(host.calls.create.length, 1, 'recovery must not create a session')
  assert.equal(host.calls.prompt.length, 1, 'the follow-up is dispatched once on the recovered session')
  assert.equal(host.calls.prompt[0].sessionId, 'session-1')
  assert.equal(host.calls.prompt[0].content[0].text, envelope.prompt)
  assert.equal(receipt.recovery.reason, 'durable-bound-turn-settled')
  assert.equal(receipt.recovery.enforcementRestored, true)
  assert.ok(host.scopedGuards.some((entry) => entry.sessionId === 'session-1'), 'the guard is restored before dispatch')
})

test('followup after an adapter reset recovers a confirmed-cancelled predecessor from host-idle settlement evidence', async () => {
  const host = createFakeHost({ durableEvents: PREDECESSOR_CLAIMED_ONLY, initialStatus: 'idle' })
  await ownedLiveSession(host)
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })

  const envelope = followupEnvelope({
    id: 'task-fu-recover-cancelled',
    attemptId: 'attempt-followup-2',
    packet: { understandingRequired: true, scope: { writeRoots: [] } },
    boundAttempt: boundAttempt({
      status: 'cancelled',
      stopConfirmed: true,
      settlementEvidence: [hostIdleSettlement()]
    })
  })
  const receipt = await adapter.followup(envelope, {})

  assert.equal(receipt.sessionId, 'session-1')
  assert.equal(receipt.mode, 'execution')
  assert.equal(host.calls.prompt.length, 1)
  assert.equal(host.calls.prompt[0].sessionId, 'session-1')
  assert.equal(host.calls.create.length, 1)

  // The same snapshot WITHOUT the exact host settlement evidence does NOT confirm a
  // cancel, so the recovered predecessor is not terminal and the reopen refuses.
  const host2 = createFakeHost({ durableEvents: PREDECESSOR_CLAIMED_ONLY, initialStatus: 'idle' })
  await ownedLiveSession(host2)
  const adapter2 = new DshAdapter(host2.ctx, { ownerId: 'owner-1' })
  const unconfirmed = followupEnvelope({
    id: 'task-fu-recover-cancelled',
    attemptId: 'attempt-followup-2',
    packet: { understandingRequired: true, scope: { writeRoots: [] } },
    boundAttempt: boundAttempt({
      status: 'cancelled',
      stopConfirmed: true,
      settlementEvidence: [hostIdleSettlement({ stopDetail: 'turn-removed' })]
    })
  })
  await assert.rejects(adapter2.followup(unconfirmed, {}), (error) => {
    assert.equal(error.code, 'adapter/attempt-in-flight')
    assert.equal(error.dispatched, false)
    return true
  })
  assert.equal(host2.calls.prompt.length, 0)
})

test('followup after an adapter reset refuses a missing, mismatched or incomplete boundAttempt', async () => {
  const base = {
    id: 'task-fu-recover-refuse',
    attemptId: 'attempt-followup-2',
    packet: { understandingRequired: true, scope: { writeRoots: [] } }
  }
  const cases = [
    ['no followups history', { followups: [] }],
    ['no entry for this attemptId', { followups: [{ attemptId: 'attempt-someone-else', boundAttempt: boundAttempt() }] }],
    ['entry without boundAttempt', { followups: [{ attemptId: 'attempt-followup-2' }] }],
    ['boundAttempt missing requestId', { boundAttempt: boundAttempt({ requestId: '' }) }],
    ['boundAttempt missing sessionId', { boundAttempt: boundAttempt({ sessionId: undefined }) }],
    ['boundAttempt missing attemptId', { boundAttempt: boundAttempt({ attemptId: undefined }) }],
    ['boundAttempt with another revision', { boundAttempt: boundAttempt({ revision: 2 }) }],
    ['requested session differs from the bound session', { sessionId: 'session-9' }]
  ]
  for (const [label, overrides] of cases) {
    const host = createFakeHost({ durableEvents: PREDECESSOR_SETTLED, initialStatus: 'idle' })
    await ownedLiveSession(host)
    const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
    await assert.rejects(adapter.followup(followupEnvelope({ ...base, ...overrides }), {}), (error) => {
      assert.equal(error.code, 'adapter/recovery-unsafe', `${label}: expected recovery-unsafe, got ${error.code}: ${error.message}`)
      assert.equal(error.dispatched, false, `${label}: a recovery refusal is never a dispatch`)
      return true
    })
    assert.equal(host.calls.prompt.length, 0, `${label}: nothing is replayed or dispatched`)
    assert.equal(host.calls.create.length, 1, `${label}: no replacement session is created`)
  }
})

test('followup after an adapter reset refuses when the trusted bound request was never claimed', async () => {
  // The bound request does not exist in the durable history: the recovery cannot
  // prove a claimed turn, so it must refuse instead of replaying or adopting.
  const host = createFakeHost({ durableEvents: PREDECESSOR_SETTLED, initialStatus: 'idle' })
  await ownedLiveSession(host)
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const envelope = followupEnvelope({
    id: 'task-fu-unclaimed',
    attemptId: 'attempt-followup-2',
    packet: { understandingRequired: true, scope: { writeRoots: [] } },
    boundAttempt: boundAttempt({ requestId: 'req-never-claimed' })
  })
  await assert.rejects(adapter.followup(envelope, {}), (error) => {
    assert.equal(error.code, 'adapter/recovery-unsafe')
    assert.equal(error.dispatched, false)
    return true
  })
  assert.equal(host.calls.prompt.length, 0)
  assert.equal(host.calls.create.length, 1)
})

test('a refused follow-up is retried after a restart with the carried boundAttempt (N2 chain)', async () => {
  const host = createFakeHost({ durableEvents: PREDECESSOR_SETTLED, initialStatus: 'running' })
  await ownedLiveSession(host, 'running')
  const carried = boundAttempt()
  const packet = { understandingRequired: true, scope: { writeRoots: [] } }

  // First adapter after the reset: recovery succeeds but the host is not settled, so
  // the dispatch is refused with `dispatched:false` and no receipt is stored.
  const adapter1 = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const refused = followupEnvelope({
    id: 'task-fu-chain',
    attemptId: 'attempt-followup-2',
    packet,
    boundAttempt: carried,
    followups: [{ attemptId: 'attempt-followup-2', boundAttempt: carried }]
  })
  await assert.rejects(adapter1.followup(refused, {}), (error) => {
    assert.equal(error.code, 'adapter/host-not-settled')
    assert.equal(error.dispatched, false)
    return true
  })
  assert.equal(host.calls.prompt.length, 0)

  // The host settles. A second (restarted) adapter mints attempt 3 and reuses the
  // carried boundAttempt because attempt 2 never produced a request binding.
  host.setStatus('session-1', 'idle')
  const adapter2 = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const retried = followupEnvelope({
    id: 'task-fu-chain',
    attemptId: 'attempt-followup-3',
    packet,
    boundAttempt: carried,
    followups: [
      { attemptId: 'attempt-followup-2', boundAttempt: carried },
      { attemptId: 'attempt-followup-3', boundAttempt: carried }
    ]
  })
  const receipt = await adapter2.followup(retried, {})
  assert.equal(receipt.sessionId, 'session-1')
  assert.equal(receipt.attemptId, 'attempt-followup-3')
  assert.equal(receipt.mode, 'execution')
  assert.equal(host.calls.prompt.length, 1)
  assert.equal(host.calls.prompt[0].content[0].text, retried.prompt)
  assert.equal(host.calls.create.length, 1, 'the retry reuses the one owned session')
})

// ---------------------------------------------------------------------------
// per-attempt budgets
// ---------------------------------------------------------------------------

test('a follow-up gets a fresh per-attempt tool budget after the previous allowance is exhausted', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const packet = {
    scope: { writeRoots: [], allowedTools: ['read'] },
    budget: { timeoutMs: 600000, maxToolCalls: 1, maxOutputChars: 200000 }
  }
  const started = await adapter.start(makeEnvelope({ id: 'task-fu-budget', attemptId: 'attempt-prev-1', packet }))
  claim(host, started.sessionId, started.requestId, 1)
  assert.equal(host.runTool(started.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-a1').allowed, true)
  const exhausted = host.runTool(started.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-a2')
  assert.equal(exhausted.allowed, false)
  assert.match(exhausted.reason, /budget exhausted/)

  host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
  const receipt = await adapter.followup(
    followupEnvelope({ id: 'task-fu-budget', attemptId: 'attempt-followup-2', packet, prompt: 'FOLLOW-UP BUDGET' })
  )
  assert.equal(receipt.mode, 'execution')
  claim(host, receipt.sessionId, receipt.requestId, 2)

  // The previous allowance is exhausted, but the follow-up has its OWN full allowance.
  assert.equal(host.runTool(receipt.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-b1').allowed, true)
  const followupExhausted = host.runTool(receipt.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-b2')
  assert.equal(followupExhausted.allowed, false)
  assert.match(followupExhausted.reason, /budget exhausted/)
})

test('a follow-up round counts child tool starts from its per-attempt base', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor, ownerId: 'owner-1' })
  const packet = {
    scope: {
      writeRoots: [],
      allowedTools: ['read', 'todo_write'],
      childSessions: { enabled: true, maxChildren: 1, toolNames: ['read', 'todo_write'] }
    },
    budget: { timeoutMs: 600000, maxToolCalls: 2, maxOutputChars: 200000 }
  }
  const started = await adapter.start(makeEnvelope({ id: 'task-fu-child', attemptId: 'attempt-prev-1', packet }))
  claim(host, started.sessionId, started.requestId, 1)
  assert.equal(host.runTool(started.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-p1').allowed, true)
  assert.equal(host.runTool(started.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-p2').allowed, true)
  assert.equal(host.runTool(started.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-p3').allowed, false)
  host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })

  const receipt = await adapter.followup(
    followupEnvelope({ id: 'task-fu-child', attemptId: 'attempt-followup-2', packet, prompt: 'FOLLOW-UP CHILD' })
  )
  assert.equal(receipt.mode, 'execution')
  claim(host, receipt.sessionId, receipt.requestId, 2)

  const parentAgent = host.agents.get(receipt.sessionId)
  const spawn = host.registeredDefinition(receipt.sessionId, 'dsh_child_spawn')
  const child = await spawn.execute(
    { childKey: 'c1', objective: 'child work', tools: ['todo_write'] },
    { agent: parentAgent, arguments: { childKey: 'c1', objective: 'child work', tools: ['todo_write'] } }
  )
  assert.equal(child.state, 'running')

  // The previous round already consumed the whole cumulative allowance (2). Without
  // the per-attempt base this FIRST child start would be denied as exhausted.
  const firstChildStart = host.runTool(child.sessionId, 'todo_write', { todos: [] }, 'child-call-1')
  assert.equal(firstChildStart.allowed, true, `expected the child start to be admitted: ${firstChildStart.reason ?? ''}`)

  // The follow-up still enforces the cap: its one remaining root call is admitted,
  // the next is denied, and the child shares that exhausted round budget.
  assert.equal(host.runTool(receipt.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-r1').allowed, true)
  const rootExhausted = host.runTool(receipt.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-r2')
  assert.equal(rootExhausted.allowed, false)
  assert.match(rootExhausted.reason, /budget exhausted/)
  const secondChildStart = host.runTool(child.sessionId, 'todo_write', { todos: [] }, 'child-call-2')
  assert.equal(secondChildStart.allowed, false)
  assert.match(secondChildStart.reason, /shares its parent's tool budget/)
})

// ---------------------------------------------------------------------------
// a running follow-up recovered after a restart keeps execution mode
// ---------------------------------------------------------------------------

test('a running follow-up recovered after an adapter reset keeps execution mode', async () => {
  const durableEvents = [
    { type: 'model/selection', seq: 0, time: 0, data: { provider: FLASH.provider, model: FLASH.model } },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { id: 'm-fu-run', turn: 1, source: { kind: 'user', rpcId: 'req-fu-run' } } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'IN PROGRESS' }] } } }
  ]
  const host = createFakeHost({ durableEvents })
  await ownedLiveSession(host, 'running')
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })

  // The understanding gate was approved before this follow-up, so the immutable packet
  // still says `understandingRequired: true`; the RESTORED attempt must stay in
  // execution mode or the approved network tool would be denied by the gate.
  const packet = {
    understandingRequired: true,
    scope: { writeRoots: [], allowedTools: ['web_search'], allowNetwork: true }
  }
  const envelope = {
    id: 'task-fu-run',
    revision: packet.revision ?? 1,
    attemptId: 'attempt-followup-run',
    requestId: 'req-fu-run',
    origin: 'codex-bridge',
    ownerId: 'owner-1',
    packet: makePacket(packet),
    prompt: 'RUNNING FOLLOW-UP',
    effectiveModel: { ...FLASH },
    sessionId: 'session-1',
    continuationKind: 'followup'
  }

  const report = await adapter.inspect(envelope)
  assert.equal(report.known, true)
  assert.equal(report.recovered, true)
  assert.equal(report.recovery.enforcementRestored, true)
  assert.equal(report.attempts.length, 1)
  assert.equal(report.attempts[0].attemptId, 'attempt-followup-run')
  assert.equal(report.attempts[0].mode, 'execution', 'a recovered running follow-up keeps execution mode')
  assert.equal(report.status, 'unknown', 'an in-flight recovered follow-up is never declared settled')

  const network = host.runTool('session-1', 'web_search', {}, 'call-net')
  assert.equal(network.allowed, true, `the approved network tool must not be fenced as understanding: ${network.reason ?? ''}`)
})

// ---------------------------------------------------------------------------
// cross-layer: real BridgeService + TaskStore + real DshAdapter on the fake host
// ---------------------------------------------------------------------------

test('service and adapter agree end to end: follow-up in the same session, history readable, restart rebinds through the store entry', async () => {
  const { TaskStore } = await import('../src/store.mjs')
  const { BridgeService } = await import('../src/service.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-followup-e2e-'))
  // The fake host's durable inspect returns this array by reference; mirroring every
  // emitted session event into it stands in for the real host's persisted session log.
  const durableEvents = [{ type: 'model/selection', seq: 0, time: 0, data: { provider: FLASH.provider, model: FLASH.model } }]
  const host = createFakeHost({ initialStatus: 'idle', durableEvents })
  const emitSession = host.emitSession
  host.emitSession = (sessionId, event) => {
    durableEvents.push({ seq: durableEvents.length, time: durableEvents.length, ...event })
    return emitSession.call(host, sessionId, event)
  }
  const catalog = [{ provider: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }]
  // The service sees the REAL adapter; only the model catalog is stubbed.
  const wire = (real) => ({
    models: async () => catalog,
    start: (task, hooks) => real.start(task, hooks),
    followup: (task, hooks) => real.followup(task, hooks),
    cancel: (task) => real.cancel(task),
    inspect: (task) => real.inspect(task)
  })
  const until = async (predicate, label) => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const settle = async (service, id, text, turn) => {
    const task = service.store.get(id)
    claim(host, task.sessionId, task.requestId, turn)
    host.emitAssistant(task.sessionId, turn, text)
    host.emitTurnEnd(task.sessionId, turn, { kind: 'completed' })
    await until(() => service.store.get(id).status === 'completed', `${text} settles`)
  }
  let store = new TaskStore({ directory, ownerId: 'owner-e2e' })
  let service = new BridgeService({ store, adapter: wire(new DshAdapter(host.ctx, { ownerId: 'owner-e2e' })), maxConcurrent: 2 })
  try {
    const packet = makePacket({
      idempotencyKey: 'e2e-followup-1',
      scope: { writeRoots: [], allowedTools: ['read'] }
    })
    const submitted = await service.submit(packet, { submittedBy: 'codex', via: null })
    await until(() => typeof store.get(submitted.id).requestId === 'string', 'first dispatch receipt')
    await settle(service, submitted.id, 'round zero answer', 1)
    const first = store.get(submitted.id)

    const out = service.followup(submitted.id, { revision: 1, afterAttemptId: first.attemptId, followupId: 'e2e-f1', text: 'Why that answer?' })
    await until(() => typeof store.get(submitted.id).requestId === 'string' && store.get(submitted.id).status === 'running', 'follow-up dispatch')
    const running = store.get(submitted.id)
    assert.equal(running.sessionId, first.sessionId, 'the follow-up runs in the SAME session')
    assert.equal(host.calls.create.length, 1, 'no second session is created')
    const sent = host.calls.prompt.at(-1).content[0].text
    assert.match(sent, /Why that answer\?/, 'the service-built fenced prompt reaches the host')
    await settle(service, submitted.id, 'round one answer', 2)

    assert.equal(service.result(submitted.id).text, 'round one answer')
    const old = service.result(submitted.id, { attemptId: first.attemptId })
    assert.equal(old.text, 'round zero answer')
    assert.equal(old.round, 0)
    assert.equal(old.status, 'completed', 'a historical round reports its own status')
    const dossier = service.dossier(submitted.id)
    assert.deepEqual(dossier.rounds.map((r) => [r.round, r.attemptId]), [[0, first.attemptId], [1, out.followup.attemptId]])

    // Restart the bridge: a fresh adapter (no in-memory record) and a fresh service on
    // the same store. The live guarded agent is still registered in the host, so the
    // store-written followups[].boundAttempt must rebind the session.
    service.close()
    store.close()
    store = new TaskStore({ directory, ownerId: 'owner-e2e' })
    service = new BridgeService({ store, adapter: wire(new DshAdapter(host.ctx, { ownerId: 'owner-e2e' })), maxConcurrent: 2 })
    const second = store.get(submitted.id)
    service.followup(submitted.id, { revision: 1, afterAttemptId: second.attemptId, followupId: 'e2e-f2', text: 'And after a restart?' })
    await until(() => ['running', 'failed', 'unknown'].includes(store.get(submitted.id).status), 'post-restart follow-up dispatch')
    const after = store.get(submitted.id)
    assert.equal(after.status, 'running', `post-restart follow-up dispatched (error: ${after.error?.message ?? 'none'})`)
    assert.equal(after.sessionId, first.sessionId)
    assert.equal(host.calls.create.length, 1)

    // Same process, after the recovered dispatch: settle round two, then ask round three.
    // The recovered record must accept another follow-up without a second restart.
    await settle(service, submitted.id, 'round two answer', 3)
    const third = store.get(submitted.id)
    service.followup(submitted.id, { revision: 1, afterAttemptId: third.attemptId, followupId: 'e2e-f3', text: 'One more?' })
    await until(() => ['running', 'failed', 'unknown'].includes(store.get(submitted.id).status), 'third follow-up dispatch')
    const thirdRunning = store.get(submitted.id)
    assert.equal(thirdRunning.status, 'running', `third follow-up dispatched (error: ${thirdRunning.error?.message ?? 'none'})`)
    await settle(service, submitted.id, 'round three answer', 4)
    assert.deepEqual(service.dossier(submitted.id).rounds.map((r) => r.round), [0, 1, 2, 3])
    assert.equal(service.result(submitted.id, { attemptId: third.attemptId }).text, 'round two answer')
    assert.equal(service.result(submitted.id).text, 'round three answer')
    assert.equal(host.calls.create.length, 1)
  } finally {
    service.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
