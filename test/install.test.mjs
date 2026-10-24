/**
 * Tests for scripts/install.mjs and scripts/uninstall.mjs.
 *
 * Everything runs against temporary fake profiles and mocked source roots under
 * <repo>/.runtime/tests (gitignored). The real DSH host, real profiles, tokens,
 * environment variables and Codex configuration are never touched.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HOST_ENTRY,
  MARKER_END,
  MARKER_START,
  PACKAGE_NAME,
  ROW_ID,
  STATE_DIR_REL,
  exclusionFor,
  install,
  main as installMain,
  parseArgs as parseInstallArgs,
  pathState,
  planInstall,
  applyInstall,
  readManifest,
} from '../scripts/install.mjs';
import {
  main as uninstallMain,
  parseArgs as parseUninstallArgs,
  planUninstall,
  uninstall,
} from '../scripts/uninstall.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, '.runtime', 'tests');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const PATCH_HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries.',
  '',
].join('\n');

let counter = 0;

async function makeSandbox() {
  counter += 1;
  const dir = path.join(RUNTIME_ROOT, `${process.pid}-${Date.now()}-${counter}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanup(dir) {
  assert.ok(dir.startsWith(RUNTIME_ROOT), `refusing to clean outside the test runtime root: ${dir}`);
  await fsp.rm(dir, { recursive: true, force: true });
}

async function writeFiles(root, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, contents);
  }
}

async function exists(abs) {
  return (await pathState(abs)).exists;
}

async function makeProfileMetadata(profileDir, patchText = PATCH_HEADER) {
  await fsp.mkdir(profileDir, { recursive: true });
  await writeFiles(profileDir, {
    'package.json': `${JSON.stringify({ name: 'web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }, null, 2)}\n`,
    'cordis.patch.yml': patchText,
  });
}

const MODELS_SOURCE = 'export const FLASH = "deepseek-flash";\n';
const DEFAULT_SOURCE = {
  'package.json': `${JSON.stringify(
    { name: PACKAGE_NAME, version: '1.0.0', private: true, main: HOST_ENTRY },
    null,
    2,
  )}\n`,
  [HOST_ENTRY]: "'use strict';\nmodule.exports = { name: 'dsh-codex-bridge-v1', apply() {} };\n",
  'src/models.mjs': MODELS_SOURCE,
  'skills/dsh-project-execution/SKILL.md': '---\nname: dsh-project-execution\n---\n\n# skill\n',
  'evidence/packaging-worker.md': 'evidence kept in the package\n',
  'evidence/raw/host-dump.txt': 'excluded raw evidence\n',
  '.git': 'gitdir: D:/projects/agent-bridge/.git/worktrees/packaging\n',
  '.runtime/state.json': '{}\n',
  '.worktrees/other/file.txt': 'other worktree\n',
};

async function makeSource(root, overrides = {}) {
  const sourceDir = path.join(root, 'source');
  await fsp.mkdir(sourceDir, { recursive: true });
  await writeFiles(sourceDir, { ...DEFAULT_SOURCE, ...overrides });
  return sourceDir;
}

/** Hermetic options: no ambient CODEX_HOME/APPDATA, fake home. */
function opts(sandbox, profileDir, sourceDir, extra = {}) {
  return { profileDir, sourceDir, home: path.join(sandbox, 'home'), env: {}, now: 1700000000000, ...extra };
}

/** Same hermetic options for the uninstaller, which takes no source root. */
function uopts(sandbox, profileDir, extra = {}) {
  return { profileDir, home: path.join(sandbox, 'home'), env: {}, now: 1700000000000, ...extra };
}

async function installFake(sandbox, { sourceOverrides, patchText } = {}) {
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir, patchText);
  const sourceDir = await makeSource(sandbox, sourceOverrides);
  const report = await install(opts(sandbox, profileDir, sourceDir));
  return { profileDir, sourceDir, report };
}

const insideOf = (candidate, root) => path.resolve(candidate).startsWith(`${path.resolve(root)}${path.sep}`);
const manifestPathOf = (profileDir) => path.join(profileDir, ...STATE_DIR_REL.split('/'), 'install-manifest.json');
const readManifestJson = async (profileDir) => JSON.parse(await fsp.readFile(manifestPathOf(profileDir), 'utf8'));

