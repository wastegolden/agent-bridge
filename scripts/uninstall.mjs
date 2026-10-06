#!/usr/bin/env node
/**
 * dsh-codex-bridge-v1 — manifest-driven uninstaller for a DSH profile package.
 *
 * Behaviour, and nothing more:
 *   - reads the install manifest written by scripts/install.mjs;
 *   - restores only content whose current SHA256 still matches what the
 *     installer wrote (a locally edited file is reported as a conflict and
 *     left exactly as the user left it);
 *   - removes only files this installer created, only directories that became
 *     empty, and only the uniquely owned cordis.patch.yml marker block;
 *   - never issues a recursive delete of an arbitrary directory; files are
 *     unlinked individually and directories are rmdir'd only when empty;
 *   - refuses to guess: with no manifest, or with a manifest whose profile
 *     does not match, it fails closed and changes nothing;
 *   - `--dry-run`/`--plan` reports the exact planned actions with zero writes.
 *
 * Usage:
 *   node scripts/uninstall.mjs --profile <dsh-profile-dir> [--dry-run] [--json]
 *
 * Domain failures throw Error with a stable `.code`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  EXIT_CONFLICT,
  EXIT_ERROR,
  EXIT_OK,
  InstallerError,
  MANIFEST_FILE_NAME,
  MANIFEST_SCHEMA_VERSION,
  MARKER_END,
  MARKER_START,
  PACKAGE_NAME,
  ROW_ID,
  STATE_DIR_REL,
  TOOL_VERSION,
  assertSafeProfileDir,
  assertSafeWriteTarget,
  fileSha256,
  hashText,
  inventoryPackage,
  isInside,
  pathState,
  patchAppendPrefix,
  readManifest,
  removeOwnedTree,
  resolveRealPath,
  rmdirIfEmpty,
  unlinkFile,
  validateManifestShape,
  writeFileAtomic,
} from './install.mjs';

const TOOL = 'dsh-codex-bridge-uninstaller';
const POSIX = (p) => p.split(path.sep).join('/');
const fail = (code, message, details) => {
  throw new InstallerError(code, message, details);
};

/**
 * Build a read-only uninstall plan. Nothing is written or deleted here.
 */
