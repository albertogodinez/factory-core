#!/usr/bin/env node
// state.mjs: the one file a ticket's phases hand over through. The conductor creates it, starts each
// phase (in its own launcher session when the machine has one), and reads back only what a phase
// left in state.json and its notes, never the phase's transcript. node: imports only. Prints JSON,
// except `status`, which prints one line.
//
//   init   --worktree <path> (--ticket <key> | --plan p | both) [--recipe skill] [--test-cmd c] [--state-root dir]
//   show   --state <file> [--field a.b]
//   set    --state <file> key=value ...           (value parsed as JSON when it parses)
//   start  --state <file> <phase> [--what words]
//                                                 (records a run; prints its n, tag, role, what and title)
//   launch --state <file> <phase> [--task text] [--what words] [--run]
//                                                 (start + the session to open it in; --run opens it)
//                                                 --what: a few words naming the run ("fix page-view reset");
//                                                 the session's name where the launcher shows it
//   end    --state <file> <phase> --notes <file|->  (validates the notes, applies their handoff)
//   kill   --state <file> <phase> --why <text>    (the conductor's notes for a phase it stopped)
//   live   --state <file>                         (tags of this ticket's phase sessions still open)
//   status --state <file>
//   digest --state <file>                         (every run's notes and metrics, for factory-reflect)
//
// The state lives at <stateRoot>/conductor/state.json, where stateRoot is the factory-context
// resolver's for the ticket's worktree. One worktree holds one ticket's state: init refuses another.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validate } from '../../factory-context/scripts/validate.mjs';
import { launchFor, afterLaunch, liveTags, pickLauncher, pickAgent } from '../../factory-reflect/scripts/candidates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = dirname(HERE);
const RESOLVER = join(SKILL, '..', 'factory-context', 'scripts', 'resolve.mjs');
export const PHASES = ['intake', 'work', 'review', 'deploy', 'ci-monitor', 'close'];
const schema = (n) => JSON.parse(readFileSync(join(SKILL, 'schemas', `${n}.schema.json`), 'utf8'));

export class StateError extends Error {}
const fail = (m) => { throw new StateError(m); };
const now = () => new Date().toISOString();
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function resolveWorktree(worktree) {
  const r = spawnSync(process.execPath, [RESOLVER, '--cwd', worktree], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) fail(`resolver failed for ${worktree}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return JSON.parse(r.stdout);
}

function save(file, state) {
  const errs = validate(schema('state'), state);
  if (errs.length) fail(`state would be invalid: ${errs.join('; ')}`);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
  return state;
}

export function load(file) {
  if (!existsSync(file)) fail(`no state at ${file}; run init first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// What a ticket's status line and default tab names call it: its key, or the plan's name until intake files the ticket.
export const label = (state) => state.ticket || (state.plan ? basename(state.plan).replace(/\.md$/, '') : state.slug);

export function init({ worktree, ticket, plan = null, recipe = null, testCmd, stateRoot, ctx }) {
  if (!worktree || (!ticket && !plan)) fail('init needs --worktree, and --ticket or --plan (a plan-first run gets its ticket at intake)');
  worktree = resolve(worktree);
  ctx = ctx || (stateRoot ? {} : resolveWorktree(worktree));
  const root = stateRoot || ctx.stateRoot;
  if (!root) fail('no stateRoot: pass --state-root, or run inside a registered project');
  const file = join(root, 'conductor', 'state.json');
  if (existsSync(file)) {
    const old = load(file);
    if (ticket ? old.ticket !== ticket : old.plan !== plan) fail(`${file} holds ${label(old)}, not ${ticket || plan}: finish or remove it, or use a worktree of its own`);
    return { file, state: old, existed: true };
  }
  const git = (args) => spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).stdout?.trim() || null;
  const state = {
    // The slug tags this ticket's sessions. stateRoot's basename alone ("main") repeats across repos.
    version: 1, slug: `${basename(root)}-${createHash('sha1').update(file).digest('hex').slice(0, 8)}`, ticket: ticket || null, plan, repo: ctx.project?.root ? mainCheckout(worktree) : null, worktree,
    branch: git(['branch', '--show-current']), trunk: ctx.project?.trunk || null, base: null, recipe,
    pr: null, head_sha: git(['rev-parse', 'HEAD']), reviewed_range: null,
    test_cmd: testCmd ?? ctx.project?.commands?.test ?? null, ci: null,
    decisions: null, phase: null, blocked: null, findings: [], phases: {},
  };
  return { file, state: save(file, state), existed: false };
}

function mainCheckout(worktree) {
  const common = spawnSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout?.trim();
  return common ? dirname(common) : worktree;
}

function parseValue(v) { try { return JSON.parse(v); } catch { return v; } }

export function set(file, pairs) {
  const state = load(file);
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) fail(`set takes key=value, got "${p}"`);
    const keys = p.slice(0, i).split('.');
    let o = state;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    o[keys.at(-1)] = parseValue(p.slice(i + 1));
  }
  return save(file, state);
}

