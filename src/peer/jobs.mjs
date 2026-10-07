// src/peer/jobs.mjs
//
// Process management for peer CLI runs (contract agent-peer-v1). One job = one
// headless peer CLI process. Every job has a directory under <stateDir>/jobs/<jobId>/
// holding job.json (state), prompt.txt, stdout.log, stderr.log and result.json, so a
// result outlives the MCP server process that started it.
//
// States: running -> completed | failed, or running -> cancelling -> cancelled, or
// running -> timing_out -> timed_out. A stop request is NOT a stop: `cancelled` and
// `timed_out` are only recorded once the process has actually exited. A job whose
// owning server died while it was active is `lost` (outcome unknown, never re-run);
// a job owned by another LIVE server sharing the state directory is left alone. An
// unknown pid is never killed (pids are reused).
//
// Each started child is also recorded in the lineage ledger (src/peer/lineage.mjs) so
// an agent-peer server inside it can prove its delegation chain.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PeerPolicyError } from './chain.mjs';
import { parsePeerOutput } from './cli.mjs';
import { clearActive, recordActive } from './lineage.mjs';

export const ACTIVE_JOB_STATES = Object.freeze(['running', 'cancelling', 'timing_out']);
export const TERMINAL_JOB_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'timed_out', 'lost']);
export const JOB_STATES = Object.freeze([...ACTIVE_JOB_STATES, ...TERMINAL_JOB_STATES]);
const MAX_PARSE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_TAIL = 4000;
const MAX_TIMER_MS = 2_147_483_647;
const JOB_ID_RE = /^peer-\d{13}-[0-9a-f]{8}$/;

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Kill a process tree and report whether that is known to have worked.
 * Windows: taskkill /T /F (exit 128 = no such process, i.e. already gone).
 * POSIX: the child was started detached as its own process group; signal the group.
 */
export function defaultKillTree(pid, { spawnImpl = nodeSpawn, platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, code: 'NO_PID' });
  if (platform === 'win32') {
    return new Promise((resolve) => {
      let killer;
      try {
        killer = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      } catch (error) {
        resolve({ ok: false, code: error?.code ?? 'E_SPAWN' });
        return;
      }
      killer.on('error', (error) => resolve({ ok: false, code: error?.code ?? 'E_SPAWN' }));
      killer.on('close', (code) => resolve(code === 0 || code === 128 ? { ok: true, code } : { ok: false, code }));
    });
  }
  return new Promise((resolve) => {
    const signal = (sig) => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        try {
          process.kill(pid, sig);
          return true;
        } catch {
          return false;
        }
      }
    };
    signal('SIGTERM');
    setTimeout(() => {
      if (isProcessAlive(pid)) signal('SIGKILL');
      resolve({ ok: true, code: 'SIGNALLED' });
    }, 3000).unref?.();
  });
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
  await rename(tmp, file);
}

