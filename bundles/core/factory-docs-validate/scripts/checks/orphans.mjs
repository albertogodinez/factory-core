// Fails when a file under a skill's scripts/ or references/ is named by nothing else in the skills
// directory. A needle is the file name, or its stem when the stem is 8+ characters with a - or _.
// Tests (*.test.*, *.guard.*) and dot files are exempt: nothing is expected to name them.
import { readFileSync } from 'node:fs';
import { basename, extname, relative, sep } from 'node:path';
import { isTest, walk } from '../lib.mjs';

const TEXT = /\.(md|mjs|js|cjs|ts|sh|py|json|ya?ml|toml|txt|tsv)$|(^|\/)(Makefile)$/;

export function needles(file) {
  const name = basename(file);
  const stem = basename(file, extname(file));
  const out = [name];
  if (stem.length >= 8 && /[-_]/.test(stem)) out.push(stem);
  return out;
}

export function run({ skillsDir }) {
  const files = walk(skillsDir);
  const candidates = files.filter((f) => {
    const parts = relative(skillsDir, f).split(sep);
    return parts.length >= 3 && (parts[1] === 'scripts' || parts[1] === 'references') && !isTest(f) && !basename(f).startsWith('.');
  });
  const corpus = files.filter((f) => TEXT.test(f.split(sep).join('/'))).map((f) => ({ f, text: readFileSync(f, 'utf8') }));
  const findings = [];
  for (const file of candidates) {
    const keys = needles(file);
    if (!corpus.some((c) => c.f !== file && keys.some((k) => c.text.includes(k)))) {
      findings.push({ file, line: 0, message: 'named by nothing else in the skills directory' });
    }
  }
  return { findings, summary: `${candidates.length} script/reference file(s)`, hint: 'Reference each from the skill or script that uses it, or delete it.' };
}
