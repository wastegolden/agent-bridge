// test/fixtures/fake-codex-app-server.mjs
//
// Offline stand-in for `<codex.exe> app-server`: a JSON-RPC 2.0 server speaking one JSON
// object per line over stdio. It answers the verify-able subset used by
// src/peer/codex-threads.mjs (initialize / initialized, threadSection/list,
// threadSection/create, thread/section/move, thread/name/set, thread/archive,
// thread/delete) entirely in memory, so no Codex install is required.
//
// Every inbound message that carries a `method` (request or notification) is appended to
// the file named by FAKE_APP_SERVER_LOG as one JSON line: {"method":..., "params":...}.
// A client *response* to the server-to-client ping has no method, so it is recorded as
// {"method":null, "params":null, "clientResponse":{id,error,result}} — that line is how a
// test observes whether the client answered the request.
//
// Behaviour switches (environment):
//   FAKE_APP_SERVER_LOG            file to append received messages to (optional)
//   FAKE_APP_SERVER_PAGES=1        threadSection/list returns one section per page
//   FAKE_APP_SERVER_FAIL_METHOD=m  answer method m with {code:-32000, message:'boom'}
//   FAKE_APP_SERVER_SILENT_METHOD=m never answer method m
//   FAKE_APP_SERVER_PING=1         right after initialize, send one server-to-client
//                                  request {id:'srv-1', method:'item/tool/requestUserInput'}
//                                  and one notification, then record the client's answer
//   FAKE_APP_SERVER_SEED=a,b       pre-seed extra sections (after Pinned) so pagination
//                                  can be exercised with the PAGES switch
//
// The server always pre-seeds the section
// {id:'01984de2-8f74-7c91-a3b2-5c5e937cf318', name:'Pinned'}.
//
// argv is expected to be ['app-server'] and is otherwise ignored.

import { appendFileSync } from 'node:fs';

const LOG_PATH = process.env.FAKE_APP_SERVER_LOG ?? '';
const PAGES = process.env.FAKE_APP_SERVER_PAGES === '1';
const FAIL_METHOD = process.env.FAKE_APP_SERVER_FAIL_METHOD ?? '';
const SILENT_METHOD = process.env.FAKE_APP_SERVER_SILENT_METHOD ?? '';
const PING = process.env.FAKE_APP_SERVER_PING === '1';

/** Deterministic section ids keep test assertions exact. */
function sectionIdFor(index) {
  return `01984de2-8f74-7c91-a3b2-${index.toString(16).padStart(12, '0')}`;
}

const sections = [];
let sectionCounter = 0;

function addSection(name, fixedId = null) {
  sectionCounter += 1;
  const section = { id: fixedId ?? sectionIdFor(sectionCounter), name, appearance: {} };
  sections.push(section);
  return section;
}

addSection('Pinned', '01984de2-8f74-7c91-a3b2-5c5e937cf318');
for (const name of (process.env.FAKE_APP_SERVER_SEED ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '')) {
  addSection(name);
}

/** Thread state, so a move/rename/archive/delete is observable beyond the request log. */
const threads = new Map();

function log(record) {
  if (LOG_PATH === '') return;
  appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`);
}

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // the client is gone; nothing left to answer
  }
}

const replyResult = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function threadOf(threadId) {
  const key = typeof threadId === 'string' ? threadId : '';
  if (!threads.has(key)) threads.set(key, { threadId: key, name: null, sectionId: null, archived: false, deleted: false });
  return threads.get(key);
}

function listSections(params) {
  const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 50;
  const effective = PAGES ? 1 : limit;
  const parsed = typeof params.cursor === 'string' && params.cursor !== '' ? Number.parseInt(params.cursor, 10) : 0;
  const from = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  const data = sections.slice(from, from + effective);
  const end = from + data.length;
  return { data, nextCursor: end < sections.length ? String(end) : null };
}

function handle(message) {
  const method = typeof message.method === 'string' ? message.method : null;
  if (method === null) {
    // A response from the client to a server-to-client request: record it verbatim.
    log({
      method: null,
      params: null,
      clientResponse: {
        id: message.id ?? null,
        error: message.error ?? null,
        result: message.result ?? null,
      },
    });
    return;
  }
  log({ method, params: message.params ?? {} });
  if (message.id === undefined || message.id === null) return; // notification: never answered
  const id = message.id;
  if (method === FAIL_METHOD) {
    replyError(id, -32000, 'boom');
    return;
  }
  if (method === SILENT_METHOD) return;
  const params = message.params ?? {};
  switch (method) {
    case 'initialize': {
      replyResult(id, {
        userAgent: 'fake-codex-app-server/0.0.0',
        codexHome: '/fake/codex-home',
        platformFamily: 'windows',
        platformOs: 'windows',
      });
      if (PING) {
        send({ jsonrpc: '2.0', id: 'srv-1', method: 'item/tool/requestUserInput', params: { questions: [] } });
        send({ jsonrpc: '2.0', method: 'thread/started', params: { threadId: '01984de2-8f74-7c91-a3b2-5c5e937cf318' } });
      }
      return;
    }
    case 'threadSection/list':
      replyResult(id, listSections(params));
      return;
    case 'threadSection/create': {
      const name = typeof params.name === 'string' ? params.name : '';
      replyResult(id, { section: addSection(name) });
      return;
    }
    case 'thread/section/move': {
      const thread = threadOf(params.threadId);
      thread.sectionId = typeof params.sectionId === 'string' ? params.sectionId : null;
      replyResult(id, {});
      return;
    }
    case 'thread/name/set': {
      const thread = threadOf(params.threadId);
      thread.name = typeof params.name === 'string' ? params.name : null;
      replyResult(id, {});
      return;
    }
    case 'thread/archive': {
      threadOf(params.threadId).archived = true;
      replyResult(id, {});
      return;
    }
    case 'thread/delete': {
      threadOf(params.threadId).deleted = true;
      replyResult(id, {});
      return;
    }
    default:
      replyError(id, -32601, `unknown method ${method}`);
  }
}

process.stdout.on('error', () => process.exit(0));

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== '') {
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        message = null;
      }
      if (message && typeof message === 'object') handle(message);
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
