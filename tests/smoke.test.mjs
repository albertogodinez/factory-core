import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
test('repo has its README and AGENTS.md', () => {
  assert.ok(existsSync(new URL('../README.md', import.meta.url)));
  assert.ok(existsSync(new URL('../AGENTS.md', import.meta.url)));
});
