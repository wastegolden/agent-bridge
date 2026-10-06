# Event wake: durable outbox → Codex follow-up

Callback-owned module set for the trusted controller side. It lets a directly
delegated DS session report a bounded outcome back to the Codex conversation
that owns it, without polling, without a scheduler, without a second Codex
writer and without exposing any of it as a worker tool.

Files:

| File | Role |
| --- | --- |
| `src/wake-outbox.mjs` | durable event outbox, dedupe, claim/attempt state machine, exclusive locks, recovery, core sink factory |
| `src/codex-wake-client.mjs` | official codex-app-tools MCP stdio client, fixed-target wake call, positive-ack parsing, framing |
| `bin/wake-codex.mjs` | event-driven runner (and operator `--reconcile`), config loading |
| `src/wake-integration.mjs` | host `eventWake` config, per-target outbox directory resolver/router, controller config loader (release 1.2.0 integration) |
| `bin/wake-controller.mjs` | trusted-controller entrypoint: one validated originating chat, minimal `--once`/reconcile flags |
| `test/wake-integration.test.mjs` | integration boundary: config refusal, target isolation, real producer records, ack semantics, 8000/8001 and 8192/8193 limits, close lifecycle |
| `scripts/smoke-autonomy.mjs` | real installed-DSH offline probe: real child session, bounded authority, cancellation, profile job, real producer outbox |
| `test/wake-outbox.test.mjs` | permissions, dedupe, filenames, crash-before/after-send, locks, multi-process race, recovery, runner idling |
| `test/codex-wake-client.test.mjs` | fake-MCP transport, acknowledgement shapes, target opt-in, approval denial, reconnection, framing, argv/shell |

## Product connection (`src/wake-integration.mjs`, bridge 1.2.0)

The host mount wires the real supervisor sink to the real outbox. Configuration is
serializable and lives in the DSH host config:

```json
{
  "rootCallbackGrants": { "originating-chat": { "targetId": "01a0e7a9-7906-7280-86a5-abca2e6bca27" } },
  "eventWake": { "enabled": true, "stateRoot": "F:/DSH/data/codex-bridge-v1/wake-state", "maxSummaryChars": 8192, "claimLeaseMs": 30000 }
}
```

* `rootCallbackGrants` is the ONLY grant map and always stays top-level. Nested grants
  are refused, and an enabled `eventWake` together with an injected `notificationSink`
  is refused as ambiguous dual configuration. Absent/disabled keeps the old behaviour.
* `stateRoot` must be absolute. `targetId` is an opaque conversation id (a UUID is
  valid), never a path: the directory is `stateRoot/t-<sha256(targetId)>` (full digest),
  derived by `resolveTargetOutboxDir` so host and controller can never disagree. A
  `target.json` binding marker makes a digest collision fail closed.
* The integration **passes `maxSummaryChars: 8192` explicitly**; the accepted low-level
  default stays 1200 and the old runner CLI default stays 1200. A `queued`
  acknowledgement is never reported as `delivered`: only a runner with a positive
  exact-target acknowledgement can settle an event as delivered. Capabilities report
  `producer/outboxConfigured: true` while `liveTransport`, `runnerAvailable` and
  `liveAck` stay `unknown`.
* The outbox is closed by the bridge lifecycle **only** when no unsettled task remains;
  an unconfirmed stop keeps the outbox, the store and the host lease for a later close.

## Core integration API (the exact sink)

