// MCP tool-contract coverage for bridge_followup (plan sections 2 and 4).
//
// Dispatcher-level only: no host, no network calls beyond an ephemeral loopback HTTP
// server used to prove the advertised tools/list and the tools/call transport.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOOLS, BRIDGE_VERSION, createDispatcher, createMcpHandler } from '../src/mcp.mjs';
import { loadControllerRegistry } from '../src/controller-auth.mjs';

const context = { principal: { id: 'codex', admin: false }, via: null, controllerIds: ['codex'] };
const store = { get: id => ({ id, submittedBy: 'codex' }) };

test('tools/list advertises bridge_followup with the bounded plan schema', () => {
  const spec = TOOLS.find(tool => tool.name === 'bridge_followup');
  assert.ok(spec, 'bridge_followup must be advertised');
  assert.equal(spec.category, 'mutate');
  assert.equal(spec.inputSchema.type, 'object');
  assert.equal(spec.inputSchema.additionalProperties, false, 'no extra field may be batched into a follow-up');
  assert.deepEqual(spec.inputSchema.required, ['taskId', 'revision', 'afterAttemptId', 'followupId', 'text']);
  const properties = spec.inputSchema.properties;
  assert.equal(properties.taskId.type, 'string');
  assert.equal(properties.taskId.minLength, 1);
  assert.equal(properties.taskId.pattern, '\\S');
  assert.equal(properties.revision.type, 'integer');
  assert.equal(properties.revision.minimum, 1);
  assert.equal(properties.revision.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(properties.afterAttemptId.type, 'string');
  assert.equal(properties.afterAttemptId.minLength, 1);
  assert.equal(properties.afterAttemptId.pattern, '\\S');
  assert.equal(properties.followupId.type, 'string');
  assert.equal(properties.followupId.minLength, 1);
  assert.equal(properties.followupId.maxLength, 200);
  assert.equal(properties.followupId.pattern, '\\S');
  assert.equal(properties.text.type, 'string');
  assert.equal(properties.text.minLength, 1);
  assert.equal(properties.text.maxLength, 20000);
  assert.equal(properties.text.pattern, '\\S');
  assert.match(spec.description, /existing owned session/);
  assert.match(spec.description, /investigate or review/);
  assert.match(spec.description, /bridge_result/);
  assert.match(spec.description, /identical/i);
});

test('bridge_followup forwards exactly the five bounded fields to the service', async () => {
  const seen = [];
  const call = createDispatcher({
    store,
    followup: async (id, options) => {
      seen.push({ id, options });
      return { taskId: id, followup: { followupId: options.followupId, afterAttemptId: options.afterAttemptId, attemptId: 'attempt-new', round: 1, replay: false } };
    },
  });
  const text = '  keep surrounding whitespace  ';
  const result = await call('bridge_followup', { taskId: 't-1', revision: 3, afterAttemptId: 'attempt-2', followupId: 'follow-1', text }, context);
  assert.deepEqual(seen, [{ id: 't-1', options: { revision: 3, afterAttemptId: 'attempt-2', followupId: 'follow-1', text } }]);
  assert.equal(seen[0].options.text, text, 'the question is forwarded verbatim, never trimmed');
  assert.equal(seen[0].options.taskId, undefined, 'taskId travels only as the service identity argument');
  assert.deepEqual(result.followup, { followupId: 'follow-1', afterAttemptId: 'attempt-2', attemptId: 'attempt-new', round: 1, replay: false });
});

test('bridge_followup rejects missing, blank, overlong, extra and mistyped fields before the service', async () => {
  let calls = 0;
  const call = createDispatcher({ store, followup: async () => { calls += 1; return {}; } });
  const valid = { taskId: 't-1', revision: 1, afterAttemptId: 'attempt-1', followupId: 'follow-1', text: 'question' };
  const invalid = [
    ['missing taskId', { revision: 1, afterAttemptId: 'attempt-1', followupId: 'follow-1', text: 'question' }],
    ['missing revision', { taskId: 't-1', afterAttemptId: 'attempt-1', followupId: 'follow-1', text: 'question' }],
    ['missing afterAttemptId', { taskId: 't-1', revision: 1, followupId: 'follow-1', text: 'question' }],
    ['missing followupId', { taskId: 't-1', revision: 1, afterAttemptId: 'attempt-1', text: 'question' }],
    ['missing text', { taskId: 't-1', revision: 1, afterAttemptId: 'attempt-1', followupId: 'follow-1' }],
    ['blank afterAttemptId', { ...valid, afterAttemptId: '   ' }],
    ['blank followupId', { ...valid, followupId: '\t' }],
    ['blank text', { ...valid, text: ' \n ' }],
    ['oversize followupId', { ...valid, followupId: 'x'.repeat(201) }],
    ['oversize text', { ...valid, text: 'x'.repeat(20001) }],
    ['extra field', { ...valid, packet: {} }],
    ['extra scope', { ...valid, scope: { allowShell: true } }],
    ['revision zero', { ...valid, revision: 0 }],
    ['revision string', { ...valid, revision: '1' }],
    ['revision fractional', { ...valid, revision: 1.5 }],
    ['afterAttemptId type', { ...valid, afterAttemptId: 7 }],
    ['followupId type', { ...valid, followupId: null }],
    ['text type', { ...valid, text: ['question'] }],
  ];
  for (const [label, args] of invalid) {
    await assert.rejects(() => call('bridge_followup', args, context), error => error.code === 'INVALID_ARGUMENTS', label);
  }
  assert.equal(calls, 0, 'no invalid request may reach the service');
  // Boundary values are accepted and forwarded.
  await call('bridge_followup', { ...valid, followupId: 'x'.repeat(200), text: 'x'.repeat(20000) }, context);
  assert.equal(calls, 1);
});

test('bridge_result advertises attemptId and forwards it to the service', async () => {
  const spec = TOOLS.find(tool => tool.name === 'bridge_result');
  assert.ok(spec);
  assert.equal(spec.inputSchema.properties.attemptId.type, 'string');
  assert.equal(spec.inputSchema.required.includes('attemptId'), false, 'attemptId stays optional');
  const calls = [];
  const call = createDispatcher({
    result: (id, options) => { calls.push({ id, options }); return { taskId: id, attemptId: options.attemptId ?? 'current' }; },
  });
  const selected = await call('bridge_result', { taskId: 't-1', attemptId: 'attempt-old', offset: 4, limit: 8 }, context);
  assert.equal(selected.attemptId, 'attempt-old');
  assert.deepEqual(calls[0], { id: 't-1', options: { taskId: 't-1', attemptId: 'attempt-old', offset: 4, limit: 8 } });
  const current = await call('bridge_result', { taskId: 't-1' }, context);
  assert.equal(current.attemptId, 'current');
  assert.deepEqual(calls[1], { id: 't-1', options: { taskId: 't-1' } });
});

test('bridge_capabilities reports lifecycle.followup unsupported when the adapter has no followup method', async () => {
  const baseCaps = { adapterVersion: '0.6.0', enforcement: { shell: false }, lifecycle: { reconsider: { supported: true } } };
  const without = await createDispatcher({
    maxConcurrent: 2,
    adapter: { capabilities: async () => baseCaps },
  })('bridge_capabilities', {}, context);
  assert.equal(without.version, BRIDGE_VERSION);
  assert.deepEqual(without.lifecycle.followup, { supported: false, reason: 'adapter has no followup method' });
  assert.deepEqual(without.lifecycle.reconsider, { supported: true }, 'the rest of the lifecycle report is preserved');
  assert.deepEqual(without.enforcement, { shell: false }, 'the rest of the adapter report is preserved');
  assert.equal(without.adapterVersion, '0.6.0');
  assert.equal(without.maxConcurrent, 2);

  // A missing capabilities() object must not prevent the honest unsupported report.
  const nullCaps = await createDispatcher({
    maxConcurrent: 1,
    adapter: { capabilities: async () => null },
  })('bridge_capabilities', {}, context);
  assert.deepEqual(nullCaps.lifecycle.followup, { supported: false, reason: 'adapter has no followup method' });

  // When the adapter DOES expose the seam its own lifecycle report wins untouched.
  const supportedCaps = { ...baseCaps, lifecycle: { reconsider: { supported: true }, followup: { supported: true, mode: 'execution' } } };
  const supported = await createDispatcher({
    maxConcurrent: 2,
    adapter: { capabilities: async () => supportedCaps, followup: async () => ({}) },
  })('bridge_capabilities', {}, context);
  assert.deepEqual(supported.lifecycle, supportedCaps.lifecycle);

  // A follow-up-capable adapter that advertises no lifecycle block invents nothing.
  const silent = await createDispatcher({
    maxConcurrent: 2,
    adapter: { capabilities: async () => ({}), followup: async () => ({}) },
  })('bridge_capabilities', {}, context);
  assert.equal(Object.hasOwn(silent, 'lifecycle'), false);
});

test('the MCP transport lists bridge_followup and dispatches it over tools/call', async (t) => {
  const token = 'followup-mcp-token-'.repeat(2);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-followup-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'token.txt');
  fs.writeFileSync(tokenFile, token);
  const registry = loadControllerRegistry([{ id: 'codex', tokenFile }]);
  const seen = [];
  const service = {
    store,
    followup: async (id, options) => {
      seen.push({ id, options });
      return { taskId: id, followup: { followupId: options.followupId, afterAttemptId: options.afterAttemptId, attemptId: 'attempt-new', round: 1, replay: false } };
    },
  };
  const server = http.createServer(createMcpHandler(service, { registry }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = body => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try {
    const listed = await (await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    const advertised = listed.result.tools.find(tool => tool.name === 'bridge_followup');
    assert.ok(advertised, 'tools/list must advertise bridge_followup');
    assert.equal(advertised.inputSchema.additionalProperties, false);
    assert.deepEqual(advertised.inputSchema.required, ['taskId', 'revision', 'afterAttemptId', 'followupId', 'text']);

    const response = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_followup', arguments: { taskId: 't-1', revision: 2, afterAttemptId: 'attempt-1', followupId: 'follow-1', text: 'next?' } } })).json();
    assert.equal(response.result.structuredContent.followup.attemptId, 'attempt-new');
    assert.deepEqual(seen, [{ id: 't-1', options: { revision: 2, afterAttemptId: 'attempt-1', followupId: 'follow-1', text: 'next?' } }]);

    const rejected = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_followup', arguments: { taskId: 't-1', revision: 2, afterAttemptId: 'attempt-1', followupId: 'follow-1', text: 'next?', model: 'other' } } })).json();
    assert.equal(JSON.parse(rejected.result.content[0].text).code, 'INVALID_ARGUMENTS');
    assert.equal(seen.length, 1, 'the rejected request must never reach the service');
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
