// test/models.test.mjs
//
// Bounded node:test coverage for src/models.mjs (CONTRACTS.md "Models / context module").
// Everything here is static/mock evidence: pure function calls with in-memory fixtures.
// No host, no network, no filesystem mutation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveModel, FLASH_DEFAULT, MODEL_ERROR_CODES } from '../src/models.mjs';

const CATALOG = [
  {
    provider: 'deepseek-official',
    models: [
      { id: 'deepseek-flash', reasoningEfforts: ['low', 'high'] },
      { id: 'deepseek-v4-flash-preview' },
    ],
  },
  {
    provider: 'astra',
    models: [{ id: 'astra-1', reasoningEfforts: ['xhigh'] }],
  },
];

const PROFILES = [
  {
    id: 'reviewer',
    version: 3,
    provider: 'astra',
    model: 'astra-1',
    skillIds: ['review-checklist', 'evidence-hygiene'],
    roles: ['review'],
  },
  {
    id: 'implementer',
    version: 1,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    skillIds: ['code-style'],
  },
];

/** @returns {Error & {code?:string}} */
function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

function assertCode(error, expectedCode) {
  assert.equal(error.code, expectedCode, `expected error.code=${expectedCode}, got ${error.code}: ${error.message}`);
}

test('flash default applies only when no source defines a route', () => {
  const result = resolveModel({ catalog: CATALOG });
  assert.deepEqual(result, {
    provider: FLASH_DEFAULT.provider,
    model: FLASH_DEFAULT.model,
    profileId: null,
    profileVersion: null,
    skillIds: [],
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'reasoningEffort'), false);
});

test('absent sources fall through in precedence order user > task > project > defaults', () => {
  const all = resolveModel({
    user: { provider: 'astra', model: 'astra-1', reasoningEffort: 'xhigh' },
    task: { provider: 'deepseek-official', model: 'deepseek-flash' },
    project: { provider: 'deepseek-official', model: 'deepseek-v4-flash-preview' },
    defaults: { provider: 'astra', model: 'astra-1' },
    catalog: CATALOG,
  });
  assert.equal(all.provider, 'astra');
  assert.equal(all.model, 'astra-1');
  assert.equal(all.reasoningEffort, 'xhigh');

  const withoutUser = resolveModel({
    task: { provider: 'deepseek-official', model: 'deepseek-flash' },
    project: { provider: 'deepseek-official', model: 'deepseek-v4-flash-preview' },
    defaults: { provider: 'astra', model: 'astra-1' },
    catalog: CATALOG,
  });
  assert.equal(withoutUser.model, 'deepseek-flash');

  const withoutTask = resolveModel({
    project: { provider: 'deepseek-official', model: 'deepseek-v4-flash-preview' },
    defaults: { provider: 'astra', model: 'astra-1' },
    catalog: CATALOG,
  });
  assert.equal(withoutTask.model, 'deepseek-v4-flash-preview');

  const onlyDefaults = resolveModel({ defaults: { provider: 'astra', model: 'astra-1' }, catalog: CATALOG });
  assert.equal(onlyDefaults.provider, 'astra');
  assert.equal(onlyDefaults.model, 'astra-1');
});

test('a route that only sets reasoningEffort is an incomplete route, not a skipped source', () => {
  const error = captureError(() =>
    resolveModel({
      user: { reasoningEffort: 'high' },
      project: { provider: 'astra', model: 'astra-1' },
      catalog: CATALOG,
    }),
  );
  assertCode(error, MODEL_ERROR_CODES.INCOMPLETE_ROUTE);
  assert.match(error.message, /provider and model/);
});

test('a partial route is never completed by a lower-precedence source', () => {
  const error = captureError(() =>
    resolveModel({
      task: { provider: 'deepseek-official' },
      project: { provider: 'astra', model: 'astra-1' },
      catalog: CATALOG,
    }),
  );
  assertCode(error, MODEL_ERROR_CODES.INCOMPLETE_ROUTE);
  assert.match(error.message, /missing model/);
});

test('unknown provider or model is rejected, never silently replaced', () => {
  const unknownModel = captureError(() =>
    resolveModel({ task: { provider: 'deepseek-official', model: 'no-such-model' }, catalog: CATALOG }),
  );
  assertCode(unknownModel, MODEL_ERROR_CODES.UNKNOWN_ROUTE);

  const unknownProvider = captureError(() =>
    resolveModel({ task: { provider: 'other-vendor', model: 'deepseek-flash' }, catalog: CATALOG }),
  );
  assertCode(unknownProvider, MODEL_ERROR_CODES.UNKNOWN_ROUTE);
});

