// check-map.mjs against a fixture repo that holds its own map, with a neighbor repo for cross-repo anchors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tempRoot, makeRepo, write, git } from '../../../../tests/fixtures/make.mjs';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'check-map.mjs');
const SKILL = (id, extra = '') => `---
id: ${id}
title: Checkout
status: shipped
summary: Pay for the cart.
covers: [route:/checkout]
code:
  - path: src/checkout.js
    symbols: [renderCheckout]
    role: the page
  - repo: lib
    path: src/pay.js
    symbols: [chargeCard]
tests:
  - path: test/checkout.test.js
${extra}last_verified: 2026-10-01
---

# Checkout

Pay for the cart.

## Sub-features

- CART: the cart summary.

## How to get to it (user POV)

- Open /checkout.

## Driving it with a browser

Preconditions: signed in.

## Where to change it

- the page: src/checkout.js.

## Gotchas

- none
`;

let t, app, home;
before(() => {
  t = tempRoot();
  home = join(t.root, 'home');
  makeRepo(join(t.root, 'lib'), { remote: 'git@github.com:acme/lib.git', files: { 'src/pay.js': 'export const chargeCard = 1;\n' } });
  app = makeRepo(join(t.root, 'app'), {
    remote: 'git@github.com:acme/app.git',
    files: {
      'src/checkout.js': 'export const renderCheckout = 1;\n',
      'test/checkout.test.js': 'test\n',
      '.agents/factory-metadata/project.json': JSON.stringify({ version: 1, name: 'app', neighbors: [{ name: 'lib' }] }),
    },
  });
  const map = join(app, '.agents/skills/factory-features-app');
  write(join(map, 'design-authority.json'), { version: 1, repo: 'app', defaultDesignAuthority: null, implementationVerifier: 'factory-features-app' });
  write(join(map, 'SKILL.md'), '---\nname: factory-features-app\ndescription: test\n---\n');
  write(join(map, 'features/README.md'), '# Features\n\n- [Checkout](./checkout.md) pay\n');
  write(join(map, 'features/checkout.md'), SKILL('checkout'));
  write(join(map, 'scripts/inventory.mjs'), 'console.log(JSON.stringify({items:[{id:"route:/checkout",kind:"route",source:"src/checkout.js"}]}));\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'map');
});
after(() => t.cleanup());

const run = (...args) => {
  const r = spawnSync(process.execPath, [CHECK, '--cwd', app, ...args], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: home } });
  return { status: r.status, out: r.stdout + r.stderr };
};
const entry = () => join(app, '.agents/skills/factory-features-app/features/checkout.md');

test('a map inside the repo passes: own anchors and a neighbor anchor resolve', () => {
  const r = run('--json');
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.out).ok, true);
});

test('a broken own anchor fails, and names the file', () => {
  write(entry(), SKILL('checkout').replace('src/checkout.js\n    symbols', 'src/missing.js\n    symbols'));
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.out, /app:src\/missing\.js does not exist/);
  write(entry(), SKILL('checkout'));
});

test('a symbol that is gone from a neighbor anchor fails while the neighbor is on trunk', () => {
  write(join(t.root, 'lib/src/pay.js'), 'export const other = 1;\n');
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.out, /lib:src\/pay\.js no longer contains "chargeCard"/);
  write(join(t.root, 'lib/src/pay.js'), 'export const chargeCard = 1;\n');
});

test('an anchor naming an unknown repo fails', () => {
  write(entry(), SKILL('checkout').replace('repo: lib', 'repo: nowhere'));
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.out, /"nowhere" is neither this project nor one of its neighbors/);
  write(entry(), SKILL('checkout'));
});

test('an unlinked feature file and a wrong id fail', () => {
  write(join(app, '.agents/skills/factory-features-app/features/extra.md'), SKILL('checkout'));
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.out, /index does not link extra\.md/);
  assert.match(r.out, /id "checkout" does not match the filename/);
  rmSync(join(app, '.agents/skills/factory-features-app/features/extra.md'));
});

test('--pr audit via --changes flags a PR that deletes an anchored file', () => {
  const changes = join(t.root, 'changes.json');
  write(changes, [{ status: 'removed', path: 'src/checkout.js' }]);
  const r = run('--changes', changes);
  assert.equal(r.status, 1);
  assert.match(r.out, /deletes; code anchor breaks after merge/);
});

test('a missing map directory is an error', () => {
  const r = run('--map', join(t.root, 'nope'));
  assert.equal(r.status, 1);
  assert.match(r.out, /feature map directory does not exist/);
});

test('features/keys.json: a declared extra key is accepted, an undeclared one (a typo) still warns', () => {
  const keys = join(app, '.agents/skills/factory-features-app/features/keys.json');
  const withKeys = (extra) => SKILL('checkout').replace('---\n', `---\n${extra}\n`);
  write(entry(), withKeys('proto_recipe: proto/checkout.recipe\nproto_recipie: oops'));
  try {
    let r = run();
    assert.match(r.out, /unknown frontmatter key "proto_recipe"/);
    write(keys, { proto_recipe: 'replayable route through the design prototype' });
    r = run();
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /"proto_recipe"/);
    assert.match(r.out, /unknown frontmatter key "proto_recipie".*declare it in features\/keys\.json/);
    write(keys, { code: 'dup', verified_by: '' });
    r = run();
    assert.match(r.out, /"code" is already a core key/);
    assert.match(r.out, /"verified_by" needs a one-line meaning/);
    assert.equal(r.status, 1);
  } finally { rmSync(keys, { force: true }); write(entry(), SKILL('checkout')); }
});
