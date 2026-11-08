import { test } from 'node:test';
import assert from 'node:assert/strict';

import { historyLines } from './history-lines.mjs';

const kinds = (text) => historyLines(text).map((hit) => hit.kind);

test('flags merge history, SHAs, thread ids and PR status', () => {
  assert.deepEqual(kinds('Squash-merged 2026-10-12 as cfa7eb5e from d94c8889.'), ['commit SHA', 'merge history']);
  assert.deepEqual(kinds('Dropped in `74cda54`.'), ['commit SHA']);
  assert.deepEqual(kinds('Merged 2026-10-08, released in 2.13.2.'), ['merge history']);
  assert.deepEqual(kinds('thread 1793206337.015609'), ['Slack thread or comment id']);
  assert.deepEqual(kinds('(review comment 4403547625)'), ['Slack thread or comment id']);
  assert.deepEqual(kinds('Open (CI green, mergeable).'), ['PR or ticket status']);
});

test('leaves current truth alone', () => {
  assert.deepEqual(kinds("Decided: rating colors follow the theme colors; don't re-raise. (PROJ-11755)"), []);
  assert.deepEqual(kinds('label `#105d4a`, count `#726a7a`, pill `rgb(34,121,80)`'), []);
  assert.deepEqual(kinds('Stale at step 4 as of 2026-10-22: `press "Find stays"` exits 6.'), []);
  assert.deepEqual(kinds('bundle budget 311 kB; see #706 for the open question.'), []);
  assert.deepEqual(kinds('`deadline` and `facade` are words, not SHAs.'), []);
});

test('reports 1-based line numbers', () => {
  assert.deepEqual(historyLines('ok\nmerged as `cfa7eb5e`'), [{ line: 2, kind: 'commit SHA' }]);
});
