#!/usr/bin/env node
// Build a labeled Before | After | Reference screenshot grid from a JSON spec and refuse any
// panel that is blank (the state it should show never appeared) or lacks its probe file.
// Usage: node build-compare-grid.mjs <spec.json>
// Spec shape: ../schemas/compare-grid.schema.json. Needs `magick` (ImageMagick 7) on PATH.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, '../schemas/compare-grid.schema.json'), 'utf8'));
const magick = (...args) => execFileSync('magick', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Minimal checker for the subset of JSON Schema the spec uses (node: modules only, no ajv).
function check(value, sch, path, errs) {
  const t = sch.type;
  const ok = t === 'array' ? Array.isArray(value) : t === 'integer' ? Number.isInteger(value)
    : t === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : typeof value === t;
  if (!ok) return errs.push(`${path}: expected ${t}`);
  if (t === 'string') {
    if (sch.minLength && value.length < sch.minLength) errs.push(`${path}: empty`);
    if (sch.pattern && !new RegExp(sch.pattern).test(value)) errs.push(`${path}: "${value}" does not match ${sch.pattern}`);
  }
  if ((t === 'integer' || t === 'number') && ((sch.minimum != null && value < sch.minimum) || (sch.maximum != null && value > sch.maximum))) errs.push(`${path}: out of range`);
  if (t === 'array') {
    if (sch.minItems && value.length < sch.minItems) errs.push(`${path}: needs at least ${sch.minItems} item(s)`);
    value.forEach((v, i) => check(v, sch.items, `${path}[${i}]`, errs));
  }
  if (t === 'object') {
    for (const k of sch.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (sch.properties?.[k]) check(v, sch.properties[k], `${path}.${k}`, errs);
      else if (sch.additionalProperties === false) errs.push(`${path}.${k}: unknown property`);
    }
  }
}

// A column whose header matches this is the design reference.
export const REFERENCE = /prototype|\bproto\b|figma|reference|design/i;

// GitHub fits a wide image to the ~880px PR body column, so text drawn at a fixed size shrinks with
// the grid: a 3-column grid read smaller than a 2-column one. Scale it with the grid's width instead,
// so it lands at about the same on-screen size in every grid (header ~16px, caption ~13px).
export function textSizes(gridWidth) {
  const k = Math.max(1, gridWidth / 880);
  return { header: Math.round(17 * k), label: Math.round(16 * k), caption: Math.round(14 * k) };
}

export function build(specPath) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const errs = [];
  check(spec, schema, 'spec', errs);
  if (errs.length) return { ok: false, errors: errs };
  if (!spec.columns.some((c) => REFERENCE.test(c)) && !spec.noReference?.trim()) {
    errs.push(`no reference column (a column named Prototype, Figma or Reference): add the prototype or Figma panel, or set noReference to why there is none`);
  }
  const base = dirname(resolve(specPath));
  const abs = (p) => resolve(base, p);
  const width = spec.panelWidth ?? 480;
  const minStd = spec.minStdDev ?? 0.02;
  spec.rows.forEach((r, i) => {
    if (r.panels.length !== spec.columns.length) errs.push(`rows[${i}] "${r.label}": ${r.panels.length} panels for ${spec.columns.length} columns`);
  });
  // Check every panel before drawing anything, so one run reports all the blank ones.
  spec.rows.forEach((r, i) => r.panels.forEach((p, j) => {
    const id = `rows[${i}] "${r.label}" / ${spec.columns[j] ?? j}`;
    if (p.empty) return p.caption ? undefined : errs.push(`${id}: an empty panel needs a caption`);
    if (!p.src || !p.crop) return errs.push(`${id}: needs src and crop, or empty: true`);
    if (!existsSync(abs(p.src))) return errs.push(`${id}: ${p.src} does not exist (paths resolve against the spec's folder, ${base})`);
    if (p.probe && (!existsSync(abs(p.probe)) || statSync(abs(p.probe)).size < 3)) errs.push(`${id}: probe ${p.probe} is missing or empty`);
    const sd = Number(magick(abs(p.src), '-crop', p.crop, '+repage', '-format', '%[fx:standard_deviation]', 'info:'));
    if (!(sd >= minStd)) errs.push(`${id}: crop ${p.crop} of ${p.src} is near-uniform (std dev ${sd.toFixed(4)} < ${minStd}); the state was not on screen`);
  }));
  if (errs.length) return { ok: false, errors: errs };

  const tmp = mkdtempSync(join(tmpdir(), 'compare-grid-'));
  try {
    // ImageMagick may have no default font, so name a file; GRID_FONT overrides.
    const fontFile = [process.env.GRID_FONT, '/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => f && existsSync(f));
    const font = fontFile ? ['-font', fontFile] : [];
    const gridWidth = spec.columns.length * (width + 2);
    const size = textSizes(gridWidth);
    // caption: wraps at a fixed point size; label: with a fixed box shrinks long text until it is unreadable.
    const text = (t, w, pt, name, { gravity = 'center', bg = 'white', fill = '#111', pad = 8 } = {}) => {
      const f = join(tmp, name);
      if (!t.trim()) { magick('-size', `${w}x1`, `xc:${bg}`, f); return f; }
      magick('-background', bg, '-fill', fill, ...font, '-pointsize', String(pt), '-size', `${w - 2 * pad}x`, '-gravity', gravity,
        `caption:${t.trim()}`, '-bordercolor', bg, '-border', `${pad}x${pad / 2}`, f);
      return f;
    };
    const rowFiles = spec.rows.map((r, i) => {
      const drawn = r.panels.map((p, j) => {
        if (p.empty) return null;
        const f = join(tmp, `p-${i}-${j}.png`);
        const args = [abs(p.src), '-crop', p.crop, '+repage'];
        if (p.guideX != null) {
          const h = Number(p.crop.split('x')[1].split('+')[0]);
          args.push('-stroke', '#E3183C', '-strokewidth', '1', '-draw', `line ${p.guideX},0 ${p.guideX},${h}`);
        }
        args.push('-resize', `${width}x`, '-bordercolor', '#ccc', '-border', '1', f);
        magick(...args);
        return { f, height: Number(magick('identify', '-format', '%h', f)) };
      });
      const rowHeight = Math.max(...drawn.map((d) => d?.height ?? 0));
      const cells = r.panels.map((p, j) => {
        const cap = text(p.caption ?? ' ', width + 2, size.caption, `c-${i}-${j}.png`);
        const cell = join(tmp, `cell-${i}-${j}.png`);
        if (p.empty) {
          const box = join(tmp, `e-${i}-${j}.png`);
          magick('-size', `${width + 2}x${rowHeight}`, 'xc:#f4f4f4', box);
          magick(box, cap, '-background', 'white', '-gravity', 'north', '-append', cell);
        } else {
          magick(drawn[j].f, cap, '-background', 'white', '-gravity', 'north', '-append', cell);
        }
        return cell;
      });
      const row = join(tmp, `row-${i}.png`);
      // The row label is a band across the whole row, so a long one wraps instead of shrinking into a side column.
      const band = text(r.label, gridWidth, size.label, `band-${i}.png`, { gravity: 'west', bg: '#eef0f3', pad: 12 });
      const panels = join(tmp, `panels-${i}.png`);
      magick(...cells, '-background', 'white', '-gravity', 'north', '+append', panels);
      magick(band, panels, '-background', 'white', '-gravity', 'west', '-append', row);
      return row;
    });
    const header = join(tmp, 'header.png');
    const heads = spec.columns.map((c, j) => text(c, width + 2, size.header, `h-${j}.png`));
    magick(...heads, '-background', 'white', '-gravity', 'south', '+append', header);
    const parts = [header, ...rowFiles];
    if (spec.noReference) parts.push(text(`No reference column: ${spec.noReference}`, gridWidth, size.caption, 'note.png', { gravity: 'west', fill: '#555', pad: 12 }));
    magick(...parts, '-background', 'white', '-gravity', 'west', '-append', '+repage', abs(spec.out));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: true, out: abs(spec.out) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) { console.error('usage: build-compare-grid.mjs <spec.json>'); process.exit(2); }
  const r = build(process.argv[2]);
  if (!r.ok) { console.error(`refused:\n- ${r.errors.join('\n- ')}`); process.exit(1); }
  console.log(`wrote ${r.out}`);
}
