import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveBridgeCredential, stripBridgeCredentials } from '../src/bridge-credentials.mjs';
import { createCarrier, defaultSpawnSidecar, resolveCarrierToken } from '../src/bridge-carrier.mjs';
import { testDir } from './helpers/test-root.mjs';

const TOKEN = 'a3-carrier-test-token-0123456789abcdef';
const FILE_TOKEN = 'a3-carrier-file-token-0123456789abcdef';
const CALL = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bridge_submit', arguments: { packet: { objective: 'test' } } } });
const REPLY = { jsonrpc: '2.0', id: 7, result: { structuredContent: { taskId: 'test-task' } } };

function carrierHarness({ env = {}, readFileImpl = async () => FILE_TOKEN, fetchImpl } = {}) {
  const writes = [];
  const logs = [];
  const calls = [];
  const carrier = createCarrier({
    env,
    credentialFile: 'test-configured-credential',
    endpoint: 'http://127.0.0.1:3080/mcp/test',
    readFileImpl,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fetchImpl ? fetchImpl(url, init) : { status: 200, ok: true, text: async () => JSON.stringify(REPLY) };
    },
    stdout: { write: (text) => writes.push(text) },
    logger: (record) => logs.push(record),
    watchdogEnabled: false,
  });
  return { carrier, writes, logs, calls };
}

test('controller credential precedence selects one source and trims the value', async () => {
  const reads = [];
  const readFileImpl = async (file, encoding) => {
    reads.push([file, encoding]);
    return `  ${FILE_TOKEN}\n`;
  };
  assert.equal(await resolveBridgeCredential({
    env: { DSH_MCP_TOKEN: ` ${TOKEN} `, DSH_BRIDGE_CREDENTIAL_FILE: 'env-file' },
    credentialFile: 'configured-file', readFileImpl,
  }), TOKEN);
  assert.equal(reads.length, 0, 'an environment token never reads a file');

  assert.equal(await resolveBridgeCredential({
    env: { DSH_MCP_TOKEN: ' \n', DSH_BRIDGE_CREDENTIAL_FILE: 'env-file' },
    credentialFile: 'configured-file', readFileImpl,
  }), FILE_TOKEN);
  assert.deepEqual(reads, [['env-file', 'utf8']]);

  reads.length = 0;
  assert.equal(await resolveBridgeCredential({
    env: { DSH_BRIDGE_CREDENTIAL_FILE: '  ' }, credentialFile: 'configured-file', readFileImpl,
  }), FILE_TOKEN);
  assert.deepEqual(reads, [['configured-file', 'utf8']]);
});

test('credential environment names are case insensitive', async () => {
  let reads = 0;
  assert.equal(await resolveBridgeCredential({
    env: { dsh_mcp_token: ` ${TOKEN} ` },
    readFileImpl: async () => { reads += 1; return FILE_TOKEN; },
  }), TOKEN);
  assert.equal(reads, 0);
  const files = [];
  assert.equal(await resolveBridgeCredential({
    env: { Dsh_Bridge_Credential_File: 'mixed-case-file' },
    readFileImpl: async (file) => { files.push(file); return FILE_TOKEN; },
  }), FILE_TOKEN);
  assert.deepEqual(files, ['mixed-case-file']);
});

test('an unavailable selected credential file never falls through to a different identity', async () => {
  for (const unavailable of ['empty', 'unreadable']) {
    const reads = [];
    const token = await resolveBridgeCredential({
      env: { DSH_BRIDGE_CREDENTIAL_FILE: 'selected-file' },
      credentialFile: 'other-controller-file',
      readFileImpl: async (file) => {
        reads.push(file);
        if (unavailable === 'unreadable') throw new Error(`unreadable test file: ${TOKEN}`);
        return ' \n';
      },
    });
    assert.equal(token, null, unavailable);
    assert.deepEqual(reads, ['selected-file'], unavailable);
  }
  let reads = 0;
  assert.equal(await resolveBridgeCredential({ env: {}, readFileImpl: async () => { reads += 1; return FILE_TOKEN; } }), null);
  assert.equal(reads, 0, 'the common resolver has no implicit machine credential file');
});

