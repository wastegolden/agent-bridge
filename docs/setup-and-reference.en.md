[中文](setup-and-reference.md) | English

# Agent Bridge Detailed Setup, Configuration & Technical Reference

This guide covers full installation, manual setup, configuration templates, migration from older versions, and the complete tool and security reference. If you just want a clear overview of what Agent Bridge does, read [README.en.md](../README.en.md) first.

> Baseline version: **2.1.1** (Node.js 24+, verified on Windows with DSH 0.2.0-rc.2).

---

## Contents

- [1. DSH Host Bridge Setup](#1-dsh-host-bridge-setup)
- [2. Recommended: Local Deployment (Claude Code + Codex + Antigravity)](#2-recommended-local-deployment-claude-code--codex--antigravity)
- [3. Installing the Claude Code Plugin from GitHub](#3-installing-the-claude-code-plugin-from-github)
- [4. Manual Codex Plugin Setup](#4-manual-codex-plugin-setup)
- [5. Antigravity Plugin & Headless CLI Details](#5-antigravity-plugin--headless-cli-details)
- [6. agent-peer Configuration Reference](#6-agent-peer-configuration-reference)
- [7. Post-Install Verification & Smoke Tests](#7-post-install-verification--smoke-tests)
- [8. MCP Tool Inventory](#8-mcp-tool-inventory)
- [9. Security Boundaries & Implementation Details](#9-security-boundaries--implementation-details)
- [10. Legacy "codex-bridge" Identifiers](#10-legacy-codex-bridge-identifiers)

---

## 1. DSH Host Bridge Setup

If you only use `agent_peer` between Claude Code, Codex, and Antigravity without DSH, you can skip this section.

### Check existing host status

Call `bridge_capabilities` from a connected client:

- **Only** when `controllerIdentity.enabled === true` and `controllerIdentity.schemaVersion === 1` is the host already running the controller-identity build.
- If either is missing, replace the older installation using the steps below. Do not rely on the `version` string alone.

### Install or upgrade the DSH host plugin

1. **Stop DSH.**
2. Back up `<DSH_HOME>/codex-bridge-v1` (task database and worktrees).
3. Remove the old install and install the new one (both scripts support `--dry-run` / `--plan`):

```bash
node scripts/uninstall.mjs --profile <DSH_HOME>/profiles/web --json
node scripts/install.mjs --source <this-repo> --profile <DSH_HOME>/profiles/web \
  --host-config <host-config.json> --require-host-entry --json
```

`--host-config` embeds non-secret host settings into the managed loader row; `--require-host-entry` fails fast if the host entry is missing. All writes stay inside the specified profile directory.

4. Start DSH.

> When upgrading from shared `credentialFile` authentication to per-controller `controllers`, follow the phased rollout in [controller-identity.md](controller-identity.md) (pause submissions → drain → back up → overlap config restart → switch clients → smoke test → drain → remove `legacy`).

### Example host configuration

```json
{
  "dataDirectory": "<DSH_HOME>/codex-bridge-v1",
  "ownerId": "<owner-id>",
  "controllers": [
    { "id": "claude-code", "tokenFile": "<private>/credentials/claude-code.token" },
    { "id": "codex", "tokenFile": "<private>/credentials/codex.token" },
    { "id": "antigravity", "tokenFile": "<private>/credentials/antigravity.token" },
    { "id": "operator", "tokenFile": "<private>/credentials/operator.token", "admin": true }
  ],
  "identityMigrationBackupDirectory": "<private>/backups",
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

Key fields:

- `ownerId`: persistent ownership identity (default `codex-bridge-v1`). Keep your existing value when upgrading so older tasks remain claimable.
- `controllers`: required array (1–32 entries). Each controller has a unique `id` (`^[a-z][a-z0-9-]{0,63}$`) and an absolute local `tokenFile` containing 24–512 printable ASCII characters without internal whitespace. Duplicate or weak tokens are refused. Only grant `admin: true` to an `operator` identity. Config stores paths, never tokens.
- Generate a token manually if needed (the local deploy script creates missing ones automatically without overwriting valid existing files):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > <private>/credentials/<controller-id>.token
```

- `identityMigrationBackupDirectory`: required before migrating an existing v0 store (`user_version=0`); the host snapshots the DB before migrating. Empty databases are created directly at v1; schema mismatches fail with `STORE_SCHEMA_UNSUPPORTED`. Legacy top-level `token` / `credentialFile` / `tokenEnv` fields are refused.
- `maxConcurrent`: defaults to `4`.
- `retention`: DSH session retention (default 7 days success / 30 days failure), separate from `agent-peer` record retention.
- `rootCallbackGrants` / `eventWake`: optional controller wake-ups (off by default). If provided, `eventWake.maxSummaryChars` must be exactly `8192`.

---

## 2. Recommended: Local Deployment (Claude Code + Codex + Antigravity)

Best choice for local machines and desktop apps (avoids missing `node` in desktop `PATH` and stale plugin caches).

### Step 1: Prepare `deploy.json`

Copy `scripts/deploy.example.json` outside the repository and adjust paths:

- **Required**: `deployRoot` (holds `plugin/`, `config/`, `state/` and local marketplace), `nodePath` (absolute path to Node 24 `node.exe`), `bridgeUrl`.
- **Optional**:
  - `repo`: export committed `HEAD` from a git repo; omit to copy the current directory.
  - `gitExecutable`, `peerConfig`.
  - `identity`: `credentialDirectory`, `migrationBackupDirectory`, optional `legacyTokenFile` — generates per-root token files, per-root `agent-peer-*.json` configs, and host config fragments.
  - `codexPluginDir`, `codexExecutable`, `codexPluginId`, `codexMarketplace`.
  - `claudeExecutable`, `claudePluginId`.
  - `antigravityPluginDir`, `antigravityExecutable` (opt-in; omitted leaves Claude+Codex outputs untouched).

> Executable paths support whole `*` wildcard segments; the newest match is chosen automatically.

### Step 2: Run deployment

**Fresh local install**:

```bash
node scripts/deploy-local.mjs --config <your-deploy.json> --dry-run
node scripts/deploy-local.mjs --config <your-deploy.json>
```

**Phased client switch (migrating existing installs)**:

1. Generate an isolated prepared package without touching live caches:

```bash
node scripts/deploy-local.mjs --config <your-deploy.json> --prepare-only --dry-run
node scripts/deploy-local.mjs --config <your-deploy.json> --prepare-only
```

2. Once the overlap host is ready, save your work and fully quit Claude, Codex, and residual MCP child processes, then switch (dry-run by default; add `--apply` to execute):

```bash
node scripts/switch-controller-clients.mjs --config <your-deploy.json> --prepared-plugin <prepared-dir>
node scripts/switch-controller-clients.mjs --config <your-deploy.json> --prepared-plugin <prepared-dir> --apply
```

The switcher checks for residual processes or Machine-level `DSH_MCP_TOKEN`, backs up existing files and User env state, updates runtime files/skills/configs in place, and clears the shared token. To roll back client files (database not rolled back):

```bash
node scripts/switch-controller-clients.mjs --rollback <backup-dir>
node scripts/switch-controller-clients.mjs --rollback <backup-dir> --apply
```

See [controller-identity.md](controller-identity.md#4-switch-the-windows-clients) for the full inventory.

---

## 3. Installing the Claude Code Plugin from GitHub

```bash
claude plugin marketplace add wastegolden/agent-bridge
claude plugin install agent-bridge@agent-bridge
claude plugin configure agent-bridge@agent-bridge
```

Pass values via `--values-stdin` (omitted options keep existing values):

```bash
echo '{"node_path":"C:/Program Files/nodejs/node.exe","peer_config":"<path>/agent-peer-claude-code.json","bridge_credential_file":"<private>/credentials/claude-code.token"}' | claude plugin configure agent-bridge@agent-bridge --values-stdin
```

Options:

- `node_path`: absolute path to Node 24 `node.exe` (defaults to literal `node`).
- `peer_config`: absolute path to Claude Code's `agent-peer` config file.
- `dsh_bridge_url`: defaults to `http://127.0.0.1:3080/mcp/codex-bridge-v1`.
- `bridge_credential_file`: required path to Claude Code's own token file (used by both MCP servers).

Then **fully quit and reopen the Claude desktop app**.

> **Troubleshooting**: `'node' is not recognized` or `CONNECTION_CLOSED` usually means the desktop app's `PATH` lacks `node` or it is running a stale plugin cache. Do not hand-edit the cache; use `deploy-local.mjs` in Section 2 instead.

---

## 4. Manual Codex Plugin Setup

If not using Section 2:

1. Copy `skills/`, `.codex-plugin/`, `.codex-mcp.json`, `bin/`, and `src/` into `~/.agents/plugins/plugins/agent-bridge`. Change `mcpServers` in `.codex-plugin/plugin.json` from `./.codex-mcp.json` to `./.mcp.json`.
2. Create a machine-specific `.mcp.json` based on `.codex-mcp.json`:
   - Set `command` to the absolute `node.exe` path and `args` to absolute `bin/bridge.mjs` / `bin/peer-mcp.mjs` paths.
   - Point `AGENT_PEER_CONFIG` to **Codex's own** peer config file.
   - Set `DSH_BRIDGE_CREDENTIAL_FILE` (Codex token file) and `DSH_BRIDGE_URL` in both entries; preserve delegate token and chain forwarding in `env_vars`.
   - Keep `default_tools_approval_mode: "approve"` (required for MCP calls under `codex exec`).
3. Add a marketplace entry in `~/.agents/plugins/marketplace.json` (`path` relative to user home).
4. Install the plugin:

```bash
codex plugin add agent-bridge@personal
```

---

## 5. Antigravity Plugin & Headless CLI Details

Antigravity works bidirectionally — as a **root controller** and as a **peer target** via the headless `agy` CLI:

- **Opt-in deployment**: add `antigravityPluginDir` (e.g., `C:/Users/<you>/.gemini/config/plugins/agent-bridge`) and/or `antigravityExecutable` (e.g., `C:/Users/<you>/AppData/Local/agy/bin/agy.exe`) to `deploy.json` and run `deploy-local.mjs`. The script generates `antigravity.token`, `agent-peer-antigravity.json`, `launch-antigravity.mjs`, adds `antigravity` to host fragments, deploys the native plugin (`plugin.json`, `mcp_config.json`, `skills/`, `agents/agent-bridge-readonly.md`, `agents/agent-bridge-readonly-web.md`), and validates with `agy plugin validate`.
- **Read-only boundary**: `consult` / `review` passes `--disable-slash-commands`, a read-only agent (`agent-bridge-readonly` with `read_file` only by default, or `agent-bridge-readonly-web` adding `search_web` when `peer_ask` passes `webSearch: true`), and session-only `--settings` (`allowNonWorkspaceAccess: false`, denying `write_file(*)`, `command(*)`, `mcp(*)`, `execute_url(*)`, `download_url(*)`).
- **`webSearch` toggle**: supported for `antigravity` and `claude-code` (`WebSearch`/`WebFetch`) in read-only modes; explicitly refused (`PEER_ARGS_INVALID`) on `codex` and in `delegate` mode.
- **Delegation**: `delegate` retains installed plugins/MCP config, applies `delegateMode` (`accept-edits` or `auto`), optional `--sandbox` (`delegateSandbox: true`), and `delegateAllowedPermissions`, inheriting root credentials and chain.
- **Session cleanup**: temporary CLI sessions under `records.antigravityDataDir` (default `~/.gemini/antigravity-cli`: `conversations/<id>.db`, `brain/<id>/`, `presence/<id>.lock`) are swept once closeout records expire.

---

## 6. agent-peer Configuration Reference

**Each root controller must use its own separate peer config file** (e.g., `agent-peer-claude-code.json`, `agent-peer-codex.json`, `agent-peer-antigravity.json`):

- All roots share one `stateDir` (shared job ledger, chain ledger, and record index).
- Each file's `bridge.credentialFile` must point to that root's **own** token file — never share one file across roots.

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
    "credentialFile": "<private>/credentials/<root-controller-id>.token"
  },
  "limits": { "timeoutMs": 1800000, "maxConcurrentJobs": 3 }
}
```

Key fields:

- `peers.<name>.executable`: absolute path to the peer headless CLI (supports `*` segments); must be a real executable (`.cmd` / `.bat` shims are refused).
- `model` / `reasoningEffort` (Codex) or `effort` (Claude Code / Antigravity): optional **defaults**. Any `peer_ask` (new or continued via `sessionId`) can override them per call. Precedence: `per-call argument > config default > CLI default`.
- `peers.<target>.efforts`: optional custom allowlist of effort strings (1–16 unique values matching `^[a-z][a-z0-9_-]{0,31}$`). Built-in defaults:
  - `codex`: `minimal, low, medium, high, xhigh, max, ultra`
  - `claude-code` / `antigravity`: `low, medium, high, xhigh, max`
- `peers.codex.delegateSandbox` / `readOnlyDisablePlugins`: sandbox mode for `delegate` (`read-only` / `workspace-write`) and plugins disabled in read-only runs.
- `peers.claude-code.delegatePermissionMode` / `delegateAllowedTools`: permissions for `delegate`; `consult` / `review` use read-only tools and `--no-session-persistence`.
- `records`: record folder name, retention days after acceptance (default 3) and after failed/disputed runs (default 30), sweep interval, and session directories.
- `limits`: timeout and max concurrent jobs.
- Deliberately **no free-form CLI arg arrays**: every CLI flag is derived from validated fields so configuration cannot weaken read-only sandboxes.

---

## 7. Post-Install Verification & Smoke Tests

1. **Check DSH host**: call `bridge_capabilities` and confirm `version` is `2.1.1`, `controllerIdentity.enabled === true`, `schemaVersion === 1`, and `self` / `admin` match the active controller.
2. **Check peer surface**: call `peer_capabilities` and confirm `self` (`claude-code` / `codex` / `antigravity`), `chain`, allowed peer modes, and model/effort capabilities.
3. **Check clean environment**: verify User- and root Process-level `DSH_MCP_TOKEN` is removed and desktop apps were fully restarted.
4. **Two-direction delegate smoke test (recommended after upgrades)**:
   - **Claude → Codex**: confirm the Codex delegate inherits Claude's non-admin identity and `via` chain and can submit a cheap DSH task (Codex retains its own MCP config).
   - **Codex → Claude**: confirm the Claude Code delegate runs with `--strict-mcp-config` exposing only the plugin's two MCP servers and can still submit a cheap DSH task.

---

## 8. MCP Tool Inventory

### `dsh_project` (20 `bridge_*` tools: 6 read / 1 submit / 13 mutate)

| Category | Tools |
|---|---|
| Tasks | `bridge_submit`, `bridge_check`, `bridge_result`, `bridge_dossier` |
| Authorization | `bridge_approve`, `bridge_clarify` |
| Follow-up | `bridge_followup` |
| Control | `bridge_cancel`, `bridge_reconcile`, `bridge_list`, `bridge_pause`, `bridge_resume` |
| Closeout | `bridge_acknowledge`, `bridge_archive`, `bridge_cleanup` |
| Catalogue | `bridge_models`, `bridge_capabilities` |
| Workspaces | `bridge_workspace_review`, `bridge_workspace_refresh`, `bridge_workspace_integrate` |

Read tools do not check ownership; `bridge_submit` binds the task to the authenticated controller; mutate tools require ownership or an administrator `override:{reason}` (durable audit intent → execution → result audit).

### `agent_peer` (9 tools)

| Tool | Purpose |
|---|---|
| `peer_capabilities` | Inspect chain position, callable targets, allowed modes, and default/allowed model & effort capabilities |
| `peer_ask` / `peer_check` / `peer_result` / `peer_cancel` / `peer_list` | Asynchronous peer job lifecycle |
| `record_closeout` / `record_list` | Write and list closeout Markdown records (`.agent-bridge/records/` + external index) |
| `cleanup_run` | Sweep expired temporary sessions (dry-run by default) |

---

## 9. Security Boundaries & Implementation Details

- **Tokens & ownership**: one bearer token file per controller; `task.submittedBy` is server-assigned and immutable. Historical tasks (`submittedBy: null`) require an admin override with a non-blank reason (≤500 chars). Admin tokens are never forwarded to child processes.
- **Delegation inherits root credential**: delegates inherit the root controller's non-admin credential so DSH tasks belong to the root principal; final acceptance stays with the root controller.
- **No credential fallback**: if a delegate or child process lacks its injected environment token, the carrier and peer client refuse instead of falling back to local files. Tokens are never written to job records, prompts, argv, or logs.
- **DSH containment**: `allowShell: true` is refused outright; path access is fenced by `scope.readRoots` / `writeRoots`; network access requires explicit packet grant.
- **Claude Code delegate MCP narrowing**: Claude Code delegates run with `--strict-mcp-config` containing only the plugin's two MCP servers; Codex and Antigravity delegates keep their own installed MCP config.
- **Server-enforced chain rules**: no self calls, no cycles back to any ancestor on the chain, default max 2 hops and max delegate depth 1; malformed chains are refused rather than patched.
- **Recorded-only cleanup**: the sweeper only deletes sessions explicitly listed in an existing closeout record; unrecorded sessions are never touched.

---

## 10. Legacy "codex-bridge" Identifiers

To preserve compatibility with existing task databases and worktrees, several persisted identifiers keep their original `codex-bridge` names:

- MCP endpoint: `/mcp/codex-bridge-v1`
- Host package: `@local/dsh-codex-bridge-v1`
- Host plugin ID: `dsh-codex-bridge-v1`
- Default `ownerId`: `codex-bridge-v1`

Keep these unchanged when upgrading existing installations.
