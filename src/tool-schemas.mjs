// src/tool-schemas.mjs
//
// Shared, discovery-only JSON Schema fragments advertised through MCP `tools/list`
// (`src/mcp.mjs`). They exist so a caller can see the exact shape of the verification
// `checks`/`baselineChecks` lists and of the acknowledgement `artifactState` without
// guessing.
//
// These schemas perform no enforcement. Runtime acceptance remains owned by:
//   - `src/workspaces.mjs` (`validateChecksInput`/`validateChecks`): unknown entry keys
//     are ignored; a missing/blank/over-long `command`, a command containing CR, LF or
//     NUL, a non-string `args` entry, an `args` entry containing NUL or longer than
//     8192 characters, and a `timeoutMs` outside 1..600000 are rejected; the list is
//     limited to 64 entries; `command` is executed directly, never through a shell.
//   - `src/service.mjs` (`acknowledge`): only the artifactState values below are
//     accepted, and `merged` additionally requires verified integration evidence.
// Keep this file in step with those modules by hand. Never use it to relax a runtime
// fence, and never treat an advertised constraint as proof of enforcement.
//
// Node 24 built-ins only; no imports, no I/O, no mutation of shared objects.

const CHECK_TIMEOUT_MS_DEFAULT = 300_000;
const CHECK_TIMEOUT_MS_MAX = 600_000;
const MAX_CHECKS = 64;
const MAX_COMMAND_CHARS = 4096;
const MAX_ARG_CHARS = 8192;

