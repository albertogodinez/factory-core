#!/usr/bin/env node
// Reconcile local plan lifecycle (plan frontmatter) against the merge state of each plan's PRs.
// A draft or active plan whose pr_links are all MERGED is done; a plan marked completed or
// abandoned is finished. --apply deletes finished plans that have no ticket. A plan with a ticket
// is never deleted here: the report prints its harvest command (tracker publish --harvest).
// Plans are gitignored, so a deletion is final. Files that mention a plan are reported, not edited.
//
// Usage: node reconcile-plan-prs.mjs [--apply] [--plan <path>] [--plans-dir <dir>] [--json]
import { readFileSync, readdirSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PR_URL = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const TERMINAL = ['completed', 'abandoned'];
const KNOWN = ['draft', 'active', ...TERMINAL];
const DELETABLE = ['ready-to-complete', 'deletable-finished'];

const unquote = (v) => { v = v.trim(); return v.length >= 2 && v[0] === v.at(-1) && '"\''.includes(v[0]) ? v.slice(1, -1) : v; };

// Flat scalars, `key:` followed by `- item` lines, and one-line `key: ["a", "b"]` lists. Not general YAML.
export function parseFrontmatter(content) {
  const m = /^---\s*\n([\s\S]*?\n)---\s*\n?/.exec(content);
  if (!m) return {};
  const fm = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    if (/^[ \t]/.test(line) && listKey) {
      const li = /^\s*-\s*(.*)$/.exec(line);
      if (li) fm[listKey].push(unquote(li[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw.trim();
    if (value === '') { listKey = key; fm[key] = []; }
    else if (value.startsWith('[') && value.endsWith(']')) { listKey = null; fm[key] = value.slice(1, -1).split(',').filter((v) => v.trim()).map(unquote); }
    else { listKey = null; fm[key] = unquote(value); }
  }
  return fm;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// MERGED / OPEN / CLOSED / UNKNOWN / UNPARSEABLE. One retry on a gh failure; no gh degrades to UNKNOWN.
export function classifyPr(url, gh = defaultGh) {
  if (!PR_URL.test(url)) return 'UNPARSEABLE';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = gh(['pr', 'view', url, '--json', 'state,mergedAt']);
    if (r.status === 0) {
      try {
        const s = JSON.parse(r.stdout).state;
        return s === 'MERGED' || s === 'OPEN' || s === 'CLOSED' ? s : 'UNKNOWN';
      } catch { /* retry */ }
    }
    if (attempt === 0) sleep(1500);
  }
  return 'UNKNOWN';
}
const defaultGh = (args) => spawnSync('gh', args, { encoding: 'utf8', timeout: 30000 });

export function planPrStatus(prLinks, gh) {
  if (!prLinks.length) return { merged: 0, total: 0, states: [], verdict: 'no-signal' };
  const states = prLinks.map((e) => classifyPr(e.split(/\s+/)[0] ?? '', gh));
  const merged = states.filter((s) => s === 'MERGED').length;
  const verdict = states.some((s) => s === 'UNKNOWN' || s === 'UNPARSEABLE') ? 'unverifiable'
    : merged === states.length ? 'ready-to-complete' : `pending (${merged}/${states.length} merged)`;
  return { merged, total: states.length, states, verdict };
}

// Never acts on partial information: an unverifiable plan is reported, never deleted.
export function decidePlan(fm, gh) {
  const links = Array.isArray(fm.pr_links) ? fm.pr_links : [];
  const pr = planPrStatus(links, gh);
  if (!KNOWN.includes(fm.status ?? '')) return { verdict: 'skip', pr };
  if (TERMINAL.includes(fm.status)) return { verdict: 'deletable-finished', pr };
  return { verdict: pr.verdict, pr };
}

function inboundReferences(root, name, exclude) {
  const r = spawnSync('git', ['grep', '-l', '-F', name], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) return [];
  return r.stdout.split('\n').filter((l) => l && l !== exclude);
}

export function processPlan(file, { apply, root, harvestCmd, gh }) {
  const fm = parseFrontmatter(readFileSync(file, 'utf8'));
  const { verdict, pr } = decidePlan(fm, gh);
  const rel = relative(root, file);
  const rec = { plan: rel, status: fm.status ?? 'unknown', verdict, merged: pr.merged, total: pr.total, states: pr.states };
  if (DELETABLE.includes(verdict)) {
    const actions = { inbound_references: inboundReferences(root, file.split('/').at(-1), rel), harvest: null };
    const ticket = fm.ticket || fm.jira_ticket;
    if (ticket) actions.harvest = harvestCmd ? `${harvestCmd(rel)}` : null;
    else if (apply) unlinkSync(file);
    actions.ticketed = Boolean(ticket);
    rec.actions = actions;
  }
  return rec;
}

function report(records, apply) {
  const out = [`${'='.repeat(70)}\nPLAN <-> PR RECONCILIATION [${apply ? 'APPLY' : 'REPORT-ONLY'}]\n${'='.repeat(70)}`];
  const order = ['ready-to-complete', 'deletable-finished', 'pending', 'unverifiable', 'no-signal', 'skip'];
  const key = (r) => (r.verdict.startsWith('pending') ? 'pending' : r.verdict);
  for (const k of new Set([...order, ...records.map(key)])) {
    const group = records.filter((r) => key(r) === k);
    if (!group.length) continue;
    out.push(`\n[${k}] (${group.length})`);
    for (const r of group) {
      out.push(`  - ${r.plan}  status=${r.status}  merged=${r.merged}/${r.total}${r.states.length ? `  states=${JSON.stringify(r.states)}` : ''}`);
      if (r.states.includes('CLOSED')) out.push('      -> A linked PR closed unmerged: ask the user whether that part was dropped or replaced');
      if (r.actions) {
        if (r.actions.ticketed) out.push(`      -> Has a ticket, so it is never deleted here. Harvest it to the ticket first (this deletes it after posting): ${r.actions.harvest ?? 'tracker publish --target jira --harvest'}`);
        else out.push(`      -> ${apply ? 'Deleted' : 'Would delete'}: ${r.plan}`);
        for (const ref of r.actions.inbound_references) out.push(`      -> Still mentioned in ${ref}: point it at the PR or ticket instead`);
      }
    }
  }
  out.push(`\n${'='.repeat(70)}\nTotal plans scanned: ${records.length}\n${'='.repeat(70)}`);
  return out.join('\n');
}

function resolverField(field, cwd) {
  try {
    const r = resolve(dirname(fileURLToPath(import.meta.url)), '../../toolkit-context/scripts/resolve.mjs');
    return execFileSync(process.execPath, [r, '--field', field, '--cwd', cwd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const apply = argv.includes('--apply');
  const root = resolve(resolverField('project.root', process.cwd()) ?? process.cwd());
  const plansDir = resolve(root, arg('--plans-dir') ?? resolverField('project.planHome', process.cwd()) ?? 'plans');
  const tracker = resolverField('adapters.tracker', process.cwd());
  const harvestCmd = tracker ? (rel) => `node .agents/skills/${tracker}/scripts/tracker.mjs publish --file ${rel} --target jira --harvest` : null;
  const single = arg('--plan');
  const files = single ? [resolve(single)] : existsSync(plansDir) ? readdirSync(plansDir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort().map((f) => join(plansDir, f)) : [];
  const records = files.map((f) => processPlan(f, { apply, root, harvestCmd, gh: defaultGh }));
  if (argv.includes('--json')) console.log(JSON.stringify(records.map(({ actions, ...r }) => r), null, 2));
  else console.log(report(records, apply));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
