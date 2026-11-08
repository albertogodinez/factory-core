#!/usr/bin/env node
// compile-rules.mjs <persona> <target-repo> <output-dir> [--packs a:b] [--json]
// Compiles one persona's rule files for a target project into <output-dir>/compiled-<persona>.md.
// Rules come from this skill's rules/<persona>/ and from every installed toolkit-review-* pack;
// a pack file with the same name replaces the core one. A rule applies when its `repos:`
// frontmatter lists the target or `cross-repo` (or is absent); `repos_exclude:` wins over both.
// A persona with a file but no rules (`general`) compiles to 0 of 0. Exit: 0 compiled (even zero rules), 2 bad usage or unknown persona.
import { compileRules, findPersona, parseArgs, searchRoots } from './lib.mjs';

const o = parseArgs(process.argv.slice(2), ['json']);
const [persona, target, outDir] = o._;
if (!persona || !target || !outDir) {
  console.error('Usage: compile-rules.mjs <persona> <target-repo> <output-dir> [--packs a:b] [--json]');
  process.exit(2);
}
const roots = searchRoots(o);
const r = compileRules(persona, target, roots, outDir);
if (!r.anyDir && !findPersona(persona, roots)) {
  console.error(`compile-rules: persona '${persona}' has no persona file and no rules directory in core or any pack`);
  process.exit(2);
}
console.error(`compiled ${r.included} of ${r.total} rules for ${persona} x ${target} (${r.excluded} excluded via repos_exclude)`);
if (o.json) console.log(JSON.stringify(r));
