// test/peer-bridge-client.test.mjs
//
// Contract checks for src/peer/bridge-client.mjs: the JSON-RPC request shape, per-call
// credential resolution (environment then credential file), the refusal when no
// credential exists, HTTP/JSON-RPC/isError failures with the bridge code, result paging
// and truncation, the argument shape of archive/cleanup, loopback-only URLs, and the
// rule that the resolved token never appears in an error message.
//
// The network is always a fake fetchImpl; the only real I/O is a credential file inside
// a temp directory that is removed in a finally block.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PeerPolicyError } from '../src/peer/chain.mjs';
import {
  CREDENTIAL_ENV,
  RESULT_PAGE_LIMIT,
  TRUNCATION_MARKER,
  createBridgeClient,
  isLocalBridgeUrl,
} from '../src/peer/bridge-client.mjs';

const URL_LOCAL = 'http://127.0.0.1:3080/mcp/codex-bridge-v1';
const TOKEN = 'bridge-token-0123456789abcdef';

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A Response-shaped stand-in: status/ok/text(). */
function httpReply(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/** A successful tools/call envelope carrying `structuredContent`. */
function toolResult(value, id = 1) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } };
}

/** A refused tools/call envelope (isError) carrying a bridge error body. */
function toolError(body, id = 1) {
  return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] } };
}

/** Record every fetch call and let `handler` produce the reply. */
function recorder(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const entry = { url, init, body: JSON.parse(init.body) };
    calls.push(entry);
    return handler(entry, calls.length);
  };
  return { impl, calls };
}

test('a call posts one JSON-RPC tools/call with the env token and returns structuredContent', async () => {
  const { impl, calls } = recorder(() => httpReply(toolResult({ taskId: 't-1', status: 'completed' })));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: '  env-token  ' }, fetchImpl: impl });
  assert.equal(Object.isFrozen(client), true);

  const dossier = await client.dossier('t-1');
  assert.deepEqual(dossier, { taskId: 't-1', status: 'completed' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_LOCAL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer env-token');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(calls[0].body, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'bridge_dossier', arguments: { taskId: 't-1' } },
  });

  // The token is resolved per call, and each request carries its own id.
  await client.dossier('t-2');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.id, 2);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer env-token');
});

test('the token falls back to the trimmed credential file and the env token still wins', async () => {
  await withTempDir('agent-bridge-client-', async (dir) => {
    const credentialFile = path.join(dir, 'bridge-token');
    await writeFile(credentialFile, '  file-token\n', 'utf8');

    const fromFile = recorder(() => httpReply(toolResult({ ok: true })));
    const clientA = createBridgeClient({ url: URL_LOCAL, credentialFile, env: {}, fetchImpl: fromFile.impl });
    await clientA.dossier('t-1');
    assert.equal(fromFile.calls[0].init.headers.Authorization, 'Bearer file-token');

    const both = recorder(() => httpReply(toolResult({ ok: true })));
    const clientB = createBridgeClient({ url: URL_LOCAL, credentialFile, env: { [CREDENTIAL_ENV]: 'env-wins' }, fetchImpl: both.impl });
    await clientB.dossier('t-1');
    assert.equal(both.calls[0].init.headers.Authorization, 'Bearer env-wins');

    // A blank credential file is "no credential", not an empty bearer token.
    await writeFile(credentialFile, '   \n', 'utf8');
    const blank = recorder(() => httpReply(toolResult({ ok: true })));
    const clientC = createBridgeClient({ url: URL_LOCAL, credentialFile, env: {}, fetchImpl: blank.impl });
    await assert.rejects(() => clientC.dossier('t-1'), { code: 'PEER_BRIDGE_UNAVAILABLE' });
    assert.equal(blank.calls.length, 0);
  });
});

