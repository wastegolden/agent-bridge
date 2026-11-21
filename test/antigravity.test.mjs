import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { parseViaHeaders, loadControllerRegistry } from '../src/controller-auth.mjs';
import { ENV_KEYS, HARNESSES, PEER_TARGETS, planPeerCall, readChainContext } from '../src/peer/chain.mjs';
import {
  ANTIGRAVITY_DEFAULT_DELEGATE_PERMISSIONS,
  ANTIGRAVITY_EFFORTS,
  ANTIGRAVITY_READ_ONLY_DENY,
  CLAUDE_WEB_TOOLS,
  CLAUDE_WRITE_TOOLS,
  buildInvocation,
  childEnvironment,
  effortChoices,
  formatAntigravityInput,
  parseAntigravityOutput,
  parsePeerOutput,
} from '../src/peer/cli.mjs';
import { normalizePeerConfig } from '../src/peer/config.mjs';
import { createPeerJobs } from '../src/peer/jobs.mjs';
import { appendIndexEvent, readIndex } from '../src/peer/records.mjs';
import { createPeerServer } from '../src/peer/server.mjs';
import { sweepRecords } from '../src/peer/sweeper.mjs';
import { deploy, identityLayout } from '../scripts/deploy-local.mjs';
import { testDir } from './helpers/test-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FAKE = path.join(HERE, 'fixtures', 'fake-peer-cli.mjs');
const ABS = process.platform === 'win32' ? 'C:\\agy-peer-test' : '/agy-peer-test';
const slash = (value) => value.replaceAll('\\', '/');

const exists = (file) => stat(file).then(() => true, () => false);

async function rpc(server, tool, args) {
  const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  if (reply.error) return { protocolError: reply.error };
  if (reply.result.isError) return { toolError: JSON.parse(reply.result.content[0].text) };
  return reply.result.structuredContent;
}

function fakeJobs(stateDir, maxConcurrent = 3) {
  return createPeerJobs({
    stateDir,
    maxConcurrent,
    spawnImpl: (command, args, options) => spawn(process.execPath, [FAKE, ...args], options),
  });
}

// --- 1. Chain policy & via headers --------------------------------------------

test('antigravity participates in 3-harness chains, 2-hop consult/review, cycle and via validation', () => {
  assert.ok(HARNESSES.includes('antigravity'));
  assert.ok(PEER_TARGETS.includes('antigravity'));

  const rootAgy = readChainContext({ [ENV_KEYS.self]: 'antigravity' });
  assert.equal(rootAgy.isRoot, true);
  assert.throws(() => planPeerCall(rootAgy, { target: 'antigravity', mode: 'consult' }), { code: 'PEER_SELF_TARGET' });
  for (const target of ['claude-code', 'codex']) {
    const plan = planPeerCall(rootAgy, { target, mode: 'delegate', rootTask: 'agy-root-1' });
    assert.deepEqual([...plan.chain], ['antigravity', target]);
    assert.equal(plan.depth, 1);
    assert.equal(plan.childEnv[ENV_KEYS.chain], `antigravity>${target}`);
  }

  // 2-hop chain: claude-code -> codex -> antigravity
  const codexSub = readChainContext({ [ENV_KEYS.self]: 'codex', [ENV_KEYS.chain]: 'claude-code>codex' });
  const hop2 = planPeerCall(codexSub, { target: 'antigravity', mode: 'review' });
  assert.deepEqual([...hop2.chain], ['claude-code', 'codex', 'antigravity']);
  assert.equal(hop2.depth, 2);
  assert.equal(hop2.calleeMayPeer, false);
  assert.throws(() => planPeerCall(codexSub, { target: 'antigravity', mode: 'delegate' }), { code: 'PEER_DELEGATE_DEPTH' });

  const agyLeaf = readChainContext(hop2.childEnv);
  assert.throws(() => planPeerCall(agyLeaf, { target: 'claude-code', mode: 'consult' }), { code: 'PEER_CYCLE' });
  assert.throws(() => planPeerCall(agyLeaf, { target: 'codex', mode: 'review' }), { code: 'PEER_CYCLE' });
  assert.throws(() => planPeerCall(agyLeaf, { target: 'antigravity', mode: 'consult' }), { code: 'PEER_SELF_TARGET' });

  // via headers accept antigravity in chains and keep error guidance bounded (<= 120 chars)
  const parsed = parseViaHeaders({ headers: { 'x-agent-bridge-chain': 'claude-code>codex>antigravity', 'x-agent-bridge-root-task': 'task_1' } });
  assert.deepEqual(parsed, { chain: ['claude-code', 'codex', 'antigravity'], rootTask: 'task_1' });
  assert.throws(
    () => parseViaHeaders({ headers: { 'x-agent-bridge-chain': 'antigravity>bad' } }),
    (error) => error.code === 'VIA_INVALID' && error.details.expected.length <= 120,
  );
});

// --- 2. Config validation -----------------------------------------------------

