// src/peer/chain.mjs
//
// Delegation-chain policy for cross-harness peer calls (contract agent-peer-v1).
//
// Every task has exactly ONE root controller. Whenever a harness asks another harness
// to work, the callee inherits the chain of harnesses above it through the process
// environment (`AGENT_BRIDGE_CHAIN`, e.g. `claude-code>codex`). A peer call is refused
// when it would:
//   * target the calling harness itself (PEER_SELF_TARGET),
//   * target any harness already on the chain — this covers the root controller, so
//     work can never be delegated "around the circle" back to it (PEER_CYCLE),
//   * exceed the hop limit (PEER_DEPTH_EXCEEDED), or
//   * hand sub-controller authority (`delegate`) below the delegate depth
//     (PEER_DELEGATE_DEPTH).
// A malformed inherited chain is refused rather than repaired (PEER_CHAIN_INVALID).
//
// This module is pure: no I/O, no process access. Callers pass the environment in.

export const HARNESSES = Object.freeze(['claude-code', 'codex', 'dsh']);
/** Harnesses a peer call may target. DSH work goes through the bridge_* tools instead. */
export const PEER_TARGETS = Object.freeze(['claude-code', 'codex']);
export const PEER_MODES = Object.freeze(['consult', 'review', 'delegate']);

export const ENV_KEYS = Object.freeze({
  self: 'AGENT_BRIDGE_SELF',
  chain: 'AGENT_BRIDGE_CHAIN',
  rootTask: 'AGENT_BRIDGE_ROOT_TASK',
  maxDepth: 'AGENT_BRIDGE_MAX_DEPTH',
  maxDelegateDepth: 'AGENT_BRIDGE_MAX_DELEGATE_DEPTH',
});

/** Hops below the root controller: root -> peer -> peer's peer. */
export const DEFAULT_MAX_DEPTH = 2;
/** Only the root controller may appoint a sub-controller by default. */
export const DEFAULT_MAX_DELEGATE_DEPTH = 1;
export const MAX_DEPTH_CEILING = 4;

const SEPARATOR = '>';
const ROOT_TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class PeerPolicyError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'PeerPolicyError';
    this.code = code;
    this.detail = detail;
  }
}

function isHarness(value) {
  return typeof value === 'string' && HARNESSES.includes(value);
}

/** Parse an inherited chain string. Absent/blank means "this process is a root". */
export function parseChain(text) {
  if (text === undefined || text === null) return [];
  if (typeof text !== 'string') throw new PeerPolicyError('PEER_CHAIN_INVALID', 'chain must be a string');
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const parts = trimmed.split(SEPARATOR).map((part) => part.trim());
  for (const part of parts) {
    if (!isHarness(part)) {
      throw new PeerPolicyError('PEER_CHAIN_INVALID', `chain contains an unknown harness "${part}"`, { field: ENV_KEYS.chain });
    }
  }
  if (new Set(parts).size !== parts.length) {
    throw new PeerPolicyError('PEER_CHAIN_INVALID', 'chain repeats a harness; an inherited loop is never repaired', { field: ENV_KEYS.chain });
  }
  return parts;
}

export function formatChain(chain) {
  return chain.join(SEPARATOR);
}

function boundedInteger(value, fallback, field, { min = 0, max = MAX_DEPTH_CEILING } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PeerPolicyError('PEER_CONFIG_INVALID', `${field} must be an integer within ${min}..${max}`, { field });
  }
  return parsed;
}

/**
 * Read the caller's position from its environment. `self` comes from the operator's
 * MCP server configuration; the chain and limits are inherited from the parent. A
 * nonroot chain must end with `self`, otherwise the process does not know who it is.
 */
export function readChainContext(env = {}, { self: selfOverride = null } = {}) {
  const self = selfOverride ?? env[ENV_KEYS.self];
  if (!isHarness(self)) {
    throw new PeerPolicyError('PEER_SELF_UNKNOWN', `${ENV_KEYS.self} must name one of ${HARNESSES.join(', ')}`, { field: ENV_KEYS.self });
  }
  const inherited = parseChain(env[ENV_KEYS.chain]);
  if (inherited.length > 0 && inherited[inherited.length - 1] !== self) {
    throw new PeerPolicyError(
      'PEER_CHAIN_INVALID',
      `inherited chain "${formatChain(inherited)}" does not end with this harness "${self}"`,
      { field: ENV_KEYS.chain },
    );
  }
  const chain = inherited.length > 0 ? inherited : [self];
  const maxDepth = boundedInteger(env[ENV_KEYS.maxDepth], DEFAULT_MAX_DEPTH, ENV_KEYS.maxDepth, { min: 0 });
  const maxDelegateDepth = boundedInteger(env[ENV_KEYS.maxDelegateDepth], DEFAULT_MAX_DELEGATE_DEPTH, ENV_KEYS.maxDelegateDepth, { min: 0 });
  const rootTaskRaw = env[ENV_KEYS.rootTask];
  let rootTask = null;
  if (typeof rootTaskRaw === 'string' && rootTaskRaw.trim() !== '') {
    if (!ROOT_TASK_RE.test(rootTaskRaw.trim())) {
      throw new PeerPolicyError('PEER_CHAIN_INVALID', `${ENV_KEYS.rootTask} is not a valid task label`, { field: ENV_KEYS.rootTask });
    }
    rootTask = rootTaskRaw.trim();
  }
  return Object.freeze({
    self,
    chain: Object.freeze([...chain]),
    root: chain[0],
    depth: chain.length - 1,
    isRoot: chain.length === 1,
    maxDepth,
    maxDelegateDepth,
    rootTask,
  });
}

