import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRoot, makeRepo } from './fixtures/make.mjs';

const CORE = new URL('../bundles/core/', import.meta.url);
test('unbound standalone producers load without factory-teardown installed', () => {
  const t = tempRoot();
  try {
    for (const skill of ['factory-record-flow', 'factory-pr-create', 'factory-safari-check']) cpSync(new URL(skill, CORE), join(t.root, skill), { recursive: true });
    for (const [skill, script, args] of [
      ['factory-record-flow', 'caption.mjs', []], ['factory-record-flow', 'side-by-side.mjs', []],
      ['factory-record-flow', 'build-page.mjs', []], ['factory-pr-create', 'build-compare-grid.mjs', []],
      ['factory-safari-check', 'safari.mjs', ['--help']],
    ]) {
      const env = { ...process.env }; delete env.FACTORY_RUN_ID; delete env.FACTORY_STATE_ROOT;
      const r = spawnSync(process.execPath, [join(t.root, skill, 'scripts', script), ...args], { encoding: 'utf8', env });
      assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/, script);
      assert.match(r.stdout + r.stderr, /usage/i, script);
    }
  } finally { t.cleanup(); }
});

test('take template stops on lifecycle failure before creating a recording path', { skip: process.platform === 'win32' }, () => {
  const t = tempRoot();
  try {
    const root = makeRepo(join(t.root, 'repo')), skills = join(root, '.agents/skills');
    cpSync(new URL('factory-record-flow', CORE), join(skills, 'factory-record-flow'), { recursive: true });
    mkdirSync(join(skills, 'factory-teardown/scripts'), { recursive: true });
    writeFileSync(join(skills, 'factory-teardown/scripts/lifecycle.mjs'), 'console.error("controlled lifecycle failure"); process.exit(7);');
    const r = spawnSync('bash', [join(skills, 'factory-record-flow/scripts/take-template.sh')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, BASH_ENV: '', FACTORY_RUN_ID: '', FACTORY_STATE_ROOT: join(root, 'state'), RECORD_SESSION: 'test', SKIP_SETUP: '1', TARGET_RE: 'button', RESULTS_JS: 'true', LABEL: 'take' },
    });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /controlled lifecycle failure/);
    assert.ok(!existsSync(join(root, 'state/recordings'))); assert.doesNotMatch(r.stderr, /Recording run:/);
  } finally { t.cleanup(); }
});
