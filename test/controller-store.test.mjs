import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, clarificationRequestHash, followupRequestHash } from '../src/store.mjs';
import { validatePacket } from '../src/contracts.mjs';

const identity={submittedBy:'codex',via:{chain:['claude-code','codex'],rootTask:'root-1'}};
const legacySchema='CREATE TABLE tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,idem)); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX task_events ON events(task_id,seq)';
function directory(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-controller-store-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}
function packet(dir,key='shared'){
  return validatePacket({schemaVersion:1,idempotencyKey:key,revision:1,projectId:'p',title:key,objective:'read one file',cwd:dir,role:'investigate',acceptance:['evidence'],scope:{readRoots:[dir],writeRoots:[],allowedTools:['read_file'],allowShell:false,allowNetwork:false,allowDelegation:false},materials:[],contractVersion:'1'});
}
function legacy(dir){
  const store=new TaskStore({directory:dir,ownerId:'owner'});
  const first=store.submit(packet(dir),identity).task;
  store.update(first.id,{status:'completed',sessionId:'session',requestId:'request-1',dispatchReceiptAt:10,dispatchStarted:true,effectiveModel:{provider:'p',model:'m'},stats:{toolCalls:4},result:{text:'first answer',evidence:[{source:'dsh-host',kind:'attempt-settlement',status:'completed'}],checks:['first'],uncertainties:[]},resultCollected:true,accepted:true});
  store.followup(first.id,{revision:1,afterAttemptId:first.attemptId,followupId:'f1',text:'next'});
  store.update(first.id,{status:'completed',requestId:'request-2',dispatchReceiptAt:20,dispatchStarted:true,stats:{toolCalls:7},result:{text:'second answer',evidence:[{source:'dsh-host',kind:'attempt-settlement',status:'completed'}],checks:['second'],uncertainties:[]}});
  store.followup(first.id,{revision:1,afterAttemptId:store.get(first.id).attemptId,followupId:'f2',text:'again'});
  // A cancelled, never-dispatched follow-up retains its prior owned-session binding.
  store.update(first.id,{status:'cancelled'});
  const old=store.get(first.id);
  delete old.submittedBy;delete old.via;
  const other={...structuredClone(old),id:'other-owner-task',ownerId:'other'};
  const events=store.events(first.id);
  store.close();
  const db=new DatabaseSync(path.join(dir,'tasks.sqlite'));
  db.exec('DROP TABLE tasks; DROP TABLE events; PRAGMA user_version=0');
  db.exec(legacySchema);
  for(const task of [old,other])db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id,task.ownerId,task.packet.idempotencyKey,task.requestHash,JSON.stringify(task));
  for(const event of events){const {seq,...body}=event;db.prepare('INSERT INTO events(seq,task_id,body) VALUES(?,?,?)').run(seq,event.taskId,JSON.stringify(body));}
  return {db,old,other,events};
}
function options(dir){return {directory:dir,ownerId:'owner',migrationBackupDirectory:path.join(dir,'backups')};}

test('v0 migration preserves every owner, follow-up snapshot, WAL commit, event and sequence',t=>{
  const dir=directory(t),{db,old,other,events}=legacy(dir);
  // Keep the writer open so its committed data remains in WAL during the snapshot.
  assert.ok(fs.statSync(path.join(dir,'tasks.sqlite-wal')).size>0);
  const sequence=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('events').seq;
  const store=new TaskStore(options(dir));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,1);
  assert.deepEqual(store.get(old.id),{...old,submittedBy:null,via:null});
  assert.deepEqual(store.get(old.id).followups,old.followups);
  assert.deepEqual(store.events(old.id),events);
  assert.equal(store.event(old.id,{type:'after-migration'}).seq,sequence+1);
  assert.deepEqual(store.db.prepare('SELECT submittedBy FROM tasks ORDER BY rowid').all().map(r=>r.submittedBy),['','']);
  const foreign=new TaskStore({...options(dir),ownerId:'other'});
  assert.deepEqual(foreign.get(other.id),{...other,submittedBy:null,via:null});foreign.close();
  const snapshots=fs.readdirSync(path.join(dir,'backups'));
  assert.equal(snapshots.length,1);
  const snapshot=new DatabaseSync(path.join(dir,'backups',snapshots[0]),{readOnly:true});
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,0);
  assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(JSON.parse(snapshot.prepare('SELECT body FROM tasks WHERE id=?').get(old.id).body),old);
  assert.deepEqual(snapshot.prepare('SELECT seq,body FROM events ORDER BY seq').all(),db.prepare('SELECT seq,body FROM events WHERE seq<=? ORDER BY seq').all(sequence));
  snapshot.close();db.close();
  const next=store.followup(old.id,{revision:1,afterAttemptId:old.attemptId,followupId:'f3',text:'after migration'});
  assert.equal(next.task.submittedBy,null);assert.equal(next.task.via,null);
  assert.deepEqual(next.task.followups.at(-1).boundAttempt,old.followups.at(-1).boundAttempt);
  assert.deepEqual(next.task.followups.slice(0,2),old.followups);
  store.close();
  const reopened=new TaskStore({directory:dir,ownerId:'owner'});
  assert.equal(reopened.get(old.id).followups.length,3);
  assert.deepEqual(fs.readdirSync(path.join(dir,'backups')),snapshots);
  reopened.close();
});