test('antigravity peer config validates structured options and refuses unsafe inputs', () => {
  const normalized = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: {
      antigravity: {
        executable: path.join(ABS, 'agy.exe'),
        model: 'gemini-3.8-flash',
        effort: 'high',
        readOnlyAgent: 'agent-bridge-readonly',
        readOnlyWebAgent: 'agent-bridge-readonly-web',
        delegateMode: 'auto',
        delegateSandbox: true,
        delegateAllowedPermissions: ['mcp(agent-bridge_dsh_project/*)', 'command(npm test)'],
      },
    },
    records: { antigravityDataDir: path.join(ABS, 'agy-data') },
  });
  const agy = normalized.peers.antigravity;
  assert.equal(agy.model, 'gemini-3.8-flash');
  assert.equal(agy.effort, 'high');
  assert.equal(agy.readOnlyAgent, 'agent-bridge-readonly');
  assert.equal(agy.readOnlyWebAgent, 'agent-bridge-readonly-web');
  assert.equal(agy.delegateMode, 'auto');
  assert.equal(agy.delegateSandbox, true);
  assert.deepEqual(agy.delegateAllowedPermissions, ['mcp(agent-bridge_dsh_project/*)', 'command(npm test)']);
  assert.equal(normalized.records.antigravityDataDir, path.resolve(path.join(ABS, 'agy-data')));

  // Defaults
  const bare = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: { antigravity: { executable: path.join(ABS, 'agy.exe') } },
  });
  assert.equal(bare.peers.antigravity.readOnlyAgent, null);
  assert.equal(bare.peers.antigravity.readOnlyWebAgent, null);
  assert.equal(bare.peers.antigravity.delegateMode, 'accept-edits');
  assert.equal(bare.peers.antigravity.delegateSandbox, false);
  assert.deepEqual(bare.peers.antigravity.delegateAllowedPermissions, [...ANTIGRAVITY_DEFAULT_DELEGATE_PERMISSIONS]);
  assert.ok(path.isAbsolute(bare.records.antigravityDataDir));

  // Refusals
  const badConfigs = [
    { peers: { antigravity: { executable: path.join(ABS, 'agy.cmd') } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), extraArgs: ['--dangerously-skip-permissions'] } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), delegateMode: 'plan' } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), delegateSandbox: 'yes' } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), readOnlyAgent: 'bad agent!' } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), readOnlyWebAgent: 123 } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), delegateAllowedPermissions: ['not-a-rule'] } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), delegateAllowedPermissions: ['mcp(bad(nested))'] } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), delegateAllowedPermissions: ['mcp(line\nbreak)'] } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), efforts: ['fast'], effort: 'high' } } },
    { peers: { antigravity: { executable: path.join(ABS, 'agy.exe') } }, records: { antigravityDataDir: 'relative/path' } },
  ];
  for (const patch of badConfigs) {
    assert.throws(() => normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, ...patch }), { code: 'PEER_CONFIG_INVALID' });
  }
});

// --- 3. CLI invocation & webSearch toggle across all 3 targets ----------------

test('antigravity buildInvocation locks down read-only, toggles webSearch via agents, and configures delegate', () => {
  assert.deepEqual(effortChoices('antigravity', {}), [...ANTIGRAVITY_EFFORTS]);
  const fullPeer = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: {
      antigravity: {
        executable: path.join(ABS, 'agy.exe'),
        model: 'gemini-3.8-flash',
        effort: 'medium',
        readOnlyAgent: 'agent-bridge-readonly',
        readOnlyWebAgent: 'agent-bridge-readonly-web',
        delegateMode: 'accept-edits',
        delegateSandbox: true,
      },
    },
  }).peers.antigravity;

  // Default read-only (webSearch omitted -> local readOnlyAgent)
  const review = buildInvocation({ target: 'antigravity', mode: 'review', cwd: ABS }, fullPeer);
  assert.equal(review.readOnly, true);
  assert.equal(review.webSearch, false);
  assert.equal(review.inputFormat, 'stream-json');
  assert.deepEqual(review.args.slice(0, 5), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']);
  assert.equal(review.args[review.args.indexOf('--agent') + 1], 'agent-bridge-readonly');
  assert.equal(review.args[review.args.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(review.args[review.args.indexOf('--effort') + 1], 'medium');
  assert.equal(review.args.includes('--sandbox'), false);
  assert.equal(review.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(review.args.at(-2), '--settings', '--settings sits last');
  const roSettings = JSON.parse(review.args.at(-1));
  assert.equal(roSettings.allowNonWorkspaceAccess, false);
  assert.deepEqual(roSettings.permissions.deny, [...ANTIGRAVITY_READ_ONLY_DENY]);

  // webSearch: true switches to readOnlyWebAgent while keeping all 5 deny rules
  const withWeb = buildInvocation({ target: 'antigravity', mode: 'consult', cwd: ABS, webSearch: true, reasoningEffort: 'high' }, fullPeer);
  assert.equal(withWeb.webSearch, true);
  assert.equal(withWeb.effortSource, 'call');
  assert.equal(withWeb.args[withWeb.args.indexOf('--agent') + 1], 'agent-bridge-readonly-web');
  assert.equal(withWeb.args[withWeb.args.indexOf('--effort') + 1], 'high');
  assert.deepEqual(JSON.parse(withWeb.args.at(-1)).permissions.deny, [...ANTIGRAVITY_READ_ONLY_DENY]);

  // webSearch: false explicitly selects local readOnlyAgent
  const noWeb = buildInvocation({ target: 'antigravity', mode: 'consult', cwd: ABS, webSearch: false }, fullPeer);
  assert.equal(noWeb.webSearch, false);
  assert.equal(noWeb.args[noWeb.args.indexOf('--agent') + 1], 'agent-bridge-readonly');

  // Fail-closed checks when agents are missing
  const barePeer = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: { antigravity: { executable: path.join(ABS, 'agy.exe') } },
  }).peers.antigravity;
  assert.throws(
    () => buildInvocation({ target: 'antigravity', mode: 'consult', cwd: ABS, webSearch: false }, barePeer),
    (error) => error.code === 'PEER_CONFIG_INVALID' && error.detail?.field === 'readOnlyAgent',
  );
  const bareWeb = buildInvocation({ target: 'antigravity', mode: 'consult', cwd: ABS, webSearch: true }, barePeer);
  assert.equal(bareWeb.webSearch, true);
  assert.equal(bareWeb.args.includes('--agent'), false);

  const localOnlyPeer = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: { antigravity: { executable: path.join(ABS, 'agy.exe'), readOnlyAgent: 'agent-bridge-readonly' } },
  }).peers.antigravity;
  assert.throws(
    () => buildInvocation({ target: 'antigravity', mode: 'review', cwd: ABS, webSearch: true }, localOnlyPeer),
    (error) => error.code === 'PEER_CONFIG_INVALID' && error.detail?.field === 'readOnlyWebAgent',
  );

  // Delegate mode
  const delegate = buildInvocation({
    target: 'antigravity',
    mode: 'delegate',
    cwd: ABS,
    sessionId: 'd8f6899d-1b7f-4a8e-898a-4131bf6b1857',
    addDirs: [path.join(ABS, 'extra')],
  }, fullPeer);
  assert.equal(delegate.readOnly, false);
  assert.equal(delegate.webSearch, null);
  assert.equal(delegate.args.includes('--agent'), false, 'delegate must not attach read-only agent');
  assert.equal(delegate.args.includes('--sandbox'), true);
  assert.equal(delegate.args[delegate.args.indexOf('--conversation') + 1], 'd8f6899d-1b7f-4a8e-898a-4131bf6b1857');
  assert.equal(delegate.args[delegate.args.indexOf('--add-dir') + 1], path.resolve(path.join(ABS, 'extra')));
  const delSettings = JSON.parse(delegate.args.at(-1));
  assert.equal(delSettings.agentMode, 'accept-edits');
  assert.deepEqual(delSettings.permissions.allow, [...ANTIGRAVITY_DEFAULT_DELEGATE_PERMISSIONS]);

  assert.throws(
    () => buildInvocation({ target: 'antigravity', mode: 'delegate', cwd: ABS, webSearch: false }, fullPeer),
    (error) => error.code === 'PEER_ARGS_INVALID' && error.detail?.field === 'webSearch',
  );
  assert.throws(
    () => buildInvocation({ target: 'antigravity', mode: 'review', cwd: ABS, addDirs: [ABS] }, fullPeer),
    { code: 'PEER_ARGS_INVALID' },
  );
});

