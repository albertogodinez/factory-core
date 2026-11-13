// bin/auto-update.mjs: the trunk-moved check, the copy-ready check, and the debounce lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trunkMoved, readyToCopy, repoInfo, runLocked, cleanEnv } from '../bin/auto-update.mjs';
import { makeRepo, git } from './fixtures/make.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), Z = '0'.repeat(40);

test('trunkMoved: a new commit on trunk counts; other refs and deletions do not', () => {
  assert.equal(trunkMoved(`${A} ${B} refs/heads/main\n`, 'main'), true);
  assert.equal(trunkMoved(`${Z} ${B} refs/heads/main\n`, 'main'), true);
  assert.equal(trunkMoved(`${A} ${Z} refs/heads/main\n`, 'main'), false);
  assert.equal(trunkMoved(`${A} ${B} refs/heads/lesson/x\n${A} ${B} HEAD\n`, 'main'), false);
  assert.equal(trunkMoved(`${A} ${B} refs/heads/trunk\n`, 'trunk'), true);
  assert.equal(trunkMoved('', 'main'), false);
});

test('readyToCopy: only a clean main checkout on trunk is copied from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-update-'));
  try {
    const repo = makeRepo(join(dir, 'src'), { remote: 'https://example.invalid/r.git' });
    const info = repoInfo(repo);
    assert.equal(info.trunk, 'main');
    assert.equal(readyToCopy(info.mainRoot, 'main'), '');
    writeFileSync(join(repo, 'untracked.txt'), 'x');
    assert.equal(readyToCopy(info.mainRoot, 'main'), '', 'untracked files are not copied by update');
    writeFileSync(join(repo, 'README.md'), 'draft\n');
    assert.match(readyToCopy(info.mainRoot, 'main'), /uncommitted/);
    git(repo, 'checkout', '-q', '--', 'README.md');
    git(repo, 'checkout', '-qb', 'feature');
    assert.match(readyToCopy(info.mainRoot, 'main'), /on feature, not main/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('repoInfo: a linked worktree resolves to its main checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-update-'));
  try {
    const repo = makeRepo(join(dir, 'src'));
    git(repo, 'worktree', 'add', '-qb', 'lesson/x', join(dir, 'wt'));
    assert.equal(repoInfo(join(dir, 'wt')).mainRoot, repoInfo(repo).mainRoot);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runLocked: a trigger during a run queues one more pass instead of a second worker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-update-'));
  try {
    let passes = 0, inner;
    const out = runLocked(dir, () => { passes++; if (passes === 1) inner = runLocked(dir, () => assert.fail('second worker ran')); });
    assert.equal(inner, 'queued');
    assert.equal(out, 'ran 2');
    assert.equal(existsSync(join(dir, 'auto-update.lock')), false);
    assert.equal(runLocked(dir, () => {}), 'ran 1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runLocked: a lock left by a crashed worker expires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-update-'));
  try {
    mkdirSync(join(dir, 'auto-update.lock'));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(dir, 'auto-update.lock'), old, old);
    assert.equal(runLocked(dir, () => {}), 'ran 1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cleanEnv drops the source repo variables the update must not inherit', () => {
  const e = cleanEnv({ GIT_DIR: '/x', GIT_INDEX_FILE: '/y', PATH: '/bin' });
  assert.deepEqual(e, { PATH: '/bin' });
});

test('the reference-transaction hook runs update --all for a trunk commit, not a branch commit', async () => {
  const { copyFileSync, readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
  const dir = mkdtempSync(join(tmpdir(), 'auto-update-'));
  try {
    const repo = makeRepo(join(dir, 'src'));
    mkdirSync(join(repo, 'bin')); mkdirSync(join(repo, '.githooks'));
    copyFileSync(join(ROOT, 'bin', 'auto-update.mjs'), join(repo, 'bin', 'auto-update.mjs'));
    copyFileSync(join(ROOT, '.githooks', 'reference-transaction'), join(repo, '.githooks', 'reference-transaction'));
    // A stand-in factory CLI that records the update it was asked for.
    writeFileSync(join(repo, 'bin', 'factory.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(dir, 'calls'))}, process.argv.slice(2).join(' ') + '\\n');\n`);
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'tools');
    const env = { ...cleanEnv(), FACTORY_HOME: join(dir, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const commit = (msg) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(repo, '.githooks')}`, 'commit', '-q', '--allow-empty', '-m', msg], { cwd: repo, env });
    const calls = () => { try { return readFileSync(join(dir, 'calls'), 'utf8'); } catch { return ''; } };
    const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 100)); } return pred(); };

    git(repo, 'checkout', '-qb', 'feature');
    commit('on a branch');
    git(repo, 'checkout', '-q', 'main');
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(calls(), '', 'a branch commit must not update');

    commit('on trunk');
    assert.ok(await waitFor(() => calls().includes('update --all'), 8000), `no update; log: ${(() => { try { return readFileSync(join(dir, 'home', 'auto-update.log'), 'utf8'); } catch { return '(none)'; } })()}`);
    // The worker logs after the update returns; let it finish before the directory goes.
    await waitFor(() => !existsSync(join(dir, 'home', 'auto-update.lock')), 5000);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
