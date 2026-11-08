#!/usr/bin/env node
// Context budget for a bundle. Descriptions load into every session; SKILL.md bodies load when
// a skill runs. Limits: description ≤ 600 chars, the bundle's listing (name + description)
// ≤ 14K chars, SKILL.md ≤ 24 KB. It's a ratchet: a value already over its limit is recorded in
// the baseline and may shrink but never grow; --update-baseline records the shrink.
// Usage: context-budget.mjs [--bundle bundles/core] [--baseline tests/context-baseline.json] [--update-baseline]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

export const LIMITS = { description: 600, listing: 14000, skillMd: 24 * 1024 };

export function description(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return '';
  const d = /^description:\s*(.*)$/m.exec(m[1]);
  return d ? d[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2') : '';
}

export function measure(bundleDir) {
  const skills = {};
  for (const n of readdirSync(bundleDir).sort()) {
    const f = join(bundleDir, n, 'SKILL.md');
    if (!existsSync(f)) continue;
    skills[n] = { description: description(readFileSync(f, 'utf8')).length, skillMd: statSync(f).size, name: n.length };
  }
  const listing = Object.values(skills).reduce((a, s) => a + s.name + s.description, 0);
  return { skills, listing };
}

// Returns failures; a value may exceed its limit only up to its baseline.
export function check(m, baseline = { skills: {} }) {
  const fails = [];
  const allowed = (v, limit, base) => v <= Math.max(limit, base ?? 0);
  for (const [n, s] of Object.entries(m.skills)) {
    const b = baseline.skills?.[n] || {};
    if (!allowed(s.description, LIMITS.description, b.description)) fails.push(`${n}: description ${s.description} chars (limit ${LIMITS.description}${b.description ? `, baseline ${b.description}` : ''})`);
    if (!allowed(s.skillMd, LIMITS.skillMd, b.skillMd)) fails.push(`${n}: SKILL.md ${s.skillMd} B (limit ${LIMITS.skillMd}${b.skillMd ? `, baseline ${b.skillMd}` : ''}); move detail into references/`);
  }
  if (!allowed(m.listing, LIMITS.listing, baseline.listing)) fails.push(`listing ${m.listing} chars (~${Math.round(m.listing / 4)} tokens; limit ${LIMITS.listing})`);
  return fails;
}

// The baseline keeps only what is over a limit, at its current (lower or equal) size.
export function tighten(m) {
  const skills = {};
  for (const [n, s] of Object.entries(m.skills)) {
    const e = {};
    if (s.description > LIMITS.description) e.description = s.description;
    if (s.skillMd > LIMITS.skillMd) e.skillMd = s.skillMd;
    if (Object.keys(e).length) skills[n] = e;
  }
  return { skills, ...(m.listing > LIMITS.listing ? { listing: m.listing } : {}) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const root = dirname(dirname(realpathSync(import.meta.filename)));
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const bundle = resolve(root, arg('--bundle', 'bundles/core'));
  const basePath = resolve(root, arg('--baseline', 'tests/context-baseline.json'));
  const base = existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : { skills: {} };
  const m = measure(bundle);
  const fails = check(m, base);
  if (process.argv.includes('--update-baseline')) {
    if (fails.length) { console.error(fails.join('\n')); console.error('context-budget: fix the growth before updating the baseline'); process.exit(1); }
    writeFileSync(basePath, JSON.stringify(tighten(m), null, 2) + '\n');
  }
  console.log(`context-budget: ${Object.keys(m.skills).length} skills, listing ${m.listing} chars (~${Math.round(m.listing / 4)} tokens)`);
  if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
}
