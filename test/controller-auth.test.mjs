import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadControllerRegistry, parseViaHeaders } from '../src/controller-auth.mjs';
import { mountBridge } from '../src/bootstrap.mjs';
import { acquireHostLease } from '../src/host-lease.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credential = (id, token = `${id}-`.padEnd(64, 'x'), extra = {}) => {
    const tokenFile = path.join(directory, `${id}.token`);
    fs.writeFileSync(tokenFile, token);
    return { id, tokenFile, ...extra };
  };
  return { directory, credential };
}

test('registry resolves all credentials, freezes public identity and exposes no secrets', t => {
  const { credential } = fixture(t);
  const entries = [credential('operator', 'o'.repeat(512), { admin: true }), credential('codex', ' c'.trim().repeat(24)), credential('claude-code', ` \n${'a'.repeat(64)}\r\n`)];
  const registry = loadControllerRegistry(entries);
  assert.deepEqual(registry.ids, ['claude-code', 'codex', 'operator']);
  assert.deepEqual(registry.authenticate(`Bearer ${'c'.repeat(24)}`), { id: 'codex', admin: false });
  assert.deepEqual(registry.authenticate(`Bearer ${'o'.repeat(512)}`), { id: 'operator', admin: true });
  assert.deepEqual(registry.authenticate(`Bearer ${'a'.repeat(64)}`), { id: 'claude-code', admin: false });
  for (const auth of [undefined, null, [], '', 'Basic anything', 'Bearer ', `Bearer ${'o'.repeat(511)}`, `Bearer ${'c'.repeat(24)} `]) assert.equal(registry.authenticate(auth), null);
  assert.throws(() => registry.ids.push('foreign'), TypeError);
  assert.throws(() => { registry.authenticate(`Bearer ${'c'.repeat(24)}`).admin = true; }, TypeError);
  assert.deepEqual(Object.keys(registry).sort(), ['authenticate', 'ids']);
  assert.equal(JSON.stringify(registry).includes('tokenFile'), false);
  fs.writeFileSync(entries[1].tokenFile, 'new'.repeat(20));
  assert.equal(registry.authenticate(`Bearer ${'c'.repeat(24)}`).id, 'codex', 'credentials stay fixed for the mount');
});

test('controller configuration validates cardinality, entries, IDs, paths and admin once', t => {
  const { credential } = fixture(t);
  const valid = credential('codex');
  const invalid = [undefined, null, {}, [], Array(33).fill(valid), [null], [[]], [new Date()],
    [{ ...valid, token: 'secret' }], [{ ...valid, id: undefined }], [{ ...valid, id: 'Codex' }],
    [{ ...valid, id: 'a'.repeat(65) }], [{ ...valid, id: 'a_b' }], [{ ...valid, admin: 1 }],
    [{ ...valid, admin: undefined }], [{ ...valid, tokenFile: 'relative.token' }],
    [{ ...valid, tokenFile: '\\rooted.token' }], [{ ...valid, tokenFile: '\\\\server\\share\\file' }],
    [{ ...valid, tokenFile: '//server/share/file' }], [{ ...valid, tokenFile: 'https://example/token' }],
    [{ ...valid, tokenFile: `${valid.tokenFile}\0` }], [valid, valid]];
  for (const controllers of invalid) assert.throws(() => loadControllerRegistry(controllers), { code: 'CONTROLLER_CONFIG_INVALID' });
  if (process.platform === 'win32') {
    assert.throws(() => loadControllerRegistry([{ ...valid, tokenFile: valid.tokenFile.slice(2).replaceAll('\\', '/') }]), { code: 'CONTROLLER_CONFIG_INVALID' });
  }
  const max = Array.from({ length: 32 }, (_, i) => credential(`c-${i}`));
  assert.equal(loadControllerRegistry(max).ids.length, 32);
  assert.equal(loadControllerRegistry([credential('a'.repeat(64))]).ids[0].length, 64);
});

test('credential format, duplication and file failures use bounded nonsecret errors', t => {
  const { directory, credential } = fixture(t);
  for (const token of ['', 'x'.repeat(23), 'x'.repeat(513), 'x'.repeat(24) + ' x', 'x'.repeat(24) + '\tx', 'x'.repeat(24) + '\nx', 'é'.repeat(24), 'x'.repeat(24) + '\x7f']) {
    const entry = credential('codex', token);
    assert.throws(() => loadControllerRegistry([entry]), error => {
      assert.equal(error.code, 'CONTROLLER_CONFIG_INVALID');
      assert.ok(error.details.expected.length <= 120);
      assert.equal(error.message.includes(directory), false);
      return true;
    });
  }
  assert.throws(() => loadControllerRegistry([credential('first', 'z'.repeat(64)), credential('second', 'z'.repeat(64))]), { code: 'CONTROLLER_CONFIG_INVALID' });
  for (const tokenFile of [path.join(directory, 'missing'), directory]) {
    assert.throws(() => loadControllerRegistry([{ id: 'codex', tokenFile }]), error => {
      assert.equal(error.code, 'AUTH_UNAVAILABLE');
      assert.equal(error.message.includes(tokenFile), false);
      assert.deepEqual(error.details, { field: 'controllers[0].tokenFile', expected: 'configured credential source available' });
      return true;
    });
  }
});

