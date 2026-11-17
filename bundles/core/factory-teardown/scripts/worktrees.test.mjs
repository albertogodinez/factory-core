import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inventory, retire, savePrStates } from './worktrees.mjs';
import { saveState, readState, listRuns, beginRun } from './lifecycle.mjs';
import { tempRoot, makeRepo, git, write } from '../../../../tests/fixtures/make.mjs';

const store = { saveState, readState, listRuns };
const LIFECYCLE = join(dirname(fileURLToPath(import.meta.url)), 'lifecycle.mjs');
const DAY = 24 * 3600000;

// A repo whose origin/main is its main branch, and one worktree per case.
function fixture() {
  const t = tempRoot('factory-worktrees-');
  const repo = realpathSync(makeRepo(join(t.root, 'repo'), { remote: 'https://example.invalid/r.git' }));
  const state = join(t.root, 'state');
  const add = (name, { commit = true, detach = false } = {}) => {
    const wt = join(t.root, 'wt', name);
    git(repo, 'worktree', 'add', '-q', ...(detach ? ['--detach', wt] : [wt, '-b', name]));
    if (commit) { write(join(wt, `${name}.txt`), name); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', name); }
    return realpathSync(wt);
  };
  const prs = list => { const f = join(t.root, 'prs.json'); write(f, list); return savePrStates({ stateRoot: state, store, file: f }); };
  const inv = (o = {}) => inventory({ root: repo, stateRoot: state, store, current: repo, ...o });
  const of = (r, path) => r.worktrees.find(w => w.path === path);
  return { ...t, repo, state, add, prs, inv, of };
}

test('a merged or closed PR, a deleted remote branch, or an idle empty branch is finished; an open PR or new work is not', () => {
  const f = fixture(); try {
    const merged = f.add('merged'), closed = f.add('closed'), open = f.add('open'), unknown = f.add('unknown');
    const empty = f.add('empty', { commit: false }), gone = f.add('gone');
    git(f.repo, 'config', 'branch.gone.remote', 'origin'); git(f.repo, 'config', 'branch.gone.merge', 'refs/heads/gone');
    f.prs([{ headRefName: 'merged', state: 'MERGED', number: 2 }, { headRefName: 'closed', state: 'CLOSED', number: 3 },
      { headRefName: 'open', state: 'CLOSED', number: 4 }, { headRefName: 'open', state: 'OPEN', number: 5 }]);
    const now = f.inv();
    assert.equal(now.base, 'origin/main');
    assert.deepEqual([f.of(now, merged).status, f.of(now, merged).reason], ['candidate', 'PR #2 merged']);
    assert.equal(f.of(now, closed).reason, 'PR #3 closed without merging');
    assert.deepEqual([f.of(now, open).status, f.of(now, open).reason], ['kept', 'PR #5 open'], 'an open PR wins over an older closed one');
    assert.equal(f.of(now, gone).reason, 'remote branch deleted');
    assert.equal(f.of(now, unknown).status, 'kept');
    assert.match(f.of(now, empty).reason, /may be new work/);
    assert.equal(f.of(f.inv({ now: Date.now() + 8 * DAY }), empty).status, 'candidate', 'idle past the limit');
    assert.ok(!now.worktrees.some(w => w.path === f.repo), 'the main checkout is never listed');
  } finally { f.cleanup(); }
});

test('uncommitted work, a copied skill, a live run, a lock, the current worktree or a stray detached commit keeps a finished worktree', async () => {
  const f = fixture(); try {
    const names = ['dirty', 'untracked', 'copy', 'linked', 'owned', 'locked', 'current'];
    const wt = Object.fromEntries(names.map(n => [n, f.add(n)]));
    const detached = f.add('detached', { commit: false, detach: true });
    write(join(detached, 'x.txt'), 'x'); git(detached, 'add', '-A'); git(detached, 'commit', '-qm', 'stray');
    f.prs(names.map((n, i) => ({ headRefName: n, state: 'MERGED', number: i + 1 })));
    write(join(wt.dirty, 'dirty.txt'), 'changed');
    write(join(wt.untracked, 'notes.md'), 'mine');
    mkdirSync(join(wt.copy, '.agents', 'skills', 'x'), { recursive: true }); writeFileSync(join(wt.copy, '.agents', 'skills', 'x', 'SKILL.md'), 'edited copy');
    mkdirSync(join(wt.linked, '.agents', 'skills'), { recursive: true }); mkdirSync(join(wt.linked, '.claude'));
    symlinkSync(f.repo, join(wt.linked, '.agents', 'skills', 'x')); symlinkSync('../.agents/skills', join(wt.linked, '.claude', 'skills'));
    await beginRun({ stateRoot: f.state, root: wt.owned, kind: 'test', ownerPid: process.pid });
    git(f.repo, 'worktree', 'lock', wt.locked);
    const r = f.inv({ current: wt.current });
    for (const n of ['dirty', 'untracked', 'copy']) assert.match(f.of(r, wt[n]).reason, /uncommitted changes/, n);
    assert.match(f.of(r, wt.owned).reason, /teardown run .* owns resources/);
    assert.equal(f.of(r, wt.locked).reason, 'locked');
    assert.equal(f.of(r, wt.current).reason, 'current worktree');
    assert.match(f.of(r, detached).reason, /detached HEAD with commits on no branch/);
    const linked = f.of(r, wt.linked);
    assert.equal(linked.status, 'candidate', 'factory links are not user work');
    assert.deepEqual(linked.links.sort(), ['.agents/skills/x', '.claude/skills']);
  } finally { f.cleanup(); }
});

test('retire previews by default, removes a candidate through git and keeps its branch, and refuses anything kept', () => {
  const f = fixture(); try {
    const done = f.add('done'), wip = f.add('wip');
    mkdirSync(join(done, '.agents', 'skills'), { recursive: true }); symlinkSync(f.repo, join(done, '.agents', 'skills', 'x'));
    mkdirSync(join(done, 'node_modules')); write(join(done, '.gitignore'), 'node_modules\n'); git(done, 'add', '.gitignore'); git(done, 'commit', '-qm', 'ignore');
    write(join(done, 'node_modules', 'big.js'), 'x');
    f.prs([{ headRefName: 'done', state: 'MERGED', number: 1 }, { headRefName: 'wip', state: 'OPEN', number: 2 }]);
    const o = { root: f.repo, stateRoot: f.state, store, current: f.repo };
    assert.equal(retire({ ...o, worktree: done }).status, 'candidate');
    assert.ok(existsSync(done), 'preview removes nothing');
    assert.equal(retire({ ...o, worktree: done, apply: true }).status, 'removed');
    assert.ok(!existsSync(done), 'ignored files go with the worktree');
    assert.ok(git(f.repo, 'branch', '--list', 'done'), 'the branch is kept');
    assert.equal(retire({ ...o, worktree: wip, apply: true }).status, 'kept');
    assert.ok(existsSync(wip));
    assert.throws(() => retire({ ...o, worktree: f.repo, apply: true }), /not a linked worktree/);
    const cli = spawnSync(process.execPath, [LIFECYCLE, 'retire', '--state-root', f.state, '--cwd', f.repo, '--worktree', wip, '--apply'], { cwd: f.repo, encoding: 'utf8' });
    assert.equal(cli.status, 1, 'the CLI fails when it was asked to remove and did not');
    assert.equal(JSON.parse(cli.stdout).reason, 'PR #2 open');
  } finally { f.cleanup(); }
});

test('PR states must be gh pr list JSON; the CLI saves them and reports when they were taken', () => {
  const f = fixture(); try {
    const bad = join(f.root, 'bad.json'); write(bad, { headRefName: 'x' });
    assert.throws(() => savePrStates({ stateRoot: f.state, store, file: bad }), /gh pr list/);
    const good = join(f.root, 'good.json'); write(good, [{ headRefName: 'a', state: 'MERGED', number: 1, title: 'dropped' }]);
    const cli = spawnSync(process.execPath, [LIFECYCLE, 'worktrees', '--state-root', f.state, '--cwd', f.repo, '--pr-states', good], { cwd: f.repo, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(JSON.parse(cli.stdout).prStatesCheckedAt > 0);
    assert.deepEqual(readState(f.state, 'pr-states.json').prs, [{ headRefName: 'a', state: 'MERGED', number: 1 }]);
  } finally { f.cleanup(); }
});
