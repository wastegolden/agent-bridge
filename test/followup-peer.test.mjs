// test/followup-peer.test.mjs
//
// Peer-side contract checks for the follow-up feature (bridge-followup-plan-v1 §2 and
// §4 "peer 侧"): `bridge_result` pages pinned by attemptId, the multi-round closeout
// record (every round's question/answer, a `taskId@attemptId` record identity and the
// unchanged single-round hash), the multi-round rendering, and the retention sweeper's
// "session still referenced by another record" rule.
//
// The bridge client is driven through a fake fetchImpl; the closeout and sweeper cases
// use real temp state directories while their jobs/bridge/codex clients are in-memory
// fakes whose calls are observable. Every temp directory is removed in a finally block.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CREDENTIAL_ENV, RESULT_PAGE_LIMIT, createBridgeClient } from '../src/peer/bridge-client.mjs';
import { closeoutRootTask } from '../src/peer/closeout.mjs';
import { appendIndexEvent, readIndex, renderRecord } from '../src/peer/records.mjs';
import { sweepRecords } from '../src/peer/sweeper.mjs';

const URL_LOCAL = 'http://127.0.0.1:3080/mcp/codex-bridge-v1';
const TOKEN = 'bridge-token-followup-0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_AT = new Date(2025, 5, 1, 10, 0, 0).getTime();
const ROOT_TASK = 'task-followup-peer-1';
const SESSION_ID = 'sess-followup-1';
const CODEX_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const NOW = 1_700_000_000_000;
/** The observable message the sweeper must attach to a skipped referenced session. */
const NOTE_REFERENCED = 'session still referenced by another record';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-followup-peer-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// bridge-client: resultText pinned by attemptId
// ---------------------------------------------------------------------------

/** A Response-shaped stand-in: status/text(). */
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
function toolResult(value) {
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } };
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

test('resultText pins every page request to attemptId and verifies every echoed page', async () => {
  const pages = [
    { attemptId: 'attempt-1', round: 1, followupId: 'follow-1', text: 'aa', offset: 0, nextOffset: 2, totalChars: 6, hasMore: true },
    { attemptId: 'attempt-1', round: 1, followupId: 'follow-1', text: 'bb', offset: 2, nextOffset: 4, totalChars: 6, hasMore: true },
    { attemptId: 'attempt-1', round: 1, followupId: 'follow-1', text: 'cc', offset: 4, nextOffset: 6, totalChars: 6, hasMore: false },
  ];
  let index = 0;
  const pinned = recorder(() => httpReply(toolResult(pages[index++])));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: pinned.impl });

  assert.equal(await client.resultText('t-9', { attemptId: 'attempt-1' }), 'aabbcc');
  assert.deepEqual(pinned.calls.map((call) => call.body.params.arguments), [
    { taskId: 't-9', offset: 0, limit: RESULT_PAGE_LIMIT, attemptId: 'attempt-1' },
    { taskId: 't-9', offset: 2, limit: RESULT_PAGE_LIMIT, attemptId: 'attempt-1' },
    { taskId: 't-9', offset: 4, limit: RESULT_PAGE_LIMIT, attemptId: 'attempt-1' },
  ]);

  // The first page belongs to the pinned round and the second does not: the whole read
  // aborts instead of returning a spliced answer from two rounds.
  const stalePages = [
    { attemptId: 'attempt-1', text: 'current', offset: 0, nextOffset: 7, totalChars: 14, hasMore: true },
    { attemptId: 'attempt-0', text: 'stale', offset: 7, nextOffset: 12, totalChars: 14, hasMore: false },
  ];
  let staleIndex = 0;
  const stale = recorder(() => httpReply(toolResult(stalePages[staleIndex++])));
  const staleClient = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: stale.impl });
  await assert.rejects(() => staleClient.resultText('t-9', { attemptId: 'attempt-1' }), (error) => {
    assert.equal(error.code, 'PEER_BRIDGE');
    assert.deepEqual(error.detail, {
      tool: 'bridge_result',
      code: null,
      attemptId: 'attempt-1',
      returnedAttemptId: 'attempt-0',
    });
    return true;
  });
  assert.equal(stale.calls.length, 2, 'the stale page was detected on the page it arrived in');

  // A page that echoes no attemptId cannot prove it belongs to the pinned round either.
  const silent = recorder(() => httpReply(toolResult({ text: 'x', offset: 0, nextOffset: 1, totalChars: 1, hasMore: false })));
  const silentClient = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: silent.impl });
  await assert.rejects(() => silentClient.resultText('t-9', { attemptId: 'attempt-1' }), (error) => {
    assert.equal(error.code, 'PEER_BRIDGE');
    assert.equal(error.detail.returnedAttemptId, null);
    return true;
  });

  // An invalid attemptId is refused before any request is sent.
  const invalid = recorder(() => httpReply(toolResult({})));
  const invalidClient = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: invalid.impl });
  await assert.rejects(() => invalidClient.resultText('t-9', { attemptId: '   ' }), { code: 'PEER_ARGS_INVALID' });
  assert.equal(invalid.calls.length, 0);
});

