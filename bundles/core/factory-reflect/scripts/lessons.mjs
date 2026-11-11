#!/usr/bin/env node
// lessons.mjs: the lesson log, the cross-repo index and the candidate queue for factory-reflect.
//
//   lessons.mjs record --scope repo|core|org --fingerprint <slug> --summary <text>
//                      [--destination <path>] [--status applied|proposed] [--source <session|PR>]
//   lessons.mjs decide --fingerprint <slug> --decision never [--summary <text>]
//                                            a lesson family triage must never land; known lists it
//   lessons.mjs known [--scope core|org] [--never]   fingerprints seen before, and the never list
//   lessons.mjs target --skill <name>        the source repo that owns an installed skill
//   lessons.mjs classify --text <s> | --file <f>   core or org for new content, by the installed
//                                            skills' internal-data.json patterns
//   lessons.mjs start --repo <dir> --slug <s> a lesson branch and worktree in that source repo
//   lessons.mjs open [--repo <dir>,<dir>]     open lesson branches (default: every bundle source repo)
//   lessons.mjs candidate --kind fact|pattern|harness --scope core|org --summary <text>
//                      [--skill <name>] [--evidence <json array>] [--draft <patch>] [--fixed-when <json>]
//                      [--slug <s>] [--session <id>] [--now | --queue]
//                                            hand a lesson to its source repo; prints the lane and launch
//   lessons.mjs queue [--scope core|org] [--skill <name>]   queued candidates, their source repo and launch command,
//                                            and the open lesson branches: what's waiting
//   lessons.mjs done --file <candidate> --outcome landed|dropped|merged
//   lessons.mjs land --repo <dir> --branch <b> --reviewed <sha>
//                                            fast-forward trunk to a reviewed branch, then clean up;
//                                            only from a session started in that repo (wrong-session)
//
// start, open, land and classify live in landing.mjs; candidate, queue and done in candidates.mjs. Exit 1 with {error, message} when one refuses.
//
// Every lesson goes to <stateRoot>/lessons.jsonl. A core or org lesson also goes to
// ~/.agents/factory/lessons-index.jsonl (or $FACTORY_HOME), which spans every repo; entries expire
// after 90 days without a new occurrence. Nothing counts to a threshold: factory-triage clusters the
// queued candidates, and a cluster's size is the count that matters. Prints JSON. node: imports only.
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { start, open, land, classify, LandingError } from './landing.mjs';
import { writeCandidate, queue, markDone, sourceRepo, launchFor, triagePrompt } from './candidates.mjs';

export const EXPIRY_DAYS = 90;
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

// Occurrences per fingerprint across the index, with expiry and the never list.
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
    let reason = `${live.length} in ${EXPIRY_DAYS} days`;
    if (now - last > EXPIRY_DAYS * DAY) reason = 'expired';
    if (d?.decision === 'never') reason = 'never';
    out.push({ fingerprint: s.fingerprint, scope: s.scope, summary: s.summary, occurrences: live.length,
      projects: [...s.projects].filter(Boolean).sort(), lastSeen: new Date(last).toISOString(), reason });
  }
  // A never decided in triage for a family no single fingerprint named.
  for (const [fp, d] of Object.entries(decisions.fingerprints || {})) {
    if (d?.decision === 'never' && !by.has(fp)) out.push({ fingerprint: fp, scope: d.scope || null, summary: d.summary || fp, occurrences: 0, projects: [], lastSeen: d.at, reason: 'never' });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences || a.fingerprint.localeCompare(b.fingerprint));
}

const SKILLS_DIR = dirname(dirname(dirname(realpathSync(import.meta.filename))));
function context() {
  const resolver = join(SKILLS_DIR, 'factory-context', 'scripts', 'resolve.mjs');
  if (!existsSync(resolver)) return { error: `no resolver at ${resolver}` };
  const r = spawnSync(process.execPath, [resolver], { encoding: 'utf8' });
  if (r.status !== 0) return { error: (r.stderr || '').trim() };
  return JSON.parse(r.stdout);
}

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--now' || a === '--queue' || a === '--never') o[a.slice(2)] = true;
    else if (a.startsWith('--')) { const v = argv[i + 1]; if (v == null || v.startsWith('--')) fail(`${a} needs a value`); o[a.slice(2)] = v; i++; }
    else o._.push(a);
  }
  return o;
}

