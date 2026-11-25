中文 | [English](README.en.md)

# Agent Bridge

**让 Claude Code、Codex、Antigravity 和 DeepSeek（DSH）像一支有纪律的工程团队一样互相协作，但全程只听你当前对话的这一个 AI 指挥。**

> 当前版本 `2.1.1` · MIT 协议 · 独立开源项目，与 Anthropic、OpenAI、Google、DeepSeek 均无隶属或背书关系。

---

## 一句话看懂它是干嘛的

平时用 AI 写代码，你可能同时装了 **Claude Code**、**Codex**、**Antigravity**，甚至本地跑了 **DeepSeek Harness（DSH）**，但它们彼此孤立——想让另一个模型帮你挑错，或者把重复的改代码活外包给便宜模型，只能自己来回复制粘贴。

**Agent Bridge 在它们之间搭了两座受控的桥**：

1. **大牌 AI 互叫（`agent_peer`）**：你正在用的 AI 可以直接通过命令行把另一个 AI 叫过来做**只读咨询**、**独立代码审查**、**双盲架构辩论**，或者把整个子模块外包给它当子负责人。
2. **廉价批量写代码（`dsh_project`）**：把边界清晰的代码改动拆成任务包，交给本地 **DSH（DeepSeek Flash）** 在隔离的 git worktree 里并行实现，写完再回到当前 AI 审查、测试、合并。

全程遵循一条铁律：**你正在跟谁聊天，谁就是唯一老大（根主控）**。所有活发出去都必须回到它手里验收，**服务端强制防环**，绝不会出现“A 叫 B、B 又叫回 A”的死循环。

---

## 你能拿它干什么？（直接对 AI 说就行）

### 1. 把脏活累活外包给 DeepSeek（DSH）并行写
主控负责聊需求、定边界、验收合并，DSH 在独立 git worktree 里写代码，省钱且互不干扰。

> *“把这个改动拆成有边界的任务交给 DSH：只允许改 `src/foo/`，验收标准是 `npm test` 通过，跑完把 diff 和测试输出给我。”*

### 2. 找另一个 AI 独立 Code Review / 问答咨询
纯**只读**运行，不会乱改你的文件；还能临时指定**模型**、**思考强度**（如 `xhigh`），必要时开启联网搜索（`webSearch`）。

> *“让 Codex 以 `xhigh` 思考强度独立 review 这个 commit 的正确性，不要告诉它作者是谁，也不要把我的结论告诉它。”*

### 3. 双盲背靠背架构 Battle（`back-to-back-cross-check`）
做架构选型、查疑难 Bug 时，防止后一个 AI 顺着前一个的草稿客套附和。主控同时给多个 AI 下发同一份盲审题目 → 各自独立出方案 → 匿名互相挑刺 → 主控查真实代码实证裁决。

> *“对这个重构方案做一次背靠背交叉验证：让 Codex 和 Claude 各自盲出方案，然后匿名互相挑刺，最后由你查代码裁决。”*

### 4. 把一整个子项目委派出去（子主控 Delegate）
大模块可以直接交给另一个 AI 当“子包工头”——它自己也能继续调度 DSH 或自己的 subagent，做好后再把结果交回给当前主控验收。

> *“把 `packages/parser/` 这个子项目交给 Codex 当子主控，它可以用自己的 subagent 和 DSH，完成后结果返回给我集成。”*

### 5. 自动留复盘笔记、自动清临时会话
任务结束时一键收尾，在项目的 `.agent-bridge/records/` 下生成一份 Markdown 复盘记录（自动通过 `.git/info/exclude` 忽略，不污染项目的 `.gitignore`），之后过期的临时 AI 会话会自动清理。

> *“收尾这个任务：写一份 closeout 记录，先 dry-run 预览清理，我确认后再执行。”*

---

## 它是怎么运作的？

```text
                        你（用户）
                            │
   唯一根主控：Claude Code / Codex / Antigravity（当前对话的那个）
                            │
             ┌──────────────┴──────────────┐
             │                             │
        agent_peer                    dsh_project
   （无头 CLI 互调 MCP）          （DSH 宿主桥 MCP）
             │                             │
             ▼                             ▼
    调用另一个 AI 的 CLI              本地 DSH 宿主
    · codex exec                    /mcp/codex-bridge-v1
    · claude -p                            │
    · agy (stream-json)                    ▼
                                   DSH Flash Worker
    支持三种模式：                   每个写任务独立 worktree
    · consult（只读问答）            只读/只写路径围栏、无 shell
    · review（独立只读审查）
    · delegate（子主控委派）
```

### 四个核心组成

| 组件 | 负责什么 |
|---|---|
| **`agent_peer`** | 在 **Claude Code ↔ Codex ↔ Antigravity** 之间通过无头 CLI 互相调用，管作业进度、防循环链路、收尾记录与临时会话清理 |
| **`dsh_project`** | 各端通用的 MCP 客户端，把当前主控的请求带上独立身份令牌转发给本地 DSH 宿主桥 |
| **DSH 宿主桥** | 装在本地 DSH 上的插件，把编码任务拆成带预算和路径围栏的任务包，分发给隔离的 DSH Flash worker |
| **内置 3 个 Skills** | 教 AI 何时该叫谁、怎么派活、怎么打双盲 Battle：<br>• `agent-bridge-routing`：路由分工与防环规范<br>• `dsh-project-execution`：DSH 任务拆包、理解门、审查与集成流程<br>• `back-to-back-cross-check`：双盲背靠背多模型交叉验证协议 |

