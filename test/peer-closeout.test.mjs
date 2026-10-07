// test/peer-closeout.test.mjs
//
// Contract checks for src/peer/closeout.mjs: the durable record (exactly one file, with
// the stored prompts and answers embedded), the git exclusion, the single index event,
// the retention window per outcome and per keep flag, idempotent replay, the refusals
// for a job or bridge task that is not ready (with nothing written), and the peer-job
// selection by rootTask.
//
// The jobs manager and the bridge client are in-memory fakes; prompt.txt files, the
// project directory (with a real .git directory) and the state directory are real
// temp-directory files so ensureGitExclude, writeRecord and the index are exercised for
// real. Every temp directory is removed in a finally block.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CLOSEOUT_OUTCOMES,
  MAX_CONCLUSION_CHARS,
  MAX_FINDINGS,
  MAX_TITLE_CHARS,
  closeoutRootTask,
} from '../src/peer/closeout.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_AT = new Date(2025, 5, 1, 10, 0, 0).getTime();
const ROOT_TASK = 'task-closeout-1';
const JOB_CODEX = 'peer-1750000000000-aaaaaaa1';
const JOB_CLAUDE = 'peer-1750000001000-bbbbbbb2';
const JOB_OTHER = 'peer-1750000002000-ccccccc3';

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readIndexLines(stateDir) {
  const raw = await readFile(path.join(stateDir, 'records-index.jsonl'), 'utf8');
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

async function recordFiles(projectDir) {
  return readdir(path.join(projectDir, '.agent-bridge', 'records'));
}

/** An in-memory stand-in for createPeerJobs: the surface closeout actually uses. */
function makeJobs(records, results = new Map()) {
  const byId = new Map(records.map((record) => [record.jobId, record]));
  return {
    listCalls: [],
    waitCalls: [],
    resultCalls: [],
    async list({ limit = 20 } = {}) {
      this.listCalls.push(limit);
      return [...byId.values()].slice(0, limit).map((job) => ({
        jobId: job.jobId,
        target: job.target,
        mode: job.mode,
        status: job.status,
        sessionId: job.sessionId,
      }));
    },
    async wait(jobId, waitMs = 0) {
      this.waitCalls.push([jobId, waitMs]);
      const job = byId.get(jobId);
      if (!job) throw new Error(`unknown peer job ${jobId}`);
      return structuredClone(job);
    },
    async result(jobId, { offset = 0, limit = 20_000 } = {}) {
      this.resultCalls.push([jobId, offset, limit]);
      const job = byId.get(jobId);
      const text = results.get(jobId) ?? null;
      if (text === null) {
        return { job: structuredClone(job), finalMessage: null, complete: true, outcomeUnknown: true, totalChars: 0, offset: 0, nextOffset: null };
      }
      const slice = text.slice(offset, offset + limit);
      return {
        job: structuredClone(job),
        finalMessage: slice,
        complete: true,
        outcomeUnknown: false,
        totalChars: text.length,
        offset,
        nextOffset: offset + slice.length < text.length ? offset + slice.length : null,
      };
    },
  };
}

/** An in-memory stand-in for createBridgeClient. */
function makeBridge({ dossiers = new Map(), texts = new Map() } = {}) {
  return {
    dossierCalls: [],
    resultTextCalls: [],
    async dossier(taskId) {
      this.dossierCalls.push(taskId);
      const dossier = dossiers.get(taskId);
      if (!dossier) throw new Error(`unknown bridge task ${taskId}`);
      return structuredClone(dossier);
    },
    async resultText(taskId, options = {}) {
      this.resultTextCalls.push([taskId, options]);
      return texts.get(taskId) ?? '';
    },
  };
}

function dossierFixture({ taskId = 't-1', status = 'completed', resultCollected = true, sessionId = 'sess-dsh-1', revision = 3, title = 'Backend task' } = {}) {
  return {
    schemaVersion: 1,
    taskId,
    title,
    role: 'implement',
    status,
    revision,
    controller: 'codex',
    sessionId,
    acknowledgement: { resultCollected, accepted: status === 'completed', artifactState: 'merged', pinned: false },
    stop: { stopConfirmed: true, activeJobs: 0 },
    result: { available: true, totalChars: 10 },
  };
}

function jobFixture({
  jobId,
  target = 'codex',
  mode = 'review',
  status = 'completed',
  sessionId = 'sess-codex-1',
  rootTask = ROOT_TASK,
  promptText,
  finalMessage,
  errors = [],
} = {}) {
  return {
    jobId,
    target,
    mode,
    status,
    sessionId,
    rootTask,
    chain: ['claude-code', target],
    startedAt: CLOSED_AT - 60_000,
    endedAt: CLOSED_AT,
    usage: null,
    costUsd: 0.2,
    errors,
    promptText,
    finalMessage,
  };
}

/**
 * A real project directory (with a `.git` directory) plus a real state directory, an
 * in-memory jobs manager and an in-memory bridge client. `run` calls closeoutRootTask
 * with merged input overrides.
 */
async function scenario(root, { jobs = [], dossiers = [], texts = [], projectDirName = 'project', input = {}, recordsConfig } = {}) {
  const projectDir = path.join(root, projectDirName);
  const stateDir = path.join(root, 'state');
  await mkdir(path.join(projectDir, '.git'), { recursive: true });

  const results = new Map();
  const jobRecords = [];
  for (const job of jobs) {
    const { promptText, finalMessage, ...record } = job;
    jobRecords.push({ cwd: projectDir, ...record });
    await mkdir(path.join(stateDir, 'jobs', record.jobId), { recursive: true });
    if (typeof promptText === 'string') {
      await writeFile(path.join(stateDir, 'jobs', record.jobId, 'prompt.txt'), promptText, 'utf8');
    }
    if (typeof finalMessage === 'string') results.set(record.jobId, finalMessage);
  }

  const dossierMap = new Map();
  for (const dossier of dossiers) {
    dossierMap.set(dossier.taskId, {
      workspace: { repository: projectDir },
      request: { cwd: projectDir },
      ...dossier,
    });
  }
  const textsMap = new Map(texts);

  const jobsManager = makeJobs(jobRecords, results);
  const bridgeClient = makeBridge({ dossiers: dossierMap, texts: textsMap });
  const base = {
    input: { title: 'Task one', outcome: 'accepted', conclusion: 'Everything passed.', ...input },
    rootTask: ROOT_TASK,
    context: { self: 'codex', chain: ['codex'], root: 'codex' },
    jobs: jobsManager,
    bridge: bridgeClient,
    stateDir,
    now: () => CLOSED_AT,
  };
  if (recordsConfig !== undefined) base.recordsConfig = recordsConfig;
  return {
    projectDir,
    stateDir,
    jobs: jobsManager,
    bridge: bridgeClient,
    base,
    run: (override = {}) => closeoutRootTask({ ...base, input: { ...base.input, ...override } }),
  };
}

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('closeout writes one record, excludes it from git, and appends one index event', async () => {
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const fixture = await scenario(base, {
      jobs: [
        jobFixture({
          jobId: JOB_CODEX,
          target: 'codex',
          status: 'completed',
          sessionId: 'sess-codex-1',
          promptText: 'Please review the closeout diff.',
          finalMessage: 'The diff is correct.\nNo blockers.',
        }),
        jobFixture({
          jobId: JOB_CLAUDE,
          target: 'claude-code',
          mode: 'consult',
          status: 'failed',
          sessionId: null,
          errors: ['the peer process exited 1'],
        }),
      ],
      dossiers: [dossierFixture({ taskId: 't-1' })],
      texts: [['t-1', 'RESULT: shipped with evidence.']],
      input: { bridgeTaskIds: ['t-1'], peerJobIds: [JOB_CODEX, JOB_CLAUDE] },
    });

    const result = await fixture.run();
    assert.equal(result.reused, false);
    assert.match(result.recordId, /^[0-9a-f]{16}$/);

    const recordsDir = path.join(fixture.projectDir, '.agent-bridge', 'records');
    assert.equal(path.dirname(result.path), recordsDir);
    assert.match(path.basename(result.path), /^\d{8}-\d{4}-task-one-[0-9a-f]{6}\.md$/);
    assert.deepEqual(await recordFiles(fixture.projectDir), [path.basename(result.path)]);

    const content = await readFile(result.path, 'utf8');
    assert.equal(result.sha256, sha256Hex(content));
    // The stored data is embedded verbatim: title, conclusion, both prompts and answers.
    assert.ok(content.includes('# Task one'));
    assert.ok(content.includes(ROOT_TASK));
    assert.ok(content.includes('Everything passed.'));
    assert.ok(content.includes('Please review the closeout diff.'));
    assert.ok(content.includes('The diff is correct.'));
    assert.ok(content.includes('RESULT: shipped with evidence.'));
    assert.ok(content.includes('- 结果: accepted'));

    assert.equal(result.eligibleAt, CLOSED_AT + 3 * DAY_MS);
    assert.deepEqual(result.sessions, [
      { harness: 'dsh', id: 'sess-dsh-1', source: 't-1', revision: 3 },
      { harness: 'codex', id: 'sess-codex-1', source: JOB_CODEX },
    ]);

    // The record directory is excluded through git's own local exclude file.
    const exclude = await readFile(path.join(fixture.projectDir, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.split('\n').includes('/.agent-bridge/'));

    const events = await readIndexLines(fixture.stateDir);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.kind, 'record');
    assert.equal(event.recordId, result.recordId);
    assert.equal(event.rootTask, ROOT_TASK);
    assert.equal(event.title, 'Task one');
    assert.equal(event.projectRoot, fixture.projectDir);
    assert.equal(event.path, result.path);
    assert.equal(event.sha256, result.sha256);
    assert.equal(event.outcome, 'accepted');
    assert.equal(event.keep, false);
    assert.equal(event.closedAt, CLOSED_AT);
    assert.equal(event.eligibleAt, CLOSED_AT + 3 * DAY_MS);
    assert.deepEqual(event.sessions.map((session) => session.harness), ['dsh', 'codex']);
    assert.deepEqual(event.sessions[1], { harness: 'codex', id: 'sess-codex-1', source: JOB_CODEX });
  });
});

