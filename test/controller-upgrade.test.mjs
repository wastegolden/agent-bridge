// D2 upgrade regressions: real v0 -> v1 identity migration and real mount-time
// configuration refusals.
//
// The legacy database is produced by the REAL v1 TaskStore (so ids, hashes, rounds and
// events are genuine), then downgraded to the shipped v0 schema/body shape with the
// identity fields removed. The migration under test is therefore the production
// TaskStore migration, not a hand-written replica.
//
// Covered here:
//   * multi-round history: followups, boundAttempt/previousAttempt snapshots and every
//     round's stored result survive byte-for-byte, and new rounds keep null ownership.
//   * an open WAL writer during migration, the durable v0 backup snapshot, event seq.
//   * illegal mount configuration (controllers, tokens, paths, legacy auth keys,
//     missing/duplicate/unwritable backup) never mutates an existing store.
//   * legacy credential removal: the retired token is 401 while historical tasks stay
//     readable, and administrative override still audits a null-owned mutation.
//
// controller-store.test.mjs already covers transaction rollback/process interruption,
// per-owner row preservation and unknown schema shapes; this file adds the mount-level
// view and the multi-round round-trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

import { TaskStore } from '../src/store.mjs';
import { BridgeService } from '../src/service.mjs';
import { validatePacket } from '../src/contracts.mjs';
import { mountBridge } from '../src/bootstrap.mjs';

const TEMP_ROOT = 'F:/temp/agent-bridge-upstream';
const LEGACY_SCHEMA = 'CREATE TABLE tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,idem)); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX task_events ON events(task_id,seq)';
const OWNER = 'd2-owner';

