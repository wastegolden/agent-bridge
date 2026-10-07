import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {createHash} from 'node:crypto';
import {TaskStore} from '../src/store.mjs';import {BridgeService} from '../src/service.mjs';import {TOOLS,createDispatcher,createMcpHandler} from '../src/mcp.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await sleep(5);}assert.fail('condition timed out');}

const MATERIAL_TEXT='MATERIAL SECRET TEXT';
const MATERIAL_HASH=createHash('sha256').update(MATERIAL_TEXT).digest('hex');
const TRUNCATED='…[truncated]\n';

function packet(root,extra={}){return {schemaVersion:1,idempotencyKey:'dossier-1',revision:1,projectId:'project',title:'Dossier task',objective:'Report one bounded task',cwd:root,role:'implement',acceptance:['evidence'],scope:{readRoots:[root],writeRoots:[root],allowedTools:['read','write'],allowShell:false,allowNetwork:false,allowDelegation:false},
 materials:[{text:MATERIAL_TEXT,version:'inline-1',sha256:MATERIAL_HASH},{path:'note.txt',version:'file-2'}],
 metadata:{controller:'codex',rootTask:'root-1'},contractVersion:'1',...extra};}

// Same shape as the service/store fixtures the other tests use: a real TaskStore plus a
// BridgeService whose adapter stub settles a chosen result through the stored callback.
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-dossier-'));
 fs.writeFileSync(path.join(directory,'note.txt'),'note body');
 const store=new TaskStore({directory,ownerId:'owner'});const starts=[];const callbacks=new Map();
 const adapter={models:async()=>[{provider:'deepseek-official',models:[{id:'deepseek-flash'}]}],capabilities:async()=>({}),
  start:async(task,cb)=>{starts.push(task);callbacks.set(task.id,cb);return {sessionId:`session-${task.id}`,requestId:`request-${task.id}`,effectiveModel:task.effectiveModel,effectivePolicy:{fileScope:'hard'}};},
  continue:async(task,u,cb)=>adapter.start(task,cb),cancel:async()=>({accepted:true,stopConfirmed:true,remaining:[]}),inspect:async()=>({status:'unknown',stopConfirmed:false})};
 const service=new BridgeService({store,adapter,maxConcurrent:2});
 const done=(id,text)=>callbacks.get(id).onResult({status:'completed',text,stopConfirmed:true,activeJobs:0});
 return {directory,store,adapter,starts,service,done,close(){service.close();store.close();fs.rmSync(directory,{recursive:true,force:true});}};
}

