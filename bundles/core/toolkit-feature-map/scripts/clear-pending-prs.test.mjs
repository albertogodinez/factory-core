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
