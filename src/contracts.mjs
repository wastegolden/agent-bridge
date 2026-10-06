import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const clone = value => JSON.parse(JSON.stringify(value));
export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function realPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_PATH', 'Expected absolute path');
  return fs.realpathSync.native(value);
}
export function resolvedPath(value) {
  let cursor = path.resolve(value); const rest = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('INVALID_PATH', 'Path has no existing ancestor');
    rest.unshift(path.basename(cursor)); cursor = parent;
  }
  return path.join(fs.realpathSync.native(cursor), ...rest);
}
export function validatePacket(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_PACKET', 'Task packet is required');
  let p;try{p=clone(input);}catch{fail('INVALID_PACKET','Task packet must be JSON serializable');}
  for (const key of ['idempotencyKey','projectId','title','objective','contractVersion']) {
    if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > (key === 'objective' ? 100000 : 2000)) fail('INVALID_PACKET', `Invalid ${key}`);
  }
  if (p.idempotencyKey.length > 200) fail('INVALID_PACKET', 'idempotencyKey must be a nonblank string of at most 200 characters', { field: 'idempotencyKey', expected: 'nonblank string of at most 200 characters' });
  if (p.schemaVersion !== 1) fail('INVALID_PACKET', 'schemaVersion must be the integer 1, not the string "1.0" or any other value', { field: 'schemaVersion', expected: 'integer 1' });
  if (!Number.isSafeInteger(p.revision) || p.revision < 1) fail('INVALID_PACKET', 'revision must be a positive safe integer', { field: 'revision', expected: 'positive safe integer' });
  if (!['investigate','implement','review','integrate'].includes(p.role)) fail('INVALID_PACKET', 'Unknown role');
  if (!Array.isArray(p.acceptance) || !p.acceptance.length || p.acceptance.some(x => typeof x !== 'string' || !x.trim())) fail('INVALID_PACKET', 'Nonempty acceptance criteria required');
  const requestedCwd = p.cwd;
  try { p.cwd = realPath(p.cwd); } catch { fail('INVALID_PATH', 'cwd must be an existing absolute directory'); }
  if (!fs.statSync(p.cwd).isDirectory()) fail('INVALID_PATH', 'cwd must be a directory');
  const scope = p.scope;
  if (!scope || typeof scope !== 'object' || scope.allowDelegation !== false || typeof scope.allowShell !== 'boolean' || typeof scope.allowNetwork !== 'boolean') fail('INVALID_SCOPE', 'Explicit execution permissions required; recursive delegation is disabled');
  for (const name of ['readRoots','writeRoots','allowedTools']) {
    if (!Array.isArray(scope[name]) || scope[name].some(x => typeof x !== 'string' || !x.trim())) fail('INVALID_SCOPE', `Invalid ${name}`);
  }
  if (!scope.readRoots.length || !scope.allowedTools.length) fail('INVALID_SCOPE', 'Read roots and tool allowlist must not be empty');
  for (const key of ['readRoots','writeRoots']) scope[key] = scope[key].map(pth => {
    if (!path.isAbsolute(pth)) fail('INVALID_SCOPE', 'Scope roots must be absolute');
    return resolvedPath(pth);
  });
  if (!scope.readRoots.some(r => isWithin(r, p.cwd))) fail('INVALID_SCOPE', 'cwd must be inside an authorized read root: choose an existing cwd within a read root, or split the task; never widen readRoots to cover cwd', { field: 'cwd', expected: 'existing directory inside an authorized read root, otherwise split the task' });
  if (scope.writeRoots.some(w => !scope.readRoots.some(r => isWithin(r,w)))) fail('INVALID_SCOPE', 'Write roots must be covered by read roots');
  if (['investigate','review'].includes(p.role) && scope.writeRoots.length) fail('INVALID_SCOPE', 'Investigation/review tasks must be read-only');
  const childSessions = validateChildSessions(scope.childSessions, scope.allowedTools);
  if (childSessions === undefined) delete scope.childSessions; else scope.childSessions = childSessions;
  const backgroundJobs = validateBackgroundJobs(scope.backgroundJobs);
  if (backgroundJobs === undefined) delete scope.backgroundJobs; else scope.backgroundJobs = backgroundJobs;
  const rootCallback = validateRootCallback(p.rootCallback);
  if (rootCallback === undefined) delete p.rootCallback; else p.rootCallback = rootCallback;
  // Additive long-task supervisor grant (`packet.project`). Absent means the
  // historical single bounded task: nothing below changes that path. Present means
  // this task is a supervisor-project session whose workers are declared later by
  // supervisor-only tools; the block is validated and normalized here, while host
  // enablement and per-worker attenuation are enforced by the runtime.
  const project = validateProjectBlock(p.project, scope, p.cwd);
  if (project === undefined) delete p.project; else p.project = project;
  if (project !== undefined && p.understandingRequired === true) {
    fail('INVALID_PACKET', 'understandingRequired is not supported with packet.project: a supervisor project is one planning round with no approval step', { field: 'understandingRequired' });
  }
  if (!Array.isArray(p.materials)) fail('INVALID_PACKET', 'materials array required');
  for (const m of p.materials) {
    if (!m || typeof m !== 'object' || (!m.path && typeof m.text !== 'string')) fail('INVALID_PACKET', 'Each material requires path or text');
    if(m.path!==undefined&&(typeof m.path!=='string'||!m.path.trim()))fail('INVALID_PACKET','Material path must be a nonempty string');
    if (m.path) {
      const target = resolvedPath(path.resolve(requestedCwd,m.path));
      if (!scope.readRoots.some(r=>isWithin(r,target))) fail('INVALID_SCOPE','Material outside read scope');
      m.path = target;
      if (m.sha256) {
        if(!fs.existsSync(target)||!fs.statSync(target).isFile())fail('MATERIAL_CHANGED','Hashed material file is unavailable');
        const actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        if (actual.toLowerCase() !== String(m.sha256).toLowerCase()) fail('MATERIAL_CHANGED', 'Material hash mismatch');
      }
    }
  }
  p.dependencies ??= [];
  if (!Array.isArray(p.dependencies) || p.dependencies.some(x => typeof x !== 'string' || !x.trim()) || new Set(p.dependencies).size !== p.dependencies.length) fail('INVALID_PACKET','Invalid dependencies');
  if(p.budget!==undefined&&(!p.budget||typeof p.budget!=='object'||Array.isArray(p.budget)))fail('INVALID_BUDGET','Budget must be an object');
  p.budget = {timeoutMs:600000,maxToolCalls:100,maxOutputChars:200000,...p.budget};
  for (const [k,v] of Object.entries(p.budget)) if (!['timeoutMs','maxToolCalls','maxOutputChars'].includes(k) || !Number.isSafeInteger(v) || v<1) fail('INVALID_BUDGET','Budgets must be positive integers');
  if (p.budget.timeoutMs>86400000 || p.budget.maxToolCalls>10000 || p.budget.maxOutputChars>10000000) fail('INVALID_BUDGET','Budget exceeds host maximum');
  if (p.understandingRequired !== undefined && typeof p.understandingRequired !== 'boolean') fail('INVALID_PACKET','understandingRequired must be boolean');
  if (p.workspace && (!path.isAbsolute(p.workspace.repository || '') || typeof p.workspace.baseRef !== 'string' || !p.workspace.baseRef)) fail('INVALID_WORKSPACE','Workspace repository and baseRef required');
  return p;
}
export const TERMINAL = new Set(['completed','failed','cancelled']);

