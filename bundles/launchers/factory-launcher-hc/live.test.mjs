import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveTags } from './live.mjs';

test('liveTags lists the factory.tag of each live terminal', () => {
  const fake = (args) => (args[0] === 'ls'
    ? { terminals: [{ address: 't1', state: 'live' }, { address: 't2', state: 'live' }, { address: 't3', state: 'exited' }] }
    : { t1: { labels: { 'factory.tag': 'triage:/r/a' } }, t2: { labels: {} }, t3: { labels: { 'factory.tag': 'triage:/r/c' } } }[args[1]]);
  assert.deepEqual(liveTags(fake), ['triage:/r/a'], 'an untagged or finished terminal is not a live session');
  assert.throws(() => liveTags(() => null), /hc ls failed/, 'no answer is an error, so the caller falls back to the clock');
});

test('an exact tag uses one filtered listing and requires a live terminal', () => {
  const tag = 'conductor:ticket:work:1';
  const get = (state) => (args) => {
    assert.deepEqual(args, ['ls', '--label', `factory.tag=${tag}`]);
    return { terminals: [{ state }] };
  };
  assert.deepEqual(liveTags(get('live'), tag), [tag]);
  assert.deepEqual(liveTags(get('exited'), tag), []);
});