test('a missing credential refuses before any request is made', async () => {
  const { impl, calls } = recorder(() => httpReply(toolResult({})));
  const client = createBridgeClient({ url: URL_LOCAL, env: {}, fetchImpl: impl });
  await assert.rejects(() => client.dossier('t-1'), (error) => {
    assert.equal(error instanceof PeerPolicyError, true);
    assert.equal(error.code, 'PEER_BRIDGE_UNAVAILABLE');
    assert.equal(error.detail.tool, 'bridge_dossier');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('a non-200 reply is PEER_BRIDGE with the tool and no bridge code', async () => {
  const { impl } = recorder(() => httpReply({ error: 'boom' }, 500));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: impl });
  await assert.rejects(() => client.archive('t-1', 2), (error) => {
    assert.equal(error.code, 'PEER_BRIDGE');
    assert.deepEqual(error.detail, { tool: 'bridge_archive', code: null });
    return true;
  });
});

test('a JSON-RPC error envelope is PEER_BRIDGE and a non-JSON body is refused too', async () => {
  const rpc = recorder(() => httpReply({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: rpc.impl });
  await assert.rejects(() => client.dossier('t-1'), (error) => {
    assert.equal(error.code, 'PEER_BRIDGE');
    assert.equal(error.detail.tool, 'bridge_dossier');
    assert.match(error.message, /Method not found/);
    return true;
  });

  const garbage = recorder(() => ({ status: 200, ok: true, async text() { return '<html>nope</html>'; } }));
  const client2 = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: garbage.impl });
  await assert.rejects(() => client2.dossier('t-1'), { code: 'PEER_BRIDGE' });
});

test('an isError result is PEER_BRIDGE with the bridge code parsed from content[0].text', async () => {
  const { impl } = recorder(() => httpReply(toolError({ code: 'TASK_NOT_SETTLED', message: 'Review requires a completed, stopped task' })));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: impl });
  await assert.rejects(() => client.dossier('t-1'), (error) => {
    assert.equal(error.code, 'PEER_BRIDGE');
    assert.deepEqual(error.detail, { tool: 'bridge_dossier', code: 'TASK_NOT_SETTLED' });
    assert.match(error.message, /completed, stopped task/);
    return true;
  });

  // No parsable code text: the call still fails, with code null.
  const opaque = recorder(() => httpReply({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'not json' }] } }));
  const client2 = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: opaque.impl });
  await assert.rejects(() => client2.cleanup('t-1'), (error) => {
    assert.equal(error.code, 'PEER_BRIDGE');
    assert.deepEqual(error.detail, { tool: 'bridge_cleanup', code: null });
    return true;
  });
});

test('resultText pages bridge_result from offset 0 and follows nextOffset', async () => {
  const pages = [
    { text: 'aaa', offset: 0, nextOffset: 3, totalChars: 9, hasMore: true },
    { text: 'bbb', offset: 3, nextOffset: 6, totalChars: 9, hasMore: true },
    { text: 'ccc', offset: 6, nextOffset: 9, totalChars: 9, hasMore: false },
  ];
  let index = 0;
  const { impl, calls } = recorder(() => httpReply(toolResult(pages[index++])));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: impl });

  assert.equal(await client.resultText('t-9'), 'aaabbbccc');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.body.params.name), ['bridge_result', 'bridge_result', 'bridge_result']);
  assert.deepEqual(calls.map((call) => call.body.params.arguments), [
    { taskId: 't-9', offset: 0, limit: RESULT_PAGE_LIMIT },
    { taskId: 't-9', offset: 3, limit: RESULT_PAGE_LIMIT },
    { taskId: 't-9', offset: 6, limit: RESULT_PAGE_LIMIT },
  ]);
});

test('resultText returns an empty string when the bridge has no text', async () => {
  const { impl, calls } = recorder(() => httpReply(toolResult({ text: '', offset: 0, nextOffset: 0, totalChars: 0, hasMore: false })));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: impl });
  assert.equal(await client.resultText('t-0'), '');
  assert.equal(calls.length, 1);
});

test('resultText stops at maxChars and marks the truncation', async () => {
  const longPage = recorder(() => httpReply(toolResult({ text: 'abcdefghij', offset: 0, nextOffset: 10, totalChars: 10, hasMore: false })));
  const clientA = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: longPage.impl });
  assert.equal(await clientA.resultText('t-1', { maxChars: 4 }), `abcd${TRUNCATION_MARKER}`);
  assert.equal(longPage.calls.length, 1);

  // A page that exactly fills the cap while hasMore is still true is truncated too.
  const exact = recorder(() => httpReply(toolResult({ text: 'abcd', offset: 0, nextOffset: 4, totalChars: 8, hasMore: true })));
  const clientB = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: exact.impl });
  assert.equal(await clientB.resultText('t-1', { maxChars: 4 }), `abcd${TRUNCATION_MARKER}`);
  assert.equal(exact.calls.length, 1);

  // Under the cap nothing is marked.
  const small = recorder(() => httpReply(toolResult({ text: 'ab', offset: 0, nextOffset: 2, totalChars: 2, hasMore: false })));
  const clientC = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: small.impl });
  assert.equal(await clientC.resultText('t-1', { maxChars: 4 }), 'ab');
});