test('explicit host config is installed atomically and round trips through ownership checks',async t=>{
 const sandbox=await makeSandbox();t.after(()=>cleanup(sandbox));const profileDir=path.join(sandbox,'profile');await makeProfileMetadata(profileDir,'[]\n');const sourceDir=await makeSource(sandbox);
 const options=opts(sandbox,profileDir,sourceDir,{hostConfig:{ownerId:'production',credentialFile:'E:/owned/credential',maxConcurrent:4}});
 const first=await install(options);assert.equal(first.ok,true);const patch=await fsp.readFile(path.join(profileDir,'cordis.patch.yml'),'utf8');assert.match(patch,/config: \{"ownerId":"production"/);
 assert.equal((await install(options)).ok,true);assert.equal((await uninstall(uopts(sandbox,profileDir))).ok,true);assert.equal(await fsp.readFile(path.join(profileDir,'cordis.patch.yml'),'utf8'),'[]\n');
});

test('native empty-list profile boots as a sequence and restores exactly after reinstall', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const original = '# Native DSH profile\r\n[] # empty patch\r\n';
  const { profileDir, sourceDir, report } = await installFake(sandbox, { patchText: original });
  assert.equal(report.ok, true);
  const installed = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(!installed.includes('[]'));
  assert.match(installed, /- insert:/);
  assert.match(installed, /# empty patch/);
  assert.equal((await install(opts(sandbox, profileDir, sourceDir))).ok, true);
  assert.equal((await uninstall(uopts(sandbox, profileDir))).ok, true);
  assert.equal(await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), original);
});

test('empty-list normalization preserves rows added by the user after install', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir } = await installFake(sandbox, { patchText: '# Native\n[]\n' });
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  await fsp.appendFile(patchPath, '- id: user-added\n  config: {}\n');
  assert.equal((await uninstall(uopts(sandbox, profileDir))).ok, true);
  const remaining = await fsp.readFile(patchPath, 'utf8');
  assert.match(remaining, /- id: user-added/);
  assert.ok(!remaining.includes('[]'));
  assert.ok(!remaining.includes(MARKER_START));
});

// ---------------------------------------------------------------------------
// Exclusion + plan hygiene
// ---------------------------------------------------------------------------

test('exclusion rules cover exactly the documented package exclusions', () => {
  for (const rel of ['.git', 'nested/.git', '.runtime/state.json', '.worktrees/x/y', 'evidence/raw/dump.txt', 'a/evidence/raw/b.txt']) {
    assert.ok(exclusionFor(rel), `expected exclusion for ${rel}`);
  }
  for (const rel of ['evidence/packaging-worker.md', 'skills/x/SKILL.md', 'package.json', 'evidence/rawdata.md', '.gitignore']) {
    assert.equal(exclusionFor(rel), null, `expected inclusion for ${rel}`);
  }
});

test('dry-run plan reports the full install without writing anything', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);

  const report = await install(opts(sandbox, profileDir, sourceDir, { dryRun: true }));

  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.packageName, PACKAGE_NAME);
  assert.equal(report.rowId, ROW_ID);
  assert.equal(report.hostEntry, 'present');
  assert.equal(report.patch.action, 'appended');
  assert.equal(report.patch.writeRequired, true);
  assert.ok(report.files.length >= 4);
  assert.ok(report.excluded.some((entry) => entry.path === 'evidence/raw'));

  assert.equal(await exists(path.join(profileDir, 'node_modules')), false);
  assert.equal(await exists(path.join(profileDir, ...STATE_DIR_REL.split('/'))), false);
  const patch = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.equal(patch, PATCH_HEADER, 'dry run must not modify cordis.patch.yml');
});

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

