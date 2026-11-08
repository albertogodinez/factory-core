// Fails when a skill script decides it was run directly by comparing process.argv[1] with
// import.meta.url without resolving symlinks. Agents reach skills through the .claude/skills
// symlink, so argv[1] is the symlinked path and import.meta.url the real one: the paths differ, the
// script does nothing and exits 0. Resolve both with realpathSync before comparing.
// Scope: .mjs and .js files under the skills directory, tests excluded; a line that names both
// argv[1] and import.meta.url.
import { readFileSync } from 'node:fs';
import { isTest, walk } from '../lib.mjs';

/** Lines that compare argv[1] with import.meta.url and resolve neither through realpath. */
export function findUnresolvedGuards(text) {
  return text
    .split('\n')
    .map((raw, i) => ({ line: i + 1, text: raw.trim() }))
    .filter(({ text: t }) => !t.startsWith('//') && /process\.argv\[1\]/.test(t) && /import\.meta\.url/.test(t) && !/realpath/i.test(t));
}

export const FIX = 'Through the .claude/skills symlink the paths never match, so the script does nothing and exits 0. Use `process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`.';

export function run({ skillsDir }) {
  const findings = [];
  const files = walk(skillsDir).filter((f) => /\.(mjs|js)$/.test(f) && !isTest(f));
  for (const file of files) {
    for (const h of findUnresolvedGuards(readFileSync(file, 'utf8'))) findings.push({ file, line: h.line, message: `run-directly check without realpath: ${h.text.slice(0, 120)}` });
  }
  return { findings, summary: `${files.length} script(s)`, hint: FIX };
}
