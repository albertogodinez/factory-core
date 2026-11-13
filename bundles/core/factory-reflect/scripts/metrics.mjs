#!/usr/bin/env node
// metrics.mjs: counted signals per session, and the trend report triage posts.
//
//   metrics.mjs capture --hook              read the hook's JSON on stdin ({session_id, transcript_path, cwd})
//   metrics.mjs capture --transcript <f> [--session <id>] [--cwd <dir>]
//   metrics.mjs report [--days 90] [--out <dir>]   writes <home>/reports/<date>-<core|org>.html
//
// A row holds counts, skill names and command heads: no prompts, file contents or tokens. checkRow
// enforces that before anything is written. Rows go to <home>/metrics.jsonl (home is $FACTORY_HOME or
// ~/.agents/factory), one per session; a later capture of the same session replaces its row. Rows
// older than 180 days, and the oldest beyond 5 MB, are dropped on each write. No LLM, no network,
// node: imports only. A hook run never fails the session: errors exit 0 silently.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sourceRepo } from './candidates.mjs';

export const KEEP_DAYS = 180, CAP_BYTES = 5 * 1024 * 1024, REPORTS_KEPT = 12, IDLE_MIN = 10;
const DAY = 86400000;
const home = (env = process.env) => (env.FACTORY_HOME ? resolve(env.FACTORY_HOME) : join(homedir(), '.agents/factory'));

// ---------- command heads ----------
// `git commit`, `pnpm test`, `node lessons.mjs`: enough to group, never the arguments.
export function head(command) {
  const words = String(command || '').replace(/^\s*(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, '').trim().split(/\s+/);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words[0] === 'env') { words.shift(); while (words.length && (/^-/.test(words[0]) || /=/.test(words[0]))) { if (words[0] === '-u') words.shift(); words.shift(); } }
  if (/(^|\/)git$/.test(words[0] || '') && words[1] === '-C') words.splice(1, 2);
  const w0 = basename(words[0] || '');
  if (!w0) return '';
  if (w0 === 'node' || w0 === 'python3' || w0 === 'python' || w0 === 'bash' || w0 === 'sh') {
    const script = words.slice(1).find((w) => !/^[-<>|&]/.test(w));
    return clip(script ? `${w0} ${basename(script)}` : w0);
  }
  const sub = words[1] && /^[a-z][\w:-]*$/.test(words[1]) ? ` ${words[1]}` : '';
  return clip(`${w0}${['git', 'gh', 'npm', 'pnpm', 'yarn', 'npx', 'hc', 'plannotator', 'factory', 'docker', 'brew', 'cargo', 'go', 'make'].includes(w0) ? sub : ''}`);
}
const clip = (s) => String(s).replace(/[^\w@./:+ -]/g, '').slice(0, 60);

// ---------- transcripts ----------
// Normalized events: {t, kind: 'call'|'result'|'user', name?, cmd?, error?, text?}.
export function events(lines) {
  const out = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = Date.parse(o.timestamp) || null;
    // Claude Code
    if ((o.type === 'assistant' || o.type === 'user') && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') { if (o.type === 'user') out.push({ t, kind: 'user', text: c }); continue; }
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === 'tool_use') out.push({ t, kind: 'call', name: b.name, cmd: b.input?.command, skill: b.name === 'Skill' ? b.input?.skill : undefined });
        else if (b.type === 'tool_result') out.push({ t, kind: 'result', error: b.is_error === true, text: flat(b.content) });
        else if (b.type === 'text' && o.type === 'user') out.push({ t, kind: 'user', text: b.text });
      }
      continue;
    }
    // Codex rollout
    const p = o.payload;
    if (o.type === 'response_item' && p) {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        let args = {}; try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || p.action || {}; } catch {}
        const cmd = Array.isArray(args.command) ? args.command.join(' ') : args.command || args.cmd;
        out.push({ t, kind: 'call', name: p.name || p.type, cmd: Array.isArray(args.command) && /^(bash|sh|zsh)$/.test(args.command[0]) ? args.command.slice(2).join(' ') : cmd });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const text = flat(p.output?.content ?? p.output);
        let code = null; try { code = JSON.parse(text)?.metadata?.exit_code ?? null; } catch {}
        const m = /(?:exit code|Exit code:?)\s*(\d+)/.exec(text);
        if (code === null && m) code = Number(m[1]);
        out.push({ t, kind: 'result', error: p.output?.success === false || (code !== null && code !== 0), text });
      } else if (p.type === 'message' && p.role === 'user') out.push({ t, kind: 'user', text: flat(p.content) });
    }
  }
  return out;
}
const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n') : c == null ? '' : JSON.stringify(c));

