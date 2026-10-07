// test/peer-records-tools.test.mjs
//
// Contract checks for the record/cleanup wiring of src/peer/server.mjs (contract
// agent-bridge-1.5.0-w3b3) plus the new configuration keys they depend on.
//
// The peer CLIs are the offline fixture (test/fixtures/fake-peer-cli.mjs) driven through
// the server's job-manager factory; the Codex app-server and the DSH bridge are in-memory
// fakes whose calls are observable. Project roots, git exclude files, records and the
// index are real temp-directory files, and the clock is injected, so every assertion here
// is about an observable call, an observable file or an index event — never about intent.
//
// Covered: a finished codex consult job is renamed and moved into its section; a read-only
// claude-code peer runs with --no-session-persistence and cannot be resumed; record_closeout
// writes the durable record and returns closedAt + retainDays; record_list lists it;
// cleanup_run plans without changing anything and then deletes the codex thread once the
// retention window arrives, recording the session as deleted; bridgeTaskIds without a
// bridge client (and a disabled records config) are refused; the new config keys validate
// and default. Every temp directory is removed in a finally block.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizePeerConfig } from '../src/peer/config.mjs';
import { createPeerJobs } from '../src/peer/jobs.mjs';
import { readIndex } from '../src/peer/records.mjs';
import { createPeerServer } from '../src/peer/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-peer-cli.mjs');
const ABS = process.platform === 'win32' ? 'C:\\peer-test' : '/peer-test';
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_AT = Date.parse('2025-06-01T10:00:00Z');
const CODEX_SESSION = '01a1119d-5fcc-7880-bfd6-0fb84f99c67f';
const CLAUDE_SESSION = 'a73c13c2-5006-4731-b1d3-93a817b735bc';

const fakeSpawn = (command, args, options) => spawn(process.execPath, [FAKE, ...args], options);

const rpc = async (server, name, args) => {
  const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (reply.error) return { protocolError: reply.error };
  if (reply.result.isError) return { error: JSON.parse(reply.result.content[0].text) };
  return reply.result.structuredContent;
};

/** A fake Codex app-server client factory that records every call of every client. */
function makeThreadsFactory() {
  const clients = [];
  const factory = () => {
    const calls = [];
    clients.push(calls);
    return {
      calls,
      async organize(threadId, options) {
        calls.push(['organize', threadId, options]);
        return { renamed: true, sectionId: 'sec-1' };
      },
      async archive(threadId) {
        calls.push(['archive', threadId]);
        return true;
      },
      async remove(threadId) {
        calls.push(['remove', threadId]);
        return true;
      },
      async close() {
        calls.push(['close']);
      },
    };
  };
  return { factory, clients, callsOf: () => clients.flat() };
}

/** A fake DSH bridge client covering the surface closeout and the sweeper use. */
function makeBridge({ dossiers = new Map(), texts = new Map() } = {}) {
  const calls = [];
  return {
    calls,
    dossiers,
    texts,
    async dossier(taskId) {
      calls.push(['dossier', taskId]);
      const dossier = dossiers.get(taskId);
      if (!dossier) throw new Error(`unknown bridge task ${taskId}`);
      return structuredClone(dossier);
    },
    async resultText(taskId) {
      calls.push(['resultText', taskId]);
      return texts.get(taskId) ?? '';
    },
    async archive(taskId, revision) {
      calls.push(['archive', taskId, revision]);
      return { taskId, archived: true };
    },
    async cleanup(taskId, options) {
      calls.push(['cleanup', taskId, options]);
      return { cleaned: true };
    },
  };
}