// Who a phase session is, for wherever the launcher shows it: a role, and a few words on what this run
// does. The words are only ever the conductor's own (--what): a session given none keeps its default name.
export const ROLES = { intake: 'intake', work: 'worker', review: 'reviewer', deploy: 'deploy', 'ci-monitor': 'monitor', close: 'close' };
const WHAT_CHARS = 60;

export function describe(what) {
  const t = String(what ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, WHAT_CHARS) : null;
}

export function start(file, phase, at = now(), { what } = {}) {
  if (!phase) fail('start needs a phase');
  const state = load(file);
  if (state.phase && state.phase !== phase) fail(`${state.phase} is still running; end or kill it before starting ${phase}`);
  const runs = (state.phases[phase] ??= { runs: [] }).runs;
  const open = runs.find((r) => !r.ended);
  if (open) fail(`${phase} run ${open.n} is still open; end or kill it first`);
  const n = runs.length + 1;
  const tag = `conductor:${state.slug}:${phase}:${n}`;
  const role = ROLES[phase] || phase;
  const desc = describe(what);
  runs.push({ n, started: at, tag, role, ...(desc ? { what: desc } : {}) });
  state.phase = phase;
  state.blocked = null;
  save(file, state);
  return { phase, n, tag, role, what: desc, title: desc || `${label(state)} · ${phase}${n > 1 ? ` ${n}` : ''}` };
}

// The prompt a phase session starts with. A recipe skill's phases/<phase>.md replaces the default.
export function phasePrompt(state, phase, file, n, task) {
  const recipe = state.recipe && join(state.worktree, '.agents', 'skills', state.recipe, 'phases', `${phase}.md`);
  const own = join(SKILL, 'references', 'phases', `${phase}.md`);
  const path = recipe && existsSync(recipe) ? recipe : own;
  if (!existsSync(path)) fail(`no prompt for phase ${phase} (looked in ${[recipe, own].filter(Boolean).join(', ')})`);
  return { path, prompt: `Read ${path} and follow it. State file: ${file}. Phase run: ${n}.${task ? ` Task: ${task}` : ''}` };
}

// The repo's adapters, raw so a `sessionLauncher: null` survives. A linked worktree without its own
// project.json inherits the main checkout's, as the resolver does.
function repoAdaptersFor(worktree) {
  for (const root of [worktree, mainCheckout(worktree)]) {
    const p = join(root, '.agents', 'factory-metadata', 'project.json');
    if (existsSync(p)) return readJson(p, {}).adapters || {};
  }
  return {};
}

const factoryHome = (env) => (env.FACTORY_HOME ? resolve(env.FACTORY_HOME) : join(homedir(), '.agents/factory'));

