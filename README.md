中文 | [English](README.en.md)

# Agent Bridge

Agent Bridge 让 **Claude Code**、**Codex**、**Antigravity** 和 **DeepSeek Harness（DSH）** 互相调用。你在对话的那个 harness 是任务的**根主控**：它把有边界的实现交给 DSH 的 Flash worker，把咨询、独立审查或一个子项目交给另一个 harness。每个任务只有一个根主控，DSH worker 任务有明确的读/写根、工具白名单和预算，委派链由服务端强制执行，不会出现互相委派的环。版本 2.1.1，MIT。

> 独立项目，与 DeepSeek、OpenAI、Anthropic、Google 均无隶属或背书关系。

## 组成

```
                    你（用户）
                        │
   根主控：Claude Code / Codex / Antigravity（每个任务恰好一个）
                        │
         ┌──────────────┴──────────────┐
         │                             │
    dsh_project                   agent_peer
    MCP stdio → HTTP              MCP stdio
         │                             │
         ▼                             ▼
   DSH 宿主桥                 另一个 harness 的无头 CLI
   /mcp/codex-bridge-v1       consult / review（只读）/ delegate（子主控）
         │
         ▼
   DSH Flash worker（每个写任务一个独立 worktree）
```

| 部分 | 位置 | 作用 |
|---|---|---|
| DSH 宿主桥 | `dsh-host/index.cjs`、`src/*` | DSH 插件，在 DSH 宿主上提供 MCP 端点 `/mcp/codex-bridge-v1`（默认 `http://127.0.0.1:3080`），用 bearer 令牌鉴权 |
| `dsh_project` | 各端插件清单（MCP server） | 各根主控均用 stdio 载体 `bin/bridge.mjs`，从各自凭据文件读取令牌，再转发到宿主 HTTP 端点 |
| `agent_peer` | `bin/peer-mcp.mjs`、`src/peer/*` | 用无头 CLI 在 Claude Code、Codex 与 Antigravity 之间做咨询 / 只读审查 / 子主控委派，带作业账本、链规则与收尾记录 |
| skills | `skills/agent-bridge-routing`、`skills/dsh-project-execution` | 路由规则与 DSH 执行规范 |

### DSH 宿主桥

宿主桥是一个 DSH 插件，在 DSH 宿主上挂载 MCP 端点 `/mcp/codex-bridge-v1`（默认 `http://127.0.0.1:3080`），只接受带正确 bearer 令牌的请求。它把任务作为有边界的任务包派给 DSH Flash worker：

- 每个写任务一个独立 git worktree，互不干扰；
- 任务包声明显式的读根、写根、工具白名单和预算；当前适配器拒绝 `allowShell: true`，worker 拿不到 shell；
- 网络也由任务包声明，只有被授予时才可用；
- 生命周期是 审查（review）→ 集成（integrate）→ 确认（acknowledge）→ 归档 / 清理（archive / cleanup），每一步都要求前一步的真实证据。

它暴露 20 个 `bridge_*` 工具（6 读、1 提交、13 变更；宿主 `bridge_capabilities` 报告的 `version` 是 **2.1.1**，与插件版本一致）：

- 任务：`bridge_submit`、`bridge_check`、`bridge_result`、`bridge_dossier`
- 授权：`bridge_approve`、`bridge_clarify`
- 追问：`bridge_followup`
- 控制：`bridge_cancel`、`bridge_reconcile`、`bridge_list`、`bridge_pause`、`bridge_resume`
- 收尾：`bridge_acknowledge`、`bridge_archive`、`bridge_cleanup`
- 目录：`bridge_models`、`bridge_capabilities`
- 工作区：`bridge_workspace_review`、`bridge_workspace_refresh`、`bridge_workspace_integrate`

每个工具只属于一个类别：读工具不看归属；`bridge_submit` 把任务绑定到当前控制器；变更工具要求任务属于当前控制器，或由管理员带 `override:{reason}` 越权（先写审计意图，再执行）。控制器身份、审计和迁移的完整说明见 [docs/controller-identity.md](docs/controller-identity.md)。

### dsh_project

`dsh_project` 在两侧都通过 `bin/bridge.mjs` 把 MCP stdio 转发到宿主 HTTP 端点。Claude 的必填文件选项 `bridge_credential_file`、Codex 的两个 MCP 条目分别通过 `DSH_BRIDGE_CREDENTIAL_FILE` 指向各自根凭据；两侧的 `agent_peer` 同样使用各自文件。根启动环境应清除 `DSH_MCP_TOKEN`，根请求不发送链路头。delegate 继续优先使用 peer server 显式注入的环境 token，并记录委派链路。

