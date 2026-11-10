// Run: node --test compare-geometry.test.mjs
// Each run writes synthetic geometry to an OS temp directory and removes it afterward.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'compare-geometry.mjs');
const runDir = mkdtempSync(join(tmpdir(), 'compare-geometry-test-'));
const CARD = '.synthetic-card';

after(() => rmSync(runDir, { recursive: true, force: true }));

function geometry(boxes, card = { w: 100, h: 60 }) {
  return {
    meta: { url: 'test://synthetic', captured_at: 'test-run' },
    cards: { [CARD]: [{ card, boxes }] },
  };
}

function fixture(name, value) {
  const file = join(runDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function box(x, y, w, h, cls = 'synthetic-skeleton') {
  return { cls, x, y, w, h, radius: '4px' };
}

const authorityBoxes = [box(10, 10, 40, 10), box(10, 30, 60, 10)];
const authority = fixture('authority', geometry(authorityBoxes));
const exact = fixture('exact', geometry(authorityBoxes));
const widthMismatch = fixture('width-mismatch', geometry([authorityBoxes[0], box(10, 30, 50, 10)]));
const nearWidth = fixture('near-width', geometry([authorityBoxes[0], box(10, 30, 58.75, 10)]));
const missingBox = fixture('missing-box', geometry([authorityBoxes[0]]));
const proportionalAuthority = fixture('proportional-authority', geometry([box(10, 10, 40, 10)], { w: 100, h: 40 }));
const proportionalImplementation = fixture('proportional-implementation', geometry([box(10, 10, 90, 10)], { w: 200, h: 40 }));
const duplicatedWrapper = fixture('duplicated-wrapper', geometry([
  box(10, 10, 40, 20, 'synthetic-media'),
  box(10, 10, 40, 20, 'synthetic-skeleton'),
]));
const oneSkeleton = fixture('one-skeleton', geometry([box(10, 10, 40, 20, 'synthetic-skeleton')]));

function run(args) {
  try {
    return { code: 0, out: execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { code: error.status, out: String(error.stdout), err: String(error.stderr) };
  }
}

function compare(implementation, extra = []) {
  return run([
    '--authority', authority,
    '--authority-card', CARD,
    '--implementation', implementation,
    '--implementation-card', CARD,
    ...extra,
  ]);
}

test('matching geometry exits 0', () => {
  const result = compare(exact);
  assert.equal(result.code, 0);
  assert.match(result.out, /MATCH: 2\/2 boxes/);
});

test('a width difference exits 3 and names the dimension', () => {
  const result = compare(widthMismatch);
  assert.equal(result.code, 3);
  assert.match(result.out, /MISMATCH: 1\/2 boxes/);
  assert.match(result.out, /mismatch: w/);
});

test('the tolerance controls the verdict', () => {
  assert.equal(compare(nearWidth).code, 3);
  const result = compare(nearWidth, ['--tolerance-px', '1.5']);
  assert.equal(result.code, 0);
  assert.match(result.out, /within 1.5px/);
});

test('a proportional width can match a resized content column', () => {
  const result = run([
    '--authority', proportionalAuthority,
    '--authority-card', CARD,
    '--implementation', proportionalImplementation,
    '--implementation-card', CARD,
  ]);
  assert.equal(result.code, 0);
  assert.match(result.out, /w share of column/);
});

test('a missing box is a mismatch', () => {
  const result = compare(missingBox);
  assert.equal(result.code, 3);
  assert.match(result.out, /authority has 2 boxes, implementation has 1/);
});

test('a wrapper and skeleton at the same rectangle count once', () => {
  const result = run([
    '--authority', duplicatedWrapper,
    '--authority-card', CARD,
    '--implementation', oneSkeleton,
    '--implementation-card', CARD,
  ]);
  assert.equal(result.code, 0);
  assert.match(result.out, /MATCH: 1\/1 boxes/);
});

test('--format json carries rows and the mismatch exit code', () => {
  const result = compare(widthMismatch, ['--format', 'json']);
  assert.equal(result.code, 3);
  const output = JSON.parse(result.out);
  assert.equal(output.rows.length, 2);
  assert.equal(output.mismatches, 1);
});

test('a missing selector exits 2 and lists the available selector', () => {
  const result = run([
    '--authority', authority,
    '--authority-card', '.missing',
    '--implementation', exact,
    '--implementation-card', CARD,
  ]);
  assert.equal(result.code, 2);
  assert.match(result.err, /\.synthetic-card/);
});

test('invalid geometry exits 2', () => {
  const invalid = fixture('invalid', geometry([], { w: 'wide', h: 60 }));
  const result = run([
    '--authority', invalid,
    '--authority-card', CARD,
    '--implementation', exact,
    '--implementation-card', CARD,
  ]);
  assert.equal(result.code, 2);
  assert.match(result.err, /not valid geometry/);
});

test('missing arguments exit 1', () => {
  assert.equal(run(['--authority', authority]).code, 1);
});

test('the old ref and ours flags remain compatible with saved commands', () => {
  const result = run(['--ref', authority, '--ref-card', CARD, '--ours', exact, '--ours-card', CARD]);
  assert.equal(result.code, 0);
});

// The hotel skeleton footer (PROJ-123): text rows at 20px, the price 4px further in, the photo at 8px.
const offGridBoxes = [box(8, 8, 84, 20), box(20, 32, 50, 6), box(20, 42, 40, 6), box(24, 52, 30, 6)];
const offGrid = fixture('off-grid', geometry(offGridBoxes, { w: 100, h: 70 }));
const onGrid = fixture('on-grid', geometry([...offGridBoxes.slice(0, 3), box(20, 52, 30, 6)], { w: 100, h: 70 }));
const tie = fixture('tie', geometry([box(20, 10, 40, 6), box(20, 20, 30, 6), box(24, 40, 30, 6), box(24, 50, 20, 6)], { w: 100, h: 70 }));

test('a box a few px off a shared inset exits 4 even when both sides match', () => {
  const result = run(['--authority', offGrid, '--authority-card', CARD, '--implementation', offGrid, '--implementation-card', CARD]);
  assert.equal(result.code, 4);
  assert.match(result.out, /MATCH: 4\/4 boxes/);
  assert.match(result.out, /authority: 1 box\(es\) at left inset 24px, 4px off the 20px inset/);
});

test('--alignment checks one side before any code exists', () => {
  const off = run(['--alignment', offGrid, '--card', CARD]);
  assert.equal(off.code, 4);
  assert.match(off.out, /left inset 24px, 4px off the 20px inset 2 other boxes share/);
  const on = run(['--alignment', onGrid, '--card', CARD]);
  assert.equal(on.code, 0);
  assert.match(on.out, /ALIGNED/);
});

test('an inset further away than --near-px is a separate tier, not a near miss', () => {
  assert.equal(run(['--alignment', onGrid, '--card', CARD]).code, 0);
  assert.equal(run(['--alignment', offGrid, '--card', CARD, '--near-px', '3']).code, 0);
});

test('two insets shared by the same number of boxes are reported once, against the outer one', () => {
  const result = run(['--alignment', tie, '--card', CARD, '--format', 'json']);
  assert.equal(result.code, 4);
  const { offGrid: list } = JSON.parse(result.out);
  assert.equal(list.filter((o) => o.edge === 'left').length, 1);
  assert.equal(list[0].at, 24);
  assert.equal(list[0].grid, 20);
});
