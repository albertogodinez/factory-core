import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { beginRun, addArtifact, finishRun, pinRun, teardown, gc, configure, createScratch, publishArtifact, registerResource, processIdentity, launchProcess, stopResources, releaseInputs } from './lifecycle.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-lifecycle-test-'));
  return { root, stateRoot: join(root, 'state'), dispose: () => rmSync(root, { recursive: true, force: true }) };
};
async function run(f) { return beginRun({ ...f, kind: 'test' }); }
async function file(f, r, name, kind) {
  const p = join(r.dir, name); writeFileSync(p, name);
  await addArtifact({ ...f, run: r.id, path: p, class: kind }); return p;
}

test('teardown previews and removes only registered intermediates after finish', async () => {
  const f = fixture(); try {
    const r = await run(f), raw = await file(f, r, 'raw.webm', 'intermediate');
    const evidence = await file(f, r, 'final.mp4', 'evidence');
    const durable = await file(f, r, 'handoff.md', 'durable');
    const unknown = join(r.dir, 'unknown.txt'); writeFileSync(unknown, 'keep');
    await assert.rejects(teardown({ ...f, run: r.id, apply: true }), /active/);
    await finishRun({ ...f, run: r.id, status: 'complete' });
    await teardown({ ...f, run: r.id }); assert.ok(existsSync(raw));
    const result = await teardown({ ...f, run: r.id, apply: true });
    assert.ok(result.actions.some(a => a.path === raw && a.status === 'removed'));
    assert.ok(!existsSync(raw)); for (const p of [evidence, durable, unknown]) assert.ok(existsSync(p));
    await teardown({ ...f, run: r.id, apply: true });
  } finally { f.dispose(); }
});

test('rejects path escape and symlink artifacts; pin protects targeted teardown', async () => {
  const f = fixture(); try {
    const r = await run(f); const raw = await file(f, r, 'raw', 'intermediate');
    await assert.rejects(addArtifact({ ...f, run: r.id, path: join(f.root, 'other'), class: 'intermediate' }), /outside/);
    if (process.platform !== 'win32') {
      symlinkSync(f.root, join(r.dir, 'escape'));
      await assert.rejects(addArtifact({ ...f, run: r.id, path: join(r.dir, 'escape', 'file'), class: 'intermediate' }), /symlink/);
    }
    await finishRun({ ...f, run: r.id, status: 'failed' }); await pinRun({ ...f, run: r.id, pinned: true });
    assert.equal((await teardown({ ...f, run: r.id, apply: true })).reason, 'pinned'); assert.ok(existsSync(raw));
  } finally { f.dispose(); }
});

test('scheduled GC requires policy, age and an inactive run; preserves evidence', async () => {
  const f = fixture(); try {
    const r = await run(f), raw = await file(f, r, 'raw', 'intermediate'), ev = await file(f, r, 'proof', 'evidence');
    await configure({ ...f, intermediateHours: 1 });
    await gc({ ...f, apply: true, now: Date.now() + 7200000 }); assert.ok(existsSync(raw), 'live active owner is retained');
    await finishRun({ ...f, run: r.id, status: 'complete' });
    await gc({ ...f, apply: true }); assert.ok(existsSync(raw), 'too young');
    await gc({ ...f, apply: true, now: Date.now() + 7200000 }); assert.ok(!existsSync(raw)); assert.ok(existsSync(ev));
  } finally { f.dispose(); }
});

test('owned external scratch is cleaned; substituted owner marker is retained', async () => {
  const f = fixture(); let scratch; try {
    const r = await run(f); scratch = await createScratch({ ...f, run: r.id });
    writeFileSync(join(scratch.dir, 'package.tgz'), 'package');
    await finishRun({ ...f, run: r.id, status: 'failed' });
    await teardown({ ...f, run: r.id, apply: true }); assert.ok(!existsSync(scratch.dir));
    const r2 = await run(f); scratch = await createScratch({ ...f, run: r2.id });
    writeFileSync(join(scratch.dir, '.factory-owner.json'), '{}');
    await finishRun({ ...f, run: r2.id, status: 'complete' });
    const res = await teardown({ ...f, run: r2.id, apply: true });
    assert.ok(existsSync(scratch.dir)); assert.ok(res.actions.some(a => a.status === 'failed'));
  } finally { if (scratch) rmSync(scratch.dir, { recursive: true, force: true }); f.dispose(); }
});

