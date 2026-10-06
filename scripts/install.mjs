#!/usr/bin/env node
/**
 * dsh-codex-bridge-v1 — bounded installer for a DSH profile plugin package.
 *
 * What it does, and nothing else:
 *   1. scans an explicit source root (read-only),
 *   2. validates it (package.json, host entry syntax, symlink/size bounds),
 *   3. stages a filtered copy (excluding .git/.runtime/.worktrees/evidence/raw),
 *   4. copies the staged package into <profile>/node_modules/@local/dsh-codex-bridge-v1,
 *   5. appends one uniquely owned `insert:` row (id `dsh-codex-bridge-v1`) to the
 *      profile's cordis.patch.yml,
 *   6. persists an install manifest recording before/after SHA256 and backup
 *      mappings under <profile>/node_modules/@local/.dsh-codex-bridge-v1/.
 *
 * Boundaries enforced here:
 *   - every write stays inside the explicit target profile directory;
 *   - Codex/user global configuration (~/.codex, ~/.agents, home, filesystem
 *     roots) is refused, and no environment variable, token, agent or Codex
 *     config is ever read or modified;
 *   - `--dry-run`/`--plan` performs the whole plan with zero writes;
 *   - no recursive arbitrary delete is ever issued (files are unlinked
 *     individually, directories are rmdir'd only when empty);
 *   - Node 24 built-ins only, no third-party runtime dependency.
 *
 * Usage:
 *   node scripts/install.mjs --profile <dsh-profile-dir> --source <package-source-root>
 *                           [--dry-run] [--json] [--require-host-entry]
 *
 * Domain failures throw Error with a stable `.code`.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

/** Module specifier the profile loader resolves, and its install path. */
export const PACKAGE_NAME = '@local/dsh-codex-bridge-v1';
/** Directory name under <profile>/node_modules/@local. */
export const PACKAGE_DIR_NAME = 'dsh-codex-bridge-v1';
/** Loader row id owned by this installer (unique insert target). */
export const ROW_ID = 'dsh-codex-bridge-v1';
/** Host-side plugin entry; written by the coordinator, validated here. */
export const HOST_ENTRY = 'dsh-host/index.cjs';
/** Installer state directory (manifest + backups), relative to the profile. */
export const STATE_DIR_REL = 'node_modules/@local/.dsh-codex-bridge-v1';
export const MANIFEST_FILE_NAME = 'install-manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const TOOL_VERSION = '1.0.0';

export const MARKER_START = `# --- ${ROW_ID} managed block: start ---`;
export const MARKER_END = `# --- ${ROW_ID} managed block: end ---`;

/** Directory names excluded anywhere in the copied tree. */
export const EXCLUDED_SEGMENTS = Object.freeze(['.git', '.runtime', '.worktrees']);
/** Relative path prefixes excluded from the copied tree. */
export const EXCLUDED_SUBPATHS = Object.freeze(['evidence/raw']);
/** Bounded copy limits: fail closed instead of packaging an unbounded tree. */
export const MAX_FILES = 20000;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CONFLICT = 2;

const TOOL = 'dsh-codex-bridge-installer';
const POSIX = (p) => p.split(path.sep).join('/');

/** Throwable domain failure carrying a stable machine code. */
export class InstallerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new InstallerError(code, message, details);
};

const hashBytes = (buf) => createHash('sha256').update(buf).digest('hex');
export const hashText = (text) => hashBytes(Buffer.from(text, 'utf8'));

export async function pathState(abs) {
  try {
    const st = await fsp.lstat(abs);
    return { exists: true, dir: st.isDirectory(), file: st.isFile(), link: st.isSymbolicLink() };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, dir: false, file: false, link: false };
    throw err;
  }
}

export async function fileSha256(abs) {
  return hashBytes(await fsp.readFile(abs));
}

/** True when `child` is strictly inside `parent` (both absolute, resolved). */
export function isInside(parentAbs, childAbs) {
  const rel = path.relative(parentAbs, childAbs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve a path to its real location even when it (or an ancestor) does not
 * exist yet: the deepest existing ancestor is realpath'd and the remaining
 * segments are re-appended.
 */
export async function resolveRealPath(abs) {
  let current = path.resolve(abs);
  const tail = [];
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return tail.length === 0 ? current : path.join(current, ...tail.reverse());
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Refuse any write/delete/read target that is not provably inside `rootAbs`:
 * lexical containment first, then every existing path component at or below the
 * root is lstat-checked and must not be a symlink/junction, then the real
 * (symlink-resolved) target must still be inside the real root. A junction in
 * the profile that points outside the profile therefore cannot be used as a
 * target or as an ancestor of one.
 */
export async function assertSafeWriteTarget(rootAbs, targetAbs, options = {}) {
  const code = options.code ?? 'E_WRITE_ESCAPE';
  const rootResolved = path.resolve(rootAbs);
  const targetResolved = path.resolve(targetAbs);
  if (targetResolved !== rootResolved && !isInside(rootResolved, targetResolved)) {
    fail(code, `refusing to touch a path outside the target profile: ${targetResolved}`, { root: rootResolved });
  }
  const rel = path.relative(rootResolved, targetResolved);
  const parts = rel === '' ? [] : rel.split(path.sep);
  let current = rootResolved;
  for (const part of parts) {
    current = path.join(current, part);
    const state = await pathState(current);
    if (!state.exists) break;
    if (state.link) {
      fail('E_SYMLINK_TARGET', `refusing to use a symlinked/junction path component: ${current}`, { code });
    }
  }
  const rootReal = await resolveRealPath(rootResolved);
  const targetReal = await resolveRealPath(targetResolved);
  if (targetReal !== rootReal && !isInside(rootReal, targetReal)) {
    fail(code, `resolved target escapes the target profile: ${targetReal}`, { rootReal });
  }
  return targetReal;
}

/** Exclusion rule for one POSIX-relative path, or null when included. */
export function exclusionFor(relPosix) {
  const segments = relPosix.split('/');
  for (const segment of segments) {
    if (EXCLUDED_SEGMENTS.includes(segment)) return `segment:${segment}`;
  }
  for (const prefix of EXCLUDED_SUBPATHS) {
    if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) return `path:${prefix}`;
    // The same subpath nested deeper (e.g. a/evidence/raw/b) is excluded too.
    if (relPosix.includes(`/${prefix}/`) || relPosix.endsWith(`/${prefix}`)) return `path:${prefix}`;
  }
  return null;
}

/**
 * Reject targets that would mutate Codex/user-global configuration rather than
 * an explicit DSH profile. Read-only check; no filesystem mutation.
 */
export function assertSafeProfileDir(profileDir, env = process.env, home = os.homedir()) {
  const resolved = path.resolve(profileDir);
  if (resolved === path.parse(resolved).root) {
    fail('E_UNSAFE_PROFILE', `refusing to use a filesystem root as target profile: ${resolved}`);
  }
  if (path.resolve(home) === resolved) {
    fail('E_UNSAFE_PROFILE', `refusing to use the home directory as target profile: ${resolved}`);
  }
  const forbidden = [];
  if (home) {
    forbidden.push(path.join(home, '.codex'), path.join(home, '.agents'));
  }
  for (const key of ['CODEX_HOME', 'APPDATA']) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim() !== '') forbidden.push(path.resolve(value));
  }
  for (const root of forbidden) {
    if (resolved === root || isInside(root, resolved)) {
      fail(
        'E_UNSAFE_PROFILE',
        `refusing to modify Codex/user-global configuration path as a DSH profile: ${resolved}`,
        { guardedRoot: root },
      );
    }
  }
  return resolved;
}

