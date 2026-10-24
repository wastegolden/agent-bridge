# Agent Bridge 1.4.0（原 DSH Codex Bridge）

1.4.0 起，本插件由 Codex 与 Claude Code 共用，并支持两者之间的跨 harness 协作：

| 组成 | 作用 | 谁在用 |
|---|---|---|
| DSH 宿主插件（`dsh-host/`、`src/*`） | 在 DSH 内调度有边界的 Flash 任务、worktree、审查与集成，HTTP 端点 `/mcp/codex-bridge-v1` | DSH |
| `dsh_project` | 暴露 `bridge_*` 工具：Claude Code 直接走 MCP HTTP（`Bearer ${DSH_MCP_TOKEN}`）；Codex 可走 HTTP 或 `bin/bridge.mjs` stdio → HTTP 转发 | Codex、Claude Code |
| `agent_peer`（`bin/peer-mcp.mjs`） | 无头调用另一个 harness：`consult`、只读 `review`、作为代理主控 `delegate` | Codex、Claude Code |
| 唤醒 | Codex：`bin/wake-controller.mjs`；Claude Code：`bin/wake-claude.mjs`（`--wait`/`--follow` + 显式 `--ack`） | 各自主控 |
| skills | `dsh-project-execution`（DSH 通道），`agent-bridge-routing`（分工、防套娃、多模型互证） | 两边共用 |

规则：每个任务只有一个根主控（用户正在对话的那个 harness）；任务沿链向下派发、结果沿链向上返回。
`agent_peer` 服务端强制执行：不能调用自己、不能调用链上已有的任何 harness（因此永远不会委托回主控）、
跳数和 delegate 深度有上限；DSH worker 不能调用 Codex 或 Claude Code。插件清单：
`.codex-plugin/plugin.json` + `.codex-mcp.json`（Codex）与 `.claude-plugin/plugin.json`（Claude Code，MCP 服务内联在清单里）。
Codex 的 MCP 模板不能叫根目录 `.mcp.json`：Claude Code 也会读插件根目录的 `.mcp.json`。持久化标识
（`origin: codex-bridge`、端点、宿主插件 id）保持不变，旧任务库与 worktree 继续可用。变更见 [CHANGELOG.md](CHANGELOG.md)。

以下为 1.2.0/1.3.0 时期的原始说明（文中“Codex 负责……”应理解为“提交任务的主控负责……”）。

# DSH Codex Bridge 1.2.0

已在 DSH `0.1.7-rc.2`、Node.js `24.16.0`、Windows 上验证。更新内容和验证范围见 [CHANGELOG.md](CHANGELOG.md)（本版本不在写入范围内的说明见文末）。

Codex 负责需求、接口合同、任务边界、验收与集成；DSH 默认使用 `deepseek-official/deepseek-flash` 承担编码、调查与核查。每个写任务使用独立 Git worktree，提交绑定文件范围、工具许可、材料版本、完成标准和预算。当前实现为 Node.js 24 ESM，运行时仅使用 Node 内置模块。

1.2.0 把两条已验收组件（核心 supervisor/子会话/作业、回调 outbox/runner）接成可用产品：宿主 `eventWake` 配置、受信控制器入口、摘要上限对齐与关停生命周期。适配器版本 0.4.0。

本目录是新插件源码。`dsh-host/index.cjs` 是 DSH 宿主插件；`.codex-plugin/plugin.json`、`.codex-mcp.json`（1.5.1 前名为 `.mcp.json`）和 `skills/dsh-project-execution/` 是 Codex 插件部分。连接安装与机器级 subagent 路由独立：本安装器不改全局 AGENTS、agent shim、Codex 设置或原 v0.3 桥。

## 实现边界

