const path = require('node:path');
const { pathToFileURL } = require('node:url');
module.exports = {
  name: 'dsh-codex-bridge-v1',
  inject: ['timer', 'webServer', 'sessionController', 'fs', 'sessions', 'agents'],
  apply(ctx, config = {}) {
    let mounted; let disposed = false;
    const close = async value => {
      const result = await value.close();
      if (!result.closed) console.error('[dsh-codex-bridge-v1] stopping is unconfirmed; guards, store and host lease retained; reconcile or restart the host');
    };
    const pending = import(pathToFileURL(path.join(__dirname, '..', 'src', 'bootstrap.mjs')).href)
      .then(m => m.mountBridge(ctx, config))
      .then(async value => { if (disposed) await close(value); else mounted = value; })
      .catch(error => { console.error('[dsh-codex-bridge-v1] initialization failed:', error.code || 'INTERNAL', error.message); throw error; });
    ctx.effect(() => () => { disposed = true; void (mounted ? close(mounted) : pending).catch(error => console.error('[dsh-codex-bridge-v1] shutdown failed:', error.code || 'INTERNAL')); });
    return pending;
  }
};