```js
import { createWakeSink } from './src/wake-outbox.mjs';

const sink = createWakeSink({
  dir: '<controller-owned state dir>',      // required, e.g. F:/DSH/data/.../wake-state
  authority: { root: true, source: 'trusted-controller' }, // required
  allowedTargetIds: ['01a0e7a9-7906-7280-86a5-abca2e6bca27'], // required, explicit opt-in
  maxSummaryChars: 1200,                    // optional, default 1200
  claimLeaseMs: 30000,                      // optional, default 30000
});

// Minimal sink event shape (extra control-shaped keys are rejected with E_ARGS):
await sink({ eventId, taskId, attemptId, targetId, kind, summary, resultIds });
//   eventId   string, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ (data, never a path)
//   taskId    string, attemptId string, targetId string (must be opted in)
//   kind      'completed' | 'failed' | 'cancelled' | 'needs-input'
//   summary   string, <= maxSummaryChars (over-long is refused, never truncated here)
//   resultIds optional string[] (<= 32 ids), cited in the follow-up message
// resolves  { ok: true, duplicate: boolean, reason, event }
// rejects   on any validation or persistence failure (fail-closed): E_ARGS,
//           E_TARGET, E_CONFLICT, E_STORE, E_CLOSED, E_AUTHORITY, E_LOCK_*,
//           E_RUNNER_BUSY
```

Identifiers (`eventId`, `taskId`, `attemptId`, `targetId`, `resultIds[]`) must be
non-blank, at most 200 characters and must not contain control characters
(`\u0000-\u001f`, `\u007f`): CR/LF/NUL/ESC in any identifier is `E_ARGS`, so a
model-authored id cannot inject message lines.

`createWakeSink(...).outbox` exposes the full outbox for the runner:
`enqueue`, `claimNext`, `markInFlight`, `recordDelivered|Refused|Failed|Unknown`,
`recover`, `acquireRunnerOwnership`, `releaseRunnerOwnership`, `reconcile`,
`getEvent`, `listEvents`, `hasWork`, `waitForWork`, `stats`, `close`.

## Record identity and dedupe

* A record's on-disk name is `events/evt-<sha256(eventId)>.json`. The `eventId`
  is stored inside the record as data and is verified against the filename on
  every load (`filenameForEventId`). Ids containing `:` (an NTFS alternate data
  stream in a raw path), Windows reserved device names (`CON`, `NUL`, `COM1`…)
  and ids differing only by case all round-trip through `enqueue` → `listEvents`
  → `getEvent` with no alias or filename loss. No prototype layout exists, so
  there is no legacy filename compatibility to preserve.
* Reply identity is the immutable `eventId` alone. A replay with the same
  `eventId` and identical payload returns `duplicate: true`; the same `eventId`
  with a different payload is `E_CONFLICT`; two distinct ids that share
  `taskId|attemptId|kind` are **separate events** and both persist (a second
  `needs-input` reply is never silently dropped).
* Attack-shaped fields (`threadId`, `conversationId`, `destination`, `pipePath`,
  `command`, `args`, `env`, `token`, `serverPath`, `tool`, `codexThreadId`,
  `instructions`, …) are refused with `E_ARGS`, so model text can never choose a
  destination or a transport.

## Delivery lifecycle

```
pending --claimNext--> claimed(lease) --markInFlight--> in_flight --positive-ack--> delivered
                                   \                                  \-------------> unknown (ambiguous)
                                    \--refused / failed (no external effect)
```

* The **dispatch marker** (`in_flight` + `attempt`) is persisted, with a
  best-effort `fsync` of the temp file before the rename, immediately BEFORE the
  external call. `claimNext` never returns an `in_flight` record.
* Crash *before* the marker: the claim lease expires and the event is reclaimed
  (attempt number preserved) and delivered exactly once.
* Crash *after* the marker: the send is ambiguous → `unknown`. It is never
  retried automatically. `reconcile(eventId, {delivered:true|false, requeue?})`
  is the only way out, and only an operator/controller decides it.
* Acknowledgements: `delivered` requires a **positive acknowledgement of the
  exact granted target** from the `tools/call` result — either a direct
  `structuredContent.threadId` (or `thread_id`) equal to the target, or a
  `content` text item that JSON-parses to `{threadId:"<target>"}`. There is no
  recursive field search. A real `isError:true` result is preserved as `refused`
  + `E_HOST_REFUSED`; `null`, `{}`, malformed content, a wrong-thread ack and a
  non-boolean `isError` all yield the ambiguous `unknown` (`E_ACK_TARGET` /
  `E_ACK_UNCONFIRMED`), which is never blindly resent.
