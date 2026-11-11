import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight } from './preflight.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'preflight.mjs');
const fixture = (nvmrc) => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  if (nvmrc) writeFileSync(join(dir, '.nvmrc'), nvmrc);
  return dir;
};

test('a matching .nvmrc major passes', () => {
  assert.deepEqual(preflight({ dir: fixture('v24.1.0\n'), nodeVersion: 'v24.9.0' }), []);
});

test('a mismatched .nvmrc major fails', () => {
  const [p] = preflight({ dir: fixture('20'), nodeVersion: 'v24.9.0' });
  assert.match(p, /does not match \.nvmrc/);
});

test('the CLI exits 1 under a mismatched .nvmrc fixture', () => {
  const dir = fixture('1');
  assert.throws(() => execFileSync('node', [SCRIPT, '--dir', dir], { stdio: 'pipe' }), (e) => e.status === 1 && /\.nvmrc/.test(String(e.stderr)));
});

test('a symlinked node_modules fails', () => {
  const dir = fixture();
  const real = mkdtempSync(join(tmpdir(), 'real-nm-'));
  symlinkSync(real, join(dir, 'node_modules'));
  assert.match(preflight({ dir, nodeVersion: 'v24.0.0' })[0], /symlink/);
});

test('a real node_modules directory passes', () => {
  const dir = fixture();
  mkdirSync(join(dir, 'node_modules'));
  assert.deepEqual(preflight({ dir }), []);
});

test('a HEAD that did not move fails and a moved one passes', () => {
  const dir = fixture();
  assert.match(preflight({ dir, head: 'abc', before: 'abc' })[0], /did not happen/);
  assert.deepEqual(preflight({ dir, head: 'def', before: 'abc' }), []);
});
