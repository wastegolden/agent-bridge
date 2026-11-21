[中文](README.md) | English

# Agent Bridge

Agent Bridge lets **Claude Code**, **Codex**, **Antigravity** and **DeepSeek Harness (DSH)** call each other. The harness you are talking to is the **root controller** of that task: it hands bounded implementation to DSH Flash workers, and consultation, independent review or a whole sub-project to another peer harness. There is exactly one root controller per task, DSH worker tasks carry explicit read/write roots, a tool allowlist and a budget, and the delegation chain is enforced by the server, so delegation loops cannot form. Version 2.1.0, MIT.

> Independent project; not affiliated with, or endorsed by, DeepSeek, OpenAI, Anthropic or Google.

## How it fits together

```
                      you
                       │
  root controller: Claude Code / Codex / Antigravity (exactly one per task)
                       │
        ┌──────────────┴──────────────┐
        │                             │
   dsh_project                   agent_peer
   MCP stdio → HTTP              MCP stdio
        │                             │
        ▼                             ▼
  DSH host bridge            another harness's headless CLI
  /mcp/codex-bridge-v1       consult / review (read-only) / delegate (sub-controller)
        │
        ▼
  DSH Flash worker (one git worktree per writer task)
```

| Part | Where | What it does |
|---|---|---|
| DSH host bridge | `dsh-host/index.cjs`, `src/*` | A DSH plugin that serves the MCP endpoint `/mcp/codex-bridge-v1` on the DSH host (default `http://127.0.0.1:3080`), authenticated with a bearer token |
| `dsh_project` | MCP server in each plugin manifest | Each root uses the stdio carrier `bin/bridge.mjs`, reads its own credential file and forwards to the host HTTP endpoint |
| `agent_peer` | `bin/peer-mcp.mjs`, `src/peer/*` | Runs another peer harness (Claude Code, Codex or Antigravity) through its headless CLI for consult / read-only review / sub-controller delegation, with a job ledger, chain rules and closeout records |
| Skills | `skills/agent-bridge-routing`, `skills/dsh-project-execution` | Routing rules and the DSH execution discipline |

### DSH host bridge

The host bridge is a DSH plugin. It mounts the MCP endpoint `/mcp/codex-bridge-v1` (default `http://127.0.0.1:3080`) on the DSH host and accepts only requests carrying the correct bearer token. It runs tasks as bounded packets on DSH Flash workers:

- one git worktree per writer task, so parallel writers stay isolated;
- the packet declares explicit read roots, write roots, a tool allowlist and a budget; the current adapter rejects `allowShell: true`, so a worker gets no shell;
- network access is declared by the packet too, and is available only when granted;
- the lifecycle is review → integrate → acknowledge → archive / cleanup, and every step requires the previous step's real evidence.

