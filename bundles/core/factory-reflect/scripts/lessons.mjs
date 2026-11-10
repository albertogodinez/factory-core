#!/usr/bin/env node
// lessons.mjs: the lesson log and the cross-repo promotion index for factory-reflect.
//
//   lessons.mjs record --scope repo|core|org --fingerprint <slug> --summary <text>
//                      [--destination <path>] [--status applied|proposed] [--source <session|PR>]
//   lessons.mjs due [--session <id>]         fingerprints ready for the promotion prompt (max 3 a session)
//   lessons.mjs decide --fingerprint <slug> --decision promote|not-now|never [--session <id>]
//   lessons.mjs known [--scope core|org]     fingerprints seen before, so a new lesson can reuse one
//   lessons.mjs target --skill <name>        the source repo to promote an edit of an installed skill into
//   lessons.mjs classify --text <s> | --file <f>   core or org for new content, by the installed
//                                            skills' internal-data.json patterns
//   lessons.mjs start --repo <dir> --slug <s> a lesson branch and worktree in that source repo
//   lessons.mjs open [--repo <dir>,<dir>]     open lesson branches (default: every bundle source repo)
//   lessons.mjs land --repo <dir> --branch <b> --reviewed <sha>
//                                            fast-forward trunk to a reviewed branch, then clean up
//
// start, open, land and classify live in landing.mjs. Exit 1 with {error, message} when one refuses.
//
// Every lesson goes to <stateRoot>/lessons.jsonl. A core or org lesson also goes to
// ~/.agents/factory/lessons-index.jsonl (or $FACTORY_HOME), which spans every repo. A fingerprint
// is due when it has 3+ occurrences in the last 90 days, hasn't been promoted or marked never,
// and, if snoozed ("not now"), has a new occurrence since. Prints JSON. node: imports only.
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { start, open, land, classify, LandingError } from './landing.mjs';

export const THRESHOLD = 3, EXPIRY_DAYS = 90, PROMPTS_PER_SESSION = 3;
const DAY = 86400000;

const home = (env = process.env) => (env.FACTORY_HOME ? resolve(env.FACTORY_HOME) : join(homedir(), '.agents/factory'));
const indexFile = (env) => join(home(env), 'lessons-index.jsonl');
const decisionsFile = (env) => join(home(env), 'lessons-decisions.json');
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
function writeJson(f, v) { mkdirSync(dirname(f), { recursive: true }); const t = `${f}.${process.pid}`; writeFileSync(t, JSON.stringify(v, null, 2) + '\n'); renameSync(t, f); }
function fail(m, c = 2) { process.stderr.write(`lessons: ${m}\n`); process.exit(c); }

export function normalizeFingerprint(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// Counts per fingerprint across the index, honouring expiry and decisions.
export function summarize(entries, decisions, now = Date.now()) {
  const by = new Map();
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const s = by.get(e.fingerprint) || { fingerprint: e.fingerprint, scope: e.scope, occurrences: [], projects: new Set(), summary: e.summary };
    s.occurrences.push(t); s.projects.add(e.project); s.summary = e.summary || s.summary; s.scope = e.scope || s.scope;
    by.set(e.fingerprint, s);
  }
  const out = [];
  for (const s of by.values()) {
    const last = Math.max(...s.occurrences);
    const live = s.occurrences.filter((t) => now - t <= EXPIRY_DAYS * DAY);
    const d = decisions.fingerprints?.[s.fingerprint];
    let due = live.length >= THRESHOLD, reason = due ? 'threshold' : `${live.length}/${THRESHOLD} in ${EXPIRY_DAYS} days`;
    if (now - last > EXPIRY_DAYS * DAY) { due = false; reason = 'expired'; }
    if (d?.decision === 'never') { due = false; reason = 'never'; }
    if (d?.decision === 'promote') { due = false; reason = 'promoted'; }
    if (d?.decision === 'not-now' && !(last > Date.parse(d.at))) { due = false; reason = 'snoozed until it happens again'; }
    out.push({ fingerprint: s.fingerprint, scope: s.scope, summary: s.summary, occurrences: live.length,
      projects: [...s.projects].filter(Boolean).sort(), lastSeen: new Date(last).toISOString(), due, reason });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences || a.fingerprint.localeCompare(b.fingerprint));
}

export function promptText(s) {
  const n = s.projects.length;
  return `We've seen "${s.summary || s.fingerprint}" ${s.occurrences} times across ${n} repo${n === 1 ? '' : 's'} (${s.projects.join(', ')}). Promote it to ${s.scope}? [promote / not now / never]`;
}

function context() {
  const resolver = join(dirname(dirname(dirname(realpathSync(import.meta.filename)))), 'factory-context', 'scripts', 'resolve.mjs');
  const r = spawnSync(process.execPath, [resolver], { encoding: 'utf8' });
  if (r.status !== 0) return { error: (r.stderr || '').trim() };
  return JSON.parse(r.stdout);
}

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const v = argv[i + 1]; if (v == null || v.startsWith('--')) fail(`${a} needs a value`); o[a.slice(2)] = v; i++; }
    else o._.push(a);
  }
  return o;
}

