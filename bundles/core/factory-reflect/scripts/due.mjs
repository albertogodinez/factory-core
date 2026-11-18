// due.mjs: whether triage is due for a scope, from its state. No imports, so the status hook can load it
// on every session start without paying for the rest of cadence.
const DAY = 86400000;
export const INTERVAL = { daily: 1, weekly: 7 };
export const RUN_DAYS = [1, 3, 4]; // Date#getDay, local time: Monday, Wednesday, Thursday

// Triage is due when its interval has passed since the last run (or it never ran). In thrice mode it
// is due when a run day (Monday, Wednesday or Thursday) has begun since the last run's own day, so a
// missed Monday still shows up on Tuesday and a run on Monday is not due again until Wednesday.
export function isDue(s, now = Date.now()) {
  if (!s?.lastRun) return true;
  if ((s.mode || 'thrice') === 'thrice') {
    const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; };
    const last = day(Date.parse(s.lastRun)), today = day(now);
    for (const d = new Date(last); d < today; ) {
      d.setDate(d.getDate() + 1);
      if (RUN_DAYS.includes(d.getDay())) return true;
    }
    return false;
  }
  return now - Date.parse(s.lastRun) >= INTERVAL[s.mode] * DAY;
}
