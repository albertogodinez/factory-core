// Fails when a committed note cites a session scratchpad path. The scratchpad is session-local
// scratch space that a reboot or cleanup clears, so a recipe or evidence pointer that names it
// is dead for the next reader. Scope: `*.md` under the skills directory and the plans directory.
// A hit is a path under /tmp, /private/tmp or /var/folders that has a `scratchpad` segment.
// The bare word "scratchpad" is fine; only a path is flagged. A PR body is not a file here, so
// `factory-pr-create`'s body check is the place for it.
import { readFileSync } from 'node:fs';
import { walk } from '../lib.mjs';

const PATH = /(?:\/private)?(?:\/tmp|\/var\/folders)\/[^\s)`'"<>]*\/scratchpad(?:\/[^\s)`'"<>]*)?/;

export function findScratchpadPaths(text) {
  const hits = [];
  text.split('\n').forEach((raw, i) => {
    const m = PATH.exec(raw);
    if (m) hits.push({ line: i + 1, text: m[0] });
  });
  return hits;
}

export const FIX = 'A session scratchpad is cleared between sessions, so the path is dead for the next reader. Commit the recipe or script into the repo, or cite a durable path, PR or command that reproduces the evidence.';

export function run({ skillsDir, plansDir }) {
  const findings = [];
  const files = [...walk(skillsDir), ...walk(plansDir)].filter((f) => f.endsWith('.md'));
  for (const file of files) {
    for (const h of findScratchpadPaths(readFileSync(file, 'utf8'))) findings.push({ file, line: h.line, message: `cites a session scratchpad path: ${h.text.slice(0, 120)}` });
  }
  return { findings, summary: `${files.length} note(s)`, hint: FIX };
}
