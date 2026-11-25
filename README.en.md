[中文](README.md) | English

# Agent Bridge

**Let Claude Code, Codex, Antigravity, and DeepSeek Harness (DSH) collaborate like a disciplined engineering team — with the single AI you are talking to staying strictly in charge.**

> Version `2.1.1` · MIT License · Independent open-source project, not affiliated with or endorsed by Anthropic, OpenAI, Google, or DeepSeek.

---

## What It Does (in Plain English)

If you use **Claude Code**, **Codex**, **Antigravity**, and/or a local **DeepSeek Harness (DSH)** on the same machine, they normally live in separate silos — getting a second opinion or offloading routine edits means copy-pasting prompts and diffs by hand.

**Agent Bridge connects them with two controlled bridges**:

1. **Peer-to-Peer AI Calls (`agent_peer`)**: Your active AI calls another AI through its headless CLI for **read-only consultation**, **independent code review**, **blind back-to-back architecture debates**, or **sub-project delegation**.
2. **Bounded Low-Cost Coding (`dsh_project`)**: Splits well-scoped coding tasks into isolated packets for local **DSH (DeepSeek Flash)** workers — each writer gets its own git worktree, and results come back to your active AI for review, testing, and integration.

There is one iron rule: **whichever AI you are talking to is the sole root controller**. Everything handed out returns to it for verification, and **server-enforced chain rules** make delegation loops impossible.

---

## What You Can Do With It

Just ask your active AI in natural language:

### 1. Offload Bounded Coding to DeepSeek (DSH)
Your main AI handles requirements, boundaries, and final integration while DSH Flash workers implement changes in parallel, isolated git worktrees.

> *"Break this change into bounded tasks for DSH: only `src/foo/` may be written, acceptance is `npm test` passing; return the diff and test output."*

### 2. Get an Independent, Read-Only Second Opinion / Review
Runs the peer AI in a strict read-only sandbox (cannot edit your files). You can override the **model**, **reasoning effort** (e.g., `xhigh`), and optional **web search** (`webSearch`) per call without touching config files.

> *"Have Codex independently review this commit for correctness at `xhigh` reasoning effort; don't tell it who wrote it or share my conclusion."*

### 3. Run Blind Back-to-Back Architecture Debates (`back-to-back-cross-check`)
Avoids sycophantic "looks good to me" reviews where Model B anchors on Model A's draft. The root sends the exact same blind brief to multiple AIs in parallel → collects independent proposals → runs anonymous mutual critique → verifies claims against the real codebase and adjudicates.

> *"Run a back-to-back cross-check on this refactor: have Codex and Claude produce independent blind proposals, anonymously critique each other, and adjudicate against the codebase."*

### 4. Delegate a Whole Sub-Project
Hand a self-contained module to another AI as a sub-controller — it can use its own subagents and DSH workers, then return the finished work to your root AI for integration.

> *"Hand `packages/parser/` to Codex as a sub-controller — it can use its own subagents and DSH, and return the result to me for integration."*

### 5. Automatic Closeout Notes & Session Cleanup
When a task finishes, write a clean Markdown summary to `.agent-bridge/records/` (automatically excluded via `.git/info/exclude`, never touching your `.gitignore`) and let the sweeper clean up expired temporary peer/DSH sessions.

> *"Close out this task: write the closeout record, dry-run the cleanup first, and run it once I confirm."*

---

## How It Works

```text
                         You (User)
                             │
  Sole Root Controller: Claude Code / Codex / Antigravity (the one you're chatting with)
                             │
              ┌──────────────┴──────────────┐
              │                             │
         agent_peer                    dsh_project
    (Headless CLI Peer MCP)       (DSH Host Bridge MCP)
              │                             │
              ▼                             ▼
     Another AI's Headless CLI        Local DSH Host
     · codex exec                   /mcp/codex-bridge-v1
     · claude -p                            │
     · agy (stream-json)                    ▼
                                    DSH Flash Workers
     Three modes:                   One git worktree per writer
     · consult (read-only Q&A)      Path fences, no shell
     · review (read-only review)
     · delegate (sub-controller)
```

### Four Core Building Blocks

| Component | Role |
|---|---|
| **`agent_peer`** | Invokes peer AIs (**Claude Code ↔ Codex ↔ Antigravity**) via headless CLIs; manages async jobs, chain loop prevention, closeout notes, and temp session cleanup |
| **`dsh_project`** | Shared stdio MCP carrier forwarding each root's requests (with its own credential) to the local DSH host bridge |
| **DSH Host Bridge** | Local DSH plugin turning bounded task packets (with path fences & budgets) into isolated DSH Flash worker runs |
| **3 Built-in Skills** | Teaches your AI how to route, delegate, and cross-verify:<br>• `agent-bridge-routing`: role split, loop prevention & cross-verification rules<br>• `dsh-project-execution`: DSH packet decomposition, worktree review & integration<br>• `back-to-back-cross-check`: blind multi-model proposal & adversarial critique protocol |

