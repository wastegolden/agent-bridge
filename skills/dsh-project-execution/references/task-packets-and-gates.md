# Task packets, scope and gates

## What a packet must carry

Every `bridge_submit` call is a bounded contract. Provide at least:

- `schemaVersion: 1` — required integer. This is the task packet protocol version,
  not the plugin version. Do not omit it or send the string `"1"` / `"1.0"`.
- `idempotencyKey` (nonblank, ≤200) and a positive integer `revision` — resubmitting
  the same key/revision must not create a second attempt.
- identity and intent: `projectId`, `title`, `objective`, `role`
  (`investigate|implement|review|integrate`), `contractVersion`.
- `cwd`: an absolute existing directory covered by at least one `scope.readRoots`
  entry (equal to that root or a descendant). Do not invent paths. A project
  parent above two permitted source directories is not covered by those roots.
- `acceptance`: a nonempty list of observable, checkable outcomes.
- `scope`: `readRoots`, `writeRoots`, `allowedTools`, `allowShell`, `allowNetwork`,
  and `allowDelegation: false`. Ask for the narrowest scope that can finish the task.
- `materials`: the minimum files or text the worker needs, each as `{path?, text?,
  version?, sha256?}`. Prefer paths plus a hash over inlined copies; hash what you
  inline so the worker can tell whether it has the version you intended.
- `budget` (recommended, optional): `timeoutMs`, `maxToolCalls`, `maxOutputChars`. Defaults are 600000 ms,
  100 calls and 200000 chars. Treat budgets as *requested* constraints: report them
  as requested, never as hard-enforced, unless the host's `bridge_capabilities`
  says the runtime enforces them.

Optional but often decisive: `parentTaskId`, `dependencies`, `model`, `workspace`
(`repository`, `baseRef`, `branchName?`), `retention`, `metadata`, and
`understandingRequired`.

The `workspace` block names the **main repository** the runtime creates the worktree
from and the commit it starts at: `repository` is that main repository — never another
task's worktree path — and `baseRef` is the starting commit. Express `cwd`, scope roots
and material paths against that repository; the runtime creates the worktree and remaps
them into it. There is no public adopt-existing workspace API, so every new task gets
its own worktree: see [repair-loop.md](repair-loop.md) for a repair that starts a new
worktree at the failed candidate commit.

## Complete read-only example

This is the full `bridge_submit` argument object. Replace the illustrative
`E:/your-project/src` with an existing authorized source directory, and choose a
key for this logical task. All scope roots must be absolute. `materials: []` is
valid when the bounded objective is sufficient; relative material paths, when
used, are resolved from `cwd` and must remain within `readRoots`.

```json
{
  "packet": {
    "schemaVersion": 1,
    "idempotencyKey": "source-interface-review-001",
    "revision": 1,
    "projectId": "your-project",
    "title": "Read-only interface review",
    "objective": "Read source files under the permitted root and report existing interfaces with file and line evidence. Do not implement or run commands.",
    "role": "investigate",
    "contractVersion": "1",
    "cwd": "E:/your-project/src",
    "acceptance": ["Report source evidence and explicit unknowns; perform no writes."],
    "scope": {
      "readRoots": ["E:/your-project/src"],
      "writeRoots": [],
      "allowedTools": ["read", "glob", "grep"],
      "allowShell": false,
      "allowNetwork": false,
      "allowDelegation": false
    },
    "materials": [],
    "budget": {"timeoutMs": 120000, "maxToolCalls": 12, "maxOutputChars": 8000},
    "understandingRequired": false
  }
}
```

Omitting `model` selects the advertised Flash default. An explicit model must
match `bridge_models`; never substitute a route silently.

For two authorized roots such as `E:/your-project/band/src` and
`E:/your-project/android/src`, select the first (or an existing child) as `cwd`
and retain both `readRoots`. Refer to files in the other root by absolute path.
If one task cannot be expressed within those roots, split it. Changing the cwd
does not grant additional reads, writes or tools.

## Tool preflight before a session

Tool availability is checked before the runtime creates a session. Preflight is an
**internal adapter seam invoked by `bridge_submit`**, not a caller tool: there is no
`bridge_preflight` MCP tool and nothing for the coordinator to call. `bridge_submit`
runs `adapter.preflight(packet)` internally after packet validation and model
resolution, before `store.submit` or workspace creation. The coordinator observes it
only as a typed refusal from `bridge_submit`, or as the `preflight` evidence persisted
on the created task record.

- `adapter.preflight(packet)` reuses the same packet validation and plan enforcement
  as `start` and reports
  `{ok,requestedTools,enforceableTools,availableTools,availabilityVerified,sessionVisibilityPending}`.
  It creates no session, runs no tool, sends no prompt and mutates no registry.
- `enforceableTools` describes what the adapter can classify and fence; `availableTools`
  reflects the probed host catalog. A verified catalog is not proof the worker agent
  can see the tool — `sessionVisibilityPending: true` means that check still has to
  happen before the prompt.
- A requested tool absent from a verified catalog fails with `adapter/tool-unavailable`.
  An unclassified tool such as `apply_patch` fails with the unsupported-boundary error.
  A refused preflight creates no task, session or worktree; fix the request inside the
  same authorization and retry.
- Older adapters without `preflight` stay compatible but are never recorded as a
  successful preflight (`{supported:false,reason:'adapter-preflight-unavailable'}`).
  Existing accepted idempotent submissions remain reusable without redispatch, and
  effective worktree paths are revalidated before dispatch.

