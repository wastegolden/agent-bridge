// test/fixtures/supervisor-provider.mjs
//
// Offline deterministic model used ONLY by scripts/smoke-supervisor.mjs, inside a fresh
// temporary DSH home under the provided installation directory. No network, no paid API
// call, no GPU work.
//
// Roles are decided from the REAL session history the installed host passes in
// `options.messages`, never from a global counter or a file:
//   * a supervisor session carries the `[dsh-long-task supervisor]` prompt marker the
//     host composes for `packet.project`;
//   * a worker session carries the `[dsh-long-task worker] project <id> worker <key>
//     attempt <n>` marker the host composes for a project worker task.
//
// Model ids select the supervisor scenario:
//   sup-ok      -> declare three workers, replay one create and the finalize, stop
//   sup-retry   -> declare a worker whose first attempt really fails, then two more
//   sup-cancel  -> declare one slow worker plus two normal ones
//   sup-refuse  -> attempt a widened root and a model field, then a valid plan
//
// Worker behaviour is a function of the parsed workerKey/attempt:
//   writer-*  -> write one uncommitted file, then answer
//   retry-a   -> attempt 1 ends with a real error finish; later attempts answer
//   slow-a    -> block until the host aborts the turn (cancellation probe)
//   other     -> answer immediately
//
// Every call appends one bounded line to `calls.jsonl` next to the copied fixture so the
// smoke can assert which sessions really ran and which tools were visible to them.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'bridge-supervisor-mock';
export const inject = ['llm'];

const root = import.meta.dirname;
const callsFile = path.join(root, 'calls.jsonl');

const MODELS = Object.freeze(['sup-ok', 'sup-retry', 'sup-cancel', 'sup-refuse']);
const SUPERVISOR_MARKER = '[dsh-long-task supervisor]';
const WORKER_MARKER = '[dsh-long-task worker]';
const WORKER_RE = /\[dsh-long-task worker\]\s+project\s+(\S+)\s+worker\s+(\S+)\s+attempt\s+(\d+)/;

function messagesOf(options) {
  return Array.isArray(options?.messages) ? options.messages : [];
}

function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n');
}

function history(messages) {
  return messages.map((message) => `${message?.role ?? ''}:${textOf(message)}`).join('\n');
}

function toolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool-call') {
        let args = {};
        try {
          args = JSON.parse(block.arguments ?? '{}');
        } catch {
          args = {};
        }
        calls.push({ id: block.id, name: block.name, args });
      }
    }
  }
  return calls;
}

function toolResults(messages) {
  const byId = new Map(toolCalls(messages).map((call) => [call.id, call]));
  const results = [];
  for (const message of messages) {
    if (message?.role !== 'tool') continue;
    const call = byId.get(message.toolCallId) ?? null;
    results.push({ name: call?.name ?? null, args: call?.args ?? null, isError: message.isError === true, text: textOf(message) });
  }
  return results;
}

function assistantCount(messages) {
  return messages.filter((message) => message?.role === 'assistant').length;
}

function visibleTools(options) {
  return Array.isArray(options?.tools) ? options.tools.map((tool) => (typeof tool?.name === 'string' ? tool.name : '')).filter(Boolean) : [];
}

function toolCall(name, args, id) {
  const text = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } },
    { type: 'finish', reason: { kind: 'tool-calls' } }
  ];
}

function textAnswer(value) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } }
  ];
}

function errorAnswer(code) {
  const text = `WORKER_FAIL ${code}`;
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'error', error: { code } } }
  ];
}

async function blockUntilAborted(options) {
  await new Promise((resolve, reject) => {
    const signal = options?.signal;
    const fail = () => reject(signal?.reason ?? new Error('aborted'));
    if (signal?.aborted === true) {
      fail();
      return;
    }
    const timer = setTimeout(resolve, 300_000);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      fail();
    }, { once: true });
  });
}

function refusalOf(result) {
  if (result === undefined || result === null) return null;
  if (result.isError === true) return 'isError';
  const match = /"code"\s*:\s*"([^"]+)"/.exec(typeof result.text === 'string' ? result.text : '');
  return match === null ? null : match[1];
}

function summarize(results) {
  return results.map((result) => `${result.name}${result.isError ? '[error]' : ''}`).join(',');
}

// ---------------------------------------------------------------------------
// supervisor turns (history-driven, no wall-clock counter)
// ---------------------------------------------------------------------------

