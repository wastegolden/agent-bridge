// test/peer-records.test.mjs
//
// Contract checks for src/peer/records.mjs: project-root discovery, git-exclude
// placement, deterministic file naming, retention maths, the deterministic Markdown
// record (verbatim, fence-safe) and the JSON Lines session index.
//
// Every temp directory is removed in a finally block. The git seam tests use injected
// stat/read/mkdir/append fakes so no real repository is created or touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendIndexEvent,
  computeEligibleAt,
  ensureGitExclude,
  findProjectRoot,
  readIndex,
  recordFileName,
  renderRecord,
  writeRecord,
} from '../src/peer/records.mjs';

const ROOT = path.parse(process.cwd()).root;
const DAY_MS = 24 * 60 * 60 * 1000;
const GITIGNORE = '# user rule\nnode_modules/\n';

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// findProjectRoot
// ---------------------------------------------------------------------------

/** A stat fake over an explicit set of directory and file paths. */
function statMap({ dirs = [], files = [] } = {}) {
  const entries = new Map(dirs.map((dir) => [path.normalize(dir), 'dir']));
  for (const file of files) entries.set(path.normalize(file), 'file');
  return async (target) => {
    const kind = entries.get(path.normalize(target));
    if (!kind) {
      const error = new Error(`ENOENT: ${target}`);
      error.code = 'ENOENT';
      throw error;
    }
    return {
      isDirectory: () => kind === 'dir',
      isFile: () => kind === 'file',
    };
  };
}

test('findProjectRoot: nested directories, a .git file worktree and a non-repository', async () => {
  const repo = path.join(ROOT, 'repo');
  const deep = path.join(repo, 'src', 'peer', 'deep');
  const stats = statMap({ dirs: [repo, path.join(repo, 'src'), deep, path.join(repo, '.git')] });
  assert.equal(await findProjectRoot(deep, { statImpl: stats }), repo);

  const worktree = path.join(ROOT, 'worktrees', 'wt-1');
  const wtStats = statMap({ dirs: [worktree, path.join(worktree, 'lib')], files: [path.join(worktree, '.git')] });
  assert.equal(await findProjectRoot(path.join(worktree, 'lib'), { statImpl: wtStats }), worktree);

  const plain = path.join(ROOT, 'plain', 'nested');
  const none = statMap({ dirs: [path.join(ROOT, 'plain'), plain] });
  assert.equal(await findProjectRoot(plain, { statImpl: none }), plain);
  assert.equal(await findProjectRoot(ROOT, { statImpl: statMap({}) }), ROOT);
});

test('findProjectRoot refuses a relative directory', async () => {
  await assert.rejects(() => findProjectRoot('relative/dir', { statImpl: statMap({}) }), { code: 'PEER_ARGS_INVALID' });
});

// ---------------------------------------------------------------------------
// ensureGitExclude
// ---------------------------------------------------------------------------

/**
 * A small in-memory filesystem for the git-exclude seams. `stat` answers for the paths
 * it was seeded with (plus anything mkdir/append created), reads/writes are tracked so
 * a test can prove `.gitignore` was never touched.
 */
function fakeFs({ dirs = [], files = {}, appends = {} } = {}) {
  const dirSet = new Set(dirs.map((dir) => path.normalize(dir)));
  const fileMap = new Map(Object.entries(files).map(([name, text]) => [path.normalize(name), text]));
  const appendMap = new Map();
  for (const [name, text] of Object.entries(appends)) {
    const key = path.normalize(name);
    fileMap.set(key, (fileMap.get(key) ?? '') + text);
    appendMap.set(key, [text]);
  }
  return {
    dirSet,
    fileMap,
    appendMap,
    async stat(target) {
      const key = path.normalize(target);
      if (dirSet.has(key)) return { isDirectory: () => true, isFile: () => false };
      if (fileMap.has(key)) return { isDirectory: () => false, isFile: () => true };
      const error = new Error(`ENOENT: ${target}`);
      error.code = 'ENOENT';
      throw error;
    },
    async readFile(target) {
      const key = path.normalize(target);
      if (!fileMap.has(key)) {
        const error = new Error(`ENOENT: ${target}`);
        error.code = 'ENOENT';
        throw error;
      }
      return fileMap.get(key);
    },
    async mkdir(target) {
      dirSet.add(path.normalize(target));
    },
    async appendFile(target, text) {
      const key = path.normalize(target);
      const log = appendMap.get(key) ?? [];
      log.push(text);
      appendMap.set(key, log);
      fileMap.set(key, (fileMap.get(key) ?? '') + text);
    },
  };
}

