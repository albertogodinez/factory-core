#!/usr/bin/env node
// usage.mjs: what one phase run used, read from the session log its harness already writes. A phase's
// own count of its turns and context is a guess (it left peak_ctx at 0 on every run), and the model it
// ran on is something it can't see at all. One reader per harness; a harness without one, a log that
// isn't found, or a session that started long before the run (a phase run as the conductor's subagent,
// or `end` typed in the conductor's own session) measures nothing, and the phase's self-report stands.
// node: imports only, local files only.
//
//   node usage.mjs --since <iso> [--until <iso>]   (measures the session this command runs in)
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// A launched phase's session starts after `launch` records the run. One that started this much earlier
// belongs to someone else.
export const OWN_SESSION_SLACK_MS = 10 * 60 * 1000;

const ms = (t) => (t ? Date.parse(t) : NaN);
function records(file) {
  const out = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* a line still being written */ }
  }
  return out;
}
const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const addTokens = (a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k]; return a; };
const mostUsed = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

// Which harness this command runs in, and its session log. Each harness leaves its session id in the
// environment of the commands it runs.
export function findSession(env = process.env) {
  if (env.CLAUDE_CODE_SESSION_ID) {
    const root = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
    const name = `${env.CLAUDE_CODE_SESSION_ID}.jsonl`;
    const dir = list(root).find((d) => existsSync(join(root, d, name)));
    return { agent: 'claude', file: dir ? join(root, dir, name) : null };
  }
  if (env.CODEX_THREAD_ID) {
    const root = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
    const desc = (d) => list(d).sort().reverse();
    for (const y of desc(root)) for (const m of desc(join(root, y))) for (const d of desc(join(root, y, m))) {
      const f = list(join(root, y, m, d)).find((n) => n.endsWith(`-${env.CODEX_THREAD_ID}.jsonl`));
      if (f) return { agent: 'codex', file: join(root, y, m, d, f) };
    }
    return { agent: 'codex', file: null };
  }
  return null;
}

// Claude Code writes one line per content block, each repeating its message's id and usage, so
// messages are counted by id. Subagents keep their own logs in <session>/subagents/.
export function readClaude(file, { since = -Infinity, until = Infinity } = {}) {
  let first = null;
  const own = new Map();
  let modelMs = 0, lastResult = null;
  for (const j of records(file)) {
    const t = ms(j.timestamp);
    if (Number.isFinite(t)) first ??= t;
    if (j.isSidechain || !(t >= since && t <= until)) continue;
    const content = j.message?.content;
    // Model time runs from a tool result to the model's next message. A person typing, or a message
    // the harness made up (an interrupt, an API error), ends that gap without counting it.
    if (j.type === 'user') lastResult = Array.isArray(content) && content.some((c) => c.type === 'tool_result') ? t : null;
    if (j.type === 'assistant' && j.message) {
      if (j.message.model === '<synthetic>') { lastResult = null; continue; }
      if (lastResult !== null) { modelMs += t - lastResult; lastResult = null; }
      own.set(j.message.id || j.uuid, j.message);
    }
  }
  const tally = (msgs) => {
    const tokens = { input: 0, cache_read: 0, cache_write: 0, output: 0 }, models = {};
    let peak = 0;
    for (const m of msgs) {
      const u = m.usage || {};
      const t = { input: u.input_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 };
      addTokens(tokens, t);
      peak = Math.max(peak, t.input + t.cache_read + t.cache_write);
      if (m.model) models[m.model] = (models[m.model] || 0) + 1;
    }
    return { tokens, models, peak };
  };
  const main = tally(own.values());
  const subagents = {};
  let agents = 0;
  const dir = join(file.replace(/\.jsonl$/, ''), 'subagents');
  for (const n of list(dir).filter((n) => n.endsWith('.jsonl'))) {
    const msgs = new Map();
    let started = null;
    for (const j of records(join(dir, n))) {
      const t = ms(j.timestamp);
      if (Number.isFinite(t)) started ??= t;
      if (j.type === 'assistant' && j.message && j.message.model !== '<synthetic>') msgs.set(j.message.id || j.uuid, j.message);
    }
    if (!(started >= since && started <= until) || !msgs.size) continue;
    const s = tally(msgs.values());
    const model = mostUsed(s.models) || 'unknown';
    const g = (subagents[model] ??= { n: 0, tokens: { input: 0, cache_read: 0, cache_write: 0, output: 0 } });
    g.n++;
    addTokens(g.tokens, s.tokens);
    agents++;
  }
  return { first, metrics: { turns: own.size, peak_ctx: main.peak, model: mostUsed(main.models), model_ms: modelMs,
    tokens: main.tokens, agents, ...(agents ? { subagents } : {}) } };
}

// Codex logs one token_count event per model call, with that call's usage in last_token_usage, and the
// model of each turn in turn_context. Its input_tokens include the cached ones.
export function readCodex(file, { since = -Infinity, until = Infinity } = {}) {
  let first = null, turns = 0, peak = 0, modelMs = 0, lastResult = null, before = null;
  const tokens = { input: 0, cache_read: 0, cache_write: 0, output: 0 }, models = {};
  for (const j of records(file)) {
    const t = ms(j.timestamp);
    if (Number.isFinite(t)) first ??= t;
    const p = j.payload || {};
    if (j.type === 'turn_context' && p.model && t < since) before = p.model;
    if (!(t >= since && t <= until)) continue;
    if (j.type === 'turn_context' && p.model) models[p.model] = (models[p.model] || 0) + 1;
    if (j.type === 'event_msg' && p.type === 'token_count' && p.info?.last_token_usage) {
      const u = p.info.last_token_usage;
      turns++;
      const cached = u.cached_input_tokens || 0;
      addTokens(tokens, { input: Math.max(0, (u.input_tokens || 0) - cached), cache_read: cached, cache_write: u.cache_write_input_tokens || 0, output: u.output_tokens || 0 });
      peak = Math.max(peak, u.input_tokens || 0);
    }
    if (j.type === 'response_item') {
      if (/_call_output$/.test(p.type || '')) lastResult = t;
      else if (lastResult !== null) { modelMs += t - lastResult; lastResult = null; }
    }
  }
  return { first, metrics: { turns, peak_ctx: peak, model: mostUsed(models) || before, model_ms: modelMs, tokens } };
}

const READERS = { claude: readClaude, codex: readCodex };

// The metrics of the run between since and until (epoch ms), or null when they can't be measured.
export function measure(env, { since, until = Date.now() }) {
  const s = findSession(env);
  if (!s?.file || !READERS[s.agent]) return null;
  let r;
  try { r = READERS[s.agent](s.file, { since, until }); } catch { return null; }
  if (r.first === null || r.first < since - OWN_SESSION_SLACK_MS || !r.metrics.turns) return null;
  const m = { ...r.metrics };
  if (!m.model) delete m.model;
  return m;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const since = Date.parse(opt('--since') || '');
  if (!Number.isFinite(since)) { console.error('usage.mjs needs --since <iso time>'); process.exit(2); }
  const until = opt('--until') ? Date.parse(opt('--until')) : Date.now();
  console.log(JSON.stringify(measure(process.env, { since, until }), null, 2));
}