test('install copies the filtered package, appends one owned row and records a manifest', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir, report } = await installFake(sandbox);

  assert.equal(report.ok, true);
  assert.equal(report.dryRun, false);
  const packageDir = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1');
  assert.equal(report.packageDir, packageDir);

  for (const rel of ['package.json', HOST_ENTRY, 'src/models.mjs', 'skills/dsh-project-execution/SKILL.md', 'evidence/packaging-worker.md']) {
    assert.equal(await exists(path.join(packageDir, ...rel.split('/'))), true, `expected packaged file ${rel}`);
  }
  for (const rel of ['.git', '.runtime/state.json', '.worktrees/other/file.txt', 'evidence/raw/host-dump.txt']) {
    assert.equal(await exists(path.join(packageDir, ...rel.split('/'))), false, `expected excluded path ${rel}`);
  }

  const patch = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.startsWith(PATCH_HEADER), 'pre-existing patch content must be preserved');
  assert.ok(patch.includes(MARKER_START) && patch.includes(MARKER_END));
  assert.equal(patch.split(`id: ${ROW_ID}`).length - 1, 1, 'exactly one owned insert row');
  assert.ok(patch.includes(`- insert:\n    - id: ${ROW_ID}\n      name: '${PACKAGE_NAME}'`));

  const manifest = await readManifestJson(profileDir);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.profileDir, report.profileDir);
  assert.equal(manifest.packageName, PACKAGE_NAME);
  assert.equal(manifest.rowId, ROW_ID);
  assert.equal(manifest.installedAt, 1700000000000);
  assert.equal(manifest.patch.owned, true);
  assert.equal(manifest.patch.action, 'appended');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 4);
  for (const record of manifest.files) {
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
    assert.equal(record.previous.existed, false);
    const actual = await fsp.readFile(path.join(packageDir, ...record.path.split('/')));
    assert.equal(record.sha256, createHash('sha256').update(actual).digest('hex'));
  }

  // Every write stayed inside the target profile; nothing global was touched.
  assert.deepEqual(report.globalWrites, []);
  assert.ok(report.writes.length > 0);
  for (const write of report.writes) assert.ok(insideOf(write, profileDir), `write escaped the profile: ${write}`);

  // Staging snapshot is gone; the manifest plus the cordis.patch.yml baseline
  // backup remain.
  const stateDir = path.join(profileDir, ...STATE_DIR_REL.split('/'));
  assert.deepEqual((await fsp.readdir(stateDir)).sort(), ['backups', 'install-manifest.json']);
  const backupNames = await fsp.readdir(path.join(stateDir, 'backups'));
  assert.equal(backupNames.length, 1);
  assert.match(backupNames[0], /^cordis\.patch\.yml\.[0-9a-f]{12}\.bak$/);
  assert.equal(await fsp.readFile(path.join(stateDir, 'backups', backupNames[0]), 'utf8'), PATCH_HEADER);
});

test('reinstall is idempotent: no duplicate row, unchanged files untouched', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir, sourceDir } = await installFake(sandbox);

  const second = await install(opts(sandbox, profileDir, sourceDir));
  assert.equal(second.ok, true);
  assert.equal(second.patch.action, 'owned-present');
  assert.equal(second.patch.writeRequired, false);
  assert.equal(second.writes.length, 1, 'only the manifest is rewritten on an idempotent reinstall');
  assert.ok(second.steps.every((step) => step.action === 'unchanged'));

  const patch = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.equal(patch.split(`id: ${ROW_ID}`).length - 1, 1);
  assert.equal(patch.split(MARKER_START).length - 1, 1);
});

test('install backs up a pre-existing unowned package file, and uninstall restores it', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);
  const packageDir = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1');
  const previousContent = 'older bridge content';
  await writeFiles(packageDir, { 'src/models.mjs': previousContent });

  const report = await install(opts(sandbox, profileDir, sourceDir));
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((entry) => entry.code === 'replaced_preexisting_file'));
  assert.equal(await fsp.readFile(path.join(packageDir, 'src', 'models.mjs'), 'utf8'), MODELS_SOURCE);

  const manifest = await readManifestJson(profileDir);
  const record = manifest.files.find((entry) => entry.path === 'src/models.mjs');
  assert.equal(record.action, 'backup-replace');
  assert.equal(record.previous.existed, true);
  assert.equal(record.previous.sha256, sha256(previousContent));
  assert.match(record.previous.backup, /^backups\/src__models\.mjs\.[0-9a-f]{12}\.bak$/);
  assert.equal(
    await fsp.readFile(path.join(profileDir, ...STATE_DIR_REL.split('/'), ...record.previous.backup.split('/')), 'utf8'),
    previousContent,
  );

  const uninstallReport = await uninstall(uopts(sandbox, profileDir));
  assert.equal(uninstallReport.ok, true, JSON.stringify(uninstallReport.conflicts));
  assert.equal(await fsp.readFile(path.join(packageDir, 'src', 'models.mjs'), 'utf8'), previousContent);
  assert.equal(await exists(path.join(packageDir, 'package.json')), false, 'created files are removed');
});

test('install refuses to reinstall over an installed file modified locally', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir, sourceDir, report } = await installFake(sandbox);
  const edited = path.join(report.packageDir, 'src', 'models.mjs');
  await fsp.writeFile(edited, 'export const FLASH = "locally edited";\n');

  await assert.rejects(
    install(opts(sandbox, profileDir, sourceDir)),
    (err) => err.code === 'E_LOCAL_MODIFIED',
  );
  assert.equal(await fsp.readFile(edited, 'utf8'), 'export const FLASH = "locally edited";\n');
});

