import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, makeRepo } from '../../../../tests/fixtures/make.mjs';
import { init, load, set, start, end, kill, status, digest, launch, describe, phasePrompt, main, StateError } from './state.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-conductor-test-'));
  const worktree = join(root, 'wt');
  mkdirSync(worktree);
  const home = join(root, 'home');
  mkdirSync(home);
  const r = init({ worktree, ticket: 'PROJ-1', stateRoot: join(root, 'state', 'PROJ-1-thing') });
  return { root, worktree, file: r.file, env: { FACTORY_HOME: home }, dispose: () => rmSync(root, { recursive: true, force: true }) };
};

test('init writes a valid state under <stateRoot>/conductor and is idempotent', () => {
  const f = fixture(); try {
    assert.ok(f.file.endsWith(join('PROJ-1-thing', 'conductor', 'state.json')));
    const s = load(f.file);
    assert.match(s.slug, /^PROJ-1-thing-[0-9a-f]{8}$/);
    assert.equal(s.phase, null);
    assert.equal(init({ worktree: f.worktree, ticket: 'PROJ-1', stateRoot: join(f.root, 'state', 'PROJ-1-thing') }).existed, true);
  } finally { f.dispose(); }
});

test('init refuses a worktree whose state holds another ticket', () => {
  const f = fixture(); try {
    assert.throws(() => init({ worktree: f.worktree, ticket: 'PROJ-2', stateRoot: join(f.root, 'state', 'PROJ-1-thing') }), /holds PROJ-1, not PROJ-2/);
  } finally { f.dispose(); }
});

test('two state roots with the same basename get different session tags', () => {
  const f = fixture(); try {
    const a = init({ worktree: f.worktree, ticket: 'A-1', stateRoot: join(f.root, 'repo-a', 'main') });
    const b = init({ worktree: f.worktree, ticket: 'B-1', stateRoot: join(f.root, 'repo-b', 'main') });
    assert.notEqual(start(a.file, 'work').tag, start(b.file, 'work').tag);
  } finally { f.dispose(); }
});

test('a phase run hands over only through its notes', () => {
  const f = fixture(); try {
    const r = start(f.file, 'work', '2026-01-01T00:00:00.000Z');
    assert.deepEqual([r.n, r.tag, r.title], [1, `conductor:${load(f.file).slug}:work:1`, 'worker · build PROJ-1']);
    assert.throws(() => start(f.file, 'review'), /work is still running/);
    const out = end(f.file, 'work', { phase: 'work', outcome: 'pass', metrics: { turns: 40, peak_ctx: 120000 },
      handoff: { head_sha: 'abcdef0123', test_cmd: 'npm test', findings: [{ id: 'F1', summary: 'x', status: 'open' }] } }, '2026-01-01T00:10:00.000Z');
    assert.equal(out.n, 1);
    const s = load(f.file);
    assert.equal(s.phase, null);
    assert.equal(s.head_sha, 'abcdef0123');
    assert.equal(s.phases.work.runs[0].wall_ms, 600000);
    assert.ok(existsSync(s.phases.work.runs[0].notes));
    assert.match(status(s), /findings=1 open\/1 done=work/);
  } finally { f.dispose(); }
});

test('later rounds merge findings by id and number their tabs', () => {
  const f = fixture(); try {
    start(f.file, 'review'); end(f.file, 'review', { phase: 'review', outcome: 'pass', handoff: { findings: [{ id: 'F1', summary: 'a', status: 'open' }, { id: 'F2', summary: 'b', status: 'open' }] } });
    const r2 = start(f.file, 'review');
    assert.equal(r2.title, 'reviewer · round 2');
    end(f.file, 'review', { phase: 'review', outcome: 'pass', handoff: { findings: [{ id: 'F1', summary: 'a', status: 'fixed' }] } });
    assert.deepEqual(load(f.file).findings.map((x) => `${x.id}:${x.status}`), ['F1:fixed', 'F2:open']);
  } finally { f.dispose(); }
});