test('bridge_dossier returns a fresh closeout dossier that never copies material text or mutates the store',async()=>{
 const f=fixture();try{
  const submitted=await f.service.submit(packet(f.directory));
  await until(()=>f.starts.length===1);
  f.done(submitted.id,'the full result text');
  await until(()=>f.service.get(submitted.id).status==='completed');

  const longStdout='a'.repeat(2000)+'b'.repeat(8000);
  const longStderr='c'.repeat(5000);
  const storedArchive={archived:true,uiHidden:true,sessionId:`session-${submitted.id}`,workspacePreserved:true,evidencePreserved:true,at:1234};
  f.store.update(submitted.id,{
   review:{head:'deadbeef',passed:true,checks:[{command:'node',args:['--test'],stdout:longStdout,stderr:'short'}],nested:{stderr:longStderr}},
   refresh:{adopted:true,stdout:'d'.repeat(4000)},
   integration:{merged:false,accepted:false,stderr:'e'.repeat(4100)},
   resultCollected:true,accepted:true,artifactState:'preserved',pinned:true,archive:storedArchive
  });

  const before=JSON.stringify(f.store.get(submitted.id));
  const dossier=f.service.dossier(submitted.id);
  const again=f.service.dossier(submitted.id);

  // Exactly the specified keys, no more and no fewer.
  assert.deepEqual(Object.keys(dossier).sort(),['acknowledgement','archive','attempt','contractVersion','controller','createdAt','effectiveModel','integration','phase','projectId','refresh','request','result','review','revision','role','rootTask','schemaVersion','sessionId','stats','status','stop','taskId','title','updatedAt','workspace']);
  assert.deepEqual(Object.keys(dossier.request).sort(),['acceptance','budget','cwd','materials','metadata','model','objective','scope','workspace']);
  assert.deepEqual(Object.keys(dossier.acknowledgement).sort(),['accepted','artifactState','pinned','resultCollected']);
  assert.deepEqual(Object.keys(dossier.stop).sort(),['activeJobs','stopConfirmed']);
  assert.deepEqual(Object.keys(dossier.result).sort(),['available','totalChars']);

  assert.equal(dossier.schemaVersion,1);
  assert.equal(dossier.taskId,submitted.id);
  assert.equal(dossier.projectId,'project');
  assert.equal(dossier.title,'Dossier task');
  assert.equal(dossier.role,'implement');
  assert.equal(dossier.contractVersion,'1');
  assert.equal(dossier.status,'completed');
  assert.equal(dossier.phase,'completed');
  assert.equal(dossier.revision,1);
  assert.equal(dossier.attempt,1);
  assert.equal(typeof dossier.createdAt,'number');
  assert.equal(typeof dossier.updatedAt,'number');
  assert.equal(dossier.controller,'codex');
  assert.equal(dossier.rootTask,'root-1');
  assert.equal(dossier.sessionId,`session-${submitted.id}`);
  assert.equal(dossier.effectiveModel.model,'deepseek-flash');
  assert.equal(dossier.workspace,null);
  assert.equal(dossier.stats.toolCalls,0);

  const stored=f.store.get(submitted.id);
  assert.equal(dossier.request.objective,'Report one bounded task');
  assert.deepEqual(dossier.request.acceptance,['evidence']);
  assert.equal(dossier.request.cwd,fs.realpathSync.native(f.directory));
  assert.deepEqual(dossier.request.scope,stored.packet.scope);
  assert.deepEqual(dossier.request.budget,{timeoutMs:600000,maxToolCalls:100,maxOutputChars:200000});
  assert.equal(dossier.request.model,null);
  assert.equal(dossier.request.workspace,null);
  assert.deepEqual(dossier.request.metadata,{controller:'codex',rootTask:'root-1'});

  // Materials: shape and counts only, never the text itself.
  const materials=dossier.request.materials;
  assert.equal(materials.length,2);
  assert.deepEqual(Object.keys(materials[0]).sort(),['path','sha256','textChars','version']);
  assert.equal(materials[0].path,null);
  assert.equal(materials[0].version,'inline-1');
  assert.equal(materials[0].sha256,MATERIAL_HASH);
  assert.equal(materials[0].textChars,MATERIAL_TEXT.length);
  assert.equal(materials[1].path,fs.realpathSync.native(path.join(f.directory,'note.txt')));
  assert.equal(materials[1].version,'file-2');
  assert.equal(materials[1].sha256,null);
  assert.equal(materials[1].textChars,null);
  assert.equal(JSON.stringify(dossier).includes(MATERIAL_TEXT),false,'material text must never be copied into the dossier');

  // a 10000-character stdout inside review.checks keeps only its last 4000 characters.
  assert.equal(dossier.review.checks[0].stdout,TRUNCATED+longStdout.slice(-4000));
  assert.equal(dossier.review.checks[0].stdout,TRUNCATED+'b'.repeat(4000));
  assert.equal(dossier.review.checks[0].stdout.length,TRUNCATED.length+4000);
  assert.equal(dossier.review.checks[0].stderr,'short');
  assert.equal(dossier.review.nested.stderr,TRUNCATED+longStderr.slice(-4000));
  assert.equal(dossier.refresh.stdout,'d'.repeat(4000),'exactly 4000 characters is not truncated');
  assert.equal(dossier.integration.stderr,TRUNCATED+'e'.repeat(4000));
  // The record itself keeps the full output.
  assert.equal(stored.review.checks[0].stdout,longStdout);
  assert.equal(stored.review.checks[0].stdout.length,10000);
  assert.equal(stored.integration.stderr,'e'.repeat(4100));

  assert.deepEqual(dossier.acknowledgement,{resultCollected:true,accepted:true,artifactState:'preserved',pinned:true});
  assert.deepEqual(dossier.archive,storedArchive);
  assert.deepEqual(dossier.stop,{stopConfirmed:true,activeJobs:0});
  assert.deepEqual(dossier.result,{available:true,totalChars:'the full result text'.length});

  // Two reads are equal and neither the store record nor later reads change.
  assert.deepEqual(again,dossier);
  assert.equal(JSON.stringify(f.store.get(submitted.id)),before);

  // Mutating the returned object cannot reach the store.
  dossier.review.checks[0].stdout='mutated';
  dossier.request.metadata.controller='mutated';
  assert.equal(f.store.get(submitted.id).review.checks[0].stdout,longStdout);
  assert.equal(f.store.get(submitted.id).packet.metadata.controller,'codex');
 }finally{f.close();}
});

test('bridge_dossier is advertised, dispatches to the read-only method and refuses unknown ids',async()=>{
 const f=fixture();try{
  const spec=TOOLS.find(t=>t.name==='bridge_dossier');
  assert.ok(spec,'bridge_dossier must be advertised by tools/list');
  assert.deepEqual(spec.inputSchema.required,['taskId']);
  assert.equal(spec.inputSchema.properties.taskId.type,'string');
  assert.equal(spec.inputSchema.additionalProperties,false);
  assert.match(spec.description,/Read-only closeout dossier/);
  assert.match(spec.description,/bridge_result/);

  // The advertised catalog is the array the real tools/list method serves; prove it
  // through the transport too.
  const token='dossier-test-token-'.repeat(2);
  const server=http.createServer(createMcpHandler({},{token}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
   const listed=await (await fetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).json();
   const advertised=listed.result.tools.find(t=>t.name==='bridge_dossier');
   assert.ok(advertised,'tools/list must advertise bridge_dossier');
   assert.deepEqual(advertised.inputSchema.required,['taskId']);
   assert.equal(advertised.inputSchema.properties.taskId.type,'string');
  }finally{server.closeAllConnections?.();await new Promise(r=>server.close(r));}

  const submitted=await f.service.submit(packet(f.directory));
  await until(()=>f.starts.length===1);
  f.done(submitted.id,'done');
  await until(()=>f.service.get(submitted.id).status==='completed');

  const call=createDispatcher(f.service);
  const dispatched=await call('bridge_dossier',{taskId:submitted.id});
  assert.deepEqual(dispatched,f.service.dossier(submitted.id));

  const before=JSON.stringify(f.store.get(submitted.id));
  await call('bridge_dossier',{taskId:submitted.id});
  assert.equal(JSON.stringify(f.store.get(submitted.id)),before,'the dossier must not change task state');

  await assert.rejects(()=>call('bridge_dossier',{}),{code:'INVALID_ARGUMENTS'});
  await assert.rejects(()=>call('bridge_dossier',{taskId:submitted.id,extra:1}),{code:'INVALID_ARGUMENTS'});
  // An unknown id is refused with the same typed error the other read tools use.
  await assert.rejects(()=>call('bridge_dossier',{taskId:'missing-task'}),{code:'TASK_NOT_FOUND'});
  assert.throws(()=>f.service.dossier('missing-task'),{code:'TASK_NOT_FOUND'});
 }finally{f.close();}
});
