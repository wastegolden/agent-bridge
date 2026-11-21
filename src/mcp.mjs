import { randomUUID } from 'node:crypto';
import { fail, realPath } from './contracts.mjs';
import { CONTROLLER_ID_PATTERN, parseViaHeaders } from './controller-auth.mjs';
import { TASK_PACKET_SCHEMA } from './task-packet-schema.mjs';
import { ARTIFACT_STATE_ENUM, ARTIFACT_STATE_SCHEMA, CHECKS_SCHEMA } from './tool-schemas.mjs';

// Re-exported so the advertised fragments can be imported from either module.
export { ARTIFACT_STATE_ENUM, ARTIFACT_STATE_SCHEMA, CHECKS_SCHEMA };

const object = properties => ({type:'object',properties,additionalProperties:false});
// Advertised bridge release identity matches the plugin release.
export const BRIDGE_VERSION='2.1.0';
const str={type:'string'};const num={type:'integer'};const bool={type:'boolean'};
const taskArgs={taskId:str};
const overrideSchema=object({reason:{type:'string',maxLength:500,pattern:'\\S'}});
overrideSchema.required=['reason'];
// Lifecycle tool shapes. They are deliberately narrow: a clarification or follow-up
// carries bounded text plus its round CAS only, and archiving carries only the exact
// owned revision. None can add materials, scope, model or a new task, and
// additionalProperties:false rejects any such extra field.
const clarifyArgs=object({
 taskId:{type:'string',minLength:1,pattern:'\\S',description:'Owned task identifier whose current understanding attempt is being clarified. The clarification runs in that existing session and never starts a second one.'},
 revision:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description:'Exact current positive task revision the clarification applies to. A mismatch is a clarification conflict, never an implicit rebase.'},
 understandingHash:{type:'string',minLength:1,pattern:'\\S',description:'Exact nonblank hash of the understanding currently awaiting approval. A stale hash is rejected even when the new text repeats earlier wording, because understanding is versioned.'},
 clarificationId:{type:'string',minLength:1,pattern:'\\S',maxLength:200,description:'Nonblank caller-chosen identifier of at most 200 characters. Replaying the same identifier with identical content returns the same task without another attempt; the same identifier with different content is a conflict.'},
 text:{type:'string',minLength:1,pattern:'\\S',maxLength:20000,description:'Nonblank clarification text of at most 20000 characters. It is versioned and appended to the next understanding attempt as clearly delimited untrusted context; the original packet, scope, acceptance, model and workspace remain authoritative and unchanged, and nothing executes until the new understanding is approved.'},
});
// A follow-up carries bounded text plus the exact round CAS only. It can never add a
// packet, model, scope, material or budget: additionalProperties:false rejects any
// such extra field before the service sees it.
const followupArgs=object({
 taskId:{type:'string',minLength:1,pattern:'\\S',description:'Owned task identifier whose settled attempt is being followed up. The question runs in that existing session and never starts a second one.'},
 revision:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description:'Exact current positive task revision. A mismatch is a follow-up conflict, never an implicit rebase.'},
 afterAttemptId:{type:'string',minLength:1,pattern:'\\S',description:'Exact current attempt identifier this follow-up replaces. It is the round compare-and-swap: a late follow-up bound to an older attempt is refused.'},
 followupId:{type:'string',minLength:1,pattern:'\\S',maxLength:200,description:'Nonblank caller-chosen identifier of at most 200 characters. An identical replay returns the original attempt without another turn; the same identifier with different content is a conflict.'},
 text:{type:'string',minLength:1,pattern:'\\S',maxLength:20000,description:'Nonblank follow-up question of at most 20000 characters. It is rendered as fence-delimited untrusted material in the existing session; the original packet, scope, model, workspace and permissions remain authoritative and unchanged.'},
});
const archiveArgs=object({
 taskId:{type:'string',minLength:1,pattern:'\\S',description:'Owned task identifier to UI-hide. Archiving preserves the workspace, results, evidence and events for their full retention window; no session persistence, worktree or job is deleted.'},
 revision:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description:'Exact current positive task revision of the settled owned task. Archive requires a terminal, collected, stopped task with a resolved artifact state.'},
});
export const TOOLS=[
 ['bridge_submit','submit','Submit one bounded task. Defaults to Flash; returns durable task identity quickly. The complete packet shape is advertised in inputSchema.properties.packet.',object({packet:TASK_PACKET_SCHEMA}),['packet']],
 ['bridge_check','read','Read task state and cursor-based events; bounded wait does not cancel work.',object({...taskArgs,after:num,waitMs:num,limit:num}),['taskId']],
 ['bridge_result','read','Read complete result in repeatable slices with evidence and uncertainty. Omit attemptId for the current round or pass a round attemptId from a follow-up/dossier to read that earlier answer.',object({...taskArgs,offset:num,limit:num,attemptId:str}),['taskId']],
 ['bridge_dossier','read','Read-only closeout dossier for one owned task: the submitted request, effective route, workspace and review/integration evidence, acknowledgement and archive state. Large check output is truncated; read the full result with bridge_result.',object({...taskArgs}),['taskId']],
 ['bridge_approve','mutate','Controller authorizes execution after checking understanding against existing user authorization.',object({...taskArgs,revision:num,understandingHash:str}),['taskId','revision','understandingHash']],
 ['bridge_clarify','mutate','Clarify the understanding of one owned task in its existing session; only a task currently awaiting_approval is eligible, and any other state is rejected as a clarification conflict. Bounded versioned text is appended to the next understanding attempt as clearly delimited untrusted context; the original packet, scope, acceptance, model, workspace and revision stay unchanged. A clarification is never execution approval, the new understanding hash must still be approved, and an identical replay returns the same task without another attempt.',clarifyArgs,['taskId','revision','understandingHash','clarificationId','text']],
 ['bridge_followup','mutate','Ask one bounded follow-up question in the existing owned session of a settled read-only (investigate or review) task. Eligible only for a completed, failed or cancelled task with a host-confirmed stop, zero active jobs and children, and a persisted session receipt; project tasks, project workers and unapproved understanding-gated tasks are refused. The same session, packet, scope, model and permissions are reused and never widened. An identical followupId with identical content replays the original attempt without another turn; the same identifier with different content is a conflict. Read each round with bridge_result by attemptId.',followupArgs,['taskId','revision','afterAttemptId','followupId','text']],
 ['bridge_cancel','mutate','Cancel owned queued work, active turn and jobs; inspect stop confirmation.',object({...taskArgs,reason:str}),['taskId']],
 ['bridge_pause','mutate','Pause one recurrent supervisor project (host pause AND packet.project.maxRounds >= 2). The request is persisted before the call returns, no new worker or supervisor round is admitted, and owned work finishes naturally; the project becomes paused only once the current round and every owned worker prove their stop. Idempotent by requestId and never a cancellation.',object({...taskArgs,requestId:str,reason:str}),['taskId','requestId']],
 ['bridge_resume','mutate','Resume one paused recurrent supervisor project after re-checking real stop, ownership and dispatch evidence plus the immutable deadline and cumulative budget. An unproven, expired or exhausted checkpoint is refused with a typed code and retained; the same task record continues with no copy, budget reset or deadline extension. Idempotent by requestId.',object({...taskArgs,requestId:str,reason:str}),['taskId','requestId']],
 ['bridge_reconcile','mutate','Reconcile an ambiguous attempt against actual host state without replaying it.',object(taskArgs),['taskId']],
 ['bridge_list','read','List bridge-owned tasks; plugin tasks are separate from ordinary user conversations.',object({projectId:str,status:str,includeArchived:bool,submittedBy:{type:['string','null'],pattern:'^[a-z][a-z0-9-]{0,63}$'}}),[]],
 ['bridge_acknowledge','mutate','Controller records result collection/acceptance and artifact preservation.',object({...taskArgs,revision:num,accepted:bool,artifactState:ARTIFACT_STATE_SCHEMA,pinned:bool}),['taskId','revision']],
 ['bridge_models','read','Discover actual DSH model routes. Explicit requests are never silently substituted.',object({}),[]],
 ['bridge_capabilities','read','Read effective host capabilities and known unsupported boundaries.',object({}),[]],
 ['bridge_cleanup','mutate','Preview or apply retention-qualified cleanup to one owned task. Default dry-run.',object({...taskArgs,dryRun:bool,now:num,policy:{type:'object'}}),['taskId']],
 ['bridge_archive','mutate','Archive (UI-hide) one settled owned task. The workspace, results, evidence and events are preserved and normal retention cleanup still applies; no session persistence or worktree is deleted. Requires an exact owned revision in a terminal, collected, stopped state with a resolved artifact state, and repeated archive is idempotent without resetting the retention time.',archiveArgs,['taskId','revision']],
 ['bridge_workspace_review','mutate','Attach review to the exact owned workspace commit and contract. The discoverable checks shape is advertised in inputSchema.properties.checks.',object({...taskArgs,head:str,contractVersion:str,passed:bool,checks:CHECKS_SCHEMA}),['taskId','head','contractVersion','passed']],
 ['bridge_workspace_refresh','mutate','Rebase an owned completed workspace onto an exact target head and invalidate its old review. Conflicts are preserved.',object({...taskArgs,targetRepository:str,expectedTargetHead:str}),['taskId','targetRepository','expectedTargetHead']],
 ['bridge_workspace_integrate','mutate','Integrate a reviewed exact commit; refuses dirty or stale targets. checks run on source and merged target; optional baselineChecks run before merge. Both use the discoverable checks shape advertised in inputSchema.properties.checks.',object({...taskArgs,targetRepository:str,contractVersion:str,checks:CHECKS_SCHEMA,baselineChecks:CHECKS_SCHEMA}),['taskId','targetRepository','contractVersion']],
].map(([name,category,description,inputSchema,required])=>({name,category,description,inputSchema:{...inputSchema,properties:{...inputSchema.properties,...(category==='mutate'?{override:overrideSchema}:{})},required}}));

