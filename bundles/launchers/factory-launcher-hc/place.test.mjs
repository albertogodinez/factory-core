import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSpace, placeArgs, liveTerminals } from './place.mjs';

test('pickSpace: the space of a terminal in the repo, else the busiest, else none', () => {
  const ts = [
    { cwd: '/r/other', space: 'sp-a' }, { cwd: '/r/other2', space: 'sp-a' },
    { cwd: '/home', foregroundCwd: '/r/core/.worktrees/x', space: 'sp-core' },
    { cwd: '/r/core', space: null },
  ];
  assert.deepEqual(pickSpace('/r/core', ts), { space: 'sp-core', why: 'repo' }, 'a worktree of the repo counts');
  assert.deepEqual(pickSpace('/r/cor', ts), { space: 'sp-a', why: 'busiest' }, 'a name prefix is not the repo');
  assert.equal(pickSpace('/r/core', [{ cwd: '/r/core', space: null }]).space, null, 'Herdr closed: nowhere');
  assert.deepEqual(placeArgs('/r/core', ts), ['--label', 'herdr.space=sp-core']);
  assert.deepEqual(placeArgs('/r/core', []), []);
});

test('liveTerminals reads each placed terminal\'s labels through hc get', () => {
  const fake = (args) => (args[0] === 'ls'
    ? { terminals: [{ address: 't1', cwd: '/a', where: 'a / 1' }, { address: 't2', cwd: '/b' }] }
    : { cwd: '/a', foreground: { cwd: '/a/sub' }, labels: { 'herdr.space': 'sp1' } });
  assert.deepEqual(liveTerminals(fake), [{ cwd: '/a', foregroundCwd: '/a/sub', space: 'sp1' }], 'an unplaced terminal is skipped');
  assert.deepEqual(liveTerminals(() => null), [], 'no hc: no terminals');
});
