/**
 * Host tool-catalog integration regressions — contract 20260925.1 correction.
 *
 * The live defect: `tools.schemas(scope?)` is a SCOPE PRESENTATION view. An
 * omitted scope resolves to the GLOBAL layer alone (`scopeChainOf(undefined)` is
 * empty); the preset/agent plane is merged only for a supplied scope, and no
 * public complete all-scopes catalog exists. Promoting an agentless global view
 * to "complete availability" therefore (a) claimed `availabilityVerified: true`
 * with `availableTools: []` in production and (b) fabricated a missing-tool
 * rejection for perfectly valid per-agent tools (`read`/`write`), rejecting a
 * normal submit before task creation.
 *
 * These tests pin the corrected separation:
 *   - an agentless probe (preflight / capabilities) NEVER reports a complete
 *     catalog and NEVER rejects a name on catalog grounds;
 *   - an empty or nonempty, partial, throwing or malformed global view cannot
 *     prove a requested per-agent/preset tool ABSENT;
 *   - real visibility stays mandatory: `start` proves the requested names against
 *     the REAL created agent's scoped registry before any prompt, and a session
 *     that cannot see a requested tool is failed closed before dispatch.
 *
 * Evidence class: MOCK fake host only. No real host, session, model or tool body
 * is touched, and no shell/network call is made.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { DshAdapter } from '../src/dsh-adapter.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CWD = path.resolve(HERE, '..')

function packet(allowedTools, { allowNetwork = false } = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: `host-catalog-${allowedTools.join('-')}-${Math.random().toString(36).slice(2)}`,
    revision: 1,
    projectId: 'dsh-upgrade-20260925',
    title: 'host catalog integration',
    objective: 'Separate global scope presentation from real agent-bound tool visibility.',
    cwd: CWD,
    role: 'implement',
    acceptance: ['preflight and start never confuse presentation with availability'],
    scope: {
      readRoots: [CWD],
      writeRoots: [CWD],
      allowedTools,
      allowShell: false,
      allowNetwork,
      allowDelegation: false
    },
    materials: [],
    contractVersion: '20260925.1'
  }
}

function envelope(allowedTools, id, options = {}) {
  return {
    id,
    revision: 1,
    attemptId: `${id}-attempt-1`,
    packet: packet(allowedTools, options),
    prompt: 'ROOT BUILD PROMPT: do the bounded thing',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-flash' }
  }
}

async function captureError(fn) {
  let error = null
  try {
    await fn()
  } catch (thrown) {
    error = thrown
  }
  assert.ok(error, 'expected the call to throw, but it resolved')
  return error
}

/** Interpret a `schemas()` spec: an array of names/entries, a thunk (may throw), or a raw value. */
function schemasValue(spec) {
  if (typeof spec === 'function') return spec()
  if (Array.isArray(spec)) return spec.map((entry) => (typeof entry === 'string' ? { name: entry } : entry))
  return spec
}

/**
 * Fake host with both registry planes: the host/global `tools.schemas()` view and
 * the per-agent scoped registry an agent's `ctx.get('tools')` exposes.
 *
 * @param {object} [options] - `globalSchemas` and `agentTools` specs.
 */
function makeHost({ globalSchemas = [], agentTools = ['read', 'write'] } = {}) {
  const calls = { create: 0, prompt: 0, selectModel: 0, restrict: 0, guard: 0, globalSchemas: 0, agentSchemas: 0 }
  const agents = new Map()
  let seq = 0

  const hostTools = {
    schemas() {
      calls.globalSchemas += 1
      return schemasValue(globalSchemas)
    },
    restrict() {
      calls.restrict += 1
      return () => {}
    },
    guard() {
      calls.guard += 1
      return () => {}
    }
  }

  function makeAgent(sessionId) {
    const scoped = {
      schemas() {
        calls.agentSchemas += 1
        return schemasValue(agentTools)
      },
      restrict() {
        calls.restrict += 1
        return () => {}
      },
      guard() {
        calls.guard += 1
        return () => {}
      }
    }
    return {
      id: sessionId,
      status: 'running',
      session: { id: sessionId, append() {} },
      inbox: { nextTurn: [], nextStep: [] },
      ctx: {
        get(name) {
          return name === 'tools' ? scoped : undefined
        },
        on() {
          return () => {}
        }
      }
    }
  }

  const sessionController = {
    async create() {
      calls.create += 1
      seq += 1
      const sessionId = `session-${seq}`
      agents.set(sessionId, makeAgent(sessionId))
      return { sessionId }
    },
    async selectModel(request) {
      calls.selectModel += 1
      return { selected: { provider: request.provider, model: request.model } }
    },
    async prompt() {
      calls.prompt += 1
      return { accepted: true }
    }
  }

  const services = {
    tools: hostTools,
    sessionController,
    agents: { get: (id) => agents.get(id) },
    jobs: { get: () => undefined, list: () => [] },
    fs: { sandboxMode: 'workspace-write' },
    workspaceRegistry: {},
    llm: { listProviders: () => [], listModels: async () => [] }
  }
  const ctx = {
    get(name) {
      return name === 'tools' ? hostTools : services[name]
    },
    on() {
      return () => {}
    }
  }
  return { ctx, calls }
}