/**
 * Decide one peer call. Returns the callee's chain and the exact environment entries
 * the callee must inherit; throws PeerPolicyError when the call is not allowed.
 */
export function planPeerCall(context, { target, mode, rootTask = null } = {}) {
  if (!PEER_TARGETS.includes(target)) {
    throw new PeerPolicyError('PEER_UNKNOWN_TARGET', `target must be one of ${PEER_TARGETS.join(', ')}`, { field: 'target' });
  }
  if (!PEER_MODES.includes(mode)) {
    throw new PeerPolicyError('PEER_UNKNOWN_MODE', `mode must be one of ${PEER_MODES.join(', ')}`, { field: 'mode' });
  }
  if (target === context.self) {
    throw new PeerPolicyError('PEER_SELF_TARGET', `"${target}" cannot delegate to itself through the peer bridge; use its native subagents`, { field: 'target' });
  }
  if (context.chain.includes(target)) {
    throw new PeerPolicyError(
      'PEER_CYCLE',
      `"${target}" is already on the chain ${formatChain(context.chain)}; work must flow back as a result, never as a new request`,
      { field: 'target', chain: formatChain(context.chain) },
    );
  }
  const childChain = [...context.chain, target];
  const childDepth = childChain.length - 1;
  if (childDepth > context.maxDepth) {
    throw new PeerPolicyError('PEER_DEPTH_EXCEEDED', `chain ${formatChain(childChain)} exceeds the hop limit ${context.maxDepth}`, { field: 'target' });
  }
  if (mode === 'delegate' && childDepth > context.maxDelegateDepth) {
    throw new PeerPolicyError(
      'PEER_DELEGATE_DEPTH',
      `a sub-controller may only be appointed within ${context.maxDelegateDepth} hop(s) of the root controller; use consult or review here`,
      { field: 'mode' },
    );
  }
  const task = context.rootTask ?? rootTask;
  if (task !== null && !ROOT_TASK_RE.test(task)) {
    throw new PeerPolicyError('PEER_CHAIN_INVALID', 'rootTask is not a valid task label', { field: 'rootTask' });
  }
  const childEnv = {
    [ENV_KEYS.self]: target,
    [ENV_KEYS.chain]: formatChain(childChain),
    [ENV_KEYS.maxDepth]: String(context.maxDepth),
    [ENV_KEYS.maxDelegateDepth]: String(context.maxDelegateDepth),
  };
  if (task !== null) childEnv[ENV_KEYS.rootTask] = task;
  return Object.freeze({
    target,
    mode,
    chain: Object.freeze(childChain),
    depth: childDepth,
    root: context.root,
    rootTask: task,
    // The callee may consult/review further only while hops remain; it may delegate
    // only while it is still inside the delegate depth.
    calleeMayPeer: childDepth < context.maxDepth,
    calleeMayDelegate: childDepth < context.maxDelegateDepth,
    childEnv: Object.freeze(childEnv),
  });
}

/**
 * The preamble every peer prompt starts with. It states the callee's position so a
 * model that has no peer tool still knows where results must go. It is guidance; the
 * enforcement is planPeerCall in the callee's own peer server.
 */
export function buildPeerPreamble(plan) {
  const lines = [
    `[agent-bridge] You are working as "${plan.target}" for root controller "${plan.root}" (chain ${formatChain(plan.chain)}, mode ${plan.mode}).`,
  ];
  if (plan.mode === 'delegate') {
    lines.push('You are a sub-controller for the bounded objective below: plan it, run your own subagents or DSH bridge tasks inside the stated scope, verify with real evidence, and return one final report. You do not accept, merge or publish on behalf of the root controller.');
  } else if (plan.mode === 'review') {
    lines.push('Independent review: judge the material below on its merits and on evidence you can check yourself. Do not modify files. State disagreements plainly with reasons; do not defer to the requester.');
  } else {
    lines.push('Consultation: answer the question below independently. Do not modify files.');
  }
  lines.push(
    `Never send work back to any harness on the chain (${formatChain(plan.chain)}); results return to the caller only as your final answer.`,
    plan.calleeMayPeer
      ? (plan.calleeMayDelegate ? 'You may consult, review or delegate to a harness that is not on the chain.' : 'You may consult or request a review from a harness that is not on the chain, but you may not delegate.')
      : 'You may not start further peer calls.',
    '[end agent-bridge]',
  );
  return lines.join('\n');
}
