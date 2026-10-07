import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { ENV_KEYS, PeerPolicyError, buildPeerPreamble, formatChain, parseChain, planPeerCall, readChainContext } from '../src/peer/chain.mjs';
import { CLAUDE_WRITE_TOOLS, buildInvocation, childEnvironment, parseClaudeOutput, parseCodexOutput } from '../src/peer/cli.mjs';
import { loadPeerConfig, normalizePeerConfig, resolveExecutablePattern } from '../src/peer/config.mjs';
import { createPeerJobs, defaultKillTree } from '../src/peer/jobs.mjs';
import { createPeerServer } from '../src/peer/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FAKE = path.join(HERE, 'fixtures', 'fake-peer-cli.mjs');
const ABS = process.platform === 'win32' ? 'C:\\peer-test' : '/peer-test';
const DEAD_PID = 2_147_000_001;

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
  const codexRoot = readChainContext({ [ENV_KEYS.self]: 'codex' });
  assert.equal(planPeerCall(codexRoot, { target: 'claude-code', mode: 'delegate' }).childEnv[ENV_KEYS.chain], 'codex>claude-code');
});

test('depth and delegate limits are enforced and inherited', () => {
  assert.throws(() => planPeerCall(readChainContext({ [ENV_KEYS.self]: 'claude-code', [ENV_KEYS.maxDepth]: '0' }), { target: 'codex', mode: 'consult' }), { code: 'PEER_DEPTH_EXCEEDED' });
  assert.throws(
    () => planPeerCall(readChainContext({ [ENV_KEYS.self]: 'claude-code', [ENV_KEYS.maxDelegateDepth]: '0' }), { target: 'codex', mode: 'delegate' }),
    { code: 'PEER_DELEGATE_DEPTH' },
  );
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
  assert.throws(() => readChainContext({ [ENV_KEYS.self]: 'codex', [ENV_KEYS.chain]: 'Claude-Code>codex' }), { code: 'PEER_CHAIN_INVALID' });
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

const peerConfig = () => normalizePeerConfig({
  schemaVersion: 1,
  stateDir: ABS,
  peers: {
    codex: { executable: path.join(ABS, 'codex.exe'), reasoningEffort: 'high', profile: 'review' },
    'claude-code': { executable: path.join(ABS, 'claude.exe'), readOnlyTools: ['Read', 'Grep'], effort: 'high' },
  },
});
const codexPeer = () => peerConfig().peers.codex;
const claudePeer = () => peerConfig().peers['claude-code'];

test('codex invocations keep review read-only and pin the sandbox last', () => {
  const lastMessageFile = path.join(ABS, 'last.txt');
  const fresh = buildInvocation({ target: 'codex', mode: 'review', cwd: ABS, lastMessageFile }, codexPeer());
  assert.equal(fresh.readOnly, true);
  assert.deepEqual(fresh.args.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.deepEqual(fresh.args.slice(-5), ['-s', 'read-only', '-C', path.resolve(ABS), '-']);
  assert.ok(fresh.args.includes('model_reasoning_effort="high"'));
  assert.ok(fresh.args.includes('review'));
  assert.ok(!fresh.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const delegate = buildInvocation({ target: 'codex', mode: 'delegate', cwd: ABS, lastMessageFile, addDirs: [path.join(ABS, 'x')] }, codexPeer());
  assert.equal(delegate.args[delegate.args.indexOf('-s') + 1], 'workspace-write');
  assert.ok(delegate.args.includes('--add-dir'));
  const resume = buildInvocation({ target: 'codex', mode: 'consult', cwd: ABS, lastMessageFile, sessionId: '01a1119d-5fcc-7880-bfd6-0fb84f99c67f' }, codexPeer());
  assert.deepEqual(resume.args.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(resume.args.slice(-4), ['-c', 'sandbox_mode="read-only"', '01a1119d-5fcc-7880-bfd6-0fb84f99c67f', '-']);
  assert.throws(() => buildInvocation({ target: 'codex', mode: 'delegate', cwd: ABS, lastMessageFile, sessionId: 'abc', addDirs: [ABS] }, codexPeer()), { code: 'PEER_ARGS_INVALID' });
  assert.throws(() => buildInvocation({ target: 'codex', mode: 'review', cwd: ABS, lastMessageFile, addDirs: [ABS] }, codexPeer()), { code: 'PEER_ARGS_INVALID' });
  assert.throws(() => buildInvocation({ target: 'codex', mode: 'review', cwd: 'relative', lastMessageFile }, codexPeer()), { code: 'PEER_ARGS_INVALID' });
  assert.throws(() => buildInvocation({ target: 'codex', mode: 'review', cwd: ABS, lastMessageFile, sessionId: '--last' }, codexPeer()), { code: 'PEER_ARGS_INVALID' });
  const isolated = normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: { codex: { executable: path.join(ABS, 'codex.exe'), readOnlyIgnoreUserConfig: true } } }).peers.codex;
  assert.ok(buildInvocation({ target: 'codex', mode: 'review', cwd: ABS, lastMessageFile }, isolated).args.includes('--ignore-user-config'));
  assert.ok(!buildInvocation({ target: 'codex', mode: 'delegate', cwd: ABS, lastMessageFile }, isolated).args.includes('--ignore-user-config'));
});

test('claude review exposes only read-only built-ins, no MCP, and denies write tools', () => {
  const review = buildInvocation({ target: 'claude-code', mode: 'review', cwd: ABS }, claudePeer());
  assert.deepEqual(review.args.slice(0, 3), ['-p', '--output-format', 'json']);
  const at = (flag) => review.args.indexOf(flag);
  assert.ok(at('--strict-mcp-config') > 0);
  assert.equal(review.args[at('--permission-mode') + 1], 'dontAsk');
  assert.deepEqual(review.args.slice(at('--tools') + 1), ['Read', 'Grep'], '--tools is the last, exhaustive list of available tools');
  const denied = review.args.slice(at('--disallowedTools') + 1, at('--allowedTools'));
  for (const name of ['Write', 'Edit', 'Bash', 'PowerShell', 'NotebookEdit']) assert.ok(denied.includes(name), name);
  assert.deepEqual(denied, [...CLAUDE_WRITE_TOOLS]);
  assert.equal(review.args[review.args.indexOf('--effort') + 1], 'high');
  const delegate = buildInvocation({ target: 'claude-code', mode: 'delegate', cwd: ABS, sessionId: 'a73c13c2-5006-4731-b1d3-93a817b735bc' }, claudePeer());
  assert.deepEqual(delegate.args.slice(-2), ['--permission-mode', 'acceptEdits']);
  assert.ok(!delegate.args.includes('--strict-mcp-config'), 'a sub-controller keeps its MCP tools (DSH bridge, peers)');
  assert.equal(delegate.args[delegate.args.indexOf('--resume') + 1], 'a73c13c2-5006-4731-b1d3-93a817b735bc');
});

test('the child environment drops caller identity and inherited chain in any letter case', () => {
  const env = childEnvironment(
    {
      PATH: 'p', DSH_MCP_TOKEN: 't', CLAUDECODE: '1', claudecode: '1', CLAUDE_CODE_SESSION_ID: 's', Codex_Thread_Id: 'x',
      AGENT_BRIDGE_CHAIN: 'codex', agent_bridge_max_depth: '4', Agent_Bridge_Root_Task: 'r', CLAUDE_CODE_MESSAGING_TOKEN: 'm',
    },
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
  const failed = parseCodexOutput('{"type":"turn.failed","error":{"message":"boom"}}\nnot json');
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.errors, ['boom']);
  assert.equal(failed.unparsedLines, 1);
  const claude = parseClaudeOutput('{"type":"result","subtype":"success","is_error":false,"result":"PONG","session_id":"s-1","total_cost_usd":0.01,"num_turns":1}');
  assert.equal(claude.ok, true);
  const notLoggedIn = parseClaudeOutput('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"s-2"}');
  assert.equal(notLoggedIn.ok, false);
  assert.match(notLoggedIn.errors[0], /Not logged in/);
  assert.equal(parseClaudeOutput('garbage').ok, false);
});

test('peer config refuses anything that could widen a read-only run', () => {
  const base = { schemaVersion: 1, stateDir: ABS };
  const exe = (name) => path.join(ABS, name);
  assert.equal(peerConfig().peers.codex.delegateSandbox, 'workspace-write');
  const refuse = (raw) => assert.throws(() => normalizePeerConfig(raw), { code: 'PEER_CONFIG_INVALID' });
  refuse({ ...base, peers: { codex: { executable: 'codex.exe' } } });
  refuse({ ...base, peers: { gemini: { executable: ABS } } });
  refuse({ ...base, peers: {}, token: 'x' });
  refuse({ ...base, peers: { codex: { executable: exe('codex.exe'), extraArgs: ['--dangerously-bypass-approvals-and-sandbox'] } } });
  refuse({ ...base, peers: { 'claude-code': { executable: exe('c.exe'), extraArgs: [] } } });
  refuse({ ...base, peers: { 'claude-code': { executable: exe('c.exe'), readOnlyTools: ['Read', 'Bash'] } } });
  refuse({ ...base, peers: { 'claude-code': { executable: exe('c.exe'), readOnlyTools: [] } } });
  refuse({ ...base, peers: { 'claude-code': { executable: exe('c.exe'), delegatePermissionMode: 'bypassPermissions' } } });
  refuse({ ...base, peers: { codex: { executable: exe('codex.cmd') } } });
  refuse({ ...base, peers: { codex: { executable: exe('codex.exe'), reasoningEffort: 'insane' } } });
  refuse({ ...base, peers: {}, limits: { maxTimeoutMs: 2_147_483_648, timeoutMs: 2_147_483_648 } });
});

test('a versioned executable pattern resolves to the newest installed copy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-exe-'));
  try {
    for (const [version, when] of [['2.1.100', 1_700_000_000], ['2.1.284', 1_800_000_000], ['empty', 1_900_000_000]]) {
      await mkdir(path.join(dir, version), { recursive: true });
      if (version !== 'empty') {
        const file = path.join(dir, version, 'claude.exe');
        await writeFile(file, 'x');
        await utimes(file, when, when);
      }
    }
    const configPath = path.join(dir, 'peer.json');
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, stateDir: dir, peers: { 'claude-code': { executable: `${dir.replaceAll('\\', '/')}/*/claude.exe` } } }));
    const config = await loadPeerConfig({ env: { AGENT_PEER_CONFIG: configPath } });
    assert.equal(config.peers['claude-code'].executable, path.join(dir, '2.1.284', 'claude.exe'));
    assert.equal(await resolveExecutablePattern(path.join(dir, 'plain.exe')), path.join(dir, 'plain.exe'));
    await assert.rejects(resolveExecutablePattern(`${dir}/*/missing.exe`), { code: 'PEER_CONFIG_INVALID' });
    await assert.rejects(resolveExecutablePattern(`${dir}/*/*/claude.exe`), { code: 'PEER_CONFIG_INVALID' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- jobs + server end to end with the fake CLI ------------------------------

const fakeSpawn = (command, args, options) => spawn(process.execPath, [FAKE, ...args], options);

async function withServer(env, fn, { maxConcurrent = 3, killTree, resolveLineage = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-'));
  const work = path.join(dir, 'work');
  await mkdir(work);
  const config = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: path.join(dir, 'state'),
    peers: { codex: { executable: path.join(dir, 'codex.exe') }, 'claude-code': { executable: path.join(dir, 'claude.exe') } },
  });
  const kills = [];
  const jobs = createPeerJobs({
    stateDir: config.stateDir,
    spawnImpl: fakeSpawn,
    maxConcurrent,
    shutdownGraceMs: 15_000,
    killTree: async (pid) => {
      kills.push(pid);
      return killTree ? killTree(pid) : defaultKillTree(pid);
    },
  });
  const server = createPeerServer({ env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CLAUDECODE: '1', CODEX_THREAD_ID: 'caller', ...env }, config, jobs, resolveLineage });
  try {
    await fn({ server, jobs, work, dir, config, kills });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const rpc = async (server, name, args) => {
  const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (reply.error) return { protocolError: reply.error };
  if (reply.result.isError) return { error: JSON.parse(reply.result.content[0].text) };
  return reply.result.structuredContent;
};

test('mcp handshake, catalog and strict JSON-RPC envelopes', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'claude-code' }, async ({ server }) => {
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.serverInfo.name, 'agent-peer');
    const list = await server.handle({ jsonrpc: '2.0', id: 'two', method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((t) => t.name), ['peer_capabilities', 'peer_ask', 'peer_check', 'peer_result', 'peer_cancel', 'peer_list']);
    assert.equal(list.id, 'two');
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal((await server.handle({ jsonrpc: '2.0', id: null, method: 'ping' })).error.code, -32600);
    assert.equal((await server.handle({ jsonrpc: '2.0', id: true, method: 'ping' })).error.code, -32600);
    assert.equal((await server.handle({ jsonrpc: '2.0', id: { bad: true }, method: 'ping' })).error.code, -32600);
    assert.equal((await server.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
    assert.equal((await rpc(server, 'peer_nope', {})).protocolError.code, -32602);
    assert.equal((await rpc(server, 'peer_list', { limit: 'one' })).protocolError.code, -32602);
    assert.equal((await rpc(server, 'peer_capabilities', JSON.parse('{"constructor":42,"__proto__":42}'))).protocolError.code, -32602);
    const caps = await rpc(server, 'peer_capabilities', {});
    assert.equal(caps.self, 'claude-code');
    assert.equal(caps.isRootController, true);
    assert.equal(caps.peers.codex.modes.delegate.allowed, true);
    assert.equal(caps.peers['claude-code'].modes.consult.code, 'PEER_SELF_TARGET');
  });
});

test('root claude-code consults codex; the child inherits the chain, not the caller session', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'claude-code', agent_bridge_max_depth: '4' }, async ({ server, work }) => {
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
    // Slices are repeatable and complete.
    const first = await rpc(server, 'peer_result', { jobId: asked.job.jobId, offset: 0, limit: 10 });
    assert.equal(first.finalMessage, result.finalMessage.slice(0, 10));
    assert.equal(first.nextOffset, 10);
    const rest = await rpc(server, 'peer_result', { jobId: asked.job.jobId, offset: first.nextOffset, limit: 200_000 });
    assert.equal(first.finalMessage + rest.finalMessage, result.finalMessage);
    assert.equal(rest.nextOffset, null);
    // Continue the same session under the same root task; foreign or relocated sessions are refused.
    const again = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'And 3+3?', cwd: work, sessionId: asked.job.sessionId, rootTask: 'demo-1', waitMs: 20_000 });
    assert.equal(again.job.status, 'completed');
    assert.equal(again.job.sessionId, asked.job.sessionId);
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'x', cwd: work, sessionId: asked.job.sessionId })).error.code, 'PEER_SESSION_FOREIGN', 'another root task');
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'x', cwd: work, sessionId: 'users-own-interactive-thread' })).error.code, 'PEER_SESSION_UNKNOWN');
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'x', cwd: os.tmpdir(), sessionId: asked.job.sessionId, rootTask: 'demo-1' })).error.code, 'PEER_ARGS_INVALID');
    assert.equal((await rpc(server, 'peer_list', {})).jobs.length, 2);
  });
});

