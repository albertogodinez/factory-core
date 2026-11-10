#!/usr/bin/env node
// Compare the painted boxes from the resolved design authority with the implementation.
// Usage: node compare-geometry.mjs --authority <expected.json> --authority-card <selector>
//          --implementation <actual.json> --implementation-card <selector>
//          [--tolerance-px 1] [--near-px 6] [--format md|json]
//        node compare-geometry.mjs --alignment <geometry.json> --card <selector>   (one side, before coding)
// Inputs: ../schemas/geometry.schema.json, written by a design-source skill's measure script (e.g. a prototype skill, if installed).
// Exit: 0 every box matches, 1 usage, 2 unreadable or invalid input, 3 at least one mismatch,
//       4 boxes match but one side has a box a few px off an edge its siblings share (ask the designer).
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, '../schemas/geometry.schema.json'), 'utf8'));
const EXIT = { OK: 0, USAGE: 1, INPUT: 2, MISMATCH: 3, OFF_GRID: 4 };

// Minimal checker for the subset of JSON Schema the geometry file uses (node: modules only, no ajv).
function check(value, sch, path, errs) {
  const t = sch.type;
  const ok = t === 'array' ? Array.isArray(value) : t === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : typeof value === t;
  if (!ok) return errs.push(`${path}: expected ${t}`);
  if (t === 'number' && sch.minimum != null && value < sch.minimum) errs.push(`${path}: below ${sch.minimum}`);
  if (t === 'array') value.forEach((v, i) => check(v, sch.items, `${path}[${i}]`, errs));
  if (t === 'object') {
    for (const k of sch.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      const sub = sch.properties?.[k] ?? (typeof sch.additionalProperties === 'object' ? sch.additionalProperties : null);
      if (sub) check(v, sub, `${path}.${k}`, errs);
    }
  }
}

const num = (v) => Math.round(v * 100) / 100;
const isSkeleton = (b) => /skeleton|divider/.test(b.cls ?? '');

// Old probes list a media wrapper and its skeleton at the same rect: keep one box per rect.
function dedupe(boxes) {
  const key = (b) => `${b.x},${b.y},${b.w},${b.h}`;
  const part = new Set(boxes.filter(isSkeleton).map(key));
  const seen = new Set();
  return boxes.filter((b) => {
    if (!isSkeleton(b) && part.has(key(b))) return false;
    if (seen.has(key(b))) return false;
    seen.add(key(b));
    return true;
  });
}

// Reading order: y, then x. Each box also carries what a fluid layout keeps constant.
function annotate(card, boxes) {
  const sorted = dedupe(boxes).sort((a, b) => a.y - b.y || a.x - b.x);
  return sorted.map((b, i) => {
    const prev = sorted[i - 1];
    // nearest box to the right that shares a row with this one
    const right = sorted.filter((o) => o !== b && o.x >= b.x + b.w - 0.5 && o.y < b.y + b.h && o.y + o.h > b.y).sort((p, q) => p.x - q.x)[0];
    return {
      ...b,
      right: card.w - b.x - b.w, // inset from the card's right edge
      bottom: card.h - b.y - b.h, // inset from the card's bottom edge
      gap: b.y - (prev ? prev.y + prev.h : 0), // distance below the previous box (or the card top)
      content: card.w - 2 * b.x, // width of the column the box sits in
      span: right ? right.x - b.x : null, // room up to the box beside it
    };
  });
}

// A dimension matches in px, or as the same share of something the layout scales with.
function compareBox(r, o, tol) {
  const near = (a, b) => Math.abs(a - b) <= tol;
  const via = [];
  const x = near(r.x, o.x) || near(r.right, o.right);
  const wPx = near(r.w, o.w);
  const wContent = !wPx && Math.abs(r.w / r.content - o.w / o.content) * o.content <= tol;
  const wSpan = !wPx && !wContent && r.span && o.span && Math.abs(r.w / r.span - o.w / o.span) * o.span <= tol;
  if (wContent) via.push('w share of column');
  if (wSpan) via.push('w share of row');
  const hPx = near(r.h, o.h);
  const hAspect = !hPx && Math.abs(r.h / r.w - o.h / o.w) * o.w <= tol;
  if (hAspect) via.push('h aspect');
  const yTop = near(r.y, o.y);
  const yGap = !yTop && near(r.gap, o.gap);
  const yBottom = !yTop && !yGap && near(r.bottom, o.bottom);
  if (yGap) via.push('y gap above');
  if (yBottom) via.push('y bottom-anchored');
  const bad = [];
  if (!x) bad.push('x');
  if (!(wPx || wContent || wSpan)) bad.push('w');
  if (!(yTop || yGap || yBottom)) bad.push('y');
  if (!(hPx || hAspect)) bad.push('h');
  return { bad, via };
}

