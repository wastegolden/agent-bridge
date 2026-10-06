import fs from 'node:fs';
import path from 'node:path';
import { TaskStore } from './store.mjs';
import { BridgeService } from './service.mjs';
import { DshAdapter } from './dsh-adapter.mjs';
import { WorkspaceManager } from './workspaces.mjs';
import { createMcpHandler } from './mcp.mjs';
import { fail } from './contracts.mjs';
import { defaultPolicy } from './defaults.mjs';
import { acquireHostLease } from './host-lease.mjs';
import { createBridgeCloser } from './host-lifecycle.mjs';
import { BridgeSupervisor, sharedLedger } from './supervisor.mjs';
import { CommandProfileRegistry } from './command-jobs.mjs';
import { createEventWakeRuntime } from './wake-integration.mjs';
import { SupervisorProjectRuntime, normalizeProjectConfig } from './long-task.mjs';

export async function mountBridge(ctx,config={}){
 const root=config.dataDirectory??(process.env.DSH_HOME?path.join(process.env.DSH_HOME,'codex-bridge-v1'):null);
 if(!root||!path.isAbsolute(root))fail('CONFIG_REQUIRED','Absolute dataDirectory or DSH_HOME required');
 const token=config.credentialFile?fs.readFileSync(config.credentialFile,'utf8').trim():process.env[config.tokenEnv??'DSH_MCP_TOKEN'];
 if(!token)fail('AUTH_UNAVAILABLE','Configured credential source unavailable');
 const ownerId=config.ownerId??'codex-bridge-v1';
 const endpoint=config.endpoint??'/mcp/codex-bridge-v1';
 if(!/^\/mcp\/[a-z0-9-]+$/.test(endpoint))fail('INVALID_ENDPOINT','Invalid MCP mount path');
 const policy=defaultPolicy();
 // The serializable host `eventWake` option is validated BEFORE any host resource is
 // acquired, so a misconfigured or ambiguous wake configuration refuses the mount
 // instead of starting a bridge that could never report anything. An absent/disabled
 // option preserves the historical behaviour exactly (no sink, no reply authority),
 // and the operator's top-level `rootCallbackGrants` stays the ONLY grant map.
 const eventWake=createEventWakeRuntime({eventWake:config.eventWake,rootCallbackGrants:config.rootCallbackGrants,notificationSink:config.notificationSink});
 // An ENABLED eventWake plus an injected sink is refused by normalization as ambiguous
 // dual configuration, so at most one destination exists here. A disabled/absent
 // eventWake must NOT discard the injected function: that embedding was supported before
 // this integration existed.
 const injectedSink=typeof config.notificationSink==='function';
 const notificationSink=eventWake.sink??(injectedSink?config.notificationSink:undefined);
 // Capability metadata only: it names the producer that was actually configured and
 // never claims a live runner, transport or acknowledgement.
 const producerStatus=eventWake.enabled===true
  ?{...eventWake.capabilities(),producerSource:'integrated-outbox',integratedOutbox:true,injectedSink:false}
  :{enabled:false,configured:false,producer:false,producerSource:injectedSink?'injected-sink':null,integratedOutbox:false,injectedSink,
    liveTransport:'unknown',runnerAvailable:'unknown',liveAck:'unknown',
    reason:injectedSink?'no integrated outbox producer; the injected config.notificationSink is used and its live availability stays unverified':'no integrated outbox producer and no injected notification sink'};
 const release=acquireHostLease(root);
 let store,adapter,service,unmount,projects;
 try{
 store=new TaskStore({directory:root,ownerId});
 // ONE authoritative reservation ledger per bridge owner is shared by the
 // service drain and every supervisor in this process: roots and children
 // consume the same configured limit (no changed default) and unknown work
 // keeps its slot until an observed stop.
 const maxConcurrent=config.maxConcurrent??4;
 const ledger=sharedLedger(ownerId,{limit:maxConcurrent});
 const commandProfiles=Array.isArray(config.commandProfiles)?new CommandProfileRegistry({profiles:config.commandProfiles,allowedRoots:config.commandAllowedRoots??[]}):null;
 const commandJobsEnabled=commandProfiles!==null&&(config.commandJobs===true||(config.commandJobs!==null&&typeof config.commandJobs==='object'&&config.commandJobs.enabled===true));
 const supervisor=new BridgeSupervisor({ledger,ownerId,
  persist:{event:(taskId,event)=>store.event(taskId,event),update:(taskId,changes)=>store.update(taskId,changes)},
  config:{
   childSessions:config.childSessions??{enabled:false},
   commandJobs:{enabled:commandJobsEnabled,maxJobsPerTask:(config.commandJobs&&Number.isInteger(config.commandJobs.maxJobsPerTask))?config.commandJobs.maxJobsPerTask:2,profiles:commandProfiles},
   rootCallbackGrants:config.rootCallbackGrants??{},
   // The real sink: an enqueue acknowledgement from the durable outbox. It reports
   // `queued`, never `delivered`, and its failures propagate so the supervisor
   // records unknown/refused instead of claiming a delivery.
   notificationSink
  }});
 // Capability metadata only: the producer/outbox is configured, while live transport,
 // runner availability and acknowledgement stay explicitly unverified. It cannot
 // widen the sink, the grants or any task grant.
 supervisor.setNotificationStatus(producerStatus);
 // The long-task project runtime is constructed BEFORE the adapter (which registers its
 // supervisor-only tools) and attached to the service afterwards (whose hooks drive
 // scheduling). The operator `supervisorProjects` block defaults to disabled, so a
 // host that does not opt in refuses packet.project and keeps every legacy path.
 const projectConfig=normalizeProjectConfig(config.supervisorProjects);
 projects=new SupervisorProjectRuntime({store,supervisor,config:projectConfig});
 adapter=new DshAdapter(ctx,{...config,ownerId,supervisor,projects,supervisorProjects:projectConfig,commandJobs:commandProfiles??undefined});
 const workspaces=new WorkspaceManager({root:path.join(root,'workspaces'),git:config.gitExecutable??'git'});
 service=new BridgeService({store,adapter,workspaces,profiles:config.profiles??policy.profiles,skills:config.skills??policy.skills,maxConcurrent,routeLimits:config.routeLimits??{},defaults:config.defaultModel,retention:config.retention,supervisor,projects});
 projects.attach({service,workspaces,supervisor});
 // The controller need not poll the same process, so the producer status is exposed
 // for capability reporting without claiming a live runner or a proven transport.
 service.eventWake=producerStatus;
 const handler=createMcpHandler(service,{token,allowedHosts:config.allowedHosts??['127.0.0.1','localhost']});
 unmount=ctx.webServer.register({kind:'exact',path:endpoint,handler:(req,res)=>{void handler(req,res);}});
 await service.recover();
 // Shutdown order matters: stop accepting new project transitions first, then close the
 // durable wake producer (which awaits its own accepted enqueues), so a project callback
 // accepted just before shutdown is never lost to a premature outbox close.
 const closeResources=async()=>{await projects.close();return await eventWake.close();};
 return {service,projects,eventWake:producerStatus,close:createBridgeCloser({store,adapter,service,unmount,release,resources:closeResources})};
 }catch(e){unmount?.();service?.close();adapter?.dispose?.();store?.close();await projects?.close?.().catch(()=>undefined);await eventWake.close().catch(()=>undefined);release();throw e;}
}
