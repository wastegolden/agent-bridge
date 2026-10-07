// test/peer-codex-threads.test.mjs
//
// Falsifiable tests for the Codex app-server thread-organisation client
// (contract agent-bridge-1.5.0-w2). Every test runs the fixture
// test/fixtures/fake-codex-app-server.mjs through the real child_process.spawn, exactly
// as the client spawns `<codex.exe> app-server`, and asserts on the JSON-RPC traffic the
// fixture recorded. No Codex install is touched.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PeerPolicyError } from '../src/peer/chain.mjs';
import { createCodexThreadClient } from '../src/peer/codex-threads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-codex-app-server.mjs');
const THREAD_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf319';
const PINNED_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const LATER_TWO_ID = '01984de2-8f74-7c91-a3b2-000000000003';
const FRESH_ID = '01984de2-8f74-7c91-a3b2-000000000004';

/** One temp dir, one log file, one client whose spawn runs the fixture under node. */
async function harness({ testEnv = {}, clientOptions = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-threads-'));
  const logPath = path.join(dir, 'app-server.log');
  const children = [];
  const spawnImpl = (command, args, options) => {
    const child = spawn(process.execPath, [FIXTURE, ...args], {
      ...options,
      env: { ...process.env, ...testEnv, FAKE_APP_SERVER_LOG: logPath },
    });
    children.push(child);
    return child;
  };
  const client = createCodexThreadClient({ executable: 'codex.exe', spawnImpl, ...clientOptions });
  return { dir, logPath, children, client, spawnImpl };
}

async function cleanup(h) {
  try {
    await h.client.close();
  } finally {
    for (const child of h.children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
    }
    await rm(h.dir, { recursive: true, force: true });
  }
}

async function readLog(logPath) {
  let text = '';
  try {
    text = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      // Only a torn trailing line is tolerated: the writer may still be mid-append.
      if (index === lines.length - 1) return null;
      throw error;
    }
  }).filter((entry) => entry !== null);
}

async function waitForEntry(logPath, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await readLog(logPath)).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no log entry matched within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const methodsOf = (entries) => entries.map((entry) => entry.method);

test('the child is spawned lazily and handshakes once for several calls', async () => {
  const h = await harness();
  try {
    assert.equal(h.children.length, 0, 'nothing is spawned before the first call');
    assert.equal(await h.client.ensureSection('Pinned'), PINNED_ID);
    assert.equal(await h.client.archive(THREAD_ID), true);
    assert.equal(await h.client.remove(THREAD_ID), true);

    const entries = await readLog(h.logPath);
    assert.deepEqual(methodsOf(entries), [
      'initialize',
      'initialized',
      'threadSection/list',
      'thread/archive',
      'thread/delete',
    ]);
    assert.deepEqual(entries[0].params, { clientInfo: { name: 'agent-bridge', title: 'agent-bridge', version: '1.5.0' } });
    assert.deepEqual(entries[1].params, {});
    assert.equal(h.children.length, 1);

    // organize() with nothing to rename or move is not work: no rpc, no process.
    assert.deepEqual(await h.client.organize(THREAD_ID), { renamed: false, sectionId: null });
    assert.equal(h.children.length, 1);
    assert.equal((await readLog(h.logPath)).length, 5);
  } finally {
    await cleanup(h);
  }
});

test('ensureSection follows every page, returns the exact existing section and creates a missing one once', async () => {
  const h = await harness({ testEnv: { FAKE_APP_SERVER_PAGES: '1', FAKE_APP_SERVER_SEED: 'Later One,Later Two' } });
  try {
    assert.equal(await h.client.ensureSection('Later Two'), LATER_TWO_ID);

    const lists = (await readLog(h.logPath)).filter((entry) => entry.method === 'threadSection/list');
    assert.equal(lists.length, 3, 'every page is walked');
    assert.deepEqual(lists.map((entry) => entry.params.cursor), [null, '1', '2']);
    assert.deepEqual(lists.map((entry) => entry.params.limit), [50, 50, 50]);

    // The resolved id is cached: a second lookup performs no rpc at all.
    assert.equal(await h.client.ensureSection('Later Two'), LATER_TWO_ID);
    assert.equal((await readLog(h.logPath)).filter((entry) => entry.method === 'threadSection/list').length, 3);
    assert.equal((await readLog(h.logPath)).some((entry) => entry.method === 'threadSection/create'), false);

    assert.equal(await h.client.ensureSection('Fresh Section'), FRESH_ID);
    const afterCreate = await readLog(h.logPath);
    const creates = afterCreate.filter((entry) => entry.method === 'threadSection/create');
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].params, { name: 'Fresh Section' });
    assert.equal(afterCreate.filter((entry) => entry.method === 'threadSection/list').length, 6, 'all pages are consulted before creating');

    assert.equal(await h.client.ensureSection('Fresh Section'), FRESH_ID);
    assert.equal((await readLog(h.logPath)).filter((entry) => entry.method === 'threadSection/create').length, 1, 'the created section is cached, so create never repeats');
  } finally {
    await cleanup(h);
  }
});

