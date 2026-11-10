#!/usr/bin/env node
// Append a well-formed row to a show-me-your-work decision log (TSV).
// Usage: log.mjs <slug|logfile> <phase> <decision> <why> <evidence> <result>
// A bare slug (no "/", "\", or ".tsv") writes to <stateRoot>/../decisions/<slug>.tsv, where
// stateRoot comes from the factory-context resolver. DECISIONS_DIR overrides that directory.
import { appendFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEADER = 'ts\tphase\tdecision\twhy\tevidence\tresult\n';
const fail = (msg) => { process.stderr.write(`log.mjs: ${msg}\n`); process.exit(1); };

// Strip tabs/newlines/CR so cells stay on one line, and prefix a cell whose first char a
// spreadsheet would parse as a formula (=, +, -, @) with a single quote.
export const clean = (v) => {
  const s = String(v).replace(/[\t\n\r]/g, ' ');
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};

function decisionsDir() {
  if (process.env.DECISIONS_DIR) return resolve(process.env.DECISIONS_DIR);
  const here = dirname(fileURLToPath(import.meta.url));
  const resolver = join(here, '..', '..', 'factory-context', 'scripts', 'resolve.mjs');
  let stateRoot;
  try {
    stateRoot = execFileSync(process.execPath, [resolver, '--field', 'stateRoot'], { encoding: 'utf8' }).trim();
  } catch {
    fail('could not resolve the state directory; install factory-context, or pass a log file path');
  }
  return join(stateRoot, '..', 'decisions');
}

export function logPath(target) {
  if (/[\\/]/.test(target) || target.endsWith('.tsv')) return resolve(target);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(target)) fail(`slug must match [A-Za-z0-9._-]+ and not start with ".": ${target}`);
  return join(decisionsDir(), `${target}.tsv`);
}

export function appendRow(logfile, cells, now = new Date()) {
  mkdirSync(dirname(logfile), { recursive: true });
  let empty = true;
  try { empty = statSync(logfile).size === 0; } catch { /* missing */ }
  // Append, never truncate: a network mount can report an existing log as empty, and then the
  // cost is one stray header line, not the rows.
  if (empty) appendFileSync(logfile, HEADER);
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  appendFileSync(logfile, [ts, ...cells.map(clean)].join('\t') + '\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.length !== 6) fail('usage: log.mjs <slug|logfile> <phase> <decision> <why> <evidence> <result>');
  const logfile = logPath(args[0]);
  appendRow(logfile, args.slice(1));
  process.stdout.write(`${logfile}\n`);
}
