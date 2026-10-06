# First runnable long-task supervisor (edition 1)

> Edition 2 (bridge 1.3.0, contract `bounded-recurrent-supervisor-v1`) adds opt-in bounded
> recurrence, the `dsh_supervisor_project_complete` / `dsh_supervisor_project_block`
> decision tools and the durable `bridge_pause` / `bridge_resume` checkpoint. Everything in
> THIS document still applies verbatim to a packet without `project.maxRounds`; see
> [recurrent-supervisor.md](recurrent-supervisor.md).

Contract `long-supervisor-first-edition-v1`. One `bridge_submit` packet that carries
`project` creates ONE real Flash supervisor session. That session declares a complete
bounded worker plan with supervisor-only tools, freezes it once, and ends its model
round. A host-owned deterministic orchestrator then schedules the workers, repairs
ordinary failures inside a fixed cap, aggregates honestly, and emits exactly one bounded
callback through the existing trusted outbox.

Everything here is additive. Packets without `project` behave exactly as before, and a
host that does not opt in refuses `packet.project` with a typed refusal.

## 1. Operator setup

`supervisorProjects` must be enabled in the bridge host configuration
(`dsh-host/index.cjs` config, i.e. the mount config written by the installer):

```json
{
  "supervisorProjects": {
    "enabled": true,
    "maxWorkers": 8,
    "maxConcurrentWorkers": 3,
    "maxRepairAttempts": 1,
    "maxTotalRetries": 8,
    "maxWorkerStarts": 12,
    "maxTotalToolCalls": 1000,
    "projectTimeoutMs": 600000,
    "reserveSlots": 1
  }
}
```

- Defaults are `enabled:false` and the absolute host ceilings (16 workers, 2 repairs,
  64 starts/retries, 15 reserved slots). A packet request above a host cap is refused
  with `PROJECT_HOST_CAP` / `adapter/project-host-cap`, never clamped.
- `reserveSlots` keeps at least that many slots of the shared 16-slot admission ledger
  free so a coordinator task can always be scheduled next to a running project. The
  minimum is **1** in the host config, the packet schema/contracts and the resolved
  grant alike; asking for 0 is refused, never clamped, and reserving more stays safe
  while it remains feasible inside the shared 16 slots.
- The durable callback still needs the operator-started wake controller
  (`bin/wake-controller.mjs`); the bridge only proves enqueue.

## 2. Submitting a project

`project` is an optional advertised property of the `bridge_submit` packet
(`bridge_capabilities.supervisorProjects` reports the effective host policy). The
supervisor session itself stays a bounded read-only planner: `role: "investigate"` (or
`implement`), `scope.writeRoots: []`, no `childSessions`, no `backgroundJobs`, and
`understandingRequired` is refused with `project`.

```json
{
  "schemaVersion": 1,
  "idempotencyKey": "long-project-001",
  "revision": 1,
  "projectId": "my-project",
  "title": "Long project",
  "objective": "What the project as a whole must achieve.",
  "cwd": "E:/repo",
  "role": "investigate",
  "acceptance": ["Observable project outcome."],
  "scope": { "readRoots": ["E:/repo"], "writeRoots": [], "allowedTools": ["read", "glob", "grep"], "allowShell": false, "allowNetwork": false, "allowDelegation": false },
  "materials": [],
  "contractVersion": "long-supervisor-first-edition-v1",
  "rootCallback": { "grantId": "originating-chat" },
  "model": { "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "high" },
  "project": {
    "maxWorkers": 8,
    "maxConcurrentWorkers": 3,
    "maxRepairAttempts": 1,
    "maxTotalRetries": 8,
    "maxWorkerStarts": 12,
    "maxTotalToolCalls": 1000,
    "timeoutMs": 600000,
    "reserveSlots": 1,
    "workerScope": {
      "readRoots": ["E:/repo"],
      "writeRoots": ["E:/repo"],
      "allowedTools": ["read", "write", "edit"],
      "allowNetwork": false,
      "budgets": { "timeoutMs": 600000, "maxToolCalls": 100, "maxOutputChars": 200000 }
    },
    "workspace": { "repository": "E:/repo", "baseRef": "HEAD" }
  }
}
```

