#!/usr/bin/env node
// routes.mjs: the routing table for toolkit-ask, built from the installed skills' frontmatter.
// node: imports only, no network.
//
//   routes.mjs [--dir <skills-dir>]... [--query "<words>"] [--top <n>] [--json] [--cache]
//
// Default dir: the skills directory this skill is installed in. --query ranks skills for a
// request. --cache stores the table at <stateRoot>/ask-routes.json and reuses it while no
// SKILL.md has changed (stateRoot from toolkit-context).
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(HERE, '..', '..');

// Frontmatter fields toolkit-ask needs. Handles plain, quoted, and folded (> or |) values.
export function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    } else if (/^(['"])[\s\S]*\1$/.test(v)) {
      const q = v[0];
      v = v.slice(1, -1);
      if (q === "'") v = v.replace(/''/g, "'");
    }
    out[kv[1]] = v;
  }
  return out;
}

export function scan(dirs) {
  const skills = new Map();
  let stamp = 0;
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const n of names) {
      const f = join(dir, n, 'SKILL.md');
      if (!existsSync(f)) continue;
      stamp = Math.max(stamp, statSync(f).mtimeMs);
      const fm = frontmatter(readFileSync(f, 'utf8'));
      const name = fm.name || n;
      if (skills.has(name)) continue; // first directory wins
      skills.set(name, {
        name, description: fm.description || '', path: f,
        slash: fm['disable-model-invocation'] === 'true' || fm.user_invocable === 'true' || undefined,
        hidden: fm['disable-model-invocation'] === 'true' || undefined,
      });
    }
  }
  return { skills: [...skills.values()], stamp, count: skills.size };
}

const STOP = new Set('a an the and or of to in on for with is it my me i we do how what which when where this that can use want need should run get make into from about'.split(' '));
const tokens = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');

export function rank(skills, query, top = 5) {
  const q = [...new Set(tokens(query).map(stem))];
  if (!q.length) return [];
  return skills.map((s) => {
    const nameT = new Set(s.name.split('-').map(stem));
    const descT = tokens(s.description).map(stem);
    let score = 0;
    const hits = [];
    for (const w of q) {
      const inName = nameT.has(w);
      const n = descT.filter((d) => d === w).length;
      if (inName || n) { score += (inName ? 3 : 0) + Math.min(n, 3); hits.push(w); }
    }
    return { name: s.name, score, hits, description: s.description, path: s.path };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, top);
}

function stateRoot() {
  const p = spawnSync(process.execPath, [join(HERE, '..', '..', 'toolkit-context', 'scripts', 'resolve.mjs'), '--field', 'stateRoot'], { encoding: 'utf8' });
  return p.status === 0 ? p.stdout.trim() : null;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const o = { dirs: [], top: 5 };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--dir' && a[i + 1]) o.dirs.push(resolve(a[++i]));
    else if (a[i] === '--query' && a[i + 1]) o.query = a[++i];
    else if (a[i] === '--top' && a[i + 1]) o.top = Number(a[++i]) || 5;
    else if (a[i] === '--json') o.json = true;
    else if (a[i] === '--cache') o.cache = true;
    else { process.stderr.write('usage: routes.mjs [--dir d]... [--query "words"] [--top n] [--json] [--cache]\n'); process.exit(a[i] === '-h' ? 0 : 2); }
  }
  const dirs = o.dirs.length ? o.dirs : [SKILLS];
  let table, cacheFile;
  if (o.cache && !o.dirs.length) {
    const root = stateRoot();
    if (root) cacheFile = join(root, 'ask-routes.json');
  }
  const fresh = scan(dirs);
  try {
    const c = cacheFile && JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (c && c.stamp === fresh.stamp && c.count === fresh.count) table = c;
  } catch {}
  if (!table) {
    table = fresh;
    if (cacheFile) { try { mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(table)); } catch {} }
  }
  const visible = table.skills;
  if (o.query) {
    const r = rank(visible, o.query, o.top);
    if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else if (!r.length) process.stdout.write('no installed skill matches\n');
    else for (const x of r) process.stdout.write(`${x.name}  (score ${x.score}: ${x.hits.join(', ')})\n  ${x.description}\n  ${x.path}\n`);
  } else if (o.json) process.stdout.write(JSON.stringify(visible, null, 2) + '\n');
  else for (const s of visible) process.stdout.write(`${s.name}\t${s.description.length > 140 ? s.description.slice(0, 137) + '...' : s.description}\n`);
}
