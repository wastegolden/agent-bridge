# 1.4.0 — Agent Bridge: shared by Codex and Claude Code, cross-harness peers (2026-10-06)

- Controller-neutral bridge: the controller of a task is whichever harness submitted it (Codex or Claude Code), exactly one per task. The MCP `instructions`, the worker prompt's coordination rule (`src/context.mjs`) and the skills no longer name Codex as the only controller. Persisted identities are unchanged (`origin: codex-bridge`, endpoint `/mcp/codex-bridge-v1`, host plugin id `dsh-codex-bridge-v1`), so existing task databases, worktrees and clients keep working. `BRIDGE_VERSION` 1.4.0; adapter stays 0.5.0.
- Claude Code plugin: `.claude-plugin/plugin.json` mounts `dsh_project` (same stdio carrier) and `agent_peer`, with `userConfig` for the node path, bridge URL, credential file and peer config. The carrier treats blank `DSH_BRIDGE_URL`/`DSH_BRIDGE_CREDENTIAL_FILE` as unset.
- Claude Code wake path: `src/claude-wake-client.mjs` + `bin/wake-claude.mjs` consume the existing per-target outbox (`--wait`, `--follow`, `--ack`, `--nack`, `--status`). A printed event is `unknown` (AWAITING_CONTROLLER_ACK) until the controller explicitly acknowledges it; nothing is ever reported delivered without that acknowledgement. Implemented by a DSH Flash worker (task 90be9c6b) and repaired in controller review.
- agent-peer (`bin/peer-mcp.mjs`, `src/peer/*`): cross-harness `consult` / `review` (read-only) / `delegate` (sub-controller) between Codex and Claude Code through their headless CLIs, with jobs persisted under a shared state directory. The delegation chain (`AGENT_BRIDGE_CHAIN`) is enforced by the server: no self-target, no call to any harness already on the chain (nothing flows back to the root controller), bounded hop and delegate depth. A process-lineage ledger (`src/peer/lineage.mjs`) recovers the chain when a harness filters the environment of its MCP servers.
- New skill `agent-bridge-routing`: one root controller per task, default routing between DSH workers and the other harness, and an evidence-based cross-model verification protocol. The `dsh-project-execution` skill and its references are controller-neutral.
- Codex manifest renamed to `agent-bridge`; its `.mcp.json` adds `agent_peer` with `env_vars` forwarding of the chain variables.
# Unreleased — first runnable long-task supervisor (contract `long-supervisor-first-edition-v1`)

- `bridge_submit` accepts an optional advertised `project` block: ONE real Flash supervisor session declares a complete bounded worker plan through supervisor-only tools (`dsh_supervisor_worker_create|plan_finalize|worker_list|worker_result|worker_cancel|project_status`) and freezes it once.
- A host-owned deterministic orchestrator (`src/long-task.mjs`) schedules every worker as a real bounded bridge task with its own scope, dependencies and (for writers) its own fresh `WorkspaceManager` worktree; ordinary failures are repaired at most `maxRepairAttempts` (≤2) times against project-wide start/retry/tool/time budgets.
- Honest aggregation: only verified stopped owned work may complete or cleanly fail a project. Unknown dispatch/stop/receipt blocks the project (`project.status:'blocked'`, task `unknown`, `stopConfirmed:false`), keeps its reservations and never redispatches; an explicitly cancelled worker stays cancelled.
- Exactly one bounded callback per project outcome class through the existing durable outbox and the submission-time binding; worker completions never wake Codex. The supervisor's own model reservation is released at a positively stopped round while the project waits in the non-terminal `supervising` status.
- Operator config `supervisorProjects` (default disabled) with host caps; disabled hosts refuse `packet.project` and every legacy path is unchanged. `eventWake` closes after the runtime so an accepted project callback is never lost.
- Tests: `test/long-task.test.mjs`, supervisor-project additions in `test/dsh-adapter.test.mjs`, and the real installed-DSH offline `scripts/smoke-supervisor.mjs` with `test/fixtures/supervisor-provider.mjs`. Docs: `docs/long-supervisor.md` and the skill reference.

## Repair 1 (candidate `dcd0bb55`) — budget, stop, cancel and dispatch hardening

