# Controller identity (`p0b-v1`)

This document describes the **implemented** controller-identity layer of the DSH host
bridge: per-controller credentials, the immutable `submittedBy` ownership field, the
`read` / `submit` / `mutate` tool split with administrator override, client-declared
`via` provenance, the one-way task-store migration, and credential handling across
delegation. It is the operational guide; [CONTRACTS.md](../CONTRACTS.md) carries the
normative baseline.

Implementation references: `src/controller-auth.mjs`, `src/bootstrap.mjs`,
`src/mcp.mjs`, `src/store.mjs`, `src/service.mjs`, `src/long-task.mjs`,
`src/bridge-credentials.mjs`, `src/bridge-carrier.mjs`, `src/peer/bridge-client.mjs`,
`src/peer/cli.mjs`, `src/peer/server.mjs`.

## Scope and threat model

The boundary is **accidental misuse by cooperating agents running on one machine under
one OS user**. The bridge selects the request principal exclusively from the bearer
credential; it does not try to isolate processes, the filesystem or the OS user.

Accepted limitations of this boundary:

- A delegate runs with its **root controller's effective credential**. Its tasks belong
  to that root principal, so the delegate can read and mutate **other tasks that belong
  to the same root principal** (not only the task it was given).
- **Sessions that share one controller ID share that controller's authority.** Two
  conversations using the `claude-code` token are the same principal to the bridge.
- A **delegate** may modify other tasks of the same principal. The root controller is
  still responsible for planning, review, acceptance and integration; the bridge
  records `submittedBy` and `via`, not the human intent behind a delegate's call.
- **Final acceptance remains the root controller's responsibility.** `via` is
  client-declared provenance for audit and coordination; it grants no authority.
- Shared-user filesystem access, a hostile sub-controller with shell access, and
  deliberate credential theft are **outside** this boundary.

Administrator credentials are never forwarded to child processes. A legacy
administrator exists only inside an explicit upgrade maintenance window and is removed
before normal operation resumes.

## Host configuration

`mountBridge` reads two identity fields from the existing host configuration object:

```json
{
  "dataDirectory": "<DSH_HOME>/codex-bridge-v1",
  "ownerId": "codex-bridge-v1",
  "controllers": [
    { "id": "claude-code", "tokenFile": "<private>/credentials/claude-code.token" },
    { "id": "codex", "tokenFile": "<private>/credentials/codex.token" },
    { "id": "operator", "tokenFile": "<private>/credentials/operator.token", "admin": true }
  ],
  "identityMigrationBackupDirectory": "<temp>/agent-bridge-upstream/backups"
}
```

Deployment tooling emits `controllers` and `identityMigrationBackupDirectory` as an
identity **fragment**: merge that fragment into the existing complete host config
(keeping `dataDirectory`, `ownerId`, retention, wake and the other host fields). The
overlap and final configurations used during the upgrade are each complete host configs,
not fragments.

The example paths are placeholders. Create token files outside the repository, for
example under `F:/temp/agent-bridge-upstream/...`; never commit them and never paste a
real token into documentation, a packet or a log.

### `controllers`

Required array; **missing, an empty array or a wrong type is
`CONTROLLER_CONFIG_INVALID`** and the mount fails (the endpoint is not registered).

Each item is validated as follows (errors are `CONTROLLER_CONFIG_INVALID` unless
stated otherwise):

| Field | Actual validation |
|---|---|
| entry | Plain object (or null-prototype object) with **only** `id`, `tokenFile`, `admin`; arrays and extra keys are refused |
| `id` | Required string matching `^[a-z][a-z0-9-]{0,63}$`, case-sensitive, unique. Total 1–32 controllers |
| `tokenFile` | Required absolute **local** file path. On Windows that means a drive path such as `C:/...`; UNC and root-relative paths and NUL are refused. A malformed path is a configuration error; an unreadable file is `AUTH_UNAVAILABLE` |
| file content | Read as UTF-8, outer whitespace trimmed, then exactly 24–512 printable ASCII characters (`\x21`–`\x7e`), so no internal whitespace. A new 64-character hex token from `randomBytes(32)` is the normal case. A duplicate token (compared by SHA-256) or a format mismatch is a configuration error |
| `admin` | Optional boolean, default `false`; a non-boolean is a configuration error |

The shared contract example of a temporary maintenance entry is:

```json
{ "id": "legacy", "tokenFile": "<private>/credentials/legacy.token", "admin": true }
```

`legacy` is a **normal controller ID**, not a special case in the code. Historical
tasks whose `submittedBy` is `null` are handled separately. "Administrator" in the
authorization rules means any entry with `admin: true`, so a temporary legacy
administrator also needs an explicit override reason on a historical task.

### `identityMigrationBackupDirectory`

Optional in the configuration object, but **required to migrate an existing
`user_version = 0` store**. It must be an absolute local directory path
(`CONTROLLER_CONFIG_INVALID` otherwise). The directory is created if needed. A missing,
unwritable or unusable directory, or a snapshot that fails its integrity check, fails
the mount with `STORE_BACKUP_FAILED`. A brand-new empty store is created directly at
version 1 and needs no backup.

Put this directory under `F:/temp/agent-bridge-upstream` (outside git worktrees), for
example `F:/temp/agent-bridge-upstream/backups`. Keep the snapshot until the upgrade is
accepted and real work has resumed under the new identity.

