import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSession, readClaude, readCodex, measure, OWN_SESSION_SLACK_MS } from './usage.mjs';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'factory-usage-test-')); return { d, dispose: () => rmSync(d, { recursive: true, force: true }) }; };

const usage = (input, read, write, out) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out });
const asst = (s, id, u, model = 'claude-sonnet-5-5', extra = {}) => ({ type: 'assistant', timestamp: at(s), message: { id, model, usage: u, content: [] }, ...extra });
const toolResult = (s) => ({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } });
const typed = (s) => ({ type: 'user', timestamp: at(s), message: { content: 'a person typing' } });

// A Claude Code project dir holding one session: <config>/projects/<slug>/<id>.jsonl
function claudeSession(d, id, rows, subagents = {}) {
  const dir = join(d, 'projects', '-some-worktree');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), jsonl(rows));
  for (const [name, sub] of Object.entries(subagents)) {
    mkdirSync(join(dir, id, 'subagents'), { recursive: true });
    writeFileSync(join(dir, id, 'subagents', `${name}.jsonl`), jsonl(sub));
  }
  return join(dir, `${id}.jsonl`);
}

test('claude: a message written as several lines counts once, and model time stops at a person or an interrupt', () => {
  const t = tmp(); try {
    const file = claudeSession(t.d, 'S1', [
      { type: 'user', timestamp: at(0), message: { content: 'Read phases/work.md and follow it.' } },
      asst(2, 'm1', usage(10, 1000, 200, 50)),
      asst(2, 'm1', usage(10, 1000, 200, 50)),          // same message, second content block
      toolResult(10), asst(14, 'm2', usage(5, 1300, 0, 40)),   // 4 s of model time
      toolResult(20), asst(21, 'syn', usage(0, 0, 0, 0), '<synthetic>'), // interrupt: not counted, gap closed
      asst(400, 'm3', usage(5, 1400, 10, 30)),
      toolResult(410), typed(415), asst(500, 'm4', usage(5, 1500, 0, 20)), // a person typed: gap closed
      asst(30, 'side', usage(9, 9, 9, 9), 'claude-sonnet-5-5', { isSidechain: true }),
    ]);
    const { first, metrics: m } = readClaude(file);
    assert.equal(first, T0);
    assert.equal(m.turns, 4);
    assert.equal(m.model_ms, 4000);
    assert.equal(m.model, 'claude-sonnet-5-5');
    assert.deepEqual(m.tokens, { input: 25, cache_read: 5200, cache_write: 210, output: 140 });
    assert.equal(m.peak_ctx, 1505);
    assert.equal(m.agents, 0);
    assert.equal(m.subagents, undefined);
  } finally { t.dispose(); }
});

test('claude: subagents are grouped by their model, and only those started inside the window count', () => {
  const t = tmp(); try {
    const file = claudeSession(t.d, 'S2', [asst(1, 'm1', usage(1, 100, 0, 10), 'claude-opus-5-5'), asst(200, 'm2', usage(1, 100, 0, 10), 'claude-opus-5-5')], {
      a: [asst(5, 'a1', usage(2, 50, 0, 7), 'claude-sonnet-5-5'), asst(6, 'a1', usage(2, 50, 0, 7), 'claude-sonnet-5-5')],
      b: [asst(8, 'b1', usage(3, 60, 0, 8), 'claude-sonnet-5-5')],
      late: [asst(900, 'c1', usage(9, 90, 0, 9), 'claude-haiku-5-5')],
    });
    const { metrics: m } = readClaude(file, { since: T0, until: T0 + 300_000 });
    assert.equal(m.turns, 2);
    assert.equal(m.model, 'claude-opus-5-5');
    assert.equal(m.agents, 2);
    assert.deepEqual(m.subagents, { 'claude-sonnet-5-5': { n: 2, tokens: { input: 5, cache_read: 110, cache_write: 0, output: 15 } } });
  } finally { t.dispose(); }
});

const codexRows = [
  { type: 'session_meta', timestamp: at(0), payload: { id: 'T1' } },
  { type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-x', effort: 'medium' } },
  { type: 'event_msg', timestamp: at(2), payload: { type: 'token_count', info: null } },
  { type: 'event_msg', timestamp: at(3), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 40 } } } },
  { type: 'response_item', timestamp: at(4), payload: { type: 'function_call' } },
  { type: 'response_item', timestamp: at(10), payload: { type: 'function_call_output' } },
  { type: 'response_item', timestamp: at(13), payload: { type: 'reasoning' } },
  { type: 'event_msg', timestamp: at(14), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 60 } } } },
];

test('codex: one turn per model call, cached input split out of input, model from turn_context', () => {
  const t = tmp(); try {
    const f = join(t.d, 'r.jsonl');
    writeFileSync(f, jsonl(codexRows));
    const { first, metrics: m } = readCodex(f);
    assert.equal(first, T0);
    assert.deepEqual(m, { turns: 2, peak_ctx: 1200, model: 'gpt-x', model_ms: 3000, tokens: { input: 300, cache_read: 1900, cache_write: 0, output: 100 } });
  } finally { t.dispose(); }
});

test('findSession reads each harness\'s session id from the environment', () => {
  const t = tmp(); try {
    const file = claudeSession(t.d, 'S3', [asst(1, 'm1', usage(1, 1, 1, 1))]);
    assert.deepEqual(findSession({ CLAUDE_CODE_SESSION_ID: 'S3', CLAUDE_CONFIG_DIR: t.d }), { agent: 'claude', file });
    assert.deepEqual(findSession({ CLAUDE_CODE_SESSION_ID: 'nope', CLAUDE_CONFIG_DIR: t.d }), { agent: 'claude', file: null });
    const day = join(t.d, 'codex', 'sessions', '2026', '03', '01');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-03-01T10-00-00-T1.jsonl'), jsonl(codexRows));
    assert.deepEqual(findSession({ CODEX_THREAD_ID: 'T1', CODEX_HOME: join(t.d, 'codex') }), { agent: 'codex', file: join(day, 'rollout-2026-03-01T10-00-00-T1.jsonl') });
    assert.equal(findSession({}), null);
  } finally { t.dispose(); }
});

test('measure refuses a session that started long before the run, or one with nothing in the window', () => {
  const t = tmp(); try {
    claudeSession(t.d, 'S4', [asst(0, 'm1', usage(1, 10, 0, 1)), asst(5000, 'm2', usage(1, 20, 0, 1))]);
    const env = { CLAUDE_CODE_SESSION_ID: 'S4', CLAUDE_CONFIG_DIR: t.d };
    assert.equal(measure(env, { since: T0, until: T0 + 10_000 }).turns, 1);
    const late = T0 + OWN_SESSION_SLACK_MS + 1000;          // the conductor's own session, say
    assert.equal(measure(env, { since: late, until: T0 + 6_000_000 }), null);
    assert.equal(measure(env, { since: T0 + 100_000, until: T0 + 200_000 }), null);
    assert.equal(measure({}, { since: T0 }), null);
  } finally { t.dispose(); }
});
