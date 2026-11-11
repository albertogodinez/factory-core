import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const major = (v) => String(v).trim().replace(/^v/, '').split('.')[0];

export function preflight({ dir, nodeVersion = process.version, head, before }) {
  const problems = [];
  const nvmrc = join(dir, '.nvmrc');
  if (existsSync(nvmrc)) {
    const want = readFileSync(nvmrc, 'utf8');
    if (major(want) !== major(nodeVersion)) problems.push(`node ${nodeVersion} does not match .nvmrc ${want.trim()}: switch before running anything`);
  }
  const modules = join(dir, 'node_modules');
  if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) problems.push('node_modules is a symlink: install into this worktree');
  if (before && head === before) problems.push(`HEAD is still ${before}: the commit did not happen, so read the hook output`);
  return problems;
}

function main(argv) {
  const dir = resolve(argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : process.cwd());
  const before = argv.includes('--after-commit') ? argv[argv.indexOf('--after-commit') + 1] : undefined;
  const head = before ? execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() : undefined;
  const problems = preflight({ dir, head, before });
  for (const p of problems) console.error(`preflight: ${p}`);
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
