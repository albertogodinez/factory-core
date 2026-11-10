// Run: node --test build-compare-grid.test.mjs  (needs `magick`)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build, textSizes } from './build-compare-grid.mjs';

let dir;
const HAS_MAGICK = spawnSync('magick', ['-version'], { stdio: 'ignore' }).status === 0;
const imageTest = HAS_MAGICK ? test : test.skip;
const magick = (...a) => execFileSync('magick', a);
const spec = (name, panels, extra = {}) => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ out: `${name}.png`, columns: ['Before', 'After'], rows: [{ label: 'Acme', panels }], noReference: 'fixture', ...extra }));
  return p;
};
const panel = (src, extra = {}) => ({ src, crop: '200x150+20+20', ...extra });

before(() => {
  if (!HAS_MAGICK) return;
  dir = mkdtempSync(join(tmpdir(), 'grid-test-'));
  magick('-size', '400x300', 'pattern:checkerboard', join(dir, 'busy.png'));
  magick('-size', '400x300', 'xc:white', join(dir, 'blank.png')); // the demo had already swapped the pane
  writeFileSync(join(dir, 'probe.json'), '{"card":[1,2,3,4]}');
  writeFileSync(join(dir, 'empty.json'), '');
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

imageTest('builds a grid when every panel shows content', () => {
  const r = build(spec('ok', [panel('busy.png', { probe: 'probe.json', guideX: 20, caption: 'name 20px' }), panel('busy.png')]));
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(dir, 'ok.png')));
});

imageTest('refuses a blank panel and writes no grid', () => {
  const r = build(spec('refused', [panel('busy.png'), panel('blank.png')]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /near-uniform/);
  assert.match(r.errors.join('\n'), /After/);
  assert.equal(existsSync(join(dir, 'refused.png')), false);
});

imageTest('refuses a missing or empty probe', () => {
  for (const probe of ['nope.json', 'empty.json']) {
    const r = build(spec('probe', [panel('busy.png', { probe }), panel('busy.png')]));
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /probe/);
  }
});

imageTest('refuses a spec that breaks the schema', () => {
  const r = build(spec('bad', [{ src: 'busy.png', crop: 'wide' }, panel('busy.png')]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /crop/);
});

imageTest('refuses a row with the wrong number of panels', () => {
  const r = build(spec('cols', [panel('busy.png')]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /1 panels for 2 columns/);
});

imageTest('draws a placeholder for an empty panel and refuses one with no caption', () => {
  const ok = build(spec('empty-ok', [panel('busy.png'), { empty: true, caption: 'no equivalent in the prototype' }]));
  assert.equal(ok.ok, true);
  assert.ok(existsSync(join(dir, 'empty-ok.png')));
  const bad = build(spec('empty-bad', [panel('busy.png'), { empty: true }]));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /needs a caption/);
});

imageTest('names the folder a missing screenshot was looked for in', () => {
  const r = build(spec('where', [panel('gone.png'), panel('busy.png')]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /resolve against the spec's folder/);
});

imageTest('refuses a grid with no reference column unless it says why', () => {
  const none = build(spec('no-ref', [panel('busy.png'), panel('busy.png')], { noReference: undefined }));
  assert.equal(none.ok, false);
  assert.match(none.errors.join('\n'), /no reference column/);
  const proto = build(spec('proto', [panel('busy.png'), panel('busy.png')], { noReference: undefined, columns: ['Before', 'Prototype (mlp/main)'] }));
  assert.equal(proto.ok, true);
});

imageTest('wraps a long row label instead of shrinking it', () => {
  const label = 'Acme, always-on scrollbars, pointer on the transcript';
  const p = join(dir, 'long.json');
  writeFileSync(p, JSON.stringify({ out: 'long.png', columns: ['Before', 'Figma'], panelWidth: 150, rows: [{ label, panels: [panel('busy.png'), panel('busy.png')] }] }));
  assert.equal(build(p).ok, true);
  // The label band is as wide as the grid, so the output is no wider than its columns.
  assert.equal(Number(execFileSync('magick', ['identify', '-format', '%w', join(dir, 'long.png')])), 2 * 152);
});

test('scales text with the grid width so wide grids stay legible once GitHub shrinks them', () => {
  assert.deepEqual(textSizes(600), textSizes(880));
  assert.ok(textSizes(1760).caption === 2 * textSizes(880).caption);
});
