#!/usr/bin/env node
// guide.mjs: a guided review for the plannotator-review gate, written before the gate opens.
//
//   guide.mjs prep --worktree <dir> --base <trunk> [--pr <url>] [--out <dir>]
//       writes <out>/<head>.patch (git diff <merge-base>), <head>.prompt.md (the brief for the
//       subagent that writes the guide) and names <head>.guide.json, where the guide goes
//   guide.mjs import --worktree <dir> --guide <file> --patch <file> [--pr <url>]
//       checks the guide covers the patch, then `plannotator guide import`, so the review lists it
//       under Guides; with --pr it's saved against that PR, and the gate reviews the PR itself
//
// The guide's method and schema come from Plannotator (`plannotator inbox call get_guide_brief`),
// so they follow its version. Prints JSON. node: imports only; plannotator runs locally.
import { writeFileSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export class GuideError extends Error { constructor(code, message) { super(message); this.code = code; } }
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new GuideError('git-failed', `git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

// Paths a unified diff touches, as the guide must name them (the b/ side; a/ for a deletion).
export function patchFiles(patch) {
  const files = [];
  for (const m of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) files.push(m[2] === '/dev/null' ? m[1] : m[2]);
  return [...new Set(files)];
}

// Every patch file in exactly one place: one section's diffs, or unplacedFiles.
export function checkCoverage(guide, files) {
  if (!guide || typeof guide !== 'object') return ['the guide must be a JSON object'];
  const problems = [];
  for (const k of ['title', 'intent']) if (typeof guide[k] !== 'string' || !guide[k].trim()) problems.push(`${k} is required`);
  if (!Array.isArray(guide.sections) || !guide.sections.length) problems.push('sections must be a non-empty array');
  if (!Array.isArray(guide.unplacedFiles)) problems.push('unplacedFiles must be an array (empty when every file is placed)');
  if (problems.length) return problems;
  const seen = new Map();
  const place = (f, where) => { if (seen.has(f)) problems.push(`${f} is in ${seen.get(f)} and ${where}`); else seen.set(f, where); };
  guide.sections.forEach((s, i) => (s.diffs || []).forEach((d) => place(d.file, `section ${i + 1}`)));
  guide.unplacedFiles.forEach((f) => place(f, 'unplacedFiles'));
  for (const f of seen.keys()) if (!files.includes(f)) problems.push(`${f} is not in the patch`);
  for (const f of files) if (!seen.has(f)) problems.push(`${f} is missing: place it in a section or unplacedFiles`);
  // A dash standing in for punctuation. Code spans (`--flag`, a quoted rule) don't count.
  const prose = [guide.title, guide.intent, ...guide.sections.map((s) => s.overview)].join('\n').replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  if (/—|\s--\s/.test(prose)) problems.push('no em-dashes, or " -- " standing in for one, in the prose');
  return problems;
}

function brief() {
  const r = spawnSync('plannotator', ['inbox', 'call', 'get_guide_brief'], { encoding: 'utf8' });
  if (r.status !== 0) throw new GuideError('no-plannotator', `plannotator inbox call get_guide_brief failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return JSON.parse(r.stdout);
}

export function prep({ worktree, base, pr, out, briefFn = brief }) {
  if (!worktree || !base) throw new GuideError('usage', '--worktree and --base are required');
  const wt = resolve(worktree);
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  const mergeBase = git(wt, 'merge-base', base, 'HEAD').trim();
  const patch = git(wt, 'diff', mergeBase);
  if (!patch.trim()) throw new GuideError('empty-diff', `no changes between ${base} and HEAD in ${wt}`);
  const files = patchFiles(patch);
  const dir = resolve(out || join(tmpdir(), 'factory-guides'));
  mkdirSync(dir, { recursive: true });
  const id = head.slice(0, 12);
  const patchFile = join(dir, `${id}.patch`), promptFile = join(dir, `${id}.prompt.md`), guideFile = join(dir, `${id}.guide.json`);
  writeFileSync(patchFile, patch);
  const b = briefFn();
  const log = git(wt, 'log', '--format=%h %s%n%n%b', `${mergeBase}..HEAD`).trim();
  writeFileSync(promptFile, [
    b.methodology,
    '\n## This changeset\n',
    `- Diff: read \`${patchFile}\`. It is the exact patch; don't run another diff.`,
    `- Changed files (authoritative, ${files.length}):\n${files.map((f) => `  - ${f}`).join('\n')}`,
    pr ? `- PR: ${pr} (read its title and body for the intent).` : '- No PR: infer the intent from the commits below.',
    `- Commits:\n\n\`\`\`\n${log}\n\`\`\``,
    '\n## Output\n',
    `Write only the guide JSON to \`${guideFile}\`, matching this schema, then stop:\n\n\`\`\`json\n${JSON.stringify(b.output_schema)}\n\`\`\``,
    `\nRules:\n${(b.rules || []).map((r) => `- ${r}`).join('\n')}`,
  ].join('\n'));
  return { head, base, mergeBase, files: files.length, patch: patchFile, prompt: promptFile, guide: guideFile, target: pr || wt,
    review: pr ? `plannotator review ${pr} --gate --json` : `plannotator review ${wt} --base ${base} --diff-type merge-base --gate --json` };
}

export function importGuide({ worktree, guide, patch, pr, model, run = spawnSync }) {
  if (!worktree || !guide || !patch) throw new GuideError('usage', '--worktree, --guide and --patch are required');
  let g;
  try { g = JSON.parse(readFileSync(guide, 'utf8')); } catch (e) { throw new GuideError('bad-guide', `${guide}: ${e.message}`); }
  const problems = checkCoverage(g, patchFiles(readFileSync(patch, 'utf8')));
  if (problems.length) throw new GuideError('bad-guide', problems.join('; '));
  // The same provenance Plannotator's own guide writer records (engine claude, model sonnet).
  if (model) g.generator = { engine: 'claude', model, generatedAt: Date.now(), ...(g.generator || {}) };
  writeFileSync(guide, JSON.stringify(g, null, 2) + '\n');
  const r = run('plannotator', ['guide', 'import', '--guide', guide, '--patch', patch, ...(pr ? ['--pr', pr] : [])], { cwd: resolve(worktree), encoding: 'utf8' });
  if (r.status !== 0) throw new GuideError('import-failed', (r.stderr || r.stdout || '').trim());
  return { imported: true, output: (r.stdout || '').trim(), pr: pr || null };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) o[rest[i].slice(2)] = rest[++i];
  try {
    const res = cmd === 'prep' ? prep(o) : cmd === 'import' ? importGuide(o) : (() => { throw new GuideError('usage', 'usage: guide.mjs prep|import (see the header of this file)'); })();
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } catch (e) {
    if (!(e instanceof GuideError)) throw e;
    process.stdout.write(JSON.stringify({ error: e.code, message: e.message }, null, 2) + '\n');
    process.exit(e.code === 'usage' ? 2 : 1);
  }
}
