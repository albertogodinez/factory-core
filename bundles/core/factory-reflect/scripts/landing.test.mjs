// Lesson branches: start cuts a worktree without touching the main checkout, land fast-forwards
// only what was reviewed, open lists what waits, classify routes internal data away from core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start, open, land, classify, checkPatterns } from './landing.mjs';

const LESSONS = join(dirname(fileURLToPath(import.meta.url)), 'lessons.mjs');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[k];
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[k];

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-landing-')));
  const root = join(dir, 'src');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(root, 'skill.md'), 'one\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
  return { dir, root, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const commit = (cwd, file, text, msg) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', msg); return git(cwd, 'rev-parse', 'HEAD'); };

test('start --rolling keeps one lesson/triage branch: reused, brought up to trunk, sized against a cap', () => {
  const r = repo();
  try {
    const a = start({ repo: r.root, rolling: true, trunk: 'main' });
    assert.equal(a.branch, 'lesson/triage'); assert.equal(a.created, true); assert.equal(a.sync, 'new'); assert.equal(a.full, false);
    commit(a.worktree, 'lesson1.md', 'one\n', 'lesson 1');
    commit(r.root, 'trunk.md', 'moved\n', 'trunk moves');
    const b = start({ repo: r.root, rolling: true, trunk: 'main', date: '2030-01-01' });
    assert.equal(b.branch, 'lesson/triage', 'the date plays no part'); assert.equal(b.reused, true); assert.equal(b.sync, 'rebased', 'never pushed: rebased onto trunk');
    assert.equal(b.commits, 1); assert.ok(git(b.worktree, 'log', '--format=%s', 'main..HEAD').includes('lesson 1'));
    assert.equal(start({ repo: r.root, rolling: true, trunk: 'main' }).sync, 'current');
    // a dated branch from an older run is named, not touched
    start({ repo: r.root, slug: 'old', date: '2026-11-10', trunk: 'main' });
    assert.deepEqual(start({ repo: r.root, rolling: true, trunk: 'main' }).older, ['lesson/2026-11-10-old']);
    // the cap: five commits is full
    for (let i = 2; i <= 5; i++) commit(a.worktree, `lesson${i}.md`, `${i}\n`, `lesson ${i}`);
    const full = start({ repo: r.root, rolling: true, trunk: 'main' });
    assert.equal(full.commits, 5); assert.equal(full.full, true);
    // uncommitted edits in the worktree are left alone
    commit(r.root, 'trunk2.md', 'again\n', 'trunk moves again');
    writeFileSync(join(a.worktree, 'lesson1.md'), 'edited\n');
    assert.equal(start({ repo: r.root, rolling: true, trunk: 'main' }).sync, 'dirty');
  } finally { r.done(); }
});

test('start --rolling merges trunk into a pushed branch instead of rewriting it, and backs out of a conflict', () => {
  const r = repo();
  try {
    const remote = join(r.dir, 'remote.git'); git(r.dir, 'init', '-q', '--bare', remote);
    git(r.root, 'remote', 'add', 'origin', remote);
    const a = start({ repo: r.root, rolling: true, trunk: 'main' });
    commit(a.worktree, 'lesson1.md', 'one\n', 'lesson 1');
    git(a.worktree, 'push', '-q', '-u', 'origin', 'lesson/triage');
    const before = git(a.worktree, 'rev-parse', 'HEAD');
    commit(r.root, 'trunk.md', 'moved\n', 'trunk moves');
    const m = start({ repo: r.root, rolling: true, trunk: 'main' });
    assert.equal(m.sync, 'merged'); assert.equal(git(a.worktree, 'merge-base', '--is-ancestor', before, 'HEAD') === '', true, 'the pushed commit is still an ancestor: nothing rewritten');
    // a conflicting edit on both sides
    commit(a.worktree, 'skill.md', 'branch side\n', 'branch edit');
    commit(r.root, 'skill.md', 'trunk side\n', 'trunk edit');
    const head = git(a.worktree, 'rev-parse', 'HEAD');
    const c = start({ repo: r.root, rolling: true, trunk: 'main' });
    assert.equal(c.sync, 'conflict'); assert.equal(git(a.worktree, 'rev-parse', 'HEAD'), head, 'left as it was');
    assert.equal(git(a.worktree, 'status', '--porcelain'), '', 'no half-finished merge');
  } finally { r.done(); }
});

test('start cuts a lesson worktree from trunk and leaves the main checkout on its branch', () => {
  const r = repo();
  try {
    git(r.root, 'switch', '-q', '-c', 'other-work');
    const home = join(r.dir, 'home');
    const s = start({ repo: r.root, slug: 'Feature map: source rule', date: '2026-11-10', trunk: 'main', home });
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'lesson-branches.jsonl'), 'utf8').trim()).branch, s.branch, 'registered for the status hook');
    assert.equal(s.branch, 'lesson/2026-11-10-feature-map-source-rule');
    assert.equal(s.worktree, join(r.root, '.worktrees', 'lesson', '2026-11-10-feature-map-source-rule'));
    assert.equal(s.created, true);
    assert.equal(s.ignored, true);
    assert.equal(git(r.root, 'branch', '--show-current'), 'other-work', 'main checkout untouched');
    assert.equal(git(s.worktree, 'branch', '--show-current'), s.branch);
    const again = start({ repo: s.worktree, slug: 'feature map source rule', date: '2026-11-10', trunk: 'main' });
    assert.equal(again.created, false, 'a second start reuses the worktree');
    assert.equal(again.worktree, s.worktree);
  } finally { r.done(); }
});

