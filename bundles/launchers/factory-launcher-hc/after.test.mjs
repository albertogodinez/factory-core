import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabOf, tabName, nameTab } from './after.mjs';

const ls = { spaces: [{ tabs: [{ id: 'tb1', terminals: [{ terminal: 't1' }] }, { id: 'tb2', terminals: [{ terminal: 't2' }, { terminal: 't3' }] }] }] };

test('tabOf finds the tab holding a terminal', () => {
  assert.equal(tabOf(ls, 't3'), 'tb2');
  assert.equal(tabOf(ls, 't9'), null);
  assert.equal(tabOf(null, 't1'), null);
});

test('tabName collapses whitespace and stays short', () => {
  assert.equal(tabName('triage ·\n factory-core'), 'triage · factory-core');
  assert.equal(tabName('x'.repeat(80)).length, 40);
});

test('nameTab waits for the terminal to appear, then renames its tab once', async () => {
  let calls = 0; const renamed = [];
  const id = await nameTab({ address: 't2', title: 'triage · core', ls: () => (++calls < 3 ? { spaces: [] } : ls), rename: (i, n) => renamed.push([i, n]), wait: async () => {} });
  assert.equal(id, 'tb2'); assert.deepEqual(renamed, [['tb2', 'triage · core']]);
  assert.equal(await nameTab({ address: 't9', title: 'x', ls: () => ls, rename: () => assert.fail('renamed'), wait: async () => {}, tries: 3 }), null, 'never appears: no rename');
});
