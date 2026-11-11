#!/usr/bin/env node
// Repo-local run ownership, artifact retention and targeted teardown. No network.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, readdirSync, lstatSync, realpathSync, existsSync, rmSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = /^[a-f0-9-]{36}$/;
const CLASSES = ['intermediate', 'evidence', 'durable'];
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const inside = (root, p) => { const r = relative(root, p); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
function noLinks(root, p) {
  if (p !== root && !inside(root, p)) throw new Error(`outside owned root: ${p}`);
  let at = root;
  for (const part of ['', ...relative(root, p).split(sep).filter(Boolean)]) {
    if (part) at = join(at, part);
    try { if (lstatSync(at).isSymbolicLink()) throw new Error(`symlink in owned path: ${at}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function statePath(stateRoot) {
  const p = resolve(stateRoot);
  // The resolver-selected state root is trusted; links below it are never followed.
  return existsSync(p) ? realpathSync(p) : p;
}
function baseOf(stateRoot) { const s = statePath(stateRoot); const base = join(s, 'teardown'); noLinks(s, base); return base; }
function runPaths(stateRoot, id) {
  if (!ID.test(id || '')) throw new Error('invalid run id');
  const base = baseOf(stateRoot), root = join(base, 'runs', id);
  noLinks(base, join(root, 'manifest.json'));
  return { base, root, dir: join(root, 'files'), manifest: join(root, 'manifest.json') };
}
function save(p, value) {
  const temp = `${p}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, p); }
  finally { rmSync(temp, { force: true }); }
}
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (process.platform === 'win32') return null; // No portable start identity: never signal on a PID alone.
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
function liveOwner(m) {
  if (!Number.isSafeInteger(m.owner?.pid)) return true;
  if (!alive(m.owner.pid)) return false;
  const actual = processIdentity(m.owner.pid);
  return !actual || !m.owner.started || actual === m.owner.started;
}
async function locked(stateRoot, fn) {
  const base = baseOf(stateRoot); mkdirSync(base, { recursive: true });
  const lock = join(base, '.lock'); noLinks(base, lock);
  try { mkdirSync(lock); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner; try { owner = read(join(lock, 'owner.json')); } catch { throw new Error(`cleanup locked: ${lock}`); }
    throw new Error(`cleanup locked${liveOwner({ owner }) ? '' : ' (owner gone; inspect stale lock)'}: ${lock}`);
  }
  save(join(lock, 'owner.json'), { pid: process.pid, started: processIdentity(process.pid) });
  try { return await fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
const validPid = pid => Number.isSafeInteger(pid) && pid > 1;
const validMember = x => x && validPid(x.pid) && typeof x.started === 'string' && x.started.length > 0;
function validResource(x) {
  if (!x || Array.isArray(x) || (x.released !== undefined && typeof x.released !== 'boolean')) return false;
  if (x.type === 'scratch') return typeof x.path === 'string' && typeof x.base === 'string' && isAbsolute(x.base) && ID.test(x.token || '');
  if (x.type === 'process') return validMember(x) && (x.group === undefined || typeof x.group === 'boolean') && (x.members === undefined || Array.isArray(x.members) && x.members.every(validMember));
  if (x.type === 'browser') return /^[a-z0-9][a-z0-9_-]{0,100}$/i.test(x.session || '');
  if (x.type === 'slot') return typeof x.worktree === 'string' && isAbsolute(x.worktree) && /^[a-z0-9_-]+$/i.test(x.app || '');
  return false;
}
function load(stateRoot, id) {
  const p = runPaths(stateRoot, id), m = read(p.manifest);
  if (m.version !== 1 || m.id !== id || !Array.isArray(m.artifacts) || !Array.isArray(m.resources)
    || !['active', 'complete', 'failed'].includes(m.status) || typeof m.pinned !== 'boolean'
    || !Number.isFinite(m.createdAt) || !Number.isFinite(m.heartbeatAt)
    || (m.finishedAt !== undefined && !Number.isFinite(m.finishedAt))
    || typeof m.root !== 'string' || !isAbsolute(m.root)
    || !m.owner || !validPid(m.owner.pid) || !(m.owner.started === null || typeof m.owner.started === 'string')
    || !m.resources.every(validResource)) throw new Error(`invalid manifest: ${id}`);
  for (const a of m.artifacts) {
    if (!a || !CLASSES.includes(a.class) || typeof a.path !== 'string' || !a.path || isAbsolute(a.path)
      || (a.pinned !== undefined && typeof a.pinned !== 'boolean')
      || (a.pending !== undefined && typeof a.pending !== 'boolean')) throw new Error(`invalid artifact: ${id}`);
    const file = resolve(p.dir, a.path); if (!inside(p.dir, file)) throw new Error(`artifact outside run: ${a.path}`);
  }
  return { ...p, m };
}
async function mutate(o, fn) {
  return locked(o.stateRoot, async () => { const r = load(o.stateRoot, o.run); const value = await fn(r); save(r.manifest, r.m); return value ?? r.m; });
}
export async function beginRun({ stateRoot, root = process.cwd(), kind, ownerPid = process.ppid }) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1) throw new Error('owner pid must be an integer greater than 1');
  if (!kind || !/^[a-z0-9-]{1,80}$/i.test(kind)) throw new Error('kind must be a short name');
  return locked(stateRoot, () => {
    const id = randomUUID(), p = runPaths(stateRoot, id); mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const common = spawnSync('git', ['-C', resolve(root), 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], { encoding: 'utf8', timeout: 3000 });
    const [commonDir, gitDir] = common.status === 0 ? common.stdout.trim().split('\n') : [];
    const repoId = createHash('sha256').update(commonDir || resolve(root)).digest('hex').slice(0, 16);
    const worktreeId = gitDir && gitDir !== commonDir ? basename(gitDir) : 'main';
    const m = { version: 1, id, kind, repoId, worktreeId, root: resolve(root), createdAt: Date.now(), heartbeatAt: Date.now(),
      owner: { pid: ownerPid, started: processIdentity(ownerPid) }, status: 'active', pinned: false, artifacts: [], resources: [] };
    save(p.manifest, m); return { id, dir: p.dir, manifest: p.manifest, stateRoot: statePath(stateRoot) };
  });
}
export async function addArtifact(o) {
  return mutate(o, r => {
    if (!CLASSES.includes(o.class)) throw new Error('class must be intermediate, evidence or durable');
    const file = resolve(o.path); if (!inside(r.dir, file)) throw new Error(`artifact outside run: ${file}`);
    noLinks(r.root, file);
    if (existsSync(file) && !lstatSync(file).isFile()) throw new Error('register files individually, not directories');
    const key = relative(r.dir, file), existing = r.m.artifacts.find(a => a.path === key);
    if (existing) {
      if (existing.class !== o.class) throw new Error('artifact class cannot change');
      if (r.m.status !== 'active' && o.class !== 'evidence') throw new Error('run finished; begin a new run before recreating intermediates');
      if (r.m.status === 'active' && o.pending) existing.pending = true;
      return existing;
    }
    if (r.m.status !== 'active') throw new Error('run finished; begin a new run or unset FACTORY_RUN_ID before adding outputs');
    const a = { path: key, class: o.class, pinned: false, ...(o.pending ? { pending: true } : {}) }; r.m.artifacts.push(a); return a;
  });
}
export async function finishRun(o) {
  if (!['complete', 'failed'].includes(o.status)) throw new Error('status must be complete or failed');
  return mutate(o, r => { if (r.m.status === 'active') { r.m.status = o.status; r.m.finishedAt = Date.now(); } });
}
export async function heartbeat(o) { return mutate(o, r => { if (r.m.status !== 'active') throw new Error('run is not active'); r.m.heartbeatAt = Date.now(); if (o.ownerPid !== undefined) { if (!Number.isSafeInteger(o.ownerPid) || o.ownerPid <= 1) throw new Error('owner pid must be an integer greater than 1'); r.m.owner = { pid: o.ownerPid, started: processIdentity(o.ownerPid) }; } }); }
export async function pinRun(o) { if (typeof o.pinned !== 'boolean') throw new Error('pinned must be boolean'); return mutate(o, r => { r.m.pinned = o.pinned; }); }
export async function publishArtifact(o) {
  if (!o.verified || typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) throw new Error('publication needs a verified destination URL');
  return mutate(o, r => {
    const key = relative(r.dir, resolve(o.path)), a = r.m.artifacts.find(a => a.path === key);
    if (!a || a.class !== 'evidence') throw new Error('publication must name registered evidence');
    a.publication = { url: o.url, verifiedAt: Date.now() };
  });
}
export async function createScratch(o) {
  return mutate(o, r => {
    if (r.m.status !== 'active') throw new Error('run is not active');
    const base = realpathSync(tmpdir()), dir = mkdtempSync(join(base, 'factory-run-')), token = randomUUID();
    try { save(join(dir, '.factory-owner.json'), { run: r.m.id, token }); r.m.resources.push({ type: 'scratch', path: dir, base, token }); }
    catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
    return { dir };
  });
}
export async function registerResource(o) {
  return mutate(o, r => {
    if (r.m.status !== 'active') throw new Error('run is not active');
    let resource;
    if (o.type === 'process') {
      const pid = Number(o.pid), started = processIdentity(pid);
      if (!started || pid === process.pid) throw new Error('cannot establish a safe owned process identity');
      const group = spawnSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', timeout: 3000 });
      resource = { type: 'process', pid, started, group: group.status === 0 && Number(group.stdout.trim()) === pid };
    } else if (o.type === 'browser') {
      if (!/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(o.session || '')) throw new Error('invalid browser session');
      resource = { type: 'browser', session: o.session };
    } else if (o.type === 'slot') {
      if (!/^[a-z0-9_-]+$/i.test(o.app || '') || resolve(o.worktree || '') !== r.m.root) throw new Error('slot must belong to this run worktree');
      resource = { type: 'slot', app: o.app, worktree: r.m.root };
    } else throw new Error('unsupported resource type');
    if (!r.m.resources.some(x => JSON.stringify(x) === JSON.stringify(resource))) r.m.resources.push(resource);
    return resource;
  });
}
function groupMembers(group) {
  const r = spawnSync('ps', ['-axo', 'pid=,pgid=,lstart='], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0) throw new Error('cannot verify process-group membership');
  return r.stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)).filter(m => m && Number(m[2]) === group)
    .map(m => ({ pid: Number(m[1]), started: m[3] }));
}
export async function launchProcess(o) {
  const r = load(o.stateRoot, o.run);
  if (r.m.status !== 'active') throw new Error('run is not active');
  if (!Array.isArray(o.command) || !o.command.length || o.command.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('launch requires a command after --');
  const log = resolve(o.log || join(r.dir, 'server.log'));
  await addArtifact({ ...o, path: log, class: 'intermediate' });
  noLinks(r.root, log); mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a', 0o600);
  let child, owned;
  try { child = spawn(process.execPath, [join(HERE, 'run-process.mjs')], { detached: true, stdio: ['ignore', fd, fd, 'ipc'] }); }
  finally { closeSync(fd); }
  try {
    await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
    owned = await registerResource({ ...o, type: 'process', pid: child.pid });
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('owned process did not acknowledge startup')), 10000);
      child.once('message', message => { clearTimeout(timer); message.error ? fail(new Error(message.error)) : ok(); });
      child.once('exit', () => { clearTimeout(timer); fail(new Error('owned process exited before startup')); });
      child.send({ command: o.command, cwd: resolve(o.cwd || r.m.root) });
    });
    await heartbeat({ ...o, ownerPid: child.pid });
    child.disconnect(); child.unref(); return { pid: child.pid, log };
  } catch (e) {
    if (owned && processIdentity(child.pid) === owned.started) {
      try { process.kill(owned.group ? -child.pid : child.pid, 'SIGTERM'); } catch {}
    } else if (!owned && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw e;
  }
}