function launcherSetup(state, env) {
  const home = factoryHome(env);
  const machine = readJson(join(home, 'config.json'), {});
  const sources = readJson(join(home, 'installs.json'), {}).sources || {};
  const repoAdapters = repoAdaptersFor(state.worktree);
  const skillsDirs = [join(state.worktree, '.agents', 'skills'), sources.core && join(dirname(sources.core), 'launchers')];
  return { launcher: pickLauncher(repoAdapters, machine), agent: pickAgent(machine, { repoAdapters, env }), skillsDirs };
}

// Start a phase run and say how to open it: in its own launcher session (a terminal tab named by --what,
// such as "CI on #1029", else "<ticket> · <phase>") when the machine has a launcher, else as a subagent of the conductor.
export function launch(file, phase, { task, what, run = false, env = process.env } = {}) {
  const r = start(file, phase, now(), { what });
  const state = load(file);
  const { path, prompt } = phasePrompt(state, phase, file, r.n, task);
  const { launcher, agent, skillsDirs } = launcherSetup(state, env);
  const l = launchFor({ launcher, skillsDirs, repo: state.worktree, prompt, agent, tag: r.tag, title: r.title, role: r.role, what: r.what });
  if (l.via === 'print') return { ...r, via: 'subagent', prompt, promptFile: path, ...(l.note ? { note: l.note } : {}) };
  const out = { ...r, via: l.via, prompt, promptFile: path, command: l.command };
  if (!run) return { ...out, after: l.after?.command };
  const p = spawnSync(l.argv[0], l.argv.slice(1), { encoding: 'utf8', timeout: 60000 });
  if (p.status !== 0) return { ...out, opened: false, error: (p.stderr || p.error?.message || `exit ${p.status}`).trim().split('\n')[0] };
  const note = afterLaunch({ launcher, skillsDirs, output: p.stdout, title: r.title });
  return { ...out, opened: true, ...(note ? { note } : {}) };
}

export function live(file, env = process.env) {
  const state = load(file);
  const { launcher, skillsDirs } = launcherSetup(state, env);
  const tags = liveTags({ launcher, skillsDirs });
  return tags === null ? null : tags.filter((t) => t.startsWith(`conductor:${state.slug}:`));
}

function mergeFindings(old = [], next = []) {
  const byId = new Map(old.map((f) => [f.id, f]));
  for (const f of next) byId.set(f.id, { ...byId.get(f.id), ...f });
  return [...byId.values()];
}

export function end(file, phase, notes, at = now()) {
  const errs = validate(schema('phase-notes'), notes);
  if (errs.length) fail(`notes are invalid: ${errs.join('; ')}`);
  if (notes.phase !== phase) fail(`notes are for ${notes.phase}, not ${phase}`);
  if (notes.outcome === 'blocked' && !notes.question) fail('a blocked phase names its question');
  const state = load(file);
  const run = state.phases[phase]?.runs.find((r) => !r.ended);
  if (!run) fail(`no open ${phase} run to end`);
  const notesFile = join(dirname(file), 'notes', `${phase}-${run.n}.json`);
  mkdirSync(dirname(notesFile), { recursive: true });
  writeFileSync(notesFile, JSON.stringify(notes, null, 2) + '\n');
  Object.assign(run, { ended: at, wall_ms: Math.max(0, Date.parse(at) - Date.parse(run.started)), outcome: notes.outcome, notes: notesFile });
  const { findings, ...rest } = notes.handoff || {};
  Object.assign(state, rest);
  if (findings) state.findings = mergeFindings(state.findings, findings);
  state.phase = null;
  state.blocked = notes.outcome === 'blocked' ? { phase, question: notes.question } : null;
  save(file, state);
  return { phase, n: run.n, outcome: notes.outcome, notes: notesFile, status: status(state) };
}

export function kill(file, phase, why, at) {
  if (!why) fail('kill needs --why: the reason is the lesson');
  return end(file, phase, { phase, outcome: 'killed', summary: `stopped by the conductor: ${why}`, friction: [why] }, at);
}

