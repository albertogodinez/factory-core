import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, scheduleDefinitions, setupCleanupSchedule } from '../bin/cleanup.mjs';
import { beginRun, addArtifact, finishRun, configure } from '../bundles/core/factory-teardown/scripts/lifecycle.mjs';
import { tempRoot, makeRepo, git, write } from './fixtures/make.mjs';

function fixture() {
  const t = tempRoot('factory-cleanup-'), home = join(t.root, 'home'), repo = makeRepo(join(t.root, 'repo'));
  const wt = join(t.root, 'worktree'); git(repo, 'worktree', 'add', '-q', wt, '-b', 'feature');
  write(join(home, 'installs.json'), { version: 1, repos: { [repo]: { mode: 'local' } } });
  const state = join(repo, 'state');
  write(join(repo, '.agents/skills/factory-context/scripts/resolve.mjs'), `console.log(JSON.stringify({stateRoot:${JSON.stringify(state)}}));`);
  write(join(repo, '.agents/skills/factory-teardown/scripts/lifecycle.mjs'), `
    const apply=process.argv.includes('--apply');
    console.log(JSON.stringify({runs:[{id:'one',actions:[{type:'artifact',path:'owned',status:apply?'removed':'candidate'},{type:'artifact',path:'proof',status:'kept'}]}],errors:[]}));
  `);
  return { ...t, home, repo, wt, state };
}

test('coordinator visits worktrees and deduplicates shared state; default preview writes nothing', async () => {
  const f = fixture(); try {
    const r = await cleanup({ all: true }, { home: f.home });
    assert.equal(r.mode, 'preview'); assert.equal(r.summary.candidates, 1); assert.equal(r.summary.removed, 0);
    assert.equal(r.summary.skipped, 1); assert.equal(r.summary.kept, 1); assert.equal(r.summary.failed, 0);
    assert.equal(r.targets.length, 2); assert.ok(!existsSync(join(f.home, 'cleanup-last.json')));
    assert.ok(!existsSync(join(f.home, 'cleanup.lock')));
  } finally { f.cleanup(); }
});

test('scheduled policy can apply, while explicit dry-run overrides it and persists accurate results', async () => {
  const f = fixture(); try {
    write(join(f.home, 'cleanup-schedule.json'), { version: 1, apply: true });
    const preview = await cleanup({ all: true, scheduled: true, dryRun: true }, { home: f.home });
    assert.equal(preview.summary.candidates, 1); assert.equal(preview.summary.removed, 0);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'cleanup-last.json'))).mode, 'preview');
    const applied = await cleanup({ all: true, scheduled: true }, { home: f.home });
    assert.equal(applied.summary.removed, 1); assert.equal(applied.summary.candidates, 0);
    assert.ok(!existsSync(join(f.home, 'cleanup.lock')));
  } finally { f.cleanup(); }
});

test('missing engines are upgrade skips, malformed engine output and failed removals remain failures', async () => {
  const f = fixture(); try {
    const engine = join(f.repo, '.agents/skills/factory-teardown/scripts/lifecycle.mjs');
    writeFileSync(engine, 'console.log("not json")');
    let r = await cleanup({ to: f.repo, apply: true }, { home: f.home }); assert.ok(r.summary.failed > 0);
    writeFileSync(engine, `console.log(JSON.stringify({runs:[{id:'one',actions:[{status:'failed',reason:'denied'}]}],errors:[]}));`);
    r = await cleanup({ to: f.repo }, { home: f.home }); assert.equal(r.summary.failed, 1); assert.equal(r.summary.removed, 0);
    write(join(f.home, 'installs.json'), { repos: { [makeRepo(join(f.root, 'old'))]: {} } });
    r = await cleanup({ all: true }, { home: f.home }); assert.equal(r.summary.skipped, 1); assert.match(r.targets[0].reason, /upgrade/);
  } finally { f.cleanup(); }
});

test('pre-existing coordinator lock prevents concurrent mutation and is retained', async () => {
  const f = fixture(); try {
    mkdirSync(join(f.home, 'cleanup.lock')); write(join(f.home, 'cleanup.lock/owner.json'), { pid: process.pid });
    await assert.rejects(cleanup({ all: true, apply: true }, { home: f.home }), /locked/);
    assert.ok(existsSync(join(f.home, 'cleanup.lock')));
  } finally { f.cleanup(); }
});

test('schedule definitions use one daily report-only job and escape machine paths', () => {
  const common = { userHome: '/test/user home', factoryHome: '/test/factory home', node: '/test/node binary', cli: '/test/factory source/bin/factory.mjs', uid: 42 };
  const mac = scheduleDefinitions({ ...common, platform: 'darwin' });
  assert.equal(mac.files.length, 1); assert.match(mac.files[0].contents, /StartInterval/); assert.match(mac.files[0].contents, /--scheduled/);
  assert.ok(!mac.files[0].contents.includes('--apply'));
  const linux = scheduleDefinitions({ ...common, platform: 'linux' });
  assert.equal(linux.files.length, 2); assert.match(linux.files[0].contents, /Persistent=true/);
  assert.ok(linux.files.some(f => f.contents.includes('"/test/node binary"')));
  const win = scheduleDefinitions({ ...common, platform: 'win32' });
  assert.ok(win.commands.some(c => c.bin === 'schtasks'));
});

