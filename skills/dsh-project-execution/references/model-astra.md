# Astra high/xhigh — native Codex comparison

Astra runs as a native Codex subagent when the user explicitly chooses it.
DeepSeek Flash runs through the DSH bridge. Keep these execution routes separate:
do not add a Codex model provider to DSH, and do not forward an explicitly
requested native Astra subagent back into DSH.

Codex coordinates both workers. Use native subagent model/effort controls for
`gpt-6-astra` with `high` or `xhigh`; use `bridge_models` only for DSH providers.
Missing native models are reported, never silently substituted. Explicit user
and project routing overrides legacy machine forwarding shims.

For comparison, provide the same task contract, baseline, material boundaries,
completion format and acceptance checks. Give each writer an isolated worktree.
Keep candidate implementations hidden from one another. Ask for understanding
before writing when a gate is required; Codex approves within existing user
authorization, runs objective tests and records extra corrections or repairs.

Record native model/effort separately from DSH session routes. Native Codex tools
and DSH guarded tools are different backends; do not claim identical runtime
enforcement. Neither worker's self-report proves tests passed. Preserve first-pass
failures and score repairs separately.

Use a stronger native route for bounded diagnosis, ambiguous interface design or
subtle review when warranted. Flash remains the default DSH implementation and
review route. One module comparison supports a conclusion about that sample,
not a general ranking or a promise of unattended project development.