test('published evidence remains unless a retention policy explicitly releases it', async () => {
  const f = fixture(); try {
    const r = await run(f), ev = await file(f, r, 'proof.png', 'evidence');
    await assert.rejects(publishArtifact({ ...f, run: r.id, path: ev, url: 'https://example.com/proof' }), /verified/);
    await publishArtifact({ ...f, run: r.id, path: ev, url: 'https://example.com/proof', verified: true });
    await finishRun({ ...f, run: r.id, status: 'complete' }); await configure({ ...f, intermediateHours: 1 });
    await gc({ ...f, apply: true, now: Date.now() + 7200000 }); assert.ok(existsSync(ev));
  } finally { f.dispose(); }
});

test('preview is read-only for an uninitialized state root', async () => {
  const f = fixture(); try { assert.equal((await gc(f)).runs.length, 0); assert.ok(!existsSync(f.stateRoot)); } finally { f.dispose(); }
});

test('a changed owned process identity fails safely and retains its inputs', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(), child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    if (!processIdentity(child.pid)) { t.skip('process start identity unavailable in this sandbox'); return; }
    const r = await run(f), raw = await file(f, r, 'input', 'intermediate');
    await registerResource({ ...f, run: r.id, type: 'process', pid: child.pid });
    await finishRun({ ...f, run: r.id, status: 'complete' });
    await configure({ ...f, intermediateHours: 1 });
    await gc({ ...f, apply: true, now: Date.now() + 7200000 }); assert.ok(existsSync(raw));
    const manifest = JSON.parse(readFileSync(r.manifest)); manifest.resources[0].started = 'different process'; writeFileSync(r.manifest, JSON.stringify(manifest));
    const res = await teardown({ ...f, run: r.id, apply: true });
    assert.ok(res.actions.some(a => a.status === 'failed')); assert.ok(existsSync(raw)); assert.equal(child.exitCode, null);
    manifest.resources[0].started = (await import('./lifecycle.mjs')).processIdentity(child.pid); writeFileSync(r.manifest, JSON.stringify(manifest));
    const stopped = await teardown({ ...f, run: r.id, apply: true });
    assert.ok(!stopped.actions.some(a => a.status === 'failed')); assert.ok(!existsSync(raw));
  } finally { child.kill(); f.dispose(); }
});

test('unconfigured GC and an abandoned mutation lock report without deleting', async () => {
  const f = fixture(); try {
    const r = await run(f), raw = await file(f, r, 'raw', 'intermediate');
    await finishRun({ ...f, run: r.id, status: 'complete' });
    const res = await gc({ ...f, apply: true, now: Date.now() + 7200000 });
    assert.equal(res.runs[0].reason, 'retention policy not configured'); assert.ok(existsSync(raw));
    const lock = join(f.stateRoot, 'teardown', '.lock'); mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, started: 'old' }));
    await assert.rejects(teardown({ ...f, run: r.id, apply: true }), /stale lock/); assert.ok(existsSync(raw));
  } finally { f.dispose(); }
});

test('managed HTML output registers retained evidence through the producer binding', async () => {
  const f = fixture(); try {
    const r = await run(f), src = join(r.dir, 'source.html'), out = join(r.dir, 'report.html');
    writeFileSync(src, '<!doctype html><title>Report</title><p>Evidence</p>');
    const script = new URL('../../factory-record-flow/scripts/build-page.mjs', import.meta.url);
    const child = spawnSync(process.execPath, [script.pathname, src, out], { cwd: f.root, encoding: 'utf8', env: { ...process.env, FACTORY_RUN_ID: r.id, FACTORY_STATE_ROOT: f.stateRoot } });
    assert.equal(child.status, 0, child.stderr); assert.ok(existsSync(out));
    assert.equal(JSON.parse(readFileSync(r.manifest)).artifacts.find(a => a.path === 'report.html').class, 'evidence');
    await finishRun({ ...f, run: r.id, status: 'complete' }); await teardown({ ...f, run: r.id, apply: true }); assert.ok(existsSync(out));
    writeFileSync(src, '<!doctype html><title>Rebuilt</title>');
    const rebuilt = spawnSync(process.execPath, [script.pathname, src, out], { cwd: f.root, encoding: 'utf8', env: { ...process.env, FACTORY_RUN_ID: r.id, FACTORY_STATE_ROOT: f.stateRoot } });
    assert.equal(rebuilt.status, 0, rebuilt.stderr); assert.match(readFileSync(out, 'utf8'), /Rebuilt/);
  } finally { f.dispose(); }
});

