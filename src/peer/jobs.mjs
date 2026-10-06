// src/peer/jobs.mjs
//
// Process management for peer CLI runs (contract agent-peer-v1). One job = one
// headless peer CLI process. Every job has a directory under <stateDir>/jobs/<jobId>/
// holding job.json (state), prompt.txt, stdout.log, stderr.log and result.json, so a
// result outlives the MCP server process that started it.
//
// A job that was running when its server process died is reported as `lost` on the
// next start: its output stream is gone and its outcome is unknown. It is never
// re-run automatically and an unknown pid is never killed (pids are reused).

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PeerPolicyError } from './chain.mjs';
import { parsePeerOutput } from './cli.mjs';

export const JOB_STATES = Object.freeze(['running', 'completed', 'failed', 'cancelled', 'timed_out', 'lost']);
export const TERMINAL_JOB_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'timed_out', 'lost']);
const MAX_PARSE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_TAIL = 4000;
const JOB_ID_RE = /^peer-\d{13}-[0-9a-f]{8}$/;

export function defaultKillTree(pid, { spawnImpl = nodeSpawn } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const killer = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.on?.('error', () => undefined);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
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
  now = () => Date.now(),
  maxConcurrent = 3,
  logger = () => {},
} = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new PeerPolicyError('PEER_CONFIG_INVALID', 'stateDir must be absolute', { field: 'stateDir' });
  const jobsDir = path.join(stateDir, 'jobs');
  const live = new Map(); // jobId -> { record, child, waiters:Set, stdoutChunks, ... }
  let recovered = false;

  const dirOf = (jobId) => path.join(jobsDir, jobId);
  const snapshot = (record) => JSON.parse(JSON.stringify(record));

  function assertJobId(jobId) {
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) throw new PeerPolicyError('PEER_ARGS_INVALID', 'unknown jobId format', { field: 'jobId' });
  }

  async function persist(record) {
    await writeJsonAtomic(path.join(dirOf(record.jobId), 'job.json'), record);
  }

  async function readRecord(jobId) {
    assertJobId(jobId);
    if (live.has(jobId)) return live.get(jobId).record;
    try {
      return JSON.parse(await readFile(path.join(dirOf(jobId), 'job.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new PeerPolicyError('PEER_JOB_UNKNOWN', `no peer job ${jobId}`, { field: 'jobId' });
      throw error;
    }
  }

  /** Mark jobs left `running` by a dead server process as `lost`. Idempotent. */
  async function recover() {
    if (recovered) return { lost: 0 };
    recovered = true;
    await mkdir(jobsDir, { recursive: true });
    let lost = 0;
    for (const entry of await readdir(jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !JOB_ID_RE.test(entry.name) || live.has(entry.name)) continue;
      let record;
      try {
        record = JSON.parse(await readFile(path.join(jobsDir, entry.name, 'job.json'), 'utf8'));
      } catch {
        continue;
      }
      if (record.status !== 'running') continue;
      record.status = 'lost';
      record.endedAt = now();
      record.errors = [...(record.errors ?? []), 'the peer server that owned this job stopped; its outcome is unknown and it was not re-run'];
      await persist(record);
      lost += 1;
    }
    return { lost };
  }

  function runningCount() {
    let count = 0;
    for (const entry of live.values()) if (entry.record.status === 'running') count += 1;
    return count;
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
    if (record.status === 'running') {
      record.status = record.exitCode === 0 && parsed.ok ? 'completed' : 'failed';
    }
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
      await persist(record);
    } catch (error) {
      logger({ phase: 'persist', jobId: record.jobId, code: error?.code ?? 'E_PERSIST' });
    }
    await new Promise((resolve) => (entry.stdoutFile ? entry.stdoutFile.end(resolve) : resolve()));
    await new Promise((resolve) => (entry.stderrFile ? entry.stderrFile.end(resolve) : resolve()));
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
    live.delete(record.jobId);
  }

  /** Reserve a job id and its directory paths before the invocation is built. */
  function allocate() {
    const jobId = `peer-${String(now()).padStart(13, '0')}-${randomBytes(4).toString('hex')}`;
    const dir = dirOf(jobId);
    return { jobId, dir, lastMessageFile: path.join(dir, 'last-message.txt') };
  }

  /**
   * Start one peer process. `invocation` comes from buildInvocation, `plan` from
   * planPeerCall, `env` is the already-shaped child environment.
   */
  async function start({ jobId, invocation, plan, prompt, env, timeoutMs, title = null, cwd, sessionIdRequested = null }) {
    assertJobId(jobId);
    await recover();
    if (runningCount() >= maxConcurrent) {
      throw new PeerPolicyError('PEER_BUSY', `${maxConcurrent} peer job(s) already running; wait for one to finish`, { field: 'maxConcurrentJobs' });
    }
    const dir = dirOf(jobId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'prompt.txt'), prompt, 'utf8');
    const args = invocation.args;
    const startedAt = now();
    const record = {
      jobId,
      target: plan.target,
      mode: plan.mode,
      title,
      chain: plan.chain,
      depth: plan.depth,
      rootTask: plan.rootTask,
      cwd,
      readOnly: invocation.readOnly,
      sessionIdRequested,
      sessionId: sessionIdRequested,
      status: 'running',
      pid: null,
      startedAt,
      deadlineAt: startedAt + timeoutMs,
      endedAt: null,
      exitCode: null,
      signal: null,
      errors: [],
      promptChars: prompt.length,
    };
    const entry = {
      record,
      child: null,
      waiters: new Set(),
      stdoutChunks: [],
      stderrChunks: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutFile: createWriteStream(path.join(dir, 'stdout.log')),
      stderrFile: createWriteStream(path.join(dir, 'stderr.log')),
      settled: false,
      timer: null,
    };
    live.set(jobId, entry);
    let child;
    try {
      child = spawnImpl(invocation.command, args, { cwd: invocation.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (error) {
      record.errors.push(`spawn failed: ${error?.code ?? error?.message ?? 'E_SPAWN'}`);
      await settle(entry, { status: 'failed', exitCode: null });
      return snapshot(record);
    }
    entry.child = child;
    record.pid = child.pid ?? null;
    child.stdout?.on('data', (chunk) => {
      entry.stdoutBytes += chunk.length;
      entry.stdoutFile.write(chunk);
      if (entry.stdoutBytes <= MAX_PARSE_BYTES) entry.stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      entry.stderrBytes += chunk.length;
      entry.stderrFile.write(chunk);
      entry.stderrChunks.push(chunk);
      // Keep only a bounded tail in memory.
      let total = entry.stderrChunks.reduce((sum, item) => sum + item.length, 0);
      while (total > MAX_STDERR_TAIL * 4 && entry.stderrChunks.length > 1) total -= entry.stderrChunks.shift().length;
    });
    child.on('error', (error) => {
      record.errors.push(`process error: ${error?.code ?? error?.message ?? 'E_PROCESS'}`);
      void settle(entry, { status: record.status === 'running' ? 'failed' : record.status });
    });
    child.on('close', (code, signal) => {
      void settle(entry, { exitCode: code, signal: signal ?? null });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt, 'utf8');
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      record.status = 'timed_out';
      record.errors.push(`timed out after ${timeoutMs} ms`);
      killTree(record.pid);
    }, timeoutMs);
    entry.timer.unref?.();
    await persist(record);
    logger({ phase: 'start', jobId, target: plan.target, mode: plan.mode });
    return snapshot(record);
  }

  async function wait(jobId, waitMs = 0) {
    assertJobId(jobId);
    const entry = live.get(jobId);
    if (entry && waitMs > 0) {
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
    const text = stored?.finalMessage ?? '';
    const start = Math.max(0, Math.min(offset, text.length));
    const slice = text.slice(start, start + limit);
    return {
      job: snapshot(record),
      finalMessage: slice,
      offset: start,
      nextOffset: start + slice.length < text.length ? start + slice.length : null,
      totalChars: text.length,
      complete: true,
    };
  }

  async function cancel(jobId) {
    assertJobId(jobId);
    const entry = live.get(jobId);
    if (!entry) return { job: snapshot(await readRecord(jobId)), cancelled: false, reason: 'not running in this server' };
    if (entry.record.status === 'running') {
      entry.record.status = 'cancelled';
      entry.record.errors.push('cancelled by the caller');
      killTree(entry.record.pid);
    }
    return { job: snapshot(entry.record), cancelled: true };
  }

  async function list({ limit = 20 } = {}) {
    await recover();
    let names = [];
    try {
      names = (await readdir(jobsDir)).filter((name) => JOB_ID_RE.test(name));
    } catch {
      names = [];
    }
    names.sort().reverse();
    const jobs = [];
    for (const name of names.slice(0, Math.max(1, Math.min(limit, 200)))) {
      try {
        const record = await readRecord(name);
        jobs.push({ jobId: record.jobId, target: record.target, mode: record.mode, status: record.status, title: record.title, startedAt: record.startedAt, endedAt: record.endedAt, sessionId: record.sessionId, chain: record.chain });
      } catch {
        // skip unreadable job directories
      }
    }
    return jobs;
  }

  async function close() {
    for (const entry of live.values()) {
      if (entry.record.status === 'running') {
        entry.record.status = 'cancelled';
        entry.record.errors.push('the peer server shut down');
        killTree(entry.record.pid);
      }
    }
  }

  return Object.freeze({ allocate, start, wait, result, cancel, list, recover, close, runningCount, jobsDir });
}
