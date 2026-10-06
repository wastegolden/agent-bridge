/**
 * Phase 1 D independent public acceptance tests — contract 20260925.1
 * (`evidence/upgrade-20260925/CONTRACT.md`, sections A–D).
 *
 * These tests are written against the PUBLIC imports only. They are authored
 * independently of the candidate workers and are intended to be executed by the
 * coordinator: `node --test test/*.test.mjs`. The author did NOT run them and
 * makes no claim about their result.
 *
 * Coverage:
 *   A  discoverable checks schema + ack enum + refresh-invalidates-review ordering
 *   B  DshAdapter.preflight shape/fences/zero-mutation + capabilities().toolContract
 *   C  real temporary-git refresh cases (identity, conflict, non-content failure)
 *
 * Evidence class: MOCK (fake hosts / fake dispatcher service) plus real
 * temporary-git and real temp-filesystem assertions. Node 24 builtins only.
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
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS, createDispatcher, createMcpHandler } from '../src/mcp.mjs';
import { DshAdapter } from '../src/dsh-adapter.mjs';
import { WorkspaceManager } from '../src/workspaces.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODES = WorkspaceManager.ERROR_CODES;
const IDENTITY_CODE = CODES.GIT_IDENTITY_UNAVAILABLE ?? 'E_GIT_IDENTITY_UNAVAILABLE';

/* ------------------------------------------------------------------ *
 * temp-dir tracker and cleanup
 * ------------------------------------------------------------------ */

const TMP_BASE = mkdtempSync(path.join(os.tmpdir(), 'dsh-upgrade-contract-'));
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
 * safe process helper (file-descriptor capture: the DSH sandbox forbids
 * piped child stdio) and git discovery
 * ------------------------------------------------------------------ */

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

function gitCandidates() {
  const candidates = [];
  if (process.env.DSH_WORKSPACES_GIT) candidates.push(process.env.DSH_WORKSPACES_GIT);
  candidates.push('git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe');
  const cacheRoot = path.join(os.homedir(), '.cache', 'codex-runtimes');
  let entries = [];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    candidates.push(path.join(cacheRoot, entry, 'dependencies', 'native', 'git', 'cmd', 'git.exe'));
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

const GIT = findGit();

function git(args, options = {}) {
  return run(GIT, args, options);
}

/* ------------------------------------------------------------------ *
 * real temp-git fixtures
 * ------------------------------------------------------------------ */

function writeRepoFile(directory, relative, content) {
  const target = path.join(directory, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Commit with an explicit inline identity so the fixture never depends on
 * repository-local user.name/user.email being configured. */
function commitAll(directory, message) {
  git([
    '-C',
    directory,
    '-c',
    'user.name=Upgrade Contract Test',
    '-c',
    'user.email=upgrade-contract@local',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    message
  ]);
  return headOf(directory);
}

function makeRepo({ identity = true, files = { 'a.txt': 'base\n' } } = {}) {
  const directory = track(mkdtempSync(path.join(os.tmpdir(), 'dsh-upgrade-repo-')));
  git(['init', '-q', '-b', 'main', directory]);
  git(['-C', directory, 'config', 'commit.gpgsign', 'false']);
  // Deterministic line-ending handling from creation onward: with no repository-local
  // value, core.autocrlf is inherited from the ambient global/system config, so a
  // fixture that later hides that config would re-read checked-out files as modified
  // and fail on a spurious dirty worktree instead of on the behaviour under test.
  git(['-C', directory, 'config', 'core.autocrlf', 'false']);
  if (identity) {
    git(['-C', directory, 'config', 'user.name', 'Upgrade Contract Test']);
    git(['-C', directory, 'config', 'user.email', 'upgrade-contract@local']);
  }
  for (const [relative, content] of Object.entries(files)) writeRepoFile(directory, relative, content);
  git(['-C', directory, 'add', '-A']);
  commitAll(directory, 'base');
  return { dir: directory, top: realpathSync(directory) };
}

function makeRoot() {
  return realpathSync(track(mkdtempSync(path.join(os.tmpdir(), 'dsh-upgrade-root-'))));
}

function manager(root) {
  return new WorkspaceManager({ root, git: GIT });
}

function headOf(directory) {
  return git(['-C', directory, 'rev-parse', 'HEAD']).stdout.trim();
}

function porcelainOf(directory) {
  return git(['-C', directory, 'status', '--porcelain']).stdout.trim();
}

function unmergedOf(directory) {
  return git(['-C', directory, 'diff', '--name-only', '--diff-filter=U']).stdout.trim();
}

function gitDirOf(directory) {
  return git(['-C', directory, 'rev-parse', '--absolute-git-dir']).stdout.trim();
}

function commitFiles(directory, files, message) {
  for (const [relative, content] of Object.entries(files)) writeRepoFile(directory, relative, content);
  git(['-C', directory, 'add', '-A']);
  return commitAll(directory, message);
}

async function captureError(fn) {
  let error = null;
  try {
    await fn();
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'expected the call to throw, but it resolved');
  return error;
}

/* ------------------------------------------------------------------ *
 * schema subset checker (section A: fields and ranges)
 * ------------------------------------------------------------------ */

/**
 * Return the list of JSON-Schema violations of `value` against the subset of
 * the schema the contract names (type, minLength, maxLength, pattern, minimum,
 * maximum, enum, allOf, not). An empty list means "advertised as acceptable".
 */
function schemaViolations(schema, value) {
  if (!schema || typeof schema !== 'object') return [];
  const violations = [];
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) violations.push(...schemaViolations(sub, value));
  }
  if (schema.not !== undefined && schemaViolations(schema.not, value).length === 0) violations.push('not');
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) violations.push('enum');
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [...violations, 'type'];
    if (schema.minLength !== undefined && value.length < schema.minLength) violations.push('minLength');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) violations.push('maxLength');
    if (schema.pattern !== undefined) {
      let matches = true;
      try {
        matches = new RegExp(schema.pattern).test(value);
      } catch {
        matches = true; // an unusable pattern cannot be held against the schema here
      }
      if (!matches) violations.push('pattern');
    }
    return violations;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return [...violations, 'type'];
    if (schema.minimum !== undefined && value < schema.minimum) violations.push('minimum');
    if (schema.maximum !== undefined && value > schema.maximum) violations.push('maximum');
    return violations;
  }
  return violations;
}

