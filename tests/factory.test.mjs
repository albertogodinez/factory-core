// factory install / update / remove / link / doctor against throwaway repos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, appendFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempRoot, makeRepo, write, git } from './fixtures/make.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY = join(ROOT, 'bin', 'factory.mjs');
const CORE = join(ROOT, 'bundles', 'core');
let t, home, extra;

before(() => {
  t = tempRoot('af-factory-');
  home = join(t.root, 'home'); mkdirSync(home);
  // A second bundle with defaults, standing in for an adapter bundle.
  extra = join(t.root, 'bundles', 'extra');
  write(join(extra, 'extra-skill', 'SKILL.md'), '---\nname: extra-skill\ndescription: An extra skill.\n---\n# extra\n');
  write(join(extra, 'defaults.json'), { pr: { commentMarker: { mode: 'banner', text: 'org-marker', banner: '> BOT' } }, adapters: { tracker: 'org-tracker' } });
  write(join(home, 'sources.json'), { core: CORE, extra });
});
after(() => t.cleanup());

function factory(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [FACTORY, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, AI_TOOLKIT_HOME: home, AI_TOOLKIT_CONFIG: '', AI_TOOLKIT_HARNESSES: 'none', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const porcelain = (d) => git(d, 'status', '--porcelain', '--untracked-files=all');

// A personal repo: skills from another installer (skills-lock.json), its own skill, and a
// .claude/skills directory of per-skill links.
function personalRepo(name) {
  const d = join(t.root, name);
  makeRepo(d, { remote: `git@github.com:me/${name}.git`, files: {
    'skills-lock.json': { version: 1, skills: {
      handoff: { source: 'someone/skills', sourceType: 'github', skillPath: 'handoff/SKILL.md', computedHash: 'x' },
      tdd: { source: 'someone/skills', sourceType: 'github', skillPath: 'tdd/SKILL.md', computedHash: 'y' } } },
    '.agents/skills/handoff/SKILL.md': '---\nname: handoff\ndescription: upstream copy\n---\n',
    '.agents/skills/tdd/SKILL.md': '---\nname: tdd\ndescription: upstream tdd\n---\n',
    '.agents/skills/my-skill/SKILL.md': '---\nname: my-skill\ndescription: the repo\'s own\n---\n',
  } });
  mkdirSync(join(d, '.claude', 'skills'), { recursive: true });
  for (const n of ['handoff', 'tdd', 'my-skill']) symlinkSync(join('..', '..', '.agents', 'skills', n), join(d, '.claude', 'skills', n));
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'skills');
  return d;
}

test('install without --commit or --local is refused', () => {
  const d = personalRepo('p0');
  const r = factory(['install', 'core'], d);
  assert.equal(r.status, 2); assert.match(r.err, /--commit .* or --local/);
});

test('committed install: replaces another installer\'s copy and its lock entry, leaves the repo\'s own skill', () => {
  const d = personalRepo('p1');
  const own = readFileSync(join(d, '.agents/skills/my-skill/SKILL.md'), 'utf8');
  const r = factory(['install', 'core', '--commit'], d);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /replace handoff \(was someone\/skills\)/);
  assert.match(readFileSync(join(d, '.agents/skills/handoff/SKILL.md'), 'utf8'), /stateRoot/);
  const third = json(join(d, 'skills-lock.json'));
  assert.equal(third.skills.handoff, undefined); assert.ok(third.skills.tdd, 'unrelated entries stay');
  assert.equal(readFileSync(join(d, '.agents/skills/my-skill/SKILL.md'), 'utf8'), own);
  const lock = json(join(d, '.ai-toolkit/skills-lock.json'));
  assert.equal(lock.mode, 'commit');
  for (const n of ['toolkit-context', 'toolkit-pr-comment', 'handoff']) assert.ok(lock.skills[n]?.computedHash, n);
  assert.equal(readlinkSync(join(d, '.claude/skills/toolkit-context')), join('..', '..', '.agents', 'skills', 'toolkit-context'));
  assert.deepEqual(json(join(d, '.ai-toolkit/project.json')).pr, { commentMarker: { mode: 'off' } });
  assert.match(readFileSync(join(d, '.git/info/exclude'), 'utf8'), /\/\.ai-toolkit\/state\//);
  assert.ok(json(join(home, 'installs.json')).repos[d]);
  // The resolver works from the installed copy.
  const ctx = spawnSync(process.execPath, [join(d, '.agents/skills/toolkit-context/scripts/resolve.mjs')], { cwd: d, encoding: 'utf8', env: { ...process.env, AI_TOOLKIT_HOME: home, AI_TOOLKIT_CONFIG: '' } });
  assert.equal(JSON.parse(ctx.stdout).mode, 'project');
  const doc = factory(['doctor'], d);
  assert.equal(doc.status, 0, doc.out + doc.err);
});

test('bundle defaults: the marker default is kept without a TTY, and later bundles only add missing keys', () => {
  const d = personalRepo('p2');
  assert.equal(factory(['install', 'core', 'extra', '--commit'], d).status, 0);
  const p = json(join(d, '.ai-toolkit/project.json'));
  assert.equal(p.pr.commentMarker.text, 'org-marker');
  assert.equal(p.adapters.tracker, 'org-tracker');
  const d2 = personalRepo('p3');
  assert.equal(factory(['install', 'core', 'extra', '--commit', '--marker', 'off'], d2).status, 0);
  assert.deepEqual(json(join(d2, '.ai-toolkit/project.json')).pr.commentMarker, { mode: 'off' });
});

test('a skill name the repo already owns is a conflict, not an overwrite', () => {
  const d = personalRepo('p4');
  write(join(d, '.agents/skills/wait-what/SKILL.md'), '---\nname: wait-what\ndescription: mine\n---\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'own wait-what');
  const r = factory(['install', 'core', '--commit'], d);
  assert.equal(r.status, 0);
  assert.match(r.err, /wait-what: the repo already has its own skill/);
  assert.match(readFileSync(join(d, '.agents/skills/wait-what/SKILL.md'), 'utf8'), /description: mine/);
});

test('local-only install: git status stays clean, the team\'s tracked skill is untouched, worktrees get links', () => {
  const d = join(t.root, 'team');
  makeRepo(d, { remote: 'git@github.com:team/app.git', files: { '.agents/skills/team-skill/SKILL.md': '---\nname: team-skill\ndescription: team\n---\n' } });
  symlinkSync(join('..', '.agents', 'skills'), join(d, '.claude-link-tmp'));
  mkdirSync(join(d, '.claude')); rmSync(join(d, '.claude-link-tmp'));
  symlinkSync(join('..', '.agents', 'skills'), join(d, '.claude', 'skills'));
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'team layout');
  const before = readFileSync(join(d, '.agents/skills/team-skill/SKILL.md'), 'utf8');
  const r = factory(['install', 'core', '--local'], d);
  assert.equal(r.status, 0, r.err);
  assert.equal(porcelain(d), '', 'nothing shows in git status');
  assert.equal(readFileSync(join(d, '.agents/skills/team-skill/SKILL.md'), 'utf8'), before);
  assert.ok(existsSync(join(d, '.claude/skills/toolkit-context/SKILL.md')), 'reached through the tracked link');
  assert.equal(factory(['doctor'], d).status, 0);
  // A new worktree lacks untracked files until factory link.
  git(d, 'worktree', 'add', '-q', '.worktrees/feat/x', '-b', 'feat/x');
  const wt = join(d, '.worktrees/feat/x');
  assert.ok(!existsSync(join(wt, '.agents/skills/toolkit-context')));
  assert.equal(factory(['link'], wt).status, 0);
  assert.ok(existsSync(join(wt, '.agents/skills/toolkit-context/SKILL.md')));
  assert.equal(porcelain(wt), '', 'links are excluded too');
  const ctx = spawnSync(process.execPath, [join(wt, '.agents/skills/toolkit-context/scripts/resolve.mjs'), '--field', 'stateRoot'], { cwd: wt, encoding: 'utf8', env: { ...process.env, AI_TOOLKIT_HOME: home, AI_TOOLKIT_CONFIG: '' } });
  assert.equal(ctx.stdout.trim(), join(d, '.ai-toolkit', 'state', 'x'));
  // remove cleans the exclude entries
  assert.equal(factory(['remove', 'core', '--purge'], d).status, 0);
  const excl = readFileSync(join(d, '.git/info/exclude'), 'utf8');
  assert.doesNotMatch(excl, /agent-factory/);
  assert.ok(!existsSync(join(d, '.ai-toolkit')) && !existsSync(join(d, '.agents/skills/toolkit-context')));
  assert.ok(existsSync(join(d, '.agents/skills/team-skill/SKILL.md')));
});

test('update: refreshes a changed source, refuses an edited copy, --force overwrites', () => {
  const d = personalRepo('p5');
  assert.equal(factory(['install', 'core', 'extra', '--commit'], d).status, 0);
  const src = join(extra, 'extra-skill', 'SKILL.md');
  const orig = readFileSync(src, 'utf8');
  try {
    appendFileSync(src, 'new line\n');
    let r = factory(['update'], d);
    assert.equal(r.status, 0, r.err); assert.match(r.out, /update extra-skill/);
    assert.match(readFileSync(join(d, '.agents/skills/extra-skill/SKILL.md'), 'utf8'), /new line/);
    appendFileSync(join(d, '.agents/skills/extra-skill/SKILL.md'), 'local edit\n');
    appendFileSync(src, 'another\n');
    r = factory(['update'], d);
    assert.equal(r.status, 1); assert.match(r.err, /extra-skill: the installed copy was edited/);
    assert.match(readFileSync(join(d, '.agents/skills/extra-skill/SKILL.md'), 'utf8'), /local edit/);
    assert.equal(factory(['doctor'], d).status, 1, 'doctor flags the edited copy');
    r = factory(['update', '--force'], d);
    assert.equal(r.status, 0); assert.doesNotMatch(readFileSync(join(d, '.agents/skills/extra-skill/SKILL.md'), 'utf8'), /local edit/);
  } finally { writeFileSync(src, orig); }
});

test('update --all refreshes every recorded repo', () => {
  const a = personalRepo('pa'), b = personalRepo('pb');
  for (const d of [a, b]) assert.equal(factory(['install', 'core', 'extra', '--commit'], d).status, 0);
  const src = join(extra, 'extra-skill', 'SKILL.md');
  const orig = readFileSync(src, 'utf8');
  try {
    appendFileSync(src, 'fleet\n');
    const r = factory(['update', '--all'], a);
    for (const d of [a, b]) assert.match(readFileSync(join(d, '.agents/skills/extra-skill/SKILL.md'), 'utf8'), /fleet/);
    assert.ok(r.out.includes(a) && r.out.includes(b));
  } finally { writeFileSync(src, orig); }
});

test('--dry-run changes nothing', () => {
  const d = personalRepo('p6');
  const r = factory(['install', 'core', '--commit', '--dry-run'], d);
  assert.equal(r.status, 0, r.err); assert.match(r.out, /\[dry run\]/);
  assert.equal(porcelain(d), '');
  assert.ok(!existsSync(join(d, '.ai-toolkit')));
});

test('update from a linked worktree finds a committed install made in that worktree', () => {
  const d = personalRepo('p7');
  git(d, 'worktree', 'add', '-q', join(t.root, 'p7-wt'), '-b', 'chore/x');
  const wt = join(t.root, 'p7-wt');
  assert.equal(factory(['install', 'core', '--commit'], wt).status, 0);
  const r = factory(['update'], wt);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, new RegExp(`update core → ${wt}`));
});

