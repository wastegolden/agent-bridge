// Offline synthetic model used ONLY by scripts/smoke-autonomy.mjs, inside a fresh
// temporary DSH home under the provided DSH installation directory.
//
// It performs no network call, no paid API call and no GPU work. Each scenario is a
// deterministic function of the model id plus the REAL session history the installed
// host passes in `options.messages`; there is no wall-clock turn counter, no reliance
// on `options.sessionId` and no external `child-id.txt`:
//
//   * the next turn is the number of completed assistant messages + 1, so every
//     session (root and child) advances its own history independently;
//   * a child session is recognised by the REAL `[dsh-adapter controlled child]`
//     prompt the adapter composes (`#composeChildPrompt`), never by the model id,
//     because a child inherits its parent's model grant;
//   * child ids and wait/read/job results are parsed from the structured tool-result
//     messages already present in the history.
//
// Every call appends one bounded line to `calls.jsonl` next to the copied fixture so
// the smoke can assert what the real host session actually saw.
//
// Model ids select the scenario:
//   ordinary      -> one final text answer that names its own visible tools
//   child-agent   -> root: spawn, reply, bounded wait, real child result, answer
//   children-cap  -> root: two live blocking children, a refused third spawn, cancel,
//                    then a list until every child is terminal
//   denial        -> root: out-of-root read, native `subagent`, a real child that is
//                    denied the same way, then a refused scope-widening spawn. The
//                    initial child and the later widening request are labelled
//                    separately (`initial=spawned`/`initial=CHILD_SPAWN_REFUSED` and
//                    `widening=WIDENING_SPAWN_REFUSED`), so a real widening refusal is
//                    never mistaken for the initial child failing.
//   job           -> root: dsh_job_start, bounded job_output wait/read until a real
//                    terminal status carrying the profile marker is parsed (structured
//                    payload or the rendered `[status: <status>, <detail>]` line), then
//                    a foreign-id ownership refusal
//   live-child    -> root: spawn a child, then block until the task is cancelled
//   live-job      -> root: start the waiting profile, one bounded job_output read, then
//                    block until cancelled (or report LIVE_JOB_STOPPED/JOB_READ_REFUSED
//                    if it already died or the read was refused)
//   smallcap      -> same live child tree, used by the small-cap isolated host
//
// A call that really failed is never retried and never waited on: a refused child spawn
// answers CHILD_SPAWN_REFUSED / CHILDREN_SPAWN_REFUSED with the host's exact refusal, and
// the smoke turns that into a failed check with a nonzero exit.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'bridge-autonomy-mock';
export const inject = ['llm'];

const root = import.meta.dirname;
const callsFile = path.join(root, 'calls.jsonl');
const allowedFile = path.join(root, 'workspace', 'allowed.txt');
const outsideFile = path.join(root, 'outside.txt');

const MODELS = Object.freeze([
  'ordinary',
  'child-agent',
  'children-cap',
  'denial',
  'job',
  'live-child',
  'live-job',
  'smallcap',
]);

const CHILD_PROMPT_MARKER = '[dsh-adapter controlled child]';
const CHILD_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// Installed job statuses (`dsh-tool-jobs` render contract): a consuming read renders
// the delta and then ONE `[status: <status>[, <detail>]]` line, for example
// `[status: completed, exit code: 0]`. The terminal vocabulary is
// completed|failed|killed; `running`, `stopping` and `unknown` are never a stop.
const JOB_TERMINAL = new Set(['completed', 'failed', 'killed']);
const JOB_STATUS_LINE = /\[status:\s*([a-z-]+)(?:\s*,\s*([^\]\n]*))?\]/gi;
const JOB_MARKER = 'BRIDGE_AUTONOMY_JOB_OK';
const FOREIGN_JOB_ID = 'job-offline-foreign-000000000000';

// ---------------------------------------------------------------------------
// history parsing
// ---------------------------------------------------------------------------

function messagesOf(options) {
  return Array.isArray(options?.messages) ? options.messages : [];
}

