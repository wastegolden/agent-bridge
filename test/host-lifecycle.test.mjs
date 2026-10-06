import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeCloser } from '../src/host-lifecycle.mjs';

test('unconfirmed shutdown keeps callback resources and lease until a retry proves stopping', async () => {
  const task = { id: 'task', status: 'running' };
  const actions = [];
  let dbClosed = false;
  let confirmed = false;
  const store = { list() { assert.equal(dbClosed, false); return [task]; }, close() { dbClosed = true; actions.push('store'); } };
  const close = createBridgeCloser({store, adapter:{dispose(){actions.push('guards');}},
    service:{close(){actions.push('scheduler');},async cancel(){ task.status = confirmed ? 'cancelled' : 'cancelling'; }},
    unmount(){actions.push('unmount');},release(){actions.push('lease');}});
  assert.deepEqual(await close(), {closed:false,pendingTaskIds:['task']});
  assert.deepEqual(actions, ['unmount','scheduler']);
  assert.equal(store.list()[0].status, 'cancelling', 'late callback can still access the store');
  confirmed = true;
  assert.equal((await close()).closed, true);
  assert.deepEqual(actions, ['unmount','scheduler','guards','store','lease']);
  assert.equal((await close()).closed, true);
});

test('concurrent close callers both wait for the same cancellation', async () => {
  let resolve;
  const task = {id:'task',status:'running'};
  const close = createBridgeCloser({store:{list:()=>[task],close(){}},adapter:{dispose(){}},
    service:{close(){},cancel:()=>new Promise(r=>{resolve=()=>{task.status='cancelled';r();};})},release(){}});
  const a=close();const b=close();assert.equal(a,b);
  let done=false;b.then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);
  resolve();assert.equal((await a).closed,true);assert.equal((await b).closed,true);
});

test('a resource closer that reports not closed keeps the store, guards and lease for a retry', async () => {
  const actions = [];
  let attempts = 0;
  const close = createBridgeCloser({
    store: { list: () => [{ id: 'task', status: 'completed' }], close() { actions.push('store'); } },
    adapter: { dispose() { actions.push('guards'); } },
    service: { close() { actions.push('scheduler'); }, async cancel() {} },
    unmount: () => { actions.push('unmount'); },
    release: () => { actions.push('lease'); },
    resources: async () => {
      attempts += 1;
      actions.push(`resources:${attempts}`);
      // First attempt reports a real, unproven close; the second proves it.
      return attempts === 1 ? { ok: false, closed: false, reason: 'outbox still open' } : { ok: true, closed: true };
    },
  });
  const first = await close();
  assert.equal(first.closed, false);
  assert.equal(first.resourcesClosed, false);
  assert.equal(first.resourcesPending, true);
  assert.deepEqual(actions, ['unmount', 'scheduler', 'resources:1'], 'a not-closed resource retains the store, guards and lease');
  const second = await close();
  assert.equal(second.closed, true);
  assert.equal(second.resourcesClosed, true);
  assert.deepEqual(actions, ['unmount', 'scheduler', 'resources:1', 'resources:2', 'guards', 'store', 'lease']);
});
