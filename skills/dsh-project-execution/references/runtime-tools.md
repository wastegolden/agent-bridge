# Bridge runtime tools

Call `bridge_capabilities` and `bridge_models` first. The deployment is
authoritative: if a capability is not reported, do not plan around it and do not
report it as enforced.

## Internal preflight and tool availability

Tool *support* and tool *availability* are different facts:

- **support** — the adapter classifies the tool and can enforce a fence for it
  (`enforceableTools`). Classification support is not proof the host exposes it, and
  it is decided statically from the packet, so it says nothing about the worker agent.
- **availability** — the host tool registry was actually probed (`availableTools`).
  On the current host the agentless probe is scoped to the global view only, and a
  global-view result — an empty array included — is **not** a complete all-agent
  catalog: preset/agent-plane contributions are deliberately outside that scope, so
  the array can be empty while an agent-bound session still exposes read/write tools.
  Never present a global-view array as proof the worker agent can see a tool either
  way. Actual availability is resolved only from the target agent's own schemas;
  `sessionVisibilityPending: true` records that this check has not happened yet.

Preflight is an **internal adapter seam**, not a caller tool: there is no
`bridge_preflight` MCP tool. `bridge_submit` calls `adapter.preflight(packet)`
internally after packet validation and model resolution, before `store.submit` or
workspace creation. The coordinator observes preflight only as a typed refusal from
`bridge_submit`, or as the `preflight` evidence persisted on the created task record.
Before a session exists, `adapter.preflight(packet)` returns:

```json
{
  "ok": true,
  "requestedTools": ["read", "glob", "grep"],
  "enforceableTools": ["read", "glob", "grep", "write", "edit"],
  "availableTools": null,
  "availabilityVerified": false,
  "sessionVisibilityPending": true
}
```

This is the current host's real answer, not a placeholder: the static checks
succeeded while the agentless probe could not establish an all-agent catalog. That
separation is deliberate, not a host limitation waiting to be lifted: there is no
complete global API, so no global schema set — empty or nonempty — supports
`availabilityVerified: true`, and the implementation intentionally refuses every
agentless availability claim. Static success therefore answers only the static
question; actual tool availability remains unknown.

- Preflight reuses the same packet validation and plan enforcement as `start`; it
  creates no session, runs no tool, sends no prompt and mutates no registry.
- `ok: true` answers the static and enforceability question only. `availableTools:
  null` with `availabilityVerified: false` means actual tool availability is
  **unverified**, not refused: the preflight result is still successful and the
  submission is not invalidated by the unknown. Never report the unknown as a
  preflight failure, and never upgrade it into a verified catalog.
- When the probe is unverified, a requested name cannot be pre-checked, so actual
  availability is decided by the **start step**, which reads the target agent's own
  schemas before any prompt is dispatched. A requested tool missing there is refused
  (`adapter/scope-unsupported`) even though the earlier preflight passed — and that
  refusal can arrive after the owned session (and its worktree) already exist, which
  the adapter records as an orphan. "Preflight passed" therefore never means "the
  tools are available".
- A tool this adapter cannot bound (unclassified, e.g. `apply_patch`) is refused with
  the existing unsupported-boundary error before any task, session or worktree is
  created. That is a static refusal and does not depend on the probe. Do not work
  around it.
- `capabilities().toolContract` reports the same distinction:
  `{enforceableTools, availableTools, availabilityVerified, deniedTools,
  sessionVisibilityPending:true}`. `deniedTools` records unsupported tools and
  reasons. Network and job tools keep their existing additional permission and
  ownership gates.
- A refused preflight creates no task, session or worktree, and a thrown preflight
  error creates none either. Existing accepted idempotent submissions stay reusable
  without redispatch, and effective worktree paths are revalidated before dispatch.
- An older adapter without `preflight` stays compatible but is recorded as
  `{supported:false,reason:'adapter-preflight-unavailable'}`, never as `ok:true`.

## Task lifecycle

| Tool | Use it for | Notes |
|---|---|---|
| `bridge_capabilities` | What this host enforces | Scope enforcement, wait limits, cancellation, cleanup, workspace support |
| `bridge_models` | Provider/model/effort catalog | Route only to advertised models; unknown routes are rejected |
| `bridge_submit` | Submit one task or retry the same packet | Requires packet.schemaVersion integer 1 and cwd inside readRoots; use the complete example in task-packets-and-gates.md |
| `bridge_check` | Bounded wait / poll | Returns current state and new output; prefer polling over one long call |
| `bridge_result` | Final reply and artifacts | Read the result before treating a task as done |
| `bridge_approve` | Answer an understanding gate | Approve only after reading understanding, assumptions, actions, missing |
| `bridge_cancel` | Request stop | A request is not a confirmation |
| `bridge_reconcile` | Reconcile unknown execution against host evidence | Never replays the task; unconfirmed work keeps its concurrency slot |
| `bridge_list` | Enumerate owned tasks | Scope the listing to this bridge; never enumerate unrelated user sessions |
| `bridge_acknowledge` | Mark a result collected | Required before cleanup considers a task reclaimable; records `artifactState` `none|merged|preserved|discarded|unresolved` |
| `bridge_clarify` | Send text-only clarification into the same task and session | Requires the exact revision and understanding hash while awaiting approval; an identical replay returns `clarificationReplay:true` and starts no second attempt |
| `bridge_archive` | Hide an eligible owned session in the UI | Separate from retention cleanup; never deletes the workspace or evidence |
| `bridge_cleanup` | Release owned tasks/workspaces | Fails closed unless every ownership and stop condition holds |
| `bridge_workspace_review` | Bind pass/fail to an exact commit | Include the head, contract version and the checks actually run |
| `bridge_workspace_refresh` | Rebase a finished workspace onto an exact target head | Invalidates the old review; conflicts are preserved for the controller |
| `bridge_workspace_integrate` | Move a verified head into a target | Refuses dirty trees, head drift and failed reviews |