test('organize renames and moves with beforeThreadId null', async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.client.organize(THREAD_ID, { name: 'Renamed', sectionName: 'Pinned' }), {
      renamed: true,
      sectionId: PINNED_ID,
    });
    const entries = await readLog(h.logPath);
    const methods = methodsOf(entries);
    assert.ok(methods.indexOf('thread/name/set') < methods.indexOf('thread/section/move'), 'the rename is sent before the move');
    assert.deepEqual(entries.find((entry) => entry.method === 'thread/name/set').params, { threadId: THREAD_ID, name: 'Renamed' });
    assert.deepEqual(entries.find((entry) => entry.method === 'thread/section/move').params, {
      threadId: THREAD_ID,
      sectionId: PINNED_ID,
      beforeThreadId: null,
    });

    assert.deepEqual(await h.client.organize(THREAD_ID, { name: 'Again' }), { renamed: true, sectionId: null });
    assert.deepEqual(await h.client.organize(THREAD_ID, { sectionName: 'Pinned' }), { renamed: false, sectionId: PINNED_ID });
    assert.equal((await readLog(h.logPath)).filter((entry) => entry.method === 'thread/name/set').length, 2);
    assert.equal((await readLog(h.logPath)).filter((entry) => entry.method === 'thread/section/move').length, 2);
  } finally {
    await cleanup(h);
  }
});

test('archive and remove send thread/archive and thread/delete', async () => {
  const h = await harness();
  try {
    assert.equal(await h.client.archive(THREAD_ID), true);
    assert.equal(await h.client.remove(THREAD_ID), true);
    const entries = await readLog(h.logPath);
    assert.deepEqual(entries.find((entry) => entry.method === 'thread/archive').params, { threadId: THREAD_ID });
    assert.deepEqual(entries.find((entry) => entry.method === 'thread/delete').params, { threadId: THREAD_ID });
  } finally {
    await cleanup(h);
  }
});

test('an rpc error becomes PEER_CODEX_APP_SERVER with the rpcCode', async () => {
  const h = await harness({ testEnv: { FAKE_APP_SERVER_FAIL_METHOD: 'thread/archive' } });
  try {
    const error = await h.client.archive(THREAD_ID).catch((failure) => failure);
    assert.ok(error instanceof PeerPolicyError, `expected a PeerPolicyError, got ${error}`);
    assert.equal(error.code, 'PEER_CODEX_APP_SERVER');
    assert.equal(error.detail.method, 'thread/archive');
    assert.equal(error.detail.rpcCode, -32000);
    assert.match(error.message, /boom/);

    assert.equal(await h.client.ensureSection('Pinned'), PINNED_ID, 'only the failing request is lost, the child stays usable');
  } finally {
    await cleanup(h);
  }
});

test('a silent method rejects with PEER_CODEX_APP_SERVER_TIMEOUT', async () => {
  const h = await harness({
    testEnv: { FAKE_APP_SERVER_SILENT_METHOD: 'thread/delete' },
    clientOptions: { requestTimeoutMs: 500 },
  });
  try {
    const startedAt = Date.now();
    const error = await h.client.remove(THREAD_ID).catch((failure) => failure);
    assert.equal(error.code, 'PEER_CODEX_APP_SERVER_TIMEOUT');
    assert.equal(error.detail.method, 'thread/delete');
    assert.ok(Date.now() - startedAt >= 400, 'the timeout is actually waited out');
    assert.equal((await readLog(h.logPath)).some((entry) => entry.method === 'thread/delete'), true, 'the request was sent before the timeout');
  } finally {
    await cleanup(h);
  }
});