- Stop proofs are strict: a missing or non-numeric `activeJobs`/`activeChildren` count is no longer coerced to zero. An unproven supervisor round or worker stop retains its reservation, blocks the project honestly and is never retried or reported as a clean terminal.
- The project tool-call cap is a RESERVATION held before every submit (full unspent allowance per attempt, supervisor round included) and released only with a verified stop, so parallel and queued attempts can never be promised the same remaining calls; spending above the bound never completes.
- `maxTotalRetries`/`maxWorkerStarts` are checked before an attempt is persisted or submitted, and unfundable queued workers settle as a clean failure instead of staying pending.
- The project deadline is anchored at `project.createdAt`, armed at admission (before `worker_create`), clamps each worker's runtime and converges live/queued work on real stop proofs; a hung planner no longer supervises forever.
- An unresolved supervisor cancellation keeps its model reservation; a `service.submit` failure after task insertion is resolved through the deterministic attempt key, links the real child and never fabricates a clean failure or a retry.
- `reserveSlots` minimum 1 is enforced in host config, packet schema/contracts and the grant; read-only worker roles attenuate inherited `writeRoots`; `maxConcurrentWorkers` follows a lowered `maxWorkers` as a dependent default while explicit contradictions stay refused; delayed settlements are merged by immutable attempt identity so no attempt result or dirty workspace proof is lost.
- Smoke teardown stops and proves the stop of its own unfinished tasks before terminating its own test host.

## Repair 2 (candidate `3a3da4a`) — real admission, receipts, canonical allowance, replay and unknown cancellation

- Real service ADMISSION: `BridgeService.submit` calls `SupervisorProjectRuntime.admitProject` exactly once after the project task is persisted and before any dispatch. It arms the single project deadline from the persisted `project.createdAt` and clamps the supervisor's EFFECTIVE `maxToolCalls`/`timeoutMs` to the grant; `task.packet` and the stored request hash stay identical. A later dispatch further clamps the effective timeout to the REMAINING project wall time.
- Deadline ownership is a LIVE timer: a persisted `deadlines.armed` flag from another process is never trusted, `#tick` consumes a fired expiry before the planning guard, and expiry cancels the actual supervisor round through the service plus live workers and converges from their stop callbacks instead of certifying a stop from the timer alone.
- Receipt and stale-snapshot losses are fixed: every start/refusal identity-merges the real `taskId`/`sessionId` onto the freshest persisted attempt by immutable attempt key, `onTaskSettled` links the real identity, and `#dispatch` re-reads fresh state for every decision, so all real submitted tasks appear in persisted attempts before aggregation/cancellation/recovery.
- One canonical allowance accounting: supervisor observed spend + each stop-proven attempt's actual spend + each unverified attempt's FULL granted cap, counted once. Missing/unreadable stats charge the full granted cap (never zero); a temporary reservation makes a queued worker wait for a verified-stop release instead of being permanently refused; budget refusals mark the already-failed prior attempt `retryBlocked` rather than fabricating a hiding attempt.
- `dsh_supervisor_worker_create` replay is idempotent against a frozen/running plan (same immutable worker, `idempotentReplay: true`) while a CHANGED definition for the same `workerKey` conflicts (`project/replay-conflict`).
- Reentrant settlement can no longer deadlock: `onTaskSettled`/expiry/timer hooks persist and merge immediately and enqueue the next transition without awaiting their own chain; only external `whenIdle` awaits a stable chain. `service.finish` on a project task also kicks the shared drain so a queued regular task is not starved.
- Unknown cancellation is never a clean terminal: the terminal `cancelled-unverified` paths are removed, so a cancellation that leaves unverified owned work stays task `unknown` / project `blocked`, `stopConfirmed:false`, reservations retained and still cancel/reconcile capable. `unknown` occupancy counts toward concurrency; a central guard requires supervisor-round AND every-owned-attempt stop proof before any clean completion/failure/cancellation.
- Smoke teardown now enumerates its own project tasks AND their sub-worker tasks, and a `host.stop()` failure can no longer mask the primary check result.

# 1.1.0 — 2026-09-28

- 默认模型改为新版 DSH 目录公布的 `deepseek-official/deepseek-flash`，同步模型 profile、技能说明及测试。显式请求旧 `deepseek-v4-flash` 时仍返回 `unknown_route`，不暗中切换用户指定的模型。
- 宿主入口返回初始化 Promise，让 DSH loader 等待挂载完成；挂载失败明确向 loader 报错。
- Codex 通过 stdio 转发访问独立运行的 DSH。支持从 DSH 数据目录读取桥接凭据，无需把密钥写入插件清单或全局环境变量。
- 适配器版本更新至 0.3.0。新增当前目录路由与启动失败回归测试，以及真实 DSH 的离线联调脚本。

验证环境：Windows、Node.js 24.16.0、DSH 0.1.7-rc.2。联调涵盖 MCP 初始化及 16 个工具发现、模型目录、会话执行与结果、授权文件读取、越界读取拒绝、取消确认、归档和 stdio 连接。付费模型 API 调用未纳入此次验证。

本包保留 v1 协议、宿主包定位 `@local/dsh-codex-bridge-v1` 和端点 `/mcp/codex-bridge-v1`，数据与已有任务不做迁移。