---

## 为什么不会乱套？（安全与防失控设计）

- **服务端强制防环**：委派链由服务端记录和拦截，不能叫自己、不能回叫链上已经出现过的 AI，默认最多 2 跳、子主控委派深度上限 1，不靠提示词自觉。
- **审查绝对只读**：`consult` 和 `review` 模式给对端只读沙箱与只读工具集，禁用可能动手的插件；Claude Code 只读调用还不留多余会话记录。
- **DSH 工人关在笼子里**：每个写任务独占一个 git worktree，读写目录严格围栏（越界直接拒绝）、**禁用 shell**、默认断网，合并前必须经过「审查 → 集成 → 确认」的证据链。
- **身份隔离，数据不出本机**：Claude Code、Codex、Antigravity 各持一份独立令牌文件，谁提交的任务归谁管；除各 AI 本身必要的模型请求外，没有任何数据离开你的机器。
- **清理绝不误删**：清扫器只清理写进收尾记录的临时会话（已接受的 3 天后清、失败/争议的 30 天后清、标了 `keep` 永不清），你的日常对话永远不动。

---

## 快速开始

### 前置要求

- **操作系统**：Windows（已实测；其他平台有代码路径但未验证）
- **Node.js**：`>= 24`（不必加入 `PATH`，配置绝对路径即可）
- **AI CLI**：安装你打算使用的 Claude Code / Codex / Antigravity，并确保每个无头 CLI 都至少**各自登录过一次**
- **DSH（可选）**：如需把写代码任务外包给 DeepSeek，需要本地运行 **DSH `0.2.0-rc.2`**（默认监听 `127.0.0.1:3080`）

### 推荐：一键本地部署

克隆本仓库后，用内置部署脚本自动生成各端独立的令牌文件、peer 配置与本地插件：

1. 将 [`scripts/deploy.example.json`](scripts/deploy.example.json) 复制到仓库外，填入本机的 `deployRoot`、`nodePath` 和各客户端/CLI 路径（Antigravity 为按需配置项，填上即自动启用）。
2. 先预览再部署：

```bash
node scripts/deploy-local.mjs --config <你的 deploy.json> --dry-run
node scripts/deploy-local.mjs --config <你的 deploy.json>
```

3. 如需使用 DSH 宿主桥，先停掉 DSH，安装宿主插件后再重启：

```bash
node scripts/install.mjs --source <本仓库目录> --profile <DSH_HOME>/profiles/web \
  --host-config <宿主配置.json> --require-host-entry --json
```

4. **完全退出并重启**对应的桌面端 / CLI，然后做两步快速验收：
   - 让 AI 调用 `peer_capabilities`：确认能正确识别自己（`claude-code` / `codex` / `antigravity`）和可调用的对端列表。
   - 如已接入 DSH，调用 `bridge_capabilities`：确认返回版本 `2.1.1` 且 `controllerIdentity.enabled` 为 `true`。

> 完整的配置模板、从 GitHub 安装 Claude Code 插件、手工装 Codex、Antigravity 专项参数、旧版本平滑迁移以及全部 29 个 MCP 工具清单，见 **[详细安装、配置与技术参考](docs/setup-and-reference.md)**。

---

## 已知限制

- 目前仅在 **Windows** 上做过完整验证。
- **DSH `0.2.0-rc.2`** 仍为预览版，上游 API 未来可能变动。
- 过期临时会话的自动清扫仅在**开着带本插件的客户端会话时**触发。
- 使用 `agent_peer` 互调前，每一侧的无头 CLI 必须先各自登录过一次。

---

## 文档导航

- [详细安装、配置与技术参考](docs/setup-and-reference.md) — 完整 JSON 配置模板、手工安装、工具列表、排错与安全细则
- [docs/controller-identity.md](docs/controller-identity.md) — 控制器身份、独立令牌、越权审计与旧版迁移回滚指南
- [docs/reference/dsh-bridge-reference.zh.md](docs/reference/dsh-bridge-reference.zh.md) — DSH 宿主桥深入技术参考
- [docs/event-wake.md](docs/event-wake.md) — 事件唤醒（durable outbox → 控制器）
- [docs/long-supervisor.md](docs/long-supervisor.md) / [docs/recurrent-supervisor.md](docs/recurrent-supervisor.md) / [docs/deadline-watchdog.md](docs/deadline-watchdog.md) — 长任务、循环 Supervisor 与看门狗设计
- [CONTRACTS.md](CONTRACTS.md) — 稳定导出与接口契约基线
- [CHANGELOG.md](CHANGELOG.md) — 逐版本变更记录

---

## 开发与测试

```bash
npm install    # 仅安装开发依赖 @deepseek-ai/dsh-llm（用于适配器测试）
npm test       # 运行测试：node --test test/*.test.mjs
```

CI 运行在 Windows + Node 24（[`.github/workflows/test.yml`](.github/workflows/test.yml)）。本项目自身的大部分代码就是通过这座桥自举写出来的。

## 许可证

MIT，见 [LICENSE](LICENSE)。