// A content inset is shared by several boxes. A box a few px off it (more than the tolerance, up to
// nearPx) reads as a mistake, even when the other side has the same offset: the authority can carry it.
export function alignment(card, boxes, { tolerancePx = 1, nearPx = 6 } = {}) {
  const sorted = dedupe(boxes);
  const edges = { left: (b) => b.x, right: (b) => card.w - b.x - b.w };
  const out = [];
  for (const [edge, at] of Object.entries(edges)) {
    const groups = [];
    for (const b of sorted) {
      const v = at(b);
      const g = groups.find((x) => Math.abs(x.at - v) <= tolerancePx);
      if (g) g.boxes.push(b); else groups.push({ at: v, boxes: [b] });
    }
    for (const off of groups) {
      const grid = groups
        // the grid is the inset more boxes share; on a tie, the outer one, so the pair is reported once
        .filter((g) => g !== off && Math.abs(g.at - off.at) <= nearPx && (g.boxes.length > off.boxes.length || (g.boxes.length === off.boxes.length && g.at < off.at)))
        .sort((p, q) => q.boxes.length - p.boxes.length || p.at - q.at)[0];
      if (grid) out.push({ edge, at: num(off.at), grid: num(grid.at), delta: num(off.at - grid.at), boxes: off.boxes.length, gridBoxes: grid.boxes.length,
        parts: off.boxes.map((b) => `y ${num(b.y)}, ${num(b.w)} x ${num(b.h)}`) });
    }
  }
  return out;
}

export function compare({ authority, authorityCard, implementation, implementationCard, tolerancePx = 1, nearPx = 6 }) {
  const pick = (g, sel, side) => {
    const c = g.cards[sel]?.[0];
    if (!c) throw new Error(`${side} has no card for selector ${sel} (has: ${Object.keys(g.cards).join(', ') || 'none'})`);
    return c;
  };
  const rc = pick(authority, authorityCard, 'authority');
  const oc = pick(implementation, implementationCard, 'implementation');
  const rb = annotate(rc.card, rc.boxes);
  const ob = annotate(oc.card, oc.boxes);
  if (!rb.length || !ob.length) throw new Error(`nothing to compare: reference has ${rb.length} boxes, ours ${ob.length}. A card with no painted boxes was measured before its skeleton rendered.`);
  const rows = [];
  for (let i = 0; i < Math.max(rb.length, ob.length); i++) {
    const r = rb[i];
    const o = ob[i];
    const fmt = (b) => (b ? `x ${num(b.x)}, y ${num(b.y)}, ${num(b.w)} x ${num(b.h)}` : 'missing');
    const res = r && o ? compareBox(r, o, tolerancePx) : { bad: ['missing'], via: [] };
    rows.push({ part: `#${i + 1}`, authority: fmt(r), implementation: fmt(o), match: res.bad.length === 0, mismatch: res.bad, via: res.via });
  }
  const mismatches = rows.filter((r) => !r.match).length;
  const offGrid = {
    authority: alignment(rc.card, rc.boxes, { tolerancePx, nearPx }),
    implementation: alignment(oc.card, oc.boxes, { tolerancePx, nearPx }),
  };
  return {
    offGrid,
    card: { authority: { w: rc.card.w, h: rc.card.h, radius: rc.card.radius, shadow: rc.card.shadow }, implementation: { w: oc.card.w, h: oc.card.h, radius: oc.card.radius, shadow: oc.card.shadow } },
    rows, mismatches, tolerancePx,
    summary: `${rows.length - mismatches}/${rows.length} boxes match within ${tolerancePx}px${rb.length !== ob.length ? ` (authority has ${rb.length} boxes, implementation has ${ob.length})` : ''}`,
  };
}

function offGridLines(side, list) {
  return list.map((o) => `- ${side}: ${o.boxes} box(es) at ${o.edge} inset ${o.at}px, ${Math.abs(o.delta)}px off the ${o.grid}px inset ${o.gridBoxes} other boxes share (${o.parts.join('; ')})`);
}

