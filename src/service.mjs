import path from 'node:path';
import { createHash } from 'node:crypto';
import { validatePacket, clone, digest, fail, TERMINAL, isWithin } from './contracts.mjs';
import { resolveModel } from './models.mjs';
import { buildPrompt, buildExecutionPrompt } from './context.mjs';
import { clarificationRequestHash } from './store.mjs';
import { recoverCommandJobs } from './command-jobs.mjs';
import { PROJECT_WAITING, PROJECT_PAUSING, PROJECT_PAUSED, buildProjectPrompt, buildRoundPrompt, createProjectRecord, projectDeadlineRemaining, resolveProjectGrant } from './long-task.mjs';

const ACTIVE = new Set(['starting','running','cancelling',PROJECT_WAITING,PROJECT_PAUSING,PROJECT_PAUSED]);
const LEGACY_PREFLIGHT = Object.freeze({supported:false,reason:'adapter-preflight-unavailable'});
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

// Clarification text is untrusted context. It is carried as an extra inline material
// ONLY for prompt construction, so context.buildPrompt applies its evidence-marker
// validation and fences it as data. The immutable packet and the persisted
// effectivePacket are never modified or replaced by these derived materials.
function clarifiedMaterials(effective,task){
  const clarifications=(Array.isArray(task.clarifications)?task.clarifications:[]).filter(c=>c&&typeof c.text==='string'&&c.text.length>0);
  if(!clarifications.length)return effective.materials;
  return [...effective.materials,...clarifications.map(c=>({text:c.text,version:`clarification ${c.clarificationId} generation ${c.generation}`,sha256:createHash('sha256').update(c.text,'utf8').digest('hex')}))];
}
function derivedPacket(effective,task){return {...effective,materials:clarifiedMaterials(effective,task)};}

// The understanding digest binds revision, generation and attempt for clarified
// attempts, so identical model text in a later generation cannot revive an approval.
// Generation 0 keeps the legacy digest(text) for unchanged single-gate behavior.
function understandingDigest(task,text){
  const generation=task.understandingGeneration??0;
  return generation>0?digest({revision:task.revision,understandingGeneration:generation,attemptId:task.attemptId,text}):digest(text);
}

