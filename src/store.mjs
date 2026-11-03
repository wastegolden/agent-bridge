import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, clone, fail, TERMINAL } from './contracts.mjs';

// Clarification request hashes bind every call input except the taskId, which is
// already implicit in the task record the transaction reads.
export const clarificationRequestHash = ({revision,understandingHash,clarificationId,text}) => digest({revision,understandingHash,clarificationId,text});
// Follow-up request hashes bind every caller input except the taskId. The text is
// bound EXACTLY (never trimmed) so identical replays replay and edited content conflicts.
export const followupRequestHash = ({revision,afterAttemptId,followupId,text}) => digest({revision,afterAttemptId,followupId,text});

const FOLLOWUP_ROLES = new Set(['investigate','review']);
// The adapter re-derives a recovered cancellation from the SAME host settlement
// evidence the previous attempt recorded, so the binding keeps only that evidence.
function followupSettlementEvidence(result) {
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  return clone(evidence.filter(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry.source === 'dsh-host' && entry.kind === 'attempt-settlement'));
}

export class TaskStore {
  constructor({directory,ownerId}) {
    if (!ownerId || !directory) fail('INVALID_STORE','Store directory and owner required');
    fs.mkdirSync(directory,{recursive:true});
    this.ownerId=ownerId; this.directory=directory;
    this.db=new DatabaseSync(path.join(directory,'tasks.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,idem)); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS task_events ON events(task_id,seq);');
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;} }
  submit(packet,{effectiveModel,preflight,callbackBinding,children,project}={}) {
    const hash=digest(packet);
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT hash,body FROM tasks WHERE owner=? AND idem=?').get(this.ownerId,packet.idempotencyKey);
      if(old){if(old.hash!==hash)fail('IDEMPOTENCY_CONFLICT','Idempotency key already belongs to another request');return {created:false,task:JSON.parse(old.body)};}
      for(const id of packet.dependencies) this.get(id);
      const now=Date.now();
      const task={id:randomUUID(),ownerId:this.ownerId,origin:'codex-bridge',revision:packet.revision,packet,requestHash:hash,status:'queued',phase:'queued',createdAt:now,updatedAt:now,attemptId:randomUUID(),attempt:1,understandingGeneration:0,resultCollected:false,accepted:false,pinned:false,stopConfirmed:true,activeJobs:0,activeChildren:0,children:[],artifactState:packet.role==='implement'?'unresolved':'none',result:{text:'',evidence:[],checks:[],uncertainties:[]},stats:{toolCalls:0},lastEventSeq:0};
      if(effectiveModel)task.effectiveModel=clone(effectiveModel);
      if(preflight)task.preflight=clone(preflight);
      // The trusted callback target snapshot is resolved from host configuration
      // BEFORE the task exists and is stored immutably here: a later configuration
      // change can never retarget an existing task.
      if(callbackBinding)task.callbackBinding=clone(callbackBinding);
      // The durable long-task project record is persisted WITH the task, so a task that
      // carries packet.project can never be mistaken for an ordinary bounded task after
      // a restart, even if the process dies immediately after submission.
      if(project)task.project=clone(project);
      if(Array.isArray(children))task.children=clone(children);
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id,this.ownerId,packet.idempotencyKey,hash,JSON.stringify(task));
      this.event(task.id,{type:'task/submitted',revision:task.revision,attemptId:task.attemptId});
      return {created:true,task:clone(task)};
    });
  }
  get(id) { const r=this.db.prepare('SELECT body FROM tasks WHERE id=? AND owner=?').get(id,this.ownerId);if(!r)fail('TASK_NOT_FOUND','Task does not belong to this bridge');return JSON.parse(r.body); }
  // Read-only idempotency lookup so an already-accepted submission can be reused
  // without a fresh dispatch or a repeated adapter preflight.
  find(idempotencyKey) { const r=this.db.prepare('SELECT hash,body FROM tasks WHERE owner=? AND idem=?').get(this.ownerId,idempotencyKey);return r?{hash:r.hash,task:JSON.parse(r.body)}:null; }
  list({projectId,status,includeArchived=false}={}) {return this.db.prepare('SELECT body FROM tasks WHERE owner=? ORDER BY rowid').all(this.ownerId).map(x=>JSON.parse(x.body)).filter(t=>(!projectId||t.packet.projectId===projectId)&&(!status||t.status===status)&&(includeArchived||(!t.archivedAt&&!t.sessionArchivedAt)));}
  update(id,changes) {
    const task=this.get(id);const next=typeof changes==='function'?changes(clone(task)):{...task,...changes};
    for(const k of ['id','ownerId','origin','requestHash','revision','attemptId'])if(next[k]!==task[k])fail('IMMUTABLE_IDENTITY',`Cannot replace ${k}`);
    next.updatedAt=Date.now();this.db.prepare('UPDATE tasks SET body=? WHERE id=? AND owner=?').run(JSON.stringify(next),id,this.ownerId);return clone(next);
  }
  beginAttempt(id,changes={}) {
    const task=this.get(id);
    if(task.status!=='awaiting_approval')fail('ATTEMPT_CONFLICT','Only a checked understanding may start an execution attempt');
    const next={...task,...changes,attemptId:randomUUID(),attempt:task.attempt+1,attemptHistory:[...(task.attemptHistory??[]),{attemptId:task.attemptId,phase:task.phase,status:task.status,sessionId:task.sessionId,requestId:task.requestId}],updatedAt:Date.now()};
    this.db.prepare('UPDATE tasks SET body=? WHERE id=? AND owner=?').run(JSON.stringify(next),id,this.ownerId);return clone(next);
  }
  // Checked compare-and-swap mint for the NEXT bounded supervisor round of an owned
  // long-task project. `attemptId` is identity (`update` refuses to replace it), so a
  // new round can only be minted here, and only against the EXACT current attempt the
  // caller proved stopped, with no receipt in flight. The CAS demands POSITIVE proof of
  // that stop — an explicit `stopConfirmed: true` with numeric-zero `activeJobs` AND
  // `activeChildren`, plus the exactly matching READABLE stopped previous round
  // (nonblank `attemptId`, terminal status, its own true/0/0 proof) and a legitimately
  // bound pending-round intent persisted before any dispatch — all read INSIDE the same
  // transaction. Any ambiguity refuses and leaves the identity, checkpoint and project
  // record COMPLETELY untouched: nothing is minted and no stop is invented. A duplicate
  // scheduler or a late resume therefore conflicts instead of starting a second round;
  // the immutable packet, revision, requestHash, model and callback binding are preserved.
  beginRound(id,{expectedAttemptId,expectedRoundIndex,expectedDispatchKey}={}) {
    return this.transaction(()=>{
      const task=this.get(id);
      if(!task.project)fail('ROUND_CONFLICT','Only a long-task project can start another supervisor round');
      if(['completed','failed','cancelled'].includes(task.status))fail('ROUND_CONFLICT',`project "${id}" is already terminal (${task.status})`);
      if(['queued','starting','running','cancelling'].includes(task.status))fail('ROUND_CONFLICT',`project "${id}" already has work in flight (${task.status})`);
      if(typeof expectedAttemptId!=='string'||expectedAttemptId.length===0||task.attemptId!==expectedAttemptId)fail('ROUND_CONFLICT','the project advanced past the exact attempt this round was planned for');
      // The planned round index is the CURRENT `roundsUsed`; when the caller pins it, it must
      // match exactly. Either way the bound pending intent below must be `current + 1`, so the
      // round identity is always exact and read inside this transaction.
      const currentRound=task.project.roundsUsed??0;
      if(expectedRoundIndex!==undefined&&(!Number.isSafeInteger(expectedRoundIndex)||expectedRoundIndex<0||currentRound!==expectedRoundIndex))fail('ROUND_CONFLICT','the project advanced past the exact round this dispatch was planned for');
      if(task.dispatchPending===true)fail('ROUND_CONFLICT','a dispatch receipt is still pending for this project');
      // Explicit positive stop proof of the attempt being replaced. A missing, null or
      // non-numeric count is UNKNOWN, never zero; an unconfirmed stop is never minted from.
      if(task.stopConfirmed!==true)fail('ROUND_CONFLICT','the current attempt has no confirmed stop; a round cannot be minted from unproven work');
      if(!Number.isInteger(task.activeJobs)||task.activeJobs!==0)fail('ROUND_CONFLICT',`the current attempt owns an unknown or non-zero job count (${Number.isInteger(task.activeJobs)?task.activeJobs:'unknown'}); a round cannot be minted from unproven work`);
      if(!Number.isInteger(task.activeChildren)||task.activeChildren!==0)fail('ROUND_CONFLICT',`the current attempt owns an unknown or non-zero child count (${Number.isInteger(task.activeChildren)?task.activeChildren:'unknown'}); a round cannot be minted from unproven work`);
      // Matching stopped round identity: a continuation REQUIRES the exactly matching
      // READABLE last round for the attempt being replaced. An absent round record, a
      // missing/blank/different `attemptId`, a non-terminal status, an unconfirmed stop,
      // or an unknown/non-zero job or child count all refuse: a round is never minted
      // from an absent or ambiguous previous round. A genuinely never-dispatched first
      // round is NOT a continuation, so it must use the normal start/resume path instead
      // of this seam.
      const rounds=Array.isArray(task.project.rounds)?task.project.rounds:[];
      const last=rounds[rounds.length-1];
      if(last===undefined||last===null)fail('ROUND_CONFLICT','no recorded previous round exists for this continuation; a never-dispatched first round must not mint a continuation');
      if(typeof last!=='object'||Array.isArray(last))fail('ROUND_CONFLICT','the recorded round identity is not a readable round record');
      if(typeof last.attemptId!=='string'||last.attemptId.length===0||last.attemptId!==expectedAttemptId)fail('ROUND_CONFLICT','the recorded round has no matching attempt identity for the attempt this dispatch was planned for');
      if(!['completed','failed','cancelled'].includes(last.status))fail('ROUND_CONFLICT',`the recorded round is not terminal (${typeof last.status==='string'?last.status:'unknown'}); a round cannot be minted from an unfinished round`);
      if(last.stopConfirmed!==true)fail('ROUND_CONFLICT','the recorded round has no verified stop; a round cannot be minted from unproven work');
      if(!Number.isInteger(last.activeJobs)||last.activeJobs!==0)fail('ROUND_CONFLICT','the recorded round owns an unknown or non-zero job count; a round cannot be minted from unproven work');
      if(!Number.isInteger(last.activeChildren)||last.activeChildren!==0)fail('ROUND_CONFLICT','the recorded round owns an unknown or non-zero child count; a round cannot be minted from unproven work');
      // Legitimate bound pending-round intent, persisted BEFORE any dispatch by the
      // runtime. It must be the very next round for this attempt, carry a dispatch
      // identity, and not already have minted an attempt of its own.
      const intent=task.project.pendingRound;
      if(intent===null||intent===undefined||typeof intent!=='object'||Array.isArray(intent))fail('ROUND_CONFLICT','no bound pending-round intent exists for this dispatch');
      if(intent.index!==currentRound+1)fail('ROUND_CONFLICT','the bound pending round is not the exact next round this dispatch was planned for');
      if(typeof intent.dispatchKey!=='string'||intent.dispatchKey.length===0)fail('ROUND_CONFLICT','the bound pending round carries no dispatch identity');
      if(expectedDispatchKey!==undefined&&intent.dispatchKey!==expectedDispatchKey)fail('ROUND_CONFLICT','the bound pending round belongs to a different dispatch');
      if(intent.attemptId!==null&&intent.attemptId!==undefined)fail('ROUND_CONFLICT','the bound pending round already minted an attempt');
      const next={...task,attemptId:randomUUID(),attempt:task.attempt+1,attemptHistory:[...(task.attemptHistory??[]),{attemptId:task.attemptId,phase:task.phase,status:task.status,sessionId:task.sessionId,requestId:task.requestId}],continuationKind:'supervisor-round',status:'queued',phase:'project',dispatchStarted:false,dispatchPending:false,dispatchReceiptAt:null,requestId:null,understanding:null,error:null,endedAt:null,updatedAt:Date.now()};
      this.db.prepare('UPDATE tasks SET body=? WHERE id=? AND owner=?').run(JSON.stringify(next),id,this.ownerId);
      this.event(id,{type:'task/round-minted',attemptId:next.attemptId,round:(task.project.roundsUsed??0)+1,stopConfirmed:next.stopConfirmed===true,activeJobs:next.activeJobs,activeChildren:next.activeChildren});
      return clone(next);
    });
  }
  // Transactional compare-and-swap for bridge_clarify. The original packet, revision,
  // requestHash, SQL idempotency hash and workspace are preserved; only the attempt,
  // understanding generation and clarification history advance. Replay lookup happens
  // before eligibility so an identical replay still succeeds after the status advanced.
  clarify(id,{clarificationId,text,revision,understandingHash}) {
    const requestHash=clarificationRequestHash({revision,understandingHash,clarificationId,text});
    return this.transaction(()=>{
      const task=this.get(id);
      const existing=(task.clarifications??[]).find(c=>c.clarificationId===clarificationId);
      if(existing){
        if(existing.requestHash!==requestHash)fail('CLARIFICATION_CONFLICT','clarificationId already binds different clarification content');
        return {created:false,task:clone(task)};
      }
      if(task.revision!==revision||task.understandingHash!==understandingHash)fail('CLARIFICATION_CONFLICT','Clarification must match the awaiting task revision and understanding hash');
      if(task.status!=='awaiting_approval')fail('CLARIFICATION_CONFLICT','Clarification requires an awaiting_approval task');
      if(task.stopConfirmed!==true||task.activeJobs!==0)fail('SESSION_NOT_READY','Clarification requires a stopped session with zero active jobs');
      if(typeof task.sessionId!=='string'||!task.sessionId.trim()||!Number.isFinite(task.dispatchReceiptAt))fail('SESSION_NOT_READY','Clarification requires the persisted session and dispatch receipt');
      if(task.dispatchPending===true)fail('SESSION_NOT_READY','Clarification cannot start while a dispatch receipt is still pending');
      const now=Date.now();
      const generation=(task.understandingGeneration??0)+1;
      const attemptId=randomUUID();
      const entry={
        clarificationId,text,requestHash,generation,createdAt:now,
        previousUnderstanding:task.understanding??null,
        previousUnderstandingHash:task.understandingHash??null,
        previousResult:clone(task.result??null),
        previousAttempt:{attemptId:task.attemptId,requestId:task.requestId??null,sessionId:task.sessionId??null,revision:task.revision,phase:task.phase??null,status:task.status??null,dispatchReceiptAt:task.dispatchReceiptAt??null,effectiveModel:clone(task.effectiveModel??null)}
      };
      const next={
        ...task,
        clarifications:[...(task.clarifications??[]),entry],
        understandingGeneration:generation,
        attemptId,
        attempt:task.attempt+1,
        attemptHistory:[...(task.attemptHistory??[]),{attemptId:task.attemptId,phase:task.phase,status:task.status,sessionId:task.sessionId,requestId:task.requestId}],
        continuationKind:'clarification',
        status:'queued',phase:'queued',
        executionApproved:false,
        dispatchStarted:false,dispatchPending:false,dispatchReceiptAt:null,requestId:null,
        understanding:null,understandingHash:null,review:null,error:null,
        result:{text:'',evidence:[],checks:[],uncertainties:[]},
        endedAt:null,resultCollected:false,accepted:false,
        stopConfirmed:true,activeJobs:0,
        updatedAt:now
      };
      this.db.prepare('UPDATE tasks SET body=? WHERE id=? AND owner=?').run(JSON.stringify(next),id,this.ownerId);
      this.event(id,{type:'task/clarified',revision:task.revision,attemptId,clarificationId,generation});
      return {created:true,task:clone(next)};
    });
  }
  // Transactional compare-and-swap for bridge_followup. Replay lookup happens BEFORE
  // eligibility so an identical replay still succeeds after the task advanced or was
  // archived. The immutable packet, revision, requestHash, sessionId, workspace,
  // effectiveModel, executionApproved, artifactState and pinned flag are preserved;
  // only the attempt and the follow-up history advance. Eligibility order is the
  // order of the published error table: role -> project/worker -> understanding gate
  // -> revision/afterAttemptId -> terminal -> archived -> true/0/0 -> dispatch/session
  // -> bound session. The persisted entry keeps the replaced round's complete snapshot
  // and the exact owned-session binding needed to recover a follow-up after a host
  // restart (and to retry after a dispatched:false refusal).
  followup(id,{followupId,text,revision,afterAttemptId}={}) {
    const requestHash=followupRequestHash({revision,afterAttemptId,followupId,text});
    return this.transaction(()=>{
      const task=this.get(id);
      const history=Array.isArray(task.followups)?task.followups:[];
      const existing=history.find(entry=>entry&&entry.followupId===followupId);
      if(existing){
        if(existing.requestHash!==requestHash)fail('FOLLOWUP_IDEMPOTENCY_CONFLICT','followupId already binds different follow-up content');
        return {created:false,task:clone(task),entry:clone(existing)};
      }
      const packet=task.packet&&typeof task.packet==='object'?task.packet:{};
      if(!FOLLOWUP_ROLES.has(packet.role))fail('FOLLOWUP_ROLE_FORBIDDEN','Follow-ups are available only to investigate and review tasks');
      if(packet.project!==undefined||task.project!==undefined)fail('FOLLOWUP_UNSUPPORTED_TASK','A long-task project cannot continue with a follow-up');
      if(packet.metadata&&typeof packet.metadata==='object'&&packet.metadata.supervisorProject!==undefined&&packet.metadata.supervisorProject!==null)fail('FOLLOWUP_UNSUPPORTED_TASK','A project worker cannot continue with a follow-up');
      if(packet.understandingRequired===true&&task.executionApproved!==true)fail('FOLLOWUP_UNSUPPORTED_TASK','A task whose understanding gate was never approved cannot continue with a follow-up');
      if(task.revision!==revision)fail('FOLLOWUP_CONFLICT','Follow-up must match the owned task revision');
      if(task.attemptId!==afterAttemptId)fail('FOLLOWUP_CONFLICT','Follow-up must bind the exact current attempt; the task already advanced past the attempt this request names');
      if(!TERMINAL.has(task.status))fail('FOLLOWUP_CONFLICT','A follow-up requires a completed, failed or cancelled task');
      if((task.sessionArchivedAt!==undefined&&task.sessionArchivedAt!==null)||(task.archivedAt!==undefined&&task.archivedAt!==null))fail('FOLLOWUP_ARCHIVED','An archived or cleaned task cannot continue with a follow-up');
      if(task.stopConfirmed!==true)fail('SESSION_NOT_READY','A follow-up requires a host-confirmed stop of the previous attempt');
      if(!Number.isInteger(task.activeJobs)||task.activeJobs!==0)fail('SESSION_NOT_READY',`A follow-up requires zero active jobs (${Number.isInteger(task.activeJobs)?task.activeJobs:'unknown'})`);
      if(!Number.isInteger(task.activeChildren)||task.activeChildren!==0)fail('SESSION_NOT_READY',`A follow-up requires zero active child sessions (${Number.isInteger(task.activeChildren)?task.activeChildren:'unknown'})`);
      if(task.dispatchPending===true)fail('SESSION_NOT_READY','A follow-up cannot start while a dispatch receipt is still pending');
      if(typeof task.sessionId!=='string'||!task.sessionId.trim())fail('SESSION_NOT_READY','A follow-up requires the persisted session of the previous attempt');
      let boundAttempt;
      if(typeof task.requestId==='string'&&task.requestId.trim()&&Number.isFinite(task.dispatchReceiptAt)){
        boundAttempt={
          attemptId:task.attemptId,
          requestId:task.requestId,
          sessionId:task.sessionId,
          revision:task.revision,
          effectiveModel:clone(task.effectiveModel??null),
          status:task.status,
          stopConfirmed:task.stopConfirmed===true,
          settlementEvidence:followupSettlementEvidence(task.result)
        };
      }else{
        // N2: a follow-up attempt refused BEFORE dispatch (dispatched:false) has no
        // receipt of its own. Its session binding is the one the refused round already
        // recorded, and it stays reusable so one refusal never strands the session.
        const refusal=task.dispatchFailure;
        const prior=refusal&&refusal.dispatched===false&&refusal.attemptId===task.attemptId
          ?history.find(entry=>entry&&entry.attemptId===task.attemptId&&entry.boundAttempt)
          :null;
        if(!prior)fail('SESSION_NOT_READY','A follow-up requires a persisted receipt (or a prior bound follow-up attempt) for the session');
        boundAttempt=clone(prior.boundAttempt);
      }
      const now=Date.now();
      const attemptId=randomUUID();
      const round=history.length+1;
      const entry={
        followupId,requestHash,text,revision,afterAttemptId,
        attemptId,round,createdAt:now,
        baselineToolCalls:Number.isInteger(task.stats?.toolCalls)?task.stats.toolCalls:0,
        previousAttempt:{
          attemptId:task.attemptId,
          attempt:task.attempt,
          revision:task.revision,
          sessionId:task.sessionId??null,
          requestId:task.requestId??null,
          phase:task.phase??null,
          status:task.status??null,
          continuationKind:task.continuationKind??null,
          dispatchReceiptAt:task.dispatchReceiptAt??null,
          startedAt:task.startedAt??null,
          endedAt:task.endedAt??null,
          effectiveModel:clone(task.effectiveModel??null),
          stopConfirmed:task.stopConfirmed===true,
          activeJobs:Number.isInteger(task.activeJobs)?task.activeJobs:null,
          activeChildren:Number.isInteger(task.activeChildren)?task.activeChildren:null,
          result:clone(task.result??null),
          error:clone(task.error??null),
          stats:clone(task.stats??null),
          resultCollected:task.resultCollected===true,
          accepted:task.accepted===true,
          dispatchFailure:clone(task.dispatchFailure??null)
        },
        boundAttempt
      };
      const next={
        ...task,
        followups:[...history,entry],
        attemptId,
        attempt:task.attempt+1,
        attemptHistory:[...(task.attemptHistory??[]),{attemptId:task.attemptId,phase:task.phase,status:task.status,sessionId:task.sessionId,requestId:task.requestId}],
        continuationKind:'followup',
        status:'queued',phase:'queued',
        dispatchStarted:false,dispatchPending:false,dispatchReceiptAt:null,requestId:null,
        startedAt:null,endedAt:null,
        result:{text:'',evidence:[],checks:[],uncertainties:[]},
        error:null,dispatchFailure:null,cancellationRequested:null,cancelError:null,cancelRemaining:null,recovery:null,
        resultCollected:false,accepted:false,
        stopConfirmed:true,activeJobs:0,activeChildren:0,
        updatedAt:now
      };
      this.db.prepare('UPDATE tasks SET body=? WHERE id=? AND owner=?').run(JSON.stringify(next),id,this.ownerId);
      this.event(id,{type:'task/followup-requested',revision:task.revision,afterAttemptId,attemptId,followupId,round});
      return {created:true,task:clone(next)};
    });
  }
  event(id,event) {this.get(id);const entry={...event,timestamp:event.timestamp??Date.now(),taskId:id};const r=this.db.prepare('INSERT INTO events(task_id,body) VALUES(?,?)').run(id,JSON.stringify(entry));return {...entry,seq:Number(r.lastInsertRowid)};}
  events(id,{after=0,limit=100}={}) {this.get(id);if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>1000)fail('INVALID_CURSOR','Invalid event cursor or limit');return this.db.prepare('SELECT seq,body FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit).map(r=>({...JSON.parse(r.body),seq:r.seq}));}
  close(){if(!this.closed){this.closed=true;this.db.close();}}
}