test('unsupported explicitly provided effort is rejected when the catalog advertises efforts', () => {
  const error = captureError(() =>
    resolveModel({
      task: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'xhigh' },
      catalog: CATALOG,
    }),
  );
  assertCode(error, MODEL_ERROR_CODES.UNSUPPORTED_EFFORT);
  assert.match(error.message, /xhigh/);
});

test('effort is accepted without catalog advertisement, but still shape-checked', () => {
  // deepseek-v4-flash-preview advertises no efforts: any explicit effort passes.
  const openEffort = resolveModel({
    task: { provider: 'deepseek-official', model: 'deepseek-v4-flash-preview', reasoningEffort: 'whatever' },
    catalog: CATALOG,
  });
  assert.equal(openEffort.reasoningEffort, 'whatever');

  // No catalog at all: route is trusted as-is (nothing is advertised to contradict it).
  const noCatalog = resolveModel({ task: { provider: 'p', model: 'm', reasoningEffort: 'high' } });
  assert.deepEqual(noCatalog, {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
    profileId: null,
    profileVersion: null,
    skillIds: [],
  });

  const malformed = captureError(() =>
    resolveModel({ task: { provider: 'p', model: 'm', reasoningEffort: 5 } }),
  );
  assertCode(malformed, MODEL_ERROR_CODES.INVALID_INPUT);
});

test('profile supplies the whole route when the source only names the profile', () => {
  const result = resolveModel({ task: { profileId: 'reviewer' }, catalog: CATALOG, profiles: PROFILES });
  assert.deepEqual(result, {
    provider: 'astra',
    model: 'astra-1',
    profileId: 'reviewer',
    profileVersion: 3,
    skillIds: ['evidence-hygiene', 'review-checklist'],
  });
});

test('explicit route fields override the profile fields they set', () => {
  // The source only names a profile: every route field comes from the profile.
  const fromProfile = resolveModel({
    task: { profileId: 'implementer' },
    catalog: CATALOG,
    profiles: PROFILES,
  });
  assert.deepEqual(fromProfile, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    profileId: 'implementer',
    profileVersion: 1,
    skillIds: ['code-style'],
  });

  // Explicit fields that still describe the named profile's route are consistent,
  // and the profile identity plus skill bundle are retained.
  const consistent = resolveModel({
    task: { profileId: 'reviewer', provider: 'astra', model: 'astra-1' },
    catalog: CATALOG,
    profiles: PROFILES,
  });
  assert.equal(consistent.profileId, 'reviewer');
  assert.deepEqual(consistent.skillIds, ['evidence-hygiene', 'review-checklist']);

  // An override that changes the provider away from the named profile's route is a
  // conflict: the wrong skill bundle must never be inherited.
  const error = captureError(() =>
    resolveModel({
      task: { profileId: 'reviewer', provider: 'deepseek-official', model: 'deepseek-flash' },
      catalog: CATALOG,
      profiles: PROFILES,
    }),
  );
  assertCode(error, MODEL_ERROR_CODES.PROFILE_ROUTE_CONFLICT);
});

test('a composed provider/model override adopts the profile that owns the result', () => {
  // Profile supplies provider astra; the source overrides only the model. The
  // composed route astra/astra-2 must adopt the profile that owns astra/astra-2...
  const catalog = [
    { provider: 'astra', models: [{ id: 'astra-1' }, { id: 'astra-2' }] },
  ];
  const profiles = [
    { id: 'reviewer', version: 3, provider: 'astra', model: 'astra-1', skillIds: ['review-checklist'] },
    { id: 'reviewer-2', version: 5, provider: 'astra', model: 'astra-2', skillIds: ['second-review'] },
  ];
  const result = captureError(() =>
    resolveModel({
      task: { profileId: 'reviewer', model: 'astra-2' },
      catalog,
      profiles,
    }),
  );
  // ...and naming reviewer while landing on astra-2 is a conflict, not a silent
  // downgrade to "no profile" or an inherited reviewer skill bundle.
  assertCode(result, MODEL_ERROR_CODES.PROFILE_ROUTE_CONFLICT);
  assert.match(result.message, /astra-2/);

  const matched = resolveModel({
    task: { profileId: 'reviewer-2' },
    catalog,
    profiles,
  });
  assert.equal(matched.profileId, 'reviewer-2');
  assert.deepEqual(matched.skillIds, ['second-review']);
});