test('disabled carrier credentials are refused before reading even with an inherited token', async () => {
  for (const env of [
    { DSH_BRIDGE_DISABLED: '1', DSH_MCP_TOKEN: TOKEN },
    { dsh_bridge_disabled: '1', dsh_mcp_token: TOKEN, DSH_BRIDGE_CREDENTIAL_FILE: 'file' },
  ]) {
    let reads = 0;
    const token = await resolveBridgeCredential({ env, credentialFile: 'local-file', readFileImpl: async () => { reads += 1; return FILE_TOKEN; } });
    assert.equal(token, null);
    assert.equal(reads, 0);
  }
});

test('delegate marker and multi-member chain each forbid local-file fallback after token filtering', async () => {
  for (const env of [
    { DSH_BRIDGE_DELEGATED: '1' },
    { dsh_bridge_delegated: '1', DSH_MCP_TOKEN: '  ' },
    { AGENT_BRIDGE_CHAIN: 'claude-code>codex' },
    { agent_bridge_chain: 'codex>claude-code', DSH_MCP_TOKEN: '' },
  ]) {
    let reads = 0;
    const token = await resolveBridgeCredential({
      env: { ...env, DSH_BRIDGE_CREDENTIAL_FILE: 'child-controller-file' },
      credentialFile: 'another-controller-file',
      readFileImpl: async () => { reads += 1; return FILE_TOKEN; },
    });
    assert.equal(token, null, JSON.stringify(env));
    assert.equal(reads, 0, 'filtered delegation cannot recover a local identity');
  }
  assert.equal(await resolveBridgeCredential({
    env: { DSH_BRIDGE_DELEGATED: '1', DSH_MCP_TOKEN: TOKEN }, readFileImpl: async () => assert.fail('must not read'),
  }), TOKEN);
  assert.equal(await resolveBridgeCredential({
    env: { AGENT_BRIDGE_CHAIN: 'codex' }, credentialFile: 'root-file', readFileImpl: async () => FILE_TOKEN,
  }), FILE_TOKEN, 'a root single-member context is not a delegate');
});

test('shared bridge environment cleaning removes all case variants and preserves unrelated values', () => {
  const source = {
    DSH_MCP_TOKEN: TOKEN, dsh_mcp_token: FILE_TOKEN,
    Dsh_Bridge_Credential_File: 'file', dsh_bridge_delegated: '1', DSH_BRIDGE_DISABLED: '1',
    PATH: 'preserved-path', psMODULEpath: '', SystemRoot: 'C:\\Windows', TEMP: 'fixture-temp',
    DSH_BRIDGE_URL: 'http://127.0.0.1:3080/mcp/test', DSH_HOME: 'home',
    DSH_BRIDGE_WATCHDOG_CONFIG: 'watchdog-file', AGENT_BRIDGE_CHAIN: 'claude-code>codex', OTHER: undefined,
  };
  const before = { ...source };
  assert.deepEqual(stripBridgeCredentials(source), {
    PATH: 'preserved-path', psMODULEpath: '', SystemRoot: 'C:\\Windows', TEMP: 'fixture-temp',
    DSH_BRIDGE_URL: 'http://127.0.0.1:3080/mcp/test', DSH_HOME: 'home',
    DSH_BRIDGE_WATCHDOG_CONFIG: 'watchdog-file', AGENT_BRIDGE_CHAIN: 'claude-code>codex', OTHER: undefined,
  });
  assert.deepEqual(source, before, 'cleaning does not change the caller environment');
});

test('carrier token resolution uses the common environment file priority and delegation refusal', async () => {
  const reads = [];
  assert.equal(await resolveCarrierToken({
    env: { DSH_BRIDGE_CREDENTIAL_FILE: 'env-file' }, credentialFile: 'configured-file',
    readFileImpl: async (file) => { reads.push(file); return FILE_TOKEN; },
  }), FILE_TOKEN);
  assert.deepEqual(reads, ['env-file']);
  assert.equal(await resolveCarrierToken({
    env: { DSH_BRIDGE_DELEGATED: '1' }, credentialFile: 'local-file',
    readFileImpl: async () => assert.fail('must not fall back'),
  }), null);
});

test('carrier root requests preserve JSON-RPC replies and omit both via headers', async () => {
  for (const rootEnv of [{}, { AGENT_BRIDGE_CHAIN: 'codex', AGENT_BRIDGE_ROOT_TASK: 'root-task' }, { AGENT_BRIDGE_ROOT_TASK: 'root-task' }]) {
    const { carrier, calls, writes } = carrierHarness({ env: { DSH_MCP_TOKEN: TOKEN, ...rootEnv } });
    assert.equal((await carrier.handleLine(CALL)).code, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.body, CALL);
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.has('X-Agent-Bridge-Chain'), false);
    assert.equal(headers.has('X-Agent-Bridge-Root-Task'), false);
    assert.deepEqual(writes.map(JSON.parse), [REPLY]);
    await carrier.whenIdle();
  }
});