function blockText(block) {
  return block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map(blockText).filter((part) => part.length > 0).join('\n');
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function parseArgs(raw) {
  const value = parseJson(typeof raw === 'string' ? raw : '');
  return value ?? {};
}

/** Ordered tool calls reconstructed from assistant messages. */
function toolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool-call') calls.push({ id: block.id, name: block.name, args: parseArgs(block.arguments) });
    }
  }
  return calls;
}

/**
 * Tool results paired with the call that produced them. Pairing is positional first
 * (the durable conversation is ordered) and falls back to the provider call id, so a
 * host that regenerates ids still yields the real tool name and arguments.
 */
function toolResults(messages) {
  const calls = toolCalls(messages);
  const byId = new Map(calls.map((call) => [call.id, call]));
  const results = [];
  for (const message of messages) {
    if (message?.role !== 'tool') continue;
    const index = results.length;
    const call = byId.get(message.toolCallId) ?? calls[index] ?? null;
    results.push({
      id: message.toolCallId ?? null,
      name: call?.name ?? null,
      args: call?.args ?? null,
      isError: message.isError === true,
      text: messageText(message),
    });
  }
  return results;
}

function lastResult(messages, toolName) {
  const results = toolResults(messages);
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (results[index].name === toolName) return results[index];
  }
  return null;
}

function structured(result) {
  if (result === null || result === undefined) return null;
  const direct = parseJson(result.text);
  if (direct !== null) return direct;
  // Some host renderings prefix a payload with a label or wrap it in prose. The real
  // structured answer is still the first balanced object, so parse exactly that
  // instead of inferring success from prose.
  const text = typeof result.text === 'string' ? result.text : '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? parseJson(text.slice(start, end + 1)) : null;
}

/**
 * The exact refusal a tool result carries, or null for a real success. A failed call is
 * recognised from the host's error flag or a structured refusal payload (`code`/
 * `error`); success is never inferred from prose, and a refusal is never retried.
 */
function resultRefusal(result) {
  if (result === null || result === undefined) return null;
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  if (result.isError === true) return text.length > 0 ? text : '(the host reported a tool error with no text)';
  const value = structured(result);
  if (value === null) return null;
  for (const key of ['code', 'error']) {
    const marker = value[key];
    if (typeof marker === 'string' && marker.trim().length > 0) return `${key}=${marker.trim()}`;
  }
  return null;
}

/**
 * The LAST `[status: ...]` line in one read: the render contract places the status
 * line after the delta, so a status-shaped line inside the job's own output can never
 * masquerade as the job's current state.
 */
function lastStatusLine(text) {
  JOB_STATUS_LINE.lastIndex = 0;
  let match = null;
  for (let found = JOB_STATUS_LINE.exec(text); found !== null; found = JOB_STATUS_LINE.exec(text)) match = found;
  return match;
}

/**
 * One real `job_output` read as the model saw it. `status` comes only from the read
 * itself, never from prose: the rendered `[status: <status>[, <detail>]]` line wins
 * when present, otherwise the host's structured snapshot is used. `terminal` is true
 * only for the installed terminal vocabulary, so `running`/`stopping`/`unknown` can
 * never be mistaken for a stop.
 */
function jobObservation(result) {
  if (result === null || result === undefined) return null;
  const text = typeof result.text === 'string' ? result.text : '';
  const match = lastStatusLine(text);
  if (match !== null) {
    const status = match[1].toLowerCase();
    const detail = typeof match[2] === 'string' && match[2].trim().length > 0 ? match[2].trim() : null;
    return { status, detail, output: text, terminal: JOB_TERMINAL.has(status), source: 'text' };
  }
  const value = structured(result);
  if (value === null) return { status: null, detail: null, output: text, terminal: false, source: 'text-unparsed' };
  const snapshot = value.job !== null && value.job !== undefined && typeof value.job === 'object' ? value.job : value;
  const status = typeof snapshot.status === 'string' ? snapshot.status.toLowerCase() : null;
  const detail = typeof snapshot.detail === 'string' ? snapshot.detail : null;
  const output = typeof value.output === 'string' ? value.output : typeof value.stdout === 'string' ? value.stdout : text;
  return { status, detail, output, terminal: status !== null && JOB_TERMINAL.has(status), source: 'structured' };
}

