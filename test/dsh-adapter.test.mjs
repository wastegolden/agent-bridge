/**
 * Bounded DSH adapter tests — bounded FAKE-HOST tests only.
 *
 * These tests never touch a real DSH host, never start a service, never send a
 * prompt to a model and never run a tool body. They drive a fake host that
 * implements the documented 0.1.5-rc.2 seams (sessionController, agent-scoped
 * tools registry, jobs, workspaceRegistry, session/event feed) so that the
 * adapter's enforcement, identity binding and reporting logic is exercised
 * deterministically. Filesystem cases use a real temporary directory, because
 * the path fence is a real `realpathSync.native` fence.
 *
 * Evidence class: MOCK + real local temp-filesystem assertions.
 * See evidence/adapter-worker.md.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  DshAdapter,
  DEFAULT_MODEL,
  DELEGATION_TOOLS,
  FORBIDDEN_TOOLS,
  canonicalTarget,
  classifyTool,
  extractMessageText,
  jsonSafe,
  mapTerminalStatus,
  normalizeTurnEndReason,
  toolPathClaims,
  validateTaskPacket
} from '../src/dsh-adapter.mjs'
import { BridgeSupervisor, sharedLedger } from '../src/supervisor.mjs'
import { CommandProfileRegistry, startCommandJob, stopCommandJob } from '../src/command-jobs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Existing directory used as the task cwd. */
const ROOT = HERE
/** Parent of the task cwd: outside the default read/write roots. */
const OUTSIDE = path.dirname(HERE)

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
// fake host
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
    selectModel: [],
    prompt: [],
    // Child prompts are DELIVERED through the child agent's own `followup` seam,
    // never through generic session routing, so they are recorded separately.
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
    // The child-creation composition seam (`applyChildComposition`) and the fixed
    // delegation-scope prompt contribution, both scoped to the CHILD.
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

  /**
   * The installed host's `session/agent-busy` ownership refusal for an
   * `origin: 'subagent'` session. Generic session routing (prompt, cancel,
   * queue mutation) must never be used for such an identity: the child's own agent
   * is the only delivery/stop seam.
   * @param {string} sessionId - target session.
   * @returns {Error|null} the refusal, or null when generic routing owns the session.
   */
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
      // The installed factory stores the creation-time `agentOptions` verbatim on the
      // live agent (`Agent.options`). That published value is the ONLY supported route
      // evidence for a subagent-owned child, so the double keeps it exactly as the real
      // host does; `createIgnoresAgentOptions`/`createChildRouteOverride` model a host
      // that drops or rewrites it.
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
      // The child agent's OWN delivery seam. The installed in-process subagent
      // driver drives a published child exactly this way, so the double uses the
      // same entry point and records every delivery per session.
      followup(message) {
        calls.followup.push({ sessionId, message: jsonSafe(message) })
        // A delivery seam that really throws. `contained(...)` used to swallow this and
        // report a successful drive for a child that was never started.
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
          // A child may expose no tools registry in its own scope at all: then no
          // enforcement seam exists and the child must be refused before any prompt.
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
              // Real host behaviour: the child's agent-plane tools (e.g. `read`) live
              // in the child's OWN scope layer, so `tools.restrict()` cannot name them
              // and the global/inherited plane is empty.
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
          // A child scope that exposes no monotonic guard: presentation may still be
          // maskable, but dispatch cannot be fenced, so the adapter must fail closed.
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
    async selectModel(request) {
      calls.selectModel.push(jsonSafe(request))
      // The installed host refuses generic routing for a subagent-owned identity here
      // too ("owned by subagent routing"), exactly like prompt/cancel: the child's own
      // creation-time route is the only supported evidence, and no message-match
      // tolerance may turn this refusal into a confirmed child route.
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
      // The installed host refuses generic prompt routing for a subagent-owned
      // session BEFORE it ever reaches the agent inbox.
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
        // The installed registry fences by the CALLER'S session id (a string).
        // The double accepts a legacy agent object too and normalizes both shapes.
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
          // The real `agents.create` records the child's coarse lineage on the
          // session header, which is exactly what makes generic session routing
          // refuse the identity later.
          origin: request.meta?.origin,
          delegationDepth: request.meta?.delegationDepth,
          // The real factory stores the caller's creation-time `agentOptions`
          // verbatim (`ReactLoopAgent.options`). A host that drops or rewrites them is
          // modelled explicitly so an unverifiable route can never pass.
          hostAgentOptions:
            options.createIgnoresAgentOptions === true
              ? {}
              : { ...(request.agentOptions ?? {}), ...(options.createChildRouteOverride ?? {}) },
          // A host that emits the child's complete turn from inside its own
          // `followup` delivery: identity tracking and budgets are installed
          // BEFORE the drive call, so those events must still be attributed.
          onFollowup:
            options.earlyChildTurnOnFollowup === true
              ? (childAgent, message) => {
                  const turn = 1
                  api.emitTurnStart(request.sessionId, turn)
                  api.emitSession(request.sessionId, {
                    type: 'user/message',
                    data: { id: `msg-early-${request.sessionId}`, turn, source: message.source }
                  })
                  api.emitAssistant(request.sessionId, turn, 'early child evidence')
                  api.emitTurnEnd(request.sessionId, turn, { kind: 'completed' })
                }
              : undefined
        })
        // Compose the unpublished child scope, exactly like the real factory:
        // setup runs BEFORE the agent is inserted and announced.
        const parentCtx = request.parentAgent !== undefined && request.parentAgent !== null ? request.parentAgent.ctx : undefined
        // The child's own scoped creation context. `agentPresets` and `systemPrompt`
        // model the installed agent plane the official driver joins with
        // `applyChildComposition` (`childCtx.get('agentPresets').composeFrom(childCtx,
        // parent.ctx)`); a deployment without the join exposes no agent-plane tool.
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
                    // The join must be registered through the CHILD's own context, never
                    // the parent's, and must name the real delegating parent.
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
    /**
     * Prompts really delivered to ONE child session through the child agent's own
     * `followup` seam, in delivery order. Generic session routing never carries a
     * child prompt, so `host.calls.prompt` must stay empty of child session ids.
     */
    childMessages(sessionId) {
      return calls.followup
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => ({
          requestId: entry.message?.source?.rpcId,
          content: entry.message?.content ?? [],
          text: entry.message?.content?.[0]?.text ?? ''
        }))
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
    emitSubagentStart(sessionId, name) {
      dispatch('subagent/start', name, { childSessionId: 'child-1' }, agents.get(sessionId))
    },
    deleteAgent(sessionId) {
      agents.delete(sessionId)
    },
    inboxOf(sessionId) {
      return agents.get(sessionId).inbox
    },
    /**
     * Simulate one registry-mediated tool dispatch through the pipeline the
     * adapter hooks: monotonic guard first, then the ordered pre-execute waterfall.
     */
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

/** Bounded poll used only where a timer-driven path must be observed. */
async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

const BASE_PACKET = {
  schemaVersion: 1,
  idempotencyKey: 'key-1',
  revision: 1,
  projectId: 'proj-1',
  title: 'bounded task',
  objective: 'do the bounded thing',
  cwd: ROOT,
  role: 'implement',
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

/**
 * Build a task packet with shallow scope overrides.
 * @param {object} [overrides] - packet/scope overrides.
 * @returns {object} packet.
 */
function makePacket(overrides = {}) {
  const { scope, ...rest } = overrides
  return { ...BASE_PACKET, ...rest, scope: { ...BASE_PACKET.scope, ...(scope ?? {}) } }
}

/**
 * Build the root's task envelope (`src/service.mjs` passes `{...task, packet}`).
 * @param {object} [overrides] - envelope/packet overrides.
 * @returns {object} envelope.
 */
function makeEnvelope(overrides = {}) {
  const packet = makePacket(overrides.packet)
  return {
    id: overrides.id ?? 'task-uuid-1',
    revision: overrides.revision ?? packet.revision,
    attemptId: overrides.attemptId ?? 'attempt-uuid-1',
    packet,
    prompt: overrides.prompt ?? 'ROOT BUILD PROMPT: do the bounded thing',
    effectiveModel: overrides.effectiveModel ?? { provider: 'deepseek-official', model: 'deepseek-flash' },
    ...(overrides.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
    ...(overrides.understanding === undefined ? {} : { understanding: overrides.understanding }),
    ...(overrides.status === undefined ? {} : { status: overrides.status })
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('jsonSafe detaches host values into JSON-only snapshots', () => {
  const circular = { a: 1 }
  circular.self = circular
  const safe = jsonSafe({ big: 1n, nan: Number.NaN, fn: () => {}, circular, date: new Date(0), nested: [1, undefined, 2] })
  assert.equal(safe.big, '1')
  assert.equal(safe.nan, null)
  assert.equal('fn' in safe, false)
  assert.equal(safe.circular.self, '[circular]')
  assert.equal(safe.date, 0)
  assert.deepEqual(safe.nested, [1, null, 2])
  assert.equal(JSON.parse(JSON.stringify(safe)).circular.a, 1)
})

test('extractMessageText joins text blocks only', () => {
  assert.equal(extractMessageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(extractMessageText({ content: 'nope' }), '')
  assert.equal(extractMessageText(undefined), '')
})

test('normalizeTurnEndReason surfaces unknown kinds instead of dropping them', () => {
  assert.deepEqual(normalizeTurnEndReason({ kind: 'completed' }), { kind: 'completed', detail: null })
  assert.deepEqual(normalizeTurnEndReason({ kind: 'aborted', reason: { kind: 'user' } }), { kind: 'aborted', detail: 'user' })
  assert.deepEqual(normalizeTurnEndReason({ kind: 'aborted' }), { kind: 'aborted', detail: 'legacy' })
  assert.deepEqual(normalizeTurnEndReason({ kind: 'error', error: { code: 'UNKNOWN' } }), { kind: 'error', detail: 'UNKNOWN' })
  assert.deepEqual(normalizeTurnEndReason({ kind: 'plugin-added-kind' }), { kind: 'plugin-added-kind', detail: null })
  assert.deepEqual(normalizeTurnEndReason(undefined), { kind: 'unknown', detail: null })
})

test('mapTerminalStatus maps onto the root terminal vocabulary', () => {
  assert.equal(mapTerminalStatus('completed'), 'completed')
  assert.equal(mapTerminalStatus('aborted'), 'cancelled')
  assert.equal(mapTerminalStatus('interrupted'), 'failed')
  assert.equal(mapTerminalStatus('blocked'), 'failed')
  assert.equal(mapTerminalStatus('error'), 'failed')
  assert.equal(mapTerminalStatus('max-tokens'), 'failed')
  assert.equal(mapTerminalStatus('anything-else'), 'failed')
})

test('toolPathClaims reads the installed model-facing argument names', () => {
  assert.deepEqual(toolPathClaims('read', { file_path: 'a.txt' }), [{ path: 'a.txt', mode: 'read' }])
  assert.deepEqual(toolPathClaims('grep', { pattern: 'x', path: 'src', paths: [{ path: 'b' }] }), [
    { path: 'src', mode: 'read' },
    { path: 'b', mode: 'read' }
  ])
  assert.deepEqual(toolPathClaims('write', { file_path: 'out.txt' }), [{ path: 'out.txt', mode: 'write' }])
  assert.deepEqual(toolPathClaims('edit', { file_path: 'x', old_string: 'a' }), [{ path: 'x', mode: 'write' }])
  assert.deepEqual(toolPathClaims('todo_write', { todos: [] }), [])
  assert.deepEqual(toolPathClaims('read', undefined), [])
})

test('classifyTool is deny-by-default for unknown tools', () => {
  assert.equal(classifyTool('read'), 'fs')
  assert.equal(classifyTool('pwsh'), 'shell')
  assert.equal(classifyTool('web_fetch'), 'network')
  assert.equal(classifyTool('subagent_fork'), 'delegation')
  assert.equal(classifyTool('todo_write'), 'other')
  assert.equal(classifyTool('job_output'), 'owned-jobs')
  assert.equal(classifyTool('job_list'), 'forbidden')
  assert.equal(classifyTool('skill'), 'forbidden')
  assert.equal(classifyTool('create_goal'), 'forbidden')
  assert.equal(classifyTool('some_new_plugin_tool'), 'unclassified')
  assert.equal(classifyTool('some_new_plugin_tool', new Map([['some_new_plugin_tool', 'other']])), 'other')
})

test('canonicalTarget resolves real paths and rejects unresolvable ones', () => {
  const resolved = canonicalTarget(ROOT, ROOT)
  assert.equal(resolved.ok, true)
  const missing = canonicalTarget(path.join(ROOT, 'definitely-missing-dir', 'file.txt'), ROOT)
  assert.equal(missing.ok, true)
  assert.equal(missing.path, path.join(resolved.path, 'definitely-missing-dir', 'file.txt'))
  assert.equal(canonicalTarget('', ROOT).ok, false)
  assert.equal(canonicalTarget('   ', ROOT).code, 'EMPTY_PATH')
})

// ---------------------------------------------------------------------------
// packet validation and envelope resolution
// ---------------------------------------------------------------------------

test('validateTaskPacket rejects malformed and over-reaching packets', () => {
  assert.throws(() => validateTaskPacket({}), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ schemaVersion: 2 })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ idempotencyKey: '   ' })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ revision: 0 })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ role: 'admin' })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ cwd: 'relative/dir' })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ acceptance: [] })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ scope: { allowDelegation: true } })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ scope: { allowShell: 'yes' } })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ materials: 'nope' })), { code: 'adapter/invalid-packet' })
  assert.throws(() => validateTaskPacket(makePacket({ contractVersion: '' })), { code: 'adapter/invalid-packet' })
})

test('validateTaskPacket keeps an explicit id and otherwise derives one', () => {
  assert.equal(validateTaskPacket(makePacket({ id: 'task-7' })).id, 'task-7')
  assert.equal(validateTaskPacket(makePacket()).id, 'key-1')
  const packet = validateTaskPacket(makePacket())
  packet.scope.allowedTools.push('mutated')
  assert.equal(makePacket().scope.allowedTools.includes('mutated'), false)
})

test('DshAdapter is constructed with new and validates host and options', () => {
  assert.throws(() => new DshAdapter(null), { code: 'adapter/invalid-host' })
  assert.throws(() => new DshAdapter({}), { code: 'adapter/invalid-host' })
  assert.throws(() => new DshAdapter({ get: () => undefined }, { defaultModel: 'flash' }), { code: 'adapter/invalid-options' })
  const adapter = new DshAdapter(createFakeHost().ctx)
  assert.equal(typeof adapter.start, 'function')
  assert.equal(typeof adapter.continue, 'function')
  assert.equal(typeof adapter.cancel, 'function')
  assert.equal(typeof adapter.inspect, 'function')
  assert.equal(typeof adapter.cleanup, 'function')
  assert.equal(typeof adapter.models, 'function')
  assert.equal(typeof adapter.capabilities, 'function')
})

test('contractVersion mismatch fails closed before any host work', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx, { contractVersion: 'v2' })
  await assert.rejects(adapter.start(makeEnvelope()), { code: 'adapter/contract-version' })
  assert.equal(host.calls.create.length, 0)
})

// ---------------------------------------------------------------------------
// capabilities / models
// ---------------------------------------------------------------------------

test('capabilities reports real seams and refuses to claim unsupported ones', async () => {
  const adapter = new DshAdapter(createFakeHost().ctx)
  const caps = await adapter.capabilities()
  assert.equal(caps.adapterVersion, '0.5.0')
  assert.equal(caps.interface.constructor, 'new DshAdapter(ctx, options)')
  assert.equal(caps.interface.envelopeIdentityBound, true)
  assert.deepEqual(caps.interface.resultShape, ['status', 'text', 'stopConfirmed', 'activeJobs', 'evidence', 'checks', 'uncertainties'])
  assert.equal(caps.host.tools, true)
  assert.equal(caps.host.fsSandboxMode, 'workspace-write')
  assert.equal(caps.enforcement.failClosed, true)
  assert.equal(caps.enforcement.toolAllowlist.supported, true)
  assert.ok(caps.enforcement.toolAllowlist.mechanisms.some((entry) => entry.includes('tools.guard')))
  assert.match(caps.enforcement.pathFence.mechanism, /realpathSync\.native/)
  assert.ok(caps.enforcement.pathFence.rejects.includes('Windows junction/reparse escapes'))
  assert.deepEqual(caps.enforcement.forbiddenTools.tools.sort(), Object.keys(FORBIDDEN_TOOLS).sort())
  assert.deepEqual(caps.enforcement.ownedJobTools.tools.sort(), ['job_kill', 'job_output'])
  assert.equal(caps.enforcement.shell.supported, false)
  assert.match(caps.enforcement.shell.reason, /Network and process visibility are outside this vocabulary/)
  assert.equal(caps.enforcement.budgets.maxToolCalls.enforced, 'hard')
  assert.equal(caps.enforcement.budgets.maxOutputChars.enforced, 'advisory')
  assert.equal(caps.cancellation.hostCancelIsNotConfirmation, true)
  assert.equal(caps.persistence.delete, false)
  assert.match(caps.persistence.deleteReason, /no durable session deletion API/)
  assert.equal(caps.persistence.uiHideIsDurable, true)
  assert.equal(caps.persistence.unarchive, false)
  assert.match(caps.persistence.uiHideScope, /owned, settled task/)
  assert.match(caps.events.toolStartCounter, /exactly once per admitted dispatch/)
  assert.deepEqual(caps.orphanSessions, [])
})

test('capabilities degrades honestly on a minimal host', async () => {
  const host = createFakeHost({ noTools: true, noWorkspaceRegistry: true, noJobs: true, noFs: true })
  const caps = await new DshAdapter(host.ctx).capabilities()
  assert.equal(caps.host.tools, false)
  assert.equal(caps.enforcement.toolAllowlist.supported, false)
  assert.equal(caps.enforcement.pathFence.osWriteFence, null)
  assert.equal(caps.persistence.uiHide, null)
  assert.equal(caps.cancellation.jobKill, false)
  assert.equal(caps.persistence.delete, false)
})

test('models returns the array catalog shape the root feeds to resolveModel', async () => {
  const host = createFakeHost({
    llm: {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'broken', name: 'Broken' }
      ],
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('provider unreachable')
        return [
          { id: 'deepseek-flash', name: 'Flash' },
          { id: 'deepseek-v4-astra', name: 'Astra', description: 'high effort' }
        ]
      },
      resolveModelInfo: async (provider, model) =>
        model === 'deepseek-v4-astra' ? { reasoning: { efforts: [{ id: 'high' }, { id: 'xhigh' }], defaultEffort: 'high' } } : {}
    }
  })
  const models = await new DshAdapter(host.ctx).models()
  assert.equal(Array.isArray(models), true)
  assert.equal(models.length, 2)
  assert.equal(models[0].provider, 'deepseek-official')
  assert.deepEqual(models[0].models[1].reasoningEfforts, ['high', 'xhigh'])
  assert.equal(models[0].models[1].defaultReasoningEffort, 'high')
  assert.deepEqual(models[1].models, [])
  assert.match(models[1].error, /contributes no catalog entries/)
  // The root's resolveModel accepts exactly this field layout.
  for (const row of models) {
    assert.equal(typeof row.provider, 'string')
    assert.equal(Array.isArray(row.models), true)
    for (const model of row.models) assert.equal(typeof model.id, 'string')
  }
})

test('models reports an unavailable llm service instead of an empty catalog', async () => {
  await assert.rejects(new DshAdapter(createFakeHost({ noLlm: true }).ctx).models(), { code: 'adapter/host-unavailable' })
})

// ---------------------------------------------------------------------------
// envelope identity binding
// ---------------------------------------------------------------------------

test('start binds the envelope id, attemptId and prompt and returns the contract receipt', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const envelope = makeEnvelope({
    id: 'task-uuid-42',
    attemptId: 'attempt-uuid-99',
    prompt: 'ROOT PROMPT VERBATIM',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-v4-astra', reasoningEffort: 'xhigh' }
  })
  const res = await adapter.start(envelope)
  assert.equal(res.sessionId, 'session-1')
  assert.match(res.requestId, /^dsa-/)
  assert.equal(res.taskId, 'task-uuid-42')
  assert.equal(res.attemptId, 'attempt-uuid-99')
  assert.equal(res.revision, 1)
  assert.deepEqual(res.effectiveModel, { provider: 'deepseek-official', model: 'deepseek-v4-astra', reasoningEffort: 'xhigh' })
  assert.deepEqual(host.calls.selectModel[0], {
    sessionId: 'session-1',
    provider: 'deepseek-official',
    model: 'deepseek-v4-astra',
    reasoningEffort: 'xhigh'
  })
  assert.equal(host.calls.prompt[0].content[0].text, 'ROOT PROMPT VERBATIM')
  assert.equal(res.effectivePolicy.enforcement.mechanisms.includes('guard'), true)
  assert.equal(typeof JSON.stringify(res.effectivePolicy), 'string')
})

test('the start receipt never replaces immutable store identity', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const envelope = makeEnvelope({ id: 'task-uuid-5', revision: 3, attemptId: 'attempt-uuid-5', packet: { revision: 3 } })
  const res = await adapter.start(envelope)
  // `store.update` rejects any change to these keys; the receipt must echo the envelope.
  assert.equal(res.revision, envelope.revision)
  assert.equal(res.attemptId, envelope.attemptId)
  assert.equal(res.taskId, envelope.id)
})

test('events carry the bound envelope identity, and tool/start is counted exactly once', async () => {
  const host = createFakeHost()
  const events = []
  const adapter = new DshAdapter(host.ctx)
  const envelope = makeEnvelope({ id: 'task-uuid-7', attemptId: 'attempt-uuid-7' })
  const res = await adapter.start(envelope, { onEvent: (event) => events.push(event) })
  claim(host, res.sessionId, res.requestId, 1)

  const toolResult = host.runTool(res.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-77')
  assert.equal(toolResult.allowed, true)
  host.emitToolCall(res.sessionId, 1, 'read', 'call-77')
  host.emitToolResult(res.sessionId, 1)
  host.emitAssistant(res.sessionId, 1, 'hello')
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })

  for (const event of events) {
    assert.equal(typeof event.type, 'string')
    assert.equal(typeof event.timestamp, 'number')
    assert.equal(event.taskId, 'task-uuid-7')
    assert.equal(event.revision, 1)
    assert.equal(event.attemptId, 'attempt-uuid-7')
    assert.equal(JSON.parse(JSON.stringify(event)).type, event.type)
  }
  const starts = events.filter((event) => event.type === 'tool/start')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].callId, 'call-77')
  assert.equal(starts[0].source, 'guard')
  assert.ok(events.some((event) => event.type === 'tool/end'))
  assert.ok(events.some((event) => event.type === 'attempt/claimed'))
  assert.equal(events.filter((event) => event.type === 'assistant/message').length, 1)
})

