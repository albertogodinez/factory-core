// outputs.mjs: big build output a checkout can regenerate (node_modules, target/, dist/ …), found by name, kept
// out of git, and idle. Local only. Cleaning one deletes that folder and nothing else; the build or install that
// made it makes it again.
import { readdirSync, lstatSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bytesOf } from './worktrees.mjs';

export const IDLE_DAYS = 14, MIN_BYTES = 1e9, DEPTH = 4;
const DAY = 24 * 3600000;
// Folder name -> how it comes back. `beside` names a file that must sit next to it, for the generic names.
const KINDS = {
  node_modules: { again: 'the package manager install' },
  target: { again: 'cargo build or mvn package', beside: ['Cargo.toml', 'pom.xml'] },
  '.next': { again: 'the Next.js build' }, '.nuxt': { again: 'the Nuxt build' }, '.svelte-kit': { again: 'the SvelteKit build' },
  '.turbo': { again: 'turbo' }, '.parcel-cache': { again: 'parcel' }, '.gradle': { again: 'gradle' },
  dist: { again: 'the build', beside: ['package.json'] }, build: { again: 'the build', beside: ['package.json', 'build.gradle', 'build.gradle.kts'] },
  coverage: { again: 'the test run' },
};
const inside = (root, p) => { const r = relative(root, p); return r !== '' && !r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r); };
const git = (cwd, args, input) => spawnSync('git', ['--no-optional-locks', ...args], { cwd, input, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });

// Named folders up to DEPTH levels down, never inside one another, a nested checkout or a symlink.
function find(root) {
  const found = [];
  const walk = (dir, depth) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git') continue;
      const p = join(dir, e.name), kind = KINDS[e.name];
      if (kind && (!kind.beside || kind.beside.some(f => existsSync(join(dir, f))))) { found.push({ path: p, kind: e.name }); continue; }
      if (depth < DEPTH && !existsSync(join(p, '.git'))) walk(p, depth + 1);
    }
  };
  walk(root, 1); return found;
}
// Days since the folder or anything directly in it last changed: an install or a build touches the top level.
function idleDays(p, now) {
  let newest = lstatSync(p).mtimeMs;
  try { for (const name of readdirSync(p)) { try { newest = Math.max(newest, lstatSync(join(p, name)).mtimeMs); } catch {} } } catch {}
  return (now - newest) / DAY;
}

export function outputs({ root, now = Date.now(), idleDays: limit = IDLE_DAYS, minBytes = MIN_BYTES, only = null }) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new Error(`not a git checkout: ${root}`);
  const checkout = realpathSync(top.stdout.trim());
  const named = find(checkout).filter(n => !only || n.path === only);
  if (!named.length) return { checkout, outputs: [] };
  const rel = named.map(n => relative(checkout, n.path));
  // Only what git ignores and tracks nothing under: anything else may be someone's source.
  const ignored = new Set(git(checkout, ['check-ignore', '-z', '--stdin'], rel.join('\0') + '\0').stdout.split('\0').filter(Boolean));
  const tracked = git(checkout, ['ls-files', '-z', '--', ...rel]).stdout.split('\0').filter(Boolean);
  const list = [];
  named.forEach((n, i) => {
    const r = rel[i];
    if (!ignored.has(r) || tracked.some(t => t === r || t.startsWith(`${r}/`))) return;
    const bytes = bytesOf(n.path);
    if (bytes < minBytes) return;
    const idle = idleDays(n.path, now), days = Math.floor(idle);
    const base = { path: n.path, kind: n.kind, bytes, idleDays: days, again: KINDS[n.kind].again };
    list.push(idle >= limit ? { ...base, status: 'candidate', reason: `unused ${days}d` } : { ...base, status: 'kept', reason: `used ${days}d ago (under ${limit}d)` });
  });
  return { checkout, outputs: list.sort((a, b) => b.bytes - a.bytes) };
}

// Re-checks one folder and, with apply, deletes it.
export function cleanOutput({ path, apply = false, ...o }) {
  if (!path) throw new Error('clean-output needs --path <folder>');
  const target = resolve(path);
  if (lstatSync(target).isSymbolicLink()) throw new Error(`a symlink, not build output: ${target}`);
  const real = realpathSync(target), inv = outputs({ ...o, root: real, minBytes: 0, only: real });
  const out = inv.outputs.find(x => x.path === real);
  if (!out || !inside(inv.checkout, real)) throw new Error(`not regenerable build output git ignores in ${inv.checkout}: ${real}`);
  if (out.status !== 'candidate' || !apply) return out;
  try { rmSync(real, { recursive: true }); return { ...out, status: 'removed' }; }
  catch (e) { return { ...out, status: 'failed', reason: e.message }; }
}
