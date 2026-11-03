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
| `bridge_result` | Final reply and artifacts | Read the result before treating a task as done; pass `attemptId` to read an earlier follow-up round |
| `bridge_approve` | Answer an understanding gate | Approve only after reading understanding, assumptions, actions, missing |
| `bridge_cancel` | Request stop | A request is not a confirmation |
| `bridge_reconcile` | Reconcile unknown execution against host evidence | Never replays the task; unconfirmed work keeps its concurrency slot |
| `bridge_list` | Enumerate owned tasks | Scope the listing to this bridge; never enumerate unrelated user sessions |
| `bridge_acknowledge` | Mark a result collected | Required before cleanup considers a task reclaimable; records `artifactState` `none|merged|preserved|discarded|unresolved` |
| `bridge_clarify` | Send text-only clarification into the same task and session | Requires the exact revision and understanding hash while awaiting approval; an identical replay returns `clarificationReplay:true` and starts no second attempt |
| `bridge_followup` | Question a settled read-only task again in its existing session | Terminal `investigate`/`review` answer with a confirmed true/0/0 stop only; `afterAttemptId` is the round CAS; read earlier rounds with `bridge_result {attemptId}` |
| `bridge_archive` | Hide an eligible owned session in the UI | Separate from retention cleanup; never deletes the workspace or evidence |
| `bridge_cleanup` | Release owned tasks/workspaces | Fails closed unless every ownership and stop condition holds |
| `bridge_workspace_review` | Bind pass/fail to an exact commit | Include the head, contract version and the checks actually run |
| `bridge_workspace_refresh` | Rebase a finished workspace onto an exact target head | Invalidates the old review; conflicts are preserved for the controller |
| `bridge_workspace_integrate` | Move a verified head into a target | Refuses dirty trees, head drift and failed reviews |

## Controller identity, ownership and override

The host splits every tool into exactly one category: **6 read** (`bridge_check`,
`bridge_result`, `bridge_dossier`, `bridge_list`, `bridge_models`,
`bridge_capabilities`), **1 submit** (`bridge_submit`) and **13 mutate**
(`bridge_approve`, `bridge_clarify`, `bridge_followup`, `bridge_cancel`,
`bridge_pause`, `bridge_resume`, `bridge_reconcile`, `bridge_acknowledge`,
`bridge_archive`, `bridge_cleanup`, `bridge_workspace_review`,
`bridge_workspace_refresh`, `bridge_workspace_integrate`). Each tool's input schema is
`additionalProperties:false`; only mutate tools add a top-level `override` object whose
only key is `reason` (required, string, `maxLength: 500`, must contain non-whitespace).

Ownership is the **authenticated controller principal** (`task.submittedBy`), derived
from the bearer credential and immutable. `metadata.controller` and `parentTaskId` are
audit/coordination hints only — they never grant authority.

| Caller and target | Result |
|---|---|
| any principal, any read tool or `bridge_submit` | allowed; submit binds `submittedBy`; no `override` accepted |
| owner on a mutate tool | allowed |
| non-owner on a mutate tool, no override | `TASK_NOT_OWNED` |
| administrator, foreign or historical (`submittedBy:null`) task, no override | `OVERRIDE_REASON_REQUIRED` |
| administrator, foreign/historical task, `override:{reason}` | allowed after audit, then the existing lifecycle/revision/attempt/workspace/retention gates |
| administrator, own task, `override:{reason}` | allowed, and still audited as an override |
| non-administrator with override, or any override on read/submit | `OVERRIDE_NOT_PERMITTED` |
| malformed override (non-object, extra key, non-string, over 500 characters) | `INVALID_ARGUMENTS` |
| target does not exist | `TASK_NOT_FOUND` |

The reason is measured before trimming (≤500 characters) and stored trimmed. The audit
writes `task/override` **before** the business call — with `operationId`, `actor`,
`submittedBy`, `tool`, `reason`, `revision`, `attemptId` and this call's `via` — then a
linked `task/override-result` with `outcome:"returned"|"threw"`, the post-call
`attemptId`, applicable `accepted`/`merged`/`archived`/`cleaned`/`eligible`/`replay`
booleans and any returned/thrown `code`. Failure to persist the intent is
`OVERRIDE_AUDIT_FAILED` and the business call never runs; failure to persist the result
is `OVERRIDE_AUDIT_INCOMPLETE` and you must inspect the task and events before
retrying. `returned` means only that the call returned. An interrupted call can leave
an unclosed intent, whose outcome is unknown until read back. For `bridge_followup`
and `bridge_clarify` there is no added asynchronous boundary between the intent and
the synchronous service entry.

