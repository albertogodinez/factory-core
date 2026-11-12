// Candidates: the kind sets the lane, evidence stays pointers, the queue is the folder, and the
// launch is the adapter's argv or a printed command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { laneOf, checkEvidence, writeCandidate, queue, markDone, launchFor, sourceRepo, triagePrompt, pickLauncher, pickAgent } from './candidates.mjs';

const LESSONS = join(dirname(fileURLToPath(import.meta.url)), 'lessons.mjs');
const T0 = Date.parse('2026-11-11T12:00:00Z');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
// The agent markers too: a launch names the handing-off session's agent, and the suite runs inside one.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'CLAUDECODE', 'CODEX_THREAD_ID']) delete ENV[k];

function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-cand-')));
  return { dir, home: join(dir, 'home'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: ENV });

test('the kind sets the lane: a fact launches now, a pattern or harness lesson queues; flags override', () => {
  assert.equal(laneOf('fact'), 'now');
  assert.equal(laneOf('pattern'), 'queue');
  assert.equal(laneOf('harness'), 'queue');
  assert.equal(laneOf('fact', { queue: true }), 'queue');
  assert.equal(laneOf('pattern', { now: true }), 'now');
  assert.throws(() => laneOf('fact', { now: true, queue: true }), { code: 'usage' });
});

test('evidence is pointers: known keys, one short line each', () => {
  assert.equal(checkEvidence([{ transcript: '~/.claude/projects/x/y.jsonl', grep: 'Modify Shared Resources' }, { pr: 'o/r#9', thread: 'r1' }]), null);
  assert.match(checkEvidence([{ transcript: 'a', body: 'pasted' }]), /evidence\[0\]\.body/);
  assert.match(checkEvidence([{ note: 'line one\nline two' }]), /pointer, not content/);
  assert.match(checkEvidence([{ note: 'x'.repeat(301) }]), /pointer, not content/);
  assert.match(checkEvidence({}), /array/);
});

test('a candidate is one file in its scope folder; done moves it and its draft out of the queue', () => {
  const s = sandbox();
  try {
    const patch = join(s.dir, 'fix.patch'); writeFileSync(patch, 'diff\n');
    const w = writeCandidate({ home: s.home, kind: 'fact', scope: 'core', skill: 'factory-reflect', summary: 'A land from downstream is denied',
      evidence: [{ grep: 'Modify Shared Resources' }], draft: patch, fixedWhen: { metric: 'permission_denials', match: 'lessons.mjs land' },
      from: { project: 'shop', session: 's1' }, at: T0 });
    assert.equal(w.file, join(s.home, 'candidates', 'core', '20261111T120000Z-a-land-from-downstream-is-denied.json'));
    const c = JSON.parse(readFileSync(w.file, 'utf8'));
    assert.deepEqual(Object.keys(c), ['kind', 'scope', 'skill', 'summary', 'evidence', 'draft', 'fixedWhen', 'from', 'lane', 'at']);
    assert.equal(c.draft, 'candidates/core/20261111T120000Z-a-land-from-downstream-is-denied.patch');
    assert.ok(!('want' in c), 'no want field: the kind decides');
    writeCandidate({ home: s.home, kind: 'pattern', scope: 'org', summary: 'p', at: T0 });
    assert.deepEqual(queue(s.home, null, T0 + 3 * 86400000).map((q) => [q.scope, q.lane, q.ageDays]), [['core', 'now', 3], ['org', 'queue', 3]]);
    assert.throws(() => writeCandidate({ home: s.home, kind: 'fact', scope: 'repo', summary: 'x' }), /repo-scope lesson stays in its PR/);
    const d = markDone(s.home, w.file, 'landed', T0);
    assert.ok(!existsSync(w.file));
    assert.deepEqual(readdirSync(join(s.home, 'candidates', 'core', 'done')).sort(), [
      '20261111T120000Z-a-land-from-downstream-is-denied.json', '20261111T120000Z-a-land-from-downstream-is-denied.patch']);
    assert.equal(JSON.parse(readFileSync(d.done, 'utf8')).done.outcome, 'landed');
    assert.deepEqual(queue(s.home, 'core'), []);
    // done/ keeps 90 days.
    const old = join(s.home, 'candidates', 'core', 'done', 'old.json'); writeFileSync(old, '{}');
    utimesSync(old, new Date(T0 - 91 * 86400000), new Date(T0 - 91 * 86400000));
    const w2 = writeCandidate({ home: s.home, kind: 'fact', scope: 'core', summary: 'again', at: T0 });
    markDone(s.home, w2.file, 'dropped', T0);
    assert.ok(!existsSync(old), 'pruned after 90 days');
  } finally { s.done(); }
});

