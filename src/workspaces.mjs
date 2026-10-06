/**
 * Workspace module (CONTRACTS.md - Workspace module).
 *
 * `WorkspaceManager({root, git='git'})` owns isolated Git worktrees below `root`:
 *
 *   create({taskId, repository, baseRef, branchName?})
 *     -> {taskId, path, branch, baseCommit, repository}
 *   inspect(workspace) -> {head, dirty, changedPaths}
 *   review(workspace, {head, contractVersion, passed, checks}) -> immutable record
 *   integrate(workspace, {targetRepository, review, contractVersion, checks=[]}) -> evidence
 *   remove(workspace, {artifactState, pinned=false}) -> removal record
 *
 * Design rules implemented here:
 *  - every public input is untrusted and validated (types, shapes, unknown fields,
 *    absolute paths, repository/commit identity, argument arrays, no shell);
 *  - ownership is persisted under `root` (`.dsh-workspaces/ownership.json`) and every
 *    operation on a workspace requires a matching ownership record whose canonical path
 *    is inside `root` and whose git common directory matches the recorded one;
 *  - integration verifies source state and source checks before the target is touched,
 *    then performs a fast-forward-only merge of the exact reviewed commit;
 *  - removal only ever uses native `git worktree remove`; this module never performs
 *    recursive filesystem deletion;
 *  - review records are deeply frozen and carry exact head/check evidence.
 *
 * Interpretation notes (documented because CONTRACTS.md leaves them open):
 *  - `dirty` (workspace or target) means any porcelain status entry, including
 *    untracked files, so that uncollected work cannot be lost silently.
 *  - `review` responds with a record and never claims `passed` for a dirty workspace
 *    (`passed = requestedPassed && checksPassed && !dirty`); `integrate` refuses a dirty
 *    source outright.
 *  - `remove({artifactState:'merged'})` requires that the workspace head is either the
 *    base commit or a head recorded by a successful `integrate` for that workspace;
 *    `'preserved'` requires the workspace branch to still resolve to the head;
 *    `'discarded'` is the caller's explicit acceptance of an uncollected head.
 *    A workspace whose owned path disappeared is a stale record and is refused
 *    (`E_WORKSPACE_EXISTS`); this module never prunes git worktree metadata implicitly.
 *  - Provider/CLI processes are spawned without a shell and capture stdout/stderr through
 *    file descriptors rather than pipes: the DSH sandbox forbids piped stdio for spawned
 *    children ("no named pipes"), and file capture makes behaviour identical in and out of
 *    that sandbox. Captured evidence is bounded (see *_CAPTURE_BYTES).
 *  - If git reports "dubious ownership" the command is retried once with
 *    `-c safe.directory=<validated canonical path>` for the paths involved. This never
 *    writes global configuration and never widens the check beyond those exact paths.
 *  - Removal is always a plain, unforced native `git worktree remove` of the owned
 *    canonical path. On failure it reports `E_REMOVE_FAILED` and leaves the workspace
 *    untouched; there is no forced-removal fallback and no recursive deletion. Hosts that
 *    forbid child-process pipes (the DSH development sandbox does) cannot run git's
 *    internal cleanliness probe, so `remove` reports that error there - a host
 *    limitation, not a product path.
 *  - `review`/`integrate`/`remove` option objects are validated on the fields this module
 *    uses; unrecognized fields are ignored because the root MCP dispatcher forwards its own
 *    argument object (including `taskId`) to `review` and `integrate`. When a `taskId` is
 *    supplied it is cross-checked against the owned workspace record.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MGR = Symbol('dsh.workspaces.manager');

const STATE_DIR_NAME = '.dsh-workspaces';
const STATE_SCHEMA_VERSION = 1;

const GIT_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS_DEFAULT = 300_000;
const CHECK_TIMEOUT_MS_MAX = 600_000;
const MAX_CHECKS = 64;
const GIT_CAPTURE_BYTES = 32 * 1024 * 1024;
const CHECK_CAPTURE_BYTES = 2 * 1024 * 1024;
const EVIDENCE_TAIL_CHARS = 500;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const IS_WINDOWS = process.platform === 'win32';
const ARTIFACT_STATES = ['merged', 'preserved', 'discarded'];

/** Stable machine-readable domain failure codes. */
export const WORKSPACE_ERROR_CODES = Object.freeze({
  INVALID_OPTIONS: 'E_INVALID_OPTIONS',
  INVALID_ROOT: 'E_INVALID_ROOT',
  INVALID_GIT: 'E_INVALID_GIT',
  GIT_UNAVAILABLE: 'E_GIT_UNAVAILABLE',
  GIT_FAILED: 'E_GIT_FAILED',
  GIT_TIMEOUT: 'E_GIT_TIMEOUT',
  // Contract 20260925.1 names this code literally, without the module's usual E_ prefix.
  GIT_IDENTITY_UNAVAILABLE: 'GIT_IDENTITY_UNAVAILABLE',
  OUTPUT_LIMIT: 'E_OUTPUT_LIMIT',
  STATE_CORRUPT: 'E_STATE_CORRUPT',
  INVALID_CREATE_INPUT: 'E_INVALID_CREATE_INPUT',
  INVALID_TASK_ID: 'E_INVALID_TASK_ID',
  INVALID_REPOSITORY: 'E_INVALID_REPOSITORY',
  INVALID_BASE_REF: 'E_INVALID_BASE_REF',
  INVALID_BRANCH: 'E_INVALID_BRANCH',
  BRANCH_EXISTS: 'E_BRANCH_EXISTS',
  WORKSPACE_EXISTS: 'E_WORKSPACE_EXISTS',
  UNKNOWN_WORKSPACE: 'E_UNKNOWN_WORKSPACE',
  WORKSPACE_MISMATCH: 'E_WORKSPACE_MISMATCH',
  NOT_OWNED: 'E_WORKSPACE_NOT_OWNED',
  DIRTY: 'E_DIRTY_WORKSPACE',
  HEAD_MISMATCH: 'E_HEAD_MISMATCH',
  CONTRACT_MISMATCH: 'E_CONTRACT_MISMATCH',
  INVALID_REVIEW: 'E_INVALID_REVIEW',
  REVIEW_FAILED: 'E_REVIEW_FAILED',
  INVALID_CHECK: 'E_INVALID_CHECK',
  CHECK_FAILED: 'E_CHECK_FAILED',
  INVALID_INTEGRATE_INPUT: 'E_INVALID_INTEGRATE_INPUT',
  TARGET_MISMATCH: 'E_TARGET_MISMATCH',
  REPOSITORY_MISMATCH: 'E_REPOSITORY_MISMATCH',
  NOT_FAST_FORWARD: 'E_NOT_FAST_FORWARD',
  INVALID_REMOVE_INPUT: 'E_INVALID_REMOVE_INPUT',
  INVALID_REFRESH_INPUT: 'E_INVALID_REFRESH_INPUT',
  REBASE_IN_PROGRESS: 'E_REBASE_IN_PROGRESS',
  INVALID_ARTIFACT_STATE: 'E_INVALID_ARTIFACT_STATE',
  INVALID_PINNED: 'E_INVALID_PINNED',
  PINNED: 'E_PINNED',
  UNCOLLECTED: 'E_UNCOLLECTED',
  REMOVE_FAILED: 'E_REMOVE_FAILED',
  CREATE_FAILED: 'E_CREATE_FAILED'
});

const CODES = WORKSPACE_ERROR_CODES;

/* ------------------------------------------------------------------ *
 * Small validation helpers
 * ------------------------------------------------------------------ */

function die(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value, code, label) {
  if (!isPlainObject(value)) die(code, `${label} must be a plain object`);
  return value;
}

function assertKnownKeys(object, allowed, code, label) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) die(code, `${label} has unsupported field(s): ${unknown.join(', ')}`);
}

function assertNonBlankString(value, code, label, maxLength = 4096) {
  if (typeof value !== 'string') die(code, `${label} must be a string`);
  if (value.trim().length === 0) die(code, `${label} must be nonblank`);
  if (value.length > maxLength) die(code, `${label} must be at most ${maxLength} characters`);
  if (value.includes('\0')) die(code, `${label} must not contain NUL`);
  return value;
}

function isAbsolutePathSyntax(value) {
  if (IS_WINDOWS) {
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]/.test(value);
  }
  return path.isAbsolute(value);
}

function assertAbsolutePath(value, code, label) {
  assertNonBlankString(value, code, label);
  if (!isAbsolutePathSyntax(value)) die(code, `${label} must be an absolute path`);
  return value;
}

function pathKey(value) {
  return IS_WINDOWS ? value.toLowerCase() : value;
}

