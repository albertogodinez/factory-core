#!/usr/bin/env node
// literal-sweep.mjs <diff-file> <output-dir>
// Deterministic grep over the lines a diff ADDS, run before any reviewer interprets the change.
// Writes <output-dir>/sweep.md: one section per signal, each hit as `path:line` plus the line,
// with the personas that own the signal. Hits are places to look, not findings.
// Also writes <output-dir>/sweep-hits.tsv (signal, owners, path, line), the same hits sweep.md
// lists, for check-sweep-coverage.mjs and any pack hook that reads it.
// Generated files, lockfiles and snapshots are skipped.
// Exit: 0 done, 1 bad usage or unreadable diff.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Persona packs extend this table with a sweep-signals.txt in their directory: full rows add
// signals, "+id#owners" lines add owners to an existing signal.
// signal id # owning personas # ERE pattern # path filter (ERE; empty = any path) # path exclude (ERE; optional)
// Fields are separated by '#', so patterns may use '|'; write a literal '#' as \043. Patterns are POSIX ERE (no \b).
export const BASE_SIGNALS = String.raw`any-cast#typescript-conventions, general# as (any|unknown as)([^A-Za-z0-9_]|$)#\.(ts|tsx)$
non-null#typescript-conventions, general#[]A-Za-z0-9_)]![.)[,;]#\.(ts|tsx)$
suppression#no-comments, typescript-conventions#@ts-(ignore|expect-error|nocheck)|eslint-disable|@(file:)?Suppress(Warnings)?\(|ktlint-disable|noqa|type: *ignore#\.(ts|tsx|js|jsx|kt|kts|java|py)$
coverage-ignore#typescript-conventions#(istanbul|c8|v8) ignore#
use-effect#react-patterns#(^|[^A-Za-z0-9_])useEffect\(#\.(ts|tsx|js|jsx)$
class-selector-in-test#typescript-conventions#querySelector(All)?\(|getElementsByClassName|toHaveClass\(|classList|readFileSync\([^)]*\.css|\.find\(['"]\.#(\.test|\.spec|\.cy)\.(ts|tsx|js|jsx)$|/tests?/
not-to-be-null#typescript-conventions#\.not\.toBeNull\(\)#
clickable-div#general#<(div|span)[^>]*onClick#\.(tsx|jsx)$
debug-leftover#general#console\.(log|debug)\(|(^|[^A-Za-z0-9_])debugger([^A-Za-z0-9_]|$)#
todo#general#(^|[^A-Za-z0-9_])(TODO|FIXME|XXX)([^A-Za-z0-9_]|$)#
added-comment#no-comments#^[[:space:]]*(//|/\*|\*([[:space:]]|/|$)|\043([[:space:]]|$)|<!--|\{/\*)#\.(ts|tsx|js|jsx|kt|kts|java|py|css|scss|sh)$
swallowed-error#fix-root-causes#catch[[:space:]]*(\([^)]*\))?[[:space:]]*\{[[:space:]]*\}|\.catch\(\(\)|except[[:space:]]*(Exception)?[[:space:]]*:|runCatching|getOrNull\(\)|getOrDefault\(#\.(ts|tsx|js|jsx|kt|kts|java|py)$
fallback-default#fix-root-causes#\?\?[[:space:]]*(0|\[\]|\{\}|''|""|false)([^A-Za-z0-9_]|$)|\?:[[:space:]]*(0|emptyList\(\)|emptyMap\(\)|"")#\.(ts|tsx|js|jsx|kt|kts|java|py)$
loose-test-assertion#test-behavior#toHaveBeenCalled(Times)?\(|verify[[:space:]]*(\(|\{)|assert_called|toMatchSnapshot\(|toBeTruthy\(\)|toBeDefined\(\)|isNotNull\(\)#(\.test|\.spec|\.cy)\.(ts|tsx|js|jsx)$|/tests?/|/src/test/|test_[^/]*\.py$`;

const POSIX = {
  space: '\\s', blank: ' \\t', alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
  punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: '\\w',
};

// POSIX ERE to a JavaScript RegExp: bracket expressions (leading `]`, [:class:]), \NNN octal
// escapes, and escapes that mean a plain character in ERE but a class in JavaScript.
export function ere(src, flags = '') {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const oct = /^[0-7]{3}/.exec(src.slice(i + 1));
      const n = src[++i];
      if (oct) { out += escapeChar(String.fromCharCode(parseInt(oct[0], 8))); i += 2; }
      else if (n === 'n') out += '\\n';
      else if (n === 't') out += '\\t';
      else if (/[A-Za-z0-9]/.test(n)) out += n;
      else out += `\\${n}`;
    } else if (c === '[') {
      let j = i + 1, cls = '[';
      if (src[j] === '^') { cls += '^'; j++; }
      if (src[j] === ']') { cls += '\\]'; j++; }
      for (; j < src.length && src[j] !== ']'; j++) {
        const named = /^\[:([a-z]+):\]/.exec(src.slice(j));
        if (named) { cls += POSIX[named[1]] ?? ''; j += named[0].length - 1; }
        else if (src[j] === '\\' || src[j] === '[' || src[j] === '^') cls += `\\${src[j]}`;
        else cls += src[j];
      }
      out += `${cls}]`;
      i = j;
    } else out += c;
  }
  return new RegExp(out, flags);
}
const escapeChar = (ch) => (/[A-Za-z0-9 ]/.test(ch) ? ch : `\\${ch}`);