test('another controller session sharing the ledger cannot take over a peer session', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'claude-code' }, async ({ server, work, config, jobs }) => {
    const mine = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hello', cwd: work, waitMs: 20_000 });
    assert.equal(mine.job.status, 'completed');
    assert.match(mine.job.rootTask, /^session-/, 'a root without an explicit label gets its own session label');
    const own = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'again', cwd: work, sessionId: mine.job.sessionId, waitMs: 20_000 });
    assert.equal(own.job.status, 'completed', 'the same controller session continues its own peer session');
    const other = createPeerServer({ env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AGENT_BRIDGE_SELF: 'claude-code' }, config, jobs });
    const stolen = await rpc(other, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'x', cwd: work, sessionId: mine.job.sessionId });
    assert.equal(stolen.error.code, 'PEER_SESSION_FOREIGN');
  });
});

test('a codex sub-controller cannot call back into claude-code; rootTask is root-only', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'claude-code>codex' }, async ({ server, work, jobs }) => {
    const refused = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'review this', cwd: work, waitMs: 0 });
    assert.equal(refused.error.code, 'PEER_CYCLE');
    assert.equal((await jobs.list()).length, 0);
    const caps = await rpc(server, 'peer_capabilities', {});
    assert.equal(caps.peers['claude-code'].modes.review.code, 'PEER_CYCLE');
  });
  // A non-root with a LEGAL target still may not set rootTask.
  await withServer({ AGENT_BRIDGE_SELF: 'claude-code', AGENT_BRIDGE_CHAIN: 'dsh>claude-code' }, async ({ server, work }) => {
    const refused = await rpc(server, 'peer_ask', { target: 'codex', mode: 'review', prompt: 'x', cwd: work, rootTask: 'mine', waitMs: 0 });
    assert.equal(refused.error.code, 'PEER_ARGS_INVALID');
    assert.equal(refused.error.details.field, 'rootTask');
  });
});

