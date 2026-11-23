import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, makeRepo } from '../../../../tests/fixtures/make.mjs';
import { init, load, set, start, end, kill, status, digest, launch, live, waitForRun, describe, phasePrompt, main, StateError } from './state.mjs';

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
    assert.deepEqual([r.n, r.tag, r.title], [1, `conductor:${load(f.file).slug}:work:1`, 'PROJ-1 · work']);
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
    set(f.file, ['automation.review=true']);
    start(f.file, 'review'); end(f.file, 'review', { phase: 'review', outcome: 'pass', handoff: { findings: [{ id: 'F1', summary: 'a', status: 'open' }, { id: 'F2', summary: 'b', status: 'open' }] } });
    const r2 = start(f.file, 'review');
    assert.equal(r2.title, 'PROJ-1 · review 2');
    end(f.file, 'review', { phase: 'review', outcome: 'pass', handoff: { findings: [{ id: 'F1', summary: 'a', status: 'fixed' }] } });
    assert.deepEqual(load(f.file).findings.map((x) => `${x.id}:${x.status}`), ['F1:fixed', 'F2:open']);
  } finally { f.dispose(); }
});

test('a run is named only by the words the conductor gives (--what); without them it keeps the default', () => {
  assert.equal(describe('  fix   page-view reset '), 'fix page-view reset');
  assert.equal(describe(''), null);
  assert.equal(describe(undefined), null);
  const f = fixture(); try {
    set(f.file, ['automation.ci_monitor=true']);
    const r = start(f.file, 'ci-monitor', undefined, { what: 'CI on #1029' });
    assert.deepEqual([r.role, r.what, r.title], ['monitor', 'CI on #1029', 'CI on #1029']);
    assert.equal(load(f.file).phases['ci-monitor'].runs[0].what, 'CI on #1029');
    end(f.file, 'ci-monitor', { phase: 'ci-monitor', outcome: 'pass' });
    const d = start(f.file, 'ci-monitor');
    assert.deepEqual([d.what, d.title], [null, 'PROJ-1 · ci-monitor 2']);
    assert.equal(load(f.file).phases['ci-monitor'].runs[1].what, undefined);
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
    set(f.file, ['automation.ci_monitor=true']);
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
    set(f.file, ['automation.review=true']);
    for (const [t, p] of [[10, 50000], [5, 90000]]) { start(f.file, 'review'); end(f.file, 'review', { phase: 'review', outcome: 'pass', metrics: { turns: t, peak_ctx: p, rounds: 1 } }); }
    const d = digest(f.file).phases.review;
    assert.deepEqual([d.runs, d.turns, d.peak_ctx, d.rounds], [2, 15, 90000, 2]);
    assert.equal(d.measured, 0);
  } finally { f.dispose(); }
});

// A Claude Code session log for the run, as the harness writes it: one line per content block.
function sessionLog(root, id, startedAt, model = 'claude-haiku-5-5') {
  const dir = join(root, 'claude', 'projects', '-wt');
  mkdirSync(dir, { recursive: true });
  const t = (s) => new Date(Date.parse(startedAt) + s * 1000).toISOString();
  const a = (s, mid, u) => JSON.stringify({ type: 'assistant', timestamp: t(s), message: { id: mid, model, usage: u, content: [] } });
  const u1 = { input_tokens: 10, cache_read_input_tokens: 80000, cache_creation_input_tokens: 5000, output_tokens: 300 };
  const u2 = { input_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0, output_tokens: 200 };
  writeFileSync(join(dir, `${id}.jsonl`), [a(5, 'm1', u1), a(5, 'm1', u1),
    JSON.stringify({ type: 'user', timestamp: t(20), message: { content: [{ type: 'tool_result' }] } }), a(26, 'm2', u2)].join('\n') + '\n');
  return { CLAUDE_CODE_SESSION_ID: id, CLAUDE_CONFIG_DIR: join(root, 'claude') };
}

