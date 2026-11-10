#!/usr/bin/env node
// scope.mjs: the effective mining scope for this repo (or a neighbor) from .agents/factory-metadata/project.json.
// Prints one JSON object; exit 1 with a message when mining isn't configured. node: imports only.
//
//   scope.mjs [--cwd <dir>] [--neighbor <name>] [--reviewers a,b] [--mine-bots | --no-mine-bots]
//   scope.mjs --learn-dir [--cwd <dir>] [--neighbor <name>]   print only learn mode's directory (no cohort needed)
//
// Identity, trunk, host and the state directory come from toolkit-context. The mining block
// (cohort, loginSuffix, bots, paths) is read from the config file the resolver reports as its
// source. A flag replaces its field for this run; nothing here can widen the path scope.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTEXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'toolkit-context', 'scripts');
export const BOT_FLOOR = { minOccurrenceUnits: 5, minVerified: 2 };

function die(msg, code = 1) { process.stderr.write(`scope: ${msg}\n`); process.exit(code); }

function resolveCtx(cwd, neighbor) {
  const args = [join(CONTEXT, 'resolve.mjs'), '--cwd', cwd, '--no-cache', '--full'];
  if (neighbor) args.push('--repo', neighbor);
  const p = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (p.status !== 0) die(p.stderr.trim() || 'resolver failed', 2);
  return JSON.parse(p.stdout);
}

function configFile(ctx) {
  if (!ctx.source || !/project\.json$/.test(ctx.source)) return null;
  if (isAbsolute(ctx.source)) return ctx.source;
  const common = spawnSync('git', ['-C', ctx.project.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const main = common.status === 0 ? dirname(common.stdout.trim()) : ctx.project.root;
  return [join(main, ctx.source), join(ctx.project.root, ctx.source)].find(existsSync) || null;
}

// Learn mode's ledger and state: mining.learnDir (relative to the config's repo) when set, for a
// ledger that has to outlive a wiped stateRoot; otherwise <stateRoot>/pr-mining/learn.
function learnDirOf(ctx, file, mining) {
  return mining?.learnDir ? resolve(dirname(dirname(dirname(file))), mining.learnDir) : join(ctx.stateRoot, 'pr-mining', 'learn');
}
export function learnDir({ cwd = process.cwd(), neighbor } = {}) {
  const ctx = resolveCtx(cwd, neighbor);
  const file = configFile(ctx);
  return learnDirOf(ctx, file, (file && JSON.parse(readFileSync(file, 'utf8')).mining) || null);
}

export function effectiveScope({ cwd = process.cwd(), neighbor, reviewers, mineBots } = {}) {
  const ctx = resolveCtx(cwd, neighbor);
  const file = configFile(ctx);
  const mining = (file && JSON.parse(readFileSync(file, 'utf8')).mining) || null;
  if (!mining && !reviewers) {
    throw Object.assign(new Error(`no "mining" block in ${file || ctx.source || 'any .agents/factory-metadata/project.json'} for ${ctx.project.name}. Add one: {"mining":{"cohort":["login"],"paths":{"include":["src/"]}}}`), { code: 1 });
  }
  const cohort = reviewers || mining?.cohort || [];
  if (!cohort.length) throw Object.assign(new Error(`mining.cohort is empty for ${ctx.project.name}; list the reviewer logins or pass --reviewers`), { code: 1 });
  const notes = [];
  const bots = { mine: false, ...BOT_FLOOR, ...(mining?.bots || {}) };
  for (const k of Object.keys(BOT_FLOOR)) if (bots[k] < BOT_FLOOR[k]) { notes.push(`bots.${k} ${bots[k]} raised to the floor ${BOT_FLOOR[k]}`); bots[k] = BOT_FLOOR[k]; }
  if (mineBots !== undefined) bots.mine = mineBots;
  const include = (mining?.paths?.include || []).map(normPrefix);
  const exclude = (mining?.paths?.exclude || []).map(normPrefix);
  const suffix = mining?.loginSuffix || '';
  const r = ctx.project.remote || {};
  if (!r.host || !r.slug) throw Object.assign(new Error(`${ctx.project.name} has no remote host and slug; run toolkit-repo-register`), { code: 1 });
  return {
    name: ctx.project.name, localPath: ctx.project.root, trunk: ctx.project.trunk || null,
    ghHost: r.host, canonicalRepo: r.upstream || r.slug, fork: !!r.upstream,
    cohort, loginSuffix: suffix, queryLogins: cohort.map((l) => l + suffix),
    bots, wholeRepo: include.length === 0,
    paths: { include, exclude, pathlessBodies: mining?.paths?.pathlessBodies || 'scoped-pr-only' },
    marker: ctx.adapters?.commentMarker?.text || null,
    stateRoot: ctx.stateRoot, learnDir: learnDirOf(ctx, file, mining), writeAllowed: ctx.writeAllowed !== false,
    configFile: file, notes,
  };
}
function normPrefix(p) { const s = String(p).replace(/^\.?\/+/, ''); return s.endsWith('/') ? s : `${s}/`; }

// Is a changed file in scope? Prefixes match on directory boundaries; exclude wins.
export function inScope(path, paths) {
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return false;
  if (paths.exclude.some((p) => path.startsWith(p))) return false;
  return paths.include.length === 0 || paths.include.some((p) => path.startsWith(p));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const o = { cwd: process.cwd() };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const v = () => (a[i + 1] == null || a[i + 1].startsWith('--') ? die(`usage: ${a[i]} <value>`, 2) : a[++i]);
    if (a[i] === '--cwd') o.cwd = resolve(v());
    else if (a[i] === '--neighbor') o.neighbor = v();
    else if (a[i] === '--reviewers') o.reviewers = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a[i] === '--mine-bots') o.mineBots = true;
    else if (a[i] === '--no-mine-bots') o.mineBots = false;
    else if (a[i] === '--learn-dir') o.learnDirOnly = true;
    else die(`unknown argument: ${a[i]}`, 2);
  }
  try {
    process.stdout.write(o.learnDirOnly ? learnDir(o) + '\n' : JSON.stringify(effectiveScope(o), null, 2) + '\n');
  } catch (e) { die(e.message, e.code || 2); }
}
