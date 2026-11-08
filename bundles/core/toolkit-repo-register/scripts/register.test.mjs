import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, tempRoot, write, git } from '../../../../tests/fixtures/make.mjs';

const REG = join(dirname(fileURLToPath(import.meta.url)), 'register.mjs');

function env(root) {
  mkdirSync(join(root, 'home/.ssh'), { recursive: true });
  write(join(root, 'home/.ssh/config'), 'Host work-gh\n  HostName github.corp.example\n');
  return { ...process.env, HOME: join(root, 'home'), AI_TOOLKIT_HOME: join(root, 'toolkit-home') };
}
const run = (root, cwd, ...args) => spawnSync(process.execPath, [REG, '--cwd', cwd, ...args], { encoding: 'utf8', env: env(root) });

test('dry run proposes only what detection does not already give', () => {
  const t = tempRoot();
  try {
    const app = makeRepo(join(t.root, 'app'), {
      remote: 'git@work-gh:acme/app.git', branch: 'main',
      files: { 'pnpm-lock.yaml': '', 'package.json': { scripts: { build: 'x', test: 'y', format: 'z' } }, '.github/PULL_REQUEST_TEMPLATE.md': '#' },
    });
    git(app, 'worktree', 'add', '-q', '.worktrees/feat/x', '-b', 'feat/x');
    const r = run(t.root, app, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(r.stdout);
    assert.equal(cfg.version, 1);
    assert.deepEqual(cfg.commands, { format: 'pnpm format', install: 'pnpm install' }); // build/test already detected
    assert.equal(cfg.worktreeConvention, 'dot-worktrees');
    for (const k of ['trunk', 'packageManager', 'prTemplate', 'remote']) assert.equal(k in cfg, false, k);
    assert.equal(existsSync(join(app, '.ai-toolkit/project.json')), false, 'dry run writes nothing');
  } finally { t.cleanup(); }
});

test('a fork with an upstream remote records the canonical slug', () => {
  const t = tempRoot();
  try {
    const app = makeRepo(join(t.root, 'app'), { remote: 'git@work-gh:me/app.git' });
    git(app, 'remote', 'add', 'upstream', 'git@work-gh:acme/app.git');
    const r = run(t.root, app, '--dry-run');
    const cfg = JSON.parse(r.stdout);
    assert.deepEqual(cfg.remote, { host: 'github.corp.example', slug: 'me/app', sshAlias: 'work-gh', upstream: 'acme/app' });
    assert.match(r.stderr, /fork/);
  } finally { t.cleanup(); }
});

test('--write validates, writes, and a second run has nothing to change', () => {
  const t = tempRoot();
  try {
    const app = makeRepo(join(t.root, 'app'), { remote: 'git@github.com:acme/app.git', files: { 'Makefile': 'test:\n\techo hi\n' } });
    makeRepo(join(t.root, 'lib'), { remote: 'git@github.com:acme/lib.git' });
    let r = run(t.root, app, '--write', '--neighbor', 'lib:write');
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(readFileSync(join(app, '.ai-toolkit/project.json'), 'utf8'));
    assert.deepEqual(cfg.neighbors, [{ name: 'lib', access: 'write' }]);
    assert.equal(cfg.commands.test, 'make test');
    r = run(t.root, app, '--dry-run', '--neighbor', 'lib:write');
    assert.match(r.stderr, /lib already listed/);
    assert.doesNotMatch(r.stderr, /add:|drift:/);
  } finally { t.cleanup(); }
});

test('existing values are kept and reported as drift until --refresh', () => {
  const t = tempRoot();
  try {
    const app = makeRepo(join(t.root, 'app'), { remote: 'git@github.com:acme/app.git', branch: 'main', files: { 'yarn.lock': '' , 'package.json': { scripts: {} } } });
    write(join(app, '.ai-toolkit/project.json'), { version: 1, packageManager: 'pnpm' });
    let r = run(t.root, app, '--write');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /drift: packageManager is "pnpm" in config; verified "yarn"/);
    assert.equal(JSON.parse(readFileSync(join(app, '.ai-toolkit/project.json'), 'utf8')).packageManager, 'pnpm');
    r = run(t.root, app, '--write', '--refresh');
    assert.equal(JSON.parse(readFileSync(join(app, '.ai-toolkit/project.json'), 'utf8')).packageManager, 'yarn');
  } finally { t.cleanup(); }
});

test('bad input exits 2', () => {
  const t = tempRoot();
  try {
    const app = makeRepo(join(t.root, 'app'), { remote: 'git@github.com:acme/app.git' });
    assert.equal(run(t.root, app, '--neighbor', 'missing').status, 2);
    assert.equal(run(t.root, app, '--neighbor', 'x:admin').status, 2);
    assert.equal(run(t.root, t.root, '--dry-run').status, 2); // not a repo
  } finally { t.cleanup(); }
});
