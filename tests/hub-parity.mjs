#!/usr/bin/env node
// Phase 1 exit check: run from a hub, the resolver must report the same name,
// trunk, host and commands as the hub's .claude/repos.json for every registered repo.
// Usage: node tests/hub-parity.mjs <hub-dir>
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hub = process.argv[2];
if (!hub) { console.error('usage: hub-parity.mjs <hub-dir>'); process.exit(2); }
const RESOLVE = join(dirname(fileURLToPath(import.meta.url)), '..', 'bundles', 'core', 'factory-context', 'scripts', 'resolve.mjs');
const reg = JSON.parse(readFileSync(join(hub, '.claude', 'repos.json'), 'utf8'));
let bad = 0;
for (const r of reg.repos) {
  const o = JSON.parse(execFileSync(process.execPath, [RESOLVE, '--no-cache', '--repo', r.name], { cwd: hub, encoding: 'utf8' }));
  const want = {
    name: r.name, trunk: r.primaryBranch, host: r.remote.ghHost,
    commands: Object.fromEntries(Object.entries(r.commands || {}).filter(([, v]) => v)),
  };
  const got = { name: o.project.name, trunk: o.project.trunk, host: o.project.remote?.host, commands: o.project.commands || {} };
  const diff = Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]));
  console.log(`${diff.length ? 'DIFF' : 'ok  '} ${r.name}${diff.map((k) => `\n     ${k}: want ${JSON.stringify(want[k])} got ${JSON.stringify(got[k])}`).join('')}`);
  bad += diff.length ? 1 : 0;
}
console.log(`${reg.repos.length - bad}/${reg.repos.length} repos match`);
process.exit(bad ? 1 : 0);