export async function planUninstall(options = {}) {
  const { profileDir, now = Date.now(), env = process.env } = options;
  if (typeof profileDir !== 'string' || profileDir.trim() === '') fail('E_ARGS', 'profileDir is required');
  const profileAbs = assertSafeProfileDir(profileDir, env, options.home);
  const profileState = await pathState(profileAbs);
  if (!profileState.exists || !profileState.dir) {
    fail('E_PROFILE_MISSING', `target DSH profile directory not found: ${profileAbs}`);
  }

  const stateDir = path.join(profileAbs, ...STATE_DIR_REL.split('/'));
  const profileReal = await resolveRealPath(profileAbs);
  assertSafeProfileDir(profileReal, env, options.home);
  const actions = [];
  const conflicts = [];
  const warnings = [];

  const packageDirCandidate = path.join(profileAbs, 'node_modules', '@local', 'dsh-codex-bridge-v1');
  const patchPath = path.join(profileAbs, 'cordis.patch.yml');
  // Every path this command will read, restore, unlink or rmdir must be provably
  // inside the profile: no symlink/junction component below the profile root and
  // no resolved target outside the profile's real location.
  await assertSafeWriteTarget(profileAbs, stateDir, { code: 'E_MANIFEST_INVALID' });
  await assertSafeWriteTarget(profileAbs, patchPath, { code: 'E_MANIFEST_INVALID' });
  const prior = await readManifest(stateDir);
  const packageState = await pathState(packageDirCandidate);

  if (!prior.exists) {
    const patchState = await pathState(patchPath);
    const ownedBlockPresent = patchState.exists && patchState.file
      ? (await fsp.readFile(patchPath, 'utf8')).includes(MARKER_START)
      : false;
    if (!packageState.exists && !ownedBlockPresent) {
      return {
        ok: true,
        action: 'uninstall',
        dryRun: true,
        code: null,
        tool: TOOL,
        toolVersion: TOOL_VERSION,
        now,
        profileDir: profileAbs,
        profileReal,
        packageDir: packageDirCandidate,
        stateDir,
        manifestPath: path.join(stateDir, MANIFEST_FILE_NAME),
        alreadyAbsent: true,
        actions,
        conflicts,
        warnings,
        nextSteps: ['Nothing installed by this installer was found; no change was needed.'],
      };
    }
    fail(
      'E_NO_MANIFEST',
      `no install manifest at ${path.join(stateDir, MANIFEST_FILE_NAME)}; refusing to delete or modify unowned profile content`,
      { packageDir: packageDirCandidate },
    );
  }

  const manifest = prior.manifest;
  const manifestFiles = validateManifestShape(manifest, prior.path);
  const manifestProfile = typeof manifest.profileDir === 'string' ? path.resolve(manifest.profileDir) : null;
  if (manifestProfile === null || manifestProfile !== profileAbs) {
    fail('E_MANIFEST_PROFILE_MISMATCH', 'install manifest belongs to a different profile; nothing was changed', {
      manifestProfile,
      requestedProfile: profileAbs,
    });
  }
  const packageDir = typeof manifest.package?.dir === 'string' ? path.resolve(manifest.package.dir) : packageDirCandidate;
  if (!isInside(profileAbs, packageDir)) {
    fail('E_MANIFEST_INVALID', `manifest package directory is outside the profile: ${packageDir}`);
  }
  await assertSafeWriteTarget(profileAbs, packageDir, { code: 'E_MANIFEST_INVALID' });

  const inventory = await inventoryPackage(packageDir, manifest.files);
  const recordedPaths = new Set(manifestFiles);

  for (const record of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const targetAbs = path.join(packageDir, ...record.path.split('/'));
    if (!isInside(packageDir, targetAbs)) {
      conflicts.push({ code: 'E_MANIFEST_INVALID', path: record.path, message: 'recorded path escapes the package directory' });
      continue;
    }
    const current = inventory.files.get(record.path);
    if (!current) {
      actions.push({ kind: 'file', path: targetAbs, rel: record.path, status: 'absent', detail: 'already absent' });
      continue;
    }
    if (current.sha256 !== record.sha256) {
      if (record.previous?.existed === true && record.previous?.sha256 === current.sha256) {
        actions.push({ kind: 'file', path: targetAbs, rel: record.path, status: 'already-restored', detail: 'content already matches the pre-install state' });
        continue;
      }
      conflicts.push({
        code: 'E_LOCAL_MODIFIED',
        path: record.path,
        message: 'file changed after install; left untouched so local edits are never lost',
      });
      continue;
    }
    const previous = record.previous ?? { existed: false, sha256: null, backup: null, adopted: false };
    if (previous.existed !== true) {
      actions.push({ kind: 'file', path: targetAbs, rel: record.path, status: 'remove', detail: 'file was created by this installer' });
      continue;
    }
    if (previous.adopted === true) {
      warnings.push({
        code: 'preserved_foreign_file',
        message: `file pre-existed the install and is preserved: ${record.path}`,
      });
      actions.push({ kind: 'file', path: targetAbs, rel: record.path, status: 'preserve', detail: 'pre-existing content, not owned by the installer' });
      continue;
    }
    if (typeof previous.backup !== 'string' || previous.backup.trim() === '') {
      conflicts.push({
        code: 'E_BACKUP_MISSING',
        path: record.path,
        message: 'file replaced a pre-existing file but the manifest has no backup mapping; refusing to guess',
      });
      continue;
    }
    const backupAbs = path.join(stateDir, ...previous.backup.split('/'));
    if (!isInside(stateDir, backupAbs)) {
      conflicts.push({ code: 'E_MANIFEST_INVALID', path: record.path, message: 'backup path escapes the state directory' });
      continue;
    }
    try {
      await assertSafeWriteTarget(stateDir, backupAbs, { code: 'E_MANIFEST_INVALID' });
    } catch (err) {
      conflicts.push({
        code: err instanceof InstallerError ? err.code : 'E_MANIFEST_INVALID',
        path: record.path,
        message: `recorded backup is not a safe owned location: ${err.message}`,
      });
      continue;
    }
    const backupState = await pathState(backupAbs);
    if (!backupState.exists || !backupState.file) {
      conflicts.push({ code: 'E_BACKUP_MISSING', path: record.path, message: `recorded backup is missing: ${previous.backup}` });
      continue;
    }
    const backupSha = await fileSha256(backupAbs);
    if (backupSha !== previous.sha256) {
      conflicts.push({ code: 'E_BACKUP_MISMATCH', path: record.path, message: 'recorded backup content does not match its SHA256' });
      continue;
    }
    actions.push({ kind: 'file', path: targetAbs, rel: record.path, status: 'restore', backupAbs, detail: 'restore the pre-install file from backup' });
  }

  for (const rel of inventory.extra) {
    if (recordedPaths.has(rel)) continue;
    warnings.push({ code: 'preserved_foreign_file', message: `package directory content not owned by this installer is preserved: ${rel}` });
    actions.push({
      kind: 'file',
      path: path.join(packageDir, ...rel.split('/')),
      rel,
      status: 'preserve',
      detail: 'not recorded in the install manifest',
    });
  }

  const patchManifest = manifest.patch ?? null;
  const patchPlan = {
    path: typeof patchManifest?.path === 'string' ? patchManifest.path : path.join(profileAbs, 'cordis.patch.yml'),
    owned: patchManifest?.owned === true,
    action: patchManifest?.action ?? null,
    status: 'not-owned',
    blockSha256: patchManifest?.blockSha256 ?? null,
    baselineExisted: patchManifest?.baseline?.existed === true,
  };
  if (typeof patchManifest?.path === 'string') {
    const resolvedPatch = path.resolve(patchManifest.path);
    if (!isInside(profileAbs, resolvedPatch)) {
      fail('E_MANIFEST_INVALID', `manifest patch path is outside the profile: ${resolvedPatch}`);
    }
    try {
      await assertSafeWriteTarget(profileAbs, resolvedPatch, { code: 'E_MANIFEST_INVALID' });
    } catch (err) {
      fail(err instanceof InstallerError ? err.code : 'E_MANIFEST_INVALID', `manifest patch path is not a safe in-profile location: ${err.message}`);
    }
    patchPlan.path = resolvedPatch;
  }
  if (patchPlan.owned) {
    const backup = patchManifest?.baseline?.backup;
    if (typeof backup === 'string') {
      const backupAbs = path.resolve(stateDir, backup);
      if (!isInside(stateDir, backupAbs)) fail('E_MANIFEST_INVALID', 'patch backup escapes installer state');
      await assertSafeWriteTarget(profileAbs, backupAbs, { code: 'E_MANIFEST_INVALID' });
      if (await fileSha256(backupAbs) !== patchManifest.baseline.sha256) fail('E_BACKUP_MISMATCH', 'patch baseline backup changed');
      patchPlan.backupAbs = backupAbs;
      patchPlan.backupSha256 = patchManifest.baseline.sha256;
    }
    const patchState = await pathState(patchPlan.path);
    if (!patchState.exists) {
      patchPlan.status = 'absent';
    } else if (!patchState.file) {
      conflicts.push({ code: 'E_PATCH_NOT_FILE', path: patchPlan.path, message: 'cordis.patch.yml is not a regular file' });
      patchPlan.status = 'conflict';
    } else {
      const text = await fsp.readFile(patchPlan.path, 'utf8');
      const start = text.indexOf(MARKER_START);
      const end = text.indexOf(MARKER_END);
      if (start !== -1 && end !== -1 && end > start) {
        const block = text.slice(start, end + MARKER_END.length + 1);
        if (manifest.patch?.blockSha256 && hashText(block) === manifest.patch.blockSha256) {
          patchPlan.status = 'remove-block';
          patchPlan.block = block;
        } else {
          conflicts.push({
            code: 'E_PATCH_BLOCK_CHANGED',
            path: patchPlan.path,
            message: 'owned marker block was edited after install; left untouched',
          });
          patchPlan.status = 'conflict';
        }
      } else if (start !== -1 || end !== -1) {
        conflicts.push({
          code: 'E_PATCH_BLOCK_CHANGED',
          path: patchPlan.path,
          message: 'owned marker block is not intact; left untouched',
        });
        patchPlan.status = 'conflict';
      } else if (new RegExp(`(^|\\n)\\s*[-{]?\\s*id:\\s*['"]?${ROW_ID}['"]?\\s*$`, 'm').test(text)) {
        conflicts.push({
          code: 'E_PATCH_ROW_FOREIGN',
          path: patchPlan.path,
          message: 'row id is present without the owned marker block; left untouched',
        });
        patchPlan.status = 'conflict';
      } else {
        patchPlan.status = 'absent';
      }
    }
  }

  const createdDirs = Array.isArray(manifest.package?.createdDirs)
    ? manifest.package.createdDirs.filter((rel) => typeof rel === 'string' && rel.trim() !== '')
    : [];
  const dirCandidates = [...new Set([...createdDirs, POSIX(path.relative(profileAbs, packageDir)), 'node_modules/@local', 'node_modules'])]
    .filter((rel) => !rel.startsWith('..') && rel !== '')
    .sort((a, b) => b.length - a.length || (a < b ? 1 : -1));

  const plan = {
    ok: conflicts.length === 0,
    action: 'uninstall',
    dryRun: true,
    code: conflicts.length === 0 ? null : conflicts[0].code,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    now,
    profileDir: profileAbs,
    profileReal,
    packageDir,
    stateDir,
    manifestPath: prior.path,
    packageName: PACKAGE_NAME,
    rowId: ROW_ID,
    alreadyAbsent: false,
    actions,
    conflicts,
    warnings,
    removals: actions.filter((action) => action.status === 'remove'),
    restores: actions.filter((action) => action.status === 'restore'),
    preserves: actions.filter((action) => action.status === 'preserve'),
    patch: patchPlan,
    dirCandidates,
    manifest,
    dryRunNotes: 'plan only: no file, directory, or configuration was changed',
  };
  return plan;
}