---

## Why It Stays Safe & Predictable

- **No delegation loops (server-enforced)**: The server tracks the call chain — no AI can call itself or any ancestor already on the chain (default max 2 hops, max delegate depth 1).
- **Reviews are strictly read-only**: `consult` and `review` lock the peer into a read-only sandbox with read-only tools and disable mutating plugins; read-only Claude Code runs leave no session behind.
- **DSH workers stay boxed in**: One isolated git worktree per writer, strict read/write path fences, **no shell access**, no network unless explicitly granted, and an evidence-gated `review → integrate → acknowledge` lifecycle.
- **Isolated credentials & local-only data**: Each controller uses its own bearer token file and owns its own tasks; nothing leaves your machine except the model API calls each CLI normally makes.
- **Safe session cleanup**: Only temporary sessions listed in an existing closeout record are swept (3 days after accepted, 30 days after failed/disputed, never for `keep`). Your regular chats are never touched.

---

## Quick Start

### Requirements

- **OS**: Windows (verified; other platforms have code paths but are untested)
- **Node.js**: `>= 24` (does not need to be on `PATH`; absolute path works)
- **AI CLIs**: Whichever of Claude Code / Codex / Antigravity you want to bridge — each headless CLI must be **logged in once** beforehand
- **DSH (optional)**: Local **DSH `0.2.0-rc.2`** (default `127.0.0.1:3080`) if you want to offload coding tasks to DeepSeek

### Recommended: Local One-Command Deployment

1. Copy [`scripts/deploy.example.json`](scripts/deploy.example.json) outside the repo and fill in `deployRoot`, `nodePath`, and your CLI/plugin paths (Antigravity fields are opt-in).
2. Preview, then deploy:

```bash
node scripts/deploy-local.mjs --config <your-deploy.json> --dry-run
node scripts/deploy-local.mjs --config <your-deploy.json>
```

3. If using DSH, stop DSH, install the host plugin, and start DSH again:

```bash
node scripts/install.mjs --source <this-repo> --profile <DSH_HOME>/profiles/web \
  --host-config <host-config.json> --require-host-entry --json
```

4. **Fully quit and restart** your desktop apps / CLIs, then verify in two quick calls:
   - Call `peer_capabilities`: confirm `self` (`claude-code` / `codex` / `antigravity`) and the callable peer list.
   - If using DSH, call `bridge_capabilities`: confirm version `2.1.1` and `controllerIdentity.enabled: true`.

> For full JSON config templates, installing Claude Code from GitHub, manual Codex setup, Antigravity options, upgrading older installs, and the full 29-tool inventory, see **[Detailed Setup, Configuration & Technical Reference](docs/setup-and-reference.en.md)**.

---

## Known Limitations

- Verified on **Windows** only.
- **DSH `0.2.0-rc.2`** is a preview release whose upstream APIs may change.
- Automatic cleanup of expired temp sessions runs only while a plugin-enabled client session is open.
- Each headless CLI must be logged in once before `agent_peer` can invoke it.

---

## Documentation

- [Detailed Setup, Configuration & Technical Reference](docs/setup-and-reference.en.md) — full config templates, manual setup, tool list, troubleshooting & security details
- [docs/controller-identity.md](docs/controller-identity.md) — controller identity, per-root tokens, override audit, and migration/rollback
- [docs/reference/dsh-bridge-reference.zh.md](docs/reference/dsh-bridge-reference.zh.md) — in-depth DSH host bridge technical reference (Chinese)
- [docs/event-wake.md](docs/event-wake.md) — event wake (durable outbox → controller)
- [docs/long-supervisor.md](docs/long-supervisor.md) / [docs/recurrent-supervisor.md](docs/recurrent-supervisor.md) / [docs/deadline-watchdog.md](docs/deadline-watchdog.md) — supervisor editions and deadline watchdog
- [CONTRACTS.md](CONTRACTS.md) — stable exports and implementation baseline
- [CHANGELOG.md](CHANGELOG.md) — release-by-release history

---

## Development & Tests

```bash
npm install    # installs dev dependency @deepseek-ai/dsh-llm for adapter tests
npm test       # runs: node --test test/*.test.mjs
```

CI runs on Windows + Node 24 ([`.github/workflows/test.yml`](.github/workflows/test.yml)). Most of this repository's own code was built through the bridge itself.

## License

MIT, see [LICENSE](LICENSE).