test('webSearch toggle works on claude-code and is explicitly refused on codex', () => {
  const cfg = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: {
      codex: { executable: path.join(ABS, 'codex.exe') },
      'claude-code': { executable: path.join(ABS, 'claude.exe'), readOnlyTools: ['Read', 'Grep', 'WebSearch', 'WebFetch'] },
    },
  });

  // Codex explicitly refuses both true and false
  for (const flag of [true, false]) {
    assert.throws(
      () => buildInvocation({ target: 'codex', mode: 'review', cwd: ABS, lastMessageFile: path.join(ABS, 'last.txt'), webSearch: flag }, cfg.peers.codex),
      (error) => error.code === 'PEER_ARGS_INVALID' && error.detail?.field === 'webSearch',
    );
  }

  // Claude webSearch: false strips WebSearch/WebFetch and adds them to --disallowedTools
  const claudeOff = buildInvocation({ target: 'claude-code', mode: 'review', cwd: ABS, webSearch: false }, cfg.peers['claude-code']);
  assert.equal(claudeOff.webSearch, false);
  const toolsOff = claudeOff.args.slice(claudeOff.args.indexOf('--tools') + 1);
  assert.deepEqual(toolsOff, ['Read', 'Grep']);
  const deniedOff = claudeOff.args.slice(claudeOff.args.indexOf('--disallowedTools') + 1, claudeOff.args.indexOf('--allowedTools'));
  assert.deepEqual(deniedOff, [...CLAUDE_WRITE_TOOLS, ...CLAUDE_WEB_TOOLS]);

  // Claude webSearch: true adds WebSearch/WebFetch even if configured readOnlyTools omitted them
  const claudeLocal = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: { 'claude-code': { executable: path.join(ABS, 'claude.exe'), readOnlyTools: ['Read', 'Grep'] } },
  }).peers['claude-code'];
  const claudeOn = buildInvocation({ target: 'claude-code', mode: 'consult', cwd: ABS, webSearch: true }, claudeLocal);
  assert.equal(claudeOn.webSearch, true);
  assert.deepEqual(claudeOn.args.slice(claudeOn.args.indexOf('--tools') + 1), ['Read', 'Grep', 'WebSearch', 'WebFetch']);

  // Claude webSearch: false refuses if no non-web tools remain
  const claudeWebOnly = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: { 'claude-code': { executable: path.join(ABS, 'claude.exe'), readOnlyTools: ['WebSearch'] } },
  }).peers['claude-code'];
  assert.throws(
    () => buildInvocation({ target: 'claude-code', mode: 'consult', cwd: ABS, webSearch: false }, claudeWebOnly),
    { code: 'PEER_CONFIG_INVALID' },
  );
});

