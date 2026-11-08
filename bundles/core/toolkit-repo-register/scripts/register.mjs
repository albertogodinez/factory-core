#!/usr/bin/env node
// register.mjs: verify a repo's facts and write only what zero-config detection doesn't already give
// into .ai-toolkit/project.json. node: imports only, no network.
//
//   register.mjs [--cwd <dir>] [--dry-run | --write] [--refresh] [--neighbor <name>[:read|write]]...
//
// Default is --dry-run: stdout is the proposed project.json, stderr is a report (added, drift,
// judgment calls). --write validates with toolkit-context/scripts/validate.mjs, then writes.
// An existing config is kept: --write adds missing fields and neighbors and reports drift;
// --refresh also replaces drifted fields with the verified value.
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTEXT = join(HERE, '..', '..', 'toolkit-context', 'scripts');

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
function git(cwd, ...args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------- remote ----------
function sshHostName(alias) {
  const text = read(join(homedir(), '.ssh', 'config')) || '';
  let hosts = []; const map = {};
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (h) { hosts = h[1].split(/\s+/).filter((x) => !/[*?]/.test(x)); continue; }
    const hn = /^\s*HostName\s+(\S+)/i.exec(line);
    if (hn) for (const x of hosts) map[x] ??= hn[1];
  }
  return { real: map[alias] || alias, known: alias in map };
}
export function parseRemote(url) {
  if (!url) return null;
  let host, path, alias = null, aliasKnown = true, m;
  if ((m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url))) [, host, path] = m;
  else if ((m = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url))) {
    [, host, path] = m;
    const r = sshHostName(host);
    if (r.real !== host) { alias = host; host = r.real; }
    aliasKnown = r.known || /\./.test(host);
  } else return null;
  const slug = path.replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '');
  return { host: host.toLowerCase(), slug, ...(alias ? { sshAlias: alias } : {}), aliasKnown };
}

// ---------- toolchain ----------
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'],
  ['uv.lock', 'uv'], ['poetry.lock', 'poetry'], ['Cargo.lock', 'cargo'], ['go.sum', 'go'], ['pom.xml', 'maven'],
  ['build.gradle', 'gradle'], ['build.gradle.kts', 'gradle'],
];
function packageManager(root, pkg) {
  for (const [f, pm] of LOCKFILES) if (existsSync(join(root, f))) return pm;
  const field = pkg?.packageManager && /^(pnpm|yarn|npm|bun)@/.exec(pkg.packageManager);
  if (field) return field[1];
  return pkg ? 'npm' : null;
}
function makeTargets(root) {
  const mk = read(join(root, 'Makefile')) ?? read(join(root, 'makefile'));
  if (!mk) return new Set();
  return new Set([...mk.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((m) => m[1]));
}
export function commandsFor(root, pm, pkg) {
  const c = {}, notes = [];
  if (pkg?.scripts) {
    const run = (k) => (pm === 'npm' ? (k === 'test' || k === 'start' ? `npm ${k}` : `npm run ${k}`) : pm === 'bun' ? `bun run ${k}` : `${pm} ${k}`);
    for (const k of ['build', 'test', 'lint', 'format']) if (pkg.scripts[k]) c[k] = run(k);
    if (['pnpm', 'npm', 'yarn', 'bun'].includes(pm)) c.install = `${pm} install`;
  }
  const targets = makeTargets(root);
  for (const k of ['build', 'test', 'lint', 'format']) if (!c[k] && targets.has(k)) c[k] = `make ${k}`;
  const set = (k, v) => { if (!c[k]) c[k] = v; };
  if (pm === 'maven') { set('build', 'mvn clean install'); set('test', 'mvn test'); }
  if (pm === 'gradle') { set('build', './gradlew build'); set('test', './gradlew test'); }
  if (pm === 'cargo') { set('build', 'cargo build'); set('test', 'cargo test'); set('lint', 'cargo clippy'); set('format', 'cargo fmt'); }
  if (pm === 'go') { set('build', 'go build ./...'); set('test', 'go test ./...'); }
  if (pm === 'uv') { set('install', 'uv sync'); if (/pytest/.test(read(join(root, 'pyproject.toml')) || '')) set('test', 'uv run pytest'); }
  for (const k of ['build', 'test', 'lint']) if (!c[k]) notes.push(`no ${k} command found; left unset`);
  return { commands: c, notes };
}
const PR_TEMPLATES = ['.github/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE.MD', '.github/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md'];
function prTemplate(root) {
  for (const f of PR_TEMPLATES) if (existsSync(join(root, f))) return f;
  try {
    const dir = join(root, '.github', 'PULL_REQUEST_TEMPLATE');
    const files = readdirSync(dir).filter((f) => /\.md$/i.test(f)).sort();
    if (files.length) return { multiple: files.map((f) => `.github/PULL_REQUEST_TEMPLATE/${f}`) };
  } catch {}
  return null;
}
function worktreeConvention(root) {
  const list = (git(root, 'worktree', 'list', '--porcelain') || '').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  const others = list.filter((p) => resolve(p) !== resolve(root));
  if (others.some((p) => resolve(p).startsWith(join(resolve(root), '.worktrees') + '/'))) return 'dot-worktrees';
  if (others.some((p) => dirname(resolve(p)) === dirname(resolve(root)) && basename(p).startsWith(basename(root) + '-'))) return 'sibling-directory';
  if (existsSync(join(root, '.worktrees'))) return 'dot-worktrees';
  return 'none';
}

// ---------- verified facts ----------
export function verify(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  if (!top) throw new Error(`not inside a git repository: ${cwd}`);
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const root = common && basename(common) === '.git' ? dirname(common) : top;
  const uncertain = [];
  const originHead = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '') || null;
  if (!originHead) uncertain.push('trunk: origin/HEAD is not set; trunk is left to detection. Run `git remote set-head origin -a` to pin it.');
  const remote = parseRemote(git(root, 'remote', 'get-url', 'origin'));
  if (!remote) uncertain.push('remote: no origin remote; host and slug are left unset.');
  else if (remote.sshAlias && !remote.aliasKnown) uncertain.push(`remote: ssh alias "${remote.sshAlias}" is not in ~/.ssh/config, so its host could not be verified.`);
  const up = parseRemote(git(root, 'remote', 'get-url', 'upstream'));
  if (remote && up && up.slug !== remote.slug) { remote.upstream = up.slug; uncertain.push(`remote: an "upstream" remote points at ${up.slug}; recorded as the canonical repo (origin is a fork).`); }
  const pkg = readJson(join(root, 'package.json'));
  const pm = packageManager(root, pkg);
  const { commands, notes } = commandsFor(root, pm, pkg);
  uncertain.push(...notes);
  let tpl = prTemplate(root);
  if (tpl && tpl.multiple) { uncertain.push(`prTemplate: several templates (${tpl.multiple.join(', ')}); not set. Pick one if a skill should use it.`); tpl = null; }
  return { root, trunk: originHead, remote, packageManager: pm, commands, prTemplate: tpl, worktreeConvention: worktreeConvention(root), uncertain };
}