## Bounded waits

- Prefer `bridge_check` with an explicit wait ceiling over holding a call open;
  long tasks are polled.
- A poll that returns "still running" is information, not failure. Do not
  resubmit the task to make it feel faster; that duplicates work.
- Keep the caller's own timeout larger than the individual wait ceiling
  (at most 60 seconds). A task budget can span many such calls.

## Idempotency and identity

- Reuse the idempotency key only for the same logical attempt; a new revision or a
  new objective needs a new key.
- Track task id, revision and attempt id together. A result belongs to an attempt;
  mixing attempts is how stale output gets integrated.
- Treat unknown ids as unknown: report them. Do not adopt a session by guessing.

## Cancellation and stop confirmation

`bridge_cancel` asks the host to stop a turn. Confirm the stop before cleanup:
a cancel request alone is not evidence that work stopped, and "no output" is not
proof of termination. If the host cannot confirm the stop, the task stays in the
owned set and the cleanup gate refuses.

## Same-session clarification

When a task sits at the understanding gate and clarification would help, extend the
existing session instead of starting a second one:

```json
{
  "taskId": "t-20260925-docs-1",
  "revision": 1,
  "understandingHash": "3f2c9a...e91",
  "clarificationId": "clarify-scope-001",
  "text": "Clarify: the acceptance list also requires a checks-object example; keep the same scope."
}
```

- `revision` is a positive safe integer, `understandingHash` is nonblank,
  `clarificationId` is nonblank and at most 200 characters, and `text` is nonblank and
  at most 20000 characters.
- Text only: clarification may explain the already authorized task. It cannot change
  paths, materials, scope, model, route, budget or acceptance.
- Eligible only while the task is `awaiting_approval` with `stopConfirmed === true`,
  `activeJobs === 0`, a nonblank `sessionId`, a persisted dispatch receipt and no
  pending dispatch, and a supported `adapter.reconsider`.
- The original packet, revision, request hash, SQL idempotency hash and workspace are
  preserved; a fresh attempt is minted and the previous understanding hash is
  invalidated. The clarification understanding is dispatched only through
  `adapter.reconsider(task, hooks)` with `mode:'understanding'`, never
  `adapter.start`/`continue`; later execution uses the normal continue path and the
  clarification marker clears at approval.
- It returns the current task view and is synchronous apart from normal queued
  dispatch; an identical replay adds `clarificationReplay: true`.
- An identical replay (same `clarificationId`, same content) returns the same task
  with `clarificationReplay: true`, without another attempt, even if the task has
  advanced since. The same id with different content is `CLARIFICATION_CONFLICT`.
- Other refusals: `SESSION_NOT_READY` (the host has not confirmed stop/idle) and
  `CLARIFICATION_UNSUPPORTED` (the adapter lacks `reconsider`). Never open a second
  session to work around one of these.
- A new understanding hash binds `{revision, understandingGeneration, attemptId, text}`
  once the generation is above 0; generation 0 keeps the legacy digest of the text.
  Identical model text in a later generation never revives the old approval, and
  approval still requires the exact current hash.

## Acknowledge, UI archive and retention

These are three different things; do not collapse them:

| Action | Tool | Effect |
|---|---|---|
| Collect the result | `bridge_acknowledge` `{taskId,revision,accepted,artifactState,pinned?}` | Sets `resultCollected` and `accepted`; `artifactState` is `none|merged|preserved|discarded|unresolved`; required before cleanup |
| Hide the session | `bridge_archive` `{taskId,revision}` | Sets `sessionArchivedAt` so the session leaves the default listing; workspace, evidence and the retention clock are preserved |
| Physical cleanup | `bridge_cleanup` `{taskId,dryRun?,now?,policy?}` | Applies the retention policy; legacy `archivedAt` remains the physical-cleanup marker |

- Order matters: collect the result with `bridge_acknowledge` and confirm the
  host-reported stop with zero active jobs **first**; `bridge_archive` is optional and
  runs after that confirmation, never before it, and never substitutes for a cleanup
  gate.
- Archive requires a bridge-owned exact revision, a terminal state
  (`completed|failed|cancelled`, never unknown), `resultCollected === true`,
  `stopConfirmed === true`, `activeJobs === 0`, a resolved `artifactState` (with a
  workspace: `merged|preserved|discarded`; without one: those or `none`) and no
  pending dispatch. The busy exclusion is shared with cleanup, so a conflict is
  `CLEANUP_BUSY`.
