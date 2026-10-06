#!/usr/bin/env node
// Trusted-controller entrypoint for the event-wake runner (contract
// supervisor-event-wake-v1).
//
// This is NOT a worker tool and exposes no worker destination/transport authority.
// It starts the existing event-driven runner (`runWakeRunner`) for exactly ONE
// operator-configured originating chat:
//
//   * everything comes from a trusted JSON config file (paths + bounded limits only;
//     never an environment secret, never a thread id supplied by a model);
//   * the runner's bound target and the caller metadata must both equal the actual
//     `CODEX_THREAD_ID` of this controller process — a missing or different value is a
//     typed refusal, never forged `_meta`;
//   * the destination and message are resolved by the accepted wake client from the
//     official codex-app-tools MCP `tools/list` catalog; the raw pipe is never opened;
//   * the official transport environment must be present in the inherited process
//     environment (presence only: the value is never read, copied or logged);
//   * there are deliberately no --target/--state-dir/--server-path/--caller-thread
//     overrides, so no command line can bypass the single validated binding.
//
// Reuse, not redesign: the outbox, the client and the claim/dispatch/settle loop are
// the accepted modules. This file only wires them to one validated configuration.

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createWakeOutbox } from '../src/wake-outbox.mjs';
import { createWakeClient } from '../src/codex-wake-client.mjs';
import {
  TRUSTED_CONTROLLER_AUTHORITY,
  WakeIntegrationError,
  assertControllerBinding,
  assertTransportEnvironment,
  loadControllerConfig,
} from '../src/wake-integration.mjs';
import { createSafeLogger, reconcileEvent, runWakeRunner } from './wake-codex.mjs';

export const CONTROLLER_USAGE =
  'usage: node bin/wake-controller.mjs --config <absolute-config.json> [--once] [--reconcile <eventId> --delivered true|false [--requeue]]';

export function parseControllerArgs(argv = []) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new WakeIntegrationError('controller/invalid-arguments', `unexpected argument ${arg} (${CONTROLLER_USAGE})`, {});
    const name = arg.slice(2);
    if (name === 'once') {
      flags.once = true;
      continue;
    }
    if (name === 'requeue') {
      flags.requeue = true;
      continue;
    }
    if (!['config', 'config-file', 'reconcile', 'delivered'].includes(name)) {
      throw new WakeIntegrationError('controller/invalid-arguments', `unexpected flag --${name} (${CONTROLLER_USAGE})`, { field: name });
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new WakeIntegrationError('controller/invalid-arguments', `--${name} requires a value`, { field: name });
    }
    flags[name === 'config-file' ? 'config' : name] = value;
    index += 1;
  }
  if (typeof flags.config !== 'string' || !flags.config.trim()) {
    throw new WakeIntegrationError('controller/invalid-arguments', `--config is required (${CONTROLLER_USAGE})`, { field: 'config' });
  }
  if (flags.delivered !== undefined && flags.delivered !== 'true' && flags.delivered !== 'false') {
    throw new WakeIntegrationError('controller/invalid-arguments', '--delivered must be "true" or "false"', { field: 'delivered' });
  }
  if (flags.reconcile === undefined && (flags.delivered !== undefined || flags.requeue === true)) {
    throw new WakeIntegrationError('controller/invalid-arguments', '--delivered/--requeue are only valid together with --reconcile', { field: 'reconcile' });
  }
  return flags;
}

export async function readControllerConfigFile(filePath, readFileImpl = readFile) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new WakeIntegrationError('controller/invalid-arguments', 'a config file path is required', { field: 'config' });
  }
  let text;
  try {
    text = await readFileImpl(filePath, 'utf8');
  } catch (error) {
    throw new WakeIntegrationError('controller/config-unreadable', `cannot read the controller config file: ${error?.message ?? error}`, {
      field: 'config',
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WakeIntegrationError('controller/config-invalid-json', `the controller config file is not valid JSON: ${error?.message ?? error}`, {
      field: 'config',
    });
  }
  return loadControllerConfig(parsed);
}

/**
 * Run one controller session: reconcile mode exits after one reconciliation, send mode
 * runs the accepted event-driven loop (once or until cancelled).
 * @param {{argv?: string[], env?: object, readFileImpl?: Function, logger?: Function, clientFactory?: Function, singleShot?: boolean}} [options]
 * @returns {Promise<number>} exit code.
 */
export async function main({ argv = process.argv.slice(2), env = process.env, readFileImpl = readFile, logger = null, clientFactory = null, singleShot = false } = {}) {
  const log = logger ?? createSafeLogger();
  const flags = parseControllerArgs(argv);
  const config = await readControllerConfigFile(flags.config, readFileImpl);
  const binding = assertControllerBinding({ targetId: config.targetId, callerThreadId: config.callerThreadId, env });
  log({
    phase: 'controller-binding',
    targetAllowed: true,
    callerMetaPresent: true,
    state: binding.targetId === binding.callerThreadId ? 'bound' : 'mismatch',
  });

  const outbox = createWakeOutbox({
    dir: config.outboxDir,
    authority: TRUSTED_CONTROLLER_AUTHORITY,
    allowedTargetIds: [config.targetId],
    claimLeaseMs: config.claimLeaseMs,
    maxSummaryChars: config.maxSummaryChars,
  });

  try {
    if (flags.reconcile !== undefined) {
      const result = await reconcileEvent(outbox, {
        reconcileEventId: flags.reconcile,
        delivered: flags.delivered === undefined ? null : flags.delivered === 'true',
        requeue: flags.requeue === true,
      });
      log({
        phase: 'reconcile',
        eventId: flags.reconcile,
        state: result?.event?.state,
        code: result?.duplicate ? 'duplicate' : 'reconciled',
      });
      return 0;
    }

    // Presence only: the value is never read, copied, hashed or logged.
    assertTransportEnvironment({ env });
    const client = clientFactory !== null
      ? await clientFactory({ config })
      : createWakeClient({
          authority: TRUSTED_CONTROLLER_AUTHORITY,
          allowedTargetIds: [config.targetId],
          // The actual originating chat, taken from this controller process. The
          // accepted client refuses construction without a caller context; there is
          // no fallback identity here.
          callerContext: { codexThreadId: binding.callerThreadId },
          maxSummaryChars: config.maxSummaryChars,
          logger: log,
          stdio: {
            serverPath: config.serverPath,
            nodePath: config.nodePath,
            env,
            logger: log,
          },
        });

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const stats = await runWakeRunner({
        outbox,
        client,
        runnerId: `wake-controller:${config.targetId}`,
        idleTimeoutMs: config.idleTimeoutMs,
        once: flags.once === true || config.once === true || singleShot,
        signal: controller.signal,
        logger: log,
      });
      log({ phase: 'runner-stopped', ...stats });
      return stats.claimErrors > 0 ? 2 : 0;
    } finally {
      await client.close?.().catch(() => undefined);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    await outbox.close().catch(() => undefined);
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Bounded, secret-free diagnostic: code plus the settings field named by the
      // refusal. Message text is included only for integration-owned refusals, whose
      // wording is generated here and never contains environment values.
      const payload = { at: new Date().toISOString(), phase: 'fatal', code: error?.code ?? 'E_FATAL' };
      if (typeof error?.detail?.field === 'string') payload.field = error.detail.field;
      if (error instanceof WakeIntegrationError) payload.message = error.message;
      process.stderr.write(`${JSON.stringify(payload)}\n`);
      process.exitCode = 1;
    });
}
