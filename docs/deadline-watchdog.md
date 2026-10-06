# One-shot deadline watchdog (opt-in)

The bridge carrier can arm a small, independently timed watchdog for a **root** task that
was submitted with a trusted callback grant. It exists to make a genuinely stuck or
unconfirmed root visible once, without ever guessing that work stopped.

It is **off by default**. With no `DSH_BRIDGE_WATCHDOG_CONFIG` in the MCP environment the
carrier behaves exactly as before and no watchdog code runs.

## What it is not

* It is **not** the project hard deadline. `project.grant.timeoutMs` is enforced by the
  long-task runtime, which stops work and may cancel owned tasks. The watchdog performs
  **one** state read after the deadline has already passed and changes nothing.
* It never cancels a task, releases a model slot, replays a dispatch, changes scope,
  model, budget or configuration, polls a model, or sends anything externally.
* It does not deliver messages. The existing accepted wake-controller delivers whatever
  is in the outbox; the watchdog only ever enqueues **at most one** event.
* `enqueued` is not `delivered`. A receipt records the outbox state it observed.

## Enable it

1. Write an operator-owned JSON config file somewhere local and absolute, for example
   `F:/DSH/data/codex-bridge-v1/watchdog.json`:

   ```json
   {
     "enabled": true,
     "targetId": "<the originating Codex chat id>",
     "callerThreadId": "<the same id>",
     "stateRoot": "F:/DSH/data/codex-bridge-v1/wake",
     "receiptRoot": "F:/DSH/data/codex-bridge-v1/watchdog-receipts",
     "endpoint": "http://127.0.0.1:3080/mcp/codex-bridge-v1",
     "credentialFile": "F:/DSH/data/codex-bridge-v1/bridge-token",
     "graceMs": 2000,
     "checkTimeoutMs": 70000
   }
   ```

   Only those nine keys are accepted. Every path must be absolute and local — UNC/remote
   paths (`\\server\share`, `//server/share`, `\\?\...`) are refused on every platform —
   and `endpoint` must be loopback HTTP(S). `callerThreadId` must equal `targetId`, and both
   must equal the real `CODEX_THREAD_ID` of the carrier process — a fallback identity is
   refused rather than forged. The `DSH_BRIDGE_WATCHDOG_CONFIG` value itself must also be
   an absolute local path; a relative or UNC/remote config path is refused before any read.

2. Point the carrier at it, in the MCP server environment:

   ```json
   {"mcpServers": {"dsh_project": {"command": "node", "args": ["./bin/bridge.mjs"],
     "env": {"DSH_BRIDGE_WATCHDOG_CONFIG": "F:/DSH/data/codex-bridge-v1/watchdog.json"}}}}
   ```

`stateRoot` is the same operator state root already used by the event-wake outbox: the
watchdog resolves the target directory with the existing
`resolveTargetOutboxDir({stateRoot, targetId})` helper and reuses the accepted outbox
component, which creates its own `target.json` binding marker when the producer needs it.
The watchdog never invents or overwrites a binding marker, and it never writes outside
that directory and `receiptRoot`.

## When a timer is armed

Exactly one finite sidecar process is spawned for one exact ROOT attempt when **all** of
these hold:

* the reply is a successful `bridge_submit` tool result (not a refusal, an error, a
  notification or a non-submit call). The REAL host wire is decoded once from
  `result.structuredContent` (or the JSON text in `result.content`) — never
  `result.task`, never `taskId`;
* the decoded view carries an exact `id` **and** `attemptId`, and no `parentTaskId` and no
  children: a worker/child attempt is never armed;
* the host-returned callback binding target equals the configured target;
* an exact deadline exists: `createdAt + project.grant.timeoutMs` for a project root, or
  `createdAt + ` the EXPLICIT `budget.timeoutMs` of the successfully validated request for
  an ordinary root (its accepted view exposes no packet), `+ graceMs`. With neither grant
  nor explicit budget, arming is refused rather than guessed. For a project that opted
  into bounded recurrence the PROJECT anchor (`project.createdAt`, prepared before
  `TaskStore.submit`) is the deadline anchor, and it is what the carrier passes to the
  sidecar; the outer task `createdAt` is retained only as part of the bound identity.

Otherwise nothing is armed, and the upstream MCP reply is completely unaffected. A
duplicate or ambiguous arm is a refusal, never a second timer: the arm receipt is created
with an exclusive `wx` create before the sidecar starts, and a replay leaves the FIRST
receipt and its live owner completely untouched (it is never rewritten to `ambiguous`).

## Legitimate bounded-recurrent lineage (opt-in, strict)

