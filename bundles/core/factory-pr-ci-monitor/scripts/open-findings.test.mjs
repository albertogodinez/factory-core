import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFindings } from './open-findings.mjs';

const bot = { author: 'copilot[bot]', author_type: 'Bot' };
const me = { author: 'me', author_type: 'User' };
const other = { author: 'pat', author_type: 'User' };
const c = (id, user, extra = {}) => ({ comment_id: id, ...user, path: 'a.js', line: 3, body: 'x', in_reply_to_id: null, thread_resolved: false, ...extra });
const issue = (id, user, body) => ({ id, user: { login: user.author, type: user.author_type }, body });

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
  const reviews = [{ review_id: 90, ...bot, body: 'See [a](https://h/o/r/pull/1#discussion_r11) and [b](https://h/o/r/pull/1#discussion_r12)' }];
  const comments = [c(11, bot), c(12, bot), c(13, me, { in_reply_to_id: 12 })];
  const out = openFindings({ comments, reviews, issueComments: [], self: 'me' });
  assert.deepEqual(out.open.map((f) => f.id), [11]);
});

test('a body-only bot review is open until the session posts a top-level comment naming it', () => {
  const reviews = [{ review_id: 91, ...bot, body: 'Overall this drops the retry.' }];
  assert.deepEqual(openFindings({ comments: [], reviews, issueComments: [], self: 'me' }).bodyOnly.map((r) => r.id), [91]);
  const answered = [issue(1, me, 'Re pullrequestreview-91: fixed')];
  assert.deepEqual(openFindings({ comments: [], reviews, issueComments: answered, self: 'me' }).bodyOnly, []);
});

test('a thread resolved on GitHub is not open', () => {
  const out = openFindings({ comments: [c(1, bot, { thread_resolved: true }), c(2, bot)], reviews: [], issueComments: [], self: 'me' });
  assert.deepEqual(out.open.map((f) => f.id), [2]);
});
