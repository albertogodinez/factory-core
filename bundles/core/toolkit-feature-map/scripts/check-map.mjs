#!/usr/bin/env node
// Check a repo's feature map: frontmatter, section order, index links, anchors, inventory.
// Usage: check-map.mjs [--map <dir>] [--cwd <dir>] [--strict] [--json] [--verbose]
//        check-map.mjs --pr <N> | --diff <base>...<head> | --changes <file>   (PR audit, see check-pr.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { anchorRepo, mapDirFor, resolveContext } from './context.mjs';
import { historyLines } from './history-lines.mjs';
import { parseFrontmatter } from './parse-frontmatter.mjs';
import { loadDesignAuthorityPolicy } from './resolve-design-authority.mjs';
import { validate } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(HERE, '../schemas');
const REQUIRED_SECTIONS = ['Sub-features', 'How to get to it (user POV)', 'Driving it with', 'Where to change it', 'Gotchas'];
const KNOWN_KEYS = new Set(['id', 'title', 'status', 'summary', 'aliases', 'covers', 'sources', 'pending_pr', 'app_recipe', 'code', 'tests', 'last_verified']);

const args = process.argv.slice(2);
if (args.includes('--pr') || args.includes('--diff') || args.includes('--changes')) {
  const run = spawnSync(process.execPath, [path.join(HERE, 'check-pr.mjs'), ...args], { stdio: 'inherit' });
  process.exit(run.status ?? 2);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const strict = args.includes('--strict');
const asJson = args.includes('--json');
const verbose = args.includes('--verbose');

let ctx;
try {
  ctx = resolveContext({ cwd: flag('--cwd') ?? process.cwd() });
} catch (error) {
  console.error(`check-map: ${error.message}`);
  process.exit(2);
}
const ROOT = ctx.project.root;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const entrySchema = readJson(path.join(SCHEMA_DIR, 'entry.schema.json'));
const inventorySchema = readJson(path.join(SCHEMA_DIR, 'inventory.schema.json'));

const findings = [];
const rel = (file) => path.relative(ROOT, file) || file;
const report = (severity, file, message) => findings.push({ severity, file: rel(file), message });
const branchCache = new Map();

function currentBranch(root) {
  if (!branchCache.has(root)) {
    try {
      branchCache.set(root, execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch {
      branchCache.set(root, null);
    }
  }
  return branchCache.get(root);
}

function filesUnder(target) {
  if (fs.statSync(target).isFile()) return [target];
  return fs.readdirSync(target, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((source) => !source.includes(`${path.sep}node_modules${path.sep}`));
}

// Returns false when the anchor was checked on a stable branch and did not resolve.
// The project's own anchors ship in the same commit as the map, so they are always errors.
// A neighbor's anchors are errors only while that neighbor is on its trunk.
function checkAnchor(file, anchor, label, pendingPr) {
  const repo = anchorRepo(ctx, anchor.repo);
  if (!repo) {
    report('error', file, `${label} repo "${anchor.repo}" is neither this project nor one of its neighbors`);
    return true;
  }
  if (!fs.existsSync(path.join(repo.root, '.git'))) {
    report('warn', file, `${label} ${repo.name} is not cloned at ${repo.root}; skipped ${anchor.path}`);
    return true;
  }
  const branch = currentBranch(repo.root);
  const stable = repo.own || (repo.trunk && branch === repo.trunk);
  const severity = stable && !pendingPr ? 'error' : 'warn';
  const where = !stable ? ` (${repo.name} is on ${branch}, not ${repo.trunk ?? 'its trunk'})` : pendingPr ? ` (waiting on ${pendingPr})` : '';
  const target = path.join(repo.root, anchor.path);
  if (!fs.existsSync(target)) {
    report(severity, file, `${label} ${repo.name}:${anchor.path} does not exist${where}`);
    return !stable;
  }
  let resolved = true;
  const symbols = anchor.symbols ?? [];
  if (symbols.length === 0) return resolved;
  const text = filesUnder(target).map((source) => fs.readFileSync(source, 'utf8')).join('\n');
  for (const symbol of symbols) {
    if (text.includes(symbol)) continue;
    report(severity, file, `${label} ${repo.name}:${anchor.path} no longer contains "${symbol}"${where}`);
    if (stable) resolved = false;
  }
  return resolved;
}

// app_recipe is replayed by the map's own scripts/replay-app.mjs; its --check needs no browser.
function checkAppRecipe(file, recipe) {
  const mapDir = path.resolve(path.dirname(file), '..');
  const target = path.join(mapDir, recipe);
  const runner = path.join(mapDir, 'scripts/replay-app.mjs');
  if (!fs.existsSync(target)) return report('error', file, `app_recipe "${recipe}" does not exist`);
  if (!fs.existsSync(runner)) return report('error', file, `app_recipe "${recipe}" has no scripts/replay-app.mjs in its map to replay it`);
  try {
    execFileSync(process.execPath, [runner, '--check', target], { stdio: 'pipe' });
  } catch (error) {
    report('error', file, `app_recipe "${recipe}" fails replay-app.mjs --check: ${String(error.stderr).trim()}`);
  }
}

function checkSections(file, body) {
  const headings = [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
  let cursor = 0;
  for (const section of REQUIRED_SECTIONS) {
    const index = headings.findIndex((heading, position) => position >= cursor && heading.startsWith(section));
    if (index === -1) {
      report('error', file, `missing or out-of-order section "## ${section}"`);
      continue;
    }
    cursor = index + 1;
  }
}

function checkHistory(file, raw) {
  const hits = historyLines(raw);
  if (hits.length === 0) return;
  const shown = hits.slice(0, 5).map(({ line, kind }) => `${kind} at line ${line}`).join(', ');
  const more = hits.length > 5 ? `, and ${hits.length - 5} more` : '';
  report(strict ? 'error' : 'warn', file, `${hits.length} line(s) read as history (${shown}${more}); see entry-contract.md "What an entry leaves out"`);
}

function checkEntry(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parseFrontmatter(raw);
  if (parsed.error) {
    report('error', file, parsed.error);
    return null;
  }
  for (const warning of parsed.warnings) report('warn', file, warning);
  const data = parsed.data;
  const errors = validate(data, entrySchema);
  if (errors.length) {
    for (const message of errors) report('error', file, `frontmatter ${message}`);
    return null;
  }
  for (const key of Object.keys(data)) if (!KNOWN_KEYS.has(key)) report('warn', file, `unknown frontmatter key "${key}" is ignored`);
  if (data.id !== path.basename(file, '.md')) report('error', file, `id "${data.id}" does not match the filename`);

  checkSections(file, parsed.content);
  checkHistory(file, raw);
  if (data.app_recipe) checkAppRecipe(file, data.app_recipe);
  const pending = data.pending_pr;
  const results = [
    ...data.code.map((anchor) => checkAnchor(file, anchor, 'code', pending)),
    ...(data.tests ?? []).map((anchor) => checkAnchor(file, anchor, 'test', pending)),
  ];
  if (pending) {
    report('warn', file, results.every(Boolean)
      ? `pending_pr ${pending}: every anchor resolves, so it has likely merged; run scripts/clear-pending-prs.mjs --apply`
      : `describes ${pending}, which has not landed yet; scripts/clear-pending-prs.mjs --apply clears it after the merge`);
  }
  return data;
}

function checkIndex(mapDir, featureFiles) {
  const indexFile = path.join(mapDir, 'features/README.md');
  if (!fs.existsSync(indexFile)) return report('error', indexFile, 'feature index is missing');
  const linked = new Set([...fs.readFileSync(indexFile, 'utf8').matchAll(/\]\(\.\/([^)#]+\.md)\)/g)].map((match) => match[1]));
  const present = new Set(featureFiles.map((file) => path.basename(file)));
  for (const name of present) if (!linked.has(name)) report('error', indexFile, `index does not link ${name}`);
  for (const name of linked) if (!present.has(name)) report('error', indexFile, `index links missing file ${name}`);
}

function checkDesignAuthority(mapDir) {
  const policyFile = path.join(mapDir, 'design-authority.json');
  if (!fs.existsSync(policyFile)) {
    return report('error', policyFile, 'design authority policy is missing; set defaultDesignAuthority to null when the repo has no default');
  }
  try {
    loadDesignAuthorityPolicy({ root: ROOT, mapDir });
  } catch (error) {
    report('error', policyFile, error.message);
  }
}

function checkInventory(mapDir, entries) {
  const script = path.join(mapDir, 'scripts/inventory.mjs');
  if (!fs.existsSync(script)) return;
  let inventory;
  try {
    inventory = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: ROOT }));
  } catch (error) {
    return report('error', script, `inventory failed: ${error.message.split('\n')[0]}`);
  }
  const shapeErrors = validate(inventory, inventorySchema);
  if (shapeErrors.length) {
    for (const message of shapeErrors) report('error', script, `inventory output ${message}`);
    return;
  }
  if (inventory.skipped) return report('warn', script, `inventory skipped: ${inventory.skipped}`);
  const duplicates = inventory.items.map((item) => item.id).filter((id, index, ids) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicates)) report('error', script, `inventory reports "${id}" more than once`);

  const known = new Map(inventory.items.map((item) => [item.id, item]));
  const covered = new Map();
  for (const { file, data } of entries) for (const id of data.covers ?? []) covered.set(id, file);
  for (const [id, file] of covered) if (!known.has(id)) report('error', file, `covers "${id}", which the inventory no longer reports`);
  const unmapped = [...known.values()].filter((item) => !covered.has(item.id));
  if (unmapped.length === 0) return;
  const indexFile = path.join(mapDir, 'features/README.md');
  if (strict || verbose) {
    for (const item of unmapped) report(strict ? 'error' : 'warn', indexFile, `unmapped ${item.kind} "${item.id}" (${item.source})`);
  } else {
    report('warn', indexFile, `${unmapped.length} of ${known.size} inventory items unmapped (--verbose lists them)`);
  }
}

const mapDir = mapDirFor(ctx, flag('--map'));
if (!fs.existsSync(mapDir)) {
  report('error', mapDir, 'feature map directory does not exist; create one with references/create.md');
} else {
  const featuresDir = path.join(mapDir, 'features');
  const featureFiles = fs.existsSync(featuresDir)
    ? fs.readdirSync(featuresDir).filter((name) => name.endsWith('.md') && name !== 'README.md').map((name) => path.join(featuresDir, name))
    : [];
  checkIndex(mapDir, featureFiles);
  checkDesignAuthority(mapDir);
  const entries = featureFiles.map((file) => ({ file, data: checkEntry(file) })).filter((entry) => entry.data);
  checkInventory(mapDir, entries);
}

const errors = findings.filter((finding) => finding.severity === 'error');
if (asJson) {
  console.log(JSON.stringify({ ok: errors.length === 0, findings }, null, 2));
} else {
  for (const { severity, file, message } of findings) console.log(`${severity === 'error' ? 'error' : 'warn '} ${file}: ${message}`);
  console.log(errors.length === 0 ? 'feature map OK' : `${errors.length} feature map error(s)`);
}
process.exit(errors.length === 0 ? 0 : 1);