test('the record is written before the index event: a record that cannot be written leaves no index event', async () => {
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const fixture = await scenario(base, {
      jobs: [jobFixture({ jobId: JOB_CODEX, promptText: 'p', finalMessage: 'a' })],
      input: { peerJobIds: [JOB_CODEX] },
    });
    // `<project>/blocker` is a FILE, so the record directory can never be created and
    // writeRecord fails. The state directory is real and writable, so an implementation
    // that appended the index event first would leave records-index.jsonl behind.
    await writeFile(path.join(fixture.projectDir, 'blocker'), 'not a directory', 'utf8');

    await assert.rejects(() => closeoutRootTask({ ...fixture.base, recordsConfig: { dirName: 'blocker/records' } }));
    assert.equal(existsSync(path.join(fixture.projectDir, 'blocker', 'records')), false);
    assert.equal(existsSync(path.join(fixture.stateDir, 'records-index.jsonl')), false);
  });
});

// ---------------------------------------------------------------------------
// retention windows and idempotent replay
// ---------------------------------------------------------------------------

test('eligibleAt follows the outcome and the keep flag', async () => {
  const cases = [
    ['accepted', {}, CLOSED_AT + 3 * DAY_MS],
    ['failed', {}, CLOSED_AT + 30 * DAY_MS],
    ['disputed', {}, CLOSED_AT + 30 * DAY_MS],
    ['unresolved', {}, CLOSED_AT + 30 * DAY_MS],
    ['accepted', { keep: true }, null],
    ['disputed', { keep: true }, null],
  ];
  for (const [outcome, extra, expected] of cases) {
    await withTempDir('agent-bridge-closeout-', async (base) => {
      const fixture = await scenario(base, {
        jobs: [jobFixture({ jobId: JOB_CODEX })],
        input: { outcome, peerJobIds: [JOB_CODEX], ...extra },
      });
      const result = await fixture.run();
      assert.equal(result.eligibleAt, expected, `${outcome} with ${JSON.stringify(extra)}`);
      const [event] = await readIndexLines(fixture.stateDir);
      assert.equal(event.eligibleAt, expected);
      assert.equal(event.keep, extra.keep === true);
    });
  }
});

