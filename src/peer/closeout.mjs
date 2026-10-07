// src/peer/closeout.mjs
//
// Close out ONE root task: the root controller (or an appointed sub-controller) has
// finished a chain of work — peer CLI jobs plus, possibly, DSH bridge tasks — and the
// raw harness sessions behind that work are about to be swept. Before they are, one
// durable Markdown record is generated from the STORED data (never summarised by a
// model) and one JSON Lines index event is appended.
//
// The order is deliberate and load-bearing:
//   1. validate + collect everything (a job or task that is not ready refuses here);
//   2. compute the deterministic recordId; if the index already knows it, return the
//      stored record unchanged (a repeated closeout is a no-op);
//   3. locate the project root and make git exclude the record directory;
//   4. WRITE THE RECORD FILE;
//   5. append the index event.
// Because 4 precedes 5, a session can never become eligible for cleanup without its
// record already existing on disk.
//
// This module owns no policy of its own beyond that: it reuses src/peer/records.mjs for
// project-root discovery, git exclusion, naming, retention maths, rendering, atomic
// writing and the index.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PeerPolicyError } from './chain.mjs';
import { TERMINAL_JOB_STATES } from './jobs.mjs';
import {
  DEFAULT_DISPUTED_RETAIN_DAYS,
  DEFAULT_RECORD_DIR,
  DEFAULT_RETAIN_DAYS,
  appendIndexEvent,
  computeEligibleAt,
  ensureGitExclude,
  findProjectRoot,
  readIndex,
  recordFileName,
  renderRecord,
  writeRecord,
} from './records.mjs';

/** Outcomes a closeout record may declare. */
export const CLOSEOUT_OUTCOMES = Object.freeze(['accepted', 'failed', 'disputed', 'unresolved']);
/** Verdicts a cross-verification finding may declare. */
export const FINDING_VERDICTS = Object.freeze(['confirmed', 'refuted', 'unresolved']);
/** Bridge task states that may be closed out. */
export const CLOSEOUT_TASK_STATES = Object.freeze(['completed', 'failed', 'cancelled']);
export const MAX_TITLE_CHARS = 200;
export const MAX_CONCLUSION_CHARS = 20_000;
export const MAX_FINDINGS = 200;
/** How many recent peer jobs are scanned when peerJobIds is omitted. */
export const MAX_JOB_LIST = 200;
/** How much of one peer job's final message the record embeds. */
export const MAX_JOB_RESULT_CHARS = 2_000_000;

export const DEFAULT_RECORDS_CONFIG = Object.freeze({
  dirName: DEFAULT_RECORD_DIR,
  retainDays: DEFAULT_RETAIN_DAYS,
  disputedRetainDays: DEFAULT_DISPUTED_RETAIN_DAYS,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNotFound(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function invalid(message, field) {
  return new PeerPolicyError('PEER_ARGS_INVALID', message, { field });
}

function notReady(message, field) {
  return new PeerPolicyError('PEER_CLOSEOUT_NOT_READY', message, { field });
}

function requireNonBlankString(value, field, maxChars) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} must be a nonblank string`, field);
  if (maxChars !== undefined && value.length > maxChars) throw invalid(`${field} must be at most ${maxChars} characters`, field);
  return value;
}

/** An optional list of nonblank string ids; absent/blank/null means "not given". */
function optionalIdList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${field} must be an array of task or job ids`, field);
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') throw invalid(`${field} entries must be nonblank strings`, field);
  }
  return [...value];
}

