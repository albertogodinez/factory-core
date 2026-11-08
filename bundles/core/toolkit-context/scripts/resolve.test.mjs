// Unit tests for the resolver. Fixtures are built fresh in a temp directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, rmSync, renameSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtures, write, git } from '../../../../tests/fixtures/make.mjs';
import { parseRemote } from './resolve.mjs';
import { validate, loadSchema } from './validate.mjs';

const RESOLVE = join(dirname(fileURLToPath(import.meta.url)), 'resolve.mjs');
let fx;
before(() => { fx = makeFixtures(); });
after(() => fx.cleanup());

function run(cwd, args = [], env = {}) {
  const out = execFileSync(process.execPath, [RESOLVE, '--no-cache', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, AI_TOOLKIT_HOME: fx.home, AI_TOOLKIT_CONFIG: '', ...env },
  });
  return args.includes('--field') ? out.trim() : JSON.parse(out);
}

test('source 1: --config wins over a project.json', () => {
  const o = run(join(fx.root, 'project'), ['--config', join(fx.root, 'explicit.json')]);
  assert.equal(o.mode, 'project');
  assert.equal(o.source, join(fx.root, 'explicit.json'));
  assert.equal(o.project.name, 'explicit-name');
  assert.equal(o.project.trunk, 'release');
  assert.ok(o.stateRoot.startsWith(join(fx.home, 'cache')), 'explicit config keeps state out of the repo');
});

test('source 1: AI_TOOLKIT_CONFIG works like --config', () => {
  const o = run(join(fx.root, 'project'), [], { AI_TOOLKIT_CONFIG: join(fx.root, 'explicit.json') });
  assert.equal(o.project.name, 'explicit-name');
});

test('source 2: the nearest project.json, from a subdirectory', () => {
  const o = run(join(fx.root, 'project', '.github'));
  assert.equal(o.mode, 'project');
  assert.equal(o.source, '.ai-toolkit/project.json');
  assert.equal(o.project.name, 'project');
  assert.equal(o.project.root, join(fx.root, 'project'));
  assert.equal(o.project.trunk, 'main');
  assert.equal(o.project.packageManager, 'pnpm');
  assert.equal(o.project.prTemplate, '.github/PULL_REQUEST_TEMPLATE.md');
  assert.deepEqual(o.project.commands, { build: 'pnpm build', test: 'pnpm test', lint: 'pnpm lint' });
  assert.deepEqual(o.project.remote, { host: 'github.com', slug: 'acme/project' });
  assert.deepEqual(o.adapters, { commentMarker: { mode: 'off' } });
  assert.equal(o.stateRoot, join(fx.root, 'project', '.ai-toolkit', 'state', 'main'));
  assert.equal(o.writeAllowed, true);
});

test('neighbors: default sibling root is omitted, trunk read from the neighbor', () => {
  const o = run(join(fx.root, 'project'));
  assert.deepEqual(o.neighbors, [{ name: 'lib', trunk: 'develop' }]);
});

test('source 3 beats 4: workspace.json is used before a legacy repos.json', () => {
  const hub = join(fx.root, 'hub');
  write(join(hub, '.ai-toolkit/workspace.json'), { version: 2, repos: [] });
  try {
    const o = run(hub);
    assert.equal(o.mode, 'workspace');
    assert.equal(o.source, '.ai-toolkit/workspace.json');
  } finally { rmSync(join(hub, '.ai-toolkit'), { recursive: true }); }
});

test('source 4: legacy repos.json lists every registered repo as a neighbor', () => {
  const o = run(join(fx.root, 'hub'));
  assert.equal(o.mode, 'workspace');
  assert.equal(o.source, '.claude/repos.json');
  assert.equal(o.project.name, 'hub');
  assert.deepEqual(o.neighbors.map((n) => [n.name, n.trunk, n.access]), [['project', 'main', 'write'], ['lib', 'develop', 'write']]);
  assert.equal(o.stateRoot, join(fx.root, 'hub', 'tmp'));
});

