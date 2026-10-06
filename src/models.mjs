// src/models.mjs
//
// Model routing for the DSH Codex Bridge (CONTRACTS.md, "Models / context module").
//
// Contract summary implemented here:
//   resolveModel({user,task,project,defaults,catalog,profiles}) ->
//     {provider,model,reasoningEffort?,profileId,profileVersion,skillIds:string[]}
//
//   * First defined complete route wins, precedence user > task > project > defaults.
//   * Flash default when no route is defined anywhere.
//   * reject incomplete route / unknown route / unsupported explicitly provided effort
//     when the catalog advertises efforts.
//   * No silent fallback of any kind.
//   * All inputs are untrusted and validated; failures are Error with a stable `.code`.
//   * Returned values are detached, JSON-serializable and deep-frozen.

/* ------------------------------------------------------------------ helpers */
//
// Kept local to this module on purpose: the assignment permits exactly the
// assigned module files, so shared internals are not factored out into a third
// module. The two copies are small, pure and identical.

/** True for JSON-style plain objects (no arrays, null, class instances). */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep JSON clone that drops prototype-polluting keys. */
function deepClone(value) {
  if (Array.isArray(value)) return value.map((entry) => deepClone(entry));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = deepClone(value[key]);
    }
    return out;
  }
  return value;
}

/** Domain error code for route and capability validation failures. */
export const MODEL_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'invalid_input',
  INCOMPLETE_ROUTE: 'incomplete_route',
  UNKNOWN_ROUTE: 'unknown_route',
  UNSUPPORTED_EFFORT: 'unsupported_effort',
  UNKNOWN_PROFILE: 'unknown_profile',
  INVALID_PROFILE: 'invalid_profile',
  DUPLICATE_ROUTE: 'duplicate_route',
  AMBIGUOUS_ROUTE: 'ambiguous_route',
  PROFILE_ROUTE_CONFLICT: 'profile_route_conflict',
});

/** Built-in Flash default. Used only when no source defines a route. */
export const FLASH_DEFAULT = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
});

/** Route sources in contract precedence order (highest first). */
export const ROUTE_PRECEDENCE = Object.freeze(['user', 'task', 'project', 'defaults']);

const MAX_IDENTITY_CHARS = 200;

/**
 * Domain error carrying a stable machine-readable `.code`.
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function modelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function checkIdentity(value, field) {
  if (value === undefined || value === null) return null;
  if (!isNonBlankString(value)) {
    throw modelError(
      MODEL_ERROR_CODES.INVALID_INPUT,
      `${field} must be a nonblank string when provided`,
    );
  }
  if (value.length > MAX_IDENTITY_CHARS) {
    throw modelError(
      MODEL_ERROR_CODES.INVALID_INPUT,
      `${field} must be at most ${MAX_IDENTITY_CHARS} characters`,
    );
  }
  return value;
}

function checkEffortShape(value, field) {
  if (value === undefined || value === null) return null;
  if (!isNonBlankString(value)) {
    throw modelError(
      MODEL_ERROR_CODES.INVALID_INPUT,
      `${field} must be a nonblank string when provided`,
    );
  }
  return value;
}

/* ------------------------------------------------------------------ catalog */

/**
 * Validate the catalog into an immutable lookup.
 *
 * catalog is an array `{provider, models:[{id, reasoningEfforts?:string[]}]}`.
 * `undefined`/`null` catalog is allowed and disables catalog-based checks
 * (nothing is advertised, so nothing can contradict the requested route).
 *
 * A *provided nonempty* catalog, by contrast, is authoritative: every route,
 * including the built-in Flash default, must be advertised by it. An empty array
 * advertises nothing, matching the absent-catalog behaviour.
 *
 * @param {unknown} catalog
 * @returns {{advertised:boolean, providers:Map<string, Map<string, string[]|null>>}}
 */
