// factory-docs-validate's main-guard over every bundle in this repo. A run-directly check that
// skips realpath does nothing through the .claude/skills symlink and exits 0, so a consumer's hook
// would be the first to notice. This catches it here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATE = join(ROOT, 'bundles', 'core', 'factory-docs-validate', 'scripts', 'validate.mjs');

test('every bundle script resolves symlinks before deciding it was run directly (main-guard)', () => {
  const r = spawnSync(process.execPath, [VALIDATE, '--only', 'main-guard', '--skills', join(ROOT, 'bundles'), '--cwd', ROOT], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
