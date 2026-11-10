#!/usr/bin/env node
// factory: install factory-core bundles into a repo, keep them current, and check them.
// One file, node: imports only, copies from local paths, never touches the network.
//
//   factory install <bundle...> [--to <repo>] (--commit | --local) [--marker keep|off|text:<tag>]
//                               [--force] [--dry-run]
//   factory update [--all] [--to <repo>] [--force]
//   factory remove <skill|bundle...> [--to <repo>] [--purge]
//   factory link [--to <worktree>]
//   factory doctor [--to <repo>] [--live] [--json]
//   factory list [--to <repo>]
//   factory status [--to <repo>]          one line when installed skills are behind; else silent
//   factory status --hook                 the same as a hook: also says, once per session, which skills
//                                         were updated or edited in place after the session started
//   factory setup [--root <dir>] [--dry-run]   a new machine: add the status hooks to Claude Code and
//                                         Codex, and record the repos under <dir> that carry an install
//
// Bundles: core (this repo), expedia and trips (../factory-org). Override
// a bundle's path in ~/.agents/factory/sources.json: {"expedia": "/path/to/bundles/expedia"}.
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, rmSync,
  cpSync, symlinkSync, readlinkSync, realpathSync, renameSync, appendFileSync, openSync, fstatSync, readSync, closeSync,
} from 'node:fs';
import { join, dirname, resolve, relative, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { findGit, toolkitHome, parseRemote } from '../bundles/core/toolkit-context/scripts/resolve.mjs';

const FACTORY = dirname(dirname(realpathSync(import.meta.filename)));
const RESOLVE = join(FACTORY, 'bundles', 'core', 'toolkit-context', 'scripts', 'resolve.mjs');
const IS_WIN = process.platform === 'win32';
const LOCK = join('.agents/factory-metadata', 'skills-lock.json');
const PROJECT = join('.agents/factory-metadata', 'project.json');
const BLOCK_START = '# >>> factory-core (managed by factory; `factory remove` deletes this block)';
const BLOCK_END = '# <<< factory-core';
const LIMITS = { descriptionChars: 600, listingChars: 14000, skillMdBytes: 24 * 1024 };

// ---------- output ----------
const out = (s = '') => process.stdout.write(s + '\n');
const warn = (s) => process.stderr.write(`factory: ${s}\n`);
function die(s, code = 1) { warn(s); process.exit(code); }

// ---------- small fs helpers ----------
const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, p);
}
const lexists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const posix = (p) => p.split(sep).join('/');

// What an install copies and hashes. Tests run in the bundle's own repo, where their fixtures
// live; a consumer can't run them, so they aren't installed (hash version 2). Version 1 hashed
// everything but .DS_Store; a lock without hashVersion is checked by that rule until the next
// update rewrites it.
export const HASH_VERSION = 2;
const SKIP = {
  1: (name) => name === '.DS_Store',
  2: (name) => name === '.DS_Store' || name === '__pycache__' || /\.(test|guard)\.mjs$/.test(name),
};
export const installs = (name) => !SKIP[HASH_VERSION](name);