test('a run is named by its role and a few words: --what, a short --task, else the phase', () => {
  const st = { ticket: 'PROJ-1', pr: 1029 };
  assert.equal(describe(st, 'work', 2, { task: 'fix page-view reset' }), 'fix page-view reset');
  assert.equal(describe(st, 'work', 2, { task: 'fix F1 F2; keep the merge, never rebase' }), 'fix F1 F2', 'first clause of a task');
  assert.equal(describe(st, 'ci-monitor', 7, { task: 'watch PR #1029 at 5246cc0b (base main) until all checks finish' }), 'watch PR #1029 at 5246cc0b');
  assert.equal(describe(st, 'ci-monitor', 7, { task: 'poll every check on the open pull request and report each failure with ids' }), 'CI on #1029', 'a long task: the phase says it');
  assert.equal(describe(st, 'ci-monitor', 7, { task: 'long '.repeat(20), what: 'CI on #1029' }), 'CI on #1029');
  assert.equal(describe({ ...st, pr: 'https://github.com/o/r/pull/77' }, 'ci-monitor', 1), 'CI on #77');
  assert.equal(describe(st, 'review', 3), 'round 3');
  assert.equal(describe({ ticket: 'PROJ-1', pr: null }, 'intake', 1), 'scope PROJ-1');
  const f = fixture(); try {
    const r = start(f.file, 'ci-monitor', undefined, { what: 'CI on #1029' });
    assert.deepEqual([r.role, r.what, r.title], ['monitor', 'CI on #1029', 'monitor · CI on #1029']);
    assert.deepEqual([load(f.file).phases['ci-monitor'].runs[0].role, load(f.file).phases['ci-monitor'].runs[0].what], ['monitor', 'CI on #1029']);
  } finally { f.dispose(); }
});

test('invalid notes, a blocked phase without a question, and wrong-phase notes are refused', () => {
  const f = fixture(); try {
    start(f.file, 'deploy');
    assert.throws(() => end(f.file, 'deploy', { phase: 'deploy', outcome: 'done' }), StateError);
    assert.throws(() => end(f.file, 'deploy', { phase: 'deploy', outcome: 'pass', extra: 1 }), /unknown property/);
    assert.throws(() => end(f.file, 'deploy', { phase: 'deploy', outcome: 'blocked' }), /names its question/);
    assert.throws(() => end(f.file, 'deploy', { phase: 'work', outcome: 'pass' }), /not deploy/);
    end(f.file, 'deploy', { phase: 'deploy', outcome: 'blocked', question: 'stack on the open PR?' });
    assert.match(status(load(f.file)), /BLOCKED\(deploy\): stack on the open PR\?/);
  } finally { f.dispose(); }
});

test('kill records the reason as friction, so reflect sees the failed run', () => {
  const f = fixture(); try {
    start(f.file, 'ci-monitor');
    assert.throws(() => kill(f.file, 'ci-monitor'), /needs --why/);
    kill(f.file, 'ci-monitor', 'looped on the same red check');
    const d = digest(f.file);
    assert.deepEqual(d.phases['ci-monitor'].outcomes, ['killed']);
    assert.deepEqual(d.runs[0].notes.friction, ['looped on the same red check']);
  } finally { f.dispose(); }
});

test('digest totals metrics per phase', () => {
  const f = fixture(); try {
    for (const [t, p] of [[10, 50000], [5, 90000]]) { start(f.file, 'review'); end(f.file, 'review', { phase: 'review', outcome: 'pass', metrics: { turns: t, peak_ctx: p, rounds: 1 } }); }
    const d = digest(f.file).phases.review;
    assert.deepEqual([d.runs, d.turns, d.peak_ctx, d.rounds], [2, 15, 90000, 2]);
  } finally { f.dispose(); }
});

test('a stacked PR records its base and the status line names the parent', () => {
  const f = fixture(); try {
    assert.equal(load(f.file).base, null);
    set(f.file, ['trunk=main', 'base=feat/PROJ-0-parent', 'pr=12']);
    assert.match(status(load(f.file)), /pr=12 stacked-on=feat\/PROJ-0-parent/);
    set(f.file, ['base=main']);
    assert.doesNotMatch(status(load(f.file)), /stacked-on/, 'a PR on trunk is not stacked');
  } finally { f.dispose(); }
});

test('set parses JSON values and the result must still be valid', () => {
  const f = fixture(); try {
    set(f.file, ['pr=42', 'ci=green']);
    assert.equal(load(f.file).pr, 42);
    assert.throws(() => set(f.file, ['ci=purple']), /invalid/);
  } finally { f.dispose(); }
});

test('a recipe phase prompt replaces the default one', () => {
  const f = fixture(); try {
    const s = load(f.file);
    assert.match(phasePrompt(s, 'work', f.file, 1).path, /factory-conductor[\\/]references[\\/]phases[\\/]work\.md$/);
    const dir = join(f.worktree, '.agents', 'skills', 'my-recipe', 'phases');
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'work.md'), '# work');
    const p = phasePrompt({ ...s, recipe: 'my-recipe' }, 'work', f.file, 2, 'fix F1');
    assert.equal(p.path, join(dir, 'work.md'));
    assert.match(p.prompt, /Phase run: 2\. Task: fix F1$/);
  } finally { f.dispose(); }
});