function safeScratch(resource, id) {
  const base = resource.base, p = resource.path;
  if (typeof base !== 'string' || !isAbsolute(base) || realpathSync(base) !== base) throw new Error('scratch base changed');
  if (typeof p !== 'string' || dirname(p) !== base || !/^factory-run-[a-zA-Z0-9]+$/.test(basename(p))) throw new Error('scratch outside temporary root');
  noLinks(base, join(p, '.factory-owner.json'));
  const owner = read(join(p, '.factory-owner.json'));
  if (owner.run !== id || owner.token !== resource.token) throw new Error('scratch ownership marker changed');
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isSymbolicLink()) throw new Error('scratch contains symlink'); if (e.isDirectory()) walk(join(d, e.name)); } };
  walk(p); return p;
}
async function releaseResource(x, r, scheduled, apply) {
  const action = { type: x.type, path: x.path, status: 'kept' };
  if (x.released) return { ...action, reason: 'already released' };
  if (scheduled && x.type !== 'scratch') return { ...action, reason: 'targeted teardown required' };
  if (!apply) return { ...action, status: 'candidate' };
  try {
    if (x.type === 'scratch') { if (existsSync(x.path)) rmSync(safeScratch(x, r.m.id), { recursive: true }); }
    else if (x.type === 'process') {
      if (!Number.isSafeInteger(x.pid) || x.pid <= 1 || x.pid === process.pid || x.pid === process.ppid) throw new Error('unsafe process identity');
      const current = processIdentity(x.pid);
      if (alive(x.pid) && (!x.started || current !== x.started)) throw new Error('process identity changed or unavailable');
      if (x.group) {
        if (current === x.started) {
          x.members = groupMembers(x.pid);
          process.kill(-x.pid, 'SIGTERM');
        } else {
          for (const member of x.members || []) if (processIdentity(member.pid) === member.started) process.kill(member.pid, 'SIGTERM');
        }
        for (let i = 0; i < 20 && groupMembers(x.pid).length; i++) await delay(50);
        if (groupMembers(x.pid).length) throw new Error('owned process group still has members; no force kill attempted');
      } else if (alive(x.pid)) {
        process.kill(x.pid, 'SIGTERM');
        for (let i = 0; i < 20 && alive(x.pid); i++) await delay(50);
        if (alive(x.pid)) throw new Error('process did not stop; no force kill attempted');
      }
    } else if (x.type === 'browser') {
      if (!/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(x.session || '')) throw new Error('invalid browser session');
      const result = spawnSync('agent-browser', ['--session', x.session, 'close'], { encoding: 'utf8', timeout: 10000 });
      if (result.status !== 0) throw new Error(result.error?.message || 'browser close failed');
    } else if (x.type === 'slot') {
      if (x.worktree !== r.m.root || !/^[a-z0-9_-]+$/i.test(x.app || '')) throw new Error('slot ownership changed');
      const result = spawnSync(process.execPath, [join(HERE, '../../factory-dev-slot/scripts/slot.mjs'), 'down', x.app, '--worktree', x.worktree, '--purge'], { cwd: r.m.root, encoding: 'utf8', timeout: 30000 });
      if (result.status !== 0) throw new Error(result.error?.message || 'slot teardown failed');
    } else throw new Error('unknown resource type');
    x.released = true; return { ...action, status: 'removed' };
  } catch (e) { return { ...action, status: 'failed', reason: e.message }; }
}
async function clean(r, { apply = false, scheduled = false } = {}) {
  if (r.m.pinned) return { id: r.m.id, reason: 'pinned', actions: [] };
  const actions = [];
  const runtime = r.m.resources.filter(x => x.type !== 'scratch');
  for (const x of runtime) actions.push(await releaseResource(x, r, scheduled, apply));
  if (actions.some(a => a.status === 'failed' || a.reason === 'targeted teardown required')) {
    return { id: r.m.id, reason: 'runtime resources require targeted teardown', actions };
  }
  for (const x of r.m.resources.filter(x => x.type === 'scratch')) actions.push(await releaseResource(x, r, scheduled, apply));
  for (const a of r.m.artifacts) {
    const file = resolve(r.dir, a.path), action = { path: file, type: 'artifact', status: 'kept' };
    if (a.class !== 'intermediate' || a.pinned || a.pending) { actions.push({ ...action, reason: a.pinned ? 'pinned' : a.pending ? 'awaiting consumer' : a.class }); continue; }
    try {
      noLinks(r.root, file);
      if (!existsSync(file)) action.status = 'absent';
      else if (!lstatSync(file).isFile()) throw new Error('artifact is not a regular file');
      else if (!apply) action.status = 'candidate';
      else { unlinkSync(file); action.status = 'removed'; }
    } catch (e) { action.status = 'failed'; action.reason = e.message; }
    actions.push(action);
  }
  return { id: r.m.id, actions };
}
export async function stopResources(o) {
  const perform = async () => {
    const r = load(o.stateRoot, o.run);
    if (r.m.pinned) return { id: r.m.id, reason: 'pinned', actions: [] };
    const actions = [];
    for (const x of r.m.resources.filter(x => x.type !== 'scratch')) actions.push(await releaseResource(x, r, false, o.apply));
    if (o.apply) save(r.manifest, r.m);
    return { id: r.m.id, actions };
  };
  return o.apply ? locked(o.stateRoot, perform) : perform();
}
export async function teardown(o) {
  const perform = async () => { const r = load(o.stateRoot, o.run); if (r.m.status === 'active') throw new Error('finish the active run before teardown'); const result = await clean(r, o); if (o.apply) save(r.manifest, r.m); return result; };
  return o.apply ? locked(o.stateRoot, perform) : perform();
}
export async function releaseInputs(o) {
  if (!o.verified) throw new Error('verify that every consumer is finished before releasing inputs');
  return mutate(o, r => { for (const a of r.m.artifacts) if (a.class === 'intermediate') a.pending = false; });
}