* `client.probeAcknowledgement({eventId, interpret})` remains available but is
  fail-closed: with no injected interpreter it returns `{known:false}`.

## Concurrency, locks and recovery (v1 limits)

* **All read-modify-write operations** (`enqueue`, `claimNext`, `markInFlight`,
  every settlement, `reconcile`, `recover`) run under an exclusive lock file
  `<state-dir>/state.lock` created with `open(...,'wx')`. Contention is bounded
  (`lockTimeoutMs`, default 5000 ms) and then fails with `E_LOCK_BUSY`; no lock
  is ever stolen.
* **One live runner per state dir** holds `<state-dir>/runner.lock` for its
  lifetime. A second live runner gets `E_RUNNER_BUSY`. Producers only need the
  state lock, so they keep enqueuing while a runner owns the runner lock and
  sleeps between events.
* Locks are released only by their **token-checked owner** (the file is deleted
  only when its stored token matches). There is **no automatic stale-lock
  reclaim**: not on a dead pid, not on elapsed time. Two automatic reclaimers
  could delete a freshly acquired lock and break exclusivity.
* A lock that cannot be acquired fails closed with a diagnostic naming the lock
  file and owner (`E_LOCK_BUSY` when the owner looks live or is on another host,
  `E_LOCK_STALE` when the owner process is provably gone on this host). The
  message states the offline procedure.
* **Offline operator recovery** (documented, manual): stop every producer and
  runner that uses the state directory, confirm no live owner remains, then
  delete only the named lock file. Process-crash recovery is therefore not
  automatic; this availability limit is accepted for v1.
* `recover({runnerId})` requires exclusive runner ownership first (else
  `E_RUNNER_BUSY`). Only then does it return expired `claimed` records to
  `pending` and convert orphaned `in_flight` markers to the terminal `unknown`
  state (`recovered-interrupted-send`) — never resending them. It can never
  touch a live sender's `in_flight` marker, because a live sender holds the
  runner lock.

## Wake client

```js
import { createWakeClient } from './src/codex-wake-client.mjs';

const client = createWakeClient({
  authority: { root: true, source: 'trusted-controller' },
  allowedTargetIds: ['01a0e7a9-7906-7280-86a5-abca2e6bca27'],
  // caller context injected by the controller; never a model-supplied thread id
  callerContext: { codexThreadId: '<origin Codex thread>', codexTurnId?, codexCallId? },
  maxSummaryChars: 1200,
  transport,              // OR transportFactory(), OR stdio: {...} (tests inject a fake)
  stdio: {
    serverPath: 'C:/Users/ROG/.codex/plugins/cache/openai-bundled/codex-app-tools/0.1.5/server.mjs',
    nodePath: process.execPath,
    env: process.env,     // passed through to the server child; never read or logged
  },
});

const outcome = await client.deliver(event);
// { outcome: 'delivered' | 'refused' | 'failed' | 'unknown', code, message?, hostError?, ack? }
```

`deliver` never throws for policy, host or transport failures; it returns a
typed outcome so the runner can persist it. Route rules:

* `tools/list` is called once per live connection; only `send_message_to_thread`
  (and `read_thread` for the optional probe) is ever invoked. No tool fan-out.
* When the stdio child exits or errors, the handshake state and any partial
  frame are reset and the cached `tools/list` catalog is discarded, so the next
  request spawns a fresh server, sends `initialize` first and re-discovers
  tools. It does not reuse a dead connection's catalog.
* The destination argument and the message argument are resolved from the
  discovered `inputSchema`; an unresolvable or ambiguous schema is
  `E_SCHEMA`/refused, never guessed.
* `params._meta` always carries the injected `codexThreadId`; a missing caller
  context is refused at construction (`E_CALLER`). The client never forges a
  thread identity.
