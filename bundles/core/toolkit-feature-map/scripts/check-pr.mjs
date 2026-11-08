#!/usr/bin/env node
// PR-scoped audit: what a PR does to a feature map that check-map cannot see before the merge.
// Usage: check-map.mjs --pr <N> | --diff <base>...<head> [--worktree <path>] [--changes <file.json>]
//        [--map <dir>] [--cwd <dir>] [--strict] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { anchorRepo, mapDirFor, resolveContext } from './context.mjs';
import { parseFrontmatter } from './parse-frontmatter.mjs';
import { auditChanges, fromGithubFiles, parseNameStatus } from './pr-audit.mjs';
import { validate } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const strict = args.includes('--strict');
const asJson = args.includes('--json');

function fail(message) {
  console.error(`check-pr: ${message}`);
  process.exit(2);
}
if (!(flag('--pr') || flag('--diff') || flag('--changes'))) fail('usage: --pr <N> | --diff <base>...<head> [--worktree <path>] [--changes <file>] [--map <dir>] [--strict] [--json]');

let ctx;
try {
  ctx = resolveContext({ cwd: flag('--cwd') ?? process.cwd() });
} catch (error) {
  fail(error.message);
}
const repoName = ctx.project.name;
const mapDir = mapDirFor(ctx, flag('--map'));
if (!fs.existsSync(path.join(mapDir, 'features'))) fail(`no feature map at ${mapDir}`);

// An entry whose frontmatter doesn't parse can't be audited; report it and audit the rest.
const unparsed = [];
const entries = fs
  .readdirSync(path.join(mapDir, 'features'))
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .flatMap((name) => {
    const file = path.relative(ctx.project.root, path.join(mapDir, 'features', name));
    const parsed = parseFrontmatter(fs.readFileSync(path.join(mapDir, 'features', name), 'utf8'));
    if (parsed.error) {
      unparsed.push({ file, message: parsed.error });
      return [];
    }
    const { data } = parsed;
    // The audit covers the PR's own repo, so an omitted anchor repo means this project.
    const own = (anchor) => ({ ...anchor, repo: anchorRepo(ctx, anchor.repo)?.name ?? anchor.repo });
    return [{ id: data.id ?? path.basename(name, '.md'), file, code: (data.code ?? []).map(own), tests: (data.tests ?? []).map(own) }];
  });

const root = flag('--worktree') ? path.resolve(flag('--worktree')) : ctx.project.root;
let changes;
let readHead;
let label;
if (flag('--changes')) {
  changes = JSON.parse(fs.readFileSync(flag('--changes'), 'utf8'));
  label = `changes from ${flag('--changes')}`;
} else if (flag('--diff')) {
  const range = flag('--diff');
  if (!range.includes('...')) fail('--diff takes <base>...<head>');
  const head = range.split('...')[1] || 'HEAD';
  changes = parseNameStatus(execFileSync('git', ['-C', root, 'diff', '--name-status', '-M', range], { encoding: 'utf8' }));
  readHead = (file) => {
    try {
      return execFileSync('git', ['-C', root, 'show', `${head}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  label = `diff ${range}`;
} else {
  const number = flag('--pr');
  if (!/^\d+$/.test(number ?? '')) fail('--pr takes a PR number');
  const { slug, host } = ctx.project.remote ?? {};
  if (!slug) fail('no remote slug resolved; use --diff or --changes instead');
  const raw = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${slug}/pulls/${number}/files?per_page=100`], {
    encoding: 'utf8',
    env: host ? { ...process.env, GH_HOST: host } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  changes = fromGithubFiles(JSON.parse(raw).flat());
  label = `${slug}#${number}`;
}

const shape = validate(changes, JSON.parse(fs.readFileSync(path.join(HERE, '../schemas/changes.schema.json'), 'utf8')));
if (shape.length) fail(`changes do not match schemas/changes.schema.json: ${shape.join('; ')}`);

const result = auditChanges({ repo: repoName, changes, entries, readHead });
const failed = unparsed.length > 0 || result.errors.length > 0 || (strict && result.warnings.length > 0);

if (asJson) {
  console.log(JSON.stringify({ ok: !failed, label, changedFiles: changes.length, unparsed, ...result }, null, 2));
} else {
  console.log(`feature-map PR audit: ${repoName} ${label} (${changes.length} files)`);
  for (const u of unparsed) console.log(`error ${u.file}: ${u.message}`);
  for (const e of result.errors) console.log(`error ${e.file} [${e.feature}]: ${e.anchor} - ${e.message}`);
  for (const w of result.warnings) console.log(`warn  ${w.path}: ${w.message}`);
  if (result.touched.length > 0) {
    console.log('entries the PR touches:');
    for (const t of result.touched) console.log(`  ${t.file}  (${t.paths.length} path${t.paths.length === 1 ? '' : 's'})`);
  } else {
    console.log('no feature entry is touched');
  }
  console.log(failed ? `${unparsed.length} unparseable entr${unparsed.length === 1 ? 'y' : 'ies'}, ${result.errors.length} broken anchor(s), ${result.warnings.length} unanchored file(s)` : `no anchor breaks (${result.warnings.length} unanchored file(s))`);
}
process.exit(failed ? 1 : 0);