Plan with tools the host actually exposes. [runtime-tools.md](runtime-tools.md) has
the preflight shape and the capability report.

## Scope discipline

- `readRoots`/`writeRoots` are the whole permission surface. A worker that believes
  it needs another root returns that as a finding; it does not widen its own scope.
- One writer per writable root. Two tasks that must write the same tree are one
  task or two sequential tasks, not two parallel ones.
- `metadata` is for coordination hints only, never for authority.

## Context bounds

Send the smallest context that makes the task decidable, and say what is out of
scope. Oversized context is a correctness risk as well as a cost: it hides the
signal the worker needs. When a task depends on a large artifact, prefer giving a
path plus SHA256 and let the worker read it under `readRoots`.

Never place credentials, tokens, or unrelated session history in a packet. If a
worker would need a secret, the right answer is a different task design.

## Acceptance quality

Acceptance criteria are the review contract. Write them so a reviewer can answer
yes/no from evidence:

- Name the observable: files, exports, commands, exit codes, hashes, counts.
- Prefer "test X fails before and passes after" over "tests pass".
- Forbid vacuous evidence explicitly when it matters: assertions that cannot fail,
  snapshots of generated wording, self-reported success without command output.
- Separate first-pass results from repair results; a repaired run is a new result,
  not proof the original was correct.

State the checks that decide acceptance as objects, never as shell strings. Review and
integration accept a `checks` array (integration also an optional `baselineChecks`) of
at most 64 items, each like
`{"command":"node","args":["--test","test/x.test.mjs"],"timeoutMs":300000}`. `command`
is required, nonblank, at most 4096 characters and newline-free; `args` is an optional
array of strings of at most 8192 characters each with no NUL; `timeoutMs` is an
integer 1..600000. The runtime's own limits are authoritative — do not invent stricter
ones. [runtime-tools.md](runtime-tools.md) carries the complete checks example.

## The understanding gate

Use the understanding gate when being wrong is expensive: destructive or
irreversible actions, ambiguous requirements, work over code the planner cannot
cheaply review, or anything whose failure mode is silent.

Procedure: submit with `understandingRequired: true`, then read back the returned
understanding, assumptions, planned actions and missing information. Approve only
if the assumptions match yours and the missing information is genuinely
non-blocking; otherwise answer the gap, narrow the scope, or cancel. Do not treat
approval as a formality — the gate exists so that misunderstanding is caught
before mutation, not after it.

Cheap, reversible, well-specified work does not need a gate; gating everything
spends the budget that risky work needs.

## Clarification: extend the gate, do not re-plan

When the gate is open and what is missing is one bounded explanation rather than a
different task, use `bridge_clarify` in the same task and session:

```json
{
  "taskId": "t-20260925-docs-1",
  "revision": 1,
  "understandingHash": "3f2c9a...e91",
  "clarificationId": "clarify-scope-001",
  "text": "Clarify: also include a complete checks-object example in the packet reference."
}
```

- The exact `taskId`, `revision` and `understandingHash` are required, and the hash
  must bind the understanding currently awaiting approval.
- Text only: clarification explains the already authorized task and cannot change
  paths, materials, scope, model, route, budget or acceptance.
- Eligible only while `awaiting_approval` with a confirmed stop, zero active jobs, a
  nonblank session, a persisted dispatch receipt and no pending dispatch.
- Identical replay with the same `clarificationId` and content returns the same task
  with `clarificationReplay: true` and starts no new attempt. The same id with
  different content is `CLARIFICATION_CONFLICT`; `SESSION_NOT_READY` and
  `CLARIFICATION_UNSUPPORTED` mean do not proceed — never open a second session.
- The original packet, hashes and workspace are preserved and a new understanding
  generation is minted, so identical model text in a later generation cannot revive
  the old approval. Approval still requires the exact new hash.

Use `bridge_approve` when the understanding is correct as it stands, `bridge_clarify`
when one bounded explanation is missing, and re-plan only when the task itself is
wrong.

## Failure handling

- `INVALID_PACKET` with a schema-version message: use the required integer 1,
  not a guessed plugin version. Correct any other field named by the error.
- `INVALID_SCOPE` saying cwd is not covered: select an existing cwd within an
  already authorized root, or split the task. Do not widen readRoots to make a
  parent cwd pass.
- These explicit packet-validation rejections occur before task creation; after
  correcting the packet within the same authorization, the same rejected key can
  be reused. A transport timeout or an unknown execution outcome is different:
  inspect task state before deciding whether to retry.
- A typed preflight refusal (`adapter/tool-unavailable`, or an unsupported boundary
  such as `apply_patch`) is a deliberate rejection from the internal preflight that
  `bridge_submit` runs before a task exists, so it creates no task; correct the request
  inside the existing authorization. It is not a host outage.
- `GIT_IDENTITY_UNAVAILABLE` is a **different operation stage**: `bridge_workspace_refresh`
  raises it on an existing owned task and workspace before rebasing, when the git
  author/committer identity cannot be read there. The task, workspace, evidence and
  already-collected results are retained and the prior review is already invalidated.
  Fix the identity condition for that workspace and retry the refresh — never report
  it as a submit error that created no task, and never delete the task or workspace
  because of it.
- Never advise adding `apply_patch` or a raw shell string to get around a refusal; the
  allowed tools come from the packet and host enforcement.
- A failed or blocked task returns a reason, not a guess. Record the reason and
  decide: re-scope, re-plan, or stop.
- Never let a worker's narrative stand in for state. Task state comes from the
  bridge; artifacts come from the filesystem; both are checked.