export function hashDir(dir, version = HASH_VERSION) {
  const skip = SKIP[version] || SKIP[HASH_VERSION];
  const h = createHash('sha256');
  const walk = (d) => {
    for (const e of readdirSync(d).filter((x) => !skip(x)).sort()) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else { h.update(posix(relative(dir, p))); h.update('\0'); h.update(readFileSync(p)); h.update('\0'); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------- sources and bundles ----------
export function bundleSources(home = toolkitHome()) {
  const def = {
    core: join(FACTORY, 'bundles', 'core'),
    expedia: join(dirname(FACTORY), 'factory-org', 'bundles', 'expedia'),
    trips: join(dirname(FACTORY), 'factory-org', 'bundles', 'trips'),
  };
  return { ...def, ...readJson(join(home, 'sources.json'), {}) };
}
export function readBundle(name, sources = bundleSources()) {
  const dir = sources[name];
  if (!dir) die(`unknown bundle "${name}" (known: ${Object.keys(sources).join(', ')})`, 2);
  if (!existsSync(dir)) die(`bundle "${name}" not found at ${dir}`, 2);
  const skills = readdirSync(dir).filter((e) => existsSync(join(dir, e, 'SKILL.md'))).sort();
  const repo = git(dir, 'rev-parse', '--show-toplevel');
  return {
    name, dir, skills, defaults: readJson(join(dir, 'defaults.json'), {}),
    source: repo ? basename(repo) : basename(dir), repo,
    rev: repo ? git(dir, 'rev-parse', '--short', 'HEAD') : null,
  };
}
function frontmatter(skillMd) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillMd, 'utf8'));
  const fm = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

// Host linters that would lint the installed skills' scripts under the host's own rules. A
// skill is owned upstream and overwritten on update, so the host should skip both directories
// (.claude/skills holds symlinks that linters follow, so it counts too). Text heuristics only:
// a config or ignore file that names both directories counts as skipping them, and so does a
// package.json script that runs the linter only on paths outside them (`eslint src/**`).
const JS_EXT = /\.(m|c)?[jt]sx?$/;
const VALUE_FLAGS = new Set(['--ext', '--config', '-c', '--config-path', '--format', '-f', '--rule', '--plugin', '--ignore-pattern', '--ignore-path', '--max-warnings', '--output-file', '-o', '--tsconfig']);
// For each script invocation of `tool`: does it lint the repo root or the skill directories?
// Returns null when no script runs it (an editor or CI may still), else true/false.
function scriptReaches(scripts, tool) {
  let seen = false, reaches = false;
  for (const cmd of scripts) for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const tok = seg.trim().split(/\s+/);
    const i = tok.findIndex((x) => x === tool || x.endsWith(`/${tool}`));
    if (i < 0) continue;
    seen = true;
    const paths = [];
    for (let j = i + 1; j < tok.length; j++) {
      const x = tok[j];
      if (x.startsWith('-')) { if (VALUE_FLAGS.has(x)) j++; continue; }
      if (tool === 'biome' && ['lint', 'check', 'ci', 'format'].includes(x)) continue;
      paths.push(x.replace(/^["']|["']$/g, ''));
    }
    if (!paths.length || paths.some((p) => /^(\.\/?|\*.*|\.agents.*|\.claude.*)$/.test(p))) reaches = true;
  }
  return seen ? reaches : null;
}
function lintersCoveringSkills(root) {
  const read = (f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return null; } };
  const skips = (...texts) => { const s = texts.filter(Boolean).join('\n'); return /\.agents\b/.test(s) && /\.claude\b/.test(s); };
  let files = []; try { files = readdirSync(root); } catch {}
  const scripts = Object.values(readJson(join(root, 'package.json'), {})?.scripts || {});
  const viaScripts = (tool) => scriptReaches(scripts, tool) !== false;
  const out = [];
  // oxlint: lints every JS/TS file unless ignored; runs with built-in rules even with no config.
  const ox = files.find((f) => /^\.?oxlintrc(\.json|\.jsonc)?$|^oxlint\.json$/.test(f));
  if ((ox || scriptReaches(scripts, 'oxlint')) && viaScripts('oxlint') && !skips(ox && read(ox), read('.oxlintignore'), read('.eslintignore')))
    out.push({ tool: 'oxlint', file: ox || 'package.json', fix: 'add ".agents/skills/**", ".claude/skills/**" to ignorePatterns' });
  // ESLint: flat config ignores only node_modules and .git by default.
  const es = files.find((f) => /^eslint\.config\.(m|c)?[jt]s$|^\.eslintrc(\.\w+)?$/.test(f));
  if (es && viaScripts('eslint') && !skips(read(es), read('.eslintignore')))
    out.push({ tool: 'eslint', file: es, fix: es.startsWith('eslint.config') ? 'add { ignores: [".agents/skills/**", ".claude/skills/**"] }' : 'add both directories to ignorePatterns' });
  // Biome: lints JS/TS by default; a files.includes list with no JS-capable entry leaves skills alone.
  const bi = files.find((f) => /^biome\.jsonc?$/.test(f));
  if (bi) {
    const text = read(bi) || '';
    const inc = /"includes"\s*:\s*\[([^\]]*)\]/.exec(text);
    const positives = inc ? [...inc[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('!')) : null;
    const reaches = !positives || positives.some((p) => (/^(\*\*|\.agents|\.claude|\*)/.test(p)) && (JS_EXT.test(p) || !/\.[a-z]+$/i.test(p)));
    if (reaches && viaScripts('biome') && !skips(text)) out.push({ tool: 'biome', file: bi, fix: 'add "!.agents/skills", "!.claude/skills" to files.includes' });
  }
  return out;
}

// ---------- target repo ----------
function target(opts, { forLocal } = {}) {
  const start = resolve(opts.to || process.cwd());
  const g = findGit(start, null, true);
  if (!g) die(`${start} is not inside a git repository`, 2);
  return { git: g, root: forLocal ? g.mainRoot : g.toplevel };
}
const lockOf = (root) => readJson(join(root, LOCK), { version: 1, skills: {} });

// .git/info/exclude lives in the common git dir, so one block covers every worktree.
function excludeFile(g) { return join(g.commonDir, 'info', 'exclude'); }
export function setExcludeBlock(g, lines) {
  const f = excludeFile(g);
  const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const re = new RegExp(`\\n?${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${BLOCK_END}\\n?`);
  let next = text.replace(re, '\n').replace(/\n{3,}$/, '\n\n');
  if (lines.length) next = `${next.replace(/\n*$/, '\n')}${BLOCK_START}\n${lines.join('\n')}\n${BLOCK_END}\n`;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, next.replace(/^\n+/, ''));
}
export function excludeBlock(g) {
  const f = excludeFile(g);
  const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const i = text.indexOf(BLOCK_START), j = text.indexOf(BLOCK_END);
  return i < 0 || j < 0 ? [] : text.slice(i + BLOCK_START.length, j).trim().split('\n').filter(Boolean);
}
// A local install's plans are working files in a team's repo: hide the plan directory too, unless
// the team already tracks files there (then whether plans are committed is theirs to decide).
function planDirToHide(root) {
  const home = String(readJson(join(root, PROJECT), {})?.planHome || 'plans').replace(/^\.?\/+|\/+$/g, '');
  if (!home || home.split('/').includes('..') || home.startsWith('/')) return null;
  return git(root, 'ls-files', '--', home) ? null : home;
}
function excludeLinesFor(lock, root) {
  if (lock.mode !== 'local') return ['/.agents/factory-metadata/state/'];
  const lines = ['/.agents/factory-metadata/'];
  const plans = planDirToHide(root);
  if (plans) lines.push(`/${plans}/`);
  for (const n of Object.keys(lock.skills).sort()) lines.push(`/.agents/skills/${n}`);
  if (lock.claudeLink === 'dir') lines.push('/.claude/skills');
  else if (lock.claudeLink === 'per-skill') for (const n of Object.keys(lock.skills).sort()) lines.push(`/.claude/skills/${n}`);
  return lines;
}

// ---------- the .claude/skills link ----------
// Claude Code reads .claude/skills; the other harnesses read .agents/skills. Three layouts:
//   absent → link .claude/skills to ../.agents/skills (copy on Windows)            ("dir")
//   a link to .agents/skills → nothing to do                                          ("dir")
//   a real directory (per-skill links or copies) → add one link per installed skill  ("per-skill")
function claudeLayout(root) {
  const c = join(root, '.claude', 'skills');
  if (!lexists(c)) return 'absent';
  if (isLink(c)) return 'dir';
  return IS_WIN && existsSync(join(c, '.factory-copy')) ? 'dir' : 'per-skill';
}
function linkOrCopy(targetAbs, linkPath, relTarget) {
  rmSync(linkPath, { recursive: true, force: true });
  mkdirSync(dirname(linkPath), { recursive: true });
  if (IS_WIN) cpSync(targetAbs, linkPath, { recursive: true });
  else symlinkSync(relTarget, linkPath);
}
function ensureClaudeLinks(root, names, report, { dryRun } = {}) {
  const layout = claudeLayout(root);
  const c = join(root, '.claude', 'skills');
  if (layout === 'absent') {
    report.push('link .claude/skills -> ../.agents/skills');
    if (!dryRun) {
      linkOrCopy(join(root, '.agents', 'skills'), c, join('..', '.agents', 'skills'));
      if (IS_WIN) writeFileSync(join(c, '.factory-copy'), 'copied by factory; refreshed by factory update\n');
    }
    return { mode: 'dir', created: true };
  }
  if (layout === 'dir') {
    if (IS_WIN && !dryRun) for (const n of names) cpSync(join(root, '.agents', 'skills', n), join(c, n), { recursive: true });
    return { mode: 'dir', created: false };
  }
  const conflicts = [];
  for (const n of names) {
    const p = join(c, n);
    const rel = join('..', '..', '.agents', 'skills', n);
    if (isLink(p) && readlinkSync(p) === rel) continue;
    if (lexists(p) && !isLink(p) && !report.replaced?.has(n)) { conflicts.push(n); continue; }
    report.push(`link .claude/skills/${n}`);
    if (!dryRun) linkOrCopy(join(root, '.agents', 'skills', n), p, rel);
  }
  return { mode: 'per-skill', created: false, conflicts };
}

// ---------- marker question ----------
async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = await new Promise((r) => rl.question(q, r));
  rl.close();
  return a.trim();
}
function describeMarker(m) {
  if (!m || m.mode === 'off') return 'off (comments are posted as written)';
  return `${m.mode}: <!-- ${m.text} {...} -->${m.mode === 'banner' ? ' plus a visible banner' : ''}`;
}
async function chooseMarker(flag, bundleDefault) {
  if (flag === 'off') return { mode: 'off' };
  if (flag === 'keep') return bundleDefault || { mode: 'off' };
  if (flag?.startsWith('text:')) return { mode: 'text', text: flag.slice(5) };
  if (flag) die(`--marker must be keep, off or text:<tag> (got ${flag})`, 2);
  if (!process.stdin.isTTY) {
    const m = bundleDefault || { mode: 'off' };
    warn(`PR comment marker: ${describeMarker(m)} (no TTY; pass --marker keep|off|text:<tag> to choose)`);
    return m;
  }
  out(`PR comment marker. Comments a session posts go out under your account; a marker lets you and your tools tell them apart.`);
  out(`  default: ${describeMarker(bundleDefault)}`);
  const a = (await ask('Keep the default, turn it off, or use your own tag? [keep/off/<tag>] ')).toLowerCase();
  if (!a || a === 'keep' || a === 'k') return bundleDefault || { mode: 'off' };
  if (a === 'off' || a === 'o' || a === 'none') return { mode: 'off' };
  return { mode: 'text', text: a };
}