// ---------------------------------------------------------------------------
// Additive optional grants (contract supervisor-event-wake-v1)
//
// `allowDelegation` stays literal false: recursive native delegation is never
// enabled. Child sessions and profile-granted background jobs are separate,
// explicitly opted-in grants that must be present or absent exactly as
// declared. They are validated for SHAPE here; host-side enablement and the
// immutable parent grant are enforced by the adapter/supervisor before any
// session, child or job exists.
// ---------------------------------------------------------------------------

const CHILD_SESSION_KEYS = ['enabled','maxChildren','toolNames'];
const BACKGROUND_JOB_KEYS = ['enabled','profileIds','maxJobs'];
const ROOT_CALLBACK_KEYS = ['grantId'];

function requireExactKeys(value, allowed, field, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(code, `${field} does not permit "${key}"`, { field: `${field}.${key}`, expected: allowed.join('|') });
    }
  }
}

function validateChildSessions(raw, allowedTools) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_SCOPE','scope.childSessions must be an object',{ field:'scope.childSessions' });
  requireExactKeys(raw, CHILD_SESSION_KEYS, 'scope.childSessions', 'INVALID_SCOPE');
  if (raw.enabled !== true) fail('INVALID_SCOPE','scope.childSessions.enabled must be exactly true to opt in',{ field:'scope.childSessions.enabled', expected:'true' });
  const out = { enabled: true };
  if (raw.maxChildren !== undefined) {
    if (!Number.isSafeInteger(raw.maxChildren) || raw.maxChildren < 1 || raw.maxChildren > 16) fail('INVALID_SCOPE','scope.childSessions.maxChildren must be an integer 1..16',{ field:'scope.childSessions.maxChildren' });
    out.maxChildren = raw.maxChildren;
  }
  if (raw.toolNames !== undefined) {
    if (!Array.isArray(raw.toolNames) || raw.toolNames.some(n => typeof n !== 'string' || !n.trim())) fail('INVALID_SCOPE','scope.childSessions.toolNames must be an array of nonblank tool names',{ field:'scope.childSessions.toolNames' });
    for (const name of raw.toolNames) {
      if (!allowedTools.includes(name)) fail('INVALID_SCOPE',`scope.childSessions.toolNames names "${name}" outside scope.allowedTools`,{ field:'scope.childSessions.toolNames', tool:name });
    }
    out.toolNames = [...raw.toolNames];
  }
  return out;
}

