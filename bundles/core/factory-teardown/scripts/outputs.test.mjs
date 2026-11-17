import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, utimesSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { outputs, cleanOutput } from './outputs.mjs';
import { tempRoot, makeRepo, git, write } from '../../../../tests/fixtures/make.mjs';

const LIFECYCLE = join(dirname(fileURLToPath(import.meta.url)), 'lifecycle.mjs');
const DAY = 24 * 3600000;
// Backdate a folder and everything directly in it, as an install or build that long ago would leave it.
const age = (dir, days) => { const t = (Date.now() - days * DAY) / 1000; for (const n of readdirSync(dir)) utimesSync(join(dir, n), t, t); utimesSync(dir, t, t); };

function fixture() {
  const t = tempRoot('factory-outputs-');
  const repo = makeRepo(join(t.root, 'repo'), { files: {
    '.gitignore': '/node_modules\npkgs/*/node_modules\nvendor/\ntarget\ndist\nbuild\n', 'package.json': '{}', 'rust/Cargo.toml': '[package]',
    'docs/build/index.md': '# tracked build folder', 'pkgs/a/package.json': '{}',
  } });
  git(repo, 'add', '-f', 'docs/build/index.md'); git(repo, 'commit', '-qm', 'tracked');
  const fill = (rel) => { write(join(repo, rel, 'x.bin'), 'x'.repeat(4096)); return join(repo, rel); };
  return { ...t, repo, fill };
}
const by = (r, repo, rel) => r.outputs.find(o => o.path === join(repo, rel));

test('finds named, git-ignored, untracked build output; idle ones are candidates, recent ones kept', () => {
  const f = fixture(); try {
    const nm = f.fill('node_modules'), target = f.fill('rust/target'), nested = f.fill('pkgs/a/node_modules');
    f.fill('rust/dist');                     // dist needs a package.json beside it
    f.fill('docs/build');                    // tracked: someone's source
    f.fill('src/node_modules');              // not ignored: may be someone's source
    mkdirSync(join(f.repo, 'vendor')); makeRepo(join(f.repo, 'vendor', 'other')); f.fill('vendor/other/node_modules'); // a nested checkout
    age(target, 30); age(nested, 30);
    const r = outputs({ root: f.repo, minBytes: 0 });
    assert.deepEqual(r.outputs.map(o => o.path).sort(), [nm, nested, target].sort(), JSON.stringify(r.outputs));
    assert.equal(by(r, f.repo, 'pkgs/a/node_modules').status, 'candidate', 'a workspace package is found too');
    assert.equal(by(r, f.repo, 'rust/target').status, 'candidate');
    assert.match(by(r, f.repo, 'rust/target').reason, /unused 30d/);
    assert.equal(by(r, f.repo, 'node_modules').status, 'kept', 'used today');
    assert.equal(outputs({ root: f.repo }).outputs.length, 0, 'under the 1 GB default nothing is reported');
  } finally { f.cleanup(); }
});

test('clean-output previews, deletes only a candidate, and refuses anything else', () => {
  const f = fixture(); try {
    const target = f.fill('rust/target'), nm = f.fill('node_modules'); age(target, 30);
    assert.equal(cleanOutput({ root: f.repo, path: target }).status, 'candidate');
    assert.ok(existsSync(target), 'preview deletes nothing');
    assert.equal(cleanOutput({ root: f.repo, path: target, apply: true }).status, 'removed');
    assert.ok(!existsSync(target)); assert.ok(existsSync(join(f.repo, 'rust', 'Cargo.toml')));
    assert.equal(cleanOutput({ root: f.repo, path: nm, apply: true }).status, 'kept', 'recently used');
    assert.ok(existsSync(nm));
    assert.throws(() => cleanOutput({ root: f.repo, path: join(f.repo, 'docs', 'build'), apply: true }), /not regenerable/);
    assert.throws(() => cleanOutput({ root: f.repo, path: join(f.repo, 'rust'), apply: true }), /not regenerable/);
    symlinkSync(nm, join(f.repo, 'pkgs', 'a', 'node_modules'));
    assert.throws(() => cleanOutput({ root: f.repo, path: join(f.repo, 'pkgs', 'a', 'node_modules'), apply: true }), /symlink/);
    const cli = spawnSync(process.execPath, [LIFECYCLE, 'clean-output', '--state-root', join(f.root, 'state'), '--cwd', f.repo, '--path', nm, '--apply'], { cwd: f.repo, encoding: 'utf8' });
    assert.equal(cli.status, 1, 'the CLI fails when it was asked to delete and did not');
    const list = spawnSync(process.execPath, [LIFECYCLE, 'outputs', '--state-root', join(f.root, 'state'), '--cwd', f.repo, '--min-gb', '0'], { cwd: f.repo, encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).outputs.map(o => o.kind), ['node_modules']);
  } finally { f.cleanup(); }
});
