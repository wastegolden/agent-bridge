import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DshAdapter } from '../src/dsh-adapter.mjs'

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function packet(allowedTools, allowNetwork = false) {
  return {
    schemaVersion: 1,
    idempotencyKey: 'upgrade-preflight',
    revision: 1,
    projectId: 'isolated-preflight-test',
    title: 'Verify admission before dispatch',
    objective: 'Check public preflight with a fake host',
    cwd,
    role: 'investigate',
    acceptance: ['No session or prompt is created'],
    scope: {
      readRoots: [cwd],
      writeRoots: [],
      allowedTools,
      allowShell: false,
      allowNetwork,
      allowDelegation: false
    },
    materials: [],
    contractVersion: 'upgrade-preflight-test'
  }
}

/**
 * Fake host. `catalog` is the GLOBAL presentation the host registry returns when
 * `schemas()` is called with no scope; it is deliberately incomplete and must
 * never be promoted to complete availability or used to prove a tool absent.
 */
function fixture(toolClassifications = {}, catalog = ['read', 'pwsh', 'subagent', 'web_fetch']) {
  const mutations = { create: 0, prompt: 0, restrict: 0, guard: 0, execute: 0 }
  const mutate = (name) => () => {
    mutations[name] += 1
    throw new Error(`Unexpected host mutation: ${name}`)
  }
  const services = {
    tools: {
      schemas: () => catalog === null ? undefined : catalog.map((name) => ({ name })),
      restrict: mutate('restrict'),
      guard: mutate('guard'),
      execute: mutate('execute')
    },
    sessionController: { create: mutate('create'), prompt: mutate('prompt') }
  }
  return {
    adapter: new DshAdapter({ get: (name) => services[name] }, { toolClassifications }),
    assertUnmutated: () => assert.deepEqual(mutations, { create: 0, prompt: 0, restrict: 0, guard: 0, execute: 0 })
  }
}

for (const name of ['pwsh', 'subagent']) {
  for (const catalogVerified of [true, false]) {
    test(`preflight rejects ${name}->other before dispatch regardless of global catalog content`, async () => {
      const host = fixture({ [name]: 'other' }, catalogVerified ? [name] : null)
      await assert.rejects(host.adapter.preflight(packet([name])), (error) => {
        assert.equal(error.code, 'adapter/scope-unsupported')
        assert.equal(error.dispatched, false)
        assert.match(error.message, new RegExp(name))
        assert.equal(error.details.denied[0].name, name)
        assert.equal(error.details.denied[0].code, 'adapter/scope-unsupported')
        assert.equal(error.message, error.details.denied[0].reason)
        return true
      })
      host.assertUnmutated()
    })
  }
}

test('read preflight succeeds without host mutations and reports availability as unproved', async () => {
  const host = fixture()
  const result = await host.adapter.preflight(packet(['read']))
  assert.equal(result.ok, true)
  assert.deepEqual(result.requestedTools, ['read'])
  assert.deepEqual(result.enforceableTools, ['read'])
  assert.equal(result.availableTools, null, 'an agentless global view is not a complete catalog')
  assert.equal(result.availabilityVerified, false, 'availability cannot be proved without a real agent')
  assert.equal(result.sessionVisibilityPending, true)
  host.assertUnmutated()
})

test('a nonempty global catalog missing the requested tool cannot prove absence', async () => {
  for (const catalog of [['write'], ['write', 'edit'], []]) {
    const host = fixture({}, catalog)
    const result = await host.adapter.preflight(packet(['read', 'write']))
    assert.equal(result.ok, true, `catalog ${JSON.stringify(catalog)} must not fabricate a missing tool`)
    assert.equal(result.availableTools, null)
    assert.equal(result.availabilityVerified, false)
    assert.equal(result.sessionVisibilityPending, true)
    assert.deepEqual(result.enforceableTools, ['read', 'write'])
    host.assertUnmutated()
  }
})

for (const override of [false, true]) {
  for (const allowNetwork of [false, true]) {
    test(`network admission requires permission with override=${override}, allowNetwork=${allowNetwork}`, async () => {
      const host = fixture(override ? { web_fetch: 'other' } : {})
      if (allowNetwork) {
        const result = await host.adapter.preflight(packet(['web_fetch'], true))
        assert.equal(result.ok, true)
        assert.deepEqual(result.enforceableTools, ['web_fetch'])
        assert.equal(result.availableTools, null)
        assert.equal(result.availabilityVerified, false)
        assert.equal(result.sessionVisibilityPending, true)
      } else {
        await assert.rejects(host.adapter.preflight(packet(['web_fetch'])), (error) => {
          assert.equal(error.code, 'adapter/scope-unsupported')
          assert.equal(error.dispatched, false)
          assert.match(error.message, /network/)
          return true
        })
      }
      host.assertUnmutated()
    })
  }
}
