/**
 * Tests for src/workspaces.mjs (CONTRACTS.md - Workspace module).
 *
 * Every test uses real temporary git repositories and the real git binary; child
 * processes are captured through file descriptors because the DSH sandbox forbids
 * piped stdio for spawned children ("no named pipes").
 *
 * Git discovery order: $DSH_WORKSPACES_GIT, `git` on PATH, common install paths,
 * then the git bundled with the Codex primary runtime.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceManager } from '../src/workspaces.mjs';

const CODES = WorkspaceManager.ERROR_CODES;
const NODE = process.execPath;
// Canonical fixtures: the workspace manager fences and reports canonical paths
// (`realpathSync.native`), which also expands Windows 8.3 short names, so every temp
// directory the assertions compare against is created through the same canonicalization.
const TMP_BASE = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-suite-')));
const CAPTURES = path.join(TMP_BASE, 'captures');
mkdirSync(CAPTURES, { recursive: true });

const cleanupTargets = [];

function track(directory) {
  cleanupTargets.push(directory);
  return directory;
}

after(() => {
  for (const directory of cleanupTargets) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  rmSync(TMP_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/* ------------------------------------------------------------------ *
 * git discovery and safe process helpers
 * ------------------------------------------------------------------ */

function gitCandidates() {
  const candidates = [];
  if (process.env.DSH_WORKSPACES_GIT) candidates.push(process.env.DSH_WORKSPACES_GIT);
  candidates.push('git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe');
  const cacheRoots = [path.join(os.homedir(), '.cache', 'codex-runtimes')];
  for (const root of cacheRoots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      candidates.push(path.join(root, entry, 'dependencies', 'native', 'git', 'cmd', 'git.exe'));
    }
  }
  return candidates;
}

function findGit() {
  for (const candidate of gitCandidates()) {
    let probe;
    try {
      probe = run(candidate, ['--version'], { allowFailure: true });
    } catch {
      continue;
    }
    if (probe.status === 0 && /git version/.test(probe.stdout)) return candidate;
  }
  throw new Error('no usable git executable found; set DSH_WORKSPACES_GIT');
}

let runCounter = 0;

function run(command, args, { cwd, allowFailure = false } = {}) {
  const id = `${process.pid}-${runCounter}-${randomUUID()}`;
  runCounter += 1;
  const outFile = path.join(CAPTURES, `${id}.out`);
  const errFile = path.join(CAPTURES, `${id}.err`);
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(command, args, {
      cwd,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: 60_000
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(outFile, 'utf8');
  const stderr = readFileSync(errFile, 'utf8');
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`command failed (${result.status}): ${command} ${args.join(' ')}\n${stderr || stdout}`);
  }
  return { status: result.status, stdout, stderr };
}

function git(args, options = {}) {
  return run(GIT, args, options);
}

const GIT = findGit();

async function expectCode(code, fn) {
  let error = null;
  try {
    await fn();
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, `expected failure with code ${code}, but the call succeeded`);
  assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
  return error;
}

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

