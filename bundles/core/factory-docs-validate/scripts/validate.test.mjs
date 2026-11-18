// validate.mjs over throwaway repos: one clean fixture and one with a defect for every check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, tempRoot } from '../../../../tests/fixtures/make.mjs';
import { findUnresolvedGuards } from './checks/main-guard.mjs';
import { findTimeouts } from './checks/no-timeout.mjs';
import { findSelfPaths } from './checks/script-self-path.mjs';
import { findScratchpadPaths } from './checks/scratchpad-evidence.mjs';
import { checkSkillText } from './checks/skill-frontmatter.mjs';
import { checkPlanText } from './checks/plan-frontmatter.mjs';
import { parseFrontmatter } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE = join(HERE, 'validate.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [VALIDATE, '--cwd', cwd, ...args], { encoding: 'utf8' });

const skill = (name, description = 'Does a thing.') => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
const goodPlan = '---\ntitle: A plan\nstatus: active\nrepos: [app, lib]\ncreated: 2026-01-02\n---\nBody\n';
const guard = (real) => `if (process.argv[1] && ${real ? 'realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))' : 'process.argv[1] === fileURLToPath(import.meta.url)'}) main();\n`;

let t, clean, broken;
before(() => {
  t = tempRoot('docs-validate-');
  clean = makeRepo(join(t.root, 'clean'), {
    files: {
      '.agents/skills/alpha/SKILL.md': skill('alpha', 'Runs scripts/run.mjs and reads references/notes.md.'),
      '.agents/skills/alpha/scripts/run.mjs': guard(true),
      '.agents/skills/alpha/scripts/run.test.mjs': 'x',
      '.agents/skills/alpha/references/notes.md': 'notes',
      'plans/feat-a.md': goodPlan,
      'plans/README.md': 'no frontmatter, ignored',
    },
  });
  broken = makeRepo(join(t.root, 'broken'), {
    files: {
      '.agents/factory-metadata/project.json': { version: 1, planHome: 'work/plans' },
      '.agents/skills/alpha/SKILL.md': skill('wrong-name'),
      '.agents/skills/beta/scripts/go.mjs': guard(false),
      '.agents/skills/beta/scripts/wait.sh': '#!/bin/sh\ntimeout 5 sleep 1\n',
      '.agents/skills/beta/scripts/unused-helper.mjs': 'export {};\n',
      '.agents/skills/beta/references/unused-notes.md': 'nobody names me',
      'work/plans/bad.md': '---\ntitle: Bad\nstatus: nearly\nrepos: []\ncreated: 2026-13-40\n---\n',
      'plans/ignored.md': 'not the plan home',
      '.agents/skills/beta/references/recipe.md': 'Run /private/tmp/claude-502/-Users-me-repo/abc/scratchpad/capture.mjs, then cite it. Orphan check: see references/recipe.md.\n',
      '.agents/skills/beta/SKILL.md': skill('beta', 'x'.repeat(601)) + 'See references/recipe.md.\n',
    },
  });
});
after(() => t.cleanup());

test('a clean repo passes every check', () => {
  const r = run(clean);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const c of ['skill-frontmatter', 'main-guard', 'no-timeout', 'orphans', 'plan-frontmatter', 'script-self-path', 'scratchpad-evidence']) assert.match(r.stdout, new RegExp(`${c}: ok`));
});

test('a broken repo fails each check and the exit code is the sum of their bits', () => {
  const r = run(broken);
  assert.equal(r.status, 1 + 2 + 4 + 8 + 16 + 128, r.stdout);
  assert.match(r.stdout, /references\/recipe\.md:1  cites a session scratchpad path: \/private\/tmp\/claude-502/);
  assert.match(r.stdout, /alpha\/SKILL\.md:2  name "wrong-name" does not match the directory "alpha"/);
  assert.match(r.stdout, /description is 601 chars/);
  assert.match(r.stdout, /beta\/scripts\/go\.mjs:1  run-directly check without realpath/);
  assert.match(r.stdout, /beta\/scripts\/wait\.sh:2  `timeout` used as a command/);
  assert.match(r.stdout, /scripts\/unused-helper\.mjs {2}named by nothing/);
  assert.match(r.stdout, /references\/unused-notes\.md {2}named by nothing/);
  assert.match(r.stdout, /work\/plans\/bad\.md:\d+  status "nearly"/);
  assert.match(r.stdout, /`repos` must be a non-empty list/);
  assert.match(r.stdout, /created "2026-13-40"/);
  assert.ok(!r.stdout.includes('plans/ignored.md'), 'planHome from the resolver, not the default');
});