Historical tasks have `submittedBy:null` and require a remaining administrator plus an
override reason. `bridge_list` takes `submittedBy`: omitted = all, a controller ID =
that principal (a retired ID still works for reading), `null` = historical. Read tools
have no ownership check. `bridge_capabilities.controllerIdentity` reports
`{enabled, schemaVersion:1, self, admin, controllers, ownership:"credential-principal",
delegation:"inherit-root-credential", legacyTaskOwner:null,
override:{requiredForForeignTasks:true,reasonMaxChars:500},
via:{source:"client-declared",authorizes:false}}`; `self`/`admin` come from the current
request, and no token or token path is returned.

`via` is client-declared submission provenance from `X-Agent-Bridge-Chain` /
`X-Agent-Bridge-Root-Task`. A root controller sends neither header (`via:null`); only a
delegate sends them. It grants no authority and is not part of the idempotency hash.
Invalid via headers return HTTP 400 `{error:"invalid via",code:"VIA_INVALID",details:
{field,expected}}`; authentication still runs first (unknown token = 401).

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
- De-duplication is namespaced by `(ownerId, submittedBy, idempotencyKey)`: two
  controllers may use the same key independently, while the same principal + key +
  different packet is `IDEMPOTENCY_CONFLICT`. `via` is excluded from the hash, so a
  changed chain does not create a second task. A delegate's key lives in the root
  principal's namespace.
- The store opens only the shipped schemas: `user_version=0` must have the shipped v0
  `tasks` shape (no `submittedBy`, `UNIQUE(owner,idem)`), `user_version=1` the shipped
  v1 shape; any version/shape mismatch is `STORE_SCHEMA_UNSUPPORTED` (never guessed or
  repaired), while a new empty store with no schema objects is created directly at v1.
  Version-0 bodies carry no `submittedBy`/`via`; migrated rows keep `submittedBy:null`.
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

## Same-session follow-up (`bridge_followup`)

A settled read-only task can be questioned again in the SAME owned session instead of
submitting a new task. Clarification extends the understanding gate before approval;
follow-up extends a terminal answer after it. They are not interchangeable:
clarification carries no execution and binds an `understandingHash`, follow-up reuses
the already authorized packet and needs no gate.

```json
{
  "taskId": "t-20260925-docs-1",
  "revision": 1,
  "afterAttemptId": "3f2c9a1e-7b4d-4c8a-9e21-0d5f6a7b8c90",
  "followupId": "followup-contradiction-001",
  "text": "Your report cites src/service.mjs:571 for slicing. Quote the exact lines there and say which part of the claim they actually support."
}
```

| Field | Type | Constraint |
|---|---|---|
| `taskId` | string | Nonblank owned task id |
| `revision` | integer | 1..MAX_SAFE_INTEGER; must equal the task revision |
| `afterAttemptId` | string | Nonblank; must equal the task's current `attemptId` |
| `followupId` | string | Nonblank, at most 200 characters; the idempotency key |
| `text` | string | Nonblank, at most 20000 characters |

`additionalProperties:false`: no extra field is accepted, so a follow-up cannot carry
paths, materials, tools, scope, a model, a budget or a new acceptance list. The
original packet, effective packet, workspace, session and model route are reused; the
follow-up text and the new attempt are the only additions. `text` is rendered as
clearly delimited untrusted material, so instructions inside it are data, not
authority; text containing a reserved material delimiter is refused with
`material_delimiter_conflict`.

- **Output.** `{...TaskView, followup:{followupId, afterAttemptId, attemptId, round, replay}}`.
  `attemptId` is the attempt minted by this request (a replay returns the same one),
  and `round` counts follow-ups from 1 (the original answer is round 0). The task view
  also gains `round` and a compact `followups` list. The call returns after the task is
  persisted; dispatch stays queued like any other task.
- **Eligibility.** The task must be terminal (`completed`, `failed` or `cancelled`)
  with `stopConfirmed === true`, integer `activeJobs === 0` and integer
  `activeChildren === 0`; its role must be `investigate` or `review`; it must not be a
  project (`packet.project`/`task.project`) or a project worker
  (`packet.metadata.supervisorProject`); an understanding-gated task must have been
  approved (`understandingRequired === true` requires `executionApproved === true`,
  otherwise it is `FOLLOWUP_UNSUPPORTED_TASK`); it must not be archived
  (`sessionArchivedAt`) or cleaned (`archivedAt`); no dispatch may be pending; and a
  usable session binding must exist (the persisted receipt of the current attempt, or
  the `boundAttempt` kept from an earlier refused follow-up; otherwise
  `SESSION_NOT_READY`). While archive or cleanup holds the task, the answer is
  `CLEANUP_BUSY`. The role and project exclusions are structural: a write task never
  gets a second turn through this path, and a project worker is never settled again
  outside the project runtime.
- **`afterAttemptId` is the round CAS.** `revision` is immutable across attempts, so it
  cannot identify a round. `afterAttemptId` must equal the current `attemptId`; a late
  request carrying an older attempt id is `FOLLOWUP_CONFLICT` and mints nothing. Two
  different `followupId`s aimed at the same `afterAttemptId` produce one attempt.