function toolByName(name) {
  const tool = TOOLS.find((entry) => entry.name === name);
  assert.ok(tool, `tool ${name} must be advertised`);
  return tool;
}

function assertNonEmptyCollection(value, label) {
  if (Array.isArray(value)) {
    assert.ok(value.length > 0, `${label} must be a non-empty array`);
    return;
  }
  assert.ok(value !== null && typeof value === 'object', `${label} must be an array or an object map`);
  assert.ok(Object.keys(value).length > 0, `${label} must not be empty`);
}

function assertJsonSafe(value, label) {
  const seen = new Set();
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null) continue;
    const type = typeof current;
    assert.ok(type !== 'function' && type !== 'symbol' && type !== 'bigint', `${label}: non-JSON ${type}`);
    if (type === 'number') assert.ok(Number.isFinite(current), `${label}: non-finite number`);
    if (type === 'object') {
      assert.ok(!(current instanceof Set) && !(current instanceof Map), `${label}: live ${current.constructor?.name}`);
      if (seen.has(current)) continue;
      seen.add(current);
      for (const key of Object.keys(current)) stack.push(current[key]);
    }
  }
}

/* ================================================================== *
 * Section A — MCP contract
 * ================================================================== */

test('A: tools/list publishes the shared checks schema with the contract fields and ranges', async () => {
  const token = 'upgrade-contract-token-'.repeat(2);
  const server = http.createServer(createMcpHandler({}, { token }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let listed;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    listed = (await response.json()).result.tools;
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  for (const name of [
    'bridge_submit',
    'bridge_check',
    'bridge_result',
    'bridge_approve',
    'bridge_cancel',
    'bridge_reconcile',
    'bridge_list',
    'bridge_acknowledge',
    'bridge_models',
    'bridge_capabilities',
    'bridge_cleanup',
    'bridge_workspace_review',
    'bridge_workspace_refresh',
    'bridge_workspace_integrate'
  ]) {
    assert.ok(listed.some((entry) => entry.name === name), `tools/list must advertise ${name}`);
  }

  const reviewChecks = listed.find((t) => t.name === 'bridge_workspace_review').inputSchema.properties.checks;
  const integrateSchema = listed.find((t) => t.name === 'bridge_workspace_integrate').inputSchema;
  const integrateChecks = integrateSchema.properties.checks;
  const baselineChecks = integrateSchema.properties.baselineChecks;

  assert.deepEqual(reviewChecks, integrateChecks, 'review and integrate must share one checks schema');
  assert.deepEqual(integrateChecks, baselineChecks, 'integrate checks and baselineChecks must share one schema');

  assert.equal(reviewChecks.type, 'array');
  assert.equal(reviewChecks.maxItems, 64);
  assert.ok(reviewChecks.items && typeof reviewChecks.items === 'object', 'checks must advertise an item schema');
  assert.equal(reviewChecks.items.type, 'object');
  assert.notEqual(
    reviewChecks.items.additionalProperties,
    false,
    'unknown item keys stay compatible with the runtime validator'
  );

  const required = Array.isArray(reviewChecks.items.required) ? reviewChecks.items.required : [];
  assert.ok(required.includes('command'), 'command must be required');
  assert.equal(required.includes('args'), false, 'args must stay optional');
  assert.equal(required.includes('timeoutMs'), false, 'timeoutMs must stay optional');

  const properties = reviewChecks.items.properties ?? {};

  const command = properties.command ?? {};
  assert.equal(command.type, 'string');
  assert.equal(command.maxLength, 4096);
  assert.equal(schemaViolations(command, 'node').length, 0, 'a plain executable name must be accepted');
  assert.equal(schemaViolations(command, 'x'.repeat(4096)).length, 0, 'a 4096-character command must be accepted');
  assert.ok(schemaViolations(command, '').length > 0, 'the advertised schema must reject a blank command');
  assert.ok(schemaViolations(command, 'node\nevil').length > 0, 'the advertised schema must reject a newline');
  assert.ok(schemaViolations(command, 'node\revil').length > 0, 'the advertised schema must reject a CR');
  assert.ok(schemaViolations(command, 'x'.repeat(4097)).length > 0, 'commands over 4096 characters must be rejected');

  const args = properties.args;
  assert.ok(args, 'args must be advertised');
  assert.equal(args.type, 'array');
  assert.ok(args.items && typeof args.items === 'object', 'args must advertise an item schema');
  assert.equal(args.items.type, 'string');
  assert.equal(args.items.maxLength, 8192);
  assert.equal(schemaViolations(args.items, 'plain').length, 0, 'a plain argument must be accepted');
  assert.equal(schemaViolations(args.items, 'x'.repeat(8192)).length, 0, 'an 8192-character argument must be accepted');
  assert.ok(schemaViolations(args.items, 'bad\u0000arg').length > 0, 'the advertised schema must reject NUL');
  assert.ok(schemaViolations(args.items, 'x'.repeat(8193)).length > 0, 'arguments over 8192 characters must be rejected');

  const timeoutMs = properties.timeoutMs;
  assert.ok(timeoutMs, 'timeoutMs must be advertised');
  assert.equal(timeoutMs.type, 'integer');
  assert.equal(timeoutMs.minimum, 1);
  assert.equal(timeoutMs.maximum, 600000);
  assert.equal(schemaViolations(timeoutMs, 1).length, 0);
  assert.equal(schemaViolations(timeoutMs, 600000).length, 0);
  assert.ok(schemaViolations(timeoutMs, 0).length > 0, 'timeoutMs 0 must be rejected');
  assert.ok(schemaViolations(timeoutMs, 600001).length > 0, 'timeoutMs beyond 600000 must be rejected');
  assert.ok(schemaViolations(timeoutMs, 1.5).length > 0, 'a non-integer timeoutMs must be rejected');
});

test('A: bridge_acknowledge advertises the resolveable artifactState enum', () => {
  const artifactState = toolByName('bridge_acknowledge').inputSchema.properties.artifactState;
  assert.ok(Array.isArray(artifactState.enum), 'artifactState must advertise an enum');
  assert.deepEqual(
    [...artifactState.enum].sort(),
    ['discarded', 'merged', 'none', 'preserved', 'unresolved'].sort(),
    'artifactState enum must be none|merged|preserved|discarded|unresolved'
  );
});

test('A: packet schema and result pagination keep their existing shape', () => {
  const packet = toolByName('bridge_submit').inputSchema.properties.packet;
  for (const field of [
    'schemaVersion',
    'idempotencyKey',
    'revision',
    'projectId',
    'title',
    'objective',
    'cwd',
    'role',
    'acceptance',
    'scope',
    'materials',
    'contractVersion'
  ]) {
    assert.ok(packet.required.includes(field), `packet.required must still include ${field}`);
  }
  assert.deepEqual(packet.properties.scope.required, [
    'readRoots',
    'writeRoots',
    'allowedTools',
    'allowShell',
    'allowNetwork',
    'allowDelegation'
  ]);

  const review = toolByName('bridge_workspace_review').inputSchema;
  for (const field of ['taskId', 'head', 'contractVersion', 'passed']) {
    assert.ok(review.required.includes(field), `review must still require ${field}`);
  }
  assert.equal(review.required.includes('checks'), false, 'checks stays optional');

  const result = toolByName('bridge_result').inputSchema.properties;
  assert.equal(result.limit.maximum, undefined, 'no stricter result pagination limit may be invented');
  assert.equal(result.offset.maximum, undefined, 'no stricter result pagination limit may be invented');
});

/* ------------------------------------------------------------------ *
 * Section A — refresh must invalidate a prior review before it mutates
 * ------------------------------------------------------------------ */

function refreshFixture(repository, overrides = {}) {
  return {
    id: 'task-upgrade-refresh',
    workspace: {
      taskId: 'task-upgrade-refresh',
      repository,
      path: path.join(repository, 'ws'),
      branch: 'task/task-upgrade-refresh',
      baseCommit: 'a'.repeat(40)
    },
    status: 'completed',
    stopConfirmed: true,
    activeJobs: 0,
    review: { head: 'b'.repeat(40), contractVersion: 'v1', passed: true },
    ...overrides
  };
}

test('A: bridge_workspace_refresh invalidates the stored review before a throwing refresh', async () => {
  const repository = realpathSync(TMP_BASE);
  const task = refreshFixture(repository);
  const log = [];
  const store = {
    get: (id) => (id === task.id ? task : undefined),
    update: (id, patch) => {
      log.push({ kind: 'update', patch });
      Object.assign(task, patch);
    }
  };
  const failure = Object.assign(new Error('mutating refresh failed after partial work'), {
    code: 'E_REBASE_IN_PROGRESS'
  });
  const workspaces = {
    refresh: async () => {
      log.push({ kind: 'refresh' });
      throw failure;
    }
  };
  const dispatch = createDispatcher({ store, workspaces });

  await assert.rejects(
    dispatch('bridge_workspace_refresh', {
      taskId: task.id,
      targetRepository: repository,
      expectedTargetHead: 'c'.repeat(40)
    }),
    (error) => error === failure
  );

  const refreshIndex = log.findIndex((entry) => entry.kind === 'refresh');
  const invalidationIndex = log.findIndex(
    (entry) => entry.kind === 'update' && entry.patch && Object.hasOwn(entry.patch, 'review') && entry.patch.review === null
  );
  assert.ok(invalidationIndex >= 0, 'the review must be invalidated through store.update before the refresh throws');
  assert.ok(refreshIndex >= 0, 'workspaces.refresh must still have been called');
  assert.ok(
    invalidationIndex < refreshIndex,
    'review invalidation must happen BEFORE workspace.refresh runs, not after it returns'
  );
  assert.equal(task.review, null, 'the stale approval must not survive a mutating refresh exception');
});

test('A: bridge_workspace_refresh keeps the review invalidated after a successful refresh', async () => {
  const repository = realpathSync(TMP_BASE);
  const task = refreshFixture(repository, { id: 'task-upgrade-refresh-ok' });
  task.workspace.taskId = task.id;
  const store = {
    get: (id) => (id === task.id ? task : undefined),
    update: (id, patch) => Object.assign(task, patch)
  };
  const refreshedHead = 'd'.repeat(40);
  const workspaces = {
    refresh: async () => ({
      schemaVersion: 1,
      kind: 'workspace-refresh',
      refreshed: true,
      conflict: false,
      reviewInvalidated: true,
      head: refreshedHead,
      workspace: { taskId: task.id, path: task.workspace.path, branch: task.workspace.branch, baseCommit: 'e'.repeat(40), repository }
    })
  };
  const result = await createDispatcher({ store, workspaces })('bridge_workspace_refresh', {
    taskId: task.id,
    targetRepository: repository,
    expectedTargetHead: 'e'.repeat(40)
  });
  assert.equal(result.refreshed, true);
  assert.equal(task.review, null, 'a completed refresh must leave the old review invalidated');
});

test('A: bridge_workspace_refresh does not invalidate the review when an earlier gate fails', async () => {
  const repository = realpathSync(TMP_BASE);
  const otherRepository = makeRoot();
  const log = [];

  const settled = refreshFixture(repository, { id: 'task-not-settled', status: 'queued' });
  const settledStore = {
    get: (id) => (id === settled.id ? settled : undefined),
    update: () => log.push('update')
  };
  const settledWorkspaces = { refresh: async () => log.push('refresh') };
  const settledError = await captureError(() =>
    createDispatcher({ store: settledStore, workspaces: settledWorkspaces })('bridge_workspace_refresh', {
      taskId: settled.id,
      targetRepository: repository,
      expectedTargetHead: 'c'.repeat(40)
    })
  );
  assert.equal(settledError.code, 'TASK_NOT_SETTLED');
  assert.deepEqual(log, [], 'a failed task gate must not invalidate the review or call refresh');

  const mismatched = refreshFixture(repository, { id: 'task-mismatch' });
  const mismatchStore = {
    get: (id) => (id === mismatched.id ? mismatched : undefined),
    update: () => log.push('update')
  };
  const mismatchWorkspaces = { refresh: async () => log.push('refresh') };
  const mismatchError = await captureError(() =>
    createDispatcher({ store: mismatchStore, workspaces: mismatchWorkspaces })('bridge_workspace_refresh', {
      taskId: mismatched.id,
      targetRepository: otherRepository,
      expectedTargetHead: 'c'.repeat(40)
    })
  );
  assert.equal(mismatchError.code, 'TARGET_MISMATCH');
  assert.deepEqual(log, [], 'a target gate failure must not invalidate the review or call refresh');
});

/* ================================================================== *
 * Section B — adapter preflight and capabilities().toolContract
 * ================================================================== */

const ADAPTER_CATALOG = [
  'read',
  'write',
  'edit',
  'read_image',
  'glob',
  'grep',
  'str_replace_editor',
  'todo_write',
  'present',
  'ask_user_question',
  'get_goal',
  'job_output',
  'job_kill',
  'web_search',
  'web_fetch',
  'pwsh',
  'bash',
  'subagent',
  'send_message',
  'workflow',
  'skill',
  'create_goal'
];

function createAdapterHost({ catalog = ADAPTER_CATALOG, toolsUnavailable = false, schemasThrow = false } = {}) {
  const calls = { create: [], prompt: [], selectModel: [], restrict: [], guard: [], schemas: 0 };
  const tools = toolsUnavailable
    ? undefined
    : {
        schemas: () => {
          calls.schemas += 1;
          if (schemasThrow) throw new Error('tool registry schemas unavailable');
          return catalog.map((name) => ({ name }));
        },
        restrict: () => {
          calls.restrict.push('restrict');
          return () => {};
        },
        guard: () => {
          calls.guard.push('guard');
          return () => {};
        }
      };
  const sessionController = {
    async create(request) {
      calls.create.push(request);
      throw new Error('preflight must never create a session');
    },
    async prompt(request) {
      calls.prompt.push(request);
      throw new Error('preflight must never prompt');
    },
    async selectModel(request) {
      calls.selectModel.push(request);
      throw new Error('preflight must never select a model');
    }
  };
  const services = {
    sessionController,
    agents: { get: () => undefined },
    jobs: { get: () => undefined, list: () => [] },
    fs: { sandboxMode: 'workspace-write' },
    workspaceRegistry: {},
    llm: { listProviders: () => [], listModels: async () => [] }
  };
  const ctx = {
    get(name) {
      if (name === 'tools') return tools;
      return services[name];
    },
    on() {
      return () => {};
    }
  };
  return { ctx, calls };
}

function packetFor(allowedTools) {
  return {
    schemaVersion: 1,
    idempotencyKey: `upgrade-contract-${randomUUID()}`,
    revision: 1,
    projectId: 'dsh-upgrade-20260925',
    title: 'preflight acceptance probe',
    objective: 'Exercise adapter preflight without creating a session, prompt or registry mutation.',
    cwd: HERE,
    role: 'implement',
    acceptance: ['preflight returns the documented JSON shape'],
    scope: {
      readRoots: [HERE],
      writeRoots: [],
      allowedTools,
      allowShell: false,
      allowNetwork: false,
      allowDelegation: false
    },
    materials: [],
    contractVersion: '20260925.1'
  };
}

test('B: preflight reports the documented JSON shape with zero session, prompt or registry mutations', async () => {
  const host = createAdapterHost();
  const adapter = new DshAdapter(host.ctx);
  assert.equal(typeof adapter.preflight, 'function', 'DshAdapter must expose preflight(packet)');

  // The fake host registers a NONEMPTY global presentation that happens to include
  // the requested names. It must still never be promoted to complete availability:
  // a global `schemas()` view is scope presentation, not an all-agent catalog.
  const result = await adapter.preflight(packetFor(['write', 'read', 'todo_write']));

  assert.equal(result.ok, true);
  assert.equal(result.sessionVisibilityPending, true);
  assert.equal(result.availabilityVerified, false, 'an agentless global view is not a complete catalog');
  assert.equal(result.availableTools, null, 'preflight must not claim a catalog it cannot prove');
  assert.deepEqual([...result.requestedTools].sort(), ['read', 'todo_write', 'write']);
  assertNonEmptyCollection(result.enforceableTools, 'preflight.enforceableTools');
  assertJsonSafe(result, 'preflight result');
  for (const forbidden of ['plan', 'hooks', 'model', 'effectiveModel']) {
    assert.equal(Object.hasOwn(result, forbidden), false, `preflight must not return ${forbidden}`);
  }

  assert.equal(host.calls.schemas, 0, 'preflight must not consult the global presentation as a catalog');
  assert.deepEqual(host.calls.create, [], 'preflight must not create a session');
  assert.deepEqual(host.calls.prompt, [], 'preflight must not send a prompt');
  assert.deepEqual(host.calls.selectModel, [], 'preflight must not select or guess a model');
  assert.deepEqual(host.calls.restrict, [], 'preflight must not mutate the registry');
  assert.deepEqual(host.calls.guard, [], 'preflight must not register enforcement');
});

test('B: preflight reuses packet validation and plan enforcement without a session', async () => {
  const host = createAdapterHost();
  const adapter = new DshAdapter(host.ctx);

  const invalid = await captureError(() => adapter.preflight({ nope: true }));
  assert.equal(invalid.code, 'adapter/invalid-packet');

  const cwdless = packetFor(['read']);
  delete cwdless.cwd;
  const missingCwd = await captureError(() => adapter.preflight(cwdless));
  assert.equal(missingCwd.code, 'adapter/invalid-packet');

  const shell = packetFor(['read']);
  shell.scope.allowShell = true;
  const shellError = await captureError(() => adapter.preflight(shell));
  assert.equal(shellError.code, 'adapter/shell-unsupported', 'preflight must reuse the start plan fences');

  const delegation = packetFor(['read']);
  delegation.scope.allowDelegation = true;
  const delegationError = await captureError(() => adapter.preflight(delegation));
  assert.equal(delegationError.code, 'adapter/invalid-packet');

  const unclassified = await captureError(() => adapter.preflight(packetFor(['read', 'apply_patch'])));
  assert.equal(
    unclassified.code,
    'adapter/scope-unsupported',
    'apply_patch is unclassified and must hit the existing unsupported-boundary error'
  );

  const network = packetFor(['web_search']);
  const networkError = await captureError(() => adapter.preflight(network));
  assert.equal(networkError.code, 'adapter/scope-unsupported');

  assert.deepEqual(host.calls.create, [], 'no rejected preflight may create a session');
  assert.deepEqual(host.calls.prompt, [], 'no rejected preflight may prompt');
});

test('B: a nonempty global catalog missing the requested tool cannot prove absence', async () => {
  // The host global presentation lists only "write" and omits "read". A global
  // view is incomplete scope presentation: it can neither prove that a
  // per-agent/preset "read" is absent nor authorize a rejection, so preflight
  // must stay ok and explicitly unverified.
  const host = createAdapterHost({ catalog: ['write'] });
  const adapter = new DshAdapter(host.ctx);
  const result = await adapter.preflight(packetFor(['read', 'write']));
  assert.equal(result.ok, true, 'a global view must not fabricate a missing-tool rejection');
  assert.deepEqual(result.requestedTools, ['read', 'write']);
  assert.equal(result.availableTools, null);
  assert.equal(result.availabilityVerified, false);
  assert.equal(result.sessionVisibilityPending, true);
  assert.equal(host.calls.schemas, 0, 'an incomplete global view must not be consulted as a catalog');
  assert.deepEqual(host.calls.create, [], 'a catalog probe must not create a session');
  assert.deepEqual(host.calls.prompt, []);
});

test('B: preflight degrades honestly when the host catalog is unavailable or throws', async () => {
  for (const options of [{ toolsUnavailable: true }, { schemasThrow: true }]) {
    const host = createAdapterHost(options);
    const result = await new DshAdapter(host.ctx).preflight(packetFor(['read']));
    assert.equal(result.ok, true, 'an unverifiable catalog must not fabricate a rejection');
    assert.equal(result.availableTools, null);
    assert.equal(result.availabilityVerified, false);
    assert.equal(result.sessionVisibilityPending, true);
    assert.deepEqual(host.calls.create, [], 'availability probing must not create a session');
  }
});

test('B: capabilities().toolContract distinguishes enforceable from available', async () => {
  const host = createAdapterHost();
  const caps = await new DshAdapter(host.ctx).capabilities();
  const contract = caps.toolContract;
  assert.ok(contract && typeof contract === 'object', 'capabilities must expose toolContract');
  assert.equal(contract.sessionVisibilityPending, true);
  assert.equal(contract.availabilityVerified, false, 'an agentless capability report cannot verify availability');
  assert.equal(contract.availableTools, null, 'availability must stay unproved without a real agent');
  assertNonEmptyCollection(contract.enforceableTools, 'toolContract.enforceableTools');
  assertJsonSafe(contract, 'toolContract');
  assert.ok(Object.hasOwn(contract, 'deniedTools'), 'toolContract must record deniedTools');
  const denied = JSON.stringify(contract.deniedTools);
  assert.match(denied, /bash|skill|create_goal/, 'deniedTools must record unsupported tools/reasons');
  assert.equal(host.calls.schemas, 0, 'the global presentation must not be promoted to availability');

  const degraded = await new DshAdapter(createAdapterHost({ toolsUnavailable: true }).ctx).capabilities();
  assert.equal(degraded.toolContract.availableTools, null, 'an unavailable catalog must report null');
  assert.equal(degraded.toolContract.availabilityVerified, false);
  assertNonEmptyCollection(
    degraded.toolContract.enforceableTools,
    'classification support must survive an unavailable catalog'
  );
});

/* ================================================================== *
 * Section C — real temporary-git refresh cases
 * ================================================================== */

/**
 * Run `fn` with committer/author identity made unavailable to every git child:
 * global and system config point at an empty file, config-only user identity is
 * forced, and identity environment variables are cleared. The caller's process
 * environment is restored in `finally`; no user git config is read or written.
 */
async function withHiddenIdentity(fn) {
  const keys = [
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'EMAIL'
  ];
  const saved = new Map();
  for (const key of keys) saved.set(key, { present: Object.hasOwn(process.env, key), value: process.env[key] });

  const emptyConfig = path.join(TMP_BASE, 'empty-git-config');
  writeFileSync(emptyConfig, '');
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_SYSTEM = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly';
  process.env.GIT_CONFIG_VALUE_0 = 'true';
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
    delete process.env[key];
  }

  try {
    return await fn();
  } finally {
    for (const [key, previous] of saved) {
      if (previous.present) process.env[key] = previous.value;
      else delete process.env[key];
    }
  }
}

test('C: missing identity fails before rebase and leaves HEAD, index and local config untouched', async () => {
  const repo = makeRepo({ identity: false });
  const root = makeRoot();
  const mgr = manager(root);
  const ws = await mgr.create({ taskId: 'task-identity', repository: repo.top, baseRef: 'main' });

  commitFiles(repo.top, { 'target.txt': 'target\n' }, 'target-advance');
  const targetHead = headOf(repo.top);
  const branchHead = commitFiles(ws.path, { 'ws.txt': 'workspace\n' }, 'workspace-work');

  const gitDir = gitDirOf(ws.path);
  const configBefore = git(['-C', repo.top, 'config', '--local', '--list']).stdout.replace(/\r\n/g, '\n');
  const indexBefore = git(['-C', ws.path, 'diff', '--cached', '--name-only']).stdout;

  assert.equal(porcelainOf(ws.path), '', 'the identity fixture must be clean before its config is hidden');
  const error = await captureError(() =>
    withHiddenIdentity(() => {
      assert.equal(
        porcelainOf(ws.path),
        '',
        'hiding the global git config must not make the fixture worktree dirty'
      );
      return mgr.refresh(ws, { targetRepository: repo.top, expectedTargetHead: targetHead });
    })
  );
  assert.equal(error.code, IDENTITY_CODE, `missing identity must throw ${IDENTITY_CODE}`);

  assert.equal(headOf(ws.path), branchHead, 'a failed identity preflight must not move HEAD');
  assert.equal(porcelainOf(ws.path), '', 'a failed identity preflight must leave the index and worktree clean');
  assert.equal(git(['-C', ws.path, 'diff', '--cached', '--name-only']).stdout, indexBefore);
  assert.equal(unmergedOf(ws.path), '', 'no unmerged index path may be created');
  assert.equal(existsSync(path.join(gitDir, 'rebase-merge')), false, 'no rebase may have started');
  assert.equal(existsSync(path.join(gitDir, 'rebase-apply')), false, 'no rebase may have started');
  assert.equal(
    git(['-C', repo.top, 'config', '--local', '--list']).stdout.replace(/\r\n/g, '\n'),
    configBefore,
    'the identity preflight must not mutate repository config'
  );

  const details = JSON.stringify(error.details ?? {});
  assert.equal(details.includes('upgrade-contract@local'), false, 'identity values must not leak into error details');
});

test('C: an adopt-only refresh needs no identity', async () => {
  const repo = makeRepo({ identity: false });
  const root = makeRoot();
  const mgr = manager(root);
  const ws = await mgr.create({ taskId: 'task-adopt', repository: repo.top, baseRef: 'main' });
  const targetHead = headOf(repo.top);

  assert.equal(porcelainOf(ws.path), '', 'the adopt-only fixture must be clean before its config is hidden');
  const result = await withHiddenIdentity(() => {
    assert.equal(
      porcelainOf(ws.path),
      '',
      'hiding the global git config must not make the adopt-only fixture dirty'
    );
    return mgr.refresh(ws, { targetRepository: repo.top, expectedTargetHead: targetHead });
  });
  assert.equal(result.refreshed, true);
  assert.equal(result.rebased, false);
  assert.equal(result.adopted, true);
  assert.equal(result.reviewInvalidated, true);
  assert.equal(result.baseCommit, targetHead);
});

test('C: a real unmerged content conflict stays conflict:true/rebase_conflict and is preserved', async () => {
  const repo = makeRepo({ files: { 'shared.txt': 'base\n' } });
  const root = makeRoot();
  const mgr = manager(root);
  const wsA = await mgr.create({ taskId: 'task-conflict-a', repository: repo.top, baseRef: 'main' });
  const wsB = await mgr.create({ taskId: 'task-conflict-b', repository: repo.top, baseRef: 'main' });

  const headA = commitFiles(wsA.path, { 'shared.txt': 'from-a\n' }, 'a');
  const reviewA = await mgr.review(wsA, { head: headA, contractVersion: 'v1', passed: true, checks: [] });
  await mgr.integrate(wsA, { targetRepository: repo.top, review: reviewA, contractVersion: 'v1' });
  const targetHead = headOf(repo.top);
  const headB = commitFiles(wsB.path, { 'shared.txt': 'from-b\n' }, 'b');

  const result = await mgr.refresh(wsB, { targetRepository: repo.top, expectedTargetHead: targetHead });
  try {
    assert.equal(result.refreshed, false);
    assert.equal(result.conflict, true, 'a real unmerged content conflict must be reported as a conflict');
    assert.equal(result.reason, 'rebase_conflict');
    assert.equal(result.rebaseInProgress, true, 'the half-finished rebase must be preserved and reported');
    assert.ok(
      result.changedPaths.some((entry) => entry.replace(/\\/g, '/').endsWith('shared.txt')),
      'the actual unmerged path must be reported'
    );
    // A native rebase checks out the target and detaches HEAD before replaying the
    // branch, so the stopped scene's HEAD is not the pre-rebase branch head. Assert the
    // scene that actually exists and keep the old head as recoverable evidence, rather
    // than demanding the old HEAD equality the contract does not require.
    assert.equal(
      result.head,
      headOf(wsB.path),
      'the reported head must be the actual stopped rebase HEAD, not the pre-rebase branch head'
    );
    const origHead = git(['-C', wsB.path, 'rev-parse', 'ORIG_HEAD']).stdout.trim();
    assert.equal(origHead, headB, 'ORIG_HEAD must retain the pre-rebase workspace head');
    const branchTip = git(['-C', wsB.path, 'rev-parse', `refs/heads/${wsB.branch}`]).stdout.trim();
    assert.equal(
      branchTip,
      headB,
      'the workspace branch must still resolve to the pre-rebase head while the rebase is stopped'
    );
    assert.equal(headOf(repo.top), targetHead, 'the target must not move');
    assert.equal(existsSync(wsB.path), true, 'the conflicting workspace must not be deleted');
    assert.ok(unmergedOf(wsB.path).length > 0, 'the fixture must really leave an unmerged index path');
  } finally {
    git(['-C', wsB.path, 'rebase', '--abort']);
  }
  assert.equal(porcelainOf(wsB.path), '');
});

test('C: a non-content rebase failure is not reported as a conflict', async () => {
  const repo = makeRepo({ files: { 'a.txt': 'base\n' } });
  const root = makeRoot();
  const mgr = manager(root);
  const ws = await mgr.create({ taskId: 'task-non-content', repository: repo.top, baseRef: 'main' });

  commitFiles(repo.top, { 'target.txt': 't\n' }, 'target');
  const targetHead = headOf(repo.top);
  const branchHead = commitFiles(ws.path, { 'ws.txt': 'w\n' }, 'ws');

  const gitDir = gitDirOf(ws.path);
  const lock = path.join(gitDir, 'HEAD.lock');
  writeFileSync(lock, 'locked by upgrade-contract.test.mjs\n');

  let result;
  try {
    result = await mgr.refresh(ws, { targetRepository: repo.top, expectedTargetHead: targetHead });
  } finally {
    rmSync(lock, { force: true });
  }

  assert.equal(result.refreshed, false);
  assert.equal(result.conflict, false, 'a non-content failure must not be classified as a content conflict');
  assert.equal(result.reason, 'rebase_failed');
  assert.equal(unmergedOf(ws.path), '', 'the non-content failure fixture leaves no unmerged index path');
  assert.equal(headOf(ws.path), branchHead, 'the failed rebase must leave the workspace head intact');
  assert.equal(existsSync(ws.path), true, 'a failed rebase must not hide or remove the workspace');
  assert.equal(typeof result.rebaseInProgress, 'boolean');
});