test('an env-stripped callee is placed back on its chain by the lineage resolver', async () => {
  const fromLedger = async (env) => ({ env: { ...env, AGENT_BRIDGE_CHAIN: 'claude-code>codex' }, source: 'ledger' });
  await withServer({ AGENT_BRIDGE_SELF: 'codex' }, async ({ server, work }) => {
    const caps = await rpc(server, 'peer_capabilities', {});
    assert.equal(caps.chain, 'claude-code>codex');
    assert.equal(caps.chainSource, 'ledger');
    assert.equal(caps.isRootController, false);
    assert.equal((await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'x', cwd: work })).error.code, 'PEER_CYCLE');
  }, { resolveLineage: fromLedger });
  const broken = async () => { throw new PeerPolicyError('PEER_LINEAGE_UNAVAILABLE', 'no process table'); };
  await withServer({ AGENT_BRIDGE_SELF: 'codex' }, async ({ server, work }) => {
    assert.equal((await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'x', cwd: work })).error.code, 'PEER_LINEAGE_UNAVAILABLE');
  }, { resolveLineage: broken });
  // A self-only chain is still a root claim and must not slip past an unverifiable lineage.
  await withServer({ AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'codex' }, async ({ server, work }) => {
    assert.equal((await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'x', cwd: work })).error.code, 'PEER_LINEAGE_UNAVAILABLE');
  }, { resolveLineage: broken });
  // A genuine callee chain survives an unavailable lineage (it is already restrictive).
  await withServer({ AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'claude-code>codex' }, async ({ server, work }) => {
    assert.equal((await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'x', cwd: work })).error.code, 'PEER_CYCLE');
  }, { resolveLineage: broken });
});