export function run(cmd, o, env = process.env, now = Date.now()) {
  const decisions = readJson(decisionsFile(env), { fingerprints: {} });
  decisions.fingerprints ||= {};
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
    return { recorded: local, index: indexFile(env), ...s, ...(s.reason === 'never' ? { note: 'marked never: drop it, or ask the user before handing it upstream' } : {}) };
  }
  if (cmd === 'decide') {
    const fp = normalizeFingerprint(o.fingerprint);
    if (!fp) fail('--fingerprint is required');
    if (o.decision !== 'never') fail('--decision must be never (triage decides the rest; a cluster\'s size is the count)');
    decisions.fingerprints[fp] = { decision: 'never', at: new Date(now).toISOString(), ...(o.summary ? { summary: o.summary } : {}), ...(o.scope ? { scope: o.scope } : {}) };
    writeJson(decisionsFile(env), decisions);
    return { fingerprint: fp, decision: 'never' };
  }
  if (cmd === 'known') {
    return summarize(readJsonl(indexFile(env)), decisions, now)
      .filter((s) => (!o.scope || s.scope === o.scope) && (!o.never || s.reason === 'never'))
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
    if (!sourceDir || !existsSync(sourceDir)) return { skill: o.skill, installed: true, bundle: s.bundle, note: `the ${s.bundle} bundle's source isn't on this machine; record the lesson and hand it over where that bundle lives` };
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: sourceDir, encoding: 'utf8' }).stdout.trim();
    return { skill: o.skill, installed: true, bundle: s.bundle, sourceDir, repo: top || null,
      next: 'a session started in that repo edits the skill on a lesson branch, reviews and lands it; consumers pull the change at their next session start' };
  }
  if (cmd === 'start') return start({ repo: o.repo || process.cwd(), slug: o.slug, date: o.date, trunk: o.trunk, home: home(env) });
  if (cmd === 'open') {
    const repos = o.repo ? o.repo.split(',') : Object.values(readJson(join(home(env), 'installs.json'), {}).sources || {});
    return { branches: open({ repos }) };
  }
  if (cmd === 'land') return land({ repo: o.repo || process.cwd(), branch: o.branch, reviewed: o.reviewed, trunk: o.trunk });
  if (cmd === 'candidate') {
    const json = (k) => { if (o[k] === undefined) return undefined; try { return JSON.parse(o[k]); } catch { throw new LandingError('usage', `--${k} is not valid JSON`); } };
    const ctx = o.project ? { project: { name: o.project, root: o.root }, adapters: {} } : context();
    if (ctx.error) fail(ctx.error);
    const from = { project: ctx.project?.name, root: ctx.project?.root, ...(o.session ? { session: o.session } : {}) };
    const w = writeCandidate({ home: home(env), kind: o.kind, scope: o.scope, skill: o.skill, summary: o.summary, evidence: json('evidence') ?? [],
      draft: o.draft, fixedWhen: json('fixed-when'), from, slug: o.slug, now: o.now, queue: o.queue, at: now });
    const sources = readJson(join(home(env), 'installs.json'), {}).sources || {};
    const repo = sourceRepo(o.scope, sources);
    const out = { file: w.file, lane: w.lane, kind: w.candidate.kind, scope: w.candidate.scope, repo };
    if (!repo) return { ...out, note: `the ${o.scope} source repo isn't on this machine; the candidate waits until a session there runs factory-triage` };
    const prompt = triagePrompt(repo, w.file, sources);
    if (from.root && repo === from.root) return { ...out, home: true, next: `you are in the source repo: ${prompt}` };
    // Fast lane: start the source repo's session now. Queue: the status hook there names it.
    if (w.lane === 'now') return { ...out, launch: launchFor({ launcher: ctx.adapters?.sessionLauncher, skillsDir: o['skills-dir'] || SKILLS_DIR, repo, prompt }) };
    return { ...out, next: `queued: the next factory-triage session in ${repo} takes it` };
  }
  if (cmd === 'queue') {
    const sources = readJson(join(home(env), 'installs.json'), {}).sources || {};
    const scopes = o.scope ? [o.scope] : ['core', 'org'];
    const repos = scopes.map((sc) => {
      const items = queue(home(env), sc, now).filter((c) => !o.skill || c.skill === o.skill);
      const repo = sourceRepo(sc, sources);
      return { scope: sc, repo, queued: items.length, oldestDays: items.length ? Math.max(...items.map((c) => c.ageDays)) : null,
        candidates: items.map(({ file, kind, skill, summary, lane, ageDays }) => ({ file, kind, skill, summary, lane, ageDays })),
        ...(repo && items.length ? { start: `cd ${repo} && <your agent CLI>`, prompt: triagePrompt(repo, '', sources) } : {}) };
    });
    const branches = open({ repos: Object.values(sources) }).map(({ repo, branch, commits, worktree }) => ({ repo, branch, commits: commits.length, worktree }));
    return { repos, branches };
  }
  if (cmd === 'done') {
    if (!['landed', 'dropped', 'merged'].includes(o.outcome)) fail('--outcome must be landed, dropped or merged');
    if (!o.file) fail('--file is required');
    return markDone(home(env), o.file, o.outcome, now);
  }
  if (cmd === 'classify') {
    if (o.text === undefined && !o.file) fail('classify needs --text or --file');
    return classify({ text: o.text ?? readFileSync(o.file, 'utf8'), skillsDir: o['skills-dir'] });
  }
  fail('usage: lessons.mjs record|decide|known|target|candidate|queue|done|start|open|land|classify (see the header of this file)');
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