test('install refuses when a directory occupies a package file path', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);
  const packageDir = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1');
  await writeFiles(packageDir, { 'src/models.mjs/inner.txt': 'in the way' });

  await assert.rejects(
    install(opts(sandbox, profileDir, sourceDir)),
    (err) => err.code === 'E_TARGET_NOT_FILE',
  );
  assert.equal(await exists(path.join(packageDir, 'src', 'models.mjs', 'inner.txt')), true);
  assert.equal(await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), PATCH_HEADER);
});

test('a stale plan aborts during staging and leaves the profile untouched', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);

  const plan = await planInstall(opts(sandbox, profileDir, sourceDir));
  plan.steps[0].sourceSha256 = 'f'.repeat(64);

  await assert.rejects(applyInstall(plan), (err) => err.code === 'E_STAGING_MISMATCH');
  const packageDir = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1');
  assert.equal(await exists(packageDir), false, 'no package files may be copied on a staging failure');
  assert.equal(await exists(manifestPathOf(profileDir)), false);
  assert.equal(await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), PATCH_HEADER);
  const stateDir = path.join(profileDir, ...STATE_DIR_REL.split('/'));
  if (await exists(stateDir)) {
    assert.deepEqual(await fsp.readdir(stateDir), [], 'staging directory must be cleaned up');
  }
});

test('reinstall removes stale owned files that left the source', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox, { 'src/legacy.mjs': 'export const legacy = true;\n' });
  await install(opts(sandbox, profileDir, sourceDir));
  const legacyAbs = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1', 'src', 'legacy.mjs');
  assert.equal(await exists(legacyAbs), true);

  await fsp.rm(path.join(sourceDir, 'src', 'legacy.mjs'));
  const report = await install(opts(sandbox, profileDir, sourceDir));
  assert.equal(report.removals.length, 1);
  assert.equal(await exists(legacyAbs), false, 'stale owned file must be removed on upgrade');
});

// ---------------------------------------------------------------------------
// Uninstall: backup/restore and conflicts
// ---------------------------------------------------------------------------

test('uninstall restores pre-existing files from backup and removes only owned content', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir, `${PATCH_HEADER}# user row\n- id: user-skin\n  disabled: false\n`);
  const sourceDir = await makeSource(sandbox);
  const packageDir = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1');

  const originalPackageJson = '{"name":"pre-existing-user-file"}';
  await writeFiles(packageDir, { 'package.json': originalPackageJson });

  await install(opts(sandbox, profileDir, sourceDir));
  const manifest = await readManifestJson(profileDir);
  const record = manifest.files.find((entry) => entry.path === 'package.json');
  assert.equal(record.previous.existed, true);
  assert.match(record.previous.backup, /^backups\/package\.json\.[0-9a-f]{12}\.bak$/);
  assert.equal(
    await exists(path.join(profileDir, ...STATE_DIR_REL.split('/'), ...record.previous.backup.split('/'))),
    true,
  );

  const report = await uninstall(uopts(sandbox, profileDir));
  assert.equal(report.ok, true, JSON.stringify(report.conflicts));
  assert.equal(await fsp.readFile(path.join(packageDir, 'package.json'), 'utf8'), originalPackageJson);
  assert.equal(await exists(path.join(packageDir, HOST_ENTRY)), false, 'created files are removed');

  const patch = await fsp.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.equal(patch, `${PATCH_HEADER}# user row\n- id: user-skin\n  disabled: false\n`);
  assert.equal(await exists(path.join(profileDir, ...STATE_DIR_REL.split('/'))), false);
});

test('uninstall deletes a cordis.patch.yml it created, and reports plan-only under dry run', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await fsp.mkdir(profileDir, { recursive: true });
  await writeFiles(profileDir, {
    'package.json': `${JSON.stringify({ name: 'web', private: true }, null, 2)}\n`,
  });
  const sourceDir = await makeSource(sandbox);
  await install(opts(sandbox, profileDir, sourceDir));
  assert.equal(await exists(path.join(profileDir, 'cordis.patch.yml')), true);

  const plan = await uninstall(uopts(sandbox, profileDir, { dryRun: true }));
  assert.equal(plan.dryRun, true);
  assert.equal(plan.patch.status, 'remove-block');
  assert.equal(await exists(path.join(profileDir, 'cordis.patch.yml')), true, 'dry run must not remove the patch file');

  const report = await uninstall(uopts(sandbox, profileDir));
  assert.equal(report.ok, true);
  assert.equal(report.patch.deleted, true);
  assert.equal(await exists(path.join(profileDir, 'cordis.patch.yml')), false);
  assert.equal(await exists(path.join(profileDir, 'node_modules')), false, 'installer-created empty directories are removed');
});