async function cleanupStateDir(stateDir, profileAbs) {
  const report = { removed: [], preserved: [], dirs: [] };
  const state = await pathState(stateDir);
  if (!state.exists || !state.dir) return report;
  const entries = await fsp.readdir(stateDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(stateDir, entry.name);
    if (entry.isFile() && entry.name === MANIFEST_FILE_NAME) {
      if ((await unlinkFile(abs)) === 'removed') report.removed.push(abs);
      continue;
    }
    if (entry.isDirectory() && (entry.name === 'backups' || entry.name.startsWith('staging-'))) {
      try {
        await assertSafeWriteTarget(stateDir, abs, { code: 'E_SYMLINK_TARGET' });
      } catch {
        report.preserved.push(abs);
        continue;
      }
      const sub = await removeOwnedTree(abs, stateDir);
      report.removed.push(...sub.removed);
      report.preserved.push(...sub.preserved);
      continue;
    }
    report.preserved.push(abs);
  }
  const outcome = await rmdirIfEmpty(stateDir);
  if (outcome === 'removed') report.dirs.push(stateDir);
  else if (outcome === 'not-empty') report.preserved.push(stateDir);
  return report;
}

/**
 * Execute a plan from planUninstall. Restores everything unchanged, reports
 * conflicts for everything changed, and never deletes unowned content.
 */
