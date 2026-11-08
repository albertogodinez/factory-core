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
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