function samePath(a, b) {
  return pathKey(path.resolve(a)) === pathKey(path.resolve(b));
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '') return false;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrResolve(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function tailOf(text, length = EVIDENCE_TAIL_CHARS) {
  const value = String(text ?? '');
  return value.length <= length ? value : value.slice(value.length - length);
}

/* ------------------------------------------------------------------ *
 * Process capture (no shell, file-descriptor stdio, bounded evidence)
 * ------------------------------------------------------------------ */

async function readBounded(file, maxBytes) {
  const stat = await fs.stat(file);
  const toRead = Math.min(stat.size, maxBytes);
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(toRead);
    let read = 0;
    while (read < toRead) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await handle.read(buffer, read, toRead - read, read);
      if (bytesRead <= 0) break;
      read += bytesRead;
    }
    const captured = buffer.subarray(0, read);
    return {
      text: captured.toString('utf8'),
      bytes: stat.size,
      truncated: stat.size > maxBytes,
      sha256: createHash('sha256').update(captured).digest('hex')
    };
  } finally {
    await handle.close();
  }
}

/**
 * Run one command without a shell, capturing stdout/stderr into manager-owned files.
 * Never rejects for a non-zero exit; rejects only if the process cannot be spawned.
 */
async function runProcess(mgr, { command, args, cwd, env, timeoutMs, maxBytes }) {
  await prepareManager(mgr);
  const outFile = path.join(mgr.tmpDir, `${randomUUID()}.out`);
  const errFile = path.join(mgr.tmpDir, `${randomUUID()}.err`);
  const startedAt = Date.now();
  let outHandle = null;
  let errHandle = null;
  try {
    outHandle = await fs.open(outFile, 'w');
    errHandle = await fs.open(errFile, 'w');
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', outHandle.fd, errHandle.fd]
    });
    const outcome = await new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* the child is already gone */
        }
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(Object.assign(error, { spawnFailed: true, timedOut }));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut });
      });
    });
    const stdout = await readBounded(outFile, maxBytes);
    const stderr = await readBounded(errFile, maxBytes);
    return {
      command,
      args: [...args],
      cwd,
      exitCode: outcome.code,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      durationMs: Date.now() - startedAt,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutSha256: stdout.sha256,
      stderrSha256: stderr.sha256
    };
  } finally {
    if (outHandle) await outHandle.close().catch(() => {});
    if (errHandle) await errHandle.close().catch(() => {});
    await fs.rm(outFile, { force: true }).catch(() => {});
    await fs.rm(errFile, { force: true }).catch(() => {});
  }
}

function gitEnvironment() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true'
  };
}

/**
 * Run git. Returns the raw capture result; callers decide how to fail.
 * `guardPaths` are canonical, already-validated paths used only for the
 * non-persistent `safe.directory` retry.
 */
async function gitRaw(mgr, args, { cwd, guardPaths, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const guards = (guardPaths ?? (cwd ? [cwd] : [])).filter((value) => typeof value === 'string' && value);
  const capture = async (argv) => {
    try {
      return await runProcess(mgr, {
        command: mgr.git,
        args: argv,
        cwd,
        env: gitEnvironment(),
        timeoutMs,
        maxBytes: GIT_CAPTURE_BYTES
      });
    } catch (error) {
      // Only process-spawn failures are folded into a result; validation errors propagate.
      if (error.spawnFailed) {
        return { spawnFailed: true, spawnCode: error.code ?? null, spawnMessage: String(error.message ?? error) };
      }
      throw error;
    }
  };
  const result = await capture(args);
  if (result.spawnFailed || result.exitCode === 0) return result;
  if (guards.length === 0 || !/dubious ownership/i.test(result.stderr)) return result;
  const configArgs = guards.flatMap((guard) => ['-c', `safe.directory=${guard}`]);
  const retried = await capture([...configArgs, ...args]);
  if (!retried.spawnFailed) retried.safeDirectoryOverride = true;
  return retried;
}

/* ------------------------------------------------------------------ *
 * Ownership state
 * ------------------------------------------------------------------ */

function emptyOwnershipState(mgr) {
  return { schemaVersion: STATE_SCHEMA_VERSION, root: mgr.root, updatedAt: 0, workspaces: {} };
}

function validateStoredRecord(mgr, key, record) {
  const corrupt = (reason) => die(CODES.STATE_CORRUPT, `ownership state is invalid (${key}): ${reason}`);
  if (!isPlainObject(record)) corrupt('record must be an object');
  if (record.taskId !== key) corrupt('taskId must match its key');
  if (typeof record.taskId !== 'string' || !TASK_ID_RE.test(record.taskId)) corrupt('taskId is not a valid task id');
  if (typeof record.path !== 'string' || !isAbsolutePathSyntax(record.path)) corrupt('path must be absolute');
  if (!isInsideRoot(mgr.root, record.path)) corrupt('path must be inside the manager root');
  if (typeof record.repository !== 'string' || !isAbsolutePathSyntax(record.repository)) corrupt('repository must be absolute');
  if (typeof record.gitCommonDir !== 'string' || !isAbsolutePathSyntax(record.gitCommonDir)) corrupt('gitCommonDir must be absolute');
  if (typeof record.branch !== 'string' || record.branch.trim().length === 0) corrupt('branch must be nonblank');
  if (typeof record.baseCommit !== 'string' || !SHA_RE.test(record.baseCommit)) corrupt('baseCommit must be a full commit id');
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0) corrupt('createdAt must be a non-negative integer');
  if (!Array.isArray(record.integrations)) corrupt('integrations must be an array');
  for (const entry of record.integrations) {
    if (!isPlainObject(entry)) corrupt('integration entries must be objects');
    if (typeof entry.head !== 'string' || !SHA_RE.test(entry.head)) corrupt('integration head must be a full commit id');
    if (typeof entry.targetRepository !== 'string' || !isAbsolutePathSyntax(entry.targetRepository)) {
      corrupt('integration targetRepository must be absolute');
    }
    if (!Number.isSafeInteger(entry.at) || entry.at < 0) corrupt('integration at must be a non-negative integer');
  }
  return record;
}