### Legacy authentication keys are refused

Any top-level `token`, `credentialFile` or `tokenEnv` property makes the mount fail
with `CONTROLLER_CONFIG_INVALID` (message: migration to `controllers` is required).
This is stricter than "refuse only when both identities are configured": the old
top-level authentication keys are rejected whenever they are present.

## Request identity

1. The HTTP handler checks Host/Origin, then authenticates the `Authorization` header.
   It must be the exact form `Bearer <token>` (the prefix is case-sensitive and the
   token is not trimmed by the authenticator).
2. The registry compares the SHA-256 of the candidate against **every** configured
   digest with `crypto.timingSafeEqual`, including after a match, and returns the
   frozen principal `{id, admin}`.
3. An unknown or missing token gets HTTP 401 with only `{"error":"unauthorized"}` — no
   controller ID, token or token-file detail.
4. Only the SHA-256 digest is retained in the authentication closure; the plaintext
   token is not stored after the controller registry is built.
5. The request-local principal is placed on the dispatcher context together with the
   sorted controller IDs and the parsed `via`. Concurrent HTTP requests therefore keep
   their own identity.

`task.submittedBy` is set from that principal at submission and is **immutable**:

- `BridgeService.submit(packet, identity)` requires an identity object with a
  `submittedBy` key; the MCP dispatcher passes `context.principal.id`.
- `TaskStore.submit`, `update`, `beginAttempt`, `clarify`, `followup` and
  `beginRound` either set or preserve it; an attempt to replace `submittedBy` or
  `via` reaches `IMMUTABLE_IDENTITY` in `update`/`beginAttempt`. Clarification and
  follow-up mint new attempts by spreading the existing record, so identity and
  provenance survive every round.
- Internal supervisor workers are submitted with the **parent's** `{submittedBy, via}`
  and a `parentTaskId`; parent/child `submittedBy` consistency is checked, so packet
  metadata or `parentTaskId` alone can never create a different owner.
- The existing `ownerId` keeps its resource-ownership meaning (which bridge instance
  owns the task store); it is not the controller identity.

`submittedBy` and `via` are returned by the task view (`bridge_check`, `bridge_list`),
by `bridge_result` and by `bridge_dossier`.

## Tool categories and administrator override

Every tool declares exactly one category. The current registry is **6 read, 1 submit,
13 mutate**:

| Category | Tools |
|---|---|
| `read` (6) | `bridge_check`, `bridge_result`, `bridge_dossier`, `bridge_list`, `bridge_models`, `bridge_capabilities` |
| `submit` (1) | `bridge_submit` |
| `mutate` (13) | `bridge_approve`, `bridge_clarify`, `bridge_followup`, `bridge_cancel`, `bridge_pause`, `bridge_resume`, `bridge_reconcile`, `bridge_acknowledge`, `bridge_archive`, `bridge_cleanup`, `bridge_workspace_review`, `bridge_workspace_refresh`, `bridge_workspace_integrate` |

A missing category, an unknown category or a duplicate tool name is
`TOOL_POLICY_INVALID` and fails dispatcher construction / mount, not a per-request
error.

Read tools and `bridge_submit` have no ownership check. Their tool schemas do **not**
contain `override`; sending one is `OVERRIDE_NOT_PERMITTED`. Submit binds the
authenticated principal and uses `(ownerId, submittedBy, idempotencyKey)` for
de-duplication.

Every mutate tool takes the target as the top-level `taskId` and its input schema adds
a top-level `override` object:

```json
{
  "taskId": "t-...",
  "override": { "reason": "Inspect historical task" }
}
```

- `override` is accepted only on a `mutate` tool and only from `admin: true`.
- The object may contain **only** `reason`; an extra key, a non-object, or a non-string
  reason is `INVALID_ARGUMENTS`.
- `reason` is measured before trimming: the raw string must be at most 500 characters;
  after `trim()` it must be non-empty. The **trimmed** value is what is stored.
- A valid but unnecessary override (an administrator acting on their **own** task) is
  still audited as an override.
- All `additionalProperties: false` rules still apply, so `override` cannot smuggle
  another packet, scope, model, revision or acceptance field.

### Authorization order

The dispatcher applies, in this order:

1. authenticated caller context;
2. object arguments, known tool, required keys, unknown keys and declared types;
3. format checks (`bridge_list.submittedBy`, revision, bounded text, nonblank
   `taskId`);
4. override shape and permission (before the target is read);
5. the target task record (`TASK_NOT_FOUND`);
6. ownership and override-reason decision;
7. audit intent (only for a valid override);
8. the business call;
9. audit result;
10. the business result or its error.

Consequences:

- A normal principal on a foreign or historical task gets `TASK_NOT_OWNED`.
- An administrator on a foreign or historical task with no override gets
  `OVERRIDE_REASON_REQUIRED`.
- An administrator on a foreign or historical task with a valid reason proceeds to the
  **existing** lifecycle, revision, attempt, workspace and retention gates; override
  does not bypass them.
- A non-administrator sending any override, or anyone sending an override on a
  read/submit tool, gets `OVERRIDE_NOT_PERMITTED`.
- A missing target is `TASK_NOT_FOUND` and produces no task event.
- Rejections before the business call leave the task body, events, rounds, worktree and
  adapter call count unchanged.

### Durable audit