test('ensureGitExclude adds the pattern once inside <root>/.git/info/exclude', async () => {
  const root = path.join(ROOT, 'repo');
  const dotGit = path.join(root, '.git');
  const ignoreFile = path.join(root, '.gitignore');
  const fs = fakeFs({
    dirs: [root, dotGit],
    files: { [ignoreFile]: GITIGNORE },
  });
  const options = {
    stat: fs.stat,
    readFile: fs.readFile,
    mkdir: fs.mkdir,
    appendFile: fs.appendFile,
  };
  const infoDir = path.join(dotGit, 'info');
  const excludeFile = path.join(infoDir, 'exclude');

  const first = await ensureGitExclude(root, options);
  assert.deepEqual(first, { excluded: true, reason: 'added', file: excludeFile });
  assert.equal(fs.fileMap.get(excludeFile), '/.agent-bridge/\n');
  // Exactly one append: the missing file was created with the pattern as its only line.
  assert.equal(fs.appendMap.get(excludeFile).length, 1);

  const second = await ensureGitExclude(root, options);
  assert.deepEqual(second, { excluded: true, reason: 'present', file: excludeFile });
  assert.equal(fs.fileMap.get(excludeFile), '/.agent-bridge/\n');
  // Never a second append, and the project's tracked ignore file is untouched.
  assert.equal(fs.appendMap.get(excludeFile).length, 1);
  assert.equal(fs.fileMap.get(ignoreFile), GITIGNORE);
});

