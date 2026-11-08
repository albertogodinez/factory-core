import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { DesignAuthorityError, resolveDesignAuthority } from './resolve-design-authority.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(policy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-authority-'));
  roots.push(root);
  const skills = path.join(root, '.agents/skills');
  for (const skill of ['toolkit-features-demo', 'toolkit-proto', 'toolkit-figma', 'toolkit-app-verify']) {
    fs.mkdirSync(path.join(skills, skill), { recursive: true });
    fs.writeFileSync(path.join(skills, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: test\n---\n`);
  }
  fs.mkdirSync(path.join(skills, 'toolkit-features-demo/features'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'toolkit-features-demo/features/search.md'), '# Search\n');
  if (policy) fs.writeFileSync(path.join(skills, 'toolkit-features-demo/design-authority.json'), JSON.stringify(policy));
  return { root, mapDir: path.join(skills, 'toolkit-features-demo') };
}

const resolve = (policy, feature = 'search') => resolveDesignAuthority(fixture(policy), feature);

const base = {
  version: 1,
  repo: 'demo',
  defaultDesignAuthority: { kind: 'prototype', skill: 'toolkit-proto' },
  implementationVerifier: 'toolkit-app-verify',
  featureOverrides: {},
};

test('resolves the repo default without reading another design source', () => {
  const result = resolve(base);
  assert.equal(result.resolution, 'repo-default');
  assert.deepEqual(result.designAuthority, base.defaultDesignAuthority);
  assert.equal(result.implementationVerifier, 'toolkit-app-verify');
});

test('a feature override replaces the repo default', () => {
  const result = resolve({ ...base, featureOverrides: { search: { kind: 'figma', skill: 'toolkit-figma' } } });
  assert.equal(result.resolution, 'feature-override');
  assert.equal(result.designAuthority.kind, 'figma');
});

test('a feature override resolves when the repo intentionally has no default', () => {
  const result = resolve({ ...base, defaultDesignAuthority: null, featureOverrides: { search: { kind: 'figma', skill: 'toolkit-figma' } } });
  assert.equal(result.resolution, 'feature-override');
});

test('an explicit null default stops and tells the agent to ask instead of infer', () => {
  assert.throws(
    () => resolve({ ...base, defaultDesignAuthority: null }),
    (error) => error instanceof DesignAuthorityError && error.kind === 'unresolved' && /Ask the user/.test(error.message) && /do not infer/.test(error.message),
  );
});

test('a missing policy is unresolved, not an invitation to inspect every source', () => {
  assert.throws(() => resolve(null), (error) => error instanceof DesignAuthorityError && error.kind === 'unresolved');
});

test('an unknown feature fails before an authority skill is loaded', () => {
  assert.throws(() => resolve(base, 'missing'), /no feature-map entry missing/);
});

test('the policy rejects an undeclared field', () => {
  assert.throws(() => resolve({ ...base, fallback: 'figma' }), /fallback: unexpected property/);
});
