// Hard limits on `factory status`, which a user-level SessionStart hook runs at the start of every
// session. Runs in pre-commit whenever bin/factory.mjs changes (see .githooks/pre-commit).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempRoot, makeRepo, write, git } from '../fixtures/make.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FACTORY = join(ROOT, 'bin', 'factory.mjs');
const CORE = join(ROOT, 'bundles', 'core');
// Node takes 40-50 ms to start on a loaded laptop, so the limits are on overhead above an empty
// Node run, measured alternately with it.
const LIMITS = { cachedOverheadMs: 40, cachedSpawns: 0, uncachedOverheadMs: 250, uncachedSpawnsPerRepo: 1 };

let t, home, repo, fakeBin, counter;
before(() => {
  t = tempRoot('af-status-');
  home = join(t.root, 'home'); mkdirSync(home);
  // Two bundles in one source repo, plus core in this repo: two source repos.
  const src = join(t.root, 'src');
  const files = {};
  for (const b of ['x', 'y']) for (let i = 0; i < 15; i++) files[`bundles/${b}/${b}-skill-${i}/SKILL.md`] = `---\nname: ${b}-skill-${i}\ndescription: d\n---\n`;
  makeRepo(src, { files });
  for (let i = 0; i < 50; i++) { write(join(src, 'log.txt'), `${i}\n`); git(src, 'add', '-A'); git(src, 'commit', '-qm', `c${i}`); }
  write(join(home, 'sources.json'), { core: CORE, x: join(src, 'bundles', 'x'), y: join(src, 'bundles', 'y') });
  repo = join(t.root, 'consumer');
  makeRepo(repo, { remote: 'git@github.com:me/consumer.git' });
  const env = { ...process.env, AI_TOOLKIT_HOME: home, AI_TOOLKIT_CONFIG: '', AI_TOOLKIT_HARNESSES: 'none' };
  execFileSync(process.execPath, [FACTORY, 'install', 'core', 'x', 'y', '--commit', '--marker', 'off'], { cwd: repo, env, stdio: 'ignore' });
  fakeBin = join(t.root, 'fakebin'); counter = join(t.root, 'git-calls'); mkdirSync(fakeBin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\necho x >> "${counter}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(fakeBin, 'git'), 0o755);
});
after(() => t.cleanup());

const env = () => ({ ...process.env, AI_TOOLKIT_HOME: home, AI_TOOLKIT_CONFIG: '', PATH: `${fakeBin}:${process.env.PATH}` });
function timed(args) {
  const s = performance.now();
  const r = spawnSync(process.execPath, args, { cwd: repo, env: env(), encoding: 'utf8' });
  return { ms: performance.now() - s, r };
}
function spawns(fn) {
  rmSync(counter, { force: true });
  fn();
  return existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0;
}
// Median overhead over an empty Node, alternating the two runs.
function overhead(prep) {
  const d = [];
  for (let i = 0; i < 7; i++) { prep(); const a = timed([FACTORY, 'status']).ms; const b = timed(['-e', '0']).ms; d.push(a - b); }
  return d.sort((p, q) => p - q)[3];
}
const dropCache = () => rmSync(join(home, 'status-cache.json'), { force: true });

test('uncached: one git spawn per source repo, bounded overhead', () => {
  assert.equal(spawns(() => { dropCache(); timed([FACTORY, 'status']); }), 2 * LIMITS.uncachedSpawnsPerRepo);
  const ms = overhead(dropCache);
  assert.ok(ms < LIMITS.uncachedOverheadMs, `uncached overhead ${ms.toFixed(0)} ms >= ${LIMITS.uncachedOverheadMs}`);
});

test('cached: no git spawns, near-zero overhead', () => {
  timed([FACTORY, 'status']);
  assert.equal(spawns(() => timed([FACTORY, 'status'])), LIMITS.cachedSpawns);
  const ms = overhead(() => {});
  assert.ok(ms < LIMITS.cachedOverheadMs, `cached overhead ${ms.toFixed(0)} ms >= ${LIMITS.cachedOverheadMs}`);
});
