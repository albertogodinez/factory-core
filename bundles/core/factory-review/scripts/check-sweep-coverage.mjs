#!/usr/bin/env node
// check-sweep-coverage.mjs --hits <sweep-hits.tsv> --reviewers <dir> --dispatched <persona,persona,...>
// Proves every sweep hit was answered: each hit needs a sweep_dispositions entry (same signal, file
// and line) from at least one dispatched owner. Reviewer outputs are the JSON files in <dir>, one
// per reviewer, checked against ../schemas/reviewer-output.schema.json.
// Prints a markdown table of problem hits and a summary line.
// Exit: 0 every hit answered, 1 some hit unreviewed or unproven, 2 bad input.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, '../schemas/reviewer-output.schema.json'), 'utf8'));

// A pack can require that a left_alone / not_applicable note on a signal names something specific
// (a design-system component, say) with a "!signal#regex" line in its sweep-signals.txt.
function noteRules() {
  const rules = {};
  const skills = join(here, '../..');
  const dirs = readdirSync(skills).filter((n) => n.startsWith('factory-review-')).map((n) => join(skills, n));
  dirs.push(...(process.env.TOOLKIT_REVIEW_PACKS ?? '').split(':').filter(Boolean));
  for (const d of dirs) {
    const f = join(d, 'sweep-signals.txt');
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^!([^#]+)#(.+)$/);
      if (m) rules[m[1]] = new RegExp(m[2]);
    }
  }
  return rules;
}
const NOTE_MUST_NAME = noteRules();

function check(value, sch, path, errs) {
  const t = sch.type;
  const ok = t === 'array' ? Array.isArray(value) : t === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : typeof value === t;
  if (!ok) return errs.push(`${path}: expected ${t}`);
  if (sch.enum && !sch.enum.includes(value)) errs.push(`${path}: must be one of ${sch.enum.join(', ')}`);
  if (t === 'array' && sch.items) value.forEach((v, i) => check(v, sch.items, `${path}[${i}]`, errs));
  if (t === 'object') {
    for (const k of sch.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(value)) if (sch.properties?.[k]) check(v, sch.properties[k], `${path}.${k}`, errs);
  }
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['hits', 'reviewers', 'dispatched']) if (!o[k]) throw new Error(`missing --${k}`);
  return o;
}

function loadReviewers(dir) {
  const out = new Map();
  for (const f of readdirSync(dir).filter((n) => /\.(json|md)$/.test(n))) {
    const raw = readFileSync(join(dir, f), 'utf8').trim().replace(/^```(json)?\s*/, '').replace(/```\s*$/, '');
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      throw new Error(`${f}: not JSON`);
    }
    const errs = [];
    check(r, schema, f, errs);
    if (errs.length) throw new Error(`${f} does not match reviewer-output.schema.json:\n  ${errs.join('\n  ')}`);
    const list = out.get(r.reviewer) ?? [];
    out.set(r.reviewer, list.concat(r.sweep_dispositions));
  }
  return out;
}

function main() {
  const o = args(process.argv.slice(2));
  if (!existsSync(o.reviewers)) throw new Error(`no reviewer directory ${o.reviewers}`);
  const dispatched = new Set(o.dispatched.split(',').map((s) => s.trim()).filter(Boolean));
  const reviewers = loadReviewers(o.reviewers);
  const missing = [...dispatched].filter((p) => !reviewers.has(p));
  const hits = readFileSync(o.hits, 'utf8').trim().split('\n').slice(1).filter(Boolean).map((l) => {
    const [signal, owners, file, line] = l.split('\t');
    return { signal, owners: owners.split(',').map((s) => s.trim()), file, line: +line };
  });

  const rows = [];
  const tally = { answered: 0, unreviewed: 0, unproven: 0, unowned: 0 };
  for (const h of hits) {
    const owners = h.owners.filter((p) => dispatched.has(p));
    const where = `\`${h.file}:${h.line}\``;
    if (!owners.length) {
      tally.unowned++;
      rows.push(`| ${h.signal} | ${where} | ${h.owners.join(', ')} | no owner dispatched |`);
      continue;
    }
    const entries = owners.flatMap((p) => reviewers.get(p) ?? []).filter((d) => d.signal === h.signal && d.file === h.file && d.line === h.line);
    const must = NOTE_MUST_NAME[h.signal];
    const proven = entries.some((d) => d.disposition === 'finding' || (d.note.trim() && (!must || must.test(d.note))));
    if (!entries.length) {
      tally.unreviewed++;
      rows.push(`| ${h.signal} | ${where} | ${owners.join(', ')} | unreviewed hit |`);
    } else if (!proven) {
      tally.unproven++;
      rows.push(`| ${h.signal} | ${where} | ${owners.join(', ')} | unproven: ${must ? `note does not match ${must}` : 'empty note'} |`);
    } else tally.answered++;
  }

  if (missing.length) console.log(`No output from dispatched reviewer(s): ${missing.join(', ')}. Their hits count as unreviewed.\n`);
  if (rows.length) console.log(['| Signal | Hit | Owners | Status |', '|---|---|---|---|', ...rows].join('\n'), '\n');
  console.log(`sweep coverage: ${hits.length} hits, ${tally.answered} answered, ${tally.unreviewed} unreviewed, ${tally.unproven} unproven, ${tally.unowned} with no owner dispatched`);
  return tally.unreviewed || tally.unproven ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`check-sweep-coverage: ${e.message}`);
  process.exit(2);
}
