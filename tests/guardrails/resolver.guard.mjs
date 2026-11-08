// Hard limits on the resolver: speed, git spawns, output size, imports.
// Every skill calls the resolver, so these run in pre-commit whenever
// bundles/core/toolkit-context/ changes (see .githooks/pre-commit).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtures } from '../fixtures/make.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..', '..', 'bundles', 'core', 'toolkit-context');
const RESOLVE = join(SKILL, 'scripts', 'resolve.mjs');
const LIMITS = { cachedMedianMs: 50, cachedMaxMs: 100, coldMs: 150, coldSpawns: 1, cachedSpawns: 0, outBytes: 1024, fieldBytes: 200 };

let fx, fakeBin, counter;
before(() => {
  fx = makeFixtures();
  // A `git` that counts its calls, then runs the real one.
  fakeBin = join(fx.root, 'fakebin'); counter = join(fx.root, 'git-calls');
  mkdirSync(fakeBin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\necho x >> "${counter}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(fakeBin, 'git'), 0o755);
});
after(() => fx.cleanup());

const baseEnv = (extra = {}) => ({ ...process.env, AI_TOOLKIT_CONFIG: '', AI_TOOLKIT_HOME: fx.home, ...extra });
function timed(cwd, args = [], env = baseEnv()) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [RESOLVE, ...args], { cwd, env, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.status, 0, r.stderr);
  return { ms, out: r.stdout };
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function spawns(fn) {
  rmSync(counter, { force: true });
  fn();
  return existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').length : 0;
}

test(`cached: median < ${LIMITS.cachedMedianMs} ms, max < ${LIMITS.cachedMaxMs} ms over 10 runs`, () => {
  const cwd = join(fx.root, 'project');
  timed(cwd); // warm the cache
  const runs = Array.from({ length: 10 }, () => timed(cwd).ms);
  const m = median(runs), mx = Math.max(...runs);
  assert.ok(m < LIMITS.cachedMedianMs, `median ${m.toFixed(1)} ms (runs: ${runs.map((x) => x.toFixed(0)).join(', ')})`);
  assert.ok(mx < LIMITS.cachedMaxMs, `max ${mx.toFixed(1)} ms`);
});

test(`cold: < ${LIMITS.coldMs} ms (median of 5, empty cache each time)`, () => {
  const runs = ['project', 'zero-config', 'hub', 'project', 'zero-config'].map((d, i) => {
    const home = join(fx.root, `cold-home-${i}`);
    return timed(join(fx.root, d), [], baseEnv({ AI_TOOLKIT_HOME: home })).ms;
  });
  assert.ok(median(runs) < LIMITS.coldMs, `median ${median(runs).toFixed(1)} ms (runs: ${runs.map((x) => x.toFixed(0)).join(', ')})`);
});

test(`git spawns: ≤ ${LIMITS.coldSpawns} cold, ${LIMITS.cachedSpawns} cached`, () => {
  const env = baseEnv({ PATH: `${fakeBin}:${process.env.PATH}`, AI_TOOLKIT_HOME: join(fx.root, 'spawn-home') });
  for (const d of ['project', 'zero-config', 'hub', join('project', '.worktrees', 'feat', 'x')]) {
    const cwd = join(fx.root, d);
    assert.ok(spawns(() => timed(cwd, [], env)) <= LIMITS.coldSpawns, `${d} cold`);
    assert.equal(spawns(() => timed(cwd, [], env)), LIMITS.cachedSpawns, `${d} cached`);
  }
  // The one case that needs git: GIT_DIR set. Exactly one spawn, never more.
  const gitEnv = { ...env, GIT_DIR: join(fx.root, 'project', '.git') };
  assert.equal(spawns(() => timed(join(fx.root, 'project'), [], gitEnv)), 1, 'GIT_DIR fallback');
});

test(`output: ≤ ${LIMITS.outBytes} B, ≤ ${LIMITS.fieldBytes} B with --field`, () => {
  for (const [d, args] of [['project', []], ['zero-config', []], ['hub', []], ['hub', ['--repo', 'project']], ['project/.worktrees/feat/x', []]]) {
    const { out } = timed(join(fx.root, d), ['--no-cache', ...args]);
    assert.ok(Buffer.byteLength(out) <= LIMITS.outBytes, `${d}: ${Buffer.byteLength(out)} B`);
  }
  for (const f of ['project.trunk', 'stateRoot', 'project.remote', 'writeAllowed']) {
    const { out } = timed(join(fx.root, 'project'), ['--no-cache', '--field', f]);
    assert.ok(Buffer.byteLength(out) <= LIMITS.fieldBytes, `--field ${f}: ${Buffer.byteLength(out)} B`);
  }
});

test('imports: node: modules only (plus files inside the skill)', () => {
  const dir = join(SKILL, 'scripts');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((m) => m[1] || m[2] || m[3]);
    const bad = specs.filter((s) => !s.startsWith('node:') && !s.startsWith('./'));
    assert.deepEqual(bad, [], `${f} imports ${bad.join(', ')}`);
  }
});
