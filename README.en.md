[中文](README.md) | English

# Agent Bridge

Agent Bridge lets **Claude Code**, **Codex** and **DeepSeek Harness (DSH)** call each other. The harness you are talking to is the **root controller** of that task: it hands bounded implementation to DSH Flash workers, and consultation, independent review or a whole sub-project to the other harness. There is exactly one root controller per task, DSH worker tasks carry explicit read/write roots, a tool allowlist and a budget, and the delegation chain is enforced by the server, so delegation loops cannot form. Version 1.6.2, MIT.

> Independent project; not affiliated with, or endorsed by, DeepSeek, OpenAI or Anthropic.

## How it fits together

```
                      you
                       │
        root controller: Claude Code or Codex (exactly one per task)
                       │
        ┌──────────────┴──────────────┐
        │                             │
   dsh_project                   agent_peer
   MCP HTTP                      MCP stdio
        │                             │
        ▼                             ▼
  DSH host bridge            the other harness's headless CLI
  /mcp/codex-bridge-v1       consult / review (read-only) / delegate (sub-controller)
        │
        ▼
  DSH Flash worker (one git worktree per writer task)
```

| Part | Where | What it does |
|---|---|---|
| DSH host bridge | `dsh-host/index.cjs`, `src/*` | A DSH plugin that serves the MCP endpoint `/mcp/codex-bridge-v1` on the DSH host (default `http://127.0.0.1:3080`), authenticated with a bearer token |
| `dsh_project` | MCP server in both plugin manifests | Connects to that endpoint over MCP HTTP with `Authorization: Bearer <DSH_MCP_TOKEN>` |
| `agent_peer` | `bin/peer-mcp.mjs`, `src/peer/*` | Runs the other harness through its headless CLI for consult / read-only review / sub-controller delegation, with a job ledger, chain rules and closeout records |
| Skills | `skills/agent-bridge-routing`, `skills/dsh-project-execution` | Routing rules and the DSH execution discipline |

### DSH host bridge

The host bridge is a DSH plugin. It mounts the MCP endpoint `/mcp/codex-bridge-v1` (default `http://127.0.0.1:3080`) on the DSH host and accepts only requests carrying the correct bearer token. It runs tasks as bounded packets on DSH Flash workers:

- one git worktree per writer task, so parallel writers stay isolated;
- the packet declares explicit read roots, write roots, a tool allowlist and a budget; the current adapter rejects `allowShell: true`, so a worker gets no shell;
- network access is declared by the packet too, and is available only when granted;
- the lifecycle is review → integrate → acknowledge → archive / cleanup, and every step requires the previous step's real evidence.

