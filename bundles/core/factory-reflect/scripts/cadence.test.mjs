// Cadence: daily until two quiet weeks (after at least 14 days), weekly until an early trigger,
// a pinned mode holds, and a lesson whose signal stayed flat brings daily back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cadence, triggers, quiet, isDue, readState } from './cadence.mjs';
import { writeCandidate, queue, markDone } from './candidates.mjs';
import { store, summarizeSession } from './metrics.mjs';

const LESSONS = join(dirname(fileURLToPath(import.meta.url)), 'lessons.mjs');
const DAY = 86400000, T0 = Date.parse('2026-11-01T00:00:00Z');
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-cadence-')));
  const home = join(dir, 'home');
  return { dir, home, env: { FACTORY_HOME: home }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the early triggers: queue >= 5, oldest >= 3 days, a cluster >= 3, a flat signal a week after landing', () => {
  const q = (n, ageDays) => Array.from({ length: n }, () => ({ at: new Date(T0 - ageDays * DAY).toISOString() }));
  assert.deepEqual(triggers({ queued: q(4, 2), now: T0 }), []);
  assert.match(triggers({ queued: q(5, 0), now: T0 })[0], /queue 5/);
  assert.match(triggers({ queued: q(1, 3), now: T0 })[0], /oldest candidate 3 days/);
  assert.match(triggers({ queued: [], clusterMax: 3, now: T0 })[0], /cluster of 3/);
  const flat = { summary: 'x', metric: 'permission_denials', at: new Date(T0 - 8 * DAY).toISOString(), before: 1, after: 1 };
  assert.match(triggers({ queued: [], lessons: [flat], now: T0 })[0], /didn't drop \(1 -> 1\)/);
  assert.deepEqual(triggers({ queued: [], lessons: [{ ...flat, after: 0 }], now: T0 }), [], 'it dropped');
  assert.deepEqual(triggers({ queued: [], lessons: [{ ...flat, at: new Date(T0 - 2 * DAY).toISOString() }], now: T0 }), [], 'too soon to judge');
});

test('a quiet week: <= 2 new candidates and none a fact', () => {
  assert.equal(quiet([{ kind: 'pattern', at: 1 }, { kind: 'pattern', at: 2 }], 0, 10), true);
  assert.equal(quiet([{ kind: 'pattern', at: 1 }, { kind: 'pattern', at: 2 }, { kind: 'harness', at: 3 }], 0, 10), false);
  assert.equal(quiet([{ kind: 'fact', at: 1 }], 0, 10), false);
});

test('daily -> weekly after 14 days and two quiet weeks; weekly -> daily on a trigger; --pin holds', () => {
  const s = sandbox();
  try {
    const run = (now, extra = {}) => cadence({ home: s.home, scope: 'core', env: s.env, now, ...extra });
    assert.equal(run(T0).mode, 'daily', 'the first mode is daily');
    assert.equal(run(T0 + 10 * DAY).mode, 'daily', 'quiet, but not yet 14 days in daily');
    // A fact 10 days in makes the week before T0+16 loud.
    writeCandidate({ home: s.home, kind: 'fact', scope: 'core', summary: 'f', at: T0 + 10 * DAY });
    const st = run(T0 + 16 * DAY, { ran: true, clusterMax: 1 });
    assert.equal(st.mode, 'daily');
    assert.equal(st.quietWeeks, false);
    // Land it so it leaves the queue (an old queued candidate is itself a trigger).
    for (const c of queue(s.home, 'core')) markDone(s.home, c.file, 'landed', T0 + 16 * DAY);
    const w = run(T0 + 25 * DAY, { ran: true, clusterMax: 1 });
    assert.equal(w.mode, 'weekly');
    assert.equal(w.switched, 'daily -> weekly');
    assert.equal(w.due, false, 'just ran');
    assert.equal(isDue(readState(s.home).core, T0 + 32 * DAY), true, 'a week later it is due');
    for (let i = 0; i < 5; i++) writeCandidate({ home: s.home, kind: 'pattern', scope: 'core', summary: `p${i}`, at: T0 + 26 * DAY });
    const back = run(T0 + 26 * DAY);
    assert.equal(back.mode, 'daily');
    assert.match(back.triggers[0], /queue 5/);
    assert.equal(run(T0 + 26 * DAY, { pin: 'weekly' }).mode, 'weekly', 'a pin holds against the trigger');
    assert.equal(run(T0 + 27 * DAY).mode, 'weekly');
    assert.equal(run(T0 + 27 * DAY, { pin: 'off' }).mode, 'daily', 'unpinned, the trigger applies again');
    assert.throws(() => run(T0, { pin: 'hourly' }), /--pin must be/);
  } finally { s.done(); }
});

test('a landed lesson whose fixedWhen signal stayed flat sends weekly back to daily', () => {
  const s = sandbox();
  try {
    const st = { core: { mode: 'weekly', pinned: false, since: new Date(T0 - 30 * DAY).toISOString(), lastRun: new Date(T0 - DAY).toISOString(), lastClusterMax: 0 } };
    mkdirSync(s.home, { recursive: true }); writeFileSync(join(s.home, 'triage-state.json'), JSON.stringify(st));
    const land = T0 - 10 * DAY, base = summarizeSession([], { session: 'x', harness: 'h', project: 'p' });
    for (let d = -17; d < 0; d++) store({ ...base, session: `s${d}`, at: new Date(T0 + d * DAY).toISOString(), layers: ['core'], denials: { total: 1, heads: { 'node lessons.mjs': 1 } } }, s.env, T0);
    const done = join(s.home, 'candidates', 'core', 'done'); mkdirSync(done, { recursive: true });
    writeFileSync(join(done, 'l.json'), JSON.stringify({ kind: 'fact', scope: 'core', summary: 'land from home', at: new Date(land).toISOString(),
      fixedWhen: { metric: 'permission_denials', match: 'lessons.mjs' }, done: { outcome: 'landed', at: new Date(land).toISOString() } }));
    const r = cadence({ home: s.home, scope: 'core', env: s.env, now: T0 });
    assert.equal(r.mode, 'daily');
    assert.match(r.triggers.join(' '), /"land from home" landed but permission_denials didn't drop/);
  } finally { s.done(); }
});

test('the CLI: cadence prints both scopes, --ran records the run, a bad pin exits 2', () => {
  const s = sandbox();
  try {
    const cli = (...a) => spawnSync(process.execPath, [LESSONS, 'cadence', ...a], { encoding: 'utf8', env: { ...process.env, ...s.env } });
    const p = cli('--ran', '--clusters', '2');
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(JSON.parse(p.stdout).scopes.map((x) => [x.scope, x.mode, x.due]), [['core', 'daily', false], ['org', 'daily', false]]);
    assert.equal(readState(s.home).core.lastClusterMax, 2);
    assert.equal(cli('--pin', 'hourly').status, 2);
  } finally { s.done(); }
});
