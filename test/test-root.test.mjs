import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestDir, testDir, testRootBase } from './helpers/test-root.mjs';

test('test root: unset BRIDGE_TEST_TMP falls back to the platform temporary directory', () => {
  assert.equal(testRootBase({}), os.tmpdir());
  assert.equal(testRootBase({ BRIDGE_TEST_TMP: '' }), os.tmpdir());
});

test('test root: an explicit BRIDGE_TEST_TMP is created and used, each caller gets its own directory', (t) => {
  const base = fs.mkdtempSync(path.join(testRootBase(), 'bridge-test-root-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const configured = path.join(base, 'nested', 'root');
  const env = { BRIDGE_TEST_TMP: configured };

  assert.equal(testRootBase(env), configured);
  assert.ok(fs.statSync(configured).isDirectory(), 'the configured root is created when missing');

  const first = makeTestDir('sample', env);
  const second = makeTestDir('sample', env);
  assert.notEqual(first, second);
  for (const dir of [first, second]) {
    assert.equal(path.dirname(dir), configured);
    assert.match(path.basename(dir), /^sample-/);
  }
});

test('test root: a relative BRIDGE_TEST_TMP and an unsafe prefix are refused', () => {
  assert.throws(() => testRootBase({ BRIDGE_TEST_TMP: 'relative/dir' }), /absolute path/);
  assert.throws(() => makeTestDir('../escape', {}), /prefix/);
  assert.throws(() => makeTestDir('', {}), /prefix/);
});

test('test root: testDir removes its directory when the test context finishes', async (t) => {
  let created = null;
  await t.test('inner', (inner) => {
    created = testDir(inner, 'bridge-test-root-cleanup');
    fs.writeFileSync(path.join(created, 'file.txt'), 'x');
  });
  assert.ok(created !== null);
  assert.equal(fs.existsSync(created), false);
});