test('a server-to-client request is answered with -32601 and notifications are ignored', async () => {
  const h = await harness({ testEnv: { FAKE_APP_SERVER_PING: '1' } });
  try {
    assert.equal(await h.client.ensureSection('Pinned'), PINNED_ID, 'the notification did not disturb the call');
    const answered = await waitForEntry(h.logPath, (entry) => entry.clientResponse !== undefined);
    assert.deepEqual(answered.clientResponse, {
      id: 'srv-1',
      error: { code: -32601, message: 'not supported by agent-bridge' },
      result: null,
    });
  } finally {
    await cleanup(h);
  }
});

test('invalid threadId and names are refused before any spawn', async () => {
  const h = await harness();
  try {
    const invalidThreadIds = ['not-a-uuid', '', '01984de2-8f74-7c91-a3b2-5c5e937cf31', `${THREAD_ID}0`, null, 42];
    for (const threadId of invalidThreadIds) {
      await assert.rejects(h.client.archive(threadId), { code: 'PEER_ARGS_INVALID' });
      await assert.rejects(h.client.remove(threadId), { code: 'PEER_ARGS_INVALID' });
      await assert.rejects(h.client.organize(threadId, { name: 'ok' }), { code: 'PEER_ARGS_INVALID' });
    }
    await assert.rejects(h.client.organize(THREAD_ID, { name: '' }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.organize(THREAD_ID, { name: '   ' }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.organize(THREAD_ID, { name: 'x'.repeat(201) }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.organize(THREAD_ID, { name: 'bad\u0007name' }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.organize(THREAD_ID, { name: 'bad\nname' }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.organize(THREAD_ID, { name: 42 }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.organize(THREAD_ID, { sectionName: '' }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.organize(THREAD_ID, { sectionName: {} }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.ensureSection(''), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.ensureSection('   '), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.ensureSection('n'.repeat(201)), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.ensureSection('n\tname'), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(h.client.ensureSection(null), { code: 'PEER_ARGS_INVALID' });

    assert.equal(h.children.length, 0, 'no argument violation ever reaches spawn');

    // A valid call with nothing to do also starts nothing.
    assert.deepEqual(await h.client.organize(THREAD_ID), { renamed: false, sectionId: null });
    assert.equal(h.children.length, 0);
  } finally {
    await cleanup(h);
  }
});

test('a killed child is replaced and handshakes again on the next call', async () => {
  const h = await harness();
  try {
    assert.equal(await h.client.ensureSection('Pinned'), PINNED_ID);
    assert.equal(h.children.length, 1);
    const first = h.children[0];
    first.kill();
    await once(first, 'close');

    assert.equal(await h.client.archive(THREAD_ID), true, 'the next call respawns');
    assert.equal(h.children.length, 2);
    const entries = await readLog(h.logPath);
    assert.equal(entries.filter((entry) => entry.method === 'initialize').length, 2);
    assert.equal(entries.filter((entry) => entry.method === 'initialized').length, 2);
    assert.deepEqual(methodsOf(entries).slice(-3), ['initialize', 'initialized', 'thread/archive']);
  } finally {
    await cleanup(h);
  }
});

test('close() kills the child and every later call fails with PEER_CODEX_APP_SERVER', async () => {
  const h = await harness();
  try {
    assert.equal(await h.client.ensureSection('Pinned'), PINNED_ID);
    const child = h.children[0];
    await h.client.close();
    assert.equal(child.killed, true, 'close kills the running child');
    await h.client.close(); // idempotent

    await assert.rejects(h.client.ensureSection('Pinned'), { code: 'PEER_CODEX_APP_SERVER' });
    await assert.rejects(h.client.organize(THREAD_ID, { name: 'Later' }), { code: 'PEER_CODEX_APP_SERVER' });
    await assert.rejects(h.client.archive(THREAD_ID), { code: 'PEER_CODEX_APP_SERVER' });
    await assert.rejects(h.client.remove(THREAD_ID), { code: 'PEER_CODEX_APP_SERVER' });
    assert.equal(h.children.length, 1, 'a closed client never respawns');
  } finally {
    await cleanup(h);
  }
});