function validateFindings(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid('findings must be an array', 'findings');
  if (value.length > MAX_FINDINGS) throw invalid(`findings must hold at most ${MAX_FINDINGS} items`, 'findings');
  for (const finding of value) {
    if (!isObject(finding)) throw invalid('each finding must be an object', 'findings');
    if (typeof finding.id !== 'string' || finding.id.trim() === '') throw invalid('each finding needs a nonblank id', 'findings');
    if (!Array.isArray(finding.raisedBy) || !finding.raisedBy.every((entry) => typeof entry === 'string')) {
      throw invalid('each finding needs raisedBy as an array of strings', 'findings');
    }
    if (!FINDING_VERDICTS.includes(finding.verdict)) {
      throw invalid(`each finding verdict must be one of ${FINDING_VERDICTS.join(', ')}`, 'findings');
    }
    for (const key of ['summary', 'evidence']) {
      const entry = finding[key];
      if (entry !== undefined && entry !== null && typeof entry !== 'string') throw invalid(`each finding ${key} must be a string`, 'findings');
    }
  }
  return value;
}

/** Validate and normalize the closeout input. Every refusal names its field. */
function validateInput(input) {
  if (!isObject(input)) throw invalid('input must be an object', 'input');
  const title = requireNonBlankString(input.title, 'title', MAX_TITLE_CHARS);
  if (!CLOSEOUT_OUTCOMES.includes(input.outcome)) {
    throw invalid(`outcome must be one of ${CLOSEOUT_OUTCOMES.join(', ')}`, 'outcome');
  }
  const conclusion = requireNonBlankString(input.conclusion, 'conclusion', MAX_CONCLUSION_CHARS);
  const findings = validateFindings(input.findings);
  const bridgeTaskIds = optionalIdList(input.bridgeTaskIds, 'bridgeTaskIds');
  const peerJobIds = optionalIdList(input.peerJobIds, 'peerJobIds');
  let projectRoot = null;
  if (input.projectRoot !== undefined && input.projectRoot !== null) {
    if (typeof input.projectRoot !== 'string' || input.projectRoot === '' || !path.isAbsolute(input.projectRoot)) {
      throw invalid('projectRoot must be an absolute path', 'projectRoot');
    }
    projectRoot = input.projectRoot;
  }
  if (input.keep !== undefined && input.keep !== null && typeof input.keep !== 'boolean') {
    throw invalid('keep must be a boolean', 'keep');
  }
  return {
    title,
    outcome: input.outcome,
    conclusion,
    findings,
    bridgeTaskIds,
    peerJobIds,
    peerJobIdsGiven: input.peerJobIds !== undefined && input.peerJobIds !== null,
    projectRoot,
    keep: input.keep === true,
  };
}

function firstNonBlankString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * Close out one root task and return its durable record identity.
 *
 * @param {object} spec
 * @param {object} spec.input validated closeout input (title, outcome, conclusion,
 *   findings, bridgeTaskIds, peerJobIds, projectRoot, keep).
 * @param {string} spec.rootTask effective root task label, already resolved by the caller.
 * @param {{self: string, chain: string[], root: string}} spec.context chain context.
 * @param {object} spec.jobs peer job manager (list/wait/result).
 * @param {object} spec.bridge bridge client (dossier/resultText).
 * @param {string} spec.stateDir absolute state directory holding jobs/ and the index.
 * @param {object} [spec.recordsConfig] record directory and retention windows.
 * @param {Function} [spec.now] clock seam (epoch milliseconds).
 * @param {Function} [spec.readFileImpl] seam for reading prompt.txt.
 * @returns {Promise<{recordId: string, path: string, sha256: string, eligibleAt: number|null, sessions: object[], reused: boolean}>}
 */
