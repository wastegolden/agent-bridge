// src/peer/lineage.mjs
//
// Process-lineage ledger for agent-peer (contract agent-peer-v1).
//
// The delegation chain normally travels in AGENT_BRIDGE_CHAIN. A harness may start
// its MCP servers with a filtered environment (Codex forwards only a whitelist), so
// an agent-peer server inside a peer harness could otherwise believe it is a root
// controller and call back up the chain. The ledger closes that gap without trusting
// the environment:
//
//   * when a peer job starts, the spawning server records
//       <stateDir>/active/<childPid>.json = { pid, jobId, chain, target, startedAt }
//     and removes it when the job settles;
//   * when an agent-peer server starts, it walks its own process ancestry (bounded)
//     and, if an ancestor pid has a ledger entry whose spawn time matches that
//     process, adopts the recorded chain.
//
// A stale entry can only make a chain longer (more refusals), never shorter, so pid
// reuse fails safe. Ancestry lookup errors are reported; they never invent a chain.
//
// On Windows the helper uses an absolute PowerShell path, fill-only environment
// defaults, inbox modules and no stdin. A harness can filter its MCP environment
// and start the server without a console. Measured on a GitHub windows-latest runner
// (scripts/ci-diagnose.mjs): without the inherited PSModulePath, command discovery
// for Get-CimInstance through module auto-loading hung past the 20 s timeout (also
// with an inbox-only PSModulePath, and no other variable or stdin/console setting
// helped); importing the inbox modules explicitly with auto-loading off read the
// table in ~0.4 s. The remaining environment defaults are defensive.

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HARNESSES, PeerPolicyError, formatChain, parseChain } from './chain.mjs';

export const MAX_ANCESTOR_HOPS = 8;
/** A recorded spawn and the matching process creation must be this close (ms). */
export const SPAWN_MATCH_WINDOW_MS = 120_000;

export function activeDir(stateDir) {
  return path.join(stateDir, 'active');
}