test('host linters: install and doctor warn when a linter would lint the installed skills', () => {
  const line = (out) => out.split('\n').find((l) => l.includes('host linters skip installed skills')) || '';
  // oxlint with no ignore for the skills, and ESLint flat config: both reported.
  const a = join(t.root, 'lint-a');
  makeRepo(a, { remote: 'git@github.com:me/lint-a.git', files: {
    '.oxlintrc.json': '{\n  // comment\n  "ignorePatterns": ["dist/**"]\n}\n',
    'eslint.config.mjs': 'export default [{ ignores: ["dist/**"] }];\n',
  } });
  const ia = factory(['install', 'core', '--commit'], a);
  assert.equal(ia.status, 0, ia.err);
  assert.match(ia.err, /oxlint \(\.oxlintrc\.json\) will lint the installed skills' scripts/);
  assert.match(ia.err, /eslint \(eslint\.config\.mjs\)/);
  const da = factory(['doctor'], a);
  assert.equal(da.status, 0, 'a warning, not a failure');
  assert.match(line(da.out), /warn .*oxlint.*ignorePatterns.*eslint.*ignores/);
  // Ignores in place, Biome limited to CSS, oxlint only in package.json scripts with an ignore file.
  const b = join(t.root, 'lint-b');
  makeRepo(b, { remote: 'git@github.com:me/lint-b.git', files: {
    '.oxlintrc.json': '{ "ignorePatterns": [".agents/skills/**", ".claude/skills/**"] }\n',
    'biome.jsonc': '{ "files": { "includes": ["**/*.css", "!dist"] } }\n',
  } });
  assert.equal(factory(['install', 'core', '--commit'], b).status, 0);
  assert.match(line(factory(['doctor'], b).out), /ok {3}host linters/);
  // Biome with no includes lints JS everywhere; oxlint via a script with no config.
  const c = join(t.root, 'lint-c');
  makeRepo(c, { remote: 'git@github.com:me/lint-c.git', files: {
    'biome.json': '{ "linter": { "enabled": true } }\n',
    'package.json': { name: 'c', scripts: { lint: 'oxlint && biome lint .' } },
  } });
  assert.equal(factory(['install', 'core', '--commit'], c).status, 0);
  const lc = line(factory(['doctor'], c).out);
  assert.match(lc, /oxlint \(package\.json\)/); assert.match(lc, /biome \(biome\.json\): add "!\.agents\/skills"/);
  // A lint script that names only paths outside the skills (eslint src/**) doesn't reach them.
  const e = join(t.root, 'lint-e');
  makeRepo(e, { remote: 'git@github.com:me/lint-e.git', files: {
    'eslint.config.js': 'export default [];\n',
    'package.json': { name: 'e', scripts: { lint: 'eslint src/** --ext .ts,.tsx --no-error-on-unmatched-pattern', 'lint:pg': 'pnpm -r lint && eslint playground/src' } },
  } });
  assert.equal(factory(['install', 'core', '--commit'], e).status, 0);
  assert.match(line(factory(['doctor'], e).out), /ok {3}host linters/);
  // The same config with `eslint .` does.
  write(join(e, 'package.json'), { name: 'e', scripts: { lint: 'eslint .' } });
  assert.match(line(factory(['doctor'], e).out), /warn host linters .*eslint \(eslint\.config\.js\)/);
});

test('installs.json: a committed install from a worktree is recorded under the main checkout; update --all prunes missing paths and names the branch', () => {
  const d = personalRepo('wt-main');
  const wt = join(t.root, 'wt-main-pilot');
  git(d, 'worktree', 'add', '-q', '-b', 'chore/pilot', wt);
  assert.equal(factory(['install', 'core', '--commit'], wt).status, 0);
  const repos = () => json(join(home, 'installs.json')).repos;
  assert.ok(repos()[d], 'keyed by the main checkout');
  assert.equal(repos()[wt], undefined, 'not by the worktree');
  // Before the branch merges, the main checkout has no install: update --all says which branch.
  const before = factory(['update', '--all'], d);
  assert.match(before.err, new RegExp(`${d}: no factory install on the checked-out branch \\(main\\)`));
  // A recorded path that no longer exists is dropped, not retried forever.
  const gone = join(t.root, 'deleted-repo');
  const f = join(home, 'installs.json'); const all = json(f);
  all.repos[gone] = { mode: 'commit', bundles: ['core'], skills: 1 }; writeFileSync(f, JSON.stringify(all));
  const r = factory(['update', '--all'], d);
  assert.match(r.err, /deleted-repo: no longer exists; dropped from installs\.json/);
  assert.equal(repos()[gone], undefined);
  git(d, 'worktree', 'remove', '--force', wt);
});

test('install into a hub with a registry writes a workspace pointer, so the registry still lists its repos', () => {
  const d = join(t.root, 'hub-install');
  makeRepo(d, { remote: 'git@github.com:me/hub-install.git', files: {
    '.claude/repos.json': { version: 2, repos: [
      { name: 'other', localPath: '../other', remote: { org: 'me', repo: 'other', ghHost: 'github.com' }, primaryBranch: 'main', commands: {} },
    ] } } });
  const r = factory(['install', 'core', '--commit'], d);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /workspace \.claude\/repos\.json/);
  assert.equal(json(join(d, '.ai-toolkit/project.json')).workspace, '.claude/repos.json');
  const ctx = spawnSync(process.execPath, [join(d, '.agents/skills/toolkit-context/scripts/resolve.mjs'), '--no-cache'], { cwd: d, encoding: 'utf8', env: { ...process.env, AI_TOOLKIT_HOME: home, AI_TOOLKIT_CONFIG: '' } });
  const o = JSON.parse(ctx.stdout);
  assert.equal(o.mode, 'workspace');
  assert.deepEqual(o.neighbors.map((n) => n.name), ['other']);
});