* The fixed follow-up message marks the DS output as UNTRUSTED RESULT DATA,
  points at owned `resultIds`, and carries the event identity as JSON data
  (`[dsh-bridge-event] {"eventId":…,"kind":…,"taskId":…,"attemptId":…,"resultIds":[…]}`).
  The summary is embedded as a JSON string and fenced with a per-message random
  boundary token, so no payload can close the untrusted-data fence or inject a
  new message line. The fence wording is not a trust boundary by itself: the
  target and caller checks above are what constrain the send.
* Host approval/auth denial is preserved: an `isError` result becomes
  `refused` + `E_HOST_REFUSED` with the host message (bounded) in `hostError`.
* Transport classification: `failed` only when no byte can have reached the
  host — a spawn failure (`E_SPAWN`), a synchronous write throw (`E_WRITE`
  before any byte is handed to the host), or MCP `-32601/-32602`. A write that
  was *attempted* but whose callback never confirmed, an asynchronous write
  error, a timeout, a disconnect, and an opaque MCP error are all `unknown`
  (ambiguous). Auth/policy codes are `refused`. There is no internal retry.
* `spawn(nodePath, [serverPath], { shell: false, env })` only. The message is a
  JSON string field, never a command line, and env values are never logged.

## Runner and startup

```bash
# state dir + target + server path + origin thread are injected (flags or env):
node bin/wake-codex.mjs \
  --state-dir "F:/DSH/data/codex-bridge-v1/wake-state" \
  --target "01a0e7a9-7906-7280-86a5-abca2e6bca27" \
  --server-path "C:/Users/ROG/.codex/plugins/cache/openai-bundled/codex-app-tools/0.1.5/server.mjs" \
  --caller-thread "<origin Codex thread id>"

# one drain pass (tests/CI), then exit:
node bin/wake-codex.mjs --state-dir ... --target ... --server-path ... --caller-thread ... --once

# operator reconciliation of an ambiguous send (--target is required in every mode):
node bin/wake-codex.mjs --state-dir ... --target ... --reconcile evt-123 --delivered true
node bin/wake-codex.mjs --state-dir ... --target ... --reconcile evt-123 --delivered false --requeue
```

Equal-name env vars: `DSH_WAKE_STATE_DIR`, `DSH_WAKE_TARGET`, `DSH_WAKE_SERVER`,
`DSH_WAKE_NODE`, `DSH_WAKE_CALLER_THREAD`, `DSH_WAKE_CALLER_TURN`,
`DSH_WAKE_CALLER_CALL`, `DSH_WAKE_IDLE_TIMEOUT_MS`, `DSH_WAKE_CLAIM_LEASE_MS`,
`DSH_WAKE_MAX_SUMMARY_CHARS`. `--state-dir`/`DSH_WAKE_STATE_DIR` and
`--target`/`DSH_WAKE_TARGET` are required in every mode; `--server-path` and
`--caller-thread` are required for a send run but not for `--reconcile`. Missing
settings fail with `E_ARGS` naming the setting (never its value). Log lines carry
only presence/booleans/ids/codes plus, on a claim refusal, the bounded lock
diagnostic (lock file path, owner pid/host, offline recovery instruction) — never
raw MCP messages, environment values, pipe paths or credentials.

`runWakeRunner({outbox, client, idleTimeoutMs, once, signal, logger})`:
claim → dispatch marker → single `client.deliver` → persist one of
`delivered|refused|failed|unknown`. With an empty outbox it awaits
`outbox.waitForWork(...)`, which wakes on an in-process enqueue notification, a
filesystem change in the events directory, an abort signal, a watcher error, or
the bounded idle timer. `idleTimeoutMs` defaults to **5000 ms**, and a
zero/absent value falls back to the same bounded safety timer, so an unavailable
or missed `fs.watch` cannot strand a pending event indefinitely. This is a local
filesystem fallback only: there is no LLM polling, no scheduler and no Codex
heartbeat, and the runner stays asleep between events/timer checks.

A claim refusal (`E_RUNNER_BUSY` / `E_LOCK_STALE` / any claim error) is never
retried and never steals the lock: the runner stops and the process exits
nonzero (code 2, distinct from the fatal-error code 1) after logging the lock
diagnostic, so a supervisor can see and act on it.

