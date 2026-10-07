// test/peer-sweeper.test.mjs
//
// Contract checks for src/peer/sweeper.mjs (contract agent-bridge-1.5.0-w3b2).
//
// The fake `codexThreads` and `bridge` objects record their calls, so every assertion here is
// about an observable call, an observable file or an index event — never about intent. The
// claude-code cases use real temporary project directories; the "never touch" case injects a
// `readdir` that throws, so a filesystem access would fail the test instead of hiding.
//
// Every temp directory is removed in a finally block (withTempDir).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appendIndexEvent, readIndex } from '../src/peer/records.mjs';
import { sweepRecords } from '../src/peer/sweeper.mjs';

const CODEX_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const CLAUDE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLAUDE_ID_2 = '11111111-2222-4333-8444-555555555555';
const MISSING_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const AMBIG_ID = 'cccccccc-1111-4222-8333-444444444444';
const DIR_ONLY_ID = 'dddddddd-1111-4222-8333-444444444444';
const NESTED_ID = 'eeeeeeee-1111-4222-8333-444444444444';

const NOW = 1_700_000_000_000;
const INDEX_FILE_NAME = 'records-index.jsonl';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peer-sweeper-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function indexFileOf(stateDir) {
  return path.join(stateDir, INDEX_FILE_NAME);
}