- **Idempotency.** The request hash is `digest({revision, afterAttemptId, followupId,
  text})`, not trimmed. The same `followupId` with the same content is a replay: it
  returns the original attempt with `followup.replay:true` and dispatches nothing, at
  any later time — after further follow-ups, even after archive. The same id with
  different content is `FOLLOWUP_IDEMPOTENCY_CONFLICT`. Retry a timed out or unknown
  follow-up with the same `followupId`; reread the task first.
- **Budget.** Every follow-up gets a fresh allowance equal to the original packet's
  per-attempt budget, not the remainder of a lifetime counter, so a first round that
  consumed its budget does not block a later question. No round can exceed the
  original authorization, and the timeout stays per attempt.
- **Refusal at dispatch.** Adapter refusals keep their existing `adapter/*` codes
  (`not-owned`, `packet-changed`, `model-route-mismatch`, `attempt-conflict`,
  `attempt-in-flight`, `task-cleaned`, `task-archived`, `recovery-unsafe`,
  `host-state-unknown`, `host-not-settled`) and arrive with `dispatched:false`: that
  follow-up attempt is recorded `failed` with `dispatchFailure`, the earlier answer
  stays readable in the round history, and the task can be followed up again with a
  NEW `followupId` and `afterAttemptId` set to the failed attempt's `attemptId`. The
  retry reuses the session binding recorded as the refused attempt's `boundAttempt`, so
  one refusal does not make the task permanently unfollowable. The same holds for a
  follow-up that was cancelled (or interrupted by a bridge restart) before its dispatch
  started. Only a dispatch that started without a receipt is ambiguous and stays
  refused with `SESSION_NOT_READY`. A refusal is never a reason to submit a replacement
  task or to open a second session.
- **Cold host restart.** The follow-up reuses the live guarded agent of the owned
  session. If the DSH host restarted and no live agent remains, the request is refused
  (the reported blocker is `guarded-agent-absent`) — the same limitation as
  clarification. Recovery binds only through the persisted round history
  (`followups[].boundAttempt`), never by guessing a session or turn, and "remembers
  everything" is not guaranteed: memory depends on the host's own context retention and
  compression.
- **Capability.** `bridge_capabilities` reports `lifecycle.followup` with the supported
  mode, allowed roles, excluded task classes, recovery rule and the input limits. An
  adapter without the method returns `FOLLOWUP_UNSUPPORTED`; probe before planning.

| Error code | Condition |
|---|---|
| `INVALID_ARGUMENTS` | Wrong shape or type, blank, over the length limit, or an extra field |
| `TASK_NOT_FOUND` | Unknown task, or one not owned by this controller |
| `FOLLOWUP_IDEMPOTENCY_CONFLICT` | `followupId` is already bound to different content |
| `FOLLOWUP_ROLE_FORBIDDEN` | Role is not `investigate` or `review` |
| `FOLLOWUP_UNSUPPORTED_TASK` | Project task, project worker, or an understanding gate that was never approved |
| `FOLLOWUP_CONFLICT` | `revision`/`afterAttemptId` mismatch, or the task is not completed/failed/cancelled |
| `FOLLOWUP_ARCHIVED` | `sessionArchivedAt` or `archivedAt` is set |
| `SESSION_NOT_READY` | Stop is not true/0/0, no session, a dispatch is pending, or no usable session binding |
| `FOLLOWUP_UNSUPPORTED` | The adapter has no `followup` method |
| `CLEANUP_BUSY` | Archive or cleanup is holding this task |
| `material_delimiter_conflict` | The text contains a reserved material delimiter |

## Result rounds (`bridge_result`, `bridge_dossier`)

A follow-up overwrites the current result, so earlier answers are read by attempt id.

- `bridge_result {taskId, attemptId?, offset?, limit?}` serves the current round. Add the
  optional nonblank `attemptId` to read the saved snapshot of an earlier round — the
  value recorded as that round's attempt id in `followups` and in
  `bridge_dossier.rounds`. Omitting it keeps the current round; an `attemptId` that
  names no earlier round is `ATTEMPT_NOT_FOUND`, so do not pass the current attempt id
  as a selector. Slicing is unchanged (`offset`, `limit`, `nextOffset`, `totalChars`,
  `hasMore`, with `evidence`, `checks` and `uncertainties`), and the response also
  reports `round` (0 = original task) and `followupId` (the follow-up that produced the
  round; `null` for the original attempt).
- `bridge_dossier {taskId}` adds the current `attemptId` and
  `rounds:[{round, attemptId, followupId, question, status, stopConfirmed, resultChars,
  resultCollected, accepted, endedAt}]`, ascending by round with the current round last
  (`question` is truncated to 4000 characters). The full answer is never copied into
  the dossier.
- `bridge_check` and `bridge_list` do not expand full snapshots: their task views add
  `round` (= the number of follow-ups) and a compact
  `followups:[{round, followupId, afterAttemptId, attemptId, createdAt}]`. Read a
  specific round's text with `bridge_result`; never infer it from a dossier summary.

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