/** Recursively list a source tree, applying exclusions and refusing symlinks. */
export async function scanSourceTree(sourceDir) {
  const files = [];
  const dirs = [];
  const excluded = [];
  let totalBytes = 0;

  async function walk(absDir, relDir) {
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = path.join(absDir, entry.name);
      const rule = exclusionFor(rel);
      if (rule) {
        excluded.push({ path: rel, rule });
        continue;
      }
      if (entry.isSymbolicLink()) {
        fail('E_SYMLINK_UNSUPPORTED', `refusing to package symlinked entry: ${rel}`);
      }
      if (entry.isDirectory()) {
        dirs.push(rel);
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) {
        excluded.push({ path: rel, rule: 'special-file' });
        continue;
      }
      const st = await fsp.stat(abs);
      totalBytes += st.size;
      files.push({ path: rel, abs, bytes: st.size });
      if (files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
        fail('E_SOURCE_TOO_LARGE', `source tree exceeds packaging bounds (files<=${MAX_FILES}, bytes<=${MAX_TOTAL_BYTES})`);
      }
    }
  }

  await walk(sourceDir, '');
  for (const file of files) {
    file.sha256 = await fileSha256(file.abs);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  dirs.sort();
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, dirs, excluded, totalBytes };
}

function isEsmFile(relPosix, packageType) {
  if (relPosix.endsWith('.mjs')) return true;
  if (relPosix.endsWith('.cjs')) return false;
  return packageType === 'module';
}

/**
 * Parse-only syntax validation. CJS/script sources are compiled in-process with
 * node:vm (never executed); ESM sources fall back to `node --check` with
 * captured-status stdio, and degrade to `skipped` when the host cannot spawn.
 */
export function checkSyntax(absPath, text, esm) {
  if (!esm) {
    try {
      new vm.Script(text, { filename: absPath });
      return { file: absPath, status: 'ok', via: 'vm.Script' };
    } catch (err) {
      return { file: absPath, status: 'failed', via: 'vm.Script', message: String(err?.message ?? err) };
    }
  }
  const result = spawnSync(process.execPath, ['--check', absPath], { stdio: 'ignore', timeout: 15000 });
  if (result.error) {
    return { file: absPath, status: 'skipped', via: 'node --check', message: String(result.error.code ?? result.error.message) };
  }
  if (result.status === 0) return { file: absPath, status: 'ok', via: 'node --check' };
  return { file: absPath, status: 'failed', via: 'node --check', message: `exit ${result.status}` };
}

const warn = (list, code, message, extra = {}) => {
  list.push({ code, message, ...extra });
};

function desiredPatchBlock(hostConfig) {
  if(hostConfig!==undefined&&(hostConfig===null||typeof hostConfig!=='object'||Array.isArray(hostConfig)))fail('E_ARGS','hostConfig must be a JSON object');
  const config=hostConfig===undefined?'':`      config: ${JSON.stringify(hostConfig)}\n`;
  return `${MARKER_START}\n- insert:\n    - id: ${ROW_ID}\n      name: '${PACKAGE_NAME}'\n${config}${MARKER_END}\n`;
}

/** Read and shape-check the profile's cordis.patch.yml. Read-only. */
async function readPatchFile(patchPath) {
  const state = await pathState(patchPath);
  if (!state.exists) return { path: patchPath, exists: false, text: null, sha256: null, bytes: 0 };
  if (!state.file) fail('E_PATCH_NOT_FILE', `cordis.patch.yml is not a regular file: ${patchPath}`);
  const text = await fsp.readFile(patchPath, 'utf8');
  return { path: patchPath, exists: true, text, sha256: hashText(text), bytes: Buffer.byteLength(text) };
}

