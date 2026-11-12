// Machine coordinator; deletion stays in each repo's installed teardown engine.
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, renameSync, rmSync, lstatSync, cpSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const FACTORY = join(dirname(fileURLToPath(import.meta.url)), 'factory.mjs');
const defaultHome = () => process.env.FACTORY_HOME || join(homedir(), '.agents', 'factory');
function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`${path}: ${e.message}`); }
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, value, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
function canonical(path) {
  try { return realpathSync(path); }
  catch (e) { if (e.code !== 'ENOENT') throw e; const parent = dirname(path); if (parent === path) throw e; return join(canonical(parent), basename(path)); }
}
function child(bin, args, cwd, home) {
  const env = { ...process.env, FACTORY_HOME: home };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'FACTORY_CONFIG']) delete env[key];
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(r.error?.message || r.stderr?.trim() || `${bin} exited ${r.status}`);
  return r.stdout;
}
function engineResult(raw) {
  const result = JSON.parse(raw);
  if (!result || !Array.isArray(result.runs) || !Array.isArray(result.errors)) throw new Error('teardown engine returned an invalid result');
  const statuses = ['candidate', 'removed', 'failed', 'kept', 'absent'];
  for (const run of result.runs) {
    if (!run || typeof run !== 'object' || !Array.isArray(run.actions)) throw new Error('teardown engine returned an invalid run');
    for (const action of run.actions) if (!statuses.includes(action?.status)) throw new Error('teardown engine returned an invalid action status');
  }
  return result;
}
function summarize(targets, errors) {
  const summary = { candidates: 0, removed: 0, failed: errors.length, kept: 0, absent: 0, skipped: 0, attention: 0, runs: 0 };
  const keys = { candidate: 'candidates', removed: 'removed', failed: 'failed', kept: 'kept', absent: 'absent' };
  for (const target of targets) {
    if (target.status === 'skipped') { summary.skipped++; continue; }
    if (target.status === 'failed') { summary.failed++; continue; }
    summary.failed += target.result.errors.length;
    for (const run of target.result.runs) {
      summary.runs++;
      if (run.error) summary.failed++;
      if (['inactive run needs inspection', 'abandoned run needs inspection'].includes(run.reason)) summary.attention++;
      for (const action of run.actions) summary[keys[action.status]]++;
    }
  }
  return summary;
}

