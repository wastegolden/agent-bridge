// Regression tests for the persisted dispatch-pending lifecycle.
//
// Contract: evidence/upgrade-20260925/LIFECYCLE-CONTRACT.md (20260925.2).
//
// A dispatch that the adapter refuses with an explicit `dispatched:false` is a
// definite non-dispatch: no prompt crossed the host boundary, so no receipt can
// ever arrive and the persisted `dispatchPending` marker must be cleared for that
// same attempt, with the refusal retained as evidence. An ambiguous failure stays
// unknown and pending, a result that precedes the receipt never clears the marker,
// and a late failure from a superseded attempt cannot clear or settle a newer one.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {TaskStore} from '../src/store.mjs';import {BridgeService} from '../src/service.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await sleep(5);}assert.fail('condition timed out');}
function makePacket(root,key,extra={}){return {schemaVersion:1,idempotencyKey:key,revision:1,projectId:'project',title:key,objective:'bounded read',cwd:root,role:'investigate',acceptance:['evidence'],scope:{readRoots:[root],writeRoots:[],allowedTools:['read_file'],allowShell:false,allowNetwork:false,allowDelegation:false},materials:[],contractVersion:'1',...extra};}
function receiptFor(task,requestId){return {sessionId:`session-${task.id}`,requestId,effectiveModel:task.effectiveModel,effectivePolicy:{fileScope:'hard'}};}
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-dispatch-'));const store=new TaskStore({directory,ownerId:'owner'});
 const calls={starts:[],continues:[],reconsiders:[],archives:[]};
 const adapter={
  models:async()=>[{provider:'deepseek-official',models:[{id:'deepseek-flash'}]}],capabilities:async()=>({}),
  start:async(task,cb)=>{calls.starts.push({task,cb});return receiptFor(task,`request-start-${task.attempt}`);},
  continue:async(task,understanding,cb)=>{calls.continues.push({task,understanding,cb});return {sessionId:task.sessionId,requestId:`request-continue-${task.attempt}`,effectiveModel:task.effectiveModel,effectivePolicy:{fileScope:'hard'}};},
  reconsider:async(task,cb)=>{calls.reconsiders.push({task,cb});return {sessionId:task.sessionId,requestId:`request-reconsider-${task.attempt}`,effectiveModel:task.effectiveModel,effectivePolicy:{fileScope:'hard'}};},
  cancel:async()=>({accepted:true,stopConfirmed:true,remaining:[]}),inspect:async()=>({status:'unknown',stopConfirmed:false}),cleanup:async()=>({cleaned:true}),
  archive:async(task)=>{calls.archives.push(task.sessionId);return {archived:true,uiHidden:true,sessionId:task.sessionId,workspacePreserved:true,evidencePreserved:true};}
 };
 const service=new BridgeService({store,adapter,maxConcurrent:4});
 return {directory,store,adapter,service,calls,close(){service.close();store.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
// Drive a gated task to a stopped understanding with its dispatch receipt persisted.
async function understood(f,key,text='understanding text'){
 const submitted=await f.service.submit(makePacket(f.directory,key,{understandingRequired:true}));
 await until(()=>f.calls.starts.length===1);
 await until(()=>Number.isFinite(f.store.get(submitted.id).dispatchReceiptAt));
 const call=f.calls.starts.find(s=>s.task.id===submitted.id);
 call.cb.onResult({status:'completed',text,evidence:[],checks:[],uncertainties:[],stopConfirmed:true,activeJobs:0});
 await until(()=>f.service.get(submitted.id).status==='awaiting_approval');
 const task=f.store.get(submitted.id);
 return {id:submitted.id,attemptId:task.attemptId,hash:task.understandingHash,sessionId:task.sessionId};
}
test('successful initial understanding persists the receipt and clears dispatch-pending',async()=>{
 const f=fixture();try{
  const t=await f.service.submit(makePacket(f.directory,'understanding-ok',{understandingRequired:true}));
  await until(()=>f.calls.starts.length===1);
  await until(()=>Number.isFinite(f.store.get(t.id).dispatchReceiptAt));
  const running=f.store.get(t.id);
  assert.equal(running.sessionId,`session-${t.id}`);
  assert.equal(running.status,'running');
  assert.equal(running.dispatchStarted,true);
  assert.equal(running.dispatchPending,false);
  assert.equal(running.dispatchFailure,undefined);
  const call=f.calls.starts.find(s=>s.task.id===t.id);
  call.cb.onResult({status:'completed',text:'understood the task',stopConfirmed:true,activeJobs:0});
  await until(()=>f.service.get(t.id).status==='awaiting_approval');
  const gated=f.store.get(t.id);
  assert.equal(gated.status,'awaiting_approval');
  assert.equal(gated.phase,'awaiting_approval');
  assert.equal(gated.dispatchPending,false);
  assert.equal(gated.stopConfirmed,true);
  assert.equal(gated.activeJobs,0);
  assert.equal(typeof gated.understandingHash,'string');
  assert.equal(gated.understandingHash.length,64);
  assert.equal(gated.understandingGeneration,0);
  assert.ok(f.store.events(t.id).some(e=>e.type==='task/accepted'&&e.sessionId===`session-${t.id}`));
 }finally{f.close();}
});
test('clarification reconsider dispatches in the same session with a fresh attempt and immutable packet',async()=>{
 const f=fixture();try{
  const ready=await understood(f,'clarify-ok');
  const before=f.store.get(ready.id);
  f.service.clarify(ready.id,{revision:1,understandingHash:ready.hash,clarificationId:'c-1',text:'also verify the receipt path'});
  await until(()=>f.calls.reconsiders.length===1);
  const host=f.calls.reconsiders[0].task;
  assert.equal(host.id,ready.id);
  assert.equal(host.sessionId,ready.sessionId);
  assert.equal(host.continuationKind,'clarification');
  assert.equal(host.executionApproved,false);
  assert.equal(f.calls.starts.length,1,'clarification must never start a second session');
  assert.equal(f.calls.continues.length,0);
  assert.ok(host.prompt.includes('also verify the receipt path'),'clarification text is dispatched as untrusted context');
  const dispatched=f.store.get(ready.id);
  assert.notEqual(dispatched.attemptId,ready.attemptId);
  assert.equal(dispatched.understandingGeneration,1);
  assert.equal(dispatched.sessionId,ready.sessionId);
  assert.deepEqual(dispatched.packet,before.packet);
  assert.deepEqual(dispatched.effectivePacket,before.effectivePacket);
  assert.equal(dispatched.requestHash,before.requestHash);
  assert.equal(dispatched.revision,before.revision);
  await until(()=>Number.isFinite(f.store.get(ready.id).dispatchReceiptAt));
  const call=f.calls.reconsiders[0];
  call.cb.onResult({status:'completed',text:'revised understanding',stopConfirmed:true,activeJobs:0});
  await until(()=>f.service.get(ready.id).status==='awaiting_approval');
  const gated=f.store.get(ready.id);
  assert.equal(gated.understandingGeneration,1);
  assert.equal(gated.dispatchPending,false);
  assert.ok(Number.isFinite(gated.dispatchReceiptAt));
  assert.notEqual(gated.understandingHash,ready.hash,'a new generation mints a new understanding hash');
  assert.throws(()=>f.service.approve(ready.id,{revision:1,understandingHash:ready.hash}),{code:'APPROVAL_CONFLICT'});
  f.service.approve(ready.id,{revision:1,understandingHash:gated.understandingHash});
  await until(()=>f.calls.continues.length===1);
  assert.equal(f.calls.continues[0].task.sessionId,ready.sessionId);
  assert.equal(f.calls.continues[0].task.executionApproved,true);
  assert.equal(f.calls.continues[0].task.continuationKind,null);
  assert.equal(f.calls.starts.length,1);
 }finally{f.close();}
});
test('a definite reconsider non-dispatch clears persisted pending and permits acknowledgement and archive',async()=>{
 const f=fixture();try{
  const ready=await understood(f,'clarify-refused');
  f.adapter.reconsider=async(task,cb)=>{f.calls.reconsiders.push({task,cb});const error=new Error('reconsider refused: envelope mismatch');error.code='adapter/envelope';error.dispatched=false;throw error;};
  f.service.clarify(ready.id,{revision:1,understandingHash:ready.hash,clarificationId:'c-2',text:'clarify me'});
  await until(()=>f.service.get(ready.id).status==='failed');
  const failed=f.store.get(ready.id);
  assert.equal(failed.status,'failed');
  assert.equal(failed.dispatchStarted,true);
  assert.equal(failed.dispatchPending,false,'a definite non-dispatch must not strand the pending marker');
  assert.equal(failed.dispatchFailure.dispatched,false);
  assert.equal(failed.dispatchFailure.code,'adapter/envelope');
  assert.match(failed.dispatchFailure.message,/envelope mismatch/);
  assert.equal(failed.dispatchFailure.attemptId,failed.attemptId);
  assert.ok(Number.isFinite(failed.dispatchFailure.at));
  assert.match(failed.error.message,/envelope mismatch/);
  assert.equal(failed.result.text,'reconsider refused: envelope mismatch');
  assert.equal(failed.stopConfirmed,true);
  assert.equal(failed.activeJobs,0);
  assert.ok(f.store.events(ready.id).some(e=>e.type==='task/dispatch-failed'&&e.dispatched===false&&e.attemptId===failed.attemptId));
  assert.equal(f.calls.reconsiders.length,1,'a definite non-dispatch is recorded once and never replayed');
  assert.equal(f.calls.starts.length,1,'no new session was started');
  const acknowledged=f.service.acknowledge(ready.id,{revision:1,accepted:false});
  assert.equal(acknowledged.resultCollected,true);
  const archived=await f.service.archive(ready.id,{revision:1});
  assert.equal(archived.archived,true);
  assert.equal(archived.uiHidden,true);
  assert.equal(archived.evidencePreserved,true);
  assert.equal(archived.workspacePreserved,true);
  assert.deepEqual(f.calls.archives,[ready.sessionId]);
  assert.ok(Number.isFinite(f.store.get(ready.id).sessionArchivedAt));
  assert.equal(f.store.get(ready.id).archivedAt,undefined,'UI archive must not write the physical cleanup marker');
 }finally{f.close();}
});
test('an ambiguous reconsider failure stays unknown, keeps pending, and is never replayed',async()=>{
 const f=fixture();try{
  const ready=await understood(f,'clarify-unknown');
  let reconsiderCalls=0;
  f.adapter.reconsider=async()=>{reconsiderCalls++;throw new Error('transport lost after possible acceptance');};
  f.service.clarify(ready.id,{revision:1,understandingHash:ready.hash,clarificationId:'c-3',text:'clarify me'});
  await until(()=>f.service.get(ready.id).status==='unknown');
  const unknown=f.store.get(ready.id);
  assert.equal(unknown.dispatchStarted,true);
  assert.equal(unknown.dispatchPending,true,'an unknown dispatch outcome must stay pending');
  assert.equal(unknown.stopConfirmed,false);
  assert.equal(unknown.dispatchFailure,undefined,'an ambiguous failure is not evidence of non-dispatch');
  assert.equal(reconsiderCalls,1);
  await f.service.recover();
  await sleep(20);
  assert.equal(reconsiderCalls,1,'recovery must never replay an ambiguous dispatch');
  assert.equal(f.store.get(ready.id).dispatchPending,true);
  assert.equal(f.store.get(ready.id).status,'unknown');
  assert.throws(()=>f.service.acknowledge(ready.id,{revision:1}),{code:'ACK_CONFLICT'});
  await assert.rejects(()=>f.service.archive(ready.id,{revision:1}),{code:'ARCHIVE_CONFLICT'});
 }finally{f.close();}
});
test('a terminal result before the dispatch receipt never clears persisted pending',async()=>{
 const f=fixture();try{
  let release;
  f.adapter.start=(task,cb)=>{f.calls.starts.push({task,cb});return new Promise(resolve=>{release=()=>resolve(receiptFor(task,'request-late'));});};
  const submitted=await f.service.submit(makePacket(f.directory,'result-first'));
  await until(()=>f.calls.starts.length===1);
  f.calls.starts[0].cb.onResult({status:'completed',text:'done before receipt',stopConfirmed:true,activeJobs:0});
  await until(()=>f.service.get(submitted.id).status==='completed');
  const early=f.store.get(submitted.id);
  assert.equal(early.dispatchPending,true,'finish must not clear pending merely because it is terminal');
  f.service.acknowledge(submitted.id,{revision:1,accepted:true});
  await assert.rejects(()=>f.service.archive(submitted.id,{revision:1}),{code:'ARCHIVE_CONFLICT'});
  release();
  await until(()=>f.store.get(submitted.id).dispatchPending===false);
  assert.ok(Number.isFinite(f.store.get(submitted.id).dispatchReceiptAt));
  const archived=await f.service.archive(submitted.id,{revision:1});
  assert.equal(archived.archived,true);
 }finally{f.close();}
});
test('approval refuses an understanding whose dispatch receipt is still pending',async()=>{
 const f=fixture();try{
  let release;
  f.adapter.start=(task,cb)=>{f.calls.starts.push({task,cb});return new Promise(resolve=>{release=()=>resolve(receiptFor(task,'request-race'));});};
  const submitted=await f.service.submit(makePacket(f.directory,'receipt-race',{understandingRequired:true}));
  await until(()=>f.calls.starts.length===1);
  f.calls.starts[0].cb.onResult({status:'completed',text:'understood before receipt',stopConfirmed:true,activeJobs:0});
  await until(()=>f.service.get(submitted.id).status==='awaiting_approval');
  const racing=f.store.get(submitted.id);
  assert.equal(racing.dispatchPending,true);
  assert.throws(()=>f.service.approve(submitted.id,{revision:1,understandingHash:racing.understandingHash}),{code:'APPROVAL_CONFLICT'});
  assert.throws(()=>f.service.clarify(submitted.id,{revision:1,understandingHash:racing.understandingHash,clarificationId:'c-race',text:'x'}),{code:'SESSION_NOT_READY'});
  release();
  await until(()=>f.store.get(submitted.id).dispatchPending===false);
  assert.ok(Number.isFinite(f.store.get(submitted.id).dispatchReceiptAt));
  f.service.approve(submitted.id,{revision:1,understandingHash:f.store.get(submitted.id).understandingHash});
  await until(()=>f.calls.continues.length===1);
  assert.equal(f.calls.continues[0].task.sessionId,`session-${submitted.id}`);
 }finally{f.close();}
});
test('approval requires a nonblank persisted session',async()=>{
 const f=fixture();try{
  f.adapter.start=async(task,cb)=>{f.calls.starts.push({task,cb});return {sessionId:'',requestId:'request-blank',effectiveModel:task.effectiveModel,effectivePolicy:{fileScope:'hard'}};};
  const submitted=await f.service.submit(makePacket(f.directory,'blank-session',{understandingRequired:true}));
  await until(()=>f.calls.starts.length===1);
  await until(()=>Number.isFinite(f.store.get(submitted.id).dispatchReceiptAt));
  f.calls.starts[0].cb.onResult({status:'completed',text:'understood',stopConfirmed:true,activeJobs:0});
  await until(()=>f.service.get(submitted.id).status==='awaiting_approval');
  const gated=f.store.get(submitted.id);
  assert.equal(gated.sessionId,'');
  assert.equal(gated.dispatchPending,false);
  assert.ok(Number.isFinite(gated.dispatchReceiptAt));
  assert.throws(()=>f.service.approve(submitted.id,{revision:1,understandingHash:gated.understandingHash}),{code:'APPROVAL_CONFLICT'});
 }finally{f.close();}
});
test('a late failure from a superseded attempt cannot clear or settle the newer attempt',async()=>{
 const f=fixture();try{
  // Attempt 1 delivers an understanding result while its dispatch promise stays open,
  // so no receipt is ever persisted for it and its pending marker stays set.
  let rejectFirst;let firstRejected=false;
  f.adapter.start=(task,cb)=>{f.calls.starts.push({task,cb});return new Promise((resolve,reject)=>{rejectFirst=reject;});};
  const submitted=await f.service.submit(makePacket(f.directory,'stale-error',{understandingRequired:true}));
  await until(()=>f.calls.starts.length===1);
  f.calls.starts[0].cb.onResult({status:'completed',text:'first understanding',stopConfirmed:true,activeJobs:0});
  await until(()=>f.service.get(submitted.id).status==='awaiting_approval');
  const firstAttempt=f.store.get(submitted.id).attemptId;
  const firstUnderstanding=f.store.get(submitted.id).understanding;
  // Fault injection: attempt 1's dispatch promise is still open, so the real approve()
  // path must and does refuse (no persisted receipt, pending marker still set) and no
  // second attempt could exist through the public API. Mint attempt 2 through the
  // low-level store.beginAttempt exactly as the approval CAS would, and hand it the
  // known session binding attempt 1 never received, so the forced attempt takes the
  // continue-known-session path instead of starting a second session. This bypasses
  // public approval deliberately, to exercise the defensive stale-attempt fence.
  const knownSession=`session-${submitted.id}`;
  f.store.update(submitted.id,{sessionId:knownSession});
  let resolveSecond;let secondSettled=false;
  f.adapter.continue=(task,understanding,cb)=>{f.calls.continues.push({task,understanding,cb});return new Promise(resolve=>{resolveSecond=()=>{secondSettled=true;resolve({sessionId:task.sessionId,requestId:'request-second',effectiveModel:task.effectiveModel,effectivePolicy:{fileScope:'hard'}});};});};
  f.store.beginAttempt(submitted.id,{executionApproved:true,status:'queued',phase:'queued',continuationKind:null,dispatchStarted:false,dispatchPending:false,dispatchReceiptAt:null,requestId:null});
  f.service.kick();
  await until(()=>f.calls.continues.length===1);
  await until(()=>f.store.get(submitted.id).dispatchPending===true);
  const secondAttempt=f.store.get(submitted.id).attemptId;
  assert.notEqual(secondAttempt,firstAttempt);
  assert.equal(f.calls.starts.length,1,'the forced attempt must reuse the known session, never start a second one');
  assert.equal(f.calls.continues[0].task.id,submitted.id);
  assert.equal(f.calls.continues[0].task.sessionId,knownSession);
  assert.equal(f.calls.continues[0].task.executionApproved,true);
  assert.equal(f.calls.continues[0].understanding,firstUnderstanding);
  const stale=new Error('stale envelope refusal');stale.code='adapter/envelope';stale.dispatched=false;
  firstRejected=true;rejectFirst(stale);
  await sleep(30);
  const after=f.store.get(submitted.id);
  assert.equal(after.attemptId,secondAttempt);
  assert.equal(after.status,'starting','the stale failure must not settle the newer attempt');
  assert.equal(after.dispatchPending,true,'the newer attempt keeps its own pending dispatch');
  assert.equal(after.dispatchFailure,undefined,'the stale failure must not be recorded against the newer attempt');
  assert.equal(after.sessionId,knownSession,'the stale failure must not rewrite the newer attempt session');
  assert.ok(!f.store.events(submitted.id).some(e=>e.type==='task/dispatch-failed'),'no non-dispatch evidence may be recorded for the stale refusal');
  assert.ok(!f.store.events(submitted.id).some(e=>e.type==='task/settled'&&e.attemptId===secondAttempt),'the stale failure must not settle the newer attempt');
  resolveSecond();
  await until(()=>f.store.get(submitted.id).status==='running');
  const settled=f.store.get(submitted.id);
  assert.equal(settled.dispatchPending,false);
  assert.equal(settled.sessionId,knownSession);
  assert.equal(settled.requestId,'request-second');
  assert.ok(Number.isFinite(settled.dispatchReceiptAt));
  f.calls.continues[0].cb.onResult({status:'completed',text:'executed',stopConfirmed:true,activeJobs:0});
  await until(()=>f.service.get(submitted.id).status==='completed');
 }finally{
  // A failed assertion above can leave a dispatch promise open; settle every still-open
  // one before teardown so a timing-out run never strands a pending hazard.
  if(typeof rejectFirst==='function'&&!firstRejected){firstRejected=true;rejectFirst(new Error('test cleanup settled the abandoned first dispatch'));}
  if(typeof resolveSecond==='function'&&!secondSettled)resolveSecond();
  await sleep(0);
  f.close();
 }
});
test('a service-side pre-dispatch refusal is an explicit non-dispatch that clears pending',async()=>{
 const f=fixture();try{
  const ready=await understood(f,'clarify-unsupported');
  f.service.clarify(ready.id,{revision:1,understandingHash:ready.hash,clarificationId:'c-4',text:'clarify me'});
  // The capability disappears between scheduling and dispatch; no adapter call is made.
  delete f.adapter.reconsider;
  await until(()=>f.service.get(ready.id).status==='failed');
  const failed=f.store.get(ready.id);
  assert.equal(failed.dispatchPending,false);
  assert.equal(failed.dispatchStarted,true);
  assert.equal(failed.dispatchFailure.dispatched,false);
  assert.equal(failed.dispatchFailure.code,'CLARIFICATION_UNSUPPORTED');
  assert.equal(failed.dispatchFailure.attemptId,failed.attemptId);
  assert.equal(failed.error.code,'CLARIFICATION_UNSUPPORTED');
  assert.equal(failed.stopConfirmed,true);
  assert.equal(failed.activeJobs,0);
  assert.equal(f.calls.reconsiders.length,0,'the adapter was never reached');
  assert.equal(f.calls.starts.length,1,'the existing session was reused, not replaced');
  f.service.acknowledge(ready.id,{revision:1,accepted:false});
  const archived=await f.service.archive(ready.id,{revision:1});
  assert.equal(archived.archived,true);
 }finally{f.close();}
});