test('a peer CLI that exits immediately is settled from its real exit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-fast-'));
  try {
    // Exits before the start() bookkeeping (ledger + persist) has finished.
    const instant = (command, args, options) => spawn(process.execPath, ['-e', 'process.exit(3)'], options);
    const jobs = createPeerJobs({ stateDir: dir, spawnImpl: instant });
    const allocation = jobs.allocate();
    const plan = planPeerCall(rootClaude(), { target: 'codex', mode: 'consult', rootTask: 't-1' });
    const started = await jobs.start({
      jobId: allocation.jobId,
      invocation: buildInvocation({ target: 'codex', mode: 'consult', cwd: dir, lastMessageFile: allocation.lastMessageFile }, peerConfig().peers.codex),
      plan,
      prompt: 'hi',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      timeoutMs: 60_000,
      cwd: dir,
    });
    const settled = await jobs.wait(started.jobId, 10_000);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.exitCode, 3);
    let active = [];
    try { active = await readdir(path.join(dir, 'active')); } catch { active = []; }
    assert.deepEqual(active, [], 'no stale lineage entry survives a fast exit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model failures, cancellation and timeouts become terminal only after the process exits', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'codex' }, async ({ server, work, jobs, kills, config }) => {
    const failed = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'FAIL please', cwd: work, waitMs: 20_000 });
    assert.equal(failed.job.status, 'failed');
    assert.match(failed.job.errors.join(' '), /Not logged in/);

    const sleeping = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'consult', prompt: 'SLEEP', cwd: work, waitMs: 0 });
    assert.equal(sleeping.job.status, 'running');
    const ledger = await readdir(path.join(config.stateDir, 'active'));
    assert.deepEqual(ledger, [`${sleeping.job.pid}.json`], 'the running child is in the lineage ledger');
    const cancelled = await rpc(server, 'peer_cancel', { jobId: sleeping.job.jobId });
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.killConfirmed, true);
    assert.deepEqual(kills, [sleeping.job.pid]);
    const settled = await rpc(server, 'peer_check', { jobId: sleeping.job.jobId, waitMs: 20_000 });
    assert.equal(settled.job.status, 'cancelled');
    assert.deepEqual(await readdir(path.join(config.stateDir, 'active')), [], 'the ledger entry is cleared');
    const again = await rpc(server, 'peer_cancel', { jobId: sleeping.job.jobId });
    assert.equal(again.cancelRequested, false);

    const allocation = jobs.allocate();
    const plan = planPeerCall(readChainContext({ AGENT_BRIDGE_SELF: 'codex' }), { target: 'claude-code', mode: 'consult' });
    const started = await jobs.start({
      jobId: allocation.jobId,
      invocation: { ...buildInvocation({ target: 'claude-code', mode: 'consult', cwd: work }, config.peers['claude-code']) },
      plan,
      prompt: 'SLEEP',
      env: childEnvironment({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, plan.childEnv),
      timeoutMs: 300,
      cwd: work,
    });
    const timedOut = await jobs.wait(started.jobId, 20_000);
    assert.equal(timedOut.status, 'timed_out');
    const onDisk = JSON.parse(await readFile(path.join(jobs.jobsDir, started.jobId, 'job.json'), 'utf8'));
    assert.equal(onDisk.status, 'timed_out', 'the persisted state is the final state');
  });
});