test('launch: the adapter argv when sessionLauncher names an installed launcher.json, else a printed command', () => {
  const s = sandbox();
  try {
    const skills = join(s.dir, 'skills'); mkdirSync(join(skills, 'launch-x'), { recursive: true });
    writeFileSync(join(skills, 'launch-x', 'launcher.json'), JSON.stringify({ argv: ['tool', 'run', '--cwd', '{repo}', 'agent', '{prompt}'] }));
    const a = launchFor({ launcher: 'launch-x', skillsDir: skills, repo: '/r/src', prompt: '/factory-triage /h/c.json' });
    assert.deepEqual(a.argv, ['tool', 'run', '--cwd', '/r/src', 'agent', '/factory-triage /h/c.json']);
    assert.equal(a.command, "tool run --cwd /r/src agent '/factory-triage /h/c.json'");
    assert.deepEqual(launchFor({ skillsDir: skills, repo: '/r/my src', prompt: 'p' }), { via: 'print', command: "cd '/r/my src' && <your agent CLI>", prompt: 'p' });
    assert.match(launchFor({ launcher: 'missing', skillsDir: skills, repo: '/r', prompt: 'p' }).note, /no valid launcher\.json/);
    // The launchers bundle itself is the fallback, so no repo has to install the launcher.
    assert.deepEqual(launchFor({ launcher: 'launch-x', skillsDirs: [join(s.dir, 'none'), skills], repo: '/r', prompt: 'p' }).argv, ['tool', 'run', '--cwd', '/r', 'agent', 'p']);
  } finally { s.done(); }
});