test('a second identical closeout reuses the stored record and writes nothing', async () => {
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const fixture = await scenario(base, {
      jobs: [jobFixture({ jobId: JOB_CODEX, promptText: 'p', finalMessage: 'a' })],
      dossiers: [dossierFixture({ taskId: 't-1' })],
      texts: [['t-1', 'RESULT']],
      input: { bridgeTaskIds: ['t-1'], peerJobIds: [JOB_CODEX] },
    });

    const first = await fixture.run();
    const before = await readFile(first.path, 'utf8');
    const second = await fixture.run();

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.recordId, first.recordId);
    assert.deepEqual(
      { path: second.path, sha256: second.sha256, eligibleAt: second.eligibleAt, sessions: second.sessions },
      { path: first.path, sha256: first.sha256, eligibleAt: first.eligibleAt, sessions: first.sessions },
    );

    assert.deepEqual(await recordFiles(fixture.projectDir), [path.basename(first.path)]);
    assert.equal((await readFile(first.path, 'utf8')), before);
    assert.equal((await readIndexLines(fixture.stateDir)).length, 1);
  });
});

// ---------------------------------------------------------------------------
// refusals: nothing may be written before every input is ready
// ---------------------------------------------------------------------------

test('a non-terminal peer job is refused and nothing is written', async () => {
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const fixture = await scenario(base, {
      jobs: [jobFixture({ jobId: JOB_CODEX, status: 'running', promptText: 'p', finalMessage: 'a' })],
      dossiers: [dossierFixture({ taskId: 't-1' })],
      texts: [['t-1', 'RESULT']],
      input: { bridgeTaskIds: ['t-1'], peerJobIds: [JOB_CODEX] },
    });

    await assert.rejects(() => fixture.run(), (error) => {
      assert.equal(error.code, 'PEER_CLOSEOUT_NOT_READY');
      assert.deepEqual(error.detail, { field: 'peerJobIds' });
      return true;
    });
    assert.equal(existsSync(path.join(fixture.projectDir, '.agent-bridge')), false);
    assert.equal(existsSync(path.join(fixture.projectDir, '.git', 'info', 'exclude')), false);
    assert.equal(existsSync(path.join(fixture.stateDir, 'records-index.jsonl')), false);
    assert.equal(fixture.bridge.resultTextCalls.length, 0);
  });
});