test('carrier delegate requests send client-declared chain and optional root task in both directions', async () => {
  for (const [chain, rootTask, delegated] of [
    ['claude-code>codex', 'root:task-1', '1'],
    ['codex>claude-code', null, undefined],
  ]) {
    const { carrier, calls } = carrierHarness({ env: {
      DSH_MCP_TOKEN: TOKEN, AGENT_BRIDGE_CHAIN: chain,
      ...(rootTask ? { AGENT_BRIDGE_ROOT_TASK: rootTask } : {}),
      ...(delegated ? { DSH_BRIDGE_DELEGATED: delegated } : {}),
    } });
    await carrier.handleLine(CALL);
    assert.equal(calls.length, 1);
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get('X-Agent-Bridge-Chain'), chain);
    assert.equal(headers.get('X-Agent-Bridge-Root-Task'), rootTask);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.body.includes(TOKEN), false);
    await carrier.whenIdle();
  }
});

test('disabled and token-filtered delegates produce one credential error without HTTP or disk access', async () => {
  for (const env of [
    { DSH_BRIDGE_DISABLED: '1', DSH_MCP_TOKEN: TOKEN },
    { DSH_BRIDGE_DELEGATED: '1' },
    { AGENT_BRIDGE_CHAIN: 'claude-code>codex', DSH_MCP_TOKEN: ' ' },
  ]) {
    let reads = 0;
    const { carrier, calls, writes, logs } = carrierHarness({ env, readFileImpl: async () => { reads += 1; return FILE_TOKEN; } });
    assert.equal((await carrier.handleLine(CALL)).code, -32000);
    assert.equal(calls.length, 0);
    assert.equal(reads, 0);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0]).id, 7);
    assert.equal(JSON.parse(writes[0]).error.code, -32000);
    assert.match(JSON.parse(writes[0]).error.message, /credential|disabled|delegat/i);
    assert.equal(JSON.stringify({ writes, logs }).includes(TOKEN), false);
    assert.equal(JSON.stringify({ writes, logs }).includes(FILE_TOKEN), false);
  }
});

test('carrier transport errors cannot expose the resolved token in replies or logs', async () => {
  for (const phase of ['fetch', 'body', 'json']) {
    const { carrier, writes, logs } = carrierHarness({
      env: { DSH_MCP_TOKEN: TOKEN },
      fetchImpl: async () => {
        if (phase === 'fetch') throw new Error(`transport rejected ${TOKEN}`);
        return { status: 200, ok: true, text: async () => {
          if (phase === 'body') throw new Error(`reply read failed ${TOKEN}`);
          return `invalid-json-${TOKEN}`;
        } };
      },
    });
    assert.equal((await carrier.handleLine(CALL)).code, -32000, phase);
    assert.equal(writes.length, 1, phase);
    assert.equal(JSON.parse(writes[0]).error.code, -32000, phase);
    assert.equal(JSON.stringify({ writes, logs }).includes(TOKEN), false, phase);
  }
});

test('carrier HTTP 202 remains silent and HTTP faults preserve the transport error code', async () => {
  for (const [status, expectedWrites] of [[202, 0], [500, 1]]) {
    const { carrier, writes } = carrierHarness({
      env: { DSH_MCP_TOKEN: TOKEN },
      fetchImpl: async () => ({ status, ok: status === 202, text: async () => assert.fail('no response body should be read') }),
    });
    const result = await carrier.handleLine(CALL);
    assert.equal(result.code, status === 202 ? 202 : -32000);
    assert.equal(writes.length, expectedWrites);
    if (expectedWrites) assert.equal(JSON.parse(writes[0]).error.message, 'DSH bridge HTTP 500');
  }
});