/** A read settles the job only when it is terminal AND carries the granted profile marker. */
function settledJobOk(observation) {
  return observation !== null && observation.terminal === true && String(observation.output ?? '').includes(JOB_MARKER);
}

/** Whether this task already attempted the foreign (unowned) job id. */
function hasForeignJobRead(results) {
  return results.some(
    (result) => result.name === 'job_output' && result.args !== null && result.args !== undefined && result.args.job_id === FOREIGN_JOB_ID,
  );
}

/** LIVE (non-terminal) children in a `dsh_child_list` payload, or -1 when unreadable. */
function liveChildCount(result) {
  const value = structured(result);
  if (value === null || !Array.isArray(value.children)) return -1;
  return value.children.filter((child) => typeof child?.state === 'string' && !CHILD_TERMINAL.has(child.state)).length;
}

function isChildSession(messages) {
  return messages.some((message) => message?.role === 'user' && messageText(message).includes(CHILD_PROMPT_MARKER));
}

function visibleTools(options) {
  return Array.isArray(options?.tools) ? options.tools.map((tool) => (tool && typeof tool.name === 'string' ? tool.name : '')).filter(Boolean) : [];
}

/** The next turn is derived from durable history, not from a global counter. */
function nextTurn(messages) {
  let assistants = 0;
  for (const message of messages) if (message?.role === 'assistant') assistants += 1;
  return assistants + 1;
}

function summarizeResults(results, limit = 3000) {
  const lines = results.map((result) => `${result.name ?? '?'}${result.isError ? '[error]' : ''}: ${String(result.text ?? '').slice(0, 800)}`);
  return lines.join(' | ').slice(0, limit);
}

function childIdsOf(results) {
  const ids = [];
  for (const result of results) {
    if (result.name !== 'dsh_child_spawn' || result.isError === true) continue;
    const value = structured(result);
    if (value !== null && typeof value.childId === 'string' && value.childId.length > 0) ids.push(value.childId);
  }
  return ids;
}

/** The newest real child id present in the tool history (spawn/wait/result/cancel). */
function newestChildId(messages) {
  const results = toolResults(messages);
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const value = structured(results[index]);
    if (value !== null && typeof value.childId === 'string' && value.childId.length > 0) return value.childId;
  }
  return null;
}

function settledResult(result) {
  const value = structured(result);
  if (value === null) return false;
  if (value.settled === true) return true;
  return typeof value.state === 'string' && CHILD_TERMINAL.has(value.state);
}

function allChildrenTerminal(result) {
  const value = structured(result);
  if (value === null || !Array.isArray(value.children)) return false;
  return value.children.every((child) => typeof child?.state === 'string' && CHILD_TERMINAL.has(child.state));
}

// ---------------------------------------------------------------------------
// stream chunks
// ---------------------------------------------------------------------------

