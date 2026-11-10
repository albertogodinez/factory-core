#!/usr/bin/env node
// validate.mjs [--cwd <dir>] [--only <check>[,<check>]] [--skills <dir>] [--plans <dir>] [--verbose] [--list]
// Runs the skill-hygiene checks over <project.root>/.agents/skills and the plans directory
// (project.planHome from factory-context, default `plans`). Reads the files and changes nothing.
//
// Checks and their exit-code bits:
//    1  skill-frontmatter  SKILL.md name matches its directory; description present, at most 600 chars
//    2  main-guard         run-directly checks that compare argv[1] with import.meta.url use realpath
//    4  no-timeout         no `timeout` command in skill shell scripts
//    8  orphans            every scripts/ and references/ file is named by something else
//   16  plan-frontmatter   plans have title, status, repos, created
// Exit: 0 all pass; the sum of the failing checks' bits otherwise (with --only, that check's bit);
// 64 bad usage.
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, rel } from './lib.mjs';
import * as skillFrontmatter from './checks/skill-frontmatter.mjs';
import * as mainGuard from './checks/main-guard.mjs';
import * as noTimeout from './checks/no-timeout.mjs';
import * as orphans from './checks/orphans.mjs';
import * as planFrontmatter from './checks/plan-frontmatter.mjs';

export const CHECKS = [
  { name: 'skill-frontmatter', bit: 1, mod: skillFrontmatter },
  { name: 'main-guard', bit: 2, mod: mainGuard },
  { name: 'no-timeout', bit: 4, mod: noTimeout },
  { name: 'orphans', bit: 8, mod: orphans },
  { name: 'plan-frontmatter', bit: 16, mod: planFrontmatter },
];

const HERE = dirname(fileURLToPath(import.meta.url));

function usage(msg) {
  if (msg) console.error(`validate: ${msg}`);
  console.error('Usage: validate.mjs [--cwd <dir>] [--only <check>[,<check>]] [--skills <dir>] [--plans <dir>] [--verbose] [--list]');
  console.error(`Checks: ${CHECKS.map((c) => c.name).join(', ')}`);
  process.exit(64);
}

function parse(argv) {
  const o = { verbose: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose') o.verbose = true;
    else if (a === '--list') o.list = true;
    else if (['--cwd', '--only', '--skills', '--plans'].includes(a)) {
      if (argv[i + 1] === undefined) usage(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else usage(`unknown argument ${a}`);
  }
  return o;
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.list) {
    for (const c of CHECKS) console.log(`${String(c.bit).padStart(2)}  ${c.name}`);
    return;
  }
  let selected = CHECKS;
  if (o.only) {
    const names = o.only.split(',').filter(Boolean);
    const bad = names.filter((n) => !CHECKS.some((c) => c.name === n));
    if (bad.length) usage(`unknown check ${bad.join(', ')}`);
    selected = CHECKS.filter((c) => names.includes(c.name));
  }
  const ctx = context({
    cwd: resolve(o.cwd ?? process.cwd()),
    skills: o.skills && resolve(o.skills),
    plans: o.plans && resolve(o.plans),
    resolver: join(HERE, '../../factory-context/scripts/resolve.mjs'),
  });
  let code = 0;
  for (const c of selected) {
    const r = c.mod.run(ctx);
    if (r.findings.length === 0) {
      console.log(`${c.name}: ok (${r.summary})`);
      continue;
    }
    code |= c.bit;
    console.log(`${c.name}: ${r.findings.length} problem(s)`);
    for (const f of r.findings) console.log(`  ${rel(ctx.root, f.file)}${f.line ? `:${f.line}` : ''}  ${f.message}`);
    if (r.hint) console.log(`  -> ${r.hint}`);
  }
  if (o.verbose) console.log(`root ${ctx.root}\nskills ${ctx.skillsDir}\nplans ${ctx.plansDir}`);
  if (code) console.error(`validate: failed (exit ${code})`);
  process.exit(code);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