export function validateToolPolicies(tools){
 const names=new Set();
 for(const tool of tools){
  if(!['read','submit','mutate'].includes(tool.category)||names.has(tool.name))fail('TOOL_POLICY_INVALID','Invalid tool policy',{field:tool.name,expected:'read, submit or mutate'});
  names.add(tool.name);
 }
}
validateToolPolicies(TOOLS);

// The generic type pass checks declared types only. The lifecycle tools also
// enforce the fixed bounded, nonblank constraints here so malformed input is
// rejected before any replay lookup, compare-and-swap or archive bookkeeping.
const boundedText=(a,key,max)=>{
 const value=a[key];
 if(typeof value!=='string'||value.trim().length===0||(max!==undefined&&value.length>max))fail('INVALID_ARGUMENTS',`Invalid ${key}`,{field:key,expected:max===undefined?'nonblank string':`nonblank string of at most ${max} characters`});
};
const ownedRevision=a=>{if(!Number.isSafeInteger(a.revision)||a.revision<1)fail('INVALID_ARGUMENTS','revision must be a positive safe integer',{field:'revision',expected:'positive safe integer'});};

export function createDispatcher(service){
 validateToolPolicies(TOOLS);
 const execute=async(name,a,context)=>{
  switch(name){
   case 'bridge_submit':return service.submit(a.packet,{submittedBy:context.principal.id,via:context.via});
   case 'bridge_check':return service.wait(a.taskId,a);
   case 'bridge_result':return service.result(a.taskId,a);
   case 'bridge_dossier':return service.dossier(a.taskId);
   case 'bridge_approve':return service.approve(a.taskId,a);
   case 'bridge_clarify':return service.clarify(a.taskId,{revision:a.revision,understandingHash:a.understandingHash,clarificationId:a.clarificationId,text:a.text});
   case 'bridge_followup':return service.followup(a.taskId,{revision:a.revision,afterAttemptId:a.afterAttemptId,followupId:a.followupId,text:a.text});
   case 'bridge_cancel':return service.cancel(a.taskId,a.reason);
   case 'bridge_pause':return service.pause(a.taskId,{requestId:a.requestId,reason:a.reason});
   case 'bridge_resume':return service.resume(a.taskId,{requestId:a.requestId,reason:a.reason});
   case 'bridge_reconcile':return service.reconcile(a.taskId);
   case 'bridge_list':return {tasks:service.list(a)};
   case 'bridge_acknowledge':return service.acknowledge(a.taskId,a);
   case 'bridge_models':return {models:await service.adapter.models()};
   case 'bridge_capabilities':{
    const caps=await service.adapter.capabilities();
    const capsObject=caps!==null&&typeof caps==='object'&&!Array.isArray(caps)?caps:{};
    const adapterSupervisor=capsObject.supervisor!==null&&typeof capsObject.supervisor==='object'?capsObject.supervisor:null;
    const lifecycleFollowup=typeof service.adapter.followup==='function'?null:{supported:false,reason:'adapter has no followup method'};
    return {version:BRIDGE_VERSION,...caps,
     ...(lifecycleFollowup?{lifecycle:{...(capsObject.lifecycle!==null&&typeof capsObject.lifecycle==='object'&&!Array.isArray(capsObject.lifecycle)?capsObject.lifecycle:{}),followup:lifecycleFollowup}}:{}),
     maxConcurrent:service.maxConcurrent,
     supervisor:service.supervisor?{ledger:service.supervisor.ledger.counts(),children:service.supervisor.snapshot().children,notification:service.supervisor.notificationsStatus(),commandJobs:service.supervisor.commandJobsStatus(),capabilities:adapterSupervisor}:null,
     supervisorProjects:service.projects?service.projects.status():{supported:false,enabled:false,reason:'no long-task supervisor runtime is configured on this host'},
     eventWake:service.eventWake??null,
     lastError:service.lastError??null,
     controllerIdentity:{enabled:true,schemaVersion:1,self:context.principal.id,admin:context.principal.admin,controllers:[...context.controllerIds].sort(),ownership:'credential-principal',delegation:'inherit-root-credential',legacyTaskOwner:null,override:{requiredForForeignTasks:true,reasonMaxChars:500},via:{source:'client-declared',authorizes:false}}};
   }
   case 'bridge_cleanup':return service.cleanup(a.taskId,a);
   case 'bridge_archive':return service.archive(a.taskId,{revision:a.revision});
   case 'bridge_workspace_review':{
    const task=service.store.get(a.taskId);if(!task.workspace)fail('NO_WORKSPACE','No owned workspace');
    if(task.status!=='completed'||task.stopConfirmed!==true||task.activeJobs!==0)fail('TASK_NOT_SETTLED','Review requires a completed, stopped task');
    const review=await service.workspaces.review(task.workspace,a);service.store.update(task.id,{review});return review;
   }
   case 'bridge_workspace_refresh':{
    const task=service.store.get(a.taskId);if(!task.workspace||task.status!=='completed'||!task.stopConfirmed||task.activeJobs!==0)fail('TASK_NOT_SETTLED','Refresh requires an owned completed, stopped workspace');
    if(realPath(task.workspace.repository)!==realPath(a.targetRepository))fail('TARGET_MISMATCH','Refresh target must equal task repository');
    // Clear review before Git can change the workspace, including partial failures.
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
 return async (name,a={},context)=>{
  if(typeof context?.principal?.id!=='string'||!context.principal.id||typeof context.principal.admin!=='boolean'||!Array.isArray(context.controllerIds)||!Object.hasOwn(context,'via'))fail('AUTH_UNAVAILABLE','Authenticated caller context required',{field:'context',expected:'configured credential source available'});
  if(!a||typeof a!=='object'||Array.isArray(a))fail('INVALID_ARGUMENTS','Expected object arguments');
  const spec=TOOLS.find(t=>t.name===name);if(!spec)fail('UNKNOWN_TOOL','Unknown tool');
  for(const key of spec.inputSchema.required)if(a[key]===undefined)fail('INVALID_ARGUMENTS',`Missing ${key}`);
  for(const key of Object.keys(a))if(key!=='override'&&!Object.hasOwn(spec.inputSchema.properties,key))fail('INVALID_ARGUMENTS',`Unexpected ${key}`);
  for(const [key,value] of Object.entries(a)){
   if(key==='override')continue;
   const type=spec.inputSchema.properties[key].type;
   if(Array.isArray(type)){if(value===null||typeof value==='string')continue;fail('INVALID_ARGUMENTS',`Invalid type for ${key}`);}
   if(!(type==='integer'?Number.isSafeInteger(value):type==='array'?Array.isArray(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):typeof value===type))fail('INVALID_ARGUMENTS',`Invalid type for ${key}`);
  }
  if(name==='bridge_list'&&a.submittedBy!==undefined&&a.submittedBy!==null&&!CONTROLLER_ID_PATTERN.test(a.submittedBy))fail('INVALID_ARGUMENTS','Invalid submittedBy',{field:'submittedBy',expected:'controller ID or null'});
  if(name==='bridge_clarify'||name==='bridge_followup'||name==='bridge_archive')ownedRevision(a);
  if(name==='bridge_clarify'){boundedText(a,'understandingHash');boundedText(a,'clarificationId',200);boundedText(a,'text',20000);}
  if(name==='bridge_followup'){boundedText(a,'afterAttemptId');boundedText(a,'followupId',200);boundedText(a,'text',20000);}
  if(spec.category==='mutate')boundedText(a,'taskId');
  const hasOverride=Object.hasOwn(a,'override');
  let reason;
  if(hasOverride){
   if(spec.category!=='mutate'||!context.principal.admin)fail('OVERRIDE_NOT_PERMITTED','Override requires an administrator and a mutate tool',{field:'override',expected:'admin override on a mutate tool'});
   const override=a.override;
   if(!override||typeof override!=='object'||Array.isArray(override)||Object.keys(override).some(key=>key!=='reason'))fail('INVALID_ARGUMENTS','Invalid override',{field:'override',expected:'object with only reason'});
   if(Object.hasOwn(override,'reason')&&(typeof override.reason!=='string'||override.reason.length>500))fail('INVALID_ARGUMENTS','Invalid override reason',{field:'override.reason',expected:'nonblank string, maximum 500 characters'});
   reason=override.reason?.trim();
   if(!reason)fail('OVERRIDE_REASON_REQUIRED','Override reason required',{field:'override.reason',expected:'nonblank string, maximum 500 characters'});
  }
  if(spec.category!=='mutate')return execute(name,a,context);
  const task=service.store.get(a.taskId);
  if(task.submittedBy!==context.principal.id){
   if(!context.principal.admin)fail('TASK_NOT_OWNED','Task is owned by another controller',{field:'taskId',expected:'task owned by authenticated controller'});
   if(!hasOverride)fail('OVERRIDE_REASON_REQUIRED','Override reason required',{field:'override.reason',expected:'nonblank string, maximum 500 characters'});
  }
  const {override,...businessArgs}=a;
  if(!hasOverride)return execute(name,businessArgs,context);
  const operationId=randomUUID();
  try{
   service.store.event(task.id,{type:'task/override',operationId,actor:context.principal.id,submittedBy:task.submittedBy,tool:name,reason,revision:task.revision,attemptId:task.attemptId,via:context.via});
  }catch{fail('OVERRIDE_AUDIT_FAILED','Override audit intent could not be persisted',{field:'override',expected:'durable audit before execution'});}
  // Calling execute enters synchronous clarify/followup before the first await.
  let result,businessError;
  try{result=await execute(name,businessArgs,context);}catch(error){businessError=error;}
  try{
   const outcome={type:'task/override-result',operationId,outcome:businessError?'threw':'returned',attemptId:service.store.get(task.id).attemptId};
   if(businessError)outcome.code=businessError.code??'INTERNAL';
   else{
    // Select only this call's operation fields. Task projections can carry an
    // earlier acknowledgement and error, including on successful replays.
    let operationResult,fields=[];
    switch(name){
     case 'bridge_cancel':operationResult=result?.cancel;fields=['accepted'];break;
     case 'bridge_pause':operationResult=result?.pause;fields=['accepted','replay'];break;
     case 'bridge_resume':operationResult=result?.resume;fields=['accepted','replay'];break;
     case 'bridge_clarify':operationResult={replay:result?.clarificationReplay};fields=['replay'];break;
     case 'bridge_followup':operationResult={replay:result?.followup?.replay};fields=['replay'];break;
     case 'bridge_approve':case 'bridge_reconcile':break;
     case 'bridge_acknowledge':operationResult={accepted:result?.accepted};fields=['accepted'];break;
     case 'bridge_archive':operationResult=result;fields=['archived'];break;
     case 'bridge_cleanup':operationResult=result;fields=['cleaned','eligible'];break;
     case 'bridge_workspace_review':operationResult=result;fields=['passed'];break;
     case 'bridge_workspace_refresh':operationResult=result;fields=['refreshed'];break;
     case 'bridge_workspace_integrate':operationResult=result;fields=['accepted','merged'];break;
    }
    for(const key of fields){
     const value=operationResult?.[key];
     if(typeof value==='boolean')outcome[key]=value;
    }
    const returnedCode=operationResult?.code??operationResult?.error?.code;
    if(typeof returnedCode==='string')outcome.code=returnedCode;
   }
   service.store.event(task.id,outcome);
  }catch{fail('OVERRIDE_AUDIT_INCOMPLETE','Override outcome audit could not be persisted',{field:'override',expected:'inspect task and audit before retry'});}
  if(businessError)throw businessError;
  return result;
 };
}

export function createMcpHandler(service,{registry,allowedHosts=['127.0.0.1','localhost'],maxBodyBytes=2_000_000}={}){
 if(!registry||typeof registry.authenticate!=='function'||!Array.isArray(registry.ids))fail('AUTH_UNAVAILABLE','Controller registry required',{field:'registry',expected:'configured credential source available'});
 const call=createDispatcher(service);
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
   const principal=registry.authenticate(req.headers.authorization);if(!principal){send(res,401,{error:'unauthorized'});return;}
   if(req.method!=='POST'){send(res,405,{error:'POST required'});return;}
   const chunks=[];let size=0;const timeout=setTimeout(()=>req.destroy(),30000);timeout.unref?.();
   try{for await(const chunk of req){size+=chunk.length;if(size>maxBodyBytes){send(res,413,{error:'body too large'});return;}chunks.push(chunk);}}finally{clearTimeout(timeout);}
   const raw=Buffer.concat(chunks).toString('utf8');
   let msg;try{msg=JSON.parse(raw);}catch{send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return;}
   if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'){send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid envelope'}});return;}
   let via;
   try{via=parseViaHeaders(req);}catch(error){send(res,400,{error:'invalid via',code:'VIA_INVALID',details:safeDetails(error.details)});return;}
   const context={principal,via,controllerIds:registry.ids};
   if(msg.method.startsWith('notifications/')){send(res,202);return;}
   if(msg.id===undefined||msg.id===null){send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Request identity required'}});return;}
   let result;
   if(msg.method==='initialize'){
    const supported=['2025-06-18','2025-03-26','2024-11-05'];const requested=msg.params?.protocolVersion;
    result={protocolVersion:supported.includes(requested)?requested:supported[0],capabilities:{tools:{}},serverInfo:{name:'dsh-codex-bridge-v1',version:BRIDGE_VERSION},instructions:'The controller that submits a task (Codex, Claude Code or Antigravity; exactly one per task) owns its planning and acceptance. Prefer bounded Flash implementation and review tasks. Check effective model and permissions. Use task IDs, collect full results, and confirm stopping before cleanup. Skill rules are guidance, not authorization.'};
   }else if(msg.method==='ping')result={};
   else if(msg.method==='tools/list')result={tools:TOOLS};
   else if(msg.method==='tools/call'){
    try{const value=await call(msg.params?.name,msg.params?.arguments,context);result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}
    catch(e){const details=safeDetails(e&&e.details);result={isError:true,content:[{type:'text',text:JSON.stringify({code:e.code??'INTERNAL',message:e.message,...(details?{details}:{})})}]};}
   }else{send(res,200,{jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Method not found'}});return;}
   send(res,200,{jsonrpc:'2.0',id:msg.id,result});
  }catch{if(!res.headersSent)send(res,500,{error:'bridge request failed'});else res.end();}
 };
}