| 环节 | v1 行为 |
|---|---|
| 默认分工 | Flash 执行有边界任务；Codex 检查真实文件、测试结果和 Git SHA |
| 并发 | 源码默认 4 路（未改动）；本机生产配置 `maxConcurrent: 16`，宿主配置 `routeLimits`；根任务与子会话共用同一份额度，依赖任务等待上游完成且被接受 |
| 上下文 | TaskPacket 保留原始材料及来源；事实、推断、未知分开；材料作为不可信数据 |
| 理解确认 | 可选 `understandingRequired`；理解阶段运行时只允许读工具，确认绑定 revision 与理解文本哈希 |
| 模型 | 每任务显式 provider/model/effort；启动前查宿主目录、启动时核对有效路由；无静默回退 |
| Skill | common / role / model 分层、带版本；模型 profile 自动匹配对应 skills；不能扩大任务权限 |
| 文件与工具 | DSH agent scoped guard 和 allowlist；解析 realpath、junction、最近已有祖先后检查读写范围 |
| 任务状态 | SQLite WAL；幂等键与输入摘要；task / revision / attempt / request / session 分离；事件游标与完整结果分页 |
| 不明执行结果 | 保持 unknown，不自动重放；占用并发预算；`bridge_reconcile` 从宿主证据对账 |
| 取消 | 清除本任务队列、取消执行、核对所属 jobs；`turn/end` 或实际 `whenIdle()` 静止证据后才能确认 |
| 集成 | 审查绑定具体 SHA；目标变更后 refresh/rebase、重新审查；只允许 fast-forward；合并后再验证 |
| 清理 | 默认成功 7 天、失败/取消 30 天；已收集、停止确认、无作业、产物解决后才清理；默认仅预览 |
| 界面 | 使用 DSH `archiveSession` 归档本桥拥有的会话；归档失败保留状态并允许重试 |
| 安装回滚 | 明确 profile；先暂存；安装清单、SHA256、备份；卸载遇用户后续修改报告冲突并保留 |

**当前能力限制必须保留：** 任意 shell 在 worker 中拒绝，测试和 Git 操作由 Codex/宿主以明确 argv 执行。网络只控制可用工具，不声称 OS 网络隔离。输出字符预算是建议值；超时为协作取消。文件检查与真正打开之间仍有 TOCTOU 窗口，写入另外受到 DSH 文件沙箱约束；不声称任意同机恶意进程隔离。DSH 暂无持久会话删除接口，归档不等于删除。重启后仅凭匹配请求的宿主证据恢复；理解会话缺少可恢复的执行器时会明确拒绝继续。

## 使用流程

先用 `bridge_capabilities` 和 `bridge_models` 获取当前能力与模型目录，然后：

1. 规划接口、文件所有权和依赖图，用 `bridge_submit` 提交一个完整 TaskPacket。
2. 用 `bridge_check` 的事件游标等待，单次最长 60 秒。等待超时不会取消任务。
3. 理解阶段结束后，控制器核对已有授权，使用 `bridge_approve`；普通范围内的确认不需要再问用户。
4. 用 `bridge_result` 分页取全结果。结果文字中的自述不是运行证据；实际执行检查并审查代码。
5. Controller 在工作树提交已核对改动，然后调用 `bridge_workspace_review`。如果主树前进，先 `bridge_workspace_refresh` 并重新审查；冲突保留现场，不自动 reset/abort。
6. `bridge_workspace_integrate` 的 `checks` 在源树和合并后的目标执行。可选 `baselineChecks` 仅检查旧目标，避免拿新功能测试要求旧版本通过。合并后失败返回 `merged:true, accepted:false`。
7. `bridge_acknowledge` 记录收集与接受；`bridge_cleanup` 先预览，再执行宿主保留策略。调用方的时间/策略覆盖只用于预览。

完整输入合同见 [CONTRACTS.md](CONTRACTS.md)；协调器操作指引见 [SKILL.md](skills/dsh-project-execution/SKILL.md)。运行时额外支持 `bridge_reconcile` 和 `bridge_workspace_refresh`，分别用于未知状态对账和并行分支更新基线。

## 配置与安装