function deepMergeMissing(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (k.startsWith('$')) continue;
    if (!(k in base)) base[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') deepMergeMissing(base[k], v);
  }
  return base;
}

// ---------- installs.json ----------
// Keyed by the main checkout: a committed install made in a worktree lands in the
// main checkout once the branch merges, and the worktree is usually deleted.
function recordInstall(root, lock) {
  const f = join(toolkitHome(), 'installs.json');
  const all = readJson(f, { version: 1, repos: {} });
  all.factory = FACTORY;
  all.sources = bundleSources(); // machine-specific paths stay here, never in a repo's lock
  if (Object.keys(lock.skills).length === 0) delete all.repos[root];
  else all.repos[root] = { mode: lock.mode, bundles: lock.bundles, skills: Object.keys(lock.skills).length, updatedAt: new Date().toISOString() };
  writeJson(f, all);
}

// ---------- install / update ----------
const lockEntry = (b, n, computedHash) => ({ source: b.source, sourceType: 'local', bundle: b.name,
  skillPath: posix(join(relative(b.repo || b.dir, b.dir), n, 'SKILL.md')), sourceRev: b.rev, computedHash });
async function install(bundleNames, opts, { isUpdate = false } = {}) {
  if (!bundleNames.length) die('name at least one bundle: factory install core [expedia] [trips]', 2);
  if (!bundleNames.includes('core')) bundleNames = ['core', ...bundleNames];
  const prior = target(opts);
  const priorLock = lockOf(prior.git.mainRoot);
  let mode = opts.commit ? 'commit' : opts.local ? 'local' : (priorLock.mode || lockOf(prior.root).mode);
  if (!mode) die('pass --commit (a repo you own: the skills are committed) or --local (a team repo: nothing is committed)', 2);
  const { git: g, root } = target(opts, { forLocal: mode === 'local' });
  const lock = lockOf(root);
  if (lock.mode && lock.mode !== mode) die(`this repo has a ${lock.mode} install; remove it before installing as ${mode}`, 2);
  lock.version = 1; lock.mode = mode;
  lock.bundles = [...new Set([...(lock.bundles || []), ...bundleNames])];
  const sources = bundleSources();
  const bundles = bundleNames.map((b) => readBundle(b, sources));
  const thirdPartyPath = join(root, 'skills-lock.json');
  const thirdParty = readJson(thirdPartyPath, null);
  const report = []; report.replaced = new Set();
  const conflicts = [], edited = [];
  const dest = (n) => join(root, '.agents', 'skills', n);
  const plan = [], relock = [];

  for (const b of bundles) for (const n of b.skills) {
    const src = join(b.dir, n);
    const srcHash = hashDir(src);
    const mine = lock.skills[n];
    if (mine && mine.bundle !== b.name) { conflicts.push(`${n}: in both ${mine.bundle} and ${b.name}`); continue; }
    if (existsSync(dest(n))) {
      if (mine) {
        if (mine.computedHash === srcHash && hashDir(dest(n)) === srcHash) {
          // Current. If the bundle moved to another repo, the files are the same but the lock
          // still names the old source: rewrite the entry only (sourceRev alone is not a move).
          const entry = lockEntry(b, n, srcHash);
          if (entry.source !== mine.source || entry.skillPath !== mine.skillPath) {
            report.push(`relock ${n} (source ${mine.source} → ${entry.source})`);
            relock.push({ n, entry });
          }
          continue;
        }
        if (hashDir(dest(n), lock.hashVersion || 1) !== mine.computedHash && !opts.force) { edited.push(n); continue; }
        report.push(`update ${n}`);
      } else if (thirdParty?.skills?.[n]) {
        report.push(`replace ${n} (was ${thirdParty.skills[n].source})`);
        report.replaced.add(n);
      } else if (!opts.force) {
        conflicts.push(`${n}: the repo already has its own skill with this name; left alone (rename ours or pass --force)`);
        continue;
      } else report.push(`replace ${n} (repo's own, --force)`);
    } else report.push(`add ${n}`);
    plan.push({ n, src, srcHash, b });
  }

  if (!opts.dryRun) {
    for (const { n, src, srcHash, b } of plan) {
      rmSync(dest(n), { recursive: true, force: true });
      mkdirSync(dirname(dest(n)), { recursive: true });
      cpSync(src, dest(n), { recursive: true, filter: (p) => installs(basename(p)) });
      lock.skills[n] = lockEntry(b, n, srcHash);
    }
    for (const { n, entry } of relock) lock.skills[n] = entry;
    lock.hashVersion = HASH_VERSION;
    if (report.replaced.size && thirdParty) {
      for (const n of report.replaced) delete thirdParty.skills[n];
      writeJson(thirdPartyPath, thirdParty);
    }
  }
  const names = Object.keys(lock.skills).length ? Object.keys(lock.skills) : plan.map((p) => p.n);
  const claude = ensureClaudeLinks(root, names, report, opts);
  lock.claudeLink = lock.claudeLink || (claude.created ? 'dir' : claude.mode === 'per-skill' ? 'per-skill' : 'existing');
  for (const n of claude.conflicts || []) conflicts.push(`.claude/skills/${n}: exists and isn't a link to .agents/skills/${n}; left alone`);

  // project.json: create once, asking the marker question; later installs only add missing defaults.
  const projPath = join(root, PROJECT);
  const existing = readJson(projPath, null);
  const defaults = {};
  for (const b of bundles) deepMergeMissing(defaults, b.defaults);
  // The marker is chosen explicitly (chooseMarker), never merged field by field.
  const markerDefault = defaults.pr?.commentMarker;
  const rest = structuredClone(defaults);
  if (rest.pr) { delete rest.pr.commentMarker; if (!Object.keys(rest.pr).length) delete rest.pr; }
  let proj = existing;
  if (!existing) {
    // Name from the remote (a worktree's directory name is not the project's name).
    let name = basename(g.mainRoot);
    const slug = parseRemote(git(root, 'remote', 'get-url', 'origin'))?.slug;
    if (slug) name = slug.split('/').pop();
    proj = { version: 1, name };
    // A hub already resolving through a multi-repo registry stays in workspace mode:
    // without this pointer, the new project.json would outrank the registry and drop its repos.
    const registry = ['.agents/factory-metadata/workspace.json', '.claude/repos.json']
      .find((r) => Array.isArray(readJson(join(root, ...r.split('/')), null)?.repos));
    if (registry) proj.workspace = registry;
    const marker = await chooseMarker(opts.marker, markerDefault);
    proj.pr = { commentMarker: marker };
    deepMergeMissing(proj, rest);
    report.push(`write ${posix(PROJECT)} (marker ${marker.mode}${registry ? `; workspace ${registry}` : ''})`);
  } else {
    const before = JSON.stringify(existing);
    if (!existing.pr || !('commentMarker' in existing.pr)) {
      existing.pr = { ...(existing.pr || {}), commentMarker: await chooseMarker(opts.marker, markerDefault) };
    }
    deepMergeMissing(existing, rest);
    if (JSON.stringify(existing) !== before) report.push(`update ${posix(PROJECT)} (added bundle defaults)`);
  }

  if (!opts.dryRun) {
    writeJson(projPath, proj);
    writeJson(join(root, LOCK), lock);
    setExcludeBlock(g, excludeLinesFor(lock, root));
    recordInstall(g.mainRoot, lock);
    if (plan.length) logUpdate(g.mainRoot, plan.map(({ n, b }) => ({ name: n, bundle: b.name, source: b.source, rev: b.rev })));
  }

  out(`${opts.dryRun ? '[dry run] ' : ''}${isUpdate ? 'update' : 'install'} ${bundleNames.join(' ')} → ${root} (${mode})`);
  for (const r of report) out(`  ${r}`);
  if (!report.length) out('  nothing to change');
  for (const e of edited) warn(`${e}: the installed copy was edited, so it wasn't updated. Move your change into the bundle, or pass --force to overwrite it.`);
  for (const c of conflicts) warn(c);
  for (const l of lintersCoveringSkills(root)) warn(`${l.tool} (${l.file}) will lint the installed skills' scripts under this repo's rules: ${l.fix}.`);
  if (mode === 'commit' && !opts.dryRun && report.length) {
    out(`\nCommit the install: git -C ${root} add .agents/skills .claude/skills .agents/factory-metadata skills-lock.json && git -C ${root} commit -m "chore: install factory-core ${bundleNames.join(' ')}"`);
  }
  return { edited, conflicts };
}

