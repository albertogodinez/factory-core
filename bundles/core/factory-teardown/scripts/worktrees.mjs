// worktrees.mjs: which linked worktrees are finished and safe to retire. The inventory is local git only. PR states
// come from gh: refreshPrStates asks it (the session-start hook runs that in the background), or the agent saves
// its own `gh pr list` output. Retiring removes the worktree through git, never
// with --force, and keeps the branch, so no commit is lost: only a clean checkout and its ignored files go.
import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// `store` is lifecycle.mjs's state access ({ saveState, readState, listRuns }), passed in: importing it here would
// deadlock its top-level await.

export const IDLE_DAYS = 7;
const DAY = 24 * 3600000;
const STATES = ['OPEN', 'CLOSED', 'MERGED'];
// What a local-only factory install links into each worktree. Only symlinks count: a copy may hold edits.
const FACTORY_LINK = /^(?:\.agents\/skills\/[^/]+|\.claude\/skills(?:\/[^/]+)?)$/;

const run = (cwd, args) => spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
function git(cwd, args) { const r = run(cwd, args); if (r.status !== 0) throw new Error(r.stderr?.trim() || r.error?.message || `git ${args[0]} failed`); return r.stdout; }
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };

export const PR_FIELDS = ['--state', 'all', '--limit', '300', '--json', 'headRefName,state,number'];
// `gh pr list` + PR_FIELDS output, kept with the time it was taken.
function storePrStates({ stateRoot, store, raw, now = Date.now() }) {
  if (!Array.isArray(raw) || !raw.every(p => p && typeof p.headRefName === 'string' && STATES.includes(p.state))) {
    throw new Error('PR states must be the JSON of: gh pr list --state all --json headRefName,state,number');
  }
  const value = { version: 1, checkedAt: now, prs: raw.map(p => ({ headRefName: p.headRefName, state: p.state, ...(Number.isSafeInteger(p.number) ? { number: p.number } : {}) })) };
  store.saveState(stateRoot, 'pr-states.json', value);
  return value;
}
export function savePrStates({ file, ...o }) { return storePrStates({ ...o, raw: JSON.parse(readFileSync(file, 'utf8')) }); }
export function refreshPrStates({ root, gh = process.env.FACTORY_GH || 'gh', ...o }) {
  const r = spawnSync(gh, ['pr', 'list', ...PR_FIELDS], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh pr list failed: ${r.error?.message || r.stderr?.trim() || `exit ${r.status}`}`);
  return storePrStates({ ...o, raw: JSON.parse(r.stdout) });
}
// An open PR wins; otherwise the newest PR for the branch name.
function prFor(prs, branch) {
  const mine = prs.filter(p => p.headRefName === branch);
  return mine.find(p => p.state === 'OPEN') || mine.sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0] || null;
}
function baseRef(main) {
  const head = run(main, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) if (run(main, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]).status === 0) return ref;
  return null;
}
function parseList(text) {
  return text.split('\0\0').filter(Boolean).map(record => {
    const f = record.split('\0'), get = k => f.find(x => x === k || x.startsWith(`${k} `));
    return { path: get('worktree')?.slice(9), head: get('HEAD')?.slice(5) || null, branch: get('branch')?.slice(7).replace(/^refs\/heads\//, '') || null,
      locked: Boolean(get('locked')), prunable: Boolean(get('prunable')) };
  });
}
function bytesOf(dir) {
  let total = 0;
  const walk = d => {
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      try { const s = lstatSync(p); total += s.blocks ? s.blocks * 512 : s.size; if (e.isDirectory()) walk(p); } catch {}
    }
  };
  walk(dir); return total;
}
// Tracked changes and untracked files, minus the links factory itself placed.
function changes(path) {
  const entries = git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  const links = [], work = [];
  for (const e of entries) {
    const file = e.slice(3);
    if (e.startsWith('?? ') && FACTORY_LINK.test(file.replace(/\/$/, ''))) {
      try { if (lstatSync(join(path, file)).isSymbolicLink()) { links.push(file.replace(/\/$/, '')); continue; } } catch {}
    }
    work.push(e);
  }
  return { links, work };
}
function idleDays(path, now) {
  const dir = git(path, ['rev-parse', '--absolute-git-dir']).trim();
  for (const f of [join(dir, 'logs', 'HEAD'), join(dir, 'HEAD')]) if (existsSync(f)) return (now - lstatSync(f).mtimeMs) / DAY;
  return 0;
}
// Why this worktree's work is done, or null with why it isn't.
function finished(w, { main, base, prs, idle, idleDays: limit }) {
  if (w.branch) {
    const pr = prFor(prs, w.branch), n = pr?.number ? ` #${pr.number}` : '';
    if (pr?.state === 'OPEN') return { done: null, why: `PR${n} open` };
    if (pr?.state === 'MERGED') return { done: `PR${n} merged` };
    if (pr?.state === 'CLOSED') return { done: `PR${n} closed without merging` };
    const track = run(main, ['for-each-ref', '--format=%(upstream)%09%(upstream:track)', `refs/heads/${w.branch}`]).stdout.trim();
    if (/^\S+\t\[gone\]$/.test(track)) return { done: 'remote branch deleted' };
  }
  if (base && run(main, ['merge-base', '--is-ancestor', w.head, base]).status === 0) {
    const days = Math.floor(idle);
    return idle >= limit ? { done: `no commits beyond ${base}, idle ${days}d` } : { done: null, why: `no commits beyond ${base} yet, idle ${days}d (under ${limit}d: may be new work)` };
  }
  return { done: null, why: w.branch ? `commits not on ${base || 'a base branch'}${prs.length ? '' : '; no PR states saved'}` : 'detached HEAD with commits on no branch' };
}