function validateBackgroundJobs(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_SCOPE','scope.backgroundJobs must be an object',{ field:'scope.backgroundJobs' });
  requireExactKeys(raw, BACKGROUND_JOB_KEYS, 'scope.backgroundJobs', 'INVALID_SCOPE');
  if (raw.enabled !== true) fail('INVALID_SCOPE','scope.backgroundJobs.enabled must be exactly true to opt in',{ field:'scope.backgroundJobs.enabled', expected:'true' });
  if (!Array.isArray(raw.profileIds) || raw.profileIds.length === 0 || raw.profileIds.length > 32 || raw.profileIds.some(id => typeof id !== 'string' || !id.trim())) {
    fail('INVALID_SCOPE','scope.backgroundJobs.profileIds must be a nonempty array of at most 32 nonblank profile ids',{ field:'scope.backgroundJobs.profileIds' });
  }
  if (new Set(raw.profileIds).size !== raw.profileIds.length) fail('INVALID_SCOPE','scope.backgroundJobs.profileIds must not repeat',{ field:'scope.backgroundJobs.profileIds' });
  const out = { enabled: true, profileIds: [...raw.profileIds] };
  if (raw.maxJobs !== undefined) {
    if (!Number.isSafeInteger(raw.maxJobs) || raw.maxJobs < 1 || raw.maxJobs > 16) fail('INVALID_SCOPE','scope.backgroundJobs.maxJobs must be an integer 1..16',{ field:'scope.backgroundJobs.maxJobs' });
    out.maxJobs = raw.maxJobs;
  }
  return out;
}

function validateRootCallback(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_PACKET','rootCallback must be an object',{ field:'rootCallback' });
  requireExactKeys(raw, ROOT_CALLBACK_KEYS, 'rootCallback', 'INVALID_PACKET');
  if (typeof raw.grantId !== 'string' || !raw.grantId.trim() || raw.grantId.length > 200) fail('INVALID_PACKET','rootCallback.grantId must be a nonblank string of at most 200 characters',{ field:'rootCallback.grantId' });
  return { grantId: raw.grantId.trim() };
}

// ---------------------------------------------------------------------------
// Additive long-task supervisor grant (`packet.project`, contract
// long-supervisor-first-edition-v1)
//
// The project block is the immutable WORKER ENVELOPE plus the project-wide
// budgets. It never grants the supervisor session itself any write, shell,
// network or delegation authority: the supervisor session stays a bounded
// read-only planner and every worker is a separate bounded task whose packet is
// attenuated from this envelope by `src/long-task.mjs`.
//
// Defaults here are the REQUESTED defaults. Host policy (`supervisorProjects`)
// may only lower them, and does so in the runtime/adapter with a typed refusal,
// never by silently clamping a request.
// ---------------------------------------------------------------------------

const PROJECT_KEYS = ['maxWorkers','maxConcurrentWorkers','maxRepairAttempts','maxTotalRetries','maxWorkerStarts','maxTotalToolCalls','timeoutMs','reserveSlots','workerScope','workspace','maxRounds'];
const PROJECT_WORKER_SCOPE_KEYS = ['readRoots','writeRoots','allowedTools','allowNetwork','budgets'];

function projectInt(value, field, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_PACKET', `${field} must be an integer within ${min}..${max}`, { field, expected: `integer ${min}..${max}` });
  }
  return value;
}