async function waitForCall(threads, method, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const call = threads.callsOf().find((entry) => entry[0] === method);
    if (call) return call;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the codex thread client to call ${method}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A real temp project (with a `.git` directory), a state directory, a claude projects
 * directory, the offline peer CLIs and an injected clock at CLOSED_AT. The job manager is
 * built BY THE SERVER (through jobsFactory) so its onSettled hook is the one under test.
 */
async function withPeer({ self = 'claude-code', bridgeClient = null, records = {}, codex = {}, threads = null, startSweepTimer = false } = {}, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peer-records-'));
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  const claudeProjects = path.join(root, 'claude-projects');
  await mkdir(path.join(project, '.git'), { recursive: true });
  await mkdir(claudeProjects, { recursive: true });
  const config = normalizePeerConfig({
    schemaVersion: 1,
    stateDir,
    peers: {
      codex: { executable: path.join(root, 'codex.exe'), ...codex },
      'claude-code': { executable: path.join(root, 'claude.exe') },
    },
    records: { claudeProjectsDir: claudeProjects, ...records },
  });
  let currentNow = CLOSED_AT;
  const now = () => currentNow;
  const server = createPeerServer({
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AGENT_BRIDGE_SELF: self },
    config,
    jobsFactory: (options) => createPeerJobs({ ...options, spawnImpl: fakeSpawn, shutdownGraceMs: 15_000 }),
    ...(threads ? { codexThreadsFactory: threads.factory } : {}),
    bridgeClient,
    now,
    startSweepTimer,
  });
  try {
    await fn({ server, project, stateDir, claudeProjects, root, config, setNow: (value) => { currentNow = value; } });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

test('peer config validates the records, bridge and codex thread keys and applies their defaults', () => {
  const defaults = normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: {} });
  assert.deepEqual({ ...defaults.records }, {
    enabled: true,
    dirName: '.agent-bridge/records',
    retainDays: 3,
    disputedRetainDays: 30,
    sweepIntervalMinutes: 60,
    claudeProjectsDir: path.join(os.homedir(), '.claude', 'projects'),
  });
  assert.equal(defaults.bridge, null);

  const threadDefaults = normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: { codex: { executable: path.join(ABS, 'codex.exe') } } });
  assert.equal(threadDefaults.peers.codex.threadSection, 'Agent Bridge');
  assert.equal(threadDefaults.peers.codex.threadNamePrefix, '[agent-bridge]');

  const explicit = normalizePeerConfig({
    schemaVersion: 1,
    stateDir: ABS,
    peers: { codex: { executable: path.join(ABS, 'codex.exe'), threadSection: null, threadNamePrefix: '[x]' } },
    records: { enabled: false, dirName: 'records-dir', retainDays: 5, disputedRetainDays: 11, sweepIntervalMinutes: 0, claudeProjectsDir: path.join(ABS, 'claude') },
    bridge: { url: 'http://127.0.0.1:3080/mcp', credentialFile: path.join(ABS, 'token') },
  });
  assert.deepEqual({ ...explicit.records }, {
    enabled: false,
    dirName: 'records-dir',
    retainDays: 5,
    disputedRetainDays: 11,
    sweepIntervalMinutes: 0,
    claudeProjectsDir: path.join(ABS, 'claude'),
  });
  assert.equal(explicit.peers.codex.threadSection, null);
  assert.equal(explicit.peers.codex.threadNamePrefix, '[x]');
  assert.deepEqual({ ...explicit.bridge }, { url: 'http://127.0.0.1:3080/mcp', credentialFile: path.join(ABS, 'token') });
  assert.equal(normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: {}, bridge: { url: 'http://localhost:4000' } }).bridge.credentialFile, null);

  const refuse = (raw) => assert.throws(
    () => normalizePeerConfig({ schemaVersion: 1, stateDir: ABS, peers: {}, ...raw }),
    { code: 'PEER_CONFIG_INVALID' },
    `expected a refusal for ${JSON.stringify(raw)}`,
  );
  refuse({ records: { dirName: '../escape' } });
  refuse({ records: { dirName: '..' } });
  refuse({ records: { dirName: path.join(ABS, 'records') } });
  refuse({ records: { dirName: '' } });
  refuse({ records: { enabled: 'yes' } });
  refuse({ records: { retainDays: 0 } });
  refuse({ records: { disputedRetainDays: -3 } });
  refuse({ records: { sweepIntervalMinutes: -1 } });
  refuse({ records: { sweepIntervalMinutes: 1.5 } });
  refuse({ records: { claudeProjectsDir: 'relative/projects' } });
  refuse({ records: { nope: 1 } });
  refuse({ records: 5 });
  refuse({ bridge: { url: 'https://127.0.0.1:3080/mcp' } });
  refuse({ bridge: { url: 'http://example.com:3080' } });
  refuse({ bridge: {} });
  refuse({ bridge: { url: 'not a url' } });
  refuse({ bridge: { url: 'http://localhost:1', credentialFile: 'relative/token' } });
  refuse({ bridge: { url: 'http://localhost:1', nope: 1 } });
  refuse({ peers: { codex: { executable: path.join(ABS, 'codex.exe'), threadSection: 42 } } });
  refuse({ peers: { codex: { executable: path.join(ABS, 'codex.exe'), threadSection: '   ' } } });
  refuse({ peers: { codex: { executable: path.join(ABS, 'codex.exe'), threadNamePrefix: 'x'.repeat(41) } } });
  refuse({ nope: true });
});

