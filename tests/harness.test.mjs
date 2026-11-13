// bin/harness.mjs and `factory harness`: fragments in git merge into the user's settings, a removed
// entry is taken back out, the user's own entries are never touched, and a broad allow is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { broadAllow, checkFragment, merge, drifted, fragments } from '../bin/harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY = join(ROOT, 'bin', 'factory.mjs');
const write = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('broadAllow: a rule must name what it allows', () => {
  for (const r of ['Bash', 'Bash(*)', 'Bash(:*)', 'Edit', 'Read( * )']) assert.equal(broadAllow(r), true, r);
  for (const r of ['Bash(git commit:*)', 'Bash(npm test)', 'Read(./docs/**)', 'mcp__plannotator__plannotator']) assert.equal(broadAllow(r), false, r);
});

test('checkFragment: only hooks and permissions, well formed, no broad allow', () => {
  assert.equal(checkFragment({ hooks: {}, permissions: { allow: [], deny: [] } }), null);
  assert.match(checkFragment({ env: { X: '1' } }), /only hooks and permissions/);
  assert.match(checkFragment({ hooks: { 'not an event': [] } }), /not an event name/);
  assert.match(checkFragment({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] } }), /type command/);
  assert.match(checkFragment({ permissions: { allow: ['Bash(*)'] } }), /allows too much/);
  assert.match(checkFragment({ permissions: { ask: ['x'] } }), /only allow and deny/);
});

test('merge: adds what fragments ask for, removes what it added before and they dropped, keeps the user\'s own', () => {
  const user = { command: 'my-own-hook', type: 'command' };
  const cfg = { hooks: { Stop: [{ hooks: [user] }] }, permissions: { allow: ['Bash(ls:*)'] }, theme: 'dark' };
  const frag = (allow, cmd) => [{ bundle: 'core', hash: 'h1', fragment: { hooks: cmd ? { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: cmd, timeout: 5 }] }] } : {}, permissions: { allow } } }];
  const first = merge(cfg, frag(['Bash(git commit:*)'], 'guard.sh'));
  assert.deepEqual(first.changes, ['Stop: added guard.sh', 'permissions.allow: added Bash(git commit:*)']);
  assert.deepEqual(cfg.hooks.Stop.map((g) => g.hooks.map((h) => h.command)), [['my-own-hook'], ['guard.sh']]);
  assert.equal(cfg.hooks.Stop[1].matcher, 'x');
  assert.deepEqual(merge(cfg, frag(['Bash(git commit:*)'], 'guard.sh'), first.record).changes, [], 'a second apply changes nothing');
  const dropped = merge(cfg, frag([], null), first.record);
  assert.deepEqual(dropped.changes, ['Stop: removed guard.sh', 'permissions.allow: removed Bash(git commit:*)']);
  assert.deepEqual(cfg, { hooks: { Stop: [{ hooks: [user] }] }, permissions: { allow: ['Bash(ls:*)'] }, theme: 'dark' }, 'back to the user\'s own settings');
});

test('drifted: a changed fragment drifts; an empty one never applied does not', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-harness-')));
  try {
    const core = join(dir, 'core'), org = join(dir, 'org');
    write(join(core, 'harness', 'claude-code.json'), { hooks: {}, permissions: { allow: [], deny: [] } });
    write(join(org, 'harness', 'claude-code.json'), { permissions: { deny: ['Bash(rm -rf:*)'] } });
    const sources = { core, org };
    assert.deepEqual(drifted(sources, {}, 'claude-code'), ['org']);
    const applied = { 'claude-code': { sources: Object.fromEntries(fragments(sources, 'claude-code', { git: false }).map((f) => [f.bundle, { hash: f.hash }])) } };
    assert.deepEqual(drifted(sources, applied, 'claude-code'), []);
    write(join(org, 'harness', 'claude-code.json'), { permissions: { deny: ['Bash(rm -rf:*)', 'Bash(git push --force:*)'] } });
    assert.deepEqual(drifted(sources, applied, 'claude-code'), ['org']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('factory harness: shows the change, --apply writes it with a backup, a status hook names drift', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-harness-')));
  try {
    const home = join(dir, 'home'), claude = join(dir, 'claude'), codex = join(dir, 'codex'), core = join(dir, 'bundles', 'core');
    write(join(home, 'sources.json'), { core, launchers: join(dir, 'absent'), expedia: join(dir, 'absent'), trips: join(dir, 'absent') });
    write(join(core, 'harness', 'claude-code.json'), { permissions: { allow: ['Bash(git commit:*)'], deny: ['Bash(git push --force:*)'] } });
    write(join(core, 'harness', 'codex.json'), { hooks: {} });
    write(join(core, 'x-skill', 'SKILL.md'), '---\nname: x-skill\ndescription: d\n---\n');
    write(join(claude, 'settings.json'), { permissions: { allow: ['Bash(ls:*)'] } });
    mkdirSync(codex, { recursive: true });
    const env = { ...process.env, FACTORY_HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
    const run = (...a) => spawnSync(process.execPath, [FACTORY, ...a], { encoding: 'utf8', env, cwd: dir });

    const show = run('harness');
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /harness claude-code \(not applied\):\n  permissions\.allow: added Bash\(git commit:\*\)\n  permissions\.deny: added Bash\(git push --force:\*\)/);
    assert.deepEqual(read(join(claude, 'settings.json')).permissions.allow, ['Bash(ls:*)'], 'showing writes nothing');

    const apply = run('harness', '--apply');
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(read(join(claude, 'settings.json')).permissions, { allow: ['Bash(ls:*)', 'Bash(git commit:*)'], deny: ['Bash(git push --force:*)'] });
    assert.ok(readdirSync(claude).some((n) => n.startsWith('settings.json.bak-')), 'backed up first');
    assert.match(run('harness').stdout, /harness claude-code: up to date/);

    write(join(core, 'harness', 'claude-code.json'), { permissions: { allow: ['Bash(*)'] } });
    const broad = run('harness', '--apply');
    assert.equal(broad.status, 1);
    assert.match(broad.stderr, /allows too much/);
    assert.deepEqual(read(join(claude, 'settings.json')).permissions.allow, ['Bash(ls:*)', 'Bash(git commit:*)'], 'a refused fragment changes nothing');

    write(join(core, 'harness', 'claude-code.json'), { permissions: { allow: [] } });
    const repo = join(dir, 'shop'); mkdirSync(repo);
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const inst = run('install', 'core', '--commit', '--to', repo, '--marker', 'off');
    assert.equal(inst.status, 0, inst.stderr);
    const hook = spawnSync(process.execPath, [FACTORY, 'status', '--hook'], { cwd: repo, encoding: 'utf8', env: { ...env, FACTORY_NO_TRIAGE_LAUNCH: '1' },
      input: JSON.stringify({ session_id: 'h1', hook_event_name: 'SessionStart', cwd: repo }) });
    assert.equal(hook.status, 0, hook.stderr);
    assert.match(hook.stdout, /harness settings for claude-code changed upstream \(core\)/);
    run('harness', '--apply');
    assert.deepEqual(read(join(claude, 'settings.json')).permissions, { allow: ['Bash(ls:*)'] }, 'entries dropped from the fragment are removed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
