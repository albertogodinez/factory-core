#!/usr/bin/env node
// Run one dev server per worktree in its own container, published on 127.0.0.1:<port>, so
// several agents can validate the same app at once without fighting over its fixed dev port.
// Docker labels say who owns a slot (app, worktree, port); a lease file says when a slot command
// last touched it. gc reaps slots whose worktree is gone, whose container exited, or whose lease
// is older than the app's idleMinutes. up queues FIFO while Docker's memory cannot fit one more.
//
// Usage: node slot.mjs <command> [app] [--worktree DIR] [options]
//   up    [--no-wait] [--rebuild] [--force] [--timeout S]  start (or reuse) this worktree's slot
//   url | env | list | down [--all] [--purge] | gc [--dry-run]
//   check [--url URL]       exit 0 only if URL is served by this worktree
//   host  [--release] [--timeout S]  no Docker: wait for the app's own port, then hold its lock
// App config: <project>/.ai-toolkit/dev-slot.json or an installed companion's apps/<app>.json, shape
// ../schemas/app.schema.json. app defaults to the project name from toolkit-context.
// Env profile: adapters.envProfile names profiles/<name>.json in an installed skill (see SKILL.md).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Slot state (leases, queue, host lock) lives beside the per-worktree stateRoot, so every worktree of
// one project shares it: <stateRoot>/../dev-slots. initState() sets it before any command runs.
let STATE = '', LEASES = '', QUEUE = '';
export function initState(dir) { STATE = dir; LEASES = join(dir, 'leases'); QUEUE = join(dir, 'queue'); }
const LABEL = 'toolkit.dev-slot';
const GiB = 1024 ** 3;
const POLL_MS = 10000, TICKET_STALE_MS = 2 * 60 * 1000;
export const EXIT = { usage: 1, prereq: 2, notReady: 4, none: 8, mismatch: 9, timeout: 10 };

// Minimal checker for the subset of JSON Schema the app files use (node: modules only, no ajv).
export function check(value, sch, path, errs = []) {
  const t = sch.type;
  const ok = t === 'array' ? Array.isArray(value) : t === 'integer' ? Number.isInteger(value)
    : t === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : typeof value === t;
  if (!ok) return errs.push(`${path}: expected ${t}`), errs;
  if (sch.enum && !sch.enum.includes(value)) errs.push(`${path}: must be one of ${sch.enum.join(', ')}`);
  if (t === 'string') {
    if (sch.minLength && value.length < sch.minLength) errs.push(`${path}: empty`);
    if (sch.pattern && !new RegExp(sch.pattern).test(value)) errs.push(`${path}: "${value}" does not match ${sch.pattern}`);
  }
  if ((t === 'integer' || t === 'number') && ((sch.minimum != null && value < sch.minimum) || (sch.maximum != null && value > sch.maximum))) errs.push(`${path}: out of range`);
  if (t === 'array') {
    if (sch.minItems && value.length < sch.minItems) errs.push(`${path}: needs at least ${sch.minItems} item(s)`);
    value.forEach((v, i) => check(v, sch.items, `${path}[${i}]`, errs));
  }
  if (t === 'object') {
    for (const k of sch.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (sch.properties?.[k]) check(v, sch.properties[k], `${path}.${k}`, errs);
      else if (sch.additionalProperties === false) errs.push(`${path}.${k}: unknown property`);
    }
  }
  return errs;
}

const SKILLS_DIR = join(here, '../..');
const skillsDirs = (worktree) => [...new Set([join(worktree, '.agents/skills'), SKILLS_DIR].map(real))];

// Where an app config can live: the project's own file, then each installed companion's apps/ dir.
export function appCandidates(name, worktree) {
  const own = [join(worktree, '.ai-toolkit/dev-slot.json')];
  const companions = skillsDirs(worktree).flatMap((d) => existsSync(d)
    ? readdirSync(d).filter((e) => e.startsWith('toolkit-dev-slot-')).map((e) => join(d, e, 'apps', `${name}.json`)) : []);
  return [...own, ...companions];
}

