// Fails when a skill shell script finds its own directory through `$0` where `$0` is wrong:
// after a `cd` (a relative `$0` now points nowhere), or in a file another skill script
// `source`s (there `$0` is the caller). `${BASH_SOURCE[0]}`, read before any `cd`, is right in both.
// Scope: `*.sh` under the skills directory. Matches `dirname "$0"`, `dirname -- "$0"` and `${0%/*}`.
// Skipped: comment lines and heredoc bodies. Zsh-only array subscripts are not detected.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { walk } from '../lib.mjs';

const SELF = /dirname\s+(?:--\s+)?"?\$0"?|\$\{0%\/\*\}|"\$0"\s*\)\s*\/\.\./;
const CD = /(?:^|[;&|(]|\bthen\b|\bdo\b)\s*cd\s/;

export function findSelfPaths(text, { sourced = false } = {}) {
  const hits = [];
  let heredoc = null, cdSeen = false;
  text.split('\n').forEach((raw, i) => {
    if (heredoc) { if (raw.trim() === heredoc) heredoc = null; return; }
    const m = raw.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (m) heredoc = m[2];
    if (/^\s*#/.test(raw)) return;
    if (SELF.test(raw) && (sourced || cdSeen)) hits.push({ line: i + 1, text: raw.trim(), why: sourced ? 'the file is sourced, so `$0` is the caller' : 'it follows a `cd`' });
    if (CD.test(raw)) cdSeen = true;
  });
  return hits;
}

export const FIX = 'Capture `HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)` once, before any `cd`, and build paths from `$HERE`.';

export function run({ skillsDir }) {
  const findings = [];
  const files = walk(skillsDir).filter((f) => f.endsWith('.sh'));
  const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const sourcedNames = new Set();
  for (const text of texts.values()) for (const m of text.matchAll(/(?:^|[;&|(]|\s)(?:source|\.)\s+"?[^\s"]*?([\w.-]+\.sh)"?/gm)) sourcedNames.add(m[1]);
  for (const [file, text] of texts) {
    for (const h of findSelfPaths(text, { sourced: sourcedNames.has(basename(file)) })) findings.push({ file, line: h.line, message: `\`$0\` is the wrong anchor here (${h.why}): ${h.text.slice(0, 120)}` });
  }
  return { findings, summary: `${files.length} shell script(s)`, hint: FIX };
}
