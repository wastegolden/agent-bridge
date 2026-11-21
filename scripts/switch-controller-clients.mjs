#!/usr/bin/env node
// R8 client cutover. Importable operations use injected environment/process/ACL
// adapters; only the CLI constructs a Windows adapter. Never log adapter errors.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { identityLayout, validateConfig } from './deploy-local.mjs';
import { stripBridgeCredentials } from '../src/bridge-credentials.mjs';

export const DEFAULT_BACKUP_ROOT = 'F:/temp/agent-bridge-upstream/deploy-p0b/client-backups';
export const USAGE = 'node scripts/switch-controller-clients.mjs --config <deploy.json> [--prepared-plugin <dir>] [--dry-run | --apply] [--claude-home <dir>] [--codex-home <dir>] [--codex-cache-dir <dir>] [--backup-root <dir>]\nnode scripts/switch-controller-clients.mjs --rollback <backup-directory> [--dry-run | --apply]';
const TOKEN_NAME = 'DSH_MCP_TOKEN';
const ROOT_ENV = /^(DSH_MCP_TOKEN|DSH_BRIDGE_CREDENTIAL_FILE|DSH_BRIDGE_DELEGATED|DSH_BRIDGE_DISABLED|DSH_BRIDGE_URL|AGENT_BRIDGE_CHAIN|AGENT_BRIDGE_ROOT_TASK)$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const slash = (value) => value.replaceAll('\\', '/');
const keyPath = (value) => slash(path.resolve(value)).toLowerCase();
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
class SwitchError extends Error {}
const fail = (message) => { throw new SwitchError(message); };

export function parseArgs(argv) {
  const options = { dryRun: true };
  const values = { '--config': 'configPath', '--rollback': 'rollback', '--prepared-plugin': 'preparedPlugin', '--claude-home': 'claudeHome', '--codex-home': 'codexHome', '--codex-cache-dir': 'codexCacheDir', '--backup-root': 'backupRoot' };
  let mode;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--apply' || arg === '--dry-run') {
      if (mode && mode !== arg) fail('Choose --apply or --dry-run.');
      mode = arg;
      options.dryRun = arg !== '--apply';
    } else if (values[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('A path option is missing its value.');
      options[values[arg]] = path.resolve(argv[++i]);
    } else fail('Unknown argument.');
  }
  if (!options.help && Boolean(options.configPath) === Boolean(options.rollback)) fail('Provide exactly one of --config or --rollback.');
  return options;
}

async function snapshot(file, restore = true) {
  const content = await readFile(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    fail('Cannot read a client configuration file.');
  });
  return { path: file, exists: content !== null, content: content?.toString('base64') ?? null, restore };
}

