// Project facts for the feature-map scripts, taken from toolkit-context's resolver.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAP_PREFIX = 'toolkit-features-';
const RESOLVER = resolve(HERE, '../../toolkit-context/scripts/resolve.mjs');

/** Run the resolver for `cwd`. Throws with its message when it fails. */
export function resolveContext({ cwd = process.cwd() } = {}) {
  if (!existsSync(RESOLVER)) throw new Error('toolkit-context is not installed next to this skill; install it with the same bundle');
  const run = spawnSync(process.execPath, [RESOLVER, '--cwd', cwd], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'toolkit-context failed').trim());
  return JSON.parse(run.stdout);
}

/** Where the map for this project lives: an explicit directory, or the default inside the repo. */
export function mapDirFor(ctx, explicit) {
  if (explicit) return resolve(explicit);
  return join(ctx.project.root, '.agents/skills', MAP_PREFIX + ctx.project.name);
}

/**
 * The checkout an anchor's `repo` names: omitted or the project's own name is the project root;
 * anything else must be a neighbor. Returns null for an unknown name.
 */
export function anchorRepo(ctx, name) {
  const { project, neighbors = [] } = ctx;
  if (!name || name === project.name) return { name: project.name, root: project.root, trunk: project.trunk, own: true };
  const n = neighbors.find((x) => x.name === name);
  if (!n) return null;
  return { name, root: resolve(project.root, n.root ?? `../${name}`), trunk: n.trunk, own: false };
}
