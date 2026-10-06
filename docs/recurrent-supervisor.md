# Bounded recurrent supervisor (edition 2)

Contract `bounded-recurrent-supervisor-v1`. Edition 1 (`long-supervisor-first-edition-v1`,
see [long-supervisor.md](long-supervisor.md)) stays exactly as documented: one `bridge_submit`
packet carrying `project` creates ONE real Flash supervisor session, that session declares a
bounded worker plan, and a host-owned deterministic orchestrator schedules, repairs and
aggregates it. **Everything in this document is additive and opt-in twice** — on the host
AND on the packet — and a legacy packet keeps its exact normalized bytes, its SQL
idempotency hash and its single-round behavior.

## 1. Opt-in

Host configuration (`supervisorProjects` in the bridge host config, forwarded by
`dsh-host/index.cjs` into `src/bootstrap.mjs`):

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
    "reserveSlots": 1,
    "maxRounds": 4,
    "pause": true
  }
}
```

- `maxRounds` is the host ceiling, an integer **1..8**, default **1**. `1` is the
  historical plan-once project; `2..8` is the explicit host opt-in to bounded recurrence.
- `pause` (default `false`) gates the control-plane `bridge_pause`/`bridge_resume` API. It
  requires `maxRounds >= 2`; anything else is a configuration refusal.
- Packet side: `project.maxRounds`, integer **1..8**, default **1 when omitted**. An
  explicit request above the host ceiling is refused (`PROJECT_HOST_CAP` /
  `adapter/project-host-cap`), never clamped. **Absent stays absent**: validation never
  injects `maxRounds: 1` into a normalized packet, so an already-persisted legacy project
  submission still matches its stored hash.
- Recurrence needs `maxRounds >= 2` on the packet AND a host ceiling that allows it.
  Pause/resume additionally needs host `pause: true`. No legacy packet gains any of it.

`bridge_capabilities.supervisorProjects` reports the real host state:
`firstEdition.recurrentReasoning`, `recurrence.{enabled,maxRounds,pause,modelPolling,tools}`
and the granted `tools` (the two decision tools appear only on a recurrent host).

## 2. Round lifecycle

1. **Plan round (round 1).** Unchanged: the supervisor declares workers with
   `dsh_supervisor_worker_create`, freezes with `dsh_supervisor_plan_finalize`, and ends its
   turn. The host schedules the workers as real bounded bridge tasks.
2. **Waiting is host-driven.** No model polling: while workers run there is no supervisor
   model round, no busy wait and no extra token spend. The model round ENDED; settlement
   callbacks drive the runtime.
3. **Review round (round 2..N).** Only when the current round and EVERY genuinely owned
   attempt prove a positive stop, and only through the real adapter seam
   `adapter.nextRound(task, hooks)`: the SAME owned session is continued, and BEFORE any
   prompt the adapter re-proves the whole settled picture with the STRICT probes — the live
   agent must be idle (or positively absent) and identical to the guarded agent, both agent
   queue lists (`nextTurn`/`nextStep`) must be readable, and the owned-job AND owned-child
   inspectors must be readable and report zero. A missing, throwing or non-array seam is
   UNKNOWN and refuses locally (`adapter/host-state-unknown`/`adapter/host-not-settled`,
   `dispatched: false`); it is never read as zero. Recurrence itself is the ADMISSION-TIME
   grant: the original normalized packet plus the mounted host policy are re-proven, so a
   legacy project or a host that no longer opts in can never be granted a round by the
   narrowed round envelope. No new session, model route or approval is created. The round
   prompt carries the real aggregate of the wave that just settled (re-derived from the
   settled worker evidence, so a COMPLETED wave is never printed as a still-pending project),
   each worker's persisted state/stop flag and its result digest, plus a BOUNDED excerpt
   (512 chars per worker, at most 16 workers) of the REAL result of that worker's last
   settled attempt, snapshotted from the actual owned task at settlement and printed
   JSON-escaped on one line clearly labelled as untrusted worker data so it can never be
   read as prompt instructions. The full result is still read with
   `dsh_supervisor_worker_result`; no summary is ever invented for the prompt. When the
   round was minted to finish a plan that is still unfrozen (a resumed planning
   checkpoint), the prompt says so and asks for the worker declarations plus
   `dsh_supervisor_plan_finalize` instead of a wave review.
4. **Decision tools (recurrent projects only).**
   - `dsh_supervisor_project_complete {summary?}` **records** the decision. It never
     finalizes early: the host finalizes only after this round AND every owned attempt prove
     their stop, the aggregate is completed and no required worker is unfinished.
   - `dsh_supervisor_project_block {reason}` records an honest blocked decision; the host
     settles a capacity-retaining `blocked` state after the same proof.
   - A review round may also append bounded workers (append-only, same immutable envelope
     and hard caps) or record no decision, which requests one more bounded round.
5. **The first wave never masquerades as the whole goal.** A completed aggregate with no
   complete decision starts another round while rounds remain; at the round cap the project
   fails honestly (`supervisor-rounds-exhausted`), never as a fabricated completion.

## 3. Cumulative hard budgets (counted exactly once)

The project-wide tool ledger has four disjoint terms:

| term | meaning |
| --- | --- |
| `supervisorToolSpend` | observed supervisor round spend, cumulative |
| `supervisorReserved` | the FULL allowance of the round currently in flight |
| `toolSpend` | observed released worker spend (unchanged meaning) |
| worker reservations | each unstopped worker attempt's full granted cap |

`bound = supervisorToolSpend + supervisorReserved + toolSpend + workerReserved` and every
round/worker start is refused when `bound` would exceed `grant.maxTotalToolCalls`. An item
moves from its reserved bucket to its spend bucket exactly once, at its own verified
stop: nothing is double charged and nothing is dropped. A round's spend is a DELTA of the
cumulative store counter (`stats.toolCalls - roundBaselineToolCalls`); unreadable stats
conservatively charge the FULL reserved cap, never zero. Intent and the full reservation
are persisted BEFORE any await or host dispatch, and the new attempt is minted only through a
transactional checked CAS (`TaskStore.beginRound`) that demands the EXACT current
attempt and round, a positive `stopConfirmed: true` with numeric-zero `activeJobs` AND
`activeChildren`, the exactly matching READABLE stopped PREVIOUS round for that same
attempt — a nonblank `attemptId`, a terminal `completed|failed|cancelled` status and its
own explicit true/0/0 proof all read inside the transaction — no pending dispatch and the
legitimately bound pending-round intent persisted before dispatch. An ABSENT previous round
refuses: a genuinely never-dispatched first round is not a continuation and uses the normal
start/resume path instead. Any ambiguity is `ROUND_CONFLICT` and
leaves the identity, checkpoint and project record completely untouched — no stop is invented and
no attempt is minted. A duplicate scheduler, a late resume, a late duplicate reconcile or a
delayed older callback can therefore never start or mutate another round. The adapter's per-round
guard is bound to the round's own narrowed plan (`adapter/round-budget-widened` refuses any
upward movement), so a round cannot overspend the allowance the host actually reserved.

## 4. Durable pause/resume

- `bridge_pause {taskId, requestId, reason?}` persists the request before it returns, blocks
  all NEW admission (no worker attempt, no supervisor round) and lets owned work finish
  naturally. `pausing` is never reported as `paused`. The project becomes `paused` only with
  the full proof: the current round and EVERY genuinely owned attempt positively stopped
  (`stopConfirmed: true`, explicit numeric-zero jobs AND children) with no dispatch pending.
  Idempotent by `requestId`; it is not a cancellation. The service mutates the durable
  checkpoint BEFORE reading the response, so the returned status is the honest post-request
  `pausing`/`paused` state, never the stale pre-request `supervising`.
- **`requestId` binds the task and the operation; `reason` is first-request audit text.**
  A later retry with the same `requestId` (reason omitted or different) returns the ORIGINAL
  outcome with `replay: true` and makes NO new transition: it schedules nothing, spends
  nothing and mints nothing. Pause and resume keep separate namespaces, a pause replay never
  moves the checkpoint or rewrites the first reason, and a resume replay is answered BEFORE
  the terminal and pause-state gates, so a successful resume replays both immediately (when
  the pause state is already `none`) and after the project has completed. Every accepted OR
  refused resume request id is kept in a bounded per-operation history (cap 128). A known id
  always replays its recorded outcome — including a refusal recorded while owned work was
  still live, which is persisted BEFORE the refusal is returned and therefore still refuses
  after the proof arrives. An older id retried after a NEWER control request replays its own
  recorded refusal and can never reopen admission. At capacity an UNKNOWN id is typed-refused
  (`project/request-history-full`) before any mutation or admission; known ids still replay.
  A resume that is accepted and then refused LOCALLY by the adapter updates that request's own
  durable receipt to the real refused outcome, so a later replay returns the refusal.
  Accepted pause ids have their own durable history (cap 128), including requests that
  acknowledge an existing pause. An older pause id cannot pause a newer resumed round;
  known ids replay before terminal checks, and a new id at capacity refuses without mutation.
- **A pause during the planning round is an honest paused planning checkpoint.** The plan
  round is a genuinely owned, positively stopped round with zero owned work; if a pause is
  requested while it is still live, the runtime records the real true/0/0 stop and settles
  `pausing -> paused` instead of fabricating a `plan-not-frozen` failure. Freezing is NOT
  admission: `dsh_supervisor_plan_finalize` may close an already-declared draft while
  admission is held (it never admits or starts a worker and never rewrites the held control
  state), so a draft declared before the pause is never silently lost. An explicit
  `bridge_resume` then continues the SAME project: an already-frozen plan dispatches its
  declared draft, and an unfrozen plan is finished by ONE guarded bounded planning round
  under the same immutable identity, grant and deadline. A first round that was never
  dispatched still uses the normal start path.
- `bridge_resume {taskId, requestId, reason?}` re-reads the real stop, ownership and dispatch
  evidence plus the immutable deadline and the cumulative budget BEFORE any admission, then
  continues the SAME task record: no task copy, no budget reset and no deadline extension.
  Typed refusals keep the checkpoint: `project/resume-unproven`, `project/deadline-exceeded`,
  `project/cancel-requested`, `project/budget-exhausted`, `project/rounds-exhausted`.
  Idempotent by `requestId`. A cancellation request is never undone by a resume: a project the
  controller has already asked to cancel refuses a resume and keeps its checkpoint.
- **An accepted `bridge_resume` is a scheduling INTENT, not a completed resume.** The real
  adapter re-proves ownership on the `nextRound` seam, so a resumed round may still be refused
  locally; the runtime then restores the `paused` checkpoint with a typed
  `control.resume.outcome: 'refused'`. Observers (and the installed-DSH smoke) must wait
  boundedly for EITHER a real terminal completion with positive proof OR that retained
  checkpoint, and must never equate the accepted intent with a successful dispatch.
- **The immutable deadline keeps running through a pause.** The deadline timer stays armed
  (or is re-armed on the same `project.createdAt` anchor), expiry converges on real stop
  proofs into a bounded honest `failed`/`blocked` result without waiting for a resume, and a
  resume after expiry is refused with no added time.
- `pausing`/`paused` are distinct non-terminal states preserved through
  `bridge_check`/`bridge_reconcile` (a stopped root never certifies its workers),
  `bridge_cancel` (a cancel request is not a resume) and `bridge_cleanup`/`bridge_archive`
  (both refuse, because the task is not terminal). Paused work stays active and unsettled for
  collection gates.

## 5. Restart honesty

- Startup reconciliation NEVER auto-resumes a pause checkpoint: it stays `paused` with its
  reservation settled from real proofs and the deadline re-armed on the original anchor.
- A round whose dispatch is not provably stopped is an ambiguous dispatch: the project fails
  closed (`host-restart-round-ambiguous`), the reservation is retained, and nothing is
  replayed. A round that was planned but never minted never crossed the host boundary; its
  reservation is released honestly.
- An explicit `bridge_resume` after a restart re-proves durable ownership and restores the
  guard through the adapter's trusted recovery path. When the installed DSH cannot prove
  that restoration, the resume is refused with a typed local refusal
  (`adapter/recovery-unsafe`/`adapter/host-state-unknown`, `dispatched:false`), the
  checkpoint is retained and no session is adopted, no prompt is replayed and no round is
  duplicated. The smoke reports resumed and refused outcomes as they actually happened; no
  restart success is claimed without real adapter evidence.

## 6. Verification

- Runtime regressions: `test/recurrent-supervisor.test.mjs` (two genuine rounds consuming
  real results with bounded untrusted excerpts and the real numeric child-count proof on
  every owned attempt, no polling while workers are live, exact cumulative accounting,
  unreadable stats charged the reserved cap, late-callback fencing, honest round cap, pause
  proof, idempotent pause/resume, the durable early-refusal replay and the bounded request
  history, deadline/budget refusals, local-refusal retention, the planning-phase pause
  checkpoint with its explicit continuation, restart reconciliation, and the checked
  `beginRound` CAS whose absent/unreadable/mismatched previous round always refuses).
- Adapter/service legs: project cases in `test/dsh-adapter.test.mjs`, `test/mcp.test.mjs`,
  `test/long-task.test.mjs`, `test/ledger-maintenance.test.mjs`.
- Real installed DSH, offline, no paid API: `node scripts/smoke-recurrent.mjs <dsh install dir>`
  (real mount, service, store, adapter and tool lifecycle; recurrence, round cap, cumulative
  budgets, pause/resume and a controller restart).