export function status(state) {
  const open = state.findings.filter((f) => f.status === 'open').length;
  const parts = [label(state), `phase=${state.phase ?? '-'}`];
  if (state.pr) parts.push(`pr=${state.pr}`);
  if (state.base && state.base !== state.trunk) parts.push(`stacked-on=${state.base}`);
  if (state.head_sha) parts.push(`head=${state.head_sha.slice(0, 8)}`);
  if (state.ci) parts.push(`ci=${state.ci}`);
  parts.push(`findings=${open} open/${state.findings.length}`);
  const done = PHASES.filter((p) => state.phases[p]?.runs.some((r) => r.outcome === 'pass'));
  parts.push(`done=${done.join(',') || '-'}`);
  if (state.blocked) parts.push(`BLOCKED(${state.blocked.phase}): ${state.blocked.question}`);
  return parts.join(' ');
}

// What factory-reflect reads instead of transcripts: each run's notes and the per-phase totals.
export function digest(file) {
  const state = load(file);
  const phases = {};
  const runs = [];
  for (const [phase, { runs: rs }] of Object.entries(state.phases)) {
    phases[phase] = { runs: rs.length, wall_ms: rs.reduce((a, r) => a + (r.wall_ms || 0), 0),
      outcomes: rs.map((r) => r.outcome || 'open'), rounds: 0, turns: 0, agents: 0, user_interventions: 0, peak_ctx: 0 };
    for (const r of rs) {
      const notes = r.notes ? readJson(r.notes, null) : null;
      if (notes?.metrics) for (const k of ['rounds', 'turns', 'agents', 'user_interventions']) phases[phase][k] += notes.metrics[k] || 0;
      if (notes?.metrics?.peak_ctx) phases[phase].peak_ctx = Math.max(phases[phase].peak_ctx, notes.metrics.peak_ctx);
      runs.push({ phase, n: r.n, started: r.started, ended: r.ended ?? null, notes });
    }
  }
  return { ticket: state.ticket, slug: state.slug, pr: state.pr, worktree: state.worktree, decisions: state.decisions, phases, runs };
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } }
    else o._.push(a);
  }
  return o;
}

export function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const o = args(rest);
  const file = o.state && resolve(o.state);
  const need = () => { if (!file) fail(`${cmd} needs --state <file>`); return file; };
  switch (cmd) {
    case 'init': {
      const r = init({ worktree: o.worktree, ticket: o.ticket, plan: o.plan || null, recipe: o.recipe || null, testCmd: o['test-cmd'], stateRoot: o['state-root'] || env.FACTORY_STATE_ROOT });
      return { file: r.file, existed: r.existed, status: status(r.state) };
    }
    case 'show': { const s = load(need()); return o.field ? o.field.split('.').reduce((v, k) => v?.[k], s) ?? null : s; }
    case 'set': return { status: status(set(need(), o._)) };
    case 'start': return start(need(), o._[0], now(), { what: o.what });
    case 'launch': return launch(need(), o._[0], { task: o.task, what: o.what, run: !!o.run, env });
    case 'end': {
      if (!o.notes) fail('end needs --notes <file|->');
      const notes = JSON.parse(o.notes === '-' ? readFileSync(0, 'utf8') : readFileSync(o.notes, 'utf8'));
      return end(need(), o._[0], notes);
    }
    case 'kill': return kill(need(), o._[0], o.why);
    case 'live': return live(need(), env);
    case 'status': return status(load(need()));
    case 'digest': return digest(need());
    default: fail(`unknown command "${cmd ?? ''}"; see the header of state.mjs`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const out = main(process.argv.slice(2));
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } catch (e) {
    if (!(e instanceof StateError)) throw e;
    console.error(JSON.stringify({ error: 'conductor', message: e.message }));
    process.exit(1);
  }
}
