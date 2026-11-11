// Run: node --test record-lib.test.mjs  (needs bash; stubs agent-browser, records nothing)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const LIB = fileURLToPath(new URL('./record-lib.sh', import.meta.url));
const shellTest = process.platform === 'win32' ? test.skip : test;
let dir, stub, log;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'record-lib-test-'));
  stub = join(dir, 'agent-browser');
  log = join(dir, 'calls.log');
  // Answers --version like a 0.38+ build and logs every other call's arguments.
  writeFileSync(stub, `#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo "agent-browser 0.40.0"; exit 0; fi\necho "$*" >> "${log}"\nif [ "$3" = record ] && [ "$4" = start ]; then printf take > "$5"; fi\nif [ "\${FAIL_RECORD_COMMAND:-}" = "$3 $4" ]; then exit 9; fi\n`);
  chmodSync(stub, 0o755);
});
after(() => rmSync(dir, { recursive: true, force: true }));

// Runs record_begin in a fresh shell (sleeps are shortened by shadowing `sleep`) and returns the logged agent-browser calls.
const begin = (args, env = {}) => {
  for (const name of ['out.webm', 'out.webm.marks', 'out.captions.jsonl', 'out.take.json', 'take.webm', 'take.webm.marks', 'take.captions.jsonl', 'take.take.json']) rmSync(join(dir, name), { force: true });
  writeFileSync(log, '');
  const r = spawnSync('bash', ['-c', `sleep() { :; }; source "${LIB}"; record_begin ${args} && record_end`], {
    env: { ...process.env, BASH_ENV: '', AGENT_BROWSER_BIN: stub, RECORD_SESSION: 's', ...env }, cwd: dir, timeout: 30000,
  });
  return { status: r.status, stderr: r.stderr.toString(), calls: readFileSync(log, 'utf8').trim().split('\n') };
};

shellTest('record_begin passes a requested WxH to set viewport', () => {
  const { status, calls } = begin('out.webm 2560x1300');
  assert.equal(status, 0);
  assert.ok(calls.includes('--session s set viewport 2560 1300'), calls.join('\n'));
});

shellTest('record_begin falls back to VIEWPORT_W/H, then 1440x900', () => {
  assert.ok(begin('out.webm', { VIEWPORT_W: '1000', VIEWPORT_H: '700' }).calls.includes('--session s set viewport 1000 700'));
  const plain = begin('out.webm', { VIEWPORT_W: '', VIEWPORT_H: '' });
  assert.ok(plain.calls.includes('--session s set viewport 1440 900'), plain.calls.join('\n'));
});

shellTest('record_begin hands the daemon an absolute path for a relative one', () => {
  const { status, calls } = begin('out.webm');
  assert.equal(status, 0);
  const start = calls.find((c) => c.includes(' record start '));
  assert.ok(start?.includes(` record start ${join(realpathSync(dir), 'out.webm')}`), calls.join('\n'));
});

shellTest('record_begin refuses a path whose directory is missing, before touching the browser', () => {
  const { status, stderr, calls } = begin('missing/out.webm');
  assert.equal(status, 2);
  assert.match(stderr, /does not exist/);
  assert.deepEqual(calls, ['']);
});

shellTest('record_begin refuses a malformed size without touching the browser', () => {
  const { status, stderr, calls } = begin('out.webm wide');
  assert.equal(status, 2);
  assert.match(stderr, /2560x1300/);
  assert.deepEqual(calls, ['']);
});

shellTest('record_begin starts an empty marks file beside the take, and mark appends to it', () => {
  const r = spawnSync('bash', ['-c', `sleep() { :; }; source "${LIB}"; record_begin take.webm && mark "reply rendered" && record_end && cat take.webm.marks`], {
    cwd: dir,
    env: { ...process.env, BASH_ENV: '', AGENT_BROWSER_BIN: stub, RECORD_SESSION: 's' },
  });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(r.stdout.toString(), /^\d+\.\d{2}\treply rendered\n$/);
});

