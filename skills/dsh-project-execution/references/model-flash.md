# Flash (deepseek-official/deepseek-flash)

The default delegated model for implementation, review and integration. Verify the
exact provider/model id from `bridge_models` before submitting; treat this file as
working guidance, not as a catalog.

## Where it belongs

- Bounded implementation with explicit acceptance criteria and a reviewable diff.
- Independent review of a specific commit against a stated contract.
- Integration mechanics once a head is verified.
- Investigation with a narrow question and named files.

## How to get good work out of it

- **Be concrete about the deliverable.** Name files, exports, commands and exit
  codes. "Improve error handling" produces a plausible diff; "reject a blank
  `idempotencyKey` with `E_ARGS` and cover it in `test/x.test.mjs`" produces a
  checkable one.
- **Give the evidence surface.** Tell the worker which command proves the task and
  demand its real output. Self-reported success is not a result.
- **Bound the diff.** One responsibility per task, one writer per worktree. Large
  multi-concern tasks are where plausible-looking but wrong changes accumulate.
- **State the invariants that must not regress**, especially ones the worker could
  reasonably trade away (compatibility, fail-closed behavior, no new dependency).
- **Ask for the failure modes it did not test**, not just a summary of what it did.

## Reviewing its output

Review the artifact, not the narrative: read the diff, the tests and the command
output. Check that new tests can fail (mutate the source mentally or actually) and
that claims about untouched scope are true. Unexplained extra edits, silently
relaxed assertions, or a passing test that asserts nothing are review findings.

## When to escalate

For this user's installation, escalation must preserve the Flash-only DSH route.
Narrow the task, provide concrete failure evidence, or return it to the controller
for inspection. Do not select Pro or another DSH model unless the user explicitly
changes the restriction. The general guidance below applies only within that
authorization.

Escalate to a higher-effort model when the task is ambiguous, when a first attempt
failed in a way the worker could not explain, when the change is subtle enough that
review itself is expensive, or when the cost of a wrong answer exceeds the cost of
the extra reasoning. Escalation is per task and explicit; it never happens
implicitly through a fallback.