export function validateApp(app, label = 'app') {
  const errs = check(app, JSON.parse(readFileSync(join(here, '../schemas/app.schema.json'), 'utf8')), label);
  if (app.portRange?.length === 2 && app.portRange[0] > app.portRange[1]) errs.push(`${label}.portRange: first > last`);
  return errs;
}

export function loadAppFile(file, name) {
  const app = JSON.parse(readFileSync(file, 'utf8'));
  const errs = validateApp(app, name ?? file);
  if (name && app.name !== name) errs.push(`${name}.name: must match the app name (${file} says "${app.name}")`);
  if (errs.length) throw new Error(`${file}:\n${errs.join('\n')}`);
  return app;
}

// name: the app (default: the project's name). worktree: where to look for the project's own file.
export function loadApp(name, worktree = process.cwd()) {
  const tried = [];
  for (const file of appCandidates(name, worktree)) {
    if (!existsSync(file)) { tried.push(file); continue; }
    const own = file.endsWith('/.ai-toolkit/dev-slot.json');
    const app = JSON.parse(readFileSync(file, 'utf8'));
    if (own && app.name !== name) { tried.push(`${file} (names "${app.name}")`); continue; }
    return loadAppFile(file, name);
  }
  throw new Error(`no app config for "${name}". Looked in:\n  ${tried.join('\n  ')}\nAdd .ai-toolkit/dev-slot.json (copy examples/astro.json) or install a toolkit-dev-slot-* companion that ships apps/${name}.json.`);
}

// --- env profiles -----------------------------------------------------------------------------
// A profile is extra container setup a company network needs. Named by adapters.envProfile, shipped
// as profiles/<name>.json by an installed skill. No profile configured means none applied.
export function profileCandidates(name, worktree) {
  return skillsDirs(worktree).flatMap((d) => existsSync(d)
    ? readdirSync(d).map((e) => join(d, e, 'profiles', `${name}.json`)) : []);
}

export function loadProfile(name, worktree) {
  const found = profileCandidates(name, worktree).find((f) => existsSync(f));
  if (!found) throw new Error(`env profile "${name}" (adapters.envProfile) not found. Looked for .agents/skills/*/profiles/${name}.json in:\n  ${skillsDirs(worktree).join('\n  ')}\nInstall the skill that ships it, or unset adapters.envProfile.`);
  const profile = JSON.parse(readFileSync(found, 'utf8'));
  const errs = check(profile, JSON.parse(readFileSync(join(here, '../schemas/profile.schema.json'), 'utf8')), name);
  if (profile.name !== name) errs.push(`${name}.name: must match the profile name, got "${profile.name}"`);
  if (errs.length) throw new Error(`${found}:\n${errs.join('\n')}`);
  return { ...profile, file: found };
}

