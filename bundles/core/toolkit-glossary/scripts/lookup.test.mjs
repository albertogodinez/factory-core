import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, check, sentences } from './lookup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOOKUP = join(HERE, 'lookup.mjs');
const CORE = join(HERE, '..', 'GLOSSARY.md');

const run = (args, cwd) => spawnSync(process.execPath, [LOOKUP, ...args], { cwd, encoding: 'utf8' });

// A repo with its own GLOSSARY.md and two installed layers next to a copy of core.
function fixture({ repoFile = 'GLOSSARY.md', repoText } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'glossary-'));
  mkdirSync(join(root, '.git'));
  const skills = join(root, '.agents', 'skills');
  const layer = (name, meta, text) => {
    mkdirSync(join(skills, name), { recursive: true });
    if (meta) writeFileSync(join(skills, name, 'glossary.json'), JSON.stringify(meta));
    writeFileSync(join(skills, name, 'GLOSSARY.md'), text);
  };
  layer('toolkit-glossary', { layer: 'core', order: 100 }, '# Core\n\n**Plan**:\nA living document.\n\n**Widget**:\nThe core meaning.\n');
  layer('team-glossary', { layer: 'team', order: 20 }, '# Team\n\n**Widget**:\nThe team meaning.\n_Avoid_: gizmo, doohickey (in prose)\n');
  layer('not-a-glossary', null, '**Widget**:\nIgnored: no glossary.json.\n');
  if (repoText) writeFileSync(join(root, repoFile), repoText);
  return { root, skills, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('parse reads terms, definitions, sections and _Avoid_ synonyms', () => {
  const e = parse('# G\n\n## Area\n\n**Term one**:\nFirst. Second.\n_Avoid_: alt (when x), other\n\n**Two**:\nOnly one.\n');
  assert.deepEqual(e.map((x) => [x.term, x.section, x.definition, x.avoid]), [
    ['Term one', 'Area', 'First. Second.', ['alt', 'other']],
    ['Two', 'Area', 'Only one.', []],
  ]);
});

test('sentences ignores abbreviations and code spans', () => {
  assert.equal(sentences('Uses `a.b. C.d` and e.g. this. Then that.'), 2);
});

test('check flags long, empty, repeated and same-line entries', () => {
  const out = check('**A**:\nOne. Two. Three.\n\n**B**:\n\n**A**:\nAgain.\n**C**: inline\n', 'g.md');
  assert.equal(out.length, 4, out.join('\n'));
  assert.match(out.join('\n'), /\*\*A\*\* has 3 sentences/);
  assert.match(out.join('\n'), /\*\*B\*\* has no definition/);
  assert.match(out.join('\n'), /\*\*A\*\* is already defined at line 1/);
  assert.match(out.join('\n'), /g\.md:8 put the definition on the line after/);
});

test('the core layer passes its own format check', () => {
  assert.deepEqual(check(readFileSync(CORE, 'utf8'), 'GLOSSARY.md'), []);
});

test('lookup: the most specific layer wins and the override is named', () => {
  const f = fixture({ repoText: '# Repo\n\n**Widget**:\nThe repo meaning.\n' });
  try {
    const r = run(['--skills-dir', f.skills, 'widget'], f.root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^\[repo\] GLOSSARY\.md:3\n\*\*Widget\*\*:\nThe repo meaning\./);
    assert.match(r.stdout, /Also defined in \[team\].*the \[repo\] definition above wins/);
    assert.match(r.stdout, /Also defined in \[core\]/);
    assert.doesNotMatch(r.stdout, /Ignored/);
  } finally { f.done(); }
});

test('lookup: an _Avoid_ synonym points to the term to use; misses exit 1', () => {
  const f = fixture();
  try {
    const a = run(['--skills-dir', f.skills, 'gizmo'], f.root);
    assert.equal(a.status, 0);
    assert.match(a.stdout, /"gizmo" is a term to avoid; use \*\*Widget\*\*/);
    const p = run(['--skills-dir', f.skills, 'plans'], f.root);
    assert.equal(p.status, 1);
    assert.match(p.stdout, /Close matches: \*\*Plan\*\* \[core\]/);
    assert.equal(run(['--skills-dir', f.skills, 'nothing-like-it'], f.root).status, 1);
  } finally { f.done(); }
});

test('lookup: CONTEXT.md is the repo layer when there is no GLOSSARY.md', () => {
  const f = fixture({ repoFile: 'CONTEXT.md', repoText: '**Plan**:\nThe repo plan.\n' });
  try {
    const r = run(['--skills-dir', f.skills, 'Plan'], f.root);
    assert.match(r.stdout, /^\[repo\] CONTEXT\.md:1/);
  } finally { f.done(); }
});

test('--dupes finds a term two repos each defined (a promotion candidate)', () => {
  const a = fixture({ repoText: '**Shared idea**:\nRepo A says.\n\n**Only A**:\nX.\n' });
  const b = fixture({ repoText: '**shared idea**:\nRepo B says.\n' });
  try {
    const r = run(['--dupes', join(a.root, 'GLOSSARY.md'), join(b.root, 'GLOSSARY.md')], a.root);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /\*\*Shared idea\*\* is defined in 2 places: .*GLOSSARY\.md:1, .*GLOSSARY\.md:1/);
    assert.doesNotMatch(r.stdout, /Only A/);
  } finally { a.done(); b.done(); }
});
