import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {TaskStore} from '../src/store.mjs';import {BridgeService} from '../src/service.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function makePacket(root,key,extra={}){return {schemaVersion:1,idempotencyKey:key,revision:1,projectId:'project',title:key,objective:'bounded read',cwd:root,role:'investigate',acceptance:['evidence'],scope:{readRoots:[root],writeRoots:[],allowedTools:['read_file'],allowShell:false,allowNetwork:false,allowDelegation:false},materials:[],contractVersion:'1',...extra};}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await sleep(10);}assert.fail('condition timed out');}
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-service-'));const store=new TaskStore({directory,ownerId:'owner'});const starts=[];const callbacks=new Map();
 const adapter={models:async()=>[{provider:'deepseek-official',models:[{id:'deepseek-flash'}]}],capabilities:async()=>({}),
 start:async(task,cb)=>{starts.push(task);callbacks.set(task.id,cb);return {sessionId:`session-${task.id}`,requestId:`request-${task.id}`,effectiveModel:task.effectiveModel,effectivePolicy:{fileScope:'hard'}};},
 continue:async(task,u,cb)=>adapter.start(task,cb),cancel:async()=>({accepted:true,stopConfirmed:true,remaining:[]}),inspect:async()=>({status:'unknown',stopConfirmed:false}),cleanup:async()=>({cleaned:true})};
 const service=new BridgeService({store,adapter,maxConcurrent:2});const done=(id,text='done')=>callbacks.get(id).onResult({status:'completed',text,stopConfirmed:true,activeJobs:0});
 return {directory,store,adapter,starts,service,done,close(){service.close();store.close();fs.rmSync(directory,{recursive:true});}};
}
test('parallel independent tasks, dependencies wait for controller acceptance, idempotent retry',async()=>{
 const f=fixture();try{
  const a=await f.service.submit(makePacket(f.directory,'a'));const b=await f.service.submit(makePacket(f.directory,'b'));
  const c=await f.service.submit(makePacket(f.directory,'c',{dependencies:[a.id]}));await until(()=>f.starts.length===2);
  assert.equal((await f.service.submit(makePacket(f.directory,'a'))).id,a.id);assert.equal(f.starts.length,2);
  f.done(a.id,'x'.repeat(25001));await sleep(20);assert.equal(f.starts.length,2);
  assert.equal(f.service.result(a.id,{offset:20000}).text.length,5001);assert.equal(f.service.result(a.id).hasMore,true);
  f.service.acknowledge(a.id,{revision:1,accepted:true});await until(()=>f.starts.length===3);assert.equal(f.starts[2].id,c.id);f.done(b.id);f.done(c.id);
 }finally{f.close();}
});
test('understanding is gated by exact revision and returned understanding hash',async()=>{
 const f=fixture();try{
  const task=await f.service.submit(makePacket(f.directory,'gate',{understandingRequired:true}));await until(()=>f.starts.length===1);f.done(task.id,'Only read file A');
  const t=f.service.get(task.id);assert.equal(t.status,'awaiting_approval');assert.equal(f.starts.length,1);
  assert.throws(()=>f.service.approve(task.id,{revision:2,understandingHash:t.understandingHash}),{code:'APPROVAL_CONFLICT'});
  f.service.approve(task.id,{revision:1,understandingHash:t.understandingHash});await until(()=>f.starts.length===2);assert.equal(f.starts[1].executionApproved,true);f.done(task.id);
 }finally{f.close();}
});
test('completed results expose the final reply while progress remains in events',async()=>{
 const f=fixture();try{
  const t=await f.service.submit(makePacket(f.directory,'structured-final'));await until(()=>f.starts.length===1);
  f.service.onEvent(t.id,f.starts[0].attemptId,{type:'assistant/message',text:'Checking required material'});
  f.service.finish(t.id,{status:'completed',text:'Checking required material\n{"status":"blocked"}',finalText:'{"status":"blocked"}',stopConfirmed:true,activeJobs:0});
  assert.deepEqual(JSON.parse(f.service.result(t.id).text),{status:'blocked'});
  assert.ok(f.store.events(t.id).some(e=>e.text==='Checking required material'));
  const u=await f.service.submit(makePacket(f.directory,'failed-partial'));await until(()=>f.starts.length===2);
  f.service.finish(u.id,{status:'failed',text:'partial diagnostics',finalText:'not a completed result',stopConfirmed:true,activeJobs:0});
  assert.equal(f.service.result(u.id).text,'partial diagnostics');
 }finally{f.close();}
});
test('an empty completed handoff is the result while progress and failure text stay diagnostic',async()=>{
 const f=fixture();try{
  const t=await f.service.submit(makePacket(f.directory,'empty-final'));await until(()=>f.starts.length===1);
  f.service.onEvent(t.id,f.starts[0].attemptId,{type:'assistant/message',text:'progress line'});
  f.service.finish(t.id,{status:'completed',text:'progress line',finalText:'',stopConfirmed:true,activeJobs:0});
  assert.equal(f.service.get(t.id).status,'completed');
  // The explicit empty handoff is the result; accumulated progress is not promoted.
  assert.equal(f.service.result(t.id).text,'');
  assert.ok(f.store.events(t.id).some(e=>e.type==='assistant/message'&&e.text==='progress line'));
  const legacy=await f.service.submit(makePacket(f.directory,'legacy-no-final'));await until(()=>f.starts.length===2);
  f.service.finish(legacy.id,{status:'completed',text:'legacy text',stopConfirmed:true,activeJobs:0});
  assert.equal(f.service.result(legacy.id).text,'legacy text');
  const failed=await f.service.submit(makePacket(f.directory,'failed-diagnostic'));await until(()=>f.starts.length===3);
  f.service.finish(failed.id,{status:'failed',text:'partial diagnostics',finalText:'',stopConfirmed:true,activeJobs:0});
  assert.equal(f.service.get(failed.id).status,'failed');
  assert.equal(f.service.result(failed.id).text,'partial diagnostics');
  assert.ok(f.store.events(failed.id).some(e=>e.type==='task/settled'&&e.status==='failed'));
 }finally{f.close();}
});
test('cancel must distinguish acknowledgement from confirmed stopping',async()=>{
 const f=fixture();try{
  f.adapter.cancel=async()=>({accepted:true,stopConfirmed:false,remaining:['owned job']});
  const task=await f.service.submit(makePacket(f.directory,'cancel'));await until(()=>f.starts.length===1);
  const cancelled=await f.service.cancel(task.id);assert.equal(cancelled.status,'cancelling');assert.equal(cancelled.stopConfirmed,false);
  f.adapter.cancel=async()=>({accepted:true,stopConfirmed:true,remaining:[]});await f.service.cancel(task.id);assert.equal(f.service.get(task.id).status,'cancelled');
 }finally{f.close();}
});
test('recovery never replays an ambiguously submitted task',async()=>{
 const f=fixture();try{
  const task=await f.service.submit(makePacket(f.directory,'recover'));await until(()=>f.starts.length===1);f.service.close();
  const other=new BridgeService({store:f.store,adapter:f.adapter});await other.recover();await sleep(20);assert.equal(other.get(task.id).status,'unknown');assert.equal(f.starts.length,1);other.close();
 }finally{f.close();}
});
test('lost dispatch receipt stays unknown and consumes concurrency until reconciled',async()=>{
 const f=fixture();try{
  f.service.maxConcurrent=1;f.adapter.start=async()=>{throw new Error('lost transport after possible acceptance');};
  const a=await f.service.submit(makePacket(f.directory,'lost'));await until(()=>f.service.get(a.id).status==='unknown');
  const b=await f.service.submit(makePacket(f.directory,'next'));await sleep(30);
  assert.equal(f.service.get(b.id).status,'queued');assert.equal(f.service.get(a.id).stopConfirmed,false);
 }finally{f.close();}
});
test('cancel before workspace creation finishes prevents host dispatch',async()=>{
 const f=fixture();try{
  let release;f.service.workspaces={create:()=>new Promise(resolve=>{release=resolve;})};
  const a=await f.service.submit(makePacket(f.directory,'slow-create',{workspace:{repository:f.directory,baseRef:'HEAD'}}));
  await until(()=>!!release);await f.service.cancel(a.id);release({path:f.directory});
  await until(()=>f.service.get(a.id).status==='cancelled');assert.equal(f.starts.length,0);
 }finally{f.close();}
});
test('late previous attempt callbacks cannot overwrite execution or its receipt',async()=>{
 const f=fixture();try{
  const a=await f.service.submit(makePacket(f.directory,'old-attempt',{understandingRequired:true}));await until(()=>f.starts.length===1);
  const old=f.starts[0];f.done(a.id,'understood');const gated=f.service.get(a.id);
  f.service.approve(a.id,{revision:1,understandingHash:gated.understandingHash});await until(()=>f.starts.length===2);
  f.service.finish(a.id,{status:'failed',text:'stale',stopConfirmed:true,activeJobs:0},old.attemptId);
  assert.equal(f.service.get(a.id).status,'running');f.done(a.id);assert.equal(f.service.result(a.id).text,'done');
 }finally{f.close();}
});
test('invalid packets create no task or adapter work and the corrected key may be reused',async()=>{
 const f=fixture();try{
  const narrowA=fs.mkdtempSync(path.join(f.directory,'narrow-a-'));const narrowB=fs.mkdtempSync(path.join(f.directory,'narrow-b-'));
  let modelCalls=0;const models=f.adapter.models;f.adapter.models=async()=>{modelCalls++;return models();};
  for(const schemaVersion of [undefined,'1','1.0',2]){
   const badSchema=makePacket(narrowA,'discover-key',{schemaVersion});
   await assert.rejects(()=>f.service.submit(badSchema),e=>e.code==='INVALID_PACKET'&&/integer 1/.test(e.message)&&/1\.0/.test(e.message)&&e.details?.field==='schemaVersion');
  }
  const narrow=makePacket(narrowA,'discover-key');
  const badCwd={...narrow,cwd:f.directory,scope:{...narrow.scope,readRoots:[narrowA,narrowB]}};
  await assert.rejects(()=>f.service.submit(badCwd),e=>e.code==='INVALID_SCOPE'&&/never widen readRoots/.test(e.message)&&e.details?.field==='cwd');
  assert.equal(modelCalls,0);assert.equal(f.starts.length,0);assert.deepEqual(f.store.list(),[]);
  const corrected={...badCwd,cwd:narrowA};
  const accepted=await f.service.submit(corrected);
  await until(()=>f.starts.length===1);f.done(accepted.id);
  assert.equal((await f.service.submit(corrected)).id,accepted.id);
  const stored=f.store.list();assert.equal(stored.length,1);assert.equal(stored[0].packet.idempotencyKey,'discover-key');assert.equal(stored[0].packet.revision,1);
  assert.deepEqual(stored[0].packet.scope.readRoots,[fs.realpathSync.native(narrowA),fs.realpathSync.native(narrowB)]);
 }finally{f.close();}
});