test('a durable tool/call the guard never saw is announced once', async () => {
  const host = createFakeHost()
  const events = []
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope(), { onEvent: (event) => events.push(event) })
  claim(host, res.sessionId, res.requestId, 1)
  host.emitToolCall(res.sessionId, 1, 'read', 'call-durable-only')
  assert.equal(events.filter((event) => event.type === 'tool/start').length, 1)
  assert.equal(events.find((event) => event.type === 'tool/start').source, 'durable-event')
})

// ---------------------------------------------------------------------------
// turn isolation (regression)
// ---------------------------------------------------------------------------

test('a foreign live turn never becomes the task reply and is preserved separately', async () => {
  const host = createFakeHost()
  const events = []
  const results = []
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope(), {
    onResult: (result) => results.push(result),
    onEvent: (event) => events.push(event)
  })
  claim(host, res.sessionId, res.requestId, 1)
  host.emitAssistant(res.sessionId, 1, 'OUR TEXT')
  // A second, foreign turn on the same session: it must be observed but never
  // claimed as this attempt's reply.
  host.emitTurnStart(res.sessionId, 2)
  host.emitAssistant(res.sessionId, 2, 'FOREIGN TEXT')
  host.emitTurnEnd(res.sessionId, 2, { kind: 'completed' })
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })

  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'completed')
  assert.equal(results[0].text, 'OUR TEXT')
  assert.equal(results[0].finalText, 'OUR TEXT')
  assert.equal(results[0].text.includes('FOREIGN TEXT'), false)

  const foreignEvent = events.find((event) => event.text === 'FOREIGN TEXT')
  assert.ok(foreignEvent, 'the foreign observation must still be emitted')
  assert.equal(foreignEvent.unbound, true)
  assert.equal(foreignEvent.attemptId, undefined)
  assert.ok(events.some((event) => event.text === 'OUR TEXT' && event.unbound !== true))

  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.text, 'OUR TEXT')
  assert.equal(inspected.text.includes('FOREIGN TEXT'), false)
  assert.deepEqual(inspected.unboundAssistantMessages.map((entry) => entry.text), ['FOREIGN TEXT'])
})

test('successive turns bind by the explicit claim turn before its own turn/start', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const first = await adapter.start(makeEnvelope())
  claim(host, first.sessionId, first.requestId, 1)
  host.emitAssistant(first.sessionId, 1, 'turn one')
  host.emitTurnEnd(first.sessionId, 1, { kind: 'completed' })

  const second = await adapter.continue(makeEnvelope({ attemptId: 'attempt-two', sessionId: first.sessionId }), {})
  // The host claims turn 2 BEFORE announcing turn/start: the explicit claim turn
  // must be used, never the opener of the turn that already ended.
  host.emitUserMessage(second.sessionId, second.requestId, 2)
  host.emitAssistant(second.sessionId, 2, 'turn two')
  host.emitTurnEnd(second.sessionId, 2, { kind: 'completed' })

  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.attempts.length, 2)
  assert.equal(inspected.attempts[0].boundTurn, 1)
  assert.equal(inspected.attempts[0].rootStatus, 'completed')
  assert.equal(inspected.attempts[1].boundTurn, 2)
  assert.equal(inspected.attempts[1].rootStatus, 'completed')
  assert.equal(inspected.attempts[1].textLength, 'turn two'.length)
  assert.equal(inspected.text, 'turn two')
})

test('a claim without an explicit turn does not reuse the turn that already ended', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const first = await adapter.start(makeEnvelope())
  claim(host, first.sessionId, first.requestId, 1)
  host.emitTurnEnd(first.sessionId, 1, { kind: 'completed' })

  const second = await adapter.continue(makeEnvelope({ attemptId: 'attempt-three', sessionId: first.sessionId }), {})
  // No turn/start and no explicit turn: turn 1 ended, so nothing may be bound.
  host.emitUserMessage(second.sessionId, second.requestId, undefined)
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.attempts[1].claimed, true)
  assert.equal(inspected.attempts[1].boundTurn, null)
})

test('an empty last assistant message is the live handoff while progress stays in the attempt', async () => {
  const host = createFakeHost()
  const events = []
  const results = []
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope(), {
    onResult: (result) => results.push(result),
    onEvent: (event) => events.push(event)
  })
  claim(host, res.sessionId, res.requestId, 1)
  host.emitAssistant(res.sessionId, 1, 'progress line')
  host.emitAssistant(res.sessionId, 1, '')
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })

  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'completed')
  assert.equal(results[0].text, 'progress line')
  assert.equal(results[0].finalText, '')
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.attempts[0].textLength, 'progress line'.length)
  assert.equal(inspected.finalText, '')
  assert.deepEqual(
    events.filter((event) => event.type === 'assistant/message').map((event) => event.text),
    ['progress line', '']
  )
})

test('a foreign-only durable transcript never becomes the task text', async () => {
  const durableEvents = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 7 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'FOREIGN DURABLE' }] } }
    },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 7, reason: { kind: 'completed' } } }
  ]
  const host = createFakeHost({ durableEvents })
  const adapter = new DshAdapter(host.ctx)
  await adapter.start(makeEnvelope())
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.durable.available, true)
  assert.equal(inspected.durable.text, 'FOREIGN DURABLE')
  assert.equal(inspected.durable.bound.claimed, false)
  assert.equal(inspected.durable.lastStopReason, 'completed')
  assert.equal(inspected.text, '')
  assert.equal(inspected.finalText, undefined)
  assert.deepEqual(inspected.unboundAssistantMessages, [])
})

test('start replays identically for the same identity and rejects a changed packet', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const first = await adapter.start(makeEnvelope())
  const replay = await adapter.start(makeEnvelope())
  assert.equal(replay.idempotentReplay, true)
  assert.equal(replay.sessionId, first.sessionId)
  assert.equal(replay.requestId, first.requestId)
  assert.equal(host.calls.create.length, 1)
  assert.equal(host.calls.prompt.length, 1)

  await assert.rejects(adapter.start(makeEnvelope({ attemptId: 'attempt-2', packet: { idempotencyKey: 'other' } })), {
    code: 'adapter/duplicate-task'
  })
  await assert.rejects(adapter.start(makeEnvelope({ revision: 2, packet: { revision: 2 } })), { code: 'adapter/duplicate-task' })
})

test('the bare TaskPacket form still works without the root service', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makePacket({ understandingRequired: true, budget: { timeoutMs: 600000 } }))
  assert.equal(res.taskId, 'key-1')
  assert.equal(res.attemptId, 'key-1@1#0')
  assert.equal(res.mode, 'understanding')
  assert.match(host.calls.prompt[0].content[0].text, /Do NOT execute changes yet/)
})

// ---------------------------------------------------------------------------
// fail-closed scope planning
// ---------------------------------------------------------------------------

test('start rejects allowShell before creating a session', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  await assert.rejects(adapter.start(makeEnvelope({ packet: { scope: { allowShell: true } } })), {
    code: 'adapter/shell-unsupported'
  })
  assert.equal(host.calls.create.length, 0)
})

test('start rejects write roots outside the session sandbox root', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  await assert.rejects(adapter.start(makeEnvelope({ packet: { scope: { writeRoots: [OUTSIDE] } } })), {
    code: 'adapter/scope-unsupported'
  })
  assert.equal(host.calls.create.length, 0)
})

test('start rejects unresolvable model routes instead of falling back', async () => {
  const host = createFakeHost({ rejectModel: true })
  const adapter = new DshAdapter(host.ctx)
  await assert.rejects(adapter.start(makeEnvelope()), { code: 'adapter/model-route-rejected' })
  assert.equal(adapter.orphans().length, 1)
})

test('start rejects unbounded tools, delegation, shell and network allowlist entries', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  for (const tool of ['brand_new_tool', 'subagent', 'pwsh', 'web_fetch', 'run_code', 'skill', 'job_list', 'create_goal', 'update_goal']) {
    await assert.rejects(
      adapter.start(makeEnvelope({ packet: { scope: { allowedTools: [tool] } } })),
      { code: 'adapter/scope-unsupported' },
      `expected "${tool}" to be rejected`
    )
  }
  assert.equal(host.calls.create.length, 0)
})

test('start rejects unclassified tools unless the coordinator classifies them', async () => {
  const host = createFakeHost({ availableTools: [...ALL_TOOLS, 'brand_new_tool'] })
  const adapter = new DshAdapter(host.ctx)
  await assert.rejects(adapter.start(makeEnvelope({ packet: { scope: { allowedTools: ['brand_new_tool'] } } })), {
    code: 'adapter/scope-unsupported'
  })
  const permissive = new DshAdapter(host.ctx, { toolClassifications: { brand_new_tool: 'other' } })
  const res = await permissive.start(makeEnvelope({ packet: { scope: { allowedTools: ['brand_new_tool'] } } }))
  assert.equal(host.runTool(res.sessionId, 'brand_new_tool', {}).allowed, true)
})

test('classification overrides cannot re-enable an unbounded tool at plan time', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx, {
    toolClassifications: { skill: 'other', job_list: 'other', create_goal: 'other' }
  })
  for (const tool of ['skill', 'job_list', 'create_goal']) {
    await assert.rejects(
      adapter.start(makeEnvelope({ packet: { scope: { allowedTools: ['read', tool] } } })),
      { code: 'adapter/scope-unsupported' },
      `expected the overridden classification for "${tool}" to stay rejected`
    )
  }
  assert.equal(host.calls.create.length, 0)
  // The reason names the concrete unbounded capability, not a generic refusal.
  await assert.rejects(adapter.start(makeEnvelope({ packet: { scope: { allowedTools: ['skill'] } } })), (error) => {
    assert.match(error.message, /SKILL\.md|skill roots/)
    return true
  })
})

test('the forbidden-tool escape hatch is explicit, reported and denies nothing silently', async () => {
  const host = createFakeHost()
  const strict = new DshAdapter(host.ctx)
  const strictCaps = await strict.capabilities()
  assert.equal(strictCaps.enforcement.forbiddenTools.overrideEnabled, false)

  const relaxed = new DshAdapter(host.ctx, { allowForbiddenTools: true })
  const relaxedCaps = await relaxed.capabilities()
  assert.equal(relaxedCaps.enforcement.forbiddenTools.overrideEnabled, true)
  // With the coordinator hatch open the tool is allowed through the guard, which is
  // exactly why the hatch is coordinator-only and reported in capabilities.
  const res = await relaxed.start(makeEnvelope({ packet: { scope: { allowedTools: ['skill'] } } }))
  assert.equal(host.runTool(res.sessionId, 'skill', { name: 'x' }).allowed, true)
})

test('start does not create a session when the tools registry is missing or host-only', async () => {
  const noTools = createFakeHost({ noTools: true })
  await assert.rejects(new DshAdapter(noTools.ctx).start(makeEnvelope()), { code: 'adapter/enforcement-unavailable' })
  assert.equal(noTools.calls.create.length, 0)

  const hostOnly = createFakeHost({ scopedToolsUnavailable: true })
  const adapter = new DshAdapter(hostOnly.ctx)
  await assert.rejects(adapter.start(makeEnvelope()), { code: 'adapter/enforcement-unavailable' })
  // A host-context guard would mask every agent: the adapter must never register one.
  assert.deepEqual(hostOnly.calls.globalToolCalls, [])
  assert.equal(adapter.orphans().length, 1)
  assert.equal(adapter.orphans()[0].sessionId, 'session-1')
})

test('start rejects a non-existent cwd without touching the host', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  await assert.rejects(adapter.start(makeEnvelope({ packet: { cwd: path.join(ROOT, 'does-not-exist-xyz') } })), {
    code: 'adapter/invalid-packet'
  })
  assert.equal(host.calls.create.length, 0)
})

// ---------------------------------------------------------------------------
// tool enforcement
// ---------------------------------------------------------------------------

test('start installs agent-scoped enforcement and never a host-scoped guard', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())
  assert.deepEqual(host.calls.globalToolCalls, [])
  assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === res.sessionId).length, 1)
  assert.equal(host.calls.restrictions.length, 1)
  assert.deepEqual(host.calls.restrictions[0].filter.allow.slice().sort(), ['edit', 'read', 'todo_write', 'write'])
  for (const name of ['subagent', 'send_message', 'ralph', 'pwsh', 'bash', 'web_fetch', 'skill', 'job_list']) {
    assert.equal(host.calls.restrictions[0].filter.allow.includes(name), false, `expected exclusion for ${name}`)
  }
  assert.equal(res.effectivePolicy.enforcement.recursiveDelegation, 'denied (tool allowlist + guard)')
})

test('the guard denies tools outside the allowlist, delegation, network and escalation', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())
  const { sessionId } = res

  assert.equal(host.runTool(sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }).allowed, true)
  assert.equal(host.runTool(sessionId, 'todo_write', { todos: [] }).allowed, true)

  const notAllowed = host.runTool(sessionId, 'bash', { command: 'whoami' })
  assert.equal(notAllowed.allowed, false)
  assert.match(notAllowed.reason, /not in this task's allowedTools/)

  const delegation = host.runTool(sessionId, 'subagent', { description: 'spin up a child' })
  assert.equal(delegation.allowed, false)

  const escalation = host.runTool(sessionId, 'write', {
    file_path: path.join(ROOT, 'a.txt'),
    sandbox_permissions: 'danger-full-access',
    justification: 'because'
  })
  assert.equal(escalation.allowed, false)
  assert.match(escalation.reason, /escalation is denied/)

  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.enforcement.toolViolations.length, 3)
  assert.ok(inspected.enforcement.toolViolations.some((entry) => entry.tool === 'subagent'))
})

test('guard is defence in depth for shell and network classification overrides', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx, { toolClassifications: { pwsh: 'other', web_fetch: 'other' } })
  const res = await adapter.start(
    makeEnvelope({ packet: { scope: { allowedTools: ['read', 'pwsh', 'web_fetch'], allowNetwork: false } } })
  )
  const shell = host.runTool(res.sessionId, 'pwsh', { command: 'echo hi' })
  assert.equal(shell.allowed, false)
  assert.match(shell.reason, /cannot bound an arbitrary shell/)

  const network = host.runTool(res.sessionId, 'web_fetch', { url: 'https://example.invalid' })
  assert.equal(network.allowed, false)
  assert.match(network.reason, /scope.allowNetwork is false/)
})

test('the path fence rejects lexical escapes and resolves canonical targets', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ packet: { scope: { allowedTools: ['read', 'write', 'edit', 'glob', 'grep', 'todo_write'] } } }))
  const { sessionId } = res

  assert.equal(host.runTool(sessionId, 'read', { file_path: path.join(ROOT, 'inside.txt') }).allowed, true)
  assert.equal(host.runTool(sessionId, 'read', { file_path: 'inside-relative.txt' }).allowed, true)
  assert.equal(host.runTool(sessionId, 'glob', { pattern: '*.mjs', path: ROOT }).allowed, true)
  assert.equal(host.runTool(sessionId, 'read', { file_path: path.join(ROOT, 'new-dir', 'new-file.txt') }).allowed, true)

  const outsideRead = host.runTool(sessionId, 'read', { file_path: path.join(OUTSIDE, 'outside.txt') })
  assert.equal(outsideRead.allowed, false)
  assert.match(outsideRead.reason, /readRoots/)

  const escapeRead = host.runTool(sessionId, 'read', { file_path: path.join(ROOT, '..', 'escape.txt') })
  assert.equal(escapeRead.allowed, false)

  assert.equal(host.runTool(sessionId, 'write', { file_path: path.join(ROOT, 'out.txt') }).allowed, true)
  const outsideWrite = host.runTool(sessionId, 'write', { file_path: path.join(OUTSIDE, 'out.txt') })
  assert.equal(outsideWrite.allowed, false)
  assert.match(outsideWrite.reason, /writeRoots/)

  const grepOutside = host.runTool(sessionId, 'grep', { pattern: 'x', paths: [{ path: OUTSIDE }] })
  assert.equal(grepOutside.allowed, false)
})

test('path-less glob/grep are fenced against the session cwd', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const nested = path.join(ROOT, 'test')
  const res = await adapter.start(
    makeEnvelope({ packet: { scope: { readRoots: [nested], writeRoots: [], allowedTools: ['glob', 'grep'] } } })
  )
  const defined = host.runTool(res.sessionId, 'glob', { pattern: '*.mjs', path: nested })
  assert.equal(defined.allowed, true)
  const implicit = host.runTool(res.sessionId, 'grep', { pattern: 'secret' })
  assert.equal(implicit.allowed, false)
  assert.match(implicit.reason, /reads the session cwd/)
})

test('a symlink escape is rejected by the canonical fence', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adapter-link-'))
  const inside = path.join(base, 'inside')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(inside)
  fs.mkdirSync(outside)
  const link = path.join(inside, 'escape')
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fs.rmSync(base, { recursive: true, force: true })
    t.skip(`directory link creation unavailable in this environment: ${error.code}`)
    return
  }
  try {
    const host = createFakeHost()
    const adapter = new DshAdapter(host.ctx)
    const res = await adapter.start(
      makeEnvelope({
        packet: {
          cwd: inside,
          scope: { readRoots: [inside], writeRoots: [inside], allowedTools: ['read', 'write', 'glob'] }
        }
      })
    )
    const writeThroughLink = host.runTool(res.sessionId, 'write', { file_path: path.join(link, 'pwn.txt') })
    assert.equal(writeThroughLink.allowed, false)
    assert.match(writeThroughLink.reason, /outside this task's writeRoots/)

    const readThroughLink = host.runTool(res.sessionId, 'read', { file_path: path.join(link, 'hosts') })
    assert.equal(readThroughLink.allowed, false)
    assert.match(readThroughLink.reason, /readRoots/)

    // A real target inside the declared root is still allowed.
    assert.equal(host.runTool(res.sessionId, 'write', { file_path: path.join(inside, 'ok.txt') }).allowed, true)
    assert.equal(host.runTool(res.sessionId, 'write', { file_path: path.join(inside, 'new-sub', 'ok.txt') }).allowed, true)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('a dangling link is denied instead of resolved past the fence', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adapter-dangling-'))
  const inside = path.join(base, 'inside')
  fs.mkdirSync(inside)
  const link = path.join(inside, 'dangling')
  try {
    fs.symlinkSync(path.join(base, 'missing-target'), link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fs.rmSync(base, { recursive: true, force: true })
    t.skip(`dangling link creation unavailable in this environment: ${error.code}`)
    return
  }
  try {
    const host = createFakeHost()
    const adapter = new DshAdapter(host.ctx)
    const res = await adapter.start(
      makeEnvelope({
        packet: { cwd: inside, scope: { readRoots: [inside], writeRoots: [inside], allowedTools: ['write'] } }
      })
    )
    const denied = host.runTool(res.sessionId, 'write', { file_path: path.join(link, 'pwn.txt') })
    assert.equal(denied.allowed, false)
    assert.match(denied.reason, /cannot be safely resolved|UNRESOLVABLE|dangling/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('a task with no writeRoots denies writes and pins the session to read-only', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ packet: { scope: { writeRoots: [] } } }))
  const denied = host.runTool(res.sessionId, 'write', { file_path: path.join(ROOT, 'x.txt') })
  assert.equal(denied.allowed, false)
  assert.match(denied.reason, /no writeRoots/)
  const appended = host.appended.get(res.sessionId).filter((entry) => entry.type === 'sandbox/mode')
  assert.deepEqual(appended, [{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
  assert.equal(res.effectivePolicy.enforcement.sandboxModeOverride, 'read-only')
})

test('an empty allowedTools set denies every tool', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ packet: { scope: { allowedTools: [] } } }))
  assert.equal(host.runTool(res.sessionId, 'read', { file_path: 'a' }).allowed, false)
  assert.equal(res.effectivePolicy.requested.allowedTools.length, 0)
})

test('the tool-call budget is enforced by the guard', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ packet: { budget: { maxToolCalls: 2, timeoutMs: 600000 } } }))
  assert.equal(host.runTool(res.sessionId, 'read', { file_path: 'a' }).allowed, true)
  assert.equal(host.runTool(res.sessionId, 'read', { file_path: 'b' }).allowed, true)
  const third = host.runTool(res.sessionId, 'read', { file_path: 'c' })
  assert.equal(third.allowed, false)
  assert.match(third.reason, /tool-call budget exhausted/)
})

test('job_output/job_kill require verified ownership of the addressed job', async () => {
  const jobs = [
    { id: 'bash-1', kind: 'bash', label: 'owned', ownerSession: 'session-1', status: 'running' },
    { id: 'bash-2', kind: 'bash', label: 'foreign', ownerSession: 'session-9', status: 'running' }
  ]
  const host = createFakeHost({ jobs })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ packet: { scope: { allowedTools: ['read', 'job_output', 'job_kill'] } } }))

  assert.equal(host.runTool(res.sessionId, 'job_output', { job_id: 'bash-1' }).allowed, true)
  const foreign = host.runTool(res.sessionId, 'job_output', { job_id: 'bash-2' })
  assert.equal(foreign.allowed, false)
  assert.match(foreign.reason, /not owned by this task/)

  const missing = host.runTool(res.sessionId, 'job_kill', { job_id: 'bash-absent' })
  assert.equal(missing.allowed, false)
  assert.match(missing.reason, /unknown or not visible/)

  const noId = host.runTool(res.sessionId, 'job_kill', {})
  assert.equal(noId.allowed, false)
  assert.match(noId.reason, /requires an explicit job id/)
  assert.equal(host.calls.jobGet[0].caller, 'session-1')
})

test('job_output is denied when ownership cannot be verified at all', async () => {
  const host = createFakeHost({ jobsGetFails: true, jobs: [{ id: 'bash-1', ownerSession: 'session-1', status: 'running' }] })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ packet: { scope: { allowedTools: ['job_output'] } } }))
  const denied = host.runTool(res.sessionId, 'job_output', { job_id: 'bash-1' })
  assert.equal(denied.allowed, false)
  assert.match(denied.reason, /unknown or not visible/)

  const noJobsHost = createFakeHost({ noJobs: true })
  const noJobsAdapter = new DshAdapter(noJobsHost.ctx)
  const second = await noJobsAdapter.start(makeEnvelope({ packet: { scope: { allowedTools: ['job_output'] } } }))
  const deniedSecond = noJobsHost.runTool(second.sessionId, 'job_output', { job_id: 'bash-1' })
  assert.equal(deniedSecond.allowed, false)
  assert.match(deniedSecond.reason, /job ownership cannot be verified/)
})

test('a failing tools.restrict leaves guard-only enforcement intact', async () => {
  const host = createFakeHost({ restrictFails: true })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())
  assert.deepEqual(host.calls.restrictions, [])
  assert.equal(host.scopedGuards.length, 1)
  assert.deepEqual(res.effectivePolicy.enforcement.mechanisms, ['guard'])
  assert.equal(res.effectivePolicy.enforcement.visibilityFiltered, false)
  assert.match(res.effectivePolicy.enforcement.notes.join(' '), /tools\.restrict\(\) failed/)
  assert.equal(host.runTool(res.sessionId, 'read', { file_path: 'a' }).allowed, true)
  assert.equal(host.runTool(res.sessionId, 'subagent', { description: 'x' }).allowed, false)
})

