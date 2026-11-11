// Metrics: a transcript becomes counts only; the privacy schema refuses anything else; retention
// and the report hold their limits; the hook never fails a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { head, events, summarizeSession, checkRow, store, readRows, capture, trend, report } from './metrics.mjs';

const METRICS = join(dirname(fileURLToPath(import.meta.url)), 'metrics.mjs');
const T0 = Date.parse('2026-11-01T10:00:00Z'), MIN = 60000, DAY = 86400000;
const SECRET = 'sk-SECRET-token-9f8e7d';
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-metrics-')));
  return { dir, env: { FACTORY_HOME: join(dir, 'home') }, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const at = (m) => new Date(T0 + m * MIN).toISOString();
const call = (m, name, input) => JSON.stringify({ type: 'assistant', timestamp: at(m), message: { content: [{ type: 'tool_use', id: `t${m}`, name, input }] } });
const result = (m, content, isError = false) => JSON.stringify({ type: 'user', timestamp: at(m), message: { content: [{ type: 'tool_result', tool_use_id: `t${m}`, content, is_error: isError }] } });
const user = (m, text) => JSON.stringify({ type: 'user', timestamp: at(m), message: { content: text } });

function claudeTranscript() {
  return [
    user(0, `<command-name>/factory-review</command-name> please use ${SECRET}`),
    call(1, 'Skill', { skill: 'factory-reflect' }),
    call(2, 'Bash', { command: `cd /repo && git push origin main # ${SECRET}` }),
    result(2, 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: Modify Shared Resources', true),
    call(3, 'Bash', { command: 'pnpm test' }), result(3, `Exit code 1\n${SECRET}`, true),
    call(4, 'Bash', { command: 'pnpm test' }), result(4, 'Exit code 1', true),
    call(5, 'Bash', { command: 'pnpm test' }), result(5, 'Exit code 1', true),
    user(6, 'no, run the lint first'),
    call(30, 'Bash', { command: 'git commit -m x' }), result(30, 'PreToolUse:Bash hook error: [guard]: BLOCKED', true),
    call(31, 'Edit', { file_path: '/repo/a.md' }), result(31, "The user doesn't want to proceed with this tool use.", true),
    user(32, '[Request interrupted by user]'),
    'not json',
  ];
}

test('head keeps the command and its subcommand, never the arguments', () => {
  assert.equal(head('cd "/a b" && git commit -m "secret"'), 'git commit');
  assert.equal(head('FOO=1 node ./x/lessons.mjs land --repo /r'), 'node lessons.mjs');
  assert.equal(head('env -u GIT_DIR /usr/bin/git -C /r status'), 'git status');
  assert.equal(head("python3 - <<'EOF'"), 'python3');
  assert.equal(head('curl https://example.com/?token=abc'), 'curl');
});

test('a Claude transcript becomes counts: tools, heads, failures, denials, hook blocks, stuck, corrections, skills, layers', () => {
  const row = summarizeSession(events(claudeTranscript()), { session: 's1', harness: 'claude-code', project: 'shop',
    layerOf: (s) => ({ 'factory-reflect': 'core', 'factory-review': 'core', 'shop-auth': 'org' })[s] || null });
  assert.equal(checkRow(row), null);
  assert.deepEqual(row.tools, { Skill: 1, Bash: 5, Edit: 1 });
  assert.deepEqual(row.heads, { 'git push': 1, 'pnpm test': 3, 'git commit': 1 });
  assert.deepEqual(row.denials, { total: 1, heads: { 'git push': 1 } });
  assert.deepEqual(row.hookBlocks, { total: 1, heads: { 'git commit': 1 } });
  assert.equal(row.failures.total, 6);
  assert.deepEqual(row.stuck, { retries: 1, failStreaks: 1, idleGaps: 1 });
  assert.deepEqual(row.corrections, { interrupts: 1, rejects: 1, redirects: 1, heuristic: true });
  assert.deepEqual(row.skills, ['factory-reflect', 'factory-review']);
  assert.deepEqual(row.layers, ['core']);
  assert.ok(!JSON.stringify(row).includes('SECRET'), 'no content reaches the row');
  assert.ok(!JSON.stringify(row).includes('/repo'), 'no paths reach the row');
});

test('a Codex rollout counts the same way', () => {
  const ev = (m, payload) => JSON.stringify({ timestamp: at(m), type: 'response_item', payload });
  const lines = [
    ev(0, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] }),
    ev(1, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status'] }), call_id: 'a' }),
    ev(1, { type: 'function_call_output', call_id: 'a', output: JSON.stringify({ output: 'x', metadata: { exit_code: 1 } }) }),
    ev(2, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['pnpm', 'lint'] }), call_id: 'b' }),
    ev(2, { type: 'function_call_output', call_id: 'b', output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }) }),
  ];
  const row = summarizeSession(events(lines), { session: 'c1', harness: 'codex', project: 'p' });
  assert.equal(checkRow(row), null);
  assert.deepEqual(row.heads, { 'git status': 1, 'pnpm lint': 1 });
  assert.deepEqual(row.failures, { total: 1, heads: { 'git status': 1 } });
  assert.equal(row.turns, 1);
});

