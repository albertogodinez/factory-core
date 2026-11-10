// Shared helpers for the factory-docs-validate checks. Imports only node: modules.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__']);

// Every file under `dir`, as absolute paths in a stable order. Follows symlinked directories once.
export function walk(dir, seen = new Set()) {
  const out = [];
  let real;
  try { real = realpathSync(dir); } catch { return out; }
  if (seen.has(real)) return out;
  seen.add(real);
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p, seen));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

export const rel = (root, file) => relative(root, file).split(sep).join('/');
export const isTest = (f) => /\.(test|guard)\.(mjs|js|cjs|ts)$/.test(f);

function unquote(v) {
  const t = v.trim();
  const m = /^(['"])([\s\S]*)\1$/.exec(t);
  if (!m) return t.replace(/\s+#.*$/, '');
  return m[1] === '"' ? m[2].replace(/\\(["\\])/g, '$1') : m[2].replace(/''/g, "'");
}

// Minimal YAML frontmatter reader: top-level `key: value` scalars (quoted, plain, or a folded or
// literal block), flow lists `[a, b]`, and block lists (`- item`). Anything nested is kept as raw
// text. Returns { data, lines } where lines maps each key to its 1-based line, or null when the
// file has no frontmatter.
export function parseFrontmatter(text) {
  const all = text.replace(/\r\n/g, '\n').split('\n');
  if (all[0] !== '---') return null;
  const end = all.indexOf('---', 1);
  if (end < 0) return null;
  const data = {}, lines = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(all[i]);
    if (!m) continue;
    const [, key, rest] = m;
    lines[key] = i + 1;
    const cont = [];
    while (i + 1 < end && (/^[ \t]+\S/.test(all[i + 1]) || /^-\s/.test(all[i + 1]) || all[i + 1] === '')) {
      if (all[i + 1] === '' && !/^[ \t]+\S|^-\s/.test(all[i + 2] ?? '')) break;
      cont.push(all[++i]);
    }
    const body = cont.map((l) => l.trim()).filter(Boolean);
    if (/^[>|][+-]?$/.test(rest)) data[key] = body.join(rest[0] === '>' ? ' ' : '\n');
    else if (/^\[.*\]$/.test(rest.trim())) data[key] = rest.trim().slice(1, -1).split(',').map(unquote).filter((s) => s !== '');
    else if (rest === '' && body.length && body.every((l) => l.startsWith('- '))) data[key] = body.map((l) => unquote(l.slice(2)));
    else if (rest === '' && body.length) data[key] = body.join('\n');
    else data[key] = [unquote(rest), ...body].join(' ').trim();
  }
  return { data, lines };
}

// The project root, the skills directory and the plans directory, from the resolver when it is
// installed beside this skill, else from git, else the cwd.
export function context({ cwd, skills, plans, resolver }) {
  const run = (...a) => {
    if (!resolver || !existsSync(resolver)) return null;
    const r = spawnSync(process.execPath, [resolver, '--cwd', cwd, ...a], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  let root = run('--field', 'project.root');
  if (!root) {
    const g = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    root = g.status === 0 ? g.stdout.trim() : cwd;
  }
  const planHome = run('--field', 'project.planHome') || 'plans';
  return {
    root,
    skillsDir: resolve(skills ?? join(root, '.agents', 'skills')),
    plansDir: resolve(plans ?? join(root, planHome)),
    planHome,
  };
}