test('the agent: machine config picks claude or codex, {agent} fills the argv, and each gets its own skill prompt', () => {
  const s = sandbox();
  try {
    assert.equal(pickAgent({}).bin, 'claude', 'claude when unset');
    assert.equal(pickAgent({}).configured, false);
    const codex = pickAgent({ adapters: { agentCLI: 'codex' } });
    assert.deepEqual([codex.bin, codex.configured], ['codex', true]);
    assert.deepEqual(pickAgent({ adapters: { agentCLI: 'pi' }, agents: { pi: { bin: 'pi-cli', skill: 'run {skill}' } } }), { name: 'pi', bin: 'pi-cli', skill: 'run {skill}', from: 'machine', configured: true }, 'the machine can add one');
    // First match wins: the repo's setting, the handing-off session's agent, the machine's, then claude.
    const m = { adapters: { agentCLI: 'claude' } };
    assert.equal(pickAgent(m, { env: { CODEX_THREAD_ID: 't1' } }).bin, 'codex', 'a Codex session hands off to Codex');
    assert.equal(pickAgent({ adapters: { agentCLI: 'codex' } }, { env: { CLAUDECODE: '1' } }).bin, 'claude', 'a Claude Code session hands off to Claude');
    assert.equal(pickAgent(m, { env: { CODEX_THREAD_ID: 't1' }, repoAdapters: { agentCLI: 'claude' } }).from, 'repo', 'the repo overrides the session');
    assert.equal(pickAgent(m, { env: {} }).from, 'machine', 'no session (a scheduled job): the machine');
    assert.equal(pickAgent({ adapters: { agentCLI: 'other' } }).skill, 'Read {skillPath} and follow it{forTarget}.', 'an unknown agent reads the skill by path');

    const skills = join(s.dir, 'skills'); mkdirSync(join(skills, 'launch-x'), { recursive: true });
    writeFileSync(join(skills, 'launch-x', 'launcher.json'), JSON.stringify({ argv: ['tool', '--cwd', '{repo}', '{agent}', '{prompt}'] }));
    assert.deepEqual(launchFor({ launcher: 'launch-x', skillsDir: skills, repo: '/r', prompt: 'p', agent: codex }).argv, ['tool', '--cwd', '/r', 'codex', 'p']);
    assert.deepEqual(launchFor({ launcher: 'launch-x', skillsDir: skills, repo: '/r', prompt: 'p' }).argv, ['tool', '--cwd', '/r', 'claude', 'p'], 'claude by default');
    assert.equal(launchFor({ skillsDir: skills, repo: '/r', prompt: 'p', agent: codex }).command, 'cd /r && codex', 'a configured agent is named in the printed command');

    const repo = join(s.dir, 'src'), md = join(repo, '.agents', 'skills', 'factory-triage', 'SKILL.md');
    assert.equal(triagePrompt(repo, '/h/c.json', {}, codex), 'Use the factory-triage skill for /h/c.json.', 'no SKILL.md anywhere: name the skill');
    mkdirSync(dirname(md), { recursive: true }); writeFileSync(md, 'x');
    assert.equal(triagePrompt(repo, '/h/c.json', {}, codex), `Read ${md} and follow it for /h/c.json.`);
    assert.equal(triagePrompt(repo, '', {}, codex), `Read ${md} and follow it.`);
    assert.equal(triagePrompt(repo, '/h/c.json', {}), '/factory-triage /h/c.json', 'claude keeps the slash command');
  } finally { s.done(); }
});

test('the launcher: the repo\'s setting wins (null turns it off), else the machine\'s', () => {
  const machine = { adapters: { sessionLauncher: 'factory-launcher-hc' } };
  assert.equal(pickLauncher({}, machine), 'factory-launcher-hc');
  assert.equal(pickLauncher({ sessionLauncher: 'other' }, machine), 'other');
  assert.equal(pickLauncher({ sessionLauncher: null }, machine), null, 'a repo can turn it off');
  assert.equal(pickLauncher({}, {}), null);
});

