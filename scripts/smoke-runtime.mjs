// Real DSH host with an offline provider. No production profile or paid API calls.
// node scripts/smoke-runtime.mjs <directory containing node_modules/@deepseek-ai/dsh>
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { install } from './install.mjs';

const source=path.resolve(import.meta.dirname,'..');
const dshRoot=path.resolve(process.argv[2]??process.cwd());
const dshBin=path.join(dshRoot,'node_modules/@deepseek-ai/dsh/lib/bin.js');
assert.ok(fs.existsSync(dshBin),'Provide the DSH installation directory');
const root=fs.mkdtempSync(path.join(dshRoot,'.bridge-smoke-'));
const home=path.join(root,'home');
const profile=path.join(home,'profiles/web');
const cwd=path.join(root,'workspace');
fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(cwd);
fs.writeFileSync(path.join(cwd,'allowed.txt'),'BRIDGE_ALLOWED_CONTENT');
fs.writeFileSync(path.join(root,'outside.txt'),'BRIDGE_OUTSIDE_MUST_NOT_BE_READ');
fs.copyFileSync(path.join(source,'test/fixtures/dsh-current-provider.mjs'),path.join(root,'provider.mjs'));
fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({name:'bridge-compat-profile',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
fs.writeFileSync(path.join(profile,'cordis.patch.yml'),`- insert:\n    - id: bridge-compat-mock\n      name: ${JSON.stringify(path.join(root,'provider.mjs'))}\n`);
const token=randomBytes(32).toString('base64url');
const credentialFile=path.join(root,'bridge-token');
fs.writeFileSync(credentialFile,token,{mode:0o600});
await install({sourceDir:source,profileDir:profile,requireHostEntry:true,hostConfig:{dataDirectory:path.join(root,'state'),credentialFile,ownerId:'codex-bridge-compat',agentPreset:'standard'}});
const log=fs.openSync(path.join(root,'host.log'),'a');
const child=spawn(process.execPath,[dshBin,'web','--port','0','--no-open'],{cwd:dshRoot,env:{...process.env,DSH_HOME:home},windowsHide:true,stdio:['ignore',log,log]});
fs.closeSync(log);
const exited=once(child,'exit');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={dsh:JSON.parse(fs.readFileSync(path.join(dshRoot,'node_modules/@deepseek-ai/dsh/package.json'),'utf8')).version,bridge:JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version,provider:'offline fixture; no paid API calls',checks:[]};
let endpoint;
async function rpc(method,params) {
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params}),signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);
  const body=await response.json();assert.ok(!body.error,JSON.stringify(body.error));
  return body.result;
}
async function call(name,args={}) {
  const result=await rpc('tools/call',{name,arguments:args});
  assert.ok(!result.isError,JSON.stringify(result.content));
  return result.structuredContent??JSON.parse(result.content[0].text);
}
async function submit(model) {
  return call('bridge_submit',{packet:{schemaVersion:1,idempotencyKey:`compat-${model}-${Date.now()}`,revision:1,projectId:'compat',title:`DSH compatibility ${model}`,objective:'Run the offline compatibility probe.',cwd,role:'investigate',acceptance:['Probe evidence is returned.'],scope:{readRoots:[cwd],writeRoots:[],allowedTools:['read'],allowShell:false,allowNetwork:false,allowDelegation:false},materials:[],contractVersion:'v1',model:{provider:'bridge-compat-mock',model},budget:{timeoutMs:30000,maxToolCalls:5,maxOutputChars:10000}}});
}
async function settled(taskId) {
  for(let i=0;i<100;i++) {
    const {task}=await call('bridge_check',{taskId});
    if(['completed','failed','cancelled','unknown'].includes(task.status))return task;
    await sleep(200);
  }
  throw new Error('Task did not settle');
}
try {
  for(let i=0;i<300;i++) {
    if(child.exitCode!==null)throw new Error(`DSH exited; inspect ${root}/host.log`);
    const content=fs.readFileSync(path.join(root,'host.log'),'utf8');
    const address=content.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if(address){endpoint=address+'/mcp/codex-bridge-v1';try{await rpc('ping',{});break;}catch{}}
    await sleep(200);
  }
  assert.ok(endpoint,'DSH startup timed out');
  const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'compat-smoke',version:'1'}});
  assert.equal(initialized.serverInfo.version,report.bridge);
  const tools=await rpc('tools/list',{});assert.equal(tools.tools.length,19);
  const catalog=await call('bridge_models');
  assert.match(JSON.stringify(catalog),/deepseek-flash/);
  report.checks.push({name:'MCP initialization, 18 tools, current Flash model catalog',passed:true});
  for(const model of ['text','read','denied']) {
    const submitted=await submit(model);const task=await settled(submitted.id);
    assert.equal(task.status,'completed');assert.equal(task.stopConfirmed,true);
    const result=await call('bridge_result',{taskId:task.id});
    if(model==='text')assert.equal(result.text,'BRIDGE_COMPAT_OK');
    if(model==='read'){assert.match(result.text,/BRIDGE_ALLOWED_CONTENT/);assert.match(result.text,/"isError":false/);}
    if(model==='denied'){assert.match(result.text,/"isError":true/);assert.ok(!result.text.includes('BRIDGE_OUTSIDE_MUST_NOT_BE_READ'));}
    await call('bridge_acknowledge',{taskId:task.id,revision:1,accepted:true,artifactState:'none'});
    const archived=await call('bridge_archive',{taskId:task.id,revision:1});
    assert.equal(archived.uiHidden,true);
    report.checks.push({name:`${model}: real session execution, result, stop confirmation and archive`,passed:true,result:result.text});
  }
  const cancelled=await submit('cancel');
  for(let i=0;i<100;i++) {
    if(fs.existsSync(path.join(root,'calls.jsonl'))&&fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').includes('"model":"cancel"'))break;
    await sleep(100);
  }
  assert.match(fs.readFileSync(path.join(root,'calls.jsonl'),'utf8'),/"model":"cancel"/);
  await call('bridge_cancel',{taskId:cancelled.id,reason:'Compatibility probe'});
  const stopped=await settled(cancelled.id);
  assert.equal(stopped.status,'cancelled');assert.equal(stopped.stopConfirmed,true);assert.equal(stopped.activeJobs,0);
  report.checks.push({name:'Cancellation of an active model call confirms stopped with zero jobs',passed:true});
  const carrier=spawn(process.execPath,[path.join(source,'bin/bridge.mjs')],{cwd:source,env:{...process.env,DSH_BRIDGE_URL:endpoint,DSH_BRIDGE_CREDENTIAL_FILE:credentialFile,DSH_MCP_TOKEN:''},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='';carrier.stdout.on('data',data=>{output+=data;});
  carrier.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}})+'\n');
  const timer=setTimeout(()=>carrier.kill(),15000);
  const [code]=await once(carrier,'exit');clearTimeout(timer);
  assert.equal(code,0);assert.equal(JSON.parse(output.trim()).result.serverInfo.version,report.bridge);
  report.checks.push({name:'Codex stdio carrier reads credential file and forwards MCP initialization',passed:true});
  report.passed=true;
} catch(error) {
  report.passed=false;report.error=error.stack;process.exitCode=1;
} finally {
  child.kill();await Promise.race([exited,sleep(5000)]);
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({root,...report},null,2));
}
