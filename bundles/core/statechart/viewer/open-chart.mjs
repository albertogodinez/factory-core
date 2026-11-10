#!/usr/bin/env node
// Writes chart.html next to a statechart run's chart.mmd, drawn by Pele from the CDN with the colors in
// references/render.md, so the chart can be viewed in a browser. Not part of the upstream command.
// Usage: node open-chart.mjs <out dir> [--open]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const PELE = 'https://cdn.jsdelivr.net/npm/pele@1.9.0/dist/pele.js';

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The `css` block of render.md: Pele's theme plus the group, bug and path classes the command writes. */
export function renderCss(renderMd) {
  const css = renderMd.match(/```css\r?\n([\s\S]*?)```/)?.[1];
  if (!css) throw new Error('references/render.md has no css block');
  return css;
}

export function buildHtml(mmd, css) {
  const title = mmd.match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? 'Statechart';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0; padding: 24px; font-family: ui-sans-serif, system-ui, sans-serif; background: #fff; color: #1c1c1c; }
@media (prefers-color-scheme: dark) { body { background: #1f1f1f; color: #f5f5f5; } }
${css}</style>
<script type="module">
import { mount } from "${PELE}";
const el = document.querySelector("pre.mermaid");
const host = document.createElement("div");
el.replaceWith(host);
mount(host, el.textContent);
</script></head>
<body><pre class="mermaid">${escapeHtml(mmd)}</pre></body></html>
`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const outDir = args.find((a) => !a.startsWith('--'));
  if (!outDir) { console.error('usage: node open-chart.mjs <out dir> [--open]'); process.exit(2); }
  const mmdPath = path.join(outDir, 'chart.mmd');
  if (!existsSync(mmdPath)) { console.error(`open-chart: no ${mmdPath}; the run drew no chart (see report.md)`); process.exit(1); }
  const css = renderCss(readFileSync(path.join(here, '../references/render.md'), 'utf8'));
  const htmlPath = path.join(outDir, 'chart.html');
  writeFileSync(htmlPath, buildHtml(readFileSync(mmdPath, 'utf8'), css));
  console.log(`open-chart: wrote ${htmlPath}`);
  if (args.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const r = spawnSync(opener, [htmlPath], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`open-chart: ${opener} failed; open ${htmlPath} by hand`); process.exit(1); }
  }
}
