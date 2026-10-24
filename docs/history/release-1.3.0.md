# Release candidate 1.3.0 — bounded recurrent supervisor (edition 2)

Candidate version: bridge **1.3.0**, adapter **0.5.0**, contract
`bounded-recurrent-supervisor-v1`. This is the second edition of the long-task supervisor;
the 1.2.1 maintenance record in [maintenance-1.2.1.md](maintenance-1.2.1.md) is preserved
verbatim and every 1.2.1 stop/ledger/identity/watchdog fix is retained.

## What is new

- **Opt-in bounded recurrence.** Host `supervisorProjects.maxRounds` (1..8, default 1) and
  packet `project.maxRounds` (1..8, absent = 1). Absent `maxRounds` is never injected into a
  normalized packet, so legacy project submissions keep their stored hash and remain
  idempotent. Over-cap requests are refused, never clamped.
- **Real review rounds.** `adapter.nextRound(task, hooks)` continues the SAME owned session and
  re-proves the ADMISSION-TIME recurrent grant plus the strict settled picture (idle/absent and
  identical guarded agent, readable queue lists, readable owned-job and owned-child inspectors at
  zero) before any prompt; a missing/throwing/non-array probe is unknown and refuses with
  `dispatched:false`. It then installs the round's own narrowed tool/time allowance. The round
  prompt carries the real persisted worker results — each worker's state/stop flag, result digest
  and a bounded (512 chars, at most 16 workers) JSON-escaped excerpt of the REAL settled result
  snapshotted from the owned task and labelled untrusted — and waiting is host-driven with no model
  polling.
- **Checked round CAS.** The next attempt is minted only by `TaskStore.beginRound`, which demands
  the exact current attempt/round, an explicit true/0/0 stop, the exactly matching READABLE stopped
  PREVIOUS round for that attempt (nonblank `attemptId`, terminal status, its own true/0/0 proof; an
  absent previous round refuses), no pending dispatch and the bound pending-round intent; any
  ambiguity is `ROUND_CONFLICT` with the identity and checkpoint untouched.
- **Decision tools** `dsh_supervisor_project_complete` / `dsh_supervisor_project_block`,
  granted only on a recurrent project. A completed first wave never completes the whole
  goal; the round cap produces an honest failure.
- **Cumulative budget accounting** counted exactly once per term (supervisor observed spend,
  live supervisor reservation, released worker spend, worker reservations), with round spend
  as a delta of the cumulative counter and unreadable stats charged the full reserved cap.
- **Durable pause/resume** `bridge_pause` / `bridge_resume`, idempotent by `requestId` (which
  binds the task and the operation; `reason` is first-request audit text and a later same-id
  retry returns the original outcome with `replay:true` and no new transition), with the distinct
  `pausing`/`paused` states proven before admission is released, the immutable deadline still
  counting through a pause, and typed refusals that retain the checkpoint. Every accepted or
  refused resume id is kept in a bounded per-operation history (cap 128): an early refusal is
  persisted BEFORE it is returned and still replays after the proof arrives, an older id can never
  reopen admission after a newer request, and an unknown id at capacity is typed-refused. The
  service mutates before it reads, so the reported status is never stale.
- **Honest planning-phase pause.** A pause during the still-live plan round records the real
  true/0/0 root stop and settles to `paused` (never a fabricated `plan-not-frozen` failure);
  `dsh_supervisor_plan_finalize` may close an already-declared draft while admission is held
  without admitting or starting anything; an explicit resume continues the same record, dispatching
  a frozen draft or finishing an unfrozen plan with one guarded bounded planning round.
- **Recurrent watchdog lineage.** The finite one-shot watchdog durably binds the project identity
  at arming (project anchor/grant plus the outer task anchor, armed first attempt and target) and
  treats a later attempt as legitimate ONLY with a complete readable exact lineage, exact project
  anchor/grant/deadline/target and a positive all-work stop; a stopped completed/cancelled project
  is quiet and a genuine current failed aggregate callback is reused. Missing/broken/mismatched
  proof stays an anomaly, and ordinary/legacy arms keep byte-identical receipts (no binding key).
- **Restart honesty**: no auto-resume, ambiguous round dispatches fail closed, and an
  explicit resume either continues through real adapter ownership/guard proof or refuses
  with a typed local refusal and retains the checkpoint.

## Compatibility

- Bridge version: `BRIDGE_VERSION` (src/mcp.mjs), `package.json` and
  `.codex-plugin/plugin.json` are all `1.3.0`; the MCP surface grows from 16 to 18 tools
  with `bridge_pause` and `bridge_resume`.
- Adapter version: `ADAPTER_VERSION` is `0.5.0` (new `nextRound` seam, base-aware root
  guard, recurrence-aware capability report). Adapters without `nextRound` refuse a
  recurrent round locally (`ROUND_UNSUPPORTED`, `dispatched:false`).
- Legacy behavior: packets without `project` are untouched; packets with `project` and no
  `maxRounds` keep the edition-1 single-round lifecycle and tool surface; the host defaults
  keep recurrence and pause off.

## Verification (commands to run; the implementer claims no run result)

- `node --test test/*.test.mjs`
- `node scripts/smoke-recurrent.mjs <dir with node_modules/@deepseek-ai/dsh>` (offline
  synthetic model, real mounted host, no paid API)
- `node scripts/smoke-supervisor.mjs <same dir>` (edition-1 behavior preserved)

Only Flash (`deepseek-official/deepseek-flash`) is used; no other model route is selected,
substituted or escalated to.