export function inventory({ root, stateRoot, store, now = Date.now(), idleDays: limit = IDLE_DAYS, sizes = false, current = process.cwd() }) {
  const main = real(dirname(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()));
  const base = baseRef(main);
  const saved = stateRoot ? store.readState(stateRoot, 'pr-states.json') : null;
  const prs = saved?.version === 1 && Array.isArray(saved.prs) ? saved.prs : [];
  const runs = stateRoot ? store.listRuns(stateRoot) : [];
  const here = run(current, ['rev-parse', '--show-toplevel']);
  const cur = here.status === 0 ? real(here.stdout.trim()) : null;
  const worktrees = [];
  for (const w of parseList(git(main, ['worktree', 'list', '--porcelain', '-z'])).slice(1)) {
    const path = w.path && existsSync(w.path) ? real(w.path) : w.path;
    const entry = { path, branch: w.branch, head: w.head, status: 'kept' };
    const keep = reason => worktrees.push({ ...entry, reason });
    if (!path || w.prunable || !existsSync(path)) { keep('worktree path is missing; git worktree prune clears it'); continue; }
    if (w.locked) { keep('locked'); continue; }
    if (path === cur) { keep('current worktree'); continue; }
    try {
      const idle = idleDays(path, now), f = finished(w, { main, base, prs, idle, idleDays: limit });
      if (!f.done) { keep(f.why); continue; }
      entry.finished = f.done;
      const { links, work } = changes(path);
      if (work.length) { keep(`uncommitted changes (${work.length} file${work.length === 1 ? '' : 's'})`); continue; }
      const owner = runs.find(r => r.m && real(r.m.root) === path && (r.m.status === 'active' || r.m.resources.some(x => x.type !== 'scratch' && !x.released)));
      if (owner) { keep(`teardown run ${owner.m.id} still owns resources here`); continue; }
      worktrees.push({ ...entry, status: 'candidate', reason: f.done, links, ...(sizes ? { bytes: bytesOf(path) } : {}) });
    } catch (e) { worktrees.push({ ...entry, status: 'failed', reason: e.message }); }
  }
  return { main, base, prStatesCheckedAt: saved?.checkedAt ?? null, worktrees };
}

// Re-checks one worktree and, with apply, removes it: factory links first, then plain git worktree remove.
export function retire({ worktree, apply = false, ...o }) {
  if (!worktree) throw new Error('retire needs --worktree <path>');
  const target = real(worktree), inv = inventory(o);
  const w = inv.worktrees.find(x => x.path === target);
  if (!w) throw new Error(`not a linked worktree of ${inv.main}: ${target}`);
  if (w.status !== 'candidate' || !apply) return w;
  try {
    for (const link of w.links) { const p = join(target, link); if (lstatSync(p).isSymbolicLink()) unlinkSync(p); }
    git(inv.main, ['worktree', 'remove', target]);
    return { ...w, status: 'removed' };
  } catch (e) { return { ...w, status: 'failed', reason: e.message }; }
}