- Success returns
  `{taskId,revision,archived:true,uiHidden:true,sessionArchivedAt,workspacePreserved:true,evidencePreserved:true}`.
  A missing host API returns `{archived:false,supported:false}`, and a host exception
  returns `{archived:false,outcome:'unknown',retryable:true}`; neither sets an archive
  timestamp or a false-success marker.
- Default retention is **7 days after success, 30 days after failure**. Hiding a
  session does not start, reset or extend that clock: a repeated archive keeps the
  original `sessionArchivedAt`.
- The default `bridge_list` hides sessions carrying either marker; `includeArchived`
  includes both. An eligible hidden task can still be cleaned by explicit `taskId`.
  Pinned evidence may be hidden but stays protected from physical cleanup.
- `adapter.archive(task)` calls only `workspaceRegistry.archiveSession(sessionId)`.
  It never calls cleanup, deletes a worktree or session persistence, releases guards,
  kills jobs, sets `cleanedUp` or modifies `endedAt`. Cleanup may archive the same
  session again later, harmlessly.

## Checks objects

Every check passed to `bridge_workspace_review` or `bridge_workspace_integrate`
(`checks`, and integration's optional `baselineChecks`) is an object — never a shell
string:

```json
{
  "checks": [
    {"command": "node", "args": ["--test", "test/upgrade-contract.test.mjs"], "timeoutMs": 300000}
  ]
}
```

- The array holds at most 64 items.
- `command` is required, nonblank, at most 4096 characters and contains no newline.
- `args`, when present, is an array of strings of at most 8192 characters each with no
  NUL character.
- `timeoutMs`, when present, is an integer from 1 to 600000.
- The runtime's own limits are authoritative: do not invent stricter check or result
  pagination limits, and do not assume `additionalProperties` is forbidden where the
  runtime accepts other keys.

`bridge_workspace_integrate` runs `baselineChecks` against the old target before the
merge, then `checks` on the source and the merged target. A failing target-side check
means the work is not accepted.

## Failure surfaces

- Packet-validation rejection (`INVALID_PACKET`, or `INVALID_SCOPE` before a
  task is created): correct the named field using the published schema and
  packet example. Keep the original authorization. These rejections are not
  connection failures; a rejected key can be retried after correction.
- Unsupported-boundary refusal (`adapter/scope-unsupported`, e.g. an unclassified
  tool such as `apply_patch`): a deliberate typed rejection from the internal preflight
  that `bridge_submit` runs before a task exists, so it creates no task, session or
  worktree. Correct the request inside the existing authorization — narrow the tools,
  choose a supported way to run the check — and retry. This is a static refusal, not a
  host outage and not a probe result.
- Missing actual agent visibility raises the **same** `adapter/scope-unsupported`
  error from a **different stage**: the start step reads the target agent's own
  schemas before any prompt is dispatched, and a requested name missing there is
  refused. Unlike the static refusal above, that refusal can arrive after the owned
  session and its worktree already exist (recorded as an orphan). A global-view probe
  array — empty included — never proves an agent lacks a tool, so never claim global
  availability absence; only the target agent's schemas decide the request.
- `GIT_IDENTITY_UNAVAILABLE` is a **different operation stage**: it is raised by
  `bridge_workspace_refresh` on an **existing owned task and workspace**, before the
  rebase, when `git var GIT_AUTHOR_IDENT` or `git var GIT_COMMITTER_IDENT` cannot be
  read in that workspace. Do not list it with submit-time preflight refusals and do not
  assume no task exists. The task, workspace, evidence and already-collected results
  are retained, the prior review has already been invalidated by the refresh, no git
  config is mutated and no identity value is echoed. Resolve the identity condition for
  that workspace on the host, then retry the refresh — never delete the task, discard
  the workspace, or paper over the failure by submitting a replacement task.
- Never advise a caller or worker to add `apply_patch` or a raw shell string to get
  around a refusal; allowed tools come from the packet and host enforcement.
- Unknown task/session: report as unknown; do not fabricate state.
- Scope refusal: the request exceeded the packet scope. Re-plan with a narrower or
  explicitly authorized task; never work around the refusal.
- Budget exhaustion: the bridge requests cancellation. Confirm stopping before
  deciding whether the next step is a new bounded task; an unconfirmed stop can
  remain cancelling or unknown.
- Transport/timeouts: retry only idempotent reads (`bridge_check`, `bridge_result`,
  `bridge_list`, `bridge_models`, `bridge_capabilities`). A timeout during a
  mutating call, or any unknown execution outcome, means inspect task state first,
  then decide — a typed preflight refusal and a host outage are different conditions
  with different responses.

## Evidence rules

Task state comes from the bridge; artifacts come from the filesystem; both are
checked directly. A model's assertion that a file changed, a test passed, or a
commit exists is a claim to verify — read the path, run the check, or read the
commit. Prefer exact hashes and commit ids in reports so a later reader can
re-check without rerunning the whole task.
