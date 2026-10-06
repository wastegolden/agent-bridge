// Offline stand-in for the codex / claude CLIs used by test/peer.test.mjs.
// argv[0] === 'exec'  -> behaves like `codex exec --json ... -o <file> -`
// argv[0] === '-p'    -> behaves like `claude -p --output-format json ...`
// The prompt arrives on stdin. Prompt markers:
//   SLEEP      never finishes on its own (cancel / timeout tests)
//   FAIL       reports a model-side error
// The reply echoes the inherited chain variables so tests can check propagation.
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (prompt.includes('SLEEP')) {
    setInterval(() => {}, 1000);
    return;
  }
  const echo = JSON.stringify({
    self: process.env.AGENT_BRIDGE_SELF ?? null,
    chain: process.env.AGENT_BRIDGE_CHAIN ?? null,
    rootTask: process.env.AGENT_BRIDGE_ROOT_TASK ?? null,
    claudecode: process.env.CLAUDECODE ?? null,
    codexThread: process.env.CODEX_THREAD_ID ?? null,
    hasPreamble: prompt.startsWith('[agent-bridge]'),
    argv,
  });
  if (argv[0] === 'exec') {
    const resume = argv[1] === 'resume';
    const threadId = resume ? argv.at(-2) : '01a1119d-5fcc-7880-bfd6-0fb84f99c67f';
    const out = argv[argv.indexOf('-o') + 1];
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
    if (prompt.includes('FAIL')) {
      process.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: 'model refused' } })}\n`);
      process.exitCode = 1;
      return;
    }
    const text = `CODEX-ECHO ${echo}`;
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })}\n`);
    writeFileSync(out, text);
    return;
  }
  if (argv[0] === '-p') {
    const resumeAt = argv.indexOf('--resume');
    const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : 'a73c13c2-5006-4731-b1d3-93a817b735bc';
    const failed = prompt.includes('FAIL');
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: failed,
      result: failed ? 'Not logged in · Please run /login' : `CLAUDE-ECHO ${echo}`,
      session_id: sessionId,
      total_cost_usd: 0.001,
      num_turns: 1,
      permission_denials: [],
    }));
    if (failed) process.exitCode = 1;
    return;
  }
  process.stderr.write('unknown fake mode\n');
  process.exitCode = 9;
});