const DENIED = /Permission (?:to use \w+.*?|for this action )(?:has been|was) denied|denied by the .*classifier/i;
const HOOK_BLOCK = /^\s*(PreToolUse|PostToolUse|UserPromptSubmit|Stop)[:\w]* hook (error|blocked)|blocked by (a |the )?\w*\s*hook/i;
const INTERRUPT = /^\[Request interrupted by user/;
const REJECT = /The user doesn't want to proceed with this tool use|tool use was rejected/i;
const REDIRECT = /^\s*(no\b|nope|stop\b|don'?t\b|wait\b|actually\b|instead\b|that'?s (wrong|not)|wrong\b|undo\b|revert\b)/i;
const SKILL_CMD = /<command-name>\/?([\w:-]+)<\/command-name>/;

const bump = (m, k, n = 1) => { if (k) m[k] = (m[k] || 0) + n; };

// The counted row for one session's events. `layerOf(skill)` maps a skill to core or org.
export function summarizeSession(evs, { session, harness, project, layerOf = () => null, revs }) {
  const tools = {}, heads = {}, failHeads = {}, hookBlocks = {}, denialHeads = {};
  let failures = 0, denials = 0, interrupts = 0, rejects = 0, redirects = 0, idle = 0, streaks = 0, streak = 0, turns = 0;
  const skills = new Set(), cmdCount = {};
  let lastCall = null, prevKind = null, lastCmd = '';
  const times = evs.map((e) => e.t).filter(Boolean);
  for (const e of evs) {
    if (e.kind === 'call') {
      bump(tools, clip(e.name));
      if (e.skill) skills.add(clip(e.skill));
      lastCmd = e.cmd ? head(e.cmd) : clip(e.name);
      if (e.cmd) { bump(heads, lastCmd); bump(cmdCount, e.cmd); }
      if (e.t && lastCall && e.t - lastCall > IDLE_MIN * 60000) idle++;
      if (e.t) lastCall = e.t;
    } else if (e.kind === 'result') {
      const text = e.text || '';
      if (DENIED.test(text)) { denials++; bump(denialHeads, lastCmd); }
      else if (HOOK_BLOCK.test(text)) bump(hookBlocks, lastCmd);
      else if (REJECT.test(text)) rejects++;
      if (e.error) { failures++; bump(failHeads, lastCmd); streak++; if (streak === 3) streaks++; } else streak = 0;
    } else if (e.kind === 'user') {
      const text = e.text || '';
      const m = SKILL_CMD.exec(text);
      if (m) skills.add(clip(m[1]));
      if (INTERRUPT.test(text)) interrupts++;
      else if (prevKind === 'result' && REDIRECT.test(text)) redirects++;
      if (!/^<|^\[Request/.test(text.trim()) && text.trim()) turns++;
    }
    prevKind = e.kind;
  }
  const layers = [...new Set([...skills].map(layerOf).filter(Boolean))].sort();
  return {
    v: 1, session: clip(session), harness: clip(harness), project: clip(project),
    at: new Date(times.length ? Math.max(...times) : Date.now()).toISOString(),
    minutes: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 60000) : 0,
    turns, tools, heads, layers, skills: [...skills].sort(),
    failures: { total: failures, heads: failHeads },
    hookBlocks: { total: Object.values(hookBlocks).reduce((a, b) => a + b, 0), heads: hookBlocks },
    denials: { total: denials, heads: denialHeads },
    stuck: { retries: Object.values(cmdCount).filter((n) => n >= 3).length, failStreaks: streaks, idleGaps: idle },
    corrections: { interrupts, rejects, redirects, heuristic: true },
    ...(revs && Object.keys(revs).length ? { revs } : {}),
  };
}

// ---------- the privacy schema ----------
// Every string is a name, a head or an id: one short token run. A count map's keys obey the same rule.
const TOKEN = /^[\w@./:+ -]{0,60}$/;
const SHAPE = { v: 'n', session: 's', harness: 's', project: 's', at: 'iso', minutes: 'n', turns: 'n', tools: 'map', heads: 'map', layers: 'list', skills: 'list',
  failures: { total: 'n', heads: 'map' }, hookBlocks: { total: 'n', heads: 'map' }, denials: { total: 'n', heads: 'map' },
  stuck: { retries: 'n', failStreaks: 'n', idleGaps: 'n' }, corrections: { interrupts: 'n', rejects: 'n', redirects: 'n', heuristic: 'b' },
  revs: 'revs?' };
const REV = /^[0-9a-f]{7,40}$/;
export function checkRow(row, shape = SHAPE, path = 'row') {
  if (!row || typeof row !== 'object') return `${path} must be an object`;
  for (const k of Object.keys(row)) if (!(k in shape)) return `${path}.${k} is not a metrics field`;
  for (const [k, t] of Object.entries(shape)) {
    const v = row[k], p = `${path}.${k}`;
    if (t === 'revs?') {
      if (v !== undefined && !(v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([kk, r]) => TOKEN.test(kk) && typeof r === 'string' && REV.test(r)))) return `${p} must map layers to commit ids`;
      continue;
    }
    if (typeof t === 'object') { const e = checkRow(v, t, p); if (e) return e; continue; }
    if (t === 'n' && !(Number.isInteger(v) && v >= 0)) return `${p} must be a count`;
    if (t === 'b' && typeof v !== 'boolean') return `${p} must be a boolean`;
    if (t === 's' && !(typeof v === 'string' && TOKEN.test(v))) return `${p} must be a short name`;
    if (t === 'iso' && !(typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.length < 30)) return `${p} must be a timestamp`;
    if (t === 'list' && !(Array.isArray(v) && v.every((x) => typeof x === 'string' && TOKEN.test(x)))) return `${p} must list short names`;
    if (t === 'map' && !(v && typeof v === 'object' && Object.entries(v).every(([kk, n]) => TOKEN.test(kk) && Number.isInteger(n)))) return `${p} must map short names to counts`;
  }
  return null;
}