shellTest('caption appends what the viewer sees, timed from the start of the take', () => {
  const out = join(dir, 'cap.webm');
  const r = spawnSync('bash', ['-c', `sleep() { :; }; source "${LIB}"; record_begin "${out}"; caption 'Quick replies at 16/22'; caption "No drawer \\"yet\\""; record_end`], {
    env: { ...process.env, BASH_ENV: '', AGENT_BROWSER_BIN: stub, RECORD_SESSION: 's' },
  });
  assert.equal(r.status, 0, r.stderr.toString());
  const lines = readFileSync(join(dir, 'cap.captions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.text), ['Quick replies at 16/22', 'No drawer "yet"']);
  // record start returns ~2.1 s into the capture, so the first caption lands at about 2.1 s, not 0.
  assert.ok(lines[0].at >= 2, String(lines[0].at));
});

// Evaluates visible_button's JS against a fake DOM of buttons.
const pick = (name, buttons, scope = '') => {
  const js = spawnSync('bash', ['-c', `source "${LIB}"; visible_button "$1" "$2"`, '_', name, scope], {
    env: { ...process.env, BASH_ENV: '', AGENT_BROWSER_BIN: stub, RECORD_SESSION: 's' },
  }).stdout.toString().trim();
  const document = { querySelectorAll: () => buttons };
  return new Function('document', `return ${js}`)(document);
};
const button = (text, visible, id) => ({
  id, textContent: text, getAttribute: () => null,
  offsetParent: visible ? {} : null, getBoundingClientRect: () => ({ width: visible ? 40 : 0 }),
});

shellTest('visible_button skips a hidden duplicate and returns the one visible match', () => {
  const el = pick('See all', [button('See all', false, 'hidden'), button('See all', true, 'drawer')]);
  assert.equal(el.id, 'drawer');
});

shellTest('visible_button throws on zero or two visible matches, and keeps a quoted name intact', () => {
  assert.throws(() => pick('See all', [button('See all', true, 'a'), button('See all', true, 'b')]), /2 visible matches/);
  assert.throws(() => pick('See all', [button('See all', false, 'a')]), /0 visible matches/);
  assert.equal(pick("It's here", [button("It's here", true, 'q')]).id, 'q');
});

shellTest('highlight returns 1 when the page finds nothing to outline', () => {
  const d = mkdtempSync(join(tmpdir(), 'record-lib-hl-'));
  const bin = join(d, 'agent-browser');
  writeFileSync(bin, '#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo "agent-browser 0.40.0"; exit 0; fi\necho \'"miss"\'\n');
  chmodSync(bin, 0o755);
  const r = spawnSync('bash', ['-c', `source "${LIB}"; highlight "document.querySelector('#nope')" "label"`], {
    env: { ...process.env, BASH_ENV: '', AGENT_BROWSER_BIN: bin, RECORD_SESSION: 's' },
  });
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /highlight 'label'/);
});

shellTest('record_begin writes the served app commit beside the take', () => {
  const repo = fileURLToPath(new URL('.', import.meta.url));
  const sha = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.toString().trim();
  const r = begin('take.webm', { RECORD_APP_DIR: repo });
  assert.equal(r.status, 0, r.stderr);
  const take = JSON.parse(readFileSync(join(dir, 'take.take.json'), 'utf8'));
  assert.equal(take.appSha, sha);
});

const recording = (body, { before = '', env = {} } = {}) => {
  const work = mkdtempSync(join(dir, 'case-'));
  writeFileSync(log, '');
  const run = spawnSync('bash', ['-c', `${before} sleep() { :; }; source "$1"; ${body}`, '_', LIB], {
    cwd: work, env: { ...process.env, BASH_ENV: '', AGENT_BROWSER_BIN: stub, RECORD_SESSION: 'owned', ...env }, encoding: 'utf8', timeout: 30000,
  });
  return { ...run, work };
};

shellTest('abort removes only this take and sidecars and runs the caller EXIT trap once', () => {
  const r = recording('record_begin take.webm; caption test; record_abort bad', {
    before: `trap 'printf "%s\\n" "$?" >> exit-status' EXIT; printf keep > unrelated.webm;`,
  });
  assert.equal(r.status, 1, r.stderr);
  for (const name of ['take.webm', 'take.webm.marks', 'take.captions.jsonl', 'take.take.json']) assert.equal(existsSync(join(r.work, name)), false, name);
  assert.equal(readFileSync(join(r.work, 'unrelated.webm'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(r.work, 'exit-status'), 'utf8'), '1\n');
});

shellTest('an unfinished take is removed on shell failure, preserving the caller trap and status', () => {
  const r = recording('record_begin take.webm; exit 7', { before: `trap 'printf "%s\\n" "$?" > exit-status' EXIT;` });
  assert.equal(r.status, 7, r.stderr);
  assert.equal(existsSync(join(r.work, 'take.webm')), false);
  assert.equal(readFileSync(join(r.work, 'exit-status'), 'utf8'), '7\n');
});

shellTest('completed recording is kept and the original EXIT handler is restored', () => {
  const r = recording('record_begin take.webm; record_end; exit 6', { before: `trap 'printf "%s\\n" "$?" > exit-status' EXIT;` });
  assert.equal(r.status, 6, r.stderr);
  assert.equal(existsSync(join(r.work, 'take.webm')), true);
  assert.equal(existsSync(join(r.work, 'take.take.json')), true);
  assert.equal(readFileSync(join(r.work, 'exit-status'), 'utf8'), '6\n');
});

shellTest('record_begin refuses pre-existing output or sidecars without touching them', () => {
  for (const name of ['take.webm', 'take.webm.marks', 'take.captions.jsonl', 'take.take.json']) {
    const r = recording(`printf keep > ${name}; record_begin take.webm; status=$?; exit "$status"`);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.equal(readFileSync(join(r.work, name), 'utf8'), 'keep');
  }
});

shellTest('TERM removes unfinished output and preserves caller TERM and EXIT handlers', () => {
  const r = recording('record_begin take.webm; kill -TERM $$; printf continued', {
    before: `trap 'printf term > term-ran' TERM; trap 'printf "%s\\n" "$?" > exit-status' EXIT;`,
  });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(existsSync(join(r.work, 'take.webm')), false);
  assert.equal(readFileSync(join(r.work, 'term-ran'), 'utf8'), 'term');
  assert.equal(readFileSync(join(r.work, 'exit-status'), 'utf8'), '143\n');
});

shellTest('failed browser start or stop removes owned output and retains the command status', () => {
  for (const command of ['record start', 'record stop']) {
    const r = recording('record_begin take.webm && record_end; status=$?; exit "$status"', {
      before: `trap 'printf "%s\\n" "$?" > exit-status' EXIT;`, env: { FAIL_RECORD_COMMAND: command },
    });
    assert.equal(r.status, 9, `${command}: ${r.stderr}`);
    for (const name of ['take.webm', 'take.webm.marks', 'take.captions.jsonl', 'take.take.json']) assert.equal(existsSync(join(r.work, name)), false, name);
    assert.equal(readFileSync(join(r.work, 'exit-status'), 'utf8'), '9\n');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.some((c) => c === '--session owned record stop'), command === 'record stop', calls.join('\n'));
    assert.ok(calls.every((c) => c.startsWith('--session owned ')), calls.join('\n'));
  }
});

shellTest('record_begin refuses a dangling output symlink without deleting it', () => {
  const r = recording('ln -s missing take.webm; record_begin take.webm; status=$?; test -L take.webm || exit 3; exit "$status"');
  assert.equal(r.status, 2, r.stderr);
});

shellTest('strict-shell failure cleans an unfinished take and preserves its original exit status', () => {
  const r = recording('record_begin take.webm; false', { before: `set -euo pipefail; trap 'printf "%s\\n" "$?" > exit-status' EXIT;` });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(existsSync(join(r.work, 'take.webm')), false);
  assert.equal(readFileSync(join(r.work, 'exit-status'), 'utf8'), '1\n');
});
