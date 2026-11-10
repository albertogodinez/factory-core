// Builds throwaway git repos for the resolver and factory tests. Nested git
// repos can't be committed, so the fixtures are generated at test time into a
// temp directory, and removed by the caller.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const GIT_ENV = (() => {
  const e = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k];
  return e;
})();
export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV,
  }).trim();
}

export function write(file, content) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

// A repo with one commit on `branch`, an origin remote, and (optionally) an
// origin/HEAD pointing at `originHead`.
export function makeRepo(dir, { remote, branch = 'main', originHead = branch, files = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  for (const [f, c] of Object.entries({ 'README.md': '# fixture\n', ...files })) write(join(dir, f), c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  if (remote) {
    git(dir, 'remote', 'add', 'origin', remote);
    if (originHead) {
      git(dir, 'update-ref', `refs/remotes/origin/${originHead}`, 'HEAD');
      git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${originHead}`);
    }
  }
  return dir;
}

export function tempRoot(prefix = 'af-') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The standard layout used by the resolver tests:
//   <root>/project/      .agents/factory-metadata/project.json (untracked), neighbor `lib`, worktree .worktrees/feat/x
//   <root>/lib/          neighbor; origin/HEAD → develop
//   <root>/zero-config/  no config, no origin/HEAD
//   <root>/hub/          .claude/repos.json (legacy registry listing project and lib)
//   <root>/explicit.json a config selected with --config
//   <root>/clone/        a second checkout of `project` (same remote, different directory)
//   <root>/home/         FACTORY_HOME
export function makeFixtures() {
  const t = tempRoot();
  const r = t.root;
  makeRepo(join(r, 'lib'), { remote: 'git@github.com:acme/lib.git', branch: 'develop' });
  makeRepo(join(r, 'project'), {
    remote: 'https://github.com/acme/project.git',
    files: { 'pnpm-lock.yaml': '', 'package.json': { scripts: { build: 'x', test: 'y' } }, '.github/PULL_REQUEST_TEMPLATE.md': '## Summary\n' },
  });
  write(join(r, 'project/.agents/factory-metadata/project.json'), {
    version: 1, name: 'project',
    commands: { lint: 'pnpm lint' },
    neighbors: [{ name: 'lib' }],
    pr: { commentMarker: { mode: 'off' } },
  });
  git(join(r, 'project'), 'worktree', 'add', '-q', '.worktrees/feat/x', '-b', 'feat/x');
  makeRepo(join(r, 'zero-config'), { remote: 'git@example.org:me/zero-config.git', originHead: null });
  makeRepo(join(r, 'hub'), { remote: 'git@github.com:acme/hub.git' });
  write(join(r, 'hub/.claude/repos.json'), {
    version: 2,
    repos: [
      { name: 'project', localPath: '../project', remote: { org: 'acme', repo: 'project', ghHost: 'github.com', sshAlias: null, isFork: false, upstreamOrg: null }, primaryBranch: 'main', instructionFile: 'AGENTS.md', packageManager: 'pnpm', commands: { build: 'pnpm build', test: 'pnpm test', lint: null }, worktreeConvention: 'dot-worktrees', prTemplatePath: null, isMonorepo: false, pathFilter: null, componentAuthoring: false, planHome: 'toolkit', review: { enabled: true, personas: ['general'] } },
      { name: 'lib', localPath: '../lib', remote: { org: 'acme', repo: 'lib', ghHost: 'github.com', sshAlias: null, isFork: false, upstreamOrg: null }, primaryBranch: 'develop', instructionFile: 'none', packageManager: 'none', commands: {}, worktreeConvention: 'none', prTemplatePath: null, isMonorepo: false, pathFilter: null, componentAuthoring: false, planHome: 'toolkit' },
    ],
  });
  write(join(r, 'explicit.json'), { version: 1, name: 'explicit-name', trunk: 'release' });
  makeRepo(join(r, 'clone'), { remote: 'https://github.com/acme/project.git' });
  mkdirSync(join(r, 'home'));
  return { ...t, home: join(r, 'home') };
}