// ---------- the store ----------
const metricsFile = (env) => join(home(env), 'metrics.jsonl');
export function readRows(env) {
  try { return readFileSync(metricsFile(env), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
// Upsert by session, then apply retention: 180 days, then the newest rows under 5 MB.
export function store(row, env = process.env, now = Date.now(), cap = CAP_BYTES) {
  const problem = checkRow(row);
  if (problem) throw new Error(`metrics: ${problem}`);
  let rows = readRows(env).filter((r) => r.session !== row.session && now - Date.parse(r.at) <= KEEP_DAYS * DAY);
  rows.push(row);
  rows.sort((a, b) => a.at.localeCompare(b.at));
  let lines = rows.map((r) => JSON.stringify(r));
  let size = lines.reduce((a, l) => a + l.length + 1, 0);
  while (size > cap && lines.length > 1) size -= lines.shift().length + 1;
  const f = metricsFile(env);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.${process.pid}`, lines.join('\n') + '\n');
  renameSync(`${f}.${process.pid}`, f);
  return { file: f, rows: lines.length };
}

// The session repo's skills-lock.json skills, found by walking up to the repo root.
function lockSkills(cwd) {
  let dir = resolve(cwd || '.');
  for (;;) {
    const lock = join(dir, '.agents', 'factory-metadata', 'skills-lock.json');
    if (existsSync(lock)) { try { return JSON.parse(readFileSync(lock, 'utf8')).skills || {}; } catch { return null; } }
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}
const layerOfBundle = (b) => (b ? (b === 'core' ? 'core' : 'org') : null);
// core or org per installed skill, from the session repo's skills-lock.json.
export function layerMap(cwd) {
  const skills = lockSkills(cwd);
  return skills ? (s) => layerOfBundle(skills[s]?.bundle) : () => null;
}
// The source revision each layer was installed at: the most common sourceRev among its skills. The
// report splits sessions before and after a land by this, not by date.
export function lockRevs(cwd) {
  const skills = lockSkills(cwd) || {}, count = {};
  for (const s of Object.values(skills)) {
    const layer = layerOfBundle(s?.bundle);
    if (!layer || !REV.test(String(s.sourceRev || ''))) continue;
    (count[layer] ||= {})[s.sourceRev] = (count[layer][s.sourceRev] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(count).map(([l, m]) => [l, Object.entries(m).sort((a, b) => b[1] - a[1])[0][0]]));
}

// The harness bundle revision each layer had applied on this machine (factory harness --apply), as
// harness-core / harness-org, for the harness this session ran in.
export function harnessRevs(env, harness) {
  let applied = {};
  try { applied = JSON.parse(readFileSync(join(home(env), 'harness-applied.json'), 'utf8')); } catch { return {}; }
  const out = {};
  for (const [bundle, s] of Object.entries(applied?.[harness]?.sources || {})) {
    if (REV.test(String(s?.rev || ''))) out[`harness-${bundle === 'core' ? 'core' : 'org'}`] = s.rev;
  }
  return out;
}
export function capture({ transcript, session, cwd, harness }, env = process.env, now = Date.now()) {
  const lines = readFileSync(transcript, 'utf8').split('\n');
  const evs = events(lines);
  const h = harness || (/\.codex\//.test(transcript) ? 'codex' : 'claude-code');
  const row = summarizeSession(evs, { session: session || basename(transcript).replace(/\.jsonl$/, ''), harness: h, project: basename(resolve(cwd || '.')), layerOf: layerMap(cwd), revs: { ...lockRevs(cwd), ...harnessRevs(env, h) } });
  return { ...store(row, env, now), session: row.session };
}

// ---------- the report ----------
// Signals a candidate's fixedWhen.metric can name, read from a row (match filters by command head).
export const SIGNALS = {
  permission_denials: (r, m) => (m ? sumMatch(r.denials?.heads, m) : r.denials?.total || 0),
  tool_failures: (r, m) => (m ? sumMatch(r.failures?.heads, m) : r.failures?.total || 0),
  hook_blocks: (r, m) => (m ? sumMatch(r.hookBlocks?.heads, m) : r.hookBlocks?.total || 0),
  corrections: (r) => (r.corrections?.interrupts || 0) + (r.corrections?.rejects || 0) + (r.corrections?.redirects || 0),
  stuck: (r) => (r.stuck?.retries || 0) + (r.stuck?.failStreaks || 0) + (r.stuck?.idleGaps || 0),
};
const sumMatch = (m, s) => Object.entries(m || {}).filter(([k]) => k.includes(s) || s.includes(k)).reduce((a, [, n]) => a + n, 0);
const SERIES = ['tool_failures', 'permission_denials', 'hook_blocks', 'corrections', 'stuck'];

// better / flat / worse for a lesson's signal; null without both sides.
export function verdict(before, after) {
  if (before == null || after == null) return null;
  return after < before ? 'better' : after > before ? 'worse' : 'flat';
}
// Weekly per-session rates for one layer, landed lessons as markers, and before/after per fixedWhen.
// A lesson whose land recorded its commit splits the 14 days either side by revision: a session ran
// the lesson when its revs[layer] contains that commit (`contains(rev, commit)`, git ancestry).
// Without a commit, or with no session carrying revs, it splits by the land's date.
export function trend(rows, landed, layer, { days = 90, now = Date.now(), contains } = {}) {
  const from = now - days * DAY, mine = rows.filter((r) => Date.parse(r.at) >= from && (r.layers || []).includes(layer));
  const weeks = [];
  for (let s = from; s < now; s += 7 * DAY) {
    const w = mine.filter((r) => { const t = Date.parse(r.at); return t >= s && t < s + 7 * DAY; });
    const rate = Object.fromEntries(SERIES.map((k) => [k, w.length ? w.reduce((a, r) => a + SIGNALS[k](r), 0) / w.length : null]));
    weeks.push({ start: new Date(s).toISOString().slice(0, 10), sessions: w.length, ...rate });
  }
  const lessons = landed.filter((c) => c.scope === layer && Date.parse(c.done?.at) >= from).map((c) => {
    const t = Date.parse(c.done.at), f = c.fixedWhen;
    const mean = (w) => (w.length && f && SIGNALS[f.metric] ? +(w.reduce((s, r) => s + SIGNALS[f.metric](r, f.match), 0) / w.length).toFixed(2) : null);
    // A harness lesson changes every session on the machine, not only those using a skill of its layer.
    const key = c.kind === 'harness' ? `harness-${layer}` : layer;
    const pool = c.kind === 'harness' ? rows : mine;
    const within = (a, b) => pool.filter((r) => { const x = Date.parse(r.at); return x >= a && x < b; });
    const near = within(t - 14 * DAY, t + 14 * DAY).filter((r) => r.revs?.[key]);
    let before, after, by = 'date';
    if (c.done.commit && contains && near.length) {
      const ran = near.filter((r) => contains(r.revs[key], c.done.commit));
      before = mean(near.filter((r) => !ran.includes(r))); after = mean(ran); by = 'revision';
    } else { before = mean(within(t - 7 * DAY, t)); after = mean(within(t, t + 7 * DAY)); }
    return { at: c.done.at, summary: c.summary, metric: f?.metric || null, match: f?.match || null, ...(c.done.commit ? { commit: c.done.commit } : {}),
      before, after, by, verdict: verdict(before, after) };
  });
  return { layer, sessions: mine.length, weeks, lessons };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function renderHtml(t, date) {
  const W = 720, H = 220, P = 32, max = Math.max(1, ...t.weeks.flatMap((w) => SERIES.map((k) => w[k] || 0)));
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, t.weeks.length - 1), y = (v) => H - P - (v / max) * (H - 2 * P);
  const lines = SERIES.map((k, n) => {
    const pts = t.weeks.map((w, i) => (w[k] == null ? null : `${x(i).toFixed(1)},${y(w[k]).toFixed(1)}`)).filter(Boolean).join(' ');
    return pts ? `<polyline fill="none" stroke="var(--c${n + 1})" stroke-width="2" points="${pts}"><title>${k}</title></polyline>` : '';
  }).join('');
  const t0 = t.weeks.length ? Date.parse(t.weeks[0].start) : 0, span = Math.max(1, t.weeks.length - 1) * 7 * DAY;
  const marks = t.lessons.map((l) => { const mx = P + ((Date.parse(l.at) - t0) / span) * (W - 2 * P); return `<line x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="${P}" y2="${H - P}" stroke="var(--muted)" stroke-dasharray="3 3"><title>${esc(l.summary)}</title></line>`; }).join('');
  const legend = SERIES.map((k, n) => `<span><i style="background:var(--c${n + 1})"></i>${k.replace(/_/g, ' ')}</span>`).join('');
  const rows = t.lessons.map((l) => `<tr><td>${esc(l.at.slice(0, 10))}</td><td>${esc(l.summary)}</td><td>${esc(l.metric || '—')}${l.match ? ` <code>${esc(l.match)}</code>` : ''}</td><td>${l.before ?? '—'}</td><td>${l.after ?? '—'}</td><td>${esc(l.verdict || '—')}${l.by === 'revision' ? ' (by revision)' : ''}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Factory trend ${esc(t.layer)}</title>
<style>:root{--bg:#fff;--fg:#1b1d22;--muted:#6b7280;--c1:#2563eb;--c2:#dc2626;--c3:#d97706;--c4:#7c3aed;--c5:#059669}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e5e7eb;--muted:#9ca3af;--c1:#60a5fa;--c2:#f87171;--c3:#fbbf24;--c4:#a78bfa;--c5:#34d399}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:760px}
svg{width:100%;height:auto}.legend span{margin-right:12px;white-space:nowrap}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--muted);padding:4px 6px;text-align:left;vertical-align:top}</style></head><body>
<h1>${esc(t.layer)} · ${esc(date)}</h1><p>${t.sessions} session(s) with a ${esc(t.layer)} skill active, per-session rates by week. Dashed lines: lessons landed. Corrections are a heuristic.</p>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="weekly rates"><line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="var(--muted)"/>${marks}${lines}<text x="${P}" y="${P - 8}" fill="var(--muted)" font-size="11">max ${max.toFixed(2)} / session</text></svg>
<p class="legend">${legend}</p><h2>Lessons and their signal</h2><p>Mean per session before and after each land: by the installed revision when the land recorded its commit, else 7 days either side. Flat means it didn't work, and triage reopens that cluster. Worse means it made things worse, and triage queues a fact to revert or rework it.</p>
<table><tr><th>Landed</th><th>Lesson</th><th>fixedWhen</th><th>Before</th><th>After</th><th>Verdict</th></tr>${rows || '<tr><td colspan="6">No lessons landed in this window.</td></tr>'}</table></body></html>
`;
}

function landedCandidates(h) {
  const out = [];
  for (const scope of ['core', 'org']) {
    const d = join(h, 'candidates', scope, 'done');
    let names = []; try { names = readdirSync(d).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const n of names) { try { const c = JSON.parse(readFileSync(join(d, n), 'utf8')); if (c.done?.outcome === 'landed') out.push(c); } catch {} }
  }
  return out;
}

// Whether a session's installed revision contains a land's commit, by git ancestry in the layer's
// source repo. Cached: a report asks about the same pairs many times.
function ancestry(repo) {
  const seen = new Map();
  return (rev, commit) => {
    const k = `${rev} ${commit}`;
    if (!seen.has(k)) seen.set(k, !!repo && spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, rev]).status === 0);
    return seen.get(k);
  };
}

// Writes one report per layer and keeps the newest 12 per layer. `worse` lists the lessons whose
// signal rose after they landed, for triage to queue a revert or rework.
export function report({ days = 90, out } = {}, env = process.env, now = Date.now()) {
  const h = home(env), dir = out || join(h, 'reports'), date = new Date(now).toISOString().slice(0, 10);
  mkdirSync(dir, { recursive: true });
  const rows = readRows(env), landed = landedCandidates(h), written = [];
  let sources = {}; try { sources = JSON.parse(readFileSync(join(h, 'installs.json'), 'utf8')).sources || {}; } catch {}
  for (const layer of ['core', 'org']) {
    const t = trend(rows, landed, layer, { days, now, contains: ancestry(sourceRepo(layer, sources)) });
    const f = join(dir, `${date}-${layer}.html`);
    writeFileSync(f, renderHtml(t, date));
    written.push({ layer, file: f, sessions: t.sessions, lessons: t.lessons });
    const mine = readdirSync(dir).filter((n) => n.endsWith(`-${layer}.html`)).sort();
    for (const n of mine.slice(0, Math.max(0, mine.length - REPORTS_KEPT))) rmSync(join(dir, n), { force: true });
  }
  return { reports: written, worse: written.flatMap((w) => w.lessons.filter((l) => l.verdict === 'worse').map((l) => ({ layer: w.layer, ...l }))) };
}

// ---------- CLI ----------
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--hook') o.hook = true; else if (a.startsWith('--')) o[a.slice(2)] = argv[++i]; }
  return o;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  if (cmd === 'capture' && o.hook) {
    try {
      const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
      const transcript = input.transcript_path || input.transcriptPath;
      if (transcript && existsSync(transcript) && statSync(transcript).size) capture({ transcript, session: input.session_id || input.sessionId, cwd: input.cwd });
    } catch {}
    process.exit(0);
  }
  try {
    let res;
    if (cmd === 'capture') { if (!o.transcript) throw new Error('capture needs --transcript <file> or --hook'); res = capture({ transcript: o.transcript, session: o.session, cwd: o.cwd || process.cwd() }); }
    else if (cmd === 'report') res = report({ days: o.days ? Number(o.days) : 90, out: o.out });
    else throw new Error('usage: metrics.mjs capture --hook | capture --transcript <f> | report [--days N] [--out dir]');
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