It exposes 19 `bridge_*` tools (the host's `bridge_capabilities` reports `version` **1.5.0**, which is not the plugin version 1.6.2):

- tasks: `bridge_submit`, `bridge_check`, `bridge_result`, `bridge_dossier`
- authorization: `bridge_approve`, `bridge_clarify`
- control: `bridge_cancel`, `bridge_reconcile`, `bridge_list`, `bridge_pause`, `bridge_resume`
- closeout: `bridge_acknowledge`, `bridge_archive`, `bridge_cleanup`
- catalogue: `bridge_models`, `bridge_capabilities`
- workspaces: `bridge_workspace_review`, `bridge_workspace_refresh`, `bridge_workspace_integrate`

### dsh_project

`dsh_project` is the MCP server on the Claude Code / Codex side. It talks to the host endpoint over MCP HTTP and takes the token from the `DSH_MCP_TOKEN` environment variable. The Claude Code manifest inlines this server; the Codex template is `.codex-mcp.json`. The stdio carrier `bin/bridge.mjs` is still available, but neither client needs it by default.

### agent_peer

`agent_peer` (`bin/peer-mcp.mjs`) runs the other harness through its headless CLI (`codex exec` / `claude -p`) and exposes 9 tools:

- `peer_capabilities`: where I sit on the chain, whom I may call right now, which modes are allowed
- `peer_ask`, `peer_check`, `peer_result`, `peer_cancel`, `peer_list`: job lifecycle
- `record_closeout`, `record_list`: closeout records and index
- `cleanup_run`: sweep temporary sessions (dry run by default)

Three modes: `consult` (a question) and `review` (an independent review) are read-only — the peer gets a read-only sandbox and a read-only tool set; only `delegate` (sub-controller) may write inside `cwd` / `addDirs`. The chain rules are enforced by the server, not by prompts: no self target, no call to any harness already on the chain (so work can never flow back to the root controller), at most 2 hops below the root by default, and sub-controller appointment only to a default depth of 1.

`record_closeout` writes one Markdown record per root task into `<project>/.agent-bridge/records/`, excluded from git through `.git/info/exclude` (the project's own `.gitignore` is not touched), and appends one event to an external index at `<stateDir>/records-index.jsonl`. A sweeper then cleans up the temporary peer / DSH sessions automatically: **3 days** after an accepted record, **30 days** for failed / disputed / unresolved ones, and never for `keep`. DSH sessions have no delete API, so they are archived and then cleaned. The index is the only source of session ids, and nothing is swept while the record file is missing.

### Skills

- `agent-bridge-routing`: who does what (volume to DSH, judgement to the other harness by default), one root controller per task, no delegation loops, and an evidence-based cross-model verification protocol.
- `dsh-project-execution`: how to decompose work into packets, the understanding gate, parallel worktrees, review of an exact commit, integration of a verified head, and cleanup of owned tasks.

### About the "codex-bridge" ids

For compatibility with existing installs the persisted ids are still the old ones: the endpoint `/mcp/codex-bridge-v1`, the task origin, the host package `@local/dsh-codex-bridge-v1`, the host plugin id `dsh-codex-bridge-v1`, and the default `ownerId` of the host config, `codex-bridge-v1`. They keep their values, so old task databases and worktrees keep working.

## Requirements

- **DSH 0.2.0-rc.2** (the version this was verified on). The examples assume the host listens on `127.0.0.1:3080`; if yours listens elsewhere, change `dsh_bridge_url` / `bridgeUrl` accordingly.
- **Node.js 24 or later.** It does not need to be on PATH; an absolute path to `node.exe` is fine.
- **Windows** (verified; other platforms have code paths but are untested).
- **Claude Code and/or Codex**.
- Peer calls need each headless CLI to be logged in once.
- The user environment variable **`DSH_MCP_TOKEN`**, whose value is the bridge token of the DSH host (the content of the file `credentialFile` points at). Restart Claude / Codex after setting it.

## Install

### 1. DSH host bridge

Check what you have first: call `bridge_capabilities` from a connected Claude / Codex and read `version`. The 1.6.x host code is identical to 1.5.0 and also reports 1.5.0; if you are already there, skip this section.

When replacing an older install:

1. **Stop DSH.**
2. Back up `<DSH_HOME>/codex-bridge-v1` (task database and worktrees) before upgrading.
3. Remove the old install, then install the new one:

```bash
node scripts/uninstall.mjs --profile <DSH_HOME>/profiles/web --json
node scripts/install.mjs --source <this repository> --profile <DSH_HOME>/profiles/web \
  --host-config <host-config.json> --require-host-entry --json
```

Both scripts accept `--dry-run` (`--plan` is a synonym) to print the plan first. `uninstall.mjs` needs `--profile`; `install.mjs` needs both `--source` and `--profile`, `--host-config` embeds the non-secret host settings into the loader row it owns, and `--require-host-entry` fails hard when the host entry is missing. Writes stay inside the given profile directory.

4. Start DSH.

Example host config (replace the paths):

```json
{
  "dataDirectory": "<DSH_HOME>/codex-bridge-v1",
  "ownerId": "<owner-id>",
  "credentialFile": "<somewhere private>/bridge-token.txt",
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

- `ownerId` is a persisted identity: keep the value an existing install used, or old tasks cannot be claimed. The default is `codex-bridge-v1`.
- The content of `credentialFile` is the bearer token; clients send it as `DSH_MCP_TOKEN`. **The host does not generate a token for you**: before installing, write a random value into that file and set the same value as the user environment variable `DSH_MCP_TOKEN`:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > <somewhere private>/bridge-token.txt
  ```

  Without `credentialFile`, the host reads the token from `DSH_MCP_TOKEN` in its own process environment.
- `maxConcurrent` defaults to 4.
- `retention` is the retention of DSH task sessions (default 7 / 30 days). It is a different policy from the 3 / 30 days of the agent-peer records below.
- `rootCallbackGrants` and `eventWake` are optional controller wake-ups; absent means off. If `eventWake.maxSummaryChars` is given it must be exactly 8192 (the default) — that is the fixed wire limit.

### 2. Claude Code from GitHub

```bash
claude plugin marketplace add <owner>/agent-bridge
claude plugin install agent-bridge@agent-bridge
claude plugin configure agent-bridge@agent-bridge
```

The marketplace name and the plugin name both come from `.claude-plugin/marketplace.json` (`agent-bridge` / `agent-bridge`). Without flags, `configure` only shows the options and which are unset; to save values, pipe a JSON object into `--values-stdin` (options left out keep their values):

```bash
echo '{"node_path":"C:/Program Files/nodejs/node.exe","peer_config":"<path>/agent-peer.json"}' | claude plugin configure agent-bridge@agent-bridge --values-stdin
```

The three options:

- `node_path`: absolute path of the Node 24 `node.exe` (the default is the literal `node`).
- `peer_config`: absolute path of the agent-peer config file (see 5 below).
- `dsh_bridge_url`: defaults to `http://127.0.0.1:3080/mcp/codex-bridge-v1`.

Then **quit the Claude desktop app completely and reopen it**.

**The pitfall**: if the MCP servers fail with `'node' is not recognized` or `CONNECTION_CLOSED`, the desktop app started `agent_peer` with the literal default `node` — its PATH usually has no node. It may also still be running an old copy from its plugin cache. Do not hand-edit the cache: use the deploy script in 3, which writes machine paths into the **deployed** plugin defaults and refreshes the Claude Code plugin cache.

### 3. One-command local deploy (Claude Code + Codex)

Works for an extracted package without git history, and for a machine that is already hand-configured. Clone or download this repository, then:

1. Copy `scripts/deploy.example.json` outside the repository and edit it. Three fields are required: `deployRoot` (holds `plugin/`, `config/`, `state/` and the Claude local marketplace below it), `nodePath` and `bridgeUrl`. Optional: `repo` (export the committed HEAD of this git repository; without it the package directory is copied as is), `gitExecutable`, `peerConfig`, `credentialFile`, `codexPluginDir`, `codexExecutable`, `codexPluginId`, `codexMarketplace`, `claudeExecutable`, `claudePluginId`. Executable paths may use whole `*` segments; the newest match is used, because both desktop apps install their CLI under version/hash directories that change on update.
2. Plan first, then run:

```bash
node scripts/deploy-local.mjs --config <your deploy.json> --dry-run
node scripts/deploy-local.mjs --config <your deploy.json>
```

It creates machine-specific files only when they are **missing** and never overwrites an existing one: the Claude local marketplace (`<deployRoot>/.claude-plugin/marketplace.json`), `config/agent-peer.json`, the Codex plugin's `.mcp.json` (`dsh_project` over HTTP with `DSH_MCP_TOKEN`, `agent_peer` with the absolute node path) and the Codex personal-marketplace entry. It writes machine paths into the deployed copy's plugin defaults, syncs the Codex plugin skills and manifest, and — when `claudeExecutable` is set — refreshes the Claude Code plugin cache.

3. **Quit and reopen the Claude desktop app**; start a new Codex session.

### 4. Codex by hand (when not using 3)

1. Put this repository's `skills/`, `.codex-plugin/`, `.codex-mcp.json`, `bin/` and `src/` into the plugin directory `~/.agents/plugins/plugins/agent-bridge`. The shipped `.codex-plugin/plugin.json` points at `./.codex-mcp.json`; when installing as a machine plugin, change its `mcpServers` to `./.mcp.json` (that is what the deploy script does).
2. Put a machine-specific `.mcp.json` in the plugin directory, based on `.codex-mcp.json`, with `agent_peer`'s `command` set to the absolute node path, its `args` pointing at the absolute `bin/peer-mcp.mjs` inside the plugin directory, and `AGENT_PEER_CONFIG` set to the absolute config path. The template's `default_tools_approval_mode: "approve"` is what makes MCP tool calls work under `codex exec`; do not drop it.
3. Add a marketplace entry to `~/.agents/plugins/marketplace.json`, with `path` relative to the user home.
4. Install the plugin:

```bash
codex plugin add agent-bridge@personal
```

### 5. agent-peer config

Claude Code and Codex should point at the **same** file so both see one job ledger and one chain ledger.

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

The main keys:

- `stateDir`: the job ledger, the chain ledger and the records index.
- `peers.<name>.executable`: absolute path of the peer headless CLI; whole `*` segments pick the newest version. It must be the real executable, not a `.cmd` / `.bat` shim (otherwise the config is refused).
- `peers.codex.delegateSandbox`: the Codex sandbox for `delegate` (`read-only` or `workspace-write`). `readOnlyDisablePlugins` disables the listed plugins in read-only runs, so a reviewer cannot act through MCP tools.
- `peers.codex.reasoningEffort` / `peers.codex.model`: optional, and **global** — they apply to every Codex peer call.
- `peers.claude-code.delegatePermissionMode` / `delegateAllowedTools`: permission mode and allowed tools for `delegate`; `review` / `consult` use the read-only tool set and `--no-session-persistence`.
- `records`: record directory name, retention after acceptance, retention for failed/disputed work, sweep interval, and the Claude sessions directory.
- `bridge`: the DSH endpoint used by the cleanup sweeper; the token comes from `DSH_MCP_TOKEN` first, with an optional `credentialFile` as the fallback.
- `limits`: timeout, concurrency and the other bounds.

There is deliberately no free-form argument list: every CLI flag is generated from a validated field, so configuration cannot reopen the read-only sandbox.

## Verify

1. Call `bridge_capabilities`: the host should report `version` `1.5.0` (the plugin version is 1.6.2 — these differ).
2. Call `peer_capabilities`: `self` should be `claude-code` on the Claude side and `codex` on the Codex side; `chain` shows your position, and every peer/mode pair states whether it is allowed and, if not, with which error code.

## Usage

Some requests you can just type:

1. Delegate to DSH: *"Break this change into bounded tasks and give them to DSH: only `src/foo/` may be written, acceptance is `npm test` passing; give me the diff and the test output."*
2. Independent review by the other harness: *"Have Codex independently review this commit for correctness; don't tell it who wrote it and don't give it my conclusion."*
3. Codex as sub-controller: *"Hand this sub-project to Codex as sub-controller — it may use its own subagents and DSH, scope is `packages/parser/`, and the result comes back to me for integration."*
4. Close out and clean up: *"Close out this root task: write the closeout record, then dry-run the cleanup and only then run it."*

There is one rule: **the harness you are talking to is the root controller of the task**, and it alone owns requirements, interface contracts, authorization, acceptance and integration — everything it hands out comes back as a result it must verify. No one routes around it to change requirements, and no work is delegated back to it.

## Security model

- **Token**: the host endpoint accepts only requests with the correct bearer token; the token comes from the user environment variable `DSH_MCP_TOKEN` and is never written into a plugin manifest.
- **DSH tasks cannot run a shell**: the current adapter rejects `allowShell: true` outright, with no workaround.
- **Path fences**: a worker may only read `scope.readRoots` and write `writeRoots`; going outside is an explicit refusal, not a hint.
- **Network**: available only when the packet grants it.
- **Read-only peers cannot write**: `consult` / `review` give the peer a read-only sandbox and a read-only tool set and disable plugins that could act; a read-only Claude run leaves no session behind.
- **Delegation chain enforcement**: no self target, no harness already on the chain, bounded hops and delegate depth; a malformed chain is refused rather than repaired.
- **Only recorded sessions are cleaned**: the sweeper touches only sessions listed in a closeout record, and only while the record file exists; anything not in a record is never touched.
- **Nothing leaves the machine**: apart from the model calls the harnesses already make, no data goes anywhere else.

## Known limitations

- Verified on **Windows** only; other platforms have code paths but are untested.
- **DSH 0.2.0-rc.2 is a preview** and its APIs can change.
- Codex reasoning effort **cannot be set per peer call**; only globally through `peers.codex.reasoningEffort`.
- The automatic cleanup runs only **while a Claude Code or Codex session with the plugin is open**.
- Each headless CLI must be logged in once, or peer calls fail.

## Documentation

- [docs/reference/dsh-bridge-reference.zh.md](docs/reference/dsh-bridge-reference.zh.md): the host bridge in depth (Chinese; the 1.2/1.3-era technical reference)
- [docs/event-wake.md](docs/event-wake.md): event wake (durable outbox → controller)
- [docs/long-supervisor.md](docs/long-supervisor.md): the long-task supervisor (edition 1)
- [docs/recurrent-supervisor.md](docs/recurrent-supervisor.md): the bounded recurrent supervisor (edition 2)
- [docs/deadline-watchdog.md](docs/deadline-watchdog.md): the one-shot deadline watchdog
- [CONTRACTS.md](CONTRACTS.md): the implementation baseline for the stable exports
- [CHANGELOG.md](CHANGELOG.md): per-release changes and known boundaries

## Development

```bash
npm install    # dev dependency only: @deepseek-ai/dsh-llm, used by the adapter tests
npm test       # node --test test/*.test.mjs
```

CI runs on Windows + Node 24 (`.github/workflows/test.yml`).

Much of this project's own code was written through this bridge: DSH Flash workers implemented it and Claude Code reviewed, tested and integrated it — the commit authors and the release notes in `CHANGELOG.md` show it.

## License

MIT, see [LICENSE](LICENSE).