function projectRoots(value, field, { allowEmpty }) {
  if (value === undefined || value === null) {
    if (allowEmpty) return [];
    fail('INVALID_PACKET', `${field} is required`, { field });
  }
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail('INVALID_PACKET', `${field} must be ${allowEmpty ? 'an array' : 'a nonempty array'} of absolute paths`, { field });
  }
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) fail('INVALID_PACKET', `${field} entries must be nonblank strings`, { field });
    if (!path.isAbsolute(entry)) fail('INVALID_SCOPE', `${field} entries must be absolute paths`, { field });
    out.push(resolvedPath(entry));
  }
  return out;
}

function validateProjectBlock(raw, scope, cwd) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_PACKET', 'project must be an object', { field: 'project' });
  requireExactKeys(raw, PROJECT_KEYS, 'project', 'INVALID_PACKET');
  if (scope.writeRoots.length > 0) {
    fail('INVALID_SCOPE', 'a supervisor-project packet must not declare its own scope.writeRoots; worker writes are declared inside project.workerScope', { field: 'scope.writeRoots' });
  }
  if (scope.allowShell === true) fail('INVALID_SCOPE', 'a supervisor-project packet must not request a shell', { field: 'scope.allowShell' });
  if (scope.childSessions !== undefined) fail('INVALID_SCOPE', 'a supervisor-project packet must not grant childSessions; workers are declared through supervisor-only tools', { field: 'scope.childSessions' });
  if (scope.backgroundJobs !== undefined) fail('INVALID_SCOPE', 'a supervisor-project packet must not grant backgroundJobs', { field: 'scope.backgroundJobs' });

  const rawScope = raw.workerScope;
  if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    fail('INVALID_PACKET', 'project.workerScope is required and must be an object', { field: 'project.workerScope' });
  }
  requireExactKeys(rawScope, PROJECT_WORKER_SCOPE_KEYS, 'project.workerScope', 'INVALID_PACKET');
  const readRoots = projectRoots(rawScope.readRoots, 'project.workerScope.readRoots', { allowEmpty: false });
  const writeRoots = projectRoots(rawScope.writeRoots, 'project.workerScope.writeRoots', { allowEmpty: true });
  for (const root of writeRoots) {
    if (!readRoots.some((candidate) => isWithin(candidate, root))) {
      fail('INVALID_SCOPE', 'project.workerScope.writeRoots must be covered by project.workerScope.readRoots', { field: 'project.workerScope.writeRoots' });
    }
  }
  const allowedTools = rawScope.allowedTools;
  if (!Array.isArray(allowedTools) || allowedTools.length === 0 || allowedTools.some((name) => typeof name !== 'string' || !name.trim())) {
    fail('INVALID_PACKET', 'project.workerScope.allowedTools must be a nonempty array of nonblank tool names', { field: 'project.workerScope.allowedTools' });
  }
  if (typeof rawScope.allowNetwork !== 'boolean') {
    fail('INVALID_PACKET', 'project.workerScope.allowNetwork must be a boolean', { field: 'project.workerScope.allowNetwork' });
  }
  const rawBudgets = rawScope.budgets;
  let budgets;
  if (rawBudgets !== undefined && rawBudgets !== null) {
    if (typeof rawBudgets !== 'object' || Array.isArray(rawBudgets)) fail('INVALID_PACKET', 'project.workerScope.budgets must be an object', { field: 'project.workerScope.budgets' });
    for (const key of Object.keys(rawBudgets)) {
      if (!['timeoutMs','maxToolCalls','maxOutputChars'].includes(key)) fail('INVALID_PACKET', `project.workerScope.budgets does not permit "${key}"`, { field: `project.workerScope.budgets.${key}` });
    }
    budgets = {
      timeoutMs: projectInt(rawBudgets.timeoutMs, 'project.workerScope.budgets.timeoutMs', 1, 86400000, 600000),
      maxToolCalls: projectInt(rawBudgets.maxToolCalls, 'project.workerScope.budgets.maxToolCalls', 1, 10000, 100),
      maxOutputChars: projectInt(rawBudgets.maxOutputChars, 'project.workerScope.budgets.maxOutputChars', 1, 10000000, 200000)
    };
  }

  const maxWorkers = projectInt(raw.maxWorkers, 'project.maxWorkers', 1, 16, 8);
  const maxConcurrentWorkers = projectInt(raw.maxConcurrentWorkers, 'project.maxConcurrentWorkers', 1, 16, 3);
  if (maxConcurrentWorkers > maxWorkers) fail('INVALID_PACKET', 'project.maxConcurrentWorkers must not exceed project.maxWorkers', { field: 'project.maxConcurrentWorkers' });
  const maxRepairAttempts = projectInt(raw.maxRepairAttempts, 'project.maxRepairAttempts', 0, 2, 2);
  const attemptCeiling = Math.min(64, maxWorkers * (maxRepairAttempts + 1));
  const maxTotalRetries = projectInt(raw.maxTotalRetries, 'project.maxTotalRetries', 0, 64, attemptCeiling);
  const maxWorkerStarts = projectInt(raw.maxWorkerStarts, 'project.maxWorkerStarts', 1, 64, attemptCeiling);
  // Optional bounded-recurrence opt-in. A TRULY ABSENT `maxRounds` stays absent in the
  // normalized packet so an already-persisted legacy project packet keeps its exact
  // bytes and SQL idempotency hash; the effective default of 1 is resolved by the
  // grant/runtime, never injected into the packet here. A PRESENT value must be an
  // integer 1..8: an explicit `null` (or any other non-integer) is a refused request,
  // never silently rewritten into "absent", while `projectInt`'s null-means-fallback
  // rule would have dropped it. 1..8 is the published range for BOTH the packet
  // request and the host ceiling.
  const maxRounds = raw.maxRounds === undefined
    ? undefined
    : Number.isSafeInteger(raw.maxRounds) && raw.maxRounds >= 1 && raw.maxRounds <= 8
      ? raw.maxRounds
      : fail('INVALID_PACKET', 'project.maxRounds must be an integer within 1..8', { field: 'project.maxRounds', expected: 'integer 1..8' });

  const out = {
    maxWorkers,
    maxConcurrentWorkers,
    maxRepairAttempts,
    maxTotalRetries,
    maxWorkerStarts,
    maxTotalToolCalls: projectInt(raw.maxTotalToolCalls, 'project.maxTotalToolCalls', 1, 100000, 10000),
    timeoutMs: projectInt(raw.timeoutMs, 'project.timeoutMs', 1000, 86400000, 3600000),
    reserveSlots: projectInt(raw.reserveSlots, 'project.reserveSlots', 1, 15, 1),
    ...(maxRounds === undefined ? {} : { maxRounds }),
    workerScope: {
      readRoots,
      writeRoots,
      allowedTools: [...allowedTools],
      allowNetwork: rawScope.allowNetwork,
      ...(budgets === undefined ? {} : { budgets })
    }
  };

  if (raw.workspace !== undefined && raw.workspace !== null) {
    const rawWorkspace = raw.workspace;
    if (typeof rawWorkspace !== 'object' || Array.isArray(rawWorkspace)) fail('INVALID_WORKSPACE', 'project.workspace must be an object', { field: 'project.workspace' });
    requireExactKeys(rawWorkspace, ['repository','baseRef'], 'project.workspace', 'INVALID_WORKSPACE');
    if (typeof rawWorkspace.repository !== 'string' || !path.isAbsolute(rawWorkspace.repository)) {
      fail('INVALID_WORKSPACE', 'project.workspace.repository must be an absolute path', { field: 'project.workspace.repository' });
    }
    if (typeof rawWorkspace.baseRef !== 'string' || !rawWorkspace.baseRef.trim()) {
      fail('INVALID_WORKSPACE', 'project.workspace.baseRef is required', { field: 'project.workspace.baseRef' });
    }
    const repository = resolvedPath(rawWorkspace.repository);
    for (const root of [...readRoots, ...writeRoots]) {
      if (!isWithin(repository, root)) {
        fail('INVALID_SCOPE', 'project.workerScope roots must stay inside project.workspace.repository: a per-writer worktree cannot isolate a root outside its repository', { field: 'project.workerScope.readRoots' });
      }
    }
    if (!isWithin(repository, cwd)) {
      fail('INVALID_SCOPE', 'a supervisor project with project.workspace requires cwd inside project.workspace.repository', { field: 'cwd' });
    }
    out.workspace = { repository, baseRef: rawWorkspace.baseRef };
  } else if (writeRoots.length > 0) {
    fail('INVALID_SCOPE', 'project.workerScope.writeRoots requires project.workspace: every writer needs its own owned worktree', { field: 'project.workspace' });
  }

  return out;
}