async function loadOwnershipState(mgr) {
  let raw;
  try {
    raw = await fs.readFile(mgr.stateFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyOwnershipState(mgr);
    die(CODES.STATE_CORRUPT, `cannot read ownership state ${mgr.stateFile}: ${error.code ?? error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die(CODES.STATE_CORRUPT, `ownership state ${mgr.stateFile} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) die(CODES.STATE_CORRUPT, 'ownership state must be a JSON object');
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) die(CODES.STATE_CORRUPT, 'unsupported ownership state schemaVersion');
  if (parsed.root !== undefined && !samePath(String(parsed.root), mgr.root)) {
    die(CODES.STATE_CORRUPT, 'ownership state belongs to a different root');
  }
  if (!isPlainObject(parsed.workspaces)) die(CODES.STATE_CORRUPT, 'ownership state workspaces must be an object');
  const workspaces = {};
  const seenPaths = new Set();
  for (const [key, record] of Object.entries(parsed.workspaces)) {
    validateStoredRecord(mgr, key, record);
    const key2 = pathKey(record.path);
    if (seenPaths.has(key2)) die(CODES.STATE_CORRUPT, `ownership state has duplicate workspace path ${record.path}`);
    seenPaths.add(key2);
    workspaces[key] = {
      taskId: record.taskId,
      path: record.path,
      repository: record.repository,
      gitCommonDir: record.gitCommonDir,
      branch: record.branch,
      baseCommit: record.baseCommit,
      createdAt: record.createdAt,
      integrations: record.integrations.map((entry) => ({
        head: entry.head,
        targetRepository: entry.targetRepository,
        targetHeadBefore: typeof entry.targetHeadBefore === 'string' ? entry.targetHeadBefore : null,
        at: entry.at
      }))
    };
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    root: mgr.root,
    updatedAt: Number.isSafeInteger(parsed.updatedAt) && parsed.updatedAt >= 0 ? parsed.updatedAt : 0,
    workspaces
  };
}

async function saveOwnershipState(mgr, state) {
  state.updatedAt = Date.now();
  const payload = `${JSON.stringify(
    {
      schemaVersion: STATE_SCHEMA_VERSION,
      root: mgr.root,
      updatedAt: state.updatedAt,
      workspaces: state.workspaces
    },
    null,
    2
  )}\n`;
  const tempFile = `${mgr.stateFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempFile, payload, { encoding: 'utf8' });
    await fs.rename(tempFile, mgr.stateFile);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    die(CODES.STATE_CORRUPT, `cannot persist ownership state: ${error.code ?? error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Manager lifecycle
 * ------------------------------------------------------------------ */

function initManager(options) {
  const opts = options === undefined ? {} : assertPlainObject(options, CODES.INVALID_OPTIONS, 'options');
  assertKnownKeys(opts, ['root', 'git'], CODES.INVALID_OPTIONS, 'options');
  if (opts.root === undefined) die(CODES.INVALID_ROOT, 'root is required');
  assertAbsolutePath(opts.root, CODES.INVALID_ROOT, 'root');
  const root = path.resolve(opts.root);
  if (path.parse(root).root === root) die(CODES.INVALID_ROOT, 'root must not be a filesystem root');
  const git = opts.git === undefined ? 'git' : opts.git;
  assertNonBlankString(git, CODES.INVALID_GIT, 'git', 4096);
  if (/[\r\n]/.test(git)) die(CODES.INVALID_GIT, 'git must not contain control characters');
  return {
    root,
    git,
    stateDir: path.join(root, STATE_DIR_NAME),
    stateFile: path.join(root, STATE_DIR_NAME, 'ownership.json'),
    tmpDir: path.join(root, STATE_DIR_NAME, 'tmp'),
    prepared: false,
    lock: Promise.resolve()
  };
}

async function prepareManager(mgr) {
  if (mgr.prepared) return mgr;
  let stat = null;
  try {
    stat = await fs.stat(mgr.root);
  } catch (error) {
    if (error.code !== 'ENOENT') die(CODES.INVALID_ROOT, `cannot access root ${mgr.root}: ${error.code ?? error.message}`);
  }
  if (stat && !stat.isDirectory()) die(CODES.INVALID_ROOT, `root is not a directory: ${mgr.root}`);
  await fs.mkdir(mgr.root, { recursive: true });
  const real = await fs.realpath(mgr.root);
  if (path.parse(real).root === real) die(CODES.INVALID_ROOT, `root must not be a filesystem root: ${real}`);
  mgr.root = real;
  mgr.stateDir = path.join(real, STATE_DIR_NAME);
  mgr.stateFile = path.join(mgr.stateDir, 'ownership.json');
  mgr.tmpDir = path.join(mgr.stateDir, 'tmp');
  await fs.mkdir(mgr.tmpDir, { recursive: true });
  mgr.prepared = true;
  return mgr;
}

function requireManager(self) {
  if (!self || !(self instanceof WorkspaceManager) || !self[MGR]) {
    die(CODES.INVALID_OPTIONS, 'WorkspaceManager method called on a non-manager receiver');
  }
  return self[MGR];
}

function withLock(mgr, task) {
  const run = mgr.lock.then(task, task);
  mgr.lock = run.then(
    () => {},
    () => {}
  );
  return run;
}

/* ------------------------------------------------------------------ *
 * Git identity helpers
 * ------------------------------------------------------------------ */

async function resolveRepository(mgr, input, code, label) {
  assertAbsolutePath(input, code, label);
  const directory = path.resolve(input);
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch {
    die(code, `${label} does not exist: ${directory}`);
  }
  if (!stat.isDirectory()) die(code, `${label} is not a directory: ${directory}`);
  const canonical = await fs.realpath(directory);
  const identity = await repoIdentity(mgr, canonical, code, label);
  return { path: canonical, top: identity.top, common: identity.common };
}

async function repoIdentity(mgr, directory, code, label) {
  const top = await gitRaw(mgr, ['rev-parse', '--show-toplevel'], { cwd: directory, guardPaths: [directory] });
  if (top.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${top.spawnMessage}`);
  if (top.exitCode !== 0) die(code, `${label} is not a git working tree: ${directory}`);
  const topPath = await realpathOrResolve(top.stdout.trim());
  const common = await gitRaw(mgr, ['rev-parse', '--git-common-dir'], { cwd: topPath, guardPaths: [topPath, directory] });
  if (common.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${common.spawnMessage}`);
  if (common.exitCode !== 0) die(code, `cannot resolve the git common directory for ${label}: ${directory}`);
  const commonRaw = common.stdout.trim();
  const commonPath = await realpathOrResolve(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(topPath, commonRaw));
  return { top: topPath, common: commonPath };
}

async function resolveCommit(mgr, repository, baseRef) {
  const result = await gitRaw(mgr, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
    cwd: repository,
    guardPaths: [repository]
  });
  if (result.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${result.spawnMessage}`);
  if (result.exitCode !== 0) die(CODES.INVALID_BASE_REF, `baseRef does not resolve to a commit in ${repository}`);
  const sha = result.stdout.trim();
  if (!SHA_RE.test(sha)) die(CODES.INVALID_BASE_REF, `unexpected commit id from git for baseRef: ${sha.slice(0, 80)}`);
  return sha;
}

async function resolveRefOrNull(mgr, repository, ref) {
  const result = await gitRaw(mgr, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: repository,
    guardPaths: [repository]
  });
  if (result.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${result.spawnMessage}`);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return SHA_RE.test(sha) ? sha : null;
}

async function branchCheckedOutElsewhere(mgr, repository, branch) {
  const result = await gitRaw(mgr, ['worktree', 'list', '--porcelain'], { cwd: repository, guardPaths: [repository] });
  if (result.exitCode !== 0) return null;
  const needle = `branch refs/heads/${branch}`;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim() === needle) return true;
  }
  return false;
}

async function validateBranchName(mgr, repository, branch) {
  const result = await gitRaw(mgr, ['check-ref-format', '--branch', branch], {
    cwd: repository,
    guardPaths: [repository]
  });
  if (result.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${result.spawnMessage}`);
  if (result.exitCode !== 0) die(CODES.INVALID_BRANCH, `branchName is not a valid git branch name: ${branch}`);
}

/* ------------------------------------------------------------------ *
 * Working-state helpers
 * ------------------------------------------------------------------ */

function parsePorcelainZ(text) {
  const entries = text.split('\0').filter((entry) => entry.length > 0);
  const paths = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.add(entry.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const original = entries[index + 1];
      if (original !== undefined) {
        paths.add(original);
        index += 1;
      }
    }
  }
  return [...paths].map((value) => value.split('\\').join('/')).sort();
}

async function readWorkingState(mgr, directory) {
  const headResult = await gitRaw(mgr, ['rev-parse', 'HEAD'], { cwd: directory, guardPaths: [directory] });
  if (headResult.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${headResult.spawnMessage}`);
  if (headResult.exitCode !== 0) {
    die(CODES.GIT_FAILED, `cannot read HEAD in ${directory}: ${tailOf(headResult.stderr.trim())}`);
  }
  const head = headResult.stdout.trim();
  if (!SHA_RE.test(head)) die(CODES.GIT_FAILED, `unexpected HEAD value in ${directory}: ${head.slice(0, 80)}`);
  const statusResult = await gitRaw(mgr, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], {
    cwd: directory,
    guardPaths: [directory]
  });
  if (statusResult.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${statusResult.spawnMessage}`);
  if (statusResult.exitCode !== 0) {
    die(CODES.GIT_FAILED, `cannot read status in ${directory}: ${tailOf(statusResult.stderr.trim())}`);
  }
  const changedPaths = parsePorcelainZ(statusResult.stdout);
  return { head, dirty: changedPaths.length > 0, changedPaths };
}

async function currentHead(mgr, directory) {
  const result = await gitRow(mgr, directory, ['rev-parse', 'HEAD']);
  if (!SHA_RE.test(result)) die(CODES.GIT_FAILED, `unexpected HEAD value in ${directory}: ${String(result).slice(0, 80)}`);
  return result;
}

async function gitRow(mgr, directory, args) {  const result = await gitRaw(mgr, args, { cwd: directory, guardPaths: [directory] });
  if (result.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${result.spawnMessage}`);
  if (result.exitCode !== 0) {
    die(CODES.GIT_FAILED, `git ${args[0]} failed in ${directory}: ${tailOf(result.stderr.trim())}`);
  }
  return result.stdout.trim();
}

/* ------------------------------------------------------------------ *
 * Refresh helpers (parallel same-baseline branches)
 * ------------------------------------------------------------------ */

async function gitDirOf(mgr, directory) {
  const result = await gitRaw(mgr, ['rev-parse', '--git-dir'], { cwd: directory, guardPaths: [directory] });
  if (result.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${result.spawnMessage}`);
  if (result.exitCode !== 0) die(CODES.GIT_FAILED, `cannot resolve the git directory of ${directory}`);
  const raw = result.stdout.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(directory, raw);
}

/** A rebase left half-finished must be surfaced, never ignored or silently undone. */
async function assertNoRebaseInProgress(mgr, directory) {
  const gitDir = await gitDirOf(mgr, directory);
  for (const marker of ['rebase-merge', 'rebase-apply']) {
    if (await pathExists(path.join(gitDir, marker))) {
      die(CODES.REBASE_IN_PROGRESS, `an unfinished rebase is already in progress in ${directory}`);
    }
  }
  return gitDir;
}

async function isAncestor(mgr, directory, ancestor, descendant) {
  const result = await gitRaw(mgr, ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: directory,
    guardPaths: [directory]
  });
  if (result.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${result.spawnMessage}`);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  die(CODES.GIT_FAILED, `cannot determine ancestry in ${directory}: ${tailOf(result.stderr.trim())}`);
}

