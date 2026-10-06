// scripts/smoke-recurrent.mjs
//
// REAL installed-DSH offline probe for the bounded RECURRENT supervisor and its durable
// pause/resume checkpoint (contract bounded-recurrent-supervisor-v1).
//
// Run by the controller: node scripts/smoke-recurrent.mjs <dir with node_modules/@deepseek-ai/dsh>
//
// Guarantees:
//   * only FRESH temporary DSH homes inside the provided installation directory are used;
//     no production profile, no global setting, no existing session;
//   * the installed DSH runs the offline synthetic model
//     `test/fixtures/recurrent-provider.mjs`: no paid API call, no network, no GPU;
//   * the bridge is installed with the REAL host config (eventWake + a recurrent
//     `supervisorProjects` block) so the actual mount, adapter, service hooks, round
//     dispatcher and durable outbox produce the evidence;
//   * every round runs through the real `adapter.nextRound` seam on the SAME owned
//     session, and every worker is a real bounded bridge task;
//   * it NEVER performs a real Codex send: callbacks are observed as durable outbox
//     records only (state `pending`, never `delivered`).
//
// Gates exercised: two genuine rounds consuming REAL worker results, no model polling
// while workers run, an honest round-cap failure, cumulative budget accounting, durable
// pause (pausing -> paused only with the full proof) and idempotent resume, a controller
// restart that never auto-resumes, and a legacy packet that gains none of it.
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
const PROVIDER = 'bridge-recurrent-mock';
const AUTHORITY = Object.freeze({ root: true, source: 'trusted-controller' });
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);