test('end measures the run from its session log, over the phase\'s own count', () => {
  const f = fixture(); try {
    set(f.file, ['automation.ci_monitor=true']);
    const r = start(f.file, 'ci-monitor', '2026-01-01T00:00:00.000Z');
    const env = sessionLog(f.root, 'SID', '2026-01-01T00:00:01.000Z');
    end(f.file, 'ci-monitor', { phase: 'ci-monitor', outcome: 'pass', metrics: { turns: 99, peak_ctx: 0, user_interventions: 1 } }, '2026-01-01T00:05:00.000Z', { env });
    const run = load(f.file).phases['ci-monitor'].runs[r.n - 1];
    assert.equal(run.model, 'claude-haiku-5-5');
    const m = JSON.parse(readFileSync(run.notes, 'utf8')).metrics;
    assert.deepEqual([m.source, m.turns, m.peak_ctx, m.user_interventions, m.model_ms], ['measured', 2, 90005, 1, 6000]);
    assert.deepEqual(m.tokens, { input: 15, cache_read: 170000, cache_write: 5000, output: 500 });
    const d = digest(f.file).phases['ci-monitor'];
    assert.equal(d.measured, 1);
    assert.deepEqual(d.by_model['claude-haiku-5-5'], { runs: 1, wall_ms: 300000, model_ms: 6000, turns: 2, tokens: m.tokens });
  } finally { f.dispose(); }
});