test('a bridge task that is not settled and acknowledged is refused and nothing is written', async () => {
  // The result was never collected: the task has not been reviewed and acknowledged.
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const fixture = await scenario(base, {
      dossiers: [dossierFixture({ taskId: 't-1', resultCollected: false })],
      texts: [['t-1', 'RESULT']],
      input: { bridgeTaskIds: ['t-1'], peerJobIds: [] },
    });
    await assert.rejects(() => fixture.run(), (error) => {
      assert.equal(error.code, 'PEER_CLOSEOUT_NOT_READY');
      assert.deepEqual(error.detail, { field: 'bridgeTaskIds' });
      return true;
    });
    assert.equal(existsSync(path.join(fixture.projectDir, '.agent-bridge')), false);
    assert.equal(existsSync(path.join(fixture.stateDir, 'records-index.jsonl')), false);
    // The unacknowledged result text was never even fetched.
    assert.equal(fixture.bridge.resultTextCalls.length, 0);
  });

  // A task that has not reached a terminal state is refused the same way.
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const fixture = await scenario(base, {
      dossiers: [dossierFixture({ taskId: 't-1', status: 'running', resultCollected: true })],
      texts: [['t-1', 'RESULT']],
      input: { bridgeTaskIds: ['t-1'], peerJobIds: [] },
    });
    await assert.rejects(() => fixture.run(), (error) => {
      assert.equal(error.code, 'PEER_CLOSEOUT_NOT_READY');
      assert.equal(error.detail.field, 'bridgeTaskIds');
      return true;
    });
    assert.equal(existsSync(path.join(fixture.projectDir, '.agent-bridge')), false);
    assert.equal(existsSync(path.join(fixture.stateDir, 'records-index.jsonl')), false);
  });
});

// ---------------------------------------------------------------------------
// selection and project root
// ---------------------------------------------------------------------------

test('peer jobs are selected by rootTask when peerJobIds is omitted', async () => {
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const fixture = await scenario(base, {
      jobs: [
        jobFixture({ jobId: JOB_CODEX, sessionId: 'sess-codex-1', promptText: 'IN-ROOT prompt', finalMessage: 'IN-ROOT answer' }),
        jobFixture({ jobId: JOB_OTHER, target: 'claude-code', rootTask: 'task-other', sessionId: 'sess-other-1', promptText: 'OTHER prompt', finalMessage: 'OTHER answer' }),
      ],
      dossiers: [],
      texts: [],
    });

    const result = await fixture.run();
    assert.deepEqual(fixture.jobs.listCalls, [200]);
    assert.deepEqual(result.sessions, [{ harness: 'codex', id: 'sess-codex-1', source: JOB_CODEX }]);
    assert.equal(result.eligibleAt, CLOSED_AT + 3 * DAY_MS);

    const content = await readFile(result.path, 'utf8');
    assert.ok(content.includes('IN-ROOT prompt'));
    assert.ok(content.includes('IN-ROOT answer'));
    assert.equal(content.includes('OTHER prompt'), false);
    assert.equal(content.includes('OTHER answer'), false);
  });
});