test('land fast-forwards the reviewed head, removes the worktree and branch, and lists the push', () => {
  const r = repo();
  try {
    const s = start({ repo: r.root, slug: 'a', date: '2026-11-10', trunk: 'main' });
    commit(s.worktree, 'skill.md', 'two\n', 'lesson one');
    const head = commit(s.worktree, 'rule.md', 'r\n', 'lesson two');
    const listed = open({ repos: [r.root] });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].commits.map((c) => c.replace(/^\S+ /, '')), ['lesson two', 'lesson one']);
    assert.equal(listed[0].worktree, s.worktree);
    const out = land({ repo: r.root, branch: s.branch, reviewed: head, trunk: 'main', cwd: r.root });
    assert.equal(out.to, head);
    assert.equal(git(r.root, 'rev-parse', 'main'), head);
    assert.ok(!existsSync(s.worktree));
    assert.equal(git(r.root, 'branch', '--list', 'lesson/*'), '');
    assert.deepEqual(out.next, [`git -C ${r.root} push origin main`], 'the land ends at its own push; consumers pull');
    assert.deepEqual(open({ repos: [r.root] }), []);
  } finally { r.done(); }
});

test('land refuses a branch that changed after review, and one whose trunk moved', () => {
  const r = repo();
  try {
    const s = start({ repo: r.root, slug: 'b', date: '2026-11-10', trunk: 'main' });
    const reviewed = commit(s.worktree, 'skill.md', 'two\n', 'lesson');
    commit(s.worktree, 'extra.md', 'x\n', 'sneaked in after review');
    assert.throws(() => land({ repo: r.root, branch: s.branch, reviewed, trunk: 'main', cwd: r.root }), { code: 'changed-since-review' });
    git(s.worktree, 'reset', '-q', '--hard', reviewed);
    commit(r.root, 'other.md', 'o\n', 'trunk moved');
    assert.throws(() => land({ repo: r.root, branch: s.branch, reviewed, trunk: 'main', cwd: r.root }), { code: 'trunk-moved' });
    // A clean rebase keeps the reviewed change, so it lands without a second review.
    git(s.worktree, 'rebase', '-q', 'main');
    const out = land({ repo: r.root, branch: s.branch, reviewed, trunk: 'main', cwd: r.root });
    assert.notEqual(out.to, reviewed);
    assert.equal(git(r.root, 'show', 'main:skill.md'), 'two');
  } finally { r.done(); }
});

test('land moves trunk by ref when no worktree has it checked out', () => {
  const r = repo();
  try {
    git(r.root, 'switch', '-q', '-c', 'busy');
    writeFileSync(join(r.root, 'wip.txt'), 'uncommitted\n');
    const s = start({ repo: r.root, slug: 'c', date: '2026-11-10', trunk: 'main' });
    const head = commit(s.worktree, 'skill.md', 'three\n', 'lesson');
    land({ repo: r.root, branch: s.branch, reviewed: head, trunk: 'main', cwd: r.root });
    assert.equal(git(r.root, 'rev-parse', 'main'), head);
    assert.equal(git(r.root, 'branch', '--show-current'), 'busy', 'the busy checkout keeps its branch and its edits');
    assert.ok(existsSync(join(r.root, 'wip.txt')));
  } finally { r.done(); }
});

