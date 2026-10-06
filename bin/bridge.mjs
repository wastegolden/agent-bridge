#!/usr/bin/env node
// Small stdio carrier connecting Codex to an independently hosted DSH plugin.
//
// It never starts/stops the DSH host and never logs the bearer credential. The JSON-RPC
// behaviour is unchanged; the only addition is an OPTIONAL, opt-in one-shot deadline
// watchdog (see docs/deadline-watchdog.md) that is fully inert unless the operator sets
// DSH_BRIDGE_WATCHDOG_CONFIG. Watchdog work runs strictly after the upstream reply and
// can never alter it or write to stdout.
import process from 'node:process';
import readline from 'node:readline';

import {
  createCarrier,
  createCarrierLogger,
  defaultCredentialFile,
  nonBlankEnv,
  resolveCarrierToken,
} from '../src/bridge-carrier.mjs';

const env = process.env;
const log = createCarrierLogger();
const credentialFile = nonBlankEnv(env, 'DSH_BRIDGE_CREDENTIAL_FILE') ?? defaultCredentialFile(env);

// The historical startup refusal is preserved exactly: no token means a stderr line and
// exit code 2, with nothing written to stdout.
const token = await resolveCarrierToken({ env, credentialFile });
if (!token) {
  process.stderr.write('DSH bridge credential unavailable\n');
  process.exit(2);
}

const carrier = createCarrier({ env, credentialFile, logger: log });
await carrier.start();
carrier.attach((options) => readline.createInterface(options));