test('pre-execute waterfall is the fallback when tools.guard is unavailable', async () => {
  const host = createFakeHost({ guardThrows: true })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())
  assert.equal(host.scopedPreExecute.length, 1)
  assert.deepEqual(res.effectivePolicy.enforcement.mechanisms, ['restrict', 'pre-execute'])
  assert.match(res.effectivePolicy.enforcement.notes.join(' '), /tools\.guard\(\) failed/)
  assert.equal(host.runTool(res.sessionId, 'read', { file_path: 'a' }).allowed, true)
  assert.equal(host.runTool(res.sessionId, 'subagent', { description: 'x' }).allowed, false)
})

test('delegation that starts anyway is recorded as an observed violation', async () => {
  const host = createFakeHost()
  const events = []
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope(), { onEvent: (event) => events.push(event) })
  host.emitSubagentStart(res.sessionId, 'spawn')
  assert.ok(events.some((event) => event.type === 'policy/violation' && event.violation === 'delegation-started'))
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.enforcement.delegationViolations.length, 1)
})

test('a throwing event listener is contained and counted, never propagated', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope(), {
    onEvent: () => {
      throw new Error('listener exploded')
    }
  })
  claim(host, res.sessionId, res.requestId, 1)
  host.emitAssistant(res.sessionId, 1, 'still working')
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })
  const caps = await adapter.capabilities()
  assert.ok(caps.listenerFailures > 0)
  assert.equal(caps.lastListenerFailure, 'listener exploded')
  assert.equal((await adapter.inspect(makeEnvelope())).status, 'completed')
})

// ---------------------------------------------------------------------------
// onResult contract
// ---------------------------------------------------------------------------

test('onResult uses the root result shape and reports an observed settlement', async () => {
  const host = createFakeHost()
  const results = []
  const adapter = new DshAdapter(host.ctx)
  const envelope = makeEnvelope({ id: 'task-uuid-11', attemptId: 'attempt-uuid-11' })
  const res = await adapter.start(envelope, { onResult: (result) => results.push(result) })
  claim(host, res.sessionId, res.requestId, 1)
  host.emitAssistant(res.sessionId, 1, 'first paragraph')
  host.emitAssistant(res.sessionId, 1, 'second paragraph')
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })

  assert.equal(results.length, 1)
  const result = results[0]
  assert.equal(result.status, 'completed')
    assert.equal(result.text, 'first paragraph\nsecond paragraph')
    assert.equal(result.finalText, 'second paragraph')
  assert.equal(result.stopConfirmed, true)
  assert.equal(result.activeJobs, 0)
  assert.equal(result.taskId, 'task-uuid-11')
  assert.equal(result.attemptId, 'attempt-uuid-11')
  assert.equal(result.sessionId, res.sessionId)
  assert.equal(result.requestId, res.requestId)
  assert.equal(Array.isArray(result.evidence), true)
  assert.equal(result.evidence[0].source, 'dsh-host')
  assert.deepEqual(result.checks, [])
  assert.equal(Array.isArray(result.uncertainties), true)
  assert.equal(typeof JSON.stringify(result), 'string')
  // The root only accepts a terminal status with stopConfirmed && activeJobs === 0.
  assert.equal(result.stopConfirmed, true)
  assert.equal(result.activeJobs, 0)
})

test('onResult reports cancelled for an aborted turn and failed for an error turn', async () => {
  const cancelledHost = createFakeHost({
    onCancel: (api, request) => {
      api.emitTurnEnd(request.sessionId, 1, { kind: 'aborted', reason: { kind: 'user' } })
      api.setStatus(request.sessionId, 'idle')
    }
  })
  const adapter = new DshAdapter(cancelledHost.ctx, { stopConfirmTimeoutMs: 200 })
  const results = []
  const res = await adapter.start(makeEnvelope(), { onResult: (result) => results.push(result) })
  claim(cancelledHost, res.sessionId, res.requestId, 1)
  await adapter.cancel(makeEnvelope())
  assert.equal(results[0].status, 'cancelled')
  assert.equal(results[0].stopReason, 'aborted')
  assert.equal(results[0].stopDetail, 'user')

  const errorHost = createFakeHost()
  const errorResults = []
  const errorAdapter = new DshAdapter(errorHost.ctx)
  const second = await errorAdapter.start(makeEnvelope({ id: 'task-uuid-12', attemptId: 'attempt-12' }), {
    onResult: (result) => errorResults.push(result)
  })
  claim(errorHost, second.sessionId, second.requestId, 1)
  errorHost.emitTurnEnd(second.sessionId, 1, { kind: 'error', error: { code: 'PROVIDER_DOWN' } })
  assert.equal(errorResults[0].status, 'failed')
  assert.equal(errorResults[0].stopReason, 'error')
  assert.equal(errorResults[0].stopDetail, 'PROVIDER_DOWN')
  assert.equal(errorResults[0].stopConfirmed, true)
})

test('onResult reports live owned jobs instead of claiming a clean stop', async () => {
  const jobs = [{ id: 'bash-1', kind: 'bash', label: 'still running', ownerSession: 'session-1', status: 'running' }]
  const host = createFakeHost({ jobs })
  const results = []
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope(), { onResult: (result) => results.push(result) })
  claim(host, res.sessionId, res.requestId, 1)
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })
  assert.equal(results[0].status, 'completed')
  assert.equal(results[0].activeJobs, 1)
  assert.ok(results[0].uncertainties.some((entry) => entry.includes('still live at settlement')))
})

// ---------------------------------------------------------------------------
// continue
// ---------------------------------------------------------------------------

test('continue submits a new attempt on the same session and refuses while one is in flight', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const first = await adapter.start(makeEnvelope({ understanding: undefined }))
  await assert.rejects(adapter.continue(makeEnvelope({ sessionId: first.sessionId }), { summary: 'x' }), {
    code: 'adapter/attempt-in-flight'
  })

  claim(host, first.sessionId, first.requestId, 1)
  host.emitTurnEnd(first.sessionId, 1, { kind: 'completed' })

  const second = await adapter.continue(
    makeEnvelope({ attemptId: 'attempt-uuid-2', sessionId: first.sessionId, prompt: 'ROOT EXECUTION PROMPT' }),
    { summary: 'understood' }
  )
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.attemptId, 'attempt-uuid-2')
  assert.notEqual(second.requestId, first.requestId)
  assert.equal(host.calls.prompt.length, 2)
  assert.equal(host.calls.prompt[1].content[0].text, 'ROOT EXECUTION PROMPT')
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.attempts.length, 2)
})

test('continue composes the execution prompt for the bare-packet form', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const first = await adapter.start(makePacket({ understandingRequired: true }))
  claim(host, first.sessionId, first.requestId, 1)
  host.emitTurnEnd(first.sessionId, 1, { kind: 'completed' })
  await adapter.continue(makePacket(), { summary: 'understood', assumptions: [] })
  assert.match(host.calls.prompt[1].content[0].text, /authorized execution/)
  assert.match(host.calls.prompt[1].content[0].text, /"summary":"understood"/)
})

test('continue verifies ownership and fails closed for unknown tasks', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  await assert.rejects(adapter.continue(makeEnvelope(), {}), { code: 'adapter/unknown-task' })
  const started = await adapter.start(makeEnvelope())
  await assert.rejects(adapter.continue(makeEnvelope({ sessionId: 'some-other-session' }), {}), {
    code: 'adapter/session-mismatch'
  })
  await assert.rejects(adapter.continue(makeEnvelope({ revision: 2, packet: { revision: 2 } }), {}), {
    code: 'adapter/revision-mismatch'
  })
  assert.equal(started.sessionId, 'session-1')
})

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test('cancel removes pending queue items and confirms stop from observed host state', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 200 })
  const res = await adapter.start(makeEnvelope())
  const [queued] = host.inboxOf(res.sessionId).nextTurn
  assert.ok(queued)

  const cancelled = await adapter.cancel(makeEnvelope())
  assert.equal(cancelled.accepted, true)
  assert.equal(cancelled.stopConfirmed, true)
  assert.deepEqual(cancelled.remaining, [])
  assert.deepEqual(host.calls.updateQueue, [{ sessionId: res.sessionId, itemId: queued.id, action: { kind: 'remove' } }])
  assert.ok(cancelled.actions.some((action) => action.kind === 'queue-remove' && action.accepted === true))
  assert.equal(cancelled.actions.some((action) => action.kind === 'turn-cancel'), false)
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.status, 'cancelled')
  assert.equal(inspected.stopConfirmed, true)
  assert.equal(inspected.activeJobs, 0)
})

test('cancel reports stopConfirmed false when the host never confirms the turn ended', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 60 })
  const res = await adapter.start(makeEnvelope())
  claim(host, res.sessionId, res.requestId, 1)

  const cancelled = await adapter.cancel(makeEnvelope())
  assert.equal(cancelled.accepted, true)
  assert.equal(cancelled.stopConfirmed, false)
  assert.equal(host.calls.cancel.length, 1)
  assert.ok(cancelled.remaining.some((entry) => entry.kind === 'active-attempt'))
  assert.deepEqual(cancelled.observed, ['agent-running', 'attempt-active', 'queued-items:0', 'live-jobs:0'])
  assert.equal((await adapter.inspect(makeEnvelope())).stopConfirmed, false)
})

test('early cancellation needs whole-driver quiescence when the host omits turn/end',async()=>{
 const host=createFakeHost();const adapter=new DshAdapter(host.ctx,{stopConfirmTimeoutMs:60});
 const envelope=makeEnvelope();const receipt=await adapter.start(envelope);claim(host,receipt.sessionId,receipt.requestId,1);
 const agent=host.ctx.get('agents').get(receipt.sessionId);agent.whenIdle=async()=>{agent.status='idle'};
 const stopped=await adapter.cancel(envelope);assert.equal(stopped.stopConfirmed,true);assert.ok(stopped.actions.some(a=>a.kind==='driver-quiescence'));
 const report=await adapter.inspect(envelope);assert.equal(report.status,'cancelled');assert.equal(report.lastResult.evidence[0].stopDetail,'host-idle-after-cancel');
});

test('cancel clears the inbox when precise queue removal is unavailable', async () => {
  const host = createFakeHost({ updateQueueFails: true, initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 200 })
  const res = await adapter.start(makeEnvelope())
  const cancelled = await adapter.cancel(makeEnvelope())
  assert.equal(host.calls.agentCancel.length, 1)
  assert.equal(host.calls.agentCancel[0].cause.kind, 'user')
  assert.ok(cancelled.actions.some((action) => action.kind === 'queue-remove' && action.accepted === false))
  assert.ok(cancelled.actions.some((action) => action.kind === 'inbox-clear' && action.accepted === true))
  assert.equal(cancelled.stopConfirmed, true)
  assert.deepEqual(host.inboxOf(res.sessionId).nextTurn, [])
})

test('cancel kills owned background jobs only', async () => {
  const jobs = [
    { id: 'bash-1', kind: 'bash', label: 'owned', ownerSession: 'session-1', status: 'running' },
    { id: 'bash-2', kind: 'bash', label: 'foreign', ownerSession: 'session-99', status: 'running' },
    { id: 'bash-3', kind: 'bash', label: 'finished', ownerSession: 'session-1', status: 'completed' }
  ]
  const host = createFakeHost({ jobs, initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 200 })
  await adapter.start(makeEnvelope())
  const cancelled = await adapter.cancel(makeEnvelope())
  assert.deepEqual(host.calls.jobsKilled.map((entry) => entry.id), ['bash-1'])
  assert.equal(host.calls.jobsKilled[0].caller, 'session-1')
  assert.equal(cancelled.stopConfirmed, true)
  assert.deepEqual(cancelled.remaining, [])
})

test('cancel reports remaining live jobs when a killed job never settles', async () => {
  const jobs = [{ id: 'bash-9', kind: 'bash', label: 'stuck', ownerSession: 'session-1', status: 'running' }]
  const host = createFakeHost({ jobs })
  host.ctx.get('jobs').kill = () => 'requested'
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 60 })
  const res = await adapter.start(makeEnvelope())
  claim(host, res.sessionId, res.requestId, 1)
  const cancelled = await adapter.cancel(makeEnvelope())
  assert.equal(cancelled.stopConfirmed, false)
  assert.ok(cancelled.remaining.some((entry) => entry.kind === 'job' && entry.jobId === 'bash-9'))
})

test('cancel confirms from observation when no live agent remains', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 100 })
  const res = await adapter.start(makeEnvelope())
  host.deleteAgent(res.sessionId)
  const cancelled = await adapter.cancel(makeEnvelope())
  assert.equal(cancelled.stopConfirmed, true)
  assert.ok(cancelled.observed.includes('agent-absent'))
})

test('cancel and inspect accept identity references and reject unknown tasks', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 100 })
  await adapter.start(makeEnvelope({ id: 'task-uuid-13' }))
  const cancelled = await adapter.cancel({ id: 'task-uuid-13' })
  assert.equal(cancelled.accepted, true)
  await assert.rejects(adapter.cancel({ id: 'nope' }), { code: 'adapter/unknown-task' })
  await assert.rejects(adapter.cancel(42), { code: 'adapter/invalid-packet' })
})

test('cancel refuses an envelope for another session', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  await adapter.start(makeEnvelope())
  await assert.rejects(adapter.cancel(makeEnvelope({ sessionId: 'foreign-session' })), { code: 'adapter/session-mismatch' })
})

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test('inspect derives facts from durable history, including the effective model', async () => {
  const durableEvents = [
    { type: 'assistant/message', seq: 1, time: 10, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'durable one' }] } } },
    { type: 'tool/call', seq: 2, time: 11, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'model/selection', seq: 3, time: 12, data: { provider: 'deepseek-official', model: 'deepseek-v4-astra', reasoningEffort: 'xhigh' } },
    { type: 'assistant/message', seq: 4, time: 13, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'durable two' }] } } },
    { type: 'turn/end', seq: 5, time: 14, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }
  ]
  const host = createFakeHost({ durableEvents })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())
  const inspected = await adapter.inspect(makeEnvelope())

  assert.equal(inspected.known, true)
  assert.equal(inspected.durable.available, true)
  assert.equal(inspected.durable.text, 'durable one\ndurable two')
  assert.equal(inspected.durable.turns, 1)
  assert.equal(inspected.durable.toolCalls, 1)
  assert.equal(inspected.durable.lastStopReason, 'aborted')
  assert.equal(inspected.durable.lastStopDetail, 'user')
  assert.equal(inspected.durable.lastSeq, 5)
  assert.deepEqual(inspected.durable.model, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-astra',
    reasoningEffort: 'xhigh'
  })
  assert.deepEqual(inspected.effectiveModel, inspected.durable.model)
  // The whole-session transcript is diagnostic only: no attempt is bound to a
  // claimed turn of this task, so it must never surface as the task reply.
  assert.equal(inspected.text, '')
  assert.equal(inspected.finalText, undefined)
  assert.equal(host.calls.inspect[0], res.sessionId)

  const full = await adapter.inspect(makeEnvelope(), { includeEvents: true })
  assert.equal(full.durable.events.length, durableEvents.length)
})

test('inspect reports a settled attempt in the root vocabulary so recover() can finish it', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ attemptId: 'attempt-uuid-21' }))
  claim(host, res.sessionId, res.requestId, 1)
  host.emitAssistant(res.sessionId, 1, 'recovered text')
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.status, 'completed')
  assert.equal(inspected.stopConfirmed, true)
  assert.equal(inspected.activeJobs, 0)
  assert.equal(inspected.text, 'recovered text')
  assert.equal(inspected.attempts[0].rootStatus, 'completed')
})

test('inspect returns an unknown, non-terminal report for a task with no local record', async () => {
  const host = createFakeHost({ inspectFails: true })
  const adapter = new DshAdapter(host.ctx)
  const inspected = await adapter.inspect(makeEnvelope({ id: 'never-seen', sessionId: 'session-404' }))
  assert.equal(inspected.known, false)
  assert.equal(inspected.status, 'unknown')
  assert.equal(inspected.stopConfirmed, false)
  assert.equal(inspected.activeJobs, null)
  assert.equal(inspected.durable.available, false)
  assert.match(inspected.uncertainties.join(' '), /no local record/)
  await assert.rejects(adapter.inspect(42), { code: 'adapter/invalid-packet' })
})

test('inspect reports unavailable durability instead of inventing history', async () => {
  const host = createFakeHost({ inspectFails: true })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.durable.available, false)
  assert.match(inspected.durable.reason, /session not found/)
  assert.equal(inspected.status, 'queued')
  assert.equal(inspected.currentRequestId, res.requestId)
  assert.equal(inspected.live, true)
})

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

test('cleanup refuses while the task is not settled and then hides the session durably', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())

  const refused = await adapter.cleanup(makeEnvelope())
  assert.equal(refused.cleaned, false)
  assert.equal(refused.reason, 'not-stopped')
  assert.deepEqual(refused.blockers, ['stop_unconfirmed', 'active_attempt', 'queued_items'])
  assert.deepEqual(host.calls.archived, [])

  claim(host, res.sessionId, res.requestId, 1)
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })

  const cleaned = await adapter.cleanup(makeEnvelope())
  assert.equal(cleaned.cleaned, true)
  assert.equal(cleaned.performed, true)
  assert.equal(cleaned.uiHidden, true)
  assert.equal(cleaned.uiHideMechanism, 'workspaceRegistry.archiveSession')
  assert.deepEqual(host.calls.archived, [res.sessionId])
  assert.equal(cleaned.persistenceDeleted, false)
  assert.equal(cleaned.persistenceCleanup.supported, false)
  assert.match(cleaned.persistenceCleanup.reason, /no durable session deletion API/)
  assert.equal(cleaned.unarchiveSupported, false)
  assert.ok(cleaned.released.enforcementDisposers >= 1)
  assert.equal(host.scopedGuards.length, 0)

  const again = await adapter.cleanup(makeEnvelope())
  assert.equal(again.cleaned, true)
  assert.equal(again.performed, false)
  assert.equal(again.reason, 'already-cleaned')

  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.cleanedUp, true)
  assert.equal(inspected.status, 'completed')
  await assert.rejects(adapter.continue(makeEnvelope(), {}), { code: 'adapter/task-cleaned' })
})

test('cleanup refuses a session this adapter does not own for the task', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())
  claim(host, res.sessionId, res.requestId, 1)
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })
  const outcome = await adapter.cleanup(makeEnvelope({ sessionId: 'someone-elses-session' }))
  assert.equal(outcome.cleaned, false)
  assert.equal(outcome.reason, 'not-owned')
  assert.deepEqual(host.calls.archived, [])
})

test('cleanup reports unknown tasks without throwing and never fakes deletion', async () => {
  const adapter = new DshAdapter(createFakeHost().ctx)
  const result = await adapter.cleanup({ id: 'never-started' })
  assert.equal(result.cleaned, false)
  assert.equal(result.reason, 'unknown-task')
  assert.equal(result.uiHidden, false)
  assert.equal(result.persistenceDeleted, false)
  assert.equal(result.supported, true)
})

test('cleanup reports retryable archive failure and never claims cleaned', async () => {
  const host = createFakeHost({ noWorkspaceRegistry: true })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope())
  claim(host, res.sessionId, res.requestId, 1)
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })
  const cleaned = await adapter.cleanup(makeEnvelope())
  assert.equal(cleaned.cleaned, false)
  assert.equal(cleaned.reason, 'archive-failed')
  assert.equal(cleaned.retryable, true)
  assert.equal(cleaned.guardPreserved, true)
  assert.equal(cleaned.uiHidden, false)
  assert.match(cleaned.uiHideError, /archiveSession is unavailable/)
  assert.equal(cleaned.persistenceDeleted, false)
  // The guard is still installed, so the retry is safe.
  assert.equal(host.scopedGuards.length, 1)
})

// ---------------------------------------------------------------------------
// bounds and lifecycle
// ---------------------------------------------------------------------------

test('the timeout budget cancels cooperatively and is reported as cooperative', async () => {
  const host = createFakeHost({
    onCancel: (api, request) => {
      api.emitTurnEnd(request.sessionId, 1, { kind: 'aborted', reason: { kind: 'user' } })
      api.setStatus(request.sessionId, 'idle')
    }
  })
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 200 })
  const events = []
  const res = await adapter.start(makeEnvelope({ packet: { budget: { timeoutMs: 40, maxToolCalls: 100 } } }), {
    onEvent: (event) => events.push(event)
  })
  claim(host, res.sessionId, res.requestId, 1)
  assert.equal(await waitFor(() => host.calls.cancel.length === 1, 800), true)
  assert.ok(events.some((event) => event.type === 'attempt/timeout'))
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.attempts[0].timedOut, true)
  assert.equal(inspected.stopConfirmed, true)
})

test('a lost prompt acknowledgement remains unknown without a false stop confirmation', async () => {
  const host = createFakeHost({ promptFails: true })
  const adapter = new DshAdapter(host.ctx)
  const results = []
  await assert.rejects(adapter.start(makeEnvelope(), { onResult: (result) => results.push(result) }), {
    code: 'adapter/prompt-rejected', dispatched: true
  })
  // The root learns from the rejection; no onResult may claim a settled task.
  assert.deepEqual(results, [])
  const status = adapter.status('task-uuid-1')
  assert.equal(status.currentState, 'unknown')
  assert.equal(status.stopConfirmed, false)
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.status, 'unknown')
  assert.equal(inspected.attempts[0].terminal, false)
  assert.equal(inspected.attempts[0].rootStatus, 'unknown')
})

test('status, orphans and dispose report adapter-owned state without destroying host sessions', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  assert.equal(adapter.status('nope'), null)
  await adapter.start(makeEnvelope({ id: 'task-uuid-31' }))
  const status = adapter.status('task-uuid-31')
  assert.equal(status.sessionId, 'session-1')
  assert.equal(status.currentState, 'queued')
  assert.equal(status.eventsDropped, 0)
  assert.deepEqual(adapter.orphans(), [])

  const disposed = adapter.dispose()
  assert.equal(disposed.disposed, true)
  assert.ok(disposed.enforcementDisposersReleased >= 1)
  assert.equal(adapter.dispose().alreadyDisposed, true)
  await assert.rejects(adapter.start(makeEnvelope({ id: 'task-uuid-32' })), { code: 'adapter/disposed' })
  assert.equal(host.agents.size, 1)
})

test('an explicit agentPreset mismatch is reported, not silently accepted', async () => {
  const host = createFakeHost({ createAgentPreset: 'other-preset' })
  const adapter = new DshAdapter(host.ctx, { agentPreset: 'wanted-preset' })
  const res = await adapter.start(makeEnvelope())
  const inspected = await adapter.inspect(makeEnvelope())
  assert.equal(inspected.enforcement.agentPreset, 'other-preset')
  assert.equal(inspected.enforcement.agentPresetMatched, false)
  assert.deepEqual(host.calls.create, [{ cwd: ROOT, agentPreset: 'wanted-preset' }])
  assert.equal(res.effectivePolicy.enforced, true)
})