Rules enforced before any task, session or worktree exists:

- `scope.writeRoots` must be empty; worker writes live in `project.workerScope`.
- `workerScope.writeRoots` requires `project.workspace`, and with a workspace every
  worker root must stay inside the repository and `cwd` must be inside it too, so a
  per-writer worktree really isolates the declared roots.
- `workerScope.allowedTools` may not name shell, delegation, `run_code`, bridge or
  supervisor tools.

## 3. Supervisor-only tools

Registered into the authorized supervisor's own scoped tool layer only (never visible to
a worker, a child or an ordinary task), and admitted by the `packet.project` grant rather
than by `scope.allowedTools` — naming one of them in `allowedTools` is refused:

| Tool | Purpose |
|---|---|
| `dsh_supervisor_worker_create` | Declare one bounded worker. Idempotent per `workerKey`; refuses roots/tools/network/budget/callback/children/depth widening and any `model` field. Every worker inherits the project's immutable route. |
| `dsh_supervisor_plan_finalize` | Freeze the plan. Required/optional rules are fixed exactly as declared; the plan cannot change afterwards. |
| `dsh_supervisor_worker_list` | Persisted worker states, attempts and stop confirmation. |
| `dsh_supervisor_worker_result` | Bounded result slice of a worker's latest attempt plus workspace evidence. |
| `dsh_supervisor_worker_cancel` | Cancel one worker and report the observed stop; an explicit cancellation is never respawned. |
| `dsh_supervisor_project_status` | Bounded aggregate status, budgets and callback outcome. |

A worker request may set `role`, `tools`, `readRoots`, `writeRoots`, `allowNetwork`,
`budgets`, `required` and `dependsOn`; it may never set a model, callback, thread,
token, child, depth or job field.

## 4. Lifecycle

```
planning → frozen → dispatching → completed | failed | blocked | cancelled
```

1. The supervisor declares workers and calls `dsh_supervisor_plan_finalize`. Ending the
   round without a frozen plan blocks the project (`plan-not-frozen`); no worker runs.
2. The round's positive stop is recorded, the supervisor's own model reservation is
   released, and the task waits in the explicit non-terminal status `supervising`
   (`bridge_check` treats it as active; `bridge_cancel` and `bridge_reconcile` work). The
   project's root slot IS the round's slot: it is held while the round is live or its stop
   is unproven, and released only by strictly proven round stop proof (`stopConfirmed` plus
   an explicit numeric zero for both jobs and children), so a stopped waiting round never
   holds a phantom root slot. A recorded round's stop proof is bound to the EXACT current
   attempt: its `attemptId` must be nonblank and equal to the task's real store-minted
   `attemptId`. A round whose identity is missing or belongs to a superseded attempt is
   unproven, and it never resumes or completes the current attempt. Host recovery applies
   the same rule but additionally requires every unresolved owned attempt to be genuinely
   accounted elsewhere before the round's slot may be released (§5).
3. The orchestrator submits each ready worker as a REAL bounded bridge task with
   `parentTaskId` pointing at the project, its own scope, budget and (for writers) its
   own fresh `WorkspaceManager` worktree. Worker slots come from the same global
   16-slot ledger (`maxConcurrentWorkers`, `reserveSlots` honored).
4. Worker settlements are aggregated. Only verified stopped owned work may complete or
   cleanly fail a project.

The lifecycle is event-driven: the service hooks (`onSupervisorFinished`,
`onTaskSettled`, `requestProjectCancel`, `recoverProject`) and the supervisor tools
drive every transition. Real-service **admission** (`admitProject`, invoked once by
`BridgeService.submit` immediately after the project task is persisted and before any
dispatch) arms the ONE host timer the runtime owns — the per-project admission deadline
described in §5, anchored at the persisted `project.createdAt` — and clamps the
supervisor's EFFECTIVE packet budget to the project grant, so a silent or
capacity-queued planner is bounded before any model tool exists. Only
`task.effectivePacket` narrows: `task.packet` and the stored request hash stay
identical. A live timer owned by THIS process is the only proof a deadline is armed, so
recovery re-arms a persisted active deadline instead of trusting a stale
`deadlines.armed` flag. Timers are cleared on every terminal state and on `close()`, so
no handle leaks.