/* ------------------------------------------------------------------ *
 * 1. empty global schemas + read/write valid on the real agent
 * ------------------------------------------------------------------ */

test('empty global schemas never blocks preflight, and a real agent with read/write can start', async () => {
  const host = makeHost({ globalSchemas: [], agentTools: ['read', 'write'] })
  const adapter = new DshAdapter(host.ctx)

  const result = await adapter.preflight(packet(['read', 'write']))
  assert.equal(result.ok, true)
  assert.deepEqual(result.requestedTools, ['read', 'write'])
  assert.equal(result.availableTools, null, 'an empty global view is not a complete catalog')
  assert.equal(result.availabilityVerified, false)
  assert.equal(result.sessionVisibilityPending, true)
  assert.equal(host.calls.globalSchemas, 0, 'the global presentation must not be consulted as a catalog')
  assert.equal(host.calls.agentSchemas, 0, 'preflight has no agent and must not claim agent visibility')
  assert.equal(host.calls.create, 0)
  assert.equal(host.calls.prompt, 0)
  assert.equal(host.calls.restrict, 0)
  assert.equal(host.calls.guard, 0)
  assert.equal(host.calls.selectModel, 0)

  // A proper start may create an owned session, and it proves the requested tools
  // against the REAL agent's scoped registry before dispatch.
  const receipt = await adapter.start(envelope(['read', 'write'], 'task-empty-global'))
  assert.equal(typeof receipt.sessionId, 'string')
  assert.equal(host.calls.create, 1)
  assert.ok(host.calls.agentSchemas >= 1, 'start must consult the real agent-scoped registry')
  assert.equal(host.calls.prompt, 1, 'a visible requested tool set must dispatch')
  adapter.dispose()
})

/* ------------------------------------------------------------------ *
 * 2. nonempty partial global view missing the requested tool
 * ------------------------------------------------------------------ */

test('a nonempty global view missing read cannot prove read absent or block dispatch', async () => {
  const host = makeHost({ globalSchemas: ['write'], agentTools: ['read', 'write'] })
  const adapter = new DshAdapter(host.ctx)

  const result = await adapter.preflight(packet(['read', 'write']))
  assert.equal(result.ok, true, 'an incomplete global view must not fabricate a missing tool')
  assert.deepEqual(result.requestedTools, ['read', 'write'])
  assert.equal(result.availableTools, null)
  assert.equal(result.availabilityVerified, false)
  assert.equal(host.calls.globalSchemas, 0, 'the partial global view must not be promoted to a catalog')
  assert.equal(host.calls.create, 0)
  assert.equal(host.calls.prompt, 0)

  const receipt = await adapter.start(envelope(['read', 'write'], 'task-partial-global'))
  assert.equal(typeof receipt.sessionId, 'string')
  assert.equal(host.calls.create, 1)
  assert.equal(host.calls.prompt, 1, 'the real agent sees read/write, so dispatch proceeds')
  adapter.dispose()
})

test('capabilities reports unproved availability even when the global view lists tools', async () => {
  const host = makeHost({ globalSchemas: ['read', 'write', 'grep'], agentTools: ['read'] })
  const caps = await new DshAdapter(host.ctx).capabilities()
  assert.equal(caps.toolContract.availableTools, null)
  assert.equal(caps.toolContract.availabilityVerified, false)
  assert.equal(caps.toolContract.sessionVisibilityPending, true)
  assert.equal(host.calls.globalSchemas, 0, 'capabilities must not promote the global presentation')
})

/* ------------------------------------------------------------------ *
 * 3. root schema throw / malformed
 * ------------------------------------------------------------------ */