test('with no launcher a phase runs as a subagent, with the prompt to give it', () => {
  const f = fixture(); try {
    const r = launch(f.file, 'intake', { env: f.env });
    assert.equal(r.via, 'subagent');
    assert.match(r.prompt, /phases[\\/]intake\.md/);
    assert.equal(load(f.file).phase, 'intake');
  } finally { f.dispose(); }
});

test('with a launcher, the session is tagged and titled for the phase', () => {
  const f = fixture(); try {
    const lp = join(f.root, 'launchers', 'fake-launcher');
    mkdirSync(lp, { recursive: true });
    writeFileSync(join(lp, 'launcher.json'), JSON.stringify({ argv: ['term', '{tag}', '--cwd', '{repo}', '{agent}', '{prompt}'], tag: ['--label', 't={tag}'], after: 'after.mjs' }));
    writeFileSync(join(f.env.FACTORY_HOME, 'config.json'), JSON.stringify({ adapters: { sessionLauncher: 'fake-launcher', agentCLI: 'claude' } }));
    writeFileSync(join(f.env.FACTORY_HOME, 'installs.json'), JSON.stringify({ sources: { core: join(f.root, 'core') } }));
    const r = launch(f.file, 'work', { env: f.env });
    assert.equal(r.via, 'fake-launcher');
    assert.ok(r.command.includes(`t=conductor:${load(f.file).slug}:work:1`));
    assert.match(r.command, new RegExp(`--cwd ${f.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.after, /--title 'worker · build PROJ-1'/);
    end(f.file, 'work', { phase: 'work', outcome: 'pass' });
    writeFileSync(join(lp, 'launcher.json'), JSON.stringify({ argv: ['term', '{name}', '{prompt}'], name: ['--label', 'role={role}', '--label', 'what={what}'] }));
    const n = launch(f.file, 'review', { task: 'round two of the review', env: f.env });
    assert.ok(n.command.includes("--label role=reviewer --label 'what=round two of the review'"), n.command);
  } finally { f.dispose(); }
});

test('a linked worktree without its own project.json keeps the main checkout\'s sessionLauncher: null', () => {
  const f = fixture(); try {
    const lp = join(f.root, 'launchers', 'fake-launcher');
    mkdirSync(lp, { recursive: true });
    writeFileSync(join(lp, 'launcher.json'), JSON.stringify({ argv: ['term', '{prompt}'] }));
    writeFileSync(join(f.env.FACTORY_HOME, 'config.json'), JSON.stringify({ adapters: { sessionLauncher: 'fake-launcher' } }));
    writeFileSync(join(f.env.FACTORY_HOME, 'installs.json'), JSON.stringify({ sources: { core: join(f.root, 'core') } }));
    const main = makeRepo(join(f.root, 'proj'));
    mkdirSync(join(main, '.agents', 'factory-metadata'), { recursive: true });
    writeFileSync(join(main, '.agents', 'factory-metadata', 'project.json'), JSON.stringify({ version: 1, adapters: { sessionLauncher: null } }));
    const wt = join(f.root, 'proj-wt');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const r = init({ worktree: wt, ticket: 'PROJ-9', stateRoot: join(f.root, 'state', 'wt') });
    assert.equal(launch(r.file, 'work', { env: f.env }).via, 'subagent');
  } finally { f.dispose(); }
});

test('the CLI reports a refused command as an error, not a crash', () => {
  const f = fixture(); try {
    assert.throws(() => main(['end', '--state', f.file, 'work']), /needs --notes/);
    assert.throws(() => main(['bogus']), /unknown command/);
    assert.match(main(['status', '--state', f.file]), /^PROJ-1 phase=-/);
  } finally { f.dispose(); }
});

test('a plan-first run starts without a ticket, named after its plan, and intake files the ticket', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-conductor-plan-'));
  try {
    const worktree = join(root, 'wt'); mkdirSync(worktree);
    const stateRoot = join(root, 'state', 'feat-x');
    assert.throws(() => init({ worktree, stateRoot }), /--ticket or --plan/);
    const { file } = init({ worktree, plan: 'plans/feat-clickstream.md', stateRoot });
    assert.equal(load(file).ticket, null);
    assert.equal(init({ worktree, plan: 'plans/feat-clickstream.md', stateRoot }).existed, true);
    assert.throws(() => init({ worktree, plan: 'plans/other.md', stateRoot }), /holds feat-clickstream/);
    const r = start(file, 'intake');
    assert.equal(r.title, 'intake · scope feat-clickstream');
    assert.match(status(load(file)), /^feat-clickstream phase=intake/);
    end(file, 'intake', { phase: 'intake', outcome: 'pass', handoff: { ticket: 'PROJ-9' } });
    assert.equal(load(file).ticket, 'PROJ-9');
    assert.equal(start(file, 'work').title, 'worker · build PROJ-9');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