test('backup configuration and flush failure prevent all migration writes',t=>{
  const dir=directory(t),{db,old}=legacy(dir);db.close();
  const assertOriginal=()=>{
    const raw=new DatabaseSync(path.join(dir,'tasks.sqlite'));
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version,0);
    assert.deepEqual(JSON.parse(raw.prepare('SELECT body FROM tasks WHERE id=?').get(old.id).body),old);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='tasks_v1'").get().n,0);raw.close();
  };
  assert.throws(()=>new TaskStore({directory:dir,ownerId:'owner'}),{code:'STORE_BACKUP_FAILED'});assertOriginal();
  const blocked=path.join(dir,'not-a-directory');fs.writeFileSync(blocked,'file');
  assert.throws(()=>new TaskStore({...options(dir),migrationBackupDirectory:blocked}),{code:'STORE_BACKUP_FAILED'});assertOriginal();
  const original=fs.fsyncSync;
  fs.fsyncSync=()=>{throw new Error('injected flush failure');};
  try{assert.throws(()=>new TaskStore(options(dir)),{code:'STORE_BACKUP_FAILED'});}finally{fs.fsyncSync=original;}
  assertOriginal();
});

test('transaction failure rolls back; actual process interruption recovers and retries',t=>{
  const dir=directory(t),{db,old}=legacy(dir);db.close();
  const original=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql){if(sql.startsWith('DROP TABLE tasks; ALTER TABLE'))throw new Error('injected migration failure');return original.call(this,sql);};
  try{assert.throws(()=>new TaskStore(options(dir)),{code:'STORE_MIGRATION_FAILED'});}finally{DatabaseSync.prototype.exec=original;}
  let raw=new DatabaseSync(path.join(dir,'tasks.sqlite'));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,0);
  assert.deepEqual(JSON.parse(raw.prepare('SELECT body FROM tasks WHERE id=?').get(old.id).body),old);raw.close();
  const script=`import {DatabaseSync} from 'node:sqlite'; import {TaskStore} from ${JSON.stringify(new URL('../src/store.mjs',import.meta.url).href)};
    const original=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql){const result=original.call(this,sql);if(sql.startsWith('DROP TABLE tasks; ALTER TABLE'))process.exit(23);return result;};
    new TaskStore(${JSON.stringify(options(dir))});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{stdio:'inherit'});
  assert.equal(child.status,23,child.error?.message);
  raw=new DatabaseSync(path.join(dir,'tasks.sqlite'));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,0);
  assert.deepEqual(JSON.parse(raw.prepare('SELECT body FROM tasks WHERE id=?').get(old.id).body),old);raw.close();
  const store=new TaskStore(options(dir));
  assert.deepEqual(store.get(old.id),{...old,submittedBy:null,via:null});store.close();
  assert.equal(fs.readdirSync(path.join(dir,'backups')).length,3);
});

test('unknown versions, schemas and unmanaged identity fields are refused',t=>{
  for(const change of [
    db=>db.exec('PRAGMA user_version=2'),
    db=>db.exec('PRAGMA user_version=1'),
    db=>db.exec('ALTER TABLE tasks ADD COLUMN alien TEXT'),
    db=>db.exec('DROP INDEX task_events'),
    db=>db.exec('CREATE TABLE unrelated(x TEXT)'),
    db=>db.exec("UPDATE tasks SET body=json_set(body,'$.submittedBy',null)"),
    db=>db.exec("UPDATE tasks SET body=json_set(body,'$.via',null)"),
    db=>db.exec("UPDATE tasks SET body='invalid JSON'"),
  ]){
    const dir=directory(t),{db}=legacy(dir);change(db);db.close();
    assert.throws(()=>new TaskStore(options(dir)),{code:'STORE_SCHEMA_UNSUPPORTED'});
    assert.equal(fs.existsSync(path.join(dir,'backups')),false);
  }
  const dir=directory(t);let store=new TaskStore(options(dir));const task=store.submit(packet(dir),identity).task;store.close();
  const db=new DatabaseSync(path.join(dir,'tasks.sqlite'));db.prepare('UPDATE tasks SET submittedBy=? WHERE id=?').run('foreign',task.id);db.close();
  assert.throws(()=>new TaskStore(options(dir)),{code:'STORE_SCHEMA_UNSUPPORTED'});
  for(const schema of [legacySchema.replace('idem TEXT','idem TEXT COLLATE NOCASE'),legacySchema.replace(' AUTOINCREMENT',''),legacySchema.replace('idem TEXT','idem TE XT')]){
    const unknown=directory(t),raw=new DatabaseSync(path.join(unknown,'tasks.sqlite'));raw.exec(schema);raw.close();
    assert.throws(()=>new TaskStore(options(unknown)),{code:'STORE_SCHEMA_UNSUPPORTED'});
  }
});

test('principal namespaces preserve idempotency and separate null from legacy',t=>{
  const dir=directory(t),store=new TaskStore(options(dir));
  const p=packet(dir),ids=[];
  for(const submittedBy of ['claude-code','codex','operator','legacy',null,'retired-controller']){
    const first=store.submit(p,{submittedBy,via:identity.via});ids.push(first.task.id);
    assert.equal(store.submit(p,{submittedBy,via:null}).task.id,first.task.id);
    assert.deepEqual(store.find(p.idempotencyKey,submittedBy).task.via,identity.via);
    assert.throws(()=>store.submit({...p,title:'changed'},{submittedBy,via:null}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.deepEqual(store.list({submittedBy}).map(t=>t.id),[first.task.id]);
  }
  assert.equal(new Set(ids).size,6);assert.equal(store.list().length,6);
  assert.equal(store.find('missing','codex'),null);
  assert.throws(()=>store.find(p.idempotencyKey),{code:'AUTH_UNAVAILABLE'});
  assert.throws(()=>store.submit(p),{code:'AUTH_UNAVAILABLE'});
  assert.throws(()=>store.submit(p,{submittedBy:'codex'}),{code:'AUTH_UNAVAILABLE'});
  store.close();
});

test('identity stays immutable through update and every continuation seam',t=>{
  const dir=directory(t),store=new TaskStore(options(dir));
  const task=store.submit(packet(dir),identity).task;
  for(const change of [{submittedBy:null},{submittedBy:'operator'},{via:null},{via:{...identity.via,rootTask:'changed'}},t=>{t.via.chain.push('dsh');return t;},t=>{delete t.submittedBy;return t;}]){
    const before=store.get(task.id);assert.throws(()=>store.update(task.id,change),{code:'IMMUTABLE_IDENTITY'});assert.deepEqual(store.get(task.id),before);
  }
  store.update(task.id,t=>({...t,status:'awaiting_approval',sessionId:'s',requestId:'r',dispatchReceiptAt:1,understandingHash:'u'}));
  for(const change of [{submittedBy:null},{via:null}])assert.throws(()=>store.beginAttempt(task.id,change),{code:'IMMUTABLE_IDENTITY'});
  const clarify={revision:1,understandingHash:'u',clarificationId:'c1',text:'clarify'};
  let next=store.clarify(task.id,{...clarify,submittedBy:'foreign',via:null}).task;
  assert.equal(next.submittedBy,identity.submittedBy);assert.deepEqual(next.via,identity.via);
  assert.equal(next.clarifications[0].requestHash,clarificationRequestHash({...clarify,via:null,override:{reason:'test'}}));
  store.update(task.id,{status:'awaiting_approval'});
  next=store.beginAttempt(task.id,{status:'completed',sessionId:'s',requestId:'r2',dispatchReceiptAt:2});
  assert.equal(next.submittedBy,identity.submittedBy);assert.deepEqual(next.via,identity.via);
  const followup={revision:1,afterAttemptId:next.attemptId,followupId:'f1',text:'follow'};
  next=store.followup(task.id,{...followup,submittedBy:'foreign',via:null}).task;
  assert.equal(next.submittedBy,identity.submittedBy);assert.deepEqual(next.via,identity.via);
  assert.equal(next.followups[0].requestHash,followupRequestHash({...followup,override:{reason:'test'}}));
  assert.equal(store.followup(task.id,followup).created,false);
  assert.throws(()=>store.followup(task.id,{...followup,text:'changed'}),{code:'FOLLOWUP_IDEMPOTENCY_CONFLICT'});
  assert.throws(()=>store.followup(task.id,{...followup,followupId:'f2'}),{code:'FOLLOWUP_CONFLICT'});
  store.update(task.id,{status:'waiting',project:{roundsUsed:1,rounds:[{attemptId:next.attemptId,status:'completed',stopConfirmed:true,activeJobs:0,activeChildren:0}],pendingRound:{index:2,dispatchKey:'next'}}});
  next=store.beginRound(task.id,{expectedAttemptId:next.attemptId,expectedRoundIndex:1,expectedDispatchKey:'next',submittedBy:'foreign',via:null});
  assert.equal(next.submittedBy,identity.submittedBy);assert.deepEqual(next.via,identity.via);
  store.close();
});
