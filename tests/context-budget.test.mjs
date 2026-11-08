import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { measure, check, tighten, LIMITS } from '../scripts/context-budget.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = () => { const p = join(ROOT, 'tests', 'context-baseline.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { skills: {} }; };

test('core stays within its context budget (ratchet against the baseline)', () => {
  assert.deepEqual(check(measure(join(ROOT, 'bundles', 'core')), base()), []);
});

test('the ratchet fails when a description grows by 1 char past its limit or baseline', () => {
  const m = measure(join(ROOT, 'bundles', 'core'));
  const [name] = Object.keys(m.skills);
  const over = { skills: { [name]: { ...m.skills[name], description: LIMITS.description + 1 } }, listing: 0 };
  assert.equal(check(over, { skills: {} }).length, 1, 'over the limit with no baseline');
  assert.deepEqual(check(over, tighten(over)), [], 'at its baseline');
  const grown = { skills: { [name]: { ...over.skills[name], description: LIMITS.description + 2 } }, listing: 0 };
  assert.match(check(grown, tighten(over))[0], /description 602 chars \(limit 600, baseline 601\)/);
  const shrunk = { skills: { [name]: { ...over.skills[name], description: 500 } }, listing: 0 };
  assert.deepEqual(tighten(shrunk), { skills: {} }, 'a shrink below the limit drops it from the baseline');
});
