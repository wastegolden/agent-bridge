import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveModel, FLASH_DEFAULT } from '../src/models.mjs';
import { DEFAULT_MODEL } from '../src/dsh-adapter.mjs';
import { defaultPolicy } from '../src/defaults.mjs';

test('DSH 0.1.7 default route and model skills match its advertised Flash catalog', () => {
  const catalog=[{provider:'deepseek-official',models:[{id:'deepseek-flash',reasoningEfforts:['off','low','high','max']}]}];
  const policy=defaultPolicy();
  assert.deepEqual(DEFAULT_MODEL,FLASH_DEFAULT);
  const route=resolveModel({catalog,profiles:policy.profiles});
  assert.equal(route.model,'deepseek-flash');
  assert.deepEqual(route.skillIds,['flash-boundaries']);
  assert.throws(()=>resolveModel({catalog,task:{provider:'deepseek-official',model:'deepseek-v4-flash'}}),{code:'unknown_route'});
});

test('host initialization failure rejects the loader instead of reporting a mounted plugin', async () => {
  const require=createRequire(import.meta.url);
  const plugin=require('../dsh-host/index.cjs');
  const pending=plugin.apply({effect(){}},{dataDirectory:'relative-path'});
  assert.equal(typeof pending?.then,'function');
  await assert.rejects(pending,{code:'CONFIG_REQUIRED'});
});
