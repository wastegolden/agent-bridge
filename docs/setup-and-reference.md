中文 | [English](setup-and-reference.en.md)

# Agent Bridge 详细安装、配置与技术参考

本文档面向需要完成完整部署、手工配置、参数调优或从旧版本迁移的用户。如果你只想快速了解 Agent Bridge 是什么、能用来做什么，请先看根目录的 [README.md](../README.md)。

> 版本基线：**2.1.1**（Node.js 24+，已在 Windows + DSH 0.2.0-rc.2 验证）。

---

## 目录

- [1. DSH 宿主桥安装与配置](#1-dsh-宿主桥安装与配置)
- [2. 推荐：本地一键部署（Claude Code + Codex + Antigravity）](#2-推荐本地一键部署claude-code--codex--antigravity)
- [3. 从 GitHub 单独安装 Claude Code 插件](#3-从-github-单独安装-claude-code-插件)
- [4. 手工安装 Codex 插件](#4-手工安装-codex-插件)
- [5. Antigravity 插件与无头 CLI 细节](#5-antigravity-插件与无头-cli-细节)
- [6. agent-peer 配置文件参考](#6-agent-peer-配置文件参考)
- [7. 安装后验证与双向冒烟](#7-安装后验证与双向冒烟)
- [8. MCP 工具清单](#8-mcp-工具清单)
- [9. 安全边界与设计细节](#9-安全边界与设计细节)
- [10. 历史兼容标识说明](#10-历史兼容标识说明)

---

## 1. DSH 宿主桥安装与配置

如果你只需要 Claude Code / Codex / Antigravity 之间通过 `agent_peer` 互相调用，不接入 DSH，可跳过本节。

### 检查当前宿主状态

在已连通的客户端里调用 `bridge_capabilities`：

- **只有**当返回的 `controllerIdentity.enabled === true` 且 `controllerIdentity.schemaVersion === 1` 时，才说明宿主已经运行支持独立控制器身份的新版，可以跳过安装。
- 缺任一项（例如旧版没有 `controllerIdentity`，或 `schemaVersion` 不是 `1`）就需要替换旧安装。不要仅凭 `version` 字段判断能力。

### 安装或替换 DSH 宿主插件

1. **停掉 DSH**。
2. 升级前先备份 `<DSH_HOME>/codex-bridge-v1`（包含任务库与 worktree）。
3. 卸载旧版并安装新版（支持先加 `--dry-run` / `--plan` 预览）：

```bash
node scripts/uninstall.mjs --profile <DSH_HOME>/profiles/web --json
node scripts/install.mjs --source <本仓库目录> --profile <DSH_HOME>/profiles/web \
  --host-config <宿主配置.json> --require-host-entry --json
```

`--host-config` 会把非机密的宿主设置写入安装脚本管理的 loader 行，`--require-host-entry` 在宿主入口缺失时直接失败。所有写入都限定在指定的 profile 目录内。

4. 重新启动 DSH。

> 如果你是从旧版共享 `credentialFile` 升级到每控制器独立令牌（`controllers`），请严格按 [controller-identity.md](controller-identity.md) 的平滑切换流程执行（停新单 → 排空 → 备份 → overlap 配置重启 → 切换客户端 → 冒烟 → 再次排空 → 移除 `legacy`）。

### 宿主配置示例

```json
{
  "dataDirectory": "<DSH_HOME>/codex-bridge-v1",
  "ownerId": "<owner-id>",
  "controllers": [
    { "id": "claude-code", "tokenFile": "<私有目录>/credentials/claude-code.token" },
    { "id": "codex", "tokenFile": "<私有目录>/credentials/codex.token" },
    { "id": "antigravity", "tokenFile": "<私有目录>/credentials/antigravity.token" },
    { "id": "operator", "tokenFile": "<私有目录>/credentials/operator.token", "admin": true }
  ],
  "identityMigrationBackupDirectory": "<私有目录>/backups",
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

关键字段说明：

- `ownerId`：持久化身份，默认 `codex-bridge-v1`。升级时务必沿用旧值，否则认领不到历史任务。
- `controllers`：必填（1–32 项）。每个控制器拥有独立的 bearer 令牌文件；`id` 匹配 `^[a-z][a-z0-9-]{0,63}$` 且唯一，`tokenFile` 必须是本地绝对路径，内容去掉首尾空白后为 24–512 个可打印 ASCII 字符且内部无空白。重复或弱令牌会被拒绝启动；`admin: true` 只给需要越权审计的 `operator`。配置里只存路径，不存令牌明文。
- 生成令牌文件的参考命令（使用本地部署脚本时会自动为缺失项生成，已存在的有效文件不会覆盖）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > <私有目录>/credentials/<controller-id>.token
```

- `identityMigrationBackupDirectory`：从旧版 v0 任务库（`user_version=0`）迁移到控制器身份前必填，宿主会先做一致性快照。全新空库直接建 v1；版本与表结构不匹配会被 `STORE_SCHEMA_UNSUPPORTED` 拒绝。旧顶层认证字段（`token` / `credentialFile` / `tokenEnv`）已被拒绝。
- `maxConcurrent`：默认 `4`。
- `retention`：DSH 任务会话保留期（默认成功 7 天、失败 30 天），与 `agent-peer` 收尾记录的清理策略相互独立。
- `rootCallbackGrants` / `eventWake`：可选的事件唤醒配置，缺省关闭。若设置 `eventWake.maxSummaryChars`，必须是固定上限 `8192`。

---

## 2. 推荐：本地一键部署（Claude Code + Codex + Antigravity）

适用于本机直接部署或已有手工配置的机器，也能避免桌面端找不到 `node`、插件缓存过期等常见坑。

### 步骤一：准备 `deploy.json`

复制 `scripts/deploy.example.json` 到仓库外部，按本机路径修改：

- **必填项**：`deployRoot`（部署根目录，下设 `plugin/`、`config/`、`state/` 和本地市场）、`nodePath`（Node 24 的 `node.exe` 绝对路径）、`bridgeUrl`。
- **常用可选项**：
  - `repo`：导出指定 git 仓库的 `HEAD`；不填则直接复制当前目录。
  - `gitExecutable`、`peerConfig`。
  - `identity`：包含 `credentialDirectory`、`migrationBackupDirectory` 和可选 `legacyTokenFile`，用于为各根主控生成独立令牌文件、各自的 `agent-peer-*.json` 以及宿主配置片段。
  - `codexPluginDir`、`codexExecutable`、`codexPluginId`、`codexMarketplace`。
  - `claudeExecutable`、`claudePluginId`。
  - `antigravityPluginDir`、`antigravityExecutable`（按需填写，不填则不生成 Antigravity 产物）。

> 桌面端 CLI 常位于随版本变化的目录中，可执行文件路径支持整段 `*` 通配符，脚本会自动挑选最新匹配项。

### 步骤二：执行部署

**全新本地部署**：

```bash
node scripts/deploy-local.mjs --config <你的 deploy.json> --dry-run
node scripts/deploy-local.mjs --config <你的 deploy.json>
```

**旧版客户端平滑迁移（身份升级）**：

1. 先生成隔离准备包（不改动现有运行目录与客户端缓存）：

```bash
node scripts/deploy-local.mjs --config <你的 deploy.json> --prepare-only --dry-run
node scripts/deploy-local.mjs --config <你的 deploy.json> --prepare-only
```

2. 等 overlap 宿主就绪后，保存工作并**完全退出** Claude、Codex 及残留的 MCP 子进程，再执行切换（首次默认 dry-run，确认后加 `--apply`）：

```bash
node scripts/switch-controller-clients.mjs --config <你的 deploy.json> --prepared-plugin <返回的准备包目录>
node scripts/switch-controller-clients.mjs --config <你的 deploy.json> --prepared-plugin <返回的准备包目录> --apply
```

脚本会检测是否存在残留进程或 Machine 级 `DSH_MCP_TOKEN`，自动备份原有文件与旧 User 环境变量状态，更新缓存里的运行文件、技能和配置，并清除共享 token。如需回滚，可执行：

```bash
node scripts/switch-controller-clients.mjs --rollback <备份目录>
node scripts/switch-controller-clients.mjs --rollback <备份目录> --apply
```

（客户端回滚不会恢复数据库。）详见 [controller-identity.md](controller-identity.md#4-switch-the-windows-clients)。

---

## 3. 从 GitHub 单独安装 Claude Code 插件

```bash
claude plugin marketplace add wastegolden/agent-bridge
claude plugin install agent-bridge@agent-bridge
claude plugin configure agent-bridge@agent-bridge
```

写入配置项（通过 `--values-stdin` 传入 JSON，未提供的字段保持原值）：

```bash
echo '{"node_path":"C:/Program Files/nodejs/node.exe","peer_config":"<路径>/agent-peer-claude-code.json","bridge_credential_file":"<私有目录>/credentials/claude-code.token"}' | claude plugin configure agent-bridge@agent-bridge --values-stdin
```

四个配置项：

- `node_path`：Node 24 的 `node.exe` 绝对路径（默认字面量 `node`）。
- `peer_config`：Claude Code 专用的 `agent-peer` 配置文件绝对路径。
- `dsh_bridge_url`：默认 `http://127.0.0.1:3080/mcp/codex-bridge-v1`。
- `bridge_credential_file`：必填，指向 Claude Code 自己的令牌文件（`dsh_project` 与 `agent_peer` 共用）。

配置完成后**完全退出并重开 Claude 桌面版**。

> **常见排错**：若 MCP 启动报 `'node' is not recognized` 或 `CONNECTION_CLOSED`，通常是桌面版 `PATH` 里没有 `node`，或者它还在运行缓存里的旧副本。请勿手改插件缓存，优先使用第 2 节的 `deploy-local.mjs` 写入本机绝对路径并刷新缓存。

---

## 4. 手工安装 Codex 插件

如果不用第 2 节的一键部署脚本，可按以下 4 步手工安装：

1. 将仓库中的 `skills/`、`.codex-plugin/`、`.codex-mcp.json`、`bin/`、`src/` 复制到 `~/.agents/plugins/plugins/agent-bridge`。将 `.codex-plugin/plugin.json` 中的 `mcpServers` 从 `./.codex-mcp.json` 改为 `./.mcp.json`。
2. 以 `.codex-mcp.json` 为模板创建机器专用的 `.mcp.json`：
   - `dsh_project` 与 `agent_peer` 的 `command` 均改为 `node.exe` 绝对路径，`args` 分别指向插件目录内 `bin/bridge.mjs` 和 `bin/peer-mcp.mjs` 的绝对路径。
   - `agent_peer` 的 `AGENT_PEER_CONFIG` 指向 **Codex 自己**的 peer 配置文件。
   - 两个入口的 `env` 都设置 `DSH_BRIDGE_CREDENTIAL_FILE`（Codex 令牌文件）和 `DSH_BRIDGE_URL`，并保留 `env_vars` 中的 delegate token 与链路转发变量。
   - **不要删掉**模板里的 `default_tools_approval_mode: "approve"`，这是 `codex exec` 调用 MCP 工具所必需的。
3. 在 `~/.agents/plugins/marketplace.json` 中添加市场条目（`path` 相对用户主目录）。
4. 安装插件：

```bash
codex plugin add agent-bridge@personal
```

---

## 5. Antigravity 插件与无头 CLI 细节

Antigravity 支持双向协作：既可作为**根主控**，也可通过无头 `agy` CLI 作为**被调用端（peer target）**：

- **自动部署**：在 `deploy.json` 中配置 `antigravityPluginDir`（例如 `C:/Users/<you>/.gemini/config/plugins/agent-bridge`）和/或 `antigravityExecutable`（例如 `C:/Users/<you>/AppData/Local/agy/bin/agy.exe`），运行 `deploy-local.mjs` 后会自动生成 `antigravity.token`、`agent-peer-antigravity.json`、`launch-antigravity.mjs`，在宿主片段中加入 `antigravity`，部署原生插件（含 `plugin.json`、`mcp_config.json`、`skills/`、`agents/agent-bridge-readonly.md`、`agents/agent-bridge-readonly-web.md`）并执行 `agy plugin validate`。
- **只读边界**：`consult` / `review` 会传入 `--disable-slash-commands`、只读 agent（默认纯本地 `agent-bridge-readonly`，仅保留 `read_file`；当 `peer_ask` 显式传 `webSearch: true` 时切换为 `agent-bridge-readonly-web` 增加 `search_web`）以及会话级 `--settings`（禁止工作区外访问，并拒绝 `write_file(*)`、`command(*)`、`mcp(*)`、`execute_url(*)`、`download_url(*)`）。
- **`webSearch` 开关**：同样支持 `claude-code`（控制 `WebSearch`/`WebFetch`），对 `codex` 与 `delegate` 模式明确拒绝（`PEER_ARGS_INVALID`）。
- **子主控委派**：`delegate` 模式保留 Antigravity 已安装的插件/MCP 配置，通过 `delegateMode`（`accept-edits` 或 `auto`）、可选 `--sandbox`（`delegateSandbox: true`）及 `delegateAllowedPermissions` 运行，并继承根凭据与委派链。
- **会话清理**：`records.antigravityDataDir`（默认 `~/.gemini/antigravity-cli`）下的临时 CLI 会话（`conversations/<id>.db`、`brain/<id>/`、`presence/<id>.lock`）会在收尾记录到期后自动清理。

---

## 6. agent-peer 配置文件参考

**每个根主控必须使用各自独立的 peer 配置文件**（如 `agent-peer-claude-code.json`、`agent-peer-codex.json`、`agent-peer-antigravity.json`）：

- 它们共用同一个 `stateDir`（共享作业账本、委派链账本与记录索引）。
- 各自的 `bridge.credentialFile` 必须指向**自己**的控制器令牌文件，切勿混用。

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
  "bridge": {
    "url": "http://127.0.0.1:3080/mcp/codex-bridge-v1",
    "credentialFile": "<私有目录>/credentials/<root-controller-id>.token"
  },
  "limits": { "timeoutMs": 1800000, "maxConcurrentJobs": 3 }
}
```

关键字段说明：

- `peers.<name>.executable`：对端无头 CLI 绝对路径（支持整段 `*`）；必须是真实可执行文件，拒绝 `.cmd` / `.bat` 包装脚本。
- `model` / `reasoningEffort`（Codex）或 `effort`（Claude Code / Antigravity）：可选**默认值**。单次 `peer_ask`（新建或 `sessionId` 续接）都可传入 `model` / `reasoningEffort` 动态覆盖，优先级为：`单次调用参数 > 配置默认值 > CLI 自身默认`。
- `peers.<target>.efforts`：可选，自定义允许的思考强度列表（1–16 个匹配 `^[a-z][a-z0-9_-]{0,31}$` 的唯一字符串）。默认列表：
  - `codex`：`minimal, low, medium, high, xhigh, max, ultra`
  - `claude-code` / `antigravity`：`low, medium, high, xhigh, max`
- `peers.codex.delegateSandbox` / `readOnlyDisablePlugins`：控制 `delegate` 沙箱（`read-only` / `workspace-write`）以及只读模式下要禁用的插件。
- `peers.claude-code.delegatePermissionMode` / `delegateAllowedTools`：`delegate` 模式权限配置；`consult` / `review` 自动走只读工具集与 `--no-session-persistence`。
- `records`：收尾记录目录、接受后保留天数（默认 3 天）、失败/争议保留天数（默认 30 天）、清扫间隔以及会话目录。
- `limits`：超时时间与最大并发作业数。
- 为防止配置绕过只读沙箱，本配置文件刻意**不提供自由形状的 CLI 参数数组**，所有 flag 均由校验过的字段生成。

---

## 7. 安装后验证与双向冒烟

1. **检查 DSH 宿主连接**：调用 `bridge_capabilities`，确认 `version` 为 `2.1.1`，`controllerIdentity.enabled` 为 `true`、`schemaVersion` 为 `1`，且 `self` / `admin` 与当前控制器一致。
2. **检查对端调用能力**：调用 `peer_capabilities`，确认 `self` 与当前客户端一致（`claude-code` / `codex` / `antigravity`），`chain` 反映当前位置，且目标 peer 的模式与默认模型/思考强度列表符合预期。
3. **验证环境清洁**：确认用户级和根进程级环境变量中已清除旧的 `DSH_MCP_TOKEN`，配置生效前已完全重启桌面端应用。
4. **双向 delegate 冒烟（可选，强烈建议升级后做一次）**：
   - **Claude → Codex**：确认 Codex delegate 继承了 Claude 的非管理员身份和 `via` 链，可完成一次低成本 DSH 提交（Codex 端保留其自身的 MCP 配置）。
   - **Codex → Claude**：确认 Claude Code delegate 在 `--strict-mcp-config` 下仅可见本插件的两个 MCP server（不暴露用户其他 MCP server），且能完成一次低成本 DSH 提交。

---

## 8. MCP 工具清单

### `dsh_project`（20 个 `bridge_*` 工具：6 读 / 1 提交 / 13 变更）

| 分类 | 工具 |
|---|---|
| 任务 | `bridge_submit`、`bridge_check`、`bridge_result`、`bridge_dossier` |
| 授权 | `bridge_approve`、`bridge_clarify` |
| 追问 | `bridge_followup` |
| 控制 | `bridge_cancel`、`bridge_reconcile`、`bridge_list`、`bridge_pause`、`bridge_resume` |
| 收尾 | `bridge_acknowledge`、`bridge_archive`、`bridge_cleanup` |
| 目录 | `bridge_models`、`bridge_capabilities` |
| 工作区 | `bridge_workspace_review`、`bridge_workspace_refresh`、`bridge_workspace_integrate` |

读工具不限归属；`bridge_submit` 将任务绑定到当前控制器；变更工具仅允许操作本人任务，或由管理员携带 `override:{reason}` 越权执行（先写审计意图，再执行，再写结果审计）。

### `agent_peer`（9 个工具）

| 工具 | 作用 |
|---|---|
| `peer_capabilities` | 查看自己在委派链上的位置、可调用目标、允许模式及各 peer 模型/思考强度能力 |
| `peer_ask` / `peer_check` / `peer_result` / `peer_cancel` / `peer_list` | 异步 peer 作业生命周期管理 |
| `record_closeout` / `record_list` | 写入与查询根任务收尾记录（`.agent-bridge/records/` + 外部索引） |
| `cleanup_run` | 清理过期临时会话（默认 dry-run） |

---

## 9. 安全边界与设计细节

- **令牌与归属**：每个控制器独立 bearer 令牌文件；`task.submittedBy` 由服务端写入且不可变。历史任务（`submittedBy: null`）只有管理员带非空原因（≤500 字符）才可变更。管理员令牌不会传给任何子进程。
- **委派继承根凭据**：`delegate` 继承根控制器（非管理员）的凭据，其提交的 DSH 任务归属根主体；同机同一控制器的会话共享权限，最终验收仍归根主控负责。
- **凭据不回落**：delegate 或子进程缺少注入的环境令牌时直接拒绝，不会读取本机凭据文件兜底；令牌永不写入作业记录、prompt、argv 或日志。
- **DSH 隔离**：适配器直接拒绝 `allowShell: true`；路径读写严格受 `scope.readRoots` / `writeRoots` 围栏限制；网络仅在任务包显式授予时开放。
- **Claude Code delegate MCP 收窄**：Claude Code 作为 delegate 时使用 `--strict-mcp-config`，仅保留插件的两个 MCP 入口；Codex 与 Antigravity delegate 保留各自的插件/MCP 配置。
- **委派链强校验**：禁止自调用、禁止回叫链上已有 harness、默认最大跳数 2、delegate 深度上限 1；非法链路直接拒绝而非修补。
- **安全清理**：清扫器只清理索引中有记录且对应 `.agent-bridge/records/` 文件仍存在的临时会话；未记录的日常会话永不触碰。

---

## 10. 历史兼容标识说明

为确保旧任务库与 worktree 平滑兼容，部分底层持久化标识沿用了早期命名 `codex-bridge`：

- MCP 端点：`/mcp/codex-bridge-v1`
- 宿主包名：`@local/dsh-codex-bridge-v1`
- 宿主插件 ID：`dsh-codex-bridge-v1`
- 默认 `ownerId`：`codex-bridge-v1`

这些标识无需改动，保留原值即可兼容既有数据。
