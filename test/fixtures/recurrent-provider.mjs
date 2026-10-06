// test/fixtures/recurrent-provider.mjs
//
// Offline deterministic model used ONLY by scripts/smoke-recurrent.mjs inside a fresh
// temporary DSH home under the provided installation directory. No network, no paid API
// call, no GPU work.
//
// Roles and rounds come from the REAL session history the installed host passes in
// `options.messages`, never from a global counter:
//   * a supervisor PLANNING round carries `[dsh-long-task supervisor] project ...`;
//   * a supervisor REVIEW round carries `[dsh-long-task supervisor round N/M]`;
//   * a worker carries `[dsh-long-task worker] project ... worker ... attempt ...`.
//
// Model ids select the review-round decision:
//   rec-ok     -> review round reads every worker result, then project_complete
//   rec-pause  -> same as rec-ok (the controller pauses/resumes between the rounds)
//   rec-cap    -> review round reads results, records NO decision (round cap honoured)
//
// Worker behaviour: slow-* waits before answering (so a pause can be observed while real
// owned work is still live); writer-* writes one uncommitted file; everyone else answers.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'bridge-recurrent-mock';
export const inject = ['llm'];

const root = import.meta.dirname;
const callsFile = path.join(root, 'calls.jsonl');

const MODELS = Object.freeze(['rec-ok', 'rec-pause', 'rec-cap']);
const SUPERVISOR_MARKER = '[dsh-long-task supervisor';
const ROUND_MARKER = '[dsh-long-task supervisor round';
const WORKER_MARKER = '[dsh-long-task worker]';
const WORKER_RE = /\[dsh-long-task worker\]\s+project\s+(\S+)\s+worker\s+(\S+)\s+attempt\s+(\d+)/;

const messagesOf = (options) => (Array.isArray(options?.messages) ? options.messages : []);

function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n');
}

const history = (messages) => messages.map((message) => `${message?.role ?? ''}:${textOf(message)}`).join('\n');

function toolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'tool-call') continue;
      let args = {};
      try {
        args = JSON.parse(block.arguments ?? '{}');
      } catch {
        args = {};
      }
      calls.push({ id: block.id, name: block.name, args });
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

const assistantCount = (messages) => messages.filter((message) => message?.role === 'assistant').length;
const visibleTools = (options) => (Array.isArray(options?.tools) ? options.tools.map((tool) => tool?.name ?? '').filter(Boolean) : []);

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

async function delayedAnswer(value, ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return textAnswer(value);
}

/** Turn-by-turn supervisor script for one bounded round. */
function supervisorTurn(model, isReview, turn, messages, results) {
  const creates = results.filter((result) => result.name === 'dsh_supervisor_worker_create');
  const keyed = (key) => creates.some((result) => result.args?.workerKey === key);
  const declaredKeys = toolCalls(messages).filter((call) => call.name === 'dsh_supervisor_worker_create').map((call) => call.args?.workerKey).filter(Boolean);

  if (!isReview) {
    if (model === 'rec-pause' || model === 'rec-cap') {
      if (!keyed('slow-a')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'slow-a', objective: 'answer after a bounded delay', tools: ['read'] }, `slow-a-${turn}`);
      if (!keyed('ok-a')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-a', objective: 'answer with evidence', tools: ['read'] }, `ok-a-${turn}`);
    } else {
      if (!keyed('ok-a')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-a', objective: 'answer with evidence', tools: ['read'] }, `ok-a-${turn}`);
      if (!keyed('ok-b')) return toolCall('dsh_supervisor_worker_create', { workerKey: 'ok-b', objective: 'answer with evidence', tools: ['read'] }, `ok-b-${turn}`);
    }
    if (results.filter((result) => result.name === 'dsh_supervisor_plan_finalize').length === 0) {
      return toolCall('dsh_supervisor_plan_finalize', {}, `freeze-${turn}`);
    }
    return textAnswer(`SUPERVISOR_PLANNED model=${model} workers=${creates.length}`);
  }

  // Review round: read EVERY declared worker's real persisted result first, then decide.
  const reads = results.filter((result) => result.name === 'dsh_supervisor_worker_result');
  for (const key of declaredKeys) {
    if (!reads.some((result) => result.args?.workerId === key)) {
      return toolCall('dsh_supervisor_worker_result', { workerId: key }, `read-${key}-${turn}`);
    }
  }
  if (model === 'rec-cap') return textAnswer(`SUPERVISOR_REVIEWED_NO_DECISION model=${model} reads=${reads.length}`);
  const completes = results.filter((result) => result.name === 'dsh_supervisor_project_complete');
  if (completes.length === 0) {
    return toolCall('dsh_supervisor_project_complete', { summary: `all ${reads.length} declared worker results were read` }, `complete-${turn}`);
  }
  return textAnswer(`SUPERVISOR_COMPLETED model=${model} reads=${reads.length} workers=${declaredKeys.length}`);
}

class RecurrentAdapter extends LlmAdapter {
  async listModels(provider) {
    return MODELS.map((id) => ({ provider, id, name: `Offline recurrent ${id}` }));
  }

  async *stream(options) {
    const messages = messagesOf(options);
    const model = options?.model;
    const results = toolResults(messages);
    const tools = visibleTools(options);
    const supervisor = messages.some((message) => message?.role === 'user' && textOf(message).includes(SUPERVISOR_MARKER));
    const review = messages.some((message) => message?.role === 'user' && textOf(message).includes(ROUND_MARKER));
    const workerMatch = WORKER_RE.exec(history(messages));
    const turn = assistantCount(messages) + 1;
    fs.appendFileSync(
      callsFile,
      `${JSON.stringify({ at: new Date().toISOString(), model, role: supervisor ? 'supervisor' : workerMatch ? 'worker' : 'ordinary', review, workerKey: workerMatch?.[2] ?? null, turn, tools, results: results.map((result) => ({ name: result.name, isError: result.isError })) })}\n`
    );
    if (workerMatch !== null) {
      const workerKey = workerMatch[2];
      if (workerKey.startsWith('slow-')) {
        yield* await delayedAnswer(`WORKER_OK ${workerKey}`, 2500);
        return;
      }
      if (workerKey.startsWith('writer-') && turn === 1) {
        yield* toolCall('write', { file_path: 'worker-note.txt', content: `uncommitted artifact from ${workerKey}\n` }, `worker-write-${turn}`);
        return;
      }
      yield* textAnswer(`WORKER_OK ${workerKey} attempt=${workerMatch[3]}`);
      return;
    }
    if (supervisor) {
      yield* supervisorTurn(model, review, turn, messages, results);
      return;
    }
    yield* textAnswer(`ORDINARY_OK model=${model} tools=${tools.slice().sort().join(',')}`);
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['bridge-recurrent-mock'], new RecurrentAdapter());
}
