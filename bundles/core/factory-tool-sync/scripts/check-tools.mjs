#!/usr/bin/env node
// Are the CLIs the skills shell out to installed, new enough, and has a release come out since
// the skills were last checked against them? Pins come from every installed skill's tools.json
// (<project.root>/.agents/skills/*/tools.json), so each bundle ships its own.
//
//   check-tools.mjs                      offline: installed versions, coverage, the last snapshot. Makes no
//                                        network call. Warns, exits 0.
//   check-tools.mjs --online             fetch the latest releases, save the snapshot, exit 1 on CHANGED or BELOW
//   check-tools.mjs --bump <id> --decision "adopted|skipped: why" [--min <version>]
//                                        record the review: move `verified` to the snapshot's latest
// Other flags: --cwd <dir>, --skills <dir> (default <root>/.agents/skills), --state <dir> (snapshot
// and version cache; default the resolver's stateRoot).
// Exit: 0 ok or warnings; 1 with --online when a release is unreviewed or a CLI is below min;
// 2 bad usage or an invalid tools.json.
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.resolve(HERE, '..');
const RESOLVER = path.join(HERE, '../../factory-context/scripts/resolve.mjs');
const WIN = process.platform === 'win32';

// Numeric compare of dotted versions; a missing part counts as 0.
export const cmp = (a, b) => {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

// --- pins -----------------------------------------------------------------------

const SEMVER = /^\d+\.\d+(\.\d+)?$/;
const isArgv = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x);
const regexOk = (s) => { try { new RegExp(s); return typeof s === 'string' && s !== ''; } catch { return false; } };

// Problems with one tools.json, as strings; empty when it is valid.
export function validatePins(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tools)) return ['needs a "tools" array'];
  if (doc.snapshotMaxAgeDays !== undefined && !(Number.isInteger(doc.snapshotMaxAgeDays) && doc.snapshotMaxAgeDays >= 1)) errs.push('snapshotMaxAgeDays must be an integer of at least 1');
  doc.tools.forEach((t, i) => {
    const at = `tools[${i}]${t?.id ? ` (${t.id})` : ''}`;
    if (typeof t?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) errs.push(`${at}: id must match [a-z0-9][a-z0-9-]*`);
    if (!isArgv(t?.version?.argv) || !regexOk(t?.version?.pattern)) errs.push(`${at}: version needs argv (string list) and a valid pattern`);
    if (!regexOk(t?.usage)) errs.push(`${at}: usage must be a valid regex`);
    if (typeof t?.install !== 'string' || !t.install) errs.push(`${at}: install is required`);
    for (const k of ['min', 'verified']) if (t?.[k] !== undefined && !SEMVER.test(t[k])) errs.push(`${at}: ${k} must look like 1.2 or 1.2.3`);
    if (t?.latest) {
      const l = t.latest;
      const ok = (l.type === 'npm' && l.package) || (l.type === 'github' && /^[^/\s]+\/[^/\s]+$/.test(l.repo ?? '')) || (l.type === 'command' && isArgv(l.argv) && regexOk(l.pattern));
      if (!ok) errs.push(`${at}: latest must be npm {package}, github {repo: owner/name} or command {argv, pattern}`);
      if (!t.verified) errs.push(`${at}: latest needs verified`);
    }
  });
  return errs;
}

// Reads every <skills>/<skill>/tools.json. Entries with the same id merge, later skill names
// winning field by field, except `min`, where the highest wins. `files` lists who defined it.
export function loadPins(skillsDir) {
  const byId = new Map();
  const errors = [];
  const ages = [];
  const sources = [];
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      const file = path.join(skillsDir, name, 'tools.json');
      if (!existsSync(file)) continue;
      let doc;
      try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { errors.push(`${file}: ${e.message}`); continue; }
      const bad = validatePins(doc);
      if (bad.length) { errors.push(...bad.map((m) => `${file}: ${m}`)); continue; }
      sources.push(name);
      if (doc.snapshotMaxAgeDays) ages.push(doc.snapshotMaxAgeDays);
      for (const t of doc.tools) {
        const prev = byId.get(t.id);
        const min = prev?.min && t.min ? (cmp(prev.min, t.min) >= 0 ? prev.min : t.min) : (prev?.min ?? t.min);
        byId.set(t.id, { ...prev, ...t, ...(min ? { min } : {}), files: [...(prev?.files ?? []), file] });
      }
    }
  }
  return { tools: [...byId.values()], errors, maxAge: ages.length ? Math.min(...ages) : 14, sources };
}