### agent_peer

`agent_peer`（`bin/peer-mcp.mjs`）用对方 harness 的无头 CLI（`codex exec` / `claude -p` / `agy --input-format stream-json --output-format stream-json`）运行另一个 harness，提供 9 个工具：

- `peer_capabilities`：我在链上的位置、现在能调谁、哪些模式被允许，以及每个 peer 的默认模型、默认思考强度和允许的思考强度列表（`defaultModel`、`defaultReasoningEffort`、`reasoningEfforts`）
- `peer_ask`、`peer_check`、`peer_result`、`peer_cancel`、`peer_list`：作业生命周期
- `record_closeout`、`record_list`：收尾记录与索引
- `cleanup_run`：清理临时会话（默认 dry run）

三种模式：`consult`（问答）与 `review`（独立审查）都是只读的，只给对端只读沙箱和只读工具集；`delegate`（子主控）才可能在 `cwd` / `addDirs` 里写。链规则由服务端强制，不靠提示词：不能把目标指向自己、不能调用链上已有的任何 harness（于是工作永远流不回根主控）、跳数上限默认 2、子主控委派深度默认 1。

每次 `peer_ask` 都可以为这一次运行单独指定 `model` 和 `reasoningEffort`，新建会话和用 `sessionId` 续接会话都生效，所以同一个任务可以在轮次之间切换模型和思考强度，不必改配置或重启 MCP server。优先级是：单次调用参数 > 配置默认值（`peers.codex.model` / `peers.codex.reasoningEffort`、`peers.claude-code.model` / `peers.claude-code.effort`）> CLI 自身默认值（不传任何值），单次 `reasoningEffort` 的取值匹配 `^[a-z][a-z0-9_-]{0,31}$`。每个作业记录（`job.json`、`peer_check` / `peer_result` 的作业快照、`peer_list` 行）都带 `model`（string|null）、`modelSource`、`reasoningEffort`（string|null）、`effortSource`，来源取值 `call` / `config` / `cli-default`，表示实际传给 CLI 的内容（没传时是 `null` + `cli-default`）；closeout 记录显示为 `- 模型: <model or 'CLI 默认'>（<source>） · 思考强度: <effort or 'CLI 默认'>（<source>）`，没有这些字段的旧作业显示原有的缺失标记。

`record_closeout` 为每个根任务写一份 Markdown 记录到 `<project>/.agent-bridge/records/`，并通过 `.git/info/exclude` 排除出版本库（不改项目自己的 `.gitignore`），同时往外部索引 `<stateDir>/records-index.jsonl` 追加一条事件。之后清扫器会自动清理临时的 peer / DSH 会话：**已被记录接受的 3 天后**、**failed / disputed / unresolved 的 30 天后**，`keep` 的永不清理；DSH 会话没有删除 API，因此是归档后清理。索引是会话 id 的唯一来源，记录文件缺失时不会清理任何会话。

### Skills

- `agent-bridge-routing`：谁做什么（默认把量给 DSH、把判断给另一个 harness）、一任务一根主控、防环形委派、跨模型互证协议。
- `dsh-project-execution`：如何把工作拆成任务包、理解门、并行 worktree、按精确提交审查、集成已验证的 head、清理自有任务。

### 关于 "codex-bridge" 这个标识

为了兼容已有安装，持久化标识仍然是旧的：端点 `/mcp/codex-bridge-v1`、任务 origin、宿主包名 `@local/dsh-codex-bridge-v1`、宿主插件 id `dsh-codex-bridge-v1`，宿主配置 `ownerId` 的缺省值也是 `codex-bridge-v1`。它们都保持原值，旧任务库和 worktree 可以继续用。

## 环境要求

- **DSH 0.2.0-rc.2**（本项目正是在这个版本上验证的）。下文以宿主监听 `127.0.0.1:3080` 为例；你的 DSH 监听别的端口时，相应修改 `dsh_bridge_url` / `bridgeUrl`。
- **Node.js 24 及以上**。不需要在 PATH 里，用绝对路径的 `node.exe` 即可。
- **Windows**（已实测；其他平台有代码路径但未验证）。
- **Claude Code 和/或 Codex**。
- peer 调用要求每一侧的无头 CLI 各自登录过一次。
- 每个根控制器一个 bearer 令牌文件（宿主配置 `controllers[].tokenFile`），通过各自 MCP 配置的 `DSH_BRIDGE_CREDENTIAL_FILE` 读取。清除用户级和根进程级 `DSH_MCP_TOKEN`；禁止把 token 放入持久环境变量。设置后完全退出并重开 Claude / Codex。

