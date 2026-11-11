// candidates.mjs: the handoff from a downstream session to the source repo that owns a lesson.
// lessons.mjs is the CLI; these are its candidate and queue commands.
//
// A candidate is one JSON file at <home>/candidates/<core|org>/<ts>-<slug>.json, machine-local and
// untracked. It points at evidence; it never carries pasted transcript content. Its kind sets the
// lane: a fact is wrong today, so it launches a session in the source repo now; a pattern or a
// harness lesson waits in the queue for triage, which batches it with its family. The queue is the
// files still in the folder; triage moves each one to done/ when it lands or is dropped.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync, renameSync, statSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LandingError, slugify } from './landing.mjs';

export const KINDS = ['fact', 'pattern', 'harness'];
export const SCOPES = ['core', 'org'];
export const DONE_DAYS = 90;
const EVIDENCE_KEYS = ['transcript', 'grep', 'pr', 'thread', 'commit', 'file', 'line', 'url', 'note'];
const DAY = 86400000;

// The lane comes from the kind, in code. --now / --queue override it for a one-off.
export function laneOf(kind, { now, queue } = {}) {
  if (now && queue) throw new LandingError('usage', '--now and --queue are exclusive');
  if (now) return 'now';
  if (queue) return 'queue';
  return kind === 'fact' ? 'now' : 'queue';
}

// Evidence is pointers: short strings under known keys. A pasted transcript fails here.
export function checkEvidence(list) {
  if (!Array.isArray(list)) return 'evidence must be a JSON array of objects';
  for (const [i, e] of list.entries()) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return `evidence[${i}] must be an object`;
    for (const [k, v] of Object.entries(e)) {
      if (!EVIDENCE_KEYS.includes(k)) return `evidence[${i}].${k}: use one of ${EVIDENCE_KEYS.join(', ')}`;
      if (typeof v !== 'string' && typeof v !== 'number') return `evidence[${i}].${k} must be a string or number`;
      if (String(v).length > 300 || /\n/.test(String(v))) return `evidence[${i}].${k} is a pointer, not content: one line, at most 300 chars`;
    }
  }
  return null;
}

const dirOf = (home, scope) => join(home, 'candidates', scope);
const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export function writeCandidate({ home, kind, scope, skill, summary, evidence = [], draft, fixedWhen, from = {}, slug, now: nowFlag, queue, at = Date.now() }) {
  if (!KINDS.includes(kind)) throw new LandingError('usage', `--kind must be ${KINDS.join(', ')}`);
  if (!SCOPES.includes(scope)) throw new LandingError('usage', '--scope must be core or org (a repo-scope lesson stays in its PR)');
  if (!summary) throw new LandingError('usage', '--summary is required');
  const problem = checkEvidence(evidence);
  if (problem) throw new LandingError('bad-evidence', problem);
  if (fixedWhen !== undefined && (!fixedWhen || typeof fixedWhen !== 'object' || typeof fixedWhen.metric !== 'string')) throw new LandingError('usage', '--fixed-when must be a JSON object with a "metric"');
  const lane = laneOf(kind, { now: nowFlag, queue });
  const name = `${stamp(at)}-${slugify(slug || summary) || 'lesson'}`;
  const dir = dirOf(home, scope);
  mkdirSync(dir, { recursive: true });
  let draftRel;
  if (draft) {
    if (!existsSync(draft)) throw new LandingError('usage', `--draft ${draft} does not exist`);
    copyFileSync(draft, join(dir, `${name}.patch`));
    draftRel = `candidates/${scope}/${name}.patch`;
  }
  const candidate = { kind, scope, ...(skill ? { skill } : {}), summary, evidence, ...(draftRel ? { draft: draftRel } : {}),
    ...(fixedWhen ? { fixedWhen } : {}), from, lane, at: new Date(at).toISOString() };
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(candidate, null, 2) + '\n');
  return { file, lane, candidate };
}

// The queue: candidates not yet done, oldest first, optionally for one scope.
export function queue(home, scope, at = Date.now()) {
  const out = [];
  for (const s of scope ? [scope] : SCOPES) {
    let names = [];
    try { names = readdirSync(dirOf(home, s)); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
      const file = join(dirOf(home, s), n);
      let c;
      try { c = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      out.push({ file, ...c, ageDays: Math.floor((at - (Date.parse(c.at) || at)) / DAY) });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Triage moves a candidate (and its draft) to done/ with what happened to it, and prunes done/.
export function markDone(home, file, outcome, at = Date.now()) {
  if (!existsSync(file)) throw new LandingError('usage', `${file} is not a queued candidate`);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const done = join(dirname(file), 'done');
  mkdirSync(done, { recursive: true });
  const target = join(done, basename(file));
  writeFileSync(target, JSON.stringify({ ...c, done: { outcome, at: new Date(at).toISOString() } }, null, 2) + '\n');
  rmSync(file);
  const patch = file.replace(/\.json$/, '.patch');
  if (existsSync(patch)) renameSync(patch, join(done, basename(patch)));
  prune(done, at);
  return { done: target, outcome };
}
export function prune(done, at = Date.now()) {
  let removed = 0;
  try {
    for (const n of readdirSync(done)) {
      const p = join(done, n);
      if (at - statSync(p).mtimeMs > DONE_DAYS * DAY) { rmSync(p, { force: true }); removed++; }
    }
  } catch {}
  return removed;
}

// The source repo a scope's lessons land in: core's bundle repo, or the first other repo holding bundles.
export function sourceRepo(scope, sources) {
  const rootOf = (d) => {
    if (!d || !existsSync(d)) return null;
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: d, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const c = r.stdout.trim();
    return basename(c) === '.git' ? dirname(c) : c;
  };
  const core = rootOf(sources?.core);
  if (scope === 'core') return core;
  for (const [b, d] of Object.entries(sources || {})) {
    if (b === 'core') continue;
    const r = rootOf(d);
    if (r && r !== core) return r;
  }
  return null;
}

// The prompt that starts triage in the source repo: the slash command where factory-triage is
// installed, else the bundle's SKILL.md by path (a bundle's own repo doesn't install it).
export function triagePrompt(repo, target, sources = {}) {
  if (existsSync(join(repo, '.agents', 'skills', 'factory-triage', 'SKILL.md'))) return `/factory-triage ${target}`.trim();
  const md = sources.core && join(sources.core, 'factory-triage', 'SKILL.md');
  return md && existsSync(md) ? `Read ${md} and follow it${target ? ` for ${target}` : ''}.` : `/factory-triage ${target}`.trim();
}

const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// How to start the source repo's session: the adapter's argv when adapters.sessionLauncher names an
// installed skill with a launcher.json, else a command for the user to run (prefix it with ! to run it
// in their own session).
export function launchFor({ launcher, skillsDir, repo, prompt }) {
  const manual = { via: 'print', command: `cd ${sh(repo)} && <your agent CLI>`, prompt };
  if (!launcher) return manual;
  const f = join(skillsDir, launcher, 'launcher.json');
  let spec;
  try { spec = JSON.parse(readFileSync(f, 'utf8')); } catch { return { ...manual, note: `adapters.sessionLauncher is ${launcher}, but ${f} is missing or invalid` }; }
  if (!Array.isArray(spec.argv) || !spec.argv.length) return { ...manual, note: `${f} needs an "argv" array` };
  const argv = spec.argv.map((a) => String(a).replaceAll('{repo}', repo).replaceAll('{prompt}', prompt));
  return { via: launcher, argv, command: argv.map(sh).join(' '), prompt };
}
