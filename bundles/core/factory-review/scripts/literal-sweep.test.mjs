// literal-sweep.mjs: signal table, ERE conversion, added-line tracking, pack merging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempRoot, write } from '../../../../tests/fixtures/make.mjs';
import { ere, addedLines, loadSignals, sweep, BASE_SIGNALS } from './literal-sweep.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIFF = [
  'diff --git a/src/a.tsx b/src/a.tsx', '--- a/src/a.tsx', '+++ b/src/a.tsx', '@@ -3,2 +3,9 @@',
  ' ctx', '+const x = y as any;', '-removed', '+const z = a![0];', '+  // a comment', '+useEffect(() => {}, []);',
  '+try {} catch (e) {}', '+const n = v ?? [];', '+acmeThing();',
  'diff --git a/src/legacy/b.tsx b/src/legacy/b.tsx', '--- a/src/legacy/b.tsx', '+++ b/src/legacy/b.tsx', '@@ -1,1 +1,2 @@', '+acmeThing();',
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml', '--- a/pnpm-lock.yaml', '+++ b/pnpm-lock.yaml', '@@ -1,1 +1,2 @@', '+console.log(1)',
  '',
].join('\n');

test('ere handles a leading ], POSIX classes and octal escapes', () => {
  assert.ok(ere('[]A-Za-z0-9_)]![.)[,;]').test('a![0]'));
  assert.ok(!ere('[]A-Za-z0-9_)]![.)[,;]').test('a! x'));
  assert.ok(ere('^[[:space:]]*\\043([[:space:]]|$)').test('  # hi'));
  assert.ok(ere('^[[:space:]]*\\043([[:space:]]|$)').test('#'));
  assert.ok(!ere('^[[:space:]]*\\043([[:space:]]|$)').test('#!x'));
  assert.ok(ere('catch[[:space:]]*(\\([^)]*\\))?[[:space:]]*\\{[[:space:]]*\\}').test('} catch (e) {}'));
  assert.ok(ere('\\.(ts|tsx)$').test('a.tsx'));
});

test('addedLines tracks head-side line numbers and skips lockfiles', () => {
  const a = addedLines(DIFF);
  assert.deepEqual(a.slice(0, 3).map((x) => [x.path, x.line]), [['src/a.tsx', 4], ['src/a.tsx', 5], ['src/a.tsx', 6]]);
  assert.ok(!a.some((x) => x.path === 'pnpm-lock.yaml'));
});

test('base signals fire on the expected lines', () => {
  const t = tempRoot('sweep-');
  try {
    const r = sweep(DIFF, loadSignals(join(t.root, 'none'), ''));
    for (const id of ['any-cast', 'non-null', 'use-effect', 'added-comment', 'swallowed-error', 'fallback-default']) assert.match(r.md, new RegExp(`## ${id} \\(1\\)`), id);
    assert.match(r.tsv, /^signal\towners\tpath\tline\nany-cast\ttypescript-conventions, general\tsrc\/a\.tsx\t4\n/);
    assert.equal(r.total, 6);
  } finally { t.cleanup(); }
});

test('packs add signals, add owners and honour the path exclude; CLI writes both files', () => {
  const t = tempRoot('sweep-');
  try {
    write(join(t.root, 'pack/sweep-signals.txt'), '; comment\n+use-effect#acme-hooks\n!todo#x\nacme-sig#acme#acmeThing#\\.(ts|tsx)$#/legacy/\n');
    write(join(t.root, 'in.diff'), DIFF);
    const r = spawnSync(process.execPath, [join(HERE, 'literal-sweep.mjs'), join(t.root, 'in.diff'), join(t.root, 'out')], { encoding: 'utf8', env: { ...process.env, TOOLKIT_REVIEW_PACKS: join(t.root, 'pack') } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /literal sweep: 7 hits/);
    const md = readFileSync(join(t.root, 'out/sweep.md'), 'utf8');
    assert.match(md, /## use-effect \(1\)\n\nOwners: react-patterns, acme-hooks/);
    assert.match(md, /## acme-sig \(1\)/);
    assert.ok(!md.includes('legacy'));
    assert.match(readFileSync(join(t.root, 'out/sweep-hits.tsv'), 'utf8'), /acme-sig\tacme\tsrc\/a\.tsx\t10\n/);
  } finally { t.cleanup(); }
});

test('no hits and bad usage', () => {
  const t = tempRoot('sweep-');
  try {
    write(join(t.root, 'in.diff'), 'diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1,2 @@\n+hello\n');
    const ok = spawnSync(process.execPath, [join(HERE, 'literal-sweep.mjs'), join(t.root, 'in.diff'), join(t.root, 'out')], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.match(readFileSync(join(t.root, 'out/sweep.md'), 'utf8'), /No hits\.\n$/);
    assert.equal(spawnSync(process.execPath, [join(HERE, 'literal-sweep.mjs')], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [join(HERE, 'literal-sweep.mjs'), join(t.root, 'missing.diff'), t.root], { encoding: 'utf8' }).status, 1);
  } finally { t.cleanup(); }
});

test('the signal table has the original 14 rows', () => {
  assert.equal(BASE_SIGNALS.split('\n').length, 14);
});