/**
 * A rebase rewrites commits, so it needs a resolvable author and committer identity.
 * `git var` reports exactly git's own resolution from the existing config/environment
 * without writing any config. Only success/failure is observed here: the reported
 * identity value is never copied into an error message or `details`.
 */
async function assertRebaseIdentityAvailable(mgr, directory, guardPaths) {
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await gitRaw(mgr, ['var', variable], { cwd: directory, guardPaths });
    if (result.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${result.spawnMessage}`);
    if (result.exitCode !== 0) {
      die(
        CODES.GIT_IDENTITY_UNAVAILABLE,
        `git cannot resolve a commit identity for the rebase in ${directory}; ` +
          'configure user.name and user.email before refreshing'
      );
    }
  }
}

/**
 * Paths that are actually unmerged in the index (stages 1/2/3). A stopped rebase with no
 * unmerged path is not a content conflict, so an empty result means git successfully
 * reported an index with no unmerged entries.
 *
 * An unsuccessful probe is never treated as an empty index: a real content conflict must
 * not be reported as `conflict:false` just because the probe could not be read. Spawn
 * failures keep `E_GIT_UNAVAILABLE`, timeouts fail with `E_GIT_TIMEOUT` and any other
 * non-zero exit fails with `E_GIT_FAILED`, each with the same bounded stderr diagnostics
 * used by the other git helpers.
 */
async function unmergedIndexPaths(mgr, directory, guardPaths) {
  const result = await gitRaw(mgr, ['ls-files', '--unmerged', '-z'], { cwd: directory, guardPaths });
  if (result.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${result.spawnMessage}`);
  if (result.timedOut) die(CODES.GIT_TIMEOUT, `cannot read the unmerged index in ${directory}: probe timed out`);
  if (result.exitCode !== 0) {
    die(
      CODES.GIT_FAILED,
      `cannot read the unmerged index in ${directory} (git exit ${result.exitCode ?? 'null'}): ${tailOf(result.stderr.trim())}`
    );
  }
  const paths = new Set();
  for (const record of result.stdout.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const value = record.slice(tab + 1);
    if (value.length > 0) paths.add(value.split('\\').join('/'));
  }
  return [...paths].sort();
}

/* ------------------------------------------------------------------ *
 * Workspace ownership resolution
 * ------------------------------------------------------------------ */

function findRecordByPath(state, candidate) {
  const key = pathKey(candidate);
  return Object.values(state.workspaces).find((record) => pathKey(record.path) === key) ?? null;
}

async function resolveOwnedWorkspace(mgr, workspace, { requireExists = true } = {}) {
  const handle = assertPlainObject(workspace, CODES.NOT_OWNED, 'workspace');
  assertAbsolutePath(handle.path, CODES.NOT_OWNED, 'workspace.path');
  const declared = path.resolve(handle.path);
  const exists = await pathExists(declared);
  if (!exists && requireExists) die(CODES.UNKNOWN_WORKSPACE, `workspace path does not exist: ${declared}`);
  const canonical = await realpathOrResolve(declared);
  const state = await loadOwnershipState(mgr);
  const record = findRecordByPath(state, canonical);
  if (!record) {
    die(CODES.NOT_OWNED, `workspace is not registered as manager-owned: ${canonical}`);
  }
  if (!isInsideRoot(mgr.root, canonical)) {
    die(CODES.NOT_OWNED, `workspace path is outside the manager root: ${canonical}`);
  }
  if (record.path !== canonical && pathKey(record.path) !== pathKey(canonical)) {
    die(CODES.WORKSPACE_MISMATCH, 'workspace path does not match the owned record');
  }
  if (handle.taskId !== undefined && handle.taskId !== record.taskId) {
    die(CODES.WORKSPACE_MISMATCH, 'workspace.taskId does not match the owned record');
  }
  if (handle.branch !== undefined && handle.branch !== record.branch) {
    die(CODES.WORKSPACE_MISMATCH, 'workspace.branch does not match the owned record');
  }
  if (handle.baseCommit !== undefined && handle.baseCommit !== record.baseCommit) {
    die(CODES.WORKSPACE_MISMATCH, 'workspace.baseCommit does not match the owned record');
  }
  if (handle.repository !== undefined) {
    assertAbsolutePath(handle.repository, CODES.WORKSPACE_MISMATCH, 'workspace.repository');
    if (!samePath(handle.repository, record.repository)) {
      die(CODES.WORKSPACE_MISMATCH, 'workspace.repository does not match the owned record');
    }
  }
  if (exists) {
    const common = await gitRaw(mgr, ['rev-parse', '--git-common-dir'], { cwd: canonical, guardPaths: [canonical] });
    if (common.spawnFailed) die(CODES.GIT_UNAVAILABLE, `failed to run git: ${common.spawnMessage}`);
    if (common.exitCode !== 0) die(CODES.WORKSPACE_MISMATCH, `workspace is not a usable git worktree: ${canonical}`);
    const commonRaw = common.stdout.trim();
    const commonPath = await realpathOrResolve(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(canonical, commonRaw));
    if (!samePath(commonPath, record.gitCommonDir)) {
      die(CODES.WORKSPACE_MISMATCH, `workspace does not belong to the recorded repository: ${canonical}`);
    }
  }
  return { record, path: canonical, exists };
}

/* ------------------------------------------------------------------ *
 * Input validation: create / review / integrate / remove
 * ------------------------------------------------------------------ */

function validateTaskId(value) {
  assertNonBlankString(value, CODES.INVALID_TASK_ID, 'taskId', 128);
  if (!TASK_ID_RE.test(value)) {
    die(CODES.INVALID_TASK_ID, 'taskId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');
  }
  if (value.endsWith('.')) die(CODES.INVALID_TASK_ID, 'taskId must not end with "."');
  if (WINDOWS_RESERVED_RE.test(value)) die(CODES.INVALID_TASK_ID, `taskId must not be a reserved device name: ${value}`);
  return value;
}

function validateRevisionInput(value, code, label) {
  assertNonBlankString(value, code, label, 1024);
  if (value.startsWith('-')) die(code, `${label} must not start with "-"`);
  if (/[\r\n]/.test(value)) die(code, `${label} must not contain line breaks`);
  return value;
}

function validateCreateInput(input) {
  const options = assertPlainObject(input, CODES.INVALID_CREATE_INPUT, 'create input');
  const taskId = validateTaskId(options.taskId);
  const repository = assertNonBlankString(options.repository, CODES.INVALID_REPOSITORY, 'repository', 4096);
  const baseRef = validateRevisionInput(options.baseRef, CODES.INVALID_BASE_REF, 'baseRef');
  let branchName;
  if (options.branchName !== undefined) {
    branchName = assertNonBlankString(options.branchName, CODES.INVALID_BRANCH, 'branchName', 255);
    if (/\s/.test(branchName)) die(CODES.INVALID_BRANCH, 'branchName must not contain whitespace');
  }
  return { taskId, repository, baseRef, branchName };
}

function validateChecksInput(input, code = CODES.INVALID_CHECK) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) die(code, 'checks must be an array');
  if (input.length > MAX_CHECKS) die(code, `checks must contain at most ${MAX_CHECKS} entries`);
  return input.map((entry, index) => {
    const label = `checks[${index}]`;
    const check = assertPlainObject(entry, code, label);
    const command = assertNonBlankString(check.command, code, `${label}.command`, 4096);
    if (/[\r\n]/.test(command)) die(code, `${label}.command must not contain line breaks`);
    let args = [];
    if (check.args !== undefined) {
      if (!Array.isArray(check.args)) die(code, `${label}.args must be an array of strings`);
      args = check.args.map((arg, argIndex) => {
        if (typeof arg !== 'string') die(code, `${label}.args[${argIndex}] must be a string`);
        if (arg.includes('\0')) die(code, `${label}.args[${argIndex}] must not contain NUL`);
        if (arg.length > 8192) die(code, `${label}.args[${argIndex}] must be at most 8192 characters`);
        return arg;
      });
    }
    let timeoutMs = CHECK_TIMEOUT_MS_DEFAULT;
    if (check.timeoutMs !== undefined) {
      if (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs <= 0 || check.timeoutMs > CHECK_TIMEOUT_MS_MAX) {
        die(code, `${label}.timeoutMs must be an integer within 1..${CHECK_TIMEOUT_MS_MAX}`);
      }
      timeoutMs = check.timeoutMs;
    }
    return { command, args, timeoutMs };
  });
}