export function run(cmd, o, env = process.env, now = Date.now()) {
  const decisions = readJson(decisionsFile(env), { fingerprints: {}, sessions: {} });
  decisions.fingerprints ||= {}; decisions.sessions ||= {};
  if (cmd === 'record') {
    if (!['repo', 'core', 'org'].includes(o.scope)) fail('--scope must be repo, core or org');
    const fp = normalizeFingerprint(o.fingerprint);
    if (!fp) fail('--fingerprint is required');
    if (!o.summary) fail('--summary is required');
    const ctx = o.project ? { project: { name: o.project, root: o.root }, stateRoot: o['state-root'] } : context();
    if (ctx.error) fail(ctx.error);
    const entry = { ts: new Date(now).toISOString(), fingerprint: fp, scope: o.scope, summary: o.summary,
      project: ctx.project?.name, root: ctx.project?.root, destination: o.destination || null,
      status: o.status || 'proposed', source: o.source || 'session' };
    const local = join(ctx.stateRoot, 'lessons.jsonl');
    mkdirSync(dirname(local), { recursive: true });
    appendFileSync(local, JSON.stringify(entry) + '\n');
    if (o.scope === 'repo') return { recorded: local, fingerprint: fp, scope: 'repo' };
    mkdirSync(home(env), { recursive: true });
    appendFileSync(indexFile(env), JSON.stringify(entry) + '\n');
    const s = summarize(readJsonl(indexFile(env)), decisions, now).find((x) => x.fingerprint === fp);
    return { recorded: local, index: indexFile(env), ...s };
  }
  if (cmd === 'due') {
    const session = o.session || 'default';
    const used = decisions.sessions[session] || 0;
    const left = Math.max(0, PROMPTS_PER_SESSION - used);
    const due = summarize(readJsonl(indexFile(env)), decisions, now).filter((s) => s.due).slice(0, left);
    return { session, promptsLeft: left, due: due.map((s) => ({ ...s, prompt: promptText(s) })) };
  }
  if (cmd === 'decide') {
    const fp = normalizeFingerprint(o.fingerprint);
    if (!['promote', 'not-now', 'never'].includes(o.decision)) fail('--decision must be promote, not-now or never');
    decisions.fingerprints[fp] = { decision: o.decision, at: new Date(now).toISOString() };
    const session = o.session || 'default';
    decisions.sessions[session] = (decisions.sessions[session] || 0) + 1;
    writeJson(decisionsFile(env), decisions);
    return { fingerprint: fp, decision: o.decision };
  }
  if (cmd === 'known') {
    return summarize(readJsonl(indexFile(env)), decisions, now)
      .filter((s) => !o.scope || s.scope === o.scope)
      .map(({ fingerprint, scope, summary, occurrences, reason }) => ({ fingerprint, scope, summary, occurrences, reason }));
  }
  if (cmd === 'target') {
    if (!o.skill) fail('--skill is required');
    const ctx = context();
    if (ctx.error) fail(ctx.error);
    // The lock sits at the project root (committed install) or the main checkout (local-only);
    // stateRoot is <that root>/.agents/factory-metadata/state/<worktree>.
    const roots = [ctx.project?.root, dirname(dirname(dirname(dirname(ctx.stateRoot || ''))))].filter(Boolean);
    const lockPath = roots.map((r) => join(r, '.agents/factory-metadata', 'skills-lock.json')).find(existsSync);
    const s = lockPath ? readJson(lockPath, { skills: {} }).skills?.[o.skill] : null;
    if (!s) return { skill: o.skill, installed: false, note: 'not installed by factory: the skill belongs to this repo, so edit it here (repo scope)' };
    // Bundle source paths are machine-specific, so factory keeps them in ~/.agents/factory/installs.json.
    const bundleDir = readJson(join(home(env), 'installs.json'), {}).sources?.[s.bundle];
    const sourceDir = bundleDir && join(bundleDir, o.skill);
    if (!sourceDir || !existsSync(sourceDir)) return { skill: o.skill, installed: true, bundle: s.bundle, note: `the ${s.bundle} bundle's source isn't on this machine; record the lesson and promote it where that bundle lives` };
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: sourceDir, encoding: 'utf8' }).stdout.trim();
    return { skill: o.skill, installed: true, bundle: s.bundle, sourceDir, repo: top || null,
      next: 'edit the skill there on a local branch lesson/<fingerprint>, commit, have the user review it, then run factory update --all' };
  }
  if (cmd === 'start') return start({ repo: o.repo || process.cwd(), slug: o.slug, date: o.date, trunk: o.trunk, home: home(env) });
  if (cmd === 'open') {
    const repos = o.repo ? o.repo.split(',') : Object.values(readJson(join(home(env), 'installs.json'), {}).sources || {});
    return { branches: open({ repos }) };
  }
  if (cmd === 'land') return land({ repo: o.repo || process.cwd(), branch: o.branch, reviewed: o.reviewed, trunk: o.trunk });
  if (cmd === 'classify') {
    if (o.text === undefined && !o.file) fail('classify needs --text or --file');
    return classify({ text: o.text ?? readFileSync(o.file, 'utf8'), skillsDir: o['skills-dir'] });
  }
  fail('usage: lessons.mjs record|due|decide|known|target|start|open|land|classify (see the header of this file)');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    process.stdout.write(JSON.stringify(run(cmd, parse(rest)), null, 2) + '\n');
  } catch (e) {
    if (!(e instanceof LandingError)) throw e;
    process.stdout.write(JSON.stringify({ error: e.code, message: e.message, ...(e.fix ? { fix: e.fix } : {}) }, null, 2) + '\n');
    process.exit(e.code === 'usage' ? 2 : 1);
  }
}