async function update(opts) {
  const roots = opts.all
    ? Object.keys(readJson(join(toolkitHome(), 'installs.json'), { repos: {} }).repos)
    : [(() => { const t = target(opts); return existsSync(join(t.git.toplevel, LOCK)) ? t.git.toplevel : t.git.mainRoot; })()];
  let failed = 0;
  for (const r of roots) {
    if (opts.all && !existsSync(r)) {
      warn(`${r}: no longer exists; dropped from installs.json (reinstall from the repo's main checkout if it moved)`);
      recordInstall(r, { skills: {} });
      continue;
    }
    const lock = existsSync(join(r, LOCK)) ? lockOf(r) : lockOf(target({ to: r }).root);
    if (!lock.mode) {
      const g = findGit(r, null, true);
      let branch = '';
      try { branch = readFileSync(join(g.gitDir, 'HEAD'), 'utf8').match(/^ref: refs\/heads\/(.+)/)?.[1] || ''; } catch {}
      warn(`${r}: no factory install${branch ? ` on the checked-out branch (${branch}); switch to the branch that has it, or run update from a worktree of it` : ''}`);
      failed++; continue;
    }
    const res = await install([...(lock.bundles || ['core'])], { ...opts, to: r, all: false }, { isUpdate: true });
    if (res.edited.length) failed++;
  }
  if (failed) process.exitCode = 1;
}

// ---------- remove ----------
function remove(names, opts) {
  if (!names.length) die('name a skill or bundle to remove (or "all")', 2);
  const t0 = target(opts);
  const root = existsSync(join(t0.git.mainRoot, LOCK)) && lockOf(t0.git.mainRoot).mode === 'local' ? t0.git.mainRoot : t0.root;
  const lock = lockOf(root);
  if (!lock.mode) die(`no factory install in ${root}`, 2);
  const drop = Object.entries(lock.skills).filter(([n, s]) => names.includes('all') || names.includes(n) || names.includes(s.bundle)).map(([n]) => n);
  for (const n of drop) {
    rmSync(join(root, '.agents', 'skills', n), { recursive: true, force: true });
    const c = join(root, '.claude', 'skills', n);
    if (lock.claudeLink === 'per-skill' || IS_WIN) rmSync(c, { recursive: true, force: true });
    delete lock.skills[n];
    out(`  removed ${n}`);
  }
  lock.bundles = (lock.bundles || []).filter((b) => !names.includes(b) && !names.includes('all'));
  const empty = Object.keys(lock.skills).length === 0;
  if (empty && lock.claudeLink === 'dir' && isLink(join(root, '.claude', 'skills'))) rmSync(join(root, '.claude', 'skills'));
  if (empty) {
    rmSync(join(root, LOCK), { force: true });
    if (opts.purge) rmSync(join(root, '.agents/factory-metadata'), { recursive: true, force: true });
    setExcludeBlock(t0.git, opts.purge || lock.mode !== 'local' ? [] : ['/.agents/factory-metadata/']);
  } else {
    writeJson(join(root, LOCK), lock);
    setExcludeBlock(t0.git, excludeLinesFor(lock, root));
  }
  if (root === t0.git.mainRoot) recordInstall(root, empty ? { skills: {} } : lock);
  out(`remove ${names.join(' ')} → ${root}: ${drop.length} skill(s)${empty ? '; install fully removed' + (opts.purge ? ' with .agents/factory-metadata/' : ' (.agents/factory-metadata/project.json kept; --purge deletes it)') : ''}`);
}

