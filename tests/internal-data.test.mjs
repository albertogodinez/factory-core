// Core must carry no internal data: no company repo names, hosts, orgs, logins
// or paths. Consumers supply those through config or an adapter bundle.
// The patterns live here, outside bundles/, so the check itself isn't flagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'bundles', 'core');
const DENY = [
  /trips-ai-toolkit/i, /expedia/i, /\bEG(DS)?\b/, /\beg-internal\b/i, /Brand-Expedia/i, /tarmac/i,
  /cc-autoreply/i, /\bAISHOP-\d/, /atlassian\.net/i, /agodinez/i, /albertogodinez/i,
  /trips-pwa|shared-ui-web|experience-api-trips|trips-experience|ccui|ai-shopping-pwa|ai-agents-dnr|trips-communication-api/i,
  /\/Users\/[a-z]/,
];

function* files(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p); else yield p;
  }
}

test('bundles/core contains no internal data', () => {
  const hits = [];
  for (const f of files(CORE)) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const re of DENY) if (re.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1} ${re} ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});