// ---------------------------------------------------------------------------
// codex thread organisation after a job settles
// ---------------------------------------------------------------------------

test('a finished codex consult job is renamed and moved into its section through the injected client', async () => {
  const threads = makeThreadsFactory();
  await withPeer({ threads }, async ({ server, project }) => {
    const asked = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'What is 2+2?', cwd: project, waitMs: 20_000, title: 'Arithmetic', rootTask: 'demo-1' });
    assert.equal(asked.job.status, 'completed', JSON.stringify(asked));
    assert.equal(asked.job.sessionId, CODEX_SESSION);

    const organize = await waitForCall(threads, 'organize');
    assert.deepEqual(organize, ['organize', CODEX_SESSION, { name: '[agent-bridge] consult · Arithmetic', sectionName: 'Agent Bridge' }]);
    await waitForCall(threads, 'close');
    assert.ok(threads.callsOf().every((call) => call[0] !== 'archive' && call[0] !== 'remove'), 'settling a job never deletes a thread');
  });
});

test('the thread section and the name prefix are configurable and null disables grouping', async () => {
  const configured = makeThreadsFactory();
  await withPeer({ threads: configured, codex: { threadSection: 'Reviews', threadNamePrefix: '[r]' } }, async ({ server, project }) => {
    const asked = await rpc(server, 'peer_ask', { target: 'codex', mode: 'review', prompt: 'review this', cwd: project, waitMs: 20_000, rootTask: 'demo-2' });
    assert.equal(asked.job.status, 'completed', JSON.stringify(asked));
    const organize = await waitForCall(configured, 'organize');
    assert.deepEqual(organize, ['organize', CODEX_SESSION, { name: '[r] review · demo-2', sectionName: 'Reviews' }]);
  });

  const disabled = makeThreadsFactory();
  await withPeer({ threads: disabled, codex: { threadSection: null } }, async ({ server, project }) => {
    const asked = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'hi', cwd: project, waitMs: 20_000, rootTask: 'demo-3' });
    assert.equal(asked.job.status, 'completed', JSON.stringify(asked));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(disabled.callsOf(), [], 'threadSection null never opens a client');
  });
});

// ---------------------------------------------------------------------------
// record_closeout, record_list, cleanup_run
// ---------------------------------------------------------------------------

