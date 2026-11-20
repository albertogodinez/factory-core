#!/usr/bin/env node
// place.mjs: where a launched session shows up. Herdr shows an hc terminal in a space when the
// terminal carries a herdr.space label, and a terminal launched without one runs where nobody sees
// it. This picks the space of a live terminal working in the repo, else the space with the most
// terminals, and prints the hc run arguments that put the new terminal there (a JSON array; empty
// when no terminal is in any space, so Herdr isn't open). It also labels a fresh herdr.tab id: Herdr
// makes an id it doesn't know into a new tab in that space, so the session gets a tab of its own
// instead of joining whatever tab Herdr picks. node: imports only.
//   node place.mjs --repo <path>
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hcJson = (args) => {
  const r = spawnSync('hc', [...args, '--json'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
};

// terminals: [{ cwd, foregroundCwd, space }]. Pure, so the test needs no hc.
export function pickSpace(repo, terminals) {
  const inRepo = (p) => p && (p === repo || p.startsWith(`${repo}/`));
  const spaced = terminals.filter((t) => t.space);
  const own = spaced.find((t) => inRepo(t.foregroundCwd) || inRepo(t.cwd));
  if (own) return { space: own.space, why: 'repo' };
  const counts = new Map();
  for (const t of spaced) counts.set(t.space, (counts.get(t.space) || 0) + 1);
  const busiest = [...counts].sort((a, b) => b[1] - a[1])[0];
  return busiest ? { space: busiest[0], why: 'busiest' } : { space: null, why: 'no terminal is in a Herdr space' };
}

export function liveTerminals(get = hcJson) {
  const ls = get(['ls']);
  return (ls?.terminals || []).filter((t) => t.where).map((t) => {
    const d = get(['get', t.address]) || {};
    return { cwd: d.cwd || t.cwd, foregroundCwd: d.foreground?.cwd, space: d.labels?.['herdr.space'] || null };
  });
}

// A tab id Herdr has never seen, in the form it uses itself: tb + 32 hex.
export const freshTab = () => `tb${randomBytes(16).toString('hex')}`;

export function placeArgs(repo, terminals = liveTerminals(), tab = freshTab) {
  const { space } = pickSpace(repo, terminals);
  return space ? ['--label', `herdr.space=${space}`, '--label', `herdr.tab=${tab()}`] : [];
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  const i = process.argv.indexOf('--repo');
  const repo = i > 0 ? process.argv[i + 1] : null;
  if (!repo) { process.stderr.write('usage: place.mjs --repo <path>\n'); process.exit(2); }
  process.stdout.write(`${JSON.stringify(placeArgs(repo))}\n`);
}
