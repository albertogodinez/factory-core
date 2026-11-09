#!/usr/bin/env node
// Runs every *.test.mjs under tests/ and bundles/ with node --test. Node 20's
// test runner doesn't expand globs, so the files are listed here.
// Usage: node tests/run.mjs [extra files...]
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p); else if (e.endsWith('.test.mjs')) yield relative(ROOT, p);
  }
}
const files = [...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'bundles')), ...process.argv.slice(2)];
// A pre-commit hook runs this with git's own repo variables set (`git commit -a` points
// GIT_INDEX_FILE at a temporary index). Inherited by the factory and resolver processes the
// tests spawn, they would write fixture state into the commit being made. Tests that need
// one set it themselves.
const env = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) delete env[k];
const r = spawnSync(process.execPath, ['--test', ...(process.env.CI || process.argv.includes('--tap') ? [] : ['--test-reporter=dot']), ...files.filter((f) => f !== '--tap')], { cwd: ROOT, stdio: 'inherit', env });
process.exit(r.status ?? 1);
