// The review guide: prep writes the exact patch and a brief that names every changed file; import
// refuses a guide that misses, doubles or invents a file, and passes --pr through to plannotator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { patchFiles, checkCoverage, prep, importGuide } from './guide.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[k];
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[k];
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: ENV }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
const BRIEF = () => ({ methodology: '# Guided Review Organizer', output_schema: { type: 'object' }, rules: ['Every file once.'] });
const guide = (sections, unplacedFiles = []) => ({ title: 'T', intent: 'Why.', sections, unplacedFiles });
const sec = (...files) => ({ title: 's', overview: 'o.', diffs: files.map((file) => ({ file, summary: 'x' })) });

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-guide-')));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.md'), 'a\n'); writeFileSync(join(dir, 'gone.md'), 'g\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  git(dir, 'switch', '-q', '-c', 'lesson/x');
  writeFileSync(join(dir, 'a.md'), 'a2\n'); writeFileSync(join(dir, 'new file.md'), 'n\n'); git(dir, 'rm', '-q', 'gone.md');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'the lesson');
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('patchFiles names each changed path once, a deletion included', () => {
  const r = repo();
  try { assert.deepEqual(patchFiles(git(r.dir, 'diff', 'main')).sort(), ['a.md', 'gone.md', 'new file.md']); } finally { r.done(); }
});

test('coverage: every patch file in exactly one place, nothing invented, no em-dashes', () => {
  const files = ['a.md', 'b.md'];
  assert.deepEqual(checkCoverage(guide([sec('a.md')], ['b.md']), files), []);
  assert.match(checkCoverage(guide([sec('a.md')]), files).join(), /b\.md is missing/);
  assert.match(checkCoverage(guide([sec('a.md', 'b.md'), sec('a.md')]), files).join(), /a\.md is in section 1 and section 2/);
  assert.match(checkCoverage(guide([sec('a.md', 'b.md', 'c.md')]), files).join(), /c\.md is not in the patch/);
  assert.match(checkCoverage({ ...guide([sec('a.md', 'b.md')]), intent: 'Why — because.' }, files).join(), /em-dashes/);
  assert.match(checkCoverage({ ...guide([sec('a.md', 'b.md')]), intent: 'Why -- because.' }, files).join(), /em-dashes/);
  assert.deepEqual(checkCoverage({ ...guide([sec('a.md', 'b.md')]), intent: 'Run `lessons.mjs candidate --now` to launch.' }, files), [], 'a CLI flag is not a dash');
  assert.match(checkCoverage({ title: 'T', intent: 'I', sections: [sec('a.md', 'b.md')] }, files).join(), /unplacedFiles must be an array/);
});

test('prep writes the merge-base patch, a brief naming every file, and the review command for each target', () => {
  const r = repo();
  try {
    const out = join(r.dir, '.out');
    const local = prep({ worktree: r.dir, base: 'main', out, briefFn: BRIEF });
    assert.equal(readFileSync(local.patch, 'utf8'), git(r.dir, 'diff', 'main') + '\n');
    const p = readFileSync(local.prompt, 'utf8');
    assert.match(p, /^# Guided Review Organizer/);
    for (const f of ['a.md', 'gone.md', 'new file.md']) assert.ok(p.includes(`  - ${f}`), f);
    assert.match(p, /the lesson/);
    assert.ok(p.includes(local.guide));
    assert.equal(local.review, `plannotator review ${r.dir} --base main --diff-type merge-base --gate --json`);
    const onPr = prep({ worktree: r.dir, base: 'main', out, pr: 'https://github.com/o/r/pull/7', briefFn: BRIEF });
    assert.equal(onPr.review, 'plannotator review https://github.com/o/r/pull/7 --gate --json', 'on a PR the gate reviews the PR, so comments stay there');
    assert.match(readFileSync(onPr.prompt, 'utf8'), /PR: https:\/\/github\.com\/o\/r\/pull\/7/);
    git(r.dir, 'switch', '-q', 'main');
    assert.throws(() => prep({ worktree: r.dir, base: 'main', out, briefFn: BRIEF }), { code: 'empty-diff' });
  } finally { r.done(); }
});

test('import refuses a guide that misses a file, records the model, and passes --pr to plannotator', () => {
  const r = repo();
  try {
    const p = prep({ worktree: r.dir, base: 'main', out: join(r.dir, '.out'), briefFn: BRIEF });
    const calls = [];
    const run = (cmd, args, opts) => { calls.push([cmd, args, opts.cwd]); return { status: 0, stdout: 'saved g_1\n' }; };
    writeFileSync(p.guide, JSON.stringify(guide([sec('a.md')])));
    assert.throws(() => importGuide({ worktree: r.dir, guide: p.guide, patch: p.patch, run }), (e) => e.code === 'bad-guide' && /gone\.md is missing/.test(e.message));
    assert.equal(calls.length, 0, 'nothing reaches plannotator');
    writeFileSync(p.guide, JSON.stringify(guide([sec('a.md', 'new file.md')], ['gone.md'])));
    const res = importGuide({ worktree: r.dir, guide: p.guide, patch: p.patch, pr: 'https://github.com/o/r/pull/7', model: 'sonnet', run });
    assert.equal(res.output, 'saved g_1');
    assert.deepEqual(calls[0], ['plannotator', ['guide', 'import', '--guide', p.guide, '--patch', p.patch, '--pr', 'https://github.com/o/r/pull/7'], r.dir]);
    assert.deepEqual(JSON.parse(readFileSync(p.guide, 'utf8')).generator, { engine: 'claude-code', model: 'sonnet' });
    importGuide({ worktree: r.dir, guide: p.guide, patch: p.patch, run });
    assert.ok(!calls[1][1].includes('--pr'), 'local: no --pr');
  } finally { r.done(); }
});