async function assertCommandUsable(command, code, label) {
  if (path.isAbsolute(command)) {
    let stat;
    try {
      stat = await fs.stat(command);
    } catch {
      die(code, `${label} does not exist: ${command}`);
    }
    if (!stat.isFile()) die(code, `${label} is not a file: ${command}`);
    return;
  }
  if (command.includes('/') || command.includes('\\')) {
    die(code, `${label} must be an executable name or an existing absolute path`);
  }
}

async function validateChecks(input, code = CODES.INVALID_CHECK) {
  const checks = validateChecksInput(input, code);
  for (let index = 0; index < checks.length; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await assertCommandUsable(checks[index].command, code, `checks[${index}].command`);
  }
  return checks;
}

async function runChecks(mgr, checks, { cwd, phase }) {
  const results = [];
  for (const check of checks) {
    let capture;
    try {
      // eslint-disable-next-line no-await-in-loop
      capture = await runProcess(mgr, {
        command: check.command,
        args: check.args,
        cwd,
        env: { ...process.env },
        timeoutMs: check.timeoutMs,
        maxBytes: CHECK_CAPTURE_BYTES
      });
    } catch (error) {
      results.push({
        phase,
        command: check.command,
        args: [...check.args],
        cwd,
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: Boolean(error.timedOut),
        durationMs: 0,
        spawnErrorCode: error.code ?? null,
        spawnErrorMessage: tailOf(String(error.message ?? error)),
        stdoutSha256: null,
        stderrSha256: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutTail: '',
        stderrTail: ''
      });
      continue;
    }
    results.push({
      phase,
      command: check.command,
      args: [...check.args],
      cwd,
      ok: capture.exitCode === 0 && !capture.timedOut,
      exitCode: capture.exitCode,
      signal: capture.signal,
      timedOut: capture.timedOut,
      durationMs: capture.durationMs,
      spawnErrorCode: null,
      spawnErrorMessage: null,
      stdoutSha256: capture.stdoutSha256,
      stderrSha256: capture.stderrSha256,
      stdoutBytes: capture.stdoutBytes,
      stderrBytes: capture.stderrBytes,
      stdoutTruncated: capture.stdoutTruncated,
      stderrTruncated: capture.stderrTruncated,
      stdoutTail: tailOf(capture.stdout),
      stderrTail: tailOf(capture.stderr)
    });
  }
  return results;
}