test('the CLI reports a refusal as JSON with exit 1', () => {
  const r = repo();
  try {
    const s = start({ repo: r.root, slug: 'd', date: '2026-11-10', trunk: 'main' });
    const reviewed = commit(s.worktree, 'skill.md', 'x\n', 'l');
    writeFileSync(join(s.worktree, 'dirty.md'), 'd\n');
    const p = spawnSync(process.execPath, [LESSONS, 'land', '--repo', r.root, '--branch', s.branch, '--reviewed', reviewed, '--trunk', 'main'], { cwd: r.root, encoding: 'utf8', env: ENV });
    assert.equal(p.status, 1, p.stderr);
    assert.equal(JSON.parse(p.stdout).error, 'uncommitted');
  } finally { r.done(); }
});

test('land refuses outside its home repo and names the session to start', () => {
  const r = repo(), other = repo();
  try {
    const s = start({ repo: r.root, slug: 'e', date: '2026-11-10', trunk: 'main' });
    const head = commit(s.worktree, 'skill.md', 'e\n', 'lesson');
    for (const cwd of [other.root, other.dir]) {
      assert.throws(() => land({ repo: r.root, branch: s.branch, reviewed: head, trunk: 'main', cwd }),
        (e) => e.code === 'wrong-session' && e.fix.includes(`cd ${r.root} && `) && e.fix.includes(`--branch ${s.branch}`));
    }
    assert.notEqual(git(r.root, 'rev-parse', 'main'), head, 'nothing landed');
    const p = spawnSync(process.execPath, [LESSONS, 'land', '--repo', r.root, '--branch', s.branch, '--reviewed', head, '--trunk', 'main'], { cwd: other.root, encoding: 'utf8', env: ENV });
    assert.equal(p.status, 1, p.stderr);
    assert.equal(JSON.parse(p.stdout).error, 'wrong-session');
    // From the lesson worktree itself, the session is in the source repo.
    land({ repo: r.root, branch: s.branch, reviewed: head, trunk: 'main', cwd: s.worktree });
  } finally { r.done(); other.done(); }
});

test('a source repo that installs into itself refreshes its own copies after the push, and nothing else', () => {
  const r = repo();
  try {
    mkdirSync(join(r.root, '.agents', 'factory-metadata'), { recursive: true });
    writeFileSync(join(r.root, '.agents', 'factory-metadata', 'skills-lock.json'), '{"skills":{}}\n');
    commit(r.root, '.gitignore', '.worktrees/\n', 'lock');
    const s = start({ repo: r.root, slug: 'f', date: '2026-11-10', trunk: 'main' });
    const head = commit(s.worktree, 'skill.md', 'f\n', 'lesson');
    const out = land({ repo: r.root, branch: s.branch, reviewed: head, trunk: 'main', cwd: r.root });
    assert.deepEqual(out.next, [`git -C ${r.root} push origin main`, `factory update --to ${r.root}`]);
  } finally { r.done(); }
});

test('classify sends text with internal data to org, and everything else to core', () => {
  const r = repo();
  try {
    const skills = join(r.dir, 'skills');
    mkdirSync(join(skills, 'pack-a'), { recursive: true });
    writeFileSync(join(skills, 'pack-a', 'internal-data.json'), JSON.stringify({ patterns: [{ pattern: '\\bacme-internal\\b', flags: 'i', why: 'company host' }] }));
    assert.deepEqual(classify({ text: 'Run the checks before you land.', skillsDir: skills }).target, 'core');
    const hit = classify({ text: 'line one\nDeploy to ACME-internal first.', skillsDir: skills });
    assert.equal(hit.target, 'org');
    assert.deepEqual(hit.hits.map((h) => [h.line, h.source, h.why]), [[2, 'pack-a', 'company host']]);
    assert.match(checkPatterns({ patterns: [{ pattern: '(', why: 'x' }] }), /patterns\[0\]\.pattern/);
    assert.match(checkPatterns({ patterns: [{ pattern: 'x' }] }), /why/);
    assert.equal(checkPatterns({ patterns: [] }), null);
  } finally { r.done(); }
});
