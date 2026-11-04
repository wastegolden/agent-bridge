// test/helpers/test-root.mjs
//
// The single place that decides where tests put temporary files.
//
// BRIDGE_TEST_TMP, when set, must be an absolute path: it is created if missing and
// every caller gets its own unique subdirectory inside it. When it is not set the
// platform temporary directory is used. The local acceptance commands set
// BRIDGE_TEST_TMP (and TEMP/TMP) under F:\temp, CI sets it to the runner's temporary
// directory. Nothing here guesses from which drives or folders happen to exist, so a
// machine without the local layout still runs the suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The directory test directories are created in. */
export function testRootBase(env = process.env) {
  const configured = env.BRIDGE_TEST_TMP;
  if (configured === undefined || configured === '') return os.tmpdir();
  if (!path.isAbsolute(configured)) {
    throw new Error(`BRIDGE_TEST_TMP must be an absolute path, got ${JSON.stringify(configured)}`);
  }
  fs.mkdirSync(configured, { recursive: true });
  return configured;
}

/** Create a fresh, uniquely named directory for one test or fixture. */
export function makeTestDir(prefix, env = process.env) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new Error('makeTestDir prefix must be 1-64 characters of letters, digits, ".", "_" or "-"');
  }
  return fs.mkdtempSync(path.join(testRootBase(env), `${prefix}-`));
}

/** makeTestDir, removed again when the node:test context `t` finishes. */
export function testDir(t, prefix, env = process.env) {
  const dir = makeTestDir(prefix, env);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
