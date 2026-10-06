import { timingSafeEqual } from 'node:crypto';
import { fail, realPath } from './contracts.mjs';
import { TASK_PACKET_SCHEMA } from './task-packet-schema.mjs';
import { ARTIFACT_STATE_ENUM, ARTIFACT_STATE_SCHEMA, CHECKS_SCHEMA } from './tool-schemas.mjs';

// Re-exported so the advertised fragments can be imported from either module.
export { ARTIFACT_STATE_ENUM, ARTIFACT_STATE_SCHEMA, CHECKS_SCHEMA };

const object = properties => ({type:'object',properties,additionalProperties:false});
// Advertised release identity (bridge 1.3.0 / adapter 0.5.0).
export const BRIDGE_VERSION='1.3.0';
const str={type:'string'};const num={type:'integer'};const bool={type:'boolean'};
const taskArgs={taskId:str};
// Lifecycle tool shapes. Both are deliberately narrow: a clarification carries
// bounded text only, and archiving carries only the exact owned revision. Neither
// can add materials, scope, model or a new task, and additionalProperties:false
// rejects any such extra field.
const clarifyArgs=object({
 taskId:{type:'string',minLength:1,pattern:'\\S',description:'Owned task identifier whose current understanding attempt is being clarified. The clarification runs in that existing session and never starts a second one.'},
 revision:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description:'Exact current positive task revision the clarification applies to. A mismatch is a clarification conflict, never an implicit rebase.'},
 understandingHash:{type:'string',minLength:1,pattern:'\\S',description:'Exact nonblank hash of the understanding currently awaiting approval. A stale hash is rejected even when the new text repeats earlier wording, because understanding is versioned.'},
 clarificationId:{type:'string',minLength:1,pattern:'\\S',maxLength:200,description:'Nonblank caller-chosen identifier of at most 200 characters. Replaying the same identifier with identical content returns the same task without another attempt; the same identifier with different content is a conflict.'},
 text:{type:'string',minLength:1,pattern:'\\S',maxLength:20000,description:'Nonblank clarification text of at most 20000 characters. It is versioned and appended to the next understanding attempt as clearly delimited untrusted context; the original packet, scope, acceptance, model and workspace remain authoritative and unchanged, and nothing executes until the new understanding is approved.'},
});
const archiveArgs=object({
 taskId:{type:'string',minLength:1,pattern:'\\S',description:'Owned task identifier to UI-hide. Archiving preserves the workspace, results, evidence and events for their full retention window; no session persistence, worktree or job is deleted.'},
 revision:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description:'Exact current positive task revision of the settled owned task. Archive requires a terminal, collected, stopped task with a resolved artifact state.'},
});
export const TOOLS=[
 ['bridge_submit','Submit one bounded task. Defaults to Flash; returns durable task identity quickly. The complete packet shape is advertised in inputSchema.properties.packet.',object({packet:TASK_PACKET_SCHEMA}),['packet']],
 ['bridge_check','Read task state and cursor-based events; bounded wait does not cancel work.',object({...taskArgs,after:num,waitMs:num,limit:num}),['taskId']],
 ['bridge_result','Read complete result in repeatable slices with evidence and uncertainty.',object({...taskArgs,offset:num,limit:num}),['taskId']],
 ['bridge_approve','Controller authorizes execution after checking understanding against existing user authorization.',object({...taskArgs,revision:num,understandingHash:str}),['taskId','revision','understandingHash']],
 ['bridge_clarify','Clarify the understanding of one owned task in its existing session; only a task currently awaiting_approval is eligible, and any other state is rejected as a clarification conflict. Bounded versioned text is appended to the next understanding attempt as clearly delimited untrusted context; the original packet, scope, acceptance, model, workspace and revision stay unchanged. A clarification is never execution approval, the new understanding hash must still be approved, and an identical replay returns the same task without another attempt.',clarifyArgs,['taskId','revision','understandingHash','clarificationId','text']],
 ['bridge_cancel','Cancel owned queued work, active turn and jobs; inspect stop confirmation.',object({...taskArgs,reason:str}),['taskId']],
 ['bridge_pause','Pause one recurrent supervisor project (host pause AND packet.project.maxRounds >= 2). The request is persisted before the call returns, no new worker or supervisor round is admitted, and owned work finishes naturally; the project becomes paused only once the current round and every owned worker prove their stop. Idempotent by requestId and never a cancellation.',object({...taskArgs,requestId:str,reason:str}),['taskId','requestId']],
 ['bridge_resume','Resume one paused recurrent supervisor project after re-checking real stop, ownership and dispatch evidence plus the immutable deadline and cumulative budget. An unproven, expired or exhausted checkpoint is refused with a typed code and retained; the same task record continues with no copy, budget reset or deadline extension. Idempotent by requestId.',object({...taskArgs,requestId:str,reason:str}),['taskId','requestId']],
 ['bridge_reconcile','Reconcile an ambiguous attempt against actual host state without replaying it.',object(taskArgs),['taskId']],
 ['bridge_list','List bridge-owned tasks; plugin tasks are separate from ordinary user conversations.',object({projectId:str,status:str,includeArchived:bool}),[]],
 ['bridge_acknowledge','Controller records result collection/acceptance and artifact preservation.',object({...taskArgs,revision:num,accepted:bool,artifactState:ARTIFACT_STATE_SCHEMA,pinned:bool}),['taskId','revision']],
 ['bridge_models','Discover actual DSH model routes. Explicit requests are never silently substituted.',object({}),[]],
 ['bridge_capabilities','Read effective host capabilities and known unsupported boundaries.',object({}),[]],
 ['bridge_cleanup','Preview or apply retention-qualified cleanup to one owned task. Default dry-run.',object({...taskArgs,dryRun:bool,now:num,policy:{type:'object'}}),['taskId']],
 ['bridge_archive','Archive (UI-hide) one settled owned task. The workspace, results, evidence and events are preserved and normal retention cleanup still applies; no session persistence or worktree is deleted. Requires an exact owned revision in a terminal, collected, stopped state with a resolved artifact state, and repeated archive is idempotent without resetting the retention time.',archiveArgs,['taskId','revision']],
 ['bridge_workspace_review','Attach review to the exact owned workspace commit and contract. The discoverable checks shape is advertised in inputSchema.properties.checks.',object({...taskArgs,head:str,contractVersion:str,passed:bool,checks:CHECKS_SCHEMA}),['taskId','head','contractVersion','passed']],
 ['bridge_workspace_refresh','Rebase an owned completed workspace onto an exact target head and invalidate its old review. Conflicts are preserved.',object({...taskArgs,targetRepository:str,expectedTargetHead:str}),['taskId','targetRepository','expectedTargetHead']],
 ['bridge_workspace_integrate','Integrate a reviewed exact commit; refuses dirty or stale targets. checks run on source and merged target; optional baselineChecks run before merge. Both use the discoverable checks shape advertised in inputSchema.properties.checks.',object({...taskArgs,targetRepository:str,contractVersion:str,checks:CHECKS_SCHEMA,baselineChecks:CHECKS_SCHEMA}),['taskId','targetRepository','contractVersion']],
].map(([name,description,inputSchema,required])=>({name,description,inputSchema:{...inputSchema,required}}));

