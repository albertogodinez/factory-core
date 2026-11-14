import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFindings } from './open-findings.mjs';

const bot = { login: 'copilot', type: 'Bot' };
const me = { login: 'me', type: 'User' };
const other = { login: 'pat', type: 'User' };
const c = (id, user, extra = {}) => ({ id, user, path: 'a.js', line: 3, body: 'x', ...extra });

test('a bot thread with no reply is open, and a replied one is not', () => {
  const out = openFindings({ comments: [c(1, bot), c(2, bot), c(3, me, { in_reply_to_id: 2 })], reviews: [], issueComments: [], self: 'me' });
  assert.deepEqual(out.open.map((f) => f.id), [1]);
});

test('the session account\'s own unreplied comment is open too', () => {
  const out = openFindings({ comments: [c(5, me)], reviews: [], issueComments: [], self: 'me' });
  assert.deepEqual(out.open.map((f) => f.id), [5]);
});

test('another human\'s comment is listed for the user, never as open work', () => {
  const out = openFindings({ comments: [c(7, other)], reviews: [], issueComments: [], self: 'me' });
  assert.deepEqual(out.open, []);
  assert.deepEqual(out.others.map((f) => f.id), [7]);
});

test('each discussion link in a bot review body is its own finding, open until that thread has a reply', () => {
  const reviews = [{ id: 90, user: bot, body: 'See [a](https://h/o/r/pull/1#discussion_r11) and [b](https://h/o/r/pull/1#discussion_r12)' }];
  const comments = [c(11, bot), c(12, bot), c(13, me, { in_reply_to_id: 12 })];
  const out = openFindings({ comments, reviews, issueComments: [], self: 'me' });
  assert.deepEqual(out.open.map((f) => f.id), [11]);
});

test('a body-only bot review is open until the session posts a top-level comment naming it', () => {
  const reviews = [{ id: 91, user: bot, body: 'Overall this drops the retry.' }];
  assert.deepEqual(openFindings({ comments: [], reviews, issueComments: [], self: 'me' }).bodyOnly.map((r) => r.id), [91]);
  const answered = [{ id: 1, user: me, body: 'Re pullrequestreview-91: fixed' }];
  assert.deepEqual(openFindings({ comments: [], reviews, issueComments: answered, self: 'me' }).bodyOnly, []);
});