test('schedule dry-run creates nothing and returns proposed paths', async () => {
  const t = tempRoot(); try {
    const r = await setupCleanupSchedule({ dryRun: true }, { home: join(t.root, 'factory'), userHome: join(t.root, 'user'), platform: 'darwin' });
    assert.equal(r.apply, false); assert.ok(r.files.length > 0); assert.ok(!existsSync(join(t.root, 'factory'))); assert.ok(!existsSync(join(t.root, 'user')));
  } finally { t.cleanup(); }
});

// Exercises the actual installed deletion boundary, rather than trusting a stub's count.
test('coordinator invokes installed engine and preserves evidence while reclaiming eligible scratch', async () => {
  const f = fixture(); try {
    cpSync(new URL('../bundles/core/factory-teardown/scripts/lifecycle.mjs', import.meta.url), join(f.repo, '.agents/skills/factory-teardown/scripts/lifecycle.mjs'));
    const opts = { stateRoot: f.state, root: f.repo, kind: 'test' };
    const run = await beginRun(opts), raw = join(run.dir, 'raw'), proof = join(run.dir, 'proof.png');
    writeFileSync(raw, 'raw'); writeFileSync(proof, 'proof');
    await addArtifact({ ...opts, run: run.id, path: raw, class: 'intermediate' });
    await addArtifact({ ...opts, run: run.id, path: proof, class: 'evidence' });
    await finishRun({ ...opts, run: run.id, status: 'complete' });
    await configure({ ...opts, intermediateHours: 1 });
    const manifest = JSON.parse(readFileSync(run.manifest)); manifest.finishedAt = Date.now() - 7200000;
    writeFileSync(run.manifest, JSON.stringify(manifest));
    const result = await cleanup({ all: true, apply: true }, { home: f.home });
    assert.equal(result.summary.removed, 1); assert.equal(result.summary.failed, 0);
    assert.ok(!existsSync(raw)); assert.ok(existsSync(proof));
  } finally { f.cleanup(); }
});

test('scheduler setup retries activation after a failed first bootstrap', { skip: process.platform === 'win32' }, async () => {
  const t = tempRoot(), oldPath = process.env.PATH, oldLog = process.env.FACTORY_TEST_SCHEDULE_LOG;
  try {
    const bin = join(t.root, 'bin'), log = join(t.root, 'scheduler.log'); mkdirSync(bin);
    const stub = join(bin, 'launchctl');
    writeFileSync(stub, '#!/bin/sh\necho "$1" >> "$FACTORY_TEST_SCHEDULE_LOG"\nif [ "$1" = bootstrap ] && [ ! -f "$FACTORY_TEST_SCHEDULE_LOG.failed" ]; then touch "$FACTORY_TEST_SCHEDULE_LOG.failed"; exit 1; fi\nexit 0\n'); chmodSync(stub, 0o700);
    process.env.PATH = bin + ':' + oldPath; process.env.FACTORY_TEST_SCHEDULE_LOG = log;
    const runtime = { home: join(t.root, 'factory'), userHome: join(t.root, 'user'), platform: 'darwin' };
    await assert.rejects(setupCleanupSchedule({}, runtime), /activation failed/);
    await setupCleanupSchedule({}, runtime);
    assert.equal(readFileSync(log, 'utf8').split('\n').filter(x => x === 'bootstrap').length, 2);
  } finally { process.env.PATH = oldPath; if (oldLog === undefined) delete process.env.FACTORY_TEST_SCHEDULE_LOG; else process.env.FACTORY_TEST_SCHEDULE_LOG = oldLog; t.cleanup(); }
});


test('scheduled startup failures persist a blocked report without removing an existing coordinator lock', async () => {
  const f = fixture(); try {
    const lock = join(f.home, 'cleanup.lock'); mkdirSync(lock);
    write(join(lock, 'owner.json'), { pid: process.pid });
    const blocked = await cleanup({ all: true, scheduled: true }, { home: f.home });
    assert.equal(blocked.mode, 'blocked'); assert.equal(blocked.summary.failed, 1);
    assert.match(blocked.errors[0], /locked/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'cleanup-last.json'))), blocked);
    assert.ok(existsSync(join(lock, 'owner.json')), 'another coordinator lock stays intact');
    rmSync(lock, { recursive: true });
    writeFileSync(join(f.home, 'cleanup-schedule.json'), '{invalid');
    const malformed = await cleanup({ all: true, scheduled: true }, { home: f.home });
    assert.equal(malformed.mode, 'blocked'); assert.equal(malformed.summary.failed, 1);
    assert.match(malformed.errors[0], /cleanup-schedule.json/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'cleanup-last.json'))), malformed);
    assert.ok(!existsSync(lock), 'malformed policy creates no coordinator lock');
  } finally { f.cleanup(); }
});