test('ensureGitExclude preserves existing CRLF content and does not rewrite it', async () => {
  const root = path.join(ROOT, 'crlf-repo');
  const dotGit = path.join(root, '.git');
  const infoDir = path.join(dotGit, 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  const fs = fakeFs({
    dirs: [root, dotGit, infoDir],
    files: { [excludeFile]: '# keep me\r\n*.tmp\r\n' },
    appends: { [excludeFile]: '*.bak\r\n' },
  });
  const result = await ensureGitExclude(root, {
    stat: fs.stat,
    readFile: fs.readFile,
    mkdir: fs.mkdir,
    appendFile: fs.appendFile,
  });
  assert.deepEqual(result, { excluded: true, reason: 'added', file: excludeFile });
  assert.equal(fs.appendMap.get(excludeFile).length, 1);
  assert.equal(fs.appendMap.get(excludeFile)[0], '/.agent-bridge/\n');
  assert.equal(fs.fileMap.get(excludeFile), '# keep me\r\n*.tmp\r\n*.bak\r\n/.agent-bridge/\n');
});

test('ensureGitExclude follows a worktree .git file to commondir/info/exclude', async () => {
  const worktree = path.join(ROOT, 'worktrees', 'wt-1');
  const gitDir = path.join(worktree, '.git-dir');
  const commonDir = path.join(ROOT, 'repo', '.git');
  const fs = fakeFs({
    dirs: [worktree, gitDir, commonDir],
    files: {
      [path.join(worktree, '.git')]: `gitdir: ${path.join('.git-dir')}\n`,
      [path.join(gitDir, 'commondir')]: '../repo/.git\n',
    },
  });
  const result = await ensureGitExclude(worktree, {
    stat: fs.stat,
    readFile: fs.readFile,
    mkdir: fs.mkdir,
    appendFile: fs.appendFile,
  });
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  assert.deepEqual(result, { excluded: true, reason: 'added', file: excludeFile });
  assert.equal(fs.fileMap.get(excludeFile), '/.agent-bridge/\n');

  // A linked worktree without a commondir writes into the gitdir itself.
  const bare = path.join(ROOT, 'worktrees', 'wt-2');
  const bareGitDir = path.join(bare, '.git-dir');
  const fs2 = fakeFs({
    dirs: [bare, bareGitDir],
    files: { [path.join(bare, '.git')]: 'gitdir: .git-dir\n' },
  });
  const result2 = await ensureGitExclude(bare, {
    stat: fs2.stat,
    readFile: fs2.readFile,
    mkdir: fs2.mkdir,
    appendFile: fs2.appendFile,
  });
  assert.deepEqual(result2, { excluded: true, reason: 'added', file: path.join(bareGitDir, 'info', 'exclude') });
});

test('ensureGitExclude reports a non-repository and never creates an exclude file', async () => {
  const root = path.join(ROOT, 'no-repo');
  const fs = fakeFs({ dirs: [root], files: { [path.join(root, '.gitignore')]: GITIGNORE } });
  const result = await ensureGitExclude(root, {
    stat: fs.stat,
    readFile: fs.readFile,
    mkdir: fs.mkdir,
    appendFile: fs.appendFile,
  });
  assert.deepEqual(result, { excluded: false, reason: 'not-a-git-repository', file: null });
  assert.equal(fs.appendMap.size, 0);
  assert.equal(fs.fileMap.get(path.join(root, '.gitignore')), GITIGNORE);
});

// ---------------------------------------------------------------------------
// recordFileName / computeEligibleAt
// ---------------------------------------------------------------------------

test('recordFileName uses local time, a slug and a hash of task+timestamp', () => {
  const createdAt = new Date(2024, 4, 7, 9, 3, 41, 250).getTime();
  const name = recordFileName({ createdAt, title: 'Fix: The Login Flow!', rootTask: 'task-1' });
  assert.equal(name, `20240507-0903-fix-the-login-flow-${sha6('task-1', createdAt)}.md`);
  assert.match(name, /^\d{8}-\d{4}-[a-z0-9-]+-[0-9a-f]{6}\.md$/);

  // Hash is bound to both the root task and the exact millisecond timestamp.
  assert.notEqual(
    recordFileName({ createdAt, title: 'x', rootTask: 'task-1' }),
    recordFileName({ createdAt, title: 'x', rootTask: 'task-2' }),
  );
  assert.notEqual(
    recordFileName({ createdAt, title: 'x', rootTask: 'task-1' }),
    recordFileName({ createdAt: createdAt + 1, title: 'x', rootTask: 'task-1' }),
  );
});

function sha6(rootTask, createdAt) {
  return createHash('sha256').update(`${rootTask}\n${createdAt}`, 'utf8').digest('hex').slice(0, 6);
}

test('recordFileName falls back to the record slug and caps the slug at 40 chars', () => {
  const createdAt = new Date(2024, 0, 2, 3, 4, 5).getTime();
  assert.equal(
    recordFileName({ createdAt, title: '会话记录：中文标题', rootTask: 't' }),
    `20240102-0304-record-${sha6('t', createdAt)}.md`,
  );
  assert.equal(
    recordFileName({ createdAt, title: '!!!', rootTask: 't' }),
    `20240102-0304-record-${sha6('t', createdAt)}.md`,
  );
  assert.equal(
    recordFileName({ createdAt, title: '', rootTask: 't' }),
    `20240102-0304-record-${sha6('t', createdAt)}.md`,
  );
  const long = recordFileName({ createdAt, title: 'a'.repeat(60), rootTask: 't' });
  assert.equal(long, `20240102-0304-${'a'.repeat(40)}-${sha6('t', createdAt)}.md`);
});

test('computeEligibleAt covers every outcome and the keep flag', () => {
  const closedAt = 1_700_000_000_000;
  assert.equal(computeEligibleAt({ closedAt, outcome: 'accepted' }), closedAt + 3 * DAY_MS);
  assert.equal(computeEligibleAt({ closedAt, outcome: 'accepted', retainDays: 1 }), closedAt + DAY_MS);
  for (const outcome of ['failed', 'disputed', 'unresolved']) {
    assert.equal(computeEligibleAt({ closedAt, outcome }), closedAt + 30 * DAY_MS);
    assert.equal(computeEligibleAt({ closedAt, outcome, disputedRetainDays: 45 }), closedAt + 45 * DAY_MS);
  }
  assert.equal(computeEligibleAt({ closedAt, outcome: 'accepted', keep: true }), null);
  assert.equal(computeEligibleAt({ closedAt, outcome: 'disputed', keep: true }), null);
  assert.throws(() => computeEligibleAt({ closedAt, outcome: 'maybe' }), { code: 'PEER_ARGS_INVALID' });
  assert.throws(() => computeEligibleAt({ closedAt, outcome: undefined }), { code: 'PEER_ARGS_INVALID' });
});

// ---------------------------------------------------------------------------
// renderRecord
// ---------------------------------------------------------------------------

const CLOSED_AT = new Date(2024, 4, 7, 9, 3, 41).getTime();
const ELIGIBLE_AT = CLOSED_AT + 3 * DAY_MS;
const SEVEN_TICKS = '`'.repeat(7);

function backendTaskFixture() {
  return {
    dossier: {
      taskId: 't-1',
      title: 'Backend work',
      role: 'implement',
      status: 'completed',
      controller: 'codex',
      request: {
        objective: 'Ship the parser.',
        acceptance: ['tests pass', 'no new deps'],
        cwd: 'E:/repo',
      },
      effectiveModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      stats: { toolCalls: 12 },
      sessionId: 'sess-dsh-1',
      workspace: { branch: 'task/t-1', baseCommit: 'base123', path: 'E:/wt/t-1' },
      review: {
        passed: true,
        head: 'head456',
        checks: [{ command: 'node', args: ['--test', 'test/x.test.mjs'], exitCode: 0, ok: true }],
      },
      integration: { merged: true, accepted: true, targetHeadBefore: 'base123', targetHeadAfter: 'head456' },
      acknowledgement: { accepted: true, artifactState: 'merged' },
    },
    resultText: 'RESULT: parser shipped.\nSecond line.',
  };
}

function peerJobFixture() {
  return {
    job: {
      jobId: 'peer-1700000000000-abcdef01',
      target: 'codex',
      mode: 'review',
      status: 'completed',
      sessionId: 'sess-peer-1',
      chain: ['claude-code', 'codex'],
      startedAt: CLOSED_AT - 60_000,
      endedAt: CLOSED_AT,
      usage: null,
      costUsd: 0.25,
      errors: [],
    },
    promptText: 'Please review the diff.',
    finalMessage: 'PROMPT: looks correct.\nNo blockers.',
  };
}

function recordInput(overrides = {}) {
  return {
    recordId: 'rec-001',
    rootTask: 'task-1',
    title: 'Root task record',
    projectRoot: 'E:/repo',
    controller: 'claude-code',
    chain: 'claude-code',
    closedAt: CLOSED_AT,
    outcome: 'accepted',
    conclusion: 'All checks passed; the parser ships.',
    keep: false,
    eligibleAt: ELIGIBLE_AT,
    findings: [],
    bridgeTasks: [],
    peerJobs: [],
    ...overrides,
  };
}

/** Fenced blocks whose info string is exactly `info`, in document order. */
function fencedBlocks(markdown, info) {
  const blocks = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(`{3,})(.*)$/.exec(lines[index]);
    if (!match || match[2] !== info) continue;
    for (let end = index + 1; end < lines.length; end += 1) {
      const closing = /^(`{3,})\s*$/.exec(lines[end]);
      if (closing && closing[1].length >= match[1].length) {
        blocks.push(lines.slice(index + 1, end).join('\n'));
        index = end;
        break;
      }
    }
  }
  return blocks;
}