test('archive and cleanup send their exact arguments', async () => {
  const { impl, calls } = recorder(() => httpReply(toolResult({ archived: true })));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: impl });
  await client.archive('t-1', 4);
  await client.cleanup('t-1');
  await client.cleanup('t-2', { dryRun: true });
  assert.deepEqual(calls.map((call) => ({ name: call.body.params.name, arguments: call.body.params.arguments })), [
    { name: 'bridge_archive', arguments: { taskId: 't-1', revision: 4 } },
    { name: 'bridge_cleanup', arguments: { taskId: 't-1', dryRun: false } },
    { name: 'bridge_cleanup', arguments: { taskId: 't-2', dryRun: true } },
  ]);
});

test('only a loopback http bridge url is accepted', () => {
  const fetchImpl = async () => httpReply(toolResult({}));
  const refused = [
    'http://example.com/mcp',
    'http://127.0.0.1.evil.test/mcp',
    'https://127.0.0.1:3080/mcp',
    'http://[::1]:3080/mcp',
    'file:///tmp/x',
    'not a url',
    '',
    '   ',
  ];
  for (const url of refused) {
    assert.throws(
      () => createBridgeClient({ url, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl }),
      { code: 'PEER_CONFIG_INVALID' },
      `expected refusal for ${JSON.stringify(url)}`,
    );
  }
  // A missing or non-function network seam is a configuration error, not a call failure.
  assert.throws(() => createBridgeClient({ url: URL_LOCAL, env: {}, fetchImpl: null }), { code: 'PEER_CONFIG_INVALID' });
  assert.throws(() => createBridgeClient({ url: URL_LOCAL, env: {}, fetchImpl, timeoutMs: 0 }), { code: 'PEER_CONFIG_INVALID' });
  for (const url of ['http://127.0.0.1:3080/mcp/codex-bridge-v1', 'http://localhost/mcp', 'http://LOCALHOST:1/x']) {
    assert.equal(isLocalBridgeUrl(url), true, `expected ${url} to be local`);
  }
  assert.equal(isLocalBridgeUrl('https://127.0.0.1/mcp'), false);
  assert.equal(isLocalBridgeUrl(undefined), false);
});

test('the credential never appears in an error message or detail', async () => {
  const token = 'super-secret-bridge-token-42';

  // A transport error whose text echoes the token is redacted.
  const throwing = createBridgeClient({
    url: URL_LOCAL,
    env: { [CREDENTIAL_ENV]: token },
    fetchImpl: async () => { throw new Error(`connect failed while sending ${token}`); },
  });
  await assert.rejects(() => throwing.dossier('t-1'), (error) => {
    assert.equal(error.code, 'PEER_BRIDGE');
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error.detail).includes(token), false);
    return true;
  });

  // A bridge refusal whose message echoes the token is redacted too.
  const echoing = createBridgeClient({
    url: URL_LOCAL,
    env: { [CREDENTIAL_ENV]: token },
    fetchImpl: async () => httpReply(toolError({ code: 'TASK_NOT_SETTLED', message: `credential ${token} cannot close this task` })),
  });
  await assert.rejects(() => echoing.dossier('t-1'), (error) => {
    assert.equal(error.detail.code, 'TASK_NOT_SETTLED');
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error.detail).includes(token), false);
    return true;
  });

  // The unavailable-credential refusal cannot leak a token either.
  const missing = createBridgeClient({ url: URL_LOCAL, env: {}, fetchImpl: async () => httpReply(toolResult({})) });
  await assert.rejects(() => missing.cleanup('t-1'), (error) => {
    assert.equal(error.code, 'PEER_BRIDGE_UNAVAILABLE');
    assert.equal(error.message.includes(token), false);
    return true;
  });
});
