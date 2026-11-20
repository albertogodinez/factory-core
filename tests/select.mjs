// select.mjs: which test files a commit needs, from its staged paths. The pre-commit hook runs
// `tests/run.mjs --staged`, which asks this; the pre-push hook runs everything, so a dependency this
// misses is still caught before the push. node: imports only.
//
// - Shared code (bin/, tests/, .githooks/, package.json, factory-context, anything not inside a skill)
//   runs everything.
// - A change inside a skill (bundles/<bundle>/<skill>/) runs that skill's tests, plus the tests of every
//   skill or tests/ file whose scripts name it (an import, a spawn path), unless the change is docs only.
// - A docs-only change (every path .md) runs only the owning skills' tests: a skill's tests may read its
//   own docs, but nothing else imports them.
// - The repo-wide checks (internal data, context budget, layout) always run: they are under a second.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const ALWAYS = [
  'tests/internal-data.test.mjs', 'tests/context-budget.test.mjs', 'tests/smoke.test.mjs',
  'tests/lesson-branch-routing.test.mjs', 'tests/main-guard.test.mjs', 'tests/lifecycle-producers.test.mjs',
];
// Skills that every other skill reaches through: a change there runs everything.
export const SHARED_SKILLS = ['bundles/core/factory-context'];

function* walk(root, dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(root, p); else yield relative(root, p).split(sep).join('/');
  }
}

export function allTests(root) {
  return [...walk(root, join(root, 'tests')), ...walk(root, join(root, 'bundles'))].filter((f) => f.endsWith('.test.mjs'));
}

// bundles/<bundle>/<skill>/... -> bundles/<bundle>/<skill>; anything else -> null.
export const skillOf = (path) => { const m = /^(bundles\/[^/]+\/[^/]+)\//.exec(path); return m ? m[1] : null; };

// files: every repo file (repo-relative, / separators); read(f) gives a file's text. Pure but for read.
export function select(staged, { tests, files, read }) {
  if (!staged.length) return { mode: 'none', tests: ALWAYS.filter((t) => tests.includes(t)) };
  const skills = new Set(staged.map(skillOf));
  if (skills.has(null) && staged.some((p) => !skillOf(p) && !p.endsWith('.md'))) return { mode: 'all', why: staged.find((p) => !skillOf(p) && !p.endsWith('.md')), tests };
  skills.delete(null);
  const shared = [...skills].find((s) => SHARED_SKILLS.includes(s));
  if (shared) return { mode: 'all', why: shared, tests };
  const docsOnly = staged.every((p) => p.endsWith('.md'));
  const picked = new Set(ALWAYS.filter((t) => tests.includes(t)));
  for (const s of skills) for (const t of tests) if (t.startsWith(`${s}/`)) picked.add(t);
  if (!docsOnly && skills.size) {
    // A skill's tests depend on another skill when a script in it names that skill's directory.
    const names = [...skills].map((s) => s.split('/').pop());
    const users = new Set();
    for (const f of files) {
      if (!f.endsWith('.mjs')) continue;
      const owner = skillOf(f) || (f.startsWith('tests/') ? f : null);
      if (!owner || users.has(owner)) continue;
      const text = read(f);
      if (names.some((n) => text.includes(`/${n}/`) || text.includes(`'${n}'`) || text.includes(`"${n}"`))) users.add(owner);
    }
    for (const u of users) for (const t of tests) if (t === u || t.startsWith(`${u}/`)) picked.add(t);
  }
  return { mode: docsOnly ? 'docs' : 'scoped', skills: [...skills], tests: tests.filter((t) => picked.has(t)) };
}

export function selectIn(root, staged) {
  const files = [...walk(root, join(root, 'tests')), ...walk(root, join(root, 'bundles'))];
  return select(staged, { tests: allTests(root), files, read: (f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return ''; } } });
}