function normalizeCatalog(catalog) {
  if (catalog === undefined || catalog === null) {
    return { advertised: false, providers: new Map() };
  }
  if (!Array.isArray(catalog)) {
    throw modelError(MODEL_ERROR_CODES.INVALID_INPUT, 'catalog must be an array');
  }

  const providers = new Map();
  for (let i = 0; i < catalog.length; i += 1) {
    const entry = catalog[i];
    if (!isPlainObject(entry)) {
      throw modelError(MODEL_ERROR_CODES.INVALID_INPUT, `catalog[${i}] must be a plain object`);
    }
    if (!isNonBlankString(entry.provider)) {
      throw modelError(
        MODEL_ERROR_CODES.INVALID_INPUT,
        `catalog[${i}].provider must be a nonblank string`,
      );
    }
    if (!Array.isArray(entry.models)) {
      throw modelError(MODEL_ERROR_CODES.INVALID_INPUT, `catalog[${i}].models must be an array`);
    }
    const provider = entry.provider.trim();
    const models = providers.get(provider) ?? new Map();
    for (let j = 0; j < entry.models.length; j += 1) {
      const model = entry.models[j];
      if (!isPlainObject(model)) {
        throw modelError(
          MODEL_ERROR_CODES.INVALID_INPUT,
          `catalog[${i}].models[${j}] must be a plain object`,
        );
      }
      if (!isNonBlankString(model.id)) {
        throw modelError(
          MODEL_ERROR_CODES.INVALID_INPUT,
          `catalog[${i}].models[${j}].id must be a nonblank string`,
        );
      }
      const id = model.id.trim();
      if (models.has(id)) {
        throw modelError(
          MODEL_ERROR_CODES.DUPLICATE_ROUTE,
          `catalog advertises ${provider}/${id} more than once`,
        );
      }
      let efforts = null;
      if (model.reasoningEfforts !== undefined && model.reasoningEfforts !== null) {
        if (!Array.isArray(model.reasoningEfforts)) {
          throw modelError(
            MODEL_ERROR_CODES.INVALID_INPUT,
            `catalog[${i}].models[${j}].reasoningEfforts must be an array when provided`,
          );
        }
        const seen = new Set();
        for (const effort of model.reasoningEfforts) {
          if (!isNonBlankString(effort)) {
            throw modelError(
              MODEL_ERROR_CODES.INVALID_INPUT,
              `catalog[${i}].models[${j}].reasoningEfforts entries must be nonblank strings`,
            );
          }
          const trimmed = effort.trim();
          if (seen.has(trimmed)) {
            throw modelError(
              MODEL_ERROR_CODES.DUPLICATE_ROUTE,
              `catalog[${i}].models[${j}] advertises effort ${trimmed} more than once`,
            );
          }
          seen.add(trimmed);
        }
        efforts = Object.freeze([...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      }
      models.set(id, efforts);
    }
    if (!providers.has(provider)) providers.set(provider, models);
  }

  return { advertised: catalog.length > 0, providers };
}

/* ----------------------------------------------------------------- profiles */

/**
 * Validate the profiles array into an immutable lookup.
 *
 * profiles is `{id,version,provider,model,skillIds?:string[],roles?:string[]}`.
 *
 * Profiles are indexed both by id and by the `provider/model` route they describe, so
 * a resolved route can be matched to the profile that actually owns it. Two profiles
 * advertising the same route are ambiguous and rejected.
 *
 * @param {unknown} profiles
 * @returns {{byId:Map<string, object>, byRoute:Map<string, object>}}
 */
function normalizeProfiles(profiles) {
  if (profiles === undefined || profiles === null) {
    return { byId: new Map(), byRoute: new Map() };
  }
  if (!Array.isArray(profiles)) {
    throw modelError(MODEL_ERROR_CODES.INVALID_INPUT, 'profiles must be an array');
  }

  const byId = new Map();
  const byRoute = new Map();
  for (let i = 0; i < profiles.length; i += 1) {
    const profile = profiles[i];
    if (!isPlainObject(profile)) {
      throw modelError(MODEL_ERROR_CODES.INVALID_PROFILE, `profiles[${i}] must be a plain object`);
    }
    if (!isNonBlankString(profile.id)) {
      throw modelError(
        MODEL_ERROR_CODES.INVALID_PROFILE,
        `profiles[${i}].id must be a nonblank string`,
      );
    }
    const id = profile.id.trim();
    if (byId.has(id)) {
      throw modelError(MODEL_ERROR_CODES.INVALID_PROFILE, `duplicate profile id ${id}`);
    }
    if (!Number.isSafeInteger(profile.version) || profile.version <= 0) {
      throw modelError(
        MODEL_ERROR_CODES.INVALID_PROFILE,
        `profiles[${i}].version must be a positive integer`,
      );
    }
    if (!isNonBlankString(profile.provider)) {
      throw modelError(
        MODEL_ERROR_CODES.INVALID_PROFILE,
        `profiles[${i}].provider must be a nonblank string`,
      );
    }
    if (!isNonBlankString(profile.model)) {
      throw modelError(
        MODEL_ERROR_CODES.INVALID_PROFILE,
        `profiles[${i}].model must be a nonblank string`,
      );
    }

    const skillIds = [];
    if (profile.skillIds !== undefined && profile.skillIds !== null) {
      if (!Array.isArray(profile.skillIds)) {
        throw modelError(
          MODEL_ERROR_CODES.INVALID_PROFILE,
          `profiles[${i}].skillIds must be an array when provided`,
        );
      }
      for (const skillId of profile.skillIds) {
        if (!isNonBlankString(skillId)) {
          throw modelError(
            MODEL_ERROR_CODES.INVALID_PROFILE,
            `profiles[${i}].skillIds entries must be nonblank strings`,
          );
        }
        skillIds.push(skillId.trim());
      }
    }

    const roles = [];
    if (profile.roles !== undefined && profile.roles !== null) {
      if (!Array.isArray(profile.roles)) {
        throw modelError(
          MODEL_ERROR_CODES.INVALID_PROFILE,
          `profiles[${i}].roles must be an array when provided`,
        );
      }
      for (const role of profile.roles) {
        if (!isNonBlankString(role)) {
          throw modelError(
            MODEL_ERROR_CODES.INVALID_PROFILE,
            `profiles[${i}].roles entries must be nonblank strings`,
          );
        }
        roles.push(role.trim());
      }
    }

    const normalizedProfile = Object.freeze({
      id,
      version: profile.version,
      provider: profile.provider.trim(),
      model: profile.model.trim(),
      skillIds: Object.freeze([...new Set(skillIds)].sort()),
      roles: Object.freeze([...new Set(roles)].sort()),
    });
    byId.set(id, normalizedProfile);

    const routeKey = `${normalizedProfile.provider}\u0000${normalizedProfile.model}`;
    const existing = byRoute.get(routeKey);
    if (existing !== undefined) {
      throw modelError(
        MODEL_ERROR_CODES.AMBIGUOUS_ROUTE,
        `profiles ${existing.id} and ${id} both describe the route ${normalizedProfile.provider}/${normalizedProfile.model}`,
      );
    }
    byRoute.set(routeKey, normalizedProfile);
  }
  return { byId, byRoute };
}

/* -------------------------------------------------------------------- routes */

/**
 * Read a single route source.
 *
 * Absent sources (not an object, or no route-defining key present) are reported as
 * `defined:false` so the next source in precedence order can apply. A source that
 * *does* define a route is returned for strict validation; it is never skipped.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {{defined:boolean, provider?:string|null, model?:string|null, effort?:string|null, profileId?:string|null}}
 */
function readRouteSource(value, field) {
  if (value === undefined || value === null) return { defined: false };
  if (!isPlainObject(value)) {
    throw modelError(MODEL_ERROR_CODES.INVALID_INPUT, `${field} must be a plain object`);
  }

  const provider = checkIdentity(value.provider, `${field}.provider`);
  const model = checkIdentity(value.model, `${field}.model`);
  const effort = checkEffortShape(value.reasoningEffort, `${field}.reasoningEffort`);
  const profileId = checkIdentity(value.profileId, `${field}.profileId`);

  if (provider === null && model === null && effort === null && profileId === null) {
    return { defined: false };
  }
  return { defined: true, provider, model, effort, profileId };
}

/**
 * Resolve effective route fields for one defined source.
 *
 * `profileId` is folded in first, then the explicitly supplied fields override it.
 * A profile can therefore either complete a partial explicit route or define the
 * whole route by itself.
 */
function resolveSource(source, sourceName, profiles) {
  let provider = source.provider;
  let model = source.model;
  let effort = source.effort;
  let profile = null;

  if (source.profileId !== null) {
    profile = profiles.byId.get(source.profileId);
    if (profile === undefined) {
      throw modelError(
        MODEL_ERROR_CODES.UNKNOWN_PROFILE,
        `${sourceName}.profileId ${source.profileId} is not a known profile`,
      );
    }
    if (provider === null) provider = profile.provider;
    if (model === null) model = profile.model;
  }

  if (provider === null || model === null) {
    const missing = [];
    if (provider === null) missing.push('provider');
    if (model === null) missing.push('model');
    throw modelError(
      MODEL_ERROR_CODES.INCOMPLETE_ROUTE,
      `${sourceName} defines an incomplete route: missing ${missing.join(' and ')}`,
    );
  }

  if (profile !== null && (profile.provider !== provider || profile.model !== model)) {
    throw modelError(
      MODEL_ERROR_CODES.PROFILE_ROUTE_CONFLICT,
      `${sourceName} names profile ${profile.id} (${profile.provider}/${profile.model}) but the effective route is ${provider}/${model}; skills cannot be inherited from a profile that does not own the route`,
    );
  }

  return { provider, model, effort, profile, sourceName, explicitProfileId: source.profileId };
}

/**
 * Attach the profile that actually owns the resolved route.
 *
 * A supplied profile for the winning route is adopted automatically, with no
 * manual `profileId` needed. That is a skill/version attachment, never a model
 * fallback: the effective provider/model always comes from the route sources.
 *
 * @param {{provider:string,model:string,profile:object|null,explicitProfileId:string|null}} route
 * @param {{byRoute:Map<string, object>}} profiles
 */
function attachRouteProfile(route, profiles) {
  if (route.profile !== null) return route;

  const match = profiles.byRoute.get(`${route.provider}\u0000${route.model}`);
  if (match === undefined) return route;

  // Reached only when the source itself did not name a profile, so there is no
  // explicit profile choice to contradict.
  return { ...route, profile: match };
}

/**
 * Validate one resolved route against the catalog.
 *
 * @param {{provider:string,model:string,effort:string|null}} route
 * @param {{advertised:boolean, providers:Map<string, Map<string, string[]|null>>}} catalog
 * @param {string} sourceName
 */
function validateAgainstCatalog(route, catalog, sourceName) {
  if (!catalog.advertised) return;

  const models = catalog.providers.get(route.provider);
  if (models === undefined || !models.has(route.model)) {
    throw modelError(
      MODEL_ERROR_CODES.UNKNOWN_ROUTE,
      `${sourceName} route ${route.provider}/${route.model} is not advertised by the catalog`,
    );
  }

  if (route.effort !== null) {
    const efforts = models.get(route.model);
    if (Array.isArray(efforts) && !efforts.includes(route.effort)) {
      throw modelError(
        MODEL_ERROR_CODES.UNSUPPORTED_EFFORT,
        `${sourceName} requests reasoningEffort "${route.effort}" but ${route.provider}/${route.model} advertises only [${efforts.join(', ')}]`,
      );
    }
  }
}

/* --------------------------------------------------------------- resolution */

/**
 * Resolve the effective model route for a task.
 *
 * The winning route source (user > task > project > defaults, else the Flash
 * default) fixes `provider` and `model`; nothing else may override those two
 * fields. Profiles contribute identity, version and skills, but only when the
 * profile owns the effective route:
 *
 *   * a source may name `profileId` (the profile then completes a partial route),
 *   * a route that matches a supplied profile adopts that profile automatically,
 *   * a named profile whose route does not match the effective route is rejected
 *     with PROFILE_ROUTE_CONFLICT rather than inheriting the wrong skill bundle.
 *
 * A provided nonempty catalog is authoritative, including for the Flash default:
 * if it does not advertise the default route the call fails instead of running an
 * unadvertised model.
 *
 * @param {object} [request]
 * @param {object} [request.user]     Per-user route override.
 * @param {object} [request.task]     Per-task route override.
 * @param {object} [request.project]  Per-project route override.
 * @param {object} [request.defaults] Operator defaults.
 * @param {Array}  [request.catalog]  Advertised providers/models.
 * @param {Array}  [request.profiles] Named routes with skill bundles.
 * @returns {{provider:string, model:string, reasoningEffort?:string|null, profileId:string|null, profileVersion:number|null, skillIds:string[]}}
 */
export function resolveModel(request = {}) {
  if (!isPlainObject(request)) {
    throw modelError(MODEL_ERROR_CODES.INVALID_INPUT, 'resolveModel request must be a plain object');
  }

  const catalog = normalizeCatalog(request.catalog);
  const profiles = normalizeProfiles(request.profiles);

  const sources = {
    user: request.user,
    task: request.task,
    project: request.project,
    defaults: request.defaults,
  };

  let resolved = null;
  for (const name of ROUTE_PRECEDENCE) {
    const source = readRouteSource(sources[name], name);
    if (!source.defined) continue;
    const route = resolveSource(source, name, profiles);
    validateAgainstCatalog(route, catalog, name);
    resolved = route;
    break; // first defined complete route wins; no silent fallback
  }

  if (resolved === null) {
    resolved = {
      provider: FLASH_DEFAULT.provider,
      model: FLASH_DEFAULT.model,
      effort: null,
      profile: null,
      explicitProfileId: null,
      sourceName: 'flash-default',
    };
  }

  // The effective route always determines the model. The profile only contributes
  // identity, version and skills, and only when it owns the effective route.
  resolved = attachRouteProfile(resolved, profiles);
  validateAgainstCatalog(resolved, catalog, resolved.sourceName);

  const skillIds = new Set(resolved.profile ? resolved.profile.skillIds : []);
  const result = {
    provider: resolved.provider,
    model: resolved.model,
    profileId: resolved.profile ? resolved.profile.id : null,
    profileVersion: resolved.profile ? resolved.profile.version : null,
    skillIds: [...skillIds].sort(),
  };
  // `reasoningEffort` is optional in the contract: omit it entirely when absent.
  if (resolved.effort !== null) {
    result.reasoningEffort = resolved.effort;
  }

  return deepClone(result);
}
