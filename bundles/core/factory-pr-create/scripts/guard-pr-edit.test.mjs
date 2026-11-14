import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard-pr-edit.mjs');
const dir = mkdtempSync(join(tmpdir(), 'guard-pr-edit-'));
const run = (command) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', cwd: dir });
const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
const bad = file('bad.md', '- [x] Screenshots attached\n');
const good = file('good.md', 'Fixes the header.\n');

test('a gh pr edit whose body file fails the body check is refused, with the check output', () => {
  const r = run(`gh pr edit 906 --body-file ${bad}`);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ticked box names screenshots/);
});

test('a clean body file, other commands and an inline --body on pr create pass; an inline --body on pr edit is refused', () => {
  assert.equal(run(`gh pr edit 906 --body-file ${good}`).status, 0);
  assert.equal(run(`gh pr create --title t --body-file ${good}`).status, 0);
  assert.equal(run('gh pr view 906').status, 0);
  assert.equal(run('ls').status, 0);
  assert.equal(run('gh pr edit 906 --body "long text"').status, 2);
  assert.equal(run('gh pr edit 906 --add-label x').status, 0);
});

test('a body file that does not exist yet is left to gh', () => {
  assert.equal(run(`gh pr edit 906 --body-file ${join(dir, 'nope.md')}`).status, 0);
});

test('cleanup', () => rmSync(dir, { recursive: true, force: true }));
