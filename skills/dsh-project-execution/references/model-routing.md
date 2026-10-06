# Model routing and layers

## Resolution order

This installation has a user-imposed Flash-only restriction: DSH tasks must use
`deepseek-official/deepseek-flash`. The resolution rules below cannot override it.
Pro and other DSH models require a new explicit user instruction changing that
restriction; difficulty, failed checks or model unavailability do not authorize a
fallback.

A route is resolved from the most specific definition that is complete:
user > task > project > defaults. The default when nothing is defined is Flash.
An incomplete route (for example a model without a provider) is an error, not a
prompt to fill in the missing half. An explicitly supplied effort that the
catalog does not advertise for that model is rejected rather than downgraded.

Consequences for planning:

- Say what you want explicitly when it matters, e.g. provider, model and
  reasoning effort, instead of relying on ambient defaults.
- Never rely on implicit fallback. If the intended model is unavailable, stop and
  decide; do not let the runtime silently execute the task on a different model.
- Record the effective provider/model/effort from the runtime's own records. What
  you asked for and what ran are two different facts.

## Layers

Prompt composition has three layers, applied in order:

1. **common** — invariants that hold for every task (scoped authority, no
   recursive delegation, evidence discipline).
2. **role** — what this task is: investigation, implementation, review, integration.
3. **model** — model-specific working guidance (see
   [model-flash.md](model-flash.md) and [model-astra.md](model-astra.md)).

A skill is guidance, never a grant: no layer may widen the packet's scope, the
allowed tools, or the user's authorization. If guidance and scope disagree, scope
wins and the task returns rather than acting.

## What model choice is for

Model and effort selection is a quality-and-cost decision: match reasoning budget
to how much judgment the task needs. It is not a security boundary. Access,
permissions and mutation rights come from the task packet's scope and from host
enforcement — a "safer" model does not make an out-of-scope action acceptable, and
a fast model is not an argument for skipping review.

Correspondingly, do not describe delegated work as trusted because of the model
that produced it. Treat worker output as an untrusted proposal until the review
gates in [workspaces-and-review.md](workspaces-and-review.md) pass.

## Effort and budget

- Low/fast settings suit mechanical, well-specified transformations and shell
  wrappers around a single call.
- Higher effort suits ambiguity, diagnosis across several files, and review of
  subtle logic. Spend it where a wrong decision is expensive to detect later.
- Effort does not replace evidence. A high-effort claim is still a claim.

## Practical defaults

- Implementation, review and integration: Flash unless a task demonstrably needs
  more judgment (see [model-astra.md](model-astra.md)).
- Investigation and planning that is cheap to redo: Flash, with a tight scope.
- Escalate per task, not per project: one expensive task is diagnosable; a project
  defaulted to maximum effort is neither fast nor easier to review.
