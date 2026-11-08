import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempRoot, write } from '../../../../tests/fixtures/make.mjs';
import { frontmatter, scan, rank } from './routes.mjs';

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), 'routes.mjs');

test('frontmatter reads plain, quoted and folded values', () => {
  const fm = frontmatter("---\nname: a\ndescription: 'Don''t panic: it works'\nother: >\n  line one\n  line two\ndisable-model-invocation: true\n---\nbody");
  assert.equal(fm.name, 'a');
  assert.equal(fm.description, "Don't panic: it works");
  assert.equal(fm.other, 'line one line two');
  assert.equal(fm['disable-model-invocation'], 'true');
});

test('the table is built from the skills on disk, and a new skill appears with no map edit', () => {
  const t = tempRoot();
  try {
    write(join(t.root, 'deploy-check/SKILL.md'), '---\nname: deploy-check\ndescription: Check whether a commit is deployable before merging a Dockerfile change.\n---\n');
    write(join(t.root, 'watch-ci/SKILL.md'), '---\nname: watch-ci\ndescription: Watch pull request checks until they finish.\n---\n');
    write(join(t.root, 'no-skill-here/README.md'), 'x');
    assert.deepEqual(scan([t.root]).skills.map((s) => s.name), ['deploy-check', 'watch-ci']);
    assert.equal(rank(scan([t.root]).skills, 'is my Dockerfile change deployable')[0].name, 'deploy-check');
    write(join(t.root, 'new-one/SKILL.md'), '---\nname: new-one\ndescription: Rotate credentials for the staging cluster.\n---\n');
    assert.equal(rank(scan([t.root]).skills, 'rotate staging credentials')[0].name, 'new-one');
    assert.deepEqual(rank(scan([t.root]).skills, 'zzz qqq'), []);
  } finally { t.cleanup(); }
});

test('CLI: --query prints ranked skills, --json is parseable', () => {
  const t = tempRoot();
  try {
    write(join(t.root, 'watch-ci/SKILL.md'), '---\nname: watch-ci\ndescription: Watch pull request checks until they finish.\n---\n');
    const r = spawnSync(process.execPath, [ROUTES, '--dir', t.root, '--query', 'watch checks', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout)[0].name, 'watch-ci');
  } finally { t.cleanup(); }
});