A bounded recurrent project legitimately finishes at a later attempt than the one armed at
submission, so a check reply for a changed `attemptId` would otherwise look like a
mismatch. To keep that honest without relaxing identity for ordinary tasks:

* arming a project whose real grant says `recurrent: true` durably binds, IN the receipt,
  the project id, the immutable project anchor, the outer task anchor, the armed first
  attempt, the granted callback target, the recurrent grant (timeout/maxRounds/pause) and
  the recomputed project deadline. An ordinary or legacy arm binds nothing and keeps its
  exact previous receipt bytes and semantics;
* a check reply whose attempt differs is reinterpreted as the project's CURRENT attempt
  ONLY when that binding exists and every part of the proof is present and readable: same
  project id/anchor/grant, the same recomputed project deadline, the same granted callback
  target, a positive root stop (terminal, confirmed, true/0/0), the ARMED first attempt
  present in the round lineage as an exact stopped round, the observed attempt as the
  EXACT last round at the recorded `roundsUsed`, and a positive true/0/0 stop for EVERY
  owned worker attempt — a missing or non-numeric child count is unknown and refuses;
  this includes older worker attempts and every intermediate round. Round indexes must
  be contiguous, attempt ids unique, the count within the original maxRounds grant,
  and the outer task anchor and pause grant unchanged; pending dispatch refuses;
* a legitimate stopped `completed`/`cancelled` project is then quiet (`positive-stop`); a
  legitimate `failed` project reuses its existing aggregate callback under the CURRENT
  attempt id, and with no callback enqueues exactly ONE `needs-input` for the current
  attempt;
* an absent binding, or missing/broken/mismatched lineage, counts, target, grant or
  deadline stays an anomaly: the armed attempt is never reinterpreted, no stop is inferred
  and the ordinary one-event behaviour applies.

The internal rejection reasons (`no-project-binding`, `project-mismatch`,
`project-anchor-mismatch`, `grant-timeout-mismatch`, `project-deadline-mismatch`,
`callback-target-mismatch`, `root-not-positively-stopped`, `no-round-lineage`,
`original-attempt-not-in-lineage`, `original-round-not-stopped`, `current-round-mismatch`,
`current-round-index-mismatch`, `current-round-not-stopped`, `workers-unreadable`,
`owned-work-unproven`, `owned-child-count-unknown`) are decision inputs only; a rejected
lineage is recorded on the receipt under the ordinary `check-identity-mismatch` anomaly,
never as a positive stop.

## Process lifetime and crash policy

The sidecar is detached (`detached: true`, `windowsHide: true`, `stdio: 'ignore'`,
`unref()`), so it survives the carrier exiting and can never write into the MCP stdout
stream. It re-reads the same config file, verifies its own receipt is still `armed` for
that exact task **and** attempt, waits until the deadline, then performs one check.

If the carrier or sidecar dies before the deadline, the receipt is left `armed` or
`checking`. A later identical replay sees the existing receipt and does **not** adopt,
re-arm or silently continue it; a restart does not resurrect the timer. That is a
deliberate fail-closed choice: an unfinished receipt is ambiguous, and inventing a
continuation could double-check or double-report. The task keeps its ordinary callback
path, and `bridge_reconcile` remains available to consume real inspector evidence.

The ONE check is fenced by an exclusive claim marker (`<receipt>.claim`, `wx` create)
taken before the state leaves `armed`, so two processes that both read `armed` cannot both
check. A marker left behind by a crash is **never** reclaimed automatically: the attempt
stays unambiguous only when the original owner finishes it.

The sidecar re-reads the same config file and refuses without a check when the re-read
`targetId` no longer equals the receipt's PINNED `targetId`: the destination is immutable
for the lifetime of the attempt, and the outbox/event always use the pinned target.

## What happens at expiry

One authenticated loopback `bridge_check` is performed for that exact task.

