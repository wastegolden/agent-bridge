import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fail } from './contracts.mjs';

export const CONTROLLER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isAbsoluteLocalPath(value) {
  return typeof value === 'string' && path.isAbsolute(value)
    && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value))
    && !value.startsWith('\\') && !value.startsWith('//') && !value.includes('\0');
}

export function loadControllerRegistry(controllers) {
  if (!Array.isArray(controllers) || controllers.length < 1 || controllers.length > 32) {
    fail('CONTROLLER_CONFIG_INVALID', 'Invalid controller configuration', { field: 'controllers', expected: 'array of 1 to 32 controllers' });
  }
  const entries = [];
  const ids = new Set();
  const digests = new Set();
  for (const [index, controller] of controllers.entries()) {
    const field = `controllers[${index}]`;
    if (!controller || typeof controller !== 'object' || Array.isArray(controller)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(controller))
      || Object.keys(controller).some(key => !['id', 'tokenFile', 'admin'].includes(key))) {
      fail('CONTROLLER_CONFIG_INVALID', 'Invalid controller entry', { field, expected: 'object with only id, tokenFile and optional admin' });
    }
    if (typeof controller.id !== 'string' || !CONTROLLER_ID_PATTERN.test(controller.id) || ids.has(controller.id)) {
      fail('CONTROLLER_CONFIG_INVALID', 'Invalid or duplicate controller ID', { field: `${field}.id`, expected: 'unique ID matching ^[a-z][a-z0-9-]{0,63}$' });
    }
    if (!isAbsoluteLocalPath(controller.tokenFile)) {
      fail('CONTROLLER_CONFIG_INVALID', 'Invalid credential path', { field: `${field}.tokenFile`, expected: 'absolute local file path' });
    }
    if (Object.hasOwn(controller, 'admin') && typeof controller.admin !== 'boolean') {
      fail('CONTROLLER_CONFIG_INVALID', 'Invalid administrator flag', { field: `${field}.admin`, expected: 'boolean' });
    }
    let token;
    try {
      token = fs.readFileSync(controller.tokenFile, 'utf8').trim();
    } catch {
      fail('AUTH_UNAVAILABLE', 'Configured credential source unavailable', { field: `${field}.tokenFile`, expected: 'configured credential source available' });
    }
    if (!/^[\x21-\x7e]{24,512}$/.test(token)) {
      fail('CONTROLLER_CONFIG_INVALID', 'Invalid controller credential', { field: `${field}.tokenFile`, expected: '24 to 512 printable ASCII characters without whitespace' });
    }
    const digest = createHash('sha256').update(token).digest();
    const key = digest.toString('hex');
    if (digests.has(key)) {
      fail('CONTROLLER_CONFIG_INVALID', 'Duplicate controller credential', { field: `${field}.tokenFile`, expected: 'unique controller credential' });
    }
    ids.add(controller.id);
    digests.add(key);
    entries.push({ digest, principal: Object.freeze({ id: controller.id, admin: controller.admin ?? false }) });
  }
  return Object.freeze({
    ids: Object.freeze([...ids].sort()),
    authenticate(authorization) {
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
      const candidate = createHash('sha256').update(authorization.slice(7)).digest();
      let principal = null;
      // Every candidate is compared with every fixed-size digest, including after a match.
      for (const entry of entries) {
        if (timingSafeEqual(candidate, entry.digest)) principal = entry.principal;
      }
      return principal;
    },
  });
}

export function parseViaHeaders(req) {
  const values = {};
  for (const [header, field] of [['x-agent-bridge-chain', 'via.chain'], ['x-agent-bridge-root-task', 'via.rootTask']]) {
    let count = 0;
    for (let index = 0; index < (req.rawHeaders?.length ?? 0); index += 2) {
      if (req.rawHeaders[index].toLowerCase() === header) count++;
    }
    const value = req.headers[header];
    if (count > 1 || Array.isArray(value)) {
      fail('VIA_INVALID', 'Invalid via headers', { field, expected: 'single header value' });
    }
    if (value !== undefined && (typeof value !== 'string' || /[^\x20-\x7e\t]/.test(value))) {
      fail('VIA_INVALID', 'Invalid via headers', { field, expected: 'ASCII header without control characters' });
    }
    values[header] = value?.trim() || null;
  }
  const chain = values['x-agent-bridge-chain'];
  const rootTask = values['x-agent-bridge-root-task'];
  if (chain && (chain.length > 256 || !/^(claude-code|codex|antigravity|dsh)(>(claude-code|codex|antigravity|dsh)){0,4}$/.test(chain))) {
    fail('VIA_INVALID', 'Invalid via chain', { field: 'via.chain', expected: '1 to 5 harness names (claude-code, codex, antigravity, dsh), joined by >; max 256 bytes' });
  }
  if (rootTask && (!chain || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rootTask))) {
    fail('VIA_INVALID', 'Invalid via root task', { field: 'via.rootTask', expected: 'chain required; root task matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
  }
  return chain ? { chain: chain.split('>'), rootTask } : null;
}