test('resultText without attemptId keeps the exact old request shape', async () => {
  const single = recorder(() => httpReply(toolResult({ text: 'ONLY ANSWER', offset: 0, nextOffset: 11, totalChars: 11, hasMore: false })));
  const client = createBridgeClient({ url: URL_LOCAL, env: { [CREDENTIAL_ENV]: TOKEN }, fetchImpl: single.impl });

  assert.equal(await client.resultText('t-9'), 'ONLY ANSWER');
  assert.deepEqual(single.calls[0].body.params.arguments, { taskId: 't-9', offset: 0, limit: RESULT_PAGE_LIMIT });
});

// ---------------------------------------------------------------------------
// closeout: fakes and fixtures
// ---------------------------------------------------------------------------

/** A peer jobs manager with nothing to return (these closeouts are bridge-only). */
function makeJobs() {
  return {
    async list() {
      return [];
    },
    async wait() {
      throw new Error('the closeout has no peer job to wait for');
    },
    async result() {
      throw new Error('the closeout has no peer job result to read');
    },
  };
}

/**
 * An in-memory bridge client whose texts are keyed by `${taskId}@${attemptId}` for a
 * pinned read and by `taskId` for the current (unpinned) read.
 */
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
      const key = typeof options.attemptId === 'string' && options.attemptId !== '' ? `${taskId}@${options.attemptId}` : taskId;
      if (!texts.has(key)) throw new Error(`no bridge result text for ${key}`);
      return texts.get(key);
    },
  };
}

function roundFixture({ round, attemptId, followupId = null, question = null, status = 'completed' } = {}) {
  return {
    round,
    attemptId,
    followupId,
    question,
    status,
    stopConfirmed: true,
    resultChars: 0,
    resultCollected: true,
    accepted: status === 'completed',
    endedAt: CLOSED_AT,
  };
}

function dossierFixture({ taskId = 't-1', attemptId, rounds, sessionId = SESSION_ID, revision = 5, status = 'completed' } = {}) {
  const dossier = {
    schemaVersion: 1,
    taskId,
    title: 'Follow-up task',
    role: 'investigate',
    status,
    revision,
    controller: 'codex',
    sessionId,
    acknowledgement: { resultCollected: true, accepted: true, artifactState: 'none', pinned: false },
    stop: { stopConfirmed: true, activeJobs: 0 },
    result: { available: true, totalChars: 10 },
  };
  if (attemptId !== undefined) dossier.attemptId = attemptId;
  if (rounds !== undefined) dossier.rounds = rounds;
  return dossier;
}

/**
 * A real project directory (with a `.git` directory), a real state directory and the
 * in-memory jobs/bridge fakes. `run` calls closeoutRootTask with merged input overrides;
 * `extra` overrides the base call itself (for example a later `now`).
 */
