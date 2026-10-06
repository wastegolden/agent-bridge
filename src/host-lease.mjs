import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {fail} from './contracts.mjs';
// The SQLite request transaction handles retries; this lease separately prevents
// two host processes from dispatching the same queued row concurrently.
export function acquireHostLease(directory){
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'host-lease.json');const nonce=randomUUID();
 const body=JSON.stringify({pid:process.pid,nonce,createdAt:Date.now()});
 for(let attempt=0;attempt<2;attempt++){
  try{const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return ()=>{if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===body)fs.unlinkSync(file);};}
  catch(e){if(e.code!=='EEXIST')throw e;let old;const raw=fs.readFileSync(file,'utf8');try{old=JSON.parse(raw);}catch{fail('HOST_LEASE_CONFLICT','Unreadable host lease; manual reconciliation required');}
   if(!Number.isInteger(old.pid)||old.pid<1)fail('HOST_LEASE_CONFLICT','Invalid host lease');
   let absent=false;try{process.kill(old.pid,0);}catch(err){absent=err.code==='ESRCH';}
   if(!absent)fail('HOST_ALREADY_RUNNING','Another host owns this task store');
   if(fs.readFileSync(file,'utf8')===raw)fs.unlinkSync(file);
  }
 }
 fail('HOST_LEASE_CONFLICT','Host lease changed concurrently');
}