export function toMarkdown(r) {
  const c = r.card;
  const lines = [
    '| Part | Authority | Implementation | Result |', '|---|---|---|---|',
    ...r.rows.map((x) => `| ${x.part} | ${x.authority} | ${x.implementation} | ${x.match ? `match${x.via.length ? ` (${x.via.join(', ')})` : ''}` : `mismatch: ${x.mismatch.join(', ')}`} |`),
    '',
    `Card, not scored: authority ${c.authority.w} x ${c.authority.h}, radius ${c.authority.radius ?? '?'}, shadow ${c.authority.shadow ?? '?'}; implementation ${c.implementation.w} x ${c.implementation.h}, radius ${c.implementation.radius ?? '?'}, shadow ${c.implementation.shadow ?? '?'}.`,
    '',
    `${r.mismatches ? 'MISMATCH' : 'MATCH'}: ${r.summary}`,
  ];
  const off = [...offGridLines('authority', r.offGrid.authority), ...offGridLines('implementation', r.offGrid.implementation)];
  if (off.length) lines.push('', 'OFF-GRID: a box sits a few px off an edge its siblings share. Matching the authority does not settle it; ask the designer which inset is meant.', ...off);
  return lines.join('\n');
}

function load(p, side) {
  const g = JSON.parse(readFileSync(p, 'utf8'));
  const errs = [];
  check(g, schema, side, errs);
  if (errs.length) throw new Error(`${p} is not valid geometry:\n  ${errs.join('\n  ')}`);
  return g;
}

// One side only: run it on the authority right after measuring it, before any code is written.
function alignmentOnly(o) {
  if (!o.card) { console.error('--alignment needs --card <selector>'); return EXIT.USAGE; }
  try {
    const g = load(o.alignment, 'geometry');
    const c = g.cards[o.card]?.[0];
    if (!c) throw new Error(`no card for selector ${o.card} (has: ${Object.keys(g.cards).join(', ') || 'none'})`);
    const list = alignment(c.card, c.boxes, { tolerancePx: o.tolerancePx, nearPx: o.nearPx });
    if (o.format === 'json') console.log(JSON.stringify({ offGrid: list }, null, 2));
    else console.log(list.length ? ['OFF-GRID: ask the designer which inset is meant.', ...offGridLines(o.card, list)].join('\n') : `ALIGNED: every box shares its edges within ${o.nearPx}px`);
    return list.length ? EXIT.OFF_GRID : EXIT.OK;
  } catch (e) {
    console.error(e.message);
    return EXIT.INPUT;
  }
}

function main(argv) {
  const o = { tolerancePx: 1, nearPx: 6, format: 'md' };
  const flags = {
    '--authority': 'authority', '--authority-card': 'authorityCard',
    '--implementation': 'implementation', '--implementation-card': 'implementationCard',
    '--ref': 'authority', '--ref-card': 'authorityCard', '--ours': 'implementation', '--ours-card': 'implementationCard',
    '--tolerance-px': 'tolerancePx', '--near-px': 'nearPx', '--format': 'format',
    '--alignment': 'alignment', '--card': 'card',
  };
  const usage = () => console.error('Usage: compare-geometry.mjs --authority <expected.json> --authority-card <selector> --implementation <actual.json> --implementation-card <selector> [--tolerance-px 1] [--near-px 6] [--format md|json]\n       compare-geometry.mjs --alignment <geometry.json> --card <selector> [--tolerance-px 1] [--near-px 6] [--format md|json]');
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '-h' || argv[i] === '--help') { usage(); return EXIT.OK; }
    if (!flags[argv[i]] || argv[i + 1] === undefined) { usage(); return EXIT.USAGE; }
    o[flags[argv[i]]] = argv[i + 1];
  }
  o.tolerancePx = Number(o.tolerancePx);
  o.nearPx = Number(o.nearPx);
  if (!Number.isFinite(o.nearPx) || !['md', 'json'].includes(o.format)) { usage(); return EXIT.USAGE; }
  if (o.alignment) return alignmentOnly(o);
  if (!o.authority || !o.authorityCard || !o.implementation || !o.implementationCard || !Number.isFinite(o.tolerancePx) || !['md', 'json'].includes(o.format)) { usage(); return EXIT.USAGE; }
  try {
    const result = compare({
      authority: load(o.authority, 'authority'), authorityCard: o.authorityCard,
      implementation: load(o.implementation, 'implementation'), implementationCard: o.implementationCard,
      tolerancePx: o.tolerancePx, nearPx: o.nearPx,
    });
    console.log(o.format === 'json' ? JSON.stringify(result, null, 2) : toMarkdown(result));
    if (result.mismatches) return EXIT.MISMATCH;
    return result.offGrid.authority.length || result.offGrid.implementation.length ? EXIT.OFF_GRID : EXIT.OK;
  } catch (e) {
    console.error(e.message);
    return EXIT.INPUT;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
