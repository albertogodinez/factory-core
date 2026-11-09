#!/usr/bin/env node
/**
 * Has anything we adopted changed upstream since we last reviewed it?
 * Compares upstream against itself (the git object hash of each upstream path),
 * never against our edited copy.
 *
 *   node check-upstreams.mjs                          offline: coverage, pins, last snapshot; warns, exits 0
 *   node check-upstreams.mjs --online                 fetch upstream state, save tmp/upstream-snapshot.json, exit 1 on CHANGED or GONE
 *   node check-upstreams.mjs --diff <id>              upstream commits and patch since the baseline, for one adoption
 *   node check-upstreams.mjs --refs <id>              upstream files that mention the adopted skill, and whether our copy of each does
 *   node check-upstreams.mjs --bump <id> --decision "adopted|skipped: why|partial: what"
 *                                                     record the review: move the baseline to the snapshot's upstream head
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const manifestPath = path.join(here, '../references/upstreams.json');
const snapshotPath = path.join(root, 'tmp/upstream-snapshot.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const lines = [];
const say = (tag, msg) => lines.push(`check-upstreams: ${tag.padEnd(7)} ${msg}`);
const rel = (p) => path.relative(root, p);

function gh(apiPath) {
  const r = spawnSync('gh', ['api', apiPath], { encoding: 'utf8', timeout: 30000, env: { ...process.env, GH_HOST: 'github.com' }, maxBuffer: 64 << 20 });
  if (r.status === 0) return JSON.parse(r.stdout);
  return null;
}
async function github(apiPath) {
  const viaGh = gh(apiPath);
  if (viaGh) return viaGh;
  const res = await fetch(`https://api.github.com/${apiPath}`, { headers: { Accept: 'application/vnd.github+json' } }).catch(() => null);
  return res?.ok ? res.json() : null;
}

// --- offline checks -----------------------------------------------------------

const covered = (file) => manifest.adoptions.some((a) => a.local.some((l) => file === l || file.startsWith(`${l}/`)));

function offlineChecks() {
  for (const a of manifest.adoptions) {
    for (const l of a.local) if (!existsSync(path.join(root, l))) say('MISSING', `${a.id}: ${l} does not exist`);
    if (a.pinPattern) {
      for (const l of a.local) {
        const m = readFileSync(path.join(root, l), 'utf8').match(new RegExp(a.pinPattern));
        if (!m) say('MISSING', `${a.id}: no ${a.source} pin in ${l}`);
        else if (m[1] !== a.version) say('DRIFT', `${a.id}: ${l} pins ${m[1]}, manifest says ${a.version}; run --bump ${a.id} after reviewing`);
      }
    }
  }

  // Review rules declare their source in frontmatter.
  const rulesDir = path.join(root, 'bundles/core/toolkit-review/rules');
  for (const persona of existsSync(rulesDir) ? readdirSync(rulesDir) : []) {
    const dir = path.join(rulesDir, persona);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const file = rel(path.join(dir, f));
      const src = readFileSync(path.join(root, file), 'utf8').match(/^source:\s*(\S+)/m)?.[1];
      if (src && manifest.sources[src] && !covered(file)) say('UNTRACKED', `${file} says source: ${src} but no adoption lists it`);
    }
  }

  // A skill without the toolkit- prefix came from somewhere, or is listed as our own.
  const skillsDir = path.join(root, 'bundles/core');
  for (const name of readdirSync(skillsDir)) {
    if (name.startsWith('toolkit-') || !statSync(path.join(skillsDir, name)).isDirectory()) continue;
    const dir = `bundles/core/${name}`;
    if (!covered(dir) && !(manifest.own ?? []).includes(name)) say('UNTRACKED', `${dir} has no adoption entry and is not in "own"`);
  }

  // Provenance belongs in the manifest, not in text agents load.
  const leftover = /^(Source: \[|Source: adapted from|Adapted from )|github\.com\/(mattpocock\/skills|cursor\/plugins)\/tree\//m;
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.md') ? [p] : [];
  });
  for (const file of walk(skillsDir)) {
    if (file.startsWith(path.join(skillsDir, 'toolkit-upstream-sync'))) continue;
    const text = readFileSync(file, 'utf8');
    const m = text.match(leftover);
    if (m) say('PROVENANCE', `${rel(file)}:${text.slice(0, m.index).split('\n').length} carries provenance; record it in upstreams.json instead`);
  }
}

// --- upstream state -----------------------------------------------------------

async function fetchUpstream() {
  const snap = { fetchedAt: Date.now(), github: {}, npm: {} };
  for (const [key, s] of Object.entries(manifest.sources)) {
    if (s.type === 'github') {
      const head = await github(`repos/${s.repo}/commits/${s.branch}`);
      const tree = head && await github(`repos/${s.repo}/git/trees/${head.sha}?recursive=1`);
      if (!tree) { snap.github[key] = { error: `could not read ${s.repo}; check \`gh auth status\` or the network` }; continue; }
      if (tree.truncated) snap.github[key] = { error: `${s.repo} tree is truncated; the check needs a per-path lookup` };
      else snap.github[key] = { head: head.sha, hashes: Object.fromEntries(tree.tree.map((t) => [t.path, t.sha])) };
    } else if (s.type === 'npm') {
      const res = await fetch(`https://registry.npmjs.org/${s.package}`).catch(() => null);
      const data = res?.ok ? await res.json() : null;
      snap.npm[key] = data ? { latest: data['dist-tags'].latest } : { error: `could not read ${s.package} from registry.npmjs.org` };
    }
  }
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(snap) + '\n');
  return snap;
}

function compare(snap) {
  let pending = 0;
  for (const a of manifest.adoptions) {
    const src = manifest.sources[a.source];
    if (src.type === 'npm') {
      const s = snap.npm[a.source];
      if (s?.error) { say('skip', `${a.id}: ${s.error}`); continue; }
      if (s.latest !== a.reviewedVersion) { pending++; say('CHANGED', `${a.id}: ${src.package} ${s.latest} is out (pinned ${a.version}, last reviewed ${a.reviewedVersion})`); }
      continue;
    }
    const s = snap.github[a.source];
    if (s?.error) { say('skip', `${a.id}: ${s.error}`); continue; }
    for (const u of a.upstream) {
      const now = s.hashes[u.path];
      if (!now) { pending++; say('GONE', `${a.id}: ${src.repo} ${u.path} no longer exists; run --diff ${a.id} for the rename or removal`); }
      else if (now !== u.hash) { pending++; say('CHANGED', `${a.id}: ${src.repo} ${u.path} changed since ${u.baseline.slice(0, 7)}; run --diff ${a.id}`); }
    }
  }
  return pending;
}

function readSnapshot() {
  if (!existsSync(snapshotPath)) return null;
  const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  return Date.now() - snap.fetchedAt > manifest.snapshotMaxAgeDays * 86400e3 ? null : snap;
}

// --- review helpers -----------------------------------------------------------

function adoption(id) {
  const a = manifest.adoptions.find((x) => x.id === id);
  if (!a) { console.error(`check-upstreams: no adoption "${id}"`); process.exit(2); }
  return a;
}

async function diff(id) {
  const a = adoption(id);
  const src = manifest.sources[a.source];
  if (src.type === 'npm') {
    console.log(`${src.package}: pinned ${a.version}, last reviewed ${a.reviewedVersion}. Read the release notes: https://www.npmjs.com/package/${src.package}?activeTab=versions`);
    return;
  }
  const head = (await github(`repos/${src.repo}/commits/${src.branch}`))?.sha;
  if (!head) { console.error(`check-upstreams: could not read ${src.repo}`); process.exit(2); }
  for (const u of a.upstream) {
    const cmp = await github(`repos/${src.repo}/compare/${u.baseline}...${head}`);
    if (!cmp) { console.error(`check-upstreams: compare failed for ${u.path}`); continue; }
    const under = (f) => [f.filename, f.previous_filename].some((n) => n && (n === u.path || n.startsWith(`${u.path}/`)));
    const since = Date.parse(cmp.base_commit.commit.committer.date);
    const listed = await github(`repos/${src.repo}/commits?path=${encodeURIComponent(u.path)}&sha=${head}&per_page=100`) ?? [];
    const commits = [];
    for (const c of listed) {
      if (c.sha === u.baseline || Date.parse(c.commit.committer.date) <= since) break;
      commits.push(c);
    }
    // GitHub's compare lists at most 300 files, so on a busy upstream it can miss this path
    // entirely. Then rebuild the patch from each commit that touched the path.
    const capped = cmp.files.length >= 300;
    let files = cmp.files.filter(under);
    if (capped) {
      files = [];
      for (const c of commits) {
        // One commit's file list is paged too (100 a page, up to 3000 files).
        for (let page = 1; page <= 30; page++) {
          const detail = await github(`repos/${src.repo}/commits/${c.sha}?per_page=100&page=${page}`);
          if (!detail) { console.error(`check-upstreams: could not read commit ${c.sha.slice(0, 7)}`); break; }
          for (const f of detail.files.filter(under)) files.push({ ...f, commit: c.sha });
          if (detail.files.length < 100) break;
        }
      }
    }
    console.log(`\n## ${src.repo} ${u.path}  ${u.baseline.slice(0, 7)}..${head.slice(0, 7)}${capped ? '  (compare capped at 300 files; patches below are per commit)' : ''}`);
    if (!files.length && !commits.length) { console.log('no changes under this path'); continue; }
    for (const c of commits) console.log(`- ${c.sha.slice(0, 7)} ${c.commit.committer.date.slice(0, 10)} ${c.commit.message.split('\n')[0]}`);
    for (const f of files) {
      console.log(`\n### ${f.status} ${f.previous_filename ? `${f.previous_filename} -> ` : ''}${f.filename}${f.commit ? `  (${f.commit.slice(0, 7)})` : ''}`);
      console.log(f.patch ?? '(no textual patch)');
    }
  }
  if (a.notes) console.log(`\nOur deliberate changes: ${a.notes}`);
}

// A reference to a skill is its name after `/` or a backtick: `/name`, `../name/SKILL.md`, `name`.
const mentions = (text, name) =>
  new RegExp(`[/\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);

// The adoption whose upstream path holds `file`, or undefined.
const ownerOf = (adoptions, sourceKey, file) =>
  adoptions.find((x) => x.source === sourceKey && (x.upstream ?? []).some((u) => file === u.path || file.startsWith(`${u.path}/`)));

const walkText = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.name === '.git') return [];
  return e.isDirectory() ? walkText(p) : /\.(md|mdx|ya?ml|json)$/.test(e.name) ? [p] : [];
});

async function refs(id) {
  const a = adoption(id);
  const src = manifest.sources[a.source];
  if (src.type !== 'github') { console.log(`check-upstreams: ${id} is an ${src.type} pin; --refs applies to adopted skills`); return; }
  const head = (await github(`repos/${src.repo}/commits/${src.branch}`))?.sha;
  if (!head) { console.error(`check-upstreams: could not read ${src.repo}`); process.exit(2); }

  // Search the plugin or skills tree the adoption lives in, plus the repo's top-level docs.
  const scopes = [...new Set(a.upstream.map((u) => u.path.split('/')[0]))];
  const clone = path.join(root, 'tmp/upstream-refs', `${a.source}-${head.slice(0, 12)}`);
  if (!existsSync(path.join(clone, '.git'))) {
    mkdirSync(path.dirname(clone), { recursive: true });
    const run = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000 });
    const cl = run(['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', `https://github.com/${src.repo}.git`, clone]);
    const sp = cl.status === 0 && run(['sparse-checkout', 'set', '--no-cone', '/*.md', ...scopes.map((s) => `/${s}/`)], clone);
    if (!sp || sp.status !== 0) { console.error(`check-upstreams: could not clone ${src.repo}: ${(cl.stderr || sp?.stderr || '').trim()}`); process.exit(2); }
  }

  const names = [...new Set(a.upstream.map((u) => path.basename(u.path)))];
  const own = (file) => a.upstream.some((u) => file === u.path || file.startsWith(`${u.path}/`));
  const hits = walkText(clone)
    .map((f) => path.relative(clone, f))
    .filter((f) => !own(f) && names.some((n) => mentions(readFileSync(path.join(clone, f), 'utf8'), n)));

  console.log(`## upstream files that mention ${names.map((n) => `/${n}`).join(', ')}  (${src.repo} @ ${head.slice(0, 7)})`);
  if (!hits.length) { console.log('none'); return; }
  for (const f of hits.sort()) {
    const o = ownerOf(manifest.adoptions, a.source, f);
    if (!o) { console.log(`- ${f}  ->  not adopted`); continue; }
    const localFiles = o.local.flatMap((l) => {
      const p = path.join(root, l);
      return !existsSync(p) ? [] : statSync(p).isDirectory() ? walkText(p) : [p];
    });
    const done = localFiles.some((p) => names.some((n) => mentions(readFileSync(p, 'utf8'), n)));
    console.log(`- ${f}  ->  ${o.id} (${o.local[0]}): ${done ? 'already mentions it' : 'does NOT mention it yet'}`);
  }
}

function bump(id, decision) {
  if (!decision) { console.error('check-upstreams: --bump needs --decision "adopted|skipped: why|partial: what"'); process.exit(2); }
  const snap = readSnapshot();
  if (!snap) { console.error('check-upstreams: no fresh snapshot; run check-upstreams.mjs --online first'); process.exit(2); }
  const a = adoption(id);
  const src = manifest.sources[a.source];
  if (src.type === 'npm') {
    const s = snap.npm[a.source];
    if (!s || s.error) { console.error(`check-upstreams: snapshot has no ${src.package} version`); process.exit(2); }
    a.reviewedVersion = s.latest;
    a.version = readFileSync(path.join(root, a.local[0]), 'utf8').match(new RegExp(a.pinPattern))?.[1] ?? a.version;
  } else {
    const s = snap.github[a.source];
    if (!s || s.error) { console.error(`check-upstreams: snapshot has no ${src.repo} state`); process.exit(2); }
    for (const u of a.upstream) {
      if (!s.hashes[u.path]) { console.error(`check-upstreams: ${u.path} is gone upstream; update its path in upstreams.json by hand first`); process.exit(2); }
      u.baseline = s.head;
      u.hash = s.hashes[u.path];
    }
  }
  a.reviewed = new Date().toISOString().slice(0, 10);
  a.decision = decision;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`check-upstreams: recorded ${id}: ${decision}`);
}

// --- main ---------------------------------------------------------------------

if (argv.includes('--diff')) { await diff(arg('--diff')); process.exit(0); }
if (argv.includes('--refs')) { await refs(arg('--refs')); process.exit(0); }
if (argv.includes('--bump')) { bump(arg('--bump'), arg('--decision')); process.exit(0); }

offlineChecks();
const online = argv.includes('--online');
const snap = online ? await fetchUpstream() : readSnapshot();
let pending = 0;
if (snap) pending = compare(snap);
else say('skip', 'no upstream snapshot from the last 14 days; run check-upstreams.mjs --online');
if (!lines.some((l) => !/ skip /.test(l))) say('ok', `${manifest.adoptions.length} adoptions tracked${snap ? ', no pending upstream changes' : ''}`);
console.log(lines.join('\n'));
if (pending) console.log('check-upstreams: review with /toolkit-upstream-sync');
process.exit(online && pending ? 1 : 0);
