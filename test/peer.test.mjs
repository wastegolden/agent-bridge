import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_KEYS, PeerPolicyError, buildPeerPreamble, formatChain, parseChain, planPeerCall, readChainContext } from '../src/peer/chain.mjs';
import { buildInvocation, childEnvironment, parseClaudeOutput, parseCodexOutput } from '../src/peer/cli.mjs';
import { normalizePeerConfig } from '../src/peer/config.mjs';
import { createPeerJobs } from '../src/peer/jobs.mjs';
import { createPeerServer } from '../src/peer/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-peer-cli.mjs');
const ABS = process.platform === 'win32' ? 'C:\\peer-test' : '/peer-test';

const rootClaude = () => readChainContext({ [ENV_KEYS.self]: 'claude-code' });
const codexUnderClaude = (extra = {}) => readChainContext({ [ENV_KEYS.self]: 'codex', [ENV_KEYS.chain]: 'claude-code>codex', ...extra });

// --- chain policy -------------------------------------------------------------

test('a root controller may consult, review and delegate to the other harness', () => {
  const context = rootClaude();
  assert.equal(context.isRoot, true);
  assert.deepEqual([...context.chain], ['claude-code']);
  for (const mode of ['consult', 'review', 'delegate']) {
    const plan = planPeerCall(context, { target: 'codex', mode });
    assert.deepEqual([...plan.chain], ['claude-code', 'codex']);
    assert.equal(plan.depth, 1);
    assert.equal(plan.childEnv[ENV_KEYS.self], 'codex');
    assert.equal(plan.childEnv[ENV_KEYS.chain], 'claude-code>codex');
  }
});

test('a callee can never send work back to the root controller or itself', () => {
  const context = codexUnderClaude();
  assert.throws(() => planPeerCall(context, { target: 'claude-code', mode: 'review' }), { code: 'PEER_CYCLE' });
  assert.throws(() => planPeerCall(context, { target: 'codex', mode: 'consult' }), { code: 'PEER_SELF_TARGET' });
  assert.throws(() => planPeerCall(rootClaude(), { target: 'claude-code', mode: 'consult' }), { code: 'PEER_SELF_TARGET' });
  // Codex as root controller: the mirror image.
  const codexRoot = readChainContext({ [ENV_KEYS.self]: 'codex' });
  assert.equal(planPeerCall(codexRoot, { target: 'claude-code', mode: 'delegate' }).childEnv[ENV_KEYS.chain], 'codex>claude-code');
});

test('depth and delegate limits are enforced and inherited', () => {
  assert.throws(() => planPeerCall(readChainContext({ [ENV_KEYS.self]: 'claude-code', [ENV_KEYS.maxDepth]: '0' }), { target: 'codex', mode: 'consult' }), { code: 'PEER_DEPTH_EXCEEDED' });
  assert.throws(
    () => planPeerCall(readChainContext({ [ENV_KEYS.self]: 'claude-code', [ENV_KEYS.maxDelegateDepth]: '0' }), { target: 'codex', mode: 'delegate' }),
    { code: 'PEER_DELEGATE_DEPTH' },
  );
  // A DSH-rooted chain reaching claude-code: codex is one more hop (depth 2, allowed),
  // but delegation at depth 2 exceeds the default delegate depth 1.
  const deep = readChainContext({ [ENV_KEYS.self]: 'claude-code', [ENV_KEYS.chain]: 'dsh>claude-code' });
  assert.equal(planPeerCall(deep, { target: 'codex', mode: 'review' }).depth, 2);
  assert.throws(() => planPeerCall(deep, { target: 'codex', mode: 'delegate' }), { code: 'PEER_DELEGATE_DEPTH' });
  const limited = planPeerCall(rootClaude(), { target: 'codex', mode: 'delegate' });
  assert.equal(limited.calleeMayPeer, true);
  assert.equal(limited.calleeMayDelegate, false);
  assert.equal(limited.childEnv[ENV_KEYS.maxDepth], '2');
});

test('malformed inherited chains are refused, never repaired', () => {
  assert.throws(() => readChainContext({ [ENV_KEYS.self]: 'codex', [ENV_KEYS.chain]: 'claude-code' }), { code: 'PEER_CHAIN_INVALID' });
  assert.throws(() => readChainContext({ [ENV_KEYS.self]: 'codex', [ENV_KEYS.chain]: 'codex>claude-code>codex' }), { code: 'PEER_CHAIN_INVALID' });
  assert.throws(() => readChainContext({ [ENV_KEYS.self]: 'codex', [ENV_KEYS.chain]: 'gpt>codex' }), { code: 'PEER_CHAIN_INVALID' });
  assert.throws(() => readChainContext({}), { code: 'PEER_SELF_UNKNOWN' });
  assert.throws(() => readChainContext({ [ENV_KEYS.self]: 'codex', [ENV_KEYS.maxDepth]: '9' }), { code: 'PEER_CONFIG_INVALID' });
  assert.deepEqual(parseChain('  '), []);
  assert.equal(formatChain(['claude-code', 'codex']), 'claude-code>codex');
});

