// src/task-packet-schema.mjs
//
// Machine-readable JSON Schema for the task packet accepted by `bridge_submit`.
//
// Discovery only. This schema is advertised through MCP `tools/list` so a caller
// can see the complete packet shape without guessing. Runtime acceptance remains
// owned by `contracts.validatePacket`: this schema performs no enforcement, adds
// no coercion or defaults, and must never be used to relax the cwd/read/write/
// delegation fences. Keep the two in step by hand.
//
// Model routing: the bridge resolves the effective route from the live catalog
// (src/models.mjs). This schema therefore lists route fields, never concrete model
// names or reasoning efforts; call `bridge_models` for what is actually advertised.

const deepFreeze = value => {
  if (value && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

const text = (description, extra = {}) => ({ type: 'string', minLength: 1, pattern: '\\S', description, ...extra });

const REJECTION_NOTE =
  'Required fields, schemaVersion and cwd/readRoots containment are checked before a task record or adapter call. Preparation and execution have further checks; inspect any returned task identity before retrying an uncertain submission.'

import { PROJECT_GRANT_SCHEMA } from './tool-schemas.mjs';

export const TASK_PACKET_SCHEMA = deepFreeze({
  type: 'object',
  title: 'BridgeTaskPacket',
  description: `One bounded bridge task. ${REJECTION_NOTE}`,
  properties: {
    schemaVersion: {
      type: 'integer',
      enum: [1],
      description: 'Version of the task packet contract. Must be the integer 1, never the string "1.0" or any other value.',
    },
    idempotencyKey: text('Nonblank key for this submission. Identical accepted packets reuse the task; changed accepted packets conflict. Explicit pre-creation validation failures do not reserve the key.', { maxLength: 200 }),
    revision: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: 'Revision of this task: a positive safe integer, starting at 1.',
    },
    projectId: text('Bridge project this task belongs to.', { maxLength: 2000 }),
    title: text('Short human-readable task title.', { maxLength: 2000 }),
    objective: text('The single bounded outcome requested, at most 100000 characters.', { maxLength: 100000 }),
    cwd: text(
      'Absolute path to an existing directory that already lies inside one of scope.readRoots. If it is not covered, choose an existing cwd inside an authorized read root, or split the task; never widen readRoots to cover cwd.',
    ),
    role: {
      type: 'string',
      enum: ['investigate', 'implement', 'review', 'integrate'],
      description: 'Task role. investigate and review are read-only; implement and integrate may write.',
    },
    acceptance: {
      type: 'array',
      minItems: 1,
      items: text('One observable, checkable acceptance criterion.'),
      description: 'Nonempty list of acceptance criteria; the review contract for this task.',
    },
    scope: {
      type: 'object',
      description:
        'The complete permission surface for this task. Ask for the narrowest scope that can finish it; a worker that needs another root must report that instead of widening its own scope.',
      properties: {
        readRoots: {
          type: 'array',
          minItems: 1,
          items: text('Absolute file or directory the worker may read.'),
          description: 'Absolute read roots. Must be nonempty and must already cover cwd; use a directory root for cwd containment.',
        },
        writeRoots: {
          type: 'array',
          items: text('Absolute file or directory the worker may write.'),
          description: 'Absolute write roots, including exact output file paths. Each must be covered by readRoots; investigate and review tasks must leave this empty.',
        },
        allowedTools: {
          type: 'array',
          minItems: 1,
          items: text('Tool name the worker may use, for example read, write, edit.'),
          description: 'Nonempty tool allowlist.',
        },
        allowShell: { type: 'boolean', description: 'Requested shell permission. Current DSH adapter rejects true because it cannot enforce a process/network fence; probe bridge_capabilities.' },
        allowNetwork: { type: 'boolean', description: 'Whether the worker may use the network.' },
        allowDelegation: {
          type: 'boolean',
          enum: [false],
          description: 'Recursive delegation is disabled; must be false.',
        },
        childSessions: {
          type: ['object', 'null'],
          description:
            'Optional explicit child-session grant. Absent or null means no child sessions, which is the default for every ordinary task. When enabled, the host must also enable child sessions; the worker receives bridge-owned dsh_child_* tools for the real parent agent only. Children are real sessions at depth 1 with attenuated grants: any request that would widen roots, tools, network, model, budgets, callback target or depth is rejected, never clamped.',
          properties: {
            enabled: { type: 'boolean', enum: [true], description: 'Must be exactly true to opt in.' },
            maxChildren: { type: 'integer', minimum: 1, maximum: 16, description: 'Maximum concurrently live children for this task.' },
            toolNames: {
              type: 'array',
              uniqueItems: true,
              items: text('Tool name the child may keep; must be a subset of scope.allowedTools.'),
              description: 'Optional subset of the parent tool allowlist a child may keep. Never widens the parent grant.',
            },
          },
          required: ['enabled'],
          additionalProperties: false,
        },
        backgroundJobs: {
          type: ['object', 'null'],
          description:
            'Optional explicit background-job grant. Absent or null means no bridge-started job. When enabled, the worker may start only the named operator-approved command profiles through a real owned job registry; profiles are exact executable/argv/cwd/env and no shell string or OS sandbox is offered.',
          properties: {
            enabled: { type: 'boolean', enum: [true], description: 'Must be exactly true to opt in.' },
            profileIds: {
              type: 'array',
              minItems: 1,
              maxItems: 32,
              uniqueItems: true,
              items: text('Operator-approved command profile id granted to this task.'),
              description: 'Operator profile ids this task may start. Unknown ids are refused, never substituted.',
            },
            maxJobs: { type: 'integer', minimum: 1, maximum: 16, description: 'Maximum concurrently live bridge jobs for this task.' },
          },
          required: ['enabled', 'profileIds'],
          additionalProperties: false,
        },
      },
      required: ['readRoots', 'writeRoots', 'allowedTools', 'allowShell', 'allowNetwork', 'allowDelegation'],
      additionalProperties: true,
    },
    materials: {
      type: 'array',
      description:
        'Minimum sources the worker needs. Each entry carries path or text; a path is resolved relative to cwd and must stay inside scope.readRoots.',
      items: {
        type: 'object',
        properties: {
          path: text('Absolute or cwd-relative material path, required to stay inside scope.readRoots. A declared file hash requires an existing file.'),
          text: { type: ['string', 'null'], description: 'Inlined material content; an empty string is valid. Null requires a valid path instead.' },
          version: text('Caller-supplied material version label.', { type: ['string', 'null'] }),
          sha256: text('SHA-256 hex digest. Referenced files are checked at submission; inline text is checked while preparing context.', { type: ['string', 'null'] }),
        },
        anyOf: [{ required: ['path'] }, { required: ['text'], properties: { text: { type: 'string' } } }],
        additionalProperties: true,
      },
    },
    contractVersion: text('Contract/version label this task is submitted under.', { maxLength: 2000 }),
    parentTaskId: { description: 'Optional caller coordination metadata identifying a parent task; does not confer authority.' },
    dependencies: {
      type: ['array', 'null'],
      items: text('Task id that must complete and be accepted before this task runs.'),
      uniqueItems: true,
      description: 'Tasks that must complete and be accepted first. Omitted or null normalizes to an empty array.',
    },
    model: {
      type: ['object', 'null'],
      description:
        'Optional explicit route. Omitted, null or an empty object uses the default. Supply provider/model together, or a configured profileId. Call bridge_models for routes and advertised efforts; profile IDs come from host configuration, not that model listing.',
      properties: {
        provider: text('Advertised provider id.', { type: ['string', 'null'], maxLength: 200 }),
        model: text('Advertised model id.', { type: ['string', 'null'], maxLength: 200 }),
        reasoningEffort: text('Explicit effort is checked when the catalog advertises efforts for the route.', { type: ['string', 'null'] }),
        profileId: text('Configured profile completing a route; explicit provider/model must agree.', { type: ['string', 'null'], maxLength: 200 }),
      },
      additionalProperties: true,
    },
    workspace: {
      type: ['object', 'null'],
      description: 'Ask the runtime to create an isolated worktree instead of improvising one.',
      properties: {
        repository: text('Absolute path to the repository.'),
        baseRef: text('Base ref the workspace is created from.'),
        branchName: text('Optional branch name for the workspace.'),
      },
      required: ['repository', 'baseRef'],
      additionalProperties: true,
    },
    budget: {
      type: 'object',
      description:
        'Requested budgets, never hard-enforced unless bridge_capabilities says so. Defaults: timeoutMs 600000, maxToolCalls 100, maxOutputChars 200000. Unknown budget keys are rejected.',
      properties: {
        timeoutMs: { type: 'integer', minimum: 1, maximum: 86400000, default: 600000 },
        maxToolCalls: { type: 'integer', minimum: 1, maximum: 10000, default: 100 },
        maxOutputChars: { type: 'integer', minimum: 1, maximum: 10000000, default: 200000 },
      },
      additionalProperties: false,
    },
    understandingRequired: {
      type: 'boolean',
      description: 'When true the worker returns understanding/assumptions/actions/missing and waits for controller approval before execution.',
    },
    retention: {
      description: 'Optional coordination metadata. Applied cleanup uses the host retention policy, not a task-provided override.',
    },
    metadata: {
      description: 'JSON coordination hints only, never authorization.',
    },
    rootCallback: {
      type: ['object', 'null'],
      description:
        'Optional trusted callback-grant reference for a designated directly delegated root task. The destination thread is resolved from host configuration at submission and stored immutably; the worker can never name, change or discover the destination, and a worker report is never treated as instructions.',
      properties: {
        grantId: text('Configured root callback grant id. An ungranted id is refused; the target itself is never supplied by the caller or the worker.'),
      },
      required: ['grantId'],
      additionalProperties: false,
    },
    project: PROJECT_GRANT_SCHEMA,
  },
  required: [
    'schemaVersion',
    'idempotencyKey',
    'revision',
    'projectId',
    'title',
    'objective',
    'cwd',
    'role',
    'acceptance',
    'scope',
    'materials',
    'contractVersion',
  ],
  additionalProperties: true,
});
