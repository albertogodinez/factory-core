// Run: node --test record-lib.test.mjs  (needs bash; stubs agent-browser, records nothing)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const LIB = fileURLToPath(new URL('./record-lib.sh', import.meta.url));
let dir, stub, log;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'record-lib-test-'));
  stub = join(dir, 'agent-browser');
  log = join(dir, 'calls.log');
  // Answers --version like a 0.38+ build and logs every other call's arguments.
  writeFileSync(stub, `#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo "agent-browser 0.40.0"; exit 0; fi\necho "$*" >> "${log}"\n`);
  chmodSync(stub, 0o755);
});
after(() => rmSync(dir, { recursive: true, force: true }));

// Runs record_begin in a fresh shell (sleeps are shortened by shadowing `sleep`) and returns the logged agent-browser calls.
const begin = (args, env = {}) => {
  writeFileSync(log, '');
  const r = spawnSync('bash', ['-c', `sleep() { :; }; source "${LIB}"; record_begin ${args}`], {
    env: { ...process.env, AGENT_BROWSER_BIN: stub, RECORD_SESSION: 's', ...env }, cwd: dir,
  });
  return { status: r.status, stderr: r.stderr.toString(), calls: readFileSync(log, 'utf8').trim().split('\n') };
};

test('record_begin passes a requested WxH to set viewport', () => {
  const { status, calls } = begin('out.webm 2560x1300');
  assert.equal(status, 0);
  assert.ok(calls.includes('--session s set viewport 2560 1300'), calls.join('\n'));
});

test('record_begin falls back to VIEWPORT_W/H, then 1440x900', () => {
  assert.ok(begin('out.webm', { VIEWPORT_W: '1000', VIEWPORT_H: '700' }).calls.includes('--session s set viewport 1000 700'));
  const plain = begin('out.webm', { VIEWPORT_W: '', VIEWPORT_H: '' });
  assert.ok(plain.calls.includes('--session s set viewport 1440 900'), plain.calls.join('\n'));
});

test('record_begin hands the daemon an absolute path for a relative one', () => {
  const { status, calls } = begin('out.webm');
  assert.equal(status, 0);
  const start = calls.find((c) => c.includes(' record start '));
  assert.ok(start?.includes(` record start ${join(realpathSync(dir), 'out.webm')}`), calls.join('\n'));
});

test('record_begin refuses a path whose directory is missing, before touching the browser', () => {
  const { status, stderr, calls } = begin('missing/out.webm');
  assert.equal(status, 2);
  assert.match(stderr, /does not exist/);
  assert.deepEqual(calls, ['']);
});

test('record_begin refuses a malformed size without touching the browser', () => {
  const { status, stderr, calls } = begin('out.webm wide');
  assert.equal(status, 2);
  assert.match(stderr, /2560x1300/);
  assert.deepEqual(calls, ['']);
});

test('record_begin starts an empty marks file beside the take, and mark appends to it', () => {
  const r = spawnSync('bash', ['-c', `sleep() { :; }; source "${LIB}"; record_begin take.webm && mark "reply rendered" && cat take.webm.marks`], {
    cwd: dir,
    env: { ...process.env, AGENT_BROWSER_BIN: stub, RECORD_SESSION: 's' },
  });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(r.stdout.toString(), /^\d+\.\d{2}\treply rendered\n$/);
});

test('caption appends what the viewer sees, timed from the start of the take', () => {
  const out = join(dir, 'cap.webm');
  const r = spawnSync('bash', ['-c', `sleep() { :; }; source "${LIB}"; record_begin "${out}"; caption 'Quick replies at 16/22'; caption "No drawer \\"yet\\""`], {
    env: { ...process.env, AGENT_BROWSER_BIN: stub, RECORD_SESSION: 's' },
  });
  assert.equal(r.status, 0, r.stderr.toString());
  const lines = readFileSync(join(dir, 'cap.captions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.text), ['Quick replies at 16/22', 'No drawer "yet"']);
  // record start returns ~2.1 s into the capture, so the first caption lands at about 2.1 s, not 0.
  assert.ok(lines[0].at >= 2 && lines[0].at < 3, String(lines[0].at));
});

// Evaluates visible_button's JS against a fake DOM of buttons.
const pick = (name, buttons, scope = '') => {
  const js = spawnSync('bash', ['-c', `source "${LIB}"; visible_button "$1" "$2"`, '_', name, scope], {
    env: { ...process.env, AGENT_BROWSER_BIN: stub, RECORD_SESSION: 's' },
  }).stdout.toString().trim();
  const document = { querySelectorAll: () => buttons };
  return new Function('document', `return ${js}`)(document);
};
const button = (text, visible, id) => ({
  id, textContent: text, getAttribute: () => null,
  offsetParent: visible ? {} : null, getBoundingClientRect: () => ({ width: visible ? 40 : 0 }),
});

test('visible_button skips a hidden duplicate and returns the one visible match', () => {
  const el = pick('See all', [button('See all', false, 'hidden'), button('See all', true, 'drawer')]);
  assert.equal(el.id, 'drawer');
});

test('visible_button throws on zero or two visible matches, and keeps a quoted name intact', () => {
  assert.throws(() => pick('See all', [button('See all', true, 'a'), button('See all', true, 'b')]), /2 visible matches/);
  assert.throws(() => pick('See all', [button('See all', false, 'a')]), /0 visible matches/);
  assert.equal(pick("It's here", [button("It's here", true, 'q')]).id, 'q');
});

test('highlight returns 1 when the page finds nothing to outline', () => {
  const d = mkdtempSync(join(tmpdir(), 'record-lib-hl-'));
  const bin = join(d, 'agent-browser');
  writeFileSync(bin, '#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo "agent-browser 0.40.0"; exit 0; fi\necho \'"miss"\'\n');
  chmodSync(bin, 0o755);
  const r = spawnSync('bash', ['-c', `source "${LIB}"; highlight "document.querySelector('#nope')" "label"`], {
    env: { ...process.env, AGENT_BROWSER_BIN: bin, RECORD_SESSION: 's' },
  });
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /highlight 'label'/);
});

test('record_begin writes the served app commit beside the take', () => {
  const repo = fileURLToPath(new URL('.', import.meta.url));
  const sha = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.toString().trim();
  const r = begin('take.webm', { RECORD_APP_DIR: repo });
  assert.equal(r.status, 0, r.stderr);
  const take = JSON.parse(readFileSync(join(dir, 'take.take.json'), 'utf8'));
  assert.equal(take.appSha, sha);
});
