#!/usr/bin/env node
// after.mjs: names the tab a launched session opened in. Herdr numbers a tab (1, 2, ...) until it is
// renamed, so a run of scheduled sessions is indistinguishable. Reads the `hc run` output on stdin for the
// terminal's address, waits for Herdr to put that terminal in a tab (it adopts a labeled terminal a few
// seconds after the launch), then renames the tab. Exits 0 when Herdr isn't open: nothing to name.
//   node after.mjs --title <name> < hc-run-output
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = (args) => {
  const r = spawnSync('herdr-app', args, { encoding: 'utf8', timeout: 8000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
};

// The tab holding a terminal, from `herdr-app ls`. Pure, so the test needs no Herdr.
export function tabOf(ls, address) {
  for (const s of ls?.spaces || []) for (const t of s.tabs || []) if ((t.terminals || []).some((x) => x.terminal === address)) return t.id;
  return null;
}
export const tabName = (title) => String(title).replace(/\s+/g, ' ').trim().slice(0, 40);

export async function nameTab({ address, title, ls = () => app(['ls']), rename = (id, name) => app(['do', 'tab.rename', JSON.stringify({ id, name })]), wait = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 20 }) {
  for (let i = 0; i < tries; i++) {
    const id = tabOf(ls(), address);
    if (id) { rename(id, tabName(title)); return id; }
    await wait(1000);
  }
  return null;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  const i = process.argv.indexOf('--title');
  const title = i > 0 ? process.argv[i + 1] : null;
  let address = null; try { address = JSON.parse(readFileSync(0, 'utf8')).address; } catch {}
  if (!title || !address) { process.stderr.write('usage: after.mjs --title <name>, with the hc run output on stdin\n'); process.exit(2); }
  if (app(['status']) === null) process.exit(0); // Herdr's window isn't open
  const id = await nameTab({ address, title });
  if (!id) { process.stderr.write(`${address} never appeared in a Herdr tab\n`); process.exit(1); }
}
