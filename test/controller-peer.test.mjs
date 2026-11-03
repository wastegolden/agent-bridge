import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridgeClient } from '../src/peer/bridge-client.mjs';
import { childEnvironment } from '../src/peer/cli.mjs';
import { normalizePeerConfig } from '../src/peer/config.mjs';
import { createPeerJobs, defaultKillTree } from '../src/peer/jobs.mjs';
import { createPeerServer } from '../src/peer/server.mjs';
import { readProcessTable } from '../src/peer/lineage.mjs';
import { createCodexThreadClient } from '../src/peer/codex-threads.mjs';
import { createCarrier } from '../src/bridge-carrier.mjs';

const TOKEN = 'a3-peer-root-test-token-0123456789abcdef';
const OTHER_TOKEN = 'a3-peer-local-test-token-fedcba9876543210';
const URL = 'http://127.0.0.1:3199/mcp/controller-test';
const TEMP_ROOT = fileURLToPath(new globalThis.URL('../.plans/test-tmp/', import.meta.url));
const result = (value) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: value } }) });
const identity = (self = 'claude-code') => ({ controllerIdentity: { enabled: true, self, admin: false } });

// Real job/lineage persistence, deterministic child and HTTP seams. Tests using a
// real child below retain their assertions when the sandbox rejects spawn.
async function fixture(t, { self = 'claude-code', env = {}, fileOnly = false, bridge = true, response = identity(self), realChild = false, resolveLineage = null } = {}) {
  await mkdir(TEMP_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEMP_ROOT, 'controller-peer-'));
  const credentialFile = path.join(dir, 'root.token');
  await writeFile(credentialFile, TOKEN);
  const config = normalizePeerConfig({
    schemaVersion: 1, stateDir: path.join(dir, 'state'),
    peers: { codex: { executable: process.execPath, threadSection: null }, 'claude-code': { executable: process.execPath } },
    records: { enabled: false },
    ...(bridge ? { bridge: { url: URL, credentialFile } } : {}),
  });
  const requests = [];
  const logs = [];
  let capabilityResponse = response;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (capabilityResponse instanceof Error) throw capabilityResponse;
    return typeof capabilityResponse === 'function' ? capabilityResponse(options) : result(capabilityResponse);
  });
  const spawned = [];
  const starts = [];
  const finish = (child) => {
    const output = child.target === 'codex'
      ? { type: 'thread.started', thread_id: 'a3-session' }
      : { type: 'result', is_error: false, result: 'done', session_id: 'a3-session' };
    child.stdout.write(`${JSON.stringify(output)}\n`);
    if (child.target === 'codex') child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`);
    child.emit('close', 0, null);
  };
  const childFile = path.join(dir, 'child.mjs');
  if (realChild) {
    await writeFile(childFile, `
      if (process.env.DSH_MCP_TOKEN !== ${JSON.stringify(TOKEN)}) throw new Error('credential mismatch');
      if (process.env.DSH_BRIDGE_DELEGATED !== '1') throw new Error('delegation marker missing');
      let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
      if (prompt.includes(process.env.DSH_MCP_TOKEN)) throw new Error('credential in prompt');
      if (process.env.AGENT_BRIDGE_SELF === 'codex') {
        console.log(JSON.stringify({type:'thread.started',thread_id:'a3-session'}));
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
      } else console.log(JSON.stringify({type:'result',is_error:false,result:'done',session_id:'a3-session'}));
    `);
  }
  const jobs = createPeerJobs({
    stateDir: config.stateDir, logger: (entry) => logs.push(entry),
    killTree: async (pid) => { const child = spawned.find((entry) => entry.child.pid === pid)?.child; if (child && !realChild) finish(child); return { ok: true }; },
    spawnImpl: (command, args, options) => {
      let child;
      if (realChild) child = spawn(process.execPath, [childFile], options);
      else {
        child = new EventEmitter();
        child.pid = 840_000 + spawned.length;
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.target = options.env.AGENT_BRIDGE_SELF;
      }
      spawned.push({ command, args, options, child });
      return child;
    },
  });
  const server = createPeerServer({
    config, jobs: { ...jobs, start: (spec) => {
      const { env: childEnv, ...publicSpec } = spec;
      starts.push(publicSpec);
      return jobs.start(spec);
    } }, startSweepTimer: false, resolveLineage,
    logger: (entry) => logs.push(entry),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AGENT_BRIDGE_SELF: self,
      ...(fileOnly ? {} : { DSH_MCP_TOKEN: TOKEN }), ...env },
  });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, server, jobs, spawned, starts, requests, logs, finish,
    setResponse: (value) => { capabilityResponse = value; },
    ask: (overrides = {}) => server.call('peer_ask', {
      target: self === 'claude-code' ? 'codex' : 'claude-code', mode: 'delegate', prompt: 'Perform the bounded test.',
      cwd: dir, rootTask: 'a3-root', waitMs: 0, ...overrides,
    }),
  };
}

test('prepareDelegateCredential reads one effective file token and verifies that exact credential', async () => {
  let reads = 0;
  const calls = [];
  const client = createBridgeClient({
    url: URL, env: { DSH_BRIDGE_CREDENTIAL_FILE: 'env-file' }, credentialFile: 'configured-file',
    readFileImpl: async (file) => { assert.equal(file, 'env-file'); reads += 1; return reads === 1 ? TOKEN : OTHER_TOKEN; },
    fetchImpl: async (url, options) => { calls.push(options); return result(identity()); },
  });
  const prepared = await client.prepareDelegateCredential();
  assert.deepEqual(prepared, { token: TOKEN, principal: { id: 'claude-code', admin: false } });
  assert.equal(reads, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers['X-Agent-Bridge-Chain'], undefined);
  assert.deepEqual(JSON.parse(calls[0].body).params, { name: 'bridge_capabilities', arguments: {} });
  assert.equal(calls[0].body.includes(TOKEN), false);
});

test('delegate credential preparation requires enabled non-admin identity and refuses confirmed admin', async () => {
  for (const [capability, code] of [
    [{ controllerIdentity: { enabled: true, self: 'operator', admin: true } }, 'PEER_BRIDGE_ADMIN_DELEGATION_FORBIDDEN'],
    [{ controllerIdentity: { admin: true } }, 'PEER_BRIDGE_ADMIN_DELEGATION_FORBIDDEN'],
    [{}, 'PEER_BRIDGE_UNAVAILABLE'],
    [{ controllerIdentity: { enabled: false, self: 'codex', admin: false } }, 'PEER_BRIDGE_UNAVAILABLE'],
    [{ controllerIdentity: { enabled: true, self: 'codex', admin: 'false' } }, 'PEER_BRIDGE_UNAVAILABLE'],
    [{ controllerIdentity: { enabled: true, self: '', admin: false } }, 'PEER_BRIDGE_UNAVAILABLE'],
  ]) {
    const client = createBridgeClient({ url: URL, env: { DSH_MCP_TOKEN: TOKEN }, fetchImpl: async () => result(capability) });
    await assert.rejects(client.prepareDelegateCredential(), { code });
  }
});

test('peer bridge client refuses disabled and token-filtered delegation without file or HTTP access', async () => {
  for (const env of [{ DSH_BRIDGE_DISABLED: '1', DSH_MCP_TOKEN: TOKEN }, { DSH_BRIDGE_DELEGATED: '1' }, { AGENT_BRIDGE_CHAIN: 'codex>claude-code' }]) {
    const client = createBridgeClient({ url: URL, env, credentialFile: 'local-file',
      readFileImpl: async () => assert.fail('file fallback'), fetchImpl: async () => assert.fail('HTTP request') });
    await assert.rejects(client.dossier('test'), { code: 'PEER_BRIDGE_UNAVAILABLE' });
    await assert.rejects(client.prepareDelegateCredential(), { code: 'PEER_BRIDGE_UNAVAILABLE' });
  }
});

test('recovered peer context supplies via and prevents credential fallback after environment filtering', async () => {
  const context = { isRoot: false, chain: ['claude-code', 'codex'], rootTask: 'recovered-root' };
  const calls = [];
  for (const hasToken of [true, false]) {
    const client = createBridgeClient({ url: URL, env: hasToken ? { DSH_MCP_TOKEN: TOKEN } : {}, credentialFile: 'local-file',
      getContext: async () => context, readFileImpl: async () => assert.fail('filtered delegate must not read local files'),
      fetchImpl: async (url, options) => { calls.push(options); return result({ taskId: 'test' }); } });
    if (hasToken) await client.dossier('test');
    else await assert.rejects(client.dossier('test'), { code: 'PEER_BRIDGE_UNAVAILABLE' });
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['X-Agent-Bridge-Chain'], 'claude-code>codex');
  assert.equal(calls[0].headers['X-Agent-Bridge-Root-Task'], 'recovered-root');
});

test('peer bridge errors redact credentials in both messages and bridge error codes', async () => {
  const client = createBridgeClient({ url: URL, env: { DSH_MCP_TOKEN: TOKEN }, fetchImpl: async () => ({
    status: 200, text: async () => JSON.stringify({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: TOKEN, message: TOKEN }) }] } }),
  }) });
  await assert.rejects(client.dossier('test'), (error) => {
    assert.equal(JSON.stringify({ message: error.message, detail: error.detail }).includes(TOKEN), false);
    return error.code === 'PEER_BRIDGE';
  });
});

for (const self of ['claude-code', 'codex']) {
  test(`${self} delegate and resume inherit the verified root credential without persisting it`, async (t) => {
    const f = await fixture(t, { self, fileOnly: self === 'codex', env: { dsh_bridge_url: 'http://127.0.0.1:1/old' } });
    const { job } = await f.ask();
    const launched = f.spawned[0];
    assert.equal(job.bridge.state, 'enabled');
    assert.equal(launched.options.env.DSH_MCP_TOKEN, TOKEN);
    assert.equal(launched.options.env.DSH_BRIDGE_DELEGATED, '1');
    assert.equal(launched.options.env.DSH_BRIDGE_CREDENTIAL_FILE, undefined);
    assert.equal(launched.options.env.DSH_BRIDGE_URL, URL);
    assert.equal(launched.options.env.dsh_bridge_url, undefined);
    assert.equal(f.requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(f.requests[0].options.headers['X-Agent-Bridge-Chain'], undefined, 'the root capabilities request has no via');
    assert.equal(f.requests[0].url, URL);
    const target = self === 'codex' ? 'claude-code' : 'codex';
    assert.equal(launched.options.env.AGENT_BRIDGE_CHAIN, `${self}>${target}`);

    // Exercise the delegated carrier with the exact spawn environment. Both
    // directions must authenticate as the root and declare the child chain.
    const childCalls = [];
    const carrier = createCarrier({ env: launched.options.env, watchdogEnabled: false, stdout: { write() {} },
      fetchImpl: async (url, options) => { childCalls.push({ url, options }); return { status: 202 }; },
      readFileImpl: async () => assert.fail('child must use root token') });
    await carrier.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_submit', arguments: { packet: {} } } }));
    assert.equal(childCalls[0].url, URL);
    assert.equal(childCalls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(childCalls[0].options.headers['X-Agent-Bridge-Chain'], `${self}>${target}`);
    assert.equal(childCalls[0].options.headers['X-Agent-Bridge-Root-Task'], 'a3-root');
    if (target === 'claude-code') {
      assert.ok(launched.args.includes('--strict-mcp-config'));
      const mcp = JSON.parse(launched.args[launched.args.indexOf('--mcp-config') + 1]).mcpServers;
      assert.deepEqual(Object.keys(mcp).sort(), ['plugin_agent-bridge_agent_peer', 'plugin_agent-bridge_dsh_project']);
      assert.match(mcp['plugin_agent-bridge_dsh_project'].args[0], /bin[\\/]bridge\.mjs$/);
      assert.equal(mcp['plugin_agent-bridge_agent_peer'].env.AGENT_BRIDGE_SELF, 'claude-code');
    }
    const activeFiles = await readdir(path.join(f.config.stateDir, 'active'));
    assert.equal(activeFiles.length, 1);
    const ledger = await readFile(path.join(f.config.stateDir, 'active', activeFiles[0]), 'utf8');
    const jobDir = path.join(f.jobs.jobsDir, job.jobId);
    const prompt = await readFile(path.join(jobDir, 'prompt.txt'), 'utf8');
    assert.equal(JSON.stringify({ starts: f.starts, argv: launched.args, job, prompt, ledger, logs: f.logs }).includes(TOKEN), false);
    f.finish(launched.child);
    const done = await f.jobs.wait(job.jobId, 2000);
    assert.equal(done.status, 'completed');
    for (const name of ['job.json', 'result.json', 'prompt.txt', 'stdout.log', 'stderr.log']) {
      assert.equal((await readFile(path.join(jobDir, name), 'utf8')).includes(TOKEN), false, name);
    }
    if (self === 'codex') await writeFile(f.config.bridge.credentialFile, OTHER_TOKEN);
    const resumed = await f.ask({ sessionId: done.sessionId });
    assert.equal(f.requests.length, 2, 'resume verifies the credential again');
    const resumeToken = self === 'codex' ? OTHER_TOKEN : TOKEN;
    assert.equal(f.requests[1].options.headers.Authorization, `Bearer ${resumeToken}`);
    assert.equal(f.spawned[1].options.env.DSH_MCP_TOKEN, resumeToken);
    assert.equal(JSON.stringify(f.starts).includes(resumeToken), false);
    assert.equal(resumed.job.sessionIdRequested, 'a3-session');
    f.finish(f.spawned[1].child);
    await f.jobs.wait(resumed.job.jobId, 2000);
  });

  test(`${self} admin delegation is refused before spawn, including resume`, async (t) => {
    const f = await fixture(t, { self, response: { controllerIdentity: { enabled: true, self: 'operator', admin: true } } });
    await assert.rejects(f.ask(), { code: 'PEER_BRIDGE_ADMIN_DELEGATION_FORBIDDEN' });
    assert.equal(f.spawned.length, 0);
    f.setResponse(identity(self));
    const { job } = await f.ask();
    f.finish(f.spawned[0].child);
    const done = await f.jobs.wait(job.jobId, 2000);
    f.setResponse({ controllerIdentity: { enabled: true, self: 'operator', admin: true } });
    await assert.rejects(f.ask({ sessionId: done.sessionId }), { code: 'PEER_BRIDGE_ADMIN_DELEGATION_FORBIDDEN' });
    assert.equal(f.spawned.length, 1);
  });

  test(`${self} real child receives the verified token and emits no credential`, async (t) => {
    const f = await fixture(t, { self, fileOnly: true, realChild: true });
    const { job } = await f.ask({ waitMs: 3000 });
    assert.equal(job.status, 'completed', JSON.stringify(job.errors));
    assert.equal(f.spawned.length, 1);
    for (const name of ['job.json', 'result.json', 'prompt.txt', 'stdout.log', 'stderr.log']) {
      assert.equal((await readFile(path.join(f.jobs.jobsDir, job.jobId, name), 'utf8')).includes(TOKEN), false, name);
    }
  });
}

for (const [name, response] of [
  ['missing capability', {}],
  ['unreachable bridge', new Error(`unreachable ${TOKEN}`)],
  ['failed capability call', () => ({ status: 503, text: async () => '' })],
]) {
  test(`${name} starts a disabled delegate and persists its reason through completion`, async (t) => {
    const f = await fixture(t, { response });
    const { job } = await f.ask();
    const expected = { state: 'disabled', reason: 'PEER_BRIDGE_UNAVAILABLE' };
    assert.deepEqual(job.bridge, expected);
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0].options.env.DSH_BRIDGE_DISABLED, '1');
    assert.equal(f.spawned[0].options.env.DSH_MCP_TOKEN, undefined);
    assert.equal(f.spawned[0].options.env.DSH_BRIDGE_CREDENTIAL_FILE, undefined);
    f.finish(f.spawned[0].child);
    await f.jobs.wait(job.jobId, 2000);
    const disk = JSON.parse(await readFile(path.join(f.jobs.jobsDir, job.jobId, 'job.json'), 'utf8'));
    assert.deepEqual(disk.bridge, expected);
    assert.deepEqual((await f.server.call('peer_check', { jobId: job.jobId })).job.bridge, expected);
    assert.deepEqual((await f.server.call('peer_result', { jobId: job.jobId })).job.bridge, expected);
    assert.deepEqual((await f.server.call('peer_list')).jobs[0].bridge, expected);
    assert.equal(JSON.stringify({ disk, logs: f.logs, args: f.spawned[0].args }).includes(TOKEN), false);
  });
}

test('unconfigured peer-only delegate and consult/review children receive no bridge credentials', async (t) => {
  for (const mode of ['delegate', 'consult', 'review']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { bridge: mode !== 'delegate', response: { controllerIdentity: { enabled: true, self: 'operator', admin: true } }, env: {
        dsh_mcp_token: OTHER_TOKEN, Dsh_Bridge_Credential_File: 'admin-file', DSH_BRIDGE_DELEGATED: '1',
      } });
      const { job } = await f.ask({ mode });
      assert.equal(f.requests.length, 0);
      const childEnv = f.spawned[0].options.env;
      assert.equal(childEnv.DSH_BRIDGE_DISABLED, '1');
      assert.equal(Object.keys(childEnv).some((key) => /^(DSH_MCP_TOKEN|DSH_BRIDGE_CREDENTIAL_FILE|DSH_BRIDGE_DELEGATED)$/i.test(key)), false);
      assert.equal(JSON.stringify(childEnv).includes(TOKEN), false);
      assert.equal(JSON.stringify(childEnv).includes(OTHER_TOKEN), false);
      assert.equal(job.bridge.state, 'disabled');
    });
  }
});

test('childEnvironment removes Windows aliases before explicitly injecting a prepared credential', () => {
  const source = { PATH: 'p', psMODULEpath: '', DSH_MCP_TOKEN: OTHER_TOKEN, dsh_mcp_token: OTHER_TOKEN,
    Dsh_Bridge_Credential_File: 'file', dsh_bridge_disabled: '1', DSH_BRIDGE_DELEGATED: '1',
    Codex_Thread_Id: 'caller', AGENT_BRIDGE_CHAIN: 'old', agent_bridge_root_task: 'old' };
  const chain = { AGENT_BRIDGE_CHAIN: 'claude-code>codex', AGENT_BRIDGE_ROOT_TASK: 'root' };
  assert.deepEqual(childEnvironment(source, chain, { mode: 'delegate', bridgeCredential: { token: TOKEN, principal: { id: 'root', admin: false } } }), {
    PATH: 'p', psMODULEpath: '', ...chain, DSH_MCP_TOKEN: TOKEN, DSH_BRIDGE_DELEGATED: '1',
  });
  assert.deepEqual(childEnvironment(source, chain, { mode: 'review' }), { PATH: 'p', psMODULEpath: '', ...chain, DSH_BRIDGE_DISABLED: '1' });
});

test('PowerShell and ps process queries strip only bridge credentials and preserve supplied environment', () => {
  for (const platform of ['win32', 'linux']) {
    const source = { PATH: 'preserved', psMODULEpath: 'custom-modules', TEMP: 'F:\\temp', SYSTEMROOT: 'C:\\Windows',
      DSH_MCP_TOKEN: TOKEN, dsh_mcp_token: OTHER_TOKEN, Dsh_Bridge_Credential_File: 'file', dsh_bridge_delegated: '1', DSH_BRIDGE_DISABLED: '1', OTHER: '' };
    const before = { ...source };
    const calls = [];
    readProcessTable({ env: source, platform, spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: platform === 'win32' ? '[{"ProcessId":10,"ParentProcessId":1,"CreationDate":null}]' : '10 1\n' };
    } });
    assert.equal(calls.length, 1);
    const childEnv = calls[0].options.env;
    for (const key of ['PATH', 'psMODULEpath', 'TEMP', 'SYSTEMROOT', 'OTHER']) assert.equal(childEnv[key], source[key]);
    assert.equal(Object.keys(childEnv).some((key) => /^(DSH_MCP_TOKEN|DSH_BRIDGE_CREDENTIAL_FILE|DSH_BRIDGE_DELEGATED|DSH_BRIDGE_DISABLED)$/i.test(key)), false);
    assert.equal(JSON.stringify(calls).includes(TOKEN), false);
    assert.deepEqual(source, before);
  }
});

test('taskkill and Codex app-server never inherit an administrator token', async (t) => {
  const prior = process.env.DSH_MCP_TOKEN;
  process.env.DSH_MCP_TOKEN = TOKEN;
  t.after(() => { if (prior === undefined) delete process.env.DSH_MCP_TOKEN; else process.env.DSH_MCP_TOKEN = prior; });
  const calls = [];
  const killed = defaultKillTree(123, { platform: 'win32', spawnImpl: (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  } });
  assert.equal((await killed).ok, true);
  const client = createCodexThreadClient({ executable: process.execPath, spawnImpl: (command, args, options) => {
    calls.push({ command, args, options });
    throw new Error('test spawn stop');
  } });
  await assert.rejects(client.organize('01984de2-8f74-7c91-a3b2-5c5e937cf318', { name: 'test', sectionName: 'test' }), { code: 'PEER_CODEX_APP_SERVER' });
  await client.close();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.env.DSH_MCP_TOKEN, undefined);
    assert.equal(JSON.stringify(call).includes(TOKEN), false);
    assert.equal(call.options.env.PATH, process.env.PATH);
  }
});