/** Classify the patch file's ownership state without mutating it. */
export function patchAppendPrefix(text) {
  const active = text.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  let prefix = text;
  if (active.length === 1 && /^\s*\[\s*\]\s*(?:#.*)?$/.test(active[0])) {
    prefix = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(#[^\r\n]*)?(\r?\n|$)/m, (_match, comment, newline) => (comment ?? '') + newline);
  } else if (active.length && !/^\s*-\s+/.test(active[0])) {
    fail('E_PATCH_SHAPE', 'cordis.patch.yml must be a block sequence or an empty [] sequence');
  }
  return prefix === '' || prefix.endsWith('\n') ? prefix : `${prefix}\n`;
}

export function analyzePatch(patch, block = desiredPatchBlock()) {
  const analysis = { action: null, owned: false, block, blockSha256: hashText(block), reason: null };
  if (!patch.exists) {
    analysis.action = 'appended';
    analysis.owned = true;
    analysis.reason = 'patch file absent; it will be created with only the owned row';
    return analysis;
  }
  const text = patch.text;
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END);
  if (start !== -1 || end !== -1) {
    if (start === -1 || end === -1 || end < start) {
      analysis.action = 'conflict';
      analysis.reason = `owned marker block is not intact in ${patch.path}`;
      return analysis;
    }
    const found = text.slice(start, end + MARKER_END.length + 1);
    if (found !== block) {
      analysis.action = 'conflict';
      analysis.reason = 'owned marker block content differs from the expected row; reconcile manually';
      return analysis;
    }
    analysis.action = 'owned-present';
    analysis.owned = true;
    analysis.reason = 'owned insert row already present';
    return analysis;
  }
  const idPattern = new RegExp(`(^|\\n)\\s*[-{]?\\s*id:\\s*['"]?${ROW_ID}['"]?\\s*$`, 'm');
  if (idPattern.test(text)) {
    analysis.action = 'foreign-present';
    analysis.owned = false;
    analysis.reason = `row id ${ROW_ID} exists without the owned marker block; left untouched`;
    return analysis;
  }
  analysis.action = 'appended';
  analysis.owned = true;
  patchAppendPrefix(text);
  if (text.includes(PACKAGE_NAME)) {
    analysis.reason = `existing inert reference to ${PACKAGE_NAME} without id (loader skips it); appending the owned insert row`;
  } else {
    analysis.reason = 'appending the owned insert row';
  }
  return analysis;
}

export async function readManifest(stateDir) {
  const manifestPath = path.join(stateDir, MANIFEST_FILE_NAME);
  const state = await pathState(manifestPath);
  if (!state.exists) return { path: manifestPath, exists: false, manifest: null };
  if (!state.file) fail('E_MANIFEST_INVALID', `install manifest path is not a regular file: ${manifestPath}`);
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (err) {
    fail('E_MANIFEST_INVALID', `install manifest is not valid JSON: ${manifestPath}`, { cause: String(err?.message ?? err) });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('E_MANIFEST_INVALID', `install manifest is not a JSON object: ${manifestPath}`);
  }
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail('E_MANIFEST_INVALID', `unsupported install manifest schemaVersion: ${String(parsed.schemaVersion)}`, {
      expected: MANIFEST_SCHEMA_VERSION,
    });
  }
  if (!Array.isArray(parsed.files)) {
    fail('E_MANIFEST_INVALID', 'install manifest lacks a files array');
  }
  return { path: manifestPath, exists: true, manifest: parsed };
}

export function validateManifestShape(manifest, manifestPath) {
  const seen = new Set();
  for (const record of manifest.files) {
    if (record === null || typeof record !== 'object') fail('E_MANIFEST_INVALID', `non-object file record in ${manifestPath}`);
    const rel = record.path;
    if (typeof rel !== 'string' || rel.trim() === '' || path.isAbsolute(rel) || rel.split('/').includes('..')) {
      fail('E_MANIFEST_INVALID', `unsafe file path in install manifest: ${String(rel)}`);
    }
    if (seen.has(rel)) fail('E_MANIFEST_INVALID', `duplicate file record in install manifest: ${rel}`);
    seen.add(rel);
    if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
      fail('E_MANIFEST_INVALID', `missing/!sha256 for manifest record: ${rel}`);
    }
  }
  return seen;
}

/** Snapshot the currently installed package against a prior manifest. */
export async function inventoryPackage(packageDir, priorFiles) {
  const state = await pathState(packageDir);
  const inventory = { exists: state.exists, files: new Map(), extra: [] };
  if (!state.exists) return inventory;
  if (!state.dir) fail('E_PACKAGE_PATH_NOT_DIR', `package path exists and is not a directory: ${packageDir}`);
  const known = new Set(priorFiles.map((record) => record.path.split('/')[0]));
  async function walk(absDir, relDir) {
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        inventory.files.set(rel, { abs, sha256: await fileSha256(abs) });
      }
    }
  }
  await walk(packageDir, '');
  for (const rel of inventory.files.keys()) {
    if (!priorFiles.some((record) => record.path === rel)) inventory.extra.push(rel);
  }
  return inventory;
}

function packageJsonMainResolution(pkg, relPath) {
  if (relPath === undefined || relPath === null) return { ok: true };
  if (typeof relPath !== 'string' || relPath.trim() === '') return { ok: false, code: 'E_MAIN_INVALID', message: 'package.json main must be a nonblank string' };
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    return { ok: false, code: 'E_MAIN_INVALID', message: `package.json main must stay inside the package: ${relPath}` };
  }
  return { ok: true, rel: POSIX(relPath) };
}

/**
 * Build a read-only install plan for `{profileDir, sourceDir}`.
 * Performs every validation and records planned writes; writes nothing.
 */