test('the preamble states position and the no-return rule', () => {
  const plan = planPeerCall(rootClaude(), { target: 'codex', mode: 'review', rootTask: 'task-1' });
  const text = buildPeerPreamble(plan);
  assert.match(text, /^\[agent-bridge\]/);
  assert.match(text, /chain claude-code>codex/);
  assert.match(text, /Never send work back/);
  assert.equal(plan.childEnv[ENV_KEYS.rootTask], 'task-1');
});

// --- CLI adapters -------------------------------------------------------------

const codexPeer = { executable: path.join(ABS, 'codex.exe'), model: null, extraArgs: [], delegateSandbox: 'workspace-write' };
const claudePeer = { executable: path.join(ABS, 'claude.exe'), model: null, extraArgs: [], readOnlyTools: ['Read', 'Grep'], delegatePermissionMode: 'acceptEdits', delegateAllowedTools: [] };

test('codex invocations keep review read-only and pin the sandbox on resume', () => {
  const lastMessageFile = path.join(ABS, 'last.txt');
  const fresh = buildInvocation({ target: 'codex', mode: 'review', cwd: ABS, lastMessageFile }, codexPeer);
  assert.equal(fresh.readOnly, true);
  assert.deepEqual(fresh.args.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.equal(fresh.args[fresh.args.indexOf('-s') + 1], 'read-only');
  assert.equal(fresh.args.at(-1), '-');
  const delegate = buildInvocation({ target: 'codex', mode: 'delegate', cwd: ABS, lastMessageFile, addDirs: [path.join(ABS, 'x')] }, codexPeer);
  assert.equal(delegate.args[delegate.args.indexOf('-s') + 1], 'workspace-write');
  assert.ok(delegate.args.includes('--add-dir'));
  const resume = buildInvocation({ target: 'codex', mode: 'consult', cwd: ABS, lastMessageFile, sessionId: '01a1119d-5fcc-7880-bfd6-0fb84f99c67f' }, codexPeer);
  assert.deepEqual(resume.args.slice(0, 2), ['exec', 'resume']);
  assert.ok(resume.args.includes('sandbox_mode="read-only"'));
  assert.deepEqual(resume.args.slice(-2), ['01a1119d-5fcc-7880-bfd6-0fb84f99c67f', '-']);
  assert.throws(() => buildInvocation({ target: 'codex', mode: 'review', cwd: ABS, lastMessageFile, addDirs: [ABS] }, codexPeer), { code: 'PEER_ARGS_INVALID' });
  assert.throws(() => buildInvocation({ target: 'codex', mode: 'review', cwd: 'relative', lastMessageFile }, codexPeer), { code: 'PEER_ARGS_INVALID' });
  assert.throws(() => buildInvocation({ target: 'codex', mode: 'review', cwd: ABS, lastMessageFile, sessionId: '--last' }, codexPeer), { code: 'PEER_ARGS_INVALID' });
});

test('claude invocations use dontAsk with a read-only allowlist for review', () => {
  const review = buildInvocation({ target: 'claude-code', mode: 'review', cwd: ABS }, claudePeer);
  assert.deepEqual(review.args.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.deepEqual(review.args.slice(-5), ['--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Grep']);
  const delegate = buildInvocation({ target: 'claude-code', mode: 'delegate', cwd: ABS, sessionId: 'a73c13c2-5006-4731-b1d3-93a817b735bc' }, claudePeer);
  assert.deepEqual(delegate.args.slice(-2), ['--permission-mode', 'acceptEdits']);
  assert.equal(delegate.args[delegate.args.indexOf('--resume') + 1], 'a73c13c2-5006-4731-b1d3-93a817b735bc');
});

test('the child environment drops caller session identity and inherited chain', () => {
  const env = childEnvironment(
    { PATH: 'p', DSH_MCP_TOKEN: 't', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CODEX_THREAD_ID: 'x', AGENT_BRIDGE_CHAIN: 'codex', CLAUDE_CODE_MESSAGING_TOKEN: 'm' },
    { AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'claude-code>codex' },
  );
  assert.deepEqual(env, { PATH: 'p', DSH_MCP_TOKEN: 't', AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'claude-code>codex' });
});

test('output parsers read the real CLI shapes', () => {
  const codex = parseCodexOutput([
    '{"type":"thread.started","thread_id":"01a1119d-5fcc-7880-bfd6-0fb84f99c67f"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
    '{"type":"turn.completed","usage":{"input_tokens":19768,"output_tokens":33}}',
  ].join('\n'));
  assert.equal(codex.ok, true);
  assert.equal(codex.sessionId, '01a1119d-5fcc-7880-bfd6-0fb84f99c67f');
  assert.equal(codex.finalMessage, 'PONG');
  assert.equal(codex.usage.output_tokens, 33);
  const failed = parseCodexOutput('{"type":"turn.failed","error":{"message":"boom"}}\nnot json');
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.errors, ['boom']);
  assert.equal(failed.unparsedLines, 1);

  const claude = parseClaudeOutput('{"type":"result","subtype":"success","is_error":false,"result":"PONG","session_id":"s-1","total_cost_usd":0.01,"num_turns":1}');
  assert.equal(claude.ok, true);
  assert.equal(claude.finalMessage, 'PONG');
  const notLoggedIn = parseClaudeOutput('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"s-2"}');
  assert.equal(notLoggedIn.ok, false);
  assert.match(notLoggedIn.errors[0], /Not logged in/);
  assert.equal(parseClaudeOutput('garbage').ok, false);
});

test('peer config accepts only known fields and absolute paths', () => {
  const config = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: { codex: { executable: path.join(ABS, 'codex.exe') }, 'claude-code': { executable: path.join(ABS, 'claude.exe') } },
    limits: { timeoutMs: 60_000 },
  });
  assert.equal(config.peers.codex.delegateSandbox, 'workspace-write');
  assert.equal(config.peers['claude-code'].delegatePermissionMode, 'acceptEdits');
  assert.equal(config.limits.timeoutMs, 60_000);
  assert.throws(() => normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: { codex: { executable: 'codex.exe' } } }), { code: 'PEER_CONFIG_INVALID' });
  assert.throws(() => normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: { gemini: { executable: ABS } } }), { code: 'PEER_CONFIG_INVALID' });
  assert.throws(() => normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: {}, token: 'x' }), { code: 'PEER_CONFIG_INVALID' });
  assert.throws(
    () => normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: { 'claude-code': { executable: path.join(ABS, 'c.exe'), delegatePermissionMode: 'bypassPermissions' } } }),
    { code: 'PEER_CONFIG_INVALID' },
  );
});