test('the privacy schema refuses content, unknown fields and non-counts', () => {
  const ok = summarizeSession(events(claudeTranscript()), { session: 's', harness: 'h', project: 'p' });
  assert.match(checkRow({ ...ok, prompt: 'hello' }), /row\.prompt is not a metrics field/);
  assert.match(checkRow({ ...ok, heads: { [`git push ${'x'.repeat(80)}`]: 1 } }), /row\.heads/);
  assert.match(checkRow({ ...ok, heads: { 'cat\nsecret': 1 } }), /row\.heads/);
  assert.match(checkRow({ ...ok, skills: ['a b c; rm -rf /'] }), /row\.skills/);
  assert.match(checkRow({ ...ok, failures: { ...ok.failures, total: 1.5 } }), /row\.failures\.total must be a count/);
  assert.throws(() => store({ ...ok, prompt: 'x' }, {}), /not a metrics field/);
});

test('store replaces a session\'s row, drops rows past 180 days, and keeps the newest under the cap', () => {
  const s = sandbox();
  try {
    const base = summarizeSession([], { session: 'x', harness: 'h', project: 'p' });
    const row = (session, t) => ({ ...base, session, at: new Date(t).toISOString() });
    store(row('old', T0 - 181 * DAY), s.env, T0 - 181 * DAY);
    store(row('a', T0 - DAY), s.env, T0);
    store({ ...row('a', T0), turns: 7 }, s.env, T0);
    store(row('b', T0), s.env, T0);
    assert.deepEqual(readRows(s.env).map((r) => [r.session, r.turns]), [['a', 7], ['b', 0]]);
    const size = readFileSync(join(s.env.FACTORY_HOME, 'metrics.jsonl'), 'utf8').length;
    store(row('c', T0 + 1), s.env, T0 + 1, Math.ceil(size * 1.1));
    assert.deepEqual(readRows(s.env).map((r) => r.session), ['b', 'c'], 'the oldest row goes first');
  } finally { s.done(); }
});

test('the report: weekly rates per layer, a before/after per landed lesson, the newest 12 kept', () => {
  const s = sandbox();
  try {
    const base = summarizeSession([], { session: 'x', harness: 'h', project: 'p' });
    const land = T0 + 14 * DAY;
    for (let d = 0; d < 28; d++) {
      const denied = d < 14 ? 2 : 0;
      store({ ...base, session: `s${d}`, at: new Date(T0 + d * DAY).toISOString(), layers: ['core'], denials: { total: denied, heads: denied ? { 'node lessons.mjs': denied } : {} } }, s.env, T0 + 28 * DAY);
    }
    const done = join(s.env.FACTORY_HOME, 'candidates', 'core', 'done'); mkdirSync(done, { recursive: true });
    writeFileSync(join(done, 'x.json'), JSON.stringify({ kind: 'fact', scope: 'core', summary: 'land refuses <outside> home', fixedWhen: { metric: 'permission_denials', match: 'lessons.mjs' }, done: { outcome: 'landed', at: new Date(land).toISOString() } }));
    writeFileSync(join(done, 'y.json'), JSON.stringify({ kind: 'fact', scope: 'core', summary: 'dropped', done: { outcome: 'dropped', at: new Date(land).toISOString() } }));
    const t = trend(readRows(s.env), [JSON.parse(readFileSync(join(done, 'x.json'), 'utf8'))], 'core', { days: 28, now: T0 + 28 * DAY });
    assert.equal(t.sessions, 28);
    assert.deepEqual(t.lessons.map((l) => [l.before, l.after]), [[2, 0]]);
    assert.equal(t.weeks[0].permission_denials, 2);
    assert.equal(t.weeks[3].permission_denials, 0);
    const reports = join(s.env.FACTORY_HOME, 'reports'); mkdirSync(reports, { recursive: true });
    for (let i = 1; i <= 13; i++) writeFileSync(join(reports, `2026-01-${String(i).padStart(2, '0')}-core.html`), 'x');
    const r = report({ days: 28 }, s.env, T0 + 28 * DAY);
    const html = readFileSync(r.reports[0].file, 'utf8');
    assert.match(html, /land refuses &lt;outside&gt; home/, 'escaped');
    assert.doesNotMatch(html, /dropped/, 'only landed lessons are markers');
    assert.equal(readdirSync(reports).filter((n) => n.endsWith('-core.html')).length, 12);
    assert.ok(!existsSync(join(reports, '2026-01-01-core.html')) && !existsSync(join(reports, '2026-01-02-core.html')));
  } finally { s.done(); }
});

test('the hook reads its JSON from stdin, writes the row, and exits 0 even on bad input', () => {
  const s = sandbox();
  try {
    const repo = join(s.dir, 'repo'); mkdirSync(join(repo, '.agents', 'factory-metadata'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'factory-metadata', 'skills-lock.json'), JSON.stringify({ skills: { 'factory-reflect': { bundle: 'core' }, 'factory-review': { bundle: 'core' } } }));
    const tr = join(s.dir, 't.jsonl'); writeFileSync(tr, claudeTranscript().join('\n'));
    const run = (input) => spawnSync(process.execPath, [METRICS, 'capture', '--hook'], { input, encoding: 'utf8', env: { ...process.env, ...s.env } });
    assert.equal(run(JSON.stringify({ session_id: 'hook-1', transcript_path: tr, cwd: repo, hook_event_name: 'SessionEnd' })).status, 0);
    const [row] = readRows(s.env);
    assert.equal(row.session, 'hook-1');
    assert.equal(row.project, 'repo');
    assert.deepEqual(row.layers, ['core']);
    assert.equal(run('not json').status, 0);
    assert.equal(run(JSON.stringify({ transcript_path: join(s.dir, 'missing.jsonl') })).status, 0);
    assert.equal(readRows(s.env).length, 1);
    assert.equal(capture({ transcript: tr, session: 'hook-1', cwd: repo }, s.env).rows, 1, 'a second capture replaces the row');
  } finally { s.done(); }
});