test('linked script entry points execute and active orphan runs are reported, never reaped', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(); try {
    const script = new URL('./lifecycle.mjs', import.meta.url).pathname, linked = join(f.root, 'lifecycle.mjs'); symlinkSync(script, linked);
    const child = spawnSync(process.execPath, [linked, 'begin', '--kind', 'linked', '--state-root', f.stateRoot], { cwd: f.root, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); const r = JSON.parse(child.stdout);
    const raw = await file(f, r, 'raw', 'intermediate'); await configure({ ...f, intermediateHours: 1 });
    const m = JSON.parse(readFileSync(r.manifest)); m.owner = { pid: 99999999, started: 'gone' }; writeFileSync(r.manifest, JSON.stringify(m));
    const report = await gc({ ...f, apply: true, now: Date.now() + 7200000 });
    assert.equal(report.runs[0].reason, 'inactive run needs inspection'); assert.ok(existsSync(raw));
  } finally { f.dispose(); }
});

test('pending recording inputs survive completion and GC until consumers explicitly release them', async () => {
  const f = fixture(); try {
    const r = await run(f), raw = join(r.dir, 'take.webm'); writeFileSync(raw, 'raw');
    await addArtifact({ ...f, run: r.id, path: raw, class: 'intermediate', pending: true });
    await finishRun({ ...f, run: r.id, status: 'complete' });
    await teardown({ ...f, run: r.id, apply: true }); assert.ok(existsSync(raw));
    await assert.rejects(releaseInputs({ ...f, run: r.id }), /verify/);
    await releaseInputs({ ...f, run: r.id, verified: true }); await teardown({ ...f, run: r.id, apply: true }); assert.ok(!existsSync(raw));
  } finally { f.dispose(); }
});

test('scratch cleanup uses its recorded temp base after TMPDIR changes', async () => {
  const f = fixture(), old = process.env.TMPDIR; let scratch;
  try {
    const r = await run(f); scratch = await createScratch({ ...f, run: r.id });
    process.env.TMPDIR = f.root; await finishRun({ ...f, run: r.id, status: 'complete' });
    const result = await teardown({ ...f, run: r.id, apply: true });
    assert.ok(!result.actions.some(a => a.status === 'failed')); assert.ok(!existsSync(scratch.dir));
  } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; if (scratch) rmSync(scratch.dir, { recursive: true, force: true }); f.dispose(); }
});

test('launched process group stops descendants before releasing its inputs', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(); let server;
  try {
    if (!processIdentity(process.pid)) { t.skip('process identity unavailable in sandbox'); return; }
    const r = await run(f), raw = await file(f, r, 'input', 'intermediate');
    const app = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`;
    server = await launchProcess({ ...f, run: r.id, command: [process.execPath, '-e', app], cwd: f.root });
    for (let i = 0; i < 30 && !readFileSync(server.log, 'utf8').trim(); i++) await new Promise(r => setTimeout(r, 50));
    const descendant = Number(readFileSync(server.log, 'utf8').trim().split('\n')[0]); assert.ok(descendant > 1);
    const stopped = await stopResources({ ...f, run: r.id, apply: true });
    assert.ok(!stopped.actions.some(a => a.status === 'failed'), JSON.stringify(stopped)); assert.ok(existsSync(raw));
    assert.equal(processIdentity(descendant), null);
    await finishRun({ ...f, run: r.id, status: 'complete' }); await teardown({ ...f, run: r.id, apply: true }); assert.ok(!existsSync(raw));
  } finally { if (server) { try { process.kill(-server.pid, 'SIGKILL'); } catch {} } f.dispose(); }
});

test('a corrupt released resource never permits deletion of other artifacts', async () => {
  const f = fixture(); try {
    const r = await run(f), raw = await file(f, r, 'raw', 'intermediate');
    await finishRun({ ...f, run: r.id, status: 'complete' });
    const m = JSON.parse(readFileSync(r.manifest)); m.resources.push({ type: 'unknown', released: true }); writeFileSync(r.manifest, JSON.stringify(m));
    await assert.rejects(teardown({ ...f, run: r.id, apply: true }), /invalid manifest/); assert.ok(existsSync(raw));
  } finally { f.dispose(); }
});

test('a live owner with a day-old heartbeat is reported without stopping or deleting anything', async () => {
  const f = fixture(); try {
    const r = await beginRun({ ...f, kind: 'stale-attendance', ownerPid: process.pid });
    const raw = await file(f, r, 'raw', 'intermediate');
    await configure({ ...f, intermediateHours: 1 });
    const report = await gc({ ...f, apply: true, now: Date.now() + 25 * 3600000 });
    assert.equal(report.runs[0].reason, 'inactive run needs inspection');
    assert.ok(existsSync(raw)); assert.equal(JSON.parse(readFileSync(r.manifest)).status, 'active');
  } finally { f.dispose(); }
});