test('source 4: --repo returns one registered repo with its personas', () => {
  const o = run(join(fx.root, 'hub'), ['--repo', 'project']);
  assert.equal(o.project.name, 'project');
  assert.equal(o.project.root, join(fx.root, 'project'));
  assert.deepEqual(o.project.commands, { build: 'pnpm build', test: 'pnpm test' });
  assert.deepEqual(o.adapters.personas, ['general']);
  assert.equal(o.neighbors, undefined);
});

test('source 5: zero-config with no origin/HEAD falls back to main and refuses writes', () => {
  const o = run(join(fx.root, 'zero-config'));
  assert.equal(o.mode, 'zero-config');
  assert.equal(o.source, undefined);
  assert.equal(o.project.trunk, 'main');
  assert.deepEqual(o.project.remote, { host: 'example.org', slug: 'me/zero-config' });
  assert.equal(o.writeAllowed, false);
  assert.match(o.stateRoot, new RegExp(`^${fx.home}/cache/zero-config-[0-9a-f]{8}/main$`));
});

test('zero-config on a detached HEAD with no trunk-named branch uses null trunk safely', () => {
  const d = join(fx.root, 'zero-config');
  git(d, 'checkout', '-q', '-b', 'only-branch');
  git(d, 'branch', '-q', '-D', 'main');
  try {
    assert.equal(run(d).project.trunk, 'only-branch');
    git(d, 'checkout', '-q', '--detach');
    assert.equal(run(d).project.trunk, undefined);
  } finally { git(d, 'checkout', '-q', '-b', 'main'); git(d, 'branch', '-q', '-D', 'only-branch'); }
});

test('a linked worktree resolves to its parent project, with its own stateRoot', () => {
  const wt = join(fx.root, 'project', '.worktrees', 'feat', 'x');
  const o = run(wt);
  assert.equal(o.mode, 'project');
  assert.equal(o.project.name, 'project');
  assert.equal(o.project.root, wt);
  assert.equal(o.stateRoot, join(fx.root, 'project', '.ai-toolkit', 'state', 'x'));
});

test('a sibling checkout resolves by remote against a workspace config', () => {
  const o = run(join(fx.root, 'clone'), ['--config', join(fx.root, 'hub/.claude/repos.json')]);
  assert.equal(o.mode, 'workspace');
  assert.equal(o.project.name, 'project');
  assert.equal(o.project.root, join(fx.root, 'clone'));
  assert.equal(o.project.trunk, 'main');
});

test('a registered repo resolves by git common dir from its own worktree', () => {
  const wt = join(fx.root, 'project', '.worktrees', 'feat', 'x');
  const o = run(wt, ['--config', join(fx.root, 'hub/.claude/repos.json')]);
  assert.equal(o.project.name, 'project');
  assert.equal(o.project.root, wt);
});

test('--field prints one value', () => {
  assert.equal(run(join(fx.root, 'project'), ['--field', 'project.trunk']), 'main');
  assert.equal(run(join(fx.root, 'project'), ['--field', 'writeAllowed']), 'true');
  assert.equal(run(join(fx.root, 'project'), ['--field', 'neighbors']), '[{"name":"lib","trunk":"develop"}]');
});

test('--field on a missing path exits 1 with no output', () => {
  assert.throws(() => run(join(fx.root, 'project'), ['--field', 'nope.nope']), (e) => e.status === 1 && e.stdout === '');
});

test('outside any git repo and config: a clear error, exit 2', () => {
  assert.throws(() => run(fx.home), (e) => e.status === 2 && /not inside a git repository/.test(e.stderr));
});

test('invalid project.json is reported, not ignored', () => {
  const p = join(fx.root, 'project/.ai-toolkit/project.json');
  const good = readFileSync(p, 'utf8');
  write(p, '{ not json');
  try { assert.throws(() => run(join(fx.root, 'project')), (e) => e.status === 2 && /invalid JSON/.test(e.stderr)); }
  finally { write(p, good); }
});

