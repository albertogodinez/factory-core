#!/usr/bin/env node
// check-persona-sources.mjs [--cwd <dir>] [--repo <name>] [--packs a:b] [--all]
// Guards against persona drift. Checks, across core and every installed toolkit-review-* pack:
//   1. Each persona the project configures (adapters.personas) has a persona file and a rules
//      directory. With --all, every persona file found is checked the same way.
//   2. Each persona file has name and description frontmatter, and name matches the filename.
// A configured persona with no file is a coverage gap: it is reported and the exit code is 1.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { allPersonas, findPersona, parseArgs, parseFrontmatter, resolveContext, ruleFiles, searchRoots } from './lib.mjs';

const o = parseArgs(process.argv.slice(2), ['all']);
const roots = searchRoots(o);
let fail = 0;
const say = (ok, msg) => { if (!ok) fail = 1; console.error(`${ok ? 'OK' : 'FAIL'}: ${msg}`); };

let configured = [];
try {
  configured = resolveContext([...(o.cwd ? ['--cwd', o.cwd] : []), ...(o.repo ? ['--repo', o.repo] : [])]).adapters?.personas ?? [];
} catch (e) {
  console.error(`note: ${e.message}; checking installed personas only`);
}
const names = new Set(o.all ? [...allPersonas(roots).keys(), ...configured] : configured);
for (const name of names) {
  if (name === 'general') continue;
  const p = findPersona(name, roots);
  const r = ruleFiles(name, roots);
  const missing = [!p && 'persona file', !r.anyDir && 'rules directory'].filter(Boolean);
  say(!missing.length, missing.length ? `persona '${name}' is missing: ${missing.join(', ')}` : `persona '${name}' (${p.pack}) has a persona file and ${r.files.length} rules`);
}
for (const [name, p] of allPersonas(roots)) {
  const { fm } = parseFrontmatter(readFileSync(p.file, 'utf8'));
  if (!fm.name || !fm.description) say(false, `${basename(p.file)} (${p.pack}) is missing name or description frontmatter`);
  else if (fm.name !== name) say(false, `${basename(p.file)} (${p.pack}) has name '${fm.name}'; it must match the filename`);
  else say(true, `personas/${name}.md (${p.pack})`);
}
console.error(fail ? 'check-persona-sources: FAILED' : 'check-persona-sources: all checks passed');
process.exit(fail);