const deepFreeze = value => {
  if (value && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

/**
 * Discovery-only schema for the additive long-task supervisor grant
 * (`packet.project`, contract long-supervisor-first-edition-v1, extended by
 * bounded-recurrent-supervisor-v1). Runtime acceptance is owned by
 * `src/contracts.mjs` (`validateProjectBlock`) and host policy by
 * `src/long-task.mjs` (`resolveProjectGrant`); this fragment only documents the shape.
 * The supervisor session itself stays a bounded read-only planner: `workerScope` is the
 * envelope its workers are attenuated from, never a grant to the supervisor.
 */
export const PROJECT_GRANT_SCHEMA = deepFreeze({
  type: ['object', 'null'],
  description:
    'Optional long-task supervisor grant. Present means this task is ONE supervisor session that declares bounded workers with supervisor-only tools; with maxRounds 1 it freezes the plan once, and with maxRounds >= 2 it may review real worker results in further bounded rounds, record a complete/block decision and append workers before each round (host supervisorProjects.maxRounds and pause permitting). Absent means the historical single bounded task and changes nothing. Every worker is a separate real bridge task attenuated from workerScope; writers get a fresh owned worktree from project.workspace. Host policy `supervisorProjects.enabled` must be true or the packet is refused.',
  properties: {
    maxWorkers: { type: 'integer', minimum: 1, maximum: 16, description: 'Maximum workers the supervisor may declare. The plan must declare at least one; declare three or more when the objective splits.' },
    maxRounds: { type: 'integer', minimum: 1, maximum: 8, description: 'Requested supervisor model rounds, default 1 when omitted. 1 is the historical plan-once project; 2..8 opt into bounded recurrence, and every round is bounded by the same cumulative project tool/time budget. A request above the host supervisorProjects.maxRounds cap is refused, never clamped. Recursion and pause/resume are only granted on a packet that requests 2 or more rounds.' },
    maxConcurrentWorkers: { type: 'integer', minimum: 1, maximum: 16, description: 'Host-owned scheduling cap for simultaneously running workers.' },
    maxRepairAttempts: { type: 'integer', minimum: 0, maximum: 2, description: 'Bounded ordinary repair attempts per logical worker. Unknown stop/dispatch receipt never retries.' },
    maxTotalRetries: { type: 'integer', minimum: 0, maximum: 64, description: 'Project-wide retry total across all workers.' },
    maxWorkerStarts: { type: 'integer', minimum: 1, maximum: 64, description: 'Project-wide worker start total (initial attempts plus repairs).' },
    maxTotalToolCalls: { type: 'integer', minimum: 1, maximum: 100000, description: 'Project-wide aggregate tool-call budget across worker attempts.' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 86400000, description: 'Project wall-clock budget for deterministic scheduling and retries.' },
    reserveSlots: { type: 'integer', minimum: 1, maximum: 15, description: 'Shared-ledger slots the orchestrator reserves so a coordinator task can still be scheduled. At least 1 is always reserved; reserving more is safe while it stays feasible inside the shared 16-slot ledger.' },
    workerScope: {
      type: 'object',
      additionalProperties: false,
      required: ['readRoots', 'allowedTools', 'allowNetwork'],
      description: 'The ONLY roots/tools/network a worker may request. Every widening request is refused, never clamped.',
      properties: {
        readRoots: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Absolute read roots available to workers. With project.workspace every root must stay inside the repository.' },
        writeRoots: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Absolute write roots available to writer workers; each must be covered by readRoots, and requires project.workspace.' },
        allowedTools: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Worker tool allowlist. Shell, delegation, run_code and every bridge/supervisor tool are refused even if named.' },
        allowNetwork: { type: 'boolean', description: 'Whether workers may use the network at tool level.' },
        budgets: {
          type: 'object',
          additionalProperties: false,
          properties: {
            timeoutMs: { type: 'integer', minimum: 1 },
            maxToolCalls: { type: 'integer', minimum: 1 },
            maxOutputChars: { type: 'integer', minimum: 1 },
          },
          description: 'Per-worker budget ceiling; a worker request above it is refused.',
        },
      },
    },
    workspace: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['repository', 'baseRef'],
      description: 'Main repository every writer worker gets a fresh owned worktree from. Required when workerScope.writeRoots is nonempty.',
      properties: {
        repository: { type: 'string', minLength: 1, description: 'Absolute path to the main repository (never another task worktree).' },
        baseRef: { type: 'string', minLength: 1, description: 'Starting commit for each writer worktree.' },
      },
    },
  },
});

/** Artifact dispositions accepted by `bridge_acknowledge` (`src/service.mjs`). */
export const ARTIFACT_STATE_ENUM = Object.freeze(['none', 'merged', 'preserved', 'discarded', 'unresolved']);

export const ARTIFACT_STATE_SCHEMA = deepFreeze({
  type: 'string',
  enum: ARTIFACT_STATE_ENUM,
  description:
    'Artifact disposition recorded with the acknowledgement. `merged` requires verified integration evidence; an owned workspace cannot be `none` and must be `merged`, `preserved` or `discarded`; `unresolved` records an unknown or unsupported host outcome.',
});

/**
 * Shared checks array schema for `bridge_workspace_review.checks`,
 * `bridge_workspace_integrate.checks` and `bridge_workspace_integrate.baselineChecks`.
 * Discovery only: it documents the runtime-enforced limits instead of adding new ones.
 */
export const CHECKS_SCHEMA = deepFreeze({
  type: 'array',
  maxItems: MAX_CHECKS,
  description: `Ordered verification commands run directly without a shell, at most ${MAX_CHECKS} entries per list. Each entry names one executable plus an optional literal argument vector; unknown entry keys are ignored by the runtime validator, so do not use them to carry state. Entries are bounded check evidence, not a paginated result stream.`,
  items: {
    type: 'object',
    required: ['command'],
    additionalProperties: true,
    properties: {
      command: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_COMMAND_CHARS,
        pattern: '^(?![\\s\\S]*[\\r\\n\\u0000])(?=[\\s\\S]*\\S)',
        description: `Executable name or an existing absolute file path, at most ${MAX_COMMAND_CHARS} characters. It is spawned directly, never through a shell: no line breaks, no NUL and no shell-metacharacter interpretation. A command containing a path separator must be an existing absolute file path.`,
      },
      args: {
        type: 'array',
        description: 'Literal argument vector passed to the executable without shell expansion. Omitted means no arguments.',
        items: {
          type: 'string',
          maxLength: MAX_ARG_CHARS,
          pattern: '^[^\\u0000]*$',
          description: `One argument passed verbatim, at most ${MAX_ARG_CHARS} characters and no NUL. Shell metacharacters are literal content, not syntax.`,
        },
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: CHECK_TIMEOUT_MS_MAX,
        description: `Per-check timeout in milliseconds, an integer within 1..${CHECK_TIMEOUT_MS_MAX}. Omitted uses the runtime default of ${CHECK_TIMEOUT_MS_DEFAULT} ms.`,
      },
    },
  },
});