## 安装

### 1. DSH 宿主桥

先看现状：在已连通的 Claude / Codex / Antigravity 里调用 `bridge_capabilities`。**只有**返回的 `controllerIdentity.enabled === true` 且 `controllerIdentity.schemaVersion === 1` 时，才说明宿主已经运行控制器身份版本，可以跳过本节；缺任一项（例如旧版没有 `controllerIdentity`，或 `schemaVersion` 不是 1）就按下面替换旧安装。不要用 `version` 字段代替这两项检查；当前宿主与插件都应报告 `2.1.1`，但版本字符串本身不是身份能力的证据。

替换旧安装时：

1. 先**停掉 DSH**。
2. 升级前备份 `<DSH_HOME>/codex-bridge-v1`（任务库和 worktree）。
3. 删掉旧安装，再装新的：

```bash
node scripts/uninstall.mjs --profile <DSH_HOME>/profiles/web --json
node scripts/install.mjs --source <本仓库目录> --profile <DSH_HOME>/profiles/web \
  --host-config <宿主配置.json> --require-host-entry --json
```

两个脚本都支持 `--dry-run`（`--plan` 同义）先看计划。`uninstall.mjs` 需要 `--profile`；`install.mjs` 需要 `--source` 和 `--profile`，`--host-config` 把非机密的宿主设置嵌进它拥有的 loader 行，`--require-host-entry` 在宿主入口缺失时直接失败。安装只在指定的 profile 目录内写入。

4. 启动 DSH。

从共享 `credentialFile` 升级到控制器身份（`controllers`）时，按 [docs/controller-identity.md](docs/controller-identity.md) 执行：停止新任务 → 排空整机 → 停止并备份旧包、配置、数据库及令牌材料 → 安装新包并以保留 `legacy` 的完整 overlap 配置重启 → 切换客户端 → 两个真实根及双向 delegate 冒烟 → 再次排空 → 移除 `legacy` 并重启 → 确认旧令牌返回 401、新身份正确 → 恢复接单。客户端切换须等兼容宿主就绪；整个窗口持续停止普通任务提交。

宿主配置示例（字段见下方，路径用你自己的；完整校验规则见 [docs/controller-identity.md](docs/controller-identity.md)）：

```json
{
  "dataDirectory": "<DSH_HOME>/codex-bridge-v1",
  "ownerId": "<owner-id>",
  "controllers": [
    { "id": "claude-code", "tokenFile": "<私有目录>/credentials/claude-code.token" },
    { "id": "codex", "tokenFile": "<私有目录>/credentials/codex.token" },
    { "id": "operator", "tokenFile": "<私有目录>/credentials/operator.token", "admin": true }
  ],
  "identityMigrationBackupDirectory": "F:/temp/agent-bridge-upstream/backups",
  "maxConcurrent": 4,
  "retention": { "successDays": 7, "failureDays": 30 },
  "gitExecutable": "C:/Program Files/Git/cmd/git.exe",
  "rootCallbackGrants": { "claude-main": { "targetId": "claude-code:main" } },
  "eventWake": {
    "enabled": true,
    "stateRoot": "<DSH_HOME>/codex-bridge-v1/wake-state",
    "maxSummaryChars": 8192,
    "claimLeaseMs": 30000
  }
}
```

