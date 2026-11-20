import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select, skillOf, ALWAYS } from './select.mjs';

const tests = [...ALWAYS, 'tests/factory.test.mjs',
  'bundles/core/a/scripts/a.test.mjs', 'bundles/core/b/scripts/b.test.mjs', 'bundles/core/c/scripts/c.test.mjs',
  'bundles/core/factory-context/scripts/resolve.test.mjs'];
const src = {
  'bundles/core/a/scripts/a.mjs': 'export const a = 1;',
  'bundles/core/b/scripts/b.mjs': "import { a } from '../../a/scripts/a.mjs';",
  'bundles/core/c/scripts/c.mjs': 'export const c = 3;',
  'tests/factory.test.mjs': "const p = join(ROOT, 'bundles', 'core', 'c');",
};
const ctx = { tests, files: [...tests, ...Object.keys(src)], read: (f) => src[f] || '' };
const own = (r) => r.tests.filter((t) => !ALWAYS.includes(t));

test('skillOf: the skill directory, or null outside one', () => {
  assert.equal(skillOf('bundles/core/a/scripts/a.mjs'), 'bundles/core/a');
  assert.equal(skillOf('bundles/launchers/l/place.mjs'), 'bundles/launchers/l');
  assert.equal(skillOf('bin/factory.mjs'), null);
  assert.equal(skillOf('README.md'), null);
});

test('a skill change runs its tests and the tests of skills that name it', () => {
  const r = select(['bundles/core/a/scripts/a.mjs'], ctx);
  assert.equal(r.mode, 'scoped');
  assert.deepEqual(own(r), ['bundles/core/a/scripts/a.test.mjs', 'bundles/core/b/scripts/b.test.mjs']);
  for (const t of ALWAYS) assert.ok(r.tests.includes(t), `${t} always runs`);
});

test('a tests/ file that names the skill counts as a user', () => {
  assert.deepEqual(own(select(['bundles/core/c/scripts/c.mjs'], ctx)), ['tests/factory.test.mjs', 'bundles/core/c/scripts/c.test.mjs']);
});

test('docs only: the owning skill\'s tests, no dependents; root docs: only the repo-wide checks', () => {
  const r = select(['bundles/core/a/SKILL.md'], ctx);
  assert.equal(r.mode, 'docs');
  assert.deepEqual(own(r), ['bundles/core/a/scripts/a.test.mjs']);
  assert.deepEqual(select(['README.md', 'AGENTS.md'], ctx).tests, ALWAYS);
});

test('shared code runs everything', () => {
  for (const p of ['bin/factory.mjs', 'tests/fixtures/make.mjs', '.githooks/pre-commit', 'package.json', 'bundles/core/factory-context/scripts/resolve.mjs']) {
    const r = select(['bundles/core/a/SKILL.md', p], ctx);
    assert.equal(r.mode, 'all', p);
    assert.deepEqual(r.tests, tests, p);
  }
});

test('nothing staged runs only the repo-wide checks', () => {
  assert.deepEqual(select([], ctx), { mode: 'none', tests: ALWAYS });
});