export async function closeoutRootTask({
  input,
  rootTask,
  context,
  jobs,
  bridge,
  stateDir,
  recordsConfig = { dirName: '.agent-bridge/records', retainDays: 3, disputedRetainDays: 30 },
  now = Date.now,
  readFileImpl = readFile,
} = {}) {
  const parsed = validateInput(input);
  const task = requireNonBlankString(rootTask, 'rootTask');
  if (typeof stateDir !== 'string' || stateDir === '' || !path.isAbsolute(stateDir)) {
    throw invalid('stateDir must be an absolute path', 'stateDir');
  }
  if (!isObject(jobs) || typeof jobs.list !== 'function' || typeof jobs.wait !== 'function' || typeof jobs.result !== 'function') {
    throw new PeerPolicyError('PEER_CONFIG_INVALID', 'a peer jobs manager with list/wait/result is required', { field: 'jobs' });
  }
  if (!isObject(bridge) || typeof bridge.dossier !== 'function' || typeof bridge.resultText !== 'function') {
    throw new PeerPolicyError('PEER_CONFIG_INVALID', 'a bridge client with dossier/resultText is required', { field: 'bridge' });
  }
  if (typeof now !== 'function') throw invalid('now must be a function', 'now');
  const readText = typeof readFileImpl === 'function' ? readFileImpl : readFile;
  const config = { ...DEFAULT_RECORDS_CONFIG, ...(isObject(recordsConfig) ? recordsConfig : {}) };

  // --- 1. which peer jobs belong to this root task -------------------------------
  // The full record of a job read through list() is only a summary; the selection rule
  // requires rootTask, so every candidate is read through wait(jobId, 0).
  const selectedJobIds = [];
  const jobRecords = new Map();
  if (parsed.peerJobIdsGiven) {
    selectedJobIds.push(...parsed.peerJobIds);
  } else {
    const listed = await jobs.list({ limit: MAX_JOB_LIST });
    for (const entry of Array.isArray(listed) ? listed : []) {
      const jobId = typeof entry === 'string' ? entry : isObject(entry) && typeof entry.jobId === 'string' ? entry.jobId : null;
      if (jobId === null) continue;
      const record = await jobs.wait(jobId, 0);
      jobRecords.set(jobId, record);
      if (isObject(record) && record.rootTask === task) selectedJobIds.push(jobId);
    }
  }
  if (selectedJobIds.length === 0 && parsed.bridgeTaskIds.length === 0) {
    throw invalid('a closeout needs at least one peer job or bridge task', 'input');
  }

  // Every selected job must have stopped: a running job has no final answer to store.
  for (const jobId of selectedJobIds) {
    const record = jobRecords.get(jobId) ?? await jobs.wait(jobId, 0);
    jobRecords.set(jobId, record);
    if (!isObject(record)) throw notReady(`peer job ${jobId} could not be read`, 'peerJobIds');
    if (!TERMINAL_JOB_STATES.includes(record.status)) {
      throw notReady(`peer job ${jobId} is ${record.status ?? 'unknown'}; it must finish before the closeout`, 'peerJobIds');
    }
  }

  // Read each job's stored answer and prompt. An unrecorded outcome (a lost job) has no
  // answer: the record states that honestly instead of inventing text.
  const peerEntries = [];
  for (const jobId of selectedJobIds) {
    const job = jobRecords.get(jobId);
    let finalMessage = null;
    const outcome = await jobs.result(jobId, { offset: 0, limit: MAX_JOB_RESULT_CHARS });
    if (!(isObject(outcome) && outcome.outcomeUnknown === true)) {
      finalMessage = isObject(outcome) && typeof outcome.finalMessage === 'string' ? outcome.finalMessage : null;
    }
    let promptText = null;
    try {
      promptText = String(await readText(path.join(stateDir, 'jobs', jobId, 'prompt.txt'), 'utf8'));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      promptText = null;
    }
    peerEntries.push({ jobId, job, promptText, finalMessage });
  }

  // --- 2. bridge tasks: each must be settled AND reviewed/acknowledged ------------
  const bridgeEntries = [];
  for (const taskId of parsed.bridgeTaskIds) {
    const dossier = await bridge.dossier(taskId);
    const acknowledgement = isObject(dossier?.acknowledgement) ? dossier.acknowledgement : {};
    if (!isObject(dossier) || !CLOSEOUT_TASK_STATES.includes(dossier.status) || acknowledgement.resultCollected !== true) {
      throw notReady(
        `bridge task ${taskId} is ${dossier?.status ?? 'unknown'} and its result has not been collected and acknowledged; close it out after review`,
        'bridgeTaskIds',
      );
    }
    const resultText = await bridge.resultText(taskId);
    bridgeEntries.push({ taskId, dossier, resultText: typeof resultText === 'string' ? resultText : null });
  }

  // --- 3. deterministic identity + idempotent replay ------------------------------
  const recordId = createHash('sha256')
    .update(`${task}\n${[...parsed.bridgeTaskIds].sort().join(',')}\n${[...selectedJobIds].sort().join(',')}`, 'utf8')
    .digest('hex')
    .slice(0, 16);

  const index = await readIndex(stateDir);
  const known = index.get(recordId);
  if (known) {
    return {
      recordId,
      path: known.path,
      sha256: known.sha256,
      eligibleAt: known.eligibleAt ?? null,
      sessions: closeoutSessions(bridgeEntries, peerEntries),
      reused: true,
    };
  }

  // --- 4. project root + git exclusion -------------------------------------------
  let projectRoot = parsed.projectRoot;
  if (projectRoot === null) {
    const firstDossier = bridgeEntries.length > 0 ? bridgeEntries[0].dossier : null;
    const candidate = firstNonBlankString([
      firstDossier?.workspace?.repository,
      firstDossier?.request?.cwd,
      peerEntries[0]?.job?.cwd,
    ]);
    if (candidate === null) {
      throw invalid('projectRoot is required when no dossier or job carries a working directory', 'projectRoot');
    }
    projectRoot = await findProjectRoot(candidate);
  }
  await ensureGitExclude(projectRoot);

  // --- 5. retention window, then the record, then its index event ----------------
  const closedAt = now();
  const eligibleAt = computeEligibleAt({
    closedAt,
    outcome: parsed.outcome,
    keep: parsed.keep,
    retainDays: config.retainDays,
    disputedRetainDays: config.disputedRetainDays,
  });
  const sessions = closeoutSessions(bridgeEntries, peerEntries);
  const chain = Array.isArray(context?.chain)
    ? context.chain.join('>')
    : (typeof context?.chain === 'string' ? context.chain : '');

  const content = renderRecord({
    recordId,
    rootTask: task,
    title: parsed.title,
    projectRoot,
    controller: typeof context?.self === 'string' ? context.self : null,
    chain,
    closedAt,
    outcome: parsed.outcome,
    conclusion: parsed.conclusion,
    keep: parsed.keep,
    eligibleAt,
    findings: parsed.findings,
    bridgeTasks: bridgeEntries.map(({ dossier, resultText }) => ({ dossier, resultText })),
    peerJobs: peerEntries.map(({ job, promptText, finalMessage }) => ({ job, promptText, finalMessage })),
  });
  const fileName = recordFileName({ createdAt: closedAt, title: parsed.title, rootTask: task });
  const written = await writeRecord({ projectRoot, dirName: config.dirName, fileName, content });

  await appendIndexEvent(stateDir, {
    kind: 'record',
    recordId,
    rootTask: task,
    title: parsed.title,
    projectRoot,
    path: written.path,
    sha256: written.sha256,
    outcome: parsed.outcome,
    keep: parsed.keep,
    closedAt,
    eligibleAt,
    sessions,
  });

  return { recordId, path: written.path, sha256: written.sha256, eligibleAt, sessions, reused: false };
}

/** The sessions a closeout covers: DSH bridge sessions first, then peer job sessions. */
function closeoutSessions(bridgeEntries, peerEntries) {
  const sessions = [];
  for (const { taskId, dossier } of bridgeEntries) {
    if (typeof dossier.sessionId === 'string' && dossier.sessionId !== '') {
      sessions.push({
        harness: 'dsh',
        id: dossier.sessionId,
        source: typeof dossier.taskId === 'string' && dossier.taskId !== '' ? dossier.taskId : taskId,
        revision: dossier.revision ?? null,
      });
    }
  }
  for (const { job } of peerEntries) {
    if (typeof job.sessionId === 'string' && job.sessionId !== '') {
      sessions.push({ harness: job.target ?? null, id: job.sessionId, source: job.jobId ?? null });
    }
  }
  return sessions;
}