export async function configure(o) {
  if (!Number.isFinite(o.intermediateHours) || o.intermediateHours < 1) throw new Error('intermediateHours must be at least 1');
  return locked(o.stateRoot, () => { const policy = { version: 1, intermediateHours: o.intermediateHours }; save(join(baseOf(o.stateRoot), 'policy.json'), policy); return policy; });
}
export async function gc(o) {
  const perform = async () => {
    const base = baseOf(o.stateRoot), roots = join(base, 'runs'); noLinks(base, roots);
    const runs = [], now = o.now ?? Date.now();
    let policy; try { noLinks(base, join(base, 'policy.json')); policy = read(join(base, 'policy.json')); } catch (e) { if (e.code !== 'ENOENT') return { runs, errors: [e.message] }; }
    const hours = policy?.version === 1 && Number.isFinite(policy.intermediateHours) && policy.intermediateHours >= 1 ? policy.intermediateHours : null;
    if (!existsSync(roots)) return { runs, errors: [] };
    for (const id of readdirSync(roots)) {
      try {
        const r = load(o.stateRoot, id), m = r.m;
        const idle = now - m.heartbeatAt;
        const attended = m.status === 'active' && (idle < 10 * 60000 || (idle < 24 * 3600000 && liveOwner(m)));
        const reason = m.pinned ? 'pinned'
          : m.status === 'active' ? (attended ? 'active owner' : 'inactive run needs inspection')
          : !hours ? 'retention policy not configured'
          : now - (m.finishedAt ?? m.heartbeatAt) < hours * 3600000 ? 'too young' : null;
        if (reason) { runs.push({ id, reason, actions: [] }); continue; }
        const result = await clean(r, { apply: o.apply, scheduled: true });
        if (o.apply) save(r.manifest, m); runs.push(result);
      } catch (e) { runs.push({ id, actions: [], error: e.message }); }
    }
    return { runs, errors: [] };
  };
  return o.apply ? locked(o.stateRoot, perform) : perform();
}

