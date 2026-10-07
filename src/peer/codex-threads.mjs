// src/peer/codex-threads.mjs
//
// Client for the Codex CLI's stdio JSON-RPC 2.0 server (contract agent-bridge-1.5.0-w2).
//
// The CLI is started as `<executable> app-server` (no further arguments) and speaks one
// JSON object per line in each direction. The verified handshake is
//   client -> {jsonrpc:'2.0', id, method:'initialize', params:{clientInfo:{name,title,version}}}
//   server -> {id, result:{userAgent, codexHome, ...}}
//   client -> {jsonrpc:'2.0', method:'initialized', params:{}}          (notification)
//
// The server may also send notifications (method, no id) — ignored — and server-to-client
// requests (method AND id) — always answered with -32601 so the server never waits on us.
//
// Thread organisation methods used here:
//   threadSection/list  {cursor?: string|null, limit: integer} -> {data:[{id,name,appearance}], nextCursor}
//   threadSection/create{name}                                 -> {section:{id,name,appearance}}
//   thread/section/move {threadId, sectionId, beforeThreadId:null} -> {}
//   thread/name/set     {threadId, name}                       -> {}
//   thread/archive      {threadId}                             -> {}
//   thread/delete       {threadId}                             -> {}
//
// The child is spawned lazily on the first call and handshaken once per child. When the
// child exits or errors, every request pending against that child rejects and the next
// call starts a fresh child (fresh handshake). Every failure is a PeerPolicyError:
// 'PEER_ARGS_INVALID' for refused arguments, 'PEER_CODEX_APP_SERVER_TIMEOUT' when a
// request goes unanswered, and 'PEER_CODEX_APP_SERVER' for every other server failure
// (detail {method, rpcCode} when known). This module is the only place that talks to the
// Codex app-server; it never uses a shell.

import { spawn } from 'node:child_process';

import { PeerPolicyError } from './chain.mjs';

const ARGS_CODE = 'PEER_ARGS_INVALID';
const SERVER_CODE = 'PEER_CODEX_APP_SERVER';
const TIMEOUT_CODE = 'PEER_CODEX_APP_SERVER_TIMEOUT';

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const MAX_NAME_CHARS = 200;

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CLIENT_INFO = Object.freeze({ name: 'agent-bridge', title: 'agent-bridge', version: '1.5.0' });
/** Sections requested per threadSection/list page. */
const SECTION_PAGE_LIMIT = 50;
/** Fail loudly instead of looping forever on a server that repeats a cursor. */
const MAX_SECTION_PAGES = 1000;
/** Bound on waiting for the killed child to actually close in close(). */
const CLOSE_GRACE_MS = 2000;

function assertThreadId(threadId) {
  if (typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) {
    throw new PeerPolicyError(ARGS_CODE, 'threadId must be a UUID such as 01984de2-8f74-7c91-a3b2-5c5e937cf318', { field: 'threadId' });
  }
}

function assertName(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PeerPolicyError(ARGS_CODE, `${field} must be a nonblank string`, { field });
  }
  if (value.length > MAX_NAME_CHARS) {
    throw new PeerPolicyError(ARGS_CODE, `${field} must be at most ${MAX_NAME_CHARS} characters`, { field });
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new PeerPolicyError(ARGS_CODE, `${field} must not contain control characters`, { field });
  }
}

/**
 * Create a client for one Codex app-server. `spawnImpl` exists so tests can run a fixture
 * through the real child_process.spawn; production always uses the default.
 */
