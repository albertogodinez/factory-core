// Shared helpers for the factory-review scripts. Imports only node: modules.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORE_DIR = resolve(HERE, '..');
export const SKILLS_DIR = dirname(CORE_DIR);

// "--key value" pairs and bare "--flag" switches. Positionals are returned in `_`.
export function parseArgs(argv, switches = []) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (switches.includes(k)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = {};
  if (!m) return { fm, body: text };
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!kv) continue;
    let v = kv[2].replace(/[ \t]+#.*$/, '').trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    fm[kv[1]] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

// Directories searched for personas and rules, in priority order: this skill first, then
// every sibling factory-review-* pack, then any directory in --packs / TOOLKIT_REVIEW_PACKS.
export function searchRoots(o = {}) {
  const roots = [CORE_DIR];
  const skillsDir = o.skillsDir ?? SKILLS_DIR;
  if (existsSync(skillsDir)) {
    for (const e of readdirSync(skillsDir).sort()) {
      const p = join(skillsDir, e);
      if (e.startsWith('factory-review-') && statSync(p).isDirectory()) roots.push(p);
    }
  }
  const extra = [o.packs, process.env.TOOLKIT_REVIEW_PACKS].filter(Boolean).join(':').split(':').filter(Boolean);
  for (const p of extra) if (existsSync(p) && !roots.includes(resolve(p))) roots.push(resolve(p));
  return roots;
}

export function findPersona(name, roots) {
  for (const r of roots) {
    const f = join(r, 'personas', `${name}.md`);
    if (existsSync(f)) return { file: f, root: r, pack: r === CORE_DIR ? 'core' : basename(r) };
  }
  return null;
}

export function allPersonas(roots) {
  const out = new Map();
  for (const r of roots) {
    const d = join(r, 'personas');
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((n) => n.endsWith('.md')).sort()) {
      const name = f.slice(0, -3);
      if (!out.has(name)) out.set(name, { file: join(d, f), root: r, pack: r === CORE_DIR ? 'core' : basename(r) });
    }
  }
  return out;
}

// Rule files for a persona: the union across roots. A pack's file replaces a core file of the same name.
export function ruleFiles(persona, roots) {
  const byName = new Map();
  let anyDir = false;
  for (const r of roots) {
    const d = join(r, 'rules', persona);
    if (!existsSync(d)) continue;
    anyDir = true;
    for (const f of readdirSync(d).sort()) {
      if (!f.endsWith('.md') || f === '_manifest.md' || f === '_template.md') continue;
      byName.set(f, join(d, f));
    }
  }
  return { anyDir, files: [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p) };
}

export function compileRules(persona, target, roots, outDir) {
  const { anyDir, files } = ruleFiles(persona, roots);
  const parts = [];
  let included = 0;
  let excluded = 0;
  for (const f of files) {
    const { fm } = parseFrontmatter(readFileSync(f, 'utf8'));
    const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);
    const repos = list(fm.repos);
    if (list(fm.repos_exclude).includes(target)) { excluded++; continue; }
    if (repos.length && !repos.includes(target) && !repos.includes('cross-repo')) continue;
    included++;
    parts.push(`---\n## ${basename(f, '.md')}\n\n${readFileSync(f, 'utf8')}\n`);
  }
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `compiled-${persona}.md`);
  writeFileSync(file, parts.join(''));
  return { file, total: files.length, included, excluded, anyDir };
}

export function resolveContext(args = []) {
  const script = join(SKILLS_DIR, 'factory-context', 'scripts', 'resolve.mjs');
  if (!existsSync(script)) throw new Error(`factory-context not found at ${script}`);
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`factory-context failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  return JSON.parse(r.stdout);
}

export function readPackManifest(root) {
  const f = join(root, 'pack.json');
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}
