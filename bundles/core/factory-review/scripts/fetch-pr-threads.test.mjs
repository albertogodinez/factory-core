// fetch-pr-threads.mjs against a stand-in `gh` that answers from a scenario file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempRoot, write } from '../../../../tests/fixtures/make.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'fetch-pr-threads.mjs');
const M = '<!-- cc-test {"kind":"finding"} -->';
const user = (login, __typename = 'User') => ({ login, __typename });
const gc = (id, author, body, reply) => ({ databaseId: id, url: `https://x/c${id}`, body, path: 'a.ts', line: id, originalLine: id, diffHunk: '@@', createdAt: 'c', author, replyTo: reply ? { databaseId: reply } : null });
const graph = { data: { repository: { pullRequest: {
  number: 7, title: 'T', url: 'https://x/pr/7', updatedAt: 'u', mergedAt: null, headRefOid: 'abc', author: user('dep', 'Bot'),
  reviews: { pageInfo: { hasNextPage: false }, nodes: [
    { databaseId: 100, author: user('alice'), body: `rev ${M}`, state: 'COMMENTED', submittedAt: 's', comments: { pageInfo: { hasNextPage: false }, nodes: [gc(1, user('alice'), `top ${M}`), gc(2, user('bob'), 'reply', 1), gc(3, user('copilot', 'Bot'), 'again', 2), gc(4, null, 'orphan', 99)] } },
    { databaseId: 101, author: null, body: null, state: 'APPROVED', submittedAt: 's2', comments: { pageInfo: { hasNextPage: false }, nodes: [] } },
  ] },
} } } };
const threads = [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 1 }] } }, { isResolved: false, comments: { nodes: [{ databaseId: 4 }] } }] } } } } }];
const rc = (id, login, type, body, reply, rev) => ({ id, html_url: `https://x/c${id}`, path: 'a', line: id, original_line: id, diff_hunk: 'h', body, created_at: 'c', user: { login, type }, pull_request_review_id: rev, ...(reply ? { in_reply_to_id: reply } : {}) });
const scenario = {
  host: 'ghe.example', graph, threads,
  restComments: [[rc(1, 'alice', 'User', `top ${M}`, null, 100)], [rc(2, 'bob', 'User', 'r', 1, 100), rc(3, 'copilot[bot]', 'Bot', 'r2', 2, 100)]],
  restReviews: [[{ id: 100, user: { login: 'alice', type: 'User' }, state: 'COMMENTED', body: 'rev', submitted_at: 's' }]],
};

const FAKE = `
import { readFileSync } from 'node:fs';
const sc = JSON.parse(readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
const a = process.argv.slice(2), all = a.join(' ');
if (process.env.GH_HOST !== sc.host) { console.error('wrong host ' + process.env.GH_HOST); process.exit(1); }
if (sc.fail) { console.error('boom'); process.exit(4); }
if (a[0] === 'api' && a[1] === 'graphql') process.stdout.write(JSON.stringify(all.includes('reviewThreads') ? sc.threads : sc.graph));
else if (/pulls\\/\\d+\\/comments/.test(all)) process.stdout.write(JSON.stringify(sc.restComments));
else if (/pulls\\/\\d+\\/reviews/.test(all)) process.stdout.write(JSON.stringify(sc.restReviews));
else { console.error('no answer ' + all); process.exit(1); }
`;

function setup(sc = scenario) {
  const t = tempRoot('fpt-');
  const bin = join(t.root, 'bin');
  write(join(bin, 'fake-gh.mjs'), FAKE);
  write(join(t.root, 'sc.json'), sc);
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, FACTORY_GH_BIN: process.execPath, FACTORY_GH_BIN_ARGS: JSON.stringify([join(bin, 'fake-gh.mjs')]), FAKE_GH_SCENARIO: join(t.root, 'sc.json'), ...env },
  });
  return { t, run };
}

test('graphql path: threads, roots, resolution and bot logins', () => {
  const { t, run } = setup();
  try {
    const r = run(['ghe.example', 'acme/repo', '7']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.pr, { number: 7, title: 'T', url: 'https://x/pr/7', author: 'dep[bot]', updated_at: 'u', merged_at: null, head_ref_oid: 'abc' });
    assert.deepEqual(j.reviews.map((x) => [x.review_id, x.author, x.author_type, x.ours]), [[100, 'alice', 'User', false], [101, null, 'User', false]]);
    const c = Object.fromEntries(j.comments.map((x) => [x.comment_id, x]));
    assert.equal(c[3].author, 'copilot[bot]');
    assert.equal(c[3].author_type, 'Bot');
    assert.deepEqual([c[2].root_id, c[3].root_id, c[3].parent_author, c[4].root_id], [1, 1, 'bob', 4]);
    assert.deepEqual([c[1].thread_resolved, c[2].thread_resolved, c[4].thread_resolved], [true, true, false]);
    assert.equal(c[1].ours, false);
    assert.equal(c[1].in_reply_to_id, null);
  } finally { t.cleanup(); }
});

test('marker text sets ours and ours_kind', () => {
  const { t, run } = setup();
  try {
    const j = JSON.parse(run(['ghe.example', 'acme/repo', '7', 'cc-test']).stdout);
    assert.deepEqual([j.reviews[0].ours, j.reviews[0].ours_kind, j.reviews[1].ours], [true, 'finding', false]);
    const c = Object.fromEntries(j.comments.map((x) => [x.comment_id, x]));
    assert.deepEqual([c[1].ours, c[1].ours_kind, c[2].ours, c[2].ours_kind, c[2].parent_ours], [true, 'finding', false, null, true]);
  } finally { t.cleanup(); }
});

test('FETCH_PR_THREADS_FORCE_REST uses the REST endpoints and the same record shape', () => {
  const { t, run } = setup();
  try {
    const r = run(['ghe.example', 'acme/repo', '7'], { FETCH_PR_THREADS_FORCE_REST: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, />100 reviews or comments on acme\/repo#7; using paginated REST/);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.comments.map((x) => [x.comment_id, x.root_id, x.review_state, x.author_type]), [[1, 1, 'COMMENTED', 'User'], [2, 1, 'COMMENTED', 'User'], [3, 1, 'COMMENTED', 'Bot']]);
    assert.equal(j.comments[2].author, 'copilot[bot]');
  } finally { t.cleanup(); }
});

test('usage and gh failures exit 1', () => {
  const { t, run } = setup();
  try {
    assert.equal(run(['only', 'two']).status, 1);
    const bad = setup({ ...scenario, fail: true });
    try {
      const r = bad.run(['ghe.example', 'acme/repo', '7']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /boom/);
    } finally { bad.t.cleanup(); }
  } finally { t.cleanup(); }
});