async function readIndexText(stateDir) {
  try {
    return await readFile(indexFileOf(stateDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function makeStateDir(root) {
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  return stateDir;
}

async function addRecord(stateDir, recordPath, { recordId, eligibleAt, keep = false, sessions }) {
  await appendIndexEvent(stateDir, {
    kind: 'record',
    recordId,
    rootTask: `root-${recordId}`,
    title: recordId,
    projectRoot: path.dirname(recordPath),
    path: recordPath,
    sha256: 'c0ffee',
    outcome: 'accepted',
    keep,
    closedAt: NOW - 10_000,
    eligibleAt,
    sessions,
  });
}

/** A codex client whose calls are observable; close() must never be reached by the sweeper. */
function fakeCodex({ failRemove = 0 } = {}) {
  const calls = [];
  let failuresLeft = failRemove;
  return {
    calls,
    async archive(id) {
      calls.push(['archive', id]);
    },
    async remove(id) {
      calls.push(['remove', id]);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const error = new Error('thread/delete failed');
        error.code = 'PEER_CODEX_APP_SERVER';
        throw error;
      }
    },
    async close() {
      calls.push(['close']);
    },
  };
}

function fakeBridge({ archiveError = null, cleanupError = null } = {}) {
  const calls = [];
  return {
    calls,
    async archive(source, revision) {
      calls.push(['archive', source, revision]);
      if (archiveError) throw archiveError;
      return { taskId: source, archived: true, uiHidden: true };
    },
    async cleanup(source, options) {
      calls.push(['cleanup', source, options]);
      if (cleanupError) throw cleanupError;
      return { cleaned: true };
    },
  };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Create `<projects>/<project>/<id>.jsonl` (and optionally the sibling `<id>/` directory). */
async function writeClaudeSession(projects, project, id, { siblingDir = false } = {}) {
  const dir = path.join(projects, project);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.jsonl`), '{"session":true}\n', 'utf8');
  if (siblingDir) {
    const sibling = path.join(dir, id);
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, 'part.jsonl'), '{"part":true}\n', 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// dryRun
// ---------------------------------------------------------------------------

test('sweepRecords: dryRun plans every session and writes nothing', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'due.md');
    await writeFile(recordPath, '# due\n', 'utf8');
    await addRecord(stateDir, recordPath, {
      recordId: 'r-due',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'codex', id: CODEX_ID, source: 'task-codex' },
        { harness: 'dsh', id: 'sess-1', source: 'task-dsh', revision: 4 },
      ],
    });
    const before = await readIndexText(stateDir);
    const codex = fakeCodex();
    const bridge = fakeBridge();

    const report = await sweepRecords({
      stateDir,
      now: () => NOW,
      dryRun: true,
      codexThreads: codex,
      bridge,
      claudeProjectsDir: path.join(root, 'projects'),
    });

    assert.equal(report.dryRun, true);
    assert.equal(report.checked, 1);
    assert.equal(report.due, 1);
    assert.deepEqual(report.actions.map((action) => action.state), ['planned', 'planned']);
    assert.deepEqual(report.actions.map((action) => action.action), ['delete', 'archive']);
    assert.equal(report.actions[0].recordId, 'r-due');
    assert.equal(report.actions[0].harness, 'codex');
    assert.equal(report.actions[0].id, CODEX_ID);
    assert.deepEqual(codex.calls, []);
    assert.deepEqual(bridge.calls, []);
    assert.equal(await readIndexText(stateDir), before);
  });
});

// ---------------------------------------------------------------------------
// Eager vs. kept records
// ---------------------------------------------------------------------------

test('sweepRecords: a not-yet-due record and a keep record are never touched', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const soonPath = path.join(root, 'soon.md');
    const keptPath = path.join(root, 'kept.md');
    await writeFile(soonPath, '# soon\n', 'utf8');
    await writeFile(keptPath, '# kept\n', 'utf8');
    await addRecord(stateDir, soonPath, {
      recordId: 'r-soon',
      eligibleAt: NOW + 60_000,
      sessions: [{ harness: 'codex', id: CODEX_ID, source: 'task-soon' }],
    });
    await addRecord(stateDir, keptPath, {
      recordId: 'r-keep',
      eligibleAt: NOW - 1,
      keep: true,
      sessions: [{ harness: 'codex', id: CODEX_ID, source: 'task-keep' }],
    });
    const codex = fakeCodex();

    const report = await sweepRecords({ stateDir, now: () => NOW, dryRun: false, codexThreads: codex });

    assert.equal(report.checked, 2);
    assert.equal(report.due, 0);
    assert.deepEqual(report.actions, []);
    assert.deepEqual(codex.calls, []);
  });
});

// ---------------------------------------------------------------------------
// One due record, all three harnesses
// ---------------------------------------------------------------------------

test('sweepRecords: a due record deletes codex, deletes claude-code (file and sibling dir) and archives dsh', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'rec.md');
    await writeFile(recordPath, '# rec\n', 'utf8');
    const projects = path.join(root, 'projects');
    const claudeDir = await writeClaudeSession(projects, 'proj-a', CLAUDE_ID, { siblingDir: true });
    // A session that is NOT in the index, in the same directory as the one that is.
    await writeClaudeSession(projects, 'proj-a', CLAUDE_ID_2, { siblingDir: false });
    await mkdir(path.join(claudeDir, CLAUDE_ID_2), { recursive: true });
    await writeFile(path.join(claudeDir, CLAUDE_ID_2, 'keep.jsonl'), '{"keep":true}\n', 'utf8');
    // ...and a jsonl that is not inside any immediate project subdirectory.
    await writeFile(path.join(projects, `${CLAUDE_ID_2}.jsonl`), '{"loose":true}\n', 'utf8');

    await addRecord(stateDir, recordPath, {
      recordId: 'r-full',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'codex', id: CODEX_ID, source: 'task-codex' },
        { harness: 'claude-code', id: CLAUDE_ID, source: 'task-claude' },
        { harness: 'dsh', id: 'sess-dsh', source: 'task-dsh', revision: 7 },
      ],
    });
    const codex = fakeCodex();
    const bridge = fakeBridge();

    const report = await sweepRecords({
      stateDir,
      now: () => NOW,
      dryRun: false,
      codexThreads: codex,
      bridge,
      claudeProjectsDir: projects,
    });

    assert.equal(report.dryRun, false);
    assert.equal(report.checked, 1);
    assert.equal(report.due, 1);
    assert.deepEqual(
      report.actions.map((action) => [action.recordId, action.harness, action.action, action.state]),
      [
        ['r-full', 'codex', 'delete', 'deleted'],
        ['r-full', 'claude-code', 'delete', 'deleted'],
        ['r-full', 'dsh', 'archive', 'archived'],
      ],
    );
    // codex: archive then remove, and the caller's client is never closed by the sweeper.
    assert.deepEqual(codex.calls, [['archive', CODEX_ID], ['remove', CODEX_ID]]);
    // claude-code: the listed jsonl and its sibling directory are gone...
    assert.equal(await exists(path.join(claudeDir, `${CLAUDE_ID}.jsonl`)), false);
    assert.equal(await exists(path.join(claudeDir, CLAUDE_ID)), false);
    // ...while every file the index does not name survives.
    assert.equal(await exists(path.join(claudeDir, `${CLAUDE_ID_2}.jsonl`)), true);
    assert.equal(await exists(path.join(claudeDir, CLAUDE_ID_2, 'keep.jsonl')), true);
    assert.equal(await exists(path.join(projects, `${CLAUDE_ID_2}.jsonl`)), true);
    // dsh: archive with the indexed revision, then cleanup with dryRun false.
    assert.deepEqual(bridge.calls, [
      ['archive', 'task-dsh', 7],
      ['cleanup', 'task-dsh', { dryRun: false }],
    ]);
    assert.ok(report.actions[2].note.includes('cleaned'), `cleanup note was ${report.actions[2].note}`);

    // Each finished action is recorded immediately as one session event.
    const index = await readIndex(stateDir);
    const record = index.get('r-full');
    assert.equal(record.sessions.get(`codex\u0000${CODEX_ID}`).state, 'deleted');
    assert.equal(record.sessions.get(`claude-code\u0000${CLAUDE_ID}`).state, 'deleted');
    assert.equal(record.sessions.get('dsh\u0000sess-dsh').state, 'archived');
    const lines = (await readIndexText(stateDir)).split('\n').filter((line) => line.trim() !== '');
    assert.equal(lines.length, 4, 'one record event plus one event per finished action');
    assert.deepEqual(JSON.parse(lines[1]).state, 'deleted');
    assert.deepEqual(JSON.parse(lines[2]).state, 'deleted');
    assert.deepEqual(JSON.parse(lines[3]).state, 'archived');
  });
});

// ---------------------------------------------------------------------------
// Final states
// ---------------------------------------------------------------------------

test('sweepRecords: final states are never re-processed on a second sweep', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'rec.md');
    await writeFile(recordPath, '# rec\n', 'utf8');
    const projects = path.join(root, 'projects');
    await mkdir(projects, { recursive: true });
    await addRecord(stateDir, recordPath, {
      recordId: 'r-final',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'codex', id: CODEX_ID, source: 'task-codex' },
        { harness: 'claude-code', id: MISSING_ID, source: 'task-claude' },
      ],
    });
    const codex = fakeCodex();
    const bridge = fakeBridge();
    const options = {
      stateDir,
      now: () => NOW,
      dryRun: false,
      codexThreads: codex,
      bridge,
      claudeProjectsDir: projects,
    };

    const first = await sweepRecords(options);
    assert.deepEqual(first.actions.map((action) => action.state), ['deleted', 'skipped']);
    assert.equal(first.actions[1].note, 'session file not found');
    const callsAfterFirst = codex.calls.slice();

    const second = await sweepRecords(options);
    assert.equal(second.checked, 1);
    assert.equal(second.due, 1);
    assert.deepEqual(second.actions, []);
    assert.deepEqual(codex.calls, callsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Retry limit
// ---------------------------------------------------------------------------

test('sweepRecords: a failing action is retried until maxAttempts failure events exist', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'rec.md');
    await writeFile(recordPath, '# rec\n', 'utf8');
    await addRecord(stateDir, recordPath, {
      recordId: 'r-retry',
      eligibleAt: NOW - 1,
      sessions: [{ harness: 'codex', id: CODEX_ID, source: 'task-codex' }],
    });
    const codex = fakeCodex({ failRemove: 99 });
    const options = { stateDir, now: () => NOW, dryRun: false, codexThreads: codex, maxAttempts: 3 };

    const reports = [];
    for (let attempt = 0; attempt < 4; attempt += 1) reports.push(await sweepRecords(options));

    assert.deepEqual(reports.map((report) => report.actions.length), [1, 1, 1, 0]);
    assert.deepEqual(
      reports.slice(0, 3).map((report) => report.actions[0].state),
      ['failed', 'failed', 'failed'],
    );
    for (const report of reports.slice(0, 3)) {
      assert.match(report.actions[0].note, /^PEER_CODEX_APP_SERVER: /);
    }
    // The archive half succeeded every time and the delete half was retried exactly 3 times.
    assert.equal(codex.calls.filter((call) => call[0] === 'archive').length, 3);
    assert.equal(codex.calls.filter((call) => call[0] === 'remove').length, 3);

    const failedEvents = (await readIndexText(stateDir))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
      .filter((event) => event.kind === 'session' && event.state === 'failed');
    assert.equal(failedEvents.length, 3);
    assert.equal(failedEvents.every((event) => event.recordId === 'r-retry' && event.id === CODEX_ID), true);
  });
});

// ---------------------------------------------------------------------------
// Missing record file
// ---------------------------------------------------------------------------

test('sweepRecords: a due record whose record file is missing is never cleaned', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'gone.md'); // deliberately never created
    await addRecord(stateDir, recordPath, {
      recordId: 'r-gone',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'codex', id: CODEX_ID, source: 'task-codex' },
        { harness: 'dsh', id: 'sess-1', source: 'task-dsh', revision: 2 },
      ],
    });
    const codex = fakeCodex();
    const bridge = fakeBridge();
    const expected = [
      ['skip', 'skipped', 'record file missing'],
      ['skip', 'skipped', 'record file missing'],
    ];

    const before = await readIndexText(stateDir);
    const preview = await sweepRecords({ stateDir, now: () => NOW, dryRun: true, codexThreads: codex, bridge });
    assert.deepEqual(
      preview.actions.map((action) => [action.action, action.state, action.note]),
      expected,
    );
    assert.equal(await readIndexText(stateDir), before, 'dryRun writes nothing');

    const report = await sweepRecords({ stateDir, now: () => NOW, dryRun: false, codexThreads: codex, bridge });
    assert.equal(report.due, 1);
    assert.deepEqual(
      report.actions.map((action) => [action.action, action.state, action.note]),
      expected,
    );
    assert.deepEqual(codex.calls, []);
    assert.deepEqual(bridge.calls, []);

    const index = await readIndex(stateDir);
    const record = index.get('r-gone');
    assert.equal(record.sessions.get(`codex\u0000${CODEX_ID}`).state, 'skipped');
    assert.equal(record.sessions.get('dsh\u0000sess-1').state, 'skipped');

    // 'skipped' is final: restoring the record file does not resurrect the sessions.
    await writeFile(recordPath, '# restored\n', 'utf8');
    const later = await sweepRecords({ stateDir, now: () => NOW, dryRun: false, codexThreads: codex, bridge });
    assert.deepEqual(later.actions, []);
    assert.deepEqual(codex.calls, []);
    assert.deepEqual(bridge.calls, []);
  });
});

// ---------------------------------------------------------------------------
// claude-code edge cases
// ---------------------------------------------------------------------------

test('sweepRecords: missing, ambiguous, directory-only and nested claude sessions are never deleted', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'rec.md');
    await writeFile(recordPath, '# rec\n', 'utf8');
    const projects = path.join(root, 'projects');
    // ambiguous: the same session id in two different project subdirectories
    await writeClaudeSession(projects, 'proj-a', AMBIG_ID);
    await writeClaudeSession(projects, 'proj-b', AMBIG_ID);
    // a DIRECTORY named `<id>.jsonl` is not a session file
    const projA = path.join(projects, 'proj-a');
    await mkdir(path.join(projA, `${DIR_ONLY_ID}.jsonl`), { recursive: true });
    // a session file one level deeper than the immediate project subdirectories
    await mkdir(path.join(projA, 'nested'), { recursive: true });
    await writeFile(path.join(projA, 'nested', `${NESTED_ID}.jsonl`), '{"deep":true}\n', 'utf8');

    await addRecord(stateDir, recordPath, {
      recordId: 'r-claude',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'claude-code', id: MISSING_ID, source: 'task-missing' },
        { harness: 'claude-code', id: AMBIG_ID, source: 'task-ambiguous' },
        { harness: 'claude-code', id: DIR_ONLY_ID, source: 'task-dir-only' },
        { harness: 'claude-code', id: NESTED_ID, source: 'task-nested' },
      ],
    });

    const report = await sweepRecords({
      stateDir,
      now: () => NOW,
      dryRun: false,
      claudeProjectsDir: projects,
    });

    assert.deepEqual(
      report.actions.map((action) => [action.action, action.state, action.note]),
      [
        ['delete', 'skipped', 'session file not found'],
        ['delete', 'failed', 'ambiguous'],
        ['delete', 'skipped', 'session file not found'],
        ['delete', 'skipped', 'session file not found'],
      ],
    );
    // nothing was removed
    assert.equal(await exists(path.join(projects, 'proj-a', `${AMBIG_ID}.jsonl`)), true);
    assert.equal(await exists(path.join(projects, 'proj-b', `${AMBIG_ID}.jsonl`)), true);
    assert.equal(await exists(path.join(projA, `${DIR_ONLY_ID}.jsonl`)), true);
    assert.equal(await exists(path.join(projA, 'nested', `${NESTED_ID}.jsonl`)), true);

    const index = await readIndex(stateDir);
    const record = index.get('r-claude');
    assert.equal(record.sessions.get(`claude-code\u0000${AMBIG_ID}`).state, 'failed');
    assert.equal(record.sessions.get(`claude-code\u0000${MISSING_ID}`).state, 'skipped');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('sweepRecords: invalid ids are refused before any client or filesystem call', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'rec.md');
    await writeFile(recordPath, '# rec\n', 'utf8');
    const projects = path.join(root, 'projects');
    await mkdir(projects, { recursive: true });
    await addRecord(stateDir, recordPath, {
      recordId: 'r-bad',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'codex', id: 'not-a-uuid', source: 'task-codex' },
        { harness: 'claude-code', id: '../../escape', source: 'task-claude' },
        { harness: 'dsh', id: 'sess-1', source: 'C:\\tasks\\t-1', revision: 1 },
        { harness: 'dsh', id: 'sess-2', source: '   ', revision: 1 },
      ],
    });
    const codex = fakeCodex();
    const bridge = fakeBridge();
    let readdirCalls = 0;
    const fsImpl = {
      readdir: async () => {
        readdirCalls += 1;
        throw new Error('the filesystem must not be touched for an invalid id');
      },
    };
    const options = {
      stateDir,
      now: () => NOW,
      codexThreads: codex,
      bridge,
      claudeProjectsDir: projects,
      fsImpl,
    };
    const expected = [
      ['delete', 'failed', 'invalid id'],
      ['delete', 'failed', 'invalid id'],
      ['archive', 'failed', 'invalid id'],
      ['archive', 'failed', 'invalid id'],
    ];

    const preview = await sweepRecords({ ...options, dryRun: true });
    assert.deepEqual(
      preview.actions.map((action) => [action.action, action.state, action.note]),
      expected,
    );

    const report = await sweepRecords({ ...options, dryRun: false });
    assert.deepEqual(
      report.actions.map((action) => [action.action, action.state, action.note]),
      expected,
    );
    assert.equal(readdirCalls, 0, 'no claude project directory was read');
    assert.deepEqual(codex.calls, []);
    assert.deepEqual(bridge.calls, []);

    const index = await readIndex(stateDir);
    const record = index.get('r-bad');
    assert.equal(record.sessions.get('codex\u0000not-a-uuid').state, 'failed');
    assert.equal(record.sessions.get('claude-code\u0000../../escape').state, 'failed');
    assert.equal(record.sessions.get('dsh\u0000sess-1').state, 'failed');
    assert.equal(record.sessions.get('dsh\u0000sess-2').state, 'failed');
  });
});

// ---------------------------------------------------------------------------
// Absent clients
// ---------------------------------------------------------------------------

test('sweepRecords: absent clients and project directories report skipped instead of failing', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'rec.md');
    await writeFile(recordPath, '# rec\n', 'utf8');
    await addRecord(stateDir, recordPath, {
      recordId: 'r-absent',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'codex', id: CODEX_ID, source: 'task-codex' },
        { harness: 'claude-code', id: CLAUDE_ID, source: 'task-claude' },
        { harness: 'dsh', id: 'sess-1', source: 'task-dsh', revision: 1 },
      ],
    });

    const report = await sweepRecords({
      stateDir,
      now: () => NOW,
      dryRun: false,
      codexThreads: null,
      bridge: null,
      claudeProjectsDir: null,
    });

    assert.deepEqual(
      report.actions.map((action) => [action.harness, action.action, action.state, action.note]),
      [
        ['codex', 'delete', 'skipped', 'codex client unavailable'],
        ['claude-code', 'delete', 'skipped', 'claude projects dir unavailable'],
        ['dsh', 'archive', 'skipped', 'bridge unavailable'],
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// dsh archive/cleanup outcomes
// ---------------------------------------------------------------------------

test('sweepRecords: "already archived" counts as archived and a cleanup error never fails the session', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const recordPath = path.join(root, 'rec.md');
    await writeFile(recordPath, '# rec\n', 'utf8');
    await addRecord(stateDir, recordPath, {
      recordId: 'r-dsh',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'dsh', id: 'sess-a', source: 'task-a', revision: 1 },
        { harness: 'dsh', id: 'sess-b', source: 'task-b', revision: 2 },
        { harness: 'dsh', id: 'sess-c', source: 'task-c', revision: 3 },
      ],
    });
    const calls = [];
    const bridge = {
      async archive(source, revision) {
        calls.push(['archive', source, revision]);
        if (source === 'task-a') throw codedError('ALREADY_ARCHIVED', 'session already archived');
        if (source === 'task-c') throw codedError('ARCHIVE_CONFLICT', 'only a completed task can be archived');
        return { archived: true };
      },
      async cleanup(source, options) {
        calls.push(['cleanup', source, options]);
        if (source === 'task-b') throw codedError('CLEANUP_BUSY', 'cleanup is already running');
        return { cleaned: true };
      },
    };

    const report = await sweepRecords({ stateDir, now: () => NOW, dryRun: false, bridge });

    assert.deepEqual(
      report.actions.map((action) => [action.action, action.state]),
      [
        ['archive', 'archived'],
        ['archive', 'archived'],
        ['archive', 'failed'],
      ],
    );
    assert.ok(report.actions[0].note.includes('cleaned'), `note was ${report.actions[0].note}`);
    assert.equal(report.actions[1].note, 'CLEANUP_BUSY');
    assert.match(report.actions[2].note, /^ARCHIVE_CONFLICT: /);
    assert.deepEqual(calls, [
      ['archive', 'task-a', 1],
      ['cleanup', 'task-a', { dryRun: false }],
      ['archive', 'task-b', 2],
      ['cleanup', 'task-b', { dryRun: false }],
      ['archive', 'task-c', 3],
    ]);

    const index = await readIndex(stateDir);
    const record = index.get('r-dsh');
    assert.equal(record.sessions.get('dsh\u0000sess-a').state, 'archived');
    assert.equal(record.sessions.get('dsh\u0000sess-b').state, 'archived');
    assert.equal(record.sessions.get('dsh\u0000sess-c').state, 'failed');
  });
});
