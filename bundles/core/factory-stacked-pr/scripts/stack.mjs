#!/usr/bin/env node
// stack.mjs: the stack ledger. One claim per branch says which session writes it and what it's based
// on, and an append-only event log says when a branch moved, is about to land, or landed. Sessions on
// one stack find each other here instead of scanning terminals. Git refs stay the truth for "did the
// parent move"; the ledger adds who moved it and what's coming. node: imports only, no network.
//
//   claim   --branch <b> --owner <tag> [--base <b>] [--pr N] [--state f] [--worktree p] [--takeover --why <text>]
//   who     --branch <b>
//   peers   --branch <b>              (the parent's claim and every claim based on <b>)
//   event   --branch <b> --owner <tag> <pushed|merging|merged|released> [--head sha] [--method m] [--commit sha]
//   since   --branch <base> [--seen sha]   (events on <base> after the one whose head is <seen>)
//   guard   --branch <b> --owner <tag>     (exit 1 when another live session owns <b>)
//
// The ledger is <dirname(stateRoot)>/stack, beside decisions/ and dev-slots/, so every worktree of a
// repo shares it. --dir or FACTORY_STACK_DIR overrides that. Prints JSON.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, appendFileSync, openSync, closeSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVER = join(HERE, '..', '..', 'factory-context', 'scripts', 'resolve.mjs');
export const STALE_HOURS = 12;
export const KINDS = ['pushed', 'merging', 'merged', 'released'];

export class StackError extends Error {}
const fail = (m) => { throw new StackError(m); };
const now = () => new Date().toISOString();
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export function ledgerDir({ dir, cwd = process.cwd(), env = process.env } = {}) {
  if (dir) return resolve(dir);
  if (env.FACTORY_STACK_DIR) return resolve(env.FACTORY_STACK_DIR);
  const r = spawnSync(process.execPath, [RESOLVER, '--cwd', cwd], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) fail(`resolver failed for ${cwd}: ${(r.stderr || '').trim().split('\n')[0]}`);
  const { stateRoot } = JSON.parse(r.stdout);
  if (!stateRoot) fail('no stateRoot: pass --dir, or run inside a registered project');
  return join(dirname(stateRoot), 'stack');
}

const claimFile = (dir, branch) => join(dir, 'branches', `${encodeURIComponent(branch)}.json`);
const eventsFile = (dir) => join(dir, 'events.jsonl');

function write(file, rec) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  renameSync(tmp, file);
  return rec;
}

// A claim nobody has touched in STALE_HOURS is orphaned: its owner may be gone. Taking it over needs a reason.
export const isStale = (c, at = now(), hours = STALE_HOURS) => !!c && !c.released && Date.parse(at) - Date.parse(c.heartbeat || c.claimed) > hours * 3600e3;

export function who(dir, branch, at = now()) {
  if (!branch) fail('who needs --branch');
  const c = readJson(claimFile(dir, branch));
  return c ? { ...c, stale: isStale(c, at) } : null;
}