需要 Node.js 24 与 Git 可执行文件。DSH 安装路径与 profile 由操作人明确指定，安装器不会猜测正在使用的 profile。

```powershell
node scripts/install.mjs --source <插件源码绝对目录> --profile <DSH-profile绝对目录> --require-host-entry --dry-run --json
node scripts/install.mjs --source <插件源码绝对目录> --profile <DSH-profile绝对目录> --require-host-entry --json
node scripts/uninstall.mjs --profile <DSH-profile绝对目录> --dry-run --json
node scripts/uninstall.mjs --profile <DSH-profile绝对目录> --json
```

DSH 插件配置可设置 `dataDirectory`、`ownerId`、`endpoint`、`credentialFile` 或 `tokenEnv`、`maxConcurrent`、`routeLimits`、`defaultModel`、`profiles`、`skills`、`retention`、`childSessions`、`commandProfiles`/`commandJobs`、`rootCallbackGrants` 与 `eventWake`。宿主显式 `credentialFile` 优先，否则读取 `tokenEnv`（默认 `DSH_MCP_TOKEN`）。凭据至少 24 字符，不写入插件包。可把以上非密钥配置保存成 JSON 文件，并在安装命令中添加 `--host-config <配置文件绝对路径>`。

## 受控自治：子会话、作业与事件唤醒（1.2.0）

三个能力都默认关闭，必须**同时**满足宿主配置与每个任务的显式声明；普通 worker 的行为与默认值完全不变（无 shell、无原生委派、无子会话）。

宿主配置（`.mcp.json` 旁的 host config，经 `--host-config` 传入）：

```json
{
  "dataDirectory": "F:/DSH/data/codex-bridge-v1",
  "credentialFile": "F:/DSH/data/codex-bridge-v1/bridge-token",
  "maxConcurrent": 16,
  "childSessions": { "enabled": true, "maxDepth": 1, "maxChildrenPerTask": 2 },
  "commandProfiles": [
    { "id": "echo", "executable": "C:/Program Files/nodejs/node.exe", "argv": ["-e", "console.log(1)"],
      "cwd": "F:/work", "env": {}, "timeoutMs": 5000, "maxOutputBytes": 4096 }
  ],
  "commandJobs": { "enabled": true, "maxJobsPerTask": 1 },
  "rootCallbackGrants": { "originating-chat": { "targetId": "01a0e7a9-7906-7280-86a5-abca2e6bca27" } },
  "eventWake": { "enabled": true, "stateRoot": "F:/DSH/data/codex-bridge-v1/wake-state", "maxSummaryChars": 8192, "claimLeaseMs": 30000 }
}
```

- `rootCallbackGrants` 是**唯一**的授权表，永远在顶层；`eventWake` 内不得嵌套授权。`targetId` 是不透明会话标识（UUID 合法），不是路径；只有 `stateRoot`、`serverPath` 与配置文件路径必须是绝对路径。每个受信目标在 `stateRoot` 下拥有一个以 `t-<targetId 的完整 SHA256>` 命名的独立 outbox 目录，宿主与控制器用同一函数推导，互不消费彼此记录。
- `eventWake` 与注入 `notificationSink` 同时启用是歧义双配置，直接拒绝。关闭或缺失时保持旧行为（无回调权限）。
- 任务级开关（`bridge_submit` 的 `scope`）：`childSessions: {enabled:true, maxChildren, toolNames}`、`backgroundJobs: {enabled:true, profileIds, maxJobs}`；唤醒还需 `rootCallback: {grantId}`。`allowDelegation` 必须保持 `false`：它指的是**原生/递归**委派，与桥自有的 depth-1 子会话是两条独立规则（提示词不再自相矛盾）。
- 子会话通过真实的 `agents.create` 创建，工具为 `dsh_child_spawn|wait|result|cancel|list`；子会话不能扩大 roots/tools/network/model/budget/callback/depth，不持有 `subagent`、shell、桥作业或唤醒工具，深度固定 1。
- 作业只能使用操作人批准的 profile（精确 executable/argv/cwd/env，`shell:false`）。profile 白名单**不是** OS 沙箱：不声称进程、文件系统或网络隔离。
- 只有直接委派的根任务可以唤醒 Codex；子任务结果回到父任务。摘要上限：worker 原始回复上限仍为 **8000**，集成层在加控制器前缀（`[blocked] `/`[needs-input] `）后按 **8192** 校验；超限直接拒绝，绝不静默截断。低层 outbox 与旧 runner 的默认值保持 **1200** 不变（兼容），集成层显式传 8192。
- 能力报告区分「生产者已配置」与「投递已验证」：`eventWake.producer/outboxConfigured` 为真时，`liveTransport`、`runnerAvailable`、`liveAck` 仍是 `unknown`，只有控制器实际收到针对精确目标的肯定回执才算 `delivered`；入队只算 `queued`。