// .worktrees/fix/scrollbar-styling -> fix-scrollbar-styling; the main checkout -> main.
export function slugFor(worktree, main) {
  const rel = relative(main, worktree);
  const raw = rel === '' ? 'main' : rel.startsWith('..') ? basename(worktree) : rel.replace(/^\.worktrees\//, '');
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'main';
}

export function pickPort(taken, [lo, hi]) {
  for (let p = lo; p <= hi; p++) if (!taken.has(p)) return p;
  return null;
}

export const fitsMemory = ({ totalBytes, running, perSlotGiB }) => (running + 1) * perSlotGiB * GiB <= totalBytes;

// Why gc should remove a slot, or null to keep it.
export function expiry({ status, worktreeExists, lastUsed, now, idleMinutes }) {
  if (!worktreeExists) return 'worktree gone';
  if (status !== 'running') return `container ${status}`;
  const idle = Math.floor((now - lastUsed) / 60000);
  return idle >= idleMinutes ? `idle ${idle} min` : null;
}

// Oldest live ticket first; a ticket whose owner stopped heartbeating no longer holds a place.
export function queueOrder(tickets, now, staleMs = TICKET_STALE_MS) {
  return tickets.filter((t) => now - t.beat < staleMs).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function parseArgs(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (['worktree', 'timeout', 'url'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { cmd: pos[0], app: pos[1], flags };
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tryRun = (cmd, args) => { try { return run(cmd, args); } catch { return null; } };
const log = (msg) => process.stderr.write(`• ${msg}\n`);
const die = (code, msg) => { process.stderr.write(`✗ ${msg}\n`); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

function resolveWorktree(dir) {
  const top = tryRun('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top) die(EXIT.usage, `${dir} is not inside a git worktree`);
  const common = run('git', ['-C', top, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { worktree: real(top), main: real(dirname(common)) };
}

// Every slot on the machine (memory and ports are shared); ownSlots() is this project's, the only
// ones gc may reap, since another project's leases live in its own state dir.
function slots() {
  const ids = tryRun('docker', ['ps', '-aq', '--filter', `label=${LABEL}`]);
  if (!ids) return [];
  return JSON.parse(run('docker', ['inspect', ...ids.split('\n')])).map((c) => {
    const l = c.Config.Labels;
    const binding = Object.values(c.HostConfig.PortBindings ?? {})[0]?.[0];
    return { container: c.Name.replace(/^\//, ''), app: l[`${LABEL}.app`], worktree: l[`${LABEL}.worktree`], slug: l[`${LABEL}.slug`],
      state: l[`${LABEL}.state`], status: c.State.Status, port: binding ? Number(binding.HostPort) : null, startedAt: Date.parse(c.State.StartedAt) || Date.parse(c.Created) };
  });
}

const ownSlots = () => slots().filter((s) => s.state === STATE);
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const leaseFile = (container) => join(LEASES, `${container}.json`);
function touch(container) {
  mkdirSync(LEASES, { recursive: true });
  writeFileSync(leaseFile(container), JSON.stringify({ at: Date.now() }));
}
const lastUsed = (slot) => readJson(leaseFile(slot.container))?.at ?? slot.startedAt;

function remove(slot, purge) {
  tryRun('docker', ['rm', '-f', slot.container]);
  if (purge) tryRun('docker', ['volume', 'rm', `${slot.container}-node-modules`]);
  rmSync(leaseFile(slot.container), { force: true });
}

// Keeps the node_modules volume unless the worktree is gone, so a reaped slot restarts fast.
function gc({ dryRun = false, quiet = false } = {}) {
  const removed = [];
  for (const s of ownSlots()) {
    let idleMinutes = 60;
    try { idleMinutes = loadApp(s.app, s.worktree).idleMinutes ?? 60; } catch {}
    const worktreeExists = existsSync(s.worktree);
    const reason = expiry({ status: s.status, worktreeExists, lastUsed: lastUsed(s), now: Date.now(), idleMinutes });
    if (!reason) continue;
    if (!dryRun) remove(s, !worktreeExists);
    removed.push({ container: s.container, worktree: s.worktree, reason, removed: !dryRun });
    if (!quiet) log(`${dryRun ? 'would remove' : 'removed'} ${s.container}: ${reason}`);
  }
  // A volume outlives a slot reaped as idle; reclaim it once its worktree is gone too.
  const vols = tryRun('docker', ['volume', 'ls', '-q', '--filter', `label=${LABEL}.worktree`]);
  const live = new Set(slots().map((s) => s.container));
  for (const v of vols ? JSON.parse(run('docker', ['volume', 'inspect', ...vols.split('\n')])) : []) {
    const wt = v.Labels[`${LABEL}.worktree`];
    if (v.Labels[`${LABEL}.state`] !== STATE || existsSync(wt) || live.has(v.Name.replace(/-node-modules$/, ''))) continue;
    if (!dryRun) tryRun('docker', ['volume', 'rm', v.Name]);
    removed.push({ volume: v.Name, worktree: wt, reason: 'worktree gone', removed: !dryRun });
    if (!quiet) log(`${dryRun ? 'would remove' : 'removed'} volume ${v.Name}: worktree gone`);
  }
  for (const f of existsSync(LEASES) ? readdirSync(LEASES) : []) if (!live.has(f.replace(/\.json$/, '')) && !dryRun) rmSync(join(LEASES, f), { force: true });
  return removed;
}

function tickets() {
  return (existsSync(QUEUE) ? readdirSync(QUEUE) : []).map((f) => readJson(join(QUEUE, f))).filter(Boolean);
}

// Wait FIFO for memory: reap expired slots each round, start only as the oldest live ticket.
async function admit(app, worktree, flags) {
  mkdirSync(QUEUE, { recursive: true });
  const ticket = { id: randomUUID(), at: Date.now(), beat: Date.now(), app: app.name, worktree };
  const file = join(QUEUE, `${ticket.id}.json`);
  const leave = () => rmSync(file, { force: true });
  process.on('exit', leave);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
  const end = Date.now() + Number(flags.timeout ?? 1800) * 1000;
  const totalBytes = Number(run('docker', ['info', '--format', '{{.MemTotal}}']));
  let said = '';
  for (;;) {
    ticket.beat = Date.now();
    writeFileSync(file, JSON.stringify(ticket));
    gc({ quiet: true });
    for (const t of tickets()) if (Date.now() - t.beat >= TICKET_STALE_MS) rmSync(join(QUEUE, `${t.id}.json`), { force: true });
    const running = slots().filter((s) => s.status === 'running').length;
    const order = queueOrder(tickets(), Date.now());
    const place = order.findIndex((t) => t.id === ticket.id);
    if (place === 0 && fitsMemory({ totalBytes, running, perSlotGiB: app.memoryGiB })) return leave;
    if (Date.now() > end) die(EXIT.timeout, `still queued after ${flags.timeout ?? 1800}s (${running} slot(s) running, ${(totalBytes / GiB).toFixed(1)} GiB Docker memory)`);
    const msg = place > 0 ? `queued: ${place} ahead of you` : `waiting for memory: ${running} slot(s) running, Docker has ${(totalBytes / GiB).toFixed(1)} GiB, one more needs ${app.memoryGiB} GiB (slot list / down frees one; Docker Desktop → Resources → Memory raises the cap)`;
    if (msg !== said) log((said = msg));
    await sleep(POLL_MS);
  }
}

function listenerCwd(port) {
  const pid = tryRun('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])?.split('\n')[0];
  if (!pid) return null;
  const line = tryRun('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])?.split('\n').find((s) => s.startsWith('n'));
  return line ? real(line.slice(1)) : `pid ${pid}`;
}

const status = (url) => new Promise((done) => {
  const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { rejectUnauthorized: false, timeout: 5000 }, (res) => { res.resume(); done(res.statusCode); });
  req.on('error', () => done(null)).on('timeout', () => req.destroy());
  req.end();
});

// A host port for a slot's own auth proxy (an app's auth script may use one), clear of
// every slot's app port, so two slots' proxies never ask for the same one.
export const proxyPortFor = (port) => port + 1000;

export const schemeOf = (app) => app.scheme ?? 'https';
export const envNames = (app) => ({ baseUrl: 'DEV_SLOT_BASE_URL', session: 'DEV_SLOT_SESSION', ...app.env });

function describe(app, slot) {
  const baseUrl = `${schemeOf(app)}://localhost:${slot.port}`;
  return { app: app.name, worktree: slot.worktree, container: slot.container, status: slot.status, port: slot.port,
    baseUrl, url: `${baseUrl}${app.healthPath}`, session: `${app.sessionPrefix ?? app.name}-${slot.slug}`,
    proxyPort: proxyPortFor(slot.port), idleMinutes: app.idleMinutes ?? 60 };
}

export function envLine(app, d) {
  const n = envNames(app);
  const vars = [`${n.baseUrl}=${d.baseUrl}`, `${n.session}=${d.session}`];
  if (n.proxyPort) vars.push(`${n.proxyPort}=${d.proxyPort}`);
  return `export ${vars.join(' ')}`;
}

function dockerUp() {
  if (!tryRun('docker', ['info', '--format', '{{.ServerVersion}}'])) die(EXIT.prereq, 'Docker is not running; start Docker Desktop (open -a Docker), or use `slot.mjs host` to wait for the app port instead');
}

const expand = (p) => p.replace(/^~(?=\/|$)/, homedir());

// Turn an env profile into `docker run` args plus the child env. A secret taken from a file goes
// through the child env (`-e NAME` with no value), never argv. Without a profile: no extra args.
// Anything the host env holds beyond what the profile names stays on the host.
export function applyProfile(profile, { stateDir = STATE, hostEnv = process.env, log: say = log } = {}) {
  const args = [], env = { ...hostEnv };
  if (!profile) return { args, env };
  const mounted = new Set();
  for (const m of profile.mounts ?? []) {
    const host = expand(m.host);
    if (!existsSync(host)) { if (m.warnIfMissing) say(m.warnIfMissing); continue; }
    args.push('-v', `${host}:${m.container}${m.readOnly === false ? '' : ':ro'}`);
    mounted.add(host);
  }
  for (const [k, v] of Object.entries(profile.env ?? {})) args.push('-e', `${k}=${v}`);
  for (const f of profile.envFromFile ?? []) {
    const file = expand(f.file);
    const value = existsSync(file) ? readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(f.linePrefix))?.slice(f.linePrefix.length).trim() : null;
    if (value) { env[f.name] = value; args.push('-e', f.name); }
    else if (f.warnIfMissing) say(f.warnIfMissing);
  }
  for (const v of profile.passEnv ?? []) if (hostEnv[v]) args.push('-e', `${v}=${hostEnv[v]}`);
  for (const v of profile.rewriteLoopbackEnv ?? []) {
    if (hostEnv[v]) args.push('-e', `${v}=${hostEnv[v].replace(/127\.0\.0\.1|localhost/, 'host.docker.internal')}`);
  }
  const ca = profile.caBundle;
  if (ca) {
    let pem = '';
    if (ca.from === 'macos-keychain') {
      pem = (ca.keychains ?? []).map((k) => tryRun('security', ['find-certificate', '-a', '-p', k]) ?? '').join('\n');
    } else if (ca.from === 'file' && existsSync(expand(ca.path))) pem = readFileSync(expand(ca.path), 'utf8');
    if (pem.trim()) {
      mkdirSync(stateDir, { recursive: true });
      const out = join(stateDir, `${profile.name}-ca.pem`);
      writeFileSync(out, pem);
      args.push('-v', `${out}:${ca.container}:ro`, '-e', `${ca.env ?? 'NODE_EXTRA_CA_CERTS'}=${ca.container}`);
    } else say(`env profile ${profile.name}: no CA certificates found; TLS-inspecting proxies may fail`);
  }
  return { args, env };
}

function ensureImage(app, worktree, rebuild, profile) {
  if (!app.dockerfile) return;
  const sha = createHash('sha256').update(readFileSync(join(worktree, app.dockerfile))).digest('hex').slice(0, 16);
  const have = tryRun('docker', ['image', 'inspect', '-f', `{{index .Config.Labels "${LABEL}.dockerfile"}}`, app.image]);
  if (have === sha && !rebuild) return;
  log(`building ${app.image} from ${app.dockerfile}${have == null ? '' : ' (Dockerfile changed or --rebuild)'}`);
  const r = spawnSync('docker', ['build', '-q', '--label', `${LABEL}.dockerfile=${sha}`, '-f', app.dockerfile, '-t', app.image, '.'], { cwd: worktree, encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(r.stderr.split('\n').slice(-15).join('\n'));
    die(EXIT.prereq, `docker build failed${profile?.hints?.buildFailed ? `; ${profile.hints.buildFailed}` : ''}; an EOF means the Docker daemon restarted, so retry`);
  }
}

async function waitReady(app, slot, timeoutS) {
  const url = `${schemeOf(app)}://localhost:${slot.port}${app.healthPath}`;
  log(`waiting for ${url} (the first start installs dependencies; logs: docker logs -f ${slot.container})`);
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    if (await status(url) === 200) return;
    const st = tryRun('docker', ['inspect', '-f', '{{.State.Status}}', slot.container]);
    if (st !== 'running') {
      process.stderr.write(tryRun('docker', ['logs', '--tail', '30', slot.container]) ?? '');
      die(EXIT.notReady, `${slot.container} is ${st}; see the log above`);
    }
    await sleep(5000);
  }
  die(EXIT.notReady, `${url} not ready after ${timeoutS}s; check docker logs ${slot.container}`);
}

async function up(app, { worktree, main }, flags, profile) {
  dockerUp();
  gc({ quiet: true });
  let slot = ownSlots().find((s) => s.app === app.name && s.worktree === worktree);
  if (!slot) {
    const leave = flags.force ? () => {} : await admit(app, worktree, flags);
    ensureImage(app, worktree, flags.rebuild, profile);
    if (app.certDir && !existsSync(join(worktree, app.certDir)) && existsSync(join(main, app.certDir))) {
      cpSync(join(main, app.certDir), join(worktree, app.certDir), { recursive: true });
      log(`copied ${app.certDir}/ from the main checkout (keychain-trusted dev cert)`);
    }
    const taken = new Set(slots().map((s) => s.port));
    let port;
    for (;;) {
      port = pickPort(taken, app.portRange);
      if (port == null) die(EXIT.prereq, `no free port in ${app.portRange.join('-')}`);
      if (!tryRun('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])) break;
      taken.add(port);
    }
    const slug = slugFor(worktree, main);
    const container = `slot-${app.name}-${slug}`;
    tryRun('docker', ['rm', '-f', container]);
    const { args, env } = applyProfile(profile);
    if (profile) log(`env profile ${profile.name} (${profile.file})`);
    tryRun('docker', ['volume', 'create', '--label', `${LABEL}.worktree=${worktree}`, '--label', `${LABEL}.state=${STATE}`, `${container}-node-modules`]);
    log(`starting ${container} on 127.0.0.1:${port}`);
    run('docker', ['run', '-d', '--name', container, '--add-host=host.docker.internal:host-gateway',
      '-p', `127.0.0.1:${port}:${app.containerPort}`, '-v', `${worktree}:/app`, '-v', `${container}-node-modules:/app/node_modules`,
      '-w', '/app', ...args, '-l', `${LABEL}=1`, '-l', `${LABEL}.app=${app.name}`, '-l', `${LABEL}.worktree=${worktree}`, '-l', `${LABEL}.slug=${slug}`,
      '-l', `${LABEL}.state=${STATE}`, app.image, ...(app.command ? ['sh', '-c', app.command] : [])], { env });
    leave();
    slot = { container, app: app.name, worktree, slug, status: 'running', port };
  }
  touch(slot.container);
  if (!flags['no-wait']) await waitReady(app, slot, Number(flags.timeout ?? 900));
  touch(slot.container);
  console.log(JSON.stringify(describe(app, slot)));
}

function mine(app, worktree) {
  return ownSlots().find((s) => s.app === app.name && s.worktree === worktree);
}

// Without Docker, the app's own port is one machine-wide slot. Wait until it is free or already
// served from this worktree, then hold a lock through the startup window so a second agent waits.
async function host(app, { worktree }, flags) {
  const lockDir = join(STATE, `${app.name}-host.lock`), lockFile = join(lockDir, 'owner.json');
  const readLock = () => { try { return JSON.parse(readFileSync(lockFile, 'utf8')); } catch { return null; } };
  if (flags.release) {
    if (readLock()?.worktree === worktree) rmSync(lockDir, { recursive: true, force: true });
    return console.log(JSON.stringify({ status: 'released' }));
  }
  const end = Date.now() + Number(flags.timeout ?? 1800) * 1000;
  let said = '';
  while (Date.now() < end) {
    const owner = listenerCwd(app.containerPort), lock = readLock();
    if (owner === worktree) return console.log(JSON.stringify({ status: 'mine', baseUrl: `${schemeOf(app)}://localhost:${app.containerPort}` }));
    const lockLive = lock && lock.worktree !== worktree && Date.now() - lock.at < 10 * 60 * 1000;
    if (!owner && !lockLive) {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(lockFile, JSON.stringify({ worktree, at: Date.now() }));
      return console.log(JSON.stringify({ status: 'free', baseUrl: `${schemeOf(app)}://localhost:${app.containerPort}`, next: `start the dev server from ${worktree}, then: slot.mjs check` }));
    }
    const msg = `:${app.containerPort} held by ${owner ?? `${lock.worktree} (starting)`}; waiting`;
    if (msg !== said) log((said = msg));
    await sleep(10000);
  }
  die(EXIT.timeout, `:${app.containerPort} still held after ${flags.timeout ?? 1800}s`);
}

function checkOwner(app, { worktree }, flags) {
  const slot = mine(app, worktree);
  const url = new URL(flags.url ?? (slot ? `${schemeOf(app)}://localhost:${slot.port}` : `${schemeOf(app)}://localhost:${app.containerPort}`));
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : 443));
  const bySlot = slots().find((s) => s.port === port && s.status === 'running');
  const owner = bySlot ? bySlot.worktree : listenerCwd(port);
  if (!owner) die(EXIT.none, `nothing is listening on :${port}`);
  if (owner !== worktree) die(EXIT.mismatch, `:${port} is served by ${owner}, not ${worktree}; do not validate against it`);
  if (bySlot?.state === STATE) touch(bySlot.container);
  console.log(JSON.stringify({ ok: true, port, worktree }));
}

// Project name, state root and env-profile name from toolkit-context (the one place that reads config).
export function projectContext(dir) {
  const resolver = join(SKILLS_DIR, 'toolkit-context/scripts/resolve.mjs');
  if (!existsSync(resolver)) die(EXIT.usage, `toolkit-context is not installed beside this skill (${resolver}); install the core bundle`);
  const r = spawnSync(process.execPath, [resolver, '--cwd', dir], { encoding: 'utf8' });
  if (r.status !== 0) die(EXIT.usage, `toolkit-context failed: ${r.stderr.trim() || r.stdout.trim()}`);
  const ctx = JSON.parse(r.stdout);
  return { name: ctx.project.name, stateRoot: ctx.stateRoot, envProfile: ctx.adapters?.envProfile };
}

async function main() {
  const { cmd, app: appArg, flags } = parseArgs(process.argv.slice(2));
  const cmds = ['up', 'url', 'env', 'list', 'down', 'gc', 'check', 'host'];
  if (!cmds.includes(cmd)) die(EXIT.usage, `usage: slot.mjs <${cmds.join('|')}> [app] [--worktree DIR]`);
  const wt = resolveWorktree(flags.worktree ?? process.cwd());
  const ctx = projectContext(wt.worktree);
  initState(process.env.DEV_SLOT_STATE ?? join(dirname(ctx.stateRoot), 'dev-slots'));
  if (cmd === 'list') {
    dockerUp();
    for (const s of ownSlots()) {
      let app = { name: s.app, healthPath: '/' };
      try { app = loadApp(s.app, s.worktree); } catch {}
      console.log(JSON.stringify({ ...describe(app, s), lastUsed: new Date(lastUsed(s)).toISOString() }));
    }
    return;
  }
  if (cmd === 'gc') {
    dockerUp();
    for (const r of gc({ dryRun: flags['dry-run'] })) console.log(JSON.stringify(r));
    return;
  }
  let app, profile;
  try {
    app = loadApp(appArg ?? ctx.name ?? basename(wt.main), wt.worktree);
    if (cmd === 'up' && ctx.envProfile) profile = loadProfile(ctx.envProfile, wt.worktree);
  } catch (e) { die(EXIT.usage, e.message); }
  if (cmd === 'up') return up(app, wt, flags, profile);
  if (cmd === 'host') return host(app, wt, flags);
  if (cmd === 'check') return checkOwner(app, wt, flags);
  dockerUp();
  if (cmd === 'down') {
    for (const s of ownSlots().filter((s) => s.app === app.name && (flags.all || s.worktree === wt.worktree))) {
      remove(s, flags.purge);
      log(`removed ${s.container}${flags.purge ? ' and its node_modules volume' : ''}`);
    }
    return;
  }
  const slot = mine(app, wt.worktree);
  if (!slot || slot.status !== 'running') die(EXIT.none, `no running slot for ${wt.worktree}; run: slot.mjs up`);
  touch(slot.container);
  const d = describe(app, slot);
  if (cmd === 'url') console.log(d.baseUrl);
  else console.log(envLine(app, d));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