function validateReviewRecord(review, contractVersion) {
  const record = assertPlainObject(review, CODES.INVALID_REVIEW, 'review');
  if (typeof record.head !== 'string' || !SHA_RE.test(record.head)) {
    die(CODES.INVALID_REVIEW, 'review.head must be a full commit id');
  }
  assertNonBlankString(record.contractVersion, CODES.INVALID_REVIEW, 'review.contractVersion', 200);
  if (record.contractVersion !== contractVersion) {
    die(
      CODES.CONTRACT_MISMATCH,
      `review contract version ${record.contractVersion} does not match integrate contract version ${contractVersion}`
    );
  }
  if (typeof record.passed !== 'boolean') die(CODES.INVALID_REVIEW, 'review.passed must be a boolean');
  if (record.checks !== undefined && !Array.isArray(record.checks)) {
    die(CODES.INVALID_REVIEW, 'review.checks must be an array when present');
  }
  if (record.checksPassed !== undefined && typeof record.checksPassed !== 'boolean') {
    die(CODES.INVALID_REVIEW, 'review.checksPassed must be a boolean when present');
  }
  if (record.taskId !== undefined) assertNonBlankString(record.taskId, CODES.INVALID_REVIEW, 'review.taskId', 200);
  if (record.workspacePath !== undefined) {
    assertAbsolutePath(record.workspacePath, CODES.INVALID_REVIEW, 'review.workspacePath');
  }
  return record;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/* ------------------------------------------------------------------ *
 * WorkspaceManager
 * ------------------------------------------------------------------ */

/**
 * Create a workspace manager. Works both with and without `new`:
 * `new WorkspaceManager({root, git})` and `WorkspaceManager({root, git})`.
 */
export function WorkspaceManager(options) {
  if (!(this instanceof WorkspaceManager)) return new WorkspaceManager(options);
  Object.defineProperty(this, MGR, {
    value: initManager(options),
    enumerable: false,
    writable: false,
    configurable: false
  });
}

WorkspaceManager.ERROR_CODES = CODES;

/**
 * Create an isolated worktree for `taskId` at `baseRef`.
 * Idempotent for the same task when the owned worktree still matches the request.
 */
WorkspaceManager.prototype.create = async function create(input) {
  const mgr = requireManager(this);
  return withLock(mgr, async () => {
    const request = validateCreateInput(input);
    await prepareManager(mgr);
    const repository = await resolveRepository(mgr, request.repository, CODES.INVALID_REPOSITORY, 'repository');
    const baseCommit = await resolveCommit(mgr, repository.top, request.baseRef);
    const branch = request.branchName ?? `task/${request.taskId}`;
    await validateBranchName(mgr, repository.top, branch);
    const workspacePath = path.join(mgr.root, `task-${request.taskId}`);
    const state = await loadOwnershipState(mgr);

    const existing = state.workspaces[request.taskId];
    if (existing) {
      const sameLocation = samePath(existing.path, workspacePath);
      const existingOnDisk = await pathExists(existing.path);
      if (existingOnDisk) {
        const identityMatches = samePath(existing.gitCommonDir, repository.common);
        const head = await currentHead(mgr, existing.path);
        if (
          sameLocation &&
          identityMatches &&
          existing.branch === branch &&
          existing.baseCommit === baseCommit &&
          head === baseCommit
        ) {
          return {
            taskId: existing.taskId,
            path: existing.path,
            branch: existing.branch,
            baseCommit: existing.baseCommit,
            repository: existing.repository
          };
        }
        die(
          CODES.WORKSPACE_EXISTS,
          `manager already owns a workspace for task ${request.taskId} that does not match this request: ${existing.path}`
        );
      }
      die(
        CODES.WORKSPACE_EXISTS,
        `manager owns task ${request.taskId} but its workspace path is missing (stale record): ${existing.path}; ` +
          'restore or clear the ownership record before recreating'
      );
    }

    const conflictingRecord = findRecordByPath(state, workspacePath);
    if (conflictingRecord) {
      die(CODES.WORKSPACE_EXISTS, `workspace path is already owned by task ${conflictingRecord.taskId}: ${workspacePath}`);
    }
    const otherBranchOwner = Object.values(state.workspaces).find((record) => record.branch === branch);
    if (otherBranchOwner) {
      die(CODES.BRANCH_EXISTS, `branch ${branch} is already owned by workspace for task ${otherBranchOwner.taskId}`);
    }
    if (await pathExists(workspacePath)) {
      die(CODES.WORKSPACE_EXISTS, `workspace path already exists: ${workspacePath}`);
    }

    const branchTip = await resolveRefOrNull(mgr, repository.top, `refs/heads/${branch}`);
    if (branchTip !== null && branchTip !== baseCommit) {
      die(CODES.BRANCH_EXISTS, `branch ${branch} already exists at ${branchTip}, not at the requested base ${baseCommit}`);
    }
    if (branchTip !== null && (await branchCheckedOutElsewhere(mgr, repository.top, branch)) === true) {
      die(CODES.BRANCH_EXISTS, `branch ${branch} is already checked out in another worktree`);
    }

    const guards = [repository.top, repository.common, workspacePath];
    let created = false;
    try {
      const addArgs =
        branchTip === null
          ? ['worktree', 'add', '-b', branch, workspacePath, baseCommit]
          : ['worktree', 'add', workspacePath, branch];
      const added = await gitRaw(mgr, addArgs, { cwd: repository.top, guardPaths: guards });
      if (added.spawnFailed) {
        die(added.spawnCode === 'ENOENT' ? CODES.GIT_UNAVAILABLE : CODES.CREATE_FAILED, `failed to run git: ${added.spawnMessage}`);
      }
      if (added.exitCode !== 0) {
        die(
          CODES.CREATE_FAILED,
          `git worktree add failed (exit ${added.exitCode}): ${tailOf((added.stderr || added.stdout).trim())}`
        );
      }
      created = true;

      const canonicalPath = await fs.realpath(workspacePath);
      if (!isInsideRoot(mgr.root, canonicalPath)) {
        die(CODES.CREATE_FAILED, `created workspace escaped the manager root: ${canonicalPath}`);
      }
      const identity = await repoIdentity(mgr, canonicalPath, CODES.CREATE_FAILED, 'created workspace');
      if (!samePath(identity.top, canonicalPath)) {
        die(CODES.CREATE_FAILED, `created workspace is not a worktree root: ${canonicalPath}`);
      }
      if (!samePath(identity.common, repository.common)) {
        die(CODES.CREATE_FAILED, 'created workspace does not belong to the requested repository');
      }
      const head = await currentHead(mgr, canonicalPath);
      if (head !== baseCommit) {
        die(CODES.CREATE_FAILED, `created workspace head ${head} does not match base commit ${baseCommit}`);
      }

      state.workspaces[request.taskId] = {
        taskId: request.taskId,
        path: canonicalPath,
        repository: repository.top,
        gitCommonDir: identity.common,
        branch,
        baseCommit,
        createdAt: Date.now(),
        integrations: []
      };
      await saveOwnershipState(mgr, state);
      return {
        taskId: request.taskId,
        path: canonicalPath,
        branch,
        baseCommit,
        repository: repository.top
      };
    } catch (error) {
      if (created) {
        const removed = await gitRaw(mgr, ['worktree', 'remove', workspacePath], {
          cwd: repository.top,
          guardPaths: guards
        });
        if (!removed || removed.exitCode !== 0) error.cleanupFailed = true;
      }
      throw error;
    }
  });
};

/** Inspect an owned workspace: exact head plus every changed or untracked path. */
WorkspaceManager.prototype.inspect = async function inspect(workspace) {
  const mgr = requireManager(this);
  await prepareManager(mgr);
  const owned = await resolveOwnedWorkspace(mgr, workspace);
  return readWorkingState(mgr, owned.path);
};

/**
 * Produce an immutable review record bound to the exact workspace head.
 * `passed` is only true when the caller requested it and every check passed and the
 * workspace is clean; a dirty workspace can never yield `passed: true`.
 * Unrecognized option fields are ignored (the root MCP dispatcher forwards `taskId`);
 * a supplied `taskId` must match the owned workspace.
 */
WorkspaceManager.prototype.review = async function review(workspace, input) {
  const mgr = requireManager(this);
  await prepareManager(mgr);
  const owned = await resolveOwnedWorkspace(mgr, workspace);
  const options = assertPlainObject(input, CODES.INVALID_REVIEW, 'review options');
  if (options.taskId !== undefined && options.taskId !== owned.record.taskId) {
    die(CODES.WORKSPACE_MISMATCH, 'review options taskId does not match the owned workspace');
  }
  if (typeof options.head !== 'string' || !SHA_RE.test(options.head)) {
    die(CODES.INVALID_REVIEW, 'head must be a full commit id');
  }
  const contractVersion = assertNonBlankString(options.contractVersion, CODES.INVALID_REVIEW, 'contractVersion', 200);
  if (typeof options.passed !== 'boolean') die(CODES.INVALID_REVIEW, 'passed must be a boolean');
  const checks = await validateChecks(options.checks, CODES.INVALID_CHECK);

  const state = await readWorkingState(mgr, owned.path);
  if (state.head !== options.head) {
    die(CODES.HEAD_MISMATCH, `workspace head ${state.head} does not match the requested review head ${options.head}`);
  }
  const checkResults = await runChecks(mgr, checks, { cwd: owned.path, phase: 'review' });
  // TOCTOU guard: checks must not be able to change the code the review claims to cover.
  const afterChecks = await readWorkingState(mgr, owned.path);
  if (afterChecks.head !== state.head) {
    die(CODES.HEAD_MISMATCH, `workspace head changed from ${state.head} to ${afterChecks.head} while checks were running`);
  }
  const checksPassed = checkResults.every((entry) => entry.ok === true);
  return deepFreeze({
    schemaVersion: 1,
    kind: 'workspace-review',
    taskId: owned.record.taskId,
    workspacePath: owned.path,
    repository: owned.record.repository,
    branch: owned.record.branch,
    baseCommit: owned.record.baseCommit,
    head: state.head,
    contractVersion,
    requestedPassed: options.passed,
    checksPassed,
    passed: options.passed === true && checksPassed && state.dirty === false && afterChecks.dirty === false,
    dirty: afterChecks.dirty,
    changedPaths: afterChecks.dirty ? afterChecks.changedPaths : state.changedPaths,
    postCheckHead: afterChecks.head,
    postCheckDirty: afterChecks.dirty,
    checks: checkResults,
    reviewedAt: Date.now()
  });
};

/**
 * Integrate the exact reviewed commit into `targetRepository` with a fast-forward-only
 * merge, after verifying source state, review identity and checks. The target is not
 * touched until the source has been verified and its checks have passed.
 */
WorkspaceManager.prototype.integrate = async function integrate(workspace, input) {
  const mgr = requireManager(this);
  return withLock(mgr, async () => {
    await prepareManager(mgr);
    const owned = await resolveOwnedWorkspace(mgr, workspace);
    const options = assertPlainObject(input, CODES.INVALID_INTEGRATE_INPUT, 'integrate options');
    if (options.taskId !== undefined && options.taskId !== owned.record.taskId) {
      die(CODES.WORKSPACE_MISMATCH, 'integrate options taskId does not match the owned workspace');
    }
    const contractVersion = assertNonBlankString(
      options.contractVersion,
      CODES.INVALID_INTEGRATE_INPUT,
      'contractVersion',
      200
    );
    const review = validateReviewRecord(options.review, contractVersion);
    const checks = await validateChecks(options.checks, CODES.INVALID_CHECK);
    if (review.taskId !== undefined && review.taskId !== owned.record.taskId) {
      die(CODES.WORKSPACE_MISMATCH, 'review.taskId does not match the source workspace');
    }
    if (review.workspacePath !== undefined && !samePath(review.workspacePath, owned.path)) {
      die(CODES.WORKSPACE_MISMATCH, 'review.workspacePath does not match the source workspace');
    }

    const target = await resolveRepository(
      mgr,
      options.targetRepository,
      CODES.INVALID_REPOSITORY,
      'targetRepository'
    );
    if (!samePath(target.common, owned.record.gitCommonDir)) {
      die(CODES.REPOSITORY_MISMATCH, 'targetRepository is not the repository that owns the source workspace');
    }
    if (samePath(target.top, owned.path)) {
      die(CODES.TARGET_MISMATCH, 'targetRepository is the source workspace itself');
    }

    // --- source verification (nothing on the target has been modified yet) ---
    const sourceState = await readWorkingState(mgr, owned.path);
    if (sourceState.dirty) {
      die(CODES.DIRTY, `source workspace has uncommitted changes (${sourceState.changedPaths.length} path(s))`);
    }
    if (sourceState.head !== review.head) {
      die(CODES.HEAD_MISMATCH, `source head ${sourceState.head} does not match the reviewed head ${review.head}`);
    }
    if (review.passed !== true) die(CODES.REVIEW_FAILED, 'review did not pass; refusing to integrate');
    if (review.checksPassed === false) die(CODES.CHECK_FAILED, 'review records failed checks; refusing to integrate');
    const reviewChecks = Array.isArray(review.checks) ? review.checks : [];
    const malformedOrFailed = reviewChecks.filter((entry) => !isPlainObject(entry) || entry.ok !== true);
    if (malformedOrFailed.length > 0) {
      die(CODES.CHECK_FAILED, `review records ${malformedOrFailed.length} failed or malformed check(s); refusing to integrate`);
    }

    const sourceChecks = await runChecks(mgr, checks, { cwd: owned.path, phase: 'source' });
    if (sourceChecks.some((entry) => entry.ok !== true)) {
      return buildIntegrationResult({
        owned,
        target,
        contractVersion,
        review,
        sourceChecks,
        targetChecks: [],
        targetHeadBefore: null,
        targetHeadAfter: null,
        merged: false,
        accepted: false,
        reason: 'source_checks_failed'
      });
    }
    // TOCTOU guard: re-read the source against the before-check snapshot.
    const sourceAfterChecks = await readWorkingState(mgr, owned.path);
    if (sourceAfterChecks.head !== sourceState.head) {
      die(CODES.HEAD_MISMATCH, `source head changed from ${sourceState.head} to ${sourceAfterChecks.head} while checks ran`);
    }
    if (sourceAfterChecks.dirty) {
      die(CODES.DIRTY, `source workspace changed while checks ran (${sourceAfterChecks.changedPaths.length} path(s))`);
    }

    // --- target verification (still before any mutation of the target) ---
    const targetState = await readWorkingState(mgr, target.top);
    if (targetState.dirty) {
      die(CODES.DIRTY, `target repository has uncommitted changes (${targetState.changedPaths.length} path(s))`);
    }
    if (targetState.head !== owned.record.baseCommit) {
      die(
        CODES.TARGET_MISMATCH,
        `target head ${targetState.head} is not the workspace base ${owned.record.baseCommit}; rebase and re-review`
      );
    }
    const baselineChecks=await validateChecks(options.baselineChecks, CODES.INVALID_CHECK);
    const targetChecks = await runChecks(mgr, baselineChecks, { cwd: target.top, phase: 'target' });
    if (targetChecks.some((entry) => entry.ok !== true)) {
      return buildIntegrationResult({
        owned,
        target,
        contractVersion,
        review,
        sourceChecks,
        targetChecks,
        targetHeadBefore: targetState.head,
        targetHeadAfter: null,
        merged: false,
        accepted: false,
        reason: 'target_checks_failed'
      });
    }
    // TOCTOU guard: re-read the target against the before-check snapshot.
    const targetAfterChecks = await readWorkingState(mgr, target.top);
    if (targetAfterChecks.dirty) {
      die(CODES.DIRTY, `target repository changed while checks ran (${targetAfterChecks.changedPaths.length} path(s))`);
    }
    if (targetAfterChecks.head !== targetState.head) {
      die(CODES.TARGET_MISMATCH, `target head changed from ${targetState.head} to ${targetAfterChecks.head} while checks ran`);
    }

    // --- fast-forward-only merge of the exact reviewed commit ---
    const merge = await gitRaw(mgr, ['merge', '--ff-only', '--no-edit', review.head], {
      cwd: target.top,
      guardPaths: [target.top, target.common, owned.path]
    });
    if (merge.spawnFailed) {
      die(merge.spawnCode === 'ENOENT' ? CODES.GIT_UNAVAILABLE : CODES.GIT_FAILED, `failed to run git: ${merge.spawnMessage}`);
    }
    if (merge.exitCode !== 0) {
      die(
        CODES.NOT_FAST_FORWARD,
        `fast-forward-only merge of ${review.head} into ${target.top} failed (exit ${merge.exitCode}): ${tailOf(
          (merge.stderr || merge.stdout).trim()
        )}`
      );
    }
    const targetHeadAfter = await currentHead(mgr, target.top);
    if (targetHeadAfter !== review.head) {
      die(
        CODES.GIT_FAILED,
        `target head ${targetHeadAfter} does not equal the reviewed head ${review.head} after the merge`
      );
    }

    // The merge is already a fact from here on: post-merge check failures must be
    // reported as merged:true / accepted:false, never as a false success.
    const postMergeChecks = await runChecks(mgr, checks, { cwd: target.top, phase: 'target-post' });
    const targetFinalState = await readWorkingState(mgr, target.top);
    const targetFinalHead = targetFinalState.head;
    const postMergePassed = postMergeChecks.every((entry) => entry.ok === true) && targetFinalHead === review.head && !targetFinalState.dirty;
    const accepted = postMergePassed;
    const warnings = [];
    let integrationRecorded = false;
    const state = await loadOwnershipState(mgr);
    const record = state.workspaces[owned.record.taskId];
    if (record && Array.isArray(record.integrations)) {
      record.integrations.push({
        head: review.head,
        targetRepository: target.top,
        targetHeadBefore: targetState.head,
        accepted,
        at: Date.now()
      });
      try {
        await saveOwnershipState(mgr, state);
        integrationRecorded = true;
      } catch (error) {
        warnings.push(`integration was merged but ownership state could not be persisted: ${error.code ?? error.message}`);
      }
    } else {
      warnings.push('integration was merged but no ownership record was available to update');
    }
    if (!postMergePassed) {
      warnings.push('post-merge target checks failed; the merge is real but was not accepted');
    }

    return buildIntegrationResult({
      owned,
      target,
      contractVersion,
      review,
      sourceChecks,
      targetChecks: [...targetChecks, ...postMergeChecks],
      targetHeadBefore: targetState.head,
      targetHeadAfter: targetFinalHead,
      merged: true,
      accepted,
      reason: postMergePassed ? null : 'postmerge_target_checks_failed',
      integrationRecorded,
      warnings
    });
  });
};

function buildIntegrationResult({
  owned,
  target,
  contractVersion,
  review,
  sourceChecks,
  targetChecks,
  targetHeadBefore,
  targetHeadAfter,
  merged,
  accepted,
  reason,
  integrationRecorded = false,
  warnings = []
}) {
  const checks = [...sourceChecks, ...targetChecks];
  return {
    schemaVersion: 1,
    kind: 'workspace-integration',
    taskId: owned.record.taskId,
    workspacePath: owned.path,
    branch: owned.record.branch,
    repository: owned.record.repository,
    targetRepository: target.top,
    contractVersion,
    reviewHead: review.head,
    baseCommit: owned.record.baseCommit,
    targetHeadBefore,
    targetHeadAfter,
    merged,
    accepted: merged === true && accepted === true && checks.every((entry) => entry.ok === true),
    reason,
    integrationRecorded,
    warnings,
    checks,
    failedChecks: checks
      .filter((entry) => entry.ok !== true)
      .map((entry) => ({ phase: entry.phase, command: entry.command, args: entry.args, exitCode: entry.exitCode })),
    at: Date.now()
  };
}

/**
 * Refresh a reviewed-but-not-yet-integrated workspace onto the current target head so
 * that parallel same-baseline branches can be integrated consecutively.
 *
 * Requires an owned canonical clean source, a clean target in the same canonical
 * repository, and a target head exactly equal to `expectedTargetHead`. If a rebase is
 * actually needed, a resolvable author and committer identity is required first
 * (`git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT`); an unresolvable identity fails
 * closed with `GIT_IDENTITY_UNAVAILABLE` before the rebase and never writes config or
 * echoes the identity value. The adopted/no-rebase path has no identity requirement.
 * Runs a plain native `git rebase <expectedTargetHead>` in the source with a safe
 * argument array and no shell. On failure the rebase scene is preserved (no reset, no
 * abort) and the result reports `refreshed:false` with `conflict:true` /
 * `reason:'rebase_conflict'` only when the index actually has unmerged paths, otherwise
 * `conflict:false` / `reason:'rebase_failed'`, plus the unmerged paths and the actual
 * source/output evidence. If the unmerged-index probe itself cannot be read, refresh
 * fails closed (`GIT_TIMEOUT`/`GIT_FAILED`) instead of reporting a non-conflict. On success
 * the ownership record adopts `baseCommit = expectedTargetHead`, the returned handle carries
 * the same taskId/path/branch/repository with the updated baseCommit, and
 * `reviewInvalidated:true` tells the caller to discard any previous review.
 */
WorkspaceManager.prototype.refresh = async function refresh(workspace, input) {
  const mgr = requireManager(this);
  return withLock(mgr, async () => {
    await prepareManager(mgr);
    const owned = await resolveOwnedWorkspace(mgr, workspace);
    const options = assertPlainObject(input, CODES.INVALID_REFRESH_INPUT, 'refresh options');
    if (options.taskId !== undefined && options.taskId !== owned.record.taskId) {
      die(CODES.WORKSPACE_MISMATCH, 'refresh options taskId does not match the owned workspace');
    }
    const targetRepository = assertNonBlankString(
      options.targetRepository,
      CODES.INVALID_REPOSITORY,
      'targetRepository',
      4096
    );
    if (typeof options.expectedTargetHead !== 'string' || !SHA_RE.test(options.expectedTargetHead)) {
      die(CODES.INVALID_REFRESH_INPUT, 'expectedTargetHead must be a full commit id');
    }
    const expectedTargetHead = options.expectedTargetHead;
    const target = await resolveRepository(mgr, targetRepository, CODES.INVALID_REPOSITORY, 'targetRepository');
    if (!samePath(target.common, owned.record.gitCommonDir)) {
      die(CODES.REPOSITORY_MISMATCH, 'targetRepository is not the repository that owns the source workspace');
    }
    if (samePath(target.top, owned.path)) {
      die(CODES.TARGET_MISMATCH, 'targetRepository is the source workspace itself');
    }
    await assertNoRebaseInProgress(mgr, owned.path);

    const before = await readWorkingState(mgr, owned.path);
    if (before.dirty) {
      die(CODES.DIRTY, `source workspace has uncommitted changes (${before.changedPaths.length} path(s))`);
    }
    const targetBefore = await readWorkingState(mgr, target.top);
    if (targetBefore.dirty) {
      die(CODES.DIRTY, `target repository has uncommitted changes (${targetBefore.changedPaths.length} path(s))`);
    }
    if (targetBefore.head !== expectedTargetHead) {
      die(
        CODES.TARGET_MISMATCH,
        `target head ${targetBefore.head} does not equal expectedTargetHead ${expectedTargetHead}`
      );
    }

    // A controller may have rebased the branch already; adopt it only with proof.
    const alreadyBased = await isAncestor(mgr, owned.path, expectedTargetHead, before.head);
    let rebased = false;
    if (!alreadyBased) {
      await assertRebaseIdentityAvailable(mgr, owned.path, [owned.path, owned.record.gitCommonDir, target.top]);
      const rebase = await gitRaw(mgr, ['rebase', expectedTargetHead], {
        cwd: owned.path,
        guardPaths: [owned.path, owned.record.gitCommonDir, target.top]
      });
      if (rebase.spawnFailed) {
        die(rebase.spawnCode === 'ENOENT' ? CODES.GIT_UNAVAILABLE : CODES.GIT_FAILED, `failed to run git: ${rebase.spawnMessage}`);
      }
      if (rebase.exitCode !== 0) {
        const conflictState = await readWorkingState(mgr, owned.path);
        const gitDir = await gitDirOf(mgr, owned.path);
        const rebaseInProgress =
          (await pathExists(path.join(gitDir, 'rebase-merge'))) || (await pathExists(path.join(gitDir, 'rebase-apply')));
        // Only actual unmerged index paths are a content conflict; other rebase failures
        // (hooks, stopped/empty sequences) are reported as rebase_failed, never invented.
        // An unreadable probe throws (E_GIT_TIMEOUT/E_GIT_FAILED) rather than yielding an
        // empty list, so a real conflict can never be misreported as conflict:false.
        const unmergedPaths = await unmergedIndexPaths(mgr, owned.path, [
          owned.path,
          owned.record.gitCommonDir,
          target.top
        ]);
        const conflict = unmergedPaths.length > 0;
        return {
          schemaVersion: 1,
          kind: 'workspace-refresh',
          refreshed: false,
          conflict,
          reason: conflict ? 'rebase_conflict' : 'rebase_failed',
          taskId: owned.record.taskId,
          path: owned.path,
          branch: owned.record.branch,
          repository: owned.record.repository,
          targetRepository: target.top,
          previousBaseCommit: owned.record.baseCommit,
          baseCommit: owned.record.baseCommit,
          targetHead: expectedTargetHead,
          head: conflictState.head,
          dirty: conflictState.dirty,
          changedPaths: conflictState.changedPaths,
          unmergedPaths,
          rebaseInProgress,
          rebaseExitCode: rebase.exitCode,
          rebaseOutput: tailOf((rebase.stdout || '').trim()),
          rebaseError: tailOf((rebase.stderr || '').trim()),
          reviewInvalidated: true,
          targetHeadUnchanged: (await currentHead(mgr, target.top)) === expectedTargetHead,
          at: Date.now()
        };
      }
      rebased = true;
    }

    const after = await readWorkingState(mgr, owned.path);
    if (after.dirty) {
      die(CODES.DIRTY, `source workspace is not clean after the rebase (${after.changedPaths.length} path(s))`);
    }
    const targetAfter = await currentHead(mgr, target.top);
    if (targetAfter !== expectedTargetHead) {
      die(CODES.TARGET_MISMATCH, `target head changed to ${targetAfter} during refresh`);
    }
    if (!(await isAncestor(mgr, owned.path, expectedTargetHead, after.head))) {
      die(CODES.GIT_FAILED, `refreshed head ${after.head} does not descend from target head ${expectedTargetHead}`);
    }

    const state = await loadOwnershipState(mgr);
    const record = state.workspaces[owned.record.taskId];
    if (record) {
      record.baseCommit = expectedTargetHead;
      await saveOwnershipState(mgr, state);
    }
    return {
      schemaVersion: 1,
      kind: 'workspace-refresh',
      refreshed: true,
      conflict: false,
      reason: null,
      taskId: owned.record.taskId,
      path: owned.path,
      branch: owned.record.branch,
      repository: owned.record.repository,
      targetRepository: target.top,
      previousBaseCommit: owned.record.baseCommit,
      baseCommit: expectedTargetHead,
      targetHead: expectedTargetHead,
      head: after.head,
      dirty: after.dirty,
      changedPaths: after.changedPaths,
      rebased,
      adopted: !rebased,
      rebaseInProgress: false,
      reviewInvalidated: true,
      targetHeadUnchanged: true,
      workspace: {
        taskId: owned.record.taskId,
        path: owned.path,
        branch: owned.record.branch,
        baseCommit: expectedTargetHead,
        repository: owned.record.repository
      },
      at: Date.now()
    };
  });
};

/**
 * Remove a manager-owned workspace with native `git worktree remove`.
 * Requires an explicit `artifactState` and refuses pinned, dirty or uncollected work.
 */
WorkspaceManager.prototype.remove = async function remove(workspace, input) {
  const mgr = requireManager(this);
  return withLock(mgr, async () => {
    await prepareManager(mgr);
    const owned = await resolveOwnedWorkspace(mgr, workspace);
    const options = assertPlainObject(input, CODES.INVALID_REMOVE_INPUT, 'remove options');
    if (options.taskId !== undefined && options.taskId !== owned.record.taskId) {
      die(CODES.WORKSPACE_MISMATCH, 'remove options taskId does not match the owned workspace');
    }
    if (typeof options.artifactState !== 'string' || !ARTIFACT_STATES.includes(options.artifactState)) {
      die(CODES.INVALID_ARTIFACT_STATE, `artifactState is required and must be one of: ${ARTIFACT_STATES.join(', ')}`);
    }
    if (options.pinned !== undefined && typeof options.pinned !== 'boolean') {
      die(CODES.INVALID_PINNED, 'pinned must be a boolean when present');
    }
    if (options.pinned === true) die(CODES.PINNED, 'workspace is pinned; unpin before removing');
    const artifactState = options.artifactState;

    const state = await readWorkingState(mgr, owned.path);
    if (state.dirty) {
      die(CODES.DIRTY, `workspace has uncommitted changes (${state.changedPaths.length} path(s)); collect or discard them first`);
    }
    const head = state.head;
    const base = owned.record.baseCommit;
    const branchRef = `refs/heads/${owned.record.branch}`;
    const branchTip = await resolveRefOrNull(mgr, owned.record.repository, branchRef);
    const hasUncollectedHead = head !== base;

    if (artifactState === 'merged') {
      const integrated = owned.record.integrations.some((entry) => entry.head === head);
      if (hasUncollectedHead && !integrated) {
        die(
          CODES.UNCOLLECTED,
          `workspace head ${head} has not been integrated; integrate it or remove with artifactState "discarded"`
        );
      }
    } else if (artifactState === 'preserved') {
      if (hasUncollectedHead && branchTip !== head) {
        die(CODES.UNCOLLECTED, `workspace head ${head} is not preserved in ${branchRef}; remove as "discarded" to accept the loss`);
      }
    }

    // Plain, unforced native removal only: any git failure is reported and the workspace
    // is left untouched. No forced fallback, no recursive filesystem deletion.
    const removed = await gitRaw(mgr, ['worktree', 'remove', owned.path], {
      cwd: owned.record.repository,
      guardPaths: [owned.record.repository, owned.record.gitCommonDir, owned.path]
    });
    if (removed.spawnFailed) {
      die(removed.spawnCode === 'ENOENT' ? CODES.GIT_UNAVAILABLE : CODES.REMOVE_FAILED, `failed to run git: ${removed.spawnMessage}`);
    }
    if (removed.exitCode !== 0) {
      die(
        CODES.REMOVE_FAILED,
        `git worktree remove failed (exit ${removed.exitCode}): ${tailOf((removed.stderr || removed.stdout).trim())}`
      );
    }
    if (await pathExists(owned.path)) {
      die(CODES.REMOVE_FAILED, `git worktree remove reported success but the path still exists: ${owned.path}`);
    }

    const latest = await loadOwnershipState(mgr);
    if (latest.workspaces[owned.record.taskId]) {
      delete latest.workspaces[owned.record.taskId];
      await saveOwnershipState(mgr, latest);
    }

    return {
      schemaVersion: 1,
      kind: 'workspace-removal',
      taskId: owned.record.taskId,
      path: owned.path,
      repository: owned.record.repository,
      branch: owned.record.branch,
      baseCommit: base,
      head,
      artifactState,
      pinned: false,
      removed: true,
      removedAt: Date.now()
    };
  });
};

export default WorkspaceManager;