// The generic type pass checks declared types only. The two lifecycle tools also
// enforce the fixed bounded, nonblank constraints here so malformed input is
// rejected before any replay lookup, compare-and-swap or archive bookkeeping.
const boundedText=(a,key,max)=>{
 const value=a[key];
 if(typeof value!=='string'||value.trim().length===0||(max!==undefined&&value.length>max))fail('INVALID_ARGUMENTS',`Invalid ${key}`,{field:key,expected:max===undefined?'nonblank string':`nonblank string of at most ${max} characters`});
};
const ownedRevision=a=>{if(!Number.isSafeInteger(a.revision)||a.revision<1)fail('INVALID_ARGUMENTS','revision must be a positive safe integer',{field:'revision',expected:'positive safe integer'});};

export function createDispatcher(service){
 return async (name,a={})=>{
  if(!a||typeof a!=='object'||Array.isArray(a))fail('INVALID_ARGUMENTS','Expected object arguments');
  const spec=TOOLS.find(t=>t.name===name);if(!spec)fail('UNKNOWN_TOOL','Unknown tool');
  for(const key of spec.inputSchema.required)if(a[key]===undefined)fail('INVALID_ARGUMENTS',`Missing ${key}`);
  for(const key of Object.keys(a))if(!Object.hasOwn(spec.inputSchema.properties,key))fail('INVALID_ARGUMENTS',`Unexpected ${key}`);
  for(const [key,value] of Object.entries(a)){
   const type=spec.inputSchema.properties[key].type;
   if(!(type==='integer'?Number.isSafeInteger(value):type==='array'?Array.isArray(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):typeof value===type))fail('INVALID_ARGUMENTS',`Invalid type for ${key}`);
  }
  switch(name){
   case 'bridge_submit':return service.submit(a.packet);
   case 'bridge_check':return service.wait(a.taskId,a);
   case 'bridge_result':return service.result(a.taskId,a);
   case 'bridge_approve':return service.approve(a.taskId,a);
   case 'bridge_clarify':{
    ownedRevision(a);boundedText(a,'understandingHash');boundedText(a,'clarificationId',200);boundedText(a,'text',20000);
    // taskId travels only as the service identity argument: the service rejects
    // unknown option keys, so it must never be repeated inside the options object.
    return service.clarify(a.taskId,{revision:a.revision,understandingHash:a.understandingHash,clarificationId:a.clarificationId,text:a.text});
   }
   case 'bridge_cancel':return service.cancel(a.taskId,a.reason);
   case 'bridge_pause':return service.pause(a.taskId,{requestId:a.requestId,reason:a.reason});
   case 'bridge_resume':return service.resume(a.taskId,{requestId:a.requestId,reason:a.reason});
   case 'bridge_reconcile':return service.reconcile(a.taskId);
   case 'bridge_list':return {tasks:service.list(a)};
   case 'bridge_acknowledge':return service.acknowledge(a.taskId,a);
   case 'bridge_models':return {models:await service.adapter.models()};
   case 'bridge_capabilities':{
    const caps=await service.adapter.capabilities();
    const adapterSupervisor=caps!==null&&typeof caps==='object'&&caps.supervisor!==null&&typeof caps.supervisor==='object'?caps.supervisor:null;
    return {version:BRIDGE_VERSION,...caps,maxConcurrent:service.maxConcurrent,
     // `children` stays the live child INVENTORY array; the adapter's authoritative
     // child/job/reply SUPPORT statuses are preserved verbatim under `capabilities`
     // (the spread above would otherwise be overwritten by the inventory shape).
     supervisor:service.supervisor?{ledger:service.supervisor.ledger.counts(),children:service.supervisor.snapshot().children,notification:service.supervisor.notificationsStatus(),commandJobs:service.supervisor.commandJobsStatus(),capabilities:adapterSupervisor}:null,
     // The long-task supervisor surface (`packet.project` on bridge_submit). Absent
     // means the host has no runtime and every project grant is refused.
     supervisorProjects:service.projects?service.projects.status():{supported:false,enabled:false,reason:'no long-task supervisor runtime is configured on this host'},
     // The integrated producer status of the actual mount (eventWake outbox router):
     // configured producer, unverified live transport/runner/acknowledgement.
     eventWake:service.eventWake??null,
     lastError:service.lastError??null};
   }
   case 'bridge_cleanup':return service.cleanup(a.taskId,a);
   case 'bridge_archive':{
    ownedRevision(a);
    // Archive is UI hiding only: the same identity/options split keeps taskId out
    // of the options object, and no cleanup, delete or worktree call is dispatched.
    return service.archive(a.taskId,{revision:a.revision});
   }
   case 'bridge_workspace_review':{
    const task=service.store.get(a.taskId);if(!task.workspace)fail('NO_WORKSPACE','No owned workspace');
    if(task.status!=='completed'||task.stopConfirmed!==true||task.activeJobs!==0)fail('TASK_NOT_SETTLED','Review requires a completed, stopped task');
    const review=await service.workspaces.review(task.workspace,a);service.store.update(task.id,{review});return review;
   }
   case 'bridge_workspace_refresh':{
    const task=service.store.get(a.taskId);if(!task.workspace||task.status!=='completed'||!task.stopConfirmed||task.activeJobs!==0)fail('TASK_NOT_SETTLED','Refresh requires an owned completed, stopped workspace');
    if(realPath(task.workspace.repository)!==realPath(a.targetRepository))fail('TARGET_MISMATCH','Refresh target must equal task repository');
    // Invalidate any prior review before the refresh can mutate the workspace: a refresh
    // that throws after a partial rebase must never leave a stale approval behind.
    service.store.update(task.id,{review:null});
    const result=await service.workspaces.refresh(task.workspace,a);
    service.store.update(task.id,{refresh:result,...(result.refreshed?{workspace:result.workspace}:{})});return result;
   }
   case 'bridge_workspace_integrate':{
    const task=service.store.get(a.taskId);if(!task.workspace||!task.review)fail('NO_REVIEW','No owned reviewed workspace');
    if(task.status!=='completed'||task.stopConfirmed!==true||task.activeJobs!==0)fail('TASK_NOT_SETTLED','Integration requires a completed, stopped task');
    if(realPath(task.workspace.repository)!==realPath(a.targetRepository))fail('TARGET_MISMATCH','Integration target must equal task repository');
    const result=await service.workspaces.integrate(task.workspace,{...a,review:task.review});
    service.store.update(task.id,{integration:result,...(result.merged===true&&result.accepted===true?{artifactState:'merged'}:{artifactState:'unresolved'})});return result;
   }
  }
 };
}