## 5. Retries, unknown work and stopping

- An ordinary `failed` worker (or a non-controller cancellation such as a budget
  timeout) is repaired at most `maxRepairAttempts` times (≤ 2), counted against the
  project's `maxTotalRetries`/`maxWorkerStarts`/`maxTotalToolCalls`/`timeoutMs`
  budgets and requiring the previous attempt's verified stop. Each cap is checked
  BEFORE an attempt is persisted or submitted, across a whole scheduling pass.
- The shared tool-call cap uses ONE canonical accounting, counted exactly once:
  supervisor-observed calls + each stop-proven attempt's actual spend + each
  unverified/queued attempt's FULL granted allowance. An attempt's allowance is released
  only with its verified stop proof; a missing or unreadable stats receipt is charged its
  full granted cap, never zero, so a released reservation is never recycled as free
  budget. A queued worker is refused only when the spend alone has exhausted the grant or
  a start/retry/time budget is exhausted; allowance merely held by unstopped work makes it
  WAIT, because that work's verified stop can release the unused remainder (the next kick
  funds it). Work the budget cannot fund settles as a clean stopped failure (or honestly
  blocked when a stop is unproven) instead of staying pending; a completion above the
  shared bound is never reported.
- The project deadline is anchored at the persisted `project.createdAt` and armed by real
  admission. Planning, capacity waiting, dispatch and every worker's runtime count
  against it: both a worker packet's and the supervisor's own effective
  `budget.timeoutMs` are clamped to the REMAINING project time at actual dispatch, a late
  start is refused, and expiry cancels the ACTUAL supervisor round through the service
  plus the live workers, then converges from their real stop callbacks (clean `failed`) or
  stays blocked/unknown when a stop is unproven. Timer expiry alone never certifies a
  stop. A missing or non-numeric `activeJobs`/`activeChildren` count is never read as
  zero, and no clean completion/failure/cancellation is recorded unless the supervisor
  round AND every owned attempt carry positive stop proof: an unproven stop retains
  capacity, blocks the project and is never retried.
- A `bridge_submit` failure is resolved by the deterministic attempt key: a proven
  pre-insertion refusal is a clean, non-retryable failure; a task that was inserted before
  the error is linked by its real id, kept `unknown` with its slot and allowance held, and
  never reported as a clean terminal aggregate.
- Every attempt — initial and repair — has a deterministic idempotency key
  (`pw-<sha256(project, worker, attempt)>`) and its own fresh worktree. Failed
  workspaces are preserved, never deleted. An identical
  `dsh_supervisor_worker_create` replay is answered from the frozen plan (the same
  immutable worker, `idempotentReplay: true`), while a changed re-declaration of the same
  `workerKey` conflicts instead of mutating a frozen definition.
- `unknown` dispatch/stop/receipt is a serious issue: the project becomes
  `project.status: "blocked"` with task status `unknown`, `stopConfirmed: false`, the
  owned reservations held, and NO redispatch. `bridge_reconcile` re-evaluates from real
  stop evidence; it never replays the model round.
- Reconciliation CONSUMES real inspector evidence, bound to the exact attempt that was
  current when the inspection began (evidence landing during the await is dropped as
  stale). Only an observation with a terminal status, `stopConfirmed: true` and an
  EXPLICIT numeric zero for BOTH jobs and children proves a stop (`reconcileObserved.proven`).
  A consumed proof releases the project's own root slot ONLY under the central clean proof:
  the round bound to the exact current attempt must be stopped AND every owned attempt must
  be positively stopped. A root observation never certifies a worker stop, so an ambiguous
  or untracked owned dispatch keeps its occupancy until genuine owned proof resolves it.
  A proven observation is written into that attempt's round proof (`source: "reconcile"`)
  and every owned worker is re-evaluated; it never certifies a worker or invents a missing
  count. An unproven or unavailable inspector leaves an old terminal STRING
  (`cancelled`/`failed`/`completed`) as the honest `blocked`/`unknown` record with its
  occupancy retained, while a record that already holds a STRICTLY proven POSITIVE root
  (terminal + `stopConfirmed` + explicit numeric-zero jobs and children, plus a clean
  round/attempt proof) is not revoked. A real positive observation is consumed into the
  exact current attempt's round even when the project still carried an unproven terminal
  string; that terminal is then deterministically re-evaluated (an existing cancellation
  converges through the central proof, a plan resumes without replaying the model round or
  a settled dispatch) instead of being kept as a terminal/false contradiction. A merely
  expected-live planner is ordinary state, not an anomaly.
