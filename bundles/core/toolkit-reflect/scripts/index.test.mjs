// The promotion index: the 3rd occurrence across repos prompts; never, not-now, expiry and
// the per-session cap hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, summarize, promptText, normalizeFingerprint } from './lessons.mjs';

const LESSONS = join(dirname(fileURLToPath(import.meta.url)), 'lessons.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-06-01T00:00:00Z');

function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-lessons-')));
  const env = { AI_TOOLKIT_HOME: join(dir, 'home') };
  const rec = (project, fp, at, scope = 'core') => run('record', {
    scope, fingerprint: fp, summary: `summary of ${fp}`, project, root: join(dir, project), 'state-root': join(dir, project, '.ai-toolkit', 'state', 'main'),
  }, env, at);
  return { dir, env, rec, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the 3rd occurrence across 2 repos makes a fingerprint due, with the prompt text', () => {
  const s = sandbox();
  try {
    assert.equal(s.rec('repo-a', 'browser-reauth-after-restart', T0).due, false);
    assert.equal(s.rec('repo-b', 'browser-reauth-after-restart', T0 + DAY).due, false);
    const third = s.rec('repo-a', 'Browser reauth after restart', T0 + 2 * DAY);
    assert.equal(third.due, true);
    assert.equal(third.occurrences, 3);
    assert.deepEqual(third.projects, ['repo-a', 'repo-b']);
    const due = run('due', { session: 's1' }, s.env, T0 + 2 * DAY);
    assert.equal(due.due.length, 1);
    assert.equal(due.due[0].prompt, 'We\'ve seen "summary of Browser reauth after restart" 3 times across 2 repos (repo-a, repo-b). Promote it to core? [promote / not now / never]');
    // The local log got every lesson; repo scope never reaches the index.
    s.rec('repo-a', 'repo-only-thing', T0, 'repo');
    const local = readFileSync(join(s.dir, 'repo-a', '.ai-toolkit', 'state', 'main', 'lessons.jsonl'), 'utf8').trim().split('\n');
    assert.equal(local.length, 3);
    assert.ok(!readFileSync(join(s.env.AI_TOOLKIT_HOME, 'lessons-index.jsonl'), 'utf8').includes('repo-only-thing'));
  } finally { s.done(); }
});

test('never is remembered; not now waits for a new occurrence; promote stops prompting', () => {
  const s = sandbox();
  try {
    for (const fp of ['a-lesson', 'b-lesson', 'c-lesson']) for (let i = 0; i < 3; i++) s.rec(`r${i % 2}`, fp, T0 + i * DAY);
    run('decide', { fingerprint: 'a-lesson', decision: 'never', session: 'x' }, s.env, T0 + 3 * DAY);
    run('decide', { fingerprint: 'b-lesson', decision: 'not-now', session: 'x' }, s.env, T0 + 3 * DAY);
    run('decide', { fingerprint: 'c-lesson', decision: 'promote', session: 'x' }, s.env, T0 + 3 * DAY);
    assert.deepEqual(run('due', { session: 'y' }, s.env, T0 + 4 * DAY).due, []);
    s.rec('r0', 'a-lesson', T0 + 5 * DAY);
    s.rec('r0', 'b-lesson', T0 + 5 * DAY);
    assert.deepEqual(run('due', { session: 'y' }, s.env, T0 + 5 * DAY).due.map((d) => d.fingerprint), ['b-lesson']);
    const known = run('known', {}, s.env, T0 + 5 * DAY);
    assert.equal(known.find((k) => k.fingerprint === 'a-lesson').reason, 'never');
  } finally { s.done(); }
});

test('occurrences older than 90 days expire', () => {
  const s = sandbox();
  try {
    s.rec('r0', 'old', T0); s.rec('r1', 'old', T0 + DAY);
    const third = s.rec('r0', 'old', T0 + 95 * DAY);
    assert.equal(third.due, false);
    assert.equal(third.occurrences, 1);
    const later = summarize([{ ts: new Date(T0).toISOString(), fingerprint: 'z', project: 'p' }], {}, T0 + 91 * DAY)[0];
    assert.equal(later.reason, 'expired');
  } finally { s.done(); }
});

test('at most 3 prompts per session', () => {
  const s = sandbox();
  try {
    for (const fp of ['l1', 'l2', 'l3', 'l4', 'l5']) for (let i = 0; i < 3; i++) s.rec(`r${i}`, fp, T0 + i);
    assert.equal(run('due', { session: 'S' }, s.env, T0 + 10).due.length, 3);
    run('decide', { fingerprint: 'l1', decision: 'not-now', session: 'S' }, s.env, T0 + 11);
    run('decide', { fingerprint: 'l2', decision: 'not-now', session: 'S' }, s.env, T0 + 12);
    const left = run('due', { session: 'S' }, s.env, T0 + 13);
    assert.equal(left.promptsLeft, 1);
    assert.equal(left.due.length, 1);
    assert.equal(run('due', { session: 'other' }, s.env, T0 + 13).due.length, 3);
  } finally { s.done(); }
});

test('fingerprints normalize, and the CLI refuses bad input', () => {
  assert.equal(normalizeFingerprint('  Dev-Slot: re-auth  the browser!! '), 'dev-slot-re-auth-the-browser');
  const r = spawnSync(process.execPath, [LESSONS, 'record', '--scope', 'galaxy', '--fingerprint', 'x', '--summary', 'y'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--scope must be repo, core or org/);
  assert.match(promptText({ summary: 's', occurrences: 4, projects: ['only'], scope: 'org' }), /4 times across 1 repo \(only\)\. Promote it to org\?/);
  assert.ok(existsSync(LESSONS));
});