test('DELEGATION_TOOLS matches the installed standard preset delegation tools', () => {
  assert.deepEqual(
    [...DELEGATION_TOOLS].sort(),
    [
      'interrupt_agent',
      'list_agents',
      'list_subagent_models',
      'ralph',
      'send_message',
      'subagent',
      'subagent_claude_code',
      'subagent_codex',
      'subagent_fork',
      'workflow'
    ].sort()
  )
})


// ---------------------------------------------------------------------------
// recovery after adapter reset (root-persisted trusted envelope only)
// ---------------------------------------------------------------------------

const RECOVERY_PACKET = {
  scope: { readRoots: [ROOT], writeRoots: [ROOT], allowedTools: ['read', 'write', 'todo_write'] }
}

/** Durable fixture: turn 1 is OUR attempt (request req-r); turn 2 is another turn. */
function recoveryEnvelope(overrides = {}) {
  const packet = makePacket(overrides.packet ?? RECOVERY_PACKET)
  return {
    id: 'task-r',
    revision: 1,
    attemptId: 'attempt-r',
    requestId: 'req-r',
    origin: 'codex-bridge',
    ownerId: 'owner-1',
    packet,
    prompt: 'P',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
    sessionId: 'session-1',
    ...overrides
  }
}

const OUR_TURN_INCOMPLETE = [
  {type:'model/selection',seq:0,time:0,data:{provider:'deepseek-official',model:'deepseek-flash'}},
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { id: 'm-ours', turn: 1, source: { kind: 'user', rpcId: 'req-r' } } },
  { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'OUR TEXT' }] } } },
  { type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } },
  { type: 'assistant/message', seq: 5, time: 5, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'FOREIGN TEXT' }] } } },
  { type: 'turn/end', seq: 6, time: 6, data: { turn: 2, reason: { kind: 'completed' } } }
]

test('reset recovery never adopts another turn ending or the whole-session text', async () => {
  const host = createFakeHost({ durableEvents: OUR_TURN_INCOMPLETE, initialStatus: 'idle' })
  await host.ctx.get('sessionController').create({ cwd: ROOT }) // live agent on session-1
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const report = await adapter.inspect(recoveryEnvelope())
  assert.equal(report.known, true)
  assert.equal(report.recovered, true)
  assert.equal(report.durable.bound.claimed, true)
  assert.equal(report.durable.bound.turn, 1)
  assert.equal(report.durable.bound.terminal, false)
  // Our turn never ended: foreign turn/end must NOT settle this attempt.
  assert.equal(report.status, 'unknown')
  assert.equal(report.stopConfirmed, false)
  assert.equal(report.text, 'OUR TEXT')
  assert.equal(report.text.includes('FOREIGN TEXT'), false)
  assert.equal(report.recovery.enforcementRestored, true)
})

test('reset recovery settles only on our own bound turn/end with no work in flight', async () => {
  const durableEvents = [
    ...OUR_TURN_INCOMPLETE,
    { type: 'turn/end', seq: 7, time: 7, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }
  ]
  const host = createFakeHost({ durableEvents, initialStatus: 'idle' })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const report = await adapter.inspect(recoveryEnvelope())
  assert.equal(report.durable.bound.terminal, true)
  assert.equal(report.durable.bound.stopReason, 'aborted')
  assert.equal(report.status, 'cancelled')
  assert.equal(report.stopConfirmed, true)
  assert.equal(report.activeJobs, 0)
  assert.equal(report.text, 'OUR TEXT')
})

test('reset recovery refuses work still in flight even when our turn ended', async () => {
  const durableEvents = [
    ...OUR_TURN_INCOMPLETE,
    { type: 'turn/end', seq: 7, time: 7, data: { turn: 1, reason: { kind: 'completed' } } }
  ]
  const host = createFakeHost({
    durableEvents,
    initialStatus: 'idle',
    jobs: [{ id: 'bash-7', kind: 'bash', label: 'still running', ownerSession: 'session-1', status: 'running' }]
  })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const report = await adapter.inspect(recoveryEnvelope())
  assert.equal(report.status, 'unknown')
  assert.equal(report.stopConfirmed, false)
  assert.equal(report.activeJobs, 1)
  assert.equal(report.recovery.reason, 'work-in-flight')
})

test('reset recovery rejects a foreign owner and a non-bridge origin without adopting anything', async () => {
  const host = createFakeHost({ durableEvents: OUR_TURN_INCOMPLETE, initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  for (const override of [{ ownerId: 'someone-else' }, { origin: 'other-bridge' }]) {
    const report = await adapter.inspect(recoveryEnvelope(override))
    assert.equal(report.known, false)
    assert.equal(report.recovered, false)
    assert.equal(report.status, 'unknown')
    assert.equal(report.stopConfirmed, false)
    await assert.rejects(adapter.cancel(recoveryEnvelope(override)), { code: 'adapter/unknown-task' })
    await assert.rejects(adapter.continue(recoveryEnvelope(override), {}), { code: 'adapter/unknown-task' })
  }
  assert.equal(adapter.status('task-r'), null)
})

test('reset recovery requires an ownerId and all three durable identities', async () => {
  const host = createFakeHost({ durableEvents: OUR_TURN_INCOMPLETE, initialStatus: 'idle' })
  const noOwner = new DshAdapter(host.ctx)
  assert.equal((await noOwner.inspect(recoveryEnvelope())).recovered, false)

  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  for (const override of [{ requestId: undefined }, { attemptId: undefined }, { sessionId: undefined }]) {
    const report = await adapter.inspect(recoveryEnvelope(override))
    assert.equal(report.recovered, false)
    assert.equal(report.stopConfirmed, false)
  }
})

test('reset recovery refuses to continue when the guard cannot be restored', async () => {
  const host = createFakeHost({ durableEvents: OUR_TURN_INCOMPLETE })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  assert.equal(host.agents.size, 0)
  await assert.rejects(adapter.continue(recoveryEnvelope(), { summary: 'x' }), { code: 'adapter/recovery-unsafe' })
})

test('reset recovery cancel never fakes stop confirmation without our turn terminal', async () => {
  const host = createFakeHost({ durableEvents: OUR_TURN_INCOMPLETE, initialStatus: 'idle' })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1', stopConfirmTimeoutMs: 60 })
  const outcome = await adapter.cancel(recoveryEnvelope())
  assert.equal(outcome.stopConfirmed, false)
  assert.ok(outcome.remaining.some((entry) => entry.kind === 'durable-bound-turn-not-terminal'))
})

test('reset recovery cancel confirms when our own durable turn terminal is proven', async () => {
  const durableEvents = [
    ...OUR_TURN_INCOMPLETE,
    { type: 'turn/end', seq: 7, time: 7, data: { turn: 1, reason: { kind: 'completed' } } }
  ]
  const host = createFakeHost({ durableEvents, initialStatus: 'idle' })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1', stopConfirmTimeoutMs: 60 })
  const outcome = await adapter.cancel(recoveryEnvelope())
  assert.equal(outcome.stopConfirmed, true)
  assert.equal(outcome.remaining.some((entry) => entry.kind === 'durable-bound-turn-not-terminal'), false)
})

test('reset recovery takes an empty last assistant message as the durable handoff', async () => {
  const durableEvents = [
    { type: 'model/selection', seq: 0, time: 0, data: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { type: 'user/message', seq: 1, time: 1, data: { id: 'm-empty', turn: 4, source: { kind: 'user', rpcId: 'req-r' } } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: { turn: 4, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'OUR PROGRESS' }] } }
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3,
      data: { turn: 4, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '' }] } }
    },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 4, reason: { kind: 'completed' } } }
  ]
  const host = createFakeHost({ durableEvents, initialStatus: 'idle' })
  await host.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })
  const report = await adapter.inspect(recoveryEnvelope())
  assert.equal(report.durable.bound.claimed, true)
  assert.equal(report.durable.bound.turn, 4)
  assert.equal(report.durable.bound.text, 'OUR PROGRESS')
  assert.equal(report.durable.bound.finalText, '')
  assert.equal(report.durable.bound.terminal, true)
  assert.equal(report.status, 'completed')
  assert.equal(report.stopConfirmed, true)
  assert.equal(report.text, 'OUR PROGRESS')
  assert.equal(report.finalText, '')
})

test('cleanup retries after a real archive failure and only then reports cleaned', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ id: 'task-arch' }))
  claim(host, res.sessionId, res.requestId, 1)
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })

  const registry = host.ctx.get('workspaceRegistry')
  const real = registry.archiveSession
  registry.archiveSession = async () => {
    throw new Error('archive backend unavailable')
  }
  const failed = await adapter.cleanup(makeEnvelope({ id: 'task-arch' }))
  assert.equal(failed.cleaned, false)
  assert.equal(failed.reason, 'archive-failed')
  assert.equal(failed.retryable, true)
  assert.equal(failed.guardPreserved, true)
  assert.equal(host.scopedGuards.length, 1, 'the guard must survive a failed archive')
  assert.deepEqual(host.calls.archived, [])

  registry.archiveSession = real
  const retried = await adapter.cleanup(makeEnvelope({ id: 'task-arch' }))
  assert.equal(retried.cleaned, true)
  assert.equal(retried.uiHidden, true)
  assert.deepEqual(host.calls.archived, [res.sessionId])
  assert.equal(host.scopedGuards.length, 0)
})

test('understanding phase denies writes (regression)', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope({ packet: { understandingRequired: true } }))
  assert.equal(host.runTool(res.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }).allowed, true)
  const write = host.runTool(res.sessionId, 'write', { file_path: path.join(ROOT, 'a.txt') })
  assert.equal(write.allowed, false)
  assert.match(write.reason, /Understanding phase permits read tools only/)
})

test('durable-before-guard dedup counts one tool/start per dispatch (regression)', async () => {
  const host = createFakeHost()
  const events = []
  const adapter = new DshAdapter(host.ctx)
  const res = await adapter.start(makeEnvelope(), { onEvent: (event) => events.push(event) })
  claim(host, res.sessionId, res.requestId, 1)
  // Durable event first (the host appends tool/call before the guard observes it).
  host.emitToolCall(res.sessionId, 1, 'read', 'call-once')
  const admitted = host.runTool(res.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }, 'call-once')
  assert.equal(admitted.allowed, true)
  assert.equal(events.filter((event) => event.type === 'tool/start').length, 1)
})

// ---------------------------------------------------------------------------
// Phase-2 lifecycle contract: reconsider / archive
//
// FAKE-HOST ONLY. These cases drive the adapter's documented seams through the
// same `createFakeHost` above; no real DSH host runs, no model is prompted and no
// tool body executes. They are MOCK-class evidence, not live-runtime proof, and
// they target the public method names and returned fields fixed by
// evidence/upgrade-20260925/LIFECYCLE-CONTRACT.md (20260925.2).
// ---------------------------------------------------------------------------

/** Durable history: our bound understanding turn was claimed and completed. */
const UNDERSTANDING_SETTLED = [
  { type: 'model/selection', seq: 0, time: 0, data: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 2, data: { id: 'm-u', turn: 1, source: { kind: 'user', rpcId: 'req-r' } } },
  { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'UNDERSTOOD' }] } } },
  { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }
]

/**
 * Persisted lifecycle envelope for a clarification (`{...task, packet}`): the
 * immutable original packet plus the trusted previous-attempt snapshot a reset
 * adapter may recover from (`clarifications[last].previousAttempt`). The adapter
 * never receives that snapshot from a caller.
 * @param {object} [overrides] - envelope/clarification overrides.
 * @returns {object} envelope.
 */
function lifecycleEnvelope(overrides = {}) {
  const packet = makePacket(overrides.packet ?? { understandingRequired: true })
  const sessionId = overrides.sessionId ?? 'session-1'
  const generation = overrides.understandingGeneration ?? 1
  const previousAttempt = {
    attemptId: overrides.previousAttemptId ?? 'attempt-r',
    requestId: overrides.previousRequestId ?? 'req-r',
    sessionId,
    revision: overrides.revision ?? packet.revision,
    phase: 'understanding',
    status: 'completed',
    dispatchReceiptAt: 1,
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-flash' }
  }
  const clarification = {
    clarificationId: overrides.clarificationId ?? 'clar-1',
    text: overrides.clarificationText ?? 'also cover the boundary case',
    requestHash: 'hash-1',
    generation,
    createdAt: 1,
    previousUnderstanding: null,
    previousUnderstandingHash: null,
    previousResult: null,
    previousAttempt
  }
  return {
    id: overrides.id ?? 'task-uuid-1',
    revision: overrides.revision ?? packet.revision,
    attemptId: overrides.attemptId ?? 'attempt-clar-2',
    origin: overrides.origin ?? 'codex-bridge',
    ownerId: overrides.ownerId ?? 'owner-1',
    packet,
    prompt: overrides.prompt ?? `UNDERSTANDING: ${clarification.text}`,
    effectiveModel: overrides.effectiveModel ?? { provider: 'deepseek-official', model: 'deepseek-flash' },
    sessionId,
    continuationKind: 'clarification',
    understandingGeneration: generation,
    dispatchReceiptAt: 1,
    dispatchStarted: false,
    stopConfirmed: true,
    activeJobs: 0,
    status: 'awaiting_approval',
    phase: 'awaiting_approval',
    requestId: null,
    understanding: null,
    understandingHash: null,
    clarifications: overrides.clarifications ?? [clarification]
  }
}

/** Start an understanding task, claim its turn and settle it completed. */
async function settledUnderstandingTask(host, adapter, id) {
  const started = await adapter.start(makeEnvelope({ id, attemptId: 'attempt-c1', packet: { understandingRequired: true } }))
  claim(host, started.sessionId, started.requestId, 1)
  host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
  return started
}

/** Start an execution task, claim its turn and settle it completed. */
async function settledExecutionTask(host, adapter, id) {
  const started = await adapter.start(makeEnvelope({ id }))
  claim(host, started.sessionId, started.requestId, 1)
  host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
  return started
}

test('reconsider dispatches a new understanding attempt on the same owned session', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstandingTask(host, adapter, 'task-clar-1')

  const before = { create: host.calls.create.length, prompt: host.calls.prompt.length, selectModel: host.calls.selectModel.length }
  const receipt = await adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-1', attemptId: 'attempt-c2' }), {})

  assert.equal(receipt.sessionId, started.sessionId)
  assert.equal(receipt.attemptId, 'attempt-c2')
  assert.notEqual(receipt.requestId, started.requestId)
  assert.equal(receipt.mode, 'understanding')
  // No second session is ever created for a clarification.
  assert.equal(host.calls.create.length, before.create)
  assert.equal(host.calls.prompt.length, before.prompt + 1)
  assert.equal(host.calls.prompt[before.prompt].sessionId, started.sessionId)
  assert.match(host.calls.prompt[before.prompt].content[0].text, /also cover the boundary case/)
  assert.deepEqual(receipt.effectiveModel, { provider: 'deepseek-official', model: 'deepseek-flash' })
  // The route is never silently changed.
  for (const call of host.calls.selectModel.slice(before.selectModel)) {
    assert.equal(call.provider, 'deepseek-official')
    assert.equal(call.model, 'deepseek-flash')
  }
  assert.ok(receipt.effectivePolicy, 'the receipt carries the effective policy')
})

test('reconsider keeps the original packet and model and keeps writes denied', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const packet = { understandingRequired: true, scope: { allowedTools: ['read', 'write', 'todo_write'] } }
  const started = await adapter.start(makeEnvelope({ id: 'task-clar-2', attemptId: 'attempt-c1', packet }))
  claim(host, started.sessionId, started.requestId, 1)
  host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })

  const before = await adapter.inspect(makeEnvelope({ id: 'task-clar-2' }))
  await adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-2', attemptId: 'attempt-c2', packet }), {})
  const after = await adapter.inspect(makeEnvelope({ id: 'task-clar-2' }))

  assert.deepEqual(after.effectiveModel, before.effectiveModel)
  assert.deepEqual(after.effectivePolicy.requested, before.effectivePolicy.requested)

  assert.equal(host.runTool(started.sessionId, 'read', { file_path: path.join(ROOT, 'a.txt') }).allowed, true)
  const write = host.runTool(started.sessionId, 'write', { file_path: path.join(ROOT, 'a.txt') })
  assert.equal(write.allowed, false)
  assert.match(write.reason, /Understanding phase permits read tools only/)
})

test('reconsider refuses an in-flight attempt with dispatched:false and no prompt', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx)
  const started = await adapter.start(makeEnvelope({ id: 'task-clar-3', attemptId: 'attempt-c1', packet: { understandingRequired: true } }))
  await assert.rejects(adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-3', attemptId: 'attempt-c2' }), {}), (error) => {
    assert.match(String(error.code), /attempt-in-flight|conflict|active/i)
    assert.equal(error.dispatched, false)
    return true
  })
  assert.equal(host.calls.prompt.length, 1)
  assert.equal(host.calls.prompt[0].requestId, started.requestId)
  assert.equal(host.calls.create.length, 1)
})

test('reconsider refuses a foreign session, a changed packet and a changed route', async () => {
  // A session this adapter never bound to the task.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledUnderstandingTask(host, adapter, 'task-clar-4')
    await assert.rejects(
      adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-4', attemptId: 'attempt-c2', sessionId: 'someone-elses-session' }), {}),
      (error) => {
        assert.match(String(error.code), /session-mismatch|not-owned|mismatch/i)
        assert.equal(error.dispatched, false)
        return true
      }
    )
    assert.equal(host.calls.prompt.length, 1)
  }
  // A packet that is not the immutable original.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledUnderstandingTask(host, adapter, 'task-clar-4b')
    await assert.rejects(
      adapter.reconsider(
        lifecycleEnvelope({ id: 'task-clar-4b', attemptId: 'attempt-c2', packet: { understandingRequired: true, objective: 'a different objective' } }),
        {}
      ),
      (error) => {
        assert.match(String(error.code), /duplicate|conflict|mismatch|packet/i)
        assert.equal(error.dispatched, false)
        return true
      }
    )
    assert.equal(host.calls.prompt.length, 1)
  }
  // A route that is not the one the host verified for this task.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledUnderstandingTask(host, adapter, 'task-clar-4c')
    await assert.rejects(
      adapter.reconsider(
        lifecycleEnvelope({
          id: 'task-clar-4c',
          attemptId: 'attempt-c2',
          effectiveModel: { provider: 'deepseek-official', model: 'deepseek-v4-astra', reasoningEffort: 'xhigh' }
        }),
        {}
      ),
      (error) => {
        assert.match(String(error.code), /route|model/i)
        assert.equal(error.dispatched, false)
        return true
      }
    )
    assert.equal(host.calls.prompt.length, 1)
    assert.equal(host.calls.selectModel.length, 1)
  }
})

test('reconsider refuses a cleaned task with dispatched:false', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  await settledUnderstandingTask(host, adapter, 'task-clar-5')
  const cleaned = await adapter.cleanup(makeEnvelope({ id: 'task-clar-5' }))
  assert.equal(cleaned.cleaned, true)

  await assert.rejects(adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-5', attemptId: 'attempt-c2' }), {}), (error) => {
    assert.match(String(error.code), /task-cleaned|cleaned|conflict/i)
    assert.equal(error.dispatched, false)
    return true
  })
  assert.equal(host.calls.prompt.length, 1)
})

test('reconsider after an adapter reset recovers only from the trusted last previousAttempt', async () => {
  const host = createFakeHost({ durableEvents: UNDERSTANDING_SETTLED, initialStatus: 'idle' })
  await host.ctx.get('sessionController').create({ cwd: ROOT }) // the existing owned live session-1
  const adapter = new DshAdapter(host.ctx, { ownerId: 'owner-1' })

  const envelope = lifecycleEnvelope({ id: 'task-clar-6', attemptId: 'attempt-c2', sessionId: 'session-1' })
  const receipt = await adapter.reconsider(envelope, {})

  assert.equal(receipt.sessionId, 'session-1')
  assert.equal(receipt.attemptId, 'attempt-c2')
  assert.equal(receipt.mode, 'understanding')
  assert.notEqual(receipt.requestId, 'req-r')
  assert.equal(host.calls.create.length, 1, 'recovery must not create a session')
  assert.equal(host.calls.prompt.length, 1)
  assert.equal(host.calls.prompt[0].sessionId, 'session-1')
  assert.match(host.calls.prompt[0].content[0].text, /also cover the boundary case/)
  // Enforcement was restored on the recovered session before the new attempt.
  assert.ok(host.scopedGuards.some((entry) => entry.sessionId === 'session-1'))
  const write = host.runTool('session-1', 'write', { file_path: path.join(ROOT, 'a.txt') })
  assert.equal(write.allowed, false)

  // Missing trusted evidence refuses without replay or a new session.
  const host2 = createFakeHost({ durableEvents: UNDERSTANDING_SETTLED, initialStatus: 'idle' })
  await host2.ctx.get('sessionController').create({ cwd: ROOT })
  const adapter2 = new DshAdapter(host2.ctx, { ownerId: 'owner-1' })
  await assert.rejects(
    adapter2.reconsider(lifecycleEnvelope({ id: 'task-clar-6b', attemptId: 'attempt-c2', sessionId: 'session-1', clarifications: [] }), {}),
    (error) => {
      assert.match(String(error.code), /clarification|recovery|unknown|trust|evidence/i)
      assert.equal(error.dispatched, false)
      return true
    }
  )
  assert.equal(host2.calls.prompt.length, 0)
  assert.equal(host2.calls.create.length, 1)
})

test('reconsider does not let a previous attempt deadline cancel the new attempt', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx, { stopConfirmTimeoutMs: 40 })
  const events = []
  // The packet is immutable, so both attempts share this budget: waiting below
  // the deadline means only a stale callback could act on the new attempt.
  const budget = { timeoutMs: 2000, maxToolCalls: 100, maxOutputChars: 200000 }
  const first = await adapter.start(
    makeEnvelope({ id: 'task-clar-7', attemptId: 'attempt-c1', packet: { understandingRequired: true, budget } }),
    { onEvent: (event) => events.push(event) }
  )
  claim(host, first.sessionId, first.requestId, 1)
  host.emitTurnEnd(first.sessionId, 1, { kind: 'completed' })

  const receipt = await adapter.reconsider(
    lifecycleEnvelope({ id: 'task-clar-7', attemptId: 'attempt-c2', packet: { understandingRequired: true, budget } }),
    { onEvent: (event) => events.push(event) }
  )
  claim(host, receipt.sessionId, receipt.requestId, 2)
  host.emitAssistant(receipt.sessionId, 2, 'the later attempt is still current')

  await new Promise((resolve) => setTimeout(resolve, 250))

  // A previous attempt's timer must never cancel or settle the newer attempt.
  assert.deepEqual(host.calls.cancel, [])
  assert.equal(events.filter((event) => event.type === 'attempt/timeout').length, 0)
  const report = await adapter.inspect(lifecycleEnvelope({ id: 'task-clar-7', attemptId: 'attempt-c2' }))
  const current = report.attempts.at(-1)
  assert.equal(current.attemptId, 'attempt-c2')
  assert.equal(current.terminal, false)
  assert.equal(current.timedOut, false)
  assert.equal(report.currentAttemptId, 'attempt-c2')
  assert.equal(first.sessionId, receipt.sessionId)
})

