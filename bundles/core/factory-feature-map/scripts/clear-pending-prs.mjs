#!/usr/bin/env node
// Clear `pending_pr` from feature-map entries whose PR has merged. Run it after a merge
// (factory-pr-ci-monitor, teardown). It reads each PR's state with gh, so it is not a pre-commit check.
//
//   node clear-pending-prs.mjs [--pr <url>] [--cwd <dir> | --skills-dir <dir>] [--apply]
//
// --skills-dir scans a directory of skills instead of the project's .agents/skills: a bundle
// source, where a map installed in other repos is edited.
//
// Without --apply it reports what it would do. Per entry:
//   MERGED  -> remove the pending_pr line (with --apply)
//   OPEN    -> keep
//   CLOSED  -> keep, and say so: the entry describes code that never landed; revert those parts by hand
// Exit 0: done (also when nothing is pending). 2: usage, no project, or gh failed for a PR.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAP_PREFIX, resolveContext } from './context.mjs';

const LINE = /^pending_pr:[ \t]*['"]?(\S+?)['"]?[ \t]*\r?\n/m;

/** The pending PR URL in an entry's frontmatter, or undefined. */
export function pendingPrOf(text) {
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  if (end === -1) return undefined;
  return LINE.exec(text.slice(0, end + 1))?.[1];
}

/** The entry with its pending_pr line removed; everything else unchanged. */
export function withoutPendingPr(text) {
  const end = text.indexOf('\n---', 3);
  return text.slice(0, end + 1).replace(LINE, '') + text.slice(end + 1);
}

export function entries(skills) {
  if (!existsSync(skills)) return [];
  return readdirSync(skills)
    .filter((name) => name.startsWith(MAP_PREFIX))
    .map((name) => join(skills, name, 'features'))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => join(dir, f)));
}

function prState(url) {
  const host = new URL(url).host;
  return execFileSync('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state'], {
    encoding: 'utf8',
    env: { ...process.env, GH_HOST: host },
  }).trim();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const apply = argv.includes('--apply');
  const only = value('--pr');
  const flagWithoutValue = ['--pr', '--cwd', '--skills-dir'].some((f) => argv.includes(f) && !value(f));
  if (flagWithoutValue || (argv.includes('--cwd') && argv.includes('--skills-dir'))) {
    console.error('usage: clear-pending-prs.mjs [--pr <url>] [--cwd <dir> | --skills-dir <dir>] [--apply]');
    process.exit(2);
  }
  let root, skills = value('--skills-dir');
  if (skills) root = skills;
  else {
    try {
      root = resolveContext({ cwd: value('--cwd') ?? process.cwd() }).project.root;
    } catch (error) {
      console.error(`clear-pending-prs: ${error.message}`);
      process.exit(2);
    }
    skills = join(root, '.agents/skills');
  }
  const pending = entries(skills).map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .map((e) => ({ ...e, url: pendingPrOf(e.text) }))
    .filter((e) => e.url && (!only || e.url === only));
  if (!pending.length) console.log(`no entry has pending_pr${only ? ` ${only}` : ''}`);
  const states = new Map();
  for (const entry of pending) {
    let state = states.get(entry.url);
    if (!state) {
      try {
        state = prState(entry.url);
      } catch (error) {
        console.error(`gh pr view ${entry.url} failed: ${error.message.split('\n')[0]}`);
        process.exit(2);
      }
      states.set(entry.url, state);
    }
    const where = relative(root, entry.file);
    if (state === 'MERGED') {
      if (apply) writeFileSync(entry.file, withoutPendingPr(entry.text));
      console.log(`${apply ? 'removed' : 'would remove'} pending_pr from ${where} (${entry.url} merged)`);
    } else if (state === 'CLOSED') {
      console.log(`${where}: ${entry.url} closed without merging; the entry describes code that never landed, so revert those parts and drop pending_pr`);
    } else {
      console.log(`${where}: ${entry.url} is ${state}; keeping pending_pr`);
    }
  }
}
