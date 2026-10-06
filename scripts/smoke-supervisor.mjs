// scripts/smoke-supervisor.mjs
//
// REAL installed-DSH offline probe for the first runnable long-task supervisor
// (contract long-supervisor-first-edition-v1).
//
// Run by the controller:  node scripts/smoke-supervisor.mjs <dir with node_modules/@deepseek-ai/dsh>
//
// Guarantees:
//   * only FRESH temporary DSH homes inside the provided installation directory are used;
//     no production profile, no global setting, no existing session;
//   * the installed DSH is launched on an ephemeral port with the offline synthetic model
//     `test/fixtures/supervisor-provider.mjs`: no paid API call, no network, no GPU;
//   * the bridge is installed with the REAL host config, including the serializable
//     `eventWake` option and `supervisorProjects.enabled:true`, so the actual mount,
//     adapter, service hooks, orchestrator and durable outbox produce the evidence;
//   * every worker is a REAL bounded bridge task with its own session, and every writer a
//     real `WorkspaceManager` worktree created from a real temporary git repository;
//   * it NEVER performs a real Codex send: the project callback is observed as a durable
//     outbox record only (state `pending`, never `delivered`).
//
// Gates exercised: create-3, idempotency (duplicate create/finalize and duplicate project
// submission), retry with a fresh worktree, explicit cancellation, scope/model refusals,
// stop/aggregate gates, one callback per project and no per-worker wake.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import { install } from './install.mjs';
import { createWakeOutbox } from '../src/wake-outbox.mjs';

const TARGET = '01a0e7a9-7906-7280-86a5-abca2e6bca27';
const GRANT_ID = 'originating-chat';
const PROVIDER = 'bridge-supervisor-mock';
const AUTHORITY = Object.freeze({ root: true, source: 'trusted-controller' });
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const STOPPED = new Set(['completed', 'failed', 'cancelled']);

const source = path.resolve(import.meta.dirname, '..');
const dshRoot = path.resolve(process.argv[2] ?? process.cwd());
const dshBin = path.join(dshRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
assert.ok(fs.existsSync(dshBin), 'Provide the DSH installation directory that contains node_modules/@deepseek-ai/dsh');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function progress(line) {
  try {
    process.stderr.write(`[supervisor-smoke] ${String(line).slice(0, 300)}\n`);
  } catch {
    /* diagnostics only */
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readCalls(root) {
  const file = path.join(root, 'calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${String(result.stderr).slice(0, 400)}`);
  return String(result.stdout).trim();
}

async function rpc(endpoint, token, method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(20000)
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!body.error, JSON.stringify(body.error));
  return body.result;
}

/** Start one fresh temporary DSH host with the bridge installed and mounted. */
async function launchHost({ rootPrefix, gitRepo }) {
  const root = fs.mkdtempSync(path.join(dshRoot, rootPrefix));
  const home = path.join(root, 'home');
  const profile = path.join(home, 'profiles/web');
  fs.mkdirSync(profile, { recursive: true });
  fs.copyFileSync(path.join(source, 'test/fixtures/supervisor-provider.mjs'), path.join(root, 'provider.mjs'));

  // One real git repository: every writer worker must get a real owned worktree from it.
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '--quiet'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# supervisor smoke\n');
  runGit(['add', '.'], repo);
  runGit(['-c', 'user.name=bridge-smoke', '-c', 'user.email=bridge-smoke@example.invalid', 'commit', '--quiet', '-m', 'base'], repo);
  const base = runGit(['rev-parse', 'HEAD'], repo);

  const hostConfig = {
    dataDirectory: path.join(root, 'state'),
    credentialFile: path.join(root, 'bridge-token'),
    ownerId: 'codex-bridge-supervisor',
    agentPreset: 'standard',
    maxConcurrent: 16,
    supervisorProjects: { enabled: true, maxWorkers: 8, maxConcurrentWorkers: 3, maxRepairAttempts: 1, maxTotalRetries: 8, maxWorkerStarts: 12, maxTotalToolCalls: 1000, projectTimeoutMs: 600000, reserveSlots: 1 },
    eventWake: { enabled: true, stateRoot: path.join(root, 'wake-state'), maxSummaryChars: 8192, claimLeaseMs: 30000 },
    rootCallbackGrants: { [GRANT_ID]: { targetId: TARGET } }
  };
  const token = randomBytes(32).toString('base64url');
  fs.writeFileSync(hostConfig.credentialFile, token, { mode: 0o600 });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'bridge-supervisor-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
  );
  fs.writeFileSync(
    path.join(profile, 'cordis.patch.yml'),
    `- insert:\n    - id: bridge-supervisor-mock\n      name: ${JSON.stringify(path.join(root, 'provider.mjs'))}\n`
  );

  await install({ sourceDir: source, profileDir: profile, requireHostEntry: true, hostConfig });

  const logPath = path.join(root, 'host.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [dshBin, 'web', '--port', '0', '--no-open'], {
    cwd: dshRoot,
    env: { ...process.env, DSH_HOME: home },
    windowsHide: true,
    stdio: ['ignore', log, log]
  });
  fs.closeSync(log);
  const exited = once(child, 'exit');

  let endpoint;
  try {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`DSH exited during startup; inspect ${logPath}`);
      const content = fs.readFileSync(logPath, 'utf8');
      const address = content.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (address) {
        endpoint = `${address}/mcp/codex-bridge-v1`;
        try {
          await rpc(endpoint, token, 'ping', {});
          break;
        } catch {
          endpoint = undefined;
        }
      }
      await sleep(200);
    }
    assert.ok(endpoint, 'DSH startup timed out');
  } catch (error) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await Promise.race([exited, sleep(5000)]);
    throw error;
  }

  let stopped = false;
  return {
    root,
    repo,
    base,
    home,
    profile,
    endpoint,
    token,
    logPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
      await Promise.race([exited, sleep(5000)]);
    }
  };
}