export async function cleanup(opts = {}, runtime = {}) {
  try { return await performCleanup(opts, runtime); }
  catch (e) {
    if (!opts.scheduled) throw e;
    const errors = [e.message];
    const report = { version: 1, at: new Date().toISOString(), mode: 'blocked', targets: [], errors, summary: summarize([], errors) };
    atomic(join(resolve(runtime.home || defaultHome()), 'cleanup-last.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  }
}

async function performCleanup(opts, runtime) {
  const home = resolve(runtime.home || defaultHome());
  if (opts.apply && opts.dryRun) throw new Error('--apply and --dry-run are exclusive');
  const scheduledPolicy = opts.scheduled ? readJson(join(home, 'cleanup-schedule.json'), { apply: false }) : null;
  const apply = !opts.dryRun && (opts.apply === true || scheduledPolicy?.apply === true);
  const locked = apply || opts.scheduled;
  const lock = join(home, 'cleanup.lock');
  if (locked) {
    mkdirSync(home, { recursive: true });
    try { mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error(`cleanup coordinator locked: ${lock}; inspect its owner before removing a stale lock`); throw e; }
    try { atomic(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n'); }
    catch (e) { rmSync(lock, { recursive: true, force: true }); throw e; }
  }
  try {
    const targets = [], errors = [], seen = new Set();
    let roots;
    try {
      if (opts.all) {
        const registry = readJson(join(home, 'installs.json'), { repos: {} });
        if (!registry.repos || typeof registry.repos !== 'object' || Array.isArray(registry.repos)) throw new Error('invalid install registry');
        roots = Object.keys(registry.repos);
      } else roots = [resolve(opts.to || process.cwd())];
    } catch (e) { roots = []; errors.push(e.message); }
    const mains = new Set();
    for (const root of roots) {
      let main, worktrees;
      try {
        const common = child('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], root, home).trim();
        main = canonical(dirname(common));
        if (mains.has(main)) continue; mains.add(main);
        worktrees = child('git', ['worktree', 'list', '--porcelain', '-z'], main, home).split('\0\0').filter(Boolean).map(record => {
          const fields = record.split('\0');
          return { path: fields.find(field => field.startsWith('worktree '))?.slice(9), prunable: fields.some(field => field === 'prunable' || field.startsWith('prunable ')) };
        });
      } catch (e) { targets.push({ repo: root, status: 'failed', reason: e.message }); continue; }
      const engine = join(main, '.agents', 'skills', 'factory-teardown', 'scripts', 'lifecycle.mjs');
      const resolver = join(main, '.agents', 'skills', 'factory-context', 'scripts', 'resolve.mjs');
      if (!existsSync(engine) || !existsSync(resolver)) {
        targets.push({ repo: main, status: 'skipped', reason: 'upgrade required: factory-teardown or factory-context is not installed' }); continue;
      }
      for (const entry of worktrees) {
        const worktree = entry.path;
        const target = { repo: main, worktree };
        if (!worktree || entry.prunable || !existsSync(worktree)) {
          targets.push({ ...target, status: 'skipped', reason: entry.prunable ? 'prunable worktree; no live path to clean' : 'worktree path is missing' });
          continue;
        }
        try {
          const ctx = JSON.parse(child(process.execPath, [resolver, '--no-cache'], worktree, home));
          if (typeof ctx?.stateRoot !== 'string' || !ctx.stateRoot || !isAbsolute(ctx.stateRoot)) throw new Error('resolver did not return an absolute stateRoot');
          const stateRoot = canonical(ctx.stateRoot); target.stateRoot = stateRoot;
          if (seen.has(stateRoot)) { targets.push({ ...target, status: 'skipped', reason: 'shared state root already visited' }); continue; }
          seen.add(stateRoot);
          const result = engineResult(child(process.execPath, [engine, 'gc', '--state-root', stateRoot, '--cwd', worktree, ...(apply ? ['--apply'] : [])], worktree, home));
          targets.push({ ...target, status: 'checked', result });
        } catch (e) { targets.push({ ...target, status: 'failed', reason: e.message }); }
      }
    }
    const report = { version: 1, at: new Date().toISOString(), mode: apply ? 'apply' : 'preview', targets, errors, summary: summarize(targets, errors) };
    if (opts.scheduled) atomic(join(home, 'cleanup-last.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally { if (locked) rmSync(lock, { recursive: true, force: true }); }
}

const MARKER = 'factory cleanup schedule';
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const systemdQuote = (text, expandDollars = true) => '"' + String(text).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', expandDollars ? '$$' : '$') + '"';
// The scheduled jobs factory installs. Each is one user-level launchd agent, systemd timer or Task
// Scheduler task that runs `factory <args>`; its marker proves a file is ours before it's replaced.
export const JOBS = {
  cleanup: { marker: MARKER, label: 'local.factory.cleanup', unit: 'factory-cleanup', task: 'FactoryCleanup', log: 'cleanup-scheduler',
    wrapper: 'cleanup-scheduled.cmd', description: 'Factory cleanup inventory', args: ['cleanup', '--all', '--scheduled'], seconds: 86400, calendar: 'daily', windows: ['/SC', 'DAILY', '/ST', '10:00'] },
  triage: { marker: 'factory triage schedule', label: 'local.factory.triage', unit: 'factory-triage', task: 'FactoryTriage', log: 'triage-scheduler',
    wrapper: 'triage-scheduled.cmd', description: 'Factory lesson triage when due', args: ['triage', '--due', '--scheduled'], seconds: 14400, calendar: '*-*-* 00/4:00:00', windows: ['/SC', 'HOURLY', '/MO', '4'] },
};
export function scheduleDefinitions({ platform = process.platform, userHome = homedir(), factoryHome = defaultHome(), node = process.execPath, cli = FACTORY, uid = userInfo().uid, job = JOBS.cleanup } = {}) {
  for (const value of [userHome, factoryHome, node, cli]) if (/[\r\n\0]/.test(value)) throw new Error('scheduler paths must not contain control characters');
  const argv = [node, cli, ...job.args];
  if (platform === 'darwin') {
    const path = join(userHome, 'Library', 'LaunchAgents', `${job.label}.plist`);
    const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${job.marker} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${job.label}</string>\n<key>ProgramArguments</key><array>${argv.map(a => `<string>${xml(a)}</string>`).join('')}</array>\n<key>EnvironmentVariables</key><dict><key>FACTORY_HOME</key><string>${xml(factoryHome)}</string></dict>\n<key>StartInterval</key><integer>${job.seconds}</integer>\n<key>RunAtLoad</key><true/>\n<key>StandardOutPath</key><string>${xml(join(factoryHome, `${job.log}.log`))}</string>\n<key>StandardErrorPath</key><string>${xml(join(factoryHome, `${job.log}-error.log`))}</string>\n</dict></plist>\n`;
    return { files: [{ path, contents }], commands: [{ bin: 'launchctl', args: ['bootout', `gui/${uid}`, path], allowFailure: true }, { bin: 'launchctl', args: ['bootstrap', `gui/${uid}`, path] }] };
  }
  if (platform === 'linux') {
    const dir = join(userHome, '.config', 'systemd', 'user');
    const timer = { path: join(dir, `${job.unit}.timer`), contents: `# ${job.marker}\n[Unit]\nDescription=${job.description}\n[Timer]\nOnCalendar=${job.calendar}\nPersistent=true\n[Install]\nWantedBy=timers.target\n` };
    const service = { path: join(dir, `${job.unit}.service`), contents: `# ${job.marker}\n[Unit]\nDescription=${job.description}\n[Service]\nType=oneshot\nEnvironment=${systemdQuote(`FACTORY_HOME=${factoryHome}`, false)}\nExecStart=${argv.map(a => systemdQuote(a)).join(' ')}\n` };
    return { files: [timer, service], commands: [{ bin: 'systemctl', args: ['--user', 'daemon-reload'] }, { bin: 'systemctl', args: ['--user', 'enable', '--now', `${job.unit}.timer`] }] };
  }
  if (platform === 'win32') {
    const path = join(factoryHome, job.wrapper);
    for (const value of [factoryHome, node, cli]) if (value.includes('"')) throw new Error('Windows scheduler paths cannot contain quotes');
    const cmd = value => value.replaceAll('%', '%%');
    const contents = `@echo off\r\nrem ${job.marker}\r\nset "FACTORY_HOME=${cmd(factoryHome)}"\r\n"${cmd(node)}" "${cmd(cli)}" ${job.args.join(' ')}\r\n`;
    return { files: [{ path, contents }], commands: [{ bin: 'schtasks', args: ['/Create', ...job.windows, '/TN', job.task, '/TR', `cmd.exe /d /c ""${path}""`] }] };
  }
  throw new Error(`${job === JOBS.cleanup ? 'cleanup' : job.unit} scheduling is not supported on ${platform}`);
}

export function existingWindowsTask(wrapper, managedWrapper, task = 'FactoryCleanup') {
  const result = spawnSync('schtasks', ['/Query', '/TN', task, '/XML'], { timeout: 15000, windowsHide: true });
  if (result.status !== 0) {
    const message = result.error?.message || result.stderr?.toString().trim() || result.stdout?.toString().trim() || `exit ${result.status}`;
    if (!result.error && /cannot find (?:the file|the specified task)|does not exist|not found/i.test(message)) return false;
    throw new Error(`cannot inspect existing ${task} task: ${message.trim()}`);
  }
  const output = result.stdout;
  const text = output[0] === 0xff && output[1] === 0xfe ? output.subarray(2).toString('utf16le') : output.toString('utf8');
  const taskXml = text.replace(/<!--[\s\S]*?-->/g, '');
  const actions = [...taskXml.matchAll(/<Actions(?:\s[^>]*)?>([\s\S]*?)<\/Actions>/g)];
  const action = actions.length === 1 && actions[0][1].match(/^\s*<Exec(?:\s[^>]*)?>\s*<Command>([^<]*)<\/Command>\s*<Arguments>([^<]*)<\/Arguments>\s*<\/Exec>\s*$/);
  const decode = text => text.replace(/&(?:quot|apos|lt|gt|amp);/g, entity => ({ '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' })[entity]);
  if (!managedWrapper || !action || decode(action[1]) !== 'cmd.exe' || decode(action[2]) !== `/d /c ""${wrapper}""`) {
    throw new Error(`existing ${task} task is not provably owned; scheduler files left unchanged`);
  }
  return true;
}

export async function setupCleanupSchedule(opts = {}, runtime = {}) {
  if (opts.apply && opts.dryRun) throw new Error('--apply and --dry-run are exclusive');
  const home = resolve(runtime.home || defaultHome());
  const existing = readJson(join(home, 'cleanup-schedule.json'), { version: 1, apply: false });
  const apply = opts.apply === true || existing.apply === true;
  const definition = scheduleDefinitions({ platform: runtime.platform, userHome: runtime.userHome, factoryHome: home });
  const result = { version: 1, apply, dryRun: !!opts.dryRun, files: definition.files.map(f => f.path), commands: definition.commands };
  if (opts.dryRun) return result;
  if (existsSync(join(home, 'cleanup.lock'))) throw new Error('cleanup is running or has an unresolved lock; schedule left unchanged');
  for (const f of definition.files) {
    if (!existsSync(f.path)) continue;
    if (lstatSync(f.path).isSymbolicLink() || !readFileSync(f.path, 'utf8').includes(MARKER)) throw new Error(`unmanaged scheduler file left unchanged: ${f.path}`);
  }
  const previouslyInstalled = definition.files.every(f => existsSync(f.path));
  const reuseTask = (runtime.platform || process.platform) === 'win32' && existingWindowsTask(definition.files[0].path, previouslyInstalled);
  let changed = false;
  for (const f of definition.files) {
    if (existsSync(f.path) && readFileSync(f.path, 'utf8') === f.contents) continue;
    if (existsSync(f.path)) cpSync(f.path, `${f.path}.bak-${Date.now()}`);
    atomic(f.path, f.contents); changed = true;
  }
  atomic(join(home, 'cleanup-schedule.json'), JSON.stringify({ version: 1, apply, activated: false }, null, 2) + '\n');
  if (!reuseTask && (changed || !existing.activated)) for (const command of definition.commands) {
    if (command.allowFailure && !previouslyInstalled) continue;
    const r = spawnSync(command.bin, command.args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.status !== 0 && !command.allowFailure) throw new Error(`${command.bin}: ${r.error?.message || r.stderr?.trim() || `exit ${r.status}`}; scheduler files were saved but activation failed`);
  }
  atomic(join(home, 'cleanup-schedule.json'), JSON.stringify({ version: 1, apply, activated: true }, null, 2) + '\n');
  return { ...result, changed, commands: reuseTask ? [] : result.commands };
}

// Install or refresh a scheduled job other than cleanup (cleanup keeps its own apply/lock state).
// Same ownership rules: a file without the job's marker, or a symlink, is never replaced; a changed
// file is backed up first; activation runs only when something changed or it never activated.
export function installSchedule(job, opts = {}, runtime = {}) {
  const home = resolve(runtime.home || defaultHome());
  const definition = scheduleDefinitions({ platform: runtime.platform, userHome: runtime.userHome, factoryHome: home, job });
  const stateFile = join(home, `${job.unit.replace(/^factory-/, '')}-schedule.json`);
  const result = { dryRun: !!opts.dryRun, files: definition.files.map(f => f.path), commands: definition.commands };
  if (opts.dryRun) return result;
  for (const f of definition.files) {
    if (!existsSync(f.path)) continue;
    if (lstatSync(f.path).isSymbolicLink() || !readFileSync(f.path, 'utf8').includes(job.marker)) throw new Error(`unmanaged scheduler file left unchanged: ${f.path}`);
  }
  const previouslyInstalled = definition.files.every(f => existsSync(f.path));
  const reuseTask = (runtime.platform || process.platform) === 'win32' && existingWindowsTask(definition.files[0].path, previouslyInstalled, job.task);
  const existing = readJson(stateFile, {});
  let changed = false;
  for (const f of definition.files) {
    if (existsSync(f.path) && readFileSync(f.path, 'utf8') === f.contents) continue;
    if (existsSync(f.path)) cpSync(f.path, `${f.path}.bak-${Date.now()}`);
    atomic(f.path, f.contents); changed = true;
  }
  if (!reuseTask && (changed || !existing.activated) && !runtime.skipActivation) for (const command of definition.commands) {
    if (command.allowFailure && !previouslyInstalled) continue;
    const r = spawnSync(command.bin, command.args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.status !== 0 && !command.allowFailure) throw new Error(`${command.bin}: ${r.error?.message || r.stderr?.trim() || `exit ${r.status}`}; scheduler files were saved but activation failed`);
  }
  atomic(stateFile, JSON.stringify({ version: 1, activated: !runtime.skipActivation }, null, 2) + '\n');
  return { ...result, changed, commands: reuseTask ? [] : result.commands };
}