- The shared child/job counts are never inferred: an explicit `null` observation is
  unknown (the record stays `unknown` with its slot retained), an OMITTED count is
  resolved BEFORE the proof is written from the real owned-child manager, and only the
  legacy host with no child manager at all treats zero children as authoritative; a child
  manager that is configured but whose inspector is MISSING is unknown exactly like one
  that throws, never zero. Every resolution records its bounded provenance
  (`activeChildrenSource`: `host-reported`, `owned-manager`, `owned-manager-unavailable`
  or `legacy-no-child-manager`). The public task view (`bridge_check`, `bridge_cancel`,
  `bridge_list`) reports the stored `activeChildren` only when it is a valid nonnegative
  integer and otherwise `null`: an explicit unknown is never presented as `0`, while an
  authoritative numeric `0` (new records and the legacy no-child-manager path) stays `0`.
  Central round/attempt/root proofs require an explicit numeric zero after that resolution,
  and
  the AGGREGATE `stopConfirmed` is claimed only by strict positive proof; an unproven,
  nonzero or null-count settlement is `unknown` with `stopConfirmed: false`. A terminal
  project cancellation runs through the same central positive-root-and-workers proof as
  failure/completion.
- Reservation bookkeeping is asymmetric on purpose. A task's root slot is released only by
  ITS OWN genuine terminal proof: a `true` stop flag plus an explicit numeric zero for both
  jobs and children. An idle `awaiting_approval` task is ALREADY-DISPATCHED work, so
  cancelling it settles its slot immediately from its persisted `stopConfirmed` and numeric
  counts — exactly once, for its own key; a missing, `null` or nonzero count, an
  unconfirmed stop, a live owned child, or an inspector that cannot answer keeps the slot
  and records an honest `unknown`. Structural zero jobs is valid only for genuinely
  never-dispatched work with no dispatch marker, session or receipt; a duplicate
  cancellation settles nothing a second time.
- Recovery settles the project root on the SAME shared ledger before it accepts or blocks
  anything: a missing or unproven supervisor round ADOPTS the root (idempotent by key, and
  allowed above the configured limit, because unknown work must stay counted) and blocks
  the project without dispatching a worker or a new round — even when a historical status
  says `supervising`. The ledger seam is validated by the methods this settlement needs
  (`adopt`/`release`/`has`), so the real `HostReservationLedger` class instance is used; a
  missing or partial ledger reports `no-ledger`/`ledger-incomplete`. The adopted root is
  bound to the CURRENT task attempt identity, never to a superseded round's label.
- A strictly proven stopped round releases its own model reservation ONLY when every
  unresolved owned attempt is genuinely accounted elsewhere. A store-readable task id is
  NOT ownership: the persisted worker packet must bind `parentTaskId`,
  `metadata.supervisorProject`, `metadata.workerKey` and `metadata.attempt` to this project
  and to the exact owned worker/attempt. A genuinely bound, recoverable live worker counts
  through its OWN `task:<workerTaskId>` ledger entry (adopted idempotently, over-limit
  allowed), so a running worker never forces a phantom root slot. An untracked ambiguous
  dispatch (blank task id in `dispatching`/`running`), an unreadable record, or a readable
  but mismatched/missing binding keeps a stable root placeholder instead: recovery stays
  `blocked`, the task is `unknown` with `stopConfirmed:false`, nothing is dispatched, and
  `bridge_reconcile` neither releases that root nor records a clean terminal on the foreign
  record's stop proof.
- A round that was genuinely never dispatched holds no root at all, and a strictly proven
  stopped waiting round with no unresolved owned work holds none. A later valid
  `bridge_reconcile` proof releases the adopted root through the same proof-checked helper,
  while invalid, stale or unknown evidence preserves it.
  `bridge_capabilities.supervisor.ledger` reports these live counts.
