import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCandidates, applyProfile, envLine, expiry, fitsMemory, loadApp, loadAppFile, loadProfile, parseArgs, pickPort, proxyPortFor, queueOrder, slugFor, validateApp } from './slot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'dev-slot-'));
const write = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };

const MAIN = '/r/my-app';

test('a worktree slug drops .worktrees/ and joins the rest with dashes', () => {
  assert.equal(slugFor(`${MAIN}/.worktrees/fix/scrollbar-styling`, MAIN), 'fix-scrollbar-styling');
});

test('the main checkout is slug main', () => {
  assert.equal(slugFor(MAIN, MAIN), 'main');
});

test('a worktree outside the main checkout uses its directory name', () => {
  assert.equal(slugFor('/elsewhere/My_Tree', MAIN), 'my-tree');
});

test('pickPort skips taken ports and returns null when the range is full', () => {
  assert.equal(pickPort(new Set([18443, 18444]), [18443, 18499]), 18445);
  assert.equal(pickPort(new Set([18443]), [18443, 18443]), null);
});

test('Docker at 7.65 GiB fits one 6 GiB slot and refuses a second', () => {
  const totalBytes = 7.65 * 1024 ** 3;
  assert.equal(fitsMemory({ totalBytes, running: 0, perSlotGiB: 6 }), true);
  assert.equal(fitsMemory({ totalBytes, running: 1, perSlotGiB: 6 }), false);
});

test('value flags take the next argument; others are booleans', () => {
  assert.deepEqual(parseArgs(['up', 'my-app', '--worktree', '/w', '--no-wait']),
    { cmd: 'up', app: 'my-app', flags: { worktree: '/w', 'no-wait': true } });
});

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test('gc keeps a running slot touched within idleMinutes', () => {
  assert.equal(expiry({ status: 'running', worktreeExists: true, lastUsed: NOW - 59 * MIN, now: NOW, idleMinutes: 60 }), null);
});

test('gc reaps an idle slot, an exited container, and a removed worktree, worktree first', () => {
  assert.equal(expiry({ status: 'running', worktreeExists: true, lastUsed: NOW - 61 * MIN, now: NOW, idleMinutes: 60 }), 'idle 61 min');
  assert.equal(expiry({ status: 'exited', worktreeExists: true, lastUsed: NOW, now: NOW, idleMinutes: 60 }), 'container exited');
  assert.equal(expiry({ status: 'exited', worktreeExists: false, lastUsed: NOW, now: NOW, idleMinutes: 60 }), 'worktree gone');
});

test('the queue serves the oldest ticket first, with the id breaking a tie', () => {
  const t = (id, at) => ({ id, at, beat: NOW });
  assert.deepEqual(queueOrder([t('c', 3), t('b', 1), t('a', 1)], NOW).map((x) => x.id), ['a', 'b', 'c']);
});

test('a ticket whose owner stopped heartbeating loses its place', () => {
  const order = queueOrder([{ id: 'dead', at: 1, beat: NOW - 3 * MIN }, { id: 'live', at: 2, beat: NOW - 5000 }], NOW);
  assert.deepEqual(order.map((x) => x.id), ['live']);
});

test('every shipped example app config matches the schema', () => {
  const dir = join(HERE, '../examples');
  for (const f of readdirSync(dir)) assert.deepEqual(validateApp(JSON.parse(readFileSync(join(dir, f), 'utf8')), f), [], f);
});

test('the Astro example serves http on 4321 and runs pnpm dev bound to every interface', () => {
  const app = JSON.parse(readFileSync(join(HERE, '../examples/astro.json'), 'utf8'));
  assert.equal(app.scheme, 'http');
  assert.equal(app.containerPort, 4321);
  assert.match(app.command, /pnpm dev --host 0\.0\.0\.0 --port 4321/);
});

test('each slot gets its own auth-proxy port, clear of every app port, and env names default', () => {
  const app = JSON.parse(readFileSync(join(HERE, '../examples/astro.json'), 'utf8'));
  const [lo, hi] = app.portRange;
  assert.equal(proxyPortFor(14321), 15321);
  assert.ok(proxyPortFor(lo) > hi, 'proxy ports never land inside the slot range');
  assert.equal(envLine(app, { baseUrl: 'http://localhost:14322', session: 's', proxyPort: 15322 }),
    'export DEV_SLOT_BASE_URL=http://localhost:14322 DEV_SLOT_SESSION=s');
  const named = { ...app, env: { baseUrl: 'A_URL', session: 'A_SESSION', proxyPort: 'A_PROXY' } };
  assert.equal(envLine(named, { baseUrl: 'u', session: 's', proxyPort: 1 }), 'export A_URL=u A_SESSION=s A_PROXY=1');
});

test('an app config is found in the project, then in an installed companion', () => {
  const wt = tmp();
  const app = { name: 'site', image: 'node:24', containerPort: 4321, healthPath: '/', portRange: [14321, 14330], memoryGiB: 2 };
  assert.throws(() => loadApp('site', wt), /no app config for "site"[\s\S]*dev-slot\.json/);
  write(join(wt, '.agents/skills/toolkit-dev-slot-acme/apps/site.json'), app);
  assert.equal(loadApp('site', wt).name, 'site');
  assert.ok(appCandidates('site', wt).some((f) => f.endsWith('toolkit-dev-slot-acme/apps/site.json')));
  write(join(wt, '.ai-toolkit/dev-slot.json'), { ...app, memoryGiB: 3 });
  assert.equal(loadApp('site', wt).memoryGiB, 3, 'the project file wins');
});

