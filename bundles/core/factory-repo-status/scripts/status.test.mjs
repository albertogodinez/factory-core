import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixtures, makeRepo, write, git } from '../../../../tests/fixtures/make.mjs';
import { parseWorktrees } from './status.mjs';

const STATUS = join(dirname(fileURLToPath(import.meta.url)), 'status.mjs');
const run = (f, cwd, ...args) => {
  const r = spawnSync(process.execPath, [STATUS, '--json', '--cwd', cwd, ...args], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: f.home, HOME: f.home } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
function commit(dir, file, msg) { write(join(dir, file), msg); git(dir, 'add', file); git(dir, 'commit', '-qm', msg); }

test('project mode: the project, then its neighbors; behind count, worktrees, branch classes', () => {
  const f = makeFixtures();
  try {
    const p = join(f.root, 'project');
    git(p, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // origin/main moves ahead by one commit
    commit(p, 'a.txt', 'one'); git(p, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); git(p, 'reset', '-q', '--hard', 'HEAD~1');
    // an unmerged branch stays out of the review list
    git(p, 'checkout', '-q', '-b', 'wip'); commit(p, 'w.txt', 'wip'); git(p, 'checkout', '-q', 'main');
    const out = run(f, p);
    assert.equal(out.mode, 'project');
    assert.deepEqual(out.repos.map((r) => r.name), ['project', 'lib']);
    const proj = out.repos[0];
    assert.equal(proj.behind, 1);
    assert.equal(proj.status, 'behind');
    assert.deepEqual(proj.branches.map((b) => [b.branch, b.status]).sort(), [['feat/x', 'merged']]); // feat/x has nothing trunk lacks
    assert.equal(proj.worktrees.length, 1);
    assert.equal(proj.worktrees[0].path, '.worktrees/feat/x');
    assert.equal(proj.worktrees[0].status, 'merged'); // its tip is already on trunk
    assert.equal(out.repos[1].trunk, 'develop');
    assert.equal(run(f, p, '--no-neighbors').repos.length, 1);
  } finally { f.cleanup(); }
});

test('workspace mode: every registered repo is a neighbor of the hub', () => {
  const f = makeFixtures();
  try {
    const out = run(f, join(f.root, 'hub'));
    assert.equal(out.mode, 'workspace');
    assert.deepEqual(out.repos.map((r) => r.name).sort(), ['hub', 'lib', 'project']);
  } finally { f.cleanup(); }
});

test('a missing neighbor is reported, not fatal', () => {
  const f = makeFixtures();
  try {
    write(join(f.root, 'project/.agents/factory-metadata/project.json'), { version: 1, neighbors: [{ name: 'lib' }, { name: 'nowhere' }] });
    const out = run(f, join(f.root, 'project'));
    assert.equal(out.repos.find((r) => r.name === 'nowhere').status, 'missing');
  } finally { f.cleanup(); }
});

test('parseWorktrees reads the porcelain format', () => {
  const w = parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.worktrees/x\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(w.map((x) => [x.path, x.branch, x.prunable]), [['/r', 'main', false], ['/r/.worktrees/x', null, true]]);
});