- `ownerId` 是持久化身份：沿用已有安装的值，否则旧任务认领不到。缺省值是 `codex-bridge-v1`。
- `controllers` 是必填数组（1–32 项）。每个控制器有自己的 bearer 令牌文件；`id` 匹配 `^[a-z][a-z0-9-]{0,63}$` 且唯一，`tokenFile` 是绝对本地路径，文件内容去掉外围空白后必须是 24–512 个可打印 ASCII 字符且内部无空白（新令牌用 `randomBytes(32)` 生成 64 位十六进制）。重复令牌或弱令牌会拒绝启动；`admin: true` 只给真正需要越权审计的 `operator`。配置里只保存路径，不保存令牌。
- `identityMigrationBackupDirectory`：已有旧任务库（`user_version=0`，且必须是已发布的 v0 表结构：`tasks(id,owner,idem,hash,body,UNIQUE(owner,idem))`，无 `submittedBy`）迁移到控制器身份前必需；宿主会先做一致性快照再迁移。`user_version=1` 必须匹配已发布的 v1 表结构（含 `submittedBy` 和 `UNIQUE(owner,submittedBy,idem)`）；版本与表结构不匹配（例如 `user_version=0` 却已是 v1 表形）会被 `STORE_SCHEMA_UNSUPPORTED` 拒绝，不猜测修复。全新的空库（`user_version=0` 且没有任何 schema 对象）直接建 v1。旧的顶层 `token` / `credentialFile` / `tokenEnv` 认证字段会被拒绝，必须迁移到 `controllers`。
- 客户端各用自己那份令牌文件，两个 MCP 入口都通过 `DSH_BRIDGE_CREDENTIAL_FILE` 指向它。部署工具生成缺失的令牌文件，配置仅保存路径，已存在的文件只校验、不覆盖：

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > <私有目录>/credentials/<controller-id>.token
  ```

- `maxConcurrent` 缺省 4。
- `retention` 是 DSH 任务会话的保留期（缺省 7 / 30 天），与下面 agent-peer 记录的 3 / 30 天是两套策略。
- `rootCallbackGrants`、`eventWake` 是可选的控制器唤醒配置，不写就是关闭。`eventWake.maxSummaryChars` 如果给出，必须正好是 8192（默认值），这是固定的线路上限。

### 2. 从 GitHub 安装 Claude Code 插件

```bash
claude plugin marketplace add <owner>/agent-bridge
claude plugin install agent-bridge@agent-bridge
claude plugin configure agent-bridge@agent-bridge
```

市场名和插件名都来自 `.claude-plugin/marketplace.json`（`agent-bridge` / `agent-bridge`）。`configure` 不带参数时只显示选项和哪些还没设；要写入，就把一个 JSON 对象从标准输入传给 `--values-stdin`，没写到的选项保持原值：

```bash
echo '{"node_path":"C:/Program Files/nodejs/node.exe","peer_config":"<路径>/agent-peer-claude-code.json","bridge_credential_file":"<私有目录>/credentials/claude-code.token"}' | claude plugin configure agent-bridge@agent-bridge --values-stdin
```

四个选项：

- `node_path`：Node 24 的 `node.exe` 绝对路径（默认值是字面量 `node`）。
- `peer_config`：agent-peer 配置文件的绝对路径（见第 5 小节）。
- `dsh_bridge_url`：默认 `http://127.0.0.1:3080/mcp/codex-bridge-v1`。
- `bridge_credential_file`：必填，单个文件路径，指向 Claude 根自己的令牌文件；两个 MCP server 都会使用它。

然后**完全退出并重开 Claude 桌面版**。

**踩坑**：如果 MCP server 起不来，报 `'node' is not recognized` 或 `CONNECTION_CLOSED`，那是 Claude 桌面版用默认的字面量 `node` 去启动 `agent_peer` 了——桌面版的 PATH 里通常没有 node。也可能是它还在跑插件缓存里的旧副本。不要手改缓存，直接用第 3 小节的部署脚本：它把本机路径写进**部署副本**的插件默认值里，并刷新 Claude Code 的插件缓存。

### 3. 本地部署与客户端切换（Claude Code + Codex）

适合没有 git 历史的解压包，也适合已经手工配置过的机器。克隆或下载本仓库后：

1. 复制 `scripts/deploy.example.json` 到仓库外，改成本机路径。必填三项：`deployRoot`（部署根，下面会有 `plugin/`、`config/`、`state/` 和 Claude 的本地插件市场）、`nodePath`、`bridgeUrl`。可选：`repo`（导出这个 git 仓库的 HEAD，缺省则直接复制包目录）、`gitExecutable`、`peerConfig`、`identity`（`credentialDirectory`、`migrationBackupDirectory`、可选 `legacyTokenFile`；启用 identity 时旧的共享 `credentialFile` 配置会被拒绝；它生成的是要合并进完整宿主配置的 `controllers` + `identityMigrationBackupDirectory` 片段，并为两个根分别生成自己的 peer 配置）、`codexPluginDir`、`codexExecutable`、`codexPluginId`、`codexMarketplace`、`claudeExecutable`、`claudePluginId`。可执行文件路径可以用整段的 `*`，脚本取最新匹配的那份（两个桌面端都把 CLI 放在随更新变化的版本/哈希目录里）。
2. 身份迁移先生成隔离的准备包：

```bash
node scripts/deploy-local.mjs --config <你的 deploy.json> --prepare-only --dry-run
node scripts/deploy-local.mjs --config <你的 deploy.json> --prepare-only
```

`--prepare-only` 创建独立的 `<deployRoot>/plugin.prepared-*`，返回供切换使用的目录，并生成身份产物：缺失的 token 文件、各根 peer 配置、overlap/final 宿主片段及可选启动器。已存在的有效 token 保留原样；各根 peer 配置共用 `stateDir`、引用各自文件，已有配置不匹配会拒绝。准备阶段保留现有 `plugin/`、`plugin.prev/`、市场、客户端缓存与配置，不启动应用 CLI。`--dry-run` 不写文件、不生成 token。