export function createCodexThreadClient({
  executable,
  spawnImpl = spawn,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  clientInfo = DEFAULT_CLIENT_INFO,
} = {}) {
  if (typeof executable !== 'string' || executable.trim() === '') {
    throw new PeerPolicyError(ARGS_CODE, 'executable must be a nonblank string', { field: 'executable' });
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new PeerPolicyError(ARGS_CODE, 'requestTimeoutMs must be a positive integer', { field: 'requestTimeoutMs' });
  }
  if (typeof spawnImpl !== 'function') {
    throw new PeerPolicyError(ARGS_CODE, 'spawnImpl must be a function', { field: 'spawnImpl' });
  }
  const info = Object.freeze({
    name: typeof clientInfo?.name === 'string' && clientInfo.name !== '' ? clientInfo.name : DEFAULT_CLIENT_INFO.name,
    title: typeof clientInfo?.title === 'string' && clientInfo.title !== '' ? clientInfo.title : DEFAULT_CLIENT_INFO.title,
    version: typeof clientInfo?.version === 'string' && clientInfo.version !== '' ? clientInfo.version : DEFAULT_CLIENT_INFO.version,
  });

  /** section name -> section id, for the lifetime of this client (survives a respawn). */
  const sectionIds = new Map();
  /** The live child state, or null when no child is running. */
  let current = null;
  /** Promise for the current child's initialize + initialized handshake. */
  let handshake = null;
  let closed = false;
  let nextRequestId = 1;

  function assertOpen() {
    if (closed) {
      throw new PeerPolicyError(SERVER_CODE, 'the codex app-server client is closed');
    }
  }

  function writeMessage(state, message) {
    const stdin = state.proc?.stdin;
    if (state.dead || !stdin || typeof stdin.write !== 'function') {
      throw new PeerPolicyError(SERVER_CODE, 'the codex app-server stdin is not writable', { method: message.method ?? null });
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  function requestOn(state, method, params) {
    return new Promise((resolve, reject) => {
      if (state.dead) {
        reject(new PeerPolicyError(SERVER_CODE, `the codex app-server is not running (${method})`, { method }));
        return;
      }
      const id = nextRequestId;
      nextRequestId += 1;
      const entry = { method, settled: false, timer: null, resolve, reject };
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        state.pending.delete(id);
        reject(new PeerPolicyError(TIMEOUT_CODE, `the codex app-server did not answer ${method} within ${requestTimeoutMs} ms`, { method }));
      }, requestTimeoutMs);
      state.pending.set(id, entry);
      try {
        writeMessage(state, { jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(entry.timer);
        state.pending.delete(id);
        entry.settled = true;
        reject(error instanceof PeerPolicyError
          ? error
          : new PeerPolicyError(SERVER_CODE, `failed to write ${method} to the codex app-server: ${error?.message ?? error}`, { method }));
      }
    });
  }

  /** Settle every request of one child and drop it, so the next call starts a fresh one. */
  function failChild(state) {
    if (state.dead) return;
    state.dead = true;
    for (const entry of state.pending.values()) {
      if (entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.reject(new PeerPolicyError(SERVER_CODE, `the codex app-server exited before answering ${entry.method}`, { method: entry.method }));
    }
    state.pending.clear();
    if (current === state) {
      current = null;
      handshake = null;
    }
  }

  function handleLine(state, raw) {
    const line = raw.trim();
    if (line === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // a non-JSON line on stdout is server noise, never a request result
    }
    if (!message || typeof message !== 'object') return;
    const hasMethod = typeof message.method === 'string';
    const hasId = message.id !== undefined && message.id !== null;
    if (hasMethod && hasId) {
      // Server-to-client request: refuse it immediately so the server never waits on us.
      try {
        writeMessage(state, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported by agent-bridge' } });
      } catch {
        // the child is already gone; failChild() settles whatever is pending
      }
      return;
    }
    if (hasMethod) return; // notification: ignored by design
    if (!hasId) return;
    const entry = state.pending.get(message.id);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    state.pending.delete(message.id);
    if (message.error) {
      const rpcCode = typeof message.error.code === 'number' ? message.error.code : null;
      const text = typeof message.error.message === 'string' ? message.error.message : 'codex app-server error';
      entry.reject(new PeerPolicyError(
        SERVER_CODE,
        `${entry.method} failed (${rpcCode ?? 'unknown rpc code'}): ${text}`,
        rpcCode === null ? { method: entry.method } : { method: entry.method, rpcCode },
      ));
      return;
    }
    entry.resolve(message.result ?? null);
  }

  function onStdout(state, chunk) {
    state.buffer += typeof chunk === 'string' ? chunk : String(chunk);
    let index = state.buffer.indexOf('\n');
    while (index >= 0) {
      const line = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 1);
      handleLine(state, line);
      index = state.buffer.indexOf('\n');
    }
  }

  function startChild() {
    let proc;
    try {
      proc = spawnImpl(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (error) {
      throw new PeerPolicyError(SERVER_CODE, `failed to start the codex app-server: ${error?.message ?? error}`, { method: 'initialize' });
    }
    if (!proc || typeof proc.on !== 'function') {
      throw new PeerPolicyError(SERVER_CODE, 'spawnImpl did not return a child process', { method: 'initialize' });
    }
    const state = { proc, dead: false, buffer: '', pending: new Map() };
    current = state;
    // Every listener is attached synchronously after spawn, before any await, so an early
    // exit or error can never be emitted with nobody listening.
    proc.stdout?.setEncoding?.('utf8');
    proc.stdout?.on?.('data', (chunk) => onStdout(state, chunk));
    proc.stderr?.on?.('data', () => {});
    proc.stdin?.on?.('error', () => {});
    proc.on('error', () => failChild(state));
    proc.on('close', () => failChild(state));
    const ready = (async () => {
      await requestOn(state, 'initialize', { clientInfo: info });
      writeMessage(state, { jsonrpc: '2.0', method: 'initialized', params: {} });
    })();
    handshake = ready;
    // A child that cannot finish the handshake is unusable: drop it and stop the process
    // so the next call starts a fresh one instead of reusing a half-initialized child.
    ready.catch(() => {
      failChild(state);
      try {
        proc.stdin?.end?.();
      } catch {
        // stdin is already gone
      }
      try {
        proc.kill?.();
      } catch {
        // the process is already gone
      }
    });
    return ready;
  }

  async function ensureChild() {
    assertOpen();
    if (handshake) return handshake;
    return startChild();
  }

  async function call(method, params) {
    await ensureChild();
    const state = current;
    if (!state || state.dead) {
      throw new PeerPolicyError(SERVER_CODE, `the codex app-server is not running (${method})`, { method });
    }
    return requestOn(state, method, params);
  }

  /**
   * The id of the section named `name` exactly, creating it when no page contains it.
   * Every page is followed; the resolved id is cached per name for this client's lifetime.
   */
  async function ensureSection(name) {
    assertOpen();
    assertName(name, 'name');
    const cached = sectionIds.get(name);
    if (cached !== undefined) return cached;
    let cursor = null;
    let pages = 0;
    for (;;) {
      if (pages >= MAX_SECTION_PAGES) {
        throw new PeerPolicyError(SERVER_CODE, `threadSection/list exceeded ${MAX_SECTION_PAGES} pages`, { method: 'threadSection/list' });
      }
      pages += 1;
      const page = await call('threadSection/list', { cursor, limit: SECTION_PAGE_LIMIT });
      const data = Array.isArray(page?.data) ? page.data : [];
      for (const section of data) {
        if (section && typeof section.id === 'string' && section.id !== '' && section.name === name) {
          sectionIds.set(name, section.id);
          return section.id;
        }
      }
      const next = page?.nextCursor;
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    const created = await call('threadSection/create', { name });
    const id = created?.section?.id;
    if (typeof id !== 'string' || id === '') {
      throw new PeerPolicyError(SERVER_CODE, 'threadSection/create did not return a section id', { method: 'threadSection/create' });
    }
    sectionIds.set(name, id);
    return id;
  }

  /**
   * Rename and/or move one thread. A null/absent name or sectionName means "leave it
   * alone"; a present but invalid one is refused before any process is started.
   */
  async function organize(threadId, options = {}) {
    assertOpen();
    assertThreadId(threadId);
    const name = options?.name ?? null;
    const sectionName = options?.sectionName ?? null;
    const rename = name !== null;
    const move = sectionName !== null;
    if (rename) assertName(name, 'name');
    if (move) assertName(sectionName, 'sectionName');
    let renamed = false;
    if (rename) {
      await call('thread/name/set', { threadId, name });
      renamed = true;
    }
    let sectionId = null;
    if (move) {
      sectionId = await ensureSection(sectionName);
      await call('thread/section/move', { threadId, sectionId, beforeThreadId: null });
    }
    return { renamed, sectionId };
  }

  async function archive(threadId) {
    assertOpen();
    assertThreadId(threadId);
    await call('thread/archive', { threadId });
    return true;
  }

  async function remove(threadId) {
    assertOpen();
    assertThreadId(threadId);
    await call('thread/delete', { threadId });
    return true;
  }

  /** Kill the running child (if any) and resolve. Later calls fail with PEER_CODEX_APP_SERVER. */
  async function close() {
    closed = true;
    const state = current;
    current = null;
    handshake = null;
    if (!state || state.dead) return;
    state.dead = true;
    for (const entry of state.pending.values()) {
      if (entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.reject(new PeerPolicyError(SERVER_CODE, `the codex app-server client was closed while ${entry.method} was pending`, { method: entry.method }));
    }
    state.pending.clear();
    const proc = state.proc;
    try {
      proc.stdin?.end?.();
    } catch {
      // the stdin may already be gone; kill() below is what matters
    }
    await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        proc.removeListener?.('close', finish);
        resolve();
      };
      timer = setTimeout(finish, CLOSE_GRACE_MS);
      proc.once?.('close', finish);
      try {
        proc.kill?.();
      } catch {
        finish();
      }
    });
  }

  return Object.freeze({ ensureSection, organize, archive, remove, close });
}
