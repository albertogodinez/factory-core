// Persona resolution, rule merging, gates and pack hooks for factory-review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, tempRoot, write } from '../../../../tests/fixtures/make.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: 'utf8' });

const tsDiff = 'diff --git a/src/a.tsx b/src/a.tsx\n--- a/src/a.tsx\n+++ b/src/a.tsx\n@@ -1,1 +1,2 @@\n x\n+const y = 1;\n';
const pyDiff = tsDiff.replaceAll('src/a.tsx', 'app/a.py');

let t, repo, pack, out;
before(() => {
  t = tempRoot('review-');
  repo = makeRepo(join(t.root, 'proj'), {
    files: { '.agents/factory-metadata/project.json': { version: 1, name: 'proj', review: { personas: ['react-patterns', 'acme-conv', 'ghost-conv'] } } },
  });
  pack = join(t.root, 'factory-review-acme');
  write(join(pack, 'personas/acme-conv.md'), '---\nname: acme-conv\ndescription: Acme conventions.\n---\nBody\n');
  write(join(pack, 'rules/acme-conv/one.md'), '---\ntitle: One\nrepos: [cross-repo]\n---\nRule one\n');
  write(join(pack, 'rules/acme-conv/other-project-only.md'), '---\ntitle: Two\nrepos: [somewhere-else]\n---\nRule two\n');
  write(join(pack, 'rules/no-comments/keep-only-comments-the-code-cannot-carry.md'), '---\ntitle: Override\nrepos: [cross-repo]\n---\nPACK COPY\n');
  write(join(pack, 'pack.json'), {
    context: [{ name: 'note', whenPersonas: ['acme-conv'], command: ['node', '-e', "require('fs').writeFileSync(process.argv[1], 'x')", '{RUN}/note.md'], output: 'note.md', consumers: ['acme-conv'] }],
  });
  out = join(t.root, 'run');
  write(join(t.root, 'tsx.diff'), tsDiff);
  write(join(t.root, 'py.diff'), pyDiff);
});
after(() => t.cleanup());

function personas(diff) {
  const r = run('resolve-personas.mjs', ['--cwd', repo, '--run', out, '--diff', join(t.root, diff), '--packs', pack]);
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(JSON.parse(r.stdout).personas.map((p) => [p.name, p]));
}

test('finds a core persona, a pack persona, and reports a missing one as a gap', () => {
  const p = personas('tsx.diff');
  assert.equal(p.general.status, 'dispatch');
  assert.equal(p['react-patterns'].status, 'dispatch');
  assert.equal(p['react-patterns'].pack, 'core');
  assert.ok(p['react-patterns'].ruleCount > 10);
  assert.equal(p['acme-conv'].status, 'dispatch');
  assert.ok(p['acme-conv'].personaFile.endsWith(join('factory-review-acme', 'personas', 'acme-conv.md')));
  assert.equal(p['acme-conv'].ruleCount, 1);
  assert.equal(p['ghost-conv'].status, 'gap');
  assert.match(readFileSync(p['acme-conv'].rulesFile, 'utf8'), /Rule one/);
});

test('a language gate skips react-patterns on a Python-only diff', () => {
  const p = personas('py.diff');
  assert.equal(p['react-patterns'].status, 'skipped');
  assert.match(p['react-patterns'].reason, /gate not met/);
  assert.equal(p['acme-conv'].status, 'dispatch');
});

test('with no personas configured, the default cross-cutting set applies behind its gates', () => {
  const bare = makeRepo(join(t.root, 'bare'), {});
  const r = run('resolve-personas.mjs', ['--cwd', bare, '--run', join(t.root, 'run2'), '--diff', join(t.root, 'py.diff')]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.personaSource, 'default');
  const by = Object.fromEntries(j.personas.map((p) => [p.name, p.status]));
  assert.equal(by.general, 'dispatch');
  assert.equal(by['fix-root-causes'], 'dispatch');
  assert.equal(by['test-behavior'], 'skipped');
  assert.equal(by['no-comments'], 'skipped');
  assert.equal(by['react-patterns'], undefined);
});

test('a pack rule file replaces the core file of the same name, and repos: scoping applies', () => {
  const c = run('compile-rules.mjs', ['no-comments', 'proj', join(t.root, 'compiled'), '--packs', pack]);
  assert.equal(c.status, 0, c.stderr);
  const text = readFileSync(join(t.root, 'compiled/compiled-no-comments.md'), 'utf8');
  assert.match(text, /PACK COPY/);
  const a = run('compile-rules.mjs', ['acme-conv', 'proj', join(t.root, 'compiled'), '--packs', pack]);
  assert.match(a.stderr, /compiled 1 of 2 rules/);
});

test('compile-rules works for general-purpose personas without any pack', () => {
  for (const persona of ['fix-root-causes', 'react-patterns']) {
    const c = run('compile-rules.mjs', [persona, 'proj', join(t.root, 'compiled')]);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stderr, /compiled [1-9]\d* of/);
  }
});

test('run-hooks runs a pack hook for a dispatched persona and reports its output', () => {
  personas('tsx.diff');
  const r = run('run-hooks.mjs', ['--run', out, '--diff', join(t.root, 'tsx.diff'), '--repo-path', repo, '--head', 'abc', '--packs', pack]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.hooks.length, 1);
  assert.equal(j.hooks[0].status, 'ok');
  assert.deepEqual(j.hooks[0].consumers, ['acme-conv']);
});

test('check-persona-sources reports a configured persona that no pack provides', () => {
  const r = run('check-persona-sources.mjs', ['--cwd', repo, '--packs', pack]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /persona 'ghost-conv' is missing: persona file, rules directory/);
  assert.match(r.stderr, /OK: persona 'acme-conv'/);
});