- An exactly exhausted START cap with only already-admitted live work WAITS for that work
  (`project/live-work-settling`); no failure or `serious-issue` callback is emitted while
  merely expected-live work still runs. Genuinely unfunded required work converges by
  stopping the live owned work (or waiting for its verified settlement) and then reporting
  an honest clean failure. Temporary reserved allowance is not spent exhaustion.
- An explicitly cancelled worker stays cancelled. A required cancelled worker fails the
  project only after every owned stop is proven (a clean stopped `failed`); otherwise
  the project stays blocked/unknown.
- Host restart: a project that was not in a verified waiting state — or whose supervisor
  round has no strictly proven stop, or which carries an untracked/unreadable/misbound
  owned attempt — fails closed as blocked with its persisted worker ids and its root slot
  adopted into the shared ledger; nothing is redispatched. Only a project in `supervising`
  with a strictly proven stopped round and fully accounted owned work resumes its
  deterministic worker flow (holding no root slot of its own while its accounted workers
  keep their own entries). Missing round/dispatch fields are never read as
  never-dispatched proof once a session was dispatched.

## 6. Aggregation, artifacts and callback

- A completed project record carries one bounded summary plus per-worker evidence:
  task id, attempt, stop confirmation, a result digest, and for writers the observed
  workspace `head`, `dirty` and `changedPaths`. The base HEAD alone is never presented
  as "the changes"; uncommitted writer output is reported as uncommitted evidence and
  the worktree is kept.
- Worker heads are preserved separately; the orchestrator never merges unrelated
  branches and never marks Codex's review/integration as passed.
- Exactly one callback per outcome class is enqueued through the existing durable
  outbox and the callback binding captured at submission: `completed` (clean
  completion or clean stopped failure) and `serious-issue` (blocked/unknown work). A
  serious-issue callback is independent of clean settlement and never sets
  `stopConfirmed: true`.
- Worker completions never wake the coordinator: worker packets carry no callback
  binding. Repeats are suppressed by the stable event identity
  (`project-<sha256(task, attempt, class, aggregate)>`) and by the recorded
  `project.callbacks`.
- Controller-requested project cancellation does not generate a wake callback.

## 7. Runnable commands

```bash
# unit + integration tests (this file is additive; legacy suites stay unchanged)
node --test test/*.test.mjs

# real installed-DSH offline supervisor smoke (create-3, idempotency, retry,
# cancellation, scope/model refusals, stop gates, one callback per project)
node scripts/smoke-supervisor.mjs <directory containing node_modules/@deepseek-ai/dsh>

# legacy smokes (unchanged)
node scripts/smoke-runtime.mjs <dsh-dir>
node scripts/smoke-autonomy.mjs <dsh-dir>
```

## 8. First-edition limitations (honest)

- **One decision round.** The supervisor declares the complete plan once; there is no
  recurrent reasoning and no model is kept busy while workers run.
- **No automatic merge.** Worker branches are preserved with exact heads; review,
  integration and `bridge_acknowledge` remain Codex steps.
- **No host-crash resumption of running workers.** A restart of a non-waiting project
  is blocked honestly with persisted ids and its root slot retained in the shared ledger
  (released later only by valid reconciliation proof); automatic adoption/resumption of the
  running workers themselves is a later milestone.
- **Optional workers** are only honored when fixed at plan freeze; they are never
  inferred after a failure.
- **Bounded repair** is at most 2 per logical worker and always project-budget-bounded.
- **One host timer.** The project admission deadline is the single timer, armed once by
  real service admission and owned live by the process that armed it; there is no
  heartbeat, no model polling and no recurrent wake-up. Everything else is event-driven
  from real stop proofs. A project that exceeds its deadline stops honestly instead of
  supervising forever.
- **Flash-only.** The project route is fixed at submission and inherited by every
  worker; no Pro or other model is selected implicitly.
- **Delivery is not proven by the bridge.** The outbox acknowledgement is `queued`;
  a live runner and a positive acknowledgement are observed independently.
- Artifact resolution (`merged|preserved|discarded`) and cleanup gates are unchanged and
  remain the coordinator's explicit decision.
