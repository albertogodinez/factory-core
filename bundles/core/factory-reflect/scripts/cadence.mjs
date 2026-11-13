// cadence.mjs: how often triage runs for each scope, decided by a script, not by you or the model.
// lessons.mjs is the CLI (`cadence`); the factory status hook reads the state to decide when to nudge.
//
// State: <home>/triage-state.json, {<key>: {mode, pinned, since, lastRun, lastClusterMax, quietWeeks}}.
// The key is the scope (core, org), or repo:<main checkout> for one repo's own queue.
// Rules, at the end of each triage run (and on demand):
//   daily -> weekly  after 14+ days in daily, two 7-day windows in a row with <= 2 new candidates,
//                    no fact candidates, and no cluster >= 3
//   weekly -> daily  an early trigger: queue >= 5, oldest >= 3 days, a cluster >= 3, or a lesson that
//                    landed a week or more ago whose fixedWhen signal didn't drop
// A pinned mode never switches. The first mode is daily.
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { queue } from './candidates.mjs';
import { readRows, trend } from './metrics.mjs';

export const MODES = ['daily', 'weekly'];
export const INTERVAL = { daily: 1, weekly: 7 };
const DAY = 86400000;
const stateFile = (home) => join(home, 'triage-state.json');
export const readState = (home) => { try { return JSON.parse(readFileSync(stateFile(home), 'utf8')); } catch { return {}; } };
function writeState(home, s) { const f = stateFile(home); mkdirSync(dirname(f), { recursive: true }); writeFileSync(`${f}.${process.pid}`, JSON.stringify(s, null, 2) + '\n'); renameSync(`${f}.${process.pid}`, f); }

export const stateKey = (scope, repo) => (scope === 'repo' ? `repo:${repo}` : scope);
function doneOf(home, scope, repo) {
  const out = [];
  try {
    const d = join(home, 'candidates', scope, 'done');
    for (const n of readdirSync(d).filter((x) => x.endsWith('.json'))) {
      try { const c = JSON.parse(readFileSync(join(d, n), 'utf8')); if (!repo || c.repo === repo) out.push(c); } catch {}
    }
  } catch {}
  return out;
}
// Every candidate a scope received, queued or done, with its time.
function received(home, scope, repo) {
  return [...queue(home, scope, Date.now(), repo), ...doneOf(home, scope, repo)].map((c) => ({ kind: c.kind, at: Date.parse(c.at) })).filter((c) => Number.isFinite(c.at));
}
const landed = (home, scope, repo) => doneOf(home, scope, repo).filter((c) => c.done?.outcome === 'landed');

// The early triggers that send a scope back to daily, each as a reason.
export function triggers({ queued, clusterMax = 0, lessons = [], now }) {
  const why = [];
  if (queued.length >= 5) why.push(`queue ${queued.length} >= 5`);
  const oldest = queued.length ? Math.max(...queued.map((c) => Math.floor((now - Date.parse(c.at)) / DAY))) : 0;
  if (oldest >= 3) why.push(`oldest candidate ${oldest} days >= 3`);
  if (clusterMax >= 3) why.push(`a cluster of ${clusterMax} >= 3`);
  for (const l of lessons) {
    if (l.metric && Date.parse(l.at) <= now - 7 * DAY && l.before != null && l.after != null && l.after >= l.before) why.push(`"${l.summary}" landed but ${l.metric} didn't drop (${l.before} -> ${l.after})`);
  }
  return why;
}

// A quiet window: <= 2 new candidates, none a fact.
export function quiet(items, from, to) {
  const w = items.filter((c) => c.at >= from && c.at < to);
  return w.length <= 2 && !w.some((c) => c.kind === 'fact');
}

// Decide and record the mode for one scope. `ran` marks a triage run with its largest cluster.
export function cadence({ home, scope, repo, pin, ran, clusterMax, env, now = Date.now() }) {
  if (scope === 'repo' && !repo) throw new Error('a repo cadence needs --repo <main checkout>');
  const key = stateKey(scope, repo);
  const all = readState(home);
  const s = all[key] || { mode: 'daily', pinned: false, since: new Date(now).toISOString(), lastRun: null, lastClusterMax: 0 };
  if (pin) {
    if (pin === 'off') s.pinned = false;
    else if (MODES.includes(pin)) { if (s.mode !== pin) s.since = new Date(now).toISOString(); s.mode = pin; s.pinned = true; }
    else throw new Error('--pin must be daily, weekly or off');
  }
  if (ran) { s.lastRun = new Date(now).toISOString(); s.lastClusterMax = Number(clusterMax) || 0; }
  const queued = queue(home, scope, now, repo);
  const lessons = scope === 'repo' ? [] : trend(readRows(env), landed(home, scope), scope, { days: 30, now }).lessons;
  const why = triggers({ queued, clusterMax: s.lastClusterMax, lessons, now });
  const items = received(home, scope, repo);
  const quietWeeks = [0, 1].every((w) => quiet(items, now - (w + 1) * 7 * DAY, now - w * 7 * DAY)) && s.lastClusterMax < 3;
  const before = s.mode;
  if (!s.pinned) {
    if (s.mode === 'daily' && quietWeeks && !why.length && now - Date.parse(s.since) >= 14 * DAY) s.mode = 'weekly';
    else if (s.mode === 'weekly' && why.length) s.mode = 'daily';
  }
  if (s.mode !== before) s.since = new Date(now).toISOString();
  s.quietWeeks = quietWeeks;
  all[key] = s;
  writeState(home, all);
  return { scope, ...(repo ? { repo } : {}), mode: s.mode, pinned: s.pinned, switched: s.mode !== before ? `${before} -> ${s.mode}` : null,
    triggers: why, quietWeeks, lastRun: s.lastRun, due: isDue(s, now), queued: queued.length };
}

// Triage is due when its interval has passed since the last run (or it never ran).
export function isDue(s, now = Date.now()) {
  if (!s?.lastRun) return true;
  return now - Date.parse(s.lastRun) >= INTERVAL[s.mode || 'daily'] * DAY;
}
