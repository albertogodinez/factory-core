// Runs dispatch.mjs against fake codex/claude binaries on PATH, so no real model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dispatch = path.join(here, 'dispatch.mjs');
const pins = JSON.parse(readFileSync(path.join(here, '../references/models.json'), 'utf8')).reviewers;

// Each fake records its argv to $ARGV_LOG, answers auth checks, and writes a review.
// FAKE_FAIL=model makes `exec`/`-p` fail the way an unknown model does.
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-test-'));
  const bin = path.join(dir, 'bin');
  spawnSync('mkdir', [bin]);
  const fake = (name, body) => {
    const f = path.join(bin, name);
    writeFileSync(f, `#!/bin/sh\necho "$@" >> "$ARGV_LOG"\n${body}\n`);
    chmodSync(f, 0o755);
  };
  fake('codex', `[ "$1" = login ] && exit 0
cat >/dev/null
[ "$FAKE_FAIL" = model ] && { echo 'error: model_not_found' >&2; exit 1; }
while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo review > "$2"; }; shift; done; exit 0`);
  fake('claude', `[ "$1" = auth ] && { echo '{"loggedIn":true}'; exit 0; }
cat >/dev/null
[ "$FAKE_FAIL" = model ] && { echo 'model is not supported' >&2; exit 1; }
m=""; while [ $# -gt 0 ]; do [ "$1" = --model ] && m="$2"; shift; done
echo "{\\"result\\":\\"review\\",\\"modelUsage\\":{\\"$m\\":{}}}"`);
  writeFileSync(path.join(dir, 'prompt.md'), 'review this');
  return dir;
}

function run(dir, args, extraEnv = {}) {
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, ARGV_LOG: path.join(dir, 'argv.log'), ...extraEnv };
  delete env.TOOLKIT_SECOND_OPINION;
  const r = spawnSync('node', [dispatch, ...args], { encoding: 'utf8', env, cwd: dir });
  const argv = (() => { try { return readFileSync(env.ARGV_LOG, 'utf8'); } catch { return ''; } })();
  return { code: r.status, json: JSON.parse(r.stdout.trim().split('\n').pop()), argv };
}

const reviewArgs = (dir, to) => ['--to', to, '--prompt', path.join(dir, 'prompt.md'), '--out', path.join(dir, 'out.md'), '--cd', dir];

for (const to of ['codex', 'claude']) {
  const flag = to === 'codex' ? '-m' : '--model';

  test(`${to}: no --model runs the pin and reports no override`, () => {
    const dir = sandbox();
    const { code, json, argv } = run(dir, reviewArgs(dir, to));
    assert.equal(code, 0);
    assert.equal(json.model, pins[to].model);
    assert.equal(json.pinned, undefined);
    assert.match(argv, new RegExp(`${flag} ${pins[to].model}\\b`));
  });

  test(`${to}: --model runs the requested model and names the pin`, () => {
    const dir = sandbox();
    const { code, json, argv } = run(dir, [...reviewArgs(dir, to), '--model', 'other-model']);
    assert.equal(code, 0);
    assert.equal(json.model, 'other-model');
    assert.equal(json.pinned, pins[to].model);
    assert.match(argv, new RegExp(`${flag} other-model\\b`));
    assert.doesNotMatch(argv, new RegExp(`${flag} ${pins[to].model}\\b`));
  });

  test(`${to}: --preflight reports the override`, () => {
    const dir = sandbox();
    const { code, json } = run(dir, ['--preflight', '--to', to, '--model', 'other-model']);
    assert.equal(code, 0);
    assert.deepEqual([json.status, json.model, json.pinned], ['ready', 'other-model', pins[to].model]);
  });

  test(`${to}: an unknown overridden model is not blamed on the pin`, () => {
    const dir = sandbox();
    const { code, json } = run(dir, [...reviewArgs(dir, to), '--model', 'nope'], { FAKE_FAIL: 'model' });
    assert.equal(code, 2);
    assert.match(json.reason, /requested nope/);
    assert.doesNotMatch(json.reason, /re-pin/);
  });

  test(`${to}: an unknown pinned model still says re-pin`, () => {
    const dir = sandbox();
    const { code, json } = run(dir, reviewArgs(dir, to), { FAKE_FAIL: 'model' });
    assert.equal(code, 2);
    assert.match(json.reason, /re-pin/);
  });
}

test('--model with the pinned id is not reported as an override', () => {
  const dir = sandbox();
  const { json } = run(dir, [...reviewArgs(dir, 'codex'), '--model', pins.codex.model]);
  assert.equal(json.pinned, undefined);
});

test('--model with no value is a usage error, not a silent pin', () => {
  const dir = sandbox();
  for (const args of [[...reviewArgs(dir, 'codex'), '--model'], ['--preflight', '--to', 'codex', '--model', '--cd']]) {
    const { code, json } = run(dir, args);
    assert.equal(code, 2);
    assert.match(json.reason, /usage: --model/);
  }
});