export async function recordActive(stateDir, { pid, jobId, chain, target, startedAt, rootTask = null }) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const dir = activeDir(stateDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${pid}.json`);
  await writeFile(file, `${JSON.stringify({ pid, jobId, chain: formatChain(chain), target, startedAt, rootTask })}\n`, 'utf8');
  return file;
}

export async function clearActive(stateDir, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  await rm(path.join(activeDir(stateDir), `${pid}.json`), { force: true });
}

function parseWmiDate(value) {
  if (typeof value !== 'string') return null;
  const match = /\/Date\((\d+)\)\//.exec(value);
  if (match) return Number(match[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';
const WINDOWS_QUERY = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress';
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')",
  "Import-Module ($PSHOME + '\\Modules\\CimCmdlets\\CimCmdlets.psd1')",
  WINDOWS_QUERY,
].join('; ');

/** The actual key of `name` in `env`; Windows environment names are case-insensitive. */
function envKey(env, name) {
  const wanted = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === wanted) ?? null;
}

/** First non-empty value among case-variant spellings of `names`, or undefined. */
function envValue(env, names) {
  for (const name of names) {
    const key = envKey(env, name);
    if (key === null) continue;
    const value = env[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Fill an absent variable without changing a caller's value or adding a case variant. */
function fillEnvValue(env, name, value) {
  const key = envKey(env, name);
  if (key !== null && typeof env[key] === 'string') return;
  env[key ?? name] = value;
}

/**
 * Child environment for the Windows PowerShell helper. A harness may start an MCP
 * server with a filtered environment (Codex forwards a whitelist), and PowerShell then
 * has no SystemRoot/ComSpec/temp directory or module search path to work with. Only
 * missing values are filled; a present value (including empty) is never overridden.
 */
function windowsProcessEnv(env) {
  const child = { ...env };
  const systemRoot = envValue(child, ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR']) ?? DEFAULT_SYSTEM_ROOT;
  fillEnvValue(child, 'SystemRoot', systemRoot);
  fillEnvValue(child, 'windir', systemRoot);
  fillEnvValue(child, 'ComSpec', path.win32.join(systemRoot, 'System32', 'cmd.exe'));
  const tempDir = envValue(child, ['TEMP', 'TMP']) ?? os.tmpdir();
  fillEnvValue(child, 'TEMP', tempDir);
  fillEnvValue(child, 'TMP', tempDir);
  const userProfile = envValue(child, ['USERPROFILE']) ?? os.homedir();
  fillEnvValue(child, 'USERPROFILE', userProfile);
  fillEnvValue(child, 'LOCALAPPDATA', path.win32.join(userProfile, 'AppData', 'Local'));
  fillEnvValue(child, 'APPDATA', path.win32.join(userProfile, 'AppData', 'Roaming'));
  fillEnvValue(child, 'PATHEXT', WINDOWS_PATHEXT);
  const drive = path.win32.parse(systemRoot).root;
  const programFiles = envValue(child, ['ProgramW6432', 'ProgramFiles']) ?? path.win32.join(drive, 'Program Files');
  const programData = envValue(child, ['ProgramData', 'ALLUSERSPROFILE']) ?? path.win32.join(drive, 'ProgramData');
  fillEnvValue(child, 'ProgramFiles', programFiles);
  fillEnvValue(child, 'ProgramW6432', programFiles);
  fillEnvValue(child, 'CommonProgramFiles', path.win32.join(programFiles, 'Common Files'));
  fillEnvValue(child, 'CommonProgramW6432', path.win32.join(programFiles, 'Common Files'));
  fillEnvValue(child, 'ProgramData', programData);
  fillEnvValue(child, 'ALLUSERSPROFILE', programData);
  fillEnvValue(child, 'HOMEDRIVE', path.win32.parse(userProfile).root.replace(/\\$/, ''));
  fillEnvValue(child, 'HOMEPATH', userProfile.slice(path.win32.parse(userProfile).root.length - 1));
  if (envKey(child, 'USERNAME') === null) {
    try { fillEnvValue(child, 'USERNAME', os.userInfo().username); } catch {}
  }
  fillEnvValue(child, 'COMPUTERNAME', os.hostname());
  fillEnvValue(child, 'OS', 'Windows_NT');
  const machine = os.machine().toLowerCase();
  fillEnvValue(child, 'PROCESSOR_ARCHITECTURE', { x86_64: 'AMD64', amd64: 'AMD64', aarch64: 'ARM64', arm64: 'ARM64' }[machine] ?? 'x86');
  fillEnvValue(child, 'NUMBER_OF_PROCESSORS', String(os.cpus().length || 1));
  // The query needs only inbox modules; avoid default discovery of user/network paths.
  fillEnvValue(child, 'PSModulePath', path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
  return { env: child, systemRoot };
}

/**
 * Snapshot of the OS process table as Map<pid, {ppid, createdAt|null}>.
 * Windows uses CIM through Windows PowerShell; POSIX uses ps. Throws on failure.
 */
export function readProcessTable({ spawnSyncImpl = spawnSync, platform = process.platform, env = process.env } = {}) {
  const table = new Map();
  if (platform === 'win32') {
    const { env: childEnv, systemRoot } = windowsProcessEnv(env);
    const result = spawnSyncImpl(
      path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-Command', WINDOWS_SCRIPT],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 32 * 1024 * 1024, env: childEnv },
    );
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new PeerPolicyError('PEER_LINEAGE_UNAVAILABLE', 'cannot read the process table');
    let rows;
    try {
      rows = JSON.parse(result.stdout);
    } catch {
      throw new PeerPolicyError('PEER_LINEAGE_UNAVAILABLE', 'invalid process table');
    }
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const createdAt = parseWmiDate(row?.CreationDate);
      if (!Number.isInteger(row?.ProcessId) || row.ProcessId < 0 || !Number.isInteger(row.ParentProcessId) || row.ParentProcessId < 0) {
        throw new PeerPolicyError('PEER_LINEAGE_UNAVAILABLE', 'incomplete process table');
      }
      table.set(row.ProcessId, { ppid: row.ParentProcessId, createdAt });
    }
    if (table.size === 0) throw new PeerPolicyError('PEER_LINEAGE_UNAVAILABLE', 'empty process table');
    return table;
  }
  const result = spawnSyncImpl('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0 || typeof result.stdout !== 'string') throw new PeerPolicyError('PEER_LINEAGE_UNAVAILABLE', 'cannot read the process table');
  for (const line of result.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid)) table.set(pid, { ppid: Number.isInteger(ppid) ? ppid : null, createdAt: null });
  }
  return table;
}

/**
 * Find the nearest ancestor of `pid` that a peer server spawned. Returns
 * { chain: string[], target, jobId, ancestorPid, hops } or null.
 */
export async function findLedgerAncestor({ stateDir, pid = process.pid, table, readFileImpl = readFile, maxHops = MAX_ANCESTOR_HOPS }) {
  let current = table.get(pid)?.ppid ?? null;
  for (let hops = 1; hops <= maxHops && Number.isInteger(current) && current > 0; hops += 1) {
    let entry = null;
    try {
      entry = JSON.parse(await readFileImpl(path.join(activeDir(stateDir), `${current}.json`), 'utf8'));
    } catch {
      entry = null;
    }
    if (entry && entry.pid === current && HARNESSES.includes(entry.target)) {
      const createdAt = table.get(current)?.createdAt ?? null;
      const timeMatches = createdAt === null || !Number.isFinite(entry.startedAt) || Math.abs(createdAt - entry.startedAt) <= SPAWN_MATCH_WINDOW_MS;
      if (timeMatches) {
        const chain = parseChain(entry.chain);
        if (chain.at(-1) !== entry.target) throw new PeerPolicyError('PEER_CHAIN_INVALID', 'ledger entry chain does not end with its target');
        return { chain, target: entry.target, jobId: entry.jobId ?? null, rootTask: typeof entry.rootTask === 'string' ? entry.rootTask : null, ancestorPid: current, hops };
      }
    }
    current = table.get(current)?.ppid ?? null;
  }
  return null;
}

/**
 * Reconcile the inherited environment with the ledger. The ledger wins over a
 * missing chain; a present but different chain is refused rather than guessed.
 * Returns the environment the server should read its chain context from.
 */
export function applyLineage(env, ancestor) {
  if (!ancestor) return { env, source: 'environment' };
  const self = env.AGENT_BRIDGE_SELF;
  if (self !== ancestor.target) {
    throw new PeerPolicyError('PEER_CHAIN_INVALID', `this server runs inside a "${ancestor.target}" peer job but is configured as "${self}"`, { field: 'AGENT_BRIDGE_SELF' });
  }
  const recorded = formatChain(ancestor.chain);
  const inherited = typeof env.AGENT_BRIDGE_CHAIN === 'string' ? env.AGENT_BRIDGE_CHAIN.trim() : '';
  if (inherited !== '' && inherited !== recorded) {
    throw new PeerPolicyError('PEER_CHAIN_INVALID', `inherited chain "${inherited}" disagrees with the recorded chain "${recorded}"`, { field: 'AGENT_BRIDGE_CHAIN' });
  }
  const next = { ...env, AGENT_BRIDGE_CHAIN: recorded };
  const inheritedTask = typeof env.AGENT_BRIDGE_ROOT_TASK === 'string' ? env.AGENT_BRIDGE_ROOT_TASK.trim() : '';
  if (ancestor.rootTask) {
    if (inheritedTask !== '' && inheritedTask !== ancestor.rootTask) {
      throw new PeerPolicyError('PEER_CHAIN_INVALID', 'inherited root task disagrees with the recorded root task', { field: 'AGENT_BRIDGE_ROOT_TASK' });
    }
    next.AGENT_BRIDGE_ROOT_TASK = ancestor.rootTask;
  }
  return { env: next, source: inherited === '' ? 'ledger' : 'environment+ledger' };
}