| Observed state | Outcome | Effect |
| --- | --- | --- |
| terminal, `stopConfirmed === true`, numeric `activeJobs === 0` **and** numeric `activeChildren === 0`, `completed` or `cancelled` | `positive-stop` | Quiet. No event is enqueued. |
| the same, but `failed` | `unresolved` (`failed-without-callback`) | A failed task is NEVER quiet. Any same-attempt record already in the target outbox is reused (`existing-callback`); otherwise exactly ONE `needs-input` event is enqueued. |
| any record already in the target outbox for the same task **and** attempt (pending, delivered, unknown, …) | `existing-callback` | Preserved and never resent; its state (including ambiguity) is recorded on the receipt. |
| a reply for a DIFFERENT `id`/`attemptId` that is NOT a proven bounded-recurrent lineage, running / queued / unknown / unconfirmed / unreachable / refused | `unresolved` or `unavailable` | At most ONE stable bounded `needs-input` event is enqueued into the accepted target outbox (`check-identity-mismatch` records the mismatch; the event is always for the pinned task+attempt). |
| a LEGITIMATE bounded-recurrent lineage (see above) whose current attempt is a positive `completed`/`cancelled` stop | `positive-stop` | Quiet. No event is enqueued. |
| the same, but the current project is `failed` | `existing-callback`, else `unresolved` | The current aggregate callback is reused under the CURRENT attempt id; with none, exactly ONE `needs-input` is enqueued for the current attempt. |
| the outbox cannot be listed, cannot be created, or enqueue fails | `unavailable` | FAIL CLOSED: a missing event is not "proven" when the outbox cannot be read, so nothing is enqueued and bounded unavailable evidence is recorded. |

A missing, `null` or non-numeric job or child count is **unknown**, never a zero. Only
explicit numeric zeros prove a stop. An unsupported huge wait (beyond the finite timer
range) and a non-finite/overflowing deadline are refused, never handed to a timer.

## Receipts and diagnostics

Receipts live under `receiptRoot` with a file name that is the SHA-256 of the exact
`(taskId, attemptId)` tuple, so identifiers are data and never path components. They hold
only bounded, secret-free fields: identity, state, deadline, the counts observed, the
outbox state, a bounded reason/error code, and — ONLY for a bounded-recurrent project —
the bounded `project` binding described above. An ordinary or legacy arm stores no
`project` key at all, so its receipt bytes are exactly what they were before this binding
existed. A credential is read from `credentialFile` inside the controller only, and is
never printed, logged or stored.

Diagnostics go to stderr as one bounded JSON line per event, and contain only phases,
codes, field names and counts — never a path value, token or message body. Configuration
and receipts are never exposed to workers.

## Failure states

| State | Meaning |
| --- | --- |
| `armed` | The receipt exists; the sidecar is expected to check at the deadline. |
| `checking` | The one check has begun (the check counter was incremented). |
| `resolved` | A positive stop was recorded, or an existing callback was reused. |
| `enqueued` | One needs-input event was accepted by the outbox. `eventState` records its state. |
| `unavailable` | The bridge or the outbox could not be reached; nothing was sent. |
| `ambiguous` | An unfinished or duplicate receipt was found and was NOT re-armed or adopted. |
| `refused` | The sidecar bound to a receipt that is not `armed` for this exact attempt. |

## Bounded reason strings

Receipts/refusals use only these bounded, secret-free codes:

| Code | Meaning |
| --- | --- |
| `duplicate-arm` | An arm receipt already existed; the first receipt and owner were preserved. |
| `check-claim-held` | The exclusive claim marker existed; this process refused without checking. |
| `receipt-identity-mismatch` / `receipt-target-mismatch` | The receipt belongs to another task/attempt or another pinned target; refused without rewriting it. |
| `quiet-positive-stop` | A clean `completed`/`cancelled` stop was recorded quietly. |
| `existing-callback:<state>` | An existing same-attempt outbox record was reused, with its state. |
| `failed-without-callback` | A `failed` stop with no existing callback enqueued exactly one `needs-input`. |
| `check-identity-mismatch` | The check reply was for another `id`/`attemptId`; it was never used as this attempt's evidence. |
| `state-unconfirmed` | A running/queued/unconfirmed state enqueued one `needs-input`. |
| `check-unreachable` / `WATCHDOG_OUTBOX_LOOKUP_UNSUPPORTED` / `WATCHDOG_OUTBOX_READ_FAILED` / `enqueue-failed` | Unavailable evidence; nothing is claimed delivered. |
| `unsupported-wait` / `timeout-out-of-range` / `deadline-overflow` / `deadline-out-of-range` | Non-finite, overflowing or over-long deadlines/waits are refused. |
| `no-project-grant-or-explicit-budget` | Neither a project grant nor an explicit validated request budget could anchor a deadline. |
| `not-a-root-task` | A worker/child attempt (parent marker or children) is never watched. |

## Related files

* `src/watchdog-config.mjs` — strict config/binding validation and the arming plan.
* `src/watchdog-receipts.mjs` — the durable exclusive-create receipt.
* `src/watchdog.mjs` — the one-check controller and the strict stop-count rule.
* `bin/watchdog-sidecar.mjs` — the fixed one-shot package executable.
* `src/bridge-carrier.mjs` — the carrier and its optional, off-critical-path hook.