test('deleted but unpruned worktrees are skipped without a failed cleanup', async () => {
  const f = fixture(); try {
    rmSync(f.wt, { recursive: true });
    const listed = git(f.repo, 'worktree', 'list', '--porcelain');
    assert.ok(listed.includes(f.wt)); assert.match(listed, /prunable/);
    const result = await cleanup({ all: true }, { home: f.home });
    assert.equal(result.summary.failed, 0); assert.equal(result.summary.candidates, 1);
    const stale = result.targets.find(t => t.worktree === f.wt);
    assert.equal(stale.status, 'skipped'); assert.match(stale.reason, /prunable|missing/);
  } finally { f.cleanup(); }
});

async function withWindowsTask(mode, check) {
  const t = tempRoot(), envKeys = ['PATH', 'FACTORY_TEST_TASK_LOG', 'FACTORY_TEST_TASK_XML', 'FACTORY_TEST_TASK_MODE'];
  const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  try {
    const bin = join(t.root, 'bin'), home = join(t.root, 'factory & home'), log = join(t.root, 'task.log'), xmlPath = join(t.root, 'task.xml');
    mkdirSync(bin); mkdirSync(home);
    const stub = join(bin, 'schtasks');
    writeFileSync(stub, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.FACTORY_TEST_TASK_LOG, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === '/Query') {
  if (process.env.FACTORY_TEST_TASK_MODE === 'missing') { console.error('ERROR: The system cannot find the file specified.'); process.exit(1); }
  if (process.env.FACTORY_TEST_TASK_MODE === 'denied') { console.error('ERROR: Access is denied.'); process.exit(1); }
  const output = fs.readFileSync(process.env.FACTORY_TEST_TASK_XML);
  process.stdout.write(process.env.FACTORY_TEST_TASK_MODE === 'owned-utf16' ? Buffer.concat([Buffer.from([255,254]), Buffer.from(output.toString(), 'utf16le')]) : output);
}
`); chmodSync(stub, 0o700);
    const wrapper = join(home, 'cleanup-scheduled.cmd');
    const oldContents = '@echo off\r\nrem factory cleanup schedule\r\nrem old CLI location\r\n';
    if (mode !== 'missing') writeFileSync(wrapper, oldContents);
    const encode = s => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const target = mode === 'unrelated' ? join(t.root, 'unrelated.cmd') : wrapper;
    writeFileSync(xmlPath, `<Task><Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>${encode(`/d /c ""${target}""`)}</Arguments></Exec></Actions></Task>`);
    process.env.PATH = bin + ':' + saved.PATH;
    process.env.FACTORY_TEST_TASK_LOG = log; process.env.FACTORY_TEST_TASK_XML = xmlPath; process.env.FACTORY_TEST_TASK_MODE = mode;
    await check({ home, wrapper, oldContents, log, runtime: { home, userHome: join(t.root, 'user'), platform: 'win32' } });
  } finally {
    for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    t.cleanup();
  }
}

test('Windows setup reuses an owned existing task while updating its managed wrapper', { skip: process.platform === 'win32' }, async () => {
  for (const mode of ['owned', 'owned-utf16']) await withWindowsTask(mode, async ({ runtime, wrapper, oldContents, log, home }) => {
    await setupCleanupSchedule({}, runtime);
    assert.notEqual(readFileSync(wrapper, 'utf8'), oldContents);
    assert.match(readFileSync(wrapper, 'utf8'), /cleanup --all --scheduled/);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['/Query /TN FactoryCleanup /XML']);
    assert.equal(JSON.parse(readFileSync(join(home, 'cleanup-schedule.json'))).activated, true);
  });
});

test('Windows setup refuses an unrelated existing task before changing managed files', { skip: process.platform === 'win32' }, async () => {
  await withWindowsTask('unrelated', async ({ runtime, wrapper, oldContents, log, home }) => {
    await assert.rejects(setupCleanupSchedule({}, runtime), /not provably owned|unrelated/);
    assert.equal(readFileSync(wrapper, 'utf8'), oldContents);
    assert.ok(!existsSync(join(home, 'cleanup-schedule.json')));
    assert.ok(!readFileSync(log, 'utf8').includes('/Create'));
  });
});

test('Windows setup creates a missing task but refuses an uninspectable task', { skip: process.platform === 'win32' }, async () => {
  await withWindowsTask('missing', async ({ runtime, log, wrapper }) => {
    await setupCleanupSchedule({}, runtime);
    assert.ok(existsSync(wrapper));
    assert.match(readFileSync(log, 'utf8'), /\/Query.*\n\/Create/);
    assert.ok(!readFileSync(log, 'utf8').includes('/F '));
  });
  await withWindowsTask('denied', async ({ runtime, wrapper, oldContents, home }) => {
    await assert.rejects(setupCleanupSchedule({}, runtime), /cannot inspect|cannot verify/);
    assert.equal(readFileSync(wrapper, 'utf8'), oldContents);
    assert.ok(!existsSync(join(home, 'cleanup-schedule.json')));
  });
});