function tempDirectory(t, prefix = 'controller-upgrade-') {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function packet(directory, key, extra = {}) {
  return {
    schemaVersion: 1, idempotencyKey: key, revision: 1, projectId: 'upgrade',
    title: key, objective: 'read one file', cwd: directory, role: 'investigate',
    acceptance: ['evidence'],
    scope: { readRoots: [directory], writeRoots: [], allowedTools: ['read'], allowShell: false, allowNetwork: false, allowDelegation: false },
    materials: [], contractVersion: '1', ...extra,
  };
}

function token(id, character) {
  return `${id}-upgrade-test-${character.repeat(40)}`;
}

function controllersFor(directory, specs) {
  return specs.map(spec => {
    const tokenFile = path.join(directory, `${spec.id}.token`);
    fs.writeFileSync(tokenFile, spec.token ?? token(spec.id, 'x'));
    return { id: spec.id, tokenFile, ...(spec.admin === undefined ? {} : { admin: spec.admin }) };
  });
}

/** Build a genuine v1 database with three rounds of history plus a second task. */
function buildV1History(directory) {
  const store = new TaskStore({ directory, ownerId: OWNER });
  const multi = store.submit(validatePacket(packet(directory, 'multi-round')), {
    submittedBy: 'codex',
    via: { chain: ['claude-code', 'codex'], rootTask: 'history-root' },
  }).task;
  const model = { provider: 'deepseek-official', model: 'deepseek-flash' };
  const settle = (text, requestId, toolCalls, at) => store.update(multi.id, {
    status: 'completed', phase: 'completed', sessionId: 'session-history', requestId,
    dispatchStarted: true, dispatchReceiptAt: at, stopConfirmed: true, activeJobs: 0, activeChildren: 0,
    endedAt: at, resultCollected: true, accepted: true, artifactState: 'none',
    stats: { toolCalls }, effectiveModel: model,
    result: { text, evidence: [{ source: 'dsh-host', kind: 'attempt-settlement', status: 'completed' }], checks: [`check-${requestId}`], uncertainties: [] },
  });
  settle('first answer', 'request-1', 3, 1000);
  store.followup(multi.id, { revision: 1, afterAttemptId: store.get(multi.id).attemptId, followupId: 'history-f1', text: 'second round?' });
  settle('second answer', 'request-2', 8, 2000);
  store.followup(multi.id, { revision: 1, afterAttemptId: store.get(multi.id).attemptId, followupId: 'history-f2', text: 'third round?' });
  settle('third answer', 'request-3', 12, 3000);
  const simple = store.submit(validatePacket(packet(directory, 'simple')), { submittedBy: null, via: null }).task;
  store.update(simple.id, { status: 'cancelled', phase: 'cancelled', stopConfirmed: true, activeJobs: 0, activeChildren: 0, endedAt: 4000 });
  const tasks = store.list({ includeArchived: true });
  const events = tasks.flatMap(task => store.events(task.id, { limit: 1000 })).sort((left, right) => left.seq - right.seq);
  store.close();
  return { tasks, events, multiId: multi.id, simpleId: simple.id };
}

/** Rewrite the v1 database as the shipped v0 schema/body shape, keeping the writer open. */
function demoteToV0(directory, { tasks, events }) {
  const db = new DatabaseSync(path.join(directory, 'tasks.sqlite'));
  db.exec('DROP TABLE tasks; DROP TABLE events; PRAGMA user_version=0');
  db.exec(LEGACY_SCHEMA);
  const insert = db.prepare('INSERT INTO tasks(id,owner,idem,hash,body) VALUES(?,?,?,?,?)');
  for (const task of tasks) {
    const body = { ...task };
    delete body.submittedBy;
    delete body.via;
    insert.run(task.id, task.ownerId, task.packet.idempotencyKey, task.requestHash, JSON.stringify(body));
  }
  const insertEvent = db.prepare('INSERT INTO events(seq,task_id,body) VALUES(?,?,?)');
  for (const event of events) {
    const { seq, ...body } = event;
    insertEvent.run(seq, event.taskId, JSON.stringify(body));
  }
  return db;
}

function stripped(task) {
  const body = { ...task };
  delete body.submittedBy;
  delete body.via;
  return body;
}

function hostContext() {
  const registered = [];
  return {
    registered,
    ctx: {
      get: () => undefined,
      webServer: { register(route) { registered.push(route); return () => {}; } },
    },
  };
}

async function serveRoute(t, route) {
  const server = http.createServer((req, res) => { void route.handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return async (name, args, { token: bearer } = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { status: response.status, body: await response.json() };
  };
}

function outcomeOf(response) {
  if (response.status !== 200) return { status: response.status, body: response.body };
  const result = response.body?.result;
  if (result?.isError === true) return { error: JSON.parse(result.content[0].text) };
  return { value: result?.structuredContent };
}

test('v0 migration preserves every multi-round binding and result and keeps null ownership', async t => {
  const directory = tempDirectory(t);
  const history = buildV1History(directory);
  const backupDirectory = path.join(directory, 'backups');
  const legacyDb = demoteToV0(directory, history);
  // Keep the v0 writer open across migration so the committed WAL snapshot is what the
  // migration backup has to see.
  const wal = path.join(directory, 'tasks.sqlite-wal');
  assert.ok(fs.existsSync(wal));

  const store = new TaskStore({ directory, ownerId: OWNER, migrationBackupDirectory: backupDirectory });
  legacyDb.close();
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
  const multi = history.tasks.find(task => task.id === history.multiId);
  const simple = history.tasks.find(task => task.id === history.simpleId);
  assert.equal(store.get(history.multiId).submittedBy, null);
  assert.equal(store.get(history.multiId).via, null);
  assert.deepEqual(store.get(history.multiId), { ...multi, submittedBy: null, via: null });
  assert.deepEqual(store.get(history.multiId).followups, multi.followups);
  assert.equal(store.get(history.multiId).followups.length, 2);
  assert.equal(store.get(history.multiId).followups[0].previousAttempt.result.text, 'first answer');
  assert.equal(store.get(history.multiId).followups[0].boundAttempt.sessionId, 'session-history');
  assert.equal(store.get(history.multiId).followups[1].previousAttempt.result.text, 'second answer');
  assert.deepEqual(store.get(history.multiId).followups[1].boundAttempt, multi.followups[1].boundAttempt);
  assert.deepEqual(store.get(history.simpleId), { ...simple, submittedBy: null, via: null });
  assert.equal(store.get(history.simpleId).status, 'cancelled');
  assert.deepEqual(store.events(history.multiId), history.events.filter(event => event.taskId === history.multiId));
  assert.deepEqual(store.events(history.simpleId), history.events.filter(event => event.taskId === history.simpleId));
  assert.deepEqual(
    store.db.prepare('SELECT submittedBy FROM tasks ORDER BY rowid').all().map(row => row.submittedBy),
    ['', ''],
  );

  // The backup is a complete pre-migration snapshot: v0 version, original bodies, events,
  // and a passing integrity check.
  const snapshots = fs.readdirSync(backupDirectory);
  assert.equal(snapshots.length, 1);
  const snapshot = new DatabaseSync(path.join(backupDirectory, snapshots[0]), { readOnly: true });
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(JSON.parse(snapshot.prepare('SELECT body FROM tasks WHERE id=?').get(history.multiId).body), stripped(multi));
  assert.deepEqual(
    snapshot.prepare('SELECT seq,task_id,body FROM events ORDER BY seq').all(),
    history.events.map(({ seq, ...body }) => ({ seq, task_id: body.taskId, body: JSON.stringify(body) })),
  );
  snapshot.close();

  // A migration-created v1 store serves every historical round through the real service.
  const service = new BridgeService({ store, adapter: { models: async () => [] } });
  try {
    const firstAttempt = multi.followups[0].previousAttempt.attemptId;
    const secondAttempt = multi.followups[1].previousAttempt.attemptId;
    assert.equal(service.result(history.multiId, { attemptId: firstAttempt }).text, 'first answer');
    assert.equal(service.result(history.multiId, { attemptId: secondAttempt }).text, 'second answer');
    assert.equal(service.result(history.multiId).text, 'third answer');
    assert.equal(service.dossier(history.multiId).rounds.length, 3);
    assert.equal(service.dossier(history.multiId).submittedBy, null);
  } finally {
    service.close();
  }

  // A follow-up after migration continues the same null principal and the same session,
  // preserving the earlier rounds and their bound attempt exactly.
  const current = store.get(history.multiId);
  const next = store.followup(history.multiId, {
    revision: 1, afterAttemptId: current.attemptId, followupId: 'history-f3', text: 'after migration',
  });
  assert.equal(next.created, true);
  assert.equal(next.task.submittedBy, null);
  assert.equal(next.task.via, null);
  assert.equal(next.task.followups.length, 3);
  assert.deepEqual(next.task.followups.slice(0, 2), multi.followups);
  assert.equal(next.task.followups[2].boundAttempt.requestId, 'request-3');
  assert.equal(next.task.followups[2].boundAttempt.attemptId, current.attemptId);
  assert.equal(next.task.followups[2].previousAttempt.requestId, 'request-3');
  store.close();

  const reopened = new TaskStore({ directory, ownerId: OWNER });
  try {
    assert.equal(reopened.get(history.multiId).followups.length, 3);
    assert.equal(reopened.get(history.multiId).followups[2].boundAttempt.requestId, 'request-3');
    assert.deepEqual(fs.readdirSync(backupDirectory), snapshots, 'an already-migrated v1 store is not migrated again');
  } finally {
    reopened.close();
  }
});

test('illegal identity/mount configuration refuses before mutating an existing v0 store', async t => {
  const base = tempDirectory(t, 'controller-upgrade-mount-');
  const credentials = path.join(base, 'credentials');
  fs.mkdirSync(credentials);

  const freshV0 = async name => {
    const directory = path.join(base, name);
    fs.mkdirSync(directory);
    const history = buildV1History(directory);
    const db = demoteToV0(directory, history);
    db.close();
    return { directory, history };
  };
  const rawState = directory => {
    const db = new DatabaseSync(path.join(directory, 'tasks.sqlite'));
    try {
      return {
        version: db.prepare('PRAGMA user_version').get().user_version,
        bodies: db.prepare('SELECT body FROM tasks ORDER BY rowid').all().map(row => row.body),
      };
    } finally {
      db.close();
    }
  };

  const good = controllersFor(credentials, [{ id: 'codex' }, { id: 'operator', admin: true }]);
  const duplicateTokenFile = path.join(credentials, 'duplicate.token');
  // Same content as the codex credential, different file: duplicate tokens are refused.
  fs.writeFileSync(duplicateTokenFile, token('codex', 'x'));
  const duplicate = [{ id: 'codex', tokenFile: good[0].tokenFile }, { id: 'other', tokenFile: duplicateTokenFile }];
  fs.writeFileSync(path.join(credentials, 'short.token'), 'short');

  const cases = [
    ['missing controllers', {}, 'CONTROLLER_CONFIG_INVALID'],
    ['empty controllers', { controllers: [] }, 'CONTROLLER_CONFIG_INVALID'],
    ['duplicate controller id', { controllers: [good[0], { ...good[0], admin: false }] }, 'CONTROLLER_CONFIG_INVALID'],
    ['duplicate credential', { controllers: duplicate }, 'CONTROLLER_CONFIG_INVALID'],
    ['short credential', { controllers: [{ id: 'codex', tokenFile: path.join(credentials, 'short.token') }] }, 'CONTROLLER_CONFIG_INVALID'],
    ['relative credential path', { controllers: [{ id: 'codex', tokenFile: 'relative.token' }] }, 'CONTROLLER_CONFIG_INVALID'],
    ['unreadable credential source', { controllers: [{ id: 'codex', tokenFile: path.join(credentials, 'absent.token') }] }, 'AUTH_UNAVAILABLE'],
    ['legacy top-level token', { controllers: good, token: 'legacy-shared-token' }, 'CONTROLLER_CONFIG_INVALID'],
    ['legacy credentialFile', { controllers: good, credentialFile: path.join(credentials, 'legacy.token') }, 'CONTROLLER_CONFIG_INVALID'],
    ['relative backup directory', { controllers: good, identityMigrationBackupDirectory: 'relative/backups' }, 'CONTROLLER_CONFIG_INVALID'],
  ];
  for (const [label, extra, code] of cases) {
    const { directory, history } = await freshV0(`case-${cases.findIndex(entry => entry[0] === label)}`);
    const state = rawState(directory);
    const { ctx, registered } = hostContext();
    await assert.rejects(mountBridge(ctx, { dataDirectory: directory, ownerId: OWNER, ...extra }), { code }, label);
    assert.equal(registered.length, 0, label);
    assert.deepEqual(rawState(directory), state, `${label} changed the v0 store`);
    assert.equal(fs.existsSync(path.join(directory, 'host-lease.json')), false, `${label} leaked the host lease`);
    assert.ok(history.tasks.length > 0);
  }

  // A valid controller set still cannot migrate without a durable backup directory.
  {
    const { directory } = await freshV0('case-no-backup');
    const state = rawState(directory);
    const { ctx, registered } = hostContext();
    await assert.rejects(mountBridge(ctx, { dataDirectory: directory, ownerId: OWNER, controllers: good }), { code: 'STORE_BACKUP_FAILED' });
    assert.equal(registered.length, 0);
    assert.deepEqual(rawState(directory), state);
  }

  // A configured backup path that is a file is a refused backup, not a best-effort read.
  {
    const { directory } = await freshV0('case-backup-is-file');
    const blocked = path.join(directory, 'not-a-directory');
    fs.writeFileSync(blocked, 'file');
    const state = rawState(directory);
    const { ctx } = hostContext();
    await assert.rejects(mountBridge(ctx, {
      dataDirectory: directory, ownerId: OWNER, controllers: good, identityMigrationBackupDirectory: blocked,
    }), { code: 'STORE_BACKUP_FAILED' });
    assert.deepEqual(rawState(directory), state);
  }

  // An unknown schema is never guessed at, and the mount fails before migration.
  {
    const { directory } = await freshV0('case-alien-schema');
    const db = new DatabaseSync(path.join(directory, 'tasks.sqlite'));
    db.exec('CREATE TABLE unrelated(x TEXT)');
    db.close();
    const state = rawState(directory);
    const { ctx } = hostContext();
    await assert.rejects(mountBridge(ctx, {
      dataDirectory: directory, ownerId: OWNER, controllers: good, identityMigrationBackupDirectory: path.join(directory, 'backups'),
    }), { code: 'STORE_SCHEMA_UNSUPPORTED' });
    assert.deepEqual(rawState(directory), state);
    assert.equal(fs.existsSync(path.join(directory, 'backups')), false);
  }

  // The same store migrates once the configuration is legal.
  {
    const { directory, history } = await freshV0('case-valid');
    const backups = path.join(directory, 'backups');
    const { ctx, registered } = hostContext();
    const bridge = await mountBridge(ctx, {
      dataDirectory: directory, ownerId: OWNER, controllers: good, identityMigrationBackupDirectory: backups,
    });
    try {
      assert.equal(registered.length, 1);
      assert.equal(bridge.service.store.db.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(bridge.service.store.get(history.multiId).submittedBy, null);
      assert.equal(fs.readdirSync(backups).length, 1);
    } finally {
      await bridge.close();
    }
    assert.equal(fs.existsSync(path.join(directory, 'host-lease.json')), false);
  }
});

test('legacy credential removal leaves historical tasks readable and override-audited over real HTTP', async t => {
  const directory = tempDirectory(t, 'controller-upgrade-legacy-');
  const backups = path.join(directory, 'backups');
  const history = buildV1History(directory);
  const db = demoteToV0(directory, history);
  db.close();

  const all = controllersFor(directory, [
    { id: 'codex' },
    { id: 'operator', admin: true },
    { id: 'legacy', admin: true, token: token('legacy', 'l') },
  ]);
  const firstHost = hostContext();
  const first = await mountBridge(firstHost.ctx, {
    dataDirectory: directory, ownerId: OWNER, controllers: all, identityMigrationBackupDirectory: backups,
  });
  const firstRequest = await serveRoute(t, firstHost.registered[0]);
  try {
    assert.equal(first.service.store.get(history.multiId).submittedBy, null);
    const historical = await firstRequest('bridge_result', { taskId: history.multiId }, { token: token('legacy', 'l') });
    assert.equal(historical.status, 200);
    assert.equal(outcomeOf(historical).value.text, 'third answer');
    // The temporary legacy administrator may override a historical task, with audit.
    const audited = await firstRequest('bridge_cancel', { taskId: history.simpleId, override: { reason: '  maintenance window  ' } }, { token: token('legacy', 'l') });
    assert.equal(outcomeOf(audited).error, undefined);
    const events = first.service.store.events(history.simpleId);
    const intent = events.filter(event => event.type === 'task/override').at(-1);
    assert.equal(intent.actor, 'legacy');
    assert.equal(intent.submittedBy, null);
    assert.equal(intent.reason, 'maintenance window');
    assert.equal(first.service.store.get(history.simpleId).submittedBy, null);
  } finally {
    await first.close();
  }

  // Retire the legacy credential: the file still exists, but it is no longer configured.
  const remaining = all.filter(entry => entry.id !== 'legacy');
  const secondHost = hostContext();
  const second = await mountBridge(secondHost.ctx, { dataDirectory: directory, ownerId: OWNER, controllers: remaining });
  const request = await serveRoute(t, secondHost.registered[0]);
  try {
    const retired = await request('bridge_result', { taskId: history.multiId }, { token: token('legacy', 'l') });
    assert.deepEqual(retired, { status: 401, body: { error: 'unauthorized' } });
    const readable = await request('bridge_result', { taskId: history.multiId }, { token: token('codex', 'x') });
    assert.equal(readable.status, 200);
    assert.equal(outcomeOf(readable).value.text, 'third answer');
    assert.equal(outcomeOf(readable).value.submittedBy, null);

    // Non-admin foreign mutation is still N; the administrator still needs a reason.
    assert.equal(outcomeOf(await request('bridge_cancel', { taskId: history.simpleId }, { token: token('codex', 'x') })).error?.code, 'TASK_NOT_OWNED');
    assert.equal(outcomeOf(await request('bridge_cancel', { taskId: history.simpleId }, { token: token('operator', 'x') })).error?.code, 'OVERRIDE_REASON_REQUIRED');
    const override = await request('bridge_cancel', { taskId: history.simpleId, override: { reason: 'post-removal inspection' } }, { token: token('operator', 'x') });
    assert.equal(outcomeOf(override).error, undefined);
    assert.equal(second.service.store.get(history.simpleId).submittedBy, null);
    assert.equal(second.service.store.get(history.simpleId).via, null);
    assert.equal(second.service.store.events(history.simpleId).filter(event => event.type === 'task/override').at(-1).submittedBy, null);

    const capabilities = outcomeOf(await request('bridge_capabilities', {}, { token: token('operator', 'x') }));
    assert.deepEqual(capabilities.value.controllerIdentity.controllers, ['codex', 'operator']);
    assert.equal(capabilities.value.controllerIdentity.self, 'operator');
    assert.equal(capabilities.value.controllerIdentity.admin, true);

    // No second migration happened: the v1 store was already at version 1.
    assert.equal(fs.readdirSync(backups).length, 1);
    assert.equal(second.service.store.db.prepare('PRAGMA user_version').get().user_version, 1);
  } finally {
    await second.close();
  }
  assert.equal(fs.existsSync(path.join(directory, 'host-lease.json')), false);
});