test('uninstall reports a conflict for a locally edited file and leaves it untouched', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir } = await installFake(sandbox);
  const packageDir = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1');
  const editedContent = 'export const FLASH = "locally edited";\n';
  await fsp.writeFile(path.join(packageDir, 'src', 'models.mjs'), editedContent);

  const report = await uninstall(uopts(sandbox, profileDir));
  assert.equal(report.ok, false);
  assert.equal(report.code, 'E_LOCAL_MODIFIED');
  assert.equal(await fsp.readFile(path.join(packageDir, 'src', 'models.mjs'), 'utf8'), editedContent);
  assert.equal(await exists(path.join(packageDir, 'package.json')), false, 'unchanged owned files are still removed');
  assert.equal(await exists(manifestPathOf(profileDir)), true, 'manifest is kept when conflicts remain');
});

test('uninstall preserves unowned extra files and non-empty directories', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir, report: installReport } = await installFake(sandbox);
  const packageDir = installReport.packageDir;
  await writeFiles(packageDir, { 'extra/user-added.txt': 'keep me\n' });

  const report = await uninstall(uopts(sandbox, profileDir));
  assert.equal(report.ok, true);
  assert.equal(await fsp.readFile(path.join(packageDir, 'extra', 'user-added.txt'), 'utf8'), 'keep me\n');
  assert.ok(report.warnings.some((entry) => entry.code === 'preserved_foreign_file'));
  assert.ok(report.dirs.preserved.includes(packageDir), 'non-empty package directory is preserved, not force-deleted');
  assert.equal(await exists(path.join(profileDir, ...STATE_DIR_REL.split('/'))), false);
});

test('uninstall fails closed without a manifest and no-ops on an empty profile', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const packageDir = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1');
  await writeFiles(packageDir, { 'index.js': 'module.exports = {};\n' });

  await assert.rejects(uninstall(uopts(sandbox, profileDir)), (err) => err.code === 'E_NO_MANIFEST');
  assert.equal(await exists(path.join(packageDir, 'index.js')), true, 'unowned content must survive a failed uninstall');

  const emptyProfile = path.join(sandbox, 'empty-profile');
  await makeProfileMetadata(emptyProfile);
  const report = await uninstall(uopts(sandbox, emptyProfile));
  assert.equal(report.ok, true);
  assert.equal(report.alreadyAbsent, true);
});

test('uninstall refuses a manifest that belongs to a different profile', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir } = await installFake(sandbox);
  const manifest = await readManifestJson(profileDir);
  manifest.profileDir = path.join(sandbox, 'somewhere-else');
  await fsp.writeFile(manifestPathOf(profileDir), JSON.stringify(manifest, null, 2));

  await assert.rejects(uninstall(uopts(sandbox, profileDir)), (err) => err.code === 'E_MANIFEST_PROFILE_MISMATCH');
  assert.equal(await exists(path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1', 'package.json')), true);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test('installer refuses global configuration locations and missing inputs', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const home = path.join(sandbox, 'home');
  await fsp.mkdir(path.join(home, '.codex'), { recursive: true });
  await fsp.writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-6-astra"\n');
  const sourceDir = await makeSource(sandbox);
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);

  const cases = [
    [path.join(home, '.codex'), 'E_UNSAFE_PROFILE'],
    [path.join(home, '.agents'), 'E_UNSAFE_PROFILE'],
    [home, 'E_UNSAFE_PROFILE'],
    [path.parse(sandbox).root, 'E_UNSAFE_PROFILE'],
  ];
  for (const [unsafeProfile, code] of cases) {
    await assert.rejects(install({ profileDir: unsafeProfile, sourceDir, home, env: {}, now: 1 }), (err) => err.code === code, unsafeProfile);
  }
  await assert.rejects(
    install({ profileDir: path.join(sandbox, 'nope'), sourceDir, home, env: {}, now: 1 }),
    (err) => err.code === 'E_PROFILE_MISSING',
  );
  await assert.rejects(
    install({ profileDir, sourceDir: path.join(sandbox, 'missing'), home, env: {}, now: 1 }),
    (err) => err.code === 'E_SOURCE_MISSING',
  );
  assert.equal(await fsp.readFile(path.join(home, '.codex', 'config.toml'), 'utf8'), 'model = "gpt-6-astra"\n');
});

