# Parallel worktrees, exact-commit review and integration

## Parallel isolation

Give each concurrently executed task its own isolated workspace:

- one writer per workspace; independent tasks get independent worktrees;
- a shared read-only base is fine, a shared writable tree is not;
- include the `workspace` block (`repository`, `baseRef`, optional `branchName`)
  in the packet so the runtime creates the workspace instead of the worker
  improvising one;
- keep dependency order explicit with `dependencies` rather than hoping timing
  works out.

Parallelism is bounded by review capacity. More concurrent writers than the
planner can actually review produces unreviewed code, which is worse than a
longer serial run.

## Review an exact commit

A review record is bound to a commit, not to a branch or a moment in time:

- capture the workspace HEAD before review and pass that exact value to
  `bridge_workspace_review` together with `contractVersion` and the checks run;
- the reviewed head is the unit of approval; new commits invalidate it;
- a review must state pass/fail plus the checks that produced it, with their
  actual output — not a summary of intent;
- if the reviewer cannot reproduce a check, that is a failed review, not a
  documentation problem.

Checks are objects, not shell strings: up to 64 items of
`{"command":"node","args":["--test","test/x.test.mjs"],"timeoutMs":300000}`, where
`command` is required (nonblank, at most 4096 characters, no newline) and `args`
(strings of at most 8192 characters each, no NUL) and `timeoutMs` (integer 1..600000)
are optional. The runtime's own limits are authoritative. Integration runs the
optional `baselineChecks` against the old target before the merge, then `checks` on
the source and the merged target.

Reviewer independence matters: use a separate task (and preferably a separate
worktree) from the author. The author's own claim is a claim, not evidence.

## Integration

`bridge_workspace_integrate` is the only sanctioned path from a worker's branch
into a target:

- refuse a dirty source or target: uncommitted work must be committed or
  discarded deliberately;
- the reviewed head and the contract version must still match;
- if the target is no longer at the reviewed base, the source must be rebased and
  re-reviewed — a mismatch means integration stops, not that it proceeds anyway;
- a failed review, or a failing target-side check, means not accepted;
- the result must report the exact integrated head and the checks that ran.

Integration is a merge of verified work, not a merge conflict resolution session.
If integration reveals a conflict that needs judgment, return to planning with a
new bounded task.

## Refresh, review invalidation and Git identity

`bridge_workspace_refresh` rebases a finished workspace onto an exact target head:

- the prior `review` is invalidated **before** the refresh runs, after the task and
  target gates pass, so a refresh that throws cannot leave a stale approval behind;
- when a refresh genuinely needs a rebase, the runtime first runs
  `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` in the owned
  workspace with the same git/env wrapper. If either fails it stops with
  `GIT_IDENTITY_UNAVAILABLE` before rebasing — no config is mutated and no identity
  value is echoed. A no-op or adopt-only refresh needs no identity. This is a
  refresh-stage condition on an **existing** owned task, not a submit-time preflight
  refusal: the task, workspace, evidence and already-collected results are retained,
  the prior review has already been invalidated, and the coordinator fixes the identity
  condition for that workspace and retries the refresh instead of replacing the task;
- a nonzero rebase is classified from the actual result: unmerged index paths are
  `conflict:true` with `reason:'rebase_conflict'`; other failures are `conflict:false`
  with `reason:'rebase_failed'`. A timeout or OS error keeps its existing thrown code
  and never fabricates a content conflict;
- `rebaseInProgress` and the existing output evidence are preserved. Never auto-abort,
  reset or hide a partially applied rebase — resolve or report it. Ownership, exact
  target/HEAD, clean-state and ancestor fences stay in force.

A successful refresh returns the same task path, branch and repository with the updated
`baseCommit`, plus `adopted: true` when no rebase was needed. That return continues the
same task; there is no public adopt-existing API, so a **new** task — for example a
repair — always gets a new worktree (see [repair-loop.md](repair-loop.md)).

## Merged, preserved, discarded

Every workspace ends in a declared artifact state:

- `merged` — the reviewed head is in the target;
- `preserved` — the work still matters but is not integrated; keep the workspace
  and say where it is;
- `discarded` — the work is abandoned; discard only after the result has been
  collected and the decision recorded.

`bridge_acknowledge` records the same field as
`none|merged|preserved|discarded|unresolved`; `unresolved` is the honest value while
the artifact state is not decided, and it blocks cleanup.

Never delete a workspace that is dirty or holds uncollected changes, and never
delete outside the runtime's own workspace root.

## UI archive is not retention cleanup

`bridge_archive` `{taskId,revision}` hides a settled session in the UI. It is a
separate lifecycle step from physical retention cleanup:

- it requires a bridge-owned exact revision, a terminal
  `completed|failed|cancelled` state, `resultCollected === true`, `stopConfirmed === true`,
  `activeJobs === 0`, a resolved artifact state and no pending dispatch. It shares a
  task-level busy exclusion with cleanup, so a concurrent operation is `CLEANUP_BUSY`;
- archive is the **last** lifecycle step: collect the result and confirm the
  host-reported stop with zero active jobs first, then archive if a hidden session is
  wanted. Archive is never a cleanup gate and never a substitute for one;
- success sets `sessionArchivedAt` and returns
  `{taskId,revision,archived:true,uiHidden:true,sessionArchivedAt,workspacePreserved:true,evidencePreserved:true}`.
  A missing host API is `{archived:false,supported:false}`; a host exception is
  `{archived:false,outcome:'unknown',retryable:true}` and never a false success;
- it calls only `archiveSession(sessionId)`: never cleanup, never worktree or session
  deletion, never a guard release, job kill, `cleanedUp` or `endedAt`;
- default retention stays **7 days after success / 30 days after failure**. Hiding
  does not start, reset or extend that clock, and a repeated archive keeps the original
  `sessionArchivedAt`. Legacy `archivedAt` remains the physical-cleanup marker. The
  default `bridge_list` hides sessions carrying either marker; `includeArchived`
  includes both; an eligible hidden task can still be cleaned by explicit `taskId`;
  pinned evidence may be hidden but stays protected from physical cleanup.

## Cleanup gates

Release an owned task or workspace only when all of the following hold:

- the task was created by this bridge (`origin` is bridge-owned) and has reached a
  terminal state (`completed`, `failed`, `cancelled`);
- the result has been collected (`resultCollected`);
- the stop is confirmed by the host, not inferred from a cancel request;
- no jobs are still active for the task;
- the artifact state is resolved (`merged`, `preserved`, `discarded`, or none);
- the task is not pinned.

If any condition is unknown or unconfirmed, cleanup refuses and reports why.
Unknown, in-flight, or malformed tasks fail closed. A UI archive is not one of these
conditions and does not substitute for any of them: a hidden session still has to
satisfy every gate before physical cleanup. Never adopt or clean up an
arbitrary user session, and never clean up a task whose ownership you cannot
establish — leave it and report it.