function supervisorTurn(model, turn, messages, results) {
  const creates = results.filter((result) => result.name === 'dsh_supervisor_worker_create');
  if (model === 'sup-refuse') {
    // Turn 1: a widened root outside the envelope. Turn 2: a model field a worker may
    // never set. Turn 3: one valid worker. Turn 4: freeze. Turn 5: report the refusals.
    if (creates.length === 0) {
      return toolCall('dsh_supervisor_worker_create', { workerKey: 'bad-root', objective: 'widen past the envelope', tools: ['read'], readRoots: [path.parse(process.cwd()).root] }, `refuse-root-${turn}`);
    }
    if (creates.length === 1) {
      return toolCall('dsh_supervisor_worker_create', { workerKey: 'bad-model', objective: 'choose my own route', model: { provider: 'deepseek-official', model: 'deepseek-other' } }, `refuse-model-${turn}`);
    }
    if (creates.length === 2) {
      return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-a', objective: 'answer with evidence', tools: ['read'] }, `refuse-ok-${turn}`);
    }
    if (results.filter((result) => result.name === 'dsh_supervisor_plan_finalize').length === 0) {
      return toolCall('dsh_supervisor_plan_finalize', {}, `refuse-freeze-${turn}`);
    }
    const widths = creates.slice(0, 2).map((result) => refusalOf(result));
    return textAnswer(`SUPERVISOR_REFUSED rootRefused=${widths[0] !== null} modelRefused=${widths[1] !== null} ${summarize(results)}`);
  }
  const keyed = (key) => creates.some((result) => result.args?.workerKey === key);
  if (model === 'sup-retry') {
    if (!keyed('retry-a')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'retry-a', objective: 'fail once then succeed', tools: ['read'] }, `retry-a-${turn}`);
    if (!keyed('ok-a')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-a', objective: 'answer with evidence', tools: ['read'] }, `retry-b-${turn}`);
    if (!keyed('ok-b')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-b', objective: 'answer with evidence', tools: ['read'] }, `retry-c-${turn}`);
  } else if (model === 'sup-cancel') {
    if (!keyed('slow-a')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'slow-a', objective: 'stay live until cancelled', tools: ['read'] }, `cancel-a-${turn}`);
    if (!keyed('ok-a')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-a', objective: 'answer with evidence', tools: ['read'] }, `cancel-b-${turn}`);
    if (!keyed('ok-b')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-b', objective: 'answer with evidence', tools: ['read'] }, `cancel-c-${turn}`);
  } else {
    if (!keyed('ok-a')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-a', objective: 'answer with evidence', tools: ['read'] }, `ok-a-${turn}`);
    if (!keyed('ok-b')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-b', objective: 'answer with evidence', tools: ['read'] }, `ok-b-${turn}`);
    if (!keyed('writer-c')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'writer-c', objective: 'write one uncommitted file', role: 'implement', tools: ['read', 'write', 'edit'] }, `ok-c-${turn}`);
    // Replay the first worker key and the freeze: both must be idempotent no-ops.
    if (creates.filter((result) => result.args?.workerKey === 'ok-a').length === 1) {
      return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-a', objective: 'answer with evidence', tools: ['read'] }, `ok-a-replay-${turn}`);
    }
  }
  const finalizes = results.filter((result) => result.name === 'dsh_supervisor_plan_finalize');
  if (finalizes.length === 0) return toolCall('dsh_supervisor_plan_finalize', {}, `freeze-${turn}`);
  if (finalizes.length === 1 && model === 'sup-ok') return toolCall('dsh_supervisor_plan_finalize', {}, `freeze-replay-${turn}`);
  return textAnswer(`SUPERVISOR_DONE model=${model} workers=${creates.length} ${summarize(results)}`);
}

function workerTurn(workerKey, attempt, turn, options) {
  if (workerKey === 'slow-a') return blockUntilAborted(options).then(() => textAnswer('WORKER_ABORTED'));
  if (workerKey === 'retry-a' && attempt === 1) return null; // caller emits the error finish
  if (workerKey.startsWith('writer-') && turn === 1) {
    return toolCall('write', { file_path: 'worker-note.txt', content: `uncommitted artifact from ${workerKey}\n` }, `worker-write-${attempt}`);
  }
  return textAnswer(`WORKER_OK ${workerKey} attempt=${attempt}`);
}

class SupervisorAdapter extends LlmAdapter {
  async listModels(provider) {
    return MODELS.map((id) => ({ provider, id, name: `Offline supervisor ${id}` }));
  }

  async *stream(options) {
    const messages = messagesOf(options);
    const model = options?.model;
    const results = toolResults(messages);
    const tools = visibleTools(options);
    const isSupervisor = messages.some((message) => message?.role === 'user' && textOf(message).includes(SUPERVISOR_MARKER));
    const workerMatch = WORKER_RE.exec(history(messages));
    const isWorker = workerMatch !== null;
    const workerKey = workerMatch === null ? null : workerMatch[2];
    const attempt = workerMatch === null ? 1 : Number(workerMatch[3]);
    const turn = assistantCount(messages) + 1;
    fs.appendFileSync(
      callsFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        model,
        role: isSupervisor ? 'supervisor' : isWorker ? 'worker' : 'ordinary',
        workerKey,
        attempt,
        turn,
        tools,
        results: results.map((result) => ({ name: result.name, isError: result.isError }))
      })}\n`
    );
    if (isWorker) {
      const error = workerKey === 'retry-a' && attempt === 1 ? errorAnswer('OFFLINE_WORKER_FAIL') : null;
      if (error !== null) {
        yield* error;
        return;
      }
      const next = workerTurn(workerKey, attempt, turn, options);
      if (next !== null && typeof next.then === 'function') {
        yield* await next;
        return;
      }
      yield* next ?? textAnswer(`WORKER_OK ${workerKey}`);
      return;
    }
    if (isSupervisor) {
      yield* supervisorTurn(model, turn, messages, results);
      return;
    }
    yield* textAnswer(`ORDINARY_OK model=${model} tools=${tools.slice().sort().join(',')}`);
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['bridge-supervisor-mock'], new SupervisorAdapter());
}