export async function applyUninstall(plan) {
  if (!plan || plan.action !== 'uninstall') fail('E_ARGS', 'applyUninstall requires a plan from planUninstall');
  const profileAbs = path.resolve(plan.profileDir);
  const writes = [];
  const removed = [];
  const restored = [];
  const preserved = [...plan.preserves.map((action) => action.path)];

  for (const action of plan.actions) {
    await assertSafeWriteTarget(profileAbs, action.path, { code: 'E_WRITE_ESCAPE' });
  }

  for (const action of plan.removals) {
    const outcome = await unlinkFile(action.path);
    if (outcome === 'removed') removed.push(action.path);
  }
  for (const action of plan.restores) {
    const backupSha = await fileSha256(action.backupAbs);
    if (backupSha !== plan.manifest.files.find((record) => record.path === action.rel)?.previous?.sha256) {
      fail('E_BACKUP_MISMATCH', `backup changed after planning: ${action.rel}`);
    }
    await fsp.copyFile(action.backupAbs, action.path);
    restored.push(action.path);
    writes.push(action.path);
  }

  let patchReport = { status: plan.patch.status, removed: false, deleted: false };
  if (plan.patch.status === 'remove-block' && plan.patch.owned) {
    const patchAbs = path.resolve(plan.patch.path);
    await assertSafeWriteTarget(profileAbs, patchAbs, { code: 'E_WRITE_ESCAPE' });
    const text = await fsp.readFile(patchAbs, 'utf8');
    if (!text.includes(plan.patch.block)) {
      fail('E_CONCURRENT_CHANGE', 'cordis.patch.yml changed between plan and apply');
    }
    let next = text.replace(plan.patch.block, '');
    if (plan.patch.backupAbs) {
      await assertSafeWriteTarget(profileAbs, plan.patch.backupAbs, { code: 'E_WRITE_ESCAPE' });
      const original = await fsp.readFile(plan.patch.backupAbs, 'utf8');
      if (hashText(original) !== plan.patch.backupSha256) fail('E_BACKUP_MISMATCH', 'patch baseline backup changed after planning');
      if (next === patchAppendPrefix(original)) next = original;
    }
    if (next.trim() === '' && plan.patch.baselineExisted === false) {
      await unlinkFile(patchAbs);
      patchReport = { ...patchReport, removed: true, deleted: true };
      removed.push(patchAbs);
    } else {
      await writeFileAtomic(patchAbs, next);
      patchReport = { ...patchReport, removed: true, deleted: false };
      writes.push(patchAbs);
    }
  }

  // Clean the installer state first: it lives inside the package namespace, so
  // emptying it lets the created-directory pass below remove @local/node_modules
  // when they were created by this installer and hold nothing else.
  let stateCleanup = { removed: [], preserved: [], dirs: [] };
  if (plan.conflicts.length === 0) {
    stateCleanup = await cleanupStateDir(plan.stateDir, profileAbs);
  }

  const dirs = { removed: [], preserved: [] };
  for (const rel of plan.dirCandidates) {
    const abs = path.join(profileAbs, ...rel.split('/'));
    if (!isInside(profileAbs, abs)) continue;
    const outcome = await rmdirIfEmpty(abs);
    if (outcome === 'removed') dirs.removed.push(abs);
    else if (outcome === 'not-empty') dirs.preserved.push(abs);
  }

  const ok = plan.conflicts.length === 0;
  return {
    ...plan,
    ok,
    dryRun: false,
    code: ok ? null : plan.code,
    patch: { ...plan.patch, ...patchReport },
    writes,
    removed,
    restored,
    preserved,
    dirs,
    stateCleanup,
    globalWrites: [],
    nextSteps: ok
      ? ['Restart the DSH host for the profile so the removed loader row is no longer mounted (the uninstaller never restarts anything).']
      : ['Resolve the reported conflicts (restore or back up the listed files), then re-run the uninstaller.'],
  };
}