test('unknown profile id is rejected and profile model is catalog-validated', () => {
  const unknownProfile = captureError(() =>
    resolveModel({ task: { profileId: 'ghost' }, catalog: CATALOG, profiles: PROFILES }),
  );
  assertCode(unknownProfile, MODEL_ERROR_CODES.UNKNOWN_PROFILE);

  const badProfileModel = captureError(() =>
    resolveModel({
      task: { profileId: 'stale' },
      catalog: [{ provider: 'astra', models: [{ id: 'astra-1' }] }],
      profiles: [{ id: 'stale', version: 2, provider: 'astra', model: 'retired-model' }],
    }),
  );
  assertCode(badProfileModel, MODEL_ERROR_CODES.UNKNOWN_ROUTE);
});

test('malformed catalog and profile definitions are rejected as domain errors', () => {
  assertCode(captureError(() => resolveModel({ catalog: {} })), MODEL_ERROR_CODES.INVALID_INPUT);
  assertCode(
    captureError(() => resolveModel({ catalog: [{ provider: 'p', models: 'nope' }] })),
    MODEL_ERROR_CODES.INVALID_INPUT,
  );
  assertCode(
    captureError(() =>
      resolveModel({ catalog: [{ provider: 'p', models: [{ id: 'm' }, { id: 'm' }] }] }),
    ),
    MODEL_ERROR_CODES.DUPLICATE_ROUTE,
  );
  assertCode(
    captureError(() => resolveModel({ profiles: [{ id: 'x', version: 0, provider: 'p', model: 'm' }] })),
    MODEL_ERROR_CODES.INVALID_PROFILE,
  );
  assertCode(
    captureError(() =>
      resolveModel({
        profiles: [
          { id: 'x', version: 1, provider: 'p', model: 'm' },
          { id: 'x', version: 2, provider: 'p', model: 'm' },
        ],
      }),
    ),
    MODEL_ERROR_CODES.INVALID_PROFILE,
  );
  assertCode(captureError(() => resolveModel({ task: 'flash' })), MODEL_ERROR_CODES.INVALID_INPUT);
  assertCode(captureError(() => resolveModel(null)), MODEL_ERROR_CODES.INVALID_INPUT);
});