// --- 4. Caller environment stripping & output parsing -------------------------

test('childEnvironment strips Antigravity session and CSRF vars in any case', () => {
  const env = childEnvironment(
    {
      PATH: 'p',
      ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf',
      antigravity_ls_address: '127.0.0.1:5387',
      ANTIGRAVITY_CONVERSATION_ID: 'conv-1',
      ANTIGRAVITY_TRAJECTORY_ID: 'traj-1',
      ANTIGRAVITY_PROJECT_ID: 'proj-1',
      ANTIGRAVITY_AGENT: '1',
      ANTIGRAVITY_APP_DATA_DIR: 'C:\\data',
      ANTIGRAVITY_AGENTAPI_EXE: 'C:\\exe',
      ANTIGRAVITY_LS_VERSION: '1.0',
      ANTIGRAVITY_SOURCE_METADATA: 'meta',
      AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP: '1',
      KEEP_ME: 'ok',
    },
    { AGENT_BRIDGE_SELF: 'codex', AGENT_BRIDGE_CHAIN: 'antigravity>codex' },
  );
  assert.deepEqual(env, {
    PATH: 'p',
    KEEP_ME: 'ok',
    DSH_BRIDGE_DISABLED: '1',
    AGENT_BRIDGE_SELF: 'codex',
    AGENT_BRIDGE_CHAIN: 'antigravity>codex',
  });
});

test('parseAntigravityOutput and formatAntigravityInput handle success, error and malformed streams', () => {
  const framed = JSON.parse(formatAntigravityInput('hello\nworld'));
  assert.deepEqual(framed, { event: 'user', message: { content: 'hello\nworld' } });

  const ok = parsePeerOutput('antigravity', [
    '{"event":"init","conversation_id":"11111111-1111-1111-1111-111111111111","init":{"model":"gemini-3.8-flash"}}',
    'not-json-noise',
    '{"event":"step_update","step_update":{"step_index":0}}',
    '{"event":"result","result":{"conversation_id":"11111111-1111-1111-1111-111111111111","status":"SUCCESS","response":"DONE","num_turns":2,"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
  ].join('\n'));
  assert.equal(ok.ok, true);
  assert.equal(ok.sessionId, '11111111-1111-1111-1111-111111111111');
  assert.equal(ok.finalMessage, 'DONE');
  assert.equal(ok.numTurns, 2);
  assert.equal(ok.unparsedLines, 1);
  assert.equal(ok.eventCounts.result, 1);

  const err = parseAntigravityOutput('{"event":"result","result":{"conversation_id":"","status":"ERROR","error":"unknown model","response":""}}');
  assert.equal(err.ok, false);
  assert.equal(err.sessionId, null);
  assert.deepEqual(err.errors, ['unknown model']);

  const canceled = parseAntigravityOutput('{"event":"result","result":{"conversation_id":"22222222-2222-2222-2222-222222222222","status":"CANCELED","response":""}}');
  assert.equal(canceled.ok, false);
  assert.match(canceled.errors[0], /CANCELED/);

  const missingResult = parseAntigravityOutput('{"event":"init","conversation_id":"33333333-3333-3333-3333-333333333333"}');
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.errors[0], /result event/);
});

// --- 5. End-to-end peer server (bidirectional) --------------------------------

test('Antigravity keeps the final result after more than 16 MiB of streamed events', async (t) => {
  const cwd = testDir(t, 'agy-long-stream');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  const jobs = createPeerJobs({ stateDir: cwd, lineage: false, spawnImpl: () => child });
  t.after(() => jobs.close());
  const plan = planPeerCall(readChainContext({ AGENT_BRIDGE_SELF: 'codex' }), { target: 'antigravity', mode: 'review' });
  const { jobId } = jobs.allocate();
  const invocation = buildInvocation({ target: plan.target, mode: plan.mode, cwd }, { executable: process.execPath });
  await jobs.start({ jobId, invocation, plan, prompt: 'inspect', cwd, timeoutMs: 20_000 });

  child.stdout.write('{"event":"init","conversation_id":"from-first-event"}\n');
  const update = JSON.stringify({ event: 'step_update', text: 'x'.repeat(64 * 1024) }) + '\n';
  for (let i = 0; i < 256; i++) child.stdout.write(update);
  const last = Buffer.from(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '完成', usage: { total_tokens: 123 } } }));
  const split = last.indexOf('完') + 1;
  const ended = once(child.stdout, 'end');
  child.stdout.write(last.subarray(0, split));
  child.stdout.end(last.subarray(split)); // A split UTF-8 character and no final newline.
  await ended;
  child.emit('close', 0, null);
  const job = await jobs.wait(jobId, 10_000);
  assert.equal(job.status, 'completed', JSON.stringify(job.errors));
  assert.equal(job.sessionId, 'from-first-event');
  assert.equal(job.usage.total_tokens, 123);
  assert.equal((await jobs.result(jobId)).finalMessage, '完成');
  const stored = JSON.parse(await readFile(path.join(cwd, 'jobs', jobId, 'result.json'), 'utf8'));
  assert.deepEqual(stored.eventCounts, { init: 1, step_update: 256, result: 1 });
});