export function createPeerJobs({
  stateDir,
  spawnImpl = nodeSpawn,
  killTree = (pid) => defaultKillTree(pid),
  isAlive = isProcessAlive,
  now = () => Date.now(),
  maxConcurrent = 3,
  ownerPid = process.pid,
  shutdownGraceMs = 10_000,
  lineage = true,
  logger = () => {},
} = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'stateDir must be absolute', { field: 'stateDir' });
  const jobsDir = path.join(stateDir, 'jobs');
  const live = new Map(); // jobId -> entry
  let pendingStarts = 0;
  let recovered = null;

  const dirOf = (jobId) => path.join(jobsDir, jobId);
  const snapshot = (record) => JSON.parse(JSON.stringify(record));

  function assertJobId(jobId) {
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) throw new PeerPolicyError('PEER_ARGS_INVALID', 'unknown jobId format', { field: 'jobId' });
  }

  /** Serialized per live job: a later state can never be overwritten by an earlier write. */
  function persist(entry) {
    const record = snapshot(entry.record);
    entry.persistChain = entry.persistChain
      .then(() => writeJsonAtomic(path.join(dirOf(record.jobId), 'job.json'), record))
      .catch((error) => logger({ phase: 'persist', jobId: record.jobId, code: error?.code ?? 'E_PERSIST' }));
    return entry.persistChain;
  }

  async function readDisk(jobId) {
    try {
      return JSON.parse(await readFile(path.join(dirOf(jobId), 'job.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new PeerPolicyError('PEER_JOB_UNKNOWN', `no peer job ${jobId}`, { field: 'jobId' });
      throw error;
    }
  }

  /**
   * An active record that this server does not own is `lost` only when its owner is
   * provably gone; a job of another live server sharing the state dir is left alone.
   */
  async function reconcile(record) {
    if (!ACTIVE_JOB_STATES.includes(record.status) || live.has(record.jobId)) return record;
    const ownedHere = record.ownerPid === ownerPid;
    if (!ownedHere && isAlive(record.ownerPid)) return record;
    record.status = 'lost';
    record.endedAt = now();
    record.errors = [...(record.errors ?? []), 'the peer server that owned this job stopped before its outcome was recorded; the outcome is unknown and it was not re-run'];
    await writeJsonAtomic(path.join(dirOf(record.jobId), 'job.json'), record);
    return record;
  }

  async function readRecord(jobId) {
    assertJobId(jobId);
    if (live.has(jobId)) return live.get(jobId).record;
    return reconcile(await readDisk(jobId));
  }

  async function listIds() {
    try {
      return (await readdir(jobsDir)).filter((name) => JOB_ID_RE.test(name)).sort().reverse();
    } catch {
      return [];
    }
  }

  /** Reconcile every stale active record once per process. */
  function recover() {
    if (!recovered) {
      recovered = (async () => {
        await mkdir(jobsDir, { recursive: true });
        let lost = 0;
        for (const jobId of await listIds()) {
          try {
            const before = await readDisk(jobId);
            const after = await reconcile(before);
            if (after.status === 'lost' && ACTIVE_JOB_STATES.includes(before.status)) lost += 1;
          } catch {
            // unreadable job directories are skipped
          }
        }
        return { lost };
      })();
    }
    return recovered;
  }

  function activeCount() {
    let count = 0;
    for (const entry of live.values()) if (ACTIVE_JOB_STATES.includes(entry.record.status)) count += 1;
    return count;
  }

  async function requestKill(entry, reason) {
    const outcome = await killTree(entry.record.pid);
    if (!outcome?.ok) {
      entry.record.errors.push(`${reason}: process tree kill was not confirmed (${outcome?.code ?? 'unknown'})`);
      await persist(entry);
    }
    return outcome;
  }

  async function settle(entry, patch) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    const record = entry.record;
    const stdoutText = Buffer.concat(entry.stdoutChunks).toString('utf8');
    let lastMessage = null;
    if (record.target === 'codex') {
      try {
        lastMessage = await readFile(path.join(dirOf(record.jobId), 'last-message.txt'), 'utf8');
      } catch {
        lastMessage = null;
      }
    }
    const parsed = parsePeerOutput(record.target, stdoutText, lastMessage);
    const stderrText = Buffer.concat(entry.stderrChunks).toString('utf8');
    Object.assign(record, {
      endedAt: now(),
      sessionId: parsed.sessionId ?? record.sessionId,
      usage: parsed.usage ?? null,
      costUsd: parsed.costUsd ?? null,
      errors: [...record.errors, ...parsed.errors],
      finalMessageChars: parsed.finalMessage?.length ?? 0,
      stdoutBytes: entry.stdoutBytes,
      stderrBytes: entry.stderrBytes,
      stderrTail: stderrText.slice(-MAX_STDERR_TAIL),
      ...patch,
    });
    if (record.status === 'cancelling') record.status = 'cancelled';
    else if (record.status === 'timing_out') record.status = 'timed_out';
    else if (record.status === 'running') record.status = record.exitCode === 0 && parsed.ok ? 'completed' : 'failed';
    try {
      await writeJsonAtomic(path.join(dirOf(record.jobId), 'result.json'), {
        jobId: record.jobId,
        sessionId: record.sessionId,
        finalMessage: parsed.finalMessage,
        errors: record.errors,
        usage: record.usage,
        costUsd: record.costUsd,
        eventCounts: parsed.eventCounts ?? null,
      });
    } catch (error) {
      logger({ phase: 'result', jobId: record.jobId, code: error?.code ?? 'E_PERSIST' });
    }
    await persist(entry);
    if (lineage) await clearActive(stateDir, record.pid).catch(() => undefined);
    await Promise.all([entry.stdoutFile, entry.stderrFile].map((stream) => new Promise((resolve) => {
      if (!stream || stream.destroyed || stream.writableFinished) resolve();
      else stream.end(resolve);
    })));
    live.delete(record.jobId);
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
    entry.resolveSettled();
  }

  /** Reserve a job id and its directory paths before the invocation is built. */
  function allocate() {
    const jobId = `peer-${String(now()).padStart(13, '0')}-${randomBytes(4).toString('hex')}`;
    const dir = dirOf(jobId);
    return { jobId, dir, lastMessageFile: path.join(dir, 'last-message.txt') };
  }

  function logStream(file, entry, label) {
    const stream = createWriteStream(file);
    stream.on('error', (error) => {
      entry.record.errors.push(`${label} log unavailable (${error?.code ?? 'E_IO'}); output is still parsed in memory`);
    });
    return stream;
  }

  /**
   * Start one peer process. `invocation` comes from buildInvocation, `plan` from
   * planPeerCall, `env` is the already-shaped child environment.
   */
  async function start({ jobId, invocation, plan, prompt, env, timeoutMs, title = null, cwd, sessionIdRequested = null }) {
    assertJobId(jobId);
    // Reserve synchronously: no await may run between the capacity check and the reservation.
    if (activeCount() + pendingStarts >= maxConcurrent) {
      throw new PeerPolicyError('PEER_BUSY', `${maxConcurrent} peer job(s) already active; wait for one to finish`, { field: 'maxConcurrentJobs' });
    }
    pendingStarts += 1;
    let entry;
    try {
      await recover();
      const dir = dirOf(jobId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'prompt.txt'), prompt, 'utf8');
      const startedAt = now();
      const record = {
        jobId,
        target: plan.target,
        mode: plan.mode,
        title,
        chain: plan.chain,
        root: plan.root,
        depth: plan.depth,
        rootTask: plan.rootTask,
        cwd,
        readOnly: invocation.readOnly,
        sessionIdRequested,
        sessionId: sessionIdRequested,
        status: 'running',
        ownerPid,
        pid: null,
        startedAt,
        deadlineAt: startedAt + timeoutMs,
        endedAt: null,
        exitCode: null,
        signal: null,
        errors: [],
        promptChars: prompt.length,
      };
      let resolveSettled;
      const settledPromise = new Promise((resolve) => { resolveSettled = resolve; });
      entry = {
        record,
        child: null,
        waiters: new Set(),
        stdoutChunks: [],
        stderrChunks: [],
        stdoutBytes: 0,
        stderrBytes: 0,
        settled: false,
        timer: null,
        persistChain: Promise.resolve(),
        settledPromise,
        resolveSettled,
      };
      entry.stdoutFile = logStream(path.join(dir, 'stdout.log'), entry, 'stdout');
      entry.stderrFile = logStream(path.join(dir, 'stderr.log'), entry, 'stderr');
      live.set(jobId, entry);
    } finally {
      pendingStarts -= 1;
    }

    const record = entry.record;
    let child;
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      record.errors.push(`spawn failed: ${error?.code ?? error?.message ?? 'E_SPAWN'}`);
      await settle(entry, { status: 'failed', exitCode: null });
      return snapshot(record);
    }
    entry.child = child;
    record.pid = child.pid ?? null;
    if (lineage && record.pid) {
      await recordActive(stateDir, { pid: record.pid, jobId, chain: plan.chain, target: plan.target, startedAt: record.startedAt })
        .catch((error) => record.errors.push(`lineage ledger write failed (${error?.code ?? 'E_IO'})`));
    }
    child.stdout?.on('data', (chunk) => {
      entry.stdoutBytes += chunk.length;
      if (!entry.stdoutFile.destroyed) entry.stdoutFile.write(chunk);
      if (entry.stdoutBytes <= MAX_PARSE_BYTES) entry.stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      entry.stderrBytes += chunk.length;
      if (!entry.stderrFile.destroyed) entry.stderrFile.write(chunk);
      entry.stderrChunks.push(chunk);
      let total = entry.stderrChunks.reduce((sum, item) => sum + item.length, 0);
      while (total > MAX_STDERR_TAIL * 4 && entry.stderrChunks.length > 1) total -= entry.stderrChunks.shift().length;
    });
    child.on('error', (error) => {
      record.errors.push(`process error: ${error?.code ?? error?.message ?? 'E_PROCESS'}`);
      if (record.status === 'running') record.status = 'failed';
      void settle(entry, {});
    });
    child.on('close', (code, signal) => {
      void settle(entry, { exitCode: code, signal: signal ?? null });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt, 'utf8');
    entry.timer = setTimeout(() => {
      if (entry.settled || record.status !== 'running') return;
      record.status = 'timing_out';
      record.errors.push(`timed out after ${timeoutMs} ms`);
      void persist(entry);
      void requestKill(entry, 'timeout');
    }, Math.min(timeoutMs, MAX_TIMER_MS));
    entry.timer.unref?.();
    await persist(entry);
    logger({ phase: 'start', jobId, target: plan.target, mode: plan.mode });
    return snapshot(record);
  }

  async function wait(jobId, waitMs = 0) {
    assertJobId(jobId);
    const entry = live.get(jobId);
    if (entry && waitMs > 0 && !entry.settled) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, waitMs);
        function done() {
          clearTimeout(timer);
          entry.waiters.delete(done);
          resolve();
        }
        entry.waiters.add(done);
      });
    }
    return snapshot(await readRecord(jobId));
  }

  async function result(jobId, { offset = 0, limit = 20_000 } = {}) {
    const record = await readRecord(jobId);
    if (!TERMINAL_JOB_STATES.includes(record.status)) return { job: snapshot(record), finalMessage: null, complete: false };
    let stored = null;
    try {
      stored = JSON.parse(await readFile(path.join(dirOf(jobId), 'result.json'), 'utf8'));
    } catch {
      stored = null;
    }
    if (record.status === 'lost' || stored === null) {
      return { job: snapshot(record), finalMessage: null, complete: true, outcomeUnknown: true, totalChars: 0, offset: 0, nextOffset: null };
    }
    const text = typeof stored.finalMessage === 'string' ? stored.finalMessage : '';
    const start = Math.max(0, Math.min(offset, text.length));
    const slice = text.slice(start, start + limit);
    return {
      job: snapshot(record),
      finalMessage: slice,
      offset: start,
      nextOffset: start + slice.length < text.length ? start + slice.length : null,
      totalChars: text.length,
      complete: true,
      outcomeUnknown: false,
    };
  }

  async function cancel(jobId) {
    assertJobId(jobId);
    const entry = live.get(jobId);
    if (!entry) {
      const record = await readRecord(jobId);
      const reason = ACTIVE_JOB_STATES.includes(record.status) ? 'owned by another live peer server' : `already ${record.status}`;
      return { job: snapshot(record), cancelRequested: false, reason };
    }
    if (entry.record.status !== 'running') {
      return { job: snapshot(entry.record), cancelRequested: false, reason: `already ${entry.record.status}` };
    }
    entry.record.status = 'cancelling';
    entry.record.errors.push('cancelled by the caller');
    await persist(entry);
    const kill = await requestKill(entry, 'cancel');
    // `cancelled` is recorded only when the process actually exits (see settle).
    return { job: snapshot(entry.record), cancelRequested: true, killConfirmed: kill?.ok === true, stopped: entry.settled };
  }

  /** The newest job that produced `sessionId` for `target`, or null. */
  async function findSession(target, sessionId) {
    for (const entry of live.values()) {
      if (entry.record.target === target && entry.record.sessionId === sessionId) return snapshot(entry.record);
    }
    for (const jobId of await listIds()) {
      try {
        const record = await readDisk(jobId);
        if (record.target === target && record.sessionId === sessionId) return record;
      } catch {
        // skip unreadable
      }
    }
    return null;
  }

  async function list({ limit = 20 } = {}) {
    await recover();
    const jobs = [];
    for (const jobId of (await listIds()).slice(0, Math.max(1, Math.min(limit, 200)))) {
      try {
        const record = await readRecord(jobId);
        jobs.push({ jobId: record.jobId, target: record.target, mode: record.mode, status: record.status, title: record.title, startedAt: record.startedAt, endedAt: record.endedAt, sessionId: record.sessionId, chain: record.chain });
      } catch {
        // skip unreadable job directories
      }
    }
    return jobs;
  }

  /** Stop every active job of this server and wait (bounded) for the processes to exit. */
  async function close() {
    const entries = [...live.values()];
    for (const entry of entries) {
      if (entry.record.status === 'running') {
        entry.record.status = 'cancelling';
        entry.record.errors.push('the peer server shut down');
      }
      void persist(entry);
      void requestKill(entry, 'shutdown');
    }
    let timer;
    await Promise.race([
      Promise.all(entries.map((entry) => entry.settledPromise)),
      new Promise((resolve) => { timer = setTimeout(resolve, shutdownGraceMs); }),
    ]);
    clearTimeout(timer);
    for (const entry of entries) {
      if (!entry.settled) {
        entry.record.errors.push('the peer server exited before the stop was confirmed');
        await persist(entry);
      }
    }
  }

  return Object.freeze({ allocate, start, wait, result, cancel, list, recover, findSession, close, activeCount, jobsDir });
}
