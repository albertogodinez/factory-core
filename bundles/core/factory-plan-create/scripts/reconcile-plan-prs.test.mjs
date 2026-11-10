// Offline: gh is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, classifyPr, decidePlan, processPlan } from './reconcile-plan-prs.mjs';

const gh = (states) => (args) => {
  const state = states[args[2]];
  return state ? { status: 0, stdout: JSON.stringify({ state }) } : { status: 1, stdout: '' };
};
const A = 'https://github.com/o/r/pull/1', B = 'https://github.com/o/r/pull/2';

test('parseFrontmatter reads scalars, block lists and inline lists', () => {
  const fm = parseFrontmatter('---\ntitle: "T"\nstatus: active\nrepos:\n  - a\n  - "b"\npr_links: ["u1 note", "u2"]\n---\nbody');
  assert.deepEqual(fm, { title: 'T', status: 'active', repos: ['a', 'b'], pr_links: ['u1 note', 'u2'] });
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
});

test('classifyPr rejects non-PR urls without calling gh', () => {
  assert.equal(classifyPr('not a url', () => { throw new Error('called'); }), 'UNPARSEABLE');
  assert.equal(classifyPr(A, gh({ [A]: 'MERGED' })), 'MERGED');
});

test('decidePlan: all merged is ready, partial is pending, unknown is unverifiable, terminal is finished', () => {
  const g = gh({ [A]: 'MERGED', [B]: 'OPEN' });
  assert.equal(decidePlan({ status: 'active', pr_links: [A] }, g).verdict, 'ready-to-complete');
  assert.equal(decidePlan({ status: 'draft', pr_links: [A, B] }, g).verdict, 'pending (1/2 merged)');
  assert.equal(decidePlan({ status: 'draft', pr_links: [] }, g).verdict, 'no-signal');
  assert.equal(decidePlan({ status: 'completed' }, g).verdict, 'deletable-finished');
  assert.equal(decidePlan({ status: 'weird' }, g).verdict, 'skip');
});

test('a ticketless finished plan is deleted under --apply; a ticketed one is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const plan = (n, extra) => { const f = join(dir, n); writeFileSync(f, `---\nstatus: completed\n${extra}---\n`); return f; };
  const opts = (apply) => ({ apply, root: dir, harvestCmd: (r) => `harvest ${r}`, gh: gh({}) });
  const bare = plan('a.md', ''), ticketed = plan('b.md', 'ticket: "KEY-1"\n');
  assert.equal(processPlan(bare, opts(false)).actions.ticketed, false);
  assert.equal(existsSync(bare), true, 'report-only keeps it');
  processPlan(bare, opts(true));
  assert.equal(existsSync(bare), false);
  const r = processPlan(ticketed, opts(true));
  assert.equal(existsSync(ticketed), true);
  assert.equal(r.actions.harvest, 'harvest b.md');
});