test('watchdog sidecar spawn receives no bridge token, credential source, or delegation markers', () => {
  const calls = [];
  const logs = [];
  defaultSpawnSidecar({
    spec: { command: 'test-node', args: ['test-sidecar.mjs'] },
    taskId: 'task-1', attemptId: 'attempt-1', createdAt: 1, timeoutMs: 1000, deadlineAt: 1001,
    env: {
      DSH_MCP_TOKEN: TOKEN, dsh_mcp_token: FILE_TOKEN, DSH_BRIDGE_CREDENTIAL_FILE: 'local-file',
      DSH_BRIDGE_DELEGATED: '1', DSH_BRIDGE_DISABLED: '1', CODEX_THREAD_ID: 'thread-1',
      DSH_BRIDGE_WATCHDOG_CONFIG: 'watchdog-file',
    },
    spawnImpl: (command, args, options) => { calls.push({ command, args, options }); return { pid: 123, on() {}, unref() {} }; },
    logger: (record) => logs.push(record),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.env, { CODEX_THREAD_ID: 'thread-1', DSH_BRIDGE_WATCHDOG_CONFIG: 'watchdog-file' });
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(JSON.stringify({ calls, logs }).includes(TOKEN), false);
  assert.equal(JSON.stringify({ calls, logs }).includes(FILE_TOKEN), false);
});

test('Codex MCP templates forward the credential and delegation context through both stdio entries', async () => {
  const config = JSON.parse(await readFile(new URL('../.codex-mcp.json', import.meta.url), 'utf8'));
  const expected = [
    'DSH_MCP_TOKEN', 'DSH_BRIDGE_CREDENTIAL_FILE', 'DSH_BRIDGE_DISABLED', 'DSH_BRIDGE_DELEGATED',
    'AGENT_BRIDGE_CHAIN', 'AGENT_BRIDGE_ROOT_TASK', 'AGENT_BRIDGE_MAX_DEPTH', 'AGENT_BRIDGE_MAX_DELEGATE_DEPTH',
  ];
  for (const name of ['dsh_project', 'agent_peer']) {
    const entry = config.mcpServers[name];
    assert.equal(entry.command, 'node', name);
    for (const key of expected) assert.ok(entry.env_vars.includes(key), `${name} must forward ${key}`);
    assert.equal(Object.keys(entry.env ?? {}).some((key) => /^DSH_MCP_TOKEN$/i.test(key)), false, `${name} must not override an inherited token`);
  }
  assert.deepEqual(config.mcpServers.dsh_project.args, ['./bin/bridge.mjs']);
  assert.deepEqual(config.mcpServers.agent_peer.args, ['./bin/peer-mcp.mjs']);
});

test('Claude root config uses file credentials for both stdio servers without token or via defaults', async () => {
  const plugin = JSON.parse(await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(plugin.userConfig.bridge_credential_file.type, 'file');
  assert.equal(plugin.userConfig.bridge_credential_file.required, true);
  assert.equal(plugin.mcpServers.dsh_project.type, 'stdio');
  assert.deepEqual(plugin.mcpServers.dsh_project.args, ['${CLAUDE_PLUGIN_ROOT}/bin/bridge.mjs']);
  for (const entry of Object.values(plugin.mcpServers)) {
    assert.equal(entry.command, '${user_config.node_path}');
    assert.equal(entry.env.DSH_BRIDGE_CREDENTIAL_FILE, '${user_config.bridge_credential_file}');
    assert.equal(entry.env.DSH_BRIDGE_URL, '${user_config.dsh_bridge_url}');
    assert.equal(entry.headers, undefined);
    assert.equal(JSON.stringify(entry).includes('DSH_MCP_TOKEN'), false);
    assert.equal(Object.keys(entry.env).some((key) => /^(AGENT_BRIDGE_CHAIN|AGENT_BRIDGE_ROOT_TASK)$/i.test(key)), false);
  }
});

test('both roots authenticate from file paths containing spaces and Chinese text without via', async (t) => {
  const dir = testDir(t, 'controller-carrier');
  for (const self of ['claude-code', 'codex']) {
    const credentialFile = path.join(dir, `${self} 凭据 file.token`);
    await writeFile(credentialFile, FILE_TOKEN);
    const f = carrierHarness({ env: { DSH_BRIDGE_CREDENTIAL_FILE: credentialFile }, readFileImpl: readFile });
    await f.carrier.handleLine(CALL);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${FILE_TOKEN}`);
    assert.equal(f.calls[0].init.headers['X-Agent-Bridge-Chain'], undefined);
    assert.equal(f.calls[0].init.headers['X-Agent-Bridge-Root-Task'], undefined);
    assert.equal(JSON.stringify({ writes: f.writes, logs: f.logs }).includes(FILE_TOKEN), false);
  }
});
