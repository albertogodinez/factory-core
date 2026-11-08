import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter } from './parse-frontmatter.mjs';

const entry = (role) => `---\nid: x\ncode:\n  - repo: r\n    path: p\n    role: ${role}\n---\n\n## Sub-features\n`;

test('parses valid frontmatter and keeps the body', () => {
  const { data, content, error } = parseFrontmatter(entry('"the steps: fare, seats"'));
  assert.equal(error, undefined);
  assert.equal(data.code[0].role, 'the steps: fare, seats');
  assert.match(content, /## Sub-features/);
});

test('an unquoted ": " in a value is reported with its file line, not thrown', () => {
  const result = parseFrontmatter(entry('the steps: fare, seats'));
  assert.equal(result.data, undefined);
  assert.match(result.error, /line 6 /);
  assert.match(result.error, /role: the steps: fare, seats/);
  assert.match(result.error, /Quote any value/);
});

test('an unterminated quote is reported at the line that opened it, not where js-yaml gave up', () => {
  const raw = `---\nid: x\ntitle: "never closed\nsummary: fine\naliases: [a]\ncode:\n  - repo: r\n    path: p\n---\n`;
  const { error } = parseFrontmatter(raw);
  assert.match(error, /not valid YAML at line 3 /);
  assert.match(error, /title: "never closed/);
  assert.match(error, /a quoted value is never closed/);
});

test('a quoted value that closes on its line is not blamed for a later failure', () => {
  const { error } = parseFrontmatter(entry('the steps: fare, seats').replace('id: x', 'id: "x"'));
  assert.match(error, /line 6 /);
});

test('a value starting with # is a comment: it parses to null and gets a warning naming the key', () => {
  const { data, warnings } = parseFrontmatter(entry('#nope'));
  assert.equal(data.code[0].role, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /line 6: the value of "role" starts with "#"/);
  assert.match(warnings[0], /role: "#nope"/);
});

test('a # inside a value is not a comment and draws no warning', () => {
  assert.deepEqual(parseFrontmatter(entry('Trip #Overview')).warnings, []);
});

test('errors other than YAML failures still throw', () => {
  assert.throws(() => parseFrontmatter(undefined));
});