// --- jobs + server end to end with the fake CLI ------------------------------

const fakeSpawn = (command, args, options) => spawn(process.execPath, [FAKE, ...args], options);

async function withServer(env, fn, { maxConcurrent = 3 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-'));
  const work = path.join(dir, 'work');
  await mkdir(work);
  const config = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: path.join(dir, 'state'),
    peers: { codex: { executable: path.join(dir, 'codex.exe') }, 'claude-code': { executable: path.join(dir, 'claude.exe') } },
  });
  const jobs = createPeerJobs({ stateDir: config.stateDir, spawnImpl: fakeSpawn, maxConcurrent });
  const server = createPeerServer({ env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CLAUDECODE: '1', CODEX_THREAD_ID: 'caller', ...env }, config, jobs });
  try {
    await fn({ server, jobs, work, dir });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const rpc = async (server, name, args) => {
  const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (reply.result.isError) return { error: JSON.parse(reply.result.content[0].text) };
  return reply.result.structuredContent;
};

test('mcp handshake and tool catalog', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'claude-code' }, async ({ server }) => {
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.serverInfo.name, 'agent-peer');
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((t) => t.name), ['peer_capabilities', 'peer_ask', 'peer_check', 'peer_result', 'peer_cancel', 'peer_list']);
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const caps = await rpc(server, 'peer_capabilities', {});
    assert.equal(caps.self, 'claude-code');
    assert.equal(caps.isRootController, true);
    assert.equal(caps.peers.codex.modes.delegate.allowed, true);
    assert.equal(caps.peers['claude-code'].modes.consult.code, 'PEER_SELF_TARGET');
  });
});

test('root claude-code consults codex; the child inherits the chain, not the caller session', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'claude-code' }, async ({ server, work }) => {
    const asked = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'What is 2+2?', cwd: work, waitMs: 20_000, rootTask: 'demo-1' });
    assert.equal(asked.job.status, 'completed', JSON.stringify(asked));
    assert.equal(asked.job.sessionId, '01a1119d-5fcc-7880-bfd6-0fb84f99c67f');
    const result = await rpc(server, 'peer_result', { jobId: asked.job.jobId });
    const echo = JSON.parse(result.finalMessage.replace(/^CODEX-ECHO /, ''));
    assert.equal(echo.self, 'codex');
    assert.equal(echo.chain, 'claude-code>codex');
    assert.equal(echo.rootTask, 'demo-1');
    assert.equal(echo.claudecode, null);
    assert.equal(echo.codexThread, null);
    assert.equal(echo.hasPreamble, true);
    assert.ok(echo.argv.includes('read-only'));
    // Continue the same session.
    const again = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'And 3+3?', cwd: work, sessionId: asked.job.sessionId, waitMs: 20_000 });
    assert.equal(again.job.status, 'completed');
    assert.equal(again.job.sessionId, asked.job.sessionId);
    const listed = await rpc(server, 'peer_list', {});
    assert.equal(listed.jobs.length, 2);
  });
});