// --- environment -----------------------------------------------------------------

function onPath(bin) {
  const exts = WIN ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      if (dir && existsSync(p) && statSync(p).isFile()) return p;
    }
  }
  return null;
}

// Tools print versions to stdout or stderr and some exit non-zero while doing it.
async function probe([bin, ...args], pattern, env = {}) {
  const out = await run(bin, args, { timeout: 15000, env: { ...process.env, ...env }, shell: WIN })
    .then((r) => r.stdout + r.stderr, (e) => `${e.stdout ?? ''}${e.stderr ?? ''}`);
  return out.match(new RegExp(pattern))?.[1] ?? null;
}

// Which installed skills mention each tool: files under the skills directory, minus this skill and
// every tools.json (pins name their own tools).
function dependents(skillsDir, tools) {
  const texts = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git' && p !== SELF) walk(p); }
      else if (/\.(md|mjs|js|cjs|ts|sh|json|ya?ml)$/.test(e.name) && e.name !== 'tools.json') {
        texts.push([path.relative(skillsDir, p).split(path.sep)[0], readFileSync(p, 'utf8')]);
      }
    }
  };
  if (existsSync(skillsDir)) walk(skillsDir);
  return Object.fromEntries(tools.map((t) => {
    const re = new RegExp(t.usage);
    return [t.id, [...new Set(texts.filter(([, text]) => re.test(text)).map(([skill]) => skill))].sort()];
  }));
}

function resolveContext(o) {
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const ask = (field) => {
    if (!existsSync(RESOLVER)) return null;
    const r = spawnSync(process.execPath, [RESOLVER, '--cwd', cwd, '--field', field], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const root = ask('project.root') ?? cwd;
  const stateRoot = o.state ? path.resolve(o.state) : (ask('stateRoot') ?? path.join(tmpdir(), 'factory-tool-sync'));
  return { root, skillsDir: path.resolve(o.skills ?? path.join(root, '.agents', 'skills')), stateRoot };
}

// --- checks ------------------------------------------------------------------------

export async function localChecks({ tools, users, say, cachePath }) {
  let below = 0;
  const cache = existsSync(cachePath) ? safeJson(cachePath, {}) : {};
  // Some CLIs take half a second to print a version, so a rerun reuses the last answer until the
  // binary behind the PATH entry changes.
  async function installedVersion(t, bin) {
    const real = realpathSync(bin);
    const key = `${real}:${statSync(real).mtimeMs}`;
    if (cache[t.id]?.key === key) return cache[t.id].version;
    const version = await probe(t.version.argv, t.version.pattern, t.version.env);
    if (version) cache[t.id] = { key, version };
    return version;
  }
  await Promise.all(tools.map(async (t) => {
    const by = users[t.id].length ? ` (used by ${users[t.id].join(', ')})` : '';
    if (!users[t.id].length) say('UNUSED', `${t.id}: no skill matches /${t.usage}/; drop it from tools.json or fix the pattern`);
    const bin = onPath(t.version.argv[0]);
    if (!bin) { say('MISSING', `${t.id} is not on PATH${by}; ${t.install}`); return; }
    const v = await installedVersion(t, bin);
    if (!v) { say('UNKNOWN', `${t.id}: could not read a version from \`${t.version.argv.join(' ')}\`; fix version.pattern`); return; }
    const hint = (ver) => t.install.replace('<version>', ver);
    if (t.min && cmp(v, t.min) < 0) { below++; say('BELOW', `${t.id} ${v} is older than ${t.min}, the lowest the skills need${by}; ${hint(t.verified ?? t.min)}`); }
    else if (t.verified && cmp(v, t.verified) < 0) say('BEHIND', `${t.id} ${v} is older than ${t.verified}, the version the skills were checked against; ${hint(t.verified)}`);
    else if (t.verified && cmp(v, t.verified) > 0) say('AHEAD', `${t.id} ${v} is newer than ${t.verified}, the version the skills were checked against; if a skill misbehaves, start there`);
  }));
  try { mkdirSync(path.dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(cache) + '\n'); } catch { /* the cache is an optimisation */ }
  return below;
}

function safeJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function latestOf(src) {
  if (src.type === 'npm') {
    const res = await fetch(`https://registry.npmjs.org/${src.package}/latest`).catch(() => null);
    return res?.ok ? (await res.json()).version : null;
  }
  if (src.type === 'github') {
    const viaGh = await run('gh', ['api', `repos/${src.repo}/releases/latest`, '--jq', '.tag_name'], { timeout: 30000, env: { ...process.env, GH_HOST: 'github.com' }, shell: WIN })
      .then((r) => r.stdout.trim(), () => null);
    const tag = viaGh || await fetch(`https://api.github.com/repos/${src.repo}/releases/latest`).then((r) => (r.ok ? r.json() : null), () => null).then((j) => j?.tag_name);
    return tag?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  }
  return onPath(src.argv[0]) ? probe(src.argv, src.pattern, src.env) : null;
}

async function fetchLatest(tools, snapshotPath) {
  const snap = { fetchedAt: Date.now(), latest: {} };
  await Promise.all(tools.filter((t) => t.latest).map(async (t) => {
    snap.latest[t.id] = (await latestOf(t.latest)) ?? { error: `could not read the latest ${t.id} release` };
  }));
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(snap) + '\n');
  return snap;
}

export function compare(tools, snap, say) {
  let pending = 0;
  for (const t of tools.filter((x) => x.latest)) {
    const l = snap.latest[t.id];
    if (!l || l.error) { say('skip', `${t.id}: ${l?.error ?? 'not in the snapshot'}`); continue; }
    if (cmp(l, t.verified) > 0) { pending++; say('CHANGED', `${t.id} ${l} is out; the skills were checked against ${t.verified}`); }
  }
  return pending;
}

function readSnapshot(snapshotPath, maxAgeDays) {
  if (!existsSync(snapshotPath)) return null;
  const snap = safeJson(snapshotPath, null);
  return !snap || Date.now() - snap.fetchedAt > maxAgeDays * 86400e3 ? null : snap;
}

// Records a review in the tools.json that defines the entry last (the one whose values win).
function bump({ tools, id, decision, min, snapshotPath, maxAge }) {
  const fail = (m) => { console.error(`check-tools: ${m}`); process.exit(2); };
  if (!decision) fail('--bump needs --decision "adopted|skipped: why"');
  const t = tools.find((x) => x.id === id);
  if (!t) fail(`no tool "${id}"`);
  const latest = readSnapshot(snapshotPath, maxAge)?.latest[id];
  if (t.latest && (!latest || latest.error)) fail('no fresh snapshot for this tool; run with --online first');
  const file = t.files.at(-1);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const entry = doc.tools.find((x) => x.id === id);
  if (t.latest) entry.verified = latest;
  if (min) entry.min = min;
  entry.reviewed = new Date().toISOString().slice(0, 10);
  entry.decision = decision;
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`check-tools: recorded ${id}${t.latest ? ` at ${latest}` : ''}: ${decision} (${file})`);
}