test('an explicit projectRoot is used without walking up from the dossier cwd', async () => {
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const projectDir = path.join(base, 'explicit-project');
    const elsewhere = path.join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    // The dossier points at a directory that is NOT the explicit project root.
    const fixture = await scenario(base, {
      projectDirName: 'explicit-project',
      dossiers: [{
        ...dossierFixture({ taskId: 't-1' }),
        workspace: { repository: elsewhere },
        request: { cwd: elsewhere },
      }],
      texts: [['t-1', 'RESULT']],
      input: { bridgeTaskIds: ['t-1'], peerJobIds: [], projectRoot: projectDir },
    });

    const result = await fixture.run();
    assert.equal(path.dirname(result.path), path.join(projectDir, '.agent-bridge', 'records'));
    assert.equal(existsSync(path.join(projectDir, '.git', 'info', 'exclude')), true);
    assert.equal(existsSync(path.join(elsewhere, '.agent-bridge')), false);
  });
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

test('closeout validates its input before any work and writes nothing', async () => {
  await withTempDir('agent-bridge-closeout-', async (base) => {
    const fixture = await scenario(base, {
      jobs: [jobFixture({ jobId: JOB_CODEX, promptText: 'p', finalMessage: 'a' })],
      dossiers: [dossierFixture({ taskId: 't-1' })],
      texts: [['t-1', 'RESULT']],
      input: { bridgeTaskIds: ['t-1'], peerJobIds: [JOB_CODEX] },
    });

    const cases = [
      [{ title: undefined }, 'title'],
      [{ title: '   ' }, 'title'],
      [{ title: 'x'.repeat(MAX_TITLE_CHARS + 1) }, 'title'],
      [{ outcome: 'maybe' }, 'outcome'],
      [{ outcome: undefined }, 'outcome'],
      [{ conclusion: '' }, 'conclusion'],
      [{ conclusion: 'x'.repeat(MAX_CONCLUSION_CHARS + 1) }, 'conclusion'],
      [{ findings: 'nope' }, 'findings'],
      [{ findings: Array.from({ length: MAX_FINDINGS + 1 }, (_, index) => ({ id: `F${index}`, raisedBy: ['codex'], verdict: 'confirmed', summary: 's', evidence: 'e' })) }, 'findings'],
      [{ findings: [{ id: 'F1', raisedBy: ['codex'], verdict: 'maybe', summary: 's', evidence: 'e' }] }, 'findings'],
      [{ findings: [{ id: '', raisedBy: ['codex'], verdict: 'confirmed', summary: 's', evidence: 'e' }] }, 'findings'],
      [{ findings: [{ id: 'F1', raisedBy: 'codex', verdict: 'confirmed', summary: 's', evidence: 'e' }] }, 'findings'],
      [{ bridgeTaskIds: 't-1' }, 'bridgeTaskIds'],
      [{ peerJobIds: 'job' }, 'peerJobIds'],
      [{ projectRoot: 'relative/path' }, 'projectRoot'],
      [{ keep: 'yes' }, 'keep'],
    ];
    for (const [override, field] of cases) {
      await assert.rejects(() => fixture.run(override), (error) => {
        assert.equal(error.code, 'PEER_ARGS_INVALID', `expected PEER_ARGS_INVALID for ${JSON.stringify(override)}`);
        assert.equal(error.detail.field, field, `expected field ${field} for ${JSON.stringify(override)}`);
        return true;
      });
    }

    await assert.rejects(() => fixture.run({ peerJobIds: [], bridgeTaskIds: [] }), { code: 'PEER_ARGS_INVALID' });

    assert.equal(existsSync(path.join(fixture.projectDir, '.agent-bridge')), false);
    assert.equal(existsSync(path.join(fixture.stateDir, 'records-index.jsonl')), false);
    assert.deepEqual(CLOSEOUT_OUTCOMES, ['accepted', 'failed', 'disputed', 'unresolved']);
  });
});