test('bidirectional peer server: claude-code <-> antigravity, webSearch toggle, session resume and delegate token', async (t) => {
  const root = testDir(t, 'antigravity-server');
  const stateDir = path.join(root, 'state');
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const token = 'agy-delegate-test-token-0123456789abcdef';
  const credFile = path.join(root, 'claude.token');
  await writeFile(credFile, token);

  const config = normalizePeerConfig({
    schemaVersion: 1,
    stateDir,
    peers: {
      codex: { executable: process.execPath, threadSection: null },
      'claude-code': { executable: process.execPath },
      antigravity: {
        executable: process.execPath,
        readOnlyAgent: 'agent-bridge-readonly',
        readOnlyWebAgent: 'agent-bridge-readonly-web',
      },
    },
    records: { enabled: false },
    bridge: { url: 'http://127.0.0.1:3199/mcp/test', credentialFile: credFile },
  });

  // Direction A: claude-code -> antigravity
  const bridgeClient = {
    prepareDelegateCredential: async () => ({ token, principal: { id: 'claude-code', admin: false } }),
    dossier: async () => ({}),
    resultText: async () => '',
  };
  const claudeServer = createPeerServer({
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AGENT_BRIDGE_SELF: 'claude-code', CLAUDECODE: '1' },
    config,
    jobs: fakeJobs(stateDir),
    bridgeClient,
    startSweepTimer: false,
  });
  t.after(async () => { await claudeServer.close(); });

  const caps = await rpc(claudeServer, 'peer_capabilities', {});
  assert.equal(caps.peers.antigravity.enabled, true);
  assert.equal(caps.peers.antigravity.webSearchControl, true);
  assert.equal(caps.peers['claude-code'].webSearchControl, true);
  assert.equal(caps.peers.codex.webSearchControl, false);
  assert.equal(caps.peers.antigravity.modes.consult.allowed, true);
  assert.equal(caps.peers.antigravity.modes.delegate.allowed, true);

  // 1) Read-only consult (default local)
  const localJob = await rpc(claudeServer, 'peer_ask', {
    target: 'antigravity', mode: 'consult', prompt: 'Inspect locally', cwd: work, rootTask: 'agy-e2e-1', waitMs: 20_000,
  });
  assert.equal(localJob.job.status, 'completed', JSON.stringify(localJob));
  assert.equal(localJob.job.webSearch, false);
  assert.equal(localJob.job.sessionId, 'd8f6899d-1b7f-4a8e-898a-4131bf6b1857');
  const localRes = await rpc(claudeServer, 'peer_result', { jobId: localJob.job.jobId });
  const localEcho = JSON.parse(localRes.finalMessage.replace(/^ANTIGRAVITY-ECHO /, ''));
  assert.equal(localEcho.self, 'antigravity');
  assert.equal(localEcho.chain, 'claude-code>antigravity');
  assert.equal(localEcho.claudecode, null);
  assert.equal(localEcho.hasPreamble, true);
  assert.equal(localEcho.argv[localEcho.argv.indexOf('--agent') + 1], 'agent-bridge-readonly');

  // Verify prompt.txt stored human-readable text (not JSON-framed NDJSON)
  const storedPrompt = await readFile(path.join(stateDir, 'jobs', localJob.job.jobId, 'prompt.txt'), 'utf8');
  assert.ok(storedPrompt.startsWith('[agent-bridge]'));
  assert.ok(storedPrompt.includes('Inspect locally'));

  // 2) Continue session with webSearch: true
  const webJob = await rpc(claudeServer, 'peer_ask', {
    target: 'antigravity', mode: 'review', prompt: 'Check docs online', cwd: work,
    sessionId: localJob.job.sessionId, rootTask: 'agy-e2e-1', webSearch: true, waitMs: 20_000,
  });
  assert.equal(webJob.job.status, 'completed', JSON.stringify(webJob));
  assert.equal(webJob.job.webSearch, true);
  const webRes = await rpc(claudeServer, 'peer_result', { jobId: webJob.job.jobId });
  const webEcho = JSON.parse(webRes.finalMessage.replace(/^ANTIGRAVITY-ECHO /, ''));
  assert.equal(webEcho.argv[webEcho.argv.indexOf('--agent') + 1], 'agent-bridge-readonly-web');
  assert.equal(webEcho.argv[webEcho.argv.indexOf('--conversation') + 1], localJob.job.sessionId);

  // 3) Delegate inherits root credential without leaking it to disk or prompt
  const delJob = await rpc(claudeServer, 'peer_ask', {
    target: 'antigravity', mode: 'delegate', prompt: 'Run bounded sub-task', cwd: work, rootTask: 'agy-e2e-1', waitMs: 20_000,
  });
  assert.equal(delJob.job.status, 'completed', JSON.stringify(delJob));
  assert.equal(delJob.job.bridge.state, 'enabled');
  const jobJsonText = await readFile(path.join(stateDir, 'jobs', delJob.job.jobId, 'job.json'), 'utf8');
  assert.equal(jobJsonText.includes(token), false);

  // 4) Failure propagation
  const failJob = await rpc(claudeServer, 'peer_ask', {
    target: 'antigravity', mode: 'consult', prompt: 'FAIL now', cwd: work, rootTask: 'agy-e2e-1', waitMs: 20_000,
  });
  assert.equal(failJob.job.status, 'failed');
  assert.ok(failJob.job.errors.some((msg) => msg.includes('model refused')));

  // Direction B: antigravity -> codex & claude-code (strips ANTIGRAVITY_CSRF_TOKEN)
  const agyServer = createPeerServer({
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      AGENT_BRIDGE_SELF: 'antigravity',
      ANTIGRAVITY_CSRF_TOKEN: 'host-csrf-secret',
      ANTIGRAVITY_CONVERSATION_ID: 'host-conv-1',
    },
    config,
    jobs: fakeJobs(stateDir),
    startSweepTimer: false,
  });
  t.after(async () => { await agyServer.close(); });

  const agyCaps = await rpc(agyServer, 'peer_capabilities', {});
  assert.equal(agyCaps.self, 'antigravity');
  assert.equal(agyCaps.peers.antigravity.modes.consult.code, 'PEER_SELF_TARGET');
  assert.equal(agyCaps.peers.codex.modes.consult.allowed, true);
  assert.equal(agyCaps.peers['claude-code'].modes.delegate.allowed, true);

  const agyToCodex = await rpc(agyServer, 'peer_ask', {
    target: 'codex', mode: 'consult', prompt: 'Second opinion', cwd: work, rootTask: 'agy-caller-1', waitMs: 20_000,
  });
  assert.equal(agyToCodex.job.status, 'completed', JSON.stringify(agyToCodex));
  const codexRes = await rpc(agyServer, 'peer_result', { jobId: agyToCodex.job.jobId });
  const codexEcho = JSON.parse(codexRes.finalMessage.replace(/^CODEX-ECHO /, ''));
  assert.equal(codexEcho.chain, 'antigravity>codex');
  assert.equal(codexEcho.antigravityCsrf, null);
  assert.equal(codexEcho.antigravityConv, null);

  // Refuses webSearch on codex explicitly
  const badWebOnCodex = await rpc(agyServer, 'peer_ask', {
    target: 'codex', mode: 'consult', prompt: 'Search please', cwd: work, webSearch: true, waitMs: 0,
  });
  assert.equal(badWebOnCodex.toolError.code, 'PEER_ARGS_INVALID');
  assert.equal(badWebOnCodex.toolError.details.field, 'webSearch');
});

