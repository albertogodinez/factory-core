// The lesson index: every core and org lesson is recorded across repos, entries expire, and never
// is remembered. Nothing counts to a threshold any more; triage clusters the candidate queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lessons from './lessons.mjs';

const { run, summarize, normalizeFingerprint } = lessons;
const LESSONS = join(dirname(fileURLToPath(import.meta.url)), 'lessons.mjs');
const DAY = 86400000;
const T0 = Date.parse('2026-06-01T00:00:00Z');

function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-lessons-')));
  const env = { FACTORY_HOME: join(dir, 'home') };
  const rec = (project, fp, at, scope = 'core') => run('record', {
    scope, fingerprint: fp, summary: `summary of ${fp}`, project, root: join(dir, project), 'state-root': join(dir, project, '.agents/factory-metadata', 'state', 'main'),
  }, env, at);
  return { dir, env, rec, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const cli = (env, ...a) => spawnSync(process.execPath, [LESSONS, ...a], { encoding: 'utf8', env: { ...process.env, ...env } });

test('core and org lessons reach the index across repos; repo lessons stay local', () => {
  const s = sandbox();
  try {
    s.rec('repo-a', 'browser-reauth-after-restart', T0);
    const second = s.rec('repo-b', 'Browser reauth after restart', T0 + DAY);
    assert.equal(second.occurrences, 2);
    assert.deepEqual(second.projects, ['repo-a', 'repo-b']);
    s.rec('repo-a', 'repo-only-thing', T0, 'repo');
    const local = readFileSync(join(s.dir, 'repo-a', '.agents/factory-metadata', 'state', 'main', 'lessons.jsonl'), 'utf8').trim().split('\n');
    assert.equal(local.length, 2);
    assert.ok(!readFileSync(join(s.env.FACTORY_HOME, 'lessons-index.jsonl'), 'utf8').includes('repo-only-thing'));
  } finally { s.done(); }
});

test('the exact-slug threshold is retired: no due command, no third-time prompt', () => {
  const s = sandbox();
  try {
    for (let i = 0; i < 3; i++) s.rec(`r${i}`, 'same-slug', T0 + i);
    assert.ok(!('THRESHOLD' in lessons) && !('promptText' in lessons));
    assert.ok(!('due' in s.rec('r9', 'same-slug', T0 + 4)));
    const p = cli(s.env, 'due');
    assert.equal(p.status, 2);
    assert.match(p.stderr, /usage: lessons\.mjs record\|decide\|/);
  } finally { s.done(); }
});

test('never is remembered, for a recorded fingerprint and for a family triage named', () => {
  const s = sandbox();
  try {
    s.rec('r0', 'a-lesson', T0);
    run('decide', { fingerprint: 'a-lesson', decision: 'never' }, s.env, T0 + DAY);
    run('decide', { fingerprint: 'Retry wording family', decision: 'never', summary: 'rewording retries', scope: 'core' }, s.env, T0 + DAY);
    const nevers = run('known', { never: true }, s.env, T0 + 2 * DAY);
    assert.deepEqual(nevers.map((k) => [k.fingerprint, k.summary]), [['a-lesson', 'summary of a-lesson'], ['retry-wording-family', 'rewording retries']]);
    assert.match(s.rec('r1', 'a-lesson', T0 + 3 * DAY).note, /marked never/);
    assert.equal(cli(s.env, 'decide', '--fingerprint', 'x', '--decision', 'promote').status, 2, 'only never is a decision now');
  } finally { s.done(); }
});

test('occurrences older than 90 days expire', () => {
  const s = sandbox();
  try {
    s.rec('r0', 'old', T0); s.rec('r1', 'old', T0 + DAY);
    assert.equal(s.rec('r0', 'old', T0 + 95 * DAY).occurrences, 1);
    const later = summarize([{ ts: new Date(T0).toISOString(), fingerprint: 'z', project: 'p' }], {}, T0 + 91 * DAY)[0];
    assert.equal(later.reason, 'expired');
  } finally { s.done(); }
});

test('fingerprints normalize, and the CLI refuses bad input', () => {
  assert.equal(normalizeFingerprint('  Dev-Slot: re-auth  the browser!! '), 'dev-slot-re-auth-the-browser');
  const r = spawnSync(process.execPath, [LESSONS, 'record', '--scope', 'galaxy', '--fingerprint', 'x', '--summary', 'y'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--scope must be repo, core or org/);
  assert.ok(existsSync(LESSONS));
});