test('an unconfirmed kill is reported and the job stays non-terminal', async () => {
  let stray = null;
  await withServer({ AGENT_BRIDGE_SELF: 'codex' }, async ({ server, work }) => {
    const sleeping = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'consult', prompt: 'SLEEP', cwd: work, waitMs: 0 });
    stray = sleeping.job.pid;
    const cancelled = await rpc(server, 'peer_cancel', { jobId: sleeping.job.jobId });
    assert.equal(cancelled.killConfirmed, false);
    assert.equal(cancelled.job.status, 'cancelling');
    assert.match(cancelled.job.errors.join(' '), /kill was not confirmed/);
    const result = await rpc(server, 'peer_result', { jobId: sleeping.job.jobId });
    assert.equal(result.complete, false);
    await defaultKillTree(stray);
    assert.equal((await rpc(server, 'peer_check', { jobId: sleeping.job.jobId, waitMs: 20_000 })).job.status, 'cancelled');
  }, { killTree: async () => ({ ok: false, code: 5 }) });
});

test('the concurrency limit holds for simultaneous requests', async () => {
  await withServer({ AGENT_BRIDGE_SELF: 'claude-code' }, async ({ server, work }) => {
    const both = await Promise.all([
      rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'SLEEP', cwd: work, waitMs: 0 }),
      rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'SLEEP', cwd: work, waitMs: 0 }),
    ]);
    const busy = both.filter((reply) => reply.error?.code === 'PEER_BUSY');
    const started = both.filter((reply) => reply.job);
    assert.equal(busy.length, 1);
    assert.equal(started.length, 1);
    await rpc(server, 'peer_cancel', { jobId: started[0].job.jobId });
    assert.equal((await rpc(server, 'peer_check', { jobId: started[0].job.jobId, waitMs: 20_000 })).job.status, 'cancelled');
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hi', cwd: 'relative' })).protocolError.code, -32602, 'the advertised absolute-path pattern is enforced');
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'delegate', prompt: 'hi', cwd: work, addDirs: ['relative'] })).protocolError.code, -32602);
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hi', cwd: path.join(work, 'missing') })).error.code, 'PEER_ARGS_INVALID');
    assert.equal((await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hi', cwd: work, extra: 1 })).protocolError.code, -32602);
    assert.equal((await rpc(server, 'peer_ask', { target: 'gemini', mode: 'consult', prompt: 'hi', cwd: work })).protocolError.code, -32602);
  }, { maxConcurrent: 1 });
});

