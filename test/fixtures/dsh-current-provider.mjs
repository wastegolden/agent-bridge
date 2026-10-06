// Offline model used only by scripts/smoke-runtime.mjs in an isolated DSH home.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import fs from 'node:fs';
import path from 'node:path';
export const name = 'bridge-compat-mock';
export const inject = ['llm'];
const root = import.meta.dirname;
class MockAdapter extends LlmAdapter {
  async listModels(provider) {
    return ['text','read','denied','cancel'].map(id => ({provider,id,name:`Offline ${id}`}));
  }
  async *stream(options) {
    fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({model:options.model,tools:options.tools?.map(t=>t.name)})+'\n');
    if (options.model === 'cancel') {
      await new Promise((resolve,reject) => {
        const timer=setTimeout(resolve,20000);
        const abort=()=>{clearTimeout(timer);reject(options.signal.reason??new Error('cancelled'));};
        if(options.signal?.aborted)abort();
        else options.signal?.addEventListener('abort',abort,{once:true});
      });
    }
    const toolResult=options.messages.findLast(m=>m.role==='tool');
    if (['read','denied'].includes(options.model) && !toolResult) {
      const file=options.model==='read'?path.join(root,'workspace','allowed.txt'):path.join(root,'outside.txt');
      const args=JSON.stringify({file_path:file});
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id:'compat-read',name:'read',argumentsDelta:args};
      yield {type:'block-end',index:0,block:{type:'tool-call',id:'compat-read',name:'read',arguments:args}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
      return;
    }
    const text=toolResult?JSON.stringify({isError:toolResult.isError??false,content:toolResult.content}):'BRIDGE_COMPAT_OK';
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text};
    yield {type:'block-end',index:0,block:{type:'text',text}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['bridge-compat-mock'],new MockAdapter()); }