test('renderRecord is deterministic and emits the sections in contract order', () => {
  const input = recordInput({
    findings: [{ id: 'F1', raisedBy: ['codex'], verdict: 'confirmed', summary: 'ok', evidence: 'E:/logs/a.txt' }],
    bridgeTasks: [backendTaskFixture()],
    peerJobs: [peerJobFixture()],
  });
  const first = renderRecord(input);
  const second = renderRecord(input);
  assert.equal(first, second);

  const sections = ['# Root task record', '## 结论', '## 交叉验证', '## DSH 任务', '## Peer 调用', '## 会话清理'];
  const positions = sections.map((heading) => first.indexOf(heading));
  for (const position of positions) assert.ok(position >= 0, `missing section in output:\n${first}`);
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted);
  assert.match(first, /^# Root task record\n/);

  // Chatty peer prose stayed verbatim.
  const peerSection = first.slice(first.indexOf('## Peer 调用'));
  assert.ok(peerSection.includes('#### 请求'));
  assert.ok(peerSection.includes('#### 答复全文'));
  assert.ok(peerSection.includes('```\nPlease review the diff.\n```'));
  assert.ok(peerSection.includes('```\nPROMPT: looks correct.\nNo blockers.\n```'));
});

test('renderRecord front block parses back with sessions and ids', () => {
  const input = recordInput({
    findings: [],
    bridgeTasks: [backendTaskFixture()],
    peerJobs: [peerJobFixture()],
  });
  const markdown = renderRecord(input);
  const blocks = fencedBlocks(markdown, 'json agent-bridge-record');
  assert.equal(blocks.length, 1);
  const front = JSON.parse(blocks[0]);
  assert.deepEqual(front, {
    recordId: 'rec-001',
    rootTask: 'task-1',
    title: 'Root task record',
    projectRoot: 'E:/repo',
    controller: 'claude-code',
    chain: 'claude-code',
    closedAt: new Date(CLOSED_AT).toISOString(),
    outcome: 'accepted',
    keep: false,
    eligibleAt: new Date(ELIGIBLE_AT).toISOString(),
    bridgeTaskIds: ['t-1'],
    peerJobIds: ['peer-1700000000000-abcdef01'],
    sessions: [
      { harness: 'dsh', id: 'sess-dsh-1', source: 't-1' },
      { harness: 'codex', id: 'sess-peer-1', source: 'peer-1700000000000-abcdef01' },
    ],
  });
  // A 7-backtick run in a stored text forces an 8-backtick fence around it.
  const tricky = { ...input, bridgeTasks: [{ ...backendTaskFixture(), resultText: `a ${SEVEN_TICKS} b` }] };
  const trickyMarkdown = renderRecord(tricky);
  const EIGHT = '`'.repeat(8);
  assert.ok(trickyMarkdown.includes(`${EIGHT}\na ${SEVEN_TICKS} b\n${EIGHT}`));
  assert.equal(trickyMarkdown.includes(`${SEVEN_TICKS}\na `), false);
});