export async function planInstall(options = {}) {
  const { profileDir, sourceDir, requireHostEntry = false, now = Date.now(), env = process.env, home = os.homedir() } = options;
  if (typeof profileDir !== 'string' || profileDir.trim() === '') fail('E_ARGS', 'profileDir is required');
  if (typeof sourceDir !== 'string' || sourceDir.trim() === '') fail('E_ARGS', 'sourceDir is required');

  const warnings = [];
  const profileAbs = assertSafeProfileDir(profileDir, env, home);
  const sourceAbs = path.resolve(sourceDir);

  const profileState = await pathState(profileAbs);
  if (!profileState.exists || !profileState.dir) {
    fail('E_PROFILE_MISSING', `target DSH profile directory not found: ${profileAbs}`);
  }
  const sourceState = await pathState(sourceAbs);
  if (!sourceState.exists || !sourceState.dir) {
    fail('E_SOURCE_MISSING', `source root directory not found: ${sourceAbs}`);
  }
  if (profileAbs === sourceAbs || isInside(sourceAbs, profileAbs) || isInside(profileAbs, sourceAbs)) {
    fail('E_PATH_OVERLAP', `source root and target profile must be disjoint: source=${sourceAbs} profile=${profileAbs}`);
  }

  const markers = [];
  for (const marker of ['cordis.patch.yml', 'package.json', 'node_modules']) {
    if ((await pathState(path.join(profileAbs, marker))).exists) markers.push(marker);
  }
  if (markers.length === 0) {
    warn(warnings, 'no_profile_markers', `target profile has no cordis.patch.yml/package.json/node_modules: ${profileAbs}`);
  }

  const tree = await scanSourceTree(sourceAbs);

  const packageJsonPath = path.join(sourceAbs, 'package.json');
  const packageJsonState = await pathState(packageJsonPath);
  if (!packageJsonState.exists || !packageJsonState.file) {
    fail('E_SOURCE_PACKAGE_JSON', `source root must contain package.json: ${packageJsonPath}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(await fsp.readFile(packageJsonPath, 'utf8'));
  } catch (err) {
    fail('E_SOURCE_PACKAGE_JSON', `source package.json is not valid JSON: ${packageJsonPath}`, { cause: String(err?.message ?? err) });
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    fail('E_SOURCE_PACKAGE_JSON', `source package.json must be a JSON object: ${packageJsonPath}`);
  }
  const packageType = typeof pkg.type === 'string' ? pkg.type : 'commonjs';
  if (typeof pkg.name === 'string' && pkg.name.trim() !== '' && pkg.name !== PACKAGE_DIR_NAME && pkg.name !== PACKAGE_NAME) {
    warn(warnings, 'package_name_mismatch', `source package.json name is "${pkg.name}", expected "${PACKAGE_NAME}" (kept verbatim)`);
  }
  if (typeof pkg.main !== 'string' || pkg.main.trim() === '') {
    warn(warnings, 'package_main_missing', `source package.json has no "main"; profile loader must resolve ${HOST_ENTRY} another way`);
  }
  const mainResolution = packageJsonMainResolution(pkg, typeof pkg.main === 'string' ? pkg.main : undefined);
  if (!mainResolution.ok) fail(mainResolution.code, mainResolution.message);

  const fileByRel = new Map(tree.files.map((file) => [file.path, file]));
  const syntax = [];
  if (mainResolution.rel && !fileByRel.has(mainResolution.rel)) {
    warn(warnings, 'main_unresolved', `package.json main "${mainResolution.rel}" is not present in the source tree`);
  }

  const hostEntryAbs = path.join(sourceAbs, HOST_ENTRY);
  const hostEntryState = await pathState(hostEntryAbs);
  let hostEntry = 'missing';
  if (hostEntryState.exists && hostEntryState.file) {
    hostEntry = 'present';
    if (mainResolution.rel && mainResolution.rel !== HOST_ENTRY) {
      warn(warnings, 'main_not_host_entry', `package.json main is "${mainResolution.rel}", not ${HOST_ENTRY}`);
    }
    const text = await fsp.readFile(hostEntryAbs, 'utf8');
    const syntaxResult = checkSyntax(hostEntryAbs, text, isEsmFile(HOST_ENTRY, packageType));
    syntax.push(syntaxResult);
    if (syntaxResult.status === 'failed') {
      fail('E_HOST_ENTRY_SYNTAX', `host entry fails syntax validation: ${HOST_ENTRY}`, { message: syntaxResult.message });
    }
  } else if (hostEntryState.exists) {
    fail('E_HOST_ENTRY_NOT_FILE', `host entry path is not a regular file: ${hostEntryAbs}`);
  } else if (requireHostEntry) {
    fail('E_HOST_ENTRY_MISSING', `required host entry is missing from the source: ${HOST_ENTRY}`);
  } else {
    warn(warnings, 'host_entry_missing', `host entry ${HOST_ENTRY} not present yet (the coordinator writes it); use --require-host-entry to fail hard`);
  }

  const packageDir = path.join(profileAbs, 'node_modules', '@local', PACKAGE_DIR_NAME);
  const stateDir = path.join(profileAbs, ...STATE_DIR_REL.split('/'));
  const manifestPath = path.join(stateDir, MANIFEST_FILE_NAME);
  const patchPath = path.join(profileAbs, 'cordis.patch.yml');

  // A profile that is itself a link is the operator's explicit choice, but its
  // resolved location must still not be global configuration, and every path we
  // will read, write or delete must be provably inside the profile with no
  // symlink/junction component anywhere below the profile root.
  const profileReal = await resolveRealPath(profileAbs);
  assertSafeProfileDir(profileReal, env, home);
  await assertSafeWriteTarget(profileAbs, packageDir);
  await assertSafeWriteTarget(profileAbs, stateDir);
  await assertSafeWriteTarget(profileAbs, manifestPath);
  await assertSafeWriteTarget(profileAbs, patchPath);

  const prior = await readManifest(stateDir);
  if (prior.exists) validateManifestShape(prior.manifest, prior.path);
  const priorFiles = prior.exists ? prior.manifest.files : [];
  const priorByRel = new Map(priorFiles.map((record) => [record.path, record]));

  const inventory = await inventoryPackage(packageDir, priorFiles);
  const steps = [];
  const conflicts = [];

  for (const file of tree.files) {
    const targetAbs = path.join(packageDir, ...file.path.split('/'));
    const targetState = await pathState(targetAbs);
    if (targetState.exists && !targetState.file) {
      conflicts.push({
        code: 'E_TARGET_NOT_FILE',
        path: file.path,
        message: 'a non-file entry already occupies this package path; refusing to replace it',
      });
      continue;
    }
    const current = inventory.files.get(file.path);
    const priorRecord = priorByRel.get(file.path);
    if (!current) {
      steps.push({
        rel: file.path,
        action: 'create',
        sourceAbs: file.abs,
        sourceSha256: file.sha256,
        targetAbs,
        targetSha256Before: null,
        previous: { existed: false, sha256: null, backup: null, adopted: false },
        backupRel: null,
      });
      continue;
    }
    if (priorRecord) {
      if (current.sha256 !== priorRecord.sha256) {
        conflicts.push({
          code: 'E_LOCAL_MODIFIED',
          path: file.path,
          message: 'installed file was modified locally after this installer wrote it; reconcile before reinstalling',
        });
        continue;
      }
      steps.push({
        rel: file.path,
        action: current.sha256 === file.sha256 ? 'unchanged' : 'replace',
        sourceAbs: file.abs,
        sourceSha256: file.sha256,
        targetAbs,
        targetSha256Before: current.sha256,
        previous: priorRecord.previous ?? { existed: false, sha256: null, backup: null, adopted: false },
        backupRel: null,
      });
      continue;
    }
    // Present in the package dir but unknown to any manifest: only our own
    // package namespace is touched, the previous bytes are backed up first, and
    // uninstall restores them. A byte-identical file is adopted untouched.
    if (current.sha256 === file.sha256) {
      steps.push({
        rel: file.path,
        action: 'adopt',
        sourceAbs: file.abs,
        sourceSha256: file.sha256,
        targetAbs,
        targetSha256Before: current.sha256,
        previous: { existed: true, sha256: current.sha256, backup: null, adopted: true },
        backupRel: null,
      });
      warn(warnings, 'adopted_foreign_file', `file existed with identical content before install and is preserved on uninstall: ${file.path}`);
    } else {
      steps.push({
        rel: file.path,
        action: 'backup-replace',
        sourceAbs: file.abs,
        sourceSha256: file.sha256,
        targetAbs,
        targetSha256Before: current.sha256,
        previous: { existed: true, sha256: current.sha256, backup: null, adopted: false },
        backupRel: null,
      });
      warn(warnings, 'replaced_preexisting_file', `pre-existing package file was backed up before replacement: ${file.path}`);
    }
  }

  const removals = [];
  for (const record of priorFiles) {
    if (fileByRel.has(record.path)) continue;
    const current = inventory.files.get(record.path);
    if (!current) continue;
    if (current.sha256 !== record.sha256) {
      conflicts.push({
        code: 'E_LOCAL_MODIFIED',
        path: record.path,
        message: 'stale installed file was modified locally; refusing to remove or restore it',
      });
      continue;
    }
    removals.push({
      rel: record.path,
      targetAbs: path.join(packageDir, ...record.path.split('/')),
      targetSha256Before: current.sha256,
      previous: record.previous ?? { existed: false, sha256: null, backup: null, adopted: false },
      backupRel: null,
    });
  }
  for (const rel of inventory.extra) {
    if (removals.some((removal) => removal.rel === rel)) continue;
    warn(warnings, 'preserved_foreign_file', `file in the package directory is not owned by this installer and is never deleted: ${rel}`);
  }

  const existingDirs = new Set();
  async function collectExistingDirs(absDir, relDir) {
    const state = await pathState(absDir);
    if (!state.exists || !state.dir) return;
    if (relDir !== '') existingDirs.add(relDir);
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await collectExistingDirs(path.join(absDir, entry.name), relDir === '' ? entry.name : `${relDir}/${entry.name}`);
    }
  }
  await collectExistingDirs(path.join(profileAbs, 'node_modules'), 'node_modules');
  const createdDirs = [];
  for (const rel of [...tree.dirs].sort()) {
    const profileRel = POSIX(path.join('node_modules', '@local', PACKAGE_DIR_NAME, rel));
    if (!existingDirs.has(profileRel)) createdDirs.push(profileRel);
  }
  for (const rel of ['node_modules', 'node_modules/@local', POSIX(path.relative(profileAbs, packageDir))]) {
    if (!existingDirs.has(rel) && !createdDirs.includes(rel)) createdDirs.push(rel);
  }
  createdDirs.sort();

  const patch = await readPatchFile(patchPath);
  const patchAnalysis = analyzePatch(patch,desiredPatchBlock(options.hostConfig));
  const patchPlan = {
    path: patch.path,
    action: patchAnalysis.action,
    owned: patchAnalysis.owned,
    reason: patchAnalysis.reason,
    block: patchAnalysis.block,
    blockSha256: patchAnalysis.blockSha256,
    baseline: patchAnalysis.action === 'owned-present' && prior.manifest?.patch?.baseline
      ? prior.manifest.patch.baseline
      : patch.exists
      ? { existed: true, sha256: patch.sha256, bytes: patch.bytes, backup: null }
      : { existed: false, sha256: null, bytes: 0, backup: null },
    writeRequired: patchAnalysis.action === 'appended',
  };
  if (patchAnalysis.action === 'conflict') {
    conflicts.push({ code: 'E_PATCH_CONFLICT', path: patch.path, message: patchAnalysis.reason });
    patchPlan.action = 'conflict';
    patchPlan.owned = false;
  }
  if (patchAnalysis.action === 'foreign-present') {
    warn(warnings, 'patch_row_foreign', patchAnalysis.reason);
  }

  const sourceDigest = hashText(tree.files.map((file) => `${file.path}:${file.sha256}`).join('\n'));
  const plan = {
    ok: conflicts.length === 0,
    action: 'install',
    dryRun: true,
    code: conflicts.length === 0 ? null : conflicts[0].code,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    now,
    profileDir: profileAbs,
    profileReal,
    sourceDir: sourceAbs,
    packageDir,
    stateDir,
    manifestPath,
    packageName: PACKAGE_NAME,
    rowId: ROW_ID,
    hostEntry,
    validation: {
      markers,
      syntax,
      packageJson: {
        name: typeof pkg.name === 'string' ? pkg.name : null,
        main: mainResolution.rel ?? null,
        type: packageType,
      },
    },
    sourceDigest,
    files: tree.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    steps,
    removals,
    createdDirs,
    patch: patchPlan,
    excluded: tree.excluded,
    exclusionRules: [...EXCLUDED_SEGMENTS.map((s) => `segment:${s}`), ...EXCLUDED_SUBPATHS.map((s) => `path:${s}`)],
    totalBytes: tree.totalBytes,
    warnings,
    conflicts,
    dryRunNotes: 'plan only: no file, directory, or configuration was written',
  };
  return plan;
}

/** Unlink a single file; ENOENT is a no-op. Never recursive. */
export async function unlinkFile(abs) {
  try {
    await fsp.unlink(abs);
    return 'removed';
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'absent';
    throw err;
  }
}

/** rmdir only when empty; a non-empty directory is reported, never deleted. */
export async function rmdirIfEmpty(abs) {
  try {
    await fsp.rmdir(abs);
    return 'removed';
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'absent';
    if (err && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EBUSY')) return 'not-empty';
    throw err;
  }
}

/**
 * Delete an owned tree without any recursive filesystem API: unlink files,
 * then rmdir directories deepest-first, stopping at anything foreign.
 */
export async function removeOwnedTree(dirAbs, guardRootAbs) {
  if (!isInside(guardRootAbs, dirAbs)) {
    fail('E_UNSAFE_REMOVE', `refusing to clean a path outside its guard root: ${dirAbs}`);
  }
  const report = { removed: [], preserved: [] };
  async function walk(absDir) {
    const entries = await fsp.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isSymbolicLink()) {
        // Never follow or delete a link/junction during owned cleanup.
        report.preserved.push(abs);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs);
        const outcome = await rmdirIfEmpty(abs);
        (outcome === 'removed' ? report.removed : report.preserved).push(abs);
      } else {
        const outcome = await unlinkFile(abs);
        if (outcome === 'removed') report.removed.push(abs);
      }
    }
  }
  await walk(dirAbs);
  const outcome = await rmdirIfEmpty(dirAbs);
  (outcome === 'removed' ? report.removed : report.preserved).push(dirAbs);
  return report;
}

async function copyFileInto(sourceAbs, targetAbs) {
  await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
  await fsp.copyFile(sourceAbs, targetAbs);
}

export async function writeFileAtomic(abs, contents) {
  const tmp = `${abs}.tmp-${randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, abs);
}

/**
 * Execute a previously computed plan. Writes only inside the plan's profile.
 * On failure, best-effort rolls back every write made by this call.
 */
export async function applyInstall(plan) {
  if (!plan || plan.action !== 'install') fail('E_ARGS', 'applyInstall requires a plan from planInstall');
  if (!plan.ok) fail(plan.code ?? 'E_PLAN_CONFLICT', 'refusing to apply a plan with unresolved conflicts', { conflicts: plan.conflicts });
  const profileAbs = path.resolve(plan.profileDir);
  const warnings = [...(plan.warnings ?? [])];
  const writes = [];
  const backups = [];
  const undone = [];
  const stagingDir = path.join(plan.stateDir, `staging-${randomBytes(6).toString('hex')}`);
  const rollback = { files: [], backups: [], dirs: [] };

  const assertWritable = async (abs) => {
    await assertSafeWriteTarget(profileAbs, abs);
  };

  try {
    await fsp.mkdir(plan.stateDir, { recursive: true });

    // 1. Stage a filtered copy and verify byte-for-byte against the plan.
    for (const step of [...plan.steps, ...plan.removals]) {
      const stagedAbs = path.join(stagingDir, ...step.rel.split('/'));
      await assertWritable(stagedAbs);
      await copyFileInto(step.sourceAbs ?? step.targetAbs, stagedAbs);
    }
    for (const step of plan.steps) {
      const stagedAbs = path.join(stagingDir, ...step.rel.split('/'));
      const stagedSha = await fileSha256(stagedAbs);
      if (stagedSha !== step.sourceSha256) {
        fail('E_STAGING_MISMATCH', `source changed while staging: ${step.rel}`, {
          expected: step.sourceSha256,
          staged: stagedSha,
        });
      }
    }

    // 2. Validate the staged host entry (parse-only, never executed).
    if (plan.hostEntry === 'present') {
      const stagedHost = path.join(stagingDir, ...HOST_ENTRY.split('/'));
      const exists = await pathState(stagedHost);
      if (!exists.exists || !exists.file) {
        fail('E_HOST_ENTRY_MISSING', `staged host entry disappeared: ${HOST_ENTRY}`);
      }
      const text = await fsp.readFile(stagedHost, 'utf8');
      const esm = isEsmFile(HOST_ENTRY, plan.validation?.packageJson?.type === 'module' ? 'module' : 'commonjs');
      const syntaxResult = checkSyntax(stagedHost, text, esm);
      plan.validation.syntax.push({ ...syntaxResult, stage: 'staged' });
      if (syntaxResult.status === 'failed') {
        fail('E_HOST_ENTRY_SYNTAX', `staged host entry fails syntax validation: ${HOST_ENTRY}`, { message: syntaxResult.message });
      }
    }

    // 3. Copy staged files into the profile package directory.
    for (const step of plan.steps) {
      await assertWritable(step.targetAbs);
      const current = await pathState(step.targetAbs);
      const currentSha = current.exists ? await fileSha256(step.targetAbs) : null;
      if (currentSha !== step.targetSha256Before) {
        fail('E_CONCURRENT_CHANGE', `target changed between plan and apply: ${step.rel}`, {
          planned: step.targetSha256Before,
          current: currentSha,
        });
      }
      if (step.action === 'unchanged' || step.action === 'adopt') continue;
      if (current.exists && step.previous?.existed !== true) {
        // A file we believed absent now exists: only reachable through the
        // concurrent-change check above, kept as a defensive guard.
        fail('E_CONCURRENT_CHANGE', `unexpected existing target file: ${step.rel}`);
      }
      if (current.exists) {
        const backupName = `${step.rel.split('/').join('__')}.${String(step.targetSha256Before).slice(0, 12)}.bak`;
        const backupAbs = path.join(plan.stateDir, 'backups', backupName);
        await assertWritable(backupAbs);
        await copyFileInto(step.targetAbs, backupAbs);
        step.backupRel = POSIX(path.relative(plan.stateDir, backupAbs));
        step.previous = { ...step.previous, existed: true, sha256: step.targetSha256Before, backup: step.backupRel };
        backups.push({ path: step.targetAbs, backup: backupAbs });
        rollback.backups.push({ targetAbs: backupAbs, restoreAbs: step.targetAbs });
      }
      await copyFileInto(path.join(stagingDir, ...step.rel.split('/')), step.targetAbs);
      writes.push(step.targetAbs);
      if (!current.exists) rollback.files.push(step.targetAbs);
    }

    // 4. Remove stale owned files (upgrade), restoring their original content.
    for (const removal of plan.removals) {
      await assertWritable(removal.targetAbs);
      const currentSha = await fileSha256(removal.targetAbs);
      if (currentSha !== removal.targetSha256Before) {
        fail('E_CONCURRENT_CHANGE', `stale target changed between plan and apply: ${removal.rel}`);
      }
      if (removal.previous?.existed === true && removal.previous.backup) {
        const backupAbs = path.join(plan.stateDir, ...removal.previous.backup.split('/'));
        await copyFileInto(backupAbs, removal.targetAbs);
        writes.push(removal.targetAbs);
      } else if (removal.previous?.existed === true) {
        warn(warnings, 'stale_file_preserved', `stale installed file has no backup and is preserved: ${removal.rel}`);
      } else {
        await unlinkFile(removal.targetAbs);
        undone.push(removal.targetAbs);
      }
    }

    // 5. Append/verify the uniquely owned cordis.patch.yml insert row.
    if (plan.patch.writeRequired) {
      await assertWritable(plan.patch.path);
      const existing = await pathState(plan.patch.path);
      const baselineText = existing.exists ? await fsp.readFile(plan.patch.path, 'utf8') : '';
      const baselineSha = existing.exists ? hashText(baselineText) : null;
      if (existing.exists && baselineSha !== plan.patch.baseline.sha256) {
        fail('E_CONCURRENT_CHANGE', 'cordis.patch.yml changed between plan and apply');
      }
      if (existing.exists) {
        const backupAbs = path.join(plan.stateDir, 'backups', `cordis.patch.yml.${String(baselineSha).slice(0, 12)}.bak`);
        await assertWritable(backupAbs);
        await copyFileInto(plan.patch.path, backupAbs);
        plan.patch.baseline.backup = POSIX(path.relative(plan.stateDir, backupAbs));
        backups.push({ path: plan.patch.path, backup: backupAbs });
        rollback.backups.push({ targetAbs: backupAbs, restoreAbs: plan.patch.path });
      } else {
        rollback.files.push(plan.patch.path);
      }
      const prefix = patchAppendPrefix(baselineText);
      await writeFileAtomic(plan.patch.path, `${prefix}${plan.patch.block}`);
      writes.push(plan.patch.path);
    }

    // 6. Persist the install manifest last, so an interrupted run is detected
    //    by the absence of a manifest rather than by a partial one.
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      tool: TOOL,
      toolVersion: TOOL_VERSION,
      packageName: PACKAGE_NAME,
      rowId: ROW_ID,
      profileDir: plan.profileDir,
      sourceDir: plan.sourceDir,
      installedAt: plan.now,
      hostEntry: plan.hostEntry,
      sourceDigest: plan.sourceDigest,
      exclusionRules: plan.exclusionRules,
      files: plan.steps.map((step) => ({
        path: step.rel,
        sha256: step.sourceSha256,
        bytes: plan.files.find((file) => file.path === step.rel)?.bytes ?? null,
        action: step.action,
        previous: step.previous ?? { existed: false, sha256: null, backup: null, adopted: false },
      })),
      package: {
        dir: plan.packageDir,
        fileCount: plan.steps.filter((step) => step.action !== 'unchanged' && step.action !== 'adopt').length,
        totalBytes: plan.totalBytes,
        createdDirs: plan.createdDirs,
      },
      patch: {
        path: plan.patch.path,
        rowId: ROW_ID,
        packageName: PACKAGE_NAME,
        owned: plan.patch.owned,
        action: plan.patch.action,
        block: plan.patch.block,
        blockSha256: plan.patch.blockSha256,
        baseline: plan.patch.baseline,
      },
      warnings,
    };
    validateManifestShape(manifest, plan.manifestPath);
    await assertWritable(plan.manifestPath);
    await writeFileAtomic(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writes.push(plan.manifestPath);

    // 7. Drop the staging snapshot (owned, non-recursive cleanup).
    const stagingCleanup = await removeOwnedTree(stagingDir, plan.stateDir);

    return {
      ...plan,
      ok: true,
      dryRun: false,
      code: null,
      manifest,
      manifestPath: plan.manifestPath,
      writes,
      backups,
      removed: undone,
      stagingCleanup,
      globalWrites: [],
      nextSteps: [
        'Restart the DSH host for the profile so the new loader row is mounted (the installer never restarts anything).',
        'Run scripts/uninstall.mjs with the same --profile to restore the exact previous state.',
      ],
    };
  } catch (err) {
    const rollbackReport = await rollbackInstall({ profileAbs, plan, rollback, stagingDir, warnings });
    if (err instanceof InstallerError) {
      err.details = { ...(err.details ?? {}), rollback: rollbackReport };
      throw err;
    }
    throw new InstallerError('E_APPLY_FAILED', `install failed: ${String(err?.message ?? err)}`, { rollback: rollbackReport });
  }
}

async function rollbackInstall({ profileAbs, plan, rollback, stagingDir, warnings }) {
  const report = { attempted: true, restored: [], removed: [], cleanup: [], failed: [] };
  for (const entry of rollback.backups) {
    try {
      await copyFileInto(entry.targetAbs, entry.restoreAbs);
      report.restored.push(entry.restoreAbs);
    } catch (err) {
      report.failed.push({ path: entry.restoreAbs, message: String(err?.message ?? err) });
    }
  }
  for (const abs of rollback.files) {
    try {
      const outcome = await unlinkFile(abs);
      if (outcome === 'removed') report.removed.push(abs);
      if (abs === plan.patch.path) {
        warn(warnings, 'rollback_removed_patch', 'rolled back the owned cordis.patch.yml row appended by the failed run');
      }
    } catch (err) {
      report.failed.push({ path: abs, message: String(err?.message ?? err) });
    }
  }
  try {
    if (isInside(profileAbs, stagingDir)) {
      report.cleanup.push(await removeOwnedTree(stagingDir, plan.stateDir));
    }
  } catch (err) {
    report.failed.push({ path: stagingDir, message: String(err?.message ?? err) });
  }
  return report;
}

/**
 * Full install entry point: plan, then apply unless `dryRun`.
 * Never writes during planning; writes only inside the target profile.
 */
export async function install(options = {}) {
  const plan = await planInstall({ ...options, dryRun: true });
  if (options.dryRun === true) return { ...plan, dryRun: true };
  if (!plan.ok) {
    fail(plan.code ?? 'E_PLAN_CONFLICT', 'install plan has unresolved conflicts; nothing was written', { conflicts: plan.conflicts });
  }
  return applyInstall(plan);
}

export const USAGE = `Usage: node scripts/install.mjs --profile <dsh-profile-dir> --source <package-source-root> [options]

Required:
  --profile <dir>   Explicit target DSH profile directory (never a global config dir).
  --source <dir>    Explicit package source root to stage, validate and copy.

Options:
  --dry-run, --plan   Print the full plan and write nothing.
  --json              Emit the report as JSON.
  --require-host-entry  Fail when ${HOST_ENTRY} is missing from the source.
  --host-config <json>  Non-secret host settings file embedded in the owned loader row.
  -h, --help          Show this help.

The installer copies into <profile>/node_modules/@local/${PACKAGE_DIR_NAME}, appends the
uniquely owned insert row id ${ROW_ID} to <profile>/cordis.patch.yml, and persists an
install manifest (before/after SHA256 + backups) under <profile>/${STATE_DIR_REL}.
It never modifies Codex/user-global configuration, tokens, environment variables,
running sessions, or any path outside the given profile.`;

export function parseArgs(argv) {
  const options = { profileDir: null, sourceDir: null, dryRun: false, json: false, requireHostEntry: false, help: false };
  const takesValue = new Map([
    ['--profile', 'profileDir'],
    ['--source', 'sourceDir'],
    ['--host-config', 'hostConfigFile'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--plan') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--require-host-entry') options.requireHostEntry = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail('E_ARGS', `${arg} requires a value`);
      options[takesValue.get(arg)] = value;
      i += 1;
    } else {
      fail('E_ARGS', `unknown argument: ${arg}`);
    }
  }
  return options;
}

function renderHuman(report) {
  const lines = [];
  const conflict = report.conflicts?.length > 0;
  lines.push(`${report.tool} ${report.toolVersion} — ${report.dryRun ? 'plan (dry-run)' : 'install'}`);
  lines.push(`  profile      ${report.profileDir}`);
  lines.push(`  source       ${report.sourceDir}`);
  lines.push(`  package      ${report.packageDir} (${report.packageName})`);
  lines.push(`  manifest     ${report.manifestPath}`);
  lines.push(`  host entry   ${report.hostEntry === 'present' ? HOST_ENTRY : `missing (${HOST_ENTRY})`}`);
  if (report.files) {
    const counts = {};
    for (const step of report.steps ?? []) counts[step.action] = (counts[step.action] ?? 0) + 1;
    lines.push(`  files        ${report.files.length} scanned, ${report.totalBytes} bytes, ${JSON.stringify(counts)}`);
  }
  if (report.patch) {
    lines.push(`  patch        ${report.patch.action} (${report.patch.reason})`);
  }
  if (report.excluded?.length) {
    const shown = report.excluded.slice(0, 5).map((entry) => entry.path);
    lines.push(`  excluded     ${report.excluded.length} entries (${shown.join(', ')}${report.excluded.length > 5 ? ', ...' : ''})`);
  }
  if (report.steps?.length && report.dryRun) {
    for (const step of report.steps.slice(0, 20)) lines.push(`    - ${step.action.padEnd(9)} ${step.rel}`);
    if (report.steps.length > 20) lines.push(`    ... ${report.steps.length - 20} more`);
  }
  if (report.warnings?.length) {
    for (const entry of report.warnings) lines.push(`  warn         [${entry.code}] ${entry.message}`);
  }
  if (report.conflicts?.length) {
    for (const entry of report.conflicts) lines.push(`  conflict     [${entry.code}] ${entry.path ?? ''} ${entry.message}`);
  }
  if (report.nextSteps?.length) {
    for (const step of report.nextSteps) lines.push(`  next         ${step}`);
  }
  lines.push(`Result: ${conflict ? 'CONFLICT' : report.ok ? (report.dryRun ? 'OK (dry-run, nothing written)' : 'OK') : 'ERROR'}${report.code ? ` [${report.code}]` : ''}`);
  return `${lines.join('\n')}\n`;
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    stderr(`${err.code}: ${err.message}\n\n${USAGE}\n`);
    return EXIT_ERROR;
  }
  if (options.help) {
    stdout(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (!options.profileDir || !options.sourceDir) {
    stderr(`E_ARGS: --profile and --source are both required\n\n${USAGE}\n`);
    return EXIT_ERROR;
  }
  try {
    if(options.hostConfigFile)options.hostConfig=JSON.parse(await fsp.readFile(path.resolve(options.hostConfigFile),'utf8'));
    const report = await install(options);
    stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report));
    return report.ok ? EXIT_OK : EXIT_CONFLICT;
  } catch (err) {
    if (err instanceof InstallerError) {
      stderr(`${err.code}: ${err.message}\n`);
      if (options.json) stderr(`${JSON.stringify({ ok: false, code: err.code, message: err.message, details: err.details ?? null }, null, 2)}\n`);
      return EXIT_ERROR;
    }
    stderr(`E_UNEXPECTED: ${String(err?.stack ?? err)}\n`);
    return EXIT_ERROR;
  }
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
