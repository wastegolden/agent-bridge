中文 | [English](README.en.md)

# Agent Bridge

Agent Bridge 让 **Claude Code**、**Codex** 和 **DeepSeek Harness（DSH）** 互相调用。你在对话的那个 harness 是任务的**根主控**：它把有边界的实现交给 DSH 的 Flash worker，把咨询、独立审查或一个子项目交给另一个 harness。每个任务只有一个根主控，DSH worker 任务有明确的读/写根、工具白名单和预算，委派链由服务端强制执行，不会出现互相委派的环。版本 1.6.1，MIT。

> 独立项目，与 DeepSeek、OpenAI、Anthropic 均无隶属或背书关系。

## 组成

```
                    你（用户）
                        │
        根主控：Claude Code 或 Codex（每个任务恰好一个）
                        │
         ┌──────────────┴──────────────┐
         │                             │
    dsh_project                   agent_peer
    MCP HTTP                      MCP stdio
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
| `dsh_project` | 两边的插件清单（MCP server） | 通过 MCP HTTP 连到上面的端点：`Authorization: Bearer <DSH_MCP_TOKEN>` |
| `agent_peer` | `bin/peer-mcp.mjs`、`src/peer/*` | 用无头 CLI 在 Claude Code 与 Codex 之间做咨询 / 只读审查 / 子主控委派，带作业账本、链规则与收尾记录 |
| skills | `skills/agent-bridge-routing`、`skills/dsh-project-execution` | 路由规则与 DSH 执行规范 |

### DSH 宿主桥

宿主桥是一个 DSH 插件，在 DSH 宿主上挂载 MCP 端点 `/mcp/codex-bridge-v1`（默认 `http://127.0.0.1:3080`），只接受带正确 bearer 令牌的请求。它把任务作为有边界的任务包派给 DSH Flash worker：

- 每个写任务一个独立 git worktree，互不干扰；
- 任务包声明显式的读根、写根、工具白名单和预算；当前适配器拒绝 `allowShell: true`，worker 拿不到 shell；
- 网络也由任务包声明，只有被授予时才可用；
- 生命周期是 审查（review）→ 集成（integrate）→ 确认（acknowledge）→ 归档 / 清理（archive / cleanup），每一步都要求前一步的真实证据。

它暴露 19 个 `bridge_*` 工具（宿主 `bridge_capabilities` 报告的 `version` 是 **1.5.0**，与插件版本 1.6.1 不同）：

- 任务：`bridge_submit`、`bridge_check`、`bridge_result`、`bridge_dossier`
- 授权：`bridge_approve`、`bridge_clarify`
- 控制：`bridge_cancel`、`bridge_reconcile`、`bridge_list`、`bridge_pause`、`bridge_resume`
- 收尾：`bridge_acknowledge`、`bridge_archive`、`bridge_cleanup`
- 目录：`bridge_models`、`bridge_capabilities`
- 工作区：`bridge_workspace_review`、`bridge_workspace_refresh`、`bridge_workspace_integrate`

### dsh_project

`dsh_project` 是 Claude Code / Codex 一侧的 MCP server，直接走 MCP HTTP 连到宿主端点，令牌取自环境变量 `DSH_MCP_TOKEN`。Claude Code 的清单内联了这个 server；Codex 的模板在 `.codex-mcp.json`。仓库里的 stdio 转发载体 `bin/bridge.mjs` 仍然可用，但两个客户端默认都不再需要它。

### agent_peer

`agent_peer`（`bin/peer-mcp.mjs`）用对方 harness 的无头 CLI（`codex exec` / `claude -p`）运行另一个 harness，提供 9 个工具：

- `peer_capabilities`：我在链上的位置、现在能调谁、哪些模式被允许
- `peer_ask`、`peer_check`、`peer_result`、`peer_cancel`、`peer_list`：作业生命周期
- `record_closeout`、`record_list`：收尾记录与索引
- `cleanup_run`：清理临时会话（默认 dry run）

三种模式：`consult`（问答）与 `review`（独立审查）都是只读的，只给对端只读沙箱和只读工具集；`delegate`（子主控）才可能在 `cwd` / `addDirs` 里写。链规则由服务端强制，不靠提示词：不能把目标指向自己、不能调用链上已有的任何 harness（于是工作永远流不回根主控）、跳数上限默认 2、子主控委派深度默认 1。

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
- 用户环境变量 **`DSH_MCP_TOKEN`**，值是 DSH 宿主的桥令牌（即宿主配置 `credentialFile` 指向的文件内容）。设好后要重开 Claude / Codex 才会读到。

## 安装

### 1. DSH 宿主桥

先看现状：在已连通的 Claude / Codex 里调用 `bridge_capabilities`，读返回的 `version`。1.6.x 的宿主代码与 1.5.0 相同，报告的也是 1.5.0；如果你已经在这个版本上，跳过本节。

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

宿主配置示例（字段见下方，路径用你自己的）：

```json
{
  "dataDirectory": "<DSH_HOME>/codex-bridge-v1",
  "ownerId": "<owner-id>",
  "credentialFile": "<某个私有目录>/bridge-token.txt",
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
- `credentialFile` 的文件内容就是 bearer 令牌，客户端通过 `DSH_MCP_TOKEN` 发送它。**宿主不会替你生成令牌**，安装前自己生成一个随机值写进这个文件，再把同一个值设成用户环境变量 `DSH_MCP_TOKEN`：

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > <某个私有目录>/bridge-token.txt
  ```

  不写 `credentialFile` 时，宿主改从它自己进程环境里的 `DSH_MCP_TOKEN` 读令牌。
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
echo '{"node_path":"C:/Program Files/nodejs/node.exe","peer_config":"<路径>/agent-peer.json"}' | claude plugin configure agent-bridge@agent-bridge --values-stdin
```

三个选项：

- `node_path`：Node 24 的 `node.exe` 绝对路径（默认值是字面量 `node`）。
- `peer_config`：agent-peer 配置文件的绝对路径（见第 5 小节）。
- `dsh_bridge_url`：默认 `http://127.0.0.1:3080/mcp/codex-bridge-v1`。

然后**完全退出并重开 Claude 桌面版**。

**踩坑**：如果 MCP server 起不来，报 `'node' is not recognized` 或 `CONNECTION_CLOSED`，那是 Claude 桌面版用默认的字面量 `node` 去启动 `agent_peer` 了——桌面版的 PATH 里通常没有 node。也可能是它还在跑插件缓存里的旧副本。不要手改缓存，直接用第 3 小节的部署脚本：它把本机路径写进**部署副本**的插件默认值里，并刷新 Claude Code 的插件缓存。

### 3. 一条命令本地部署（Claude Code + Codex）

适合没有 git 历史的解压包，也适合已经手工配置过的机器。克隆或下载本仓库后：

1. 复制 `scripts/deploy.example.json` 到仓库外，改成本机路径。必填三项：`deployRoot`（部署根，下面会有 `plugin/`、`config/`、`state/` 和 Claude 的本地插件市场）、`nodePath`、`bridgeUrl`。可选：`repo`（导出这个 git 仓库的 HEAD，缺省则直接复制包目录）、`gitExecutable`、`peerConfig`、`credentialFile`、`codexPluginDir`、`codexExecutable`、`codexPluginId`、`codexMarketplace`、`claudeExecutable`、`claudePluginId`。可执行文件路径可以用整段的 `*`，脚本取最新匹配的那份（两个桌面端都把 CLI 放在随更新变化的版本/哈希目录里）。
2. 先看计划，再执行：

```bash
node scripts/deploy-local.mjs --config <你的 deploy.json> --dry-run
node scripts/deploy-local.mjs --config <你的 deploy.json>
```

它只在本机文件**缺失时**创建这些机器相关文件，已存在的一律不覆盖：Claude 的本地插件市场（`<deployRoot>/.claude-plugin/marketplace.json`）、`config/agent-peer.json`、Codex 插件的 `.mcp.json`（`dsh_project` 走 HTTP + `DSH_MCP_TOKEN`，`agent_peer` 用 node 绝对路径）、Codex 的 personal 市场条目。它会把本机路径写进部署副本的插件默认值、同步 Codex 插件的 skills 与清单，并（配置了 `claudeExecutable` 时）刷新 Claude Code 的插件缓存。

3. **完全退出并重开 Claude 桌面版**，Codex 开一个新会话。

### 4. 手工安装 Codex（不使用第 3 小节时）

1. 把本仓库的 `skills/`、`.codex-plugin/`、`.codex-mcp.json`、`bin/`、`src/` 等放进插件目录 `~/.agents/plugins/plugins/agent-bridge`。仓库里的模板 `.codex-plugin/plugin.json` 指向 `./.codex-mcp.json`，装成机器插件时把它的 `mcpServers` 改成 `./.mcp.json`（部署脚本就是这么改的）。
2. 在插件目录里放一份机器专用的 `.mcp.json`，内容以 `.codex-mcp.json` 为基础，把 `agent_peer` 的 `command` 改成 node 的绝对路径、`args` 指向插件目录里 `bin/peer-mcp.mjs` 的绝对路径、`AGENT_PEER_CONFIG` 改成配置文件的绝对路径。模板里的 `default_tools_approval_mode: "approve"` 是 `codex exec` 里调用 MCP 工具所必需的，别删。
3. 在 `~/.agents/plugins/marketplace.json` 里加一条市场条目，`path` 用相对用户主目录的路径。
4. 安装插件：

```bash
codex plugin add agent-bridge@personal
```

### 5. agent-peer 配置

Claude Code 和 Codex 应当指向**同一个**配置文件，这样两边看到同一个作业账本和同一个链账本。

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
    }
  },
  "records": {
    "enabled": true,
    "dirName": ".agent-bridge/records",
    "retainDays": 3,
    "disputedRetainDays": 30,
    "sweepIntervalMinutes": 60,
    "claudeProjectsDir": "C:/Users/<you>/.claude/projects"
  },
  "bridge": { "url": "http://127.0.0.1:3080/mcp/codex-bridge-v1" },
  "limits": { "timeoutMs": 1800000, "maxConcurrentJobs": 3 }
}
```

主要字段：

- `stateDir`：作业账本、链账本和记录索引的位置。
- `peers.<name>.executable`：对端无头 CLI 的绝对路径，可用整段 `*` 选最新版本；必须是真实可执行文件，不能是 `.cmd` / `.bat` 包装（否则配置被拒）。
- `peers.codex.delegateSandbox`：`delegate` 模式的 Codex 沙箱（`read-only` 或 `workspace-write`）。`readOnlyDisablePlugins` 在只读模式下禁用指定插件，防止审查者通过 MCP 工具动手。
- `peers.codex.reasoningEffort` / `peers.codex.model`：可选，且是**全局**的——对每一次 Codex peer 调用都生效。
- `peers.claude-code.delegatePermissionMode` / `delegateAllowedTools`：`delegate` 模式的权限模式与允许的工具；`review` / `consult` 走只读工具集与 `--no-session-persistence`。
- `records`：记录目录名、接受后的保留天数、失败/争议的保留天数、清扫间隔、Claude 会话目录。
- `bridge`：清扫器使用的 DSH 端点；令牌优先取 `DSH_MCP_TOKEN`，`credentialFile` 是可选的后备。
- `limits`：超时、并发等上限。

配置里没有自由形状的参数列表：每个 CLI flag 都由校验过的字段生成，所以配置无法重新打开只读沙箱。

## 验证

1. 调用 `bridge_capabilities`：宿主返回的 `version` 应是 `1.5.0`（插件版本是 1.6.1，两者不同）。
2. 调用 `peer_capabilities`：Claude 端 `self` 应是 `claude-code`，Codex 端应是 `codex`；`chain` 显示自己在链上的位置，每个 peer 的每个模式会明确告诉你是否允许，以及不允许时的错误码。

## 用法

几种可以直接打出来的请求：

1. 交给 DSH 实现：*"把这个改动拆成有边界的任务交给 DSH：只允许改 `src/foo/`，验收是 `npm test` 通过，跑完把 diff 和测试输出给我。"*
2. 让另一个 harness 独立审查：*"让 Codex 独立 review 这个 commit 的正确性，不要告诉它作者是谁，也不要给它我的结论。"*
3. 让 Codex 当子主控：*"这个子项目交给 Codex 当子主控，它可以用自己的 subagent 和 DSH，范围是 `packages/parser/`，结果返回给我集成。"*
4. 收尾并清理：*"收尾这个根任务：写 closeout 记录，然后 dry run 一次清理，确认后再执行。"*

规则只有一条：**你在对话的那个 harness 是这个任务的根主控**，它独自拥有需求、接口合同、授权、验收与集成，交出去的每一件东西都只能作为结果回到它这里。别人不能跳过它去改需求，也不能把工作再委托回它。

## 安全模型

- **令牌**：宿主端点只接受带正确 bearer 令牌的请求；令牌来自用户环境变量 `DSH_MCP_TOKEN`，不写进插件清单。
- **DSH 任务不能开 shell**：当前适配器直接拒绝 `allowShell: true`，不给绕过口。
- **路径围栏**：worker 只能读 `scope.readRoots`、写 `writeRoots`；越界是明确的拒绝，不是提示。
- **网络**：只有任务包显式授予时才可用。
- **只读 peer 不能写**：`consult` / `review` 给对端只读沙箱和只读工具集，并禁用可能动手的插件；Claude 一侧只读运行不留会话。
- **委派链强制**：不能指向自己、不能调用链上已有的 harness、跳数与 delegate 深度有上限；非法链直接拒绝而不是修补。
- **清理只清记录过的会话**：清扫器只动收尾记录里列出的会话，且记录文件必须存在；不在记录里的会话永远不动。
- **数据不出机器**：除各 harness 本来就在做的模型调用外，没有别的东西离开这台机器。

## 已知限制

- 只在 **Windows** 上验证过；其他平台的代码路径存在但未测试。
- **DSH 0.2.0-rc.2 是预览版**，API 可能变化。
- Codex 的推理强度**不能按单次 peer 调用设置**，只能全局配置 `peers.codex.reasoningEffort`。
- 自动清扫只在**开着带插件的 Claude Code 或 Codex 会话时**运行。
- 无头 CLI 必须先各自登录过一次，否则 peer 调用失败。

## 文档

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