test('installer refuses a source without package.json, a broken host entry or overlapping paths', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);

  const bareSource = path.join(sandbox, 'bare');
  await writeFiles(bareSource, { 'index.js': 'module.exports = {};\n' });
  await assert.rejects(
    install(opts(sandbox, profileDir, bareSource)),
    (err) => err.code === 'E_SOURCE_PACKAGE_JSON',
  );

  const brokenHost = await makeSource(sandbox, { [HOST_ENTRY]: 'module.exports = { apply( };\n' });
  await assert.rejects(
    install(opts(sandbox, profileDir, brokenHost)),
    (err) => err.code === 'E_HOST_ENTRY_SYNTAX',
  );

  const noHost = await makeSource(path.join(sandbox, 'second'));
  await fsp.rm(path.join(noHost, HOST_ENTRY));
  await assert.rejects(
    install(opts(sandbox, profileDir, noHost, { requireHostEntry: true })),
    (err) => err.code === 'E_HOST_ENTRY_MISSING',
  );
  const warned = await install(opts(sandbox, profileDir, noHost));
  assert.equal(warned.ok, true);
  assert.ok(warned.warnings.some((entry) => entry.code === 'host_entry_missing'));

  await assert.rejects(
    install(opts(sandbox, profileDir, profileDir)),
    (err) => err.code === 'E_PATH_OVERLAP',
  );
});

test('installer never touches Codex/user-global configuration or environment', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const home = path.join(sandbox, 'home');
  const codexDir = path.join(home, '.codex');
  await fsp.mkdir(codexDir, { recursive: true });
  await fsp.writeFile(path.join(codexDir, 'config.toml'), 'model = "gpt-6-astra"\n');
  await fsp.writeFile(path.join(codexDir, 'AGENTS.md'), '# global agent policy\n');
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);
  const env = { CODEX_HOME: codexDir, APPDATA: path.join(home, 'AppData') };

  const report = await install({ profileDir, sourceDir, home, env, now: 2 });
  assert.deepEqual(report.globalWrites, []);
  for (const write of report.writes) assert.ok(insideOf(write, profileDir));
  assert.equal(await fsp.readFile(path.join(codexDir, 'config.toml'), 'utf8'), 'model = "gpt-6-astra"\n');
  assert.equal(await fsp.readFile(path.join(codexDir, 'AGENTS.md'), 'utf8'), '# global agent policy\n');
  assert.deepEqual(await fsp.readdir(codexDir).then((entries) => entries.sort()), ['AGENTS.md', 'config.toml']);

  const uninstallReport = await uninstall({ profileDir, home, env, now: 3 });
  assert.equal(uninstallReport.ok, true);
  assert.deepEqual(uninstallReport.globalWrites, []);
  assert.deepEqual(await fsp.readdir(codexDir).then((entries) => entries.sort()), ['AGENTS.md', 'config.toml']);
  assert.equal(await exists(path.join(home, 'AppData')), false, 'no environment-provided directory is created');
});

test('installer refuses symlinked source content', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);
  const fileTarget = path.join(sandbox, 'outside.txt');
  await fsp.writeFile(fileTarget, 'outside\n');
  const dirTarget = path.join(sandbox, 'outside-dir');
  await fsp.mkdir(dirTarget, { recursive: true });

  let created;
  try {
    created = path.join(sourceDir, 'link.txt');
    await fsp.symlink(fileTarget, created, 'file');
  } catch {
    try {
      // Directory junctions normally do not need the Windows symlink privilege.
      created = path.join(sourceDir, 'link-dir');
      await fsp.symlink(dirTarget, created, 'junction');
    } catch (err) {
      t.skip(`symlink/junction creation unavailable on this host: ${err.code}`);
      return;
    }
  }
  assert.ok(created);
  await assert.rejects(
    install(opts(sandbox, profileDir, sourceDir)),
    (err) => err.code === 'E_SYMLINK_UNSUPPORTED',
  );
});

// ---------------------------------------------------------------------------
// Real-path escapes (junction/symlink) and manifest tampering
// ---------------------------------------------------------------------------