### 启动受信控制器 runner

```powershell
# controller.json（只放路径与限额，绝不放环境密钥）
# { "stateRoot": ".../wake-state", "targetId": "01a0e7a9-...", "serverPath": "C:/.../codex-app-tools/0.1.5/server.mjs", "idleTimeoutMs": 5000 }
node bin/wake-controller.mjs --config F:/DSH/data/codex-bridge-v1/wake-controller.json
node bin/wake-controller.mjs --config ... --once          # 单次排空（测试/CI）
node bin/wake-controller.mjs --config ... --reconcile <eventId> --delivered true|false [--requeue]
```

该入口没有 `--target/--state-dir/--server-path/--caller-thread` 覆盖：配置即唯一绑定。启动时会强制 `process.env.CODEX_THREAD_ID === targetId === callerThreadId`，并要求官方 codex-app-tools 传输所需的常规环境存在（只判断存在，绝不读取或记录其值）；缺失或不一致一律类型化拒绝，绝不伪造 `_meta`。runner 只在事件到达时唤醒，绝不轮询 LLM、不打心跳、不重放歧义发送；进程隐藏启动由它自己负责，无需服务管理器或全局环境改动。

锁不可自动回收：进程死亡后残留的 `state.lock`/`runner.lock` 必须由操作人执行离线恢复——停掉所有生产者与 runner、确认无存活持有者，再只删除该锁文件。宿主确认关停时才会关闭它拥有的 outbox；停止未确认时 outbox、store 与宿主租约一起保留，等待下次 close 重试。

Codex 的 MCP 模板 `.codex-mcp.json` 通过 `node ./bin/bridge.mjs` 使用 stdio 连接（安装副本里叫 `.mcp.json`，也可以改成直接 `url` + `bearer_token_env_var`）。转发程序读取 `DSH_MCP_TOKEN`，或 `DSH_BRIDGE_CREDENTIAL_FILE` 指定的文件；默认文件为 `$DSH_HOME/codex-bridge-v1/bridge-token`（未设置 `DSH_HOME` 时使用用户主目录下 `.dsh`）。宿主和转发程序必须使用同一凭据。默认服务地址是 `http://127.0.0.1:3080/mcp/codex-bridge-v1`，可用 `DSH_BRIDGE_URL` 覆盖。自定义 DSH 安装目录时，在 Codex 安装副本的 `.mcp.json` 中设置 `env.DSH_HOME`；凭据文件保存在运行数据目录中。

安装 Codex 插件后开启新对话加载工具和技能。DSH 必须保持运行；转发程序不会自行启动宿主。模型 API Key 仍通过 DSH 自身的设置界面配置，桥接凭据不能代替模型 API Key。

每个运行中的宿主独占一个 dataDirectory；已有宿主或无法确认是否陈旧的租约会阻止重复启动，避免两个调度器重复派发。同一任务进行中不会换模型；新任务可以显式选择另一条目录中已存在的路由。

