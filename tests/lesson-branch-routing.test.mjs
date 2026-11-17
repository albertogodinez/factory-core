// Only factory-reflect's `lessons.mjs start` opens a lesson branch. It registers the branch, so the
// status hook names it while it waits for review, and triage adds to the one rolling lesson/triage
// branch. A skill that tells an agent to write on a lesson branch itself gets a hand-made branch
// (feature-map once did: `git worktree add -b lesson/<date>-<slug>` from a consumer session), which no
// session start names and which sits beside lesson/triage as a second review. Outside reflect and
// triage, a skill hands the edit over as a candidate, or names `lessons.mjs start`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, relative, sep } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'bundles', 'core');
const OWNERS = new Set(['factory-reflect', 'factory-triage']);

const mdFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? mdFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : []);

// Sentences that tell the agent to put an edit on a lesson branch, or build one with raw git.
const WRITES_ON_BRANCH = /\b(write|commit|edit)\b[^.]*\blesson branch\b/i;
const RAW_GIT = /git\s+(worktree\s+add|branch|checkout\s+-b|switch\s+-c)\b[^\n]*\blesson\//;
const ROUTED = /lessons\.mjs start|\bcandidate\b/;

export function violations(files) {
  const out = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const sentence of text.split(/(?<=[.!?][*_`)]*)\s+|\n\s*\n/)) {
      if ((WRITES_ON_BRANCH.test(sentence) || RAW_GIT.test(sentence)) && !ROUTED.test(sentence)) {
        out.push(`${relative(ROOT, f)}: ${sentence.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
      }
    }
  }
  return out;
}

test('outside reflect and triage, no core skill opens a lesson branch by hand', () => {
  const files = mdFiles(CORE).filter((f) => !OWNERS.has(relative(CORE, f).split(sep)[0]));
  assert.deepEqual(violations(files), []);
});
