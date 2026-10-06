import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {createDispatcher,createMcpHandler} from '../src/mcp.mjs';
test('authentication and transport boundaries protect mutations',async()=>{
 let calls=0;const service={submit:async p=>{calls++;return {text:p.text};}};const token='test-only-credential-'.repeat(3);
 const server=http.createServer(createMcpHandler(service,{token}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 try{
  const call=async(body,headers={})=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,...headers},body:JSON.stringify(body)});
  let r=await call({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bridge_submit',arguments:{packet:{text:'中文'}}}},{Authorization:'bad'});assert.equal(r.status,401);assert.equal(calls,0);
  r=await call({jsonrpc:'2.0',method:'tools/call',params:{name:'bridge_submit',arguments:{packet:{text:'中文'}}}});assert.equal(r.status,400);assert.equal(calls,0);
  r=await call({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'bridge_submit',arguments:{packet:{text:'中文'}}}});assert.equal((await r.json()).result.structuredContent.text,'中文');assert.equal(calls,1);
  r=await call({jsonrpc:'2.0',id:3,method:'initialize',params:{protocolVersion:'invented'}});assert.equal((await r.json()).result.protocolVersion,'2025-06-18');
  r=await call({jsonrpc:'2.0',id:4,method:'ping'},{Origin:'http://evil.invalid'});assert.equal(r.status,403);
 }finally{await new Promise(r=>server.close(r));}
});
test('tools/list advertises the complete task packet and errors expose only bounded details',async()=>{
 const token='test-only-credential-'.repeat(3);
 const secretPath='C:/dev/private-material.txt';const secretHash='f'.repeat(64);
 const service={submit:async()=>{throw Object.assign(new Error('schemaVersion must be the integer 1, not the string "1.0" or any other value'),{code:'INVALID_PACKET',details:{field:'schemaVersion',expected:'integer 1',path:secretPath,sha256:secretHash}});}};
 const server=http.createServer(createMcpHandler(service,{token}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 const call=body=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
 try{
  const listed=await (await call({jsonrpc:'2.0',id:1,method:'tools/list'})).json();
  const submit=listed.result.tools.find(t=>t.name==='bridge_submit');const packet=submit.inputSchema.properties.packet;
  assert.equal(packet.type,'object');
  assert.equal(packet.additionalProperties,true);
  for(const field of ['schemaVersion','idempotencyKey','revision','projectId','title','objective','cwd','role','acceptance','scope','materials','contractVersion'])assert.ok(packet.required.includes(field),`missing required ${field}`);
  assert.equal(packet.properties.schemaVersion.type,'integer');assert.deepEqual(packet.properties.schemaVersion.enum,[1]);
  assert.match(packet.properties.schemaVersion.description,/integer 1/);assert.match(packet.properties.schemaVersion.description,/1\.0/);
  assert.equal(packet.properties.revision.type,'integer');assert.equal(packet.properties.revision.minimum,1);
  assert.deepEqual(packet.properties.role.enum,['investigate','implement','review','integrate']);
  assert.deepEqual(packet.properties.scope.required,['readRoots','writeRoots','allowedTools','allowShell','allowNetwork','allowDelegation']);
  assert.equal(packet.properties.scope.properties.allowDelegation.type,'boolean');assert.deepEqual(packet.properties.scope.properties.allowDelegation.enum,[false]);
  assert.equal(packet.properties.materials.type,'array');assert.equal(packet.properties.materials.items.anyOf.length,2);
  assert.equal(packet.properties.budget.additionalProperties,false);
  assert.equal(packet.properties.budget.properties.timeoutMs.default,600000);
  assert.equal(packet.properties.budget.properties.timeoutMs.maximum,86400000);
  assert.equal(packet.properties.budget.properties.maxToolCalls.maximum,10000);
  assert.equal(packet.properties.budget.properties.maxOutputChars.maximum,10000000);
  assert.equal(packet.properties.model.properties.model.enum,undefined);
  assert.ok(packet.properties.model.properties.profileId);
  assert.ok(packet.properties.model.description.includes('bridge_models'));
  assert.equal(JSON.stringify(packet.properties.model).includes('deepseek'),false);
  assert.match(packet.properties.cwd.description,/readRoots/);
  const failed=await (await call({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'bridge_submit',arguments:{packet:{schemaVersion:'1.0'}}}})).json();
  const payload=JSON.parse(failed.result.content[0].text);
  assert.equal(payload.code,'INVALID_PACKET');assert.match(payload.message,/integer 1/);
  assert.deepEqual(payload.details,{field:'schemaVersion',expected:'integer 1'});
  const text=failed.result.content[0].text;
  assert.equal(text.includes(secretPath),false);assert.equal(text.includes(secretHash),false);
 }finally{await new Promise(r=>server.close(r));}
});
test('bridge_capabilities keeps the live child inventory and the adapter child/job/reply support in separate fields',async()=>{
 const inventory=[{childId:'child-1',taskId:'t-1',attemptId:'a-1',state:'running',depth:1,sessionId:'s-1',lineage:'agents.create',stopConfirmed:false}];
 const adapterSupervisor={
  children:{supported:true,enabled:true,maxDepth:1,lineage:'agents.create',maxChildrenPerTask:2,reason:null},
  jobs:{supported:true,enabled:true,jobsRegistryReady:true,controllerStatus:'unknown',controllerUnknown:true,maxJobsPerTask:1},
  reply:{supported:true,targets:[{grantId:'originating-chat',targetId:'target-1'}]},
 };
 const ledgerCounts={limit:16,used:2,roots:1,children:1,free:14};
 const notification={supported:true,targets:[{grantId:'originating-chat',targetId:'target-1'}]};
 const commandJobs={supported:true,maxJobsPerTask:1};
 const service={
  maxConcurrent:16,
  adapter:{capabilities:async()=>({adapterVersion:'0.5.0',supervisor:adapterSupervisor})},
  supervisor:{
   ledger:{counts:()=>ledgerCounts},
   snapshot:()=>({ownerId:'owner-1',ledger:{limit:16},children:inventory}),
   notificationsStatus:()=>notification,
   commandJobsStatus:()=>commandJobs,
  },
 };
 const caps=await createDispatcher(service)('bridge_capabilities',{});
 // Inventory keeps the SAME shape it had before this change.
 assert.ok(Array.isArray(caps.supervisor.children),'children must stay the live inventory array');
 assert.deepEqual(caps.supervisor.children,inventory);
 // The adapter support answer survives verbatim; the spread no longer loses it.
 assert.deepEqual(caps.supervisor.capabilities,adapterSupervisor);
 assert.equal(caps.supervisor.capabilities.children.supported,true);
 assert.equal(caps.supervisor.capabilities.children.lineage,'agents.create');
 assert.equal(caps.supervisor.capabilities.jobs.supported,true);
 assert.equal(caps.supervisor.capabilities.reply.supported,true);
 // An inventory array is NOT a support status: the two claims must never be conflated.
 assert.equal(Array.isArray(caps.supervisor.capabilities.children),false);
 // Pre-existing fields are untouched.
 assert.deepEqual(caps.supervisor.ledger,ledgerCounts);
 assert.deepEqual(caps.supervisor.notification,notification);
 assert.deepEqual(caps.supervisor.commandJobs,commandJobs);
 assert.equal(caps.adapterVersion,'0.5.0');
});