test('a throwing root schemas() cannot fabricate availability or a rejection', async () => {
  const host = makeHost({ globalSchemas: () => { throw new Error('tool registry schemas unavailable') } })
  const adapter = new DshAdapter(host.ctx)

  const result = await adapter.preflight(packet(['read']))
  assert.equal(result.ok, true)
  assert.equal(result.availableTools, null)
  assert.equal(result.availabilityVerified, false)
  assert.equal(result.sessionVisibilityPending, true)

  const caps = await adapter.capabilities()
  assert.equal(caps.toolContract.availableTools, null)
  assert.equal(caps.toolContract.availabilityVerified, false)

  assert.equal(host.calls.globalSchemas, 0, 'a throwing global registry must never be consulted as a catalog')
  assert.equal(host.calls.create, 0)
  assert.equal(host.calls.prompt, 0)
})

test('a malformed root catalog cannot be promoted to a verified empty catalog', async () => {
  for (const malformed of [null, [null], [{ name: 42 }], [{ name: '   ' }], [{ name: 'read' }, 42]]) {
    const host = makeHost({ globalSchemas: malformed })
    const adapter = new DshAdapter(host.ctx)
    const result = await adapter.preflight(packet(['read']))
    assert.equal(result.ok, true, `malformed global ${JSON.stringify(malformed)} must not reject the packet`)
    assert.equal(result.availableTools, null, `malformed global ${JSON.stringify(malformed)} is not a catalog`)
    assert.equal(result.availabilityVerified, false)
    assert.equal(host.calls.globalSchemas, 0)
    assert.equal(host.calls.create, 0)
    assert.equal(host.calls.prompt, 0)
  }
})

/* ------------------------------------------------------------------ *
 * 4. real agent-scoped visibility is still mandatory before prompt
 * ------------------------------------------------------------------ */

test('an owned session that cannot see the requested tool is rejected before prompt', async () => {
  // The global view even lists "read" — the only authority is the real agent view.
  const host = makeHost({ globalSchemas: ['read', 'write'], agentTools: ['write'] })
  const adapter = new DshAdapter(host.ctx)

  const error = await captureError(() => adapter.start(envelope(['read'], 'task-missing-visibility')))
  assert.equal(error.code, 'adapter/scope-unsupported')
  assert.match(error.message, /read/)
  assert.deepEqual(error.details.missing, ['read'])

  assert.equal(host.calls.create, 1, 'start may create the owned session before the visibility check')
  assert.ok(host.calls.agentSchemas >= 1, 'the REAL agent-scoped registry must be read')
  assert.equal(host.calls.prompt, 0, 'a requested tool missing from the real agent must prevent the prompt')
  assert.equal(host.calls.selectModel, 0, 'no model may be selected before visibility is proved')
  assert.equal(host.calls.restrict, 0, 'no registry restriction may be installed after a visibility failure')
  assert.equal(host.calls.guard, 0, 'no guard may be installed after a visibility failure')

  const orphans = adapter.orphans()
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].sessionId, error.details.orphanSessionId)
  adapter.dispose()
})

test('a visibility failure is still reported when the agent-scoped registry throws', async () => {
  const host = makeHost({ globalSchemas: ['read'], agentTools: () => { throw new Error('scoped registry unavailable') } })
  const adapter = new DshAdapter(host.ctx)
  const error = await captureError(() => adapter.start(envelope(['read'], 'task-scoped-throw')))
  assert.equal(error.code, 'adapter/enforcement-unavailable')
  assert.equal(host.calls.create, 1)
  assert.equal(host.calls.prompt, 0)
  adapter.dispose()
})

/* ------------------------------------------------------------------ *
 * 5. unsupported boundaries stay fail-closed with zero mutations
 * ------------------------------------------------------------------ */

const UNSUPPORTED = ['apply_patch', 'pwsh', 'subagent', 'run_code', 'web_search']

for (const name of UNSUPPORTED) {
  test(`preflight and start reject unsupported tool "${name}" with zero host mutations`, async () => {
    const host = makeHost({ globalSchemas: ['read', name], agentTools: ['read', name] })
    const adapter = new DshAdapter(host.ctx)

    const preflightError = await captureError(() => adapter.preflight(packet([name])))
    assert.equal(preflightError.code, 'adapter/scope-unsupported')
    assert.equal(preflightError.dispatched, false)

    const startError = await captureError(() => adapter.start(envelope([name], `task-unsupported-${name}`)))
    assert.equal(startError.code, 'adapter/scope-unsupported')

    assert.equal(host.calls.create, 0, 'an unsupported tool must never create a session')
    assert.equal(host.calls.prompt, 0, 'an unsupported tool must never dispatch a prompt')
    assert.equal(host.calls.selectModel, 0)
    assert.equal(host.calls.restrict, 0)
    assert.equal(host.calls.guard, 0)
    assert.equal(host.calls.globalSchemas, 0)
    assert.equal(host.calls.agentSchemas, 0)
  })
}