// The signal table with every pack's sweep-signals.txt merged in. Blank lines and lines starting
// with ';' are ignored; "!id#regex" lines are read by check-sweep-coverage.mjs, not here.
export function loadSignals(skillsRoot, extraPacks = process.env.TOOLKIT_REVIEW_PACKS ?? '') {
  const packFiles = [];
  if (existsSync(skillsRoot)) {
    for (const n of readdirSync(skillsRoot).sort()) {
      const f = join(skillsRoot, n, 'sweep-signals.txt');
      if (n.startsWith('toolkit-review-') && existsSync(f)) packFiles.push(f);
    }
  }
  for (const d of extraPacks.split(delimiter).filter(Boolean)) {
    const f = join(d, 'sweep-signals.txt');
    if (existsSync(f)) packFiles.push(f);
  }
  const lines = packFiles
    .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
    .filter((l) => !/^(;|!|\s*$)/.test(l));
  const add = {};
  for (const l of lines.filter((x) => x.startsWith('+'))) {
    const [id, owners] = l.slice(1).split('#');
    add[id] = (add[id] ?? '') + `, ${owners}`;
  }
  const rows = BASE_SIGNALS.split('\n').map((l) => {
    const id = l.split('#')[0];
    if (!(id in add)) return l;
    const p = l.split('#');
    p[1] += add[id];
    return p.join('#');
  });
  rows.push(...lines.filter((x) => !x.startsWith('+')));
  return rows.filter(Boolean).map((row) => {
    const p = row.split('#');
    const [id, owners, pattern = '', filter = ''] = p;
    return { id, owners, pattern, filter, exclude: p.slice(4).join('#') };
  });
}

// Every added line as { path, line, text }, tracking head-side line numbers per hunk.
export function addedLines(diff) {
  const out = [];
  let path = '', skip = false, line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw.slice(4).replace(/^b\//, '');
      skip = path === '/dev/null' || /__generated__\/|\.snap$|(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(path);
    } else if (raw.startsWith('--- ')) continue;
    else if (raw.startsWith('@@ ')) line = Number(/\+([0-9]+)/.exec(raw)?.[1] ?? 0);
    else if (raw.startsWith('+')) { if (!skip) out.push({ path, line, text: raw.slice(1) }); line++; }
    else if (raw.startsWith('-')) continue;
    else line++;
  }
  return out;
}

export function sweep(diff, signals) {
  const added = addedLines(diff);
  const md = ['# Literal sweep', '', 'Deterministic hits on lines this diff adds. Each is a place to look, not a finding: read the',
    'line in context and decide. Read only the sections whose owners include your persona.', ''];
  const tsv = ['signal\towners\tpath\tline'];
  let total = 0;
  for (const s of signals) {
    const pat = ere(s.pattern), filt = s.filter && ere(s.filter), excl = s.exclude && ere(s.exclude);
    const hits = added.filter((a) => (!filt || filt.test(a.path)) && (!excl || !excl.test(a.path)) && pat.test(a.text));
    if (!hits.length) continue;
    total += hits.length;
    md.push(`## ${s.id} (${hits.length})`, '', `Owners: ${s.owners}`, '');
    for (const h of hits.slice(0, 40)) {
      md.push(`- \`${h.path}:${h.line}\` ${h.text.replace(/^[ \t]+/, '').slice(0, 140)}`);
      tsv.push(`${s.id}\t${s.owners}\t${h.path}\t${h.line}`);
    }
    if (hits.length > 40) md.push(`- … ${hits.length - 40} more`);
    md.push('');
  }
  if (total === 0) md.push('No hits.');
  return { md: md.join('\n') + '\n', tsv: tsv.join('\n') + '\n', total };
}

function main() {
  const [diffFile, outDir] = process.argv.slice(2);
  if (!diffFile || !outDir) { console.error('Usage: literal-sweep.mjs <diff-file> <output-dir>'); process.exit(1); }
  let diff;
  try { diff = readFileSync(diffFile, 'utf8'); } catch (e) { console.error(`literal-sweep: cannot read ${diffFile}: ${e.code}`); process.exit(1); }
  const skillsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const r = sweep(diff, loadSignals(skillsRoot));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'sweep.md'), r.md);
  writeFileSync(join(outDir, 'sweep-hits.tsv'), r.tsv);
  console.error(`literal sweep: ${r.total} hits → ${join(outDir, 'sweep.md')}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
