// check-tools.mjs against throwaway skills directories and fake CLIs on PATH. No network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, delimiter } from 'node:path';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempRoot, write } from '../../../../tests/fixtures/make.mjs';
import { cmp, loadPins, validatePins } from './check-tools.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-tools.mjs');

let t, bin, skills, state;
function fakeCli(name, output) {
  const js = join(bin, `${name}.mjs`);
  writeFileSync(js, `console.log(${JSON.stringify(output)});\n`);
  writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`); chmodSync(join(bin, name), 0o755);
  writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${js}" %*\r\n`);
}
const pin = (id, extra = {}) => ({ id, version: { argv: [id, '--version'], pattern: `${id} (\\d+\\.\\d+\\.\\d+)` }, usage: `\\b${id}\\b`, install: `install ${id}`, ...extra });
const check = (...args) => spawnSync(process.execPath, [SCRIPT, '--skills', skills, '--state', state, ...args], {
  encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
});

before(() => {
  t = tempRoot('tool-sync-');
  bin = join(t.root, 'bin'); skills = join(t.root, 'skills'); state = join(t.root, 'state');
  write(join(bin, '.keep'), '');
  fakeCli('toolcurrent', 'toolcurrent 2.0.0');
  fakeCli('toolold', 'toolold 1.0.0');
  fakeCli('toolbehind', 'toolbehind 1.5.0');
  fakeCli('toolahead', 'toolahead 3.0.0');
  fakeCli('toolrelease', 'toolrelease 9.9.9 is available');
  // core-like skill: pins and a user of each tool
  write(join(skills, 'alpha/tools.json'), { tools: [
    pin('toolcurrent', { min: '1.0.0', verified: '2.0.0' }),
    pin('toolold', { min: '1.5.0' }),
    pin('toolbehind', { verified: '2.0.0' }),
    pin('toolahead', { verified: '2.0.0' }),
    pin('toolmissing'),
    pin('toolunused'),
    pin('toolrelease', { verified: '1.0.0', latest: { type: 'command', argv: ['toolrelease'], pattern: '(\\d+\\.\\d+\\.\\d+) is available' } }),
  ] });
  write(join(skills, 'alpha/SKILL.md'), 'Runs toolcurrent, toolold, toolbehind, toolahead, toolmissing and toolrelease.\n');
  // companion pins a second CLI and raises toolold's minimum
  write(join(skills, 'beta/tools.json'), { tools: [pin('toolold', { min: '1.8.0', notes: 'companion' })] });
  write(join(skills, 'beta/SKILL.md'), 'Also runs toolold.\n');
});
after(() => t.cleanup());

test('offline run tags each CLI and merges pins from several skills', () => {
  const r = check();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BELOW\s+toolold 1\.0\.0 is older than 1\.8\.0, the lowest the skills need \(used by alpha, beta\)/);
  assert.match(r.stdout, /BEHIND\s+toolbehind 1\.5\.0 is older than 2\.0\.0/);
  assert.match(r.stdout, /AHEAD\s+toolahead 3\.0\.0 is newer than 2\.0\.0/);
  assert.match(r.stdout, /MISSING\s+toolmissing is not on PATH \(used by alpha\); install toolmissing/);
  assert.match(r.stdout, /UNUSED\s+toolunused: no skill matches/);
  assert.ok(!/toolcurrent \d/.test(r.stdout), 'a current tool is silent');
  assert.match(r.stdout, /skip\s+no release snapshot/);
});

test('offline never fetches a release: no snapshot is written', () => {
  check();
  assert.ok(!existsSync(join(state, 'tool-snapshot.json')));
});

test('--online takes a snapshot, flags CHANGED and BELOW and exits 1; --bump records the review', () => {
  const r = check('--online');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /CHANGED\s+toolrelease 9\.9\.9 is out; the skills were checked against 1\.0\.0/);
  assert.match(r.stdout, /review with \/factory-tool-sync/);
  assert.ok(existsSync(join(state, 'tool-snapshot.json')));
  // the next offline run reads the snapshot without fetching
  assert.match(check().stdout, /CHANGED\s+toolrelease/);

  const b = check('--bump', 'toolrelease', '--decision', 'adopted', '--min', '2.0.0');
  assert.equal(b.status, 0, b.stderr);
  const doc = JSON.parse(readFileSync(join(skills, 'alpha/tools.json'), 'utf8'));
  const e = doc.tools.find((x) => x.id === 'toolrelease');
  assert.deepEqual([e.verified, e.min, e.decision], ['9.9.9', '2.0.0', 'adopted']);
  assert.match(e.reviewed, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!/CHANGED/.test(check().stdout));
});

test('--bump needs a decision and a known tool', () => {
  assert.equal(check('--bump', 'toolcurrent').status, 2);
  assert.equal(check('--bump', 'nope', '--decision', 'x').status, 2);
});

test('an invalid tools.json exits 2 naming the file', () => {
  const t2 = tempRoot('tool-sync-bad-');
  try {
    write(join(t2.root, 'skills/bad/tools.json'), { tools: [{ id: 'X', version: {}, usage: '(', install: '' }] });
    const r = spawnSync(process.execPath, [SCRIPT, '--skills', join(t2.root, 'skills'), '--state', join(t2.root, 's')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /bad\/tools\.json: tools\[0\] \(X\): id must match/);
  } finally { t2.cleanup(); }
});

test('loadPins merges: highest min wins, later skill overrides other fields', () => {
  const p = loadPins(skills);
  const old = p.tools.find((x) => x.id === 'toolold');
  assert.equal(old.min, '1.8.0');
  assert.equal(old.notes, 'companion');
  assert.equal(old.files.length, 2);
  assert.deepEqual(p.sources, ['alpha', 'beta']);
});

test('validatePins and cmp', () => {
  assert.deepEqual(validatePins({ tools: [pin('a', { min: '1.2' })] }), []);
  assert.match(validatePins({ tools: [pin('a', { latest: { type: 'npm', package: 'a' } })] })[0], /latest needs verified/);
  assert.match(validatePins({ tools: [pin('a', { min: 'x' })] })[0], /min must look like/);
  assert.equal(cmp('1.10.0', '1.9.0'), 1);
  assert.equal(cmp('2.0', '2.0.0'), 0);
});

test('the shipped core pins are valid: node, git and gh, plus what core skills shell out to', () => {
  const p = loadPins(join(dirname(SCRIPT), '../..'));
  assert.deepEqual(p.errors, []);
  assert.ok(['node', 'git', 'gh'].every((id) => p.tools.some((x) => x.id === id)));
  // Each core skill ships pins for the CLIs it needs (record-flow: agent-browser, ffmpeg, jq; statechart: mise).
  assert.deepEqual(p.tools.map((x) => x.id).sort(), ['agent-browser', 'ffmpeg', 'gh', 'git', 'jq', 'mise', 'node']);
});
