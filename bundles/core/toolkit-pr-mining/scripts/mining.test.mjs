import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixtures, write } from '../../../../tests/fixtures/make.mjs';
import { inScope } from './scope.mjs';
import { classify } from './classify-interlocutor.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const scope = (f, cwd, ...args) => spawnSync(process.execPath, [join(DIR, 'scope.mjs'), '--cwd', cwd, ...args], {
  encoding: 'utf8', env: { ...process.env, AI_TOOLKIT_HOME: f.home, HOME: f.home },
});

test('scope: cohort, bots floor, paths and marker come from project.json', () => {
  const f = makeFixtures();
  try {
    const p = join(f.root, 'project');
    write(join(p, '.ai-toolkit/project.json'), {
      version: 1, name: 'project', neighbors: [{ name: 'lib' }],
      pr: { commentMarker: { mode: 'text', text: 'acme-bot' } },
      mining: { cohort: ['ann', 'bo'], loginSuffix: '_corp', bots: { mine: true, minOccurrenceUnits: 2, minVerified: 3 }, paths: { include: ['src', 'app/'], exclude: ['src/gen/'] } },
    });
    const r = scope(f, p);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.deepEqual(s.queryLogins, ['ann_corp', 'bo_corp']);
    assert.deepEqual(s.bots, { mine: true, minOccurrenceUnits: 5, minVerified: 3 }); // raised to the floor, 3 kept
    assert.deepEqual(s.paths.include, ['src/', 'app/']);
    assert.equal(s.wholeRepo, false);
    assert.equal(s.canonicalRepo, 'acme/project');
    assert.equal(s.ghHost, 'github.com');
    assert.equal(s.marker, 'acme-bot');
    assert.match(s.stateRoot, /\.ai-toolkit\/state\/main$/);
    assert.equal(s.notes.length, 1);
    // flags replace for this run
    const o = JSON.parse(scope(f, p, '--reviewers', 'zed', '--no-mine-bots').stdout);
    assert.deepEqual(o.cohort, ['zed']);
    assert.equal(o.bots.mine, false);
  } finally { f.cleanup(); }
});

test('scope: a neighbor uses its own config; no mining block is exit 1 with the fix', () => {
  const f = makeFixtures();
  try {
    const p = join(f.root, 'project');
    let r = scope(f, p);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no "mining" block/);
    write(join(f.root, 'lib/.ai-toolkit/project.json'), { version: 1, mining: { cohort: ['cy'] } });
    r = scope(f, p, '--neighbor', 'lib');
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.name, 'lib');
    assert.equal(s.wholeRepo, true);
    assert.equal(s.trunk, 'develop');
  } finally { f.cleanup(); }
});

test('scope: a fork mines its upstream; a workspace registry has no mining', () => {
  const f = makeFixtures();
  try {
    const p = join(f.root, 'project');
    write(join(p, '.ai-toolkit/project.json'), { version: 1, remote: { host: 'github.com', slug: 'me/project', upstream: 'acme/project' }, mining: { cohort: ['ann'] } });
    assert.equal(JSON.parse(scope(f, p).stdout).canonicalRepo, 'acme/project');
    assert.equal(scope(f, join(f.root, 'hub')).status, 1);
  } finally { f.cleanup(); }
});

test('inScope matches on directory boundaries and exclude wins', () => {
  const paths = { include: ['frontend/'], exclude: ['frontend/gen/'] };
  assert.equal(inScope('frontend/src/a.tsx', paths), true);
  assert.equal(inScope('frontendish/a.tsx', paths), false);
  assert.equal(inScope('openwiki/frontend/a.tsx', paths), false);
  assert.equal(inScope('frontend/gen/x.ts', paths), false);
  assert.equal(inScope('../frontend/a.ts', paths), false);
  assert.equal(inScope('a/b.ts', { include: [], exclude: [] }), true);
});

test('classify: marker beats everything, bots open findings, replies to bots steer', () => {
  const threads = {
    pr: { author: 'me_corp' },
    comments: [
      { comment_id: 1, author: 'x', author_type: 'User', in_reply_to_id: null, ours: true },
      { comment_id: 2, author: 'b[bot]', author_type: 'Bot', in_reply_to_id: null },
      { comment_id: 3, author: 'me_corp', author_type: 'User', in_reply_to_id: 2, parent_author_type: 'Bot' },
      { comment_id: 4, author: 'peer', author_type: 'User', in_reply_to_id: null },
      { comment_id: 5, author: 'peer', author_type: 'User', in_reply_to_id: 1, parent_ours: true },
    ],
  };
  assert.deepEqual(classify(threads, 'me', '_corp').map((c) => c.interlocutor), ['toolkit-posted', 'bot-finding', 'agent-steering', 'self-defense', 'agent-steering']);
  assert.deepEqual(classify({ ...threads, pr: { author: 'other' } }, 'me', '_corp').map((c) => c.interlocutor)[3], 'peer-review');
});

test('learn dir: <stateRoot>/pr-mining/learn by default; mining.learnDir (repo-relative) wins, with no cohort needed', () => {
  const f = makeFixtures();
  try {
    const p = join(f.root, 'project');
    write(join(p, '.ai-toolkit/project.json'), { version: 1, name: 'project', mining: { cohort: ['ann'] } });
    const d = scope(f, p, '--learn-dir');
    assert.equal(d.status, 0, d.stderr);
    assert.match(d.stdout.trim(), /\.ai-toolkit\/state\/main\/pr-mining\/learn$/);
    assert.equal(JSON.parse(scope(f, p).stdout).learnDir, d.stdout.trim());
    // A durable ledger: learnDir alone, without a cohort, is enough for --learn-dir.
    write(join(p, '.ai-toolkit/project.json'), { version: 1, name: 'project', mining: { learnDir: 'decisions/pr-mining-learn' } });
    const w = scope(f, p, '--learn-dir');
    assert.equal(w.status, 0, w.stderr);
    assert.equal(w.stdout.trim(), join(p, 'decisions', 'pr-mining-learn'));
  } finally { f.cleanup(); }
});
