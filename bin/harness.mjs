// harness.mjs: the harness bundle. Hooks and permission rules for Claude Code and Codex live in git,
// in each bundle's harness/<claude-code|codex>.json, so a harness lesson is a commit like any other:
// one branch, one review, the same trailers. `factory harness` shows what applying them would change;
// `--apply` merges them into ~/.claude/settings.json and ~/.codex/hooks.json.
//
// A fragment holds only { hooks: {<event>: [group]}, permissions: { allow: [rule], deny: [rule] } }.
// Factory remembers what it applied (<home>/harness-applied.json): an entry dropped from a fragment is
// removed from the settings on the next apply, and nothing the user added by hand is touched. A broad
// allow rule (a bare tool name, or one whose specifier is only a wildcard) is refused.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const HARNESSES = ['claude-code', 'codex'];
const EVENT = /^[A-Z][A-Za-z]+$/;

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

// An allow rule must name what it allows: Tool(specifier) with a specifier that isn't only wildcards,
// or a single MCP tool. "Bash", "Bash(*)" and "Bash(:*)" would allow everything.
export function broadAllow(rule) {
  if (/^mcp__[\w-]+__[\w-]+$/.test(rule)) return false;
  const m = /^(\w+)\((.*)\)$/.exec(rule);
  return !m || /^[\s*:]*$/.test(m[2]);
}

export function checkFragment(f, where = 'fragment') {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return `${where} must be an object`;
  for (const k of Object.keys(f)) if (!['hooks', 'permissions'].includes(k)) return `${where}.${k}: a fragment holds only hooks and permissions`;
  for (const [ev, groups] of Object.entries(f.hooks || {})) {
    if (!EVENT.test(ev)) return `${where}.hooks.${ev} is not an event name`;
    if (!Array.isArray(groups)) return `${where}.hooks.${ev} must be a list of groups`;
    for (const g of groups) {
      if (!Array.isArray(g?.hooks) || !g.hooks.every((h) => h?.type === 'command' && typeof h.command === 'string' && h.command)) return `${where}.hooks.${ev}: each group needs hooks of type command`;
    }
  }
  const p = f.permissions || {};
  for (const k of Object.keys(p)) if (!['allow', 'deny'].includes(k)) return `${where}.permissions.${k}: only allow and deny`;
  for (const k of ['allow', 'deny']) if (p[k] !== undefined && !(Array.isArray(p[k]) && p[k].every((r) => typeof r === 'string' && r))) return `${where}.permissions.${k} must list rules`;
  const broad = (p.allow || []).find(broadAllow);
  if (broad) return `${where}.permissions.allow: "${broad}" allows too much; name the command or path`;
  return null;
}

const hashOf = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
function revOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Every bundle's fragment for one harness, in bundle order. `git` is off for the status hook, which
// may not spawn: it compares hashes only.
export function fragments(sources, harness, { git = true } = {}) {
  const out = [];
  for (const [bundle, dir] of Object.entries(sources).sort(([a], [b]) => (a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b)))) {
    const file = join(dir, 'harness', `${harness}.json`);
    if (!existsSync(file)) continue;
    const fragment = readJson(file, null);
    const problem = fragment === null ? `${file} isn't valid JSON` : checkFragment(fragment, file);
    out.push({ bundle, file, fragment, problem, hash: hashOf(fragment), ...(git ? { rev: revOf(dir) } : {}) });
  }
  return out;
}

// The entries a set of fragments asks for: hook commands per event (with the group's matcher), and rules.
function wanted(frags) {
  const hooks = [], allow = new Set(), deny = new Set();
  for (const { fragment } of frags) {
    for (const [event, groups] of Object.entries(fragment.hooks || {})) {
      for (const g of groups) for (const h of g.hooks) hooks.push({ event, matcher: g.matcher, hook: h });
    }
    for (const r of fragment.permissions?.allow || []) allow.add(r);
    for (const r of fragment.permissions?.deny || []) deny.add(r);
  }
  return { hooks, allow: [...allow], deny: [...deny] };
}

// Merge into a settings object in place. `prev` is what factory applied last time to this file. Returns
// the changes (one line each) and the record to keep.
export function merge(cfg, frags, prev = {}) {
  const want = wanted(frags), changes = [];
  const prevHooks = prev.hooks || [], prevAllow = prev.allow || [], prevDeny = prev.deny || [];
  const wantCmd = new Set(want.hooks.map((h) => `${h.event}\t${h.hook.command}`));
  cfg.hooks ||= {};
  // Remove what factory added before and no fragment asks for any more.
  for (const { event, command } of prevHooks) {
    if (wantCmd.has(`${event}\t${command}`)) continue;
    const groups = cfg.hooks[event] || [];
    for (const g of groups) { const n = (g.hooks || []).length; g.hooks = (g.hooks || []).filter((h) => h.command !== command); if (g.hooks.length < n) changes.push(`${event}: removed ${command}`); }
    cfg.hooks[event] = groups.filter((g) => (g.hooks || []).length);
    if (!cfg.hooks[event].length) delete cfg.hooks[event];
  }
  for (const { event, matcher, hook } of want.hooks) {
    const groups = (cfg.hooks[event] ||= []);
    const found = groups.flatMap((g) => g.hooks || []).find((h) => h.command === hook.command);
    if (found) {
      if (JSON.stringify(found) !== JSON.stringify({ ...found, ...hook })) { Object.assign(found, hook); changes.push(`${event}: updated ${hook.command}`); }
      continue;
    }
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ ...hook }] });
    changes.push(`${event}: added ${hook.command}`);
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  for (const [k, w, before] of [['allow', want.allow, prevAllow], ['deny', want.deny, prevDeny]]) {
    if (!w.length && !before.length) continue;
    cfg.permissions ||= {};
    let list = cfg.permissions[k] || [];
    const gone = before.filter((r) => !w.includes(r) && list.includes(r));
    list = list.filter((r) => !gone.includes(r));
    for (const r of gone) changes.push(`permissions.${k}: removed ${r}`);
    for (const r of w) if (!list.includes(r)) { list.push(r); changes.push(`permissions.${k}: added ${r}`); }
    if (list.length) cfg.permissions[k] = list; else delete cfg.permissions[k];
  }
  if (cfg.permissions && !Object.keys(cfg.permissions).length) delete cfg.permissions;
  const record = { hooks: want.hooks.map(({ event, hook }) => ({ event, command: hook.command })), allow: want.allow, deny: want.deny,
    sources: Object.fromEntries(frags.map((f) => [f.bundle, { hash: f.hash, ...(f.rev ? { rev: f.rev } : {}) }])) };
  return { changes, record };
}

// Bundles whose fragment changed since the last apply, by hash: no git, no writes. For the status hook.
export function drifted(sources, applied, harness) {
  const now = fragments(sources, harness, { git: false });
  const was = applied?.[harness]?.sources || {};
  const names = new Set([...now.map((f) => f.bundle), ...Object.keys(was)]);
  const empty = (f) => !f || (!Object.values(f.hooks || {}).some((g) => g.length) && !(f.permissions?.allow || []).length && !(f.permissions?.deny || []).length);
  return [...names].filter((b) => {
    const f = now.find((x) => x.bundle === b);
    if (!was[b] && empty(f?.fragment)) return false; // never applied, and nothing to apply
    return (f?.hash || null) !== (was[b]?.hash || null);
  }).sort();
}
