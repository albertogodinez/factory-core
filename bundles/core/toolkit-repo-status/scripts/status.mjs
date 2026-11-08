#!/usr/bin/env node
// status.mjs: freshness, worktrees and stale branches for this repo and its neighbors.
// Read-only. node: imports only; git only. Network only with --fetch.
//
//   status.mjs [--cwd <dir>] [--fetch] [--no-neighbors] [--json]
//
// Repos come from toolkit-context: the project itself, then every neighbor it lists. In a
// legacy multi-repo workspace the resolver lists each registered repo as a neighbor.
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESOLVE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'toolkit-context', 'scripts', 'resolve.mjs');
export const STALE_BEHIND = 50, STALE_DAYS = 30;

function git(cwd, ...args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export function parseWorktrees(porcelain) {
  return (porcelain || '').trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const line = (k) => block.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
    return { path: line('worktree'), branch: line('branch')?.replace(/^refs\/heads\//, '') ?? null, head: line('HEAD'), prunable: /\nprunable/.test(block) };
  });
}

// One repo's report. `trunk` is the resolver's; `fetch` runs `git fetch` first.
export function inspect(name, root, trunk, { fetch = false } = {}) {
  const r = { name, root, trunk: trunk || null };
  if (!existsSync(join(root, '.git'))) return { ...r, status: 'missing' };
  if (fetch) r.fetched = git(root, 'fetch', '--quiet', '--prune') !== null;
  if (!r.trunk) { r.trunk = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '') || null; }
  if (!r.trunk) return { ...r, status: 'no-trunk' };
  const remoteRef = `refs/remotes/origin/${r.trunk}`;
  const hasLocal = git(root, 'rev-parse', '--verify', '-q', `refs/heads/${r.trunk}`) !== null;
  const hasRemote = git(root, 'rev-parse', '--verify', '-q', remoteRef) !== null;
  r.current = git(root, 'branch', '--show-current') || '(detached)';
  r.dirty = (git(root, 'status', '--porcelain') || '').split('\n').filter(Boolean).length;
  if (hasLocal && hasRemote) {
    const [ahead, behind] = (git(root, 'rev-list', '--left-right', '--count', `refs/heads/${r.trunk}...${remoteRef}`) || '0\t0').split(/\s+/).map(Number);
    r.ahead = ahead; r.behind = behind;
  } else r.note = hasLocal ? `no origin/${r.trunk} ref (no remote or never fetched)` : `no local ${r.trunk} branch`;
  const base = hasRemote ? remoteRef : hasLocal ? `refs/heads/${r.trunk}` : null;

  const wts = parseWorktrees(git(root, 'worktree', 'list', '--porcelain'));
  const byBranch = new Map(wts.map((w) => [w.branch, w]));
  const classify = (branch, tip) => {
    if (!base || tip === git(root, 'rev-parse', base)) return 'active'; // no commits of its own yet
    if (spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', tip, base]).status === 0) return 'merged';
    const track = git(root, 'for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`) || '';
    if (/\[gone\]/.test(track)) return 'gone';
    const behind = Number(git(root, 'rev-list', '--count', `${tip}..${base}`) || 0);
    const last = Number(git(root, 'log', '-1', '--format=%ct', tip) || 0) * 1000;
    if (behind > STALE_BEHIND && Date.now() - last > STALE_DAYS * 86400000) return 'stale';
    return 'active';
  };
  r.worktrees = wts.slice(1).map((w) => {
    const rel = relative(root, w.path);
    const status = w.prunable ? 'prunable' : !w.branch ? 'detached' : classify(w.branch, w.head);
    return { path: rel.startsWith('..') ? w.path : rel, branch: w.branch, status };
  });
  r.branches = (git(root, 'for-each-ref', '--format=%(refname:short)\t%(objectname)', 'refs/heads') || '').split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([b]) => b !== r.trunk)
    .map(([b, tip]) => ({ branch: b, status: classify(b, tip), worktree: byBranch.has(b) }))
    .filter((b) => b.status !== 'active');
  r.status = r.behind > 0 ? 'behind' : 'ok';
  return r;
}

export function targets(cwd, { neighbors = true } = {}) {
  const p = spawnSync(process.execPath, [RESOLVE, '--cwd', cwd, '--no-cache'], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(p.stderr.trim() || 'resolver failed');
  const ctx = JSON.parse(p.stdout);
  const list = [{ name: ctx.project.name, root: ctx.project.root, trunk: ctx.project.trunk }];
  if (neighbors) for (const n of ctx.neighbors || []) list.push({ name: n.name, root: n.root || resolve(ctx.project.root, '..', n.name), trunk: n.trunk });
  return { mode: ctx.mode, list };
}

function render(reports, mode) {
  const out = [`mode: ${mode}`, ''];
  const row = (cols) => `| ${cols.join(' | ')} |`;
  out.push(row(['Repo', 'Trunk', 'Behind origin', 'Checked out', 'Dirty', 'Status']), row(['---', '---', '---', '---', '---', '---']));
  for (const r of reports) {
    const status = r.status === 'missing' ? 'MISSING (not cloned)' : r.status === 'behind' ? `${r.trunk} needs a pull` : r.status === 'no-trunk' ? 'no trunk found' : 'up to date';
    out.push(row([r.name, r.trunk ?? '-', r.behind ?? '?', r.current ?? '-', r.dirty ?? '-', status + (r.note ? ` (${r.note})` : '')]));
  }
  for (const r of reports.filter((x) => x.worktrees?.length)) {
    out.push('', `worktrees in ${r.name}:`);
    for (const w of r.worktrees) out.push(`  ${w.status.padEnd(9)} ${w.path}  (${w.branch ?? 'detached'})`);
  }
  for (const r of reports.filter((x) => x.branches?.length)) {
    out.push('', `branches in ${r.name} to review:`);
    for (const b of r.branches) out.push(`  ${b.status.padEnd(7)} ${b.branch}${b.worktree ? '  (has a worktree)' : ''}`);
  }
  const behind = reports.filter((r) => r.status === 'behind');
  if (behind.length) { out.push('', 'to refresh (not run for you):'); for (const r of behind) out.push(`  git -C ${r.root} checkout ${r.trunk} && git -C ${r.root} pull`); }
  return out.join('\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const o = { cwd: process.cwd(), neighbors: true };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--cwd' && a[i + 1]) o.cwd = resolve(a[++i]);
    else if (a[i] === '--fetch') o.fetch = true;
    else if (a[i] === '--no-neighbors') o.neighbors = false;
    else if (a[i] === '--json') o.json = true;
    else { process.stderr.write('usage: status.mjs [--cwd dir] [--fetch] [--no-neighbors] [--json]\n'); process.exit(a[i] === '-h' ? 0 : 2); }
  }
  let t;
  try { t = targets(o.cwd, o); } catch (e) { process.stderr.write(`status: ${e.message}\n`); process.exit(2); }
  const reports = t.list.map((x) => inspect(x.name, x.root, x.trunk, o));
  process.stdout.write((o.json ? JSON.stringify({ mode: t.mode, repos: reports }, null, 2) : render(reports, t.mode)) + '\n');
}