const source = path.resolve(import.meta.dirname, '..');
const dshRoot = path.resolve(process.argv[2] ?? process.cwd());
const dshBin = path.join(dshRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
assert.ok(fs.existsSync(dshBin), 'Provide the DSH installation directory that contains node_modules/@deepseek-ai/dsh');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function progress(line) {
  try {
    process.stderr.write(`[recurrent-smoke] ${String(line).slice(0, 300)}\n`);
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

/** Create one fresh temporary DSH home under the installation directory. */
function prepareState(rootPrefix) {
  const root = fs.mkdtempSync(path.join(dshRoot, rootPrefix));
  const home = path.join(root, 'home');
  const profile = path.join(home, 'profiles/web');
  fs.mkdirSync(profile, { recursive: true });
  fs.copyFileSync(path.join(source, 'test/fixtures/recurrent-provider.mjs'), path.join(root, 'provider.mjs'));

  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '--quiet'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# recurrent smoke\n');
  runGit(['add', '.'], repo);
  runGit(['-c', 'user.name=bridge-smoke', '-c', 'user.email=bridge-smoke@example.invalid', 'commit', '--quiet', '-m', 'base'], repo);
  const base = runGit(['rev-parse', 'HEAD'], repo);

  const hostConfig = {
    dataDirectory: path.join(root, 'state'),
    credentialFile: path.join(root, 'bridge-token'),
    ownerId: 'codex-bridge-recurrent',
    agentPreset: 'standard',
    maxConcurrent: 16,
    supervisorProjects: {
      enabled: true,
      maxWorkers: 8,
      maxConcurrentWorkers: 3,
      maxRepairAttempts: 1,
      maxTotalRetries: 8,
      maxWorkerStarts: 12,
      maxTotalToolCalls: 1000,
      projectTimeoutMs: 600000,
      reserveSlots: 1,
      maxRounds: 4,
      pause: true
    },
    eventWake: { enabled: true, stateRoot: path.join(root, 'wake-state'), maxSummaryChars: 8192, claimLeaseMs: 30000 },
    rootCallbackGrants: { [GRANT_ID]: { targetId: TARGET } }
  };
  const token = randomBytes(32).toString('base64url');
  fs.writeFileSync(hostConfig.credentialFile, token, { mode: 0o600 });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'bridge-recurrent-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
  );
  fs.writeFileSync(
    path.join(profile, 'cordis.patch.yml'),
    `- insert:\n    - id: bridge-recurrent-mock\n      name: ${JSON.stringify(path.join(root, 'provider.mjs'))}\n`
  );
  return { root, home, profile, repo, base, hostConfig, token };
}

/** Spawn one host over an existing state (used for the restart scenario too). */
async function startHost(state) {
  const logPath = path.join(state.root, `host-${Date.now()}.log`);
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [dshBin, 'web', '--port', '0', '--no-open'], {
    cwd: dshRoot,
    env: { ...process.env, DSH_HOME: state.home },
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
          await rpc(endpoint, state.token, 'ping', {});
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
    endpoint,
    logPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
      await Promise.race([exited, sleep(5000)]);
    }
  };
}

async function launch(rootPrefix) {
  const state = prepareState(rootPrefix);
  await install({ sourceDir: source, profileDir: state.profile, requireHostEntry: true, hostConfig: state.hostConfig });
  const host = await startHost(state);
  return { ...state, ...host };
}

function projectPacket({ key, model, repo, base, maxRounds }) {
  return {
    schemaVersion: 1,
    idempotencyKey: key,
    revision: 1,
    projectId: 'recurrent-smoke',
    title: `Recurrent project ${model}`,
    objective: 'Run bounded supervisor rounds that consume the real worker results, with a durable pause/resume checkpoint.',
    cwd: repo,
    role: 'investigate',
    acceptance: ['At least two supervisor rounds consume real worker results.', 'Pause/resume preserves the immutable deadline and cumulative budget.'],
    scope: { readRoots: [repo], writeRoots: [], allowedTools: ['read', 'glob', 'grep'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [],
    contractVersion: 'bounded-recurrent-supervisor-v1',
    rootCallback: { grantId: GRANT_ID },
    model: { provider: PROVIDER, model },
    project: {
      maxWorkers: 8,
      maxConcurrentWorkers: 3,
      maxRepairAttempts: 1,
      maxTotalRetries: 8,
      maxWorkerStarts: 12,
      maxTotalToolCalls: 1000,
      timeoutMs: 600000,
      reserveSlots: 1,
      workerScope: { readRoots: [repo], writeRoots: [repo], allowedTools: ['read', 'write', 'edit'], allowNetwork: false },
      workspace: { repository: repo, baseRef: base },
      ...(maxRounds === undefined ? {} : { maxRounds })
    }
  };
}

async function main() {
  const report = {
    dsh: readJson(path.join(dshRoot, 'node_modules/@deepseek-ai/dsh/package.json'), {}).version ?? 'unknown',
    bridge: readJson(path.join(source, 'package.json'), {}).version ?? 'unknown',
    provider: 'offline synthetic model (test/fixtures/recurrent-provider.mjs); no paid API call',
    hosts: [],
    checks: [],
    notExecuted: [
      'no real Codex send was performed: project callbacks are observed as durable outbox records only',
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
  const ownedTaskIds = new Set();
  let host = null;
  let call = null;
  const workerTaskIds = (task) => (task.project?.workers ?? []).flatMap((worker) => (worker.attempts ?? []).map((attempt) => attempt.taskId).filter(Boolean));
  const attachCall = (target) => {
    call = async (name, args = {}) => {
      const result = await rpc(target.endpoint, target.token, 'tools/call', { name, arguments: args });
      if (result.isError) {
        const payload = JSON.parse(result.content[0].text);
        const error = new Error(`${name} refused: ${payload.code}: ${payload.message}`);
        error.code = payload.code;
        throw error;
      }
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    host = target;
  };
  const submitProject = async (packet) => {
    const submitted = await call('bridge_submit', { packet });
    if (submitted?.id) ownedTaskIds.add(submitted.id);
    return submitted;
  };
  const checkTask = async (taskId) => (await call('bridge_check', { taskId })).task;
  const waitSettled = async (taskId, timeoutMs = 240000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = await checkTask(taskId);
      const project = task.project ?? null;
      if (project !== null && ['completed', 'failed', 'cancelled', 'blocked'].includes(project.status) && TERMINAL.has(task.status)) return task;
      if (Date.now() > deadline) throw new Error(`project ${taskId} did not settle (task=${task.status} project=${project?.status})`);
      await sleep(300);
    }
  };
  const waitFor = async (taskId, predicate, timeoutMs = 180000, label = 'condition') => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = await checkTask(taskId);
      if (predicate(task)) return task;
      if (Date.now() > deadline) throw new Error(`${label} not reached (task=${task.status} project=${task.project?.status} rounds=${task.project?.roundsUsed})`);
      await sleep(250);
    }
  };
  const listOutbox = async () => {
    const outboxDir = path.join(host.root, 'wake-state');
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
  // The durable outbox is written by the persist-before-send path AFTER the project
  // settles, so a single immediate read races the enqueue. A bounded observation wait is
  // the honest fix: it never synthesizes a record, never skips the callback assertion and
  // never treats "not yet written" as "not emitted".
  const observeOutboxRecords = async (taskId, expected = 1, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let records = [];
    for (;;) {
      records = (await listOutbox()).filter((record) => record.taskId === taskId);
      if (records.length >= expected || Date.now() > deadline) return records;
      await sleep(200);
    }
  };
  const stopOwnTasks = async () => {
    if (typeof call !== 'function') return;
    const targets = new Set(ownedTaskIds);
    for (const taskId of ownedTaskIds) {
      try {
        const task = await checkTask(taskId);
        for (const workerId of workerTaskIds(task)) targets.add(workerId);
      } catch (error) {
        report.teardown = [...(report.teardown ?? []), { taskId, enumerate: String(error?.code ?? error?.message ?? error) }];
      }
    }
    for (const taskId of targets) {
      try {
        const task = await checkTask(taskId);
        if (TERMINAL.has(task.status) && task.stopConfirmed === true && task.activeJobs === 0) continue;
        try {
          await call('bridge_cancel', { taskId, reason: 'recurrent smoke teardown' });
        } catch (error) {
          report.teardown = [...(report.teardown ?? []), { taskId, cancel: String(error?.code ?? error?.message ?? error) }];
        }
        const deadline = Date.now() + 30000;
        let last = null;
        for (;;) {
          last = await checkTask(taskId);
          if (TERMINAL.has(last.status) && last.stopConfirmed === true && last.activeJobs === 0) break;
          if (Date.now() > deadline) break;
          await sleep(200);
        }
        if (!last || last.stopConfirmed !== true || last.activeJobs !== 0) {
          report.teardown = [...(report.teardown ?? []), { taskId, stopped: false, status: last?.status ?? 'unreadable' }];
        }
      } catch (error) {
        report.teardown = [...(report.teardown ?? []), { taskId, check: String(error?.code ?? error?.message ?? error) }];
      }
    }
  };

  try {
    const first = await launch('.bridge-recurrent-');
    hosts.push(first);
    report.hosts.push({ root: first.root, repo: first.repo });
    attachCall(first);

    /* ------------------------------------------------------------ capabilities */
    await check('capabilities describe the REAL recurrent host state and advertise the decision tools', async () => {
      const caps = await call('bridge_capabilities');
      assert.equal(caps.supervisorProjects.enabled, true);
      assert.equal(caps.supervisorProjects.maxRounds, 4);
      assert.equal(caps.supervisorProjects.recurrence.enabled, true);
      assert.equal(caps.supervisorProjects.recurrence.pause, true);
      assert.equal(caps.supervisorProjects.recurrence.modelPolling, false);
      assert.equal(caps.supervisorProjects.firstEdition.singleRound, false);
      assert.equal(caps.supervisorProjects.firstEdition.recurrentReasoning, true);
      assert.ok(caps.supervisorProjects.tools.includes('dsh_supervisor_project_complete'));
      assert.ok(caps.supervisorProjects.tools.includes('dsh_supervisor_project_block'));
      const tools = await rpc(first.endpoint, first.token, 'tools/list', {});
      assert.equal(tools.tools.length, 18);
      assert.ok(tools.tools.some((entry) => entry.name === 'bridge_pause'));
      assert.ok(tools.tools.some((entry) => entry.name === 'bridge_resume'));
      const packet = tools.tools.find((entry) => entry.name === 'bridge_submit').inputSchema.properties.packet;
      assert.equal(packet.properties.project.properties.maxRounds.maximum, 8);
      assert.equal(packet.properties.project.properties.maxRounds.minimum, 1);
      return { tools: tools.tools.length, maxRounds: caps.supervisorProjects.maxRounds };
    });

    /* --------------------------------------------------- two genuine rounds */
    const okSubmitted = await submitProject(projectPacket({ key: 'rec-ok-1', model: 'rec-ok', repo: first.repo, base: first.base, maxRounds: 3 }));
    const okTask = await waitSettled(okSubmitted.id);
    await check('rec-ok: two genuine rounds consume the REAL worker results and only then complete', async () => {
      assert.equal(okTask.status, 'completed');
      assert.equal(okTask.project.status, 'completed');
      assert.equal(okTask.project.roundsUsed, 2, 'exactly two bounded rounds ran');
      assert.equal(okTask.project.rounds.length, 2);
      assert.equal(okTask.project.rounds[0].kind, 'plan');
      assert.equal(okTask.project.rounds[1].kind, 'review');
      assert.equal(okTask.project.decision.kind, 'complete');
      assert.equal(okTask.project.pendingRound, null);
      for (const worker of okTask.project.workers) {
        assert.equal(worker.state, 'succeeded', `worker ${worker.workerKey} must succeed`);
        assert.equal(worker.attempts.length, 1);
      }
      // The SECOND round really read the persisted results through the granted tool.
      const calls = readCalls(first.root);
      const reviewCalls = calls.filter((entry) => entry.role === 'supervisor' && entry.review === true);
      assert.ok(reviewCalls.length >= 1, 'a genuine review round ran');
      const readResults = reviewCalls.flatMap((entry) => entry.results ?? []).filter((result) => result.name === 'dsh_supervisor_worker_result');
      assert.ok(readResults.length >= 2, `the review round must read every worker result (saw ${readResults.length})`);
      assert.ok(readResults.every((result) => result.isError !== true), 'every worker result read must succeed');
      const completeResults = reviewCalls.flatMap((entry) => entry.results ?? []).filter((result) => result.name === 'dsh_supervisor_project_complete');
      assert.ok(completeResults.length >= 1, 'the review round recorded the complete decision');
      // No polling: the supervisor session spends a small, bounded number of turns.
      const supervisorTurns = calls.filter((entry) => entry.role === 'supervisor').length;
      assert.ok(supervisorTurns >= 6 && supervisorTurns <= 12, `supervisor turns must stay bounded, saw ${supervisorTurns}`);
      return { rounds: okTask.project.roundsUsed, supervisorTurns, reads: readResults.length };
    });

    await check('rec-ok: cumulative budgets hold and exactly one callback is emitted per project', async () => {
      const mine = await observeOutboxRecords(okTask.id);
      const records = await listOutbox();
      assert.equal(mine.length, 1, `one project callback expected, got ${mine.length}`);
      assert.equal(mine[0].kind, 'completed');
      assert.equal(mine[0].state, 'pending', 'the host proves enqueue, never delivery');
      for (const workerId of workerTaskIds(okTask)) {
        assert.equal(records.filter((record) => record.taskId === workerId).length, 0, 'a worker completion must never wake the coordinator');
      }
      const supervisorSpend = okTask.project.budgets.supervisorToolSpend ?? 0;
      const workerSpend = okTask.project.budgets.toolSpend ?? 0;
      assert.ok(supervisorSpend + workerSpend <= okTask.project.grant.maxTotalToolCalls, 'the cumulative bound must hold');
      assert.equal(okTask.project.budgets.supervisorReserved, 0, 'every round reservation is released by its verified stop');
      return { supervisorSpend, workerSpend, callbacks: mine.length };
    });

    /* ------------------------------------------------ honest round-cap failure */
    const capSubmitted = await submitProject(projectPacket({ key: 'rec-cap-1', model: 'rec-cap', repo: first.repo, base: first.base, maxRounds: 2 }));
    const capTask = await waitSettled(capSubmitted.id);
    await check('rec-cap: the round cap is honoured with an honest failure, never a fabricated completion', async () => {
      assert.equal(capTask.project.roundsUsed, 2);
      assert.notEqual(capTask.project.status, 'completed');
      assert.equal(capTask.project.status, 'failed');
      assert.equal(capTask.project.seriousIssue.code, 'supervisor-rounds-exhausted');
      const mine = await observeOutboxRecords(capTask.id);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].kind, 'failed');
      return { rounds: capTask.project.roundsUsed, code: capTask.project.seriousIssue.code };
    });

    /* ------------------------------------------------------- pause and resume */
    const pauseSubmitted = await submitProject(projectPacket({ key: 'rec-pause-1', model: 'rec-pause', repo: first.repo, base: first.base, maxRounds: 3 }));
    await waitFor(
      pauseSubmitted.id,
      (task) => task.project?.roundsUsed === 1 && (task.project?.workers ?? []).every((worker) => worker.attempts?.[0]?.taskId) && ['supervising', 'pausing', 'paused'].includes(task.status),
      180000,
      'round 1 with dispatched live workers'
    );
    const pauseRequested = await call('bridge_pause', { taskId: pauseSubmitted.id, requestId: 'pause-smoke-1', reason: 'recurrent smoke pause' });
    await check('bridge_pause holds new admission immediately and only becomes paused after the full stop proof', async () => {
      // The service mutates the durable checkpoint BEFORE it reads the response, so the
      // reported status is the honest post-request state (`pausing`/`paused`), never the
      // stale pre-request `supervising`.
      assert.equal(pauseRequested.pause.accepted, true);
      assert.equal(['pausing', 'paused'].includes(pauseRequested.pause.state), true, `unexpected pause state ${pauseRequested.pause.state}`);
      assert.equal(['pausing', 'paused'].includes(pauseRequested.status), true, `pause must hold admission (status ${pauseRequested.status})`);
      const paused = await waitFor(pauseSubmitted.id, (task) => task.status === 'paused' && task.project?.control?.pause?.state === 'paused', 180000, 'paused with the full proof');
      assert.equal(paused.project.pendingRound, null, 'no round is in flight while paused');
      assert.equal(paused.project.roundsUsed, 1, 'a pause never mints a round');
      const replay = await call('bridge_pause', { taskId: pauseSubmitted.id, requestId: 'pause-smoke-1' });
      assert.equal(replay.pause.replay, true);
      return { state: paused.project.control.pause.state, rounds: paused.project.roundsUsed };
    });

    const beforeResume = await checkTask(pauseSubmitted.id);
    const resumed = await call('bridge_resume', { taskId: pauseSubmitted.id, requestId: 'resume-smoke-1', reason: 'recurrent smoke resume' });
    await check('bridge_resume continues the SAME record with an unchanged anchor and cumulative budget', async () => {
      assert.equal(resumed.resume.accepted, true);
      assert.equal(resumed.resume.resumed, true);
      const settled = await waitSettled(pauseSubmitted.id);
      assert.equal(settled.id, pauseSubmitted.id);
      assert.equal(settled.project.createdAt, beforeResume.project.createdAt, 'the immutable deadline anchor is never rewritten');
      assert.equal(settled.project.grant.timeoutMs, beforeResume.project.grant.timeoutMs, 'remaining time is never extended');
      assert.ok((settled.project.budgets.supervisorToolSpend ?? 0) >= (beforeResume.project.budgets.supervisorToolSpend ?? 0), 'the cumulative budget is preserved, never reset');
      assert.equal(settled.project.roundsUsed, 2, 'the resumed project ran its second bounded round');
      const replay = await call('bridge_resume', { taskId: pauseSubmitted.id, requestId: 'resume-smoke-1' });
      assert.equal(replay.resume.replay, true);
      return { rounds: settled.project.roundsUsed, status: settled.project.status };
    });

    /* --------------------------------------- legacy packet gains none of this */
    const legacySubmitted = await submitProject(projectPacket({ key: 'rec-legacy-1', model: 'rec-ok', repo: first.repo, base: first.base }));
    const legacyTask = await waitSettled(legacySubmitted.id);
    await check('a legacy packet (no project.maxRounds) stays a single-round project and refuses pause', async () => {
      assert.equal(legacyTask.project.grant.maxRounds, 1);
      assert.equal(legacyTask.project.roundsUsed, 1, 'the historical plan-once project runs exactly one round');
      assert.equal(legacyTask.project.status, 'completed');
      let refused = null;
      try {
        await call('bridge_pause', { taskId: legacySubmitted.id, requestId: 'legacy-pause' });
      } catch (error) {
        refused = error.code;
      }
      assert.equal(refused, 'PROJECT_PAUSE_UNSUPPORTED', 'a legacy project must never gain pause/resume');
      return { rounds: legacyTask.project.roundsUsed, refused };
    });

    /* ------------------------------------------------- restart never auto-resumes */
    const restartSubmitted = await submitProject(projectPacket({ key: 'rec-restart-1', model: 'rec-pause', repo: first.repo, base: first.base, maxRounds: 3 }));
    await waitFor(
      restartSubmitted.id,
      (task) => task.project?.roundsUsed === 1 && (task.project?.workers ?? []).every((worker) => worker.attempts?.[0]?.taskId),
      180000,
      'round 1 with dispatched live workers (restart scenario)'
    );
    await call('bridge_pause', { taskId: restartSubmitted.id, requestId: 'pause-restart-1' });
    const checkpoint = await waitFor(restartSubmitted.id, (task) => task.status === 'paused' && task.project?.control?.pause?.state === 'paused', 180000, 'paused checkpoint before restart');

    // The restart must NOT cancel the checkpoint: the host is stopped with the paused
    // project (and its retained reservation) still on disk. Teardown runs afterwards.
    await first.stop();
    const second = await startHost(first);
    hosts.push(second);
    attachCall({ ...first, ...second });

    await check('a controller restart keeps the paused checkpoint and never auto-resumes', async () => {
      const after = await checkTask(restartSubmitted.id);
      assert.equal(after.status, 'paused', 'a restart never auto-resumes a paused project');
      assert.equal(after.project.control.pause.state, 'paused');
      assert.equal(after.project.createdAt, checkpoint.project.createdAt, 'the original anchor survives the restart');
      return { status: after.status, rounds: after.project.roundsUsed };
    });

    await check('the explicit resume after a restart either continues safely or refuses and retains the checkpoint', async () => {
      const response = await call('bridge_resume', { taskId: restartSubmitted.id, requestId: 'resume-restart-1' });
      const resumed = response.resume ?? {};
      // An accepted response is a SCHEDULING INTENT, never proof of a completed resume: the
      // real adapter re-proves ownership later on the nextRound seam and may refuse LOCALLY
      // (restoring `paused` plus a typed control.resume refusal). Waiting only for a terminal
      // project therefore cannot observe the honest refusal and times the run out. Wait
      // boundedly for EITHER a real terminal completion with positive proof OR the retained
      // paused checkpoint with a typed refusal; neither materializing is a real failure.
      const deadline = Date.now() + 90000;
      let terminal = null;
      let refused = null;
      for (;;) {
        const current = await checkTask(restartSubmitted.id);
        const project = current.project ?? {};
        if (TERMINAL.has(current.status) && current.stopConfirmed === true && current.activeJobs === 0 && ['completed', 'failed', 'cancelled'].includes(project.status)) {
          terminal = current;
          break;
        }
        if (current.status === 'paused' && project.control?.pause?.state === 'paused' && project.control?.resume?.outcome === 'refused') {
          refused = current;
          break;
        }
        if (Date.now() > deadline) break;
        await sleep(250);
      }
      if (terminal !== null) {
        assert.equal(terminal.project.createdAt, checkpoint.project.createdAt, 'the immutable deadline anchor is never rewritten');
        assert.equal(terminal.project.grant.timeoutMs, checkpoint.project.grant.timeoutMs, 'remaining time is never extended');
        assert.ok((terminal.project.budgets.supervisorToolSpend ?? 0) >= (checkpoint.project.budgets.supervisorToolSpend ?? 0), 'the cumulative budget is never reset');
        assert.ok(terminal.project.roundsUsed >= checkpoint.project.roundsUsed, 'a successful resume never loses the recorded round');
        return { outcome: 'terminal', accepted: resumed.resumed === true, status: terminal.project.status, rounds: terminal.project.roundsUsed };
      }
      if (refused !== null) {
        // The refusal must be the honest retained-checkpoint outcome: same anchor, no
        // duplicated round, the reservation released and a typed local code recorded.
        assert.equal(refused.project.control.pause.state, 'paused', 'a refused resume retains the checkpoint');
        assert.equal(refused.project.createdAt, checkpoint.project.createdAt, 'a refused resume never rewrites the anchor');
        assert.equal(refused.project.roundsUsed, checkpoint.project.roundsUsed, 'a refusal never duplicates a round');
        assert.equal(refused.project.pendingRound ?? null, null, 'a refused round releases its pending intent');
        assert.equal(refused.project.budgets.supervisorReserved, 0, 'a refused round releases its reservation');
        assert.ok(typeof refused.project.control.resume.code === 'string' && refused.project.control.resume.code.length > 0, 'the refusal is typed');
        return { outcome: 'refused', accepted: resumed.resumed === true, code: refused.project.control.resume.code, status: refused.status };
      }
      const state = await checkTask(restartSubmitted.id);
      throw new Error(
        `resume outcome never materialized (task=${state.status} project=${state.project?.status} rounds=${state.project?.roundsUsed} ` +
          `reserved=${state.project?.budgets?.supervisorReserved} pause=${state.project?.control?.pause?.state} resume=${state.project?.control?.resume?.outcome ?? 'none'})`
      );
    });
  } finally {
    try {
      await stopOwnTasks();
    } catch (error) {
      report.teardown = [...(report.teardown ?? []), { teardown: String(error?.message ?? error) }];
    }
    for (const target of hosts.reverse()) {
      try {
        await target.stop();
      } catch (error) {
        report.teardown = [...(report.teardown ?? []), { stop: String(error?.message ?? error) }];
      }
    }
    report.passed = report.checks.every((entry) => entry.passed === true);
    progress(JSON.stringify({ passed: report.passed, checks: report.checks.length }));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.passed !== true) process.exitCode = 1;
  }
}

await main();