#!/usr/bin/env node
// toolkit-context resolver: "which project am I in, and what are its settings?"
// node: imports only, no network, no dependencies. Git is read from files; `git`
// is spawned at most once, and only when the repository layout can't be read
// directly (GIT_DIR set, or an unusual .git layout).
//
// Usage: resolve.mjs [--cwd <dir>] [--config <file>] [--repo <name>]
//                    [--field <dotted.path>] [--no-cache] [--pretty]
import { readFileSync, statSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative, basename, sep } from 'node:path';
import { homedir } from 'node:os';

const SCHEMA_VERSION = 1; // bump when the output shape changes, to invalidate caches

// ---------- small fs helpers ----------
function read(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function mtime(p) { try { return statSync(p).mtimeMs; } catch { return -1; } }
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function exists(p) { return mtime(p) !== -1; }
function readJson(p) {
  const s = read(p);
  if (s == null) return null;
  try { return JSON.parse(s); } catch (e) { fail(`invalid JSON in ${p}: ${e.message}`); }
}
function fail(msg, code = 2) {
  process.stderr.write(`toolkit-context: ${msg}\n`);
  process.exit(code);
}
export function toolkitHome(env = process.env) {
  return env.AI_TOOLKIT_HOME ? resolve(env.AI_TOOLKIT_HOME) : join(homedir(), '.ai-toolkit');
}
function hash(s) { // FNV-1a 32-bit, hex. Enough for cache file names and ids.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------- git, read from files ----------
// Returns { toplevel, gitDir, commonDir, mainRoot, worktreeId } or null outside a repo.
// Only the lookup for the cwd honors GIT_DIR (primary=true); neighbors and
// registered repos are always read from their own files.
export function findGit(start, deps, primary = false) {
  if (primary && process.env.GIT_DIR) return gitFromSpawn(start);
  let dir = resolve(start);
  for (;;) {
    const dotgit = join(dir, '.git');
    deps?.push(dotgit);
    let st = null;
    try { st = statSync(dotgit); } catch {}
    if (st) {
      let gitDir, commonDir;
      if (st.isDirectory()) {
        gitDir = commonDir = dotgit;
      } else {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(read(dotgit) || '');
        if (!m) return gitFromSpawn(start);
        gitDir = resolve(dir, m[1]);
        const cd = read(join(gitDir, 'commondir'));
        commonDir = cd ? resolve(gitDir, cd.trim()) : gitDir;
      }
      const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : dir;
      const worktreeId = gitDir === commonDir ? 'main' : basename(gitDir);
      return { toplevel: dir, gitDir, commonDir, mainRoot, worktreeId };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

let spawnCount = 0;
function gitFromSpawn(start) {
  if (spawnCount++ > 0) fail('internal: second git spawn');
  // Lazy: most runs never load child_process.
  // process.getBuiltinModule (Node 20.16+) loads child_process synchronously
  // without importing it on the hot path.
  const { execFileSync } = process.getBuiltinModule('node:child_process');
  let out;
  try {
    out = execFileSync('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      { cwd: start, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const [toplevel, gitDir, cdRaw] = out.trim().split(/\r?\n/);
  const commonDir = resolve(toplevel, cdRaw);
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : toplevel;
  return { toplevel: resolve(toplevel), gitDir: resolve(gitDir), commonDir, mainRoot,
    worktreeId: resolve(gitDir) === commonDir ? 'main' : basename(gitDir) };
}

function headBranch(gitDir) {
  const h = read(join(gitDir, 'HEAD'));
  const m = h && /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(h);
  return m ? m[1] : null; // null = detached
}
function hasRef(commonDir, ref) {
  if (exists(join(commonDir, ref))) return true;
  const packed = read(join(commonDir, 'packed-refs'));
  return !!packed && packed.includes(` ${ref}\n`);
}
export function detectTrunk(git, deps) {
  const oh = join(git.commonDir, 'refs/remotes/origin/HEAD');
  deps?.push(oh, join(git.commonDir, 'packed-refs'));
  const m = /^ref:\s*refs\/remotes\/origin\/(.+?)\s*$/m.exec(read(oh) || '');
  if (m) return m[1];
  for (const b of ['main', 'master', 'trunk']) {
    if (hasRef(git.commonDir, `refs/heads/${b}`) || hasRef(git.commonDir, `refs/remotes/origin/${b}`)) return b;
  }
  return headBranch(git.gitDir);
}

// Parses origin (or the first remote) from the repo's config file.
function remoteUrl(commonDir, deps) {
  const cfg = join(commonDir, 'config');
  deps?.push(cfg);
  const text = read(cfg);
  if (!text) return null;
  let current = null; const urls = {};
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
    if (sec) { current = sec[1]; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const u = current && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (u && !urls[current]) urls[current] = u[1];
  }
  return urls.origin || Object.values(urls)[0] || null;
}

let sshAliases;
function sshHostName(alias) {
  if (sshAliases === undefined) {
    sshAliases = {};
    const text = read(join(homedir(), '.ssh', 'config')) || '';
    let hosts = [];
    for (const line of text.split(/\r?\n/)) {
      const h = /^\s*Host\s+(.+?)\s*$/i.exec(line);
      if (h) { hosts = h[1].split(/\s+/).filter((x) => !/[*?]/.test(x)); continue; }
      const hn = /^\s*HostName\s+(\S+)/i.exec(line);
      if (hn) for (const x of hosts) sshAliases[x] ??= hn[1];
    }
  }
  return sshAliases[alias] || alias;
}

// "git@github-work:org/repo.git" → { host: "github.com", slug: "org/repo", sshAlias: "github-work" }
export function parseRemote(url) {
  if (!url) return null;
  let host, path, alias = null;
  let m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
  if (m) { [, host, path] = m; }
  else if ((m = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url))) {
    [, host, path] = m;
    const real = sshHostName(host);
    if (real !== host) { alias = host; host = real; }
  } else return null;
  const slug = path.replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '');
  return { host: host.toLowerCase(), slug, ...(alias ? { sshAlias: alias } : {}) };
}

// ---------- zero-config facts from the working tree ----------
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['uv.lock', 'uv'], ['poetry.lock', 'poetry'],
  ['Cargo.lock', 'cargo'], ['go.sum', 'go'], ['pom.xml', 'maven'], ['build.gradle', 'gradle'],
  ['build.gradle.kts', 'gradle'],
];
const PR_TEMPLATES = [
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE.MD',
  '.github/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md',
];
function detectFacts(root, deps) {
  let packageManager = null;
  for (const [f, pm] of LOCKFILES) {
    const p = join(root, f); deps?.push(p);
    if (exists(p)) { packageManager = pm; break; }
  }
  let prTemplate = null;
  for (const f of PR_TEMPLATES) {
    const p = join(root, f); deps?.push(p);
    if (exists(p)) { prTemplate = f; break; }
  }
  const commands = {};
  const pkgPath = join(root, 'package.json'); deps?.push(pkgPath);
  const pkg = exists(pkgPath) ? safeJson(pkgPath) : null;
  if (pkg?.scripts) {
    const pm = packageManager && ['pnpm', 'yarn', 'bun'].includes(packageManager) ? packageManager : 'npm';
    for (const k of ['build', 'test', 'lint']) {
      if (pkg.scripts[k]) commands[k] = pm === 'npm' && k !== 'test' ? `npm run ${k}` : `${pm} ${k}`;
    }
    if (!packageManager) packageManager = 'npm';
  }
  return { packageManager, prTemplate, commands };
}
function safeJson(p) { try { return JSON.parse(read(p)); } catch { return null; } }

// ---------- config discovery ----------
// Walk from `from` up to `stop` (inclusive). If stop is null, walk up to, but
// not including, the home directory.
function* ancestors(from, stop) {
  const home = homedir();
  let dir = resolve(from);
  for (;;) {
    if (!stop && (dir === home || dir === dirname(home))) return;
    yield dir;
    if (stop && dir === stop) return;
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}
function findUp(from, stop, rel, deps) {
  for (const dir of ancestors(from, stop)) {
    const p = join(dir, rel); deps.push(p);
    if (exists(p)) return p;
  }
  return null;
}

// ---------- normalizers ----------
function compact(o) {
  if (Array.isArray(o)) return o.map(compact);
  if (o && typeof o === 'object') {
    const r = {};
    for (const [k, v0] of Object.entries(o)) {
      const v = compact(v0);
      if (v == null) continue;
      if (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0) continue;
      r[k] = v;
    }
    return r;
  }
  return o;
}
function pickCommands(c) {
  if (!c) return {};
  const r = {};
  for (const [k, v] of Object.entries(c)) if (typeof v === 'string' && v) r[k] = v;
  return r;
}
// A repos.json / workspace.json entry → project shape.
function fromRegistryEntry(e, base) {
  const remote = e.remote ? {
    host: e.remote.ghHost, slug: `${e.remote.org}/${e.remote.repo}`,
    ...(e.remote.sshAlias ? { sshAlias: e.remote.sshAlias } : {}),
    ...(e.remote.isFork ? { upstream: `${e.remote.upstreamOrg}/${e.remote.repo}` } : {}),
  } : null;
  return {
    name: e.name, root: resolve(base, e.localPath), trunk: e.primaryBranch,
    packageManager: e.packageManager, prTemplate: e.prTemplatePath ?? null,
    remote, commands: pickCommands(e.commands),
    worktreeConvention: e.worktreeConvention, planHome: e.planHome,
    personas: e.review?.enabled ? e.review.personas : [],
  };
}

// ---------- the resolver ----------
export function resolveContext(opts = {}) {
  const env = opts.env || process.env;
  const cwd = resolve(opts.cwd || process.cwd());
  const deps = []; // every path whose existence or mtime affects the result
  const git = findGit(cwd, deps, true);
  const configArg = opts.neighborOf ? null : (opts.config || env.AI_TOOLKIT_CONFIG || null);

  let source = null, mode = 'zero-config', configPath = null, config = null;
  if (configArg) {
    configPath = resolve(cwd, configArg);
    deps.push(configPath);
    config = readJson(configPath);
    if (!config) fail(`config not found: ${configPath}`);
    source = configPath; mode = Array.isArray(config.repos) ? 'workspace' : 'project';
  } else {
    const stop = git ? git.toplevel : null;
    configPath = findUp(cwd, stop, join('.ai-toolkit', 'project.json'), deps);
    // A local-only install lives untracked in the main checkout, so a linked
    // worktree inherits the main checkout's project.json.
    if (!configPath && git && git.mainRoot !== git.toplevel) {
      const p = join(git.mainRoot, '.ai-toolkit', 'project.json'); deps.push(p);
      if (exists(p)) configPath = p;
    }
    if (configPath) { mode = 'project'; }
    else {
      const wsStop = git ? git.mainRoot : null;
      const wsFrom = git ? git.mainRoot === git.toplevel ? cwd : git.mainRoot : cwd;
      configPath = findUp(wsFrom, wsStop, join('.ai-toolkit', 'workspace.json'), deps)
        || findUp(wsFrom, wsStop, join('.claude', 'repos.json'), deps);
      if (configPath) mode = 'workspace';
    }
    if (configPath) { config = readJson(configPath); source = configPath; }
  }

  const display = (p) => (git && p.startsWith(git.mainRoot + sep) ? relative(git.mainRoot, p) : p).split(sep).join('/');
  const home = toolkitHome(env);
  const remoteHere = git ? parseRemote(remoteUrl(git.commonDir, deps)) : null;
  let project, neighbors = [], adapters = {}, stateRoot, writeAllowed;

  if (mode === 'workspace') {
    const base = dirname(dirname(configPath)); // <hub>/.claude/repos.json → <hub>
    const entries = config.repos.map((e) => fromRegistryEntry(e, base));
    let match = null;
    if (opts.repo) {
      match = entries.find((e) => matchesRepo(e, opts.repo));
      if (!match) fail(`--repo ${opts.repo}: not in ${display(configPath)}`);
    } else if (git) {
      match = entries.find((e) => {
        const g = findGit(e.root, null);
        return g && g.commonDir === git.commonDir;
      }) || (remoteHere && entries.find((e) => e.remote && e.remote.host === remoteHere.host
        && e.remote.slug.toLowerCase() === remoteHere.slug.toLowerCase()));
    }
    if (match) {
      project = match;
      // A sibling checkout or worktree of a registered repo resolves to that repo,
      // but its own root.
      if (!opts.repo && git) project = { ...match, root: git.toplevel };
    } else {
      project = hereProject(git, cwd, remoteHere, deps);
    }
    // --repo asks for one registered repo's facts; the hub's call (no --repo)
    // is the one that lists every registered repo.
    if (!opts.repo) neighbors = entries.filter((e) => e.name !== project.name)
      .map((e) => ({ name: e.name, root: e.root, trunk: e.trunk, access: 'write' }));
    adapters = { ...(config.adapters || {}), personas: project.personas };
    stateRoot = join(base, 'tmp');
    writeAllowed = true;
  } else if (mode === 'project') {
    const det = git ? hereProject(git, cwd, remoteHere, deps) : { name: basename(cwd), root: cwd };
    const c = config;
    const projectRoot = configArg ? (git ? git.toplevel : cwd) : dirname(dirname(configPath));
    project = {
      name: c.name || det.name,
      root: git ? git.toplevel : projectRoot,
      trunk: c.trunk || det.trunk,
      packageManager: c.packageManager || det.packageManager,
      prTemplate: c.prTemplate !== undefined ? c.prTemplate : det.prTemplate,
      remote: c.remote || det.remote,
      commands: { ...det.commands, ...pickCommands(c.commands) },
      worktreeConvention: c.worktreeConvention,
      planHome: c.planHome || 'plans',
    };
    neighbors = (c.neighbors || []).map((n) => neighbor(n, projectRoot, deps));
    adapters = { ...(c.adapters || {}) };
    if (c.pr && 'commentMarker' in c.pr) adapters.commentMarker = c.pr.commentMarker;
    if (c.review?.personas) adapters.personas = c.review.personas;
    const stateBase = configArg ? join(home, 'cache', repoId(project, git)) : join(projectRoot, '.ai-toolkit', 'state');
    stateRoot = join(stateBase, git ? git.worktreeId : 'main');
    writeAllowed = c.writeAllowed !== false;
  } else {
    if (!git) fail(`not inside a git repository, and no config found (cwd ${cwd})`);
    project = hereProject(git, cwd, remoteHere, deps);
    stateRoot = join(home, 'cache', repoId(project, git), git.worktreeId);
    writeAllowed = false;
  }

  // --repo in project and zero-config modes: this project (by name or slug),
  // or a neighbor, which is then resolved from its own root.
  if (opts.repo && mode !== 'workspace' && !matchesRepo(project, opts.repo)) {
    const n = neighbors.find((x) => x.name === opts.repo
      || matchesRepo({ name: x.name, remote: (() => { const g = findGit(x.root, null); return g && parseRemote(remoteUrl(g.commonDir, null)); })() }, opts.repo));
    if (!n) fail(`--repo ${opts.repo}: not this project (${project.name}) or one of its neighbors`);
    const sub = resolveContext({ ...opts, cwd: n.root, repo: undefined, config: undefined, neighborOf: project.name });
    sub.out.writeAllowed = sub.out.writeAllowed && n.access === 'write';
    return { out: sub.out, deps: [...deps, ...sub.deps], git };
  }
  delete project.personas;
  // Keep output small: a neighbor's root is omitted when it is the default
  // sibling path (<project.root>/../<name>), and access when it is "read".
  neighbors = neighbors.map((n) => {
    const r = { ...n };
    if (r.root === join(dirname(project.root), r.name)) delete r.root;
    if (r.access === 'read') delete r.access;
    return r;
  });
  const out = compact({
    mode, source: source ? display(source) : null, project,
    neighbors, adapters, stateRoot, writeAllowed,
  });
  out.writeAllowed = writeAllowed; // keep `false` visible
  return { out, deps, git };
}

function hereProject(git, cwd, remote, deps) {
  const root = git ? git.toplevel : cwd;
  const facts = detectFacts(root, deps);
  return {
    name: remote ? remote.slug.split('/').pop() : basename(git ? git.mainRoot : cwd),
    root, trunk: git ? detectTrunk(git, deps) : null, ...facts, remote,
  };
}
function matchesRepo(p, want) {
  const w = want.toLowerCase();
  return p.name === want || p.remote?.slug?.toLowerCase() === w || p.remote?.upstream?.toLowerCase() === w;
}
function neighbor(n, base, deps) {
  const root = resolve(base, n.root || join('..', n.name));
  let trunk = n.trunk;
  if (!trunk) {
    const nc = join(root, '.ai-toolkit', 'project.json'); deps.push(nc);
    trunk = safeJson(nc)?.trunk;
    if (!trunk) { const g = findGit(root, null); if (g) trunk = detectTrunk(g, deps); }
  }
  return { name: n.name, root, trunk, access: n.access === 'write' ? 'write' : 'read' };
}
function repoId(project, git) {
  return `${project.name}-${hash(git ? git.commonDir : project.root)}`;
}

// ---------- cache ----------
function cacheFile(home, key) { return join(home, 'cache', 'resolver', `${hash(key)}.json`); }
function cacheKey(opts, env) {
  return JSON.stringify([SCHEMA_VERSION, resolve(opts.cwd || process.cwd()), opts.config || env.AI_TOOLKIT_CONFIG || '', opts.repo || '']);
}
function headStamp(git) { return git ? (read(join(git.gitDir, 'HEAD')) || '') : ''; }

export function cachedResolve(opts = {}) {
  const env = opts.env || process.env;
  const home = toolkitHome(env);
  const key = cacheKey(opts, env);
  const file = cacheFile(home, key);
  if (!opts.noCache && !env.GIT_DIR) {
    const c = safeJson(file);
    if (c && c.key === key && c.deps.every(([p, m]) => mtime(p) === m)
      && headStamp(c.gitDir ? { gitDir: c.gitDir } : null) === c.head) {
      return { out: c.out, cached: true };
    }
  }
  const { out, deps, git } = resolveContext(opts);
  if (!opts.noCache && !env.GIT_DIR) {
    const uniq = [...new Set(deps)];
    const entry = { key, head: headStamp(git), gitDir: git?.gitDir || null,
      deps: uniq.map((p) => [p, mtime(p)]), out };
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, file);
    } catch { /* a read-only home just means no cache */ }
  }
  return { out, cached: false };
}

export function getField(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ---------- CLI ----------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v == null || v.startsWith('--')) fail(`usage: ${a} <value>`); return v; };
    if (a === '--cwd') o.cwd = val();
    else if (a === '--config') o.config = val();
    else if (a === '--repo') o.repo = val();
    else if (a === '--field') o.field = val();
    else if (a === '--no-cache') o.noCache = true;
    else if (a === '--pretty') o.pretty = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: resolve.mjs [--cwd dir] [--config file] [--repo name] [--field a.b] [--no-cache] [--pretty]\n');
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  return o;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const opts = parseArgs(process.argv.slice(2));
  const { out } = cachedResolve(opts);
  if (opts.field) {
    const v = getField(out, opts.field);
    if (v === undefined) process.exit(1);
    process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v)) + '\n');
  } else {
    process.stdout.write(JSON.stringify(out, null, opts.pretty ? 2 : 0) + '\n');
  }
}