test('a codex sub-controller cannot call back into claude-code', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'claude-code>codex' }, async ({ server, work, jobs }) => {
    const refused = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'review this', cwd: work, waitMs: 0 });
    assert.equal(refused.error.code, 'PEER_CYCLE');
    assert.equal((await jobs.list()).length, 0);
    const caps = await rpc(server, 'peer_capabilities', {});
    assert.equal(caps.peers['claude-code'].modes.review.code, 'PEER_CYCLE');
    const rootTask = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'x', cwd: work, rootTask: 'nope' });
    assert.equal(rootTask.error.code, 'PEER_CYCLE');
  });
});

test('model-side failures, cancellation and timeouts settle honestly', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'codex' }, async ({ server, work, jobs }) => {
    const failed = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'FAIL please', cwd: work, waitMs: 20_000 });
    assert.equal(failed.job.status, 'failed');
    assert.match(failed.job.errors.join(' '), /Not logged in/);

    const sleeping = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'consult', prompt: 'SLEEP', cwd: work, waitMs: 0 });
    assert.equal(sleeping.job.status, 'running');
    const cancelled = await rpc(server, 'peer_cancel', { jobId: sleeping.job.jobId });
    assert.equal(cancelled.cancelled, true);
    const settled = await rpc(server, 'peer_check', { jobId: sleeping.job.jobId, waitMs: 20_000 });
    assert.equal(settled.job.status, 'cancelled');

    const allocation = jobs.allocate();
    const plan = planPeerCall(readChainContext({ AGENT_BRIDGE_SELF: 'codex' }), { target: 'claude-code', mode: 'consult' });
    const started = await jobs.start({
      jobId: allocation.jobId,
      invocation: buildInvocation({ target: 'claude-code', mode: 'consult', cwd: work }, claudePeer),
      plan,
      prompt: 'SLEEP',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      timeoutMs: 300,
      cwd: work,
    });
    const timedOut = await jobs.wait(started.jobId, 20_000);
    assert.equal(timedOut.status, 'timed_out');
  });
});

test('busy limit and invalid arguments are typed refusals', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'claude-code' }, async ({ server, work }) => {
    const first = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'SLEEP', cwd: work, waitMs: 0 });
    const busy = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hi', cwd: work, waitMs: 0 });
    assert.equal(busy.error.code, 'PEER_BUSY');
    await rpc(server, 'peer_cancel', { jobId: first.job.jobId });
    await rpc(server, 'peer_check', { jobId: first.job.jobId, waitMs: 20_000 });
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hi', cwd: 'relative' })).error.code, 'PEER_ARGS_INVALID');
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hi', cwd: path.join(work, 'missing') })).error.code, 'PEER_ARGS_INVALID');
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hi', cwd: work, extra: 1 })).error.code, 'PEER_ARGS_INVALID');
    assert.equal((await rpc(server, 'peer_ask', { target: 'gemini', mode: 'consult', prompt: 'hi', cwd: work })).error.code, 'PEER_ARGS_INVALID');
  }, { maxConcurrent: 1 });
});

test('jobs left running by a dead server are reported lost, never re-run', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-lost-'));
  try {
    const jobId = 'peer-1791297108493-0a1b2c3d';
    await mkdir(path.join(dir, 'jobs', jobId), { recursive: true });
    await writeFile(path.join(dir, 'jobs', jobId, 'job.json'), JSON.stringify({ jobId, status: 'running', errors: [], target: 'codex', mode: 'consult' }));
    const jobs = createPeerJobs({ stateDir: dir, spawnImpl: () => assert.fail('must not spawn') });
    const listed = await jobs.list();
    assert.equal(listed[0].status, 'lost');
    const stored = JSON.parse(await readFile(path.join(dir, 'jobs', jobId, 'job.json'), 'utf8'));
    assert.equal(stored.status, 'lost');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a server without self identity refuses every call but still lists tools', async () => {
  const server = createPeerServer({ env: {}, config: null, configError: new PeerPolicyError('PEER_CONFIG_INVALID', 'missing') });
  const caps = await rpc(server, 'peer_capabilities', {});
  assert.equal(caps.self, null);
  assert.equal(caps.contextError.code, 'PEER_SELF_UNKNOWN');
  const refused = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'x', cwd: ABS });
  assert.equal(refused.error.code, 'PEER_SELF_UNKNOWN');
});
