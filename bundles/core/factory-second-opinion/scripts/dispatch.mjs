#!/usr/bin/env node
/**
 * Run a review prompt on the other vendor's CLI: Codex when called from Claude
 * Code, Claude when called from Codex. Read-only on both sides.
 *
 *   node dispatch.mjs --preflight [--to codex|claude] [--model <id>]   which reviewer would run, or why it cannot
 *   node dispatch.mjs --prompt <file> --out <file> [--cd <dir>] [--to codex|claude] [--model <id>]
 *
 * --model runs a model other than the pin in references/models.json, for a request
 * that names one. The result then carries "pinned" so the override is visible.
 *
 * Prints one JSON line and exits:
 *   0  {"status":"ok","reviewer":"codex","model":"gpt-6-sol",...}     the review is in --out
 *   2  {"status":"fallback","reason":"..."}                         dispatch a same-harness subagent instead
 *   3  {"status":"nested"}                                          already inside a second opinion; do nothing
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, '../references/models.json'), 'utf8'));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

function runCli(cli, args, options = {}) {
  const key = `FACTORY_${cli.toUpperCase()}_BIN`;
  const bin = process.env[key] || cli;
  let prefix = [];
  const raw = process.env[`${key}_ARGS`];
  if (raw) {
    try { prefix = JSON.parse(raw); } catch { return { status: null, error: new Error(`${key}_ARGS must be a JSON array`) }; }
    if (!Array.isArray(prefix) || prefix.some((x) => typeof x !== 'string')) return { status: null, error: new Error(`${key}_ARGS must be a JSON array of strings`) };
  }
  return spawnSync(bin, [...prefix, ...args], options);
}

function emit(code, payload) {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

if (process.env.TOOLKIT_SECOND_OPINION === 'reviewer') emit(3, { status: 'nested' });

// The nearest claude or codex process above us is the harness. Env markers leak
// into child processes, so they only break a tie when the process walk finds nothing.
function detectHarness() {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' });
    const m = (r.stdout || '').trim().match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    const name = path.basename(m[2]).toLowerCase();
    if (name === 'claude' || name.startsWith('claude-')) return 'claude';
    if (name === 'codex' || name.startsWith('codex-')) return 'codex';
    pid = Number(m[1]);
  }
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) return 'codex';
  if (process.env.CLAUDECODE) return 'claude';
  return null;
}

function ready(cli) {
  if (cli === 'codex') {
    const r = runCli('codex', ['login', 'status'], { timeout: 15000 });
    if (r.error?.code === 'ENOENT') return 'codex is not installed';
    return r.status === 0 ? null : 'codex is not signed in (`codex login`)';
  }
  const r = runCli('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
  if (r.error?.code === 'ENOENT') return 'claude is not installed';
  try {
    return JSON.parse(r.stdout).loggedIn ? null : 'claude is not signed in (`claude auth login`)';
  } catch {
    return 'claude auth status gave no answer';
  }
}

const harness = detectHarness();
const target = arg('--to') ?? (harness === 'claude' ? 'codex' : harness === 'codex' ? 'claude' : null);
if (!target) emit(2, { status: 'fallback', reason: 'could not tell which harness this is' });
const pin = config.reviewers[target];
const hasOverride = process.argv.includes('--model');
const override = hasOverride ? arg('--model') : undefined;
if (hasOverride && (!override || override.startsWith('--'))) emit(2, { status: 'fallback', reason: 'usage: --model <id>' });
const requested = override ?? pin.model;
const overrideNote = override && override !== pin.model ? { pinned: pin.model } : {};
const notReady = ready(target);
if (notReady) emit(2, { status: 'fallback', reason: notReady, harness });
if (process.argv.includes('--preflight')) emit(0, { status: 'ready', harness, reviewer: target, model: requested, ...overrideNote });

const promptFile = arg('--prompt');
const outFile = arg('--out');
if (!promptFile || !outFile) emit(2, { status: 'fallback', reason: 'usage: --prompt <file> --out <file>' });
const cwd = path.resolve(arg('--cd') ?? process.cwd());
const prompt = readFileSync(promptFile, 'utf8');
const treeBefore = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;

const env = { ...process.env, TOOLKIT_SECOND_OPINION: 'reviewer' };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) {
  if (target === 'claude') delete env[k];
}

let r;
let model = requested;
if (target === 'codex') {
  r = runCli('codex', ['exec', '-m', requested, '-c', `model_reasoning_effort="${pin.effort}"`,
    '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C', cwd, '-o', outFile, '-'],
  { input: prompt, encoding: 'utf8', env, timeout: config.reviewTimeoutSeconds * 1000, maxBuffer: 64 << 20 });
} else {
  r = runCli('claude', ['-p', '--model', requested, '--effort', pin.effort, '--output-format', 'json',
    '--no-session-persistence', '--max-budget-usd', String(config.claudeMaxBudgetUsd),
    '--permission-mode', 'dontAsk', '--tools', 'Read', 'Grep', 'Glob', 'Bash',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)'],
  { input: prompt, encoding: 'utf8', env, cwd, timeout: config.reviewTimeoutSeconds * 1000, maxBuffer: 64 << 20 });
  if (r.status === 0) {
    try {
      const result = JSON.parse(r.stdout);
      model = Object.keys(result.modelUsage ?? {})[0] ?? model;
      writeFileSync(outFile, result.result ?? '');
    } catch {
      emit(2, { status: 'fallback', reason: 'claude returned output that is not JSON', reviewer: target });
    }
  }
}

if (r.error?.code === 'ETIMEDOUT') emit(2, { status: 'fallback', reason: `${target} timed out after ${config.reviewTimeoutSeconds}s`, reviewer: target });
if (r.status !== 0) {
  const detail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const reason = !/model_not_found|model is not supported/i.test(detail) ? null
    : override ? `${target} cannot run the requested ${requested} (model_not_found); check the id with ${target === 'codex' ? 'codex debug models' : 'claude --model <id> -p hi'}`
    : `${target} cannot run the pinned ${pin.model} (model_not_found); run check-models.mjs --online and re-pin references/models.json`;
  emit(2, { status: 'fallback', reason: reason ?? `${target} exited ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}`, reviewer: target });
}

let review = '';
try { review = readFileSync(outFile, 'utf8').trim(); } catch { /* reported below */ }
if (!review) emit(2, { status: 'fallback', reason: `${target} returned an empty review`, reviewer: target });

const treeAfter = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
emit(0, {
  status: 'ok', harness, reviewer: target, model, ...overrideNote, out: outFile,
  ...(treeAfter !== treeBefore ? { warning: 'the working tree changed during the review; inspect git status' } : {}),
});
