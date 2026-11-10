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
    const out = land({ repo: r.root, branch: s.branch, reviewed: head, trunk: 'main' });
    assert.equal(out.to, head);
    assert.equal(git(r.root, 'rev-parse', 'main'), head);
    assert.ok(!existsSync(s.worktree));
    assert.equal(git(r.root, 'branch', '--list', 'lesson/*'), '');
    assert.deepEqual(out.next, [`git -C ${r.root} push origin main`, 'factory update --all']);
    assert.deepEqual(open({ repos: [r.root] }), []);
  } finally { r.done(); }
});

test('land refuses a branch that changed after review, and one whose trunk moved', () => {
  const r = repo();
  try {
    const s = start({ repo: r.root, slug: 'b', date: '2026-11-10', trunk: 'main' });
    const reviewed = commit(s.worktree, 'skill.md', 'two\n', 'lesson');
    commit(s.worktree, 'extra.md', 'x\n', 'sneaked in after review');
    assert.throws(() => land({ repo: r.root, branch: s.branch, reviewed, trunk: 'main' }), { code: 'changed-since-review' });
    git(s.worktree, 'reset', '-q', '--hard', reviewed);
    commit(r.root, 'other.md', 'o\n', 'trunk moved');
    assert.throws(() => land({ repo: r.root, branch: s.branch, reviewed, trunk: 'main' }), { code: 'trunk-moved' });
    // A clean rebase keeps the reviewed change, so it lands without a second review.
    git(s.worktree, 'rebase', '-q', 'main');
    const out = land({ repo: r.root, branch: s.branch, reviewed, trunk: 'main' });
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
    land({ repo: r.root, branch: s.branch, reviewed: head, trunk: 'main' });
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
    const p = spawnSync(process.execPath, [LESSONS, 'land', '--repo', r.root, '--branch', s.branch, '--reviewed', reviewed, '--trunk', 'main'], { encoding: 'utf8', env: ENV });
    assert.equal(p.status, 1, p.stderr);
    assert.equal(JSON.parse(p.stdout).error, 'uncommitted');
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