普通本地安装仍可省略 `--prepare-only` 执行完整部署；完整部署会同步 Codex 配置并按配置刷新 Claude 插件缓存。现有客户端的 R8 迁移使用本节准备包和切换脚本，以便先备份实际安装内容。

3. 在 overlap 宿主就绪后切换客户端。先保存工作，完全退出 Claude、Codex 及其 MCP 子进程，再执行：

```bash
node scripts/switch-controller-clients.mjs --config <你的 deploy.json> --prepared-plugin <返回的准备包目录>
node scripts/switch-controller-clients.mjs --config <你的 deploy.json> --prepared-plugin <返回的准备包目录> --apply
```

首条默认 dry-run，可显式加 `--dry-run`。脚本定位实际安装配置，检测到 Machine 级 `DSH_MCP_TOKEN` 或残留进程会停止；它将文件和旧 User 变量状态备份到仅当前用户可读的 `F:/temp/agent-bridge-upstream/deploy-p0b/client-backups/<时间戳>`，更新实际缓存里的运行文件、技能和配置，保留无关设置，清除 User 与自身进程的共享 token。Claude 安装记录同步版本，已有缓存目录名保持原值。重跑跳过相同内容并保留首次备份。回滚预览用 `node scripts/switch-controller-clients.mjs --rollback <备份目录>`，实际恢复再加 `--apply`；客户端回滚不恢复数据库。

