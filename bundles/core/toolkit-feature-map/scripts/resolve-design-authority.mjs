#!/usr/bin/env node
// Pick the one design source that decides what a feature should look like, from the map's
// design-authority.json. Usage: resolve-design-authority.mjs [feature-id] [--map <dir>] [--cwd <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapDirFor, resolveContext } from './context.mjs';
import { validate } from './schema.mjs';

const SCHEMA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schemas/design-authority-policy.schema.json');

export class DesignAuthorityError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'DesignAuthorityError';
    this.kind = kind;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new DesignAuthorityError('invalid', `${file}: ${error.message}`);
  }
}

function assertSkill(root, skill, label, errors) {
  if (!fs.existsSync(path.join(root, '.agents/skills', skill, 'SKILL.md'))) errors.push(`${label} names missing skill ${skill}`);
}

/** `root` is the project root; `mapDir` the map directory (default: the project's own map). */
export function loadDesignAuthorityPolicy({ root, mapDir }) {
  const policyFile = path.join(mapDir, 'design-authority.json');
  const repo = path.basename(mapDir).replace(/^toolkit-features-/, '');
  if (!fs.existsSync(policyFile)) {
    throw new DesignAuthorityError(
      'unresolved',
      `${repo} has no design-authority.json. Onboarding is incomplete; ask the user which source is authoritative before verification.`,
    );
  }
  const policy = readJson(policyFile);
  const errors = validate(policy, readJson(SCHEMA_FILE)).map((m) => `policy${m.replace('(root)', '')}`);
  if (policy.repo && policy.repo !== repo) errors.push(`policy.repo is ${policy.repo}, expected ${repo}`);
  if (policy.defaultDesignAuthority) assertSkill(root, policy.defaultDesignAuthority.skill, 'defaultDesignAuthority', errors);
  if (policy.implementationVerifier) assertSkill(root, policy.implementationVerifier, 'implementationVerifier', errors);
  for (const [feature, authority] of Object.entries(policy.featureOverrides ?? {})) {
    if (!fs.existsSync(path.join(mapDir, 'features', `${feature}.md`))) errors.push(`featureOverrides.${feature} has no features/${feature}.md`);
    if (authority?.skill) assertSkill(root, authority.skill, `featureOverrides.${feature}`, errors);
  }
  if (errors.length) throw new DesignAuthorityError('invalid', `${policyFile} is invalid:\n  ${errors.join('\n  ')}`);
  return { policy, policyFile, mapDir, repo };
}

export function resolveDesignAuthority({ root, mapDir }, feature) {
  const { policy, policyFile, repo } = loadDesignAuthorityPolicy({ root, mapDir });
  if (feature && !fs.existsSync(path.join(mapDir, 'features', `${feature}.md`))) {
    throw new DesignAuthorityError('invalid', `${repo} has no feature-map entry ${feature}`);
  }
  const override = feature ? policy.featureOverrides?.[feature] : undefined;
  const designAuthority = override ?? policy.defaultDesignAuthority;
  if (!designAuthority) {
    const target = feature ? `${repo}/${feature}` : repo;
    throw new DesignAuthorityError(
      'unresolved',
      `No design authority is configured for ${target}. Ask the user which source to treat as authoritative; do not infer one from sources, links, or availability.`,
    );
  }
  return {
    repo,
    feature: feature ?? null,
    resolution: override ? 'feature-override' : 'repo-default',
    designAuthority,
    implementationVerifier: policy.implementationVerifier,
    policy: path.relative(root, policyFile),
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const usage = () => console.error('Usage: resolve-design-authority.mjs [feature-id] [--map <dir>] [--cwd <dir>]');
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(0);
  }
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const positional = argv.filter((a, i) => !a.startsWith('-') && !['--map', '--cwd'].includes(argv[i - 1]));
  if (positional.length > 1 || argv.some((a) => a.startsWith('-') && !['--map', '--cwd'].includes(a))) {
    usage();
    process.exit(2);
  }
  try {
    const ctx = resolveContext({ cwd: value('--cwd') ?? process.cwd() });
    console.log(JSON.stringify(resolveDesignAuthority({ root: ctx.project.root, mapDir: mapDirFor(ctx, value('--map')) }, positional[0]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(error instanceof DesignAuthorityError && error.kind === 'unresolved' ? 3 : 2);
  }
}
