#!/usr/bin/env node
/**
 * Is each pinned reviewer model in references/models.json still the newest of
 * its family that this account can run?
 *
 *   node check-models.mjs            offline: reads the CLIs' local catalog caches, warns, always exits 0
 *   node check-models.mjs --online   refreshes the Codex catalog, exits 1 when a pin is stale
 *   node check-models.mjs --sync     also writes the codex pin into ~/.codex/config.toml as its default model
 *
 * Sources:
 *   Codex   `codex debug models` (live, per account), saved to tmp/model-catalog.json for the offline check
 *   Claude  ~/.claude/cache/model-catalog/*-cc.json (Claude Code's own catalog cache; the CLI has no list command)
 *
 * Catalogs differ per account, so "stale" is advice for whoever runs this, not repo truth.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, '../references/models.json'), 'utf8'));
const online = process.argv.includes('--online');
const maxAgeMs = config.cacheMaxAgeDays * 86400e3;

function run(cmd, args, timeoutMs = 20000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
  return r.status === 0 ? r.stdout : null;
}

// Each source returns { ids, age } or { skip: reason }.
// Codex's own ~/.codex/models_cache.json and `codex debug models` both list models a
// ChatGPT sign-in cannot run (gpt-6.1-sol passed both, then every review fell back on
// model_not_found). So --online runs each tracked model once and keeps only those that
// answer, and the offline check reads that snapshot, never the cache.
function codexRefuses(model) {
  const r = spawnSync('codex', ['exec', '-m', model, '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', 'Reply with OK.'],
    { encoding: 'utf8', timeout: 120000 });
  return /model_not_found|model is not supported/i.test(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
}
const snapshot = path.join(here, '../../../../tmp/model-catalog.json');

function codexCatalog() {
  if (online) {
    const out = run('codex', ['debug', 'models']);
    if (out === null) return { skip: '`codex debug models` failed (offline, signed out, or not installed)' };
    const listed = JSON.parse(out).models.filter((m) => m.visibility !== 'hide').map((m) => m.slug);
    const track = new RegExp(config.reviewers.codex.track);
    const ids = listed.filter((id) => !track.test(id) || !codexRefuses(id));
    mkdirSync(path.dirname(snapshot), { recursive: true });
    writeFileSync(snapshot, JSON.stringify({ fetchedAt: Date.now(), codex: ids }, null, 2) + '\n');
    return { ids, age: 0 };
  }
  if (!existsSync(snapshot)) return { skip: 'no snapshot of the live catalog yet; run node .agents/skills/toolkit-second-opinion/scripts/check-models.mjs --online' };
  const data = JSON.parse(readFileSync(snapshot, 'utf8'));
  return { ids: data.codex, age: Date.now() - data.fetchedAt };
}

function claudeCatalog() {
  const dir = path.join(homedir(), '.claude/cache/model-catalog');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('-cc.json')) : [];
  if (!files.length) return { skip: `no Claude Code catalog cache in ${dir}; open Claude Code once` };
  const file = files.map((f) => path.join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return { ids: (data.catalog?.config?.models ?? []).map((m) => m.id), age: Date.now() - data.fetchedAt };
}

function version(id, track) {
  const m = id.match(new RegExp(track));
  return m ? m[1].split(/[.-]/).map(Number) : null;
}
function newer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

const lines = [];
let stale = false;
const sources = { codex: codexCatalog, claude: claudeCatalog };

for (const [cli, pin] of Object.entries(config.reviewers)) {
  const cat = sources[cli]();
  if (cat.skip) { lines.push(`skip    ${cli}: ${cat.skip}`); continue; }
  if (!online && cat.age > maxAgeMs) {
    lines.push(`skip    ${cli}: catalog cache is ${Math.round(cat.age / 86400e3)} days old; run node .agents/skills/toolkit-second-opinion/scripts/check-models.mjs --online`);
    continue;
  }
  const family = cat.ids.filter((id) => version(id, pin.track));
  const latest = family.reduce((best, id) => (!best || newer(version(id, pin.track), version(best, pin.track)) ? id : best), null);
  if (!cat.ids.includes(pin.model)) {
    stale = true;
    lines.push(`STALE   ${cli}: ${pin.model} is not in this account's catalog${latest ? `; newest in its family is ${latest}` : ''}`);
  } else if (latest && latest !== pin.model) {
    stale = true;
    lines.push(`STALE   ${cli}: ${latest} is newer than the pinned ${pin.model}`);
  } else {
    lines.push(`ok      ${cli}: ${pin.model} is the newest of its family`);
  }
}

// The Codex default model follows the codex pin, so models.json is the one place
// to change it. --sync writes the pin into ~/.codex/config.toml; Claude Code needs
// nothing, because its settings use the `opus` alias, which tracks the newest Opus.
const codexConfig = path.join(homedir(), '.codex/config.toml');
if (existsSync(codexConfig)) {
  const toml = readFileSync(codexConfig, 'utf8');
  const current = toml.match(/^model\s*=\s*"([^"]*)"/m)?.[1];
  const pinned = config.reviewers.codex.model;
  if (current === pinned) {
    lines.push(`ok      ~/.codex/config.toml: default model is ${pinned}`);
  } else if (process.argv.includes('--sync')) {
    const next = current === undefined ? `model = "${pinned}"\n${toml}` : toml.replace(/^model\s*=\s*"[^"]*"/m, `model = "${pinned}"`);
    writeFileSync(codexConfig, next);
    lines.push(`synced  ~/.codex/config.toml: default model ${current ?? '(unset)'} -> ${pinned}`);
  } else {
    lines.push(`DRIFT   ~/.codex/config.toml: default model is ${current ?? '(unset)'}, the pin is ${pinned}; run node .agents/skills/toolkit-second-opinion/scripts/check-models.mjs --sync`);
  }
}

console.log(lines.map((l) => `check-models: ${l}`).join('\n'));
if (stale) console.log(`check-models: update ${path.relative(process.cwd(), path.join(here, '../references/models.json'))} and its "verified" date`);
process.exit(online && stale ? 1 : 0);