// --- main ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const o = { cwd: arg('--cwd'), skills: arg('--skills'), state: arg('--state') };
  const ctx = resolveContext(o);
  const { tools, errors, maxAge, sources } = loadPins(ctx.skillsDir);
  if (errors.length) { for (const e of errors) console.error(`check-tools: invalid ${e}`); process.exit(2); }
  const snapshotPath = path.join(ctx.stateRoot, 'tool-snapshot.json');
  const cachePath = path.join(ctx.stateRoot, 'tool-versions.json');

  if (argv.includes('--bump')) { bump({ tools, id: arg('--bump'), decision: arg('--decision'), min: arg('--min'), snapshotPath, maxAge }); return; }
  if (!tools.length) { console.log(`check-tools: no tools.json under ${ctx.skillsDir}`); return; }

  const lines = [];
  const say = (tag, msg) => lines.push(`check-tools: ${tag.padEnd(9)} ${msg}`);
  const online = argv.includes('--online');
  const [below, snap] = await Promise.all([
    localChecks({ tools, users: dependents(ctx.skillsDir, tools), say, cachePath }),
    online ? fetchLatest(tools, snapshotPath) : readSnapshot(snapshotPath, maxAge),
  ]);
  const pending = snap ? compare(tools, snap, say) : 0;
  if (!snap && tools.some((t) => t.latest)) say('skip', `no release snapshot from the last ${maxAge} days; run with --online to fetch one`);
  if (!lines.some((l) => !/ skip /.test(l))) say('ok', `${tools.length} tools from ${sources.length} skill(s) installed and current${snap ? ', no unreviewed releases' : ''}`);
  console.log(lines.sort().join('\n'));
  if (pending) console.log('check-tools: review with /factory-tool-sync');
  process.exit(online && (pending || below) ? 1 : 0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