test('--only runs the named checks and exits with their bit', () => {
  assert.equal(run(broken, '--only', 'no-timeout').status, 4);
  assert.equal(run(broken, '--only', 'orphans').status, 8);
  assert.equal(run(broken, '--only', 'scratchpad-evidence').status, 128);
  assert.equal(run(broken, '--only', 'main-guard,plan-frontmatter').status, 18);
  assert.equal(run(clean, '--only', 'orphans').status, 0);
  const r = run(broken, '--only', 'no-timeout');
  assert.ok(!r.stdout.includes('skill-frontmatter'));
});

test('bad usage exits 64; --list names the checks', () => {
  assert.equal(run(clean, '--only', 'nope').status, 64);
  assert.equal(run(clean, '--bogus').status, 64);
  const l = run(clean, '--list');
  assert.equal(l.status, 0);
  assert.match(l.stdout, /16 {2}plan-frontmatter/);
});

test('--skills and --plans point the checks elsewhere', () => {
  const r = run(clean, '--skills', join(broken, '.agents/skills'), '--plans', join(broken, 'work/plans'), '--only', 'skill-frontmatter,plan-frontmatter');
  assert.equal(r.status, 1 + 16);
});

test('main-guard: flags an unresolved comparison, accepts realpath, skips comments', () => {
  assert.equal(findUnresolvedGuards(guard(false)).length, 1);
  assert.equal(findUnresolvedGuards(guard(true)).length, 0);
  assert.equal(findUnresolvedGuards('// process.argv[1] === import.meta.url\n').length, 0);
});

test('no-timeout: command position only', () => {
  const hits = (s) => findTimeouts(s).length;
  assert.equal(hits('timeout 5 cmd'), 1);
  assert.equal(hits('x && timeout 5 cmd'), 1);
  assert.equal(hits('FOO=1 exec timeout 5 cmd'), 1);
  assert.equal(hits('gtimeout 5 cmd'), 0);
  assert.equal(hits('cmd --timeout 5'), 0);
  assert.equal(hits('echo "timeout 5"'), 0);
  assert.equal(hits('# timeout 5'), 0);
  assert.equal(hits("cat <<'EOF'\ntimeout 5\nEOF\n"), 0);
});

test('scratchpad-evidence: a scratchpad path, not the word', () => {
  const hits = (s) => findScratchpadPaths(s).length;
  assert.equal(hits('run /private/tmp/claude-502/-Users-me-repo/abc/scratchpad/capture.mjs'), 1);
  assert.equal(hits('see `/tmp/claude-1/x/scratchpad/out.png`'), 1);
  assert.equal(hits('/var/folders/ab/cd/T/claude/scratchpad/notes'), 1);
  assert.equal(hits('the scratchpad is cleared between sessions'), 0);
  assert.equal(hits('the session scratchpad directory'), 0);
  assert.equal(hits('/tmp/out.log'), 0);
});

test('script-self-path: $0 after a cd, or in a sourced file', () => {
  const hits = (s, o) => findSelfPaths(s, o).length;
  assert.equal(hits('X=$(dirname "$0")'), 0);
  assert.equal(hits('cd /tmp\nX=$(dirname "$0")'), 1);
  assert.equal(hits('X=$(dirname "$0")', { sourced: true }), 1);
  assert.equal(hits('X=${0%/*}', { sourced: true }), 1);
  assert.equal(hits('cd /tmp\nX=$(dirname "${BASH_SOURCE[0]}")'), 0);
  assert.equal(hits('# dirname "$0"', { sourced: true }), 0);
});

test('frontmatter parser reads quoted, folded and list values', () => {
  const fm = parseFrontmatter('---\nname: "a"\ndescription: >-\n  one\n  two\nrepos:\n  - x\n  - y\ntags: [p, q]\n---\n');
  assert.deepEqual(fm.data, { name: 'a', description: 'one two', repos: ['x', 'y'], tags: ['p', 'q'] });
  assert.equal(parseFrontmatter('no frontmatter'), null);
  assert.deepEqual(checkSkillText('a', '---\nname: a\n---\n').map((f) => f.message), ['frontmatter has no `description`']);
});

test('plan checks: completed plans need a completed date', () => {
  assert.deepEqual(checkPlanText(goodPlan), []);
  const msgs = checkPlanText(goodPlan.replace('active', 'completed')).map((f) => f.message);
  assert.deepEqual(msgs, ['a completed plan needs a `completed` date']);
  assert.equal(checkPlanText('# no frontmatter').length, 1);
});