test('a project file for another app name is skipped, and an invalid one is an error naming the file', () => {
  const wt = tmp();
  write(join(wt, '.ai-toolkit/dev-slot.json'), { name: 'other', image: 'x', containerPort: 1, healthPath: '/', portRange: [2000, 2001], memoryGiB: 1 });
  assert.throws(() => loadApp('site', wt), /names "other"/);
  write(join(wt, '.agents/skills/toolkit-dev-slot-acme/apps/site.json'), { name: 'site', image: 'x' });
  assert.throws(() => loadApp('site', wt), /site\.json:[\s\S]*containerPort: required/);
  assert.throws(() => loadAppFile(join(wt, '.agents/skills/toolkit-dev-slot-acme/apps/site.json'), 'site'), /healthPath: required/);
});

test('a profile is found in an installed skill by name', () => {
  const wt = tmp();
  write(join(wt, '.agents/skills/toolkit-dev-slot-acme/profiles/corp.json'), { name: 'corp', env: { A: 'b' } });
  const p = loadProfile('corp', wt);
  assert.equal(p.name, 'corp');
  assert.match(p.file, /toolkit-dev-slot-acme\/profiles\/corp\.json$/);
});

test('a missing profile is a clear error that says where it looked and what to do', () => {
  assert.throws(() => loadProfile('nope-profile', tmp()), /env profile "nope-profile" \(adapters\.envProfile\) not found[\s\S]*profiles\/nope-profile\.json[\s\S]*unset adapters\.envProfile/);
});

test('a malformed profile or one whose name differs from its file is rejected', () => {
  const wt = tmp();
  write(join(wt, '.agents/skills/x/profiles/a.json'), { name: 'b' });
  assert.throws(() => loadProfile('a', wt), /must match the profile name/);
  write(join(wt, '.agents/skills/x/profiles/c.json'), { name: 'c', mounts: [{ host: '/h' }] });
  assert.throws(() => loadProfile('c', wt), /container: required/);
});

test('no profile means no extra docker args and an untouched env', () => {
  const hostEnv = { PATH: '/bin' };
  const { args, env } = applyProfile(null, { hostEnv });
  assert.deepEqual(args, []);
  assert.deepEqual(env, hostEnv);
});

// Secrets resolved for the agent stay on the host: the container gets only what the profile names.
test('docker run forwards no credential the profile does not name, and a file secret never reaches argv', () => {
  const dir = tmp();
  write(join(dir, 'rc'), '//reg/:_authToken=sekret-file-token\n');
  const profile = {
    name: 'p', mounts: [{ host: join(dir, 'rc'), container: '/home/node/.rc' }],
    envFromFile: [{ name: 'REG_TOKEN', file: join(dir, 'rc'), linePrefix: '//reg/:_authToken=' }],
    passEnv: ['NO_PROXY'], rewriteLoopbackEnv: ['HTTPS_PROXY'],
  };
  const hostEnv = { INTEGRATION_PASSWORD: 'sekret-pw', JIRA_API_TOKEN: 'sekret-tok', HTTPS_PROXY: 'http://127.0.0.1:9000', NO_PROXY: 'internal' };
  const { args, env } = applyProfile(profile, { hostEnv, stateDir: dir });
  const passed = args.filter((_, i) => args[i - 1] === '-e').map((a) => a.split('=')[0]);
  assert.deepEqual(passed.sort(), ['HTTPS_PROXY', 'NO_PROXY', 'REG_TOKEN']);
  assert.ok(args.includes('HTTPS_PROXY=http://host.docker.internal:9000'));
  assert.ok(!args.some((a) => a.includes('sekret')), 'no secret value in argv');
  assert.equal(env.REG_TOKEN, 'sekret-file-token');
  assert.ok(args.includes(`${join(dir, 'rc')}:/home/node/.rc:ro`));
});

test('a missing mount or secret file is skipped with the profile\'s own warning', () => {
  const said = [];
  const profile = { name: 'p', mounts: [{ host: '/no/such/file', container: '/x', warnIfMissing: 'no rc file' }],
    envFromFile: [{ name: 'T', file: '/no/such/file', linePrefix: 'k=', warnIfMissing: 'no token' }] };
  const { args } = applyProfile(profile, { hostEnv: {}, log: (m) => said.push(m) });
  assert.deepEqual(args, []);
  assert.deepEqual(said, ['no rc file', 'no token']);
});

test('a PEM file CA bundle is mounted read-only and exported through its env var', () => {
  const dir = tmp();
  write(join(dir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n');
  const { args } = applyProfile({ name: 'p', caBundle: { from: 'file', path: join(dir, 'ca.pem'), container: '/ca/p.pem' } }, { hostEnv: {}, stateDir: dir });
  assert.ok(args.includes('NODE_EXTRA_CA_CERTS=/ca/p.pem'));
  assert.ok(args.some((a) => a.endsWith(':/ca/p.pem:ro')));
});
