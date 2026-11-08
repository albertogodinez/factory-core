// The HITL template prints its prompts, reads Enter and answers from stdin, then prints KEY=VALUE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./hitl-loop.template.mjs', import.meta.url));

test('walks the steps and prints captured values', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { input: '\ny\nboom: x\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, />>> Open the app at http:\/\/localhost:3000 and sign in\./);
  assert.match(r.stdout, /--- Captured ---\nERRORED=y\nERROR_MSG=boom: x\n$/);
});

test('exits 1 when input ends early', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { input: '\n', encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /input closed/);
});