// --- 6. Sweeper for Antigravity sessions --------------------------------------

test('sweepRecords deletes Antigravity sessions safely (brain/lock/wal/shm before .db) and defers on EBUSY', async (t) => {
  const root = testDir(t, 'antigravity-sweeper');
  const stateDir = path.join(root, 'state');
  const agyData = path.join(root, 'antigravity-cli');
  const recordFile = path.join(root, 'record.md');
  await writeFile(recordFile, '# closed out\n');

  const idOk = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const idBusy = '11111111-2222-3333-4444-555555555555';
  const idMissing = '99999999-8888-7777-6666-555555555555';

  const setupSession = async (id) => {
    await mkdir(path.join(agyData, 'conversations'), { recursive: true });
    await mkdir(path.join(agyData, 'brain', id), { recursive: true });
    await mkdir(path.join(agyData, 'presence'), { recursive: true });
    await writeFile(path.join(agyData, 'conversations', `${id}.db`), 'sqlite');
    await writeFile(path.join(agyData, 'conversations', `${id}.db-wal`), 'wal');
    await writeFile(path.join(agyData, 'conversations', `${id}.db-shm`), 'shm');
    await writeFile(path.join(agyData, 'brain', id, 'artifact.md'), 'note');
    await writeFile(path.join(agyData, 'presence', `${id}.lock`), '1234');
  };
  await setupSession(idOk);
  await setupSession(idBusy);

  await appendIndexEvent(stateDir, {
    kind: 'record',
    recordId: 'rec-agy-1',
    owner: null,
    rootTask: 't-1',
    title: 'agy sweep',
    projectRoot: root,
    path: recordFile,
    sha256: '0'.repeat(64),
    outcome: 'accepted',
    keep: false,
    closedAt: 1_000,
    eligibleAt: 2_000,
    sessions: [
      { harness: 'antigravity', id: idOk, source: 'peer-1' },
      { harness: 'antigravity', id: idMissing, source: 'peer-2' },
      { harness: 'antigravity', id: '../escape', source: 'peer-3' },
    ],
  }, { now: () => 1_000 });

  // Dry run plans valid sessions and rejects invalid id without touching disk
  const preview = await sweepRecords({ stateDir, now: () => 5_000, dryRun: true, antigravityDataDir: agyData });
  assert.equal(preview.actions.find((a) => a.id === idOk).state, 'planned');
  assert.equal(preview.actions.find((a) => a.id === '../escape').state, 'failed');
  assert.equal(await exists(path.join(agyData, 'conversations', `${idOk}.db`)), true);

  // Unavailable dir -> deferred (no index mutation)
  const deferredDir = await sweepRecords({ stateDir, now: () => 5_000, dryRun: false, antigravityDataDir: path.join(root, 'absent') });
  assert.equal(deferredDir.actions.find((a) => a.id === idOk).state, 'deferred');
  assert.equal((await readIndex(stateDir)).get('rec-agy-1').sessions.get(`antigravity\u0000${idOk}`).state, 'pending');

  // Real sweep deletes all files of idOk and skips idMissing
  const run = await sweepRecords({ stateDir, now: () => 5_000, dryRun: false, antigravityDataDir: agyData });
  assert.equal(run.actions.find((a) => a.id === idOk).state, 'deleted');
  assert.equal(run.actions.find((a) => a.id === idMissing).state, 'skipped');
  assert.equal(await exists(path.join(agyData, 'conversations', `${idOk}.db`)), false);
  assert.equal(await exists(path.join(agyData, 'conversations', `${idOk}.db-wal`)), false);
  assert.equal(await exists(path.join(agyData, 'conversations', `${idOk}.db-shm`)), false);
  assert.equal(await exists(path.join(agyData, 'brain', idOk)), false);
  assert.equal(await exists(path.join(agyData, 'presence', `${idOk}.lock`)), false);

  // EBUSY while removing brain/<idBusy> leaves .db intact and marks deferred so next sweep finishes
  await appendIndexEvent(stateDir, {
    kind: 'record',
    recordId: 'rec-agy-busy',
    owner: null,
    rootTask: 't-2',
    title: 'agy busy',
    projectRoot: root,
    path: recordFile,
    sha256: '1'.repeat(64),
    outcome: 'accepted',
    keep: false,
    closedAt: 1_000,
    eligibleAt: 2_000,
    sessions: [{ harness: 'antigravity', id: idBusy, source: 'peer-4' }],
  }, { now: () => 1_000 });

  let failOnce = true;
  const busyRun = await sweepRecords({
    stateDir,
    now: () => 5_000,
    dryRun: false,
    antigravityDataDir: agyData,
    fsImpl: {
      rm: async (target, opts) => {
        if (failOnce && target.includes(path.join('brain', idBusy))) {
          failOnce = false;
          const err = new Error('resource busy');
          err.code = 'EBUSY';
          throw err;
        }
        return rm(target, opts);
      },
    },
  });
  assert.equal(busyRun.actions.find((a) => a.id === idBusy).state, 'deferred');
  assert.equal(await exists(path.join(agyData, 'conversations', `${idBusy}.db`)), true, '.db stays intact after brain EBUSY');

  const retryRun = await sweepRecords({ stateDir, now: () => 6_000, dryRun: false, antigravityDataDir: agyData });
  assert.equal(retryRun.actions.find((a) => a.id === idBusy).state, 'deleted');
  assert.equal(await exists(path.join(agyData, 'conversations', `${idBusy}.db`)), false);
  assert.equal(await exists(path.join(agyData, 'brain', idBusy)), false);
});