It exposes 20 `bridge_*` tools (6 read, 1 submit, 13 mutate; the host's `bridge_capabilities` reports `version` **2.1.0**, the same as the plugin version):

- tasks: `bridge_submit`, `bridge_check`, `bridge_result`, `bridge_dossier`
- authorization: `bridge_approve`, `bridge_clarify`
- follow-up: `bridge_followup`
- control: `bridge_cancel`, `bridge_reconcile`, `bridge_list`, `bridge_pause`, `bridge_resume`
- closeout: `bridge_acknowledge`, `bridge_archive`, `bridge_cleanup`
- catalogue: `bridge_models`, `bridge_capabilities`
- workspaces: `bridge_workspace_review`, `bridge_workspace_refresh`, `bridge_workspace_integrate`

Each tool has exactly one category: read tools do not check ownership; `bridge_submit` binds the task to the current controller; mutate tools require the task to belong to the current controller, or an administrator supplying `override:{reason}` (audit intent is written before execution, then the result audit). The complete controller-identity, audit and migration reference is [docs/controller-identity.md](docs/controller-identity.md).

### dsh_project

Both clients run `bin/bridge.mjs` to forward MCP stdio to the host HTTP endpoint. Claude's required file option `bridge_credential_file` and both Codex MCP entries supply each root's own path through `DSH_BRIDGE_CREDENTIAL_FILE`; `agent_peer` uses that same root-specific file. Root launch environments must have `DSH_MCP_TOKEN` cleared, and root requests send no via headers. Delegates retain priority for the environment token explicitly injected by the peer server and carry their delegation chain.

### agent_peer

`agent_peer` (`bin/peer-mcp.mjs`) runs another harness through its headless CLI (`codex exec` / `claude -p` / `agy --input-format stream-json --output-format stream-json`) and exposes 9 tools:

- `peer_capabilities`: where I sit on the chain, whom I may call right now, which modes are allowed, and each peer's default model, default reasoning effort and allowed effort list (`defaultModel`, `defaultReasoningEffort`, `reasoningEfforts`)
- `peer_ask`, `peer_check`, `peer_result`, `peer_cancel`, `peer_list`: job lifecycle
- `record_closeout`, `record_list`: closeout records and index
- `cleanup_run`: sweep temporary sessions (dry run by default)

Three modes: `consult` (a question) and `review` (an independent review) are read-only — the peer gets a read-only sandbox and a read-only tool set; only `delegate` (sub-controller) may write inside `cwd` / `addDirs`. The chain rules are enforced by the server, not by prompts: no self target, no call to any harness already on the chain (so work can never flow back to the root controller), at most 2 hops below the root by default, and sub-controller appointment only to a default depth of 1.

Every `peer_ask` can also set `model` and `reasoningEffort` for that one run — for a new session and for a continuation (`sessionId`) alike — so one task can switch model and effort between turns without editing the config or restarting the MCP server. Precedence for both: the per-call argument, then the config default (`peers.codex.model` / `peers.codex.reasoningEffort`, `peers.claude-code.model` / `peers.claude-code.effort`), then the CLI's own default (nothing passed); a per-call `reasoningEffort` value matches `^[a-z][a-z0-9_-]{0,31}$`. Every job record (`job.json`, the `peer_check` / `peer_result` job snapshots, `peer_list` rows) carries `model` (string|null), `modelSource`, `reasoningEffort` (string|null) and `effortSource`, with source `call` / `config` / `cli-default`, describing what was actually passed to the CLI (null + `cli-default` when nothing was passed); the closeout record shows the line `- 模型: <model or 'CLI 默认'>（<source>） · 思考强度: <effort or 'CLI 默认'>（<source>）`, and older jobs without the fields show the existing missing-value marker.

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
- One bearer token file per root controller (host `controllers[].tokenFile`), read through that root's MCP `DSH_BRIDGE_CREDENTIAL_FILE` setting. Clear User- and root Process-level `DSH_MCP_TOKEN`; never persist tokens in environment variables. Fully quit and restart Claude / Codex after configuration.

## Install

### 1. DSH host bridge

Check what you have first: call `bridge_capabilities` from a connected Claude / Codex / Antigravity. **Only** `controllerIdentity.enabled === true` together with `controllerIdentity.schemaVersion === 1` means the host already runs the controller-identity version, so you can skip this section; if either is missing (for example an older host without `controllerIdentity`, or a `schemaVersion` other than 1), replace the old install as below. Do not use the `version` field in place of those two checks; the current host and plugin should both report `2.1.0`, but a version string is not evidence of identity support.

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

When upgrading from shared `credentialFile` authentication to controller identity (`controllers`), follow [docs/controller-identity.md](docs/controller-identity.md): stop new submissions → drain the whole host → stop and back up the old package, configuration, database and token material → install the new package and restart with the complete overlap config retaining `legacy` → switch clients → smoke-test both real roots and both delegate directions → drain again → remove `legacy` and restart → verify the old token gets HTTP 401 and the new identities remain correct → resume submissions. Switch clients after the compatible host is ready; ordinary submissions stay paused throughout.

Example host config (replace the paths; the full validation rules are in [docs/controller-identity.md](docs/controller-identity.md)):

```json
{
  "dataDirectory": "<DSH_HOME>/codex-bridge-v1",
  "ownerId": "<owner-id>",
  "controllers": [
    { "id": "claude-code", "tokenFile": "<private>/credentials/claude-code.token" },
    { "id": "codex", "tokenFile": "<private>/credentials/codex.token" },
    { "id": "operator", "tokenFile": "<private>/credentials/operator.token", "admin": true }
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

- `ownerId` is a persisted identity: keep the value an existing install used, or old tasks cannot be claimed. The default is `codex-bridge-v1`.
- `controllers` is a required array (1–32). Each controller has its own bearer token file; `id` matches `^[a-z][a-z0-9-]{0,63}$` and is unique, `tokenFile` is an absolute local path, and the trimmed file content must be 24–512 printable ASCII characters with no internal whitespace (a new token is 64 hex characters from `randomBytes(32)`). Duplicate or weak tokens refuse the mount; give `admin: true` only to the real `operator`. The configuration stores paths, never tokens.
- `identityMigrationBackupDirectory`: required before migrating an existing (`user_version=0`) task store, which must be the shipped v0 schema (`tasks(id,owner,idem,hash,body,UNIQUE(owner,idem))`, no `submittedBy`); the host takes a consistent snapshot first. `user_version=1` must match the shipped v1 schema (with `submittedBy` and `UNIQUE(owner,submittedBy,idem)`); a version/schema mismatch — for example `user_version=0` on the v1 table shape — is `STORE_SCHEMA_UNSUPPORTED`, never guessed or repaired. A new empty store (`user_version=0` with no schema objects) is created directly at v1. The old top-level `token` / `credentialFile` / `tokenEnv` authentication fields are refused and must be migrated to `controllers`.
- Each client points both MCP entries' `DSH_BRIDGE_CREDENTIAL_FILE` at its own token file. Deployment tooling creates missing token files and writes only paths into configuration; an existing file is validated and kept:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > <private>/credentials/<controller-id>.token
  ```

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
echo '{"node_path":"C:/Program Files/nodejs/node.exe","peer_config":"<path>/agent-peer-claude-code.json","bridge_credential_file":"<private>/credentials/claude-code.token"}' | claude plugin configure agent-bridge@agent-bridge --values-stdin
```

The four options:

- `node_path`: absolute path of the Node 24 `node.exe` (the default is the literal `node`).
- `peer_config`: absolute path of the agent-peer config file (see 5 below).
- `dsh_bridge_url`: defaults to `http://127.0.0.1:3080/mcp/codex-bridge-v1`.
- `bridge_credential_file`: required single file path to the Claude root's token file; both MCP servers use it.

Then **quit the Claude desktop app completely and reopen it**.

**The pitfall**: if the MCP servers fail with `'node' is not recognized` or `CONNECTION_CLOSED`, the desktop app started `agent_peer` with the literal default `node` — its PATH usually has no node. It may also still be running an old copy from its plugin cache. Do not hand-edit the cache: use the deploy script in 3, which writes machine paths into the **deployed** plugin defaults and refreshes the Claude Code plugin cache.

### 3. Local deployment and client switching (Claude Code + Codex)

Works for an extracted package without git history, and for a machine that is already hand-configured. Clone or download this repository, then:

1. Copy `scripts/deploy.example.json` outside the repository and edit it. Three fields are required: `deployRoot` (holds `plugin/`, `config/`, `state/` and the Claude local marketplace below it), `nodePath` and `bridgeUrl`. Optional: `repo` (export the committed HEAD of this git repository; without it the package directory is copied as is), `gitExecutable`, `peerConfig`, `identity` (`credentialDirectory`, `migrationBackupDirectory`, optional `legacyTokenFile`; enabling identity refuses the old shared `credentialFile` configuration, and it emits the `controllers` + `identityMigrationBackupDirectory` fragment to merge into the complete host config plus one peer config per root), `codexPluginDir`, `codexExecutable`, `codexPluginId`, `codexMarketplace`, `claudeExecutable`, `claudePluginId`. Executable paths may use whole `*` segments; the newest match is used, because both desktop apps install their CLI under version/hash directories that change on update.
2. Prepare an isolated package for the identity migration:

```bash
node scripts/deploy-local.mjs --config <your deploy.json> --prepare-only --dry-run
node scripts/deploy-local.mjs --config <your deploy.json> --prepare-only
```

`--prepare-only` creates an isolated `<deployRoot>/plugin.prepared-*` and returns its directory for the switch. It also generates identity artifacts: missing token files, per-root peer configs, overlap/final host fragments and optional launchers. Existing valid tokens retain their bytes; per-root peer configs share `stateDir` and reference their own files, and mismatched existing configs are refused. Preparation preserves existing `plugin/`, `plugin.prev/`, marketplaces, client caches and configuration, and starts no app CLI. `--dry-run` writes nothing and generates no token.

A normal local installation can still omit `--prepare-only` for a full deployment, which syncs Codex configuration and refreshes the Claude cache when configured. For existing clients' R8 migration, use this preparation and switch workflow so actual installed files are backed up first.

3. Once the overlap host is ready, save your work and fully exit Claude, Codex and their MCP children, then switch clients:

```bash
node scripts/switch-controller-clients.mjs --config <your deploy.json> --prepared-plugin <returned-prepared-directory>
node scripts/switch-controller-clients.mjs --config <your deploy.json> --prepared-plugin <returned-prepared-directory> --apply
```

The first command defaults to dry-run; explicit `--dry-run` is also supported. The script locates installed configuration and refuses a Machine-level `DSH_MCP_TOKEN` or residual processes. It backs up files and the old User variable state under `F:/temp/agent-bridge-upstream/deploy-p0b/client-backups/<timestamp>` with access restricted to the current user, updates runtime files, skills and configuration in the actual caches, preserves unrelated settings, and clears the User and its own Process token. Claude's installation record receives the new version while existing cache directory names remain unchanged. Repeated runs skip unchanged content and retain the first backup. Preview rollback with `node scripts/switch-controller-clients.mjs --rollback <backup-directory>`; add `--apply` to restore. Client rollback does not restore the database.

4. Restart both apps from their ordinary launch entries, such as the Start menu, complete any required plugin-enable interaction, and verify each `bridge_capabilities.controllerIdentity.self` and `admin:false` before the two-direction delegate smoke. Optional wrappers are in the returned prepared directory's `config/launch-*.mjs` and only set file paths. Existing live wrappers retain their bytes; use the new prepared paths for CLI wrapper launches. See the [switch procedure and mutation inventory](docs/controller-identity.md#4-switch-the-windows-clients).

### 4. Codex by hand (when not using 3)

1. Put this repository's `skills/`, `.codex-plugin/`, `.codex-mcp.json`, `bin/` and `src/` into the plugin directory `~/.agents/plugins/plugins/agent-bridge`. The shipped `.codex-plugin/plugin.json` points at `./.codex-mcp.json`; when installing as a machine plugin, change its `mcpServers` to `./.mcp.json` (that is what the deploy script does).
2. Put a machine-specific `.mcp.json` in the plugin directory, based on `.codex-mcp.json`. The template has two stdio entries and both must be changed to absolute paths by hand: for `dsh_project` set `command` to the absolute node path and `args` to the absolute `bin/bridge.mjs` inside the plugin directory; for `agent_peer` set `command` to the same absolute node path, `args` to the absolute `bin/peer-mcp.mjs`, and `AGENT_PEER_CONFIG` to **Codex's own** peer config path. Set both entries' `env.DSH_BRIDGE_CREDENTIAL_FILE` to Codex's file path and `env.DSH_BRIDGE_URL` to the same endpoint; retain the delegate token and chain forwarding in `env_vars`. The template's `default_tools_approval_mode: "approve"` is what makes MCP tool calls work under `codex exec`; do not drop it.
3. Add a marketplace entry to `~/.agents/plugins/marketplace.json`, with `path` relative to the user home.
4. Install the plugin:

```bash
codex plugin add agent-bridge@personal
```

### 4b. Antigravity plugin and headless CLI

Antigravity works in **both** directions: as a **root controller** via a native Antigravity plugin, and as a **peer target** via the headless `agy` CLI:

- **Opt-in local deployment**: add `antigravityPluginDir` (e.g. `C:/Users/<you>/.gemini/config/plugins/agent-bridge`) and/or `antigravityExecutable` (e.g. `C:/Users/<you>/AppData/Local/agy/bin/agy.exe`) to `deploy.json`, then run `node scripts/deploy-local.mjs --config <deploy.json>`. When omitted, Claude+Codex deployments remain 100% unchanged; when present, the script generates `antigravity.token`, `agent-peer-antigravity.json`, `launch-antigravity.mjs`, adds `antigravity` to the host controller fragments, deploys the native plugin (`plugin.json`, `mcp_config.json`, `skills/`, `agents/agent-bridge-readonly.md`, `agents/agent-bridge-readonly-web.md`), and runs `agy plugin validate`.
- **Read-only and delegate boundaries**: `consult` / `review` runs with `--disable-slash-commands`, an optional read-only agent (`readOnlyAgent` = `agent-bridge-readonly` with `read_file` only by default; switched to `readOnlyWebAgent` = `agent-bridge-readonly-web` adding `search_web` when the controller passes `webSearch: true`), and session-only `--settings` (`allowNonWorkspaceAccess: false`, denying `write_file(*)`, `command(*)`, `mcp(*)`, `execute_url(*)`, `download_url(*)`). The per-call `peer_ask.webSearch` toggle also works for `claude-code` (`WebSearch`/`WebFetch`) and is explicitly refused (`PEER_ARGS_INVALID`) on `codex` and in `delegate` mode. Like Codex, an Antigravity `delegate` keeps its installed plugins/MCP config, uses `delegateMode` (`accept-edits` or `auto`), optional `--sandbox` (`delegateSandbox: true`), and `delegateAllowedPermissions` (defaulting to `mcp(agent-bridge_dsh_project/*)` and `mcp(agent-bridge_agent_peer/*)`), while inheriting the root credential and chain.
- **Session cleanup**: temporary `agy` CLI sessions under `records.antigravityDataDir` (default `~/.gemini/antigravity-cli`: `conversations/<id>.db`, `brain/<id>/`, `presence/<id>.lock`) are deleted by the retention sweeper once their closeout record becomes due.

### 5. agent-peer config

Each root gets its **own separate** agent-peer config file: Claude's `peer_config` points at `config/agent-peer-claude-code.json` and Codex's `AGENT_PEER_CONFIG` at `config/agent-peer-codex.json`. Both files share one `stateDir` (so both roots see the same job and chain ledger), but each `bridge.credentialFile` points at that root's own controller token file (`credentials/claude-code.token` / `credentials/codex.token`). Never hand one file with a `credentialFile` to both roots: one root would read the other's credential. The template below uses `<root-controller-id>`; the deploy tooling generates one copy per root. If the machine still has the old single `config/agent-peer.json`, the deploy tooling derives each missing per-root config from it and points `bridge.credentialFile` at that root's own token file; an existing per-root config is validated and kept.

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
  "bridge": { "url": "http://127.0.0.1:3080/mcp/codex-bridge-v1", "credentialFile": "<private>/credentials/<root-controller-id>.token" },
  "limits": { "timeoutMs": 1800000, "maxConcurrentJobs": 3 }
}
```

The main keys:

- `stateDir`: the job ledger, the chain ledger and the records index.
- `peers.<name>.executable`: absolute path of the peer headless CLI; whole `*` segments pick the newest version. It must be the real executable, not a `.cmd` / `.bat` shim (otherwise the config is refused).
- `peers.codex.delegateSandbox`: the Codex sandbox for `delegate` (`read-only` or `workspace-write`). `readOnlyDisablePlugins` disables the listed plugins in read-only runs, so a reviewer cannot act through MCP tools.
- `peers.codex.model` / `peers.codex.reasoningEffort`, `peers.claude-code.model` / `peers.claude-code.effort` and `peers.antigravity.model` / `peers.antigravity.effort`: optional **defaults** that a single `peer_ask` may override with the same argument; when neither is passed the CLI's own default applies.
- `peers.<target>.efforts`: optional, replaces the allowed reasoning-effort list for that target (1 to 16 unique strings, each matching `^[a-z][a-z0-9_-]{0,31}$`). When absent the built-in list applies: codex `minimal, low, medium, high, xhigh, max, ultra`; claude-code / antigravity `low, medium, high, xhigh, max`. A per-call value outside the list is refused with `PEER_ARGS_INVALID` (field `reasoningEffort`), a config default outside it with `PEER_CONFIG_INVALID`.
- `peers.claude-code.delegatePermissionMode` / `delegateAllowedTools`: permission mode and allowed tools for `delegate`; `review` / `consult` use the read-only tool set and `--no-session-persistence`.
- `peers.antigravity.readOnlyAgent` / `readOnlyWebAgent` / `delegateMode` / `delegateSandbox` / `delegateAllowedPermissions`: local read-only agent, web-enabled read-only agent, `delegate` mode (`accept-edits` / `auto`), optional `--sandbox`, and allowed Antigravity permission rules for `delegate`.
- `records`: record directory name, retention after acceptance, retention for failed/disputed work, sweep interval, Claude sessions directory, and Antigravity CLI data directory (`antigravityDataDir`).
- `bridge`: the DSH endpoint used by the cleanup sweeper. Roots read their file through `DSH_BRIDGE_CREDENTIAL_FILE` or their own `credentialFile`; delegates keep priority for the explicitly injected `DSH_MCP_TOKEN`.
- `limits`: timeout, concurrency and the other bounds.

There is deliberately no free-form argument list: every CLI flag is generated from a validated field, so configuration cannot reopen the read-only sandbox.

## Verify

1. Call `bridge_capabilities`: the host should report `version` `2.1.0` (the same as the plugin version). `controllerIdentity.self` / `admin` must match the controller token you are using, `controllers` lists the configured IDs, and `controllerIdentity.enabled` is `true` with `schemaVersion` `1`.
2. Call `peer_capabilities`: `self` should be `claude-code` on the Claude side and `codex` on the Codex side; `chain` shows your position, and every peer/mode pair states whether it is allowed and, if not, with which error code.
3. Run one disposable delegate in each direction. Claude → Codex: confirm the delegate inherited the root's (Claude's) non-administrator identity and `via` chain and can complete one cheap DSH submission; the Codex side keeps its own MCP configuration, so do not claim Codex excludes the user's other MCP servers. Codex → Claude: confirm the Claude Code delegate sees only the plugin's two MCP servers and that the user's other MCP servers are absent (the explicit narrowing since 1.7.0), and that it can still submit one cheap DSH task.

## Usage

Some requests you can just type:

1. Delegate to DSH: *"Break this change into bounded tasks and give them to DSH: only `src/foo/` may be written, acceptance is `npm test` passing; give me the diff and the test output."*
2. Independent review by the other harness: *"Have Codex independently review this commit for correctness; don't tell it who wrote it and don't give it my conclusion."*
3. Independent review at a chosen effort: *"Have Codex independently review this commit at xhigh reasoning effort; don't tell it who wrote it and don't give it my conclusion."*
4. Codex as sub-controller: *"Hand this sub-project to Codex as sub-controller — it may use its own subagents and DSH, scope is `packages/parser/`, and the result comes back to me for integration."*
5. Close out and clean up: *"Close out this root task: write the closeout record, then dry-run the cleanup and only then run it."*

There is one rule: **the harness you are talking to is the root controller of the task**, and it alone owns requirements, interface contracts, authorization, acceptance and integration — everything it hands out comes back as a result it must verify. No one routes around it to change requirements, and no work is delegated back to it.

## Security model

- **Tokens and ownership**: one bearer token file per controller; the host accepts only the correct token and derives the request principal from it. `task.submittedBy` is written by the server and immutable. Read tools do not check ownership; mutate tools require your own task, or an administrator supplying `override:{reason}` (durable audit intent, then execution, then a result audit). Administrator tokens are never forwarded to child processes.
- **History and override**: historical tasks have `submittedBy:null` and need an administrator plus a nonblank reason (≤500 characters). `metadata.controller`, `parentTaskId` and `via` are audit/coordination information, never authority.
- **Delegation inherits the root credential**: a delegate inherits the root controller's non-administrator credential, so its tasks belong to the root principal; sessions sharing one controller ID share permissions, and a delegate may modify other tasks of the same root principal — an accepted boundary of the cooperating-agent threat model. Final acceptance remains the root controller's responsibility.
- **DSH tasks cannot run a shell**: the current adapter rejects `allowShell: true` outright, with no workaround.
- **Path fences**: a worker may only read `scope.readRoots` and write `writeRoots`; going outside is an explicit refusal, not a hint.
- **Network**: available only when the packet grants it.
- **Read-only peers cannot write**: `consult` / `review` give the peer a read-only sandbox and a read-only tool set and disable plugins that could act; a read-only Claude run leaves no session behind.
- **Only the Claude Code delegate's MCP surface is narrowed**: when Claude Code is the delegate (including Codex → Claude), it runs with `--strict-mcp-config` and an MCP configuration containing only the plugin's two entries, and the user's other MCP servers are deliberately excluded (an explicit behaviour change from 1.7.0). When Claude → Codex, the Codex delegate does not get this two-entry restriction: smoke-test that direction for inherited root identity/carrier only, and do not claim it excludes other MCP servers. Smoke-test both directions after an upgrade (see Verify).
- **No credential fallback**: when a delegate or child loses its environment token, the carrier and peer client refuse instead of reading a local credential file; tokens are never written to job records, prompts, argv or logs.
- **Delegation chain enforcement**: no self target, no harness already on the chain, bounded hops and delegate depth; a malformed chain is refused rather than repaired.
- **Only recorded sessions are cleaned**: the sweeper touches only sessions listed in a closeout record, and only while the record file exists; anything not in a record is never touched.
- **Nothing leaves the machine**: apart from the model calls the harnesses already make, no data goes anywhere else.

## Known limitations

- Verified on **Windows** only; other platforms have code paths but are untested.
- **DSH 0.2.0-rc.2 is a preview** and its APIs can change.
- The automatic cleanup runs only **while a Claude Code or Codex session with the plugin is open**.
- Each headless CLI must be logged in once, or peer calls fail.

## Documentation

- [docs/controller-identity.md](docs/controller-identity.md): controller identity, credentials and token files, the 6/1/13 tool split and administrator override audit, client-declared `via`, the store migration, and the upgrade/rollback with the two-direction smoke test
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