test('record_closeout writes the record, record_list shows it and cleanup_run sweeps it after the window', async () => {
  const threads = makeThreadsFactory();
  const bridge = makeBridge();
  await withPeer({ threads, bridgeClient: bridge }, async ({ server, project, stateDir, setNow }) => {
    const asked = await rpc(server, 'peer_ask', { target: 'codex', mode: 'consult', prompt: 'What is 2+2?', cwd: project, waitMs: 20_000, title: 'Arithmetic', rootTask: 'demo-1' });
    assert.equal(asked.job.status, 'completed', JSON.stringify(asked));
    await waitForCall(threads, 'organize');

    const closed = await rpc(server, 'record_closeout', {
      title: 'Task one',
      outcome: 'accepted',
      conclusion: 'Everything passed.',
      peerJobIds: [asked.job.jobId],
      rootTask: 'demo-1',
    });
    assert.equal(closed.reused, false);
    assert.match(closed.recordId, /^[0-9a-f]{16}$/);
    assert.equal(closed.eligibleAt, CLOSED_AT + 3 * DAY_MS, 'accepted work is retained 3 days');

    const recordsDir = path.join(project, '.agent-bridge', 'records');
    assert.equal(path.dirname(closed.path), recordsDir);
    assert.deepEqual(await readdir(recordsDir), [path.basename(closed.path)]);
    const content = await readFile(closed.path, 'utf8');
    assert.ok(content.includes('# Task one'));
    assert.ok(content.includes('Everything passed.'));
    assert.ok(content.includes(CODEX_SESSION));
    assert.ok((await readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8')).split('\n').includes('/.agent-bridge/'));

    const listed = await rpc(server, 'record_list', {});
    assert.deepEqual(listed.records, [{
      recordId: closed.recordId,
      title: 'Task one',
      rootTask: 'demo-1',
      path: closed.path,
      outcome: 'accepted',
      keep: false,
      closedAt: CLOSED_AT,
      eligibleAt: CLOSED_AT + 3 * DAY_MS,
      sessions: [{ harness: 'codex', id: CODEX_SESSION, state: 'pending' }],
    }]);
    assert.deepEqual((await rpc(server, 'record_list', { limit: 1 })).records.length, 1);

    // Before the window: nothing is due, nothing is planned, nothing changes.
    const early = await rpc(server, 'cleanup_run', {});
    assert.equal(early.dryRun, true);
    assert.equal(early.due, 0);
    assert.deepEqual(early.actions, []);

    setNow(CLOSED_AT + 4 * DAY_MS);
    const before = await readFile(closed.path, 'utf8');
    const clientsBefore = threads.clients.length;
    const planned = await rpc(server, 'cleanup_run', {});
    assert.equal(planned.dryRun, true);
    assert.equal(planned.checked, 1);
    assert.equal(planned.due, 1);
    assert.deepEqual(planned.actions.map((action) => [action.harness, action.action, action.state]), [['codex', 'delete', 'planned']]);
    assert.equal(threads.clients.length, clientsBefore + 1, 'cleanup_run uses one injected client');
    const sweepCalls = threads.clients.at(-1);
    assert.deepEqual(sweepCalls, [['close']], 'dryRun calls no action and closes the client it created');
    assert.equal(await readFile(closed.path, 'utf8'), before, 'dryRun writes nothing');
    assert.equal((await readIndex(stateDir)).get(closed.recordId).sessions.get(`codex\u0000${CODEX_SESSION}`).state, 'pending');

    const applied = await rpc(server, 'cleanup_run', { dryRun: false });
    assert.equal(applied.dryRun, false);
    assert.deepEqual(applied.actions.map((action) => [action.harness, action.action, action.state]), [['codex', 'delete', 'deleted']]);
    assert.deepEqual(threads.clients.at(-1), [['archive', CODEX_SESSION], ['remove', CODEX_SESSION], ['close']], 'the sweep archives, removes and closes');
    assert.deepEqual(
      threads.callsOf().filter((call) => call[0] === 'archive' || call[0] === 'remove'),
      [['archive', CODEX_SESSION], ['remove', CODEX_SESSION]],
    );
    assert.equal((await readIndex(stateDir)).get(closed.recordId).sessions.get(`codex\u0000${CODEX_SESSION}`).state, 'deleted');
    assert.equal(await readFile(closed.path, 'utf8'), before, 'the durable record survives the sweep');
    assert.deepEqual((await rpc(server, 'record_list', {})).records[0].sessions, [{ harness: 'codex', id: CODEX_SESSION, state: 'deleted' }]);

    const again = await rpc(server, 'cleanup_run', { dryRun: false });
    assert.deepEqual(again.actions, [], 'a deleted session is final');
  });
});

test('record_closeout reads a bridge task through the injected bridge client and record_list sorts newest first', async () => {
  const bridge = makeBridge();
  await withPeer({ bridgeClient: bridge }, async ({ server, project, setNow }) => {
    bridge.dossiers.set('t-1', {
      taskId: 't-1',
      title: 'DSH task',
      role: 'implement',
      status: 'completed',
      revision: 4,
      sessionId: 'sess-dsh-1',
      workspace: { repository: project },
      request: { cwd: project },
      acknowledgement: { resultCollected: true, accepted: true, artifactState: 'merged' },
    });
    bridge.texts.set('t-1', 'RESULT: shipped with evidence.');

    const closed = await rpc(server, 'record_closeout', { title: 'Bridge task', outcome: 'accepted', conclusion: 'Shipped.', bridgeTaskIds: ['t-1'] });
    assert.equal(closed.reused, false);
    assert.equal(closed.eligibleAt, CLOSED_AT + 3 * DAY_MS);
    assert.deepEqual(bridge.calls, [['dossier', 't-1'], ['resultText', 't-1']]);
    assert.deepEqual(closed.sessions, [{ harness: 'dsh', id: 'sess-dsh-1', source: 't-1', revision: 4 }]);
    assert.equal(path.dirname(closed.path), path.join(project, '.agent-bridge', 'records'));
    const content = await readFile(closed.path, 'utf8');
    assert.ok(content.includes('RESULT: shipped with evidence.'));
    assert.deepEqual((await rpc(server, 'record_list', {})).records[0].sessions, [{ harness: 'dsh', id: 'sess-dsh-1', state: 'pending' }]);

    // A later closeout is listed first: newest by closedAt.
    setNow(CLOSED_AT + DAY_MS);
    bridge.dossiers.set('t-2', {
      taskId: 't-2',
      title: 'Later DSH task',
      role: 'implement',
      status: 'completed',
      revision: 1,
      sessionId: 'sess-dsh-2',
      workspace: { repository: project },
      request: { cwd: project },
      acknowledgement: { resultCollected: true, accepted: true, artifactState: 'merged' },
    });
    bridge.texts.set('t-2', 'SECOND RESULT');
    const later = await rpc(server, 'record_closeout', { title: 'Later task', outcome: 'accepted', conclusion: 'Later.', bridgeTaskIds: ['t-2'] });
    const list = await rpc(server, 'record_list', {});
    assert.deepEqual(list.records.map((record) => record.recordId), [later.recordId, closed.recordId]);
    assert.deepEqual(list.records.map((record) => record.title), ['Later task', 'Bridge task']);
    assert.deepEqual(list.records.map((record) => record.closedAt), [CLOSED_AT + DAY_MS, CLOSED_AT]);
  });
});

test('record_closeout is refused without a bridge client for bridgeTaskIds and when records are disabled', async () => {
  await withPeer({ bridgeClient: null }, async ({ server }) => {
    const refused = await rpc(server, 'record_closeout', { title: 'Task one', outcome: 'accepted', conclusion: 'x', bridgeTaskIds: ['t-1'] });
    assert.equal(refused.error.code, 'PEER_NOT_CONFIGURED');
    assert.equal(refused.error.details.field, 'bridgeTaskIds');
  });

  await withPeer({ records: { enabled: false } }, async ({ server }) => {
    const refused = await rpc(server, 'record_closeout', { title: 'Task one', outcome: 'accepted', conclusion: 'x', peerJobIds: ['peer-1750000000000-aaaaaaa1'] });
    assert.equal(refused.error.code, 'PEER_NOT_CONFIGURED');
    assert.equal(refused.error.details.field, 'records');
  });
});

// ---------------------------------------------------------------------------
// read-only claude-code peers
// ---------------------------------------------------------------------------

test('a read-only claude-code peer runs with --no-session-persistence and cannot be resumed', async () => {
  await withPeer({ self: 'codex' }, async ({ server, project }) => {
    const asked = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'consult', prompt: 'hello', cwd: project, waitMs: 20_000, rootTask: 'demo-1' });
    assert.equal(asked.job.status, 'completed', JSON.stringify(asked));
    assert.equal(asked.job.readOnly, true);
    assert.equal(asked.job.sessionId, CLAUDE_SESSION);

    const result = await rpc(server, 'peer_result', { jobId: asked.job.jobId });
    const echo = JSON.parse(result.finalMessage.replace(/^CLAUDE-ECHO /, ''));
    assert.deepEqual(echo.argv.slice(0, 4), ['-p', '--output-format', 'json', '--no-session-persistence']);

    const refused = await rpc(server, 'peer_ask', { target: 'claude-code', mode: 'review', prompt: 'again', cwd: project, sessionId: asked.job.sessionId, rootTask: 'demo-1' });
    assert.equal(refused.error.code, 'PEER_SESSION_NOT_RESUMABLE');
    assert.equal(refused.error.details.field, 'sessionId');
    assert.equal((await rpc(server, 'peer_list', {})).jobs.length, 1, 'the refused resume started no second job');
  });
});