// --- 7. Deployment (opt-in Antigravity plugin + identity artifacts) -----------

for (const identityMode of [true, false]) {
  test(`Antigravity upgrade preserves existing ${identityMode ? 'per-root' : 'shared'} peer settings and enables both callers`, async (t) => {
    const root = testDir(t, 'agy-upgrade');
    const config = {
      deployRoot: path.join(root, 'deploy'), nodePath: process.execPath,
      bridgeUrl: 'http://127.0.0.1:3080/mcp/test', codexExecutable: process.execPath, claudeExecutable: process.execPath,
      ...(identityMode ? { identity: { credentialDirectory: path.join(root, 'creds'), migrationBackupDirectory: path.join(root, 'backups') } } : {}),
    };
    const options = { config, packageRoot: REPO, spawnImpl: () => ({ status: 0, stdout: '' }), stdout: () => {}, stderr: () => {} };
    await deploy(options);
    const shared = path.join(config.deployRoot, 'config', 'agent-peer.json');
    const files = identityMode ? identityLayout(config).peerFiles : { claude: shared, codex: shared };
    const before = new Map();
    for (const file of new Set(Object.values(files))) {
      const old = JSON.parse(await readFile(file, 'utf8'));
      old.peers.codex.model = 'custom-model';
      old.records.retainDays = 14;
      before.set(file, old);
      await writeFile(file, JSON.stringify(old));
    }
    Object.assign(config, { antigravityExecutable: process.execPath, antigravityPluginDir: path.join(root, 'plugin-agy'), antigravityDataDir: path.join(root, 'agy-data') });
    await deploy({ ...options, dryRun: true });
    for (const [file, old] of before) assert.equal(await readFile(file, 'utf8'), JSON.stringify(old));
    await deploy(options);
    for (const [id, file] of Object.entries(files)) {
      const value = JSON.parse(await readFile(file, 'utf8'));
      const server = createPeerServer({ env: { AGENT_BRIDGE_SELF: id === 'claude' ? 'claude-code' : 'codex' }, config: normalizePeerConfig(value), startSweepTimer: false });
      t.after(() => server.close());
      const caps = await rpc(server, 'peer_capabilities', {});
      assert.equal(caps.peers.antigravity.modes.review.allowed, true);
      assert.equal(caps.peers.antigravity.webSearchControl, true);
      assert.equal(path.resolve(value.records.antigravityDataDir), config.antigravityDataDir);
      const originalFields = structuredClone(value);
      delete originalFields.peers.antigravity;
      delete originalFields.records.antigravityDataDir;
      assert.deepEqual(originalFields, before.get(file));
    }
    // Re-deployment preserves both an explicit opt-out and the operator's file formatting.
    const custom = JSON.parse(await readFile(files.codex, 'utf8'));
    custom.peers.antigravity.enabled = false;
    custom.peers.antigravity.readOnlyWebAgent = 'local-web';
    custom.records.antigravityDataDir = path.join(root, 'custom-data');
    await writeFile(files.codex, JSON.stringify(custom));
    await deploy(options);
    assert.equal(await readFile(files.codex, 'utf8'), JSON.stringify(custom));
  });
}