function toolCall(name, args, id) {
  const text = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

function textAnswer(value) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

/** Hold the turn open until the host aborts it (task/child cancellation). */
async function blockUntilAborted(options) {
  await new Promise((resolve, reject) => {
    const signal = options?.signal;
    const fail = () => reject(signal?.reason ?? new Error('aborted'));
    if (signal?.aborted === true) {
      fail();
      return;
    }
    const timer = setTimeout(resolve, 600_000);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        fail();
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// child session turns (the model id is the parent's; context decides the role)
// ---------------------------------------------------------------------------

async function* childTurn(options, model, turn, messages, results) {
  // A blocking child keeps its own shared admission slot alive until cancelled. It
  // is used by the per-task cap case and by the global shared-cap case.
  if (model === 'children-cap' || model === 'live-child' || model === 'live-job' || model === 'smallcap') {
    await blockUntilAborted(options);
    yield* textAnswer('CHILD_ABORTED');
    return;
  }

  // A denial child attempts exactly the operations its grant forbids and reports the
  // real tool results; no content outside its roots may appear.
  if (model === 'denial') {
    if (turn === 1) {
      yield* toolCall('read', { file_path: outsideFile }, `child-denial-outside-${turn}`);
      return;
    }
    if (turn === 2) {
      yield* toolCall('subagent', { prompt: 'offline-child-native-delegation-attempt' }, `child-denial-subagent-${turn}`);
      return;
    }
    if (turn === 3) {
      yield* toolCall('dsh_child_spawn', { childKey: 'offline-grandchild', objective: 'widen past depth 1' }, `child-denial-spawn-${turn}`);
      return;
    }
    if (turn === 4) {
      yield* toolCall('read', { file_path: allowedFile }, `child-denial-allowed-${turn}`);
      return;
    }
    // Report the child's own refusal flags from the host's REAL `isError` tool results,
    // so the parent carries unambiguous child evidence instead of inferring it from prose.
    const refused = (name) => results.some((result) => result.name === name && result.isError === true);
    const allowedRead = results.some((result) => result.name === 'read' && result.isError !== true);
    yield* textAnswer(
      `CHILD_DENIAL_DONE outsideRefused=${refused('read')} nativeDelegationRefused=${refused('subagent')} delegationRefused=${refused('dsh_child_spawn')} allowedRead=${allowedRead} ${summarizeResults(results)}`,
    );
    return;
  }

  // child-agent: read the allowed file through the real host tool, then answer.
  if (turn === 1) {
    yield* toolCall('read', { file_path: allowedFile }, `child-read-${turn}`);
    return;
  }
  yield* textAnswer(`CHILD_DONE ${summarizeResults(results)}`);
}

// ---------------------------------------------------------------------------
// root turns
// ---------------------------------------------------------------------------

async function* rootTurn(options, model, turn, messages, results) {
  const visible = visibleTools(options);

  if (model === 'ordinary') {
    yield* textAnswer(`AUTONOMY_TEXT_OK tools=${[...visible].sort().join(',')}`);
    return;
  }

  if (model === 'child-agent') {
    if (lastResult(messages, 'dsh_child_spawn') === null) {
      yield* toolCall(
        'dsh_child_spawn',
        { childKey: 'autonomy-child-1', objective: 'Read the allowed file and report its content.', tools: ['read'] },
        `spawn-${turn}`,
      );
      return;
    }
    if (lastResult(messages, 'dsh_bridge_reply') === null) {
      yield* toolCall(
        'dsh_bridge_reply',
        { replyId: 'autonomy-reply-1', kind: 'needs-input', summary: 'Offline smoke: root callback reply probe.' },
        `reply-${turn}`,
      );
      return;
    }
    const spawnRefusal = resultRefusal(lastResult(messages, 'dsh_child_spawn'));
    if (spawnRefusal !== null) {
      // The spawn really failed: never retry it and never wait on a child that does not
      // exist. Surface the host's exact refusal so the smoke fails with real evidence.
      yield* textAnswer(`CHILD_SPAWN_REFUSED ${spawnRefusal}`);
      return;
    }
    const childId = newestChildId(messages);
    const wait = lastResult(messages, 'dsh_child_wait');
    if (childId === null || wait === null || !settledResult(wait)) {
      yield* toolCall('dsh_child_wait', { childId: childId ?? 'missing-child-id', waitMs: 1500 }, `wait-${turn}`);
      return;
    }
    if (lastResult(messages, 'dsh_child_result') === null) {
      yield* toolCall('dsh_child_result', { childId, limit: 4000 }, `result-${turn}`);
      return;
    }
    yield* textAnswer(`ROOT_DONE ${summarizeResults(results)}`);
    return;
  }

  if (model === 'children-cap') {
    const spawns = results.filter((result) => result.name === 'dsh_child_spawn');
    if (spawns.length === 0) {
      yield* toolCall('dsh_child_spawn', { childKey: 'autonomy-child-a', objective: 'Bounded offline child a.', tools: ['read'] }, `spawn-a-${turn}`);
      return;
    }
    if (spawns.length === 1) {
      yield* toolCall('dsh_child_spawn', { childKey: 'autonomy-child-b', objective: 'Bounded offline child b.', tools: ['read'] }, `spawn-b-${turn}`);
      return;
    }
    // The per-task cap is measured against LIVE children: both children must really
    // have started and still be running before the third spawn is attempted.
    const earlyRefusals = spawns.slice(0, 2).map((result) => resultRefusal(result)).filter((value) => value !== null);
    if (earlyRefusals.length > 0) {
      // A first/second spawn refusal is an infrastructure failure, never the cap.
      yield* textAnswer(`CHILDREN_SPAWN_REFUSED ${earlyRefusals.join(' || ')}`);
      return;
    }
    const liveProof = results.find((result) => result.name === 'dsh_child_list');
    const liveBefore = liveChildCount(liveProof ?? null);
    if (spawns.length === 2) {
      if (liveProof === undefined) {
        yield* toolCall('dsh_child_list', {}, `cap-live-${turn}`);
        return;
      }
      if (liveBefore < 2) {
        // Two children were published but are not live: the cap cannot be proven here.
        yield* textAnswer(`CHILDREN_NOT_LIVE live=${liveBefore} ${summarizeResults(results)}`);
        return;
      }
      // A third live child must be refused by the per-task grant, never clamped.
      yield* toolCall('dsh_child_spawn', { childKey: 'autonomy-child-c', objective: 'Third child beyond the grant.', tools: ['read'] }, `spawn-c-${turn}`);
      return;
    }
    const thirdRefusal = resultRefusal(spawns[2]);
    const ids = childIdsOf(results);
    const cancels = results.filter((result) => result.name === 'dsh_child_cancel').length;
    if (cancels < ids.length) {
      yield* toolCall('dsh_child_cancel', { childId: ids[cancels], reason: 'offline cap probe cleanup' }, `cancel-${cancels}-${turn}`);
      return;
    }
    const list = lastResult(messages, 'dsh_child_list');
    if (list === null || !allChildrenTerminal(list)) {
      yield* toolCall('dsh_child_list', {}, `list-${turn}`);
      return;
    }
    yield* textAnswer(`CHILDREN_DONE liveAtRefusal=${liveBefore} thirdRefusal=${thirdRefusal ?? 'none'} ${summarizeResults(results)}`);
    return;
  }

  if (model === 'denial') {
    // The INITIAL denial child and the LATER deliberately widening spawn are two
    // different operations. Only the FIRST spawn result decides whether the child ran;
    // the widening attempt is the SECOND spawn result, and its refusal is separate
    // evidence — never proof that the initial child failed.
    const spawns = results.filter((result) => result.name === 'dsh_child_spawn');
    if (lastResult(messages, 'read') === null) {
      yield* toolCall('read', { file_path: outsideFile }, `root-denial-outside-${turn}`);
      return;
    }
    if (lastResult(messages, 'subagent') === null) {
      yield* toolCall('subagent', { prompt: 'offline-root-native-delegation-attempt' }, `root-denial-subagent-${turn}`);
      return;
    }
    if (spawns.length === 0) {
      yield* toolCall(
        'dsh_child_spawn',
        { childKey: 'offline-denial-child', objective: 'Attempt the denied child operations and report them.', tools: ['read'] },
        `spawn-${turn}`,
      );
      return;
    }
    const initialRefusal = resultRefusal(spawns[0]);
    if (initialRefusal !== null) {
      // The INITIAL denial child never started: surface the real refusal, keep the
      // allowed read as a positive control, and never wait on a child that does not exist.
      const reads = results.filter((result) => result.name === 'read');
      if (reads.length < 2) {
        yield* toolCall('read', { file_path: allowedFile }, `root-denial-allowed-${turn}`);
        return;
      }
      yield* textAnswer(`DENIAL_DONE initial=CHILD_SPAWN_REFUSED ${initialRefusal} ${summarizeResults(results, 4000)}`);
      return;
    }
    const childId = newestChildId(messages);
    const wait = lastResult(messages, 'dsh_child_wait');
    if (childId === null || wait === null || !settledResult(wait)) {
      yield* toolCall('dsh_child_wait', { childId: childId ?? 'missing-child-id', waitMs: 1500 }, `wait-${turn}`);
      return;
    }
    if (lastResult(messages, 'dsh_child_result') === null) {
      yield* toolCall('dsh_child_result', { childId, limit: 4000 }, `result-${turn}`);
      return;
    }
    // Now request a widening child grant: more tools and a root outside the parent's.
    if (spawns.length === 1) {
      yield* toolCall(
        'dsh_child_spawn',
        { childKey: 'offline-widening-child', objective: 'Request more than the parent holds.', tools: ['read', 'write'], readRoots: [path.dirname(root)] },
        `widen-${turn}`,
      );
      return;
    }
    // The widening attempt is the SECOND spawn result and MUST be refused. Its label is
    // deliberately distinct from CHILD_SPAWN_REFUSED so the smoke can prove both that the
    // initial child really ran and that the widening request was independently rejected.
    const wideningRefusal = resultRefusal(spawns[1]);
    const wideningState = wideningRefusal === null ? 'WIDENING_SPAWN_SUCCEEDED' : 'WIDENING_SPAWN_REFUSED';
    // Positive control: the allowed read still works after every refusal.
    const reads = results.filter((result) => result.name === 'read');
    if (reads.length < 2) {
      yield* toolCall('read', { file_path: allowedFile }, `root-denial-allowed-${turn}`);
      return;
    }
    // Surface the child's plain result text (not the wrapping JSON) so the parent's
    // bounded answer carries the child's real refusal evidence without escaping.
    const childResult = structured(lastResult(messages, 'dsh_child_result'));
    const childEvidence = childResult?.text ?? '';
    const childState = typeof childResult?.state === 'string' ? childResult.state : 'unknown';
    yield* textAnswer(
      `DENIAL_DONE initial=spawned childState=${childState} widening=${wideningState} wideningRefusal=${wideningRefusal ?? 'none'} child=${String(childEvidence).slice(0, 2000)} ${summarizeResults(results, 4000)}`,
    );
    return;
  }

  if (model === 'job') {
    const started = lastResult(messages, 'dsh_job_start');
    if (started === null) {
      yield* toolCall('dsh_job_start', { profileId: 'autonomy-echo', label: 'autonomy echo job' }, `job-${turn}`);
      return;
    }
    const startRefusal = resultRefusal(started);
    if (startRefusal !== null) {
      // The job never started: surface the exact refusal instead of reading an unowned id.
      yield* textAnswer(`JOB_START_REFUSED ${startRefusal}`);
      return;
    }
    const startedValue = structured(started);
    const jobId = startedValue !== null && typeof startedValue.jobId === 'string' ? startedValue.jobId : null;
    // Only REAL successful reads are a status source; a refused read is never retried.
    const reads = results.filter((result) => result.name === 'job_output' && result.isError !== true);
    const observed = reads.length === 0 ? null : jobObservation(reads[reads.length - 1]);
    if (observed === null || observed.terminal !== true) {
      if (reads.length >= 3) {
        // Bounded: the job is still not terminal after real bounded reads. Report the
        // observation instead of hanging or claiming a settlement that was never seen.
        yield* textAnswer(`JOB_NOT_TERMINAL reads=${reads.length} status=${observed?.status ?? 'unreadable'} detail=${observed?.detail ?? 'none'}`);
        return;
      }
      yield* toolCall('job_output', { job_id: jobId ?? 'missing-job-id', wait: true, timeout_ms: 4000 }, `job-output-${turn}`);
      return;
    }
    if (settledJobOk(observed) !== true) {
      // A terminal read that does not carry the granted profile's marker is a failure,
      // never a success.
      yield* textAnswer(`JOB_OUTPUT_MISMATCH status=${observed.status} detail=${observed.detail ?? 'none'}`);
      return;
    }
    // A job id this task does not own must be refused, never read.
    if (!hasForeignJobRead(results)) {
      yield* toolCall('job_output', { job_id: FOREIGN_JOB_ID }, `job-foreign-${turn}`);
      return;
    }
    const foreignReads = results.filter(
      (result) => result.name === 'job_output' && result.args !== null && result.args !== undefined && result.args.job_id === FOREIGN_JOB_ID,
    );
    const foreignRefused = foreignReads.length > 0 && foreignReads.every((result) => resultRefusal(result) !== null);
    yield* textAnswer(
      `JOB_ROOT_DONE ${JSON.stringify({ status: observed.status, detail: observed.detail, jobOk: settledJobOk(observed), foreignRefused, jobId, source: observed.source })}\n${summarizeResults(results, 4000)}`,
    );
    return;
  }

  if (model === 'live-child' || model === 'smallcap') {
    const spawn = lastResult(messages, 'dsh_child_spawn');
    if (spawn === null) {
      yield* toolCall(
        'dsh_child_spawn',
        { childKey: 'offline-live-child', objective: 'Stay live until the task is cancelled.', tools: ['read'] },
        `spawn-${turn}`,
      );
      return;
    }
    const spawnRefusal = resultRefusal(spawn);
    if (spawnRefusal !== null) {
      // No live child exists, so there is nothing to cancel: report the real refusal
      // instead of blocking until the smoke times out.
      yield* textAnswer(`CHILD_SPAWN_REFUSED ${spawnRefusal}`);
      return;
    }
    await blockUntilAborted(options);
    yield* textAnswer('ROOT_ABORTED');
    return;
  }

  if (model === 'live-job') {
    const started = lastResult(messages, 'dsh_job_start');
    if (started === null) {
      yield* toolCall('dsh_job_start', { profileId: 'autonomy-wait', label: 'autonomy wait job' }, `job-${turn}`);
      return;
    }
    const startRefusal = resultRefusal(started);
    if (startRefusal !== null) {
      yield* textAnswer(`JOB_START_REFUSED ${startRefusal}`);
      return;
    }
    const read = lastResult(messages, 'job_output');
    if (read === null) {
      // One bounded read: the status is parsed from the real read below.
      const value = structured(started);
      const jobId = value !== null && typeof value.jobId === 'string' ? value.jobId : null;
      yield* toolCall('job_output', { job_id: jobId ?? 'missing-job-id', wait: true, timeout_ms: 4000 }, `job-observe-${turn}`);
      return;
    }
    const readRefusal = resultRefusal(read);
    if (readRefusal !== null) {
      // A refused job read is a real seam failure, never a stop: report it instead of
      // leaving the root blocked until the smoke times out.
      yield* textAnswer(`JOB_READ_REFUSED ${readRefusal}`);
      return;
    }
    const observed = jobObservation(read);
    if (observed !== null && observed.terminal === true) {
      // A job that already settled (for example a sandbox EPERM) is surfaced with its
      // real status and detail instead of leaving the root blocked until the smoke
      // times out; the smoke treats this as a failed live-job probe.
      yield* textAnswer(`LIVE_JOB_STOPPED status=${observed.status} detail=${observed.detail ?? 'none'} ${String(observed.output ?? '').slice(0, 600)}`);
      return;
    }
    await blockUntilAborted(options);
    yield* textAnswer('ROOT_ABORTED');
    return;
  }

  yield* textAnswer(`AUTONOMY_OK tools=${[...visible].sort().join(',')}`);
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

class AutonomyAdapter extends LlmAdapter {
  async listModels(provider) {
    return MODELS.map((id) => ({ provider, id, name: `Offline autonomy ${id}` }));
  }

  async *stream(options) {
    const messages = messagesOf(options);
    const child = isChildSession(messages);
    const model = options?.model;
    const turn = nextTurn(messages);
    const results = toolResults(messages);
    const tools = visibleTools(options);
    fs.appendFileSync(
      callsFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        model,
        child,
        turn,
        tools,
        results: results.map((result) => ({ name: result.name, isError: result.isError })),
      })}\n`,
    );

    if (child) {
      yield* childTurn(options, model, turn, messages, results);
      return;
    }
    yield* rootTurn(options, model, turn, messages, results);
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['bridge-autonomy-mock'], new AutonomyAdapter());
}
