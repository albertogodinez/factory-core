#!/usr/bin/env node
// Runs every *.test.mjs under tests/ and bundles/ with node --test. Node 20's
// test runner doesn't expand globs, so the files are listed here.
// Usage: node tests/run.mjs [--staged] [extra files...]
//   --staged  only the tests the staged change needs (select.mjs); the pre-commit hook uses it,
//             and the pre-push hook runs everything.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectIn } from './select.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p); else if (e.endsWith('.test.mjs')) yield relative(ROOT, p);
  }
}
const extra = process.argv.slice(2).filter((a) => a !== '--staged' && a !== '--tap');
let files = [...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'bundles')), ...extra];
if (process.argv.includes('--staged')) {
  // Read the index with git's own variables: `git commit -a` stages into a temporary index.
  const d = spawnSync('git', ['diff', '--cached', '--name-only', '--no-renames'], { cwd: ROOT, encoding: 'utf8' });
  if (d.status !== 0) { process.stderr.write(d.stderr); process.exit(1); }
  const r = selectIn(ROOT, d.stdout.split('\n').filter(Boolean));
  process.stderr.write(`tests: ${r.mode}${r.why ? ` (${r.why})` : ''}, ${r.tests.length} of ${files.length} test files${r.mode === 'all' ? '' : '; the pre-push hook runs them all'}\n`);
  files = [...r.tests, ...extra];
}
// A pre-commit hook runs this with git's own repo variables set (`git commit -a` points
// GIT_INDEX_FILE at a temporary index). Inherited by the factory and resolver processes the
// tests spawn, they would write fixture state into the commit being made. Tests that need
// one set it themselves.
const env = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'FACTORY_RUN_ID', 'FACTORY_STATE_ROOT']) delete env[k];
// A session start launches triage for a due queue; fixtures must not start real sessions. The test
// that proves the launch unsets it.
env.FACTORY_NO_TRIAGE_LAUNCH = '1';
// Nor refresh PR states through a real gh; the tests of that launch unset it.
env.FACTORY_NO_PR_REFRESH = '1';
const r = spawnSync(process.execPath, ['--test', ...(process.env.CI || process.argv.includes('--tap') ? [] : ['--test-reporter=dot']), ...files], { cwd: ROOT, stdio: 'inherit', env });
process.exit(r.status ?? 1);