function parseJson(record) {
  if (!record.exists) fail('A required client configuration file is missing.');
  let value;
  try { value = JSON.parse(Buffer.from(record.content, 'base64').toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail('A client configuration file is not valid JSON.'); }
  if (!object(value)) fail('A client configuration file must contain an object.');
  return value;
}

/**
 * The Claude app loads a plugin from a `directory` marketplace straight from
 * the marketplace's source folder rather than from the installed cache, so that
 * folder must be switched too. Returns null for any other marketplace kind.
 */
async function locateClaudeSource(settings, claudeId, read) {
  const [name, marketplace] = claudeId.split('@');
  const source = settings.extraKnownMarketplaces?.[marketplace]?.source;
  if (!object(source) || source.source !== 'directory') return null;
  if (typeof source.path !== 'string' || !path.isAbsolute(source.path)) fail('Claude directory marketplace path must be absolute.');
  const record = await read(path.join(source.path, '.claude-plugin', 'marketplace.json'));
  const catalog = parseJson(record);
  const entries = Array.isArray(catalog.plugins) ? catalog.plugins.filter((entry) => entry?.name === name) : [];
  if (entries.length !== 1 || typeof entries[0].source !== 'string') fail('Claude directory marketplace entry is missing, ambiguous or unsupported.');
  const dir = path.resolve(source.path, entries[0].source);
  if (!keyPath(dir).startsWith(`${keyPath(source.path)}/`)) fail('Claude directory marketplace entry must stay inside its marketplace.');
  return { dir, record, catalog, entry: entries[0] };
}

/** Locate installed caches from their inventories, never from the newest mtime. */
export async function planClientSwitch(config, options = {}) {
  validateConfig(config);
  if (!config.identity) fail('Client switching requires an identity deployment.');
  const layout = identityLayout(config);
  const claudeHome = options.claudeHome ?? path.join(os.homedir(), '.claude');
  const codexHome = options.codexHome ?? path.join(os.homedir(), '.codex');
  const claudeId = config.claudePluginId ?? 'agent-bridge@agent-bridge-local';
  const codexId = config.codexPluginId ?? 'agent-bridge@personal';
  const sourceDir = options.preparedPlugin ?? path.join(config.deployRoot, 'plugin');
  const originals = new Map();
  const desired = new Map();
  const read = async (file, restore = true) => {
    const key = keyPath(file);
    if (!originals.has(key)) originals.set(key, await snapshot(file, restore));
    else if (restore) originals.get(key).restore = true;
    return originals.get(key);
  };
  const edit = (record, value) => {
    if (record.exists && isDeepStrictEqual(parseJson(record), value)) return;
    desired.set(keyPath(record.path), { path: record.path, exists: true, content: Buffer.from(jsonText(value)).toString('base64') });
  };
  const inventoryRecord = await read(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  const inventory = parseJson(inventoryRecord);
  const installs = inventory.plugins?.[claudeId];
  if (!Array.isArray(installs) || installs.length !== 1 || installs[0].scope !== 'user' || !path.isAbsolute(installs[0].installPath ?? '')) {
    fail('Claude installation is missing or ambiguous; resolve its user installation before switching.');
  }
  const claudeDir = installs[0].installPath;
  const settingsRecord = await read(path.join(claudeHome, 'settings.json'));
  const settings = parseJson(settingsRecord);
  if (settings.enabledPlugins?.[claudeId] !== true) fail('Enable the Claude plugin before switching, then quit the application.');
  const claudeSource = await locateClaudeSource(settings, claudeId, read);
  const claudeDirs = [claudeDir, ...(claudeSource && keyPath(claudeSource.dir) !== keyPath(claudeDir) ? [claudeSource.dir] : [])];
  const codexConfig = await read(path.join(codexHome, 'config.toml'), false);
  if (!codexConfig.exists) fail('Codex configuration is missing.');
  const toml = Buffer.from(codexConfig.content, 'base64').toString('utf8');
  // Read only this simple plugin section; never reserialize unrelated TOML.
  const section = toml.split(/\r?\n(?=\s*\[)/).find((part) => part.trimStart().startsWith(`[plugins.${JSON.stringify(codexId)}]`));
  if (!section || !/^\s*enabled\s*=\s*true\s*(?:#.*)?$/m.test(section)) fail('Enable the Codex plugin before switching, then quit the application.');
  const [codexName, marketplace] = codexId.split('@');
  if (!codexName || !marketplace || /[\\/]/.test(codexId)) fail('Invalid Codex plugin ID.');
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', marketplace, codexName);
  let codexDir = options.codexCacheDir;
  if (!codexDir) {
    const entries = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
    const candidates = entries.filter((entry) => entry.isDirectory());
    if (candidates.length !== 1) fail('Codex cache is missing or ambiguous; provide --codex-cache-dir for the verified installed version.');
    codexDir = path.join(cacheRoot, candidates[0].name);
  }
  if (keyPath(path.dirname(codexDir)) !== keyPath(cacheRoot)) fail('Codex cache override must name an installed version within its plugin cache.');

  const sourceRecord = await read(path.join(sourceDir, '.claude-plugin', 'plugin.json'), false);
  const template = parseJson(sourceRecord);
  if (template.mcpServers?.dsh_project?.type !== 'stdio' || !template.userConfig?.bridge_credential_file) fail('Deploy the R8 plugin package before switching clients.');
  for (const id of ['claude', 'codex']) {
    if (!(await stat(layout.tokenFiles[id]).catch(() => null))?.isFile()) fail('A root credential file is missing; prepare identity artifacts before switching.');
  }
  for (const name of ['bridge.mjs', 'peer-mcp.mjs']) {
    if (!(await stat(path.join(sourceDir, 'bin', name)).catch(() => null))?.isFile()) fail('Deployed MCP entry points are missing.');
  }
  const defaults = { node_path: slash(config.nodePath), peer_config: slash(layout.peerFiles.claude), dsh_bridge_url: config.bridgeUrl, bridge_credential_file: slash(layout.tokenFiles.claude) };
  for (const dir of claudeDirs) {
    const record = await read(path.join(dir, '.claude-plugin', 'plugin.json'));
    const manifest = parseJson(record);
    if (manifest.name !== template.name) fail('Claude installed cache or marketplace source does not contain the expected plugin.');
    manifest.version = template.version;
    manifest.description = template.description;
    manifest.userConfig ??= {};
    for (const [name, value] of Object.entries(defaults)) manifest.userConfig[name] = { ...template.userConfig[name], default: value };
    manifest.mcpServers ??= {};
    for (const [name, script] of [['dsh_project', 'bridge.mjs'], ['agent_peer', 'peer-mcp.mjs']]) {
      const prior = manifest.mcpServers[name] ?? {};
      const env = Object.fromEntries(Object.entries(prior.env ?? {}).filter(([key]) => !ROOT_ENV.test(key)));
      const server = { ...prior, ...template.mcpServers[name], type: 'stdio', command: slash(config.nodePath), args: [slash(path.join(sourceDir, 'bin', script))],
        env: { ...env, DSH_BRIDGE_CREDENTIAL_FILE: defaults.bridge_credential_file, DSH_BRIDGE_URL: config.bridgeUrl,
          ...(name === 'agent_peer' ? { AGENT_BRIDGE_SELF: 'claude-code', AGENT_PEER_CONFIG: defaults.peer_config } : {}) } };
      for (const key of ['url', 'headers', 'bearer_token_env_var']) delete server[key];
      manifest.mcpServers[name] = server;
    }
    edit(record, manifest);
  }
  installs[0].version = template.version;
  edit(inventoryRecord, inventory);
  if (claudeSource) {
    claudeSource.entry.version = template.version;
    edit(claudeSource.record, claudeSource.catalog);
  }
  settings.pluginConfigs ??= {};
  settings.pluginConfigs[claudeId] ??= {};
  settings.pluginConfigs[claudeId].options = { ...settings.pluginConfigs[claudeId].options, ...defaults };
  edit(settingsRecord, settings);

  const codexTemplate = parseJson(await read(path.join(sourceDir, '.codex-mcp.json'), false));
  const codexManifestTemplate = parseJson(await read(path.join(sourceDir, '.codex-plugin', 'plugin.json'), false));
  for (const dir of new Set([codexDir, ...(config.codexPluginDir ? [config.codexPluginDir] : [])])) {
    const manifestRecord = await read(path.join(dir, '.codex-plugin', 'plugin.json'));
    const creatingSource = !manifestRecord.exists && keyPath(dir) !== keyPath(codexDir);
    const manifest = creatingSource ? structuredClone(codexManifestTemplate) : parseJson(manifestRecord);
    if (manifest.name !== codexName) fail('Codex installed/source directory does not contain the expected plugin.');
    manifest.version = codexManifestTemplate.version;
    manifest.description = codexManifestTemplate.description;
    const relative = manifest.mcpServers;
    if (typeof relative !== 'string' || !['./.codex-mcp.json', './.mcp.json'].includes(slash(relative))) fail('Unsupported Codex MCP config location.');
    const loadedRecord = await read(path.join(dir, relative));
    const current = creatingSource && !loadedRecord.exists ? structuredClone(codexTemplate) : parseJson(loadedRecord);
    const targetRecord = await read(path.join(dir, '.mcp.json'));
    // A previously separate .mcp.json is preserved too, including extra servers.
    const target = targetRecord.exists ? parseJson(targetRecord) : {};
    const value = { ...target, ...current, mcpServers: { ...target.mcpServers, ...current.mcpServers } };
    for (const [name, script] of [['dsh_project', 'bridge.mjs'], ['agent_peer', 'peer-mcp.mjs']]) {
      const prior = value.mcpServers[name] ?? {};
      const base = codexTemplate.mcpServers?.[name];
      if (!object(base)) fail('Deployed Codex MCP template is incomplete.');
      const server = { ...base, ...prior, command: slash(config.nodePath), args: [slash(path.join(sourceDir, 'bin', script))],
        env_vars: [...new Set([...(base.env_vars ?? []), ...(prior.env_vars ?? [])])],
        env: { ...Object.fromEntries(Object.entries(prior.env ?? {}).filter(([key]) => !ROOT_ENV.test(key))),
          DSH_BRIDGE_CREDENTIAL_FILE: slash(layout.tokenFiles.codex), DSH_BRIDGE_URL: config.bridgeUrl,
          ...(name === 'agent_peer' ? { AGENT_BRIDGE_SELF: 'codex', AGENT_PEER_CONFIG: slash(layout.peerFiles.codex) } : {}) } };
      for (const key of ['type', 'url', 'headers', 'bearer_token_env_var']) delete server[key];
      value.mcpServers[name] = server;
    }
    edit(loadedRecord, value);
    edit(targetRecord, value);
    manifest.mcpServers = './.mcp.json';
    edit(manifestRecord, manifest);
  }
  // Refresh the runtime and skills at the paths the applications already load.
  // Keep installation paths stable; their directory names may retain an older
  // version. Every overwritten/new file participates in the same rollback.
  const assets = ['package.json'];
  for (const folder of ['bin', 'src', 'skills', 'dsh-host']) {
    const pending = [folder];
    while (pending.length) {
      const relative = pending.pop();
      const entries = await readdir(path.join(sourceDir, relative), { withFileTypes: true });
      for (const entry of entries) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile()) assets.push(child);
        else fail('Prepared plugin runtime contains an unsupported file entry.');
      }
    }
  }
  for (const relative of assets) {
    const source = await snapshot(path.join(sourceDir, relative), false);
    if (!source.exists) fail('Prepared plugin runtime is incomplete.');
    for (const dir of new Set([...claudeDirs, codexDir, ...(config.codexPluginDir ? [config.codexPluginDir] : [])])) {
      if (keyPath(dir) === keyPath(sourceDir)) continue;
      const record = await read(path.join(dir, relative));
      if (record.content !== source.content) desired.set(keyPath(record.path), { path: record.path, exists: true, content: source.content });
    }
  }
  let stateDir;
  for (const id of ['claude', 'codex']) {
    const record = await read(layout.peerFiles[id]);
    const peer = parseJson(record);
    if (typeof peer.stateDir !== 'string' || !path.isAbsolute(peer.stateDir)) fail('Peer configuration requires an absolute shared stateDir.');
    if (stateDir && keyPath(stateDir) !== keyPath(peer.stateDir)) fail('Both peer configurations must use the same stateDir.');
    stateDir = peer.stateDir;
    peer.bridge = { ...peer.bridge, url: config.bridgeUrl, credentialFile: slash(layout.tokenFiles[id]) };
    edit(record, peer);
  }
  return { originals: [...originals.values()], changes: [...desired.values()], processRoots: [sourceDir, ...claudeDirs, codexDir, config.codexPluginDir].filter(Boolean),
    locations: { claudeDir, claudeSourceDir: claudeSource?.dir ?? null, codexDir, claudeSettings: settingsRecord.path, codexConfig: codexConfig.path, peerFiles: layout.peerFiles } };
}

export function blockingProcesses(processes, roots = [], ownPid = process.pid) {
  const normalized = roots.map(keyPath);
  const blocked = new Set();
  for (const item of processes) {
    if (item.pid === ownPid) continue;
    const name = item.name ?? '';
    const command = slash(item.commandLine ?? '').toLowerCase();
    if (/^(claude|claude-code|codex|chatgpt)(\.exe)?$/i.test(name)
      || /(?:^|[\s/"'])[^\s/"']*(?:mcp|codex-code-mode-host)[^\s/"']*\.exe(?:[\s"']|$)/i.test(` ${name} `)
      || (/^(node|python[\d.]*|uv|uvx|bun|deno)(\.exe)?$/i.test(name)
        && (/(?:^|[\s/"'])[^\s"']*mcp[^\s"']*|\/bin\/bridge\.mjs/i.test(command) || normalized.some((root) => command.includes(root))))) blocked.add(item.pid);
  }
  let size;
  do {
    size = blocked.size;
    for (const item of processes) if (item.pid !== ownPid && blocked.has(item.parentPid)) blocked.add(item.pid);
  } while (blocked.size !== size);
  return [...blocked];
}

/** Windows registry and process boundary. Values travel on stdin, never argv. */
export function createWindowsAdapter({ env = process.env, spawnImpl = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') fail('Client switching requires Windows.');
  const run = (script, input = {}) => {
    const result = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $request = [Console]::In.ReadToEnd() | ConvertFrom-Json; ${script}`],
      { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: stripBridgeCredentials(env) });
    if (result.error || result.status !== 0) fail('Windows environment/process/ACL operation failed.');
    const output = String(result.stdout ?? '').trim();
    return output ? JSON.parse(output) : undefined;
  };
  return {
    readEnvironment(scope) {
      if (scope === 'Process') {
        const name = Object.keys(env).find((key) => key.toUpperCase() === TOKEN_NAME);
        return { exists: name !== undefined, value: name === undefined ? null : env[name] };
      }
      return run(`$key = if ($request.scope -eq 'User') { [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment') } else { [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') }; $exists = $null -ne $key -and $key.GetValueNames() -contains 'DSH_MCP_TOKEN'; $value = if ($exists) { $key.GetValue('DSH_MCP_TOKEN', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }; @{exists=$exists;value=$value} | ConvertTo-Json -Compress`, { scope });
    },
    writeEnvironment(scope, state) {
      if (scope === 'Process') {
        for (const key of Object.keys(env)) if (key.toUpperCase() === TOKEN_NAME) delete env[key];
        if (state.exists) env[TOKEN_NAME] = state.value;
        return;
      }
      if (scope !== 'User') fail('Only the User environment can be changed.');
      run(`if ($request.exists -and $request.value -eq '') { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $key.SetValue('DSH_MCP_TOKEN', '', [Microsoft.Win32.RegistryValueKind]::String); $key.Dispose() } else { $value = if ($request.exists) { [string]$request.value } else { $null }; [Environment]::SetEnvironmentVariable('DSH_MCP_TOKEN', $value, 'User') }; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class BridgeEnvironmentNotice { [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'; $result = [UIntPtr]::Zero; [void][BridgeEnvironmentNotice]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)`, state);
    },
    listProcesses() {
      const value = run("@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='parentPid';e={$_.ParentProcessId}}, @{n='name';e={$_.Name}}, @{n='commandLine';e={$_.CommandLine}}) | ConvertTo-Json -Compress");
      return Array.isArray(value) ? value : value ? [value] : [];
    },
    restrictBackup(directory) {
      run(`$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $request.directory -AclObject $acl`, { directory });
    },
  };
}

async function restoreFiles(records, write = writeFile) {
  for (const record of [...records].reverse()) {
    if (!record.restore) continue;
    const current = await snapshot(record.path);
    if (current.exists === record.exists && current.content === record.content) continue;
    if (record.exists) await write(record.path, Buffer.from(record.content, 'base64'));
    else await unlink(record.path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** No default adapter: imported tests cannot accidentally mutate the machine. */
export async function switchClients(options, { adapter, log = () => {}, now = () => new Date(), write = writeFile } = {}) {
  if (!adapter) fail('An environment/process/ACL adapter is required.');
  let backupDirectory;
  try {
    const machine = await adapter.readEnvironment('Machine');
    if (machine.exists) fail('Machine-level DSH_MCP_TOKEN exists. Stop and arrange its removal before switching.');
    let plan;
    let backup;
    if (options.rollback) {
      backupDirectory = path.resolve(options.rollback);
      backup = parseJson(await snapshot(path.join(backupDirectory, 'backup.json')));
      if (backup.schemaVersion !== 1 || !Array.isArray(backup.files) || !Array.isArray(backup.processRoots)
        || !['User', 'Process'].every((scope) => typeof backup.environment?.[scope]?.exists === 'boolean'
          && (backup.environment[scope].exists ? typeof backup.environment[scope].value === 'string' : backup.environment[scope].value === null))
        || !backup.files.every((record) => path.isAbsolute(record.path ?? '') && typeof record.restore === 'boolean' && typeof record.exists === 'boolean'
          && (record.exists ? typeof record.content === 'string' : record.content === null))) fail('Invalid client backup.');
      plan = { processRoots: backup.processRoots };
    } else {
      const config = options.config ?? parseJson(await snapshot(options.configPath));
      plan = await planClientSwitch(config, options);
    }
    const processes = blockingProcesses(await adapter.listProcesses(), plan.processRoots);
    if (processes.length) fail('Claude/Codex or MCP processes are still running. Save work and fully quit both applications and their MCP children, then retry.');
    const environment = { User: await adapter.readEnvironment('User'), Process: await adapter.readEnvironment('Process') };
    const dryRun = options.dryRun !== false;
    if (options.rollback) {
      if (dryRun) { log('Dry-run: would restore backed-up client files and User/Process environment state.'); return { dryRun, backupDirectory }; }
      const failures = [];
      for (const record of [...backup.files].reverse()) await restoreFiles([record], write).catch(() => failures.push('file'));
      for (const scope of ['User', 'Process']) if (JSON.stringify(environment[scope]) !== JSON.stringify(backup.environment[scope])) {
        await Promise.resolve().then(() => adapter.writeEnvironment(scope, backup.environment[scope])).catch(() => failures.push('environment'));
      }
      if (failures.length) fail('Client rollback was incomplete. Resolve file/environment access and rerun --rollback with the retained backup.');
      log('Client rollback completed. Restart both applications from fresh launch environments.');
      return { dryRun, backupDirectory, rolledBack: true };
    }
    log(`Located Claude cache: ${plan.locations.claudeDir}`);
    if (plan.locations.claudeSourceDir) log(`Located Claude marketplace source: ${plan.locations.claudeSourceDir}`);
    log(`Located Codex cache: ${plan.locations.codexDir}`);
    for (const change of plan.changes) log(`${dryRun ? 'Would update' : 'Planned update'}: ${change.path}`);
    const envChanges = ['User', 'Process'].filter((scope) => environment[scope].exists);
    if (dryRun) {
      log(`Dry-run: ${plan.changes.length} file changes; ${envChanges.length} environment entries to clear. No changes made.`);
      return { dryRun, changedFiles: plan.changes.map((item) => item.path), locations: plan.locations };
    }
    if (plan.changes.length === 0 && envChanges.length === 0) {
      log('Client configuration already matches R8; shared token variables are absent.');
      return { dryRun, changedFiles: [], backupDirectory: null, locations: plan.locations };
    }
    const backupRoot = path.resolve(options.backupRoot ?? DEFAULT_BACKUP_ROOT);
    await mkdir(backupRoot, { recursive: true });
    const stamp = now().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    for (let suffix = 0; ; suffix += 1) {
      backupDirectory = path.join(backupRoot, `${stamp}${suffix ? `-${suffix}` : ''}`);
      const made = await mkdir(backupDirectory, { mode: 0o700 }).then(() => true, (error) => { if (error.code === 'EEXIST') return false; throw error; });
      if (made) break;
    }
    // Protect the directory before any token-bearing backup bytes are created.
    await adapter.restrictBackup(backupDirectory);
    backup = { schemaVersion: 1, files: plan.originals, environment, processRoots: plan.processRoots };
    await writeFile(path.join(backupDirectory, 'backup.json'), jsonText(backup), { flag: 'wx', mode: 0o600 });
    const attemptedFiles = [];
    const attemptedEnvironment = [];
    try {
      for (const change of plan.changes) {
        attemptedFiles.push(plan.originals.find((record) => keyPath(record.path) === keyPath(change.path)));
        await mkdir(path.dirname(change.path), { recursive: true });
        await write(change.path, Buffer.from(change.content, 'base64'));
      }
      for (const scope of envChanges) {
        attemptedEnvironment.push(scope);
        await adapter.writeEnvironment(scope, { exists: false, value: null });
      }
    } catch {
      const failures = [];
      // Restore every attempted mutation even if one restoration fails.
      for (const record of attemptedFiles.reverse()) await restoreFiles([record], write).catch(() => failures.push('file'));
      for (const scope of attemptedEnvironment.reverse()) await Promise.resolve().then(() => adapter.writeEnvironment(scope, environment[scope])).catch(() => failures.push('environment'));
      fail(failures.length ? 'Client switch failed; automatic rollback was incomplete. Use --rollback with the retained backup after resolving the failure.' : 'Client switch failed; all attempted changes were rolled back. The backup was retained.');
    }
    log(`Backup retained: ${backupDirectory}`);
    log('Client switch completed. Restart both applications from ordinary entries and run the real-app identity/delegation smoke checks.');
    return { dryRun, backupDirectory, changedFiles: plan.changes.map((item) => item.path), locations: plan.locations };
  } catch (error) {
    // Neither platform errors nor parser snippets can expose an inherited token.
    const safe = new SwitchError(error instanceof SwitchError ? error.message : 'Client switch failed; check configuration paths and Windows access.');
    safe.backupDirectory = backupDirectory;
    throw safe;
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  try {
    const options = parseArgs(argv);
    if (options.help) { stdout(`${USAGE}\n`); return 0; }
    await switchClients(options, { adapter: io.adapter ?? createWindowsAdapter(), log: (line) => stdout(`${line}\n`) });
    return 0;
  } catch (error) {
    stderr(`${error instanceof SwitchError ? error.message : 'Client switch failed.'}\n`);
    if (error.backupDirectory) stderr(`Retained backup: ${error.backupDirectory}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