// The resolver's own detection, for comparison: an empty config makes it fill every field from git.
function detection(root) {
  const dir = mkdtempSync(join(tmpdir(), 'register-'));
  try {
    const cfg = join(dir, 'empty.json');
    writeFileSync(cfg, '{"version":1}');
    const r = spawnSync(process.execPath, [join(CONTEXT, 'resolve.mjs'), '--cwd', root, '--config', cfg, '--no-cache', '--full'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`resolver failed: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout).project || {};
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------- proposal ----------
export function propose(cwd, { neighbors = [], refresh = false } = {}) {
  const v = verify(cwd);
  const det = detection(v.root);
  const file = join(v.root, '.ai-toolkit', 'project.json');
  const existing = readJson(file);
  if (existsSync(file) && !existing) throw new Error(`${file} exists but is not valid JSON; fix it first`);
  const config = existing ? structuredClone(existing) : { version: 1 };
  const notes = { added: [], drift: [], refreshed: [], neighbors: [], uncertain: v.uncertain };
  const apply = (key, value) => {
    const cur = config[key];
    if (cur === undefined) { config[key] = value; notes.added.push(key); }
    else if (!same(cur, value)) {
      if (refresh) { config[key] = value; notes.refreshed.push({ field: key, was: cur, now: value }); }
      else notes.drift.push({ field: key, config: cur, verified: value });
    }
  };
  // Fields where detection and the verified value differ are the only ones written.
  // A field already in the config is always compared, so drift shows even when detection agrees.
  const differs = (key, value, detected) => value != null && (key in config || !same(value, detected));
  if (differs('trunk', v.trunk, det.trunk)) apply('trunk', v.trunk);
  if (differs('packageManager', v.packageManager, det.packageManager)) apply('packageManager', v.packageManager);
  if (differs('prTemplate', v.prTemplate, det.prTemplate)) apply('prTemplate', v.prTemplate);
  if (v.remote) {
    const { aliasKnown, ...r } = v.remote;
    const d = det.remote || {};
    if ('remote' in config || r.host !== d.host || r.slug !== d.slug || r.sshAlias !== d.sshAlias || r.upstream !== d.upstream) apply('remote', r);
  }
  const cmds = {};
  for (const [k, val] of Object.entries(v.commands)) if (val !== det.commands?.[k] || k in (config.commands || {})) cmds[k] = val;
  if (Object.keys(cmds).length) {
    if (!config.commands) { config.commands = cmds; notes.added.push('commands'); }
    else for (const [k, val] of Object.entries(cmds)) {
      const cur = config.commands[k];
      if (cur === undefined) { config.commands[k] = val; notes.added.push(`commands.${k}`); }
      else if (cur !== val) {
        if (refresh) { config.commands[k] = val; notes.refreshed.push({ field: `commands.${k}`, was: cur, now: val }); }
        else notes.drift.push({ field: `commands.${k}`, config: cur, verified: val });
      }
    }
  }
  if (v.worktreeConvention !== 'none' || 'worktreeConvention' in config) apply('worktreeConvention', v.worktreeConvention);
  for (const spec of neighbors) {
    const [name, access = 'read'] = spec.split(':');
    if (!['read', 'write'].includes(access)) throw new Error(`--neighbor ${spec}: access must be read or write`);
    if (!name || /[/\\]/.test(name)) throw new Error(`--neighbor ${spec}: give a sibling directory name, not a path`);
    const root = resolve(v.root, '..', name);
    if (!existsSync(join(root, '.git'))) throw new Error(`--neighbor ${name}: ${root} is not a git checkout`);
    config.neighbors ||= [];
    const entry = config.neighbors.find((n) => n.name === name);
    const want = access === 'write' ? { name, access } : { name };
    if (!entry) { config.neighbors.push(want); notes.neighbors.push(`added ${name} (${access})`); }
    else if ((entry.access || 'read') !== access) { if (access === 'write') entry.access = 'write'; else delete entry.access; notes.neighbors.push(`${name}: access now ${access}`); }
    else notes.neighbors.push(`${name} already listed`);
  }
  return { file, root: v.root, exists: !!existing, config, notes };
}

function validateConfig(config) {
  const dir = mkdtempSync(join(tmpdir(), 'register-'));
  try {
    const f = join(dir, 'project.json');
    writeFileSync(f, JSON.stringify(config));
    const r = spawnSync(process.execPath, [join(CONTEXT, 'validate.mjs'), f], { encoding: 'utf8' });
    return r.status === 0 ? [] : r.stderr.trim().split('\n').map((l) => l.replace(f, 'project.json'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function parseArgs(argv) {
  const o = { neighbors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const x = argv[++i]; if (x == null || x.startsWith('--')) die(`usage: ${a} <value>`); return x; };
    if (a === '--cwd') o.cwd = val();
    else if (a === '--dry-run') o.dry = true;
    else if (a === '--write') o.write = true;
    else if (a === '--refresh') o.refresh = true;
    else if (a === '--neighbor') o.neighbors.push(val());
    else if (a === '-h' || a === '--help') { process.stdout.write('usage: register.mjs [--cwd dir] [--dry-run | --write] [--refresh] [--neighbor name[:read|write]]...\n'); process.exit(0); }
    else die(`unknown argument: ${a}`);
  }
  if (o.dry && o.write) die('--dry-run and --write are exclusive');
  return o;
}
function die(m) { process.stderr.write(`register: ${m}\n`); process.exit(2); }

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const o = parseArgs(process.argv.slice(2));
  let p;
  try { p = propose(resolve(o.cwd || process.cwd()), { neighbors: o.neighbors, refresh: o.refresh }); } catch (e) { die(e.message); }
  const errs = validateConfig(p.config);
  const n = p.notes;
  const err = (s) => process.stderr.write(s + '\n');
  err(`register: ${p.file}${p.exists ? '' : ' (new)'}`);
  if (n.added.length) err(`  add: ${n.added.join(', ')}`);
  for (const d of n.drift) err(`  drift: ${d.field} is ${JSON.stringify(d.config)} in config; verified ${JSON.stringify(d.verified)} (kept; --refresh replaces)`);
  for (const d of n.refreshed) err(`  refreshed: ${d.field} ${JSON.stringify(d.was)} -> ${JSON.stringify(d.now)}`);
  for (const x of n.neighbors) err(`  neighbor: ${x}`);
  for (const u of n.uncertain) err(`  check: ${u}`);
  if (!n.added.length && !n.drift.length && !n.refreshed.length && !n.neighbors.length) err('  nothing to change: detection already matches the repo');
  if (errs.length) { for (const e of errs) err(`  invalid: ${e}`); process.exit(1); }
  if (o.write) {
    mkdirSync(dirname(p.file), { recursive: true });
    writeFileSync(p.file, JSON.stringify(p.config, null, 2) + '\n');
    err(`  wrote ${p.file}`);
  } else process.stdout.write(JSON.stringify(p.config, null, 2) + '\n');
}