For a valid override the bridge first appends `task/override`:

```json
{
  "type": "task/override",
  "operationId": "<uuid>",
  "actor": "operator",
  "submittedBy": null,
  "tool": "bridge_followup",
  "reason": "Inspect historical task",
  "revision": 1,
  "attemptId": "<current attempt>",
  "via": null
}
```

`taskId`, `timestamp` and `seq` are filled in by the store. Workspace operations may
carry their existing head fields in the business result.

After the call it appends `task/override-result`, linked by `operationId`:

```json
{
  "type": "task/override-result",
  "operationId": "<uuid>",
  "outcome": "returned",
  "attemptId": "<attempt after the call>",
  "accepted": false,
  "replay": true,
  "code": "project/budget-exhausted"
}
```

`outcome` is `returned` or `threw`. `returned` only means the call returned — an
archive that reports `archived:false`, for example, is still `returned`. Applicable
boolean fields (`accepted`, `merged`, `archived`, `cleaned`, `eligible`, `replay`) are
copied from the operation result, and a returned or thrown code is recorded when one
exists. Pause/resume read those booleans from their operation outcome, not from task
acceptance.

Failure semantics:

- If the intent cannot be persisted, the business call is **not executed** and the
  caller gets `OVERRIDE_AUDIT_FAILED`.
- If the result event cannot be persisted after the call, the caller gets
  `OVERRIDE_AUDIT_INCOMPLETE`; the intent is retained and the caller must inspect the
  task and events before retrying.
- A process interrupted after the intent but before the result leaves an unclosed
  intent; the outcome is **unknown** until the task and event stream are inspected.
- Audit events are separate inserts; no SQLite transaction is held across an async
  business call.
- For the synchronous `bridge_followup` / `bridge_clarify` entry points the intent is
  persisted before the service is entered, with no added asynchronous boundary.

### Identity error codes

Tool-domain errors keep the existing MCP shape: HTTP 200 with
`result.isError: true`; the text is `{code, message, details?}` where `details` only
carries bounded (`<= 120` characters) `field` / `expected` strings. Unknown/missing
credentials are the exception: HTTP 401 `{"error":"unauthorized"}`.

| Code | Condition | `field` / `expected` |
|---|---|---|
| `TASK_NOT_OWNED` | Non-administrator mutates a foreign or historical task | `taskId` / `task owned by authenticated controller` |
| `OVERRIDE_NOT_PERMITTED` | Override from a non-administrator, or an override on a read/submit tool | `override` / `admin override on a mutate tool` |
| `OVERRIDE_REASON_REQUIRED` | Administrator needs an override but the reason is missing or blank | `override.reason` / `nonblank string, maximum 500 characters` |
| `INVALID_ARGUMENTS` | Malformed override (extra key, non-string, over 500) or existing argument errors | the named field / its type or range |
| `TASK_NOT_FOUND` | The target does not exist in this bridge instance | existing response shape |
| `OVERRIDE_AUDIT_FAILED` | The intent event could not be persisted | `override` / `durable audit before execution` |
| `OVERRIDE_AUDIT_INCOMPLETE` | The result event could not be persisted after the call | `override` / `inspect task and audit before retry` |
| `VIA_INVALID` | Invalid via header combination (see below) | `via.chain` or `via.rootTask` / the rule |
| `CONTROLLER_CONFIG_INVALID` | Invalid controller configuration, duplicate ID/token or weak token | the configuration field / the rule; mount fails |
| `AUTH_UNAVAILABLE` | Credential file unreadable, or internal call lacking a caller context | the source field / `configured credential source available` |
| `TOOL_POLICY_INVALID` | Invalid tool category, missing category or duplicate name | tool name / `read, submit or mutate`; mount fails |
| `STORE_SCHEMA_UNSUPPORTED` | Unknown store version or version/schema mismatch | `user_version` / supported matching schema; mount fails |
| `STORE_BACKUP_FAILED` / `STORE_MIGRATION_FAILED` | Migration snapshot or transactional migration failed | `identityMigrationBackupDirectory` or `store` / the stage; mount fails |
| `IMMUTABLE_IDENTITY` | Store-level attempt to replace `submittedBy`/`via` | the field name; no task event |

### `bridge_list.submittedBy`

`bridge_list` accepts `submittedBy?: string | null`:

- omitted — all tasks owned by this bridge instance;
- a valid controller ID — tasks of that principal, **including an ID no longer present
  in `controllers`**, so jobs of a retired controller remain queryable;
- `null` — historical tasks whose `submittedBy` is null.

The HTTP dispatcher validates the string against the controller ID pattern (or `null`);
`5`, `""` and `Bad-ID` are `INVALID_ARGUMENTS`.

## `via`: client-declared provenance

Two ASCII request headers carry submission provenance:

| Header | Rule |
|---|---|
| `X-Agent-Bridge-Chain` | `claude-code>codex` style, **1–5** members from `claude-code`, `codex`, `dsh`, joined by `>`, at most **256** characters |
| `X-Agent-Bridge-Root-Task` | Optional; requires a chain; matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` |

- A duplicated header or a non-string value is `VIA_INVALID`. Header control
  characters are refused (the HTTP layer tolerates an ASCII tab; the chain/root-task
  patterns do not). A value that is only whitespace is treated as absent.
- A root task without a chain is `VIA_INVALID`; a chain without a root task is valid.
- A syntactically valid chain does **not** have to match the authenticated controller
  ID; it is declared provenance, not authentication.
- `VIA_INVALID` is the only identity error returned as HTTP **400**
  (`{"error":"invalid via","code":"VIA_INVALID","details":{"field":...,"expected":...}}`).
  Authentication still runs first: an unknown token gets 401 even with invalid via
  headers, and invalid JSON gets `-32700` before via parsing. Via parsing runs before
  the tool name is resolved, so an unknown tool with a bad via is still `VIA_INVALID`.
- The stored value is `via: {chain: string[], rootTask: string | null}`. Both headers
  omitted (or blank) means `via: null`.
- **Root controllers send no via headers (contract R1).** The root's tasks have
  `via: null`. Only a delegate sends them: the stdio carrier derives them from
  `AGENT_BRIDGE_CHAIN` / `AGENT_BRIDGE_ROOT_TASK`, and the peer bridge client derives
  them from the recovered peer lineage. The Claude plugin manifest does not add chain
  request headers; only credential-related settings changed.
- `via` is stored on the **first** submission and is never overwritten by a later
  `bridge_submit` replay. An override event records the current call's `via`, which can
  differ from the task's original `via`.
- `via` grants **no** authority and is **excluded from the idempotency hash** (the hash
  covers the packet only). Changing `via` does not change de-duplication; forging a
  chain, `metadata.controller` or `parentTaskId` cannot widen permissions.
- `bridge_capabilities.controllerIdentity.via` reports
  `{source:"client-declared", authorizes:false}`.

## Capabilities

`bridge_capabilities` reports the request-local identity and suppresses any
adapter-supplied look-alike:

```json
{
  "controllerIdentity": {
    "enabled": true,
    "schemaVersion": 1,
    "self": "claude-code",
    "admin": false,
    "controllers": ["claude-code", "codex", "operator"],
    "ownership": "credential-principal",
    "delegation": "inherit-root-credential",
    "legacyTaskOwner": null,
    "override": { "requiredForForeignTasks": true, "reasonMaxChars": 500 },
    "via": { "source": "client-declared", "authorizes": false }
  }
}
```

`controllers` lists IDs only, sorted. `self` and `admin` always come from the current
request context, never from a cached value. Existing adapter/lifecycle follow-up and
supervisor capability fields are preserved. No token or token-file path is returned.

## Idempotency and the legacy migration

### Idempotency namespace

The SQLite task table adds a `submittedBy` column and the uniqueness key becomes
`UNIQUE(owner, submittedBy, idem)`:

- same principal + same key + same packet → the original task is returned;
- same principal + same key + a different packet → `IDEMPOTENCY_CONFLICT`;
- different principals + the same key → two independent tasks;
- a different `via` with the same key/packet → still the same task.

Historical tasks use the SQL namespace `""` (empty string) and a JSON body
`submittedBy: null`. Controller IDs cannot be empty, so a configured `legacy` ID can
never collide with historical rows.

### Database version and backup

The store is `<dataDirectory>/tasks.sqlite` with WAL mode. `PRAGMA user_version` moves
from the old unset `0` to **1**. Version 1 has:

```sql
CREATE TABLE tasks(
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  submittedBy TEXT NOT NULL,
  idem TEXT NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(owner, submittedBy, idem)
);
```

New empty store (version 0, no schema objects): create the version-1 `tasks`/`events`
schema directly — no backup and no copy step.

Schema acceptance is exact and version-specific:

- `user_version = 0` must be the **shipped v0** schema:
  `tasks(id,owner,idem,hash,body,UNIQUE(owner,idem))` — no `submittedBy` column — plus
  the shipped `events` table and `task_events` index. A database that reports
  `user_version = 0` but already carries the v1 `tasks` shape is
  `STORE_SCHEMA_UNSUPPORTED`; it is **not** treated as a v0 store and is **not**
  migrated.
- `user_version = 1` must be the **shipped v1** schema above (`submittedBy` present,
  `UNIQUE(owner,submittedBy,idem)`) plus the same events objects. An unknown version, a
  missing or extra object, or any column, uniqueness or SQL-text mismatch is
  `STORE_SCHEMA_UNSUPPORTED`.
- Version-0 bodies must not contain `submittedBy` or `via`; version-1 bodies are
  validated as described after the migration steps.

Existing version-0 store:

1. Determine the version and the exact schema; a mismatch is
   `STORE_SCHEMA_UNSUPPORTED` (never guessed or repaired).
2. Require `identityMigrationBackupDirectory`; create it and take a
   `VACUUM INTO <backup>/tasks-v0-<timestamp>-<uuid>.sqlite` snapshot, which includes
   committed WAL content. Run `PRAGMA integrity_check` on the snapshot and `fsync` it
   before touching the live table. Any failure is `STORE_BACKUP_FAILED` and the mount
   stops.
3. `BEGIN IMMEDIATE`; create `tasks_v1`; copy rows in old `rowid` order, keeping `id`,
   `owner`, `idem`, `hash`, the packet and all round data, adding
   `submittedBy: null` + `via: null` to the body and `""` to the SQL namespace.
4. Verify row count, order, identity mapping, hashes and bodies, and the uniqueness
   constraint.
5. Drop the old `tasks`, rename `tasks_v1`, set `user_version = 1`, commit. The
   `events` table, its sequence and its index are left in place.
6. On a transaction failure, roll back and refuse the mount with
   `STORE_MIGRATION_FAILED`; the backup is retained. An interrupted migration is first
   recovered by SQLite, then retried according to the version actually present.

An already-version-1 store is opened without migrating. Version-1 bodies are validated
on open: `via` must be present, `submittedBy` must be `null` or match the controller ID
pattern, and `row.submittedBy` must equal `body.submittedBy ?? ""`. Historical v0 bodies
never contain `submittedBy`/`via`; the migration adds them as `null`.

### Legacy ownership after migration

- Historical tasks keep `submittedBy: null` forever; they do not acquire the
  `legacy` controller ID.
- Every authenticated principal may read them (read tools have no ownership check).
- A non-administrator cannot mutate them (`TASK_NOT_OWNED`).
- An administrator can mutate them only with `override: {reason}` — including when
  using the temporary `legacy` administrator during the maintenance window.

## Delegation and credential handling

### Credential precedence

There is one shared resolver for the carrier, the peer bridge client and child
processes:

1. `DSH_BRIDGE_DISABLED=1` → no credential (disabled).
2. Non-blank `DSH_MCP_TOKEN`.
3. If `DSH_BRIDGE_DELEGATED=1` **or** `AGENT_BRIDGE_CHAIN` has more than one member and
   no `DSH_MCP_TOKEN` was present → **refuse**: a delegated process must never fall back
   to a local file.
4. `DSH_BRIDGE_CREDENTIAL_FILE`, otherwise the caller-configured `credentialFile`
   (for the carrier, its historical default file; for the peer client,
   `config.bridge.credentialFile`).
5. File read failure or an empty file → no credential. Error text never includes the
   path or the OS error, because both can carry secrets.

Environment names are matched case-insensitively (Windows). The token lives only in
the current process memory; it is not written to configuration output or logs.

This is what makes a **filtered environment** safe: if a child process loses
`DSH_MCP_TOKEN` but is still marked delegated (or is below a multi-member chain), the
carrier and the peer client refuse the bridge call instead of borrowing the root's
credential file. The Codex MCP entries forward `DSH_MCP_TOKEN`,
`DSH_BRIDGE_CREDENTIAL_FILE`, `DSH_BRIDGE_DELEGATED`, `DSH_BRIDGE_DISABLED`, the chain
variables and the existing limit variables, and the generated configuration never
statically overrides the inherited token. A token-lost test is expected to observe a
refusal, not a successful file fallback.

The operator command (deployment tooling) reads its own dedicated token file in its own
process, sends HTTP with it, ignores an environment token and starts no child
processes. Deployment scripts strip bridge credential variables when they spawn
external programs. This covers the bridge's own propagation paths; a user manually
reading a credential file remains inside the accepted threat model.

### Delegate credential preparation

Before spawning a `delegate`, the peer server:

1. resolves one effective token once;
2. calls `bridge_capabilities` with **that exact token**;
3. checks `controllerIdentity`:
   - `admin === true` → refuse with `PEER_BRIDGE_ADMIN_DELEGATION_FORBIDDEN` **before
     spawn**; an administrator token is never inherited by a child;
   - `enabled === true`, `admin === false`, and a valid non-blank `self` matching the
     controller ID pattern → use `{token, principal:{id:self, admin:false}}`;
   - anything else (missing/invalid identity) → not verifiable.

Contract **R2** applies when the bridge is unavailable, `bridge_capabilities` fails, or
the identity cannot be verified: **do not refuse the delegate.** The child is started
with `DSH_BRIDGE_DISABLED=1` and **no** bridge credential, and the job record stores
`bridge: {state:"disabled", reason:"<code>"}` (never a token). The delegate still runs
its ordinary work, just without DSH. `PEER_BRIDGE_UNAVAILABLE` is therefore a job
`reason`, not a spawn failure. The initial reason is `PEER_NOT_CONFIGURED` when no
bridge client is configured at all; `PEER_BRIDGE_UNAVAILABLE` when a configured client
cannot verify or reach the bridge. Only the administrator refusal aborts the spawn.

`consult` and `review` never receive a bridge credential: they run with
`DSH_BRIDGE_DISABLED=1` (job reason `PEER_BRIDGE_READ_ONLY`).

### Child environment

`childEnvironment(baseEnv, chainEnv, {mode, bridgeCredential})`:

- removes every bridge credential variable (`DSH_MCP_TOKEN`,
  `DSH_BRIDGE_CREDENTIAL_FILE`, `DSH_BRIDGE_DELEGATED`, `DSH_BRIDGE_DISABLED`,
  case-insensitive) and every `AGENT_BRIDGE_*` variable from the inherited environment;
- removes the caller harness's own session-identity variables so the child starts its
  own session; preserves unrelated variables (PATH, PowerShell module state, etc.);
- adds the peer chain environment computed by the chain planner;
- for a verified delegate credential: sets `DSH_MCP_TOKEN` to that token and
  `DSH_BRIDGE_DELEGATED=1`; otherwise sets `DSH_BRIDGE_DISABLED=1`.

For a delegate the peer server also sets `DSH_BRIDGE_URL` from `config.bridge.url`.
The token is not placed in the invocation, `job.json`, the prompt, `argv` or the
lineage ledger; the job's `bridge` object carries only `state` and `reason`.

### Claude Code delegate: strict MCP configuration (explicit behaviour change)

Only a **Claude Code delegate** — the target harness is Claude Code, which includes
Codex → Claude — is started with `--strict-mcp-config --mcp-config <json>`. The peer
server's invocation builder generates that JSON with **exactly the plugin's two stdio MCP
entries and nothing else**:

- `plugin_agent-bridge_dsh_project` → `bin/bridge.mjs` (the stdio carrier, so the child
  receives inherited credentials, disabled markers and via regardless of which harness
  is the delegate);
- `plugin_agent-bridge_agent_peer` → `bin/peer-mcp.mjs` (stdio) with
  `AGENT_BRIDGE_SELF=claude-code`.

No HTTP entry and no user-configured server is included. `--strict-mcp-config` means the
user's **other** MCP servers are deliberately excluded from that Claude Code delegate's
session. This is an intentional behaviour change relative to 1.7.0, where a delegate
could inherit the user's MCP configuration; it narrows what a sub-controller can reach
through MCP and widens nothing.

The narrowing is kept even when the bridge is **unavailable or disabled**. A delegate
whose capability check cannot verify the bridge still runs under contract R2 with
`DSH_BRIDGE_DISABLED=1` and no credential, and it is still started with the same strict
two-entry configuration. There is no "bridge unavailable → non-strict" fallback: the
disabled marker, inherited credential and `via` are honoured only by the carrier and the
credential resolver (`src/bridge-credentials.mjs`), while an HTTP entry or a
user-configured bridge entry does not understand them. Relaxing strict would let the
disabled state leak through another MCP path and make the delegate's tool surface depend
on bridge health.

**Compatibility impact to state in an upgrade:** any Claude Code delegate workflow that
relied on the user's other MCP servers loses those tools inside the delegate. Plan for
that before upgrading; a sub-controller that needs an unrelated MCP server cannot get it
through the strict delegate path.

This restriction is **direction-specific and does not apply to a Codex delegate**. When
Claude delegates to Codex (Claude → Codex), the child is Codex: it keeps its own Codex MCP
configuration with the forwarded credential/chain environment, and no two-entry
`--strict-mcp-config` exclusion is claimed for it. That asymmetry is known and accepted
under contract R5. A Claude → Codex smoke test verifies the inherited root identity and
carrier (the task belongs to the root principal and its delegate `via` is recorded); it
must not assert that Codex excludes the user's other MCP servers.

Because the Claude Code narrowing changes a live client's tool surface, an upgrade
requires a **dual-direction root smoke test**: after restart, run one disposable
delegate in each direction (Claude → Codex and Codex → Claude) and verify:

- Codex → Claude: the Claude Code delegate sees exactly the two plugin MCP entries, the
  user's other MCP servers are absent, and one cheap bridge call succeeds;
- Claude → Codex: the Codex delegate inherits the root's non-administrator identity and
  `via` carrier and can submit one cheap DSH task; other Codex MCP servers are not
  asserted absent.

Do this with disposable tasks before relying on the new configuration for real work.

Codex read-only runs already disable configured plugins (`readOnlyDisablePlugins`) and
may ignore the user config; Codex delegates keep the plugin's MCP entries with the
forwarded credential environment. Identity changes do not relax the existing
read-only sandbox, plugin-disable or approval rules.

## Upgrade and rollback

The identity migration is a **one-way database migration**, and the host endpoint is
shared by every controller. Plan it as an operator maintenance action, not as part of
an ordinary coding task, and **drain the whole host**, not just one controller's
sessions.

Test code obtains every temporary directory through `test/helpers/test-root.mjs` (contract
R6). That helper uses an explicit `BRIDGE_TEST_TMP` as the only configurable base: it
must be an absolute path, is created if missing, and each test gets its own unique
subdirectory which it alone removes. When `BRIDGE_TEST_TMP` is unset the helper uses the
platform temporary directory (`os.tmpdir()`); nothing infers the base from which drive
letters or folders happen to exist. Local acceptance commands set `BRIDGE_TEST_TMP`,
`TEMP` and `TMP` to `F:/temp/agent-bridge-upstream/test-tmp`; CI sets
`BRIDGE_TEST_TMP` to the runner's temporary directory. Migration backups and disposable
upgrade artifacts for this machine still belong under `F:/temp/agent-bridge-upstream`,
outside git worktrees. Use fake tokens in any rehearsal; never read or copy the machine's
real credential files into a test, log or document.

### 1. Before stopping: prepare and drain

1. Finish or cancel every task from every controller; collect results, acknowledge,
   and confirm the host-reported stop (`stopConfirmed:true`, `activeJobs:0`,
   `activeChildren:0`). A restart while work is active recovers it as unknown/not
   replayed, so do not start the upgrade with live tasks.
2. Decide the temporary backup root, e.g.
   `F:/temp/agent-bridge-upstream/backups`, and make sure it is writable and outside
   the DSH data directory and any git worktree.
3. Have the deployment tooling prepare the identity inputs: one token file per
   controller (create if missing with `randomBytes(32)`, validate and keep valid
   existing bytes), the `controllers` list, `identityMigrationBackupDirectory`, and both
   an **overlap** host configuration (includes the temporary `legacy` administrator) and
   a **final** configuration (without `legacy`). The deploy config's `identity` block
   carries `credentialDirectory`, `migrationBackupDirectory` and the optional
   `legacyTokenFile`, and its output is an **identity fragment** (`controllers` +
   `identityMigrationBackupDirectory`) to **merge into the complete host config** that
   keeps `dataDirectory`, `ownerId` and every other host field; the overlap and final
   configs are each complete.

   **An old install upgrading from the shared `credentialFile` must set
   `identity.legacyTokenFile` explicitly.** Unlike the per-root controller token files,
   the legacy token is never generated: point the field at an existing valid token file
   (24–512 printable ASCII characters with no internal whitespace) that will become the
   temporary `legacy` administrator in the overlap config. The deploy config is parsed as
   strict JSON, so it must not contain comments; this is a complete, valid deploy config
   example (replace the paths):

   ```json
   {
     "deployRoot": "F:/temp/agent-bridge-upstream/deploy",
     "nodePath": "C:/Program Files/nodejs/node.exe",
     "bridgeUrl": "http://127.0.0.1:3080/mcp/codex-bridge-v1",
     "identity": {
       "credentialDirectory": "F:/temp/agent-bridge-upstream/deploy/credentials",
       "migrationBackupDirectory": "F:/temp/agent-bridge-upstream/backups",
       "legacyTokenFile": "F:/temp/agent-bridge-upstream/deploy/credentials/legacy.token"
     }
   }
   ```

   If `identity.legacyTokenFile` is present but the file is missing, deployment refuses;
   it never guesses a token or creates one for `legacy`. After the **final** restart,
   remove both the `legacyTokenFile` field and the legacy token file (the final config no
   longer lists `legacy`); leaving the field in place while deleting only the file makes
   the next deploy refuse. In identity mode the deploy additionally writes these
   identity artifacts: a per-root peer config is created only when absent (an existing
   one is validated for the shared `stateDir` and its own `bridge.credentialFile`, and a
   stale mismatch is refused rather than rewritten); the overlap and final host identity
   fragments are regenerated on every apply; and an existing Codex `.mcp.json` is
   migrated to the two A3 stdio entries from `.codex-mcp.json` (`dsh_project` through
   `bin/bridge.mjs`, and `agent_peer`) while unrelated MCP servers are preserved. A dry
   run writes nothing and generates no token.
4. Refresh the client side so each root uses its **own** controls, not a shared one:
   - Claude Code uses its own controller token for the `dsh_project` HTTP entry, loaded
     into the Claude **root launch environment** as `DSH_MCP_TOKEN`;
   - Codex's root clears the shared environment token and uses its own credential file
     through the stdio carrier, with its own `AGENT_PEER_CONFIG`;
   - each root gets its **own separate** agent-peer config, `agent-peer-claude-code.json`
     and `agent-peer-codex.json`, in the configured peer-config directory (default
     `<deployRoot>/config`). Both share the same `stateDir`, but each
     `bridge.credentialFile` points at that root's own token file. The deploy tooling
     derives each missing per-root config from a legacy single shared file; an existing
     per-root config is validated and kept;
   - the operator command uses its own file.
   Point each client at the overlap configuration for the maintenance window.

   Identity deployments also generate one launch wrapper per root under
   `<deployRoot>/config`:

   - `launch-claude-code.mjs` and `launch-codex.mjs` are plain Node scripts. Each one
     removes inherited bridge credential variables and `AGENT_BRIDGE_CHAIN` /
     `AGENT_BRIDGE_ROOT_TASK`, sets `AGENT_PEER_CONFIG` and `DSH_BRIDGE_URL`, then starts
     the configured root CLI with **all of its own argv forwarded unchanged**. Run them
     as `node <deployRoot>/config/launch-claude-code.mjs [claude arguments...]` and
     `node <deployRoot>/config/launch-codex.mjs [codex arguments...]`; they accept no
     flags of their own. The Claude wrapper reads its token file and exports
     `DSH_MCP_TOKEN`; the Codex wrapper exports `DSH_BRIDGE_CREDENTIAL_FILE` instead.
     Neither wrapper embeds a token.

   The wrappers are a convenience, not the only way. Starting the root CLI yourself with
   the same environment works too: for the Claude root's HTTP entry set `DSH_MCP_TOKEN`
   before launch; for Codex set `DSH_BRIDGE_CREDENTIAL_FILE`, `DSH_BRIDGE_URL` and
   `AGENT_PEER_CONFIG`, and remove inherited `DSH_MCP_TOKEN` / chain variables. The
   shared resolver (`src/bridge-credentials.mjs`) checks `DSH_MCP_TOKEN` first and then
   `DSH_BRIDGE_CREDENTIAL_FILE`; a delegated process refuses a missing environment token
   instead of falling back to a local file.

### 2. Stop and back up

1. Stop the DSH host cleanly.
2. Back up, under the temporary upstream directory:
   - the installed package / plugin copy and its manifest;
   - the host configuration (overlap and final);
   - `<dataDirectory>`, i.e. `tasks.sqlite` **and** its WAL/SHM state (the events live
     in the same database), plus worktrees that still matter;
   - the client configurations (Claude plugin configuration, Codex `.mcp.json`, each
     root's agent-peer config and the shared state) and the token files. The **live
     controller token files are not disposable**: keep them and their backup copies.
3. Keep a restore copy and do not delete the old installation yet.
4. Install the new package (the uninstall/install sequence in README §1) while the host
   is stopped, **before the first restart**. After installing, merge the overlap identity
   fragment into the complete host config used for the first restart. The first restart
   must load the identity-aware code that validates `controllers` and migrates the store;
   never start the old package with the new configuration.

### 3. First restart (overlap)

1. Start the host with the **overlap** configuration after the new package is
   installed. The store migrates 0 → 1 and writes the pre-migration snapshot into
   `identityMigrationBackupDirectory` first. If the mount fails with
   `STORE_BACKUP_FAILED` or `STORE_MIGRATION_FAILED`, stop: the host did not start, the
   backup is retained, and restoring the old configuration is still safe.
2. Verify `bridge_capabilities`: `controllerIdentity.enabled === true`, the correct
   `self`/`admin` for each client, and the expected `controllers` list. Confirm
   historical tasks are still readable (`bridge_list` with `submittedBy: null`) and
   that an existing task's `submittedBy`/`via` are what the old data should show.
3. **Maintenance window rule:** `legacy` is an administrator for migration and repair
   only. Any mutation of a foreign or historical task during this window uses an
   explicit `override: {reason}` — including history (`submittedBy: null`). Record the
   reason in the operation/audit trail; do not use the legacy token for normal work.
4. **Dual-direction disposable-task smoke**:
   - submit one cheap read-only task from each root controller and check
     `submittedBy` equals that controller and `via` is `null` for the root;
   - run one disposable delegate in each direction (Claude → Codex and Codex →
     Claude) and confirm the delegate's tasks belong to the root principal and that
     its `via` chain is recorded as client-declared provenance;
   - Codex → Claude: confirm the Claude Code delegate's strict MCP surface (the two
     plugin entries only, the user's other MCP servers absent) and that a cheap bridge
     call succeeds;
   - Claude → Codex: confirm the Codex delegate inherited the root identity/carrier and
     can complete a cheap DSH submission; do not assert that Codex excludes the user's
     other MCP servers;
   - confirm a normal (non-admin) delegate cannot mutate the other root's task
     (`TASK_NOT_OWNED`) and that an administrator delegate attempt is refused before
     spawn (`PEER_BRIDGE_ADMIN_DELEGATION_FORBIDDEN`);
   - collect, archive/clean up or discard the disposable tasks deliberately.

### 4. Second restart (final)

1. Remove the `legacy` controller entry and its token file (or otherwise make the
   token unreadable) and start again with the **final** configuration. At the same time
   remove the `legacyTokenFile` field from the deploy config: a configured field whose
   file is missing is refused, so the field and the file are removed together. No
   migration runs on an already-version-1 store.
2. Verify the old legacy token now gets **HTTP 401** `{"error":"unauthorized"}`.
3. Verify the remaining controllers and clients still authenticate; historical tasks
   remain readable; mutating a historical task now requires a remaining administrator
   plus an override reason.
4. Keep the live controller token files and the pre-migration snapshot(s) you still
   need for rollback and audit. Delete only intended disposable test artifacts and,
   after the final restart, the temporary `legacy` token file; do not delete live
   controller token files or the needed backup snapshots.
5. If the deadline watchdog sidecar is enabled, its separate
   `DSH_BRIDGE_WATCHDOG_CONFIG` still names its own `credentialFile`. After the final
   restart, point that field at a **live controller** token file — for example
   `<credentialDirectory>/codex.token` — because the sidecar performs a read-only
   `bridge_check` and any configured controller may use read tools; the removed `legacy`
   token is no longer valid. Update the sidecar configuration and restart the sidecar
   process so it reads the new credential. Do the same whenever a controller token file
   used by the sidecar is rotated or removed.

### Rollback

The pre-migration snapshot (plus the old package, host configuration and client
configuration) is a rollback point **only before real new work exists under the new
identity**. To roll back that early: stop the host, restore the old package/config and
the old database (and WAL) from the backups, restore the old clients, and restart with
the old configuration. The migrated version-1 database is not downgraded in place;
the snapshot is the way back.

After new real tasks, events or clients exist under controller identity, **do not**
restore the snapshot: doing so discards that work and leaves clients pointed at a
host whose identity no longer matches. Real tasks require **forward repair** — fix the
identity/configuration problem and continue under the new schema — not a data
rollback. If a migration cannot be completed and no new work exists, restore the
snapshot and old install; the backup is retained precisely for that case.

## Operational notes

- A configuration error (`CONTROLLER_CONFIG_INVALID`, `TOOL_POLICY_INVALID`,
  `STORE_SCHEMA_UNSUPPORTED`, `STORE_BACKUP_FAILED`, `STORE_MIGRATION_FAILED`) is a
  **mount failure**: there is no endpoint and no task is created.
- `AUTH_UNAVAILABLE` during registry load means a configured token file could not be
  read; fix the file/path and restart. It is not a per-request 401.
- A missing/invalid token on an already-mounted endpoint is a request-level 401; it does
  not reveal which controller or file failed.
- Never put a token in a packet, peer prompt, job record, log or skill; the bridge
  deliberately reports only `{state, reason}` and bounded error fields.
- Never widen scope or reuse another controller's token to work around an ownership
  refusal. A `TASK_NOT_OWNED` is the ownership model working; an administrator uses an
  override reason when the maintenance/repair authorization genuinely covers it.