async function makeJunction(targetDir, linkPath) {
  try {
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    await fsp.symlink(targetDir, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

test('installer refuses a junction inside the profile that escapes it', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await fsp.mkdir(profileDir, { recursive: true });
  await writeFiles(profileDir, { 'package.json': '{"name":"web","private":true}' });
  const outside = path.join(sandbox, 'outside');
  await fsp.mkdir(outside, { recursive: true });
  if (!(await makeJunction(outside, path.join(profileDir, 'node_modules')))) {
    t.skip('junction creation unavailable on this host');
    return;
  }
  const sourceDir = await makeSource(sandbox);

  await assert.rejects(
    install(opts(sandbox, profileDir, sourceDir)),
    (err) => err.code === 'E_SYMLINK_TARGET',
  );
  assert.deepEqual(await fsp.readdir(outside), [], 'nothing may be written through the escaping junction');
});

test('uninstall refuses a package directory replaced by an escaping junction', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir, report } = await installFake(sandbox);
  const packageDir = report.packageDir;
  const outside = path.join(sandbox, 'outside-pkg');
  await fsp.cp(packageDir, outside, { recursive: true });
  await fsp.rm(packageDir, { recursive: true, force: true });
  if (!(await makeJunction(outside, packageDir))) {
    t.skip('junction creation unavailable on this host');
    return;
  }

  await assert.rejects(
    uninstall(uopts(sandbox, profileDir)),
    (err) => err.code === 'E_SYMLINK_TARGET',
  );
  assert.equal(await exists(path.join(outside, 'package.json')), true, 'escaping target content must survive');
  assert.equal(await exists(path.join(outside, HOST_ENTRY)), true);
});

test('uninstall rejects tampered manifest paths that would escape the profile', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);
  const packageDir = path.join(profileDir, 'node_modules', '@local', 'dsh-codex-bridge-v1');
  const previousContent = 'pre-existing content';
  await writeFiles(packageDir, { 'src/models.mjs': previousContent });
  await install(opts(sandbox, profileDir, sourceDir));

  const outside = path.join(sandbox, 'outside');
  await fsp.mkdir(outside, { recursive: true });
  const outsideBackup = path.join(outside, 'escape.bak');
  await fsp.writeFile(outsideBackup, 'do not touch');

  // 1. backup mapping pointing outside the installer state directory
  const manifest = await readManifestJson(profileDir);
  const record = manifest.files.find((entry) => entry.path === 'src/models.mjs');
  assert.equal(record.previous.existed, true);
  record.previous.backup = '../../../../outside/escape.bak';
  await fsp.writeFile(manifestPathOf(profileDir), JSON.stringify(manifest, null, 2));

  const report = await uninstall(uopts(sandbox, profileDir));
  assert.equal(report.ok, false);
  assert.ok(report.conflicts.some((conflict) => conflict.code === 'E_MANIFEST_INVALID'), JSON.stringify(report.conflicts));
  assert.equal(await fsp.readFile(outsideBackup, 'utf8'), 'do not touch');
  assert.equal(
    await fsp.readFile(path.join(packageDir, 'src', 'models.mjs'), 'utf8'),
    MODELS_SOURCE,
    'the unresolved record is left untouched',
  );

  // 2. patch path pointing outside the profile
  const tamperedPatch = await readManifestJson(profileDir);
  tamperedPatch.patch.path = path.join(outside, 'cordis.patch.yml');
  await fsp.writeFile(manifestPathOf(profileDir), JSON.stringify(tamperedPatch, null, 2));
  await assert.rejects(uninstall(uopts(sandbox, profileDir)), (err) => err.code === 'E_MANIFEST_INVALID');
  assert.equal(await exists(path.join(outside, 'cordis.patch.yml')), false);

  // 3. package directory pointing outside the profile
  const tamperedPackage = await readManifestJson(profileDir);
  tamperedPackage.package.dir = outside;
  await fsp.writeFile(manifestPathOf(profileDir), JSON.stringify(tamperedPackage, null, 2));
  await assert.rejects(uninstall(uopts(sandbox, profileDir)), (err) => err.code === 'E_MANIFEST_INVALID');
  assert.equal(await fsp.readFile(outsideBackup, 'utf8'), 'do not touch');
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test('installer CLI parses arguments, supports --help and emits JSON under --dry-run', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);

  assert.deepEqual(parseInstallArgs(['--profile', 'p', '--source', 's']), {
    profileDir: 'p',
    sourceDir: 's',
    dryRun: false,
    json: false,
    requireHostEntry: false,
    help: false,
  });
  assert.throws(() => parseInstallArgs(['--nope']), (err) => err.code === 'E_ARGS');
  assert.throws(() => parseInstallArgs(['--profile']), (err) => err.code === 'E_ARGS');

  let out = '';
  let err = '';
  assert.equal(await installMain(['--help'], { stdout: (text) => { out += text; }, stderr: () => {} }), 0);
  assert.match(out, /--profile/);

  out = '';
  assert.equal(await installMain([], { stdout: (text) => { out += text; }, stderr: (text) => { err += text; } }), 1);
  assert.match(err, /E_ARGS/);

  out = '';
  const code = await installMain(['--profile', profileDir, '--source', sourceDir, '--plan', '--json'], {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
  });
  assert.equal(code, 0, err);
  const parsed = JSON.parse(out);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.ok, true);
  assert.equal(await exists(path.join(profileDir, 'node_modules')), false);
});

