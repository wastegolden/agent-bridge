#!/usr/bin/env node
// agent-peer MCP stdio server (contract agent-peer-v1).
//
// Required environment (set in the harness's MCP server config, never by a model):
//   AGENT_BRIDGE_SELF   which harness this server runs inside: claude-code | codex
//   AGENT_PEER_CONFIG   absolute path of the operator peer config JSON
// Inherited from a calling harness when this harness was itself started as a peer:
//   AGENT_BRIDGE_CHAIN, AGENT_BRIDGE_MAX_DEPTH, AGENT_BRIDGE_MAX_DELEGATE_DEPTH, AGENT_BRIDGE_ROOT_TASK
//
// A missing or invalid config does not stop the server: tools/list still works and
// peer_capabilities reports the problem, so the controller sees why calls are refused.
import process from 'node:process';
import readline from 'node:readline';

import { loadPeerConfig } from '../src/peer/config.mjs';
import { createPeerServer } from '../src/peer/server.mjs';

let config = null;
let configError = null;
try {
  config = await loadPeerConfig({ env: process.env });
} catch (error) {
  configError = error;
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: 'agent-peer', phase: 'config', code: error?.code ?? 'E_CONFIG', field: error?.detail?.field ?? null })}\n`);
}

const server = createPeerServer({ env: process.env, config, configError });
const reader = server.attach({ input: process.stdin, output: process.stdout, createInterface: readline.createInterface });
const shutdown = async () => {
  reader.close();
  await server.close();
  process.exit(0);
};
process.stdin.on('end', shutdown);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
