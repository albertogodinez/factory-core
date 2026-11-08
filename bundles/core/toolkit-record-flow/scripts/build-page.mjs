#!/usr/bin/env node
// Build one self-contained HTML page (an explainer, a bug report) from a source page with
// placeholders, so it opens anywhere with its screenshots and video inside it.
//
//   node build-page.mjs <src.html> <out.html> [--assets <dir>]...
//
//   {{style}}         <style> with assets/explainer-theme.css (the Plannotator explainer theme)
//   {{css:<file>}}    <style> with that file
//   {{img:<file>}}    data: URI of an image   e.g. <img src="{{img:after.png}}" alt="…">
//   {{vid:<file>}}    data: URI of a video    e.g. <video controls src="{{vid:take.mp4}}"></video>
//
// <file> resolves against each --assets dir in order, then the source page's folder.
// {{img:}} and {{vid:}} must sit inside a src, poster or href attribute, and {{style}} / {{css:}}
// outside any <style> element, since each expands to a full <style> block.
// Exit 0: written. 1: a placeholder's file is missing. 2: usage. 3: a placeholder is misplaced.
// Nothing is written on 1 or 3.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THEME = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'explainer-theme.css');
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
};
const PLACEHOLDER = /\{\{(style|css|img|vid)(?::([^}]+))?\}\}/g;

const IN_URL_ATTRIBUTE = /\b(?:src|poster|href)\s*=\s*["']$/i;

/** Placeholders that would expand into broken markup, each as "<placeholder> on line N …". */
export function findMisplaced(source) {
  const misplaced = [];
  for (const m of source.matchAll(PLACEHOLDER)) {
    const before = source.slice(0, m.index);
    const line = before.split('\n').length;
    if (m[1] === 'img' || m[1] === 'vid') {
      if (!IN_URL_ATTRIBUTE.test(before)) {
        const tag = m[1] === 'img' ? `<img src="${m[0]}" alt="…">` : `<video controls src="${m[0]}"></video>`;
        misplaced.push(`${m[0]} on line ${line} is not inside src="…" (it expands to a bare data: URI, so the page shows it as text); write ${tag}`);
      }
    } else if (before.lastIndexOf('<style') > before.lastIndexOf('</style')) {
      misplaced.push(`${m[0]} on line ${line} is inside a <style> element (it expands to its own <style> block); move it before your <style>`);
    }
  }
  return misplaced;
}

/** Replaces every placeholder; returns {html, missing, misplaced}. `read(path)` returns a Buffer or null. */
export function inline(source, { resolveFile, read }) {
  const missing = [];
  const misplaced = findMisplaced(source);
  const html = source.replace(PLACEHOLDER, (whole, kind, name) => {
    const path = kind === 'style' ? THEME : name && resolveFile(name.trim());
    const data = path ? read(path) : null;
    if (!data) {
      missing.push(whole);
      return whole;
    }
    if (kind === 'style' || kind === 'css') return `<style>\n${data.toString('utf8')}\n</style>`;
    const mime = MIME[extname(path).toLowerCase()];
    if (!mime) {
      missing.push(`${whole} (unknown type ${extname(path)})`);
      return whole;
    }
    return `data:${mime};base64,${data.toString('base64')}`;
  });
  return { html, missing, misplaced };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const assets = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--assets') assets.push(resolve(argv[++i] ?? ''));
    else positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    console.error('usage: build-page.mjs <src.html> <out.html> [--assets <dir>]...');
    process.exit(2);
  }
  const [src, out] = positional;
  const dirs = [...assets, dirname(resolve(src))];
  const { html, missing, misplaced } = inline(readFileSync(src, 'utf8'), {
    resolveFile: (name) => dirs.map((d) => resolve(d, name)).find((p) => existsSync(p)),
    read: (path) => (existsSync(path) ? readFileSync(path) : null)
  });
  if (misplaced.length) {
    for (const m of misplaced) console.error(`✗ ${m}`);
    process.exit(3);
  }
  if (missing.length) {
    for (const m of missing) console.error(`✗ no file for ${m}`);
    process.exit(1);
  }
  writeFileSync(out, html);
  console.log(`✓ ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
}
