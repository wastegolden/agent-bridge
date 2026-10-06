# Long-task supervisor, first edition (Flash-only)

Reference for `docs/long-supervisor.md`, contract `long-supervisor-first-edition-v1`.
This page is the operator/coordinator checklist; the product details live in the doc.

## When to use it

Use `packet.project` when the work is one project whose pieces are independent bounded
tasks and the coordinator should not have to babysit each child: several parallel
implementations in separate worktrees, one project that survives a single coordinator
turn, or a batch where only the aggregate outcome should wake the controller.

Do not use it for one bounded change (use a normal `bridge_submit`), or when the plan cannot
be stated up front. For work that genuinely needs **bounded recurrent review** of real
worker results, opt into edition 2 (`project.maxRounds` 2..8 plus a host
`supervisorProjects.maxRounds` ceiling) — see
[docs/recurrent-supervisor.md](../../../docs/recurrent-supervisor.md).

## Setup the operator owns

- `supervisorProjects.enabled: true` in the bridge host config (default `false` keeps
  every legacy path byte-identical and refuses `packet.project` with
  `PROJECT_UNSUPPORTED`).
- Caps: `maxWorkers`, `maxConcurrentWorkers`, `maxRepairAttempts` (≤2),
  `maxTotalRetries`, `maxWorkerStarts`, `maxTotalToolCalls`, `projectTimeoutMs`,
  `reserveSlots` (minimum **1**, enforced in config, packet schema/contracts and the
  grant: it keeps at least one shared-ledger slot for a coordinator next to a running
  project; reserving more is safe while it stays feasible inside the shared 16 slots).
- The trusted callback path exactly as for a direct root task: `rootCallback.grantId`
  in the packet, the grant and `eventWake` producer in the host config, and the
  operator-started wake controller for actual delivery.

## Coordinator checklist

1. `bridge_capabilities` → `supervisorProjects.enabled === true`, read `tools`,
   `firstEdition` and `reserveSlots`. `bridge_models` → the Flash route id.
2. Submit ONE project packet with `project.workerScope` (the only surface a worker may
   request), `project.workspace` when anything writes, and `rootCallback`.
3. Poll `bridge_check`. The project task is `supervising` between rounds — that is
   active, not settled; `project.status` carries the real phase.
4. Inspect `task.project.workers[*]`: state, attempts, `stopConfirmed`, `inspect`
   (`head`/`dirty`/`changedPaths`) and the per-worker `taskId`. Read a worker's result
   through `bridge_result` on its task id (or let the supervisor read it).
5. On `completed`, review each writer's exact head, then integrate through the normal
   `bridge_workspace_review` → `bridge_workspace_integrate` path. On `blocked`/`unknown`,
   investigate: an unverified stop is never capacity that was freed.
6. `bridge_acknowledge` each worker task (and the project task) before cleanup; artifact
   state for a preserved project is `preserved`. Cleanup keeps the standard gates.

## Budgets and retries

- Retries: at most `maxRepairAttempts` per logical worker, and only after a verified
  stop. Every attempt gets a fresh worktree; the failed one is preserved.
- Project budgets are real gates: `maxWorkerStarts`, `maxTotalRetries`,
  `maxTotalToolCalls` and `timeoutMs` stop further dispatch and turn the project into an
  honest failure/block. Tool-call allowance is RESERVED before each submit and released
  only with a verified stop, so parallel or queued attempts never share the same
  remaining calls; the supervisor round's own calls count against the same cap, and the
  canonical bound counts supervisor spend + released actuals + each unverified attempt's
  full allowance exactly once. Unreadable receipts are charged their full cap, and
  allowance temporarily held by unstopped work makes a queued worker WAIT rather than fail.
- The project deadline is armed by real service ADMISSION from `project.createdAt`,
  covers planning and capacity waiting, clamps the supervisor's and each worker's runtime
  to the remaining project time, and cancels the actual supervisor round plus live workers
  at expiry, converging on their real stop callbacks. A missing or non-numeric
  `activeJobs` / `activeChildren` count is never zero, and no clean terminal is recorded
  without round AND owned-work stop proof: the stop is unproven, capacity is retained and
  no retry or clean terminal is fabricated.
- An identical `dsh_supervisor_worker_create` replay after plan freeze reuses the frozen
  worker; a changed definition for the same `workerKey` is a conflict.
- Cancelling a project that still owns unverified work leaves it `unknown`/blocked with
  its reservations, never a fabricated clean cancellation.
- An explicit `bridge_cancel` of a worker stays cancelled and is never repaired; a
  required one fails the project once all owned stops are proven.

## Callbacks