test('result is detached from inputs and frozen', () => {
  const task = { profileId: 'reviewer' };
  const catalog = [
    { provider: 'astra', models: [{ id: 'astra-1', reasoningEfforts: ['xhigh'] }] },
  ];
  const profiles = [
    { id: 'reviewer', version: 1, provider: 'astra', model: 'astra-1', skillIds: ['b', 'a'] },
  ];

  const first = resolveModel({ task, catalog, profiles });
  assert.deepEqual(first.skillIds, ['a', 'b']);

  // Mutating every input afterwards must not reach the returned snapshot.
  task.profileId = 'ghost';
  catalog[0].models[0].id = 'mutated';
  profiles[0].skillIds.push('injected');
  profiles[0].model = 'mutated';

  const second = resolveModel({
    task: { profileId: 'reviewer' },
    catalog: [{ provider: 'astra', models: [{ id: 'astra-1' }] }],
    profiles: [{ id: 'reviewer', version: 1, provider: 'astra', model: 'astra-1', skillIds: ['a', 'b'] }],
  });
  assert.deepEqual(first, second);

  // Returned object is a fresh plain object, safe to JSON round-trip.
  assert.equal(Object.getPrototypeOf(first), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test('a provided nonempty catalog must advertise the flash default', () => {
  // The catalog advertises Flash but has retired the exact default model: the host
  // must not silently run a model that is no longer advertised.
  const stale = captureError(() =>
    resolveModel({ catalog: [{ provider: 'deepseek-official', models: [{ id: 'deepseek-v4' }] }] }),
  );
  assertCode(stale, MODEL_ERROR_CODES.UNKNOWN_ROUTE);

  // A catalog that does not advertise the Flash provider at all is equally
  // authoritative: an unrouted task must not fall back to a nonexistent Flash.
  const astraOnly = captureError(() =>
    resolveModel({ catalog: [{ provider: 'astra', models: [{ id: 'astra-1' }] }] }),
  );
  assertCode(astraOnly, MODEL_ERROR_CODES.UNKNOWN_ROUTE);
  assert.match(astraOnly.message, /deepseek-official\/deepseek-flash/);

  // The same catalog works as soon as a route is actually defined.
  const routed = resolveModel({
    task: { provider: 'astra', model: 'astra-1' },
    catalog: [{ provider: 'astra', models: [{ id: 'astra-1' }] }],
  });
  assert.equal(routed.model, 'astra-1');

  // An explicitly requested unknown route is never laundered through the default.
  const explicit = captureError(() =>
    resolveModel({
      task: { provider: 'deepseek-official', model: 'deepseek-v4' },
      catalog: [{ provider: 'astra', models: [{ id: 'astra-1' }] }],
    }),
  );
  assertCode(explicit, MODEL_ERROR_CODES.UNKNOWN_ROUTE);

  // An advertised Flash default still resolves normally.
  const advertised = resolveModel({ catalog: CATALOG });
  assert.equal(advertised.model, FLASH_DEFAULT.model);

  // An empty catalog advertises nothing, matching the absent-catalog behaviour.
  const empty = resolveModel({ catalog: [] });
  assert.equal(empty.model, FLASH_DEFAULT.model);
});

test('a supplied profile matching the default route contributes skills without a manual profileId', () => {
  const result = resolveModel({ catalog: CATALOG, profiles: PROFILES });
  assert.deepEqual(result, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    profileId: 'implementer',
    profileVersion: 1,
    skillIds: ['code-style'],
  });
});

test('an explicit route adopts the profile that owns it, never another profile bundle', () => {
  // Explicit astra/astra-1 adopts the reviewer profile that owns that route.
  const astra = resolveModel({
    task: { provider: 'astra', model: 'astra-1', reasoningEffort: 'xhigh' },
    catalog: CATALOG,
    profiles: PROFILES,
  });
  assert.deepEqual(astra, {
    provider: 'astra',
    model: 'astra-1',
    reasoningEffort: 'xhigh',
    profileId: 'reviewer',
    profileVersion: 3,
    skillIds: ['evidence-hygiene', 'review-checklist'],
  });

  // Explicit deepseek-v4-flash-preview owns no profile: no wrong bundle is attached.
  const orphan = resolveModel({
    task: { provider: 'deepseek-official', model: 'deepseek-v4-flash-preview' },
    catalog: CATALOG,
    profiles: PROFILES,
  });
  assert.deepEqual(orphan, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-preview',
    profileId: null,
    profileVersion: null,
    skillIds: [],
  });

  // Naming a profile that does not own the effective route is a hard conflict.
  const conflict = captureError(() =>
    resolveModel({
      task: { profileId: 'reviewer', provider: 'deepseek-official' },
      catalog: CATALOG,
      profiles: PROFILES,
    }),
  );
  assertCode(conflict, MODEL_ERROR_CODES.PROFILE_ROUTE_CONFLICT);
  assert.match(conflict.message, /skills cannot be inherited/);
});

test('ambiguous profiles describing the same route are rejected', () => {
  const error = captureError(() =>
    resolveModel({
      profiles: [
        { id: 'a', version: 1, provider: 'astra', model: 'astra-1', skillIds: ['x'] },
        { id: 'b', version: 1, provider: 'astra', model: 'astra-1', skillIds: ['y'] },
      ],
    }),
  );
  assertCode(error, MODEL_ERROR_CODES.AMBIGUOUS_ROUTE);
});

test('every failure path exposes a stable machine-readable Error.code', () => {
  const failures = [
    () => resolveModel({ task: { provider: 'p' } }),
    () => resolveModel({ task: { provider: 'p', model: 'm' }, catalog: [{ provider: 'p', models: [{ id: 'other' }] }] }),
    () => resolveModel({ task: { profileId: 'nope' } }),
    () => resolveModel({ task: { provider: 'p', model: 'm', reasoningEffort: 'high' }, catalog: [{ provider: 'p', models: [{ id: 'm', reasoningEfforts: ['low'] }] }] }),
  ];
  const codes = failures.map((fn) => captureError(fn).code);
  assert.deepEqual(codes, [
    MODEL_ERROR_CODES.INCOMPLETE_ROUTE,
    MODEL_ERROR_CODES.UNKNOWN_ROUTE,
    MODEL_ERROR_CODES.UNKNOWN_PROFILE,
    MODEL_ERROR_CODES.UNSUPPORTED_EFFORT,
  ]);
  for (const code of codes) {
    assert.equal(typeof code, 'string');
    assert.notEqual(code.length, 0);
  }
});

test('blank and oversized identifiers are rejected', () => {
  assertCode(captureError(() => resolveModel({ task: { provider: '   ', model: 'm' } })), MODEL_ERROR_CODES.INVALID_INPUT);
  assertCode(
    captureError(() => resolveModel({ task: { provider: 'p'.repeat(201), model: 'm' } })),
    MODEL_ERROR_CODES.INVALID_INPUT,
  );
});
