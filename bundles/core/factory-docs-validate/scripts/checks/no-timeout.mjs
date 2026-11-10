// Fails when a skill shell script runs `timeout` as a command. macOS ships no `timeout`, so the
// call dies with `command not found` and the guarded step never runs. Scope: `*.sh` under the
// skills directory. Shell snippets embedded in .mjs/.js (execSync, spawn with a shell) are not
// scanned: finding them reliably needs a parser.
// A hit is a command-position `timeout`: line start, or after ; && || | ( $( then do else, with
// optional env assignments or exec/command/env/nohup/sudo before it. Skipped: comment lines,
// heredoc bodies, quoted strings, and `gtimeout`, `--timeout`, `timeout_ms`, `$TIMEOUT`.
import { readFileSync } from 'node:fs';
import { walk } from '../lib.mjs';

const CMD = /(?:^|[;&|(]|\bthen\b|\bdo\b|\belse\b)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:exec|command|env|nohup|sudo)\s+)*timeout(?:\s|$)/;

export function findTimeouts(text) {
  const hits = [];
  let heredoc = null;
  text.split('\n').forEach((raw, i) => {
    if (heredoc) {
      if (raw.trim() === heredoc) heredoc = null;
      return;
    }
    const m = raw.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (m) heredoc = m[2];
    if (/^\s*#/.test(raw)) return;
    const code = raw
      .replace(/'[^']*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, (s) => (s.includes('$(') ? s : '""'))
      .replace(/\s#\s.*$/, '');
    if (CMD.test(code)) hits.push({ line: i + 1, text: raw.trim() });
  });
  return hits;
}

export const FIX = 'macOS has no `timeout` ("command not found"), so the guarded step never runs. Run the command as a background job and `kill` it after a bounded wait loop, or use the tool\'s own --timeout flag.';

export function run({ skillsDir }) {
  const findings = [];
  const files = walk(skillsDir).filter((f) => f.endsWith('.sh'));
  for (const file of files) {
    for (const h of findTimeouts(readFileSync(file, 'utf8'))) findings.push({ file, line: h.line, message: `\`timeout\` used as a command: ${h.text.slice(0, 120)}` });
  }
  return { findings, summary: `${files.length} shell script(s)`, hint: FIX };
}
