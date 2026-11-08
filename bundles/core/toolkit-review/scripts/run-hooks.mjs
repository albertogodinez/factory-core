#!/usr/bin/env node
// run-hooks.mjs --run <dir> --diff <diff.txt> --repo-path <dir> --head <sha> [--personas a,b] [--packs a:b]
// Without --personas it uses the dispatched personas in <run>/personas.json (from resolve-personas.mjs).
// Runs the context hooks that installed persona packs declare in their pack.json, then prints
// what each one produced. Run it after literal-sweep.sh, because hooks may read sweep-hits.tsv.
//
// pack.json: { "context": [ { "name", "whenPersonas": [..], "command": [..], "output": "file.md",
//                             "consumers": [..] } ],
//              "agentContext": [ { "name", "file", "whenPersonas": [..], "consumers": [..], "how": ".." } ] }
// A hook runs when any of its whenPersonas is in --personas. Its command runs with the pack
// directory as cwd; {RUN} {DIFF} {REPO} {HEAD} are replaced. `agentContext` entries are not run:
// they are steps the orchestrator performs (the pack's SKILL.md says how) and are listed for it.
// Exit 0 always; a failing hook is reported as status "failed", not fatal.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, readPackManifest, searchRoots } from './lib.mjs';

const o = parseArgs(process.argv.slice(2));
for (const k of ['run', 'diff', 'repo-path', 'head']) {
  if (!o[k]) { console.error(`run-hooks: missing --${k}`); process.exit(2); }
}
let names = o.personas ? o.personas.split(',').map((s) => s.trim()).filter(Boolean) : null;
if (!names) {
  const f = join(o.run, 'personas.json');
  if (!existsSync(f)) { console.error('run-hooks: no --personas and no personas.json in the run directory'); process.exit(2); }
  names = JSON.parse(readFileSync(f, 'utf8')).personas.filter((p) => p.status === 'dispatch').map((p) => p.name);
}
const personas = new Set(names);
const sub = (s) => s.replaceAll('{RUN}', o.run).replaceAll('{DIFF}', o.diff).replaceAll('{REPO}', o['repo-path']).replaceAll('{HEAD}', o.head);
const applies = (h) => (h.whenPersonas ?? []).some((p) => personas.has(p));

const hooks = [];
const agentSteps = [];
for (const root of searchRoots(o).slice(1)) {
  let m;
  try { m = readPackManifest(root); } catch (e) { hooks.push({ pack: root, name: 'pack.json', status: 'failed', reason: e.message }); continue; }
  if (!m) continue;
  for (const h of m.context ?? []) {
    if (!applies(h)) continue;
    const [cmd, ...args] = h.command.map(sub);
    const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
    const out = join(o.run, h.output);
    const status = r.status !== 0 ? 'failed' : existsSync(out) ? 'ok' : 'no-output';
    hooks.push({ pack: root, name: h.name, status, output: status === 'ok' ? out : null, consumers: h.consumers ?? [], reason: status === 'failed' ? (r.stderr || '').trim().split('\n').pop() : status === 'no-output' ? 'gate not met' : undefined });
  }
  for (const a of m.agentContext ?? []) if (applies(a)) agentSteps.push({ pack: root, ...a, file: join(o.run, a.file) });
}
console.log(JSON.stringify({ hooks, agentSteps }, null, 2));