test('renderRecord escapes pipes and newlines inside the findings table', () => {
  const markdown = renderRecord(recordInput({
    findings: [{
      id: 'F-1',
      raisedBy: ['codex', 'claude-code'],
      verdict: 'refuted',
      summary: 'a|b',
      evidence: 'line1\nline2',
    }],
  }));
  assert.ok(markdown.includes('| 编号 | 提出方 | 结论 | 说明 | 证据 |'));
  assert.ok(markdown.includes('| F-1 | codex、claude-code | refuted | a\\|b | line1<br>line2 |'));
  // The raw newline never reaches the table row.
  assert.equal(markdown.includes('| a|b |'), false);
});

test('renderRecord renders missing data as （无） and keeps titles inside their fence', () => {
  const markdown = renderRecord(recordInput({
    chain: ['claude-code'],
    findings: [],
    bridgeTasks: [{ dossier: { taskId: 't-2', title: 'Sparse' }, resultText: null }],
    peerJobs: [{ job: { jobId: 'peer-2', target: 'codex', mode: 'consult', status: 'failed', errors: ['boom'] }, promptText: null, finalMessage: null }],
  }));
  assert.ok(markdown.includes('（无）'));
  assert.ok(markdown.includes('- 错误: boom'));
  assert.ok(markdown.includes('### codex · consult (peer-2)'));
  const dsh = markdown.slice(markdown.indexOf('## DSH 任务'), markdown.indexOf('## Peer 调用'));
  assert.ok(dsh.includes('#### 结果全文'));
  assert.ok(dsh.includes('（无）'));
  assert.equal(markdown.includes('## 交叉验证'), false);
  assert.ok(markdown.includes('- 可清理时间: ' + new Date(ELIGIBLE_AT).toISOString()));
});

