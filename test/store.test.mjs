import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskStore} from '../src/store.mjs';
import {validatePacket} from '../src/contracts.mjs';
export function packet(root,extra={}){return {schemaVersion:1,idempotencyKey:'test',revision:1,projectId:'p',title:'bounded',objective:'read one file',cwd:root,role:'investigate',acceptance:['evidence'],scope:{readRoots:[root],writeRoots:[],allowedTools:['read_file'],allowShell:false,allowNetwork:false,allowDelegation:false},materials:[],contractVersion:'1',...extra};}
test('durable idempotency, ownership and complete events survive reopening',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-store-'));let s=new TaskStore({directory:dir,ownerId:'a'});
 const p=validatePacket(packet(dir));const t=s.submit(p);assert.equal(t.created,true);assert.equal(s.submit(p).task.id,t.task.id);
 assert.throws(()=>s.submit({...p,title:'different'}),{code:'IDEMPOTENCY_CONFLICT'});
 s.update(t.task.id,{result:{text:'x'.repeat(25000)},status:'completed'});s.event(t.task.id,{type:'end'});s.close();
 s=new TaskStore({directory:dir,ownerId:'a'});assert.equal(s.get(t.task.id).result.text.length,25000);const first=s.events(t.task.id,{limit:1});assert.equal(s.events(t.task.id,{after:first[0].seq}).length,1);s.close();
 const foreign=new TaskStore({directory:dir,ownerId:'b'});assert.throws(()=>foreign.get(t.task.id),{code:'TASK_NOT_FOUND'});foreign.close();fs.rmSync(dir,{recursive:true});
});
test('input rejects widened review scope, material escape, malformed budget',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-input-'));const p=packet(dir);
 assert.throws(()=>validatePacket({...p,scope:{...p.scope,writeRoots:[dir]}}),{code:'INVALID_SCOPE'});
 assert.throws(()=>validatePacket({...p,materials:[{path:path.dirname(dir)}]}),{code:'INVALID_SCOPE'});
 assert.throws(()=>validatePacket({...p,budget:{maxToolCalls:0}}),{code:'INVALID_BUDGET'});fs.rmSync(dir,{recursive:true});
});