// ---------- link (local installs, new worktrees) ----------
export function link(opts) {
  const { git: g } = target(opts);
  const wt = g.toplevel, main = g.mainRoot;
  if (wt === main) die('run link inside a linked worktree; the main checkout already has the skills', 2);
  const lock = lockOf(main);
  if (lock.mode !== 'local') die(`link is for local-only installs; this repo's install is ${lock.mode || 'missing'}`, 2);
  let n = 0;
  for (const name of Object.keys(lock.skills)) {
    const p = join(wt, '.agents', 'skills', name);
    if (existsSync(join(p, 'SKILL.md')) && !isLink(p)) continue; // the branch has its own copy
    linkOrCopy(join(main, '.agents', 'skills', name), p, relative(dirname(p), join(main, '.agents', 'skills', name)));
    n++;
  }
  const c = join(wt, '.claude', 'skills');
  if (!lexists(c)) linkOrCopy(join(wt, '.agents', 'skills'), c, join('..', '.agents', 'skills'));
  else if (!isLink(c)) for (const name of Object.keys(lock.skills)) {
    const p = join(c, name);
    if (!lexists(p)) linkOrCopy(join(main, '.agents', 'skills', name), p, join('..', '..', '.agents', 'skills', name));
  }
  if (lock.claudeLink === 'dir' || !lexists(join(main, '.claude', 'skills'))) { /* covered by /.claude/skills */ }
  out(`link: ${n} skill(s) linked into ${wt}`);
}

// ---------- list ----------
function list(opts) {
  const t0 = target(opts);
  const lock = existsSync(join(t0.git.mainRoot, LOCK)) ? lockOf(t0.git.mainRoot) : lockOf(t0.root);
  if (!lock.mode) { out('no factory install here'); return; }
  const root = lock.mode === 'local' ? t0.git.mainRoot : t0.root;
  out(`${root} (${lock.mode}; bundles: ${(lock.bundles || []).join(', ')})`);
  for (const [n, s] of Object.entries(lock.skills).sort()) {
    const d = join(root, '.agents', 'skills', n);
    const state = !existsSync(d) ? 'MISSING' : hashDir(d, lock.hashVersion || 1) === s.computedHash ? 'ok' : 'EDITED';
    out(`  ${n.padEnd(32)} ${s.bundle.padEnd(8)} ${s.sourceRev || ''} ${state}`);
  }
}

