import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {acquireHostLease} from '../src/host-lease.mjs';
test('a task store has one host owner and release never removes a replaced lease',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-lease-'));try{
 const release=acquireHostLease(root);assert.throws(()=>acquireHostLease(root),{code:'HOST_ALREADY_RUNNING'});release();release();
 const again=acquireHostLease(root);const file=path.join(root,'host-lease.json');fs.writeFileSync(file,'replacement');again();assert.equal(fs.readFileSync(file,'utf8'),'replacement');
 }finally{fs.rmSync(root,{recursive:true});}
});
