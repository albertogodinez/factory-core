#!/usr/bin/env node
// live.mjs: the tags of the sessions this launcher started that are still open. A session started with
// `--label factory.tag=<tag>` (launcher.json's "tag") carries it until its terminal ends, so a scheduled
// job can ask "is a triage session for this repo still open?" instead of guessing from a clock.
// Prints a JSON array of tag strings. With --tag, hc filters the listing in one call. node: imports only.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hcJson = (args) => {
  const r = spawnSync('hc', [...args, '--json'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
};

// Pure but for `get`, so the test needs no hc.
export function liveTags(get = hcJson, tag) {
  const ls = get(tag ? ['ls', '--label', `factory.tag=${tag}`] : ['ls']);
  if (!ls) throw new Error('hc ls failed');
  if (tag) return (ls.terminals || []).some((t) => t.state === 'live') ? [tag] : [];
  return (ls.terminals || []).filter((t) => t.state === 'live')
    .map((t) => get(['get', t.address])?.labels?.['factory.tag']).filter(Boolean);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  try {
    const [flag, tag] = process.argv.slice(2);
    if (flag && (flag !== '--tag' || !tag)) throw new Error('usage: live.mjs [--tag <tag>]');
    process.stdout.write(`${JSON.stringify(liveTags(hcJson, tag))}\n`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
