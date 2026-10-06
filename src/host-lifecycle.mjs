const unsettled = task => ['starting', 'running', 'cancelling', 'unknown'].includes(task.status);

/**
 * Resolve the optional owned-resource closer. It accepts either a function or an
 * object with a `close()` method so a caller can hand over a runtime directly.
 */
function resourceCloser(resources) {
  if (resources === undefined || resources === null) return null;
  if (typeof resources === 'function') return resources;
  if (typeof resources.close === 'function') return () => resources.close();
  return null;
}

// A hot-unloaded plugin can still have live host callbacks. Keep their store,
// policy guards and lease until stopping is proven; a later close can retry.
//
// `resources` is an optional owned-resource closer (for example the eventWake
// outbox runtime). It is released ONLY in the same branch that already proves no
// unsettled task remains: an unconfirmed stop keeps the store, the guards, the
// lease AND the outbox, so a later close can still finish the job.
export function createBridgeCloser({ store, adapter, service, unmount, release, resources }) {
  let detached = false;
  let closed = false;
  let pending;
  const closeResources = resourceCloser(resources);
  // The extra field is present only when an owned resource closer was actually
  // supplied, so a closer without one keeps its historical return shape.
  const outcome = (value) => (closeResources === null ? value : { ...value, resourcesClosed: value.closed === true });
  return function close() {
    if (closed) return Promise.resolve(outcome({ closed: true, pendingTaskIds: [] }));
    if (pending) return pending;
    pending = (async () => {
      if (!detached) { unmount?.(); service.close(); detached = true; }
      for (const task of store.list().filter(unsettled)) {
        try { await service.cancel(task.id, 'bridge stopping'); } catch { /* Preserve unknown state. */ }
      }
      const active = store.list().filter(unsettled);
      if (active.length) return outcome({ closed: false, pendingTaskIds: active.map(task => task.id) });
      // Confirmed shutdown: release the owned outbox producer before the store and
      // the host lease, so no event can be enqueued into a store that is gone. A
      // closer that THROWS, or that explicitly reports it did not close (closed:false
      // or ok:false), keeps this close incomplete: nothing is marked closed, the
      // store, the guards and the lease are all retained, and a later close() is a
      // genuine retry instead of a second claim of success.
      if (closeResources !== null) {
        const result = await closeResources();
        if (result !== undefined && result !== null && (result.closed === false || result.ok === false)) {
          return { ...outcome({ closed: false, pendingTaskIds: [] }), resourcesPending: true, resourceClose: result };
        }
      }
      adapter.dispose?.();
      store.close();
      release();
      closed = true;
      return outcome({ closed: true, pendingTaskIds: [] });
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