test('deploy-local.mjs deploys Antigravity plugin, 4th identity token, peer config, launcher and validates plugin', async (t) => {
  const sandbox = testDir(t, 'antigravity-deploy');
  const agyPluginDir = path.join(sandbox, 'agy-plugin');
  const agyDataDir = path.join(sandbox, 'agy-cli-data');
  const config = {
    deployRoot: path.join(sandbox, 'deploy'),
    nodePath: process.execPath,
    bridgeUrl: 'http://127.0.0.1:3080/mcp/codex-bridge-v1',
    codexPluginDir: path.join(sandbox, 'codex-plugin'),
    antigravityPluginDir: agyPluginDir,
    antigravityExecutable: process.execPath,
    antigravityDataDir: agyDataDir,
    identity: {
      credentialDirectory: path.join(sandbox, 'credentials'),
      migrationBackupDirectory: path.join(sandbox, 'backups'),
    },
  };

  // Dry run touches nothing
  const spawnCalls = [];
  const mockSpawn = (command, argv) => {
    spawnCalls.push({ command, argv });
    return { status: 0, stdout: '', stderr: '' };
  };
  await deploy({ config, packageRoot: REPO, dryRun: true, spawnImpl: mockSpawn, stdout: () => {}, stderr: () => {} });
  assert.equal(await exists(agyPluginDir), false);
  assert.equal(await exists(config.deployRoot), false);

  // Pre-seed unrelated custom MCP server to verify merge preserves it
  await mkdir(agyPluginDir, { recursive: true });
  await writeFile(path.join(agyPluginDir, 'mcp_config.json'), JSON.stringify({
    mcpServers: { user_custom: { command: 'custom-bin', args: [] } },
  }));

  await deploy({ config, packageRoot: REPO, spawnImpl: mockSpawn, stdout: () => {}, stderr: () => {} });

  const layout = identityLayout(config);
  assert.deepEqual(Object.keys(layout.tokenFiles).sort(), ['antigravity', 'claude', 'codex', 'operator']);
  assert.deepEqual(Object.keys(layout.peerFiles).sort(), ['antigravity', 'claude', 'codex']);
  assert.deepEqual(Object.keys(layout.launcherFiles).sort(), ['antigravity', 'claude', 'codex']);

  // Host fragments include antigravity and pass loadControllerRegistry
  const finalHost = JSON.parse(await readFile(layout.hostFiles.final, 'utf8'));
  assert.deepEqual(finalHost.controllers.map((c) => c.id), ['claude-code', 'codex', 'antigravity', 'operator']);
  loadControllerRegistry(finalHost.controllers);

  // Per-root peer configs share stateDir, have peers.antigravity with both readOnly agents, and validate
  const agyToken = (await readFile(layout.tokenFiles.antigravity, 'utf8')).trim();
  const agyPeerCfg = JSON.parse(await readFile(layout.peerFiles.antigravity, 'utf8'));
  assert.doesNotThrow(() => normalizePeerConfig(agyPeerCfg));
  assert.equal(agyPeerCfg.peers.antigravity.readOnlyAgent, 'agent-bridge-readonly');
  assert.equal(agyPeerCfg.peers.antigravity.readOnlyWebAgent, 'agent-bridge-readonly-web');
  assert.equal(path.resolve(agyPeerCfg.records.antigravityDataDir), path.resolve(agyDataDir));
  assert.equal(path.resolve(agyPeerCfg.bridge.credentialFile), path.resolve(layout.tokenFiles.antigravity));

  // Deployed native Antigravity plugin contents
  const deployedManifest = JSON.parse(await readFile(path.join(agyPluginDir, 'plugin.json'), 'utf8'));
  assert.equal(deployedManifest.name, 'agent-bridge');
  const deployedMcp = JSON.parse(await readFile(path.join(agyPluginDir, 'mcp_config.json'), 'utf8'));
  assert.deepEqual(Object.keys(deployedMcp.mcpServers).sort(), ['agent_peer', 'dsh_project', 'user_custom']);
  assert.equal(deployedMcp.mcpServers.agent_peer.env.AGENT_BRIDGE_SELF, 'antigravity');
  assert.equal(path.resolve(deployedMcp.mcpServers.agent_peer.env.AGENT_PEER_CONFIG), path.resolve(layout.peerFiles.antigravity));
  assert.equal(path.resolve(deployedMcp.mcpServers.dsh_project.env.DSH_BRIDGE_CREDENTIAL_FILE), path.resolve(layout.tokenFiles.antigravity));
  assert.equal(JSON.stringify(deployedMcp).includes(agyToken), false, 'token content must never appear in mcp_config.json');
  assert.equal(await exists(path.join(agyPluginDir, 'agents', 'agent-bridge-readonly.md')), true);
  assert.equal(await exists(path.join(agyPluginDir, 'agents', 'agent-bridge-readonly-web.md')), true);
  assert.equal(await exists(path.join(agyPluginDir, 'skills', 'agent-bridge-routing', 'SKILL.md')), true);

  // Launcher points to antigravity files without token bytes
  const launcher = await readFile(layout.launcherFiles.antigravity, 'utf8');
  assert.ok(launcher.includes(JSON.stringify(slash(layout.tokenFiles.antigravity))));
  assert.ok(launcher.includes(JSON.stringify(slash(layout.peerFiles.antigravity))));
  assert.equal(launcher.includes(agyToken), false);

  // Deploy invoked `agy plugin validate <agyPluginDir>`
  assert.ok(spawnCalls.some((call) => call.argv[0] === 'plugin' && call.argv[1] === 'validate' && call.argv[2] === agyPluginDir));
});
