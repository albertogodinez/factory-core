// post-comment.mjs against a recording fake `gh` (tests/fixtures/fake-gh.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixtures, write } from '../../../../tests/fixtures/make.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POST = join(HERE, 'post-comment.mjs');
const FAKE = join(HERE, '..', '..', '..', '..', 'tests', 'fixtures', 'fake-gh.mjs');
const BANNERS = { reply: '> BOT reply', annotation: '> BOT note', review: '> BOT review' };
const PATCH = '@@ -1,3 +1,4 @@\n line1\n-old2\n+new2\n+new3\n line3';

let fx, log, scenario, body;
before(() => {
  fx = makeFixtures();
  log = join(fx.root, 'gh.log'); scenario = join(fx.root, 'scenario.json'); body = join(fx.root, 'body.md');
  writeFileSync(body, 'The body, with `backticks` and ${dollars}.\n');
});
after(() => fx.cleanup());

function setMarker(marker, extra = {}) {
  const p = join(fx.root, 'project/.agents/factory-metadata/project.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const next = { ...c, pr: marker === undefined ? undefined : { commentMarker: marker }, ...extra };
  if (marker === undefined) delete next.pr;
  write(p, next);
}
function post(args, { cwd = join(fx.root, 'project'), sc = {} } = {}) {
  rmSync(log, { force: true });
  writeFileSync(scenario, JSON.stringify({
    pr: { head: 'abc123', node_id: 'PR_1', state: 'open' },
    files: [[{ filename: 'src/a.ts', patch: PATCH }], [{ filename: 'img.png' }]],
    reviews: [], threads: [{ id: 'T_1', comments: { nodes: [{ databaseId: 55 }] } }], ...sc,
  }));
  const r = spawnSync(process.execPath, [POST, '--body-file', body, '--model', 'm-1', ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, FACTORY_GH_BIN: process.execPath, FACTORY_GH_BIN_ARGS: JSON.stringify([FAKE]), FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: log,
      FACTORY_HOME: fx.home, FACTORY_CONFIG: '', POST_COMMENT_TS: '2026-01-01T00:00:00Z' },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { ...r, calls, writes: calls.filter((c) => c.argv.includes('POST') || /mutation/.test(c.argv.join(' '))) };
}

test('marker off: a reply posts the body unchanged to the project host', () => {
  setMarker({ mode: 'off' });
  const r = post(['--pr', '7', '--kind', 'reply', '--in-reply-to', '55']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'https://example.test/comment/1');
  assert.equal(r.writes.length, 1);
  const w = r.writes[0];
  assert.equal(w.host, 'github.com');
  assert.deepEqual(w.argv.slice(0, 4), ['api', '-X', 'POST', 'repos/acme/project/pulls/7/comments/55/replies']);
  assert.ok(w.argv.includes(`body=@${readFileSync(body, 'utf8')}`));
});

test('banner mode: marker line, the banner for the kind, a blank line, then the body', () => {
  setMarker({ mode: 'banner', text: 'test-marker', banner: BANNERS });
  const r = post(['--pr', '7', '--kind', 'annotation', '--path', 'src/a.ts', '--line', '3']);
  assert.equal(r.status, 0, r.stderr);
  const b = r.writes[0].argv.find((x) => x.startsWith('body=@')).slice(6);
  assert.equal(b, '<!-- test-marker {"v":1,"kind":"annotation","model":"m-1","pr":7,"path":"src/a.ts","line":3,"head":"abc123","ts":"2026-01-01T00:00:00Z"} -->\n> BOT note\n\n' + readFileSync(body, 'utf8'));
  assert.ok(r.writes[0].argv.includes('commit_id=abc123'));
});

test('text mode: marker only, no banner', () => {
  setMarker({ mode: 'text', text: 'test-marker' });
  const r = post(['--pr', '7', '--kind', 'reply', '--in-reply-to', '55']);
  const b = r.writes[0].argv.find((x) => x.startsWith('body=@')).slice(6);
  assert.match(b, /^<!-- test-marker \{"v":1,"model":"m-1","pr":7,"in_reply_to":55,"head":"abc123","ts":"[^"]+"\} -->\n\nThe body/);
});

test('an unconfigured marker policy is refused, and nothing is posted', () => {
  setMarker(undefined);
  const r = post(['--pr', '7', '--kind', 'reply', '--in-reply-to', '55']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no comment-marker policy/);
  assert.equal(r.writes.length, 0);
});

test('zero-config: posting is refused without explicit context', () => {
  const r = post(['--repo', 'me/zero-config', '--host', 'example.org', '--pr', '7', '--kind', 'reply', '--in-reply-to', '55'], { cwd: join(fx.root, 'zero-config') });
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 0, 'refused before any gh call');
});

test('writeAllowed false: refused, then allowed once the user confirms with --yes', () => {
  setMarker({ mode: 'off' }, { writeAllowed: false });
  try {
    const r = post(['--pr', '7', '--kind', 'reply', '--in-reply-to', '55']);
    assert.equal(r.status, 1); assert.match(r.stderr, /refusing to post: writeAllowed is false/);
    assert.equal(r.calls.length, 0);
    assert.equal(post(['--pr', '7', '--kind', 'reply', '--in-reply-to', '55', '--yes']).status, 0);
  } finally { setMarker({ mode: 'off' }, { writeAllowed: undefined }); }
});

test('--host overrides detection', () => {
  setMarker({ mode: 'off' });
  const r = post(['--pr', '7', '--kind', 'reply', '--in-reply-to', '55', '--host', 'git.example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.every((c) => c.host === 'git.example.com'));
});

test('a line outside the diff is rejected before posting', () => {
  setMarker({ mode: 'off' });
  const r = post(['--pr', '7', '--kind', 'annotation', '--path', 'src/a.ts', '--line', '2', '--side', 'LEFT', '--start-line', '1']);
  assert.equal(r.status, 0, 'LEFT 1-2 are in the diff');
  const bad = post(['--pr', '7', '--kind', 'annotation', '--path', 'src/a.ts', '--line', '9']);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /line 9 of src\/a.ts is not in the PR diff on the RIGHT side/);
  assert.equal(bad.writes.length, 0);
  const nopatch = post(['--pr', '7', '--kind', 'annotation', '--path', 'img.png', '--line', '1']);
  assert.match(nopatch.stderr, /no patch for img.png/);
  const notInPr = post(['--pr', '7', '--kind', 'annotation', '--path', 'other.ts', '--line', '1']);
  assert.match(notInPr.stderr, /other.ts is not changed by PR #7/);
});

test('the single-pending-review 422 falls back to the pending review', () => {
  setMarker({ mode: 'off' });
  const sc = { rest422: true, reviews: [{ state: 'COMMENTED', node_id: 'R_0' }, { state: 'PENDING', node_id: 'R_9' }] };
  const reply = post(['--pr', '7', '--kind', 'reply', '--in-reply-to', '55'], { sc });
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(reply.stdout.trim(), 'https://example.test/pending-reply');
  const m = reply.writes.at(-1).argv;
  assert.ok(m.includes('r=R_9') && m.includes('t=T_1'));
  const note = post(['--pr', '7', '--kind', 'annotation', '--path', 'src/a.ts'], { sc });
  assert.equal(note.stdout.trim(), 'https://example.test/pending-thread');
  assert.match(note.writes.at(-1).argv.join(' '), /subjectType:FILE/);
});

test('review: starts a pending review when none exists, and never submits one', () => {
  setMarker({ mode: 'off' });
  const r = post(['--pr', '7', '--kind', 'review', '--path', 'src/a.ts', '--line', '3']);
  assert.equal(r.status, 0, r.stderr);
  const q = r.writes.map((w) => w.argv.join(' '));
  assert.match(q[0], /addPullRequestReview\(/); assert.match(q[1], /addPullRequestReviewThread\(.*r=PRR_new/s);
  assert.ok(!q.some((x) => /submitPullRequestReview|event/.test(x)));
});

test('--dry-run makes only GET requests, even with nothing configured', () => {
  setMarker(undefined);
  const r = post(['--pr', '7', '--kind', 'review', '--path', 'src/a.ts', '--line', '3', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.writes.length, 0);
  assert.match(r.stderr, /a real post would be refused/);
  assert.match(r.stderr, /addPullRequestReviewThread/);
});

test('a body that already carries the marker is refused', () => {
  setMarker({ mode: 'banner', text: 'test-marker', banner: BANNERS });
  const own = join(fx.root, 'marked.md'); writeFileSync(own, '<!-- test-marker {} -->\nhi\n');
  const r = spawnSync(process.execPath, [POST, '--body-file', own, '--pr', '7', '--kind', 'reply', '--in-reply-to', '55'], {
    cwd: join(fx.root, 'project'), encoding: 'utf8', env: { ...process.env, FACTORY_HOME: fx.home, FACTORY_CONFIG: '', FACTORY_GH_BIN: process.execPath, FACTORY_GH_BIN_ARGS: JSON.stringify([FAKE]), FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: log },
  });
  assert.equal(r.status, 1); assert.match(r.stderr, /already contains test-marker/);
});