// ---------------------------------------------------------------------------
// writeRecord
// ---------------------------------------------------------------------------

test('writeRecord writes atomically, returns the real sha256, and refuses overwrite', async () => {
  await withTempDir('agent-bridge-records-', async (projectRoot) => {
    const content = '# 记录\n\n正文 with `backticks`.\n';
    const result = await writeRecord({ projectRoot, fileName: 'a.md', content });
    const expectedPath = path.join(projectRoot, '.agent-bridge', 'records', 'a.md');
    assert.equal(result.path, expectedPath);
    assert.equal(result.sha256, createHash('sha256').update(content, 'utf8').digest('hex'));
    assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(await readFile(expectedPath, 'utf8'), content);
    // No temp files are left behind.
    const entries = await readdir(path.dirname(expectedPath));
    assert.deepEqual(entries, ['a.md']);

    await assert.rejects(
      () => writeRecord({ projectRoot, fileName: 'a.md', content: 'other' }),
      { code: 'PEER_RECORD_EXISTS' },
    );
    assert.equal(await readFile(expectedPath, 'utf8'), content);

    const custom = await writeRecord({ projectRoot, dirName: 'records-2', fileName: 'b.md', content: 'x' });
    assert.equal(custom.path, path.join(projectRoot, 'records-2', 'b.md'));
    assert.equal(custom.bytes, 1);

    await assert.rejects(() => writeRecord({ projectRoot, fileName: '../escape.md', content: 'x' }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(() => writeRecord({ projectRoot: 'relative', fileName: 'a.md', content: 'x' }), { code: 'PEER_ARGS_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

test('appendIndexEvent writes one JSON line and validates the kind', async () => {
  await withTempDir('agent-bridge-index-', async (stateDir) => {
    const at = 1_700_000_000_000;
    const recordEvent = {
      kind: 'record',
      recordId: 'rec-001',
      rootTask: 'task-1',
      title: 'Title',
      projectRoot: 'E:/repo',
      path: 'E:/repo/.agent-bridge/records/a.md',
      sha256: 'deadbeef',
      outcome: 'accepted',
      keep: false,
      closedAt: CLOSED_AT,
      eligibleAt: ELIGIBLE_AT,
      sessions: [
        { harness: 'dsh', id: 'sess-dsh-1', source: 't-1' },
        { harness: 'codex', id: 'sess-peer-1', source: 'peer-1' },
      ],
    };
    const appended = await appendIndexEvent(stateDir, recordEvent, { now: () => at });
    assert.equal(appended.at, at);
    await appendIndexEvent(stateDir, { kind: 'session', recordId: 'rec-001', harness: 'dsh', id: 'sess-dsh-1', state: 'deleted', note: 'swept', at: at + 5 }, { now: () => at + 9 });

    const raw = await readFile(path.join(stateDir, 'records-index.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).kind, 'record');
    assert.equal(JSON.parse(lines[0]).at, at);
    assert.equal(JSON.parse(lines[1]).state, 'deleted');
    // `{at, ...event}`: an explicit event.at survives.
    assert.equal(JSON.parse(lines[1]).at, at + 5);

    await assert.rejects(() => appendIndexEvent(stateDir, { kind: 'other', recordId: 'x' }), { code: 'PEER_ARGS_INVALID' });
    await assert.rejects(() => appendIndexEvent(stateDir, { recordId: 'x' }), { code: 'PEER_ARGS_INVALID' });
    assert.equal((await readFile(path.join(stateDir, 'records-index.jsonl'), 'utf8')).split('\n').filter((line) => line !== '').length, 2);
  });
});

test('readIndex folds record and session events and counts skipped lines', async () => {
  await withTempDir('agent-bridge-index-', async (stateDir) => {
    const file = path.join(stateDir, 'records-index.jsonl');
    await writeFile(file, [
      JSON.stringify({
        at: 10,
        kind: 'record',
        recordId: 'rec-001',
        rootTask: 'task-1',
        title: 'Title',
        projectRoot: 'E:/repo',
        path: 'E:/repo/a.md',
        sha256: 'deadbeef',
        outcome: 'accepted',
        keep: false,
        closedAt: CLOSED_AT,
        eligibleAt: ELIGIBLE_AT,
        sessions: [
          { harness: 'dsh', id: 'sess-dsh-1', source: 't-1' },
          { harness: 'codex', id: 'sess-peer-1', source: 'peer-1' },
        ],
      }),
      JSON.stringify({ at: 11, kind: 'session', recordId: 'rec-001', harness: 'dsh', id: 'sess-dsh-1', state: 'deleted', note: 'swept' }),
      JSON.stringify({ at: 12, kind: 'record', recordId: 'rec-002', rootTask: 'task-2', title: 'Keep me', keep: true, eligibleAt: null, sessions: [] }),
      JSON.stringify({ at: 13, kind: 'session', recordId: 'rec-999', harness: 'dsh', id: 'ghost', state: 'deleted' }),
      '{ this is not json',
      JSON.stringify({ at: 14, kind: 'bogus', recordId: 'rec-003' }),
      JSON.stringify({ at: 15, kind: 'record', title: 'no id' }),
      'null',
      '',
    ].join('\n'), 'utf8');

    const index = await readIndex(stateDir);
    assert.equal(index.size, 2);
    assert.equal(index.skipped, 4);

    const first = index.get('rec-001');
    assert.equal(first.rootTask, 'task-1');
    assert.equal(first.outcome, 'accepted');
    assert.equal(first.keep, false);
    assert.equal(first.path, 'E:/repo/a.md');
    assert.equal(first.sha256, 'deadbeef');
    assert.equal(first.sessions.size, 2);
    const deleted = first.sessions.get('dsh\u0000sess-dsh-1');
    assert.equal(deleted.source, 't-1');
    assert.equal(deleted.state, 'deleted');
    assert.equal(deleted.note, 'swept');
    assert.equal(deleted.at, 11);
    const untouched = first.sessions.get('codex\u0000sess-peer-1');
    assert.equal(untouched.state, 'pending');
    assert.equal(untouched.note, null);
    assert.equal(untouched.at, null);

    const second = index.get('rec-002');
    assert.equal(second.keep, true);
    assert.equal(second.eligibleAt, null);
    assert.equal(second.sessions.size, 0);
  });
});

test('readIndex on a missing index file is an empty index', async () => {
  await withTempDir('agent-bridge-index-', async (stateDir) => {
    const index = await readIndex(stateDir);
    assert.equal(index.size, 0);
    assert.equal(index.skipped, 0);
    assert.equal(index instanceof Map, true);
  });
});