export function createMcpHandler(service,{token,allowedHosts=['127.0.0.1','localhost'],maxBodyBytes=2_000_000}={}){
 if(typeof token!=='string'||token.length<24)fail('AUTH_UNAVAILABLE','A strong bearer credential is required');
 const call=createDispatcher(service);const secret=Buffer.from(token);
 const equal=value=>{const b=Buffer.from(value);return b.length===secret.length&&timingSafeEqual(secret,b);};
 // Expose only bounded field/expected guidance from a domain error; never the raw
 // details object, which may carry paths, hashes or other internals.
 const safeDetails=details=>{
  if(!details||typeof details!=='object'||Array.isArray(details))return undefined;
  const bounded={};
  for(const key of ['field','expected']){const value=details[key];if(typeof value==='string'&&value.length<=120)bounded[key]=value;}
  return Object.keys(bounded).length?bounded:undefined;
 };
 const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(body===undefined?'':JSON.stringify(body));};
 return async(req,res)=>{
  try{
   const authority=String(req.headers.host??'');const host=authority.replace(/:\d+$/,'').toLowerCase();
   if(!allowedHosts.includes(host)){send(res,403,{error:'host rejected'});return;}
   if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{send(res,403,{error:'origin rejected'});return;}if(origin.host!==authority||origin.protocol!=='http:'){send(res,403,{error:'origin rejected'});return;}}
   const auth=String(req.headers.authorization??'');if(!auth.startsWith('Bearer ')||!equal(auth.slice(7))){send(res,401,{error:'unauthorized'});return;}
   if(req.method!=='POST'){send(res,405,{error:'POST required'});return;}
   const chunks=[];let size=0;const timeout=setTimeout(()=>req.destroy(),30000);timeout.unref?.();
   try{for await(const chunk of req){size+=chunk.length;if(size>maxBodyBytes){send(res,413,{error:'body too large'});return;}chunks.push(chunk);}}finally{clearTimeout(timeout);}
   const raw=Buffer.concat(chunks).toString('utf8');
   let msg;try{msg=JSON.parse(raw);}catch{send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return;}
   if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'){send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid envelope'}});return;}
   if(msg.method.startsWith('notifications/')){send(res,202);return;}
   if(msg.id===undefined||msg.id===null){send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Request identity required'}});return;}
   let result;
   if(msg.method==='initialize'){
    const supported=['2025-06-18','2025-03-26','2024-11-05'];const requested=msg.params?.protocolVersion;
    result={protocolVersion:supported.includes(requested)?requested:supported[0],capabilities:{tools:{}},serverInfo:{name:'dsh-codex-bridge-v1',version:BRIDGE_VERSION},instructions:'Codex owns planning and acceptance. Prefer bounded Flash implementation and review tasks. Check effective model and permissions. Use task IDs, collect full results, and confirm stopping before cleanup. Skill rules are guidance, not authorization.'};
   }else if(msg.method==='ping')result={};
   else if(msg.method==='tools/list')result={tools:TOOLS};
   else if(msg.method==='tools/call'){
    try{const value=await call(msg.params?.name,msg.params?.arguments);result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}
    catch(e){const details=safeDetails(e&&e.details);result={isError:true,content:[{type:'text',text:JSON.stringify({code:e.code??'INTERNAL',message:e.message,...(details?{details}:{})})}]};}
   }else{send(res,200,{jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Method not found'}});return;}
   send(res,200,{jsonrpc:'2.0',id:msg.id,result});
  }catch{if(!res.headersSent)send(res,500,{error:'bridge request failed'});else res.end();}
 };
}