test('reconsider refuses when host jobs or queue truth cannot be confirmed', async () => {
  // Absent jobs service: not evidence of zero jobs.
  {
    const host = createFakeHost({ noJobs: true, initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledUnderstandingTask(host, adapter, 'task-clar-8a')
    await assert.rejects(adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-8a', attemptId: 'attempt-c2' }), {}), (error) => {
      assert.equal(error.dispatched, false)
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // A throwing jobs probe: not evidence of zero jobs.
  {
    const host = createFakeHost({ initialStatus: 'idle', jobs: [{ id: 'bash-1', ownerSession: 'session-1', status: 'completed' }] })
    const adapter = new DshAdapter(host.ctx)
    await settledUnderstandingTask(host, adapter, 'task-clar-8b')
    host.ctx.get('jobs').list = () => {
      throw new Error('job list unavailable')
    }
    await assert.rejects(adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-8b', attemptId: 'attempt-c2' }), {}), (error) => {
      assert.equal(error.dispatched, false)
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // A throwing queue probe: not evidence of an empty queue.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    const started = await settledUnderstandingTask(host, adapter, 'task-clar-8c')
    Object.defineProperty(host.agents.get(started.sessionId), 'inbox', {
      configurable: true,
      get() {
        throw new Error('session inbox is unavailable')
      }
    })
    await assert.rejects(adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-8c', attemptId: 'attempt-c2' }), {}), (error) => {
      assert.equal(error.dispatched, false)
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // An owned live job blocks the new attempt.
  {
    const host = createFakeHost({ initialStatus: 'idle', jobs: [{ id: 'bash-1', ownerSession: 'session-1', status: 'running' }] })
    const adapter = new DshAdapter(host.ctx)
    await settledUnderstandingTask(host, adapter, 'task-clar-8d')
    await assert.rejects(adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-8d', attemptId: 'attempt-c2' }), {}), (error) => {
      assert.equal(error.dispatched, false)
      return true
    })
    assert.equal(host.calls.prompt.length, 1)
  }
  // Control: a confirmed-empty host with only a foreign job still succeeds.
  {
    const host = createFakeHost({ initialStatus: 'idle', jobs: [{ id: 'bash-9', ownerSession: 'session-99', status: 'running' }] })
    const adapter = new DshAdapter(host.ctx)
    await settledUnderstandingTask(host, adapter, 'task-clar-8e')
    const receipt = await adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-8e', attemptId: 'attempt-c2' }), {})
    assert.equal(receipt.mode, 'understanding')
    assert.equal(host.calls.create.length, 1)
  }
})

test('archive hides the owned settled session without cleanup, job kills or disposer release', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledExecutionTask(host, adapter, 'task-arch-1')
  const before = await adapter.inspect(makeEnvelope({ id: 'task-arch-1' }))
  const guardsBefore = host.scopedGuards.length

  const out = await adapter.archive(makeEnvelope({ id: 'task-arch-1' }))

  assert.equal(out.archived, true)
  assert.equal(out.uiHidden, true)
  assert.equal(out.sessionId, started.sessionId)
  assert.equal(out.workspacePreserved, true)
  assert.equal(out.evidencePreserved, true)
  assert.deepEqual(host.calls.archived, [started.sessionId])
  assert.deepEqual(host.calls.jobsKilled, [], 'archive must not kill jobs')
  assert.equal(host.scopedGuards.length, guardsBefore, 'archive must not release enforcement')
  assert.equal(host.agents.size, 1, 'archive must not delete the session')
  const after = await adapter.inspect(makeEnvelope({ id: 'task-arch-1' }))
  assert.equal(after.cleanedUp, false)
  assert.equal(after.attempts[0].endedAt, before.attempts[0].endedAt)
  assert.notEqual(after.status, 'unknown')
})

test('archive refuses a foreign session, unsettled work, queued work and live owned jobs', async () => {
  // Foreign session.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledExecutionTask(host, adapter, 'task-arch-r1')
    await assert.rejects(
      () => adapter.archive(makeEnvelope({ id: 'task-arch-r1', sessionId: 'someone-elses-session' })),
      (error) => {
        assert.equal(error.code, 'adapter/session-mismatch')
        assert.equal(error.dispatched, false)
        return true
      }
    )
    assert.deepEqual(host.calls.archived, [])
  }
  // Active attempt without a terminal turn.
  {
    const host = createFakeHost()
    const adapter = new DshAdapter(host.ctx)
    const started = await adapter.start(makeEnvelope({ id: 'task-arch-r2' }))
    claim(host, started.sessionId, started.requestId, 1)
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-r2' }))
    assert.notEqual(out.archived, true)
    assert.deepEqual(host.calls.archived, [])
  }
  // Queued work that was never claimed.
  {
    const host = createFakeHost()
    const adapter = new DshAdapter(host.ctx)
    await adapter.start(makeEnvelope({ id: 'task-arch-r3' }))
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-r3' }))
    assert.notEqual(out.archived, true)
    assert.deepEqual(host.calls.archived, [])
  }
  // A live job owned by this task.
  {
    const host = createFakeHost({ initialStatus: 'idle', jobs: [{ id: 'bash-5', ownerSession: 'session-1', status: 'running' }] })
    const adapter = new DshAdapter(host.ctx)
    await settledExecutionTask(host, adapter, 'task-arch-r4')
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-r4' }))
    assert.notEqual(out.archived, true)
    assert.deepEqual(host.calls.archived, [])
  }
  // Control: a foreign job does not block this task's archive.
  {
    const host = createFakeHost({ initialStatus: 'idle', jobs: [{ id: 'bash-6', ownerSession: 'session-77', status: 'running' }] })
    const adapter = new DshAdapter(host.ctx)
    await settledExecutionTask(host, adapter, 'task-arch-r5')
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-r5' }))
    assert.equal(out.archived, true)
  }
})

test('archive refuses when the jobs or queue seam cannot be confirmed', async () => {
  // Absent jobs service.
  {
    const host = createFakeHost({ noJobs: true, initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledExecutionTask(host, adapter, 'task-arch-u1')
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-u1' }))
    assert.notEqual(out.archived, true)
    assert.deepEqual(host.calls.archived, [])
  }
  // Throwing jobs probe.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledExecutionTask(host, adapter, 'task-arch-u2')
    host.ctx.get('jobs').list = () => {
      throw new Error('job list unavailable')
    }
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-u2' }))
    assert.notEqual(out.archived, true)
    assert.deepEqual(host.calls.archived, [])
  }
  // Throwing queue probe.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    const started = await settledExecutionTask(host, adapter, 'task-arch-u3')
    Object.defineProperty(host.agents.get(started.sessionId), 'inbox', {
      configurable: true,
      get() {
        throw new Error('session inbox is unavailable')
      }
    })
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-u3' }))
    assert.notEqual(out.archived, true)
    assert.deepEqual(host.calls.archived, [])
  }
})

test('archive reports unsupported and throwing host outcomes without a false success', async () => {
  // Host has no archive API at all.
  {
    const host = createFakeHost({ noWorkspaceRegistry: true, initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledExecutionTask(host, adapter, 'task-arch-x1')
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-x1' }))
    assert.equal(out.archived, false)
    assert.equal(out.supported, false)
    assert.notEqual(out.uiHidden, true)
    assert.deepEqual(host.calls.archived, [])
    assert.equal((await adapter.inspect(makeEnvelope({ id: 'task-arch-x1' }))).cleanedUp, false)
  }
  // The archive backend throws.
  {
    const host = createFakeHost({ initialStatus: 'idle' })
    const adapter = new DshAdapter(host.ctx)
    await settledExecutionTask(host, adapter, 'task-arch-x2')
    host.ctx.get('workspaceRegistry').archiveSession = async () => {
      throw new Error('archive backend unavailable')
    }
    const out = await adapter.archive(makeEnvelope({ id: 'task-arch-x2' }))
    assert.equal(out.archived, false)
    assert.equal(out.outcome, 'unknown')
    assert.equal(out.retryable, true)
    assert.deepEqual(host.calls.archived, [])
    assert.equal(host.scopedGuards.length >= 1, true, 'enforcement survives a failed archive')
    assert.equal((await adapter.inspect(makeEnvelope({ id: 'task-arch-x2' }))).cleanedUp, false)
  }
})

test('a repeated archive is harmless and never releases enforcement', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  await settledExecutionTask(host, adapter, 'task-arch-dup')
  const envelope = makeEnvelope({ id: 'task-arch-dup' })

  const first = await adapter.archive(envelope)
  const second = await adapter.archive(envelope)

  assert.equal(first.archived, true)
  assert.equal(second.archived, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.ok(host.calls.archived.length >= 1)
  assert.ok(host.calls.archived.every((id) => id === first.sessionId))
  assert.equal(host.scopedGuards.length >= 1, true)
  assert.equal((await adapter.inspect(envelope)).cleanedUp, false)
})

test('normal continue still works on the same session after a clarification reconsider', async () => {
  const host = createFakeHost({ initialStatus: 'idle' })
  const adapter = new DshAdapter(host.ctx)
  const started = await settledUnderstandingTask(host, adapter, 'task-clar-14')

  const clarified = await adapter.reconsider(lifecycleEnvelope({ id: 'task-clar-14', attemptId: 'attempt-c2' }), {})
  claim(host, clarified.sessionId, clarified.requestId, 2)
  host.emitTurnEnd(clarified.sessionId, 2, { kind: 'completed' })

  const exec = await adapter.continue(
    makeEnvelope({
      id: 'task-clar-14',
      attemptId: 'attempt-exec',
      sessionId: clarified.sessionId,
      packet: { understandingRequired: true },
      prompt: 'ROOT EXECUTION PROMPT'
    }),
    { summary: 'understood' }
  )

  assert.equal(exec.sessionId, started.sessionId)
  assert.equal(exec.attemptId, 'attempt-exec')
  assert.equal(exec.mode, 'execution')
  assert.equal(host.calls.create.length, 1, 'continue must not create a session either')
  assert.equal(host.calls.prompt.length, 3)
  assert.equal(host.calls.prompt[2].content[0].text, 'ROOT EXECUTION PROMPT')
  // Approval clears the understanding gate: writes are admitted again.
  assert.equal(host.runTool(started.sessionId, 'write', { file_path: path.join(ROOT, 'x.txt') }).allowed, true)
})

// ---------------------------------------------------------------------------
// controlled supervisor: child sessions, bridge jobs, root reply
// (contract supervisor-event-wake-v1)
// ---------------------------------------------------------------------------

async function captureFailure(fn, code) {
  try {
    await fn()
  } catch (error) {
    if (code !== undefined) assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return error
  }
  throw new Error(`expected a failure${code === undefined ? '' : ` with code ${code}`}`)
}

function supervisorFor(options = {}) {
  const ledger = sharedLedger(`adapter-supervisor-${randomUUID()}`, { limit: options.limit ?? 8 })
  return new BridgeSupervisor({
    ledger,
    ownerId: 'owner',
    config: {
      childSessions: options.childSessions ?? { enabled: true, maxChildrenPerTask: 2, maxDepth: 1, waitTimeoutMs: 50, maxWaitTimeoutMs: 100 },
      commandJobs: options.commandJobs ?? { enabled: false },
      rootCallbackGrants: options.rootCallbackGrants ?? {},
      notificationSink: options.notificationSink
    }
  })
}

test('an ordinary task never registers bridge tools and the guard denies them by name', async () => {
  const host = createFakeHost()
  // Even a classification override that re-labels the bridge tools cannot make
  // them admissible: the task carries no grant.
  const adapter = new DshAdapter(host.ctx, {
    supervisor: supervisorFor(),
    toolClassifications: { dsh_child_spawn: 'other', dsh_bridge_reply: 'other' }
  })
  const res = await adapter.start(makePacket())
  assert.deepEqual(host.calls.registered, [], 'an ordinary task must register no bridge-owned tool')
  for (const name of ['dsh_child_spawn', 'dsh_child_wait', 'dsh_job_start', 'dsh_bridge_reply']) {
    const denied = host.runTool(res.sessionId, name, { childKey: 'c1', objective: 'o', profileId: 'p', replyId: 'r', summary: 's' })
    assert.equal(denied.allowed, false, `${name} must be denied without a grant`)
    assert.match(denied.reason, /task-granted|no approved/, `${name} denial must name the missing grant`)
  }
  const caps = await adapter.capabilities()
  assert.equal(caps.supervisor.children.supported, true, 'the host supports child sessions; the TASK did not grant them')
  assert.equal(caps.enforcement.ownedJobTools.tools.length, 2)
})

test('a granted task registers the child tools on the authorized parent and rejects widening and foreign callers', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1 } } }))

  const names = host.calls.registered.filter((entry) => entry.sessionId === res.sessionId).map((entry) => entry.name)
  assert.deepEqual(names.sort(), ['dsh_child_cancel', 'dsh_child_list', 'dsh_child_result', 'dsh_child_spawn', 'dsh_child_wait'])

  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  assert.equal(typeof spawn.execute, 'function')
  const parentAgent = host.agents.get(res.sessionId)

  // Widening is REJECTED (never clamped) and creates nothing.
  for (const args of [
    { childKey: 'w1', objective: 'o', readRoots: [OUTSIDE] },
    { childKey: 'w2', objective: 'o', writeRoots: [OUTSIDE] },
    { childKey: 'w3', objective: 'o', allowNetwork: true },
    { childKey: 'w4', objective: 'o', model: { provider: 'deepseek-official', model: 'other-model' } },
    { childKey: 'w5', objective: 'o', budgets: { timeoutMs: 10_000_000 } },
    { childKey: 'w6', objective: 'o', tools: ['subagent'] },
    { childKey: 'w7', objective: 'o', tools: ['bash'] },
    { childKey: 'w8', objective: 'o', tools: ['dsh_child_spawn'] },
    { childKey: 'w9', objective: 'o', depth: 1 }
  ]) {
    const failure = await captureFailure(() => spawn.execute(args, { agent: parentAgent, arguments: args }), 'supervisor/grant-widened')
    assert.ok(failure.code === 'supervisor/grant-widened')
  }
  assert.equal(supervisor.ledger.counts().children, 0, 'no refused request may reserve a child slot')
  assert.equal(host.calls.create.length, 1, 'no refused request may create a session')

  // A foreign agent cannot call the bridge tool even though the definition exists.
  const foreign = await captureFailure(
    () => spawn.execute({ childKey: 'f1', objective: 'x' }, { agent: { id: 'someone-else' }, arguments: { childKey: 'f1', objective: 'x' } }),
    'adapter/unauthorized-caller'
  )
  assert.equal(foreign.code, 'adapter/unauthorized-caller')
})

test('a child session starts with an attenuated grant, cannot delegate or use a shell, and releases its slot only on observed settlement', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read', 'todo_write'] } } }))
  const parentAgent = host.agents.get(res.sessionId)
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')

  const child = await spawn.execute(
    { childKey: 'c1', objective: 'read one file', tools: ['read'] },
    { agent: parentAgent, arguments: { childKey: 'c1', objective: 'read one file', tools: ['read'] } }
  )
  assert.equal(child.state, 'running')
  assert.equal(child.depth, 1)
  assert.equal(child.lineage, 'agents.create')
  assert.equal(supervisor.ledger.counts().children, 1)

  // The child is a real published agent with its own subagent-owned identity, and
  // its enforcement is scoped to the CHILD, never to the parent.
  const childAgent = host.agents.get(child.sessionId)
  assert.ok(childAgent, 'the child agent really exists in the host registry')
  assert.equal(childAgent.session.header.origin, 'subagent')
  assert.equal(childAgent.session.header.delegationDepth, 1)
  assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === child.sessionId).length, 1)
  assert.equal(
    host.scopedGuards.filter((entry) => entry.sessionId === res.sessionId).length,
    1,
    'the parent keeps exactly its own guard'
  )

  // The child's own scoped registry was restricted to the attenuated grant and
  // the child's plan is enforced by its own guard.
  const childRestriction = host.calls.restrictions.find((entry) => entry.sessionId === child.sessionId)
  assert.deepEqual(childRestriction.filter.allow, ['read'])
  assert.equal(host.runTool(child.sessionId, 'subagent', { description: 'x' }).allowed, false)
  assert.equal(host.runTool(child.sessionId, 'pwsh', { command: 'x' }).allowed, false)
  assert.equal(host.runTool(child.sessionId, 'write', { file_path: path.join(ROOT, 'x.txt') }).allowed, false)

  // The child ran as a REAL session with the parent's verified route, driven
  // through its OWN agent seam. Generic session routing must never be used for an
  // `origin: 'subagent'` child: the installed host refuses it.
  const childDelivery = host.childMessages(child.sessionId)
  assert.equal(childDelivery.length, 1, 'the child session must receive exactly one bounded prompt through its own agent')
  assert.match(childDelivery[0].text, /read one file/)
  assert.equal(
    host.calls.prompt.some((entry) => entry.sessionId === child.sessionId),
    false,
    'a subagent-owned child is never driven through generic sessionController.prompt'
  )

  // Idempotent replay of the same childKey returns the same child.
  const replay = await spawn.execute(
    { childKey: 'c1', objective: 'read one file', tools: ['read'] },
    { agent: parentAgent, arguments: { childKey: 'c1', objective: 'read one file', tools: ['read'] } }
  )
  assert.equal(replay.childId, child.childId)
  assert.equal(replay.idempotentReplay, true)
  assert.equal(host.calls.agentCreate.length, 1, 'a replayed childKey must not start a second session')
  assert.equal(host.childMessages(child.sessionId).length, 1, 'a replayed childKey must not deliver a second child prompt')

  // Bounded wait observes the running child without releasing anything.
  const wait = await host
    .registeredDefinition(res.sessionId, 'dsh_child_wait')
    .execute({ childId: child.childId, waitMs: 5 }, { agent: parentAgent, arguments: { childId: child.childId, waitMs: 5 } })
  assert.equal(wait.state, 'running')
  assert.equal(wait.waitBoundMs, 5)
  assert.equal(supervisor.ledger.counts().children, 1)

  // The child's real turn settles through session events; the teardown is ASYNC
  // (AgentHandle.dispose is awaited), so the slot is released only once the
  // observed stop is proven and the owned child agent is really gone.
  claim(host, child.sessionId, childDelivery[0].requestId, 1)
  host.emitAssistant(child.sessionId, 1, 'child evidence')
  host.emitTurnEnd(child.sessionId, 1, { kind: 'completed' })
  assert.equal(
    await waitFor(() => supervisor.ledger.counts().children === 0),
    true,
    'the child slot is released once the async teardown proves the stop'
  )
  assert.equal(host.agents.get(child.sessionId), undefined, 'the owned AgentHandle was disposed: no live child agent remains')
  const result = await host
    .registeredDefinition(res.sessionId, 'dsh_child_result')
    .execute({ childId: child.childId }, { agent: parentAgent, arguments: { childId: child.childId } })
  assert.equal(result.state, 'completed')
  assert.equal(result.stopConfirmed, true)
  assert.match(result.text, /child evidence/)
})

test('the child drive seam survives the installed host refusal of generic session routing for an origin=subagent child (actual-host regression)', async () => {
  // Reproduces F:/DSH/.bridge-autonomy-a-txrPCx/report.json: `agents.create` PUBLISHED
  // the child, then `sessionController.prompt` was refused with `session/agent-busy`
  // ("owned by subagent routing") and the published child had to be torn down. The
  // double now enforces the same ownership rule, and the adapter must drive the child
  // through the child agent's own `followup` seam instead.
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 600000, maxToolCalls: 5 }, scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  const parentAgent = host.agents.get(res.sessionId)
  const parentGuardsBefore = host.scopedGuards.filter((entry) => entry.sessionId === res.sessionId).length

  // The ownership refusal itself: generic routing refuses this identity, so a child
  // driven that way can never start.
  const stranger = { id: 'agent-busy-probe', session: { id: 'agent-busy-probe', header: { id: 'agent-busy-probe', cwd: ROOT, origin: 'subagent' } } }
  const baseGet = host.ctx.get.bind(host.ctx)
  const baseController = baseGet('sessionController')
  host.ctx.get = (name) =>
    name !== 'sessionController'
      ? baseGet(name)
      : {
          ...baseController,
          // The router first proves the session belongs to subagent routing (the
          // installed host resolves it through the agent registry), then refuses.
          prompt: async (request, signal) => {
            const owner = host.agents.get(request.sessionId) ?? stranger
            if (owner?.session?.header?.origin === 'subagent') {
              throw Object.assign(new Error(`session "${request.sessionId}" is owned by subagent routing`), {
                code: 'session/agent-busy',
                reason: 'use subagent delivery for this child session'
              })
            }
            return baseController.prompt(request, signal)
          },
          cancel: (request) => {
            const owner = host.agents.get(request.sessionId) ?? stranger
            if (owner?.session?.header?.origin === 'subagent') {
              throw Object.assign(new Error(`session "${request.sessionId}" is owned by subagent routing`), {
                code: 'session/agent-busy',
                reason: 'use subagent delivery for this child session'
              })
            }
            return baseController.cancel(request)
          }
        }
  try {
    await assert.rejects(
      () => host.ctx.get('sessionController').prompt({ requestId: 'probe', sessionId: stranger.id, mode: 'queue', content: [{ type: 'text', text: 'p' }] }),
      (error) => error.code === 'session/agent-busy' && /owned by subagent routing/.test(error.message),
      'the generic prompt seam must really refuse a subagent-owned identity in this double'
    )

    const child = await host
      .registeredDefinition(res.sessionId, 'dsh_child_spawn')
      .execute({ childKey: 'live', objective: 'read one file', tools: ['read'] }, { agent: parentAgent, arguments: {} })

    // The child is REALLY published and started, under its own identity and lineage.
    assert.equal(child.state, 'running')
    assert.equal(child.depth, 1)
    assert.equal(child.lineage, 'agents.create')
    assert.equal(child.enforcement.guardInstalled, true)
    assert.equal(child.enforcement.dispatchMechanism, 'scoped-monotonic-guard')
    assert.equal(child.enforcement.driveMechanism, 'child-agent.followup')
    const childAgent = host.agents.get(child.sessionId)
    assert.ok(childAgent, 'the child agent really exists in the registry')
    assert.equal(childAgent.session.header.origin, 'subagent', 'the child keeps its subagent-owned identity')
    assert.equal(childAgent.session.header.delegationDepth, 1)

    // Exactly ONE prompt, delivered through that child agent; generic routing was
    // never asked to carry it.
    const deliveries = host.childMessages(child.sessionId)
    assert.equal(deliveries.length, 1, 'the child receives exactly one bounded prompt')
    assert.match(deliveries[0].text, /read one file/)
    assert.equal(host.calls.prompt.some((entry) => entry.sessionId === child.sessionId), false)
    // The route is proven from what the host really PUBLISHED on the live child, never
    // from generic controller mutation: the installed controller refuses an
    // `origin: 'subagent'` identity, so `selectModel` must not be asked to carry a
    // child route and a tolerated refusal must never be counted as confirmation.
    assert.equal(
      host.calls.selectModel.some((entry) => entry.sessionId === child.sessionId),
      false,
      'generic sessionController.selectModel is never used for a subagent-owned child route'
    )
    // The real controller refusal this regression models: had the adapter asked the
    // generic seam to route the child, `session/agent-busy` ("owned by subagent
    // routing") would be the only possible answer -- never a confirmed route.
    await assert.rejects(
      () =>
        host.ctx.get('sessionController').selectModel({
          sessionId: child.sessionId,
          provider: 'deepseek-official',
          model: 'deepseek-flash'
        }),
      (error) => error.code === 'session/agent-busy' && /owned by subagent routing/.test(error.message),
      'the generic model seam must really refuse a subagent-owned identity in this double'
    )
    assert.deepEqual(childAgent.options, { provider: 'deepseek-official', model: 'deepseek-flash', subagentDepth: 1 })
    assert.equal(child.enforcement.routeVerified, true, 'the published child route was verified before delivery')
    assert.deepEqual(child.enforcement.modelRoute, { provider: 'deepseek-official', model: 'deepseek-flash' })
    // The child joined its parent's composed agent plane inside its OWN creation
    // window, before the guard and before any delivery.
    assert.equal(child.enforcement.compositionJoined, true)
    const composition = host.calls.composeFrom.find((entry) => entry.childSessionId === child.sessionId)
    assert.ok(composition, 'the child must join its parent preset through the applyChildComposition seam')
    assert.equal(composition.childCtxIsScoped, true, 'the join is registered through the CHILD context')
    assert.equal(composition.parentCtxIsParent, true, 'the join names the real delegating parent context')
    assert.deepEqual(composition.joinedTools, ['read'])

    // The child's monotonic guard is scoped to the CHILD, never to the parent.
    assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === child.sessionId).length, 1)
    assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === res.sessionId).length, parentGuardsBefore)

    // Authorized in-root read works; delegation, shell, out-of-root and widening are denied.
    assert.equal(host.runTool(child.sessionId, 'read', { file_path: ROOT }, 'r-ok').allowed, true)
    assert.equal(host.runTool(child.sessionId, 'read', { file_path: OUTSIDE }, 'r-out').allowed, false)
    assert.equal(host.runTool(child.sessionId, 'subagent', { description: 'x' }, 'r-del').allowed, false)
    assert.equal(host.runTool(child.sessionId, 'pwsh', { command: 'echo hi' }, 'r-sh').allowed, false)
    await captureFailure(
      () =>
        host
          .registeredDefinition(res.sessionId, 'dsh_child_spawn')
          .execute({ childKey: 'wide', objective: 'o', readRoots: [OUTSIDE] }, { agent: parentAgent, arguments: {} }),
      'supervisor/grant-widened'
    )
    assert.equal(host.calls.agentCreate.length, 1, 'a refused widening creates no second child session')

    // The child settles through real events and its slot is released only after the
    // owned handle's disposal was observed.
    claim(host, child.sessionId, deliveries[0].requestId, 1)
    host.emitAssistant(child.sessionId, 1, 'child evidence')
    host.emitTurnEnd(child.sessionId, 1, { kind: 'completed' })
    assert.equal(await waitFor(() => supervisor.ledger.counts().children === 0), true)
    assert.equal(host.agents.get(child.sessionId), undefined, 'the owned AgentHandle was disposed')
  } finally {
    host.ctx.get = baseGet
  }
})