test('uninstaller CLI parses arguments and reports conflicts with exit code 2', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const { profileDir, report } = await installFake(sandbox);
  await fsp.writeFile(path.join(report.packageDir, 'package.json'), '{"name":"edited"}');

  assert.deepEqual(parseUninstallArgs(['--profile', 'p', '--dry-run']), {
    profileDir: 'p',
    dryRun: true,
    json: false,
    help: false,
  });
  assert.throws(() => parseUninstallArgs(['--what']), (err) => err.code === 'E_ARGS');

  let out = '';
  const code = await uninstallMain(['--profile', profileDir, '--json'], {
    stdout: (text) => { out += text; },
    stderr: () => {},
  });
  assert.equal(code, 2);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.conflicts.some((conflict) => conflict.code === 'E_LOCAL_MODIFIED'));

  let help = '';
  assert.equal(await uninstallMain(['--help'], { stdout: (text) => { help += text; }, stderr: () => {} }), 0);
  assert.match(help, /--profile/);
});

test('planInstall exposes the same plan shape the CLI renders', async (t) => {
  const sandbox = await makeSandbox();
  t.after(() => cleanup(sandbox));
  const profileDir = path.join(sandbox, 'profile');
  await makeProfileMetadata(profileDir);
  const sourceDir = await makeSource(sandbox);
  const plan = await planInstall(opts(sandbox, profileDir, sourceDir));
  assert.equal(plan.dryRun, true);
  assert.equal(plan.ok, true);
  assert.equal(plan.validation.syntax.length, 1);
  assert.equal(plan.validation.syntax[0].status, 'ok');
  assert.ok(plan.createdDirs.includes('node_modules'));
  assert.match(plan.sourceDigest, /^[0-9a-f]{64}$/);

  const manifestState = await readManifest(path.join(profileDir, ...STATE_DIR_REL.split('/')));
  assert.equal(manifestState.exists, false);
  const uninstallPlan = await planUninstall(uopts(sandbox, profileDir));
  assert.equal(uninstallPlan.alreadyAbsent, true);
});

// ---------------------------------------------------------------------------
// Packaged skill structure
// ---------------------------------------------------------------------------

test('packaged skill keeps frontmatter, discovery and reference links intact', async () => {
  const skillDir = path.join(REPO_ROOT, 'skills', 'dsh-project-execution');
  const referencesDir = path.join(skillDir, 'references');
  const skillText = await fsp.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skillText);
  assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter');
  assert.match(frontmatter[1], new RegExp(`^name:\\s*${path.basename(skillDir)}\\s*$`, 'm'), 'frontmatter name must match the skill folder');
  assert.match(frontmatter[1], /^description:\s*\S.{40,}$/m, 'frontmatter needs a discriminating description');
  assert.equal(frontmatter[1].includes('allow_implicit_invocation'), false, 'implicit discovery stays enabled');

  const linked = [...new Set([...skillText.matchAll(/\]\((references\/[^)]+)\)/g)].map((match) => match[1]))];
  const onDisk = (await fsp.readdir(referencesDir)).filter((name) => name.endsWith('.md')).map((name) => `references/${name}`);
  assert.ok(linked.length >= 5, 'the skill should route to modular references');
  for (const rel of linked) {
    assert.ok(onDisk.includes(rel), `linked reference is missing on disk: ${rel}`);
  }
  for (const rel of onDisk) {
    assert.ok(linked.includes(rel), `reference is not discoverable from SKILL.md: ${rel}`);
    const text = await fsp.readFile(path.join(skillDir, ...rel.split('/')), 'utf8');
    assert.equal(/\[TODO/i.test(text), false, `scaffold placeholder left in ${rel}`);
  }
  assert.equal(/\[TODO/i.test(skillText), false, 'scaffold placeholder left in SKILL.md');

  const plugin = JSON.parse(await fsp.readFile(path.join(REPO_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.skills, './skills/', 'plugin manifest must expose the skills directory');
});