function writeRepoFile(directory, relative, content) {
  const target = path.join(directory, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeRepo(files = { 'a.txt': 'base\n' }) {
  const directory = realpathSync.native(track(mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-repo-'))));
  git(['init', '-q', '-b', 'main', directory]);
  git(['-C', directory, 'config', 'user.name', 'Test Worker']);
  git(['-C', directory, 'config', 'user.email', 'test@local']);
  git(['-C', directory, 'config', 'commit.gpgsign', 'false']);
  for (const [relative, content] of Object.entries(files)) writeRepoFile(directory, relative, content);
  git(['-C', directory, 'add', '-A']);
  git(['-C', directory, 'commit', '-q', '-m', 'base']);
  return { dir: directory, top: realpathSync.native(directory) };
}

function makeRoot() {
  return realpathSync.native(track(mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-root-'))));
}

function manager(root, options = {}) {
  return new WorkspaceManager({ root, git: GIT, ...options });
}

async function scenario({ taskId = 'task-1', branchName, baseRef = 'main', files } = {}) {
  const repo = makeRepo(files);
  const root = makeRoot();
  const mgr = manager(root);
  const ws = await mgr.create({
    taskId,
    repository: repo.top,
    baseRef,
    ...(branchName === undefined ? {} : { branchName })
  });
  return { repo, root, mgr, ws, taskId };
}

function commitFiles(directory, files, message) {
  for (const [relative, content] of Object.entries(files)) writeRepoFile(directory, relative, content);
  git(['-C', directory, 'add', '-A']);
  git(['-C', directory, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
  return git(['-C', directory, 'rev-parse', 'HEAD']).stdout.trim();
}

function headOf(directory) {
  return git(['-C', directory, 'rev-parse', 'HEAD']).stdout.trim();
}

function porcelainOf(directory) {
  return git(['-C', directory, 'status', '--porcelain']).stdout.trim();
}

function worktreePaths(repoTop) {
  return git(['-C', repoTop, 'worktree', 'list', '--porcelain'])
    .stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).replace(/\\/g, '/').toLowerCase());
}

function normalised(target) {
  return target.replace(/\\/g, '/').toLowerCase();
}

const OUTSIDE_ROOT = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

function readsFeature(directory) {
  return readFileSync(path.join(directory, 'feature.txt'), 'utf8').replace(/\r\n/g, '\n');
}

function stateFileOf(root) {
  return path.join(root, '.dsh-workspaces', 'ownership.json');
}

/* ------------------------------------------------------------------ *
 * create
 * ------------------------------------------------------------------ */

test('create: worktree at the exact base commit, contract shape, persisted ownership', async () => {
  const { repo, root, mgr, ws } = await scenario({ taskId: 'task-create' });
  assert.deepEqual(Object.keys(ws).sort(), ['baseCommit', 'branch', 'path', 'repository', 'taskId']);
  assert.equal(ws.taskId, 'task-create');
  assert.equal(ws.branch, 'task/task-create');
  assert.equal(ws.repository, repo.top);
  assert.equal(ws.baseCommit, headOf(repo.top));
  assert.ok(path.isAbsolute(ws.path));
  assert.ok(ws.path.toLowerCase().startsWith(root.toLowerCase()));
  assert.equal(headOf(ws.path), ws.baseCommit);
  assert.equal(git(['-C', ws.path, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'task/task-create');
  assert.ok(worktreePaths(repo.top).includes(normalised(ws.path)));
  const state = JSON.parse(readFileSync(stateFileOf(root), 'utf8'));
  assert.equal(state.workspaces['task-create'].path, ws.path);
  assert.equal(normalised(state.workspaces['task-create'].gitCommonDir), normalised(path.join(repo.top, '.git')));
  const clean = await mgr.inspect(ws);
  assert.deepEqual(clean, { head: ws.baseCommit, dirty: false, changedPaths: [] });
});

test('create: honours an explicit branchName', async () => {
  const { repo, ws } = await scenario({ taskId: 'task-named', branchName: 'work/named-branch' });
  assert.equal(ws.branch, 'work/named-branch');
  assert.equal(git(['-C', ws.path, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'work/named-branch');
  assert.equal(ws.repository, repo.top);
});

test('create: idempotent for the same request and fail-closed on conflicts', async () => {
  const { repo, root, mgr, ws, taskId } = await scenario({ taskId: 'task-idem' });
  const again = await mgr.create({ taskId, repository: repo.top, baseRef: 'main' });
  assert.deepEqual(again, ws);
  await expectCode(CODES.WORKSPACE_EXISTS, () =>
    mgr.create({ taskId, repository: repo.top, baseRef: 'main', branchName: 'task/other-branch' })
  );
  await expectCode(CODES.BRANCH_EXISTS, () =>
    mgr.create({ taskId: 'task-other', repository: repo.top, baseRef: 'main', branchName: ws.branch })
  );
  // a foreign branch that already exists at a different commit must be refused, not reset
  git(['-C', ws.path, 'checkout', '-q', '-b', 'unused/conflict']);
  const foreignCommit = commitFiles(ws.path, { 'conflict.txt': 'x\n' }, 'conflict');
  git(['-C', ws.path, 'checkout', '-q', ws.branch]);
  assert.equal(headOf(ws.path), ws.baseCommit);
  await expectCode(CODES.BRANCH_EXISTS, () =>
    mgr.create({ taskId: 'task-third', repository: repo.top, baseRef: 'main', branchName: 'unused/conflict' })
  );
  assert.equal(headOf(repo.top), ws.baseCommit);
  assert.equal(git(['-C', repo.top, 'rev-parse', 'refs/heads/unused/conflict']).stdout.trim(), foreignCommit);
  assert.deepEqual(worktreePaths(repo.top), [normalised(repo.top), normalised(ws.path)]);
  // a stale ownership record (worktree disappeared) is refused, never pruned or recreated
  rmSync(ws.path, { recursive: true, force: true });
  await expectCode(CODES.WORKSPACE_EXISTS, () => mgr.create({ taskId, repository: repo.top, baseRef: 'main' }));
  assert.equal(existsSync(ws.path), false);
  assert.equal(JSON.parse(readFileSync(stateFileOf(root), 'utf8')).workspaces[taskId].path, ws.path);
});

test('create: validates untrusted inputs without creating anything', async () => {
  const repo = makeRepo();
  const root = makeRoot();
  const mgr = manager(root);
  const base = { taskId: 'task-validate', repository: repo.top, baseRef: 'main' };
  await expectCode(CODES.INVALID_TASK_ID, () => mgr.create({ ...base, taskId: '../escape' }));
  await expectCode(CODES.INVALID_TASK_ID, () => mgr.create({ ...base, taskId: 'a/b' }));
  await expectCode(CODES.INVALID_TASK_ID, () => mgr.create({ ...base, taskId: 'CON' }));
  await expectCode(CODES.INVALID_TASK_ID, () => mgr.create({ ...base, taskId: 'trailing.' }));
  await expectCode(CODES.INVALID_TASK_ID, () => mgr.create({ ...base, taskId: '   ' }));
  await expectCode(CODES.INVALID_REPOSITORY, () => mgr.create({ ...base, repository: 'relative/repo' }));
  await expectCode(CODES.INVALID_REPOSITORY, () => mgr.create({ ...base, repository: path.join(root, 'missing') }));
  await expectCode(CODES.INVALID_REPOSITORY, () => mgr.create({ ...base, repository: root }));
  await expectCode(CODES.INVALID_BASE_REF, () => mgr.create({ ...base, baseRef: '--upload-pack=evil' }));
  await expectCode(CODES.INVALID_BASE_REF, () => mgr.create({ ...base, baseRef: 'no-such-ref' }));
  await expectCode(CODES.INVALID_BRANCH, () => mgr.create({ ...base, branchName: 'bad name' }));
  await expectCode(CODES.INVALID_BRANCH, () => mgr.create({ ...base, branchName: 'bad..name' }));
  await expectCode(CODES.INVALID_CREATE_INPUT, () => mgr.create(null));
  assert.equal(worktreePaths(repo.top).length, 1);
  assert.equal(existsSync(stateFileOf(root)), false);
  assert.equal(porcelainOf(repo.top), '');
  // extra packet fields are ignored: the root forwards the whole packet.workspace object
  const created = await mgr.create({ ...base, metadata: { note: 'ignored' }, branchName: undefined });
  assert.equal(created.taskId, base.taskId);
  assert.equal(created.branch, 'task/task-validate');
  assert.equal(headOf(created.path), created.baseCommit);
});

/* ------------------------------------------------------------------ *
 * inspect
 * ------------------------------------------------------------------ */

test('inspect: reports head, dirty flag and every changed path', async () => {
  const { ws, mgr } = await scenario({ taskId: 'task-inspect' });
  const clean = await mgr.inspect(ws);
  assert.deepEqual(Object.keys(clean).sort(), ['changedPaths', 'dirty', 'head']);
  assert.equal(clean.head, ws.baseCommit);
  assert.equal(clean.dirty, false);
  assert.deepEqual(clean.changedPaths, []);

  writeRepoFile(ws.path, 'a.txt', 'modified\n');
  writeRepoFile(ws.path, 'nested/new.txt', 'new\n');
  const dirty = await mgr.inspect(ws);
  assert.equal(dirty.dirty, true);
  assert.deepEqual(dirty.changedPaths, ['a.txt', 'nested/new.txt']);

  commitFiles(ws.path, {}, 'record changes');
  git(['-C', ws.path, 'mv', 'a.txt', 'renamed.txt']);
  const renamed = await mgr.inspect(ws);
  assert.equal(renamed.head, headOf(ws.path));
  assert.deepEqual(renamed.changedPaths, ['a.txt', 'renamed.txt']);
});

test('inspect: refuses paths that are not manager-owned', async () => {
  const { ws, mgr, repo, root } = await scenario({ taskId: 'task-owned' });
  const bystander = path.join(root, 'bystander');
  mkdirSync(bystander, { recursive: true });
  writeFileSync(path.join(bystander, 'keep.txt'), 'keep');
  await expectCode(CODES.NOT_OWNED, () => mgr.inspect({ path: repo.top }));
  await expectCode(CODES.NOT_OWNED, () => mgr.inspect({ path: root }));
  await expectCode(CODES.NOT_OWNED, () => mgr.inspect({ path: bystander }));
  await expectCode(CODES.NOT_OWNED, () => mgr.inspect({}));
  await expectCode(CODES.NOT_OWNED, () => mgr.inspect({ path: 'relative/path' }));
  await expectCode(CODES.UNKNOWN_WORKSPACE, () => mgr.inspect({ path: path.join(root, 'gone') }));
  await expectCode(CODES.WORKSPACE_MISMATCH, () => mgr.inspect({ ...ws, taskId: 'someone-else' }));
  assert.equal(existsSync(path.join(bystander, 'keep.txt')), true);
});

/* ------------------------------------------------------------------ *
 * review
 * ------------------------------------------------------------------ */

test('review: binds to the exact head and returns a deeply frozen record', async () => {
  const { ws, mgr } = await scenario({ taskId: 'task-review' });
  const head = commitFiles(ws.path, { 'work.txt': 'work\n' }, 'work');
  const record = await mgr.review(ws, { head, contractVersion: 'v1', passed: true, checks: [] });
  assert.equal(record.head, head);
  assert.equal(record.contractVersion, 'v1');
  assert.equal(record.passed, true);
  assert.equal(record.requestedPassed, true);
  assert.equal(record.checksPassed, true);
  assert.equal(record.dirty, false);
  assert.equal(record.taskId, 'task-review');
  assert.equal(record.workspacePath, ws.path);
  assert.equal(record.branch, ws.branch);
  assert.equal(record.baseCommit, ws.baseCommit);
  assert.deepEqual(record.checks, []);
  assert.equal(record.kind, 'workspace-review');
  assert.ok(Number.isSafeInteger(record.reviewedAt));
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.checks));
  assert.ok(Object.isFrozen(record.changedPaths));
  assert.throws(() => {
    record.passed = false;
  }, TypeError);
  assert.throws(() => {
    record.checks.push({});
  }, TypeError);
  assert.equal(JSON.parse(JSON.stringify(record)).head, head);

  const next = commitFiles(ws.path, { 'work.txt': 'work2\n' }, 'work2');
  await expectCode(CODES.HEAD_MISMATCH, () =>
    mgr.review(ws, { head, contractVersion: 'v1', passed: true, checks: [] })
  );
  await expectCode(CODES.INVALID_REVIEW, () =>
    mgr.review(ws, { head: next.slice(0, 7), contractVersion: 'v1', passed: true, checks: [] })
  );
  await expectCode(CODES.INVALID_REVIEW, () => mgr.review(ws, { head: next, contractVersion: '', passed: true }));
  await expectCode(CODES.INVALID_REVIEW, () => mgr.review(ws, { head: next, contractVersion: 'v1', passed: 'yes' }));
  // extra fields are tolerated (the root MCP dispatcher forwards its full argument object)
  const tolerant = await mgr.review(ws, {
    taskId: 'task-review',
    head: next,
    contractVersion: 'v1',
    passed: true,
    checks: [],
    metadata: { ignored: true }
  });
  assert.equal(tolerant.head, next);
  assert.equal(tolerant.passed, true);
  await expectCode(CODES.WORKSPACE_MISMATCH, () =>
    mgr.review(ws, { taskId: 'some-other-task', head: next, contractVersion: 'v1', passed: true })
  );
});

test('review: runs checks in the workspace, no shell, exact evidence', async () => {
  const { ws, mgr } = await scenario({ taskId: 'task-checks' });
  const head = commitFiles(ws.path, { 'x.txt': 'x\n' }, 'x');
  const record = await mgr.review(ws, {
    head,
    contractVersion: 'v1',
    passed: true,
    checks: [{ command: NODE, args: ['-e', 'process.stdout.write("check-ok")'] }]
  });
  assert.equal(record.passed, true);
  assert.equal(record.checks.length, 1);
  const [entry] = record.checks;
  assert.equal(entry.ok, true);
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.phase, 'review');
  assert.equal(entry.cwd, ws.path);
  assert.equal(entry.stdoutBytes, 8);
  assert.equal(entry.stdoutTail, 'check-ok');
  assert.equal(entry.stdoutSha256, createHash('sha256').update('check-ok').digest('hex'));

  const literal = await mgr.review(ws, {
    head,
    contractVersion: 'v1',
    passed: true,
    checks: [{ command: NODE, args: ['-e', 'process.stdout.write(process.argv[1])', 'a;b$(c)|d>e'] }]
  });
  assert.equal(literal.checks[0].stdoutTail, 'a;b$(c)|d>e');

  const failed = await mgr.review(ws, {
    head,
    contractVersion: 'v1',
    passed: true,
    checks: [{ command: NODE, args: ['-e', 'process.exit(3)'] }]
  });
  assert.equal(failed.requestedPassed, true);
  assert.equal(failed.checksPassed, false);
  assert.equal(failed.passed, false);
  assert.equal(failed.checks[0].ok, false);
  assert.equal(failed.checks[0].exitCode, 3);

  const timedOut = await mgr.review(ws, {
    head,
    contractVersion: 'v1',
    passed: true,
    checks: [{ command: NODE, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 400 }]
  });
  assert.equal(timedOut.checks[0].timedOut, true);
  assert.equal(timedOut.checks[0].ok, false);
  assert.equal(timedOut.passed, false);
  assert.ok(timedOut.checks[0].durationMs >= 300);
});

test('review: a dirty workspace can never pass', async () => {
  const { ws, mgr, repo } = await scenario({ taskId: 'task-dirty-review' });
  writeRepoFile(ws.path, 'untracked.txt', 'x\n');
  const record = await mgr.review(ws, { head: ws.baseCommit, contractVersion: 'v1', passed: true, checks: [] });
  assert.equal(record.dirty, true);
  assert.deepEqual(record.changedPaths, ['untracked.txt']);
  assert.equal(record.requestedPassed, true);
  assert.equal(record.passed, false);
  await expectCode(CODES.DIRTY, () =>
    mgr.integrate(ws, { targetRepository: repo.top, review: record, contractVersion: 'v1' })
  );
});

test('checks: unsupported command/args values are rejected, extra fields ignored', async () => {
  const { ws, mgr } = await scenario({ taskId: 'task-check-validation' });
  const head = commitFiles(ws.path, { 'c.txt': 'c\n' }, 'c');
  const reviewWith = (checks) => mgr.review(ws, { head, contractVersion: 'v1', passed: true, checks });
  // extra check fields are ignored and cannot redirect the working directory
  const tolerated = await reviewWith([
    { command: NODE, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: '/tmp', label: 'ignored' }
  ]);
  assert.equal(tolerated.checks[0].ok, true);
  assert.equal(tolerated.checks[0].cwd, ws.path);
  assert.equal(tolerated.checks[0].stdoutTail, ws.path);
  await expectCode(CODES.INVALID_CHECK, () => reviewWith([{ command: './relative/thing' }]));
  await expectCode(CODES.INVALID_CHECK, () => reviewWith([{ command: path.join(ws.path, 'missing.exe') }]));
  await expectCode(CODES.INVALID_CHECK, () => reviewWith([{ command: NODE, args: ['ok', 5] }]));
  await expectCode(CODES.INVALID_CHECK, () => reviewWith([{ command: NODE, timeoutMs: 10_000_000 }]));
  await expectCode(CODES.INVALID_CHECK, () => reviewWith([{ command: '' }]));
  await expectCode(CODES.INVALID_CHECK, () => reviewWith('not-an-array'));
});

/* ------------------------------------------------------------------ *
 * integrate
 * ------------------------------------------------------------------ */

test('integrate: fast-forwards the exact reviewed commit and reports exact evidence', async () => {
  const { ws, mgr, repo } = await scenario({ taskId: 'task-integrate' });
  const head = commitFiles(ws.path, { 'feature.txt': 'feature\n' }, 'feature');
  const review = await mgr.review(ws, {
    head,
    contractVersion: 'v1',
    passed: true,
    checks: [{ command: NODE, args: ['-e', 'process.exit(0)'] }]
  });
  const result = await mgr.integrate(ws, {
    // the root MCP dispatcher forwards its full argument object, including taskId
    taskId: 'task-integrate',
    targetRepository: repo.top,
    review,
    contractVersion: 'v1',
    checks: [{ command: NODE, args: ['-e', 'process.stdout.write(process.cwd())'] }]
  });
  assert.equal(result.merged, true);
  assert.equal(result.accepted, true);
  assert.equal(result.reason, null);
  assert.equal(result.reviewHead, head);
  assert.equal(result.baseCommit, ws.baseCommit);
  assert.equal(result.targetHeadBefore, ws.baseCommit);
  assert.equal(result.targetHeadAfter, head);
  assert.equal(result.targetRepository, repo.top);
  assert.equal(result.integrationRecorded, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.failedChecks, []);
  assert.deepEqual(
    result.checks.map((entry) => entry.phase),
    ['source', 'target-post']
  );
  assert.deepEqual(
    result.checks.map((entry) => entry.ok),
    [true, true]
  );
  assert.equal(result.checks[0].cwd, ws.path);
  assert.equal(result.checks[1].cwd, repo.top);
  assert.equal(result.checks[1].stdoutTail, repo.top);
  assert.equal(headOf(repo.top), head);
  assert.equal(readsFeature(repo.top), 'feature\n');

  // the target has already moved, so a repeat integration must be refused
  await expectCode(CODES.TARGET_MISMATCH, () =>
    mgr.integrate(ws, { targetRepository: repo.top, review, contractVersion: 'v1' })
  );
});

test('integrate: refuses a dirty source and leaves the target untouched', async () => {
  const { ws, mgr, repo } = await scenario({ taskId: 'task-dirty-source' });
  const head = commitFiles(ws.path, { 'f.txt': 'f\n' }, 'f');
  const review = await mgr.review(ws, { head, contractVersion: 'v1', passed: true, checks: [] });
  writeRepoFile(ws.path, 'uncommitted.txt', 'x\n');
  await expectCode(CODES.DIRTY, () =>
    mgr.integrate(ws, { targetRepository: repo.top, review, contractVersion: 'v1' })
  );
  assert.equal(headOf(repo.top), ws.baseCommit);
  assert.equal(porcelainOf(repo.top), '');
});

test('integrate: refuses a dirty target and a target that moved past the base', async () => {
  const dirty = await scenario({ taskId: 'task-dirty-target' });
  const head = commitFiles(dirty.ws.path, { 'f.txt': 'f\n' }, 'f');
  const review = await dirty.mgr.review(dirty.ws, { head, contractVersion: 'v1', passed: true, checks: [] });
  writeRepoFile(dirty.repo.top, 'untracked.txt', 'x\n');
  await expectCode(CODES.DIRTY, () =>
    dirty.mgr.integrate(dirty.ws, { targetRepository: dirty.repo.top, review, contractVersion: 'v1' })
  );
  assert.equal(headOf(dirty.repo.top), dirty.ws.baseCommit);

  const moved = await scenario({ taskId: 'task-target-moved' });
  const movedHead = commitFiles(moved.ws.path, { 'f.txt': 'f\n' }, 'f');
  const movedReview = await moved.mgr.review(moved.ws, {
    head: movedHead,
    contractVersion: 'v1',
    passed: true,
    checks: []
  });
  const advanced = commitFiles(moved.repo.top, { 'other.txt': 'other\n' }, 'other');
  await expectCode(CODES.TARGET_MISMATCH, () =>
    moved.mgr.integrate(moved.ws, { targetRepository: moved.repo.top, review: movedReview, contractVersion: 'v1' })
  );
  assert.equal(headOf(moved.repo.top), advanced);
});

test('integrate: refuses contract, review, head and workspace mismatches', async () => {
  const { ws, mgr, repo } = await scenario({ taskId: 'task-mismatch' });
  const head = commitFiles(ws.path, { 'f.txt': 'f\n' }, 'f');
  const review = await mgr.review(ws, {
    head,
    contractVersion: 'v1',
    passed: true,
    checks: [{ command: NODE, args: ['-e', 'process.exit(0)'] }]
  });
  await expectCode(CODES.INVALID_INTEGRATE_INPUT, () => mgr.integrate(ws, null));
  await expectCode(CODES.WORKSPACE_MISMATCH, () =>
    mgr.integrate(ws, { taskId: 'some-other-task', targetRepository: repo.top, review, contractVersion: 'v1' })
  );
  await expectCode(CODES.CONTRACT_MISMATCH, () =>
    mgr.integrate(ws, { targetRepository: repo.top, review, contractVersion: 'v2' })
  );
  await expectCode(CODES.INVALID_REVIEW, () => mgr.integrate(ws, { targetRepository: repo.top, contractVersion: 'v1' }));
  await expectCode(CODES.REVIEW_FAILED, () =>
    mgr.integrate(ws, {
      targetRepository: repo.top,
      review: { ...review, passed: false },
      contractVersion: 'v1'
    })
  );
  await expectCode(CODES.CHECK_FAILED, () =>
    mgr.integrate(ws, {
      targetRepository: repo.top,
      review: { ...review, checks: [{ ...review.checks[0], ok: false }] },
      contractVersion: 'v1'
    })
  );
  await expectCode(CODES.WORKSPACE_MISMATCH, () =>
    mgr.integrate(ws, {
      targetRepository: repo.top,
      review: { ...review, taskId: 'some-other-task' },
      contractVersion: 'v1'
    })
  );
  await expectCode(CODES.REPOSITORY_MISMATCH, () =>
    mgr.integrate(ws, { targetRepository: makeRepo().top, review, contractVersion: 'v1' })
  );
  await expectCode(CODES.TARGET_MISMATCH, () =>
    mgr.integrate(ws, { targetRepository: ws.path, review, contractVersion: 'v1' })
  );
  commitFiles(ws.path, { 'later.txt': 'later\n' }, 'later');
  await expectCode(CODES.HEAD_MISMATCH, () =>
    mgr.integrate(ws, { targetRepository: repo.top, review, contractVersion: 'v1' })
  );
  assert.equal(headOf(repo.top), ws.baseCommit);
  assert.equal(porcelainOf(repo.top), '');
});

test('integrate: failing checks can never report merged or accepted', async () => {
  const source = await scenario({ taskId: 'task-source-check-fail' });
  const sourceHead = commitFiles(source.ws.path, { 'f.txt': 'f\n' }, 'f');
  const sourceReview = await source.mgr.review(source.ws, {
    head: sourceHead,
    contractVersion: 'v1',
    passed: true,
    checks: []
  });
  const sourceResult = await source.mgr.integrate(source.ws, {
    targetRepository: source.repo.top,
    review: sourceReview,
    contractVersion: 'v1',
    checks: [{ command: NODE, args: ['-e', 'process.exit(9)'] }]
  });
  assert.equal(sourceResult.merged, false);
  assert.equal(sourceResult.accepted, false);
  assert.equal(sourceResult.reason, 'source_checks_failed');
  assert.equal(sourceResult.targetHeadAfter, null);
  assert.deepEqual(
    sourceResult.failedChecks.map((entry) => entry.phase),
    ['source']
  );
  assert.equal(headOf(source.repo.top), source.ws.baseCommit);
  assert.equal(porcelainOf(source.repo.top), '');

  const target = await scenario({ taskId: 'task-target-check-fail' });
  const targetHead = commitFiles(target.ws.path, { 'f.txt': 'f\n' }, 'f');
  const targetReview = await target.mgr.review(target.ws, {
    head: targetHead,
    contractVersion: 'v1',
    passed: true,
    checks: []
  });
  const targetResult = await target.mgr.integrate(target.ws, {
    targetRepository: target.repo.top,
    review: targetReview,
    contractVersion: 'v1',
    baselineChecks:[{command:NODE,args:['-e','process.exit(9)']}],
    checks: [
      {
        command: NODE,
        args: ['-e', 'process.exit(process.cwd() === process.argv[1] ? 9 : 0)', target.repo.top]
      }
    ]
  });
  assert.equal(targetResult.merged, false);
  assert.equal(targetResult.accepted, false);
  assert.equal(targetResult.reason, 'target_checks_failed');
  assert.deepEqual(
    targetResult.checks.map((entry) => entry.phase),
    ['source', 'target']
  );
  assert.deepEqual(
    targetResult.failedChecks.map((entry) => entry.phase),
    ['target']
  );
  assert.equal(headOf(target.repo.top), target.ws.baseCommit);
  assert.equal(porcelainOf(target.repo.top), '');
});

test('integrate: refuses a non-fast-forward head without modifying the target', async () => {
  const { ws, mgr, repo } = await scenario({ taskId: 'task-non-ff' });
  git(['-C', repo.top, 'checkout', '-q', '--orphan', 'orphan-branch']);
  git(['-C', repo.top, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'orphan']);
  const orphan = headOf(repo.top);
  git(['-C', repo.top, 'checkout', '-q', 'main']);
  assert.equal(headOf(repo.top), ws.baseCommit);
  git(['-C', ws.path, 'reset', '-q', '--hard', orphan]);
  const head = headOf(ws.path);
  assert.notEqual(head, ws.baseCommit);
  const review = await mgr.review(ws, { head, contractVersion: 'v1', passed: true, checks: [] });
  await expectCode(CODES.NOT_FAST_FORWARD, () =>
    mgr.integrate(ws, { targetRepository: repo.top, review, contractVersion: 'v1' })
  );
  assert.equal(headOf(repo.top), ws.baseCommit);
  assert.equal(porcelainOf(repo.top), '');
});

test('root call shapes: UUID task ids and MCP argument objects are accepted', async () => {
  const taskId = randomUUID();
  const repo = makeRepo();
  const root = makeRoot();
  // bootstrap.mjs: new WorkspaceManager({root: path.join(dataDirectory,'workspaces')});
  // production relies on the default `git: 'git'` from PATH, injected here because this
  // development sandbox has no git on PATH (see the missing-git test for that path).
  const mgr = new WorkspaceManager({ root: path.join(root, 'workspaces'), git: GIT });
  // service.mjs: create({taskId: id, ...packet.workspace})
  const ws = await mgr.create({ taskId, repository: repo.top, baseRef: 'main' });
  assert.equal(ws.taskId, taskId);
  assert.equal(ws.branch, `task/${taskId}`);
  assert.ok(path.isAbsolute(ws.path));
  assert.ok(normalised(ws.path).startsWith(`${normalised(root)}/workspaces/task-`));
  assert.equal(ws.repository, repo.top);
  const head = commitFiles(ws.path, { 'feature.txt': 'f\n' }, 'feature');
  // mcp.mjs: review(task.workspace, a) where a is the full tool argument object
  const review = await mgr.review(ws, { taskId, head, contractVersion: 'v1', passed: true, checks: [] });
  assert.equal(review.head, head);
  assert.equal(review.passed, true);
  assert.equal(review.workspacePath, ws.path);
  // mcp.mjs: integrate(task.workspace, {...a, review: task.review})
  const result = await mgr.integrate(ws, {
    taskId,
    targetRepository: repo.top,
    contractVersion: 'v1',
    checks: [],
    review
  });
  assert.equal(result.merged, true);
  assert.equal(result.accepted, true);
  assert.equal(result.targetHeadAfter, head);
  assert.equal(headOf(repo.top), head);
  // service.mjs remaps task roots from this returned path
  assert.equal(path.isAbsolute(result.workspacePath), true);
  assert.equal(existsSync(result.workspacePath), true);
});

/* ------------------------------------------------------------------ *
 * refresh (parallel same-baseline branches)
 * ------------------------------------------------------------------ */

test('refresh: rebases a parallel branch onto the new target head and invalidates the review', async () => {
  const repo = makeRepo();
  const root = makeRoot();
  const mgr = manager(root);
  const wsA = await mgr.create({ taskId: 'task-par-a', repository: repo.top, baseRef: 'main' });
  const wsB = await mgr.create({ taskId: 'task-par-b', repository: repo.top, baseRef: 'main' });
  const headA = commitFiles(wsA.path, { 'a.txt': 'a\n' }, 'a');
  const reviewA = await mgr.review(wsA, { head: headA, contractVersion: 'v1', passed: true, checks: [] });
  const mergedA = await mgr.integrate(wsA, { targetRepository: repo.top, review: reviewA, contractVersion: 'v1' });
  assert.equal(mergedA.accepted, true);
  const targetHead = headOf(repo.top);
  const headB = commitFiles(wsB.path, { 'b.txt': 'b\n' }, 'b');

  const refreshed = await mgr.refresh(wsB, {
    taskId: 'task-par-b',
    targetRepository: repo.top,
    expectedTargetHead: targetHead
  });
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.conflict, false);
  assert.equal(refreshed.reason, null);
  assert.equal(refreshed.rebased, true);
  assert.equal(refreshed.adopted, false);
  assert.equal(refreshed.reviewInvalidated, true);
  assert.equal(refreshed.previousBaseCommit, wsB.baseCommit);
  assert.equal(refreshed.baseCommit, targetHead);
  assert.equal(refreshed.targetHead, targetHead);
  assert.equal(refreshed.targetHeadUnchanged, true);
  assert.deepEqual(refreshed.workspace, {
    taskId: 'task-par-b',
    path: wsB.path,
    branch: wsB.branch,
    baseCommit: targetHead,
    repository: repo.top
  });
  assert.equal((await mgr.inspect(refreshed.workspace)).dirty, false);
  assert.equal((await mgr.inspect(refreshed.workspace)).head, refreshed.head);
  assert.notEqual(refreshed.head, headB);
  assert.equal(headOf(repo.top), targetHead);
  assert.equal(git(['-C', wsB.path, 'merge-base', '--is-ancestor', targetHead, 'HEAD']).status, 0);
  assert.equal(
    JSON.parse(readFileSync(stateFileOf(root), 'utf8')).workspaces['task-par-b'].baseCommit,
    targetHead
  );
  // callers must adopt the refreshed handle: the stale baseCommit handle is refused
  await expectCode(CODES.WORKSPACE_MISMATCH, () => mgr.inspect(wsB));
  const refreshedHandle = { ...wsB, ...refreshed.workspace };
  // the pre-refresh review is invalidated: it no longer binds to the live head
  await expectCode(CODES.HEAD_MISMATCH, () =>
    mgr.review(refreshedHandle, { head: headB, contractVersion: 'v1', passed: true })
  );
  // and the refreshed workspace can be reviewed and integrated consecutively
  const reviewB = await mgr.review(refreshedHandle, {
    head: refreshed.head,
    contractVersion: 'v1',
    passed: true,
    checks: []
  });
  const mergedB = await mgr.integrate(refreshedHandle, {
    targetRepository: repo.top,
    review: reviewB,
    contractVersion: 'v1'
  });
  assert.equal(mergedB.accepted, true);
  assert.equal(headOf(repo.top), refreshed.head);
});

test('refresh: conflict preserves the rebase scene and a second refresh detects it', async () => {
  const repo = makeRepo({ 'shared.txt': 'base\n' });
  const root = makeRoot();
  const mgr = manager(root);
  const wsA = await mgr.create({ taskId: 'task-cf-a', repository: repo.top, baseRef: 'main' });
  const wsB = await mgr.create({ taskId: 'task-cf-b', repository: repo.top, baseRef: 'main' });
  const headA = commitFiles(wsA.path, { 'shared.txt': 'from-a\n' }, 'a');
  const reviewA = await mgr.review(wsA, { head: headA, contractVersion: 'v1', passed: true, checks: [] });
  await mgr.integrate(wsA, { targetRepository: repo.top, review: reviewA, contractVersion: 'v1' });
  const targetHead = headOf(repo.top);
  commitFiles(wsB.path, { 'shared.txt': 'from-b\n' }, 'b');

  const conflict = await mgr.refresh(wsB, { targetRepository: repo.top, expectedTargetHead: targetHead });
  assert.equal(conflict.refreshed, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.reason, 'rebase_conflict');
  assert.equal(conflict.rebaseInProgress, true);
  assert.equal(conflict.dirty, true);
  assert.equal(conflict.baseCommit, wsB.baseCommit);
  assert.equal(conflict.previousBaseCommit, wsB.baseCommit);
  assert.equal(conflict.targetHead, targetHead);
  assert.equal(conflict.rebaseExitCode !== 0, true);
  assert.ok(conflict.changedPaths.includes('shared.txt'));
  assert.equal(existsSync(wsB.path), true);
  assert.equal(headOf(repo.top), targetHead);
  assert.equal(
    JSON.parse(readFileSync(stateFileOf(root), 'utf8')).workspaces['task-cf-b'].baseCommit,
    wsB.baseCommit
  );
  // the half-finished rebase is detected, never reset or aborted by the module
  await expectCode(CODES.REBASE_IN_PROGRESS, () =>
    mgr.refresh(wsB, { targetRepository: repo.top, expectedTargetHead: targetHead })
  );
  // the controller (or test fixture) decides how to resolve it
  git(['-C', wsB.path, 'rebase', '--abort']);
  assert.equal(porcelainOf(wsB.path), '');
});

test('refresh: adopts a branch the controller already rebased onto the target', async () => {
  const repo = makeRepo();
  const root = makeRoot();
  const mgr = manager(root);
  const wsA = await mgr.create({ taskId: 'task-ad-a', repository: repo.top, baseRef: 'main' });
  const wsB = await mgr.create({ taskId: 'task-ad-b', repository: repo.top, baseRef: 'main' });
  const headA = commitFiles(wsA.path, { 'a2.txt': 'a\n' }, 'a');
  const reviewA = await mgr.review(wsA, { head: headA, contractVersion: 'v1', passed: true, checks: [] });
  await mgr.integrate(wsA, { targetRepository: repo.top, review: reviewA, contractVersion: 'v1' });
  const targetHead = headOf(repo.top);
  commitFiles(wsB.path, { 'b2.txt': 'b\n' }, 'b');
  git(['-C', wsB.path, 'rebase', targetHead]);
  const headB = headOf(wsB.path);

  const refreshed = await mgr.refresh(wsB, { targetRepository: repo.top, expectedTargetHead: targetHead });
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.rebased, false);
  assert.equal(refreshed.adopted, true);
  assert.equal(refreshed.head, headB);
  assert.equal(refreshed.baseCommit, targetHead);
  assert.equal(refreshed.reviewInvalidated, true);
  assert.equal(JSON.parse(readFileSync(stateFileOf(root), 'utf8')).workspaces['task-ad-b'].baseCommit, targetHead);
});

test('refresh: validates repository identity, expected head and clean state', async () => {
  const repo = makeRepo();
  const root = makeRoot();
  const mgr = manager(root);
  const ws = await mgr.create({ taskId: 'task-rf-val', repository: repo.top, baseRef: 'main' });
  commitFiles(ws.path, { 'f.txt': 'f\n' }, 'f');
  await expectCode(CODES.INVALID_REFRESH_INPUT, () =>
    mgr.refresh(ws, { targetRepository: repo.top, expectedTargetHead: 'not-a-sha' })
  );
  await expectCode(CODES.TARGET_MISMATCH, () =>
    mgr.refresh(ws, { targetRepository: repo.top, expectedTargetHead: 'f'.repeat(40) })
  );
  await expectCode(CODES.REPOSITORY_MISMATCH, () =>
    mgr.refresh(ws, { targetRepository: makeRepo().top, expectedTargetHead: ws.baseCommit })
  );
  await expectCode(CODES.TARGET_MISMATCH, () =>
    mgr.refresh(ws, { targetRepository: ws.path, expectedTargetHead: ws.baseCommit })
  );
  await expectCode(CODES.WORKSPACE_MISMATCH, () =>
    mgr.refresh(ws, { taskId: 'some-other-task', targetRepository: repo.top, expectedTargetHead: ws.baseCommit })
  );
  writeRepoFile(ws.path, 'dirty.txt', 'x\n');
  await expectCode(CODES.DIRTY, () =>
    mgr.refresh(ws, { targetRepository: repo.top, expectedTargetHead: ws.baseCommit })
  );
  rmSync(path.join(ws.path, 'dirty.txt'), { force: true });
  writeRepoFile(repo.top, 'target-dirty.txt', 'x\n');
  await expectCode(CODES.DIRTY, () =>
    mgr.refresh(ws, { targetRepository: repo.top, expectedTargetHead: ws.baseCommit })
  );
});

/* ------------------------------------------------------------------ *
 * review / integrate TOCTOU
 * ------------------------------------------------------------------ */

test('review: checks that change the workspace can never pass or retarget the head', async () => {
  const { ws, mgr } = await scenario({ taskId: 'task-toctou-review' });
  const head = commitFiles(ws.path, { 'r.txt': 'r\n' }, 'r');
  const dirtying = await mgr.review(ws, {
    head,
    contractVersion: 'v1',
    passed: true,
    checks: [
      { command: NODE, args: ['-e', 'import("node:fs").then(fs => fs.writeFileSync("check-artifact.txt","x"))'] }
    ]
  });
  assert.equal(dirtying.checks[0].ok, true);
  assert.equal(dirtying.postCheckHead, head);
  assert.equal(dirtying.postCheckDirty, true);
  assert.equal(dirtying.dirty, true);
  assert.equal(dirtying.passed, false);
  assert.ok(dirtying.changedPaths.includes('check-artifact.txt'));
  rmSync(path.join(ws.path, 'check-artifact.txt'), { force: true });

  const commitCheck = [
    {
      command: NODE,
      args: [
        '-e',
        'import("node:child_process").then(cp => cp.spawnSync(process.argv[1], ["commit","--allow-empty","-m","toctou"], {stdio:"inherit"}))',
        GIT
      ]
    }
  ];
  await expectCode(CODES.HEAD_MISMATCH, () =>
    mgr.review(ws, { head, contractVersion: 'v1', passed: true, checks: commitCheck })
  );
});

test('integrate: a source check that changes the workspace is refused before the merge', async () => {
  const { ws, mgr, repo } = await scenario({ taskId: 'task-toctou-integrate' });
  const head = commitFiles(ws.path, { 'f.txt': 'f\n' }, 'f');
  const review = await mgr.review(ws, { head, contractVersion: 'v1', passed: true, checks: [] });
  await expectCode(CODES.DIRTY, () =>
    mgr.integrate(ws, {
      targetRepository: repo.top,
      review,
      contractVersion: 'v1',
      checks: [
        {
          command: NODE,
          args: ['-e', 'import("node:fs").then(fs => fs.writeFileSync("integrate-artifact.txt","x"))']
        }
      ]
    })
  );
  assert.equal(headOf(repo.top), ws.baseCommit);
  assert.equal(porcelainOf(repo.top), '');
});

test('integrate: post-merge target check failure reports merged true and accepted false', async () => {
  const { ws, mgr, repo } = await scenario({ taskId: 'task-postmerge' });
  const head = commitFiles(ws.path, { 'postmerge.txt': 'present after merge\n' }, 'postmerge');
  const review = await mgr.review(ws, { head, contractVersion: 'v1', passed: true, checks: [] });
  const result = await mgr.integrate(ws, {
    targetRepository: repo.top,
    review,
    contractVersion: 'v1',
    checks: [
      {
        command: NODE,
        args: [
          '-e',
          'import("node:fs").then(fs => process.exit(fs.existsSync("postmerge.txt") && process.cwd() === process.argv[1] ? 7 : 0))',
          repo.top
        ]
      }
    ]
  });
  assert.equal(result.merged, true);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'postmerge_target_checks_failed');
  assert.equal(result.targetHeadAfter, head);
  assert.equal(headOf(repo.top), head);
  assert.deepEqual(
    result.checks.map((entry) => entry.phase),
    ['source', 'target-post']
  );
  assert.deepEqual(
    result.failedChecks.map((entry) => entry.phase),
    ['target-post']
  );
  assert.equal(result.failedChecks[0].exitCode, 7);
  assert.equal(result.integrationRecorded, true);
  assert.ok(result.warnings.some((warning) => /post-merge/.test(warning)));
});

/* ------------------------------------------------------------------ *
 * remove
 *
 * `git worktree remove` internally probes the target with `git status` through a pipe.
 * Hosts that forbid child-process pipes (the DSH development sandbox does) cannot run
 * that probe, so the removal tests below fail there with `E_REMOVE_FAILED` while the
 * module correctly fails closed. They are expected to pass on a normal host. The test
 * "either removes completely or fails closed" documents that boundary in both hosts.
 * ------------------------------------------------------------------ */

test('remove: requires artifactState, refuses pinned, dirty and foreign targets', async () => {
  const { ws, mgr, root, repo } = await scenario({ taskId: 'task-remove-guard' });
  const bystander = path.join(root, 'bystander');
  mkdirSync(bystander, { recursive: true });
  writeFileSync(path.join(bystander, 'keep.txt'), 'keep');
  await expectCode(CODES.INVALID_ARTIFACT_STATE, () => mgr.remove(ws, {}));
  await expectCode(CODES.INVALID_REMOVE_INPUT, () => mgr.remove(ws));
  await expectCode(CODES.INVALID_ARTIFACT_STATE, () => mgr.remove(ws, { artifactState: 'kept' }));
  await expectCode(CODES.INVALID_PINNED, () => mgr.remove(ws, { artifactState: 'discarded', pinned: 'yes' }));
  await expectCode(CODES.PINNED, () => mgr.remove(ws, { artifactState: 'discarded', pinned: true }));
  writeRepoFile(ws.path, 'dirty.txt', 'x\n');
  await expectCode(CODES.DIRTY, () => mgr.remove(ws, { artifactState: 'discarded' }));
  assert.equal(existsSync(ws.path), true);
  rmSync(path.join(ws.path, 'dirty.txt'), { force: true });
  await expectCode(CODES.NOT_OWNED, () => mgr.remove({ path: bystander }, { artifactState: 'discarded' }));
  await expectCode(CODES.NOT_OWNED, () => mgr.remove({ path: repo.top }, { artifactState: 'discarded' }));
  await expectCode(CODES.WORKSPACE_MISMATCH, () => mgr.remove({ ...ws, baseCommit: 'f'.repeat(40) }, { artifactState: 'discarded' }));
  assert.equal(existsSync(path.join(bystander, 'keep.txt')), true);
  assert.equal(existsSync(ws.path), true);
});

test('remove: native worktree removal only, branch preserved, record pruned', async () => {
  const { ws, mgr, root, repo } = await scenario({ taskId: 'task-discard' });
  const head = commitFiles(ws.path, { 'f.txt': 'f\n' }, 'f');
  const bystander = path.join(root, 'bystander');
  mkdirSync(bystander, { recursive: true });
  writeFileSync(path.join(bystander, 'keep.txt'), 'keep');
  const result = await mgr.remove(ws, { artifactState: 'discarded' });
  assert.equal(result.removed, true);
  assert.equal(result.artifactState, 'discarded');
  assert.equal(result.head, head);
  assert.equal(result.path, ws.path);
  assert.equal(existsSync(ws.path), false);
  assert.equal(existsSync(path.join(bystander, 'keep.txt')), true);
  assert.equal(git(['-C', repo.top, 'rev-parse', `refs/heads/${ws.branch}`]).stdout.trim(), head);
  assert.equal(worktreePaths(repo.top).includes(ws.path.replace(/\\/g, '/').toLowerCase()), false);
  await expectCode(CODES.UNKNOWN_WORKSPACE, () => mgr.remove(ws, { artifactState: 'discarded' }));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(stateFileOf(root), 'utf8')).workspaces), []);
});

test('remove: "merged" needs collection evidence, "preserved" needs the branch', async () => {
  const empty = await scenario({ taskId: 'task-remove-empty' });
  const emptyResult = await empty.mgr.remove(empty.ws, { artifactState: 'merged' });
  assert.equal(emptyResult.removed, true);
  assert.equal(emptyResult.head, empty.ws.baseCommit);

  const uncollected = await scenario({ taskId: 'task-uncollected' });
  commitFiles(uncollected.ws.path, { 'f.txt': 'f\n' }, 'f');
  await expectCode(CODES.UNCOLLECTED, () => uncollected.mgr.remove(uncollected.ws, { artifactState: 'merged' }));

  const merged = await scenario({ taskId: 'task-merged' });
  const mergedHead = commitFiles(merged.ws.path, { 'f.txt': 'f\n' }, 'f');
  const mergedReview = await merged.mgr.review(merged.ws, {
    head: mergedHead,
    contractVersion: 'v1',
    passed: true,
    checks: []
  });
  await merged.mgr.integrate(merged.ws, {
    targetRepository: merged.repo.top,
    review: mergedReview,
    contractVersion: 'v1'
  });
  const mergedResult = await merged.mgr.remove(merged.ws, { artifactState: 'merged' });
  assert.equal(mergedResult.removed, true);
  assert.equal(headOf(merged.repo.top), mergedHead);

  const preserved = await scenario({ taskId: 'task-preserved' });
  const preservedHead = commitFiles(preserved.ws.path, { 'f.txt': 'f\n' }, 'f');
  const preservedResult = await preserved.mgr.remove(preserved.ws, { artifactState: 'preserved' });
  assert.equal(preservedResult.removed, true);
  assert.equal(git(['-C', preserved.repo.top, 'rev-parse', `refs/heads/${preserved.ws.branch}`]).stdout.trim(), preservedHead);

  const lost = await scenario({ taskId: 'task-lost-branch' });
  commitFiles(lost.ws.path, { 'f.txt': 'f\n' }, 'f');
  git(['-C', lost.ws.path, 'checkout', '-q', '--detach']);
  git(['-C', lost.repo.top, 'branch', '-D', lost.ws.branch]);
  await expectCode(CODES.UNCOLLECTED, () => lost.mgr.remove(lost.ws, { artifactState: 'preserved' }));
  const discarded = await lost.mgr.remove(lost.ws, { artifactState: 'discarded' });
  assert.equal(discarded.removed, true);
});

test('remove: a git refusal is reported and the workspace is left intact', async () => {
  const { ws, mgr, repo } = await scenario({ taskId: 'task-locked' });
  commitFiles(ws.path, { 'l.txt': 'l\n' }, 'l');
  git(['-C', repo.top, 'worktree', 'lock', ws.path]);
  await expectCode(CODES.REMOVE_FAILED, () => mgr.remove(ws, { artifactState: 'discarded' }));
  assert.equal(existsSync(ws.path), true);
  git(['-C', repo.top, 'worktree', 'unlock', ws.path]);
  const result = await mgr.remove(ws, { artifactState: 'discarded' });
  assert.equal(result.removed, true);
});

test('remove: either removes completely or fails closed with the workspace intact', async () => {
  const { ws, mgr, root, repo } = await scenario({ taskId: 'task-remove-boundary' });
  const head = commitFiles(ws.path, { 'f.txt': 'f\n' }, 'f');
  let result = null;
  let error = null;
  try {
    result = await mgr.remove(ws, { artifactState: 'discarded', taskId: 'task-remove-boundary' });
  } catch (thrown) {
    error = thrown;
  }
  const state = JSON.parse(readFileSync(stateFileOf(root), 'utf8'));
  if (error) {
    // No forced fallback: a host that cannot run native `git worktree remove` must fail
    // closed and leave everything (worktree, branch, ownership record) untouched.
    assert.equal(error.code, CODES.REMOVE_FAILED, `unexpected failure: ${error.code}: ${error.message}`);
    assert.equal(existsSync(ws.path), true);
    assert.equal(headOf(ws.path), head);
    assert.equal(state.workspaces['task-remove-boundary'].path, ws.path);
    assert.equal(worktreePaths(repo.top).includes(normalised(ws.path)), true);
    assert.equal(git(['-C', repo.top, 'rev-parse', `refs/heads/${ws.branch}`]).stdout.trim(), head);
  } else {
    assert.equal(result.removed, true);
    assert.equal(existsSync(ws.path), false);
    assert.equal(state.workspaces['task-remove-boundary'], undefined);
  }
});

/* ------------------------------------------------------------------ *
 * manager-level behaviour
 * ------------------------------------------------------------------ */

test('manager: ownership persists across instances and tampering fails closed', async () => {
  const { ws, mgr, root } = await scenario({ taskId: 'task-persist' });
  const other = manager(root);
  assert.deepEqual(await other.inspect(ws), { head: ws.baseCommit, dirty: false, changedPaths: [] });

  const stateFile = stateFileOf(root);
  const tampered = JSON.parse(readFileSync(stateFile, 'utf8'));
  tampered.workspaces['task-persist'].path = OUTSIDE_ROOT;
  writeFileSync(stateFile, `${JSON.stringify(tampered, null, 2)}\n`);
  await expectCode(CODES.STATE_CORRUPT, () => other.inspect(ws));

  writeFileSync(stateFile, '{not json');
  await expectCode(CODES.STATE_CORRUPT, () => other.inspect(ws));
  assert.equal(existsSync(ws.path), true);
  assert.equal(headOf(ws.path), ws.baseCommit);
  assert.equal(mgr instanceof WorkspaceManager, true);
});

test('manager: validates options, works without new, reports a missing git', async () => {
  const root = makeRoot();
  assert.throws(() => new WorkspaceManager({ root: 'relative/root' }), (error) => error.code === CODES.INVALID_ROOT);
  if (process.platform === 'win32') {
    assert.throws(() => new WorkspaceManager({ root: 'C:\\' }), (error) => error.code === CODES.INVALID_ROOT);
  }
  assert.throws(() => new WorkspaceManager({}), (error) => error.code === CODES.INVALID_ROOT);
  assert.throws(() => new WorkspaceManager({ root, extra: true }), (error) => error.code === CODES.INVALID_OPTIONS);
  assert.throws(() => new WorkspaceManager({ root, git: '   ' }), (error) => error.code === CODES.INVALID_GIT);

  const bare = WorkspaceManager({ root, git: GIT });
  assert.equal(bare instanceof WorkspaceManager, true);
  const repo = makeRepo();
  const ws = await bare.create({ taskId: 'task-bare', repository: repo.top, baseRef: 'main' });
  assert.equal((await bare.inspect(ws)).head, ws.baseCommit);
  await expectCode(CODES.INVALID_OPTIONS, () => {
    const detached = bare.inspect;
    return detached(ws);
  });

  const broken = manager(makeRoot(), { git: path.join(root, 'no-such-git-binary') });
  await expectCode(CODES.GIT_UNAVAILABLE, () =>
    broken.create({ taskId: 'task-broken-git', repository: repo.top, baseRef: 'main' })
  );
});