test('the CLI: a downstream fact prints its launch; a pattern queues; queue lists both with the source repo', () => {
  const s = sandbox();
  try {
    const src = join(s.dir, 'src'); mkdirSync(join(src, 'bundles', 'core'), { recursive: true });
    git(src, 'init', '-q', '-b', 'main');
    mkdirSync(s.home, { recursive: true });
    writeFileSync(join(s.home, 'installs.json'), JSON.stringify({ sources: { core: join(src, 'bundles', 'core'), org: join(s.dir, 'absent') } }));
    assert.equal(sourceRepo('core', { core: join(src, 'bundles', 'core') }), src);
    assert.equal(sourceRepo('org', { core: join(src, 'bundles', 'core'), launchers: join(src, 'bundles') }), null, "a bundle in core's repo is not the org repo");
    const run = (...a) => { const p = spawnSync(process.execPath, [LESSONS, ...a], { encoding: 'utf8', env: { ...ENV, FACTORY_HOME: s.home } }); return { status: p.status, out: p.stdout ? JSON.parse(p.stdout) : null, err: p.stderr }; };
    const base = ['--scope', 'core', '--project', 'shop', '--root', join(s.dir, 'shop')];
    const fact = run('candidate', '--kind', 'fact', '--summary', 'stale command', '--evidence', '[{"pr":"o/r#1"}]', ...base);
    assert.equal(fact.status, 0, fact.err);
    assert.equal(fact.out.lane, 'now');
    assert.equal(fact.out.launch.via, 'print');
    assert.equal(fact.out.launch.command, `cd ${src} && <your agent CLI>`);
    assert.equal(fact.out.launch.prompt, `/factory-triage ${fact.out.file}`);
    // A machine-level launcher, read from the launchers bundle next to core: no repo installs it.
    mkdirSync(join(src, 'bundles', 'launchers', 'launch-x'), { recursive: true });
    writeFileSync(join(src, 'bundles', 'launchers', 'launch-x', 'launcher.json'), JSON.stringify({ argv: ['tool', '--cwd', '{repo}', '{prompt}'] }));
    writeFileSync(join(s.home, 'config.json'), JSON.stringify({ adapters: { sessionLauncher: 'launch-x' } }));
    const launched = run('candidate', '--kind', 'fact', '--summary', 'machine launch', ...base);
    assert.equal(launched.out.launch.via, 'launch-x');
    assert.deepEqual(launched.out.launch.argv.slice(0, 3), ['tool', '--cwd', src]);
    // A Codex session hands off to Codex, and the candidate records which agent found it.
    writeFileSync(join(src, 'bundles', 'launchers', 'launch-x', 'launcher.json'), JSON.stringify({ argv: ['tool', '--cwd', '{repo}', '{agent}', '{prompt}'] }));
    const cx = spawnSync(process.execPath, [LESSONS, 'candidate', '--kind', 'fact', '--summary', 'from codex', ...base], { encoding: 'utf8', env: { ...ENV, FACTORY_HOME: s.home, CODEX_THREAD_ID: 't1' } });
    const cxOut = JSON.parse(cx.stdout);
    assert.equal(cxOut.launch.argv[3], 'codex');
    assert.match(cxOut.launch.prompt, /^Use the factory-triage skill for /, 'no SKILL.md in this fixture: Codex is told the skill by name');
    assert.equal(JSON.parse(readFileSync(cxOut.file, 'utf8')).from.agent, 'codex');
    rmSync(join(s.home, 'config.json'));
    const pat = run('candidate', '--kind', 'pattern', '--summary', 'new rule', ...base);
    assert.equal(pat.out.lane, 'queue');
    assert.ok(!pat.out.launch);
    assert.equal(run('candidate', '--kind', 'pattern', '--summary', 'x', '--now', ...base).out.lane, 'now');
    assert.equal(run('candidate', '--kind', 'fact', '--summary', 'x', '--evidence', '[{"body":"pasted"}]', ...base).out.error, 'bad-evidence');
    const home = run('candidate', '--kind', 'fact', '--summary', 'here', '--scope', 'core', '--project', 'src', '--root', src);
    assert.equal(home.out.home, true, 'in the source repo itself there is nothing to launch');
    const q = run('queue');
    assert.equal(q.out.repos[0].repo, src);
    assert.equal(q.out.repos[0].queued, 6);
    assert.equal(q.out.repos[0].start, `cd ${src} && <your agent CLI>`);
    assert.equal(q.out.repos[0].prompt, '/factory-triage', 'no bundle SKILL.md in this fixture');
    // A bundle repo that doesn't install core gets the SKILL.md by path.
    mkdirSync(join(src, 'bundles', 'core', 'factory-triage'), { recursive: true });
    writeFileSync(join(src, 'bundles', 'core', 'factory-triage', 'SKILL.md'), '---\nname: factory-triage\n---\n');
    assert.equal(triagePrompt(src, '/h/c.json', { core: join(src, 'bundles', 'core') }), `Read ${join(src, 'bundles', 'core', 'factory-triage', 'SKILL.md')} and follow it for /h/c.json.`);
    mkdirSync(join(src, '.agents', 'skills', 'factory-triage'), { recursive: true });
    writeFileSync(join(src, '.agents', 'skills', 'factory-triage', 'SKILL.md'), 'x');
    assert.equal(triagePrompt(src, '/h/c.json', { core: join(src, 'bundles', 'core') }), '/factory-triage /h/c.json', 'installed: the slash command');
    assert.equal(q.out.repos[1].queued, 0);
  } finally { s.done(); }
});
