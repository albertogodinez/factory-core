#!/usr/bin/env node
// Which formal verify skills are stale against trunk, or touched by a PR or diff.
// Usage: check-drift.mjs [<verify-skill>...] [--fetch] [--strict] [--json]
//        check-drift.mjs --repo <repo> --pr <N> | --diff <base>...<head> [--worktree <path>] [--strict] [--json]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coveredPaths, missingSymbols, touchedChecks, validateCoverage } from './drift.mjs';

const PREFIX = 'toolkit-verify-';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--repo', '--pr', '--diff', '--worktree', '--root']);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// --root points at another project (its .ai-toolkit/project.json and .agents/skills); the tests use it.
const TOOLKIT_ROOT = flag('--root') ? path.resolve(flag('--root')) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SKILLS_DIR = path.join(TOOLKIT_ROOT, '.agents/skills');
const strict = args.includes('--strict');
const asJson = args.includes('--json');
const named = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));

function fail(message) {
  console.error(`check-drift: ${message}`);
  process.exit(2);
}

const git = (cwd, gitArgs) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const tryGit = (cwd, gitArgs) => {
  try {
    return git(cwd, gitArgs);
  } catch {
    return null;
  }
};

// A repo's root, trunk and remote come from the toolkit-context resolver, so the project's registry
// can live anywhere its project.json points.
const RESOLVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../toolkit-context/scripts/resolve.mjs');
const resolved = new Map();
function lookup(name) {
  if (!resolved.has(name)) {
    let repo = null;
    try {
      const out = execFileSync(process.execPath, [RESOLVER, '--cwd', TOOLKIT_ROOT, '--repo', name, '--no-cache'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      repo = JSON.parse(out).project;
    } catch {
      repo = null;
    }
    resolved.set(name, repo);
  }
  return resolved.get(name);
}

const skills = (named.length ? named : fs.readdirSync(SKILLS_DIR).filter((d) => d.startsWith(PREFIX))).map((name) => {
  const file = path.join(SKILLS_DIR, name, 'coverage.json');
  if (!fs.existsSync(file)) fail(`${name} has no coverage.json`);
  let cov;
  try {
    cov = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`${name}/coverage.json is not JSON: ${e.message}`);
  }
  const errors = validateCoverage(cov);
  if (errors.length) fail(`${name}/coverage.json:\n  ${errors.join('\n  ')}`);
  if (!lookup(cov.repo)) fail(`${name}: repo ${cov.repo} is not a registered repo of this project (toolkit-context --repo)`);
  for (const check of cov.checks)
    for (const rel of [check.model, check.config, check.view, ...(check.findings ?? []).map((f) => f.replay)].filter(Boolean))
      if (!fs.existsSync(path.join(SKILLS_DIR, name, rel))) fail(`${name}: ${check.id} names ${rel}, which is not in the skill`);
  return { name, cov };
});

const results = [];
const warnings = [];

if (flag('--pr') || flag('--diff')) {
  const repoName = flag('--repo') ?? fail('--pr and --diff need --repo <repo>');
  const repo = lookup(repoName) ?? fail(`${repoName} is not a registered repo of this project (toolkit-context --repo)`);
  let files;
  if (flag('--pr')) {
    const out = execFileSync('gh', ['api', '--paginate', `repos/${repo.remote.slug}/pulls/${flag('--pr')}/files`, '--jq', '.[] | .filename, (.previous_filename // empty)'], {
      encoding: 'utf8',
      env: { ...process.env, GH_HOST: repo.remote.host },
    });
    files = out.split('\n').filter(Boolean);
  } else {
    const root = flag('--worktree') ? path.resolve(flag('--worktree')) : repo.root;
    files = git(root, ['diff', '--name-only', '--no-renames', flag('--diff')]).split('\n').filter(Boolean);
  }
  for (const { name, cov } of skills.filter((s) => s.cov.repo === repoName)) {
    const touched = touchedChecks(cov, files);
    if (touched.length) results.push({ skill: name, status: 'touched', checks: touched });
  }
} else {
  for (const { name, cov } of skills) {
    const repo = lookup(cov.repo);
    const root = repo.root;
    if (!fs.existsSync(path.join(root, '.git'))) {
      warnings.push(`${name}: ${cov.repo} is not cloned at ${root}; skipped`);
      continue;
    }
    const trunk = `origin/${repo.trunk}`;
    if (args.includes('--fetch') && tryGit(root, ['fetch', '-q', 'origin', repo.trunk]) === null) fail(`${name}: git fetch origin ${repo.trunk} failed in ${root}`);
    if (tryGit(root, ['cat-file', '-e', `${cov.syncCommit}^{commit}`]) === null) fail(`${name}: syncCommit ${cov.syncCommit.slice(0, 12)} is not in ${root}; rerun with --fetch`);
    // An old ref that predates syncCommit gives an empty range, which would read as in sync.
    if (tryGit(root, ['merge-base', '--is-ancestor', cov.syncCommit, trunk]) === null) fail(`${name}: ${trunk} does not contain syncCommit ${cov.syncCommit.slice(0, 12)}; rerun with --fetch`);
    const trunkAt = git(root, ['log', '-1', '--format=%h %cs', trunk]).trim();
    const paths = coveredPaths(cov);
    const commits = git(root, ['log', '--format=%h %s', `${cov.syncCommit}..${trunk}`, '--', ...paths]).split('\n').filter(Boolean);
    const read = (p) => {
      const type = tryGit(root, ['cat-file', '-t', `${trunk}:${p}`])?.trim();
      if (!type) return null;
      return type === 'tree' ? (tryGit(root, ['grep', '-h', '--no-color', '-e', '', trunk, '--', p]) ?? '') : git(root, ['show', `${trunk}:${p}`]);
    };
    const missing = missingSymbols(cov, read);
    results.push({ skill: name, status: commits.length || missing.length ? 'stale' : 'in-sync', trunk, trunkAt, syncCommit: cov.syncCommit, commits, missing });
  }
}

const flagged = results.filter((r) => r.status !== 'in-sync');
if (asJson) {
  console.log(JSON.stringify({ results, warnings }, null, 2));
} else {
  for (const w of warnings) console.log(`warn    ${w}`);
  for (const r of results) {
    if (r.status === 'touched') {
      console.log(`touched ${r.skill}: follow its "Does my change touch it?" steps before the final push`);
      for (const c of r.checks) console.log(`          ${c.property}: ${c.files.join(', ')}`);
    } else if (r.status === 'stale') {
      console.log(`stale   ${r.skill}: ${r.commits.length} commit(s) on ${r.trunk} touch covered code since ${r.syncCommit.slice(0, 12)}; run maintain`);
      for (const c of r.commits) console.log(`          ${c}`);
      for (const m of r.missing) console.log(`          ${m.path}: ${m.symbol === null ? 'gone from trunk' : `no longer contains "${m.symbol}"`} (${m.check})`);
    } else {
      console.log(`in sync ${r.skill} at ${r.syncCommit.slice(0, 12)} (${r.trunk} is ${r.trunkAt}; --fetch to refresh it)`);
    }
  }
  if (!results.length && !warnings.length) console.log(flag('--pr') || flag('--diff') ? 'check-drift: the change touches no verified code' : 'check-drift: no verify skills');
}
process.exit(strict && flagged.length ? 1 : 0);