热卸载时若仍无法确认任务停止，会保留工具限制、任务数据库和宿主租约，防止另一个挂载实例同时接管。`unknown` 任务持续占用并发额度，达到上限时新任务排队；必须通过 `bridge_reconcile`/`bridge_cancel` 取得宿主证据后才能释放，v1 不提供无证据的“强制成功”或自动重放。宿主重启可以解除已死亡进程的租约，但不会凭此把任务判定为成功或停止。

## 验证与证据

```powershell
node --test test/*.test.mjs
node scripts/smoke-runtime.mjs <包含node_modules的DSH安装目录>
node scripts/smoke-autonomy.mjs <包含node_modules的DSH安装目录>
node scripts/smoke-supervisor.mjs <包含node_modules的DSH安装目录>
```

测试包括真实临时 Git 仓库/worktree 操作、安装回滚与 junction 攻击、任务恢复/幂等/取消状态机，以及模拟宿主适配。`smoke-runtime.mjs` 在 DSH 安装目录下创建独立 `.bridge-smoke-*` 数据目录，使用空闲端口启动真实 DSH 和离线模型 fixture，验证会话、文件工具边界、取消、归档以及 Codex stdio 转发。退出时停止测试宿主，保留报告用于诊断；不调用付费模型 API，也不访问正式 profile。成功联调报告见 [evidence/dsh-0.1.7-rc.2.json](evidence/dsh-0.1.7-rc.2.json)。报告不能证明真实模型服务的联网认证或输出质量。

`smoke-autonomy.mjs` 在 DSH 安装目录下创建独立 `.bridge-autonomy-*` 目录，用**真实** `mountBridge`（含 `eventWake`）与离线合成模型验证：真实 `agents.create` 子会话及其结果与降权、子会话上限拒绝、取消与已确认停止、操作人 profile 作业的所有权/输出/停止、以及真实生产者写入的 durable outbox 记录（`pending`，非 `delivered`）。它只用注入的假 client 走一遍 runner 的入队→投递判定，**绝不真实发送**；真正的同一会话投递由控制器在 review 后单独执行。作业场景若被宿主 seam 拒绝，会以具体拒绝证据记录为失败，而不会因为「被拒绝」就判为通过。

`test/wake-integration.test.mjs` 覆盖配置拒绝、目标目录隔离与绑定标记、真实生产者记录、精确目标肯定回执才转为 `delivered`、歧义不重放、8000/8001 与 8192/8193 边界、以及关停生命周期；它**不能**替代上面两个真实宿主联调。

## 长任务 supervisor（第一版，显式开启）

宿主配置 `supervisorProjects.enabled: true` 后，`bridge_submit` 的 TaskPacket 可带一个可选 `project` 块：它创建**一个**真实 Flash supervisor 会话，由该会话用 supervisor 专用工具（`dsh_supervisor_worker_create` / `plan_finalize` / `worker_list` / `worker_result` / `worker_cancel` / `project_status`）一次性声明完整 worker 计划并冻结；随后由宿主确定性编排器把每个 worker 作为真实有界 bridge 任务调度（写手各得一个全新 worktree），普通失败在固定上限内修复，只有**已验证停止**的所属工作才可能让项目完成或干净失败。项目在两轮之间处于 `supervising`（活跃、未结算），真实阶段在 `project.status`。worker 完成**不会**单独唤醒 Codex：只有聚合完成或严重问题才通过既有 outbox 与提交时绑定的目标产生一条有界回调。被阻塞/`unknown` 的项目保留占用，必须 `bridge_reconcile`，不得在停止未证实的情况下重派、清理或归档。第一版为一次性计划、不自动合并、宿主重启不接管运行中的 worker。未开启该配置的宿主会以类型化拒绝 `packet.project`，其余行为与之前完全一致。详见 [docs/long-supervisor.md](docs/long-supervisor.md) 与技能参考。