test('invalid identity configuration fails before lease, store or endpoint creation', async t => {
  const { directory, credential } = fixture(t);
  const controllers = [credential('codex')];
  let registered = 0;
  const ctx = { webServer: { register() { registered++; } } };
  for (const extra of [{}, { controllers: [] }, ...['token', 'credentialFile', 'tokenEnv'].map(key => ({ controllers, [key]: 'legacy-secret' })), { controllers, identityMigrationBackupDirectory: 'relative' }]) {
    const root = path.join(directory, `data-${registered}-${Object.keys(extra).join('-')}`);
    await assert.rejects(mountBridge(ctx, { dataDirectory: root, ...extra }), { code: 'CONTROLLER_CONFIG_INVALID' });
    assert.equal(fs.existsSync(root), false);
  }
  await assert.rejects(mountBridge(ctx, { dataDirectory: path.join(directory, 'unreadable'), controllers: [{ id: 'codex', tokenFile: path.join(directory, 'absent') }] }), { code: 'AUTH_UNAVAILABLE' });
  assert.equal(registered, 0);
});

function via(chain, rootTask, rawHeaders) {
  return parseViaHeaders({ headers: { 'x-agent-bridge-chain': chain ?? undefined, 'x-agent-bridge-root-task': rootTask ?? undefined }, rawHeaders });
}

test('bootstrap holds the host lease before migration and forwards the configured backup directory', async t => {
  const { directory, credential } = fixture(t);
  const root = path.join(directory, 'legacy-store');
  fs.mkdirSync(root);
  const file = path.join(root, 'tasks.sqlite');
  let db = new DatabaseSync(file);
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,idem)); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX task_events ON events(task_id,seq)');
  db.close();
  const config = { dataDirectory: root, controllers: [credential('codex')], identityMigrationBackupDirectory: path.join(directory, 'backups'), ownerId: `auth-migration-${path.basename(directory)}` };
  let mounts = 0;
  const ctx = { get: () => undefined, webServer: { register() { mounts++; assert.equal(fs.existsSync(path.join(root, 'host-lease.json')), true); return () => { mounts--; }; } } };
  const release = acquireHostLease(root);
  try {
    await assert.rejects(mountBridge(ctx, config), { code: 'HOST_ALREADY_RUNNING' });
    db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    db.close();
    assert.equal(fs.existsSync(config.identityMigrationBackupDirectory), false);
  } finally { release(); }
  const bridge = await mountBridge(ctx, config);
  try {
    assert.equal(mounts, 1);
    assert.equal(bridge.service.store.db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(fs.readdirSync(config.identityMigrationBackupDirectory).length, 1);
  } finally { await bridge.close(); }
  assert.equal(mounts, 0);
  assert.equal(fs.existsSync(path.join(root, 'host-lease.json')), false);
});

test('via accepts omitted root provenance and bounded client-declared delegate chains', () => {
  assert.equal(via(), null);
  assert.equal(via(' \t ', '\t'), null);
  assert.deepEqual(via(' claude-code>codex ', ' root_1:a.b-c '), { chain: ['claude-code', 'codex'], rootTask: 'root_1:a.b-c' });
  assert.deepEqual(via('codex'), { chain: ['codex'], rootTask: null });
  assert.equal(via('dsh>dsh>dsh>dsh>dsh', 'r'.repeat(128)).chain.length, 5);
});

test('via rejects duplicates, unknown members, non-ASCII, controls and invalid combinations', () => {
  const cases = [
    [undefined, 'root', undefined, 'via.rootTask'], ['codex', 'r'.repeat(129), undefined, 'via.rootTask'],
    ['codex', '-root', undefined, 'via.rootTask'], ['codex', 'r\tt', undefined, 'via.rootTask'],
    ['codex', 'r\0t', undefined, 'via.rootTask'], ['unknown', null, undefined, 'via.chain'],
    ['x'.repeat(257), null, undefined, 'via.chain'], ['codex>'.repeat(5) + 'dsh', null, undefined, 'via.chain'],
    ['codex> dsh', null, undefined, 'via.chain'], ['codex\tdsh', null, undefined, 'via.chain'],
    ['codex\rdsh', null, undefined, 'via.chain'], ['é', null, undefined, 'via.chain'],
    [['codex'], null, undefined, 'via.chain'],
    ['codex', null, ['X-Agent-Bridge-Chain', 'codex', 'x-agent-bridge-chain', 'codex'], 'via.chain'],
    ['codex', 'r', ['X-Agent-Bridge-Root-Task', 'r', 'x-agent-bridge-root-task', 'r'], 'via.rootTask'],
  ];
  for (const [chain, rootTask, rawHeaders, field] of cases) assert.throws(() => via(chain, rootTask, rawHeaders), error => {
    assert.equal(error.code, 'VIA_INVALID');
    assert.equal(error.details.field, field);
    assert.ok(error.details.expected.length <= 120);
    return true;
  });
});