- Exactly one `completed` event per clean project outcome and one `serious-issue` event
  per blocked/unverified outcome, both through the existing durable outbox and the
  submission-time binding. Bounded summary (≤ 2000 characters by default).
- Worker completions never wake the controller; a controller-requested project cancel
  does not wake either. A Claude Code controller consumes the same per-target outbox
  with `bin/wake-claude.mjs` (`--wait`, `--follow`, then an explicit `--ack <eventId>`),
  while a Codex controller uses `bin/wake-controller.mjs`.
- An enqueue acknowledgement is `queued`, never `delivered`.

## Evidence-first cleanup

- A project's aggregate result is a claim surface, not execution evidence: check the
  worker tasks, their persisted `stopConfirmed`, their worktrees and the artifact bytes.
- Dirty writer worktrees are reported with their changed paths; keep them until the work
  is integrated or deliberately discarded.
- Blocked/`unknown` projects hold their owned reservations; never clean up, archive or
  delete around an unproven stop.

## Edition-1 limitations

One supervisor round; no recurrent reasoning; no automatic merge; no resumption of
running workers after a host restart (fail closed with persisted ids); optional workers
only when fixed at freeze; repairs ≤2; Flash-only route inheritance; delivery still
requires the operator-started wake controller.

## Edition 2 (bounded recurrence + pause/resume, double opt-in)

Adds, without changing any edition-1 rule above:

- `project.maxRounds` (1..8, absent = 1) plus host `supervisorProjects.maxRounds` (1..8,
  default 1). Over-cap is refused, never clamped; an absent packet field is never injected
  into the normalized packet, so legacy project submissions stay idempotent.
- Review rounds on the SAME owned session via `adapter.nextRound`: the host waits for every
  owned stop, then re-proves the ADMISSION-TIME recurrent grant plus the strict settled picture
  (idle/absent and identical guarded agent, readable queue lists, readable owned-job and
  owned-child inspectors reporting zero) BEFORE any prompt. A missing/throwing/non-array probe
  is unknown and refuses locally (`dispatched: false`), and a legacy project can never be
  newly granted recurrence by the narrowed envelope. Then the model reads real results
  (`dsh_supervisor_worker_result`) and records `dsh_supervisor_project_complete` or
  `dsh_supervisor_project_block` (granted only on a recurrent project). No model polling: the
  round ends and settlement callbacks drive the next step. The round cap fails honestly
  (`supervisor-rounds-exhausted`).
- Cumulative budgets counted once per term; each round's allowance is reserved before
  dispatch and released only by its own verified stop (`adapter/round-budget-widened`
  refuses any upward movement). The next attempt is minted only by a transactional checked
  CAS (`TaskStore.beginRound`) demanding the exact current attempt/round, an explicit
  true/0/0 stop, the exactly matching READABLE stopped previous round for that attempt
  (nonblank `attemptId`, terminal status, its own true/0/0 proof; an absent previous round
  refuses because a never-dispatched first round is not a continuation), no pending dispatch
  and the bound pending-round intent; any ambiguity is `ROUND_CONFLICT` with identity and
  checkpoint untouched.
- The round prompt carries each worker's real state/stop flag and result digest plus a
  bounded (512 chars per worker, up to 16 workers) JSON-escaped excerpt of the REAL settled
  result, labelled untrusted worker data; the full result stays available through
  `dsh_supervisor_worker_result`.
- `bridge_pause` / `bridge_resume`, idempotent by `requestId` (which binds the task and the
  operation; `reason` is first-request audit text, so a later same-id retry returns the
  original outcome with `replay: true` and makes no new transition), requiring host
  `pause: true` and `maxRounds >= 2`: `pausing` is never reported as `paused`; the project
  becomes `paused` only when the current round and every owned worker prove true/0/0 with
  no pending dispatch; the reported status is the post-mutation state, never stale; the
  immutable deadline keeps running through the pause and a resume never extends it;
  unknown/expired/exhausted/cancel-requested checkpoints are refused and retained, and an
  early unproven refusal is persisted BEFORE it is returned so the same `requestId` still
  replays the refusal after the proof arrives. A bounded per-request history (cap 128) keeps
  every accepted/refused id: an older id can never reopen admission after a newer request,
  and an unknown id at capacity is typed-refused. A pause during the live plan round retains
  an honest paused planning checkpoint (finalizing an already-declared draft while admission
  is held admits nothing), and an explicit resume dispatches a frozen draft or finishes an
  unfrozen plan with one guarded bounded round. A host restart never auto-resumes, and an
  unprovable post-restart guard is an honest typed refusal with the checkpoint kept. An
  accepted resume is a scheduling intent: the real adapter may still refuse the round locally
  and restore the paused checkpoint with a typed refusal, updating that request's own receipt.
