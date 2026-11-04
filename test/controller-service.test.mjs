import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TaskStore } from '../src/store.mjs';
import { BridgeService } from '../src/service.mjs';
import { validatePacket } from '../src/contracts.mjs';
import { BridgeSupervisor, HostReservationLedger } from '../src/supervisor.mjs';
import { SupervisorProjectRuntime, createProjectRecord, normalizeProjectConfig, resolveProjectGrant } from '../src/long-task.mjs';
import { makeTestDir } from './helpers/test-root.mjs';

const via={chain:['claude-code','codex'],rootTask:'root-1'};
const model={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'};
function packet(dir,key='shared',extra={}){
  return {schemaVersion:1,idempotencyKey:key,revision:1,projectId:'identity',title:key,objective:'read one file',cwd:dir,role:'investigate',acceptance:['evidence'],scope:{readRoots:[dir],writeRoots:[],allowedTools:['read'],allowShell:false,allowNetwork:false,allowDelegation:false},materials:[],contractVersion:'1',...extra};
}
function fixture(t){
  const dir=makeTestDir('bridge-controller-service');
  const store=new TaskStore({directory:dir,ownerId:'owner'});
  let preflights=0,modelCalls=0;
  const adapter={models:async()=>{modelCalls++;return [{provider:'deepseek-official',models:[{id:'deepseek-flash'}]}];},preflight:async()=>{preflights++;return {ok:true};},followup:async()=>{throw new Error('unexpected dispatch');}};
  const service=new BridgeService({store,adapter});
  service.kick=()=>{};
  const env={dir,store,service,counts:()=>({preflights,modelCalls})};
  t.after(async()=>{if(env.runtime)await env.runtime.close();service.close();env.store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return env;
}
function projectFixture(t,submittedBy){
  const env=fixture(t),{dir,store,service}=env;
  const config=normalizeProjectConfig({enabled:true,reserveSlots:1});
  const supervisor=new BridgeSupervisor({ownerId:'owner',ledger:new HostReservationLedger({limit:16,id:`identity-${submittedBy}`})});
  env.runtime=new SupervisorProjectRuntime({store,service,supervisor,config});
  const p=validatePacket(packet(dir,'parent',{rootCallback:{grantId:'grant'},project:{maxWorkers:2,maxConcurrentWorkers:2,maxRepairAttempts:1,maxTotalRetries:2,maxWorkerStarts:4,maxTotalToolCalls:1000,timeoutMs:3600000,reserveSlots:1,workerScope:{readRoots:[dir],writeRoots:[dir],allowedTools:['read','write'],allowNetwork:false},workspace:{repository:dir,baseRef:'HEAD'}}}));
  const project=createProjectRecord({packet:p,grant:resolveProjectGrant(p.project,config),now:Date.now()});
  env.parent=store.submit(p,{submittedBy,via:submittedBy===null?null:via,effectiveModel:model,project}).task;
  env.runtime.admitProject(env.parent.id);
  env.runtime.workerCreate({taskId:env.parent.id,args:{workerKey:'reader',objective:'read bounded input',role:'review',tools:['read']}});
  env.runtime.planFinalize({taskId:env.parent.id});
  env.config=config;env.supervisor=supervisor;
  return env;
}
async function startWorker(env){
  await env.runtime.onSupervisorFinished(env.parent.id,{status:'completed',stopConfirmed:true,activeJobs:0});
  await env.runtime.whenIdle(env.parent.id);
  return env.store.get(env.parent.id).project.workers[0].attempts[0];
}

test('service requires explicit identity before adapter work and isolates each principal',async t=>{
  const {dir,store,service,counts}=fixture(t),p=packet(dir);
  for(const identity of [undefined,null,{}, {submittedBy:'codex'}, {via:null}])await assert.rejects(service.submit(p,identity),{code:'AUTH_UNAVAILABLE'});
  assert.deepEqual(counts(),{preflights:0,modelCalls:0});assert.equal(store.list().length,0);
  const principals=['claude-code','codex','operator','legacy',null];
  const tasks=await Promise.all(principals.map(submittedBy=>service.submit(p,{submittedBy,via})));
  assert.equal(new Set(tasks.map(t=>t.id)).size,principals.length);
  for(const [i,submittedBy] of principals.entries()){
    const replay=await service.submit(p,{submittedBy,via:null});assert.equal(replay.id,tasks[i].id);assert.deepEqual(replay.via,via);
    assert.deepEqual(service.list({submittedBy}).map(t=>t.id),[tasks[i].id]);
    await assert.rejects(service.submit({...p,title:'changed'},{submittedBy,via:null}),{code:'IDEMPOTENCY_CONFLICT'});
  }
  assert.equal(counts().preflights,principals.length);
});

test('metadata, parentTaskId and declared via never supply submission authority; all read projections retain identity',async t=>{
  const {dir,store,service}=fixture(t);
  const parent=await service.submit(packet(dir,'parent'),{submittedBy:'claude-code',via:null});
  const task=await service.submit(packet(dir,'child',{parentTaskId:parent.id,metadata:{controller:'claude-code',submittedBy:'operator',rootTask:'hint'}}),{submittedBy:'codex',via});
  assert.equal(task.submittedBy,'codex');
  store.update(task.id,{status:'completed',sessionId:'s',requestId:'r',dispatchReceiptAt:1,result:{text:'first',evidence:[],checks:[],uncertainties:[]}});
  const before=store.get(task.id);
  const followup=service.followup(task.id,{revision:1,afterAttemptId:before.attemptId,followupId:'f1',text:'next'});
  assert.equal(typeof followup?.then,'undefined','followup stays synchronous');
  const dossier=service.dossier(task.id);
  assert.equal(dossier.controller,'claude-code');assert.equal(dossier.rootTask,'hint');
  for(const projection of [service.get(task.id),(await service.wait(task.id)).task,service.result(task.id),service.result(task.id,{attemptId:before.attemptId}),dossier]){
    assert.equal(projection.submittedBy,'codex');assert.deepEqual(projection.via,via);
  }
  assert.equal(service.result(task.id,{attemptId:before.attemptId}).text,'first');
  assert.equal(dossier.rounds.length,2);
});

for(const submittedBy of ['claude-code','codex','operator','legacy',null]){
  test(`internal workers, repair and restart retain parent identity ${submittedBy}`,async t=>{
    const env=projectFixture(t,submittedBy);
    const first=await startWorker(env);
    const child=env.store.get(first.taskId);
    assert.equal(child.submittedBy,submittedBy);assert.deepEqual(child.via,env.parent.via);
    env.store.update(child.id,{status:'failed',stopConfirmed:true,activeJobs:0,activeChildren:0,result:{text:'repair needed'}});
    await env.runtime.onTaskSettled(env.store.get(child.id));await env.runtime.whenIdle(env.parent.id);
    const attempts=env.store.get(env.parent.id).project.workers[0].attempts;
    assert.equal(attempts.length,2);
    const repaired=env.store.get(attempts[1].taskId);
    assert.equal(repaired.submittedBy,submittedBy);assert.deepEqual(repaired.via,env.parent.via);
    await env.runtime.close();env.store.close();
    env.store=new TaskStore({directory:env.dir,ownerId:'owner'});env.service.store=env.store;
    env.runtime=new SupervisorProjectRuntime({store:env.store,service:env.service,supervisor:env.supervisor,config:env.config});
    const before=env.store.list().length;
    await env.runtime.recoverProject(env.store.get(env.parent.id));await env.runtime.whenIdle(env.parent.id);
    assert.equal(env.store.list().length,before);
    assert.equal(env.store.get(repaired.id).submittedBy,submittedBy);assert.deepEqual(env.store.get(repaired.id).via,env.parent.via);
  });
}

for(const submittedBy of ['codex',null])for(const inserted of [false,true]){
  test(`failed worker submit looks up only parent namespace ${submittedBy}; inserted=${inserted}`,async t=>{
    const env=projectFixture(t,submittedBy);
    const submit=env.service.submit.bind(env.service);
    let foreignId,ownedId;
    env.service.submit=async(p,identity)=>{
      const foreign=env.store.submit(validatePacket(p),{submittedBy:'foreign-controller',via:null});foreignId=foreign.task.id;
      if(inserted)ownedId=(await submit(p,identity)).id;
      throw new Error('injected submission failure');
    };
    const attempt=await startWorker(env);
    assert.notEqual(attempt.taskId,foreignId);
    assert.equal(attempt.taskId,inserted?ownedId:null);
    assert.equal(attempt.state,inserted?'unknown':'failed');
    if(inserted)assert.equal(env.store.get(ownedId).submittedBy,submittedBy);
  });
}

test('foreign same-key worker settlement cannot link or mutate the parent; restart rejects foreign binding',async t=>{
  const env=projectFixture(t,'codex');
  const submit=env.service.submit.bind(env.service);
  let foreignId,settlement;
  env.service.submit=async(p,identity)=>{
    const foreign=env.store.submit(validatePacket(p),{submittedBy:'claude-code',via:null}).task;foreignId=foreign.id;
    env.store.update(foreign.id,{status:'completed',result:{text:'foreign evidence'}});
    const before=env.store.get(env.parent.id),events=env.store.events(env.parent.id);
    await env.runtime.onTaskSettled(env.store.get(foreign.id));
    settlement={before,events,after:env.store.get(env.parent.id),afterEvents:env.store.events(env.parent.id)};
    return submit(p,identity);
  };
  const attempt=await startWorker(env);assert.notEqual(attempt.taskId,foreignId);
  assert.deepEqual(settlement.after,settlement.before);assert.deepEqual(settlement.afterEvents,settlement.events);
  // Exercise recovery's ownership proof against a persisted foreign task pointer.
  env.store.update(env.parent.id,t=>{t.project.workers[0].attempts[0].taskId=foreignId;return t;});
  const report=await env.runtime.recoverProject(env.store.get(env.parent.id));
  assert.equal(report.resumed,false);assert.equal(report.reason,'host-restart-fail-closed');
  assert.equal(env.store.get(env.parent.id).stopConfirmed,false);
});