test('the child route is fixed with an explicit reasoningEffort and verified from the published agent options', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makeEnvelope({
      effectiveModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      packet: { budget: { timeoutMs: 600000, maxToolCalls: 5 }, scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }
    })
  )
  const parentAgent = host.agents.get(res.sessionId)
  const child = await host
    .registeredDefinition(res.sessionId, 'dsh_child_spawn')
    .execute({ childKey: 'route', objective: 'read one file', tools: ['read'] }, { agent: parentAgent, arguments: {} })

  const created = host.calls.agentCreate.find((entry) => entry.sessionId === child.sessionId)
  assert.ok(created, 'the child was created through agents.create')
  // The COMPLETE route (provider/model/reasoningEffort) is handed to the child loop at
  // creation time, exactly like the installed in-process driver.
  assert.deepEqual(created.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    subagentDepth: 1
  })
  const childAgent = host.agents.get(child.sessionId)
  assert.deepEqual(childAgent.options, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    subagentDepth: 1
  })
  // The published triple is verified before the first delivery and reported exactly.
  assert.equal(child.enforcement.routeVerified, true)
  assert.deepEqual(child.enforcement.modelRoute, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(
    host.calls.selectModel.some((entry) => entry.sessionId === child.sessionId),
    false,
    'the child route is never confirmed through generic sessionController mutation'
  )
  assert.equal(host.childMessages(child.sessionId).length, 1, 'the verified child is driven exactly once')
  assert.equal(child.enforcement.compositionJoined, true, 'the child was composed before it was driven')
  const delegation = host.calls.systemPromptContexts.find((entry) => entry.childSessionId === child.sessionId)
  assert.ok(delegation, 'the fixed delegation-scope statement is registered on the child')
  assert.equal(delegation.contribution.name, 'subagent:delegation')
})

test('a missing, wrong or effort-mismatched published child route fails closed before any delivery', async () => {
  for (const [label, hostOptions] of [
    ['host ignores the creation-time options', { createIgnoresAgentOptions: true }],
    ['host publishes a different model', { createChildRouteOverride: { model: 'deepseek-v4-astra' } }],
    ['host publishes a different reasoning effort', { createChildRouteOverride: { reasoningEffort: 'xhigh' } }]
  ]) {
    const host = createFakeHost(hostOptions)
    const supervisor = supervisorFor()
    const adapter = new DshAdapter(host.ctx, { supervisor })
    const res = await adapter.start(
      makeEnvelope({
        effectiveModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
        packet: { scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }
      })
    )
    const parentAgent = host.agents.get(res.sessionId)
    const error = await captureFailure(
      () =>
        host
          .registeredDefinition(res.sessionId, 'dsh_child_spawn')
          .execute({ childKey: 'bad-route', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} }),
      'supervisor/child-create-failed'
    )
    assert.match(error.message, /did not carry the requested model route/, `${label}: ${error.message}`)
    const attemptedSessionId = host.calls.agentCreate.at(-1).sessionId
    assert.equal(
      host.childMessages(attemptedSessionId).length,
      0,
      `${label}: a child whose route could not be verified must never be driven`
    )
    assert.equal(host.agents.get(attemptedSessionId), undefined, `${label}: the unverified child was torn down`)
    assert.equal(supervisor.ledger.counts().children, 0, `${label}: the reservation was released only after a proven teardown`)
    const failed = supervisor.findChild(error.details.childId)
    assert.equal(failed.state, 'failed', `${label}: the child must be recorded failed, not running`)
    assert.equal(failed.stopConfirmed, true, `${label}: the torn-down child's stop is proven`)
  }
})

test('a throwing child followup is a real failure: the published child is torn down, never reported started', async () => {
  const host = createFakeHost({ followupThrows: true })
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 600000, maxToolCalls: 5 }, scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  const parentAgent = host.agents.get(res.sessionId)
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')

  const error = await captureFailure(() => spawn.execute({ childKey: 'throwing', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} }), 'supervisor/child-create-failed')
  assert.match(error.message, /could not be driven through its own agent/, `the real delivery failure must surface: ${error.message}`)
  const attemptedSessionId = host.calls.agentCreate.at(-1).sessionId
  // The delivery was really attempted exactly once and its throw was never swallowed.
  assert.equal(host.calls.followup.filter((entry) => entry.sessionId === attemptedSessionId).length, 1)
  assert.equal(host.agents.get(attemptedSessionId), undefined, 'the published child was disposed')
  assert.equal(supervisor.ledger.counts().children, 0, 'the slot is released only on the observed teardown')
  const failed = supervisor.findChild(error.details.childId)
  assert.equal(failed.state, 'failed', 'a child whose delivery threw is never reported running')
  assert.equal(failed.stopConfirmed, true, 'the teardown proof is truthful')
})

test('a child scope with no agent-preset join is refused before publication, never run uncomposed', async () => {
  for (const [label, hostOptions] of [
    ['no agentPresets service', { childPresetsUnavailable: true }],
    ['agentPresets without composeFrom', { childComposeFromUnavailable: true }]
  ]) {
    const host = createFakeHost(hostOptions)
    const supervisor = supervisorFor()
    const adapter = new DshAdapter(host.ctx, { supervisor })
    const res = await adapter.start(
      makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
    )
    const parentAgent = host.agents.get(res.sessionId)
    const error = await captureFailure(
      () =>
        host
          .registeredDefinition(res.sessionId, 'dsh_child_spawn')
          .execute({ childKey: 'uncomposed', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} }),
      'supervisor/child-create-failed'
    )
    assert.match(error.message, /agent-preset join/, `${label}: the missing composition seam must be named: ${error.message}`)
    assert.equal(host.calls.composeFrom.length, 0, `${label}: nothing may claim a composition join that never happened`)
    assert.equal(host.calls.followup.length, 0, `${label}: an uncomposed child is never driven`)
    assert.equal(supervisor.ledger.counts().children, 0, `${label}: the failed reservation is released`)
    assert.equal(host.calls.prompt.length, 1, `${label}: only the root prompt may exist`)
  }
})

test('a live child cancel goes through the child agent and keeps an unproven stop counted', async () => {
  // Generic `sessionController.cancel` is refused for a subagent-owned child, so the
  // adapter must request the stop through the child's own agent. Even then the slot is
  // released only on observed proof, never on the request itself.
  const host = createFakeHost() // the double's agent cancel emits no turn/end: stop unproven
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor, stopConfirmTimeoutMs: 20 })
  const res = await adapter.start(
    makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  const parentAgent = host.agents.get(res.sessionId)
  const child = await host
    .registeredDefinition(res.sessionId, 'dsh_child_spawn')
    .execute({ childKey: 'live-cancel', objective: 'slow child', tools: ['read'] }, { agent: parentAgent, arguments: {} })
  assert.equal(supervisor.ledger.counts().children, 1)

  const cancelled = await host
    .registeredDefinition(res.sessionId, 'dsh_child_cancel')
    .execute({ childId: child.childId, reason: 'operator stop' }, { agent: parentAgent, arguments: {} })
  const stopRequest = host.calls.agentCancel.find((entry) => entry.sessionId === child.sessionId)
  assert.ok(stopRequest, 'the child stop was requested through the child agent')
  assert.deepEqual(stopRequest.cause, { kind: 'parent' })
  assert.equal(
    host.calls.cancel.some((entry) => entry.sessionId === child.sessionId),
    false,
    'generic sessionController.cancel is never used for a subagent-owned child'
  )
  assert.equal(cancelled.stopConfirmed, false, 'an unobserved stop is never reported as confirmed')
  assert.equal(cancelled.outcome, 'unknown')
  assert.equal(supervisor.ledger.counts().children, 1, 'the shared ledger slot is retained until the stop is observed')
  const result = await host
    .registeredDefinition(res.sessionId, 'dsh_child_result')
    .execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(result.stopConfirmed, false)
  assert.equal(result.enforcement.stopMechanism, 'child-agent.cancel')
})

test('a child whose global-only restrict throws still starts under its own monotonic guard (actual-host regression)', async () => {
  // Reproduces the real host: the child's agent-plane tools (e.g. `read`) live in the
  // child's OWN scope layer, so tools.restrict() cannot name them and throws. That
  // presentation-only failure must NOT reject a safely guarded child.
  const host = createFakeHost({ childRestrictFails: true })
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 600000, maxToolCalls: 5 }, scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  const parentAgent = host.agents.get(res.sessionId)
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentGuardsBefore = host.scopedGuards.filter((entry) => entry.sessionId === res.sessionId).length
  assert.equal(parentGuardsBefore, 1, 'the root itself is guarded before any child exists')

  const child = await spawn.execute(
    { childKey: 'restrict-fail', objective: 'read one file', tools: ['read'] },
    { agent: parentAgent, arguments: { childKey: 'restrict-fail', objective: 'read one file', tools: ['read'] } }
  )
  assert.equal(child.state, 'running', 'a failing global-only mask must not fail the child')
  assert.equal(child.enforcement.guardInstalled, true, 'the child-owned dispatch guard must be installed before the first prompt')
  assert.equal(child.enforcement.dispatchMechanism, 'scoped-monotonic-guard')
  assert.equal(child.enforcement.restrictApplied, false, 'a failed restrict must never be reported as applied')
  assert.equal(child.enforcement.driveMechanism, 'child-agent.followup', 'the child is driven through its own agent seam')
  assert.match(child.enforcement.notes.join(' '), /tools\.restrict\(\) failed/)
  assert.match(child.enforcement.notes.join(' '), /unknown global tool "read"/, 'the real failure message is recorded verbatim')

  // The guard is owned by the CHILD session; no child guard may be scoped onto the parent.
  assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === child.sessionId).length, 1)
  assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === res.sessionId).length, parentGuardsBefore, 'the parent guard is untouched')
  assert.equal(host.calls.restrictions.some((entry) => entry.sessionId === child.sessionId), false, 'the failing child restrict registered nothing')

  // Exactly one bounded child prompt, delivered through the child's own agent.
  const guardedDelivery = host.childMessages(child.sessionId)
  assert.equal(guardedDelivery.length, 1, 'the guarded child must receive exactly one bounded prompt')
  assert.match(guardedDelivery[0].text, /read one file/)
  assert.equal(
    host.calls.prompt.some((entry) => entry.sessionId === child.sessionId),
    false,
    'the guarded child is driven through its own agent, never generic session routing'
  )

  // Authorized in-root read is admitted; native delegation, shell, out-of-root read
  // and out-of-grant writes are denied BEFORE dispatch.
  assert.equal(host.runTool(child.sessionId, 'read', { file_path: ROOT }, 'c-read-1').allowed, true)
  assert.equal(host.runTool(child.sessionId, 'subagent', { description: 'x' }, 'c-del').allowed, false)
  assert.equal(host.runTool(child.sessionId, 'pwsh', { command: 'echo hi' }, 'c-shell').allowed, false)
  assert.equal(host.runTool(child.sessionId, 'read', { file_path: OUTSIDE }, 'c-out').allowed, false)
  assert.equal(host.runTool(child.sessionId, 'write', { file_path: path.join(ROOT, 'x.txt') }, 'c-write').allowed, false)

  // Admitted child starts are charged to the child budget.
  const listed = await host
    .registeredDefinition(res.sessionId, 'dsh_child_list')
    .execute({}, { agent: parentAgent, arguments: {} })
  const live = listed.children.find((entry) => entry.childId === child.childId)
  assert.equal(live.budgets.toolStarts, 1, 'the admitted read is charged exactly once')

  // The parent plane still works: no parent narrowing from the child guard.
  assert.equal(host.runTool(res.sessionId, 'read', { file_path: ROOT }, 'p-read').allowed, true)
})

test('a child with no guard, a throwing guard, or a parent-context setup is refused before any prompt and releases its slot', async () => {
  for (const [label, options, expected] of [
    // Guard absent AND restrict throwing: the mandatory guard must be resolved first,
    // so the mask call is never attempted and the refusal names the missing guard.
    ['missing guard', { childGuardUnavailable: true, childRestrictFails: true }, /exposes no monotonic guard/],
    ['throwing guard', { childGuardThrows: true }, /guard unsupported in this child scope/],
    ['no child tools registry', { childToolsUnavailable: true }, /no tools registry/],
    // A setup that exposes the PARENT context must be refused: registering there
    // would scope the child guard onto the parent.
    ['parent context mis-scope', { childSetupUsesParentCtx: true }, /parent agent context/]
  ]) {
    const host = createFakeHost(options)
    const supervisor = supervisorFor()
    const adapter = new DshAdapter(host.ctx, { supervisor })
    const res = await adapter.start(
      makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
    )
    const parentAgent = host.agents.get(res.sessionId)
    const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
    const failure = await captureFailure(
      () =>
        spawn.execute(
          { childKey: 'blocked', objective: 'o', tools: ['read'] },
          { agent: parentAgent, arguments: { childKey: 'blocked', objective: 'o', tools: ['read'] } }
        ),
      'supervisor/child-create-failed'
    )
    assert.match(failure.message, expected, `${label}: the refusal must name the unavailable guard`)
    assert.equal(host.calls.prompt.length, 1, `${label}: only the root prompt may exist`)
    assert.equal(supervisor.ledger.counts().children, 0, `${label}: the reservation must be released`)
    assert.equal(host.scopedGuards.filter((entry) => entry.sessionId !== res.sessionId).length, 0, `${label}: no child guard may exist`)
    assert.equal(host.calls.restrictions.length, 1, `${label}: only the root restriction may exist`)
  }
})

test('a guarded child lifts its own guard and slot on observed settlement, leaving the parent guard intact', async () => {
  const host = createFakeHost({ childRestrictFails: true })
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  const parentAgent = host.agents.get(res.sessionId)
  const parentGuardsBefore = host.scopedGuards.filter((entry) => entry.sessionId === res.sessionId).length
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const child = await spawn.execute(
    { childKey: 'cleanup', objective: 'o', tools: ['read'] },
    { agent: parentAgent, arguments: { childKey: 'cleanup', objective: 'o', tools: ['read'] } }
  )
  assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === child.sessionId).length, 1)

  const childDelivery = host.childMessages(child.sessionId)
  assert.equal(childDelivery.length, 1)
  claim(host, child.sessionId, childDelivery[0].requestId, 1)
  host.emitAssistant(child.sessionId, 1, 'child evidence')
  host.emitTurnEnd(child.sessionId, 1, { kind: 'completed' })
  assert.equal(
    await waitFor(() => supervisor.ledger.counts().children === 0),
    true,
    'the child slot is released only on the observed stop'
  )
  assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === child.sessionId).length, 0, 'the child-owned guard disposer really lifted it')
  assert.equal(host.agents.get(child.sessionId), undefined, 'the owned child AgentHandle was disposed')
  assert.equal(host.scopedGuards.filter((entry) => entry.sessionId === res.sessionId).length, parentGuardsBefore, 'the parent guard is untouched')
  assert.equal(host.runTool(res.sessionId, 'read', { file_path: ROOT }, 'p-after').allowed, true)

  const result = await host
    .registeredDefinition(res.sessionId, 'dsh_child_result')
    .execute({ childId: child.childId }, { agent: parentAgent, arguments: { childId: child.childId } })
  assert.equal(result.state, 'completed')
  assert.equal(result.stopConfirmed, true)
  assert.equal(result.enforcement.guardInstalled, true)
})

test('child sessions are refused when the host disables them or the request widens the packet', async () => {
  const host = createFakeHost()
  const disabled = new DshAdapter(host.ctx, { supervisor: supervisorFor({ childSessions: { enabled: false } }) })
  await captureFailure(
    () => disabled.preflight(makePacket({ scope: { childSessions: { enabled: true } } })),
    'adapter/child-unsupported'
  )
  assert.deepEqual(host.calls.create, [], 'a refused child grant creates no session')

  const capped = new DshAdapter(host.ctx, { supervisor: supervisorFor({ childSessions: { enabled: true, maxChildrenPerTask: 1 } }) })
  await captureFailure(
    () => capped.preflight(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 9 } } })),
    'adapter/child-unsupported'
  )
})

/* ------------------------------------------- child budgets, teardown, events */

test('child tool budgets are admitted synchronously and charged once per distinct call against the child AND the shared root cap', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor({ limit: 8 })
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 600000, maxToolCalls: 2 }, scope: { childSessions: { enabled: true, maxChildren: 2, toolNames: ['read'] } } })
  )
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const childA = await spawn.execute({ childKey: 'a', objective: 'o', tools: ['read'], budgets: { maxToolCalls: 2 } }, { agent: parentAgent, arguments: {} })
  const childB = await spawn.execute({ childKey: 'b', objective: 'o', tools: ['read'], budgets: { maxToolCalls: 2 } }, { agent: parentAgent, arguments: {} })

  assert.equal(host.runTool(childA.sessionId, 'read', { file_path: ROOT }, 'a-1').allowed, true)
  assert.equal(host.runTool(childB.sessionId, 'read', { file_path: ROOT }, 'b-1').allowed, true)
  // A replay of the SAME provider call id is never billed twice.
  assert.equal(host.runTool(childA.sessionId, 'read', { file_path: ROOT }, 'a-1').allowed, true)
  // The shared root attempt budget is exhausted even though child B's own cap is not.
  const denied = host.runTool(childB.sessionId, 'read', { file_path: ROOT }, 'b-2')
  assert.equal(denied.allowed, false, 'the owning root attempt shared cap must deny the next child call')
  assert.match(denied.reason, /budget\.maxToolCalls=2/)
  assert.match(denied.reason, /shares its parent/)

  const snap = await host.registeredDefinition(res.sessionId, 'dsh_child_result').execute({ childId: childB.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(snap.budgets.toolStarts, 1, 'only honestly admitted starts are counted')
  assert.equal(snap.budgets.maxToolCalls, 2)
  assert.equal(snap.budgets.exhausted.budget, 'maxToolCalls')
  assert.equal(snap.budgets.exhausted.scope, 'root-shared')
})

test('a maxToolCalls=1 child admits exactly one distinct call and neither a spawn replay nor a wait resets its budget', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 600000, maxToolCalls: 5 }, scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const args = { childKey: 'one', objective: 'o', tools: ['read'], budgets: { maxToolCalls: 1 } }
  const child = await spawn.execute(args, { agent: parentAgent, arguments: args })
  assert.equal(host.runTool(child.sessionId, 'read', { file_path: ROOT }, 'c-1').allowed, true)
  const denied = host.runTool(child.sessionId, 'read', { file_path: ROOT }, 'c-2')
  assert.equal(denied.allowed, false)
  assert.match(denied.reason, /child tool-call budget exhausted \(budgets\.maxToolCalls=1\)/)

  const replay = await spawn.execute(args, { agent: parentAgent, arguments: args })
  assert.equal(replay.idempotentReplay, true)
  await host.registeredDefinition(res.sessionId, 'dsh_child_wait').execute({ childId: child.childId, waitMs: 5 }, { agent: parentAgent, arguments: {} })
  assert.equal(host.runTool(child.sessionId, 'read', { file_path: ROOT }, 'c-3').allowed, false, 'a wait must not reset the budget')
  const snap = await host.registeredDefinition(res.sessionId, 'dsh_child_result').execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(snap.budgets.toolStarts, 1)
})

