#!/usr/bin/env node
// Look up a glossary term across the layers a repo has: its own GLOSSARY.md (or CONTEXT.md),
// then each installed glossary skill, most specific first. Prints only the matching entry.
//
//   lookup.mjs <term>                     the entry, its layer, and any layer it overrides
//   lookup.mjs --list                     every term, by layer
//   lookup.mjs --check <file...>          format check: exit 1 on a malformed entry
//   lookup.mjs --dupes <file...>          terms defined in more than one file (promotion candidates)
//   options: --root <repo root>  --skills-dir <dir with installed skills>
//
// A glossary skill is any skill directory with a GLOSSARY.md and a glossary.json
// ({"layer": "<name>", "order": <n>}); a lower order is more specific and wins.
// The repo's own file has order 0. Exit codes: 0 found or clean, 1 not found or findings, 2 usage.
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = /^\*\*(.+?)\*\*:\s*$/;

// Entries are `**Term**:` lines followed by a definition and optional `_Avoid_:` lines,
// ending at the next entry, heading, or end of file.
export function parse(text) {
  const entries = [];
  let cur = null, section = '';
  const close = () => { if (cur) { cur.body = cur.lines.join('\n').trim(); entries.push(cur); cur = null; } };
  text.split('\n').forEach((line, i) => {
    if (/^#{1,6}\s/.test(line)) { close(); section = line.replace(/^#+\s*/, '').trim(); return; }
    const m = line.match(ENTRY);
    if (m) { close(); cur = { term: m[1].trim(), line: i + 1, section, lines: [] }; return; }
    if (cur) cur.lines.push(line);
  });
  close();
  for (const e of entries) {
    const avoid = e.lines.filter((l) => /^_Avoid_:/.test(l.trim()));
    e.definition = e.lines.filter((l) => l.trim() && !/^_Avoid_:/.test(l.trim())).join(' ').trim();
    e.avoid = avoid.flatMap((l) => l.replace(/^\s*_Avoid_:\s*/, '').split(/,(?![^(]*\))/).map((s) => s.replace(/\(.*?\)/g, '').replace(/["`]/g, '').trim()).filter(Boolean));
    delete e.lines;
  }
  return entries;
}

// Sentence count that ignores abbreviations and dotted file names.
export function sentences(text) {
  const t = text.replace(/`[^`]*`/g, 'X').replace(/\b(e\.g|i\.e|etc|vs)\./gi, '$1');
  return t.split(/(?<=[.!?])\s+(?=[A-Z"(])/).filter((s) => s.trim()).length;
}

export function check(text, file = 'GLOSSARY.md') {
  const out = [];
  const entries = parse(text);
  const seen = new Map();
  for (const e of entries) {
    const where = `${file}:${e.line}`;
    if (!e.definition) out.push(`${where} **${e.term}** has no definition`);
    else if (sentences(e.definition) > 2) out.push(`${where} **${e.term}** has ${sentences(e.definition)} sentences (limit 2)`);
    const k = e.term.toLowerCase();
    if (seen.has(k)) out.push(`${where} **${e.term}** is already defined at line ${seen.get(k)}`);
    else seen.set(k, e.line);
  }
  text.split('\n').forEach((l, i) => {
    if (/^\*\*[^*]+\*\*:\s*\S/.test(l)) out.push(`${file}:${i + 1} put the definition on the line after the **Term**: line`);
  });
  return out;
}

function gitRoot(from) {
  let d = resolve(from);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const p = dirname(d);
    if (p === d) return resolve(from);
    d = p;
  }
}

// The layers this repo has, most specific first.
export function layers({ root, skillsDir }) {
  const out = [];
  for (const name of ['GLOSSARY.md', 'CONTEXT.md']) {
    const f = join(root, name);
    if (existsSync(f)) { out.push({ layer: 'repo', order: 0, file: f }); break; }
  }
  const seen = new Set();
  for (const dir of [skillsDir].filter((d) => d && existsSync(d))) {
    for (const n of readdirSync(dir)) {
      const meta = join(dir, n, 'glossary.json'), g = join(dir, n, 'GLOSSARY.md');
      if (!existsSync(meta) || !existsSync(g)) continue;
      let real; try { real = realpathSync(g); } catch { real = g; }
      if (seen.has(real)) continue;
      seen.add(real);
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      out.push({ layer: m.layer || n, order: Number(m.order ?? 50), file: g });
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

export function lookup(term, ls) {
  const q = term.trim().toLowerCase();
  const hits = [], avoided = [], partial = [];
  for (const l of ls) {
    for (const e of parse(readFileSync(l.file, 'utf8'))) {
      const t = e.term.toLowerCase();
      if (t === q) hits.push({ ...l, entry: e });
      else if (e.avoid.some((a) => a.toLowerCase() === q)) avoided.push({ ...l, entry: e });
      else if (t.includes(q) || q.includes(t)) partial.push({ ...l, entry: e });
    }
  }
  return { hits, avoided, partial };
}

function show(h, root) {
  const e = h.entry;
  const lines = [`[${h.layer}] ${relative(root, h.file) || h.file}:${e.line}`, `**${e.term}**:`, e.definition];
  if (e.avoid.length) lines.push(`_Avoid_: ${e.avoid.join(', ')}`);
  return lines.join('\n');
}

function main(argv) {
  const opt = { root: null, skillsDir: null, mode: 'lookup', files: [], term: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opt.root = argv[++i];
    else if (a === '--skills-dir') opt.skillsDir = argv[++i];
    else if (a === '--list') opt.mode = 'list';
    else if (a === '--check') opt.mode = 'check';
    else if (a === '--dupes') opt.mode = 'dupes';
    else if (opt.mode === 'check' || opt.mode === 'dupes') opt.files.push(a);
    else opt.term.push(a);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const skillsDir = resolve(opt.skillsDir || join(here, '..', '..'));
  const root = resolve(opt.root || gitRoot(process.cwd()));

  if (opt.mode === 'check') {
    if (!opt.files.length) { console.error('usage: lookup.mjs --check <file...>'); return 2; }
    const out = opt.files.flatMap((f) => check(readFileSync(f, 'utf8'), f));
    out.forEach((l) => console.log(l));
    return out.length ? 1 : 0;
  }
  if (opt.mode === 'dupes') {
    const files = opt.files.length ? opt.files : layers({ root, skillsDir }).map((l) => l.file);
    const by = new Map();
    for (const f of files) for (const e of parse(readFileSync(f, 'utf8'))) {
      const k = e.term.toLowerCase();
      if (!by.has(k)) by.set(k, { term: e.term, at: [] });
      by.get(k).at.push(`${f}:${e.line}`);
    }
    const dupes = [...by.values()].filter((d) => d.at.length > 1);
    for (const d of dupes) console.log(`**${d.term}** is defined in ${d.at.length} places: ${d.at.join(', ')}`);
    return dupes.length ? 1 : 0;
  }
  const ls = layers({ root, skillsDir });
  if (!ls.length) { console.log('no glossary: no GLOSSARY.md or CONTEXT.md at the repo root, and no glossary skill installed'); return 1; }
  if (opt.mode === 'list') {
    for (const l of ls) console.log(`[${l.layer}] ${parse(readFileSync(l.file, 'utf8')).map((e) => e.term).join(', ')}`);
    return 0;
  }
  const term = opt.term.join(' ');
  if (!term) { console.error('usage: lookup.mjs <term> | --list | --check <file...> | --dupes [file...]'); return 2; }
  const { hits, avoided, partial } = lookup(term, ls);
  if (hits.length) {
    console.log(show(hits[0], root));
    for (const h of hits.slice(1)) console.log(`\nAlso defined in [${h.layer}] ${relative(root, h.file) || h.file}:${h.entry.line}; the [${hits[0].layer}] definition above wins here.`);
    return 0;
  }
  if (avoided.length) {
    for (const h of avoided) console.log(`"${term}" is a term to avoid; use **${h.entry.term}**.\n\n${show(h, root)}`);
    return 0;
  }
  if (partial.length) {
    console.log(`No entry named "${term}". Close matches: ${partial.map((h) => `**${h.entry.term}** [${h.layer}]`).join(', ')}`);
    return 1;
  }
  console.log(`No entry for "${term}" in: ${ls.map((l) => l.layer).join(', ')}`);
  return 1;
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === self) process.exitCode = main(process.argv.slice(2));