function projectPacket({ key, model, repo, base, maxRepairAttempts = 1 }) {
  return {
    schemaVersion: 1,
    idempotencyKey: key,
    revision: 1,
    projectId: 'supervisor-smoke',
    title: `Long project ${model}`,
    objective: 'Declare a complete bounded worker plan for the offline smoke and let the host schedule, aggregate and report it honestly.',
    cwd: repo,
    role: 'investigate',
    acceptance: ['Every declared worker is scheduled with its own bounded scope.', 'The aggregate reports verified stop evidence for every worker.'],
    scope: { readRoots: [repo], writeRoots: [], allowedTools: ['read', 'glob', 'grep'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [],
    contractVersion: 'supervisor-first-edition-v1',
    rootCallback: { grantId: GRANT_ID },
    model: { provider: PROVIDER, model },
    project: {
      maxWorkers: 8,
      maxConcurrentWorkers: 3,
      maxRepairAttempts,
      maxTotalRetries: 8,
      maxWorkerStarts: 12,
      maxTotalToolCalls: 1000,
      timeoutMs: 600000,
      reserveSlots: 1,
      workerScope: { readRoots: [repo], writeRoots: [repo], allowedTools: ['read', 'write', 'edit'], allowNetwork: false },
      workspace: { repository: repo, baseRef: base }
    }
  };
}

async function main() {
  const report = {
    dsh: readJson(path.join(dshRoot, 'node_modules/@deepseek-ai/dsh/package.json'), {}).version ?? 'unknown',
    bridge: readJson(path.join(source, 'package.json'), {}).version ?? 'unknown',
    provider: 'offline synthetic model (test/fixtures/supervisor-provider.mjs); no paid API call',
    hosts: [],
    checks: [],
    notExecuted: [
      'no real Codex send was performed: the project callback is observed as a durable outbox record only',
      'no production profile, global setting, GPU or paid model was used'
    ]
  };
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      report.checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
      progress(`PASS ${name}`);
      return true;
    } catch (error) {
      report.checks.push({ name, passed: false, error: String(error?.stack ?? error) });
      progress(`FAIL ${name}: ${String(error?.message ?? error).slice(0, 200)}`);
      return false;
    }
  };

  const hosts = [];
  // Every task THIS smoke created. Teardown explicitly stops its own unfinished work and
  // proves the stop before terminating its own test host; other DSH hosts are untouched.
  const ownedTaskIds = new Set();
  let call = null;
  // The real worker task ids owned by a project task, used by teardown below.
  const workerTaskIds = (task) => (task.project?.workers ?? []).flatMap((worker) => (worker.attempts ?? []).map((attempt) => attempt.taskId).filter(Boolean));
  const stopOwnTasks = async () => {
    if (typeof call !== 'function') return;
    // Enumerate ONLY this smoke's own tasks AND their sub-workers: a project task's
    // workers are real owned tasks too, and an unfinished one must be stopped and
    // proved before the host is terminated.
    const targets = new Set(ownedTaskIds);
    for (const taskId of ownedTaskIds) {
      try {
        const { task } = await call('bridge_check', { taskId });
        for (const workerId of workerTaskIds(task)) targets.add(workerId);
      } catch (error) {
        report.teardown = [...(report.teardown ?? []), { taskId, enumerate: String(error?.code ?? error?.message ?? error) }];
      }
    }
    for (const taskId of targets) {
      try {
        const { task } = await call('bridge_check', { taskId });
        if (TERMINAL.has(task.status) && task.stopConfirmed === true && task.activeJobs === 0) continue;
        try {
          await call('bridge_cancel', { taskId, reason: 'supervisor smoke teardown: stopping this smoke task' });
        } catch (error) {
          report.teardown = [...(report.teardown ?? []), { taskId, cancel: String(error?.code ?? error?.message ?? error) }];
        }
        const deadline = Date.now() + 30000;
        let last = null;
        for (;;) {
          const { task: after } = await call('bridge_check', { taskId });
          last = after;
          if (TERMINAL.has(after.status) && after.stopConfirmed === true && after.activeJobs === 0) break;
          if (Date.now() > deadline) break;
          await sleep(200);
        }
        if (!last || last.stopConfirmed !== true || last.activeJobs !== 0) {
          report.teardown = [...(report.teardown ?? []), { taskId, stopped: false, status: last?.status ?? 'unreadable', stopConfirmed: last?.stopConfirmed ?? null, activeJobs: last?.activeJobs ?? null }];
        }
      } catch (error) {
        report.teardown = [...(report.teardown ?? []), { taskId, check: String(error?.code ?? error?.message ?? error) }];
      }
    }
  };
  try {
    const host = await launchHost({ rootPrefix: '.bridge-supervisor-', gitRepo: true });
    hosts.push(host);
    report.hosts.push({ root: host.root, repo: host.repo });
    call = async (name, args = {}) => {
      const result = await rpc(host.endpoint, host.token, 'tools/call', { name, arguments: args });
      if (result.isError) {
        const payload = JSON.parse(result.content[0].text);
        const error = new Error(`${name} refused: ${payload.code}: ${payload.message}`);
        error.code = payload.code;
        throw error;
      }
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    const outboxDir = path.join(host.root, 'wake-state');
    const listOutbox = async () => {
      const dirs = fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir).map((entry) => path.join(outboxDir, entry)).filter((entry) => fs.statSync(entry).isDirectory()) : [];
      const records = [];
      for (const dir of dirs) {
        const outbox = createWakeOutbox({ dir, authority: AUTHORITY, allowedTargetIds: [TARGET], maxSummaryChars: 8192 });
        try {
          for (const record of await outbox.listEvents()) records.push(record);
        } finally {
          await outbox.close();
        }
      }
      return records;
    };
    const waitProject = async (taskId, timeoutMs = 240000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { task } = await call('bridge_check', { taskId });
        const project = task.project ?? null;
        if (project !== null && ['completed', 'failed', 'cancelled', 'blocked'].includes(project.status) && TERMINAL.has(task.status)) return task;
        if (Date.now() > deadline) throw new Error(`project ${taskId} did not settle (task=${task.status} project=${project?.status})`);
        await sleep(300);
      }
    };
    const submitProject = async (packet) => {
      const submitted = await call('bridge_submit', { packet });
      if (submitted?.id) ownedTaskIds.add(submitted.id);
      return submitted;
    };

    /* ---------------------------------------------------------- capabilities */
    await check('capabilities advertise the enabled long-task supervisor and keep the legacy 16-tool surface', async () => {
      const caps = await call('bridge_capabilities');
      assert.equal(caps.supervisorProjects.enabled, true);
      assert.equal(caps.supervisorProjects.firstEdition.singleRound, true);
      assert.equal(caps.supervisorProjects.firstEdition.automaticMerge, false);
      assert.ok(caps.supervisorProjects.tools.includes('dsh_supervisor_worker_create'));
      const tools = await rpc(host.endpoint, host.token, 'tools/list', {});
      const packet = tools.tools.find((entry) => entry.name === 'bridge_submit').inputSchema.properties.packet;
      assert.ok(packet.properties.project, 'the discoverable entrypoint must advertise packet.project');
      return { tools: tools.tools.length, reserveSlots: caps.supervisorProjects.reserveSlots };
    });

    /* ------------------------------------------------------- create-3 + gates */
    let eventsBefore = (await listOutbox()).length;
    const okSubmitted = await submitProject(projectPacket({ key: 'smoke-ok-1', model: 'sup-ok', repo: host.repo, base: host.base }));
    const okTask = await waitProject(okSubmitted.id);
    await check('sup-ok: three bounded workers complete the project with verified stops and separate writer worktrees', async () => {
      assert.equal(okTask.status, 'completed');
      assert.equal(okTask.project.status, 'completed');
      assert.equal(okTask.stopConfirmed, true);
      assert.equal(okTask.project.workers.length, 3);
      for (const worker of okTask.project.workers) {
        assert.equal(worker.state, 'succeeded', `worker ${worker.workerKey} must succeed`);
        assert.equal(worker.attempts.length, 1, 'no worker needed a repair in this scenario');
        const workerTask = (await call('bridge_check', { taskId: worker.attempts[0].taskId })).task;
        assert.equal(workerTask.status, 'completed');
        assert.equal(workerTask.stopConfirmed, true);
        assert.equal(workerTask.activeJobs, 0);
      }
      const writer = okTask.project.workers.find((worker) => worker.workerKey === 'writer-c');
      assert.ok(writer.workspace, 'a writer always owns a fresh worktree');
      // The persisted project record keeps artifact evidence on the ATTEMPT (the
      // model-facing `workerList` view projects it as `worker.inspect`), so the raw
      // persisted layer correctly asserts `writer.attempts[last].inspect`.
      const writerAttempt = writer.attempts[writer.attempts.length - 1];
      assert.equal(writerAttempt.inspect?.dirty, true, 'the uncommitted writer artifact must be reported');
      assert.ok(writerAttempt.inspect?.changedPaths?.includes('worker-note.txt'), `changedPaths must name the artifact: ${JSON.stringify(writerAttempt.inspect?.changedPaths)}`);
      const workerTask = (await call('bridge_check', { taskId: writerAttempt.taskId })).task;
      assert.ok(fs.existsSync(workerTask.workspace.path), 'the owned worktree really exists on disk');
      // The duplicate create + duplicate finalize in the fixture created nothing extra.
      const calls = readCalls(host.root);
      const supervisorCalls = calls.filter((entry) => entry.role === 'supervisor');
      assert.ok(supervisorCalls.length >= 1);
      const workerSessions = new Set(calls.filter((entry) => entry.role === 'worker').map((entry) => entry.workerKey));
      assert.deepEqual([...workerSessions].sort(), ['ok-a', 'ok-b', 'writer-c']);
      return { workers: okTask.project.workers.map((worker) => worker.workerKey), dirty: writerAttempt.inspect.changedPaths };
    });

    await check('sup-ok: exactly one completion callback per project and no per-worker wake', async () => {
      const records = await listOutbox();
      const mine = records.filter((record) => record.taskId === okTask.id);
      assert.equal(mine.length, 1, `one project callback expected, got ${mine.length}`);
      assert.equal(mine[0].kind, 'completed');
      assert.match(String(mine[0].summary), /writer-c/);
      assert.equal(mine[0].state, 'pending', 'the host proves enqueue, never delivery');
      for (const workerId of workerTaskIds(okTask)) {
        assert.equal(records.filter((record) => record.taskId === workerId).length, 0, 'a worker completion must never wake the coordinator');
      }
      assert.equal(records.length, eventsBefore + 1);
      return { events: records.length, eventId: mine[0].eventId };
    });

    await check('sup-ok: resubmitting the identical project packet reuses the task and starts nothing', async () => {
      const callsBefore = readCalls(host.root).length;
      const again = await submitProject(projectPacket({ key: 'smoke-ok-1', model: 'sup-ok', repo: host.repo, base: host.base }));
      assert.equal(again.id, okTask.id);
      assert.equal(readCalls(host.root).length, callsBefore, 'no new model session may start for an idempotent replay');
      return { taskId: again.id };
    });

    await check('worker sessions never see supervisor, child, job or reply tools', async () => {
      const calls = readCalls(host.root);
      const workerCalls = calls.filter((entry) => entry.role === 'worker');
      assert.ok(workerCalls.length >= 3);
      const forbidden = /dsh_supervisor_|dsh_child_|dsh_job_start|dsh_bridge_reply/;
      for (const entry of workerCalls) {
        const named = (entry.tools ?? []).filter((name) => forbidden.test(name));
        assert.deepEqual(named, [], `worker ${entry.workerKey} must not see ${named.join(',')}`);
      }
      return { workerSessions: workerCalls.length };
    });

    /* --------------------------------------------------------- scope refusals */
    eventsBefore = (await listOutbox()).length;
    const refuseSubmitted = await submitProject(projectPacket({ key: 'smoke-refuse-1', model: 'sup-refuse', repo: host.repo, base: host.base }));
    const refuseTask = await waitProject(refuseSubmitted.id);
    await check('sup-refuse: a widened root and a model field are refused, then the valid plan runs', async () => {
      assert.equal(refuseTask.status, 'completed');
      assert.equal(refuseTask.project.workers.length, 1);
      assert.equal(refuseTask.project.workers[0].workerKey, 'ok-a');
      const round = refuseTask.project.rounds[refuseTask.project.rounds.length - 1];
      assert.match(String(round.text), /rootRefused=true/);
      assert.match(String(round.text), /modelRefused=true/);
      const records = await listOutbox();
      assert.equal(records.filter((record) => record.taskId === refuseTask.id).length, 1);
      return { text: String(round.text).slice(0, 200) };
    });

    /* ----------------------------------------------------------------- retry */
    const retrySubmitted = await submitProject(projectPacket({ key: 'smoke-retry-1', model: 'sup-retry', repo: host.repo, base: host.base, maxRepairAttempts: 1 }));
    const retryTask = await waitProject(retrySubmitted.id);
    await check('sup-retry: one ordinary failure is repaired in a FRESH worktree and the first artifact is preserved', async () => {
      assert.equal(retryTask.status, 'completed');
      const worker = retryTask.project.workers.find((candidate) => candidate.workerKey === 'retry-a');
      assert.equal(worker.attempts.length, 2, 'exactly one bounded repair');
      const [first, second] = worker.attempts;
      assert.notEqual(first.taskId, second.taskId);
      const firstTask = (await call('bridge_check', { taskId: first.taskId })).task;
      const secondTask = (await call('bridge_check', { taskId: second.taskId })).task;
      assert.equal(firstTask.status, 'failed');
      assert.equal(firstTask.stopConfirmed, true);
      assert.equal(secondTask.status, 'completed');
      assert.notEqual(firstTask.workspace.path, secondTask.workspace.path, 'every attempt gets its own worktree');
      assert.ok(fs.existsSync(firstTask.workspace.path), 'the failed attempt artifact is preserved, never deleted');
      assert.ok(fs.existsSync(secondTask.workspace.path));
      return { attempts: worker.attempts.length, firstHead: first.inspect?.head ?? null };
    });

    /* ------------------------------------------------------- explicit cancel */
    const cancelSubmitted = await submitProject(projectPacket({ key: 'smoke-cancel-1', model: 'sup-cancel', repo: host.repo, base: host.base }));
    await check('sup-cancel: an explicitly cancelled worker is never respawned and the project fails cleanly after all stops', async () => {
      const deadline = Date.now() + 120000;
      let target = null;
      for (;;) {
        const { task } = await call('bridge_check', { taskId: cancelSubmitted.id });
        const worker = (task.project?.workers ?? []).find((candidate) => candidate.workerKey === 'slow-a');
        const attempt = worker?.attempts?.[0];
        if (attempt?.taskId) {
          const workerTask = (await call('bridge_check', { taskId: attempt.taskId })).task;
          if (['queued', 'starting', 'running'].includes(workerTask.status)) {
            target = attempt.taskId;
            break;
          }
          if (TERMINAL.has(workerTask.status)) throw new Error(`slow-a settled before it could be cancelled: ${workerTask.status}`);
        }
        if (Date.now() > deadline) throw new Error('no running slow-a worker became observable');
        await sleep(200);
      }
      await call('bridge_cancel', { taskId: target, reason: 'supervisor smoke cancellation probe' });
      const settled = await waitProject(cancelSubmitted.id);
      assert.equal(settled.status, 'failed', 'a required cancelled worker fails the project');
      assert.equal(settled.stopConfirmed, true, 'only a fully stopped failure may be terminal failed');
      assert.equal(settled.project.status, 'failed');
      const worker = settled.project.workers.find((candidate) => candidate.workerKey === 'slow-a');
      assert.equal(worker.attempts.length, 1, 'a cancelled worker is never retried as an ordinary failure');
      const workerTask = (await call('bridge_check', { taskId: target })).task;
      assert.equal(workerTask.status, 'cancelled');
      const records = await listOutbox();
      const mine = records.filter((record) => record.taskId === settled.id);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].kind, 'failed');
      return { workerState: worker.state, project: settled.project.status };
    });

    /* --------------------------------------------------- legacy path intact */
    await check('a legacy bounded task still runs unchanged on the same host', async () => {
      const submitted = await call('bridge_submit', {
        packet: {
          schemaVersion: 1,
          idempotencyKey: `legacy-${Date.now()}`,
          revision: 1,
          projectId: 'supervisor-smoke',
          title: 'legacy bounded task',
          objective: 'Answer with the offline ordinary marker.',
          cwd: host.repo,
          role: 'investigate',
          acceptance: ['A bounded result is returned.'],
          scope: { readRoots: [host.repo], writeRoots: [], allowedTools: ['read'], allowShell: false, allowNetwork: false, allowDelegation: false },
          materials: [],
          contractVersion: 'supervisor-first-edition-v1',
          model: { provider: PROVIDER, model: 'sup-ok' }
        }
      });
      if (submitted?.id) ownedTaskIds.add(submitted.id);
      const deadline = Date.now() + 120000;
      for (;;) {
        const { task } = await call('bridge_check', { taskId: submitted.id });
        if (TERMINAL.has(task.status)) {
          assert.equal(task.status, 'completed');
          assert.equal(task.project, undefined, 'a legacy task must never be treated as a project');
          return { status: task.status };
        }
        if (Date.now() > deadline) throw new Error(`legacy task did not settle (${task.status})`);
        await sleep(200);
      }
    });

    report.passed = report.checks.every((entry) => entry.passed === true);
  } catch (error) {
    report.passed = false;
    report.error = String(error?.stack ?? error);
  } finally {
    // Stop and prove the stop of THIS smoke host's own unfinished work BEFORE the host is
    // terminated. Unknown evidence is preserved in the report; no other host is touched.
    try {
      await stopOwnTasks();
    } catch (error) {
      report.teardown = [...(report.teardown ?? []), { error: String(error?.stack ?? error) }];
    }
    for (const host of hosts) {
      // A teardown failure must never mask the primary check result: each host stop is
      // recorded in the report instead of being thrown from this finally block.
      try {
        await host.stop();
      } catch (error) {
        report.teardown = [...(report.teardown ?? []), { hostStop: String(error?.stack ?? error) }];
      }
    }
    const reportPath = process.env.DSH_SUPERVISOR_SMOKE_REPORT ?? path.join(hosts[0]?.root ?? process.cwd(), 'supervisor-smoke-report.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  }
  return report.passed === true ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  }
);
