import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claim, who, peers, event, since, guard, isStale, StackError } from './stack.mjs';

const ledger = () => { const d = mkdtempSync(join(tmpdir(), 'factory-stack-test-')); return { d, dispose: () => rmSync(d, { recursive: true, force: true }) }; };
const T0 = '2026-11-18T14:56:00Z', T1 = '2026-11-18T18:16:00Z', LATE = '2026-11-19T12:00:00Z';

test('the first claim wins; the owner refreshes it; another session is refused', () => {
  const { d, dispose } = ledger(); try {
    assert.equal(claim(d, { branch: 'feat/A-1-parent', owner: 'hc:t73', pr: '1016', at: T0 }).created, true);
    const again = claim(d, { branch: 'feat/A-1-parent', owner: 'hc:t73', at: T1 });
    assert.equal(again.heartbeat, T1);
    assert.equal(again.pr, 1016, 'a refresh keeps the fields it was given before');
    assert.throws(() => claim(d, { branch: 'feat/A-1-parent', owner: 'conductor:A-2', at: T1 }), (e) => e instanceof StackError && /owned by hc:t73/.test(e.message));
  } finally { dispose(); }
});

test('a takeover needs a reason and records whom it replaced', () => {
  const { d, dispose } = ledger(); try {
    claim(d, { branch: 'b', owner: 'one', at: T0 });
    assert.throws(() => claim(d, { branch: 'b', owner: 'two', takeover: true }), /needs --why/);
    const c = claim(d, { branch: 'b', owner: 'two', takeover: true, why: 'user: one is gone', at: T1 });
    assert.deepEqual(c.took_over, { from: 'one', why: 'user: one is gone', at: T1 });
  } finally { dispose(); }
});

test('peers finds the parent and every child based on a branch', () => {
  const { d, dispose } = ledger(); try {
    claim(d, { branch: 'feat/A-1-parent', owner: 'hc:t73', at: T0 });
    claim(d, { branch: 'feat/A-2-child', owner: 'conductor:A-2', base: 'feat/A-1-parent', state: '/s/A-2/conductor/state.json', at: T0 });
    claim(d, { branch: 'feat/A-3-other', owner: 'someone', base: 'main', at: T0 });
    const up = peers(d, 'feat/A-1-parent', T1);
    assert.deepEqual(up.children.map((c) => c.owner), ['conductor:A-2']);
    const down = peers(d, 'feat/A-2-child', T1);
    assert.equal(down.parent.owner, 'hc:t73');
    assert.equal(down.base, 'feat/A-1-parent');
  } finally { dispose(); }
});

test('only the owner records events, and since returns what came after the head a child last merged', () => {
  const { d, dispose } = ledger(); try {
    claim(d, { branch: 'p', owner: 'parent', at: T0 });
    event(d, { branch: 'p', owner: 'parent', kind: 'pushed', head: '5bc22088aaaa', at: T1 });
    event(d, { branch: 'p', owner: 'parent', kind: 'pushed', head: 'a35afaaebbbb', at: T1 });
    event(d, { branch: 'p', owner: 'parent', kind: 'merging', method: 'squash', at: T1 });
    assert.throws(() => event(d, { branch: 'p', owner: 'child', kind: 'pushed', head: 'x' }), /only its owner/);
    assert.deepEqual(since(d, 'p', '5bc22088').map((e) => e.kind), ['pushed', 'merging'], 'a short sha matches');
    assert.equal(since(d, 'p').length, 3);
    assert.equal(who(d, 'p').head, 'a35afaaebbbb');
  } finally { dispose(); }
});

test('guard stops a second writer and lets the owner, a merged branch and a stale claim through', () => {
  const { d, dispose } = ledger(); try {
    assert.equal(guard(d, { branch: 'p', owner: 'anyone' }).ok, true, 'unclaimed passes with a note');
    claim(d, { branch: 'p', owner: 'hc:t73', at: T0 });
    assert.equal(guard(d, { branch: 'p', owner: 'hc:t73', at: T1 }).ok, true);
    const no = guard(d, { branch: 'p', owner: 'conductor:A-2', at: T1 });
    assert.equal(no.ok, false);
    assert.equal(no.owner, 'hc:t73');
    assert.equal(isStale(who(d, 'p', LATE), LATE), true);
    assert.match(guard(d, { branch: 'p', owner: 'conductor:A-2', at: LATE }).note, /stale claim/);
    event(d, { branch: 'p', owner: 'hc:t73', kind: 'merged', commit: 'fd26a42f', at: T1 });
    assert.equal(guard(d, { branch: 'p', owner: 'conductor:A-2', at: T1 }).ok, true, 'a merged branch is released');
    assert.equal(claim(d, { branch: 'p', owner: 'new', at: LATE }).owner, 'new', 'a released branch can be claimed again');
  } finally { dispose(); }
});

test('the CLI exits 1 on a refused guard and 2 on a bad command', () => {
  const { d, dispose } = ledger(); try {
    const cli = (...a) => spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'stack.mjs'), ...a, '--dir', d], { encoding: 'utf8' });
    assert.equal(cli('claim', '--branch', 'p', '--owner', 'one').status, 0);
    const g = cli('guard', '--branch', 'p', '--owner', 'two');
    assert.equal(g.status, 1);
    assert.equal(JSON.parse(g.stdout).owner, 'one');
    assert.equal(cli('nope').status, 2);
    assert.deepEqual(JSON.parse(cli('peers', '--branch', 'p').stdout).children, []);
  } finally { dispose(); }
});