test('child output is retained only up to its maxOutputChars grant and the truncation is reported', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 600000, maxToolCalls: 5, maxOutputChars: 200000 }, scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const child = await spawn.execute({ childKey: 'o', objective: 'o', tools: ['read'], budgets: { maxOutputChars: 20 } }, { agent: parentAgent, arguments: {} })
  const childDelivery = host.childMessages(child.sessionId)
  assert.equal(childDelivery.length, 1)
  claim(host, child.sessionId, childDelivery[0].requestId, 1)
  host.emitAssistant(child.sessionId, 1, 'x'.repeat(50))
  host.emitAssistant(child.sessionId, 1, 'y'.repeat(50))

  const result = await host.registeredDefinition(res.sessionId, 'dsh_child_result').execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(result.text, 'x'.repeat(20), 'only the bounded prefix is retained')
  assert.equal(result.totalChars, 20)
  assert.equal(result.retained.limit, 20)
  assert.equal(result.retained.truncated, true)
  assert.equal(result.retained.droppedChars, 80, 'the dropped characters are counted, never silently hidden')
})

test('a child own deadline is enforced and the slot is retained until a real stop is proven', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor, stopConfirmTimeoutMs: 20 })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 600000, maxToolCalls: 5 }, scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const child = await spawn.execute({ childKey: 'd', objective: 'o', tools: ['read'], budgets: { timeoutMs: 30 } }, { agent: parentAgent, arguments: {} })
  const definition = host.registeredDefinition(res.sessionId, 'dsh_child_result')

  const initial = await definition.execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(initial.budgets.deadlineMs, 30, 'the child own timeout is armed before its first prompt')
  assert.equal(initial.budgets.deadlineSource, 'child-budget')
  assert.equal(
    await waitFor(() => supervisor.findChild(child.childId).state === 'unknown', 2000),
    true,
    'the cooperative timeout marks the child unknown when the host never proves the stop'
  )
  assert.equal(supervisor.ledger.counts().children, 1, 'an unproven stop keeps the child slot')
  const after = await definition.execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(after.state, 'unknown')
  assert.equal(after.stopConfirmed, false)
  assert.equal(after.budgets.exhausted.budget, 'timeoutMs')
})

test('a child deadline can never exceed the parent attempt remaining deadline', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor, stopConfirmTimeoutMs: 20 })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 2000, maxToolCalls: 5 }, scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  )
  // Consume part of the parent's deadline so its REMAINING time is provably less
  // than the child's requested budget.
  await new Promise((resolve) => setTimeout(resolve, 200))
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const child = await spawn.execute({ childKey: 'clamp', objective: 'o', tools: ['read'], budgets: { timeoutMs: 2000 } }, { agent: parentAgent, arguments: {} })
  const initial = await host.registeredDefinition(res.sessionId, 'dsh_child_result').execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(initial.budgets.deadlineSource, 'parent-remaining', 'the parent remaining deadline is the effective one')
  assert.ok(initial.budgets.deadlineMs < 2000, 'the child cannot outlive the parent attempt')
  assert.ok(initial.budgets.deadlineMs >= 1)
})

test('a followup that synchronously emits a complete owned child turn is attributed and never overwritten by a later running state', async () => {
  // The host emits the child's whole turn from inside its OWN followup delivery:
  // child identity tracking and budgets are installed BEFORE the drive call, so
  // those events must still be attributed to this child.
  const host = createFakeHost({ earlyChildTurnOnFollowup: true })
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }))
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const child = await spawn.execute({ childKey: 'early', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} })
  assert.equal(child.state, 'completed', 'the early settlement is attributed, not overwritten by a later running state')
  assert.equal(child.stopConfirmed, true)
  assert.equal(child.enforcement.driveMechanism, 'child-agent.followup')
  assert.equal(await waitFor(() => supervisor.ledger.counts().children === 0), true)
  const result = await host.registeredDefinition(res.sessionId, 'dsh_child_result').execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(result.state, 'completed')
  assert.match(result.text, /early child evidence/)
})

test('a throwing AgentHandle.dispose is reported honestly: the child stays unknown and its slot is retained', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const baseGet = host.ctx.get.bind(host.ctx)
  const baseAgents = baseGet('agents')
  host.ctx.get = (name) => name !== 'agents' ? baseGet(name) : {
    ...baseAgents,
    create: async (request) => {
      const handle = await baseAgents.create(request)
      return { agent: handle.agent, dispose: async () => { throw new Error('dispose refused by the host') } }
    }
  }
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }))
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const child = await spawn.execute({ childKey: 'td', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} })
  const childDelivery = host.childMessages(child.sessionId)
  assert.equal(childDelivery.length, 1)
  claim(host, child.sessionId, childDelivery[0].requestId, 1)
  host.emitAssistant(child.sessionId, 1, 'done')
  host.emitTurnEnd(child.sessionId, 1, { kind: 'completed' })

  assert.equal(await waitFor(() => supervisor.findChild(child.childId).state === 'unknown'), true)
  assert.equal(supervisor.ledger.counts().children, 1, 'a failed teardown never releases the slot')
  const result = await host.registeredDefinition(res.sessionId, 'dsh_child_result').execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(result.state, 'unknown')
  assert.equal(result.stopConfirmed, false)
  assert.equal(result.teardown.state, 'failed')
})

test('a child published with an invalid handle is torn down as failed and never misreported as an unpublished slot release', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const baseGet = host.ctx.get.bind(host.ctx)
  const baseAgents = baseGet('agents')
  host.ctx.get = (name) => name !== 'agents' ? baseGet(name) : {
    ...baseAgents,
    // The session IS published, but the returned handle does not identify it.
    create: async (request) => {
      const handle = await baseAgents.create(request)
      return { agent: { ...handle.agent, id: 'not-the-session' }, dispose: handle.dispose }
    }
  }
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }))
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const failure = await captureFailure(
    () => spawn.execute({ childKey: 'bad', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} }),
    'supervisor/child-create-failed'
  )
  assert.equal(failure.details.outcome, 'failed')
  assert.equal(supervisor.ledger.counts().children, 0, 'the slot is released only after the published identity was really disposed')
  assert.equal(host.agents.has(failure.details.sessionId), false, 'the published identity was disposed, never left live')
  const recorded = supervisor.findChild(failure.details.childId)
  assert.equal(recorded.state, 'failed')
  assert.equal(recorded.stopConfirmed, true)
})

test('child teardown is idempotent: repeated terminal events and a post-settlement cancel dispose the handle exactly once', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  let disposeCalls = 0
  const baseGet = host.ctx.get.bind(host.ctx)
  const baseAgents = baseGet('agents')
  host.ctx.get = (name) => name !== 'agents' ? baseGet(name) : {
    ...baseAgents,
    create: async (request) => {
      const handle = await baseAgents.create(request)
      return { agent: handle.agent, dispose: async () => { disposeCalls += 1; await handle.dispose() } }
    }
  }
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }))
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const child = await spawn.execute({ childKey: 'idem', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} })
  const childDelivery = host.childMessages(child.sessionId)
  assert.equal(childDelivery.length, 1)
  claim(host, child.sessionId, childDelivery[0].requestId, 1)
  host.emitTurnEnd(child.sessionId, 1, { kind: 'completed' })
  host.emitTurnEnd(child.sessionId, 1, { kind: 'completed' })
  assert.equal(await waitFor(() => supervisor.ledger.counts().children === 0), true)
  assert.equal(disposeCalls, 1, 'the owned handle is disposed exactly once')

  const cancelled = await host.registeredDefinition(res.sessionId, 'dsh_child_cancel').execute({ childId: child.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(cancelled.cancelled, false)
  assert.equal(cancelled.alreadyFinished, true)
  assert.equal(disposeCalls, 1)
})

test('a host with no owned disposable child seam refuses a child grant before creating any session or reservation', async () => {
  const host = createFakeHost()
  // Keep the host's `sessionController.create` (it exists) but remove the ONLY
  // supported seam: `agents.create` with an owned, disposable AgentHandle.
  const baseGet = host.ctx.get.bind(host.ctx)
  const baseAgents = baseGet('agents')
  host.ctx.get = (name) => (name !== 'agents' ? baseGet(name) : { ...baseAgents, create: undefined })
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })

  const caps = await adapter.capabilities()
  assert.equal(caps.supervisor.children.supported, false, 'an un-cleanable child mode is never advertised as supported')
  assert.equal(caps.supervisor.children.lineage, null)
  assert.match(caps.supervisor.children.reason, /disposable AgentHandle/)
  assert.match(caps.supervisor.children.reason, /sessionController\.create/)

  const packet = makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } })
  await captureFailure(() => adapter.preflight(packet), 'adapter/child-unsupported')
  await captureFailure(() => adapter.start(packet), 'adapter/child-unsupported')
  assert.deepEqual(host.calls.create, [], 'a refused child grant creates no session through sessionController.create')
  assert.deepEqual(host.calls.agentCreate ?? [], [], 'a refused child grant creates no owned agent')
  assert.equal(supervisor.ledger.counts().children, 0, 'a refused child grant reserves no child slot')
  assert.equal(supervisor.ledger.counts().used, 0, 'a refused child grant leaks no reservation at all')

  // Ordinary tasks without a child grant stay usable on the same host.
  const ordinary = await adapter.start(makePacket())
  assert.equal(typeof ordinary.sessionId, 'string')
})

test('parent cancellation awaits the in-flight child turn/end settlement and emits child/settled exactly once', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const events = []
  let release
  const deferredDispose = new Promise((resolve) => {
    release = resolve
  })
  // Model the installed host: `AgentHandle.dispose()` really removes the child
  // identity, but its promise settles ASYNCHRONOUSLY — after the child's own
  // `turn/end` already marked the child terminal. The parent's descendant cancel
  // therefore races the same child settlement.
  const baseGet = host.ctx.get.bind(host.ctx)
  const baseAgents = baseGet('agents')
  host.ctx.get = (name) =>
    name !== 'agents'
      ? baseGet(name)
      : {
          ...baseAgents,
          create: async (request) => {
            const handle = await baseAgents.create(request)
            return {
              agent: handle.agent,
              dispose: async () => {
                await deferredDispose
                host.deleteAgent(request.sessionId)
              }
            }
          }
        }
  const adapter = new DshAdapter(host.ctx, { supervisor, stopConfirmTimeoutMs: 200 })
  const envelope = makeEnvelope({ id: 'task-child-race', packet: { scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } } })
  const res = await adapter.start(envelope, { onEvent: (event) => events.push(event) })
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const child = await spawn.execute({ childKey: 'race', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} })
  const childDelivery = host.childMessages(child.sessionId)
  assert.equal(childDelivery.length, 1)
  // The child's own turn is live when the parent is cancelled.
  claim(host, child.sessionId, childDelivery[0].requestId, 1)
  assert.equal(supervisor.findChild(child.childId).state, 'running')

  // The real host answers the child's OWN `agent.cancel()` with its `turn/end`, so
  // the parent's descendant cancel runs concurrently with that settlement.
  const childAgent = host.agents.get(child.sessionId)
  const baseChildCancel = childAgent.cancel.bind(childAgent)
  childAgent.cancel = (cause, options) => {
    baseChildCancel(cause, options)
    host.emitTurnEnd(child.sessionId, 1, { kind: 'aborted', reason: { kind: 'parent' } })
    host.setStatus(child.sessionId, 'idle')
  }
  // The root's own attempt is terminal and its agent idle before the cancel, so the
  // root stop is decidable without consuming the generic confirm window.
  claim(host, res.sessionId, res.requestId, 1)
  host.setStatus(res.sessionId, 'idle')
  host.emitTurnEnd(res.sessionId, 1, { kind: 'aborted', reason: { kind: 'user' } })

  const eventTypes = () => events.map((event) => event.type)
  const cancelPromise = adapter.cancel({ id: 'task-child-race' })
  let cancelResolved = false
  const markResolved = () => {
    cancelResolved = true
  }
  cancelPromise.then(markResolved, markResolved)
  await new Promise((resolve) => setTimeout(resolve, 25))
  // The child stop was observed (its own turn/end plus an idle agent), but its
  // teardown is still pending. The parent cancel must await that real teardown
  // outcome instead of returning early and letting a post-settlement task event
  // gate drop the only child/settled evidence.
  assert.equal(events.filter((event) => event.type === 'child/stop-requested').length, 1, 'the child stop request is durable')
  assert.equal(cancelResolved, false, 'the parent cancel must await the in-flight child teardown outcome')
  assert.equal(eventTypes().filter((type) => type === 'child/settled').length, 0, 'child/settled is emitted only after the real teardown outcome')

  release()
  const outcome = await cancelPromise
  assert.equal(outcome.stopConfirmed, true, `stop was not confirmed: ${JSON.stringify(outcome)}`)
  assert.equal(eventTypes().filter((type) => type === 'child/settled').length, 1, 'child/settled is emitted exactly once')
  assert.equal(eventTypes().filter((type) => type === 'child/teardown').length, 1, 'child/teardown is emitted exactly once')
  assert.equal(host.agents.get(child.sessionId), undefined, 'the owned child handle was disposed')
  assert.equal(supervisor.ledger.counts().children, 0, 'the slot is released only after the observed teardown')
})

test('a confirmed dsh_child_cancel awaits the child settlement and reports its real teardown outcome', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const events = []
  const adapter = new DshAdapter(host.ctx, { supervisor, stopConfirmTimeoutMs: 200 })
  const res = await adapter.start(
    makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }),
    { onEvent: (event) => events.push(event) }
  )
  const parentAgent = host.agents.get(res.sessionId)
  const child = await host
    .registeredDefinition(res.sessionId, 'dsh_child_spawn')
    .execute({ childKey: 'cancel-confirmed', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} })
  const childDelivery = host.childMessages(child.sessionId)
  assert.equal(childDelivery.length, 1)
  claim(host, child.sessionId, childDelivery[0].requestId, 1)
  // The real host answers the child's own `agent.cancel()` with its `turn/end`.
  const childAgent = host.agents.get(child.sessionId)
  const baseChildCancel = childAgent.cancel.bind(childAgent)
  childAgent.cancel = (cause, options) => {
    baseChildCancel(cause, options)
    host.emitTurnEnd(child.sessionId, 1, { kind: 'aborted', reason: { kind: 'parent' } })
    host.setStatus(child.sessionId, 'idle')
  }
  const cancelled = await host
    .registeredDefinition(res.sessionId, 'dsh_child_cancel')
    .execute({ childId: child.childId, reason: 'operator stop' }, { agent: parentAgent, arguments: {} })
  assert.equal(cancelled.cancelled, true, `cancel was not confirmed: ${JSON.stringify(cancelled)}`)
  assert.equal(cancelled.stopConfirmed, true)
  assert.equal(cancelled.settlementOutcome, 'disposed')
  assert.equal(events.filter((event) => event.type === 'child/settled').length, 1, 'child/settled is emitted exactly once')
  assert.equal(events.filter((event) => event.type === 'child/teardown').length, 1, 'child/teardown is emitted exactly once')
  assert.equal(supervisor.ledger.counts().children, 0, 'the slot is released only after the observed teardown')
})

test('two distinct children with the identical provider callId consume two shared root budget units, once each', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(
    makePacket({ budget: { timeoutMs: 600000, maxToolCalls: 2 }, scope: { childSessions: { enabled: true, maxChildren: 2, toolNames: ['read'] } } })
  )
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  const parentAgent = host.agents.get(res.sessionId)
  const childA = await spawn.execute({ childKey: 'id-a', objective: 'o', tools: ['read'], budgets: { maxToolCalls: 2 } }, { agent: parentAgent, arguments: {} })
  const childB = await spawn.execute({ childKey: 'id-b', objective: 'o', tools: ['read'], budgets: { maxToolCalls: 2 } }, { agent: parentAgent, arguments: {} })

  // SAME provider callId in two DIFFERENT child sessions: identities are distinct,
  // so each consumes exactly one shared root budget unit.
  assert.equal(host.runTool(childA.sessionId, 'read', { file_path: ROOT }, 'shared-id').allowed, true)
  assert.equal(host.runTool(childB.sessionId, 'read', { file_path: ROOT }, 'shared-id').allowed, true)
  // A replay of the same id in the SAME child never double-charges.
  assert.equal(host.runTool(childA.sessionId, 'read', { file_path: ROOT }, 'shared-id').allowed, true)
  // The shared root cap of 2 is exhausted by exactly those two distinct identities.
  const denied = host.runTool(childA.sessionId, 'read', { file_path: ROOT }, 'third-id')
  assert.equal(denied.allowed, false, 'the shared root cap must deny the third distinct identity')
  assert.match(denied.reason, /budget\.maxToolCalls=2/)
  assert.match(denied.reason, /shares its parent/)

  const snapA = await host.registeredDefinition(res.sessionId, 'dsh_child_result').execute({ childId: childA.childId }, { agent: parentAgent, arguments: {} })
  const snapB = await host.registeredDefinition(res.sessionId, 'dsh_child_result').execute({ childId: childB.childId }, { agent: parentAgent, arguments: {} })
  assert.equal(snapA.budgets.toolStarts, 1, 'child A admitted exactly one distinct identity')
  assert.equal(snapB.budgets.toolStarts, 1, 'child B admitted exactly one distinct identity')
})

test('a child admission never suppresses a genuine root durable-only tool/start with the same callId', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const events = []
  const res = await adapter.start(
    makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }),
    { onEvent: (event) => events.push(event) }
  )
  claim(host, res.sessionId, res.requestId, 1)
  const parentAgent = host.agents.get(res.sessionId)
  const child = await host
    .registeredDefinition(res.sessionId, 'dsh_child_spawn')
    .execute({ childKey: 'collide', objective: 'o', tools: ['read'] }, { agent: parentAgent, arguments: {} })
  assert.equal(host.runTool(child.sessionId, 'read', { file_path: ROOT }, 'collide-id').allowed, true)

  // The root was never announced for this id: a child identity must not occupy the
  // root dedup set, or the root's durable-only dispatch is silently lost.
  host.emitToolCall(res.sessionId, 1, 'read', 'collide-id')
  const roots = events.filter((event) => event.type === 'tool/start' && event.callId === 'collide-id')
  assert.equal(roots.length, 1, 'the root durable-only tool/start is emitted exactly once')
  assert.equal(roots[0].source, 'durable-event')
  // The root's own dedup still works: a repeated durable root event emits nothing new.
  host.emitToolCall(res.sessionId, 1, 'read', 'collide-id')
  assert.equal(events.filter((event) => event.type === 'tool/start' && event.callId === 'collide-id').length, 1)
})

test('adapter.dispose reports initiated/pending teardown and never releases a child slot on a deferred dispose', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  let release
  const deferred = new Promise((resolve) => {
    release = resolve
  })
  const baseGet = host.ctx.get.bind(host.ctx)
  const baseAgents = baseGet('agents')
  host.ctx.get = (name) =>
    name !== 'agents'
      ? baseGet(name)
      : {
          ...baseAgents,
          create: async (request) => {
            const handle = await baseAgents.create(request)
            // The host keeps the agent until its dispose promise settles, so the
            // stop stays UNPROVEN for as long as the promise is in flight.
            return { agent: handle.agent, dispose: () => deferred }
          }
        }
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const res = await adapter.start(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }))
  const child = await host
    .registeredDefinition(res.sessionId, 'dsh_child_spawn')
    .execute({ childKey: 'deferred', objective: 'o', tools: ['read'] }, { agent: host.agents.get(res.sessionId), arguments: {} })
  assert.equal(supervisor.ledger.counts().children, 1)

  const report = adapter.dispose()
  assert.equal(report.disposed, true)
  assert.equal(report.childrenTeardownInitiated, 1, 'the deferred dispose is reported as INITIATED')
  assert.equal(report.childrenTeardownPending, 1, 'the in-flight dispose promise is reported as PENDING')
  assert.equal(report.childrenTeardownCompleted, 0, 'nothing is completed before the promise settles')
  assert.equal(report.childrenTornDown, 0, 'childrenTornDown is the observed-completed count, not the initiation count')
  assert.equal(report.childStopsProven, false)
  assert.equal(supervisor.ledger.counts().children, 1, 'the slot is retained while the stop is unproven')
  assert.equal(supervisor.findChild(child.childId).stopConfirmed, false)

  // Even after the deferred dispose settles, no slot is released: only observed
  // absence of a live agent is proof of a stop.
  release()
  await deferred
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(supervisor.ledger.counts().children, 1, 'resolving the dispose promise alone never releases the slot')
  assert.equal(host.agents.get(child.sessionId) !== undefined, true, 'the fake host still holds the agent, so the stop stays unproven')
})

test('the root reply uses the persisted callback snapshot, never the live config, and dedups by replyId', async () => {
  const seen = []
  const host = createFakeHost()
  const supervisor = supervisorFor({
    // The live config has a DIFFERENT destination: the persisted submission
    // snapshot must win, so a later config change cannot retarget the task.
    rootCallbackGrants: { root: { targetId: 'config-target' } },
    // A positive delivery acknowledgement is required before `delivered` is true.
    notificationSink: (event) => { seen.push(event); return { delivered: true } }
  })
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const envelope = {
    ...makeEnvelope({
      id: 'task-reply',
      attemptId: 'attempt-reply',
      packet: makePacket({ idempotencyKey: 'reply-key', rootCallback: { grantId: 'root' } })
    }),
    callbackBinding: { grantId: 'root', targetId: 'persisted-target', boundAt: 1 }
  }
  const res = await adapter.start(envelope)
  const reply = host.registeredDefinition(res.sessionId, 'dsh_bridge_reply')
  const parentAgent = host.agents.get(res.sessionId)

  const first = await reply.execute({ replyId: 'r1', kind: 'blocked', summary: 'need a decision' }, { agent: parentAgent, arguments: {} })
  assert.equal(first.delivered, true)
  assert.equal(first.outcome, 'delivered')
  assert.equal(first.replyKind, 'blocked')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].targetId, 'persisted-target')
  assert.equal(seen[0].kind, 'needs-input', 'needs-input remains the shared wire kind')
  assert.deepEqual(Object.keys(seen[0]).sort(), ['attemptId', 'eventId', 'kind', 'summary', 'targetId', 'taskId'])
  assert.equal(seen[0].summary, '[blocked] need a decision', 'the reply kind survives as a controller-generated prefix')
  assert.match(seen[0].eventId, /^reply-[0-9a-f]{64}$/, 'the reply id is the full task+attempt+reply tuple')
  assert.equal(seen[0].taskId, 'task-reply')
  assert.equal(seen[0].attemptId, 'attempt-reply')

  const replay = await reply.execute({ replyId: 'r1', kind: 'blocked', summary: 'need a decision' }, { agent: parentAgent, arguments: {} })
  assert.equal(replay.outcome, 'duplicate')
  assert.equal(seen.length, 1, 'an identical replyId is never sent twice')

  // A reply never settles, fails or cancels the task.
  const status = adapter.status('task-reply')
  assert.equal(['completed', 'failed', 'cancelled'].includes(status.currentState), false)

  // Without a sink the outcome is explicitly unsupported, never a claimed send.
  const host2 = createFakeHost()
  const noSink = new DshAdapter(host2.ctx, { supervisor: supervisorFor({ rootCallbackGrants: { root: { targetId: 't' } } }) })
  const res2 = await noSink.start(envelope)
  const reply2 = host2.registeredDefinition(res2.sessionId, 'dsh_bridge_reply')
  const outcome = await reply2.execute({ replyId: 'r2', summary: 'anything' }, { agent: host2.agents.get(res2.sessionId), arguments: {} })
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.outcome, 'unsupported')
})