async function scenario(root, { dossiers = [], texts = [], input = {}, now = () => CLOSED_AT } = {}) {
  const projectDir = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  await mkdir(path.join(projectDir, '.git'), { recursive: true });

  const dossierMap = new Map();
  for (const dossier of dossiers) {
    dossierMap.set(dossier.taskId, {
      workspace: { repository: projectDir },
      request: { cwd: projectDir },
      ...dossier,
    });
  }
  const textsMap = new Map(texts);
  const jobs = makeJobs();
  const bridge = makeBridge({ dossiers: dossierMap, texts: textsMap });
  const base = {
    input: { title: 'Follow-up closeout', outcome: 'accepted', conclusion: 'Accepted.', bridgeTaskIds: ['t-1'], ...input },
    rootTask: ROOT_TASK,
    context: { self: 'codex', chain: ['codex'], root: 'codex' },
    jobs,
    bridge,
    stateDir,
    now,
  };
  return {
    projectDir,
    stateDir,
    bridge,
    base,
    dossierMap,
    textsMap,
    run: (override = {}, extra = {}) => closeoutRootTask({
      ...base,
      ...extra,
      input: { ...base.input, ...override },
    }),
  };
}

async function readIndexLines(stateDir) {
  const raw = await readFile(path.join(stateDir, 'records-index.jsonl'), 'utf8');
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

async function recordFiles(projectDir) {
  return readdir(path.join(projectDir, '.agent-bridge', 'records'));
}

/** The exact recordId the closeout must derive from its bridge tokens and job ids. */
function expectedRecordId(bridgeTokens, jobIds = []) {
  return createHash('sha256')
    .update(`${ROOT_TASK}\n${[...bridgeTokens].sort().join(',')}\n${[...jobIds].sort().join(',')}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

const MULTI_ROUNDS = [
  roundFixture({ round: 0, attemptId: 'attempt-1', question: 'Original objective: investigate the parser.' }),
  roundFixture({ round: 1, attemptId: 'attempt-2', followupId: 'follow-1', question: 'Which parser branch is unsafe?' }),
];

const MULTI_TEXTS = [
  // The unpinned current read and the pinned current round are the same answer.
  ['t-1', 'FOLLOW-UP ANSWER: branch x is unsafe.'],
  ['t-1@attempt-1', 'ORIGINAL ANSWER: the parser is fine.'],
  ['t-1@attempt-2', 'FOLLOW-UP ANSWER: branch x is unsafe.'],
];

test('multi-round closeout embeds every round pinned by attemptId and hashes taskId@attemptId', async () => {
  await withTempDir(async (root) => {
    const fixture = await scenario(root, {
      dossiers: [dossierFixture({ attemptId: 'attempt-2', rounds: MULTI_ROUNDS })],
      texts: MULTI_TEXTS,
    });

    const result = await fixture.run();
    assert.equal(result.reused, false);
    assert.equal(result.recordId, expectedRecordId(['t-1@attempt-2']));
    assert.notEqual(result.recordId, expectedRecordId(['t-1']), 'a multi-round task must not reuse the single-round hash');

    // The current (unpinned) read stays, and every round is read again with its attemptId.
    assert.deepEqual(fixture.bridge.resultTextCalls, [
      ['t-1', {}],
      ['t-1', { attemptId: 'attempt-1' }],
      ['t-1', { attemptId: 'attempt-2' }],
    ]);

    const content = await readFile(result.path, 'utf8');
    assert.ok(content.includes('#### 追问与回答'));
    assert.equal(content.includes('#### 结果全文'), false);
    assert.ok(content.includes('##### 第 0 轮（attemptId=attempt-1 · 状态=completed）'));
    assert.ok(content.includes('##### 第 1 轮（attemptId=attempt-2 · followupId=follow-1 · 状态=completed）'));
    const positions = [
      'Original objective: investigate the parser.',
      'ORIGINAL ANSWER: the parser is fine.',
      'Which parser branch is unsafe?',
      'FOLLOW-UP ANSWER: branch x is unsafe.',
    ].map((needle) => content.indexOf(needle));
    assert.ok(positions.every((position) => position >= 0), 'every round question and answer is in the record');
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the rounds are rendered in ascending order');

    // A follow-up reuses the same DSH session, so the session list is unchanged.
    assert.deepEqual(result.sessions, [{ harness: 'dsh', id: SESSION_ID, source: 't-1', revision: 5 }]);
    assert.equal((await readIndexLines(fixture.stateDir)).length, 1);
  });
});

test('repeating the closeout on the same round reuses the stored record', async () => {
  await withTempDir(async (root) => {
    const fixture = await scenario(root, {
      dossiers: [dossierFixture({ attemptId: 'attempt-2', rounds: MULTI_ROUNDS })],
      texts: MULTI_TEXTS,
    });

    const first = await fixture.run();
    const firstContent = await readFile(first.path, 'utf8');
    const second = await fixture.run();

    assert.equal(second.reused, true);
    assert.equal(second.recordId, first.recordId);
    assert.equal(second.path, first.path);
    assert.equal(second.sha256, first.sha256);
    assert.deepEqual(await recordFiles(fixture.projectDir), [path.basename(first.path)]);
    assert.equal(await readFile(first.path, 'utf8'), firstContent);
    assert.equal((await readIndexLines(fixture.stateDir)).length, 1);
  });
});

test('a new follow-up round produces a new record', async () => {
  await withTempDir(async (root) => {
    const fixture = await scenario(root, {
      dossiers: [dossierFixture({ attemptId: 'attempt-2', rounds: MULTI_ROUNDS })],
      texts: MULTI_TEXTS,
    });
    const first = await fixture.run();

    // A follow-up minted a new attempt and a new round; the dossier now reports three.
    const dossier = fixture.dossierMap.get('t-1');
    dossier.attemptId = 'attempt-3';
    dossier.rounds = [
      ...dossier.rounds,
      roundFixture({ round: 2, attemptId: 'attempt-3', followupId: 'follow-2', question: 'Is the fix verified?' }),
    ];
    fixture.textsMap.set('t-1', 'THIRD ANSWER: verified by a test run.');
    fixture.textsMap.set('t-1@attempt-3', 'THIRD ANSWER: verified by a test run.');

    const second = await fixture.run({}, { now: () => CLOSED_AT + 60_000 });
    assert.equal(second.reused, false);
    assert.notEqual(second.recordId, first.recordId);
    assert.equal(second.recordId, expectedRecordId(['t-1@attempt-3']));
    assert.equal((await recordFiles(fixture.projectDir)).length, 2);

    const content = await readFile(second.path, 'utf8');
    assert.ok(content.includes('##### 第 2 轮（attemptId=attempt-3 · followupId=follow-2 · 状态=completed）'));
    assert.ok(content.includes('Is the fix verified?'));
    assert.ok(content.includes('THIRD ANSWER: verified by a test run.'));
    assert.ok(content.includes('ORIGINAL ANSWER: the parser is fine.'));
    // The older record is not rewritten.
    assert.equal((await readFile(first.path, 'utf8')).includes('Is the fix verified?'), false);
  });
});

test('a single-round task keeps the exact legacy hash and the single-result rendering', async () => {
  await withTempDir(async (root) => {
    const fixture = await scenario(root, {
      dossiers: [dossierFixture()], // a legacy dossier: no attemptId and no rounds
      texts: [['t-1', 'SINGLE ROUND ANSWER']],
    });

    const legacy = await fixture.run();
    const expected = expectedRecordId(['t-1']);
    assert.equal(legacy.recordId, expected);
    const legacyContent = await readFile(legacy.path, 'utf8');
    assert.ok(legacyContent.includes('#### 结果全文'));
    assert.equal(legacyContent.includes('#### 追问与回答'), false);
    assert.deepEqual(fixture.bridge.resultTextCalls, [['t-1', {}]]);

    // A single-round dossier that DOES carry attemptId and exactly one rounds entry keeps
    // the same hash input, so the already written record is reused byte for byte.
    const dossier = fixture.dossierMap.get('t-1');
    dossier.attemptId = 'attempt-1';
    dossier.rounds = [roundFixture({ round: 0, attemptId: 'attempt-1', question: 'Original objective.' })];
    const single = await fixture.run();
    assert.equal(single.reused, true);
    assert.equal(single.recordId, expected);
    assert.equal(single.path, legacy.path);
    assert.equal(await readFile(legacy.path, 'utf8'), legacyContent);
    assert.deepEqual(fixture.bridge.resultTextCalls, [['t-1', {}], ['t-1', {}]]);
  });
});

// ---------------------------------------------------------------------------
// records: multi-round rendering
// ---------------------------------------------------------------------------

/** The same shape closeout hands to renderRecord for one bridge task. */
function renderedBridgeTask({ rounds, resultText = 'CURRENT ROUND ANSWER' } = {}) {
  const task = {
    dossier: {
      taskId: 't-1',
      title: 'Follow-up rendering',
      role: 'investigate',
      status: 'completed',
      controller: 'codex',
      sessionId: SESSION_ID,
      request: { objective: 'Investigate the parser.', acceptance: ['report'], cwd: 'E:/repo' },
      acknowledgement: { accepted: true, artifactState: 'none' },
    },
    resultText,
  };
  if (rounds !== undefined) task.rounds = rounds;
  return task;
}

function renderInput(bridgeTasks) {
  return {
    recordId: 'rec-followup',
    rootTask: ROOT_TASK,
    title: 'Follow-up record',
    projectRoot: 'E:/repo',
    controller: 'codex',
    chain: 'codex',
    closedAt: CLOSED_AT,
    outcome: 'accepted',
    conclusion: 'Done.',
    keep: false,
    eligibleAt: CLOSED_AT + 3 * DAY_MS,
    findings: [],
    bridgeTasks,
    peerJobs: [],
  };
}

test('renderRecord renders multi-round Q/A and leaves the single-round output unchanged', () => {
  const single = renderRecord(renderInput([renderedBridgeTask({ resultText: 'THE ONLY ANSWER' })]));
  assert.ok(single.includes('#### 结果全文\n\n```\nTHE ONLY ANSWER\n```'));
  assert.equal(single.includes('#### 追问与回答'), false);

  // Exactly one round is still a single-round task.
  const oneRound = renderRecord(renderInput([renderedBridgeTask({
    rounds: [roundFixture({ round: 0, attemptId: 'attempt-1', question: 'Original objective.' })],
    resultText: 'THE ONLY ANSWER',
  })]));
  assert.equal(oneRound, single);

  const rounds = [
    { round: 0, attemptId: 'attempt-1', followupId: null, question: 'Question one?', status: 'completed', resultText: 'ANSWER ONE' },
    { round: 1, attemptId: 'attempt-2', followupId: 'follow-1', question: 'Question two?', status: 'completed', resultText: 'ANSWER TWO' },
  ];
  const input = renderInput([renderedBridgeTask({ rounds, resultText: 'ANSWER TWO' })]);
  const multi = renderRecord(input);
  assert.equal(renderRecord(input), multi, 'rendering stays deterministic');
  assert.ok(multi.includes('#### 追问与回答'));
  assert.equal(multi.includes('#### 结果全文'), false);
  assert.ok(multi.includes('##### 第 0 轮（attemptId=attempt-1 · 状态=completed）'));
  assert.ok(multi.includes('##### 第 1 轮（attemptId=attempt-2 · followupId=follow-1 · 状态=completed）'));

  const positions = [
    '##### 第 0 轮',
    'Question one?',
    'ANSWER ONE',
    '##### 第 1 轮',
    'Question two?',
    'ANSWER TWO',
  ].map((needle) => multi.indexOf(needle));
  assert.ok(positions.every((position) => position >= 0), 'round metadata, question and answer are all rendered');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the rounds are rendered in order');
  // Both question and answer stay inside fences a stored text cannot close.
  assert.ok(multi.includes('```\nQuestion one?\n```'));
  assert.ok(multi.includes('```\nANSWER TWO\n```'));
});

// ---------------------------------------------------------------------------
// sweeper: sessions still referenced by another record
// ---------------------------------------------------------------------------

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

/** A codex client whose calls are observable. */
function fakeCodex() {
  const calls = [];
  return {
    calls,
    async archive(id) {
      calls.push(['archive', id]);
    },
    async remove(id) {
      calls.push(['remove', id]);
    },
  };
}

function fakeBridge() {
  const calls = [];
  return {
    calls,
    async archive(source, revision) {
      calls.push(['archive', source, revision]);
      return { taskId: source, archived: true, uiHidden: true };
    },
    async cleanup(source, options) {
      calls.push(['cleanup', source, options]);
      return { cleaned: true };
    },
  };
}

function indexFilePath(stateDir) {
  return path.join(stateDir, 'records-index.jsonl');
}

test('sweeper skips a due session still referenced by a kept or not-yet-due record', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const duePath = path.join(root, 'due.md');
    const keptPath = path.join(root, 'kept.md');
    const laterPath = path.join(root, 'later.md');
    for (const file of [duePath, keptPath, laterPath]) await writeFile(file, '# record\n', 'utf8');

    // The due record shares its dsh session with a keep:true record and its codex session
    // with a record whose window has not arrived: BOTH are still referenced.
    await addRecord(stateDir, duePath, {
      recordId: 'r-due',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'dsh', id: 'sess-shared', source: 'task-due', revision: 1 },
        { harness: 'codex', id: CODEX_ID, source: 'task-due' },
      ],
    });
    await addRecord(stateDir, keptPath, {
      recordId: 'r-kept',
      eligibleAt: NOW - 1,
      keep: true,
      sessions: [{ harness: 'dsh', id: 'sess-shared', source: 'task-kept', revision: 2 }],
    });
    await addRecord(stateDir, laterPath, {
      recordId: 'r-later',
      eligibleAt: NOW + 60_000,
      sessions: [{ harness: 'codex', id: CODEX_ID, source: 'task-later' }],
    });

    const codex = fakeCodex();
    const bridge = fakeBridge();
    const options = { stateDir, now: () => NOW, codexThreads: codex, bridge };
    const expected = [
      ['r-due', 'archive', 'skipped', NOTE_REFERENCED],
      ['r-due', 'delete', 'skipped', NOTE_REFERENCED],
    ];

    const before = await readFile(indexFilePath(stateDir), 'utf8');
    const preview = await sweepRecords({ ...options, dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.due, 1);
    assert.deepEqual(
      preview.actions.map((action) => [action.recordId, action.action, action.state, action.note]),
      expected,
    );
    assert.deepEqual(codex.calls, []);
    assert.deepEqual(bridge.calls, []);
    assert.equal(await readFile(indexFilePath(stateDir), 'utf8'), before, 'dryRun writes nothing');

    const report = await sweepRecords({ ...options, dryRun: false });
    assert.equal(report.due, 1);
    assert.deepEqual(
      report.actions.map((action) => [action.recordId, action.action, action.state, action.note]),
      expected,
    );
    assert.deepEqual(codex.calls, [], 'a referenced codex thread is never deleted');
    assert.deepEqual(bridge.calls, [], 'a referenced dsh session is never archived or cleaned');
    const index = await readIndex(stateDir);
    assert.equal(index.get('r-due').sessions.get('dsh\u0000sess-shared').state, 'skipped');
    assert.equal(index.get('r-due').sessions.get('dsh\u0000sess-shared').note, NOTE_REFERENCED);
    assert.equal(index.get('r-due').sessions.get(`codex\u0000${CODEX_ID}`).note, NOTE_REFERENCED);
  });
});

test('sweeper acts once on a session named by two due records', async () => {
  await withTempDir(async (root) => {
    const stateDir = await makeStateDir(root);
    const firstPath = path.join(root, 'first.md');
    const secondPath = path.join(root, 'second.md');
    await writeFile(firstPath, '# first\n', 'utf8');
    await writeFile(secondPath, '# second\n', 'utf8');

    await addRecord(stateDir, firstPath, {
      recordId: 'r-first',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'codex', id: CODEX_ID, source: 'task-first' },
        { harness: 'dsh', id: 'sess-shared', source: 'task-first', revision: 4 },
      ],
    });
    await addRecord(stateDir, secondPath, {
      recordId: 'r-second',
      eligibleAt: NOW - 1,
      sessions: [
        { harness: 'codex', id: CODEX_ID, source: 'task-second' },
        { harness: 'dsh', id: 'sess-shared', source: 'task-second', revision: 5 },
      ],
    });

    const codex = fakeCodex();
    const bridge = fakeBridge();
    const options = { stateDir, now: () => NOW, codexThreads: codex, bridge };

    const preview = await sweepRecords({ ...options, dryRun: true });
    assert.equal(preview.due, 2);
    assert.deepEqual(
      preview.actions.map((action) => [action.recordId, action.action, action.state]),
      [
        ['r-first', 'delete', 'planned'],
        ['r-first', 'archive', 'planned'],
        ['r-second', 'delete', 'skipped'],
        ['r-second', 'archive', 'skipped'],
      ],
    );
    assert.deepEqual(codex.calls, []);
    assert.deepEqual(bridge.calls, []);

    const report = await sweepRecords({ ...options, dryRun: false });
    assert.deepEqual(
      report.actions.map((action) => [action.recordId, action.action, action.state]),
      [
        ['r-first', 'delete', 'deleted'],
        ['r-first', 'archive', 'archived'],
        ['r-second', 'delete', 'skipped'],
        ['r-second', 'archive', 'skipped'],
      ],
    );
    assert.equal(report.actions[2].note, NOTE_REFERENCED);
    assert.equal(report.actions[3].note, NOTE_REFERENCED);
    // One delete and one archive/cleanup pair for the shared sessions, not two.
    assert.deepEqual(codex.calls, [['archive', CODEX_ID], ['remove', CODEX_ID]]);
    assert.deepEqual(bridge.calls, [
      ['archive', 'task-first', 4],
      ['cleanup', 'task-first', { dryRun: false }],
    ]);

    const index = await readIndex(stateDir);
    assert.equal(index.get('r-first').sessions.get('dsh\u0000sess-shared').state, 'archived');
    assert.equal(index.get('r-second').sessions.get('dsh\u0000sess-shared').state, 'skipped');
  });
});

test('renderRecord labels round 0 as the original request and marks a truncated question', () => {
  const rounds = [
    { round: 0, attemptId: 'attempt-1', followupId: null, question: null, questionChars: null, status: 'completed', resultText: 'ANSWER ONE' },
    { round: 1, attemptId: 'attempt-2', followupId: 'follow-1', question: 'Q'.repeat(4000), questionChars: 4500, status: 'completed', resultText: 'ANSWER TWO' },
    { round: 2, attemptId: 'attempt-3', followupId: 'follow-2', question: 'Short?', questionChars: 6, status: 'completed', resultText: 'ANSWER THREE' },
  ];
  const record = renderRecord(renderInput([renderedBridgeTask({ rounds, resultText: 'ANSWER THREE' })]));
  const roundZero = record.slice(record.indexOf('##### 第 0 轮'), record.indexOf('##### 第 1 轮'));
  assert.ok(roundZero.includes('（原始任务，见上方请求）'), 'round 0 points at the original request instead of "none"');
  assert.equal(roundZero.includes('（无）\n\n回答'), false);
  const roundOne = record.slice(record.indexOf('##### 第 1 轮'), record.indexOf('##### 第 2 轮'));
  assert.ok(roundOne.includes('（问题共 4500 字符，这里只保留了前 4000 字符）'));
  const roundTwo = record.slice(record.indexOf('##### 第 2 轮'));
  assert.equal(roundTwo.includes('这里只保留了前'), false, 'a complete question carries no truncation note');
});