// ---------- doctor ----------
// FACTORY_HARNESSES=claude-code,codex limits the check to those harnesses ("none" for none).
function harnessesPresent() {
  const only = process.env.FACTORY_HARNESSES ? process.env.FACTORY_HARNESSES.split(',') : null;
  const which = (b) => spawnSync(IS_WIN ? 'where' : 'sh', IS_WIN ? [b] : ['-c', `command -v ${b}`], { encoding: 'utf8' }).status === 0;
  return [
    { name: 'claude-code', bin: 'claude', dir: join('.claude', 'skills') },
    { name: 'codex', bin: 'codex', dir: join('.agents', 'skills') },
    { name: 'copilot', bin: 'copilot', dir: join('.agents', 'skills') },
    { name: 'cursor', bin: 'cursor-agent', dir: join('.agents', 'skills') },
  ].map((h) => ({ ...h, present: only ? only.includes(h.name) : which(h.bin) }));
}
const LIST_PROMPT = 'List the name of every skill available to you in this session, one per line, with no other text.';
function liveList(h, cwd) {
  const args = {
    'claude-code': ['-p', LIST_PROMPT, '--output-format', 'text'],
    codex: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', LIST_PROMPT],
    copilot: ['-p', LIST_PROMPT],
    cursor: ['-p', LIST_PROMPT],
  }[h.name];
  const r = spawnSync(h.bin, args, { cwd, encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout : null;
}

async function doctor(opts) {
  const t0 = target(opts);
  const mainLock = lockOf(t0.git.mainRoot);
  const lock = mainLock.mode ? mainLock : lockOf(t0.root);
  const root = lock.mode === 'local' ? t0.git.mainRoot : t0.root;
  const results = [];
  const check = (name, ok, detail = '', level = 'fail') => results.push({ name, status: ok ? 'ok' : level, detail });
  const names = Object.keys(lock.skills || {});
  check('install', !!lock.mode, lock.mode ? `${lock.mode}, ${names.length} skills, bundles ${(lock.bundles || []).join(', ')}` : 'no .agents/factory-metadata/skills-lock.json');

  // resolver
  const r = spawnSync(process.execPath, [join(root, '.agents', 'skills', 'toolkit-context', 'scripts', 'resolve.mjs'), '--no-cache'], { cwd: t0.git.toplevel, encoding: 'utf8' });
  let ctx = null; try { ctx = JSON.parse(r.stdout); } catch {}
  check('resolver', r.status === 0 && ctx, ctx ? `${ctx.mode}, ${ctx.project?.name}, trunk ${ctx.project?.trunk}, writeAllowed ${ctx.writeAllowed}` : (r.stderr || '').trim());
  if (existsSync(join(root, PROJECT))) {
    const v = spawnSync(process.execPath, [join(root, '.agents', 'skills', 'toolkit-context', 'scripts', 'validate.mjs'), join(root, PROJECT)], { encoding: 'utf8' });
    check('project.json schema', v.status === 0, (v.stderr || '').trim().split('\n')[0]);
  }
  check('marker policy', ctx?.adapters && 'commentMarker' in ctx.adapters, ctx?.adapters?.commentMarker ? describeMarker(ctx.adapters.commentMarker) : 'pr.commentMarker not set');

  // collisions and lock hashes
  const third = readJson(join(root, 'skills-lock.json'), { skills: {} });
  const dup = names.filter((n) => third.skills?.[n]);
  check('no colliding skills', dup.length === 0, dup.length ? `also in skills-lock.json: ${dup.join(', ')}` : '');
  const edited = names.filter((n) => existsSync(join(root, '.agents', 'skills', n)) && hashDir(join(root, '.agents', 'skills', n), lock.hashVersion || 1) !== lock.skills[n].computedHash);
  const missing = names.filter((n) => !existsSync(join(root, '.agents', 'skills', n, 'SKILL.md')));
  check('lock hashes', !edited.length && !missing.length, [edited.length && `edited: ${edited.join(', ')}`, missing.length && `missing: ${missing.join(', ')}`].filter(Boolean).join('; '));
  if (lock.mode === 'local') {
    const plans = planDirToHide(root);
    const shown = plans && existsSync(join(root, plans)) && git(root, 'status', '--porcelain', '--', plans);
    check('plans hidden', !shown, shown ? `${plans}/ shows in git status; run factory update to hide it` : '', 'warn');
  }
  let behind = [];
  try {
    const src = bundleSources();
    behind = names.filter((n) => { const s = lock.skills[n]; const d = join(src[s.bundle] || '', n); return existsSync(d) && hashDir(d) !== s.computedHash; });
  } catch {}
  check('up to date with sources', !behind.length, behind.length ? `${behind.length} changed upstream; run factory update` : '', 'warn');

  // CLIs
  const [maj, min] = process.versions.node.split('.').map(Number);
  check('node >= 20.16', maj > 20 || (maj === 20 && min >= 16), process.version);
  const gv = spawnSync('git', ['--version'], { encoding: 'utf8' });
  check('git', gv.status === 0, (gv.stdout || '').trim());
  const ghv = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  check('gh', ghv.status === 0, ghv.status === 0 ? ghv.stdout.split('\n')[0] : 'not found (PR skills need it)', 'warn');

  // local-only: nothing shows in git status
  if (lock.mode === 'local') {
    const st = git(root, 'status', '--porcelain', '--untracked-files=all') || '';
    const ours = st.split('\n').filter((l) => /\.agents\/factory-metadata\/|\.agents\/skills\/|\.claude\/skills/.test(l) && names.some((n) => l.includes(n) || l.includes('.agents/factory-metadata')));
    check('local-only install is invisible to git', ours.length === 0, ours.slice(0, 3).join(' | '));
  }

  // harness discovery: main checkout and a throwaway worktree
  const hs = harnessesPresent();
  const uncommitted = lock.mode === 'commit' && !!git(root, 'status', '--porcelain', '--', LOCK);
  const wtDir = join(root, '.worktrees', 'test', 'skill-discovery');
  let wtMade = false;
  if (!existsSync(wtDir) && git(root, 'worktree', 'add', '--detach', '-q', wtDir) !== null) wtMade = true;
  try {
    for (const h of hs) {
      if (!h.present) { results.push({ name: `harness ${h.name}`, status: 'skip', detail: `${h.bin} not installed` }); continue; }
      for (const [where, dir] of [['main checkout', root], ['new worktree', wtDir]]) {
        if (!existsSync(dir)) { check(`harness ${h.name} (${where})`, false, 'could not create a worktree', 'warn'); continue; }
        let seen = names.filter((n) => existsSync(join(dir, h.dir, n, 'SKILL.md')));
        let detail = `${seen.length}/${names.length} skills on disk under ${posix(h.dir)}`;
        // A local-only install is untracked, so a new worktree starts without it: link and look again.
        if (where === 'new worktree' && lock.mode === 'local' && seen.length < names.length && wtMade) {
          const l = spawnSync(process.execPath, [import.meta.filename, 'link', '--to', dir], { encoding: 'utf8' });
          seen = names.filter((n) => existsSync(join(dir, h.dir, n, 'SKILL.md')));
          detail += l.status === 0 ? `; after factory link: ${seen.length}/${names.length}` : `; factory link failed: ${(l.stderr || '').trim()}`;
        }
        let ok = seen.length === names.length;
        if (opts.live) {
          // Skills marked disable-model-invocation are user-only: harnesses keep them out of the
          // model's own listing, so only model-invocable skills are expected there.
          const expect = names.filter((n) => frontmatter(join(root, '.agents', 'skills', n, 'SKILL.md'))['disable-model-invocation'] !== 'true');
          const listed = liveList(h, dir);
          const lines = new Set((listed || '').split(/\r?\n/).map((l) => l.replace(/^[\s*`•-]+|[`\s]+$/g, '')));
          const found = expect.filter((n) => lines.has(n));
          ok = !!listed && found.length === expect.length;
          detail += `; live: ${listed ? `${found.length}/${expect.length} model-invocable listed` : 'harness run failed'}`;
          if (listed && found.length < expect.length) detail += ` (missing ${expect.filter((n) => !lines.has(n)).join(', ')})`;
        }
        if (!ok && where === 'new worktree' && lock.mode === 'local') detail += '; run factory link in each new worktree';
        if (!ok && where === 'new worktree' && lock.mode === 'commit' && uncommitted) detail += '; the install is not committed yet, and a new worktree starts from HEAD';
        check(`harness ${h.name} (${where})`, ok, detail, where === 'new worktree' && lock.mode === 'local' ? 'warn' : 'fail');
      }
    }
  } finally {
    if (wtMade) {
      git(root, 'worktree', 'remove', '--force', wtDir);
      for (const d of [dirname(wtDir), dirname(dirname(wtDir))]) { try { if (!readdirSync(d).length) rmSync(d, { recursive: true }); } catch {} }
    }
  }

  // context budget
  let listing = 0; const longDesc = [], bigMd = [];
  for (const n of names) {
    const md = join(root, '.agents', 'skills', n, 'SKILL.md');
    if (!existsSync(md)) continue;
    const fm = frontmatter(md);
    listing += (fm.name || '').length + (fm.description || '').length;
    if ((fm.description || '').length > LIMITS.descriptionChars) longDesc.push(`${n} (${fm.description.length})`);
    if (statSync(md).size > LIMITS.skillMdBytes) bigMd.push(`${n} (${Math.round(statSync(md).size / 1024)} KB)`);
  }
  check('context budget', listing <= LIMITS.listingChars && !longDesc.length,
    `listing ${listing} chars (~${Math.round(listing / 4)} tokens) of ${LIMITS.listingChars}` + (longDesc.length ? `; descriptions over ${LIMITS.descriptionChars}: ${longDesc.join(', ')}` : ''), 'warn');
  if (bigMd.length) check('SKILL.md size', false, `over 24 KB: ${bigMd.join(', ')}`, 'warn');

  // host linters
  const linters = lintersCoveringSkills(root);
  check('host linters skip installed skills', !linters.length, linters.map((l) => `${l.tool} (${l.file}): ${l.fix}`).join('; '), 'warn');

  if (opts.json) out(JSON.stringify({ root, results }, null, 2));
  else {
    out(`factory doctor: ${root}`);
    const mark = { ok: 'ok  ', fail: 'FAIL', warn: 'warn', skip: 'skip' };
    for (const x of results) out(`  ${mark[x.status]} ${x.name}${x.detail ? ` (${x.detail})` : ''}`);
  }
  const failed = results.filter((x) => x.status === 'fail').length;
  if (!opts.json) out(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exitCode = failed ? 1 : 0;
  return results;
}

// ---------- status: the session-start drift check ----------
// Cheap enough for a SessionStart hook: no hashing, and one `git log` per source repo only when that
// repo's HEAD or the lock changed since the last run (the answer is cached under ~/.agents/factory). A
// skill is behind when a commit after its sourceRev touched its directory; a bundle skill missing
// from the lock is new (update would add it). Uncommitted bundle edits don't count. Silent when the
// repo has no install or a bundle's source isn't on this machine; always exits 0.
function headOf(g) {
  // HEAD from the filesystem, so a cache hit spawns nothing. null when it can't be read cheaply.
  let head; try { head = readFileSync(join(g.gitDir, 'HEAD'), 'utf8').trim(); } catch { return null; }
  if (!head.startsWith('ref: ')) return head;
  const ref = head.slice(5);
  try { return readFileSync(join(g.commonDir, ref), 'utf8').trim(); } catch {}
  try { return (readFileSync(join(g.commonDir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`)) || '').split(' ')[0] || null; } catch { return null; }
}
export function drift(root, sources = bundleSources(), { maxCommits = 2000 } = {}) {
  const lock = lockOf(root);
  const byBundle = {};
  for (const [n, s] of Object.entries(lock.skills || {})) (byBundle[s.bundle] ||= []).push([n, s]);
  const behind = {}, added = {};
  const repos = new Map(); // repo toplevel -> [{ b, prefix, skills }]
  for (const [b, skills] of Object.entries(byBundle)) {
    const dir = sources[b];
    if (!dir || !existsSync(dir)) continue;
    for (const e of readdirSync(dir)) if (!lock.skills[e] && existsSync(join(dir, e, 'SKILL.md'))) (added[b] ||= []).push(e);
    const g = findGit(dir, null, true);
    if (!g) continue;
    const prefix = posix(relative(g.toplevel, dir));
    if (!repos.has(g.toplevel)) repos.set(g.toplevel, []);
    repos.get(g.toplevel).push({ b, prefix: prefix ? `${prefix}/` : '', skills });
  }
  for (const [top, bundles] of repos) {
    const log = git(top, 'log', `-n${maxCommits}`, '--format=%x00%H', '--name-only', 'HEAD');
    if (log == null) continue;
    const pending = bundles.flatMap(({ b, prefix, skills }) => skills.filter(([, s]) => s.sourceRev).map(([n, s]) => ({ b, key: `${prefix}${n}`, n, rev: s.sourceRev })));
    const touched = new Set();
    for (const block of log.split('\0').slice(1)) {
      if (!pending.length) break;
      const [sha, ...files] = block.split('\n').filter(Boolean);
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (!sha.startsWith(p.rev)) continue;
        if (touched.has(p.key)) (behind[p.b] ||= []).push(p.n);
        pending.splice(i, 1);
      }
      for (const f of files) for (const { prefix } of bundles) {
        if (prefix && !f.startsWith(prefix)) continue;
        touched.add(prefix + f.slice(prefix.length).split('/')[0]);
      }
    }
  }
  for (const m of [behind, added]) for (const k in m) m[k].sort();
  return { behind, added };
}
function statusLine(root) {
  const sources = bundleSources();
  const lockFile = join(root, LOCK);
  const heads = {};
  for (const b of Object.keys(sources).sort()) {
    const g = existsSync(sources[b]) ? findGit(sources[b], null, true) : null;
    heads[b] = g ? headOf(g) : null;
  }
  let mtime = 0; try { mtime = statSync(lockFile).mtimeMs; } catch {}
  const key = JSON.stringify({ mtime, sources, heads });
  const cacheFile = join(toolkitHome(), 'status-cache.json');
  const cache = readJson(cacheFile, {});
  if (cache[root]?.key === key && Object.values(heads).every(Boolean)) return cache[root].line;
  const { behind, added } = drift(root, sources);
  const list = (m) => {
    const parts = Object.entries(m).map(([b, ns]) => `${b}: ${ns.slice(0, 4).join(', ')}${ns.length > 4 ? ` +${ns.length - 4}` : ''}`);
    return `${Object.values(m).flat().length} (${parts.join('; ')})`;
  };
  const bits = [];
  if (Object.keys(behind).length) bits.push(`${list(behind)} changed upstream`);
  if (Object.keys(added).length) bits.push(`${list(added)} new`);
  const line = bits.length ? `factory: skills ${bits.join(', ')}. Update: node ${join(FACTORY, 'bin', 'factory.mjs')} update` : '';
  try { cache[root] = { key, line }; writeJson(cacheFile, cache); } catch {}
  return line;
}
function status(opts) {
  const g = findGit(resolve(opts.to || process.cwd()), null, true);
  if (!g) return;
  const root = [g.toplevel, g.mainRoot].find((r) => existsSync(join(r, LOCK)) && Object.keys(lockOf(r).skills || {}).length);
  if (!root) return;
  const line = statusLine(root);
  if (line) out(line);
  // A linked worktree of a local-only install sees the skills only after `factory link`.
  if (root === g.mainRoot && g.toplevel !== g.mainRoot && lockOf(root).mode === 'local') {
    const missing = Object.keys(lockOf(root).skills).filter((n) => !existsSync(join(g.toplevel, '.agents', 'skills', n, 'SKILL.md')));
    if (missing.length) out(`factory: this worktree can't see ${missing.length} installed skill(s). Link them: node ${join(FACTORY, 'bin', 'factory.mjs')} link`);
  }
}

// ---------- the update log and per-session notices ----------
// update appends what it copied; `status --hook` tells a running session about it at its next prompt.
// A skill read earlier in a session is still in that session's context, so the notice says to re-read it.
const UPDATES = () => join(toolkitHome(), 'updates.jsonl');
const SESSIONS = () => join(toolkitHome(), 'sessions');
function logUpdate(mainRoot, skills) {
  try {
    mkdirSync(toolkitHome(), { recursive: true });
    appendFileSync(UPDATES(), JSON.stringify({ at: Date.now(), root: mainRoot, skills }) + '\n');
  } catch {}
}
function updatesSince(mainRoot, since) {
  let text = '';
  try {
    const fd = openSync(UPDATES(), 'r');
    const size = fstatSync(fd).size, len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    text = buf.toString('utf8');
  } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (e.root === mainRoot && e.at > since) out.push(e); } catch {}
  }
  return out;
}
// Installed copies changed after the lock was written. A file newer than the lock is the cheap signal;
// only those skills are hashed, so a clean repo costs stats, not hashes.
function editedCopies(root, lock) {
  let lockAt = 0; try { lockAt = statSync(join(root, LOCK)).mtimeMs; } catch { return []; }
  const newer = (d) => {
    for (const e of readdirSync(d)) {
      if (!installs(e)) continue;
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory() ? newer(p) : st.mtimeMs > lockAt + 1000) return true;
    }
    return false;
  };
  const out = [];
  for (const [n, s] of Object.entries(lock.skills || {})) {
    const d = join(root, '.agents', 'skills', n);
    try { if (newer(d) && hashDir(d, lock.hashVersion || 1) !== s.computedHash) out.push({ name: n, source: s.source, skillPath: s.skillPath }); } catch {}
  }
  return out;
}
function readHookInput() {
  if (process.stdin.isTTY) return {};
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}
function hookStatus(opts) {
  const input = readHookInput();
  const sid = String(input.session_id || input.sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  const g = findGit(resolve(opts.to || input.cwd || process.cwd()), null, true);
  if (!g) return;
  const root = [g.toplevel, g.mainRoot].find((r) => existsSync(join(r, LOCK)) && Object.keys(lockOf(r).skills || {}).length);
  if (!root) return;
  const lock = lockOf(root);
  const event = input.hook_event_name || input.hookEventName || '';
  const file = sid ? join(SESSIONS(), `${sid}.json`) : null;
  const state = (file && readJson(file, null)) || null;
  const now = Date.now();
  const lines = [];
  if (!state || event === 'SessionStart') {
    status({ ...opts, to: opts.to || input.cwd }); // the drift line and the worktree hint, as at any session start
    if (file) {
      try { // forget sessions untouched for a week
        for (const f of readdirSync(SESSIONS())) if (now - statSync(join(SESSIONS(), f)).mtimeMs > 7 * 864e5) rmSync(join(SESSIONS(), f), { force: true });
      } catch {}
    }
  }
  // A resumed session (Codex fires SessionStart on resume too) still hears about updates made while it was closed.
  if (state) {
    const ups = updatesSince(g.mainRoot, state.seen);
    const names = [...new Set(ups.flatMap((e) => e.skills.map((x) => x.name)))].sort();
    if (names.length) {
      const revs = [...new Set(ups.flatMap((e) => e.skills.map((x) => `${x.source} ${x.rev}`)))].join(', ');
      const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` +${names.length - 6}` : '');
      lines.push(`factory: updated since this session last checked: ${shown} (${revs}). If you read one of them earlier in this session, read its SKILL.md again before following it.`);
    }
  }
  const told = new Set(state?.edited || []);
  const edited = editedCopies(root, lock).filter((e) => !told.has(e.name));
  for (const e of edited) lines.push(`factory: the installed copy of ${e.name} was edited here, but it's owned by ${e.source} (${e.skillPath}). Move the edit there, commit, then run factory update; the next update won't overwrite this copy until you do.`);
  for (const l of lines) out(l);
  if (file) {
    try { writeJson(file, { root: g.mainRoot, seen: now, edited: [...told, ...edited.map((e) => e.name)] }); } catch {}
  }
}

// ---------- setup ----------
// A new machine. Committed installs arrive with a clone, but the user hooks and installs.json don't,
// so sessions never hear about updates and `update --all` skips those repos. A hook file is backed up
// before it's written; a run that changes nothing writes nothing.
const hookCommand = () => `node '${join(FACTORY, 'bin', 'factory.mjs')}' status --hook 2>/dev/null || true`;
const IS_STATUS_HOOK = /factory\.mjs'? status --hook/;
export function addStatusHooks(cfg, harness, command = hookCommand()) {
  cfg.hooks ||= {};
  const changes = [];
  for (const ev of ['SessionStart', 'UserPromptSubmit']) {
    const groups = (cfg.hooks[ev] ||= []);
    const found = groups.flatMap((g) => g.hooks || []).filter((h) => IS_STATUS_HOOK.test(h.command || ''));
    for (const h of found) if (h.command !== command) { h.command = command; changes.push(`${ev}: repointed at this checkout`); }
    if (found.length) continue;
    const group = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (harness === 'claude-code' && ev === 'SessionStart') group.matcher = '^(startup|clear)$';
    groups.push(group);
    changes.push(`${ev}: added`);
  }
  return changes;
}
function hookFiles(env = process.env) {
  return [
    { harness: 'claude-code', dir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), file: 'settings.json' },
    { harness: 'codex', dir: env.CODEX_HOME || join(homedir(), '.codex'), file: 'hooks.json' },
  ].map((h) => ({ ...h, path: join(h.dir, h.file) }));
}
function setup(opts) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  out('hooks');
  let codexChanged = false;
  for (const h of hookFiles()) {
    if (!existsSync(h.dir)) { out(`  ${h.harness}: skipped (no ${h.dir})`); continue; }
    let cfg = {};
    if (existsSync(h.path)) {
      try { cfg = JSON.parse(readFileSync(h.path, 'utf8')); } catch { warn(`${h.path} isn't valid JSON; left alone. Add the hook by hand (README).`); process.exitCode = 1; continue; }
    }
    const changes = addStatusHooks(cfg, h.harness);
    if (!changes.length) { out(`  ${h.harness}: already set (${h.path})`); continue; }
    if (!opts.dryRun) {
      if (existsSync(h.path)) cpSync(h.path, `${h.path}.bak-${stamp}`);
      writeJson(h.path, cfg);
    }
    if (h.harness === 'codex') codexChanged = true;
    out(`  ${h.harness}: ${changes.join(', ')}${opts.dryRun ? ' (dry run)' : ` (${h.path}${existsSync(`${h.path}.bak-${stamp}`) ? `, backup .bak-${stamp}` : ''})`}`);
  }
  if (codexChanged) out('  codex: trust the new hooks in the next interactive session (codex exec runs no user hooks)');

  const root = resolve(opts.root || dirname(FACTORY));
  const known = readJson(join(toolkitHome(), 'installs.json'), { repos: {} }).repos;
  const recorded = [], already = [], none = [];
  for (const n of readdirSync(root).sort()) {
    const d = join(root, n);
    try { if (!statSync(join(d, '.git')).isDirectory()) continue; } catch { continue; } // main checkouts only
    const lock = lockOf(d);
    if (!lock.mode) { if (d !== FACTORY) none.push(n); continue; }
    if (known[d]) { already.push(n); continue; }
    if (!opts.dryRun) recordInstall(d, lock);
    recorded.push(`${n} (${lock.mode})`);
  }
  out(`repos under ${root}`);
  if (recorded.length) out(`  recorded${opts.dryRun ? ' (dry run)' : ''}: ${recorded.join(', ')}`);
  if (already.length) out(`  already recorded: ${already.join(', ')}`);
  if (none.length) {
    out(`  no install: ${none.join(', ')}`);
    out('  A team repo keeps its install out of git, so a clone has none. For each one you work in:');
    out('    factory install core [expedia] [trips] --local --to <repo>, then /toolkit-repo-register there');
  }
}

// ---------- CLI ----------
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to' || a === '--marker' || a === '--root') { o[a.slice(2)] = argv[++i]; if (o[a.slice(2)] == null) die(`${a} needs a value`, 2); }
    else if (['--commit', '--local', '--force', '--dry-run', '--all', '--purge', '--live', '--json', '--hook'].includes(a)) o[a.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) die(`unknown flag ${a}`, 2);
    else o._.push(a);
  }
  if (o.commit && o.local) die('--commit and --local are exclusive', 2);
  return o;
}
function help() {
  const src = readFileSync(import.meta.filename, 'utf8').split('\n');
  out(src.slice(1, src.findIndex((l) => l.startsWith('// Bundles:'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parse(rest);
  if (!cmd || o.help || cmd === 'help') help();
  else if (cmd === 'install') await install(o._, o);
  else if (cmd === 'update') await update(o);
  else if (cmd === 'remove') remove(o._, o);
  else if (cmd === 'link') link(o);
  else if (cmd === 'doctor') await doctor(o);
  else if (cmd === 'list') list(o);
  else if (cmd === 'setup') setup(o);
  else if (cmd === 'status') { try { o.hook ? hookStatus(o) : status(o); } catch {} process.exitCode = 0; }
  else die(`unknown command ${cmd} (see factory help)`, 2);
}