function args(argv) {
  const [command, ...rest] = argv, o = {};
  const booleans = ['apply', 'dry-run', 'verified', 'pending'];
  const strings = ['state-root', 'owner-pid', 'log', 'cwd', 'run', 'kind', 'path', 'class', 'status', 'pid', 'type', 'session', 'app', 'worktree', 'url', 'intermediate-hours'];
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '--') { o.command = rest.slice(i + 1); break; } const key = rest[i].replace(/^--/, ''); if (booleans.includes(key)) o[key] = true; else if (strings.includes(key) && rest[i + 1] && !rest[i + 1].startsWith('--')) o[key] = rest[++i]; else throw new Error(`unknown or incomplete option: ${rest[i]}`); }
  if (o.apply && o['dry-run']) throw new Error('apply and dry-run are exclusive');
  return { command, o };
}
export function inspectRun(o) { const r = load(o.stateRoot, o.run); return { id: r.m.id, dir: r.dir, manifest: r.manifest, status: r.m.status }; }

export async function main(argv) {
  const { command, o } = args(argv);
  const cwd = resolve(o.cwd || process.cwd());
  const boundRoot = o['state-root'] || process.env.FACTORY_STATE_ROOT;
  let ctx;
  if (!boundRoot) {
    const resolver = spawnSync(process.execPath, [join(HERE, '../../factory-context/scripts/resolve.mjs'), '--no-cache'], { cwd, encoding: 'utf8' });
    if (resolver.status !== 0) throw new Error('cannot resolve project context');
    ctx = JSON.parse(resolver.stdout);
  }
  const opts = { ...o, stateRoot: boundRoot || ctx.stateRoot, root: ctx?.project.root || cwd, intermediateHours: Number(o['intermediate-hours']), ...(o['owner-pid'] ? { ownerPid: Number(o['owner-pid']) } : {}) };
  const commands = { launch: launchProcess, release: releaseInputs, stop: stopResources, show: inspectRun, begin: beginRun, add: addArtifact, scratch: createScratch, resource: registerResource, finish: finishRun, heartbeat, pin: x => pinRun({ ...x, pinned: true }), unpin: x => pinRun({ ...x, pinned: false }), publish: publishArtifact, configure, teardown, gc };
  if (!commands[command]) throw new Error('usage: lifecycle.mjs begin|add|scratch|resource|finish|heartbeat|pin|unpin|publish|configure|teardown|gc');
  return commands[command](opts);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result));
    if (['stop', 'teardown'].includes(process.argv[2]) && (result.actions?.some(a => a.status === 'failed') || result.reason)) process.exitCode = 1;
  }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
