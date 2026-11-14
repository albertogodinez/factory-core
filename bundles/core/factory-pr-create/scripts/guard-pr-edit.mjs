#!/usr/bin/env node
// PreToolUse hook for Bash: a `gh pr edit` or `gh pr create` that sends a body file runs check-pr-body.mjs on that
// file first, and is refused (exit 2) when the check has findings. An inline `gh pr edit --body …` is refused
// outright: it replaces the live body from a string no one checked. Everything else passes.
// Reads the hook's JSON on stdin; prints the check's findings on stderr.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'check-pr-body.mjs');
let command = '';
try { command = JSON.parse(readFileSync(0, 'utf8')).tool_input?.command ?? ''; } catch {}
const pr = /\bgh\s+pr\s+(edit|create)\b/.exec(command);
if (!pr) process.exit(0);
const file = /--body-file[ =]\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
if (!file) {
  if (pr[1] === 'edit' && /\s--body[ =]/.test(command)) {
    console.error('Refused: gh pr edit --body replaces the live body from an unchecked string. Fetch the live body to a file, edit it, run check-pr-body.mjs, then pass --body-file.');
    process.exit(2);
  }
  process.exit(0);
}
const path = resolve(file[1] ?? file[2] ?? file[3]);
if (!existsSync(path)) process.exit(0);
const r = spawnSync(process.execPath, [CHECK, path], { encoding: 'utf8' });
if (r.status === 1) {
  console.error(`Refused: ${path} fails check-pr-body.mjs. Fix the body, then send it.\n${r.stderr}`);
  process.exit(2);
}
process.exit(0);