`scripts/smoke-supervisor.mjs` 在 DSH 安装目录下创建独立 `.bridge-supervisor-*` 目录与真实临时 Git 仓库，用真实 `mountBridge`（含 `eventWake` 与 `supervisorProjects`）和离线合成模型验证：一次计划创建 3 个 worker（含一个写手 worktree 与未提交改动证据）、重复声明/冻结与重复提交的幂等、普通失败的有界修复与新 worktree、显式取消 worker 后项目干净失败、越权 root/model 请求被拒、每个项目恰好一条 `pending` 回调且 worker 不产生回调，以及旧的有界任务路径不变。

## 受限多回合 supervisor 与暂停/继续（第二版，双重显式开启）

在宿主配置 `supervisorProjects.maxRounds`（1..8，默认 1）与 packet `project.maxRounds`（1..8，缺省即 1）**同时**显式开启后，同一个真实 Flash supervisor 会话可以在工人结果到齐并证明停止后进入下一次有界决策回合：等待工人期间由宿主事件推进，模型不轮询、不空转。每回合只能在同一不可变 worker 信封与硬上限内**追加**工人，并用 `dsh_supervisor_project_complete` / `dsh_supervisor_project_block` 明确记录完成或阻塞决定；首波成功不会冒充整个多回合目标完成，回合上限用尽时项目诚实失败（`supervisor-rounds-exhausted`）。所有主管回合与工人开支计入同一个累计总预算，逐项只计一次；每回合预留额度在任何 await/派发之前持久化，新 attempt 仅由一个事务型受检 CAS（`TaskStore.beginRound`）铸造：它要求精确的当前 attempt/回合、显式的 `stopConfirmed:true` 与数值 0 的 jobs/children、匹配的已停止回合身份、无未决 dispatch，以及派发前已绑定的 pending 回合意图，任何歧义都以 `ROUND_CONFLICT` 拒绝且完全不改动身份与 checkpoint；进入回合前适配器还会以严格探针重新证明**准入时**的回合授权与真实静止状态（agent idle 且与受护对象同一、队列可读、jobs/children 检查器可读且为零），缺失/抛错/非数组一律视为 unknown 并在任何 prompt 之前以 `dispatched:false` 本地拒绝，迟到旧回合回调不会改动当前 attempt。宿主 `supervisorProjects.pause: true`（需 `maxRounds >= 2`）时可用 `bridge_pause` / `bridge_resume`：暂停请求同步持久化并立即禁止新的工人与主管派发，只有当前回合与每个所属工人均为真/0/0 且无未决 dispatch 才成为 `paused`（`pausing` 绝不冒充已停，且返回的是变更后的真实状态而非旧快照）；`requestId` 绑定任务与操作，`reason` 只是首次请求的审计文本，同一 `requestId` 的后续重试（省略或改写 reason）返回原结果并带 `replay:true`，不产生任何新转移、不重复调度；resume 先重新校验停止、归属与 dispatch 证据，再延续**同一**任务记录，不复制任务、不重置预算，原始绝对截止时间在暂停期间继续计算且不可续命，已请求取消的项目不会被 resume 复活。accepted 的 resume 只是调度意图：真实适配器仍可能在回合派发时本地拒绝并异步恢复 `paused` 与类型化 refusal。宿主重启绝不自动恢复：暂停 checkpoint 保留，无法证明 guard 恢复时明确类型化拒绝并保留 checkpoint。缺省或未开启的宿主与旧 packet 行为完全不变。详见 [docs/recurrent-supervisor.md](docs/recurrent-supervisor.md) 与 [docs/release-1.3.0.md](docs/release-1.3.0.md)。

`scripts/smoke-recurrent.mjs` 用同一真实 `mountBridge` 与新的离线合成模型（`test/fixtures/recurrent-provider.mjs`）在真实安装的 DSH 上验证：两个真实回合消费真实工人结果、无模型轮询、回合上限诚实失败、累计预算、暂停→`paused` 证明、幂等 resume、宿主重启不自动恢复与暂停 checkpoint 保留，以及旧 packet 不获得任何新能力。真实 Codex 发送仍不在离线联调范围内。

正式切换前应选择宿主空闲窗口，并保留安装清单用于回滚。