test('the cache is reused, and invalidated by a config change and by a HEAD change', () => {
  const d = join(fx.root, 'project');
  const env = { ...process.env, AI_TOOLKIT_HOME: fx.home, AI_TOOLKIT_CONFIG: '' };
  const call = () => execFileSync(process.execPath, [RESOLVE, '--field', 'project.trunk'], { cwd: d, encoding: 'utf8', env }).trim();
  const p = join(d, '.ai-toolkit/project.json');
  const good = readFileSync(p, 'utf8');
  assert.equal(call(), 'main');
  write(p, { ...JSON.parse(good), trunk: 'cached-check' });
  const later = new Date(Date.now() + 5000); utimesSync(p, later, later);
  try { assert.equal(call(), 'cached-check', 'a config edit invalidates the cache'); }
  finally { write(p, good); }
  assert.equal(call(), 'main');
  // HEAD change: a checkout in the worktree must not serve the main checkout's cache entry.
  const wt = join(d, '.worktrees', 'feat', 'x');
  const callWt = () => execFileSync(process.execPath, [RESOLVE, '--field', 'stateRoot'], { cwd: wt, encoding: 'utf8', env }).trim();
  assert.match(callWt(), /state\/x$/);
  git(wt, 'checkout', '-q', '-b', 'feat/y');
  try { assert.match(callWt(), /state\/x$/); } finally { git(wt, 'checkout', '-q', 'feat/x'); git(wt, 'branch', '-q', '-D', 'feat/y'); }
});

test('parseRemote normalizes ssh, scp-style, https and aliases', () => {
  assert.deepEqual(parseRemote('git@github.com:a/b.git'), { host: 'github.com', slug: 'a/b' });
  assert.deepEqual(parseRemote('https://user@GitHub.com/a/b'), { host: 'github.com', slug: 'a/b' });
  assert.deepEqual(parseRemote('ssh://git@host.example:2222/a/b.git'), { host: 'host.example', slug: 'a/b' });
  assert.equal(parseRemote('not a url'), null);
  assert.equal(parseRemote(null), null);
});

test('the shipped fixtures and an empty config pass the schema', () => {
  const schema = loadSchema();
  assert.deepEqual(validate(schema, JSON.parse(readFileSync(join(fx.root, 'project/.ai-toolkit/project.json'), 'utf8'))), []);
  assert.deepEqual(validate(schema, {}), []);
  assert.ok(validate(schema, { neighbors: [{ access: 'admin' }] }).length >= 2);
  assert.ok(validate(schema, { pr: { commentMarker: { mode: 'loud' } } }).length >= 1);
  assert.ok(validate(schema, { bogus: 1 }).some((e) => /unknown property "bogus"/.test(e)));
});

test('Windows: paths are built with node:path, never by joining strings with "/"', () => {
  const src = readFileSync(RESOLVE, 'utf8');
  // A remote slug ("owner/repo") is not a path, so lines that build one are skipped.
  const bad = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/slug|upstream/.test(l) && /\+\s*['"`]\/|['"`]\/['"`]\s*\+|`[^`]*\$\{[^}]+\}\/\$\{/.test(l));
  assert.deepEqual(bad, []);
});

test('--repo by slug: this project, a neighbor (read-only unless access is write), or an error', () => {
  const d = join(fx.root, 'project');
  assert.equal(run(d, ['--repo', 'acme/project', '--field', 'project.name']), 'project');
  const n = run(d, ['--repo', 'acme/lib']);
  assert.equal(n.project.name, 'lib');
  assert.equal(n.project.trunk, 'develop');
  assert.equal(n.writeAllowed, false, 'a read neighbor is not writable from the host');
  assert.equal(run(d, ['--repo', 'lib', '--field', 'project.remote.host']), 'github.com');
  assert.throws(() => run(d, ['--repo', 'acme/other']), (e) => e.status === 2 && /not this project/.test(e.stderr));
  assert.equal(run(join(fx.root, 'hub'), ['--repo', 'acme/lib', '--field', 'project.name']), 'lib');
});