4. 从开始菜单等普通入口重启两个应用，完成必要的插件启用，验证各自 `bridge_capabilities.controllerIdentity.self` 和 `admin:false`，再做双向委派冒烟。可选启动包装器位于返回的准备包目录 `config/launch-*.mjs`，仅设置文件路径；原有 live 包装器保留原样，CLI 包装启动请使用准备包里的新路径。详见[切换步骤与变更清单](docs/controller-identity.md#4-switch-the-windows-clients)。

### 4. 手工安装 Codex（不使用第 3 小节时）

1. 把本仓库的 `skills/`、`.codex-plugin/`、`.codex-mcp.json`、`bin/`、`src/` 等放进插件目录 `~/.agents/plugins/plugins/agent-bridge`。仓库里的模板 `.codex-plugin/plugin.json` 指向 `./.codex-mcp.json`，装成机器插件时把它的 `mcpServers` 改成 `./.mcp.json`（部署脚本就是这么改的）。
2. 在插件目录里放一份机器专用的 `.mcp.json`，内容以 `.codex-mcp.json` 为基础。该模板有两个 stdio 入口，两个都要手工改成绝对路径：`dsh_project` 的 `command` 设为 node 的绝对路径、`args` 指向插件目录里 `bin/bridge.mjs` 的绝对路径；`agent_peer` 的 `command` 同样设为 node 的绝对路径、`args` 指向插件目录里 `bin/peer-mcp.mjs` 的绝对路径，并把 `AGENT_PEER_CONFIG` 改成**Codex 自己**的 peer 配置文件绝对路径。两个入口的 `env` 都设置 `DSH_BRIDGE_CREDENTIAL_FILE` 为 Codex 文件路径，并设置相同的 `DSH_BRIDGE_URL`；保留 `env_vars` 中 delegate token 与链路变量的转发。模板里的 `default_tools_approval_mode: "approve"` 是 `codex exec` 里调用 MCP 工具所必需的，别删。
3. 在 `~/.agents/plugins/marketplace.json` 里加一条市场条目，`path` 用相对用户主目录的路径。
4. 安装插件：

```bash
codex plugin add agent-bridge@personal
```

### 4b. Antigravity 插件与无头 CLI

Antigravity 既可以作为**根主控**，也可以通过无头 `agy` CLI 作为**被调用端（peer target）**：

- **自动部署（按需启用）**：在 `deploy.json` 中加上 `antigravityPluginDir`（例如 `C:/Users/<you>/.gemini/config/plugins/agent-bridge`）和/或 `antigravityExecutable`（例如 `C:/Users/<you>/AppData/Local/agy/bin/agy.exe`），再运行 `node scripts/deploy-local.mjs --config <deploy.json>`。未配置这两个字段时部署产物与纯 Claude+Codex 完全一致；配置后脚本会自动生成 `antigravity.token`、`agent-peer-antigravity.json`、`launch-antigravity.mjs`、把 `antigravity` 写入宿主片段 `controllers`，并把原生插件（`plugin.json`、`mcp_config.json`、`skills/`、`agents/agent-bridge-readonly.md`、`agents/agent-bridge-readonly-web.md`）部署到 `antigravityPluginDir` 且执行 `agy plugin validate`。
- **只读与委派边界**：`consult` / `review` 会传递 `--disable-slash-commands`、可选只读 agent（默认纯本地 `agent-bridge-readonly`，仅保留 `read_file`；主控在 `peer_ask` 显式传 `webSearch: true` 时切到 `agent-bridge-readonly-web`，增加 `search_web`）和会话级 `--settings`（`allowNonWorkspaceAccess: false` 且拒绝 `write_file(*)`、`command(*)`、`mcp(*)`、`execute_url(*)`、`download_url(*)`）。`peer_ask.webSearch` 开关同样支持 `claude-code`（控制 `WebSearch`/`WebFetch`），对 `codex` 与 `delegate` 模式明确拒绝（`PEER_ARGS_INVALID`）。`delegate` 模式与 Codex 一致：保留 Antigravity 已安装的插件/MCP 配置，通过 `delegateMode`（`accept-edits` 或 `auto`）、可选 `--sandbox`（`delegateSandbox: true`）和 `delegateAllowedPermissions`（默认放行 `mcp(agent-bridge_dsh_project/*)` 与 `mcp(agent-bridge_agent_peer/*)`）运行，并继承根控制器凭据与委派链。
- **会话清扫**：`records.antigravityDataDir`（默认 `~/.gemini/antigravity-cli`）下的临时 CLI 会话（`conversations/<id>.db`、`brain/<id>/`、`presence/<id>.lock`）会在收尾记录到期后被清扫器自动删除。

### 5. agent-peer 配置

每个根使用**自己独立的** agent-peer 配置文件：Claude 的 `peer_config` 指向 `config/agent-peer-claude-code.json`，Codex 的 `AGENT_PEER_CONFIG` 指向 `config/agent-peer-codex.json`。两份配置共用同一个 `stateDir`（因此两边看到同一个作业账本和链账本），但 `bridge.credentialFile` 分别指向该根自己的控制器令牌文件（`credentials/claude-code.token` / `credentials/codex.token`）。不要把一份带 `credentialFile` 的配置文件同时交给两个根，否则一个根会读到另一个根的凭据。下面是一份模板，把 `<root-controller-id>` 和路径换成该根自己的值；部署工具会为每个根生成一份。如果机器上已经有旧的单一 `config/agent-peer.json`，部署工具会以它为底本为每个根创建缺失的 peer 配置，并把 `bridge.credentialFile` 指向该根自己的令牌文件；已存在的 per-root 配置只校验、不改写。

```json
{
  "schemaVersion": 1,
  "stateDir": "<deployRoot>/state",
  "peers": {
    "codex": {
      "executable": "C:/Users/<you>/AppData/Local/OpenAI/Codex/bin/*/codex.exe",
      "delegateSandbox": "workspace-write",
      "readOnlyDisablePlugins": ["agent-bridge@personal"],
      "threadSection": "Agent Bridge",
      "threadNamePrefix": "[agent-bridge]"
    },
    "claude-code": {
      "executable": "C:/Users/<you>/AppData/Roaming/Claude/claude-code/*/*/claude.exe",
      "delegatePermissionMode": "acceptEdits",
      "delegateAllowedTools": [
        "mcp__plugin_agent-bridge_dsh_project",
        "mcp__plugin_agent-bridge_agent_peer",
        "Bash"
      ]
    },
    "antigravity": {
      "executable": "C:/Users/<you>/AppData/Local/agy/bin/agy.exe",
      "readOnlyAgent": "agent-bridge-readonly",
      "readOnlyWebAgent": "agent-bridge-readonly-web",
      "delegateMode": "accept-edits",
      "delegateAllowedPermissions": [
        "mcp(agent-bridge_dsh_project/*)",
        "mcp(agent-bridge_agent_peer/*)"
      ]
    }
  },
  "records": {
    "enabled": true,
    "dirName": ".agent-bridge/records",
    "retainDays": 3,
    "disputedRetainDays": 30,
    "sweepIntervalMinutes": 60,
    "claudeProjectsDir": "C:/Users/<you>/.claude/projects",
    "antigravityDataDir": "C:/Users/<you>/.gemini/antigravity-cli"
  },
  "bridge": { "url": "http://127.0.0.1:3080/mcp/codex-bridge-v1", "credentialFile": "<私有目录>/credentials/<root-controller-id>.token" },
  "limits": { "timeoutMs": 1800000, "maxConcurrentJobs": 3 }
}
```

主要字段：

- `stateDir`：作业账本、链账本和记录索引的位置。
- `peers.<name>.executable`：对端无头 CLI 的绝对路径，可用整段 `*` 选最新版本；必须是真实可执行文件，不能是 `.cmd` / `.bat` 包装（否则配置被拒）。
- `peers.codex.delegateSandbox`：`delegate` 模式的 Codex 沙箱（`read-only` 或 `workspace-write`）。`readOnlyDisablePlugins` 在只读模式下禁用指定插件，防止审查者通过 MCP 工具动手。
- `peers.codex.model` / `peers.codex.reasoningEffort`、`peers.claude-code.model` / `peers.claude-code.effort`、`peers.antigravity.model` / `peers.antigravity.effort`：可选，只是**默认值**，单次 `peer_ask` 可以用同名参数覆盖；都不传时用 CLI 自身的默认。
- `peers.<target>.efforts`：可选，替换该目标的允许思考强度列表（1 到 16 个唯一字符串，每个匹配 `^[a-z][a-z0-9_-]{0,31}$`）。不写时用内置列表：codex `minimal, low, medium, high, xhigh, max, ultra`，claude-code / antigravity `low, medium, high, xhigh, max`。列表外的单次值被拒为 `PEER_ARGS_INVALID`（字段 `reasoningEffort`），列表外的配置默认值被拒为 `PEER_CONFIG_INVALID`。
- `peers.claude-code.delegatePermissionMode` / `delegateAllowedTools`：`delegate` 模式的权限模式与允许的工具；`review` / `consult` 走只读工具集与 `--no-session-persistence`。
- `peers.antigravity.readOnlyAgent` / `readOnlyWebAgent` / `delegateMode` / `delegateSandbox` / `delegateAllowedPermissions`：纯本地只读 agent、带联网搜索的只读 agent、`delegate` 执行模式（`accept-edits` / `auto`）、是否加 `--sandbox`，以及 `delegate` 放行的 Antigravity 权限规则。
- `records`：记录目录名、接受后的保留天数、失败/争议的保留天数、清扫间隔、Claude 会话目录、Antigravity CLI 数据目录（`antigravityDataDir`）。
- `bridge`：清扫器使用的 DSH 端点。根通过 `DSH_BRIDGE_CREDENTIAL_FILE` 或自己的 `credentialFile` 读文件；delegate 继续优先使用显式注入的 `DSH_MCP_TOKEN`。
- `limits`：超时、并发等上限。

配置里没有自由形状的参数列表：每个 CLI flag 都由校验过的字段生成，所以配置无法重新打开只读沙箱。

## 验证

1. 调用 `bridge_capabilities`：宿主返回的 `version` 应是 `2.1.1`（与插件版本一致）。`controllerIdentity.self` / `admin` 应与你使用的控制器令牌一致，`controllers` 列出已配置的 ID，`controllerIdentity.enabled` 为 `true` 且 `schemaVersion` 为 `1`。
2. 调用 `peer_capabilities`：Claude 端 `self` 应是 `claude-code`，Codex 端应是 `codex`；`chain` 显示自己在链上的位置，每个 peer 的每个模式会明确告诉你是否允许，以及不允许时的错误码。
3. 双向各跑一个可丢弃 delegate。Claude → Codex：确认 delegate 继承的是根（Claude）的非管理员身份和 `via` 链，并能完成一个便宜的 DSH 提交；Codex 一侧保留自己的 MCP 配置，不要断言“Codex 排除了用户的其他 MCP server”。Codex → Claude：确认 Claude Code delegate 只看到插件的两个 MCP server、用户其他 MCP server 不出现（这是 1.7.0 之后的明确收窄），且它仍能完成一个便宜的 DSH 提交。

## 用法

几种可以直接打出来的请求：

1. 交给 DSH 实现：*"把这个改动拆成有边界的任务交给 DSH：只允许改 `src/foo/`，验收是 `npm test` 通过，跑完把 diff 和测试输出给我。"*
2. 让另一个 harness 独立审查：*"让 Codex 独立 review 这个 commit 的正确性，不要告诉它作者是谁，也不要给它我的结论。"*
3. 指定思考强度做独立审查：*"让 Codex 以 xhigh 思考强度独立 review 这个 commit，不要告诉它作者是谁，也不要给它我的结论。"*
4. 让 Codex 当子主控：*"这个子项目交给 Codex 当子主控，它可以用自己的 subagent 和 DSH，范围是 `packages/parser/`，结果返回给我集成。"*
5. 收尾并清理：*"收尾这个根任务：写 closeout 记录，然后 dry run 一次清理，确认后再执行。"*

规则只有一条：**你在对话的那个 harness 是这个任务的根主控**，它独自拥有需求、接口合同、授权、验收与集成，交出去的每一件东西都只能作为结果回到它这里。别人不能跳过它去改需求，也不能把工作再委托回它。

## 安全模型

- **令牌与归属**：每个控制器一个 bearer 令牌文件，宿主只接受正确令牌，并据此确定请求主体；`task.submittedBy` 由服务端写入且不可变。读工具不限制归属；变更工具要求本人任务，或管理员带显式 `override:{reason}`（先持久化审计意图，再执行，最后写结果审计）。管理员令牌不会传给子进程。
- **历史任务与越权**：历史任务 `submittedBy:null`，只有管理员加非空原因（≤500 字符）才能变更；`metadata.controller`、`parentTaskId` 和 `via` 都只是审计/协调信息，不是权限。
- **委派继承根凭据**：delegate 继承根控制器（非管理员）的凭据，其任务属于根主体；同一控制器的会话共享权限，delegate 可以修改同一根主体的其他任务——这是“同机协作 agent”威胁模型内已接受的边界。最终验收仍由根控制器负责。
- **DSH 任务不能开 shell**：当前适配器直接拒绝 `allowShell: true`，不给绕过口。
- **路径围栏**：worker 只能读 `scope.readRoots`、写 `writeRoots`；越界是明确的拒绝，不是提示。
- **网络**：只有任务包显式授予时才可用。
- **只读 peer 不能写**：`consult` / `review` 给对端只读沙箱和只读工具集，并禁用可能动手的插件；Claude 一侧只读运行不留会话。
- **只有 Claude Code delegate 的 MCP 面收窄**：当 Claude Code 是 delegate（包括 Codex → Claude）时，它使用 `--strict-mcp-config`，MCP 配置只含插件的两个入口，用户自己的其他 MCP server 被有意排除（相对 1.7.0 的明确变化）。Claude → Codex 时 Codex delegate 不使用这项两入口限制：该方向的冒烟只验证它继承根身份/载体并能提交，不声称它排除了其他 MCP server；升级后按“验证”一节做双向冒烟。
- **凭据不回落**：delegate 或子进程缺少环境令牌时，carrier 和 peer client 直接拒绝，不读本机凭据文件兜底；令牌不写入作业记录、prompt、argv 或日志。
- **委派链强制**：不能指向自己、不能调用链上已有的 harness、跳数与 delegate 深度有上限；非法链直接拒绝而不是修补。
- **清理只清记录过的会话**：清扫器只动收尾记录里列出的会话，且记录文件必须存在；不在记录里的会话永远不动。
- **数据不出机器**：除各 harness 本来就在做的模型调用外，没有别的东西离开这台机器。

## 已知限制

- 只在 **Windows** 上验证过；其他平台的代码路径存在但未测试。
- **DSH 0.2.0-rc.2 是预览版**，API 可能变化。
- 自动清扫只在**开着带插件的 Claude Code 或 Codex 会话时**运行。
- 无头 CLI 必须先各自登录过一次，否则 peer 调用失败。

## 文档

- [docs/controller-identity.md](docs/controller-identity.md)：控制器身份、凭据与令牌文件、6/1/13 工具分类与越权审计、client-declared `via`、存储迁移、升级/回滚与双向冒烟
- [docs/reference/dsh-bridge-reference.zh.md](docs/reference/dsh-bridge-reference.zh.md)：宿主桥的深入说明（中文，1.2/1.3 时期的技术参考）
- [docs/event-wake.md](docs/event-wake.md)：事件唤醒（durable outbox → 控制器）
- [docs/long-supervisor.md](docs/long-supervisor.md)：长任务 supervisor（edition 1）
- [docs/recurrent-supervisor.md](docs/recurrent-supervisor.md)：有界循环 supervisor（edition 2）
- [docs/deadline-watchdog.md](docs/deadline-watchdog.md)：一次性截止时间看门狗
- [CONTRACTS.md](CONTRACTS.md)：稳定导出的实现基线
- [CHANGELOG.md](CHANGELOG.md)：逐版本变更与已知边界

## 开发

```bash
npm install    # 只装开发依赖 @deepseek-ai/dsh-llm（适配器测试用）
npm test       # node --test test/*.test.mjs
```

CI 在 Windows + Node 24 上跑（`.github/workflows/test.yml`）。

本项目自己的大部分代码就是通过这座桥写出来的：DSH Flash worker 实现，Claude Code 负责审查、测试与集成——提交作者与 `CHANGELOG.md` 的版本记录都可以看出来。

## 许可证

MIT，见 [LICENSE](LICENSE)。