## Trusted controller entrypoint (`bin/wake-controller.mjs`)

```bash
# controller.json holds paths and limits only (no environment secret):
# { "stateRoot": "F:/DSH/data/codex-bridge-v1/wake-state",
#   "targetId": "01a0e7a9-7906-7280-86a5-abca2e6bca27",
#   "serverPath": "C:/Users/ROG/.codex/plugins/cache/openai-bundled/codex-app-tools/0.1.5/server.mjs",
#   "idleTimeoutMs": 5000 }
node bin/wake-controller.mjs --config F:/DSH/data/codex-bridge-v1/wake-controller.json
node bin/wake-controller.mjs --config <abs json> --once
node bin/wake-controller.mjs --config <abs json> --reconcile evt-123 --delivered true
```

`callerThreadId` defaults to `targetId` and must equal it: a runner is bound to exactly
one originating chat and never relays to another. At startup the process requires
`process.env.CODEX_THREAD_ID === targetId === callerThreadId` and requires the official
transport environment to be present (presence only — the value is never read, copied,
hashed or logged). There are deliberately **no** `--target/--state-dir/--server-path/
--caller-thread` overrides, so no command line can bypass the single validated binding.
The official stdio server is spawned with `shell:false` and `windowsHide:true`; a
missing or mismatched caller identity is a typed refusal, never forged `_meta`. No
service manager, detached wrapper or global environment change is required.

## Durability and permissions (honest)

* `writeRecord` writes a temp file, best-effort `fsync`s it (`FileHandle.sync`,
  which is `FlushFileBuffers` on Windows) and then renames it into place. This
  makes the `in_flight` dispatch marker safe across a process crash; it does not
  make the rename itself power-loss atomic (the directory entry is not fsynced),
  so a power loss can still lose the very last marker and the event may be
  reclaimed and resent once. That bound is accepted.
* Lock and record files are created with `mode: 0o600`, but on Windows the mode
  bits are largely inert: ACLs on the state directory are the real access
  control, and the operator must keep that directory controller-owned.
* `assertRootAuthority` is a literal integration convention plus packaging, not
  an OS sandbox; it is correct only while these modules are never registered as
  worker tools.
* The outbox is not encrypted and stores bounded summary text, never credentials
  or pipe values.

## Tests (run by Codex; not executed by the worker)

```bash
node --test test/wake-outbox.test.mjs test/codex-wake-client.test.mjs test/wake-integration.test.mjs
node scripts/smoke-autonomy.mjs <DSH installation directory>
```

Covered: root-authority boundary; identifier/target/summary validation,
control-character refusal and control-field refusal; deterministic hashed
filenames with colon/reserved-name/case round trips; eventId-only dedupe that
never drops a second reply of the same kind; durable read-back; crash before the
dispatch marker (reclaim + exactly-once delivery); crash after it (never
reclaimed, explicit reconcile, requeue preserves attempt history); exclusive
state and runner locks (live owner never stolen, stale lock diagnosed and never
auto-removed, producers still enqueue while a runner holds the lock); explicit
`recover` gated on runner ownership; a spawned multi-process claim race that
asserts exactly one claim and no overwrite of `in_flight`; runner idling with a
bounded safety timer and a throwing `fs.watch` seam; sink fail-closed behaviour;
positive-ack shapes (structuredContent, content text JSON, `null`, `{}`,
malformed, wrong-thread, non-boolean `isError`); same-target success with the
discovered tool only; wrong target / no opt-in refusal; unresolvable schema; host
approval denial; pre-send vs in-flight failure classification; mid-flight
disconnection; reconnection that re-initializes and re-discovers tools;
newline-delimited JSON framing across chunk boundaries; JSON-encoded ids/summary
with an unforgeable boundary; the documented `--reconcile` command; `shell:false`
argv spawn with shell-metacharacter text kept inside the JSON message field; env
values never logged.
