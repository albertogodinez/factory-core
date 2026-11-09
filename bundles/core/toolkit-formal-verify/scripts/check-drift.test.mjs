import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = path.join(import.meta.dirname, 'check-drift.mjs');

// A throwaway toolkit root with one verify skill, and a sibling repo whose origin/main holds one covered file.
function fixture(covers) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'check-drift-'));
  const repo = path.join(base, 'app');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/toggle.ts'), 'export const userDisabledAfterForced = false;\n');
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'empty');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'toggle');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const root = path.join(base, 'toolkit');
  const skill = path.join(root, '.agents/skills/toolkit-verify-app-toggle');
  fs.mkdirSync(path.join(skill, 'model'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/repos.json'), JSON.stringify({ repos: [{ name: 'app', localPath: repo, primaryBranch: 'main', remote: {} }] }));
  for (const f of ['M.tla', 'M.cfg']) fs.writeFileSync(path.join(skill, 'model', f), '');
  const check = { id: 'no-jump', property: 'NoJump', rule: 'The pane keeps its layout.', model: 'model/M.tla', config: 'model/M.cfg', covers };
  fs.writeFileSync(path.join(skill, 'coverage.json'), JSON.stringify({ repo: 'app', syncCommit: git('rev-parse', 'HEAD'), checks: [check] }));
  return root;
}

const run = (root) => spawnSync(process.execPath, [SCRIPT, '--root', root, '--strict'], { encoding: 'utf8' });

test('a covered file that exists at the sync commit reads as in sync', () => {
  const r = run(fixture([{ path: 'src/toggle.ts', symbols: ['userDisabledAfterForced'] }]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /in sync toolkit-verify-app-toggle/);
});

// git log over a path that never existed prints nothing, which reads like no drift.
test('a covered path that does not exist reads as stale, not in sync', () => {
  const r = run(fixture([{ path: 'src/toggle.ts' }, { path: 'src/layout/toggle.ts' }]));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /stale {3}toolkit-verify-app-toggle/);
  assert.match(r.stdout, /src\/layout\/toggle\.ts: gone from trunk/);
});

test('a covered symbol that is gone reads as stale', () => {
  const r = run(fixture([{ path: 'src/toggle.ts', symbols: ['forcedChoiceByKeyRef'] }]));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no longer contains "forcedChoiceByKeyRef"/);
});