export function claim(dir, { branch, owner, base, pr, state, worktree, takeover = false, why, at = now() }) {
  if (!branch || !owner) fail('claim needs --branch and --owner');
  if (takeover && !why) fail('a takeover needs --why: the reason goes in the claim');
  mkdirSync(join(dir, 'branches'), { recursive: true });
  const file = claimFile(dir, branch);
  const fields = Object.fromEntries(Object.entries({ base, pr: pr == null ? undefined : Number(pr), state, worktree }).filter(([, v]) => v !== undefined));
  const fresh = { branch, owner, ...fields, claimed: at, heartbeat: at };
  try { closeSync(openSync(file, 'wx')); return { ...write(file, fresh), created: true }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const old = readJson(file) || {};
  if (old.owner === owner || old.released) return write(file, old.released ? fresh : { ...old, ...fields, heartbeat: at });
  if (!takeover) fail(`${branch} is owned by ${old.owner} (last seen ${old.heartbeat}${isStale(old, at) ? ', stale' : ''}); ask the user, then claim with --takeover --why`);
  return write(file, { ...fresh, took_over: { from: old.owner, why, at } });
}

export function peers(dir, branch, at = now()) {
  if (!branch) fail('peers needs --branch');
  const all = readdirSync(join(dir, 'branches'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => readJson(join(dir, 'branches', e.name))).filter(Boolean);
  const mine = all.find((c) => c.branch === branch) || null;
  const parent = mine?.base ? who(dir, mine.base, at) : null;
  const children = all.filter((c) => c.base === branch && !c.released).map((c) => ({ ...c, stale: isStale(c, at) }));
  return { branch, owner: mine?.owner ?? null, base: mine?.base ?? null, parent, children };
}

export function event(dir, { branch, owner, kind, head, method, commit, at = now() }) {
  if (!branch || !owner || !KINDS.includes(kind)) fail(`event needs --branch, --owner and one of ${KINDS.join('|')}`);
  const c = readJson(claimFile(dir, branch));
  if (c && c.owner !== owner && !c.released) fail(`${branch} is owned by ${c.owner}; only its owner records its events`);
  const rec = Object.fromEntries(Object.entries({ at, branch, kind, by: owner, head, method, commit }).filter(([, v]) => v !== undefined));
  mkdirSync(dir, { recursive: true });
  appendFileSync(eventsFile(dir), JSON.stringify(rec) + '\n');
  if (c) write(claimFile(dir, branch), { ...c, heartbeat: at, ...(head ? { head } : {}), ...(kind === 'merged' || kind === 'released' ? { released: at } : {}) });
  return rec;
}

export function since(dir, branch, seen) {
  if (!branch) fail('since needs --branch');
  const text = existsSync(eventsFile(dir)) ? readFileSync(eventsFile(dir), 'utf8') : '';
  const evs = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.branch === branch);
  const i = seen ? evs.findLastIndex((e) => e.head && (e.head.startsWith(seen) || seen.startsWith(e.head))) : -1;
  return evs.slice(i + 1);
}

// Run before a commit or push to a branch: is it yours? Unclaimed, released and stale claims pass with a note.
export function guard(dir, { branch, owner, at = now() }) {
  if (!branch || !owner) fail('guard needs --branch and --owner');
  const c = who(dir, branch, at);
  if (!c || c.released) return { ok: true, note: `${branch} is unclaimed: claim it before you write it` };
  if (c.owner === owner) return { ok: true };
  if (c.stale) return { ok: true, note: `${branch} has a stale claim by ${c.owner}: ask the user before a --takeover` };
  return { ok: false, owner: c.owner, state: c.state ?? null, note: `${branch} belongs to ${c.owner}: read and report, don't write it` };
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } }
    else o._.push(a);
  }
  return o;
}

export function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const o = args(rest);
  const dir = ledgerDir({ dir: o.dir, env });
  switch (cmd) {
    case 'claim': return claim(dir, { branch: o.branch, owner: o.owner, base: o.base, pr: o.pr, state: o.state, worktree: o.worktree, takeover: !!o.takeover, why: o.why });
    case 'who': return who(dir, o.branch);
    case 'peers': return existsSync(join(dir, 'branches')) ? peers(dir, o.branch) : { branch: o.branch, owner: null, base: null, parent: null, children: [] };
    case 'event': return event(dir, { branch: o.branch, owner: o.owner, kind: o._[0], head: o.head, method: o.method, commit: o.commit });
    case 'since': return since(dir, o.branch, o.seen);
    case 'guard': { const g = guard(dir, { branch: o.branch, owner: o.owner }); if (!g.ok) process.exitCode = 1; return g; }
    default: fail(`unknown command "${cmd ?? ''}"; see the header of stack.mjs`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (e) {
    if (!(e instanceof StackError)) throw e;
    console.error(JSON.stringify({ error: 'stack', message: e.message }));
    process.exit(2);
  }
}