test('shutdown stops active children and records the real outcome', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-close-'));
  try {
    const jobs = createPeerJobs({ stateDir: dir, spawnImpl: fakeSpawn, shutdownGraceMs: 15_000 });
    const allocation = jobs.allocate();
    const plan = planPeerCall(rootClaude(), { target: 'codex', mode: 'consult' });
    const started = await jobs.start({
      jobId: allocation.jobId,
      invocation: buildInvocation({ target: 'codex', mode: 'consult', cwd: dir, lastMessageFile: allocation.lastMessageFile }, peerConfig().peers.codex),
      plan,
      prompt: 'SLEEP',
      env: childEnvironment({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, plan.childEnv),
      timeoutMs: 60_000,
      cwd: dir,
    });
    await jobs.close();
    const onDisk = JSON.parse(await readFile(path.join(jobs.jobsDir, started.jobId, 'job.json'), 'utf8'));
    assert.equal(onDisk.status, 'cancelled');
    assert.match(onDisk.errors.join(' '), /shut down/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery marks only jobs of dead owners lost; a lost job has no answer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-lost-'));
  try {
    const write = async (jobId, ownerPid, ownerStartedAt = undefined) => {
      await mkdir(path.join(dir, 'jobs', jobId), { recursive: true });
      await writeFile(path.join(dir, 'jobs', jobId, 'job.json'), JSON.stringify({ jobId, status: 'running', ownerPid, ownerStartedAt, errors: [], target: 'codex', mode: 'consult' }));
    };
    await write('peer-1791297108493-0a1b2c3d', DEAD_PID);
    await write('peer-1791297108494-0a1b2c3e', process.ppid, 5_000_000);
    await write('peer-1791297108495-0a1b2c3f', process.ppid, 1_000_000);
    const startTimes = { [process.ppid]: 5_010_000 };
    const jobs = createPeerJobs({ stateDir: dir, spawnImpl: () => assert.fail('must not spawn'), processStartTime: async (pid) => startTimes[pid] ?? null });
    const listed = Object.fromEntries((await jobs.list()).map((job) => [job.jobId, job.status]));
    assert.equal(listed['peer-1791297108493-0a1b2c3d'], 'lost');
    assert.equal(listed['peer-1791297108494-0a1b2c3e'], 'running', 'a job of another live server is left alone');
    assert.equal(listed['peer-1791297108495-0a1b2c3f'], 'lost', 'a reused owner pid is not the owner');
    const result = await jobs.result('peer-1791297108493-0a1b2c3d');
    assert.equal(result.complete, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.finalMessage, null);
    const cancel = await jobs.cancel('peer-1791297108494-0a1b2c3e');
    assert.equal(cancel.cancelRequested, false);
    assert.match(cancel.reason, /another live peer server/);
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

test('bin/peer-mcp.mjs speaks MCP over real stdio and exits when stdin closes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-peer-stdio-'));
  try {
    const configPath = path.join(dir, 'peer.json');
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, stateDir: path.join(dir, 'state'), peers: { codex: { executable: path.join(dir, 'codex.exe') } } }));
    const child = spawn(process.execPath, [path.join(REPO, 'bin', 'peer-mcp.mjs')], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AGENT_BRIDGE_SELF: 'claude-code', AGENT_PEER_CONFIG: configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const replies = [];
    readline.createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line)));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    child.stdin.write('this is not json\n');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'peer_capabilities', arguments: {} } })}\n`);
    const deadline = Date.now() + 20_000;
    while (replies.length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.equal(replies.find((r) => r.id === 1).result.serverInfo.name, 'agent-peer');
    assert.equal(replies.find((r) => r.id === null).error.code, -32700);
    assert.equal(replies.find((r) => r.id === 2).result.tools.length, 6);
    const caps = replies.find((r) => r.id === 3).result.structuredContent;
    assert.equal(caps.self, 'claude-code');
    assert.equal(caps.isRootController, true);
    assert.equal(caps.chainSource, 'environment', 'no ledger ancestor for a root controller');
    assert.equal(replies.length, 4, 'the notification got no reply');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