/** Uninstall entry point: plan, then apply unless `dryRun`. */
export async function uninstall(options = {}) {
  const plan = await planUninstall(options);
  if (plan.alreadyAbsent || options.dryRun === true) return { ...plan, dryRun: true };
  return applyUninstall(plan);
}

export const USAGE = `Usage: node scripts/uninstall.mjs --profile <dsh-profile-dir> [options]

Required:
  --profile <dir>   Explicit target DSH profile directory previously installed into.

Options:
  --dry-run, --plan   Report the exact planned removals/restores and write nothing.
  --json              Emit the report as JSON.
  -h, --help          Show this help.

Only content recorded in the install manifest is touched: unchanged files are
removed or restored from backup, locally edited files are reported as conflicts
and left untouched, unowned files are preserved, and directories are removed
only when they are empty. Without a manifest this command fails closed.`;

export function parseArgs(argv) {
  const options = { profileDir: null, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--plan') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--profile') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail('E_ARGS', '--profile requires a value');
      options.profileDir = value;
      i += 1;
    } else {
      fail('E_ARGS', `unknown argument: ${arg}`);
    }
  }
  return options;
}

function renderHuman(report) {
  const lines = [];
  lines.push(`${report.tool} ${report.toolVersion} — ${report.dryRun ? 'plan (dry-run)' : 'uninstall'}`);
  lines.push(`  profile    ${report.profileDir}`);
  lines.push(`  package    ${report.packageDir}`);
  lines.push(`  manifest   ${report.manifestPath}`);
  if (report.alreadyAbsent) {
    lines.push('  state      nothing installed by this installer was found');
  } else {
    for (const action of report.actions ?? []) lines.push(`    - ${action.status.padEnd(16)} ${action.rel}`);
    if (report.patch) lines.push(`  patch      ${report.patch.status} (${report.patch.path})`);
    for (const entry of report.warnings ?? []) lines.push(`  warn       [${entry.code}] ${entry.message}`);
    for (const entry of report.conflicts ?? []) lines.push(`  conflict   [${entry.code}] ${entry.path ?? ''} ${entry.message}`);
    if (report.dirs) lines.push(`  dirs       removed=${report.dirs.removed.length} preserved=${report.dirs.preserved.length}`);
    if (report.stateCleanup) lines.push(`  state dir  removed=${report.stateCleanup.removed.length} preserved=${report.stateCleanup.preserved.length}`);
    for (const step of report.nextSteps ?? []) lines.push(`  next       ${step}`);
  }
  lines.push(`Result: ${report.conflicts?.length > 0 ? 'CONFLICT' : report.ok ? (report.dryRun ? 'OK (dry-run, nothing written)' : 'OK') : 'ERROR'}${report.code ? ` [${report.code}]` : ''}`);
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
  if (!options.profileDir) {
    stderr(`E_ARGS: --profile is required\n\n${USAGE}\n`);
    return EXIT_ERROR;
  }
  try {
    const report = await uninstall(options);
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