// ---------------------------------------------------------------------------
// new tool surface and argument validation
// ---------------------------------------------------------------------------

test('the record tools are advertised in the catalog and validate their arguments', async () => {
  await withPeer({}, async ({ server }) => {
    assert.deepEqual(server.tools.map((tool) => tool.name), ['peer_capabilities', 'peer_ask', 'peer_check', 'peer_result', 'peer_cancel', 'peer_list', 'record_closeout', 'record_list', 'cleanup_run']);
    const closeout = server.tools.find((tool) => tool.name === 'record_closeout');
    assert.deepEqual(closeout.inputSchema.required, ['title', 'outcome', 'conclusion']);
    assert.deepEqual(closeout.inputSchema.properties.outcome.enum, ['accepted', 'failed', 'disputed', 'unresolved']);

    assert.equal((await rpc(server, 'record_closeout', { title: 'T', outcome: 'accepted' })).protocolError.code, -32602);
    assert.equal((await rpc(server, 'record_closeout', { title: 'T', outcome: 'maybe', conclusion: 'C' })).protocolError.code, -32602);
    assert.equal((await rpc(server, 'record_closeout', { title: 'T', outcome: 'accepted', conclusion: 'C', findings: ['nope'] })).protocolError.code, -32602);
    assert.equal((await rpc(server, 'record_closeout', { title: 'T', outcome: 'accepted', conclusion: 'C', peerJobIds: ['not-a-job-id'] })).protocolError.code, -32602);
    assert.equal((await rpc(server, 'cleanup_run', { dryRun: 'yes' })).protocolError.code, -32602);
    assert.equal((await rpc(server, 'record_list', { limit: 0 })).protocolError.code, -32602);
    // An array of plain objects passes the coarse schema and reaches the module's own
    // validation, which refuses a closeout with nothing to close out.
    const reached = await rpc(server, 'record_closeout', { title: 'T', outcome: 'accepted', conclusion: 'C', findings: [{ id: 'F1', raisedBy: ['codex'], verdict: 'confirmed' }] });
    assert.equal(reached.error.code, 'PEER_ARGS_INVALID');
    assert.equal(reached.error.details.field, 'input');
  });
});
