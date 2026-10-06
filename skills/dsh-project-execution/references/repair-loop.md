# Repair loop (bounded Flash first)

A failed independent check is a work item, not a reason to change route, widen scope
or ask the user again. Repair follows the same boundaries as the original task.

## Route discipline

- Default implementation **and** repair is bounded
  `deepseek-official/deepseek-flash`, confirmed from `bridge_models` before each
  submit; treat the model reference as guidance, not as a catalog.
- When Codex is the controller, native Astra reviewers run directly in Codex with
  their own model/effort controls. They are never forwarded into DSH, and no DSH
  task is routed to a Codex provider. Keep the two routes separate.
- No silent model or effort switch. A repair that wants a different route names the
  provider, model and effort explicitly, with the evidence that justifies it.
- Escalation is per task, explicit and evidence-based. It never happens through a
  fallback, a changed default or an unstated substitution.

## Trigger

Repair starts from evidence produced by an independent check or review:

- the exact command or check object that ran, its actual output and exit code;
- the expected behavior it contradicted;
- the exact candidate head/commit the check ran against.

A model's own claim that tests passed is neither a trigger nor a result. Review the
artifact — diff, tests, command output — before deciding whether repair or rejection
is the right outcome.

## What a repair packet carries

Repair is a **new bounded packet** aimed at the failed candidate, not a continuation
inside the failed worker's workspace. There is no public adopt-existing or
worktree-reuse API: the repair gets its own new isolated worktree, and the runtime
creates it from the candidate commit.

The new packet keeps the original task's relative boundaries and carries:

- the precise failed check, its real output and the reproducer;
- the expected behavior, stated observably;
- the exact candidate head/commit (full commit id) and its contract version;
- the invariants that must not regress (compatibility, fail-closed behavior, no new
  dependency).

### Repair workspace

Do not point `workspace.repository` at the failed worker's worktree. Name the same
original main repository and start the new worktree at the candidate commit:

```json
{
  "workspace": {
    "repository": "E:/your-project",
    "baseRef": "8c1d0f9a2b3c4d5e6f708192a3b4c5d6e7f80912"
  }
}
```

- `repository` is the original **main repository** the first task was created from.
- `baseRef` is the **full commit id** of the exact failed candidate head the check ran
  against; a branch name or an abbreviated id is not the reviewed unit.
- Express `cwd`, `readRoots`, `writeRoots` and material paths against that repository,
  exactly as in the first packet. The runtime creates the worktree and remaps them
  into it, so the same relative write boundaries apply to the new tree.
- Never invent a `reuse`, `workspacePath`, `path` or "adopt this workspace" field. The
  packet schema has only `workspace: {repository, baseRef, branchName?}`, and no tool
  accepts an existing workspace to write into.

### Partial overlay example

This is a partial overlay on the complete packet example in
[task-packets-and-gates.md](task-packets-and-gates.md); every key not shown is carried
over unchanged from the packet being repaired. Replace the objective text with the real
failed check, its actual output and exit code.

```json
{
  "packet": {
    "idempotencyKey": "source-interface-review-001-repair-1",
    "revision": 1,
    "parentTaskId": "t-20260925-docs-1",
    "title": "Repair: interface review against candidate 8c1d0f9a",
    "objective": "Fix the one failed check below and change nothing else. Failed check {\"command\":\"node\",\"args\":[\"--test\",\"test/interface.test.mjs\"]} exited 1 with <real output>; expected <observable behavior>. The candidate head under repair is 8c1d0f9a2b3c4d5e6f708192a3b4c5d6e7f80912.",
    "acceptance": [
      "The named check fails on the candidate commit and passes on the repaired head, with its real output and exit code.",
      "No file outside the original write boundaries changed; report the exact diff stat."
    ],
    "workspace": {
      "repository": "E:/your-project",
      "baseRef": "8c1d0f9a2b3c4d5e6f708192a3b4c5d6e7f80912"
    }
  }
}
```

- A new logical attempt needs a **new `idempotencyKey`**; the failed attempt keeps its
  original key and revision. Keep `projectId`, `role`, `contractVersion`, the explicit
  route and effort, and the original `cwd`/`scope`/`materials` values (the runtime
  remaps the paths), and set `parentTaskId` to the prior task id.
- The overlay changes only the keys shown. If the original was a read-only
  investigation (`writeRoots: []`, no write tools), the repair stays read-only: needing
  a write is a boundary decision for the owner, never a scope widening inside the loop.

Do not send "make the check pass" without the failure evidence, and do not let a
repair packet widen scope, add roots or tools, or change the contract. When the fix
genuinely needs a wider boundary, stop and return that need to the owner.

## Rounds and authority

- **Two routine repair rounds is the maximum**, not a target and not a minimum. It is a
  ceiling on routine repair, not authority to widen scope or switch models.
- Stop after the **first** round whenever no evidence-backed alternative remains. A
  second round is justified only by new evidence about the failure — a corrected
  hypothesis, a newly named cause, or a bounded fix the first round did not attempt.
  Repeating the same change is not a round.
- Routine repair inside the existing authorization needs no new user approval and no
  permission request; the original packet's scope already covers it.
- If the worker reports a routine, optional assumption that the existing
  authorization already permits, the coordinator resolves it and states the
  resolution. Do not bounce the question back to the user merely because the worker
  raised it.
- A repair that needs a boundary, route or authority change is a decision for the
  owner; the loop never assumes it.

## Stopping and escalation

Stop the loop and report when:

- a round does not move the failure and no evidence-backed alternative remains — stop
  there rather than spending a second round by habit, and stop immediately when the
  same failure survives both rounds;
- a repair introduces a failure it did not explain;
- the fix requires widening scope, changing route or changing acceptance.

Report the evidence, the rounds attempted and the concrete reason a different
boundary or authority is required. Escalate explicitly to a higher-effort route
(native Astra under Codex when Codex is the controller, or another explicitly named
route) or return to the owner.
Never repeat an ineffective retry, and never launder a route change as a "retry".

## Records

Keep these separate, and never merge them into one success claim:

- **first-pass** outcome of the original candidate, with its checks and head;
- **each repair round** — candidate head before and after, the failed check, the new
  output;
- **coordinator code takeover**, if the owner edits the product directly. That edit is
  not Flash output and must never be described as such.

Never fabricate an intentional defect to demonstrate a repair; an honest "no real
issue was found" is a valid outcome. Integration follows only after independent checks
and review pass on the exact repaired head. One module or one sample does not support
a general claim that Flash matches Astra.

## What callers must not do

- Never tell a caller or worker to add `apply_patch` or another unclassified tool to
  get around a refusal; unsupported tools are rejected by the internal preflight that
  `bridge_submit` runs, by design.
- Never suggest raw shell strings. Checks are `{command,args?,timeoutMs?}` objects, and
  the worker's authorized tool set comes from the packet, not from a repair
  instruction.