export class BridgeService {
  constructor({store,adapter,workspaces,profiles=[],skills=[],defaults,maxConcurrent=4,routeLimits={},retention={successDays:7,failureDays:30},supervisor,projects}={}) {
    this.store=store;this.adapter=adapter;this.workspaces=workspaces;this.profiles=profiles;this.skills=skills;this.defaults=defaults;
    if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>128)fail('INVALID_CONFIG','maxConcurrent must be 1..128');
    this.maxConcurrent=maxConcurrent;this.routeLimits=routeLimits;this.running=new Map();this.draining=false;this.closed=false;this.retention=retention;this.cleaning=new Set();
    // Per-task exclusion shared by the durable pause/resume control plane, so a
    // concurrent control operation can never interleave with another one.
    this.controlBusy=new Set();
    // The controlled supervisor (shared reservation ledger, child ledger,
    // notification sink) is optional: absence keeps the historical behaviour.
    this.supervisor=supervisor??null;
    // The long-task project runtime is optional too: absence refuses packet.project
    // and leaves every legacy path byte-identical.
    this.projects=projects??null;
  }
  async submit(packet) {
    const p=validatePacket(packet);
    const catalog=await this.adapter.models();
    const model=resolveModel({task:p.model,defaults:this.defaults,catalog,profiles:this.profiles});
    // An already-accepted identical submission stays reusable without redispatch or a
    // repeated preflight; a conflicting key is rejected exactly as the store would.
    const existing=typeof this.store.find==='function'?this.store.find(p.idempotencyKey):null;
    if(existing){
      if(existing.hash!==digest(p))fail('IDEMPOTENCY_CONFLICT','Idempotency key already belongs to another request');
      return this.view(existing.task);
    }
    // A long-task project grant is resolved against host policy BEFORE any task,
    // session or worktree exists. The durable project record is written WITH the task,
    // so a project task can never be mistaken for an ordinary bounded task after a
    // restart.
    let project;
    if(p.project){
      if(!this.projects)fail('PROJECT_UNSUPPORTED','packet.project requires a configured long-task supervisor runtime on this host');
      let grant;
      try{grant=resolveProjectGrant(p.project,this.projects.config);}
      catch(e){
        const code=e.code==='project/unsupported'?'PROJECT_UNSUPPORTED':e.code==='project/host-cap'?'PROJECT_HOST_CAP':'PROJECT_INVALID';
        fail(code,e.message,{field:'project'});
      }
      project=createProjectRecord({packet:p,grant,now:Date.now()});
    }
    // Preflight stays ahead of store.submit and workspace creation: a rejection or a
    // thrown preflight error leaves no task, session or worktree behind.
    let preflight=LEGACY_PREFLIGHT;
    if(typeof this.adapter.preflight==='function'){
      const result=await this.adapter.preflight(p);
      if(!result||typeof result!=='object'||Array.isArray(result))fail('PREFLIGHT_REJECTED','Adapter preflight returned no usable evidence');
      if(result.ok!==true){
        const reason=typeof result.reason==='string'&&result.reason.trim()?`: ${result.reason.slice(0,500)}`:'';
        fail('PREFLIGHT_REJECTED',`Adapter preflight rejected the task packet${reason}`);
      }
      preflight=clone(result);
    }
    // The trusted callback target snapshot is resolved from host configuration at
    // SUBMISSION and stored immutably on the task: a later configuration change
    // can never retarget an existing task, and send paths never re-resolve it.
    let callbackBinding;
    if(p.rootCallback){
      if(!this.supervisor)fail('CALLBACK_UNGRANTED','rootCallback requires a configured supervisor with trusted callback grants',{field:'rootCallback.grantId'});
      try{callbackBinding=this.supervisor.callbackSnapshot({grantId:p.rootCallback.grantId,taskKey:p.idempotencyKey});}
      catch(e){fail(e.code==='supervisor/callback-ungranted'?'CALLBACK_UNGRANTED':'CALLBACK_INVALID',e.message,{field:'rootCallback.grantId'});}
    }
    const submitted=this.store.submit(p,{effectiveModel:model,preflight,callbackBinding,project});
    // ADMISSION happens exactly once, right after the real task is persisted and before
    // any dispatch: the project deadline is armed and the supervisor's EFFECTIVE packet
    // budget is clamped to the grant here, so a silent or capacity-queued planner is
    // bounded before any model tool is admitted. The task already exists, so an admission
    // fault is recorded and never turned into an ambiguous post-insertion failure.
    if(submitted.created&&project&&this.projects&&typeof this.projects.admitProject==='function'){
      try{this.projects.admitProject(submitted.task.id);}
      catch(e){this.lastError={code:e.code??'PROJECT_ERROR',message:e.message};}
    }
    if(submitted.created)this.kick();
    return this.view(this.store.get(submitted.task.id));
  }
  view(task) {
    const {packet,effectivePacket,result,prompt,callbackBinding,children,...summary}=task;
    return {...summary,title:packet.title,projectId:packet.projectId,role:packet.role,contractVersion:packet.contractVersion,cwd:task.effectivePacket?.cwd??packet.cwd,resultAvailable:!!result?.text,dependencies:packet.dependencies,
      activeChildren:(Number.isInteger(task.activeChildren)&&task.activeChildren>=0)?task.activeChildren:null,
      children:(Array.isArray(children)?children:[]).map(c=>({childId:c.childId,state:c.state,attemptId:c.attemptId,sessionId:c.sessionId??null})),
      callback:callbackBinding?{grantId:callbackBinding.grantId,targetId:callbackBinding.targetId,boundAt:callbackBinding.boundAt??null}:null};
  }
  list(filters){return this.store.list(filters).map(t=>this.view(t));}
  get(id){return this.view(this.store.get(id));}
  kick(){if(!this.closed)queueMicrotask(()=>this.drain().catch(e=>{this.lastError={code:e.code??'INTERNAL',message:e.message};}));}
  async drain(){
    if(this.draining||this.closed)return;this.draining=true;
    try {
      for(const task of this.store.list()) {
        if(this.running.size+this.store.list().filter(t=>['unknown','cancelling'].includes(t.status)&&!this.running.has(t.id)).length>=this.maxConcurrent)break;
        // One authoritative reservation ledger is shared by every supervisor and
        // by this drain: roots and children consume the same configured limit, and
        // unknown/unconfirmed work keeps its slot. Saturation leaves the task
        // queued (bounded), never blocks and never oversubscribes.
        if(this.supervisor&&this.supervisor.ledger.counts().free<=0)break;
        if(task.status!=='queued'||this.running.has(task.id))continue;
        if(!task.effectiveModel){this.finish(task.id,{status:'failed',text:'Queued task has no persisted model selection',stopConfirmed:true,activeJobs:0});continue;}
        const deps=task.packet.dependencies.map(id=>this.store.get(id));
        if(deps.some(d=>['failed','cancelled'].includes(d.status))){this.finish(task.id,{status:'failed',text:'Dependency failed or was cancelled',stopConfirmed:true,activeJobs:0});continue;}
        if(deps.some(d=>d.status!=='completed'||!d.accepted))continue;
        const route=`${task.effectiveModel.provider}/${task.effectiveModel.model}`;
        if([...this.running.values()].filter(r=>r.route===route).length>=(this.routeLimits[route]??this.maxConcurrent))continue;
        // Reserve the shared admission slot SYNCHRONOUSLY before the async host
        // dispatch. It is released only after observed stop proof; an ambiguous
        // settlement keeps it and stays counted.
        if(this.supervisor){const reserved=this.supervisor.ledger.reserve({key:`task:${task.id}`,kind:'root',taskId:task.id,attemptId:task.attemptId,label:task.packet.title});if(!reserved.ok)break;}
        const running={route,timer:setTimeout(()=>this.cancel(task.id,'budget timeout').catch(()=>{}),this.#dispatchTimeoutMs(task))};running.timer.unref?.();this.running.set(task.id,running);
        // Bind this dispatch's failure handling to the attempt it actually started: a
        // late error from a superseded attempt must never settle the newer attempt.
        const attemptId=task.attemptId;
        this.store.update(task.id,{status:'starting',phase:task.packet.understandingRequired&&!task.executionApproved?'understanding':'execution',stopConfirmed:false});
        void this.start(task.id).catch(e=>{
          const current=this.store.get(task.id);
          if(current.attemptId!==attemptId)return;
          const uncertain=current.dispatchStarted===true&&e.dispatched!==false;
          if(!TERMINAL.has(current.status))this.finish(task.id,{status:uncertain?'unknown':'failed',text:e.message,error:{code:e.code??'ADAPTER_ERROR',message:e.message},stopConfirmed:!uncertain,activeJobs:uncertain?null:0},attemptId);
        }).catch(e=>{this.lastError={code:e.code??'INTERNAL',message:e.message};});
      }
    }finally{this.draining=false;}
  }
  async start(id){
    let task=this.store.get(id);let effective=task.effectivePacket??clone(task.packet);
    if(task.packet.workspace&&!task.workspace){
      if(!this.workspaces)fail('WORKSPACE_UNAVAILABLE','No workspace manager configured');
      const w=await this.workspaces.create({taskId:id,...task.packet.workspace});
      const remap=p=>isWithin(task.packet.workspace.repository,p)?path.join(w.path,path.relative(task.packet.workspace.repository,p)):p;
      effective={...effective,cwd:w.path,materials:effective.materials.map(m=>m.path?{...m,path:remap(m.path)}:m),scope:{...effective.scope,readRoots:effective.scope.readRoots.map(remap),writeRoots:effective.scope.writeRoots.map(remap)}};
      task=this.store.update(id,{workspace:w,effectivePacket:effective});
    }
    task=this.store.get(id);
    if(task.status==='cancelling'){this.finish(id,{status:'cancelled',text:'Cancelled before host dispatch',stopConfirmed:true,activeJobs:0});return;}
    if(task.status!=='starting')return;
    effective=validatePacket(effective);
    // At ACTUAL dispatch a project task's own timeout is clamped to the REMAINING project
    // wall time, not the granted total: a supervisor admitted late cannot run past its
    // project. Only the effective packet narrows; the original packet stays immutable.
    if(task.project&&effective.budget){
      const remaining=projectDeadlineRemaining(task.project,Date.now());
      effective={...effective,budget:{...effective.budget,timeoutMs:Math.max(1,Math.min(effective.budget.timeoutMs,remaining))}};
    }
    const selectedSkills=this.skills.filter(s=>(s.layer!=='role'||!s.roles||s.roles.includes(effective.role))&&(s.layer!=='model'||task.effectiveModel.skillIds?.includes(s.id)));
    // The derived packet exists only to build task.prompt with validated clarification
    // context. task.effectivePacket and the packet handed to the adapter stay immutable.
    const promptPacket=derivedPacket(effective,task);
    // A long-task project round gets the supervisor planning prompt; a recurrent
    // continuation round gets the REAL-results review prompt; every other task
    // keeps its exact historical prompt path.
    const prompt=effective.project!==undefined
      ?(task.continuationKind==='supervisor-round'?buildRoundPrompt(effective,task):buildProjectPrompt(effective,task.effectiveModel,task.project?.grant??{workerScope:effective.project.workerScope,maxWorkers:8,maxConcurrentWorkers:3,maxRepairAttempts:2,maxWorkerStarts:24,maxTotalToolCalls:10000,timeoutMs:3600000},task.id))
      :task.executionApproved?buildExecutionPrompt(promptPacket,task.understanding):buildPrompt(promptPacket,{model:task.effectiveModel,skills:selectedSkills});
    task=this.store.update(id,{prompt,effectivePacket:effective,startedAt:Date.now()});
    const attemptId=task.attemptId;
    const callbacks={onEvent:e=>this.onEvent(id,attemptId,e),onResult:r=>this.finish(id,r,attemptId)};
    // Mark dispatch before crossing the host boundary. A crash here reconciles as unknown, never auto replays.
    this.store.update(id,{dispatchStarted:true,dispatchPending:true});
    this.store.event(id,{type:'task/dispatching',revision:task.revision,attemptId});
    const run=this.running.get(id);if(run){run.dispatchPending=true;run.attemptId=attemptId;}
    const hostTask={...task,packet:effective};
    let receipt;try{
      if(task.continuationKind==='clarification'){
        // Clarifications always reuse the existing owned session; never start or continue.
        if(typeof this.adapter.reconsider!=='function'){
          // A local refusal is an explicit non-dispatch: no prompt crossed the host
          // boundary, so it carries the same dispatched:false contract as an adapter error.
          const error=new Error('This adapter cannot open a new understanding attempt in the existing session');
          error.code='CLARIFICATION_UNSUPPORTED';error.dispatched=false;throw error;
        }
        receipt=await this.adapter.reconsider(hostTask,callbacks);
      }else if(task.continuationKind==='supervisor-round'){
        // A bounded RECURRENT supervisor round reuses the SAME owned session through the
        // dedicated adapter seam: it re-proves terminal true/0/0, ownership and the
        // guarded live agent, installs the current round's narrowed allowance and never
        // creates a session or a new model route. A local refusal carries dispatched:false.
        if(typeof this.adapter.nextRound!=='function'){
          const error=new Error('This adapter cannot open another supervisor round in the existing session');
          error.code='ROUND_UNSUPPORTED';error.dispatched=false;throw error;
        }
        receipt=await this.adapter.nextRound(hostTask,callbacks);
      }else if(task.executionApproved&&task.sessionId){
        receipt=await this.adapter.continue(hostTask,task.understanding,callbacks);
      }else{
        receipt=await this.adapter.start(hostTask,callbacks);
      }
    }catch(e){
      // A definite non-dispatch from THIS attempt (explicit dispatched:false) proves no
      // prompt was submitted, so no receipt can ever resolve the persisted marker. Clear
      // only this attempt's marker and retain the non-dispatch evidence; a late error from
      // a superseded attempt must never clear or mutate the newer attempt's state.
      const latest=this.store.get(id);
      if(e&&e.dispatched===false&&latest.attemptId===attemptId){
        this.store.update(id,{dispatchPending:false,dispatchFailure:{dispatched:false,code:e.code??'ADAPTER_ERROR',message:e.message,attemptId,at:Date.now()}});
        this.store.event(id,{type:'task/dispatch-failed',dispatched:false,code:e.code??'ADAPTER_ERROR',attemptId,revision:task.revision});
      }
      throw e;
    }finally{if(run&&run.attemptId===attemptId)run.dispatchPending=false;}
    const current=this.store.get(id);
    if(current.attemptId!==task.attemptId)return;
    // Only this attempt's receipt resolves the persisted dispatch-pending marker.
    const changes={sessionId:receipt.sessionId,requestId:receipt.requestId,effectiveModel:receipt.effectiveModel??task.effectiveModel,effectivePolicy:receipt.effectivePolicy,dispatchReceiptAt:Date.now(),dispatchPending:false};
    if(current.status==='starting')changes.status='running';
    this.store.update(id,changes);
    if(current.status==='cancelling')await this.cancel(id,'cancellation requested during dispatch');
    this.store.event(id,{type:'task/accepted',sessionId:receipt.sessionId,requestId:receipt.requestId,revision:task.revision,attemptId:task.attemptId});
  }
  onEvent(id,attemptId,event){
    const task=this.store.get(id);if(task.attemptId!==attemptId||TERMINAL.has(task.status))return;
    this.store.event(id,{...event,attemptId,revision:task.revision});
    if(event.type==='tool/start'){
      const stats={...task.stats,toolCalls:task.stats.toolCalls+1};this.store.update(id,{stats});
      // The EFFECTIVE budget is enforced, not the immutable original request: a project
      // supervisor's admitted packet is clamped to the project grant, so the hard planner
      // tool budget really bounds the live round. The store counter is CUMULATIVE across
      // attempts, so a recurrent supervisor ROUND is bounded by its own delta against the
      // baseline persisted before dispatch; every legacy path (baseline 0) keeps the
      // historical cumulative comparison byte-for-byte.
      const toolLimit=task.effectivePacket?.budget?.maxToolCalls??task.packet.budget.maxToolCalls;
      const roundBaseline=task.continuationKind==='supervisor-round'&&task.project&&Number.isInteger(task.project.roundBaselineToolCalls)?task.project.roundBaselineToolCalls:0;
      const spent=Math.max(0,stats.toolCalls-roundBaseline);
      if(spent>toolLimit&&task.status!=='cancelling')void this.cancel(id,'tool budget exceeded').catch(()=>{});
    }
  }
  // finish never clears the persisted dispatch-pending marker: a result can arrive
  // before the dispatch receipt, and only that attempt's receipt (or its explicit
  // dispatched:false refusal in start) may resolve it.
  finish(id,result,attemptId){
    const task=this.store.get(id);if((attemptId&&task.attemptId!==attemptId)||TERMINAL.has(task.status)||task.status==='awaiting_approval')return;
    const entry=this.running.get(id);if(entry?.timer)clearTimeout(entry.timer);this.running.delete(id);
    // A long-task project task NEVER maps a model round straight onto a terminal task
    // status: only verified stopped owned work may complete or cleanly fail a project.
    // The runtime owns every project transition; legacy tasks are untouched.
    if(task.project){
      if(this.projects){
        // The authoritative child count is resolved BEFORE the round is forwarded: an
        // omitted count comes from the real owned-child manager, an explicit null stays
        // unknown, and the provenance names the component actually consulted.
        const children=this.#resolveChildren(id,result.activeChildren);
        void this.projects.onSupervisorFinished(id,{...result,activeChildren:children.activeChildren,activeChildrenSource:children.activeChildrenSource},attemptId).catch(e=>{this.lastError={code:e.code??'PROJECT_ERROR',message:e.message};});
      }else{
        this.store.update(id,{status:'unknown',phase:'project',stopConfirmed:false,error:{code:'PROJECT_UNSUPPORTED',message:'a project task settled without a configured long-task runtime'}});
      }
      // Releasing the supervisor's model slot can unblock unrelated queued work, so the
      // drain is kicked here too: a project finish never starves a queued regular task.
      this.kick();
      return;
    }
    const allowed=['completed','failed','cancelled','unknown'];let status=allowed.includes(result.status)?result.status:'unknown';
    const reportedStop=result.stopConfirmed===true;const activeJobs=result.activeJobs===0?0:(result.activeJobs??null);
    // A live child session is owned work exactly like a live job: a terminal status is
    // recorded only when both are zero and the host confirmed the stop. A count that was
    // merely OMITTED is resolved from the real owned-child manager; an explicit null is
    // unknown and is never inferred as zero.
    const children=this.#resolveChildren(id,result.activeChildren);
    const activeChildren=children.activeChildren;const activeChildrenSource=children.activeChildrenSource;
    // The AGGREGATE stop flag is only ever claimed by strict positive proof: a TERMINAL
    // claim requires a confirmed stop AND explicit numeric-zero jobs and children. An
    // unproven, nonzero or null-count terminal settlement stays honestly unknown with
    // stopConfirmed false; the host observation itself is kept in the evidence, never
    // fabricated into aggregate proof. A host status that is not a terminal claim keeps its
    // own stop observation unchanged.
    const claimedTerminal=TERMINAL.has(status);
    const provenStop=claimedTerminal&&reportedStop&&activeJobs===0&&activeChildren===0;
    if(claimedTerminal&&!provenStop)status='unknown';
    const stopConfirmed=claimedTerminal?provenStop:reportedStop;
    const diagnosticText=typeof result.text==='string'?result.text:'';
    // A completed result is the model's last assistant handoff: an explicit
    // finalText wins even when empty. Legacy adapters that omit finalText keep
    // the diagnostic text, and failed/unknown results always keep it.
    const text=status==='completed'&&typeof result.finalText==='string'?result.finalText:diagnosticText;
    if(task.phase==='understanding'&&status==='completed'){
      const understandingHash=understandingDigest(task,text);
      this.store.update(id,{status:'awaiting_approval',phase:'awaiting_approval',understanding:text,understandingHash,stopConfirmed,activeJobs,activeChildren,activeChildrenSource,result:{text,evidence:result.evidence??[],checks:result.checks??[],uncertainties:result.uncertainties??[]}});
    }else{
      this.store.update(id,{status,phase:status,endedAt:Date.now(),stopConfirmed,activeJobs,activeChildren,activeChildrenSource,error:result.error??null,result:{text,evidence:result.evidence??[],checks:result.checks??[],uncertainties:result.uncertainties??[]},stats:{...task.stats,...result.stats}});
    }
    const recorded=this.store.get(id).status;
    this.#settleReservation(id,{status:recorded,stopConfirmed,activeJobs,activeChildren});
    this.store.event(id,{type:'task/settled',status:recorded,stopConfirmed,activeJobs,...(activeChildren>0?{activeChildren}:{}),attemptId:task.attemptId});
    // Persist-then-send: only a genuinely terminal, stopped task whose trusted
    // callback grant is bound may wake the root. A reply is a separate path and
    // never a settlement.
    if(TERMINAL.has(recorded))this.#notifySettlement(id,recorded,text);
    // Worker tasks feed their owning project; a worker has no callback binding, so this
    // never wakes the coordinator on its own.
    if(this.projects){
      const settled=this.store.get(id);
      if(!settled.project)void Promise.resolve().then(()=>this.projects.onTaskSettled(settled)).catch(e=>{this.lastError={code:e.code??'PROJECT_ERROR',message:e.message};});
      // Capacity held by ANY task can be what a waiting project needs; re-kick the
      // waiting projects so a project is never stalled behind unrelated work.
      try{this.projects.onAnySettled();}catch(e){this.lastError={code:e.code??'PROJECT_ERROR',message:e.message};}
    }
    this.kick();
  }
  /**
   * A project task may never outlive its project. Its dispatch budget is the effective
   * (already admitted/clamped) packet timeout, further clamped at ACTUAL dispatch to the
   * REMAINING project wall time rather than the original granted total.
   */
  #dispatchTimeoutMs(task){
    const granted=task.effectivePacket?.budget?.timeoutMs??task.packet.budget.timeoutMs;
    if(!task.project)return granted;
    const remaining=projectDeadlineRemaining(task.project,Date.now());
    return Math.max(1,Math.min(granted,remaining));
  }
  /**
   * Resolve the AUTHORITATIVE live-child count and its provenance for one owned task. An
   * explicit numeric host count wins; an explicit `null` stays UNKNOWN and is never turned
   * into zero; an omitted count is resolved from the real owned-child manager. A configured
   * manager that cannot inspect — because it throws OR because its inspector is missing —
   * stays unknown. Authoritative zero exists ONLY on a legacy host with no child manager
   * wired at all; absence of an answer is never a numeric zero.
   * @returns {{activeChildren: number|null, activeChildrenSource: string}}
   */
  #resolveChildren(id,reported){
    if(reported!==undefined){
      if(reported===null)return {activeChildren:null,activeChildrenSource:'host-reported'};
      return {activeChildren:Number.isInteger(reported)&&reported>=0?reported:null,activeChildrenSource:'host-reported'};
    }
    if(!this.supervisor)return {activeChildren:0,activeChildrenSource:'legacy-no-child-manager'};
    if(typeof this.supervisor.liveChildren!=='function')return {activeChildren:null,activeChildrenSource:'owned-manager-unavailable'};
    try{return {activeChildren:this.supervisor.liveChildren(id).length,activeChildrenSource:'owned-manager'};}catch{return {activeChildren:null,activeChildrenSource:'owned-manager-unavailable'};}
  }
  // Release the shared admission slot ONLY after observed stop proof. A task that
  // settled unknown (or is still active) keeps its slot marked ambiguous, so
  // capacity is never fabricated and unknown work stays counted.
  #settleReservation(id,{status,stopConfirmed,activeJobs,activeChildren}){
    if(!this.supervisor)return;
    const key=`task:${id}`;
    if(!this.supervisor.ledger.has(key))return;
    if(TERMINAL.has(status)&&stopConfirmed===true&&activeJobs===0&&activeChildren===0){
      this.supervisor.ledger.release(key,{stopConfirmed:true,reason:`task ${status}`});
    }else{
      this.supervisor.ledger.markUnknown(key,`task ${status} with stopConfirmed=${stopConfirmed}, activeJobs=${activeJobs}, activeChildren=${activeChildren}`);
    }
  }
  // Settlement notification for a task with a persisted callback binding. The
  // task status is never changed here; no sink means an explicitly unsupported
  // outcome (recorded as such), never a claimed delivery.
  #notifySettlement(id,status,text){
    const task=this.store.get(id);
    if(!task.callbackBinding||!this.supervisor)return;
    const summary=typeof text==='string'?text.slice(0,2000):'';
    void Promise.resolve()
      .then(()=>this.supervisor.notifySettlement({task,status,summary}))
      .then(outcome=>{this.store.update(id,{settlementNotification:{outcome:outcome?.outcome??'unknown',delivery:outcome?.delivery??'unknown',delivered:outcome?.delivered===true,eventId:outcome?.eventId??null,at:Date.now()}});})
      .catch(e=>{this.store.update(id,{settlementNotification:{outcome:'unknown',delivery:'unknown',delivered:false,error:{code:e.code??'NOTIFY_ERROR',message:e.message},at:Date.now()}});});
  }
  clarify(id,{revision,understandingHash,clarificationId,text}={}){
    if(!Number.isSafeInteger(revision)||revision<1)fail('CLARIFICATION_CONFLICT','revision must be a positive safe integer');
    if(typeof understandingHash!=='string'||!understandingHash.trim())fail('CLARIFICATION_CONFLICT','understandingHash must be a nonblank string');
    if(typeof clarificationId!=='string'||!clarificationId.trim()||clarificationId.length>200)fail('CLARIFICATION_CONFLICT','clarificationId must be a nonblank string of at most 200 characters');
    if(typeof text!=='string'||!text.trim()||text.length>20000)fail('CLARIFICATION_CONFLICT','text must be a nonblank string of at most 20000 characters');
    const current=this.store.get(id);
    const requestHash=clarificationRequestHash({revision,understandingHash,clarificationId,text});
    // Replay lookup precedes eligibility: an identical replay still returns the same
    // task after the clarification status has advanced.
    const existing=(current.clarifications??[]).find(c=>c.clarificationId===clarificationId);
    if(existing){
      if(existing.requestHash!==requestHash)fail('CLARIFICATION_CONFLICT','clarificationId already binds different clarification content');
      return {...this.get(id),clarificationReplay:true};
    }
    if(current.revision!==revision||current.understandingHash!==understandingHash)fail('CLARIFICATION_CONFLICT','Clarification must match the awaiting task revision and understanding hash');
    if(current.status!=='awaiting_approval')fail('CLARIFICATION_CONFLICT','Clarification requires an awaiting_approval task');
    if(current.stopConfirmed!==true||current.activeJobs!==0)fail('SESSION_NOT_READY','Clarification requires a stopped session with zero active jobs');
    if(typeof current.sessionId!=='string'||!current.sessionId.trim()||!Number.isFinite(current.dispatchReceiptAt))fail('SESSION_NOT_READY','Clarification requires the persisted session and dispatch receipt');
    if(current.dispatchPending===true||this.running.get(id)?.dispatchPending===true)fail('SESSION_NOT_READY','Clarification cannot start while a dispatch receipt is still pending');
    // Capability support is decided by method existence only; capabilities() must not be awaited here.
    if(typeof this.adapter.reconsider!=='function')fail('CLARIFICATION_UNSUPPORTED','This adapter cannot open a new understanding attempt in the existing session');
    const outcome=this.store.clarify(id,{clarificationId,text,revision,understandingHash});
    if(!outcome.created)return {...this.get(id),clarificationReplay:true};
    this.kick();
    return this.get(id);
  }
  approve(id,{revision,understandingHash}){
    const task=this.store.get(id);
    if(task.status!=='awaiting_approval'||revision!==task.revision||understandingHash!==task.understandingHash)fail('APPROVAL_CONFLICT','Approval must match the awaiting task revision and understanding');
    // An unfinished understanding dispatch has no accountable receipt yet, so a
    // result-before-receipt race can never authorize execution on its own.
    if(task.dispatchPending===true||this.running.get(id)?.dispatchPending===true)fail('APPROVAL_CONFLICT','Approval cannot start while a dispatch receipt is still pending');
    if(task.stopConfirmed!==true||task.activeJobs!==0)fail('APPROVAL_CONFLICT','Approval requires a stopped understanding attempt with zero active jobs');
    if(typeof task.sessionId!=='string'||!task.sessionId.trim())fail('APPROVAL_CONFLICT','Approval requires the persisted session of the understanding dispatch');
    if(!Number.isFinite(task.dispatchReceiptAt))fail('APPROVAL_CONFLICT','Approval requires the persisted receipt of the understanding dispatch');
    this.store.beginAttempt(id,{executionApproved:true,status:'queued',phase:'queued',continuationKind:null,dispatchStarted:false,dispatchPending:false,dispatchReceiptAt:null,requestId:null});this.store.event(id,{type:'task/approved',revision,understandingHash});this.kick();return this.get(id);
  }
  /**
   * Durable pause of a recurrent supervisor project. The request is persisted before
   * this returns, all NEW admission (worker attempt and supervisor round) is held, and
   * owned work finishes naturally. The project becomes `paused` only once the current
   * round and every genuinely owned attempt prove a positive stop with no pending
   * dispatch; until then it is honestly `pausing`. Idempotent by `requestId`.
   */
  async pause(id,{requestId,reason}={}){
    if(typeof requestId!=='string'||!requestId.trim()||requestId.length>200)fail('INVALID_PAUSE','requestId must be a nonblank string of at most 200 characters',{field:'requestId',expected:'nonblank string of at most 200 characters'});
    const task=this.store.get(id);
    if(!task.project)fail('PROJECT_UNSUPPORTED','pause requires a long-task project task');
    if(!this.projects)fail('PROJECT_UNSUPPORTED','no long-task supervisor runtime is configured on this host');
    if(task.project.grant?.pause!==true)fail('PROJECT_PAUSE_UNSUPPORTED','this project did not opt into pause/resume: host supervisorProjects.pause and packet.project.maxRounds >= 2 are both required');
    if(this.controlBusy.has(id))fail('PROJECT_BUSY','another pause/resume operation is already running for this task');
    this.controlBusy.add(id);
    try{
      // Perform the durable mutation FIRST, then read the honest post-mutation state:
      // spreading a pre-mutation `this.get(id)` would report the stale `supervising`
      // status even though the pause request was already persisted and admission held.
      const outcome=this.projects.pauseRequest({taskId:id,requestId:requestId.trim(),reason});
      return {...this.get(id),pause:outcome};
    }
    finally{this.controlBusy.delete(id);}
  }
  /**
   * Resume a durable pause checkpoint. The runtime re-reads the real stop, ownership and
   * dispatch evidence plus the immutable deadline and cumulative budget BEFORE any
   * admission, then continues the SAME task record (no copy, no budget reset, no deadline
   * extension) or refuses with a typed code and keeps the checkpoint. Idempotent by
   * `requestId`.
   */
  async resume(id,{requestId,reason}={}){
    if(typeof requestId!=='string'||!requestId.trim()||requestId.length>200)fail('INVALID_RESUME','requestId must be a nonblank string of at most 200 characters',{field:'requestId',expected:'nonblank string of at most 200 characters'});
    const task=this.store.get(id);
    if(!task.project)fail('PROJECT_UNSUPPORTED','resume requires a long-task project task');
    if(!this.projects)fail('PROJECT_UNSUPPORTED','no long-task supervisor runtime is configured on this host');
    if(task.project.grant?.pause!==true)fail('PROJECT_PAUSE_UNSUPPORTED','this project did not opt into pause/resume: host supervisorProjects.pause and packet.project.maxRounds >= 2 are both required');
    if(this.controlBusy.has(id))fail('PROJECT_BUSY','another pause/resume operation is already running for this task');
    this.controlBusy.add(id);
    try{
      // Same rule as pause: mutate first, then report the FRESH post-mutation state, so a
      // resumed project is never reported with its stale pre-resume status/checkpoint.
      const outcome=this.projects.resumeRequest({taskId:id,requestId:requestId.trim(),reason});
      return {...this.get(id),resume:outcome};
    }
    finally{this.controlBusy.delete(id);}
  }
  async cancel(id,reason='controller requested'){    const task=this.store.get(id);if(TERMINAL.has(task.status))return {accepted:false,alreadyFinished:true,...this.view(task)};
    // A controller cancellation is recorded durably BEFORE it is attempted: a worker
    // cancelled by the controller must stay cancelled and can never be mistaken for an
    // ordinary failure that the long-task orchestrator may repair.
    this.store.update(id,{cancellationRequested:{reason:String(reason??'').slice(0,200),at:Date.now()}});
    // A project waiting between rounds, or held in a pause checkpoint, has no live
    // supervisor session to cancel: the runtime cancels its owned workers and reports
    // whether every stop was proven. A cancel request is never a resume.
    if(task.project&&this.projects&&(task.status===PROJECT_WAITING||task.status===PROJECT_PAUSING||task.status===PROJECT_PAUSED)){
      const outcome=await this.projects.requestProjectCancel(id,reason);
      return {...this.get(id),cancel:outcome};
    }
    if(['queued','awaiting_approval'].includes(task.status)&&!this.running.has(id)){
      // Structural zero jobs is genuine ONLY for work that never crossed the host boundary
      // and has no dispatch in flight. An awaiting-approval task (or a queued task with a
      // session, a dispatch marker or a persisted receipt) is ALREADY-DISPATCHED work: it
      // must show its own persisted stop flag AND an explicit numeric-zero job count. A
      // missing/null/nonzero count is never coerced into zero, and the owned-child count is
      // resolved with its real provenance (a configured-but-inspectable manager that cannot
      // answer is unknown, not zero).
      const dispatched=task.dispatchStarted===true||task.dispatchPending===true||this.running.get(id)?.dispatchPending===true||(typeof task.sessionId==='string'&&task.sessionId.trim()!=='')||Number.isFinite(task.dispatchReceiptAt);
      const children=this.#resolveChildren(id);
      const activeJobs=dispatched?(Number.isInteger(task.activeJobs)?task.activeJobs:null):0;
      const stopProven=dispatched?task.stopConfirmed===true:true;
      const stoppedClean=stopProven&&activeJobs===0&&children.activeChildren===0;
      this.store.update(id,{status:stoppedClean?'cancelled':'unknown',phase:stoppedClean?'cancelled':'cancelling',endedAt:Date.now(),stopConfirmed:stoppedClean,activeJobs,activeChildren:children.activeChildren,activeChildrenSource:children.activeChildrenSource});
      this.store.event(id,{type:'task/cancelled-before-dispatch',reason});
      // The cancellation record is durable BEFORE capacity is settled, and the SAME genuine
      // evidence decides both: a release happens only on a proven true/0/0, exactly once,
      // for this task's own root key. A duplicate cancel returns on the terminal early-return
      // and never settles a second time.
      this.#settleReservation(id,{status:stoppedClean?'cancelled':'unknown',stopConfirmed:stoppedClean,activeJobs,activeChildren:children.activeChildren});
      // A queued WORKER cancelled before dispatch still has to reach its project, and a
      // queued PROJECT cancelled before dispatch still has to settle its own record.
      if(this.projects){
        const settled=this.store.get(id);
        if(settled.project)void Promise.resolve().then(()=>this.projects.requestProjectCancel(id,reason)).catch(e=>{this.lastError={code:e.code??'PROJECT_ERROR',message:e.message};});
        else void Promise.resolve().then(()=>this.projects.onTaskSettled(settled)).catch(e=>{this.lastError={code:e.code??'PROJECT_ERROR',message:e.message};});
      }
      return this.get(id);
    }
    this.store.update(id,{status:'cancelling',phase:'cancelling'});this.store.event(id,{type:'task/cancel-requested',reason});
    if(!task.dispatchStarted){if(!this.running.has(id))this.finish(id,{status:'cancelled',text:'Never dispatched',stopConfirmed:true,activeJobs:0});return this.get(id);}
    // A cancel outcome or error is DELAYED host evidence: it must never overwrite a newer
    // attempt, nor a SAME attempt that already settled with a positive stop. Without this
    // fence a late `adapter/unknown-task` from a timeout cancellation can clobber the
    // numeric-zero stop proof a later receipt established (see watchdog-brief.md item 2).
    const cancelAttemptId=this.store.get(id).attemptId;
    try{
      const outcome=await this.adapter.cancel(this.store.get(id));
      if(this.#cancelWriteAllowed(id,cancelAttemptId)){
        if(outcome.stopConfirmed===true&&Array.isArray(outcome.remaining)&&outcome.remaining.length===0&&!this.running.get(id)?.dispatchPending)this.finish(id,{status:'cancelled',text:this.store.get(id).result.text,stopConfirmed:true,activeJobs:0},cancelAttemptId);
        else this.store.update(id,{stopConfirmed:false,cancelRemaining:outcome.remaining??['confirmation unavailable']});
      }
      return {...this.get(id),cancel:outcome};
    }catch(e){
      if(this.#cancelWriteAllowed(id,cancelAttemptId))this.store.update(id,{cancelError:{code:e.code??'CANCEL_ERROR',message:e.message},stopConfirmed:false});
      throw e;
    }
  }
  /**
   * Whether a delayed cancel outcome/error may still be persisted. It may not when the
   * task advanced to a different (newer) attempt, nor when the SAME attempt is already
   * a positively stopped terminal record — an explicit numeric zero for both jobs and
   * children and a confirmed stop. Missing/null counts are unknown, never zeros.
   */
  #cancelWriteAllowed(id,attemptId){
    const current=this.store.get(id);
    if(current.attemptId!==attemptId)return false;
    return !this.#positivelyStopped(current);
  }
  #positivelyStopped(task){
    if(!['completed','failed','cancelled'].includes(task.status))return false;
    if(task.stopConfirmed!==true)return false;
    if(!Number.isInteger(task.activeJobs)||task.activeJobs!==0)return false;
    if(!Number.isInteger(task.activeChildren)||task.activeChildren!==0)return false;
    return true;
  }
  async wait(id,{after=0,waitMs=0,limit=100}={}){
    if(!Number.isFinite(waitMs)||waitMs<0||waitMs>60000)fail('INVALID_WAIT','waitMs must be 0..60000');
    const deadline=Date.now()+waitMs;
    while(true){const task=this.store.get(id);const events=this.store.events(id,{after,limit});if(events.length||!ACTIVE.has(task.status)&&task.status!=='queued'||Date.now()>=deadline)return {task:this.view(task),events,cursor:events.at(-1)?.seq??after};await sleep(Math.min(100,deadline-Date.now()));}
  }
  result(id,{offset=0,limit=20000}={}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100000)fail('INVALID_CURSOR','Invalid result slice');
    const t=this.store.get(id);const text=t.result.text;return {taskId:id,revision:t.revision,attemptId:t.attemptId,status:t.status,text:text.slice(offset,offset+limit),offset,nextOffset:Math.min(text.length,offset+limit),totalChars:text.length,hasMore:offset+limit<text.length,evidence:t.result.evidence,checks:t.result.checks,uncertainties:t.result.uncertainties};
  }
  acknowledge(id,{revision,accepted=false,artifactState,pinned}={}){
    const t=this.store.get(id);if(revision!==t.revision||!TERMINAL.has(t.status))fail('ACK_CONFLICT','Only matching terminal task can be acknowledged');
    if(accepted&&(t.status!=='completed'||t.stopConfirmed!==true||t.activeJobs!==0))fail('ACK_CONFLICT','Only completed, settled tasks may be accepted');
    if(artifactState!==undefined&&!['none','merged','preserved','discarded','unresolved'].includes(artifactState))fail('INVALID_ARTIFACT_STATE','Unknown artifact state');
    if(artifactState==='merged'&&t.integration?.accepted!==true)fail('INVALID_ARTIFACT_STATE','Merged state requires verified integration evidence');
    if(t.workspace&&artifactState==='none')fail('INVALID_ARTIFACT_STATE','Workspace artifacts require explicit preservation, merge or discard');
    if(pinned!==undefined&&typeof pinned!=='boolean')fail('INVALID_PIN','pinned must be boolean');
    this.store.update(id,{resultCollected:true,accepted,...(artifactState!==undefined?{artifactState}:{}),...(pinned!==undefined?{pinned}:{})});this.kick();return this.get(id);
  }
  // UI archive hides an owned, settled session without touching the worktree, result,
  // evidence, endedAt, legacy archivedAt or the retention clock. It shares the task-level
  // exclusion with cleanup so archive and cleanup cannot race.
  async archive(id,{revision}={}){
    if(!Number.isSafeInteger(revision)||revision<1)fail('ARCHIVE_CONFLICT','revision must be a positive safe integer');
    const eligible=t=>{
      if(!TERMINAL.has(t.status))fail('ARCHIVE_CONFLICT','Only a completed, failed or cancelled task can be archived');
      if(t.resultCollected!==true)fail('ARCHIVE_CONFLICT','The result must be collected before its session is hidden');
      if(t.stopConfirmed!==true||t.activeJobs!==0)fail('ARCHIVE_CONFLICT','The task must be stopped with zero active jobs');
      const resolved=t.workspace?['merged','preserved','discarded']:['none','merged','preserved','discarded'];
      if(!resolved.includes(t.artifactState))fail('INVALID_ARTIFACT_STATE','Workspace artifacts must be resolved before the session is hidden');
    };
    let task=this.store.get(id);
    if(task.revision!==revision)fail('ARCHIVE_CONFLICT','Archive must match the owned task revision');
    eligible(task);
    if(this.cleaning.has(id))fail('CLEANUP_BUSY','Archive or cleanup is already running for this task');
    this.cleaning.add(id);
    try{
      task=this.store.get(id);
      if(task.revision!==revision)fail('ARCHIVE_CONFLICT','Archive must match the owned task revision');
      eligible(task);
      if(task.dispatchPending===true||this.running.get(id)?.dispatchPending===true)fail('ARCHIVE_CONFLICT','Archive cannot proceed while a dispatch receipt is pending');
      if(typeof this.adapter.archive!=='function')return {taskId:id,revision,archived:false,uiHidden:false,supported:false,sessionArchivedAt:task.sessionArchivedAt??null,workspacePreserved:true,evidencePreserved:true};
      let outcome;
      try{outcome=await this.adapter.archive(this.store.get(id));}
      catch(e){return {taskId:id,revision,archived:false,uiHidden:false,supported:true,outcome:'unknown',retryable:true,error:{code:e.code??'ARCHIVE_ERROR',message:e.message}};}
      // Recheck identity/eligibility after the await before any success marker is stored.
      const after=this.store.get(id);
      if(after.revision!==revision)fail('ARCHIVE_CONFLICT','The task changed while its session was being archived');
      eligible(after);
      if(!outcome||typeof outcome!=='object'||outcome.archived!==true||outcome.uiHidden!==true){
        const unknown=outcome?.outcome==='unknown'||outcome?.retryable===true;
        return {taskId:id,revision,archived:false,uiHidden:false,supported:outcome?.supported!==false,...(unknown?{outcome:'unknown',retryable:true}:{}),sessionArchivedAt:after.sessionArchivedAt??null,workspacePreserved:true,evidencePreserved:true};
      }
      const sessionArchivedAt=after.sessionArchivedAt??Date.now();
      this.store.update(id,{sessionArchivedAt,archive:{archived:true,uiHidden:true,sessionId:outcome.sessionId??after.sessionId??null,workspacePreserved:true,evidencePreserved:true,at:Date.now()}});
      this.store.event(id,{type:'task/session-archived',revision,uiHidden:true});
      return {taskId:id,revision,archived:true,uiHidden:true,sessionArchivedAt,workspacePreserved:true,evidencePreserved:true};
    }finally{this.cleaning.delete(id);}
  }
  async recover(){
    for(const t of this.store.list()){
      if(!ACTIVE.has(t.status)&&t.status!=='unknown')continue;
      // A long-task project carries its own durable plan. Recovery never replays the
      // supervisor round and never redispatches ambiguous worker work: the runtime
      // either resumes the deterministic plan from persisted state or fails closed.
      if(t.project&&this.projects){
        let events=[];
        try{let after=0;for(;;){const page=this.store.events(t.id,{after,limit:1000});if(!Array.isArray(page)||page.length===0)break;events.push(...page);const lastSeq=page[page.length-1]?.seq;if(page.length<1000||!Number.isSafeInteger(lastSeq)||lastSeq<=after)break;after=lastSeq;}}catch(e){this.store.update(t.id,{notificationRecovery:{outcome:'unknown',error:e?.message??String(e)}});}
        if(this.supervisor)this.supervisor.recoverTask(t,events);
        const report=await this.projects.recoverProject(this.store.get(t.id));
        this.store.update(t.id,{projectRecovery:report});
        continue;
      }
      // Recovery adopts work that ALREADY EXISTS into the shared ledger: an
      // active task, a persisted child and a persisted command job all stay
      // counted, are marked unknown without replay, and never release a slot
      // without observed stop proof.
      if(this.supervisor){
        this.supervisor.ledger.adopt({key:`task:${t.id}`,kind:'root',taskId:t.id,attemptId:t.attemptId,label:t.packet?.title,reason:`recovered active task (${t.status})`});
        // Bounded pagination over the store's (after,limit) cursor: notification
        // dedupe identities beyond the first page MUST be adopted too, or a
        // post-restart settlement could re-send an already-persisted event. A
        // page read failure is recorded explicitly instead of being mistaken for
        // "this task proved it has no notification".
        let events=[];let notificationRecovery=null;
        try{
          let after=0;
          for(;;){
            const page=this.store.events(t.id,{after,limit:1000});
            if(!Array.isArray(page)||page.length===0)break;
            events.push(...page);
            const lastSeq=page[page.length-1]?.seq;
            if(page.length<1000||!Number.isSafeInteger(lastSeq)||lastSeq<=after)break;
            after=lastSeq;
          }
        }catch(e){notificationRecovery={outcome:'unknown',error:e?.message??String(e)};}
        const report=this.supervisor.recoverTask(t,events);
        const jobRecovery=recoverCommandJobs(t.commandJobs);
        const patch={};
        if(notificationRecovery)patch.notificationRecovery=notificationRecovery;
        if(report.children.length)patch.childrenRecovery=report.children;
        if(report.adoptions>0)patch.notificationAdoptions=report.adoptions;
        if(jobRecovery.length)patch.jobRecovery=jobRecovery;
        patch.activeChildren=this.supervisor.liveChildren(t.id).length;
        this.store.update(t.id,patch);
      }
      if(!t.dispatchStarted){this.finish(t.id,{status:'failed',text:'Interrupted before dispatch',stopConfirmed:true,activeJobs:0});continue;}
      try{
        const observation=await this.adapter.inspect(t);
        if(TERMINAL.has(observation.status)&&observation.stopConfirmed===true&&observation.activeJobs===0)this.finish(t.id,observation,t.attemptId);
        else this.store.update(t.id,{status:'unknown',phase:'reconciliation',stopConfirmed:false,recovery:observation});
      }catch(e){this.store.update(t.id,{status:'unknown',phase:'reconciliation',stopConfirmed:false,recovery:{error:e.message}});}
    }
    this.kick();
  }
  async reconcile(id){
    const t=this.store.get(id);
    // A project is reconciled from its own persisted plan: no model round is replayed
    // and no worker is redispatched; the runtime re-evaluates real stop evidence.
    if(t.project&&this.projects){
      const boundAttemptId=t.attemptId;
      // The real inspector is consulted FIRST, so reconciliation consumes actual host
      // evidence instead of a terminal string alone. A non-throwing `unknown` report is
      // still reported honestly (unproven), never fabricated into a stop.
      let observation=null;
      try{observation=await this.adapter.inspect(t);}
      catch(e){observation={status:'unknown',stopConfirmed:false,activeJobs:null,activeChildren:null,inspectError:{code:e.code??'INSPECT_ERROR',message:e.message}};}
      // Inspector evidence is bound to the attempt that was current when the await began:
      // a settlement or newer attempt landing meanwhile makes it stale, and stale evidence
      // is dropped rather than applied to the newer attempt.
      if(this.store.get(id).attemptId!==boundAttemptId)return this.get(id);
      await this.projects.reevaluate(id,{observation,attemptId:boundAttemptId});
      return this.get(id);
    }
    if(TERMINAL.has(t.status))return {...this.get(id),observation:await this.adapter.inspect(t)};
    if(!t.dispatchStarted&&!this.running.has(id)){this.finish(id,{status:'failed',text:'Interrupted before dispatch',stopConfirmed:true,activeJobs:0});return this.get(id);}
    const boundAttemptId=t.attemptId;
    const observed=await this.adapter.inspect(t);
    if(this.store.get(id).attemptId!==boundAttemptId)return this.get(id);
    if(TERMINAL.has(observed.status)&&observed.stopConfirmed===true&&observed.activeJobs===0)this.finish(id,observed,boundAttemptId);
    else this.store.update(id,{recovery:observed});
    return this.get(id);
  }
  async cleanup(id,{policy,now=Date.now(),dryRun=true}={}){
    const {evaluateRetention}=await import('./retention-policy.mjs');const t=this.store.get(id);
    if(t.archivedAt)return {taskId:id,cleaned:true,alreadyArchived:true};
    if(!dryRun&&policy)fail('INVALID_CLEANUP','Applied cleanup uses host retention policy; overrides are preview-only');
    const decision=evaluateRetention(t,{...this.retention,...(dryRun?policy:{}),ownerId:this.store.ownerId},dryRun?now:Date.now());
    if(!decision.eligible||dryRun)return {taskId:id,...decision,dryRun};
    if(this.cleaning.has(id))fail('CLEANUP_BUSY','Cleanup is already running');this.cleaning.add(id);
    try{
    if(t.workspace&&!['merged','preserved','discarded'].includes(t.artifactState))fail('INVALID_ARTIFACT_STATE','Workspace artifacts must be resolved before cleanup');
    const outcome=await this.adapter.cleanup(t);
    if(outcome.cleaned!==true)return {taskId:id,...decision,cleaned:false,outcome};
    if(t.workspace){
      if(!['merged','preserved','discarded'].includes(t.artifactState))fail('INVALID_ARTIFACT_STATE','Workspace artifacts must be resolved before cleanup');
      await this.workspaces.remove(t.workspace,{artifactState:t.artifactState,pinned:t.pinned});
    }
    this.store.update(id,{archivedAt:Date.now(),cleanup:outcome});this.store.event(id,{type:'task/archived'});return {taskId:id,cleaned:true,outcome};
    }finally{this.cleaning.delete(id);}
  }
  close(){this.closed=true;for(const r of this.running.values())if(r.timer)clearTimeout(r.timer);}
}