test('a run with no session log of its own keeps its self-report, marked as such; kill measures nothing', () => {
  const f = fixture(); try {
    start(f.file, 'work', '2026-01-01T00:00:00.000Z');
    const env = sessionLog(f.root, 'OLD', '2025-12-31T20:00:00.000Z'); // started hours before the run: not this run's
    end(f.file, 'work', { phase: 'work', outcome: 'pass', metrics: { turns: 7, source: 'measured' } }, '2026-01-01T00:10:00.000Z', { env });
    const run = load(f.file).phases.work.runs[0];
    assert.equal(run.model, undefined);
    assert.deepEqual(JSON.parse(readFileSync(run.notes, 'utf8')).metrics, { turns: 7, source: 'self' });
    start(f.file, 'work');
    kill(f.file, 'work', 'looping');
    assert.equal(JSON.parse(readFileSync(load(f.file).phases.work.runs[1].notes, 'utf8')).metrics, undefined);
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

test('deploy hands over the PR\'s base through its notes', () => {
  const f = fixture(); try {
    start(f.file, 'deploy');
    end(f.file, 'deploy', { phase: 'deploy', outcome: 'pass', handoff: { pr: 12, base: 'feat/PROJ-0-parent', ci: 'pending' } });
    assert.equal(load(f.file).base, 'feat/PROJ-0-parent');
  } finally { f.dispose(); }
});

test('intake hands over the feature map entry, and every later prompt names it', () => {
  const f = fixture(); try {
    assert.doesNotMatch(phasePrompt(load(f.file), 'work', f.file, 1).prompt, /Feature map entry/);
    start(f.file, 'intake');
    const entry = '/state/feature-map/app/features/compare.md';
    end(f.file, 'intake', { phase: 'intake', outcome: 'pass', handoff: { plan: 'plans/p.md', feature_entry: entry } });
    const s = load(f.file);
    assert.equal(s.feature_entry, entry);
    assert.match(phasePrompt(s, 'work', f.file, 2, 'fix F1').prompt, /Phase run: 2\. Feature map entry: \/state\/feature-map\/app\/features\/compare\.md\. Task: fix F1$/);
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

test('existing tickets default to work and deploy with review and monitoring independently opt-in', () => {
  const f = fixture(); try {
    const legacy = load(f.file);
    delete legacy.automation;
    writeFileSync(f.file, JSON.stringify(legacy));
    start(f.file, 'work');
    end(f.file, 'work', { phase: 'work', outcome: 'pass' });
    assert.match(status(load(f.file)), /review=off ci-monitor=off/);
    assert.throws(() => launch(f.file, 'review', { env: f.env }), /review is opt-in/);
    start(f.file, 'deploy');
    end(f.file, 'deploy', { phase: 'deploy', outcome: 'pass', handoff: { pr: 42, ci: 'pending' } });
    assert.throws(() => launch(f.file, 'ci-monitor', { env: f.env }), /ci-monitor is opt-in/);
    assert.deepEqual(Object.keys(load(f.file).phases), ['work', 'deploy']);
    assert.equal(load(f.file).pr, 42);

    set(f.file, ['automation.ci_monitor=true']);
    assert.equal(launch(f.file, 'ci-monitor', { env: f.env }).phase, 'ci-monitor');
    end(f.file, 'ci-monitor', { phase: 'ci-monitor', outcome: 'pass' });
    assert.throws(() => start(f.file, 'review'), /review is opt-in/);
    set(f.file, ['automation.ci_monitor=false', 'automation.review=true']);
    assert.equal(launch(f.file, 'review', { env: f.env }).phase, 'review');
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
    assert.match(r.after, /--title 'PROJ-1 · work'/);
    end(f.file, 'work', { phase: 'work', outcome: 'pass' });
    set(f.file, ['automation.review=true']);
    writeFileSync(join(lp, 'launcher.json'), JSON.stringify({ argv: ['term', '{name}', '{prompt}'], name: ['--label', 'role={role}', '--label', 'what={what}'] }));
    assert.ok(!launch(f.file, 'review', { task: 'a long task the conductor wrote', env: f.env }).command.includes('--label'), 'no --what: no name labels');
    end(f.file, 'review', { phase: 'review', outcome: 'pass' });
    const n = launch(f.file, 'deploy', { what: 'open the PR', env: f.env });
    assert.ok(n.command.includes("--label role=deploy --label 'what=open the PR'"), n.command);
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
    writeFileSync(join(main, '.agents', 'factory-metadata', 'project.json'), JSON.stringify({
      version: 1, adapters: { sessionLauncher: null, conductor: { review: true } },
    }));
    const wt = join(f.root, 'proj-wt');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const r = init({ worktree: wt, ticket: 'PROJ-9' });
    assert.deepEqual(r.state.automation, { review: true, ci_monitor: false });
    assert.equal(launch(r.file, 'work', { env: f.env }).via, 'subagent');
  } finally { f.dispose(); }
});

test('the CLI reports a refused command as an error, not a crash', () => {
  const f = fixture(); try {
    assert.throws(() => main(['end', '--state', f.file, 'work']), /needs --notes/);
    assert.throws(() => main(['bogus']), /unknown command/);
    assert.throws(() => main(['context', '--window']), /positive token count/);
    assert.match(main(['status', '--state', f.file]), /^PROJ-1 phase=-/);
  } finally { f.dispose(); }
});

test('wait returns only the named run handoff, even after a retry starts', async () => {
  const f = fixture(); try {
    const first = start(f.file, 'work');
    const pending = waitForRun(f.file, 'work', first.n, { seconds: 2 });
    const ended = end(f.file, 'work', { phase: 'work', outcome: 'blocked', question: 'Which base?' });
    const second = start(f.file, 'work');
    assert.deepEqual(await pending, { phase: 'work', n: first.n, outcome: 'blocked', notes: ended.notes });
    assert.deepEqual(await waitForRun(f.file, 'work', second.n, { seconds: 1 }), {
      phase: 'work', n: second.n, outcome: 'waiting',
    });
  } finally { f.dispose(); }
});

test('launch timings are opt-in and exact liveness works with both launcher protocols', () => {
  const f = fixture(); try {
    const lp = join(f.worktree, '.agents', 'skills', 'fake-launcher');
    mkdirSync(lp, { recursive: true });
    const spec = {
      argv: [process.execPath, '-e', 'console.log("terminal")'],
      after: 'after.mjs',
      live: 'live.mjs',
      liveExact: true,
    };
    const configure = () => writeFileSync(join(lp, 'launcher.json'), JSON.stringify(spec));
    configure();
    writeFileSync(join(lp, 'after.mjs'), 'process.stdin.resume()');
    writeFileSync(join(f.env.FACTORY_HOME, 'config.json'), JSON.stringify({ adapters: { sessionLauncher: 'fake-launcher' } }));
    const plain = launch(f.file, 'work', { env: f.env });
    assert.equal(plain.timing_ms, undefined);
    end(f.file, 'work', { phase: 'work', outcome: 'pass' });
    const r = launch(f.file, 'work', { run: true, timing: true, env: f.env });
    assert.equal(r.opened, true);
    assert.deepEqual(Object.keys(r.timing_ms), ['prepare', 'process_start', 'tab_registration']);
    assert.ok(Object.values(r.timing_ms).every((v) => Number.isInteger(v) && v >= 0));
    writeFileSync(join(lp, 'live.mjs'),
      'if (process.argv[2] === "--tag") console.log(JSON.stringify([process.argv[3]]))');
    assert.throws(() => live(f.file, f.env, 'other:work:1'), /for this ticket/);
    assert.deepEqual(live(f.file, f.env, r.tag), [r.tag]);
    delete spec.liveExact;
    configure();
    writeFileSync(join(lp, 'live.mjs'),
      `if (process.argv.length === 2) console.log(JSON.stringify(${JSON.stringify([plain.tag, r.tag])}))`);
    assert.deepEqual(live(f.file, f.env, r.tag), [r.tag]);
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
    assert.equal(r.title, 'feat-clickstream · intake');
    assert.match(status(load(file)), /^feat-clickstream phase=intake/);
    end(file, 'intake', { phase: 'intake', outcome: 'pass', handoff: { ticket: 'PROJ-9' } });
    assert.equal(load(file).ticket, 'PROJ-9');
    assert.equal(start(file, 'work').title, 'PROJ-9 · work');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
