import { test } from 'node:test';
import assert from 'node:assert/strict';

import { auditChanges, fromGithubFiles, parseNameStatus } from './pr-audit.mjs';

const D = 'src/components/work-pane/hotel';
const entries = [
  {
    id: 'hotel-results',
    file: 'features/hotel-results.md',
    code: [
      { repo: 'app', path: `${D}/results-reveal.tsx`, symbols: ['ResultsReveal'] },
      { repo: 'app', path: `${D}/tile-skeleton.tsx` },
    ],
    tests: [{ repo: 'app', path: 'tests/results-reveal.spec.tsx' }],
  },
];
const audit = (changes, readHead) => auditChanges({ repo: 'app', changes, entries, readHead });

test('a deleted anchor is an error naming the feature file and anchor', () => {
  const r = audit([{ status: 'removed', path: `${D}/tile-skeleton.tsx` }]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].file, 'features/hotel-results.md');
  assert.equal(r.errors[0].anchor, `${D}/tile-skeleton.tsx`);
  assert.deepEqual(r.touched.map((t) => t.feature), ['hotel-results']);
});

test('a renamed anchor is an error, and the new path is not flagged as unanchored', () => {
  const r = audit([{ status: 'renamed', path: `${D}/tile.tsx`, previousPath: `${D}/tile-skeleton.tsx` }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /renames it to/);
});

test('an added source file beside an anchored file is a warning', () => {
  const r = audit([{ status: 'added', path: `${D}/new-footer.tsx` }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(r.warnings[0].features, ['hotel-results']);
});

test('tests, stories, fixtures, stylesheets and generated files are ignored', () => {
  const r = audit(['new.spec.tsx', 'new.stories.tsx', 'fixtures/a.ts', 'x.generated.ts', 'new.scss', 'new.snap'].map((n) => ({ status: 'added', path: `${D}/${n}` })));
  assert.deepEqual(r.warnings, []);
});

test('an untouched area reports nothing', () => {
  const r = audit([{ status: 'modified', path: 'src/elsewhere/thing.tsx' }, { status: 'removed', path: 'src/elsewhere/gone.tsx' }]);
  assert.deepEqual(r, { errors: [], warnings: [], touched: [] });
});

test('a modified anchored file is touched, not a warning; a removed symbol is an error', () => {
  const change = [{ status: 'modified', path: `${D}/results-reveal.tsx` }];
  assert.deepEqual(audit(change, () => 'export const ResultsReveal').errors, []);
  assert.equal(audit(change).warnings.length, 0);
  const r = audit(change, () => 'export const Other');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /ResultsReveal/);
});

test('parsers map git and GitHub statuses', () => {
  assert.deepEqual(parseNameStatus('D\ta.ts\nR087\tb.ts\tc.ts\nA\td.ts'), [
    { status: 'removed', path: 'a.ts' },
    { status: 'renamed', path: 'c.ts', previousPath: 'b.ts' },
    { status: 'added', path: 'd.ts' },
  ]);
  assert.deepEqual(fromGithubFiles([{ filename: 'n.ts', status: 'renamed', previous_filename: 'o.ts' }, { filename: 'm.ts', status: 'changed' }]), [
    { status: 'renamed', path: 'n.ts', previousPath: 'o.ts' },
    { status: 'modified', path: 'm.ts' },
  ]);
});
