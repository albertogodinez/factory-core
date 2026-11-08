#!/usr/bin/env node
// resolve-personas.mjs --run <dir> --diff <diff.txt> [--repo <name|owner/name>] [--cwd <dir>] [--packs a:b]
// Decides which reviewer personas to dispatch for this project and compiles their rules.
// 1. Asks toolkit-context for the project and adapters.personas (review.personas in the config).
//    With none configured, the default set is every persona whose frontmatter says `default: true`.
//    `general` always runs.
// 2. Finds each persona file (core, then installed toolkit-review-* packs). A persona that is
//    configured but missing is reported as a gap, not an error.
// 3. Applies each persona's gate: frontmatter `paths:` (regex over changed file paths), `sweep:`
//    (sweep signal ids with a hit in <run>/sweep-hits.tsv), `diff:` (regex over diff lines).
//    A persona with any gate runs when at least one gate matches.
// 4. Compiles rules for the rest. A persona with zero rules is skipped.
// Prints one JSON object and saves it as <run>/personas.json (run-hooks.mjs reads it). Exit 0 always, unless the project cannot be resolved (exit 2).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allPersonas, compileRules, findPersona, parseArgs, parseFrontmatter, resolveContext, searchRoots } from './lib.mjs';

const o = parseArgs(process.argv.slice(2));
if (!o.run || !o.diff) {
  console.error('Usage: resolve-personas.mjs --run <dir> --diff <diff.txt> [--repo <name>] [--cwd <dir>] [--packs a:b]');
  process.exit(2);
}
let ctx;
try {
  ctx = resolveContext([...(o.cwd ? ['--cwd', o.cwd] : []), ...(o.repo ? ['--repo', o.repo] : [])]);
} catch (e) {
  console.error(`resolve-personas: ${e.message}`);
  process.exit(2);
}
const target = ctx.project.name;
const roots = searchRoots(o);
const diffText = existsSync(o.diff) ? readFileSync(o.diff, 'utf8') : '';
const files = [...diffText.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((m) => m[1]).filter((f) => f !== '/dev/null');
const sweepFile = join(o.run, 'sweep-hits.tsv');
const sweepSignals = new Set(existsSync(sweepFile) ? readFileSync(sweepFile, 'utf8').split('\n').slice(1).map((l) => l.split('\t')[0]).filter(Boolean) : []);
const diffLines = diffText.split('\n');

const configured = ctx.adapters?.personas ?? [];
let names;
let source;
if (configured.length) {
  names = configured;
  source = 'configured';
} else {
  const defaults = [...allPersonas(roots)].filter(([, p]) => parseFrontmatter(readFileSync(p.file, 'utf8')).fm.default === 'true').map(([n]) => n);
  names = defaults;
  source = 'default';
}
names = ['general', ...names.filter((n) => n !== 'general')];

const asList = (v) => (Array.isArray(v) ? v : v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
function gate(fm) {
  const checks = [];
  if (fm.paths) checks.push({ label: `paths ${fm.paths}`, ok: files.some((f) => new RegExp(fm.paths).test(f)) });
  if (fm.sweep) checks.push({ label: `sweep ${asList(fm.sweep).join('|')}`, ok: asList(fm.sweep).some((s) => sweepSignals.has(s)) });
  if (fm.diff) { const re = new RegExp(fm.diff); checks.push({ label: 'diff pattern', ok: diffLines.some((l) => re.test(l)) }); }
  if (!checks.length) return { ok: true };
  return checks.some((c) => c.ok) ? { ok: true } : { ok: false, reason: `skipped (gate not met: ${checks.map((c) => c.label).join('; ')})` };
}

const personas = names.map((name) => {
  const found = findPersona(name, roots);
  if (!found) return { name, status: 'gap', reason: 'persona file not found in core or any installed pack' };
  const { fm } = parseFrontmatter(readFileSync(found.file, 'utf8'));
  const base = { name, pack: found.pack, personaFile: found.file };
  const g = gate(fm);
  if (!g.ok) return { ...base, status: 'skipped', reason: g.reason };
  if (name === 'general') return { ...base, status: 'dispatch', ruleCount: 0 };
  const c = compileRules(name, target, roots, o.run);
  if (!c.anyDir) return { ...base, status: 'gap', reason: 'no rules directory in core or any installed pack' };
  if (c.included === 0) return { ...base, status: 'skipped', reason: 'skipped (zero rules for this project)', ruleCount: 0 };
  return { ...base, status: 'dispatch', rulesFile: c.file, ruleCount: c.included };
});

const result = JSON.stringify({ project: target, personaSource: source, changedFiles: files.length, personas, packs: roots.slice(1) }, null, 2);
mkdirSync(o.run, { recursive: true });
writeFileSync(join(o.run, 'personas.json'), result);
console.log(result);
