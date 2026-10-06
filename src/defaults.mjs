import fs from 'node:fs';
const read=name=>fs.readFileSync(new URL(`../skills/dsh-project-execution/references/${name}.md`,import.meta.url),'utf8');
export function defaultPolicy(){
 return {
  profiles:[{id:'flash-bounded-v1',version:1,provider:'deepseek-official',model:'deepseek-flash',skillIds:['flash-boundaries']}],
  skills:[
   {id:'task-boundaries',version:1,layer:'common',text:read('task-packets-and-gates')},
   {id:'module-delivery',version:1,layer:'role',roles:['implement','integrate'],text:read('workspaces-and-review')},
   {id:'flash-boundaries',version:1,layer:'model',text:read('model-flash')}
  ]
 };
}
