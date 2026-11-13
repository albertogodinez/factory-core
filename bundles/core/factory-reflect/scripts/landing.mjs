// landing.mjs: lesson branches in a source repo, from the first commit to the fast-forward.
// lessons.mjs is the CLI; these are its start, open, land and classify commands.
//
// A lesson branch is `lesson/<date>-<slug>` with its own worktree at
// <main checkout>/.worktrees/lesson/<date>-<slug>, cut from the local trunk, so the main
// checkout's branch never changes. Nothing here fetches or pushes: the agent does the network.
import { readFileSync, readdirSync, existsSync, realpathSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SKILL_SCRIPTS = dirname(realpathSync(import.meta.filename));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}
function must(cwd, ...args) {
  const r = git(cwd, ...args);
  if (!r.ok) throw new LandingError('git-failed', `git ${args.join(' ')}: ${r.err || r.out}`);
  return r.out;
}
export class LandingError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// The repo's main checkout and trunk, from any directory inside it (a worktree included).
export function repoInfo(dir, trunkOverride) {
  const top = git(resolve(dir), 'rev-parse', '--show-toplevel');
  if (!top.ok) throw new LandingError('not-a-repo', `${dir} is not inside a git repository`);
  const common = must(top.out, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const mainRoot = basename(common) === '.git' ? dirname(common) : top.out;
  return { mainRoot, trunk: trunkOverride || trunkOf(mainRoot) };
}
function trunkOf(root) {
  const resolver = join(dirname(dirname(SKILL_SCRIPTS)), 'factory-context', 'scripts', 'resolve.mjs');
  if (existsSync(resolver)) {
    const r = spawnSync(process.execPath, [resolver, '--cwd', root, '--field', 'project.trunk'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  for (const b of ['main', 'master', 'trunk']) if (git(root, 'rev-parse', '--verify', '-q', `refs/heads/${b}`).ok) return b;
  throw new LandingError('no-trunk', `can't tell the trunk branch of ${root}`);
}

// branch -> worktree path, from `git worktree list --porcelain`.
function worktrees(root) {
  const map = new Map();
  let path = null;
  for (const line of must(root, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line.startsWith('branch refs/heads/')) map.set(line.slice(18), path);
  }
  return map;
}

// Each started branch is recorded in <home>/lesson-branches.jsonl, so the factory status hook can
// say at a session start which ones still wait for review (it checks the ref still exists).
function register(home, entry) {
  if (!home) return;
  try { mkdirSync(home, { recursive: true }); appendFileSync(join(home, 'lesson-branches.jsonl'), JSON.stringify(entry) + '\n'); } catch {}
}

export function start({ repo, slug, date, trunk: trunkArg, home }) {
  const s = slugify(slug);
  if (!s) throw new LandingError('usage', '--slug is required');
  const day = date || new Date().toISOString().slice(0, 10);
  const { mainRoot, trunk } = repoInfo(repo, trunkArg);
  const name = `${day}-${s}`, branch = `lesson/${name}`;
  const wt = join(mainRoot, '.worktrees', 'lesson', name);
  const existing = worktrees(mainRoot).get(branch);
  let created = false;
  if (existing) return { repo: mainRoot, trunk, branch, worktree: existing, base: must(mainRoot, 'merge-base', trunk, branch), created, ignored: ignored(mainRoot, wt) };
  if (git(mainRoot, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).ok) must(mainRoot, 'worktree', 'add', '-q', wt, branch);
  else { must(mainRoot, 'worktree', 'add', '-q', '--no-track', '-b', branch, wt, trunk); created = true; }
  register(home, { at: new Date().toISOString(), root: mainRoot, branch, worktree: wt });
  return { repo: mainRoot, trunk, branch, worktree: wt, base: must(mainRoot, 'rev-parse', trunk), created, ignored: ignored(mainRoot, wt) };
}
const ignored = (root, p) => git(root, 'check-ignore', '-q', p).ok;

// Open lesson branches in each repo: what they hold and where their worktree is.
export function open({ repos }) {
  const seen = new Set(), out = [];
  for (const r of repos) {
    let info;
    try { info = repoInfo(r); } catch { continue; }
    if (seen.has(info.mainRoot)) continue;
    seen.add(info.mainRoot);
    const wts = worktrees(info.mainRoot);
    const refs = git(info.mainRoot, 'for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/lesson/').out;
    for (const line of refs.split('\n').filter(Boolean)) {
      const [branch, head] = line.split('\t');
      const commits = git(info.mainRoot, 'log', '--format=%h %s', `${info.trunk}..${branch}`).out.split('\n').filter(Boolean);
      out.push({ repo: info.mainRoot, trunk: info.trunk, branch, head, commits, worktree: wts.get(branch) || null });
    }
  }
  return out;
}

function patchId(root, from, to) {
  const diff = must(root, 'diff', from, to);
  if (!diff) return '';
  const r = spawnSync('git', ['patch-id', '--stable'], { cwd: root, input: diff + '\n', encoding: 'utf8' });
  return (r.stdout || '').trim().split(/\s+/)[0] || '';
}

// Fast-forward trunk to a reviewed lesson branch, then remove its worktree and branch.
// The head must be the reviewed commit, or carry the same change after a rebase.
// Only a session started in the source repo lands: auto mode treats every other repo as shared,
// so a land from a downstream session is denied by design. `cwd` is that session's shell.
export function land({ repo, branch, reviewed, trunk: trunkArg, cwd = process.cwd() }) {
  if (!branch || !reviewed) throw new LandingError('usage', '--branch and --reviewed are required');
  const { mainRoot, trunk } = repoInfo(repo, trunkArg);
  homeCheck(mainRoot, cwd, `lessons.mjs land --repo ${mainRoot} --branch ${branch} --reviewed ${reviewed}`);
  const head = must(mainRoot, 'rev-parse', '--verify', `refs/heads/${branch}`);
  const rev = git(mainRoot, 'rev-parse', '--verify', `${reviewed}^{commit}`);
  if (!rev.ok) throw new LandingError('unknown-reviewed', `${reviewed} is not a commit in ${mainRoot}`);
  const reviewedBase = must(mainRoot, 'merge-base', trunk, rev.out);
  const base = must(mainRoot, 'merge-base', trunk, head);
  if (rev.out !== head && patchId(mainRoot, reviewedBase, rev.out) !== patchId(mainRoot, base, head)) {
    throw new LandingError('changed-since-review', `${branch} changed after the review (reviewed ${rev.out.slice(0, 7)}, now ${head.slice(0, 7)}). Review it again.`);
  }
  if (!git(mainRoot, 'merge-base', '--is-ancestor', trunk, head).ok) {
    throw new LandingError('trunk-moved', `${trunk} moved since ${branch} was cut`,
      { fix: `git -C <worktree> rebase ${trunk}, run the repo's checks, then land again with the same --reviewed` });
  }
  const wts = worktrees(mainRoot);
  const wt = wts.get(branch);
  if (wt && git(wt, 'status', '--porcelain').out) throw new LandingError('uncommitted', `${wt} has uncommitted changes; commit or drop them first`);
  const trunkWt = wts.get(trunk);
  const before = must(mainRoot, 'rev-parse', trunk);
  if (trunkWt) {
    const m = git(trunkWt, 'merge', '--ff-only', '-q', branch);
    if (!m.ok) throw new LandingError('ff-failed', `fast-forward of ${trunk} in ${trunkWt} failed: ${m.err}`);
  } else must(mainRoot, 'update-ref', `refs/heads/${trunk}`, head, before);
  if (wt) must(mainRoot, 'worktree', 'remove', wt);
  // `branch -d` asks about the main checkout's current branch, which may not be trunk.
  if (!git(mainRoot, 'merge-base', '--is-ancestor', head, trunk).ok) throw new LandingError('not-landed', `${trunk} does not contain ${head.slice(0, 7)}`);
  must(mainRoot, 'branch', '-D', branch);
  return { landed: true, repo: mainRoot, trunk, from: before, to: head, removed: { branch, worktree: wt || null },
    next: landNext(mainRoot, trunk) };
}

// A land ends at its own repo's push. Consumers get the change from the source repo's trunk hook
// (factory-core's bin/auto-update.mjs); the one exception is a source repo that installs bundles
// into itself, which refreshes its own copies.
export function landNext(mainRoot, trunk) {
  const next = [`git -C ${mainRoot} push origin ${trunk}`];
  if (existsSync(join(mainRoot, '.agents', 'factory-metadata', 'skills-lock.json'))) next.push(`factory update --to ${mainRoot}`);
  return next;
}

// Throws wrong-session unless the shell's repo is the source repo.
export function homeCheck(mainRoot, cwd, then) {
  let here = null;
  try { here = repoInfo(cwd, 'unused').mainRoot; } catch {}
  if (here && realpathSync(here) === realpathSync(mainRoot)) return;
  throw new LandingError('wrong-session', `this session's repo is ${here || `not a repo (${cwd})`}, not ${mainRoot}; a session writes only its own repo`,
    { fix: `start a session in the source repo (cd ${mainRoot} && <your agent CLI>), then run ${then} there` });
}

// Patterns of internal data that may never land in a shared, generic bundle. Each installed
// skill can ship an internal-data.json; the lists merge.
export function loadPatterns(skillsDir) {
  const list = [];
  if (!existsSync(skillsDir)) return list;
  for (const name of readdirSync(skillsDir).sort()) {
    const f = join(skillsDir, name, 'internal-data.json');
    if (!existsSync(f)) continue;
    let doc;
    try { doc = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new LandingError('bad-patterns', `${f} is not valid JSON`); }
    const problem = checkPatterns(doc);
    if (problem) throw new LandingError('bad-patterns', `${f}: ${problem}`);
    for (const p of doc.patterns) list.push({ re: new RegExp(p.pattern, p.flags || ''), pattern: p.pattern, why: p.why, source: name });
  }
  return list;
}
// Matches schemas/internal-data.schema.json.
export function checkPatterns(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.patterns)) return 'needs a "patterns" array';
  for (const [i, p] of doc.patterns.entries()) {
    if (!p || typeof p.pattern !== 'string' || !p.pattern) return `patterns[${i}].pattern must be a non-empty string`;
    if (typeof p.why !== 'string' || !p.why) return `patterns[${i}].why must be a non-empty string`;
    if (p.flags !== undefined && !/^[imsu]*$/.test(p.flags)) return `patterns[${i}].flags may only hold i, m, s, u`;
    try { new RegExp(p.pattern, p.flags || ''); } catch (e) { return `patterns[${i}].pattern: ${e.message}`; }
  }
  return null;
}

// Which repo a new lesson's text belongs in: org when it carries internal data, else core.
export function classify({ text, skillsDir }) {
  const patterns = loadPatterns(skillsDir || dirname(dirname(SKILL_SCRIPTS)));
  const hits = [];
  String(text || '').split('\n').forEach((line, i) => {
    for (const p of patterns) if (p.re.test(line)) hits.push({ line: i + 1, pattern: p.pattern, why: p.why, source: p.source, text: line.trim().slice(0, 120) });
  });
  return { target: hits.length ? 'org' : 'core', patterns: patterns.length, hits };
}
