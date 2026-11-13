#!/usr/bin/env node
// auto-update.mjs: when a bundle source repo's trunk moves, copy the change into every installed repo.
//
//   auto-update.mjs hook    run by .githooks/reference-transaction with git's ref lines on stdin
//   auto-update.mjs run     the detached worker the hook starts: `factory update --all`, debounced
//
// The hook must be quick and never fail the git command, so it only decides and spawns. The worker
// runs the update from the main checkout's own bin/factory.mjs, because that checkout is the bundle
// source `update` copies from. It skips when that checkout isn't on trunk or has uncommitted tracked
// changes: copying then would ship a branch or a draft. The status hook's "changed upstream" line
// still covers a skipped run. Then it runs `factory harness --apply`: a harness change was approved in
// the same review as a skill change, and harness.mjs refuses a broad allow and backs up each file.
// Opt out with FACTORY_AUTO_UPDATE=0 or `git config factory.autoUpdate false`; keep the harness step
// manual with `git config factory.autoHarness false`.
// A running consumer session hears about the copy from `factory status --hook` (updates.jsonl).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ZERO = /^0+$/;
const STALE_MS = 10 * 60 * 1000;
const home = (env = process.env) => (env.FACTORY_HOME ? resolve(env.FACTORY_HOME) : join(homedir(), '.agents/factory'));

// Git's own repo variables point at the source repo; an update that inherits them writes there.
export function cleanEnv(env = process.env) {
  const e = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_QUARANTINE_PATH']) delete e[k];
  return e;
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  return r.status === 0 ? r.stdout.trim() : null;
}

// reference-transaction stdin: "<old> <new> <ref>" per line. True when trunk got a new commit.
export function trunkMoved(input, trunk) {
  return String(input).split('\n').some((l) => {
    const [, next, ref] = l.trim().split(/\s+/);
    return ref === `refs/heads/${trunk}` && next && !ZERO.test(next);
  });
}

export function repoInfo(cwd) {
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common) return null;
  const mainRoot = dirname(common);
  const trunk = (git(mainRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') || 'origin/main').replace(/^origin\//, '');
  return { mainRoot, trunk };
}

// The main checkout is what `update` copies from, so it must be trunk, as committed.
export function readyToCopy(mainRoot, trunk) {
  const head = git(mainRoot, 'symbolic-ref', '--short', 'HEAD');
  if (head !== trunk) return `main checkout is on ${head || 'a detached HEAD'}, not ${trunk}`;
  if (git(mainRoot, 'status', '--porcelain', '--untracked-files=no')) return 'main checkout has uncommitted changes';
  return '';
}

export function optedOut(mainRoot, env = process.env) {
  return env.FACTORY_AUTO_UPDATE === '0' || git(mainRoot, 'config', '--bool', 'factory.autoUpdate') === 'false';
}

// One worker at a time. A second trigger while one runs leaves a pending mark; the worker loops
// until no mark is left, so a burst of commits costs one or two updates, never a missed one.
export function runLocked(dir, work, { now = Date.now } = {}) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'auto-update.lock'), pending = join(dir, 'auto-update.pending');
  try { mkdirSync(lock); } catch {
    let age = 0; try { age = now() - statSync(lock).mtimeMs; } catch {}
    if (age < STALE_MS) { writeFileSync(pending, ''); return 'queued'; }
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  let runs = 0;
  try {
    do { rmSync(pending, { force: true }); work(); runs++; } while (existsSync(pending) && runs < 5);
  } finally { rmSync(lock, { recursive: true, force: true }); }
  return `ran ${runs}`;
}

function log(line) {
  try { mkdirSync(home(), { recursive: true }); appendFileSync(join(home(), 'auto-update.log'), `${new Date().toISOString()} ${line}\n`); } catch {}
}

function hook() {
  let input = '';
  try { input = readFileSync(0, 'utf8'); } catch {}
  const info = repoInfo(process.cwd());
  if (!info || !trunkMoved(input, info.trunk) || optedOut(info.mainRoot)) return;
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, 'run', '--repo', info.mainRoot], { detached: true, stdio: 'ignore', env: cleanEnv() });
  child.unref();
}

function run(args) {
  const repo = args[args.indexOf('--repo') + 1];
  const info = repo && repoInfo(repo);
  if (!info) return log(`skip: ${repo || '(no --repo)'} is not a git repo`);
  // A merge or pull moves the ref around its checkout; let git finish before reading the tree.
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']);
  const result = runLocked(home(), () => {
    const why = readyToCopy(info.mainRoot, info.trunk);
    if (why) return log(`skip ${info.mainRoot}: ${why}`);
    const factory = join(info.mainRoot, 'bin', 'factory.mjs');
    const bin = existsSync(factory) ? factory : join(dirname(realpathSync(fileURLToPath(import.meta.url))), 'factory.mjs');
    const r = spawnSync(process.execPath, [bin, 'update', '--all'], { cwd: info.mainRoot, encoding: 'utf8', env: cleanEnv() });
    const head = git(info.mainRoot, 'rev-parse', '--short', 'HEAD');
    log(`update --all from ${info.mainRoot}@${head}: exit ${r.status}${r.status ? `\n${(r.stdout + r.stderr).trim()}` : ''}`);
    if (git(info.mainRoot, 'config', '--bool', 'factory.autoHarness') === 'false') return log('harness: skipped (factory.autoHarness false)');
    const hr = spawnSync(process.execPath, [bin, 'harness', '--apply'], { cwd: info.mainRoot, encoding: 'utf8', env: cleanEnv() });
    const changed = /^harness \S+:\n/m.test(hr.stdout || '') || /wrote /.test(hr.stdout || '');
    log(`harness --apply: exit ${hr.status}${hr.status || changed ? `\n${((hr.stdout || '') + (hr.stderr || '')).trim()}` : ''}`);
  });
  if (result === 'queued') log(`queued behind a running update (${info.mainRoot})`);
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try { if (cmd === 'hook') hook(); else if (cmd === 'run') run(rest); else { console.error('usage: auto-update.mjs hook | run --repo <dir>'); process.exitCode = 2; } }
  catch (e) { log(`error: ${e.message}`); }
}
