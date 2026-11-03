#!/usr/bin/env node
// Operator CLI for the DSH bridge.
//
//   node bin/operator.mjs --url <loopback-url> --credential-file <file>
//                         --tool <mutation-tool> --args-file <json>
//
// The credential file is read directly by THIS process; DSH_MCP_TOKEN and every other
// bridge credential variable in the environment are ignored. No child process is
// started and no shell is used. The URL must be a literal loopback HTTP(S) URL with no
// userinfo. Exactly one bridge_capabilities call and one requested mutation call are
// made with the same token; redirects fail closed. The token is never printed, including
// when the server echoes it or an error contains it.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { TOOLS } from '../src/mcp.mjs';

const TOKEN_RE = /^[\x21-\x7e]{24,512}$/;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]', '::1']);
const REQUEST_TIMEOUT_MS = 60_000;

export const MUTATION_TOOLS = Object.freeze(TOOLS.filter((tool) => tool.category === 'mutate').map((tool) => tool.name));
export const USAGE = 'usage: node bin/operator.mjs --url <loopback-url> --credential-file <file> --tool <mutation-tool> --args-file <json>';

export class OperatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OperatorError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new OperatorError(code, message);
};
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseArgs(argv) {
  const options = { url: null, credentialFile: null, tool: null, argsFile: null, help: false };
  const takesValue = new Map([
    ['--url', 'url'],
    ['--credential-file', 'credentialFile'],
    ['--tool', 'tool'],
    ['--args-file', 'argsFile'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') {
      options.help = true;
      continue;
    }
    const key = takesValue.get(argument);
    if (key === undefined) fail('E_ARGS', `unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('E_ARGS', `${argument} requires a value`);
    if (options[key] !== null) fail('E_ARGS', `${argument} was supplied more than once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

/** True only for a literal loopback http(s) URL without embedded credentials. */
export function isLoopbackUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return LOOPBACK_HOSTS.includes(parsed.hostname.toLowerCase());
}

async function readCredential(file, readFileImpl) {
  if (typeof file !== 'string' || file.trim() === '') fail('E_ARGS', '--credential-file must be a nonblank path');
  let text;
  try {
    text = String(await readFileImpl(path.resolve(file.trim()), 'utf8'));
  } catch {
    fail('E_CREDENTIAL', 'the credential file is not readable');
  }
  const token = text.trim();
  if (!TOKEN_RE.test(token)) fail('E_CREDENTIAL', 'the credential file must hold 24 to 512 printable ASCII characters without whitespace');
  return token;
}

async function readArguments(file, readFileImpl) {
  if (typeof file !== 'string' || file.trim() === '') fail('E_ARGS', '--args-file must be a nonblank path');
  let text;
  try {
    text = String(await readFileImpl(path.resolve(file.trim()), 'utf8'));
  } catch {
    fail('E_ARGS_FILE', 'the args file is not readable');
  }
  let args;
  try {
    args = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    fail('E_ARGS_FILE', 'the args file is not valid JSON');
  }
  if (!isPlainObject(args)) fail('E_ARGS_FILE', 'the args file must contain a JSON object');
  if (!Object.hasOwn(args, 'override') || !isPlainObject(args.override)) {
    fail('E_ARGS_FILE', 'the args file must contain an explicit override object');
  }
  const keys = Object.keys(args.override);
  if (keys.length !== 1 || keys[0] !== 'reason') fail('E_ARGS_FILE', 'override must contain only a reason');
  if (typeof args.override.reason !== 'string' || args.override.reason.length > 500) {
    fail('E_ARGS_FILE', 'override.reason must be a string of at most 500 characters');
  }
  const reason = args.override.reason.trim();
  if (reason === '') fail('E_ARGS_FILE', 'override.reason must be nonblank');
  return { ...args, override: { reason } };
}

function parseBridgeError(payload) {
  const content = payload?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return { code: null, message: null };
  const raw = isPlainObject(content[0]) && typeof content[0].text === 'string' ? content[0].text : null;
  if (raw === null) return { code: null, message: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: null, message: null };
  }
  if (!isPlainObject(parsed)) return { code: null, message: null };
  return {
    code: typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : (Number.isSafeInteger(parsed.code) ? parsed.code : null),
    message: typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : null,
  };
}

async function callTool({ url, token, tool, args, fetchImpl }) {
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      // A redirect could leave loopback or downgrade the request; fail instead of following.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail('E_BRIDGE', `bridge ${tool} request failed: ${error?.message ?? error}`);
  }
  if (Number(response?.status) !== 200) fail('E_BRIDGE', `bridge ${tool} returned HTTP ${Number.isFinite(Number(response?.status)) ? Number(response.status) : 'unknown'}`);
  let raw;
  try {
    raw = await response.text();
  } catch {
    fail('E_BRIDGE', `bridge ${tool} reply could not be read`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail('E_BRIDGE', `bridge ${tool} reply was not JSON`);
  }
  if (!isPlainObject(payload)) fail('E_BRIDGE', `bridge ${tool} reply was not a JSON-RPC object`);
  if (isPlainObject(payload.error)) fail('E_BRIDGE', `bridge ${tool} failed: ${typeof payload.error.message === 'string' ? payload.error.message : 'JSON-RPC error'}`);
  if (!isPlainObject(payload.result)) fail('E_BRIDGE', `bridge ${tool} returned no result`);
  if (payload.result.isError === true) {
    const parsed = parseBridgeError(payload);
    fail('E_BRIDGE', `bridge ${tool} refused the call${parsed.code === null ? '' : ` (${parsed.code})`}${parsed.message === null ? '' : `: ${parsed.message}`}`);
  }
  return payload.result.structuredContent ?? payload.result;
}

function redact(value, token) {
  const text = String(value ?? '');
  return token === null ? text : text.split(token).join('[redacted]');
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const readFileImpl = io.readFileImpl ?? readFile;
  const fetchImpl = io.fetchImpl ?? globalThis.fetch;
  let token = null;
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout(`${USAGE}\n`);
      return 0;
    }
    if (options.url === null || options.credentialFile === null || options.tool === null || options.argsFile === null) {
      fail('E_ARGS', '--url, --credential-file, --tool and --args-file are all required');
    }
    if (!isLoopbackUrl(options.url)) fail('E_URL', '--url must be a literal loopback http(s) URL without credentials');
    const args = await readArguments(options.argsFile, readFileImpl);
    if (!MUTATION_TOOLS.includes(options.tool)) fail('E_ARGS', '--tool must be one of the mutation tools');
    token = await readCredential(options.credentialFile, readFileImpl);
    const capabilities = await callTool({ url: options.url, token, tool: 'bridge_capabilities', args: {}, fetchImpl });
    const identity = capabilities?.controllerIdentity;
    if (identity?.enabled !== true || identity?.admin !== true) {
      fail('E_IDENTITY', 'the credential must resolve to an enabled administrator controller identity');
    }
    const result = await callTool({ url: options.url, token, tool: options.tool, args, fetchImpl });
    stdout(`${redact(JSON.stringify(result, null, 2), token)}\n`);
    return 0;
  } catch (error) {
    // Every externally sourced message is redacted before it reaches stderr.
    stderr(`${error?.code ?? 'E_OPERATOR'}: ${redact(error?.message ?? error, token)}\n`);
    return ['E_ARGS', 'E_URL', 'E_CREDENTIAL', 'E_ARGS_FILE'].includes(error?.code) ? 2 : 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
