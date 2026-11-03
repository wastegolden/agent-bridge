// Shared credential boundary for the carrier, peer client and child processes.
import { readFile } from 'node:fs/promises';

const BRIDGE_CREDENTIAL_ENV = /^(DSH_MCP_TOKEN|DSH_BRIDGE_CREDENTIAL_FILE|DSH_BRIDGE_DELEGATED|DSH_BRIDGE_DISABLED)$/i;

/** Windows environment names are case-insensitive, including in injected test envs. */
export function bridgeEnvValue(env, name) {
  const key = Object.hasOwn(env ?? {}, name) ? name : Object.keys(env ?? {}).find((key) => key.toUpperCase() === name);
  const value = key === undefined ? undefined : env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Preserve every unrelated variable, including PowerShell's module environment. */
export function stripBridgeCredentials(env) {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !BRIDGE_CREDENTIAL_ENV.test(key)));
}

/** Resolve one effective credential. A delegated process must never read local files. */
export async function resolveBridgeCredential({ env = process.env, credentialFile = null, readFileImpl = readFile } = {}) {
  if (bridgeEnvValue(env, 'DSH_BRIDGE_DISABLED') === '1') return null;
  const token = bridgeEnvValue(env, 'DSH_MCP_TOKEN');
  if (token !== null) return token;
  const chain = bridgeEnvValue(env, 'AGENT_BRIDGE_CHAIN');
  if (bridgeEnvValue(env, 'DSH_BRIDGE_DELEGATED') === '1' || (chain !== null && chain.split('>').length > 1)) return null;
  const file = bridgeEnvValue(env, 'DSH_BRIDGE_CREDENTIAL_FILE') ?? credentialFile;
  if (typeof file !== 'string' || file.trim() === '') return null;
  try {
    return String(await readFileImpl(file, 'utf8')).trim() || null;
  } catch {
    // File paths and OS error messages may contain secrets; report only unavailability.
    return null;
  }
}

/** Client-declared provenance. A root's requests carry neither header (contract R1). */
export function bridgeViaHeaders(env) {
  const chain = bridgeEnvValue(env, 'AGENT_BRIDGE_CHAIN');
  if (chain === null || (bridgeEnvValue(env, 'DSH_BRIDGE_DELEGATED') !== '1' && chain.split('>').length <= 1)) return {};
  const rootTask = bridgeEnvValue(env, 'AGENT_BRIDGE_ROOT_TASK');
  return {
    'X-Agent-Bridge-Chain': chain,
    ...(rootTask === null ? {} : { 'X-Agent-Bridge-Root-Task': rootTask }),
  };
}
