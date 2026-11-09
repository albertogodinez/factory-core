import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coveredPaths, missingSymbols, touchedChecks, validateCoverage } from './drift.mjs';

const cov = {
  repo: 'example-app',
  syncCommit: 'a'.repeat(40),
  checks: [
    {
      id: 'no-jump',
      property: 'NoJump',
      rule: 'The pane does not jump.',
      model: 'model/M.tla',
      config: 'model/M.cfg',
      covers: [
        { path: 'src/layout/map-toggle-context.tsx', symbols: ['userDisabledAfterForced'] },
        { path: 'src/hotel/', symbols: ['PENDING_HOTEL_SEARCH_SCREEN_ID'] },
      ],
      findings: [{ id: 'lost-toggle', status: 'open', replay: 'replay/r.spec.tsx' }],
    },
  ],
};

test('accepts a record that matches the schema', () => {
  assert.deepEqual(validateCoverage(cov), []);
});

test('names each schema break', () => {
  const bad = { ...cov, syncCommit: 'abc123', checks: [{ ...cov.checks[0], id: 'No Jump', covers: [{ path: 'src/a.ts:12' }], extra: 1 }] };
  const errors = validateCoverage(bad);
  assert.ok(errors.some((e) => e.startsWith('syncCommit')));
  assert.ok(errors.some((e) => e.includes('.id')));
  assert.ok(errors.some((e) => e.includes('no line numbers')));
  assert.ok(errors.some((e) => e.includes('unknown key "extra"')));
});

test('reports wrong nested types instead of throwing', () => {
  const shapes = [
    null,
    { ...cov, checks: null },
    { ...cov, checks: [null] },
    { ...cov, checks: [{ ...cov.checks[0], covers: null }] },
    { ...cov, checks: [{ ...cov.checks[0], covers: [null, { path: 7 }] }] },
    { ...cov, checks: [{ ...cov.checks[0], findings: 'open' }] },
    { ...cov, checks: [{ ...cov.checks[0], findings: [null] }] },
    { ...cov, checks: [{ ...cov.checks[0], view: 3 }] },
  ];
  for (const shape of shapes) assert.ok(validateCoverage(shape).length > 0, JSON.stringify(shape));
});

test('the committed verify skills match the schema', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const skills = path.resolve(import.meta.dirname, '../..');
  for (const dir of fs.readdirSync(skills).filter((d) => d.startsWith('toolkit-verify-'))) {
    assert.deepEqual(validateCoverage(JSON.parse(fs.readFileSync(path.join(skills, dir, 'coverage.json'), 'utf8'))), [], dir);
  }
});

test('a change touches a check through a covered file or a file under a covered directory', () => {
  const touched = touchedChecks(cov, ['src/hotel/use-pending-hotel-search.tsx', 'src/other.ts', 'src/hotelier.ts']);
  assert.deepEqual(touched, [{ id: 'no-jump', property: 'NoJump', files: ['src/hotel/use-pending-hotel-search.tsx'] }]);
  assert.deepEqual(touchedChecks(cov, ['src/other.ts']), []);
});

test('covered paths are listed once, without a trailing slash', () => {
  assert.deepEqual(coveredPaths(cov), ['src/layout/map-toggle-context.tsx', 'src/hotel']);
});

test('reports a renamed symbol and a deleted file', () => {
  const trunk = { 'src/layout/map-toggle-context.tsx': 'const forcedOff = true;', 'src/hotel/': null };
  const missing = missingSymbols(cov, (p) => trunk[p] ?? null);
  assert.deepEqual(missing, [
    { check: 'no-jump', path: 'src/layout/map-toggle-context.tsx', symbol: 'userDisabledAfterForced' },
    { check: 'no-jump', path: 'src/hotel/', symbol: null },
  ]);
});

// drift.mjs hand-codes coverage.schema.json so check-drift runs on bare node. This runs the same
// records through both, so a field added to one and not the other fails here. Skips without ajv.
test('the hand validation agrees with coverage.schema.json', async (t) => {
  let Ajv;
  try {
    Ajv = (await import('ajv')).default;
  } catch {
    t.skip('ajv is not installed (npm install); the hand validation is tested above');
    return;
  }
  const fs = await import('node:fs');
  const path = await import('node:path');
  const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../schemas/coverage.schema.json'), 'utf8'));
  const schemaValid = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const check = cov.checks[0];
  const records = {
    full: cov,
    'no view, findings or symbols': { ...cov, checks: [{ id: 'a', property: 'P', rule: 'R', model: 'm', config: 'c', covers: [{ path: 'src/a.ts' }] }] },
    'empty findings': { ...cov, checks: [{ ...check, findings: [] }] },
    'not an object': null,
    'array root': [],
    'missing repo': { syncCommit: cov.syncCommit, checks: cov.checks },
    'short sha': { ...cov, syncCommit: 'abc123' },
    'numeric sha': { ...cov, syncCommit: 7 },
    'extra root key': { ...cov, extra: 1 },
    'no checks': { ...cov, checks: [] },
    'checks not a list': { ...cov, checks: null },
    'check not an object': { ...cov, checks: [null] },
    'bad check id': { ...cov, checks: [{ ...check, id: 'No Jump' }] },
    'empty property': { ...cov, checks: [{ ...check, property: '' }] },
    'numeric view': { ...cov, checks: [{ ...check, view: 3 }] },
    'extra check key': { ...cov, checks: [{ ...check, extra: 1 }] },
    'no covers': { ...cov, checks: [{ ...check, covers: [] }] },
    'covers not a list': { ...cov, checks: [{ ...check, covers: null }] },
    'cover not an object': { ...cov, checks: [{ ...check, covers: [null] }] },
    'numeric path': { ...cov, checks: [{ ...check, covers: [{ path: 7 }] }] },
    'line number in path': { ...cov, checks: [{ ...check, covers: [{ path: 'src/a.ts:12' }] }] },
    'symbols not strings': { ...cov, checks: [{ ...check, covers: [{ path: 'a', symbols: [1] }] }] },
    'numeric role': { ...cov, checks: [{ ...check, covers: [{ path: 'a', role: 1 }] }] },
    'extra cover key': { ...cov, checks: [{ ...check, covers: [{ path: 'a', line: 3 }] }] },
    'findings not a list': { ...cov, checks: [{ ...check, findings: 'open' }] },
    'finding not an object': { ...cov, checks: [{ ...check, findings: [null] }] },
    'bad finding status': { ...cov, checks: [{ ...check, findings: [{ id: 'f', status: 'done' }] }] },
    'numeric replay': { ...cov, checks: [{ ...check, findings: [{ id: 'f', status: 'open', replay: 1 }] }] },
  };
  for (const [name, record] of Object.entries(records)) {
    assert.equal(validateCoverage(record).length === 0, schemaValid(record), `${name}: hand validation and the schema disagree`);
  }
});
