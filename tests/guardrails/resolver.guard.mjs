// Hard limits on the resolver: speed, git spawns, output size, imports.
// Every skill calls the resolver, so these run in pre-commit whenever
// bundles/core/toolkit-context/ changes (see .githooks/pre-commit).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtures, write, makeRepo } from '../fixtures/make.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..', '..', 'bundles', 'core', 'toolkit-context');
const RESOLVE = join(SKILL, 'scripts', 'resolve.mjs');
// Node itself takes 40-50 ms to start on a loaded laptop, so the speed limits
// are on the resolver's overhead above an empty Node run, measured alternately
// with it, with absolute caps as a backstop.
const LIMITS = {
  cachedOverheadMs: 15, cachedMaxMs: 100, coldOverheadMs: 60, coldMs: 150,
  coldSpawns: 1, cachedSpawns: 0, outBytes: 1024, perNeighborBytes: 70, fieldBytes: 200,
};

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

function baseline(cwd) {
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, ['--input-type=module', '-e', ''], { cwd });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
const fmt = (xs) => xs.map((x) => x.toFixed(0)).join(', ');

test(`cached: overhead over bare node < ${LIMITS.cachedOverheadMs} ms (median of 10), max < ${LIMITS.cachedMaxMs} ms`, () => {
  const cwd = join(fx.root, 'project');
  timed(cwd); // warm the cache
  const base = [], runs = [];
  for (let i = 0; i < 10; i++) { base.push(baseline(cwd)); runs.push(timed(cwd).ms); }
  const over = median(runs) - median(base);
  const detail = `resolver median ${median(runs).toFixed(1)} ms, bare node ${median(base).toFixed(1)} ms (runs: ${fmt(runs)})`;
  assert.ok(over < LIMITS.cachedOverheadMs, `overhead ${over.toFixed(1)} ms; ${detail}`);
  assert.ok(Math.max(...runs) < LIMITS.cachedMaxMs, `max ${Math.max(...runs).toFixed(1)} ms; ${detail}`);
});

test(`cold: overhead < ${LIMITS.coldOverheadMs} ms and total < ${LIMITS.coldMs} ms (median of 5, empty cache)`, () => {
  const base = [], runs = [];
  ['project', 'zero-config', 'hub', 'project', 'zero-config'].forEach((d, i) => {
    const cwd = join(fx.root, d);
    base.push(baseline(cwd));
    runs.push(timed(cwd, [], baseEnv({ AI_TOOLKIT_HOME: join(fx.root, `cold-home-${i}`) })).ms);
  });
  const detail = `resolver median ${median(runs).toFixed(1)} ms, bare node ${median(base).toFixed(1)} ms (runs: ${fmt(runs)})`;
  assert.ok(median(runs) - median(base) < LIMITS.coldOverheadMs, `overhead ${(median(runs) - median(base)).toFixed(1)} ms; ${detail}`);
  assert.ok(median(runs) < LIMITS.coldMs, detail);
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

// The neighbor list is the one part that grows with the config, so the cap does too.
const outCap = (out) => LIMITS.outBytes + LIMITS.perNeighborBytes * (JSON.parse(out).neighbors?.length || 0);

test(`output: ≤ ${LIMITS.outBytes} B + ${LIMITS.perNeighborBytes} B per neighbor, ≤ ${LIMITS.fieldBytes} B with --field`, () => {
  // A hub the size of a real one: 10 registered repos with long names, and a project.json
  // overlay that adds a tracker, an env profile and a banner comment marker.
  const big = join(fx.root, 'big-hub');
  makeRepo(big, { remote: 'git@github-work:some-org/a-fairly-long-hub-repository-name.git' });
  const names = Array.from({ length: 10 }, (_, i) => `registered-repository-name-${i}`);
  write(join(big, '.claude/repos.json'), { version: 2, repos: names.map((n) => ({ name: n, localPath: `../${n}`,
    remote: { org: 'some-org', repo: n, ghHost: 'github.com', sshAlias: 'github-work' }, primaryBranch: 'master', commands: {} })) });
  write(join(big, '.ai-toolkit/project.json'), { version: 1, name: 'big-hub', workspace: '.claude/repos.json',
    pr: { commentMarker: { mode: 'banner', text: 'cc-autoreply', banner: { reply: 'x'.repeat(200), review: 'y'.repeat(200) } } },
    adapters: { tracker: 'toolkit-tracker-jira', envProfile: 'eg-corporate' } });
  for (const [d, args] of [['project', []], ['zero-config', []], ['hub', []], ['hub', ['--repo', 'project']], ['project/.worktrees/feat/x', []], ['big-hub', []]]) {
    const { out } = timed(join(fx.root, d), ['--no-cache', ...args]);
    if (d === 'big-hub') assert.equal(JSON.parse(out).neighbors.length, 10);
    assert.ok(Buffer.byteLength(out) <= outCap(out), `${d}: ${Buffer.byteLength(out)} B > ${outCap(out)} B`);
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
