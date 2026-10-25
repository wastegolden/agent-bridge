#!/usr/bin/env node
// One-shot Windows lineage diagnosis; environment values and process rows stay private.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { readProcessTable } from '../src/peer/lineage.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.dirname(path.dirname(SCRIPT));
const QUERY = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress';
const ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', QUERY];
const CANDIDATES = ['PSModulePath', 'ProgramFiles', 'ProgramW6432', 'CommonProgramFiles',
  'ProgramFiles(x86)', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData',
  'ALLUSERSPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS'];

function value(env, name) {
  return env[Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())];
}

// Frozen 1.6.2 baseline: do not replace this with the product's evolving helper.
function filled162(env) {
  const child = { ...env };
  const root = value(child, 'SystemRoot') || value(child, 'windir') || 'C:\\Windows';
  const home = os.homedir();
  const defaults = {
    SystemRoot: root, windir: root, ComSpec: path.win32.join(root, 'System32', 'cmd.exe'),
    TEMP: os.tmpdir(), TMP: os.tmpdir(), USERPROFILE: home,
    LOCALAPPDATA: path.win32.join(home, 'AppData', 'Local'),
    APPDATA: path.win32.join(home, 'AppData', 'Roaming'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };
  for (const [name, fallback] of Object.entries(defaults)) {
    if (!value(child, name)) {
      const key = Object.keys(child).find((key) => key.toLowerCase() === name.toLowerCase());
      child[key ?? name] = fallback;
    }
  }
  return child;
}

function measure(spec) {
  const started = performance.now();
  let result;
  let verified = false;
  let failure = null;
  const capture = (command, args, options) => {
    result = spawnSync(command, args, options);
    return result;
  };
  try {
    if (spec.fixed || spec.fixedEnv || spec.fixedScript) {
      const table = readProcessTable({ spawnSyncImpl: (command, args, options) => capture(command,
        spec.fixedEnv ? ARGS : args, { ...options,
          ...(spec.fixedScript ? { env: filled162(process.env) } : {}),
          ...(spec.fixedEnv || spec.fixedScript ? { stdio: ['pipe', 'pipe', 'pipe'] } : {}),
        }) });
      verified = table.get(process.pid)?.ppid === process.ppid;
    } else {
      const env = spec.fullEnv ?? (spec.old ? { ...process.env } : filled162(process.env));
      if (spec.extra) Object.assign(env, spec.extra);
      if (spec.builtinModules) env.PSModulePath = path.win32.join(value(env, 'SystemRoot'), 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
      const root = value(env, 'SystemRoot') || 'C:\\Windows';
      result = capture(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ARGS, {
        encoding: 'utf8', windowsHide: spec.psVisible !== true, timeout: 20_000,
        maxBuffer: 32 * 1024 * 1024, env,
        ...(spec.stdin ? { stdio: [spec.stdin, 'pipe', 'pipe'] } : {}),
        ...(spec.detached ? { detached: true } : {}),
      });
      if (result.status === 0) {
        const parsed = JSON.parse(result.stdout);
        verified = (Array.isArray(parsed) ? parsed : [parsed]).some((row) => row?.ProcessId === process.pid && row.ParentProcessId === process.ppid);
      }
    }
  } catch (error) {
    failure = result?.stdout === '' ? 'empty stdout' : error?.code ?? error?.name ?? 'error';
  }
  return {
    ms: Math.round(performance.now() - started), status: result?.status ?? null,
    timedOut: result?.error?.code === 'ETIMEDOUT', verified,
    detail: result?.error?.code ?? result?.stderr?.match(/(?:HRESULT\s+)?0x[0-9a-f]+/i)?.[0]
      ?? result?.stderr?.match(/FullyQualifiedErrorId\s*:\s*([A-Za-z0-9_.:, -]+)/)?.[1]?.trim() ?? failure ?? '',
  };
}

async function attempt(spec, env) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [SCRIPT, '--child'], {
      env, windowsHide: spec.nodeVisible !== true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let spawnError;
    let settled = false;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (error) => { spawnError = error.code; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Bound the whole attempt, including a stuck helper, to at most 25 s.
      const killed = child.exitCode === null && child.pid ? spawnSync(
        path.win32.join(value(process.env, 'SystemRoot') || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 1000 },
      ) : null;
      child.kill();
      settled = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ variation: spec.name, ms: Math.round(performance.now() - started), status: null,
        timedOut: true, verified: false, detail: killed?.status === 0 ? 'watchdog' : 'watchdog; stop unconfirmed' });
    }, 24_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      let row;
      try { row = JSON.parse(output); } catch {}
      resolve({ variation: spec.name, ...(row ?? {
        ms: Math.round(performance.now() - started), status, timedOut, verified: false,
        detail: spawnError ?? 'child produced no result',
      }), ...(spec.missing ? { detail: 'candidate absent in parent' } : {}) });
    });
    // Keep the pipe open during the read, just like the real MCP client.
    if (spec.closeInput) child.stdin.end(`${JSON.stringify(spec)}\n`);
    else child.stdin.write(`${JSON.stringify(spec)}\n`);
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Windows-only diagnosis; skipped.');
    return;
  }
  const scratch = path.join(REPO, '.runtime');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(path.join(scratch, 'ci-diagnose-'));
  try {
    const configPath = path.join(dir, 'peer.json');
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, stateDir: path.join(dir, 'state'), peers: { codex: { executable: path.join(dir, 'codex.exe') } } }));
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AGENT_BRIDGE_SELF: 'claude-code', AGENT_PEER_CONFIG: configPath };
    const variants = [{ name: 'old/minimal', old: true }, { name: '1.6.2/filled' }];
    for (const name of CANDIDATES) {
      const inherited = value(process.env, name);
      variants.push({ name: `1.6.2 + ${name}`, extra: inherited === undefined ? {} : { [name]: inherited }, missing: inherited === undefined });
    }
    variants.push(
      { name: 'PS full env', fullEnv: { ...process.env } },
      { name: 'Node + PS full env', nodeFullEnv: true, fullEnv: { ...process.env } },
      { name: '1.6.2 / PS stdin ignore', stdin: 'ignore' },
      { name: '1.6.2 / PS stdin inherit', stdin: 'inherit' },
      { name: '1.6.2 / Node stdin closed', closeInput: true },
      { name: '1.6.2 / PS windowsHide false', psVisible: true },
      { name: '1.6.2 / Node windowsHide false', nodeVisible: true },
      { name: '1.6.2 / detached PS / null stdin', detached: true, stdin: 'ignore' },
      { name: '1.6.2 / builtin module path', builtinModules: true },
      { name: 'fixed env / old script + stdin', fixedEnv: true },
      { name: '1.6.2 / fixed script + text flags', fixedScript: true },
      { name: 'fixed readProcessTable', fixed: true },
    );
    console.log(`Node ${process.version}; ${os.type()} ${os.release()}; ${process.arch}`);
    console.log('All rows use the hidden minimal-env Node child except the labelled Node variations.');
    console.log('| variation | ms | exit status | timed out | own pid/ppid | detail |');
    console.log('| --- | ---: | --- | --- | --- | --- |');
    for (const spec of variants) {
      const row = await attempt(spec, spec.nodeFullEnv ? { ...process.env, ...env } : env);
      console.log(`| ${row.variation} | ${row.ms} | ${row.status ?? 'null'} | ${row.timedOut} | ${row.verified} | ${row.detail} |`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes('--child')) {
  const reader = readline.createInterface({ input: process.stdin });
  reader.once('line', (line) => {
    const row = measure(JSON.parse(line));
    process.stdout.write(JSON.stringify(row), () => process.exit(0));
  });
} else {
  await main().catch((error) => console.log(`Diagnosis could not finish: ${error?.code ?? error?.name ?? 'error'}`));
}