test('an ungranted rootCallback is refused before any session exists', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx, { supervisor: supervisorFor() })
  await captureFailure(() => adapter.preflight(makePacket({ rootCallback: { grantId: 'ghost' } })), 'adapter/callback-ungranted')
  assert.deepEqual(host.calls.create, [])
})

test('command jobs refuse an ungranted profile and report a precise capability refusal without ctx.jobs.start', async () => {
  const host = createFakeHost()
  const registry = new CommandProfileRegistry({
    profiles: [
      { id: 'echo', executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: ROOT, env: {}, timeoutMs: 1000, maxOutputBytes: 4096 }
    ]
  })
  const adapter = new DshAdapter(host.ctx, { supervisor: supervisorFor({ commandJobs: { enabled: true, profiles: registry } }), commandJobs: registry })
  await captureFailure(
    () => adapter.preflight(makePacket({ scope: { backgroundJobs: { enabled: true, profileIds: ['ghost'] } } })),
    'adapter/job-profile-ungranted'
  )
  const refusal = await captureFailure(
    () => adapter.preflight(makePacket({ scope: { backgroundJobs: { enabled: true, profileIds: ['echo'] } } })),
    'adapter/job-unsupported'
  )
  assert.match(refusal.message, /profile contract|ctx\.jobs|unsupported/)
  assert.deepEqual(host.calls.create, [], 'a refused job grant creates no session and no job')

  const caps = await adapter.capabilities()
  assert.equal(caps.supervisor.jobs.supported, false, 'the capability report must not advertise an unenforceable job path')
  // Registry presence and per-owner controller reachability are DIFFERENT claims.
  assert.equal(caps.supervisor.jobs.jobsRegistryReady, false, 'this host exposes no jobs.start registry')
  assert.equal(caps.supervisor.jobs.controllerStatus, 'unknown', 'no side-effect-free controller probe exists, so the status stays unknown')
  assert.equal(caps.supervisor.jobs.controllerUnknown, true)
  assert.match(caps.supervisor.jobs.controllerReason, /side-effect-free controller probe|may still refuse/)
  assert.equal(caps.supervisor.jobs.isolation.process, false)
  assert.match(caps.supervisor.jobs.enforced + ' ' + (caps.supervisor.note ?? ''), /not an OS sandbox/i)

  // A host that DOES expose a jobs registry still cannot be probed for an
  // attached per-owner controller, so the two facts are reported separately.
  const hostWithRegistry = createFakeHost()
  const baseGet = hostWithRegistry.ctx.get.bind(hostWithRegistry)
  const baseJobs = baseGet('jobs')
  hostWithRegistry.ctx.get = (name) => name !== 'jobs' ? baseGet(name) : { ...baseJobs, start: () => ({ jobId: 'probed' }) }
  const withRegistry = new DshAdapter(hostWithRegistry.ctx, {
    supervisor: supervisorFor({ commandJobs: { enabled: true, profiles: registry } }),
    commandJobs: registry
  })
  const registryCaps = await withRegistry.capabilities()
  assert.equal(registryCaps.supervisor.jobs.jobsRegistryReady, true, 'the registry exposes jobs.start on this host')
  assert.equal(registryCaps.supervisor.jobs.controllerStatus, 'unknown', 'an attached controller still cannot be probed without side effects')
  assert.equal(registryCaps.supervisor.jobs.controllerUnknown, true)
})

test('settlement with a live child is never reported as a clean stop', async () => {
  const host = createFakeHost()
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const results = []
  const res = await adapter.start(
    makePacket({ idempotencyKey: 'parent-children', scope: { childSessions: { enabled: true, maxChildren: 1 } } }),
    { onResult: (result) => results.push(result) }
  )
  const parentAgent = host.agents.get(res.sessionId)
  await host
    .registeredDefinition(res.sessionId, 'dsh_child_spawn')
    .execute({ childKey: 'live-1', objective: 'slow child' }, { agent: parentAgent, arguments: { childKey: 'live-1', objective: 'slow child' } })

  // The parent turn ends while the child is still live. The settlement payload
  // must carry the live child count, and a service-layer terminal status requires
  // zero live children, so a clean stop is never claimed.
  claim(host, res.sessionId, res.requestId, 1)
  host.emitTurnEnd(res.sessionId, 1, { kind: 'completed' })
  assert.equal(results.length, 1)
  assert.equal(results[0].activeChildren, 1)
  assert.equal(supervisor.liveChildren('parent-children').length, 1)
  assert.equal(supervisor.ledger.counts().children, 1)
})

test('cancelling the parent cancels its live descendants and keeps an unproven child slot counted', async () => {
  const host = createFakeHost() // the fake agent stays 'running' until told otherwise
  const supervisor = supervisorFor()
  const adapter = new DshAdapter(host.ctx, { supervisor })
  const packet = makePacket({ idempotencyKey: 'parent-cancel', scope: { childSessions: { enabled: true, maxChildren: 1 } } })
  const res = await adapter.start(packet)
  const parentAgent = host.agents.get(res.sessionId)
  const child = await host
    .registeredDefinition(res.sessionId, 'dsh_child_spawn')
    .execute({ childKey: 'c1', objective: 'work' }, { agent: parentAgent, arguments: { childKey: 'c1', objective: 'work' } })
  assert.equal(supervisor.ledger.counts().children, 1)

  const cancelled = await adapter.cancel(packet)
  const descendant = cancelled.actions.find((entry) => entry.kind === 'descendant-cancel')
  assert.ok(descendant, 'a parent stop must attempt descendant cancellation through the host seam')
  assert.equal(descendant.unconfirmed, 1)
  assert.equal(supervisor.findChild(child.childId).state, 'unknown')
  assert.equal(supervisor.ledger.counts().children, 1, 'an unproven child stop keeps its slot')
  assert.equal(cancelled.stopConfirmed, false, 'the parent stop is unconfirmed while its child is live')
  // The child turn was cancelled through the CHILD'S OWN agent; generic session
  // routing never touches a subagent-owned identity (the host double refuses it).
  const childCancel = host.calls.agentCancel.find((entry) => entry.sessionId === child.sessionId)
  assert.ok(childCancel, 'the child turn was actually cancelled through the child agent')
  assert.deepEqual(childCancel.cause, { kind: 'parent' })
  assert.equal(
    host.calls.cancel.some((entry) => entry.sessionId === child.sessionId),
    false,
    'generic sessionController.cancel is never used for a subagent-owned child'
  )
})

function fakeCommandJobs() {
  const jobs = new Map()
  const calls = []
  let sequence = 0
  const api = {
    start(spec) {
      calls.push({ kind: 'start', owner: spec.owner, kindOf: spec.kind, outputLimitBytes: spec.outputLimitBytes, hasOutput: Array.isArray(spec.output) })
      sequence += 1
      const id = `command-${sequence}`
      const record = { id, owner: spec.owner, status: 'running', hooks: null, spec }
      record.hooks = spec.run({ id, append() {}, updateProgress() {} })
      jobs.set(id, record)
      return id
    },
    get(id, caller) {
      calls.push({ kind: 'get', id, caller })
      const record = jobs.get(id)
      if (record === undefined) throw Object.assign(new Error('unknown job'), { code: 'job/not-found' })
      if (caller !== record.owner) throw Object.assign(new Error('foreign job'), { code: 'job/foreign' })
      return { id: record.id, owner: record.owner, status: record.status }
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
      const outcome = await record.hooks.done
      record.status = outcome.status
      return { id: record.id, owner: record.owner, status: outcome.status }
    }
  }
  return { calls, jobs, ctx: { get: (name) => (name === 'jobs' ? api : undefined) }, api }
}

function fakeSpawn(outcome) {
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
        if (outcome.killCloses === true) listeners.get('close')?.(null, 'SIGTERM')
        return true
      }
    }
    if (outcome.output !== undefined) queueMicrotask(() => listeners.get('stdout')?.(outcome.output))
    if (outcome.closesOnItsOwn === true) queueMicrotask(() => listeners.get('close')?.(0, null))
    return child
  }
  return { calls, spawnImpl }
}

test('startCommandJob uses a real owned registry request with exact profile argv, cwd and env', async () => {
  const registry = new CommandProfileRegistry({
    profiles: [
      { id: 'echo', executable: process.execPath, argv: ['-e', 'process.stdout.write("ok")'], cwd: ROOT, env: { CI: '1' }, timeoutMs: 1000, maxOutputBytes: 4096 }
    ]
  })
  const fake = fakeCommandJobs()
  const spawn = fakeSpawn({ output: 'ok', closesOnItsOwn: true })
  const started = startCommandJob({ ctx: fake.ctx, registry, profileId: 'echo', owner: 'session-1', label: 'probe', spawnImpl: spawn.spawnImpl })
  assert.match(started.jobId, /^command-\d+$/)
  assert.equal(started.isolation.process, false)
  assert.equal(started.isolation.filesystem, false)
  assert.equal(started.isolation.network, false)
  assert.match(started.isolation.note, /not an OS sandbox/i)
  const startCall = fake.calls.find((entry) => entry.kind === 'start')
  assert.equal(startCall.owner, 'session-1')
  assert.equal(startCall.outputLimitBytes, 4096)
  assert.equal(startCall.hasOutput, true)
  assert.equal(spawn.calls[0].executable, process.execPath)
  assert.deepEqual(spawn.calls[0].argv, ['-e', 'process.stdout.write("ok")'])
  assert.equal(spawn.calls[0].options.cwd, ROOT)
  assert.deepEqual(spawn.calls[0].options.env, { CI: '1' })
  assert.equal(spawn.calls[0].options.shell, false)
  const stopped = await stopCommandJob({ ctx: fake.ctx, jobId: started.jobId, owner: 'session-1' })
  assert.equal(stopped.stopConfirmed, true)
})

test('a foreign job is refused as jobs/not-owned and is never retried under another identity', async () => {
  const registry = new CommandProfileRegistry({
    profiles: [{ id: 'echo', executable: process.execPath, argv: [], cwd: ROOT, env: {}, timeoutMs: 1000, maxOutputBytes: 4096 }]
  })
  const fake = fakeCommandJobs()
  const spawn = fakeSpawn({})
  const started = startCommandJob({ ctx: fake.ctx, registry, profileId: 'echo', owner: 'session-1', spawnImpl: spawn.spawnImpl })
  const failure = await captureFailure(() => stopCommandJob({ ctx: fake.ctx, jobId: started.jobId, owner: 'session-9' }), 'jobs/not-owned')
  assert.equal(failure.code, 'jobs/not-owned')
  const getCalls = fake.calls.filter((entry) => entry.kind === 'get')
  assert.equal(getCalls.length, 1, 'the refusing identity must not be retried under another identity')
  assert.equal(getCalls[0].caller, 'session-9')
})

// ---------------------------------------------------------------------------
// supervisor-only long-task tools (contract long-supervisor-first-edition-v1)
// ---------------------------------------------------------------------------

/**
 * A project block as `src/contracts.mjs` normalizes it. The adapter re-checks host
 * policy but never re-derives packet defaults, so tests must supply the full shape.
 */
function projectBlock(overrides = {}) {
  return {
    maxWorkers: 8,
    maxConcurrentWorkers: 3,
    maxRepairAttempts: 2,
    maxTotalRetries: 24,
    maxWorkerStarts: 24,
    maxTotalToolCalls: 10000,
    timeoutMs: 3600000,
    reserveSlots: 1,
    workerScope: {
      readRoots: [ROOT],
      writeRoots: [],
      allowedTools: ['read', 'glob', 'grep'],
      allowNetwork: false,
      budgets: { timeoutMs: 600000, maxToolCalls: 100, maxOutputChars: 200000 }
    },
    ...overrides
  }
}

/** Minimal injected long-task runtime: host policy plus the six tool handlers. */
function projectsFor(options = {}) {
  const calls = []
  const handler = (name) => async (spec) => {
    calls.push({ name, ...spec })
    return { handler: name, taskId: spec.taskId, attemptId: spec.attemptId, args: spec.args }
  }
  return {
    calls,
    config: { enabled: options.enabled !== false, maxWorkers: 16, maxConcurrentWorkers: 16, maxRepairAttempts: 2, maxTotalRetries: 64, maxWorkerStarts: 64, maxTotalToolCalls: 100000, projectTimeoutMs: 86400000, reserveSlots: 15, summaryChars: 2000 },
    status: () => ({ supported: true, enabled: options.enabled !== false, tools: ['dsh_supervisor_worker_create'] }),
    workerCreate: handler('dsh_supervisor_worker_create'),
    planFinalize: handler('dsh_supervisor_plan_finalize'),
    workerList: handler('dsh_supervisor_worker_list'),
    workerResult: handler('dsh_supervisor_worker_result'),
    workerCancel: handler('dsh_supervisor_worker_cancel'),
    projectStatus: handler('dsh_supervisor_project_status')
  }
}

test('a supervisor-project packet registers exactly the six supervisor tools on the authorized supervisor only', async () => {
  const host = createFakeHost()
  const projects = projectsFor()
  const adapter = new DshAdapter(host.ctx, { supervisor: supervisorFor(), projects, supervisorProjects: projects.config })
  const projectScope = { readRoots: [ROOT], writeRoots: [], allowedTools: ['read', 'glob', 'grep'] }
  // The root service always hands the adapter the real task envelope, so the authorized
  // identity asserted below is the envelope id (`task-uuid-1`), not the packet key.
  const res = await adapter.start(makeEnvelope({ packet: { project: projectBlock(), scope: projectScope } }))
  assert.equal(res.taskId, 'task-uuid-1')
  const names = host.calls.registered.filter((entry) => entry.sessionId === res.sessionId).map((entry) => entry.name)
  assert.deepEqual(names.sort(), [
    'dsh_supervisor_plan_finalize',
    'dsh_supervisor_project_status',
    'dsh_supervisor_worker_cancel',
    'dsh_supervisor_worker_create',
    'dsh_supervisor_worker_list',
    'dsh_supervisor_worker_result'
  ])

  // The tool delegates to the injected runtime with the AUTHORIZED identity.
  const parentAgent = host.agents.get(res.sessionId)
  const create = host.registeredDefinition(res.sessionId, 'dsh_supervisor_worker_create')
  const created = await create.execute(
    { workerKey: 'w1', objective: 'read one file', tools: ['read'] },
    { agent: parentAgent, arguments: { workerKey: 'w1', objective: 'read one file', tools: ['read'] } }
  )
  assert.equal(created.handler, 'dsh_supervisor_worker_create')
  assert.equal(created.taskId, 'task-uuid-1')
  assert.equal(created.args.workerKey, 'w1')
  assert.equal(projects.calls.length, 1)

  // A foreign agent can never reach the project manager, even though the definition exists.
  const foreign = await captureFailure(
    () => create.execute({ workerKey: 'w2', objective: 'x' }, { agent: { id: 'someone-else' }, arguments: { workerKey: 'w2', objective: 'x' } }),
    'adapter/unauthorized-caller'
  )
  assert.equal(foreign.code, 'adapter/unauthorized-caller')
  assert.equal(projects.calls.length, 1)

  const caps = await adapter.capabilities()
  assert.equal(caps.supervisor.projects.enabled, true)
  assert.equal(caps.supervisor.projects.tools.includes('dsh_supervisor_worker_create'), true)
  assert.deepEqual(caps.supervisor.projectTools, [
    'dsh_supervisor_worker_create',
    'dsh_supervisor_plan_finalize',
    'dsh_supervisor_worker_list',
    'dsh_supervisor_worker_result',
    'dsh_supervisor_worker_cancel',
    'dsh_supervisor_project_status',
    'dsh_supervisor_project_complete',
    'dsh_supervisor_project_block'
  ])
})

test('the supervisor tools are refused without the grant and are never named in allowedTools', async () => {
  const host = createFakeHost()
  const projects = projectsFor()
  // An ordinary task registers nothing and the guard denies the supervisor tools by name.
  const adapter = new DshAdapter(host.ctx, { supervisor: supervisorFor(), projects, supervisorProjects: projects.config })
  const ordinary = await adapter.start(makePacket())
  assert.deepEqual(host.calls.registered.filter((entry) => entry.sessionId === ordinary.sessionId), [])
  const denied = host.runTool(ordinary.sessionId, 'dsh_supervisor_worker_create', { workerKey: 'w', objective: 'o' })
  assert.equal(denied.allowed, false)
  assert.match(denied.reason, /packet\.project|task-granted/)

  // Naming a grant-admitted tool in scope.allowedTools is refused before any session.
  await captureFailure(() => adapter.preflight(makePacket({ scope: { allowedTools: ['read', 'dsh_supervisor_worker_create'] } })), 'adapter/scope-unsupported')

  // A disabled host refuses the project grant outright.
  const disabled = new DshAdapter(host.ctx, { supervisor: supervisorFor(), projects: projectsFor({ enabled: false }), supervisorProjects: { ...projects.config, enabled: false } })
  await captureFailure(() => disabled.preflight(makePacket({ project: projectBlock(), scope: { writeRoots: [], allowedTools: ['read'] } })), 'adapter/project-unsupported')

  // A valid project packet passes preflight without naming any grant-admitted tool.
  const okPreflight = await adapter.preflight(makePacket({ project: projectBlock(), scope: { writeRoots: [], allowedTools: ['read'] } }))
  assert.equal(okPreflight.ok, true)

  // A project packet must not carry its own writes or child/job grants.
  await captureFailure(
    () => adapter.preflight(makePacket({ project: projectBlock(), scope: { allowedTools: ['read'] } })),
    'adapter/invalid-project'
  )
  await captureFailure(
    () => adapter.preflight(makePacket({ project: projectBlock(), scope: { writeRoots: [], allowedTools: ['read'], childSessions: { enabled: true, maxChildren: 1 } } })),
    'adapter/invalid-project'
  )
})

test('a child session can never receive or request a supervisor-only tool', async () => {
  const host = createFakeHost()
  const adapter = new DshAdapter(host.ctx, { supervisor: supervisorFor() })
  const res = await adapter.start(makePacket({ scope: { childSessions: { enabled: true, maxChildren: 1, toolNames: ['read'] } } }))
  const parentAgent = host.agents.get(res.sessionId)
  const spawn = host.registeredDefinition(res.sessionId, 'dsh_child_spawn')
  for (const name of ['dsh_supervisor_worker_create', 'dsh_supervisor_plan_finalize']) {
    await captureFailure(
      () => spawn.execute({ childKey: `c-${name}`, objective: 'o', tools: [name] }, { agent: parentAgent, arguments: {} }),
      'supervisor/grant-widened'
    )
  }
})

// ---------------------------------------------------------------------------
// nextRound: admission-time grant + strict settled proof before any prompt
// ---------------------------------------------------------------------------

test('nextRound requires the admission-time recurrent grant and refuses every unknown child inspector before any prompt', async () => {
  const projectScope = { readRoots: [ROOT], writeRoots: [], allowedTools: ['read', 'glob', 'grep'] }
  const recurrentConfig = { ...projectsFor().config, maxRounds: 4 }
  const recurrentPacket = () => makePacket({ project: projectBlock({ maxRounds: 4 }), scope: projectScope })

  /** Start one recurrent project, finish a real fake-host turn and leave the agent idle. */
  const settledProject = async () => {
    const host = createFakeHost({ initialStatus: 'idle' })
    const projects = { ...projectsFor(), config: recurrentConfig }
    const supervisor = supervisorFor()
    const adapter = new DshAdapter(host.ctx, { supervisor, projects, supervisorProjects: recurrentConfig })
    const started = await adapter.start(makeEnvelope({ packet: recurrentPacket() }))
    claim(host, started.sessionId, started.requestId, 1)
    host.emitAssistant(started.sessionId, 1, 'first bounded round')
    host.emitTurnEnd(started.sessionId, 1, { kind: 'completed' })
    return { host, adapter, supervisor }
  }

  // Positive control: a genuinely idle, empty, guarded owned session mints a new round.
  const control = await settledProject()
  const receipt = await control.adapter.nextRound(makeEnvelope({ packet: recurrentPacket(), attemptId: 'attempt-round-2' }), {})
  assert.equal(receipt.taskId, 'task-uuid-1')
  assert.equal(receipt.idempotentReplay, false)

  // A legacy project (no packet maxRounds, host cap 1) is never newly granted recurrence by
  // the narrowed round envelope: the admission-time grant is the only source of truth.
  const legacyHost = createFakeHost({ initialStatus: 'idle' })
  const legacyProjects = { ...projectsFor() }
  const legacyAdapter = new DshAdapter(legacyHost.ctx, { supervisor: supervisorFor(), projects: legacyProjects, supervisorProjects: legacyProjects.config })
  const legacyStarted = await legacyAdapter.start(makeEnvelope({ packet: makePacket({ project: projectBlock(), scope: projectScope }) }))
  claim(legacyHost, legacyStarted.sessionId, legacyStarted.requestId, 1)
  legacyHost.emitTurnEnd(legacyStarted.sessionId, 1, { kind: 'completed' })
  const legacyPrompts = legacyHost.calls.prompt.length
  const legacyRefusal = await captureFailure(
    () => legacyAdapter.nextRound(makeEnvelope({ packet: makePacket({ project: projectBlock(), scope: projectScope }), attemptId: 'attempt-legacy-2' }), {}),
    'adapter/project-not-recurrent'
  )
  assert.equal(legacyRefusal.dispatched, false, 'a legacy project refusal is a local non-dispatch')
  assert.equal(legacyHost.calls.prompt.length, legacyPrompts, 'no prompt may cross the boundary for a legacy project')

  // A configured owned-child manager whose inspector is missing, throwing or non-array is
  // UNKNOWN, never zero: the round refuses locally and the identity is untouched.
  const probes = [
    ['missing', (supervisor) => { supervisor.liveChildren = undefined }],
    ['throwing', (supervisor) => { supervisor.liveChildren = () => { throw new Error('child inspector exploded') } }],
    ['nonarray', (supervisor) => { supervisor.liveChildren = () => ({ not: 'a list' }) }]
  ]
  for (const [label, mutate] of probes) {
    const probe = await settledProject()
    const attemptId = `attempt-child-${label}`
    mutate(probe.supervisor)
    const promptsBefore = probe.host.calls.prompt.length
    const refusal = await captureFailure(
      () => probe.adapter.nextRound(makeEnvelope({ packet: recurrentPacket(), attemptId }), {}),
      'adapter/host-state-unknown'
    )
    assert.equal(refusal.dispatched, false, `${label}: an unknown child probe refuses before any prompt`)
    assert.equal(probe.host.calls.prompt.length, promptsBefore, `${label}: no prompt may cross the boundary`)
    const observed = await probe.adapter.inspect(makeEnvelope({ packet: recurrentPacket() }))
    assert.equal(observed.attempts.length, 1, `${label}: no attempt may be minted`)
    assert.equal(observed.attempts[0].terminal, true, `${label}: the proven round stays the only attempt`)
  }
})


