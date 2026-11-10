import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingPrOf, withoutPendingPr } from './clear-pending-prs.mjs';

const URL = 'https://github.com/acme/app/pull/754';
const entry = (field) => `---\nid: hotel-results\n${field}last_verified: 2026-10-29\n---\n\n# Hotel results\n\npending_pr: ${URL} in the body is prose, not the field\n`;

test('reads pending_pr from the frontmatter only', () => {
  assert.equal(pendingPrOf(entry(`pending_pr: ${URL}\n`)), URL);
  assert.equal(pendingPrOf(entry(`pending_pr: "${URL}"\n`)), URL);
  assert.equal(pendingPrOf(entry('')), undefined);
});

test('removing it leaves the rest of the entry byte for byte', () => {
  assert.equal(withoutPendingPr(entry(`pending_pr: ${URL}\n`)), entry(''));
});

test('entries lists map entries in a skills directory, such as a bundle source', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { entries } = await import('./clear-pending-prs.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fm-skills-'));
  mkdirSync(join(dir, 'factory-features-app', 'features'), { recursive: true });
  mkdirSync(join(dir, 'other-skill', 'features'), { recursive: true });
  writeFileSync(join(dir, 'factory-features-app', 'features', 'a.md'), entry(''));
  writeFileSync(join(dir, 'factory-features-app', 'features', 'README.md'), '# index\n');
  writeFileSync(join(dir, 'other-skill', 'features', 'b.md'), entry(''));
  assert.deepEqual(entries(dir), [join(dir, 'factory-features-app', 'features', 'a.md')]);
  assert.deepEqual(entries(join(dir, 'missing')), []);
});
