# Maintenance release 1.2.1

Bridge `1.2.1`, adapter unchanged at `0.4.0`. This release is not documentation-only:
it fixes defects in root-reservation accounting, recovery admission and stop-proof
handling, so defect behaviour changes. There is no new edition and no protocol change.
Package identity (`@local/dsh-codex-bridge-v1`), endpoint `/mcp/codex-bridge-v1`,
tasks, workspaces and evidence are unchanged, so no migration is required.

## Cancellation releases its own root slot

- Cancelling an idle queued or awaiting-approval task whose evidence is genuine
  (`stopConfirmed:true` with `activeJobs:0` and `activeChildren:0`) now settles its
  actual `task:<id>` root reservation immediately and exactly once. Before the fix the
  record became terminal while the slot stayed held. A duplicate cancellation settles
  nothing a second time.
- Anything short of genuine proof never releases the slot: a null or nonzero job count,
  a false stop flag, a configured child manager whose inspector is missing or throws, or
  a live owned child all keep it, and the task stays `unknown` with `stopConfirmed:false`.

## Real shared-ledger recovery

- The process-shared `HostReservationLedger` is used through its methods
  (`adopt`/`release`/`has`/`counts`), not a plain-object test, so a recovered unproved
  project root is genuinely adopted into the real shared ledger instead of left uncounted.
- Adoption is idempotent by immutable key, counts exactly once, and may exceed the
  configured limit: unknown or unproved work stays counted even when the ledger is
  saturated (`free` clamps at 0). Recovery dispatches nothing.
- Ledger kinds are `root` (one per admitted task) and `child` (supervisor children).
  No source path reserves a ledger slot for an owned command job.

## Stopped rounds, placeholders and lineage

- A positively stopped round bound to the current attempt (terminal status with explicit
  numeric-zero jobs and children) holds no phantom root slot, and a genuinely
  never-dispatched queued project holds none either.
- A previously dispatched session without proof, an unproved round, a stale round bound
  to a superseded attempt, an untracked ambiguous dispatch (blank task id), an unreadable
  worker record, or a readable task whose persisted lineage does not genuinely bind it to
  this project/worker/attempt all keep a stable root placeholder bound to the real current
  attempt. Recovery fails closed and dispatches nothing.
- A positively stopped round releases its own slot only when every unresolved owned
  attempt is genuinely accounted for: bound live workers count through their own
  `task:<workerTaskId>` entries (adopted idempotently), so there is exactly one slot per
  real worker and never a phantom project root.

## Strict identity and unknown evidence

- Persisted worker lineage (`parentTaskId` plus `supervisorProject`/`workerKey`/`attempt`
  metadata) is verified before its occupancy or stop proof is trusted; a mismatch stays
  unaccounted and never releases, cancels or completes the recovered project.
- A missing or non-numeric `activeJobs`/`activeChildren` is never coerced to zero. A
  configured child manager with a missing or throwing inspector reports `null` with source
  `owned-manager-unavailable`, and the public `bridge_check`/`bridge_cancel`/`bridge_list`
  view keeps `null`, never a fabricated numeric zero.
- Stale round IDs cannot certify the current round: observation evidence is bound to the
  attempt current when inspection began, so a superseded attempt's positive round is
  `round-attempt-unproven`, never a synthetic stop.

## Retained unknown historical tasks

- Historical tasks persisted with status `unknown` are retained and re-examined by
  recovery instead of being treated as clean terminals, redispatched or cleaned up.
- When the host cannot prove a stop, the task/project stays `unknown`/`blocked` with
  `stopConfirmed:false`; its reservation stays counted until an observed genuine stop
  proof releases it. This release does not claim those retained records are resolved.
- Resolve a retained unknown task with `bridge_reconcile` or `bridge_cancel` and require
  the host's own stop confirmation; never infer a stop from the request.

## Limitations

- This release adds no edition-2 capability. The long-task supervisor remains edition 1
  (plan-once, no automatic merge, no resume of running workers after a host restart).
- No tool can convert an unproven stop into a clean terminal. If the host never reports a
  confirmed stop, the honest outcome remains `unknown`/`blocked`.
- Default retention stays 7 days after success and 30 days after failure; retained
  unknown tasks are not removed by the default retention policy.
