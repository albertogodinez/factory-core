// Run: node --test log.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const LOG = fileURLToPath(new URL('./log.mjs', import.meta.url));
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'log-test-')); });
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (args, env = {}) => spawnSync(process.execPath, [LOG, ...args], {
  encoding: 'utf8', env: { ...process.env, DECISIONS_DIR: join(dir, 'decisions'), ...env },
});

test('a bare slug writes the header once, then rows, and prints the path', () => {
  const a = run(['task-1', 'frame', 'sized it', 'to plan', 'commit abc', 'ok']);
  assert.equal(a.status, 0, a.stderr);
  const file = join(dir, 'decisions', 'task-1.tsv');
  assert.equal(a.stdout.trim(), file);
  run(['task-1', 'build', 'did x', 'because y', 'a.js:1', 'green']);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'ts\tphase\tdecision\twhy\tevidence\tresult');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tframe\tsized it\tto plan\tcommit abc\tok$/);
});

test('tabs and newlines become spaces; formula-looking cells get a leading quote', () => {
  const file = join(dir, 'clean.tsv');
  assert.equal(run([file, 'p', 'a\tb\nc', '=SUM(A1)', '+1', '@x']).status, 0);
  const cells = readFileSync(file, 'utf8').trim().split('\n')[1].split('\t');
  assert.deepEqual(cells.slice(1), ['p', 'a b c', "'=SUM(A1)", "'+1", "'@x"]);
});

test('a path with a slash or .tsv is used as the file', () => {
  const file = join(dir, 'sub', 'dir', 'x.tsv');
  assert.equal(run([file, 'p', 'd', 'w', 'e', 'r']).stdout.trim(), file);
});

test('bad slug and wrong argument count are refused', () => {
  assert.equal(run(['.hidden', 'p', 'd', 'w', 'e', 'r']).status, 1);
  assert.equal(run(['bad slug', 'p', 'd', 'w', 'e', 'r']).status, 1);
  const r = run(['only', 'two']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/);
});

test('without DECISIONS_DIR the slug resolves beside the state directory', () => {
  const r = spawnSync(process.execPath, [LOG, 'viaresolver', 'p', 'd', 'w', 'e', 'r'], {
    encoding: 'utf8', cwd: dir, env: { ...process.env, DECISIONS_DIR: '' },
  });
  // The fixture dir is not a git repo and has no config, so the resolver refuses (exit 1 from us).
  assert.equal(r.status, 1);
  assert.match(r.stderr, /state directory/);
});
