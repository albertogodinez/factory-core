import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildHtml, renderCss } from './open-chart.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = renderCss(readFileSync(path.join(here, '../references/render.md'), 'utf8'));

test('takes the mark colors from render.md', () => {
  assert.match(css, /\.pele \.breaks rect/);
  assert.match(css, /\.pele \.bugPath rect/);
});

test('escapes the Mermaid text so arrows survive as text, and titles the page from the chart', () => {
  const html = buildHtml('---\ntitle: "Hotel <pane>"\n---\nstateDiagram-v2\n  s0 --> s1: you press play\n', css);
  assert.match(html, /<title>Hotel &lt;pane&gt;<\/title>/);
  assert.match(html, /s0 --&gt; s1: you press play/);
  assert.doesNotMatch(html, /s0 --> s1/);
});

test('fails loudly when render.md loses its css block', () => {
  assert.throws(() => renderCss('# no css here'), /no css block/);
});

test('runs when invoked through a symlink, as .claude/skills does', async () => {
  const { mkdtempSync, symlinkSync, writeFileSync: write, existsSync: exists } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(path.join(tmpdir(), 'open-chart-'));
  const link = path.join(dir, 'linked-viewer');
  symlinkSync(here, link);
  write(path.join(dir, 'chart.mmd'), 'stateDiagram-v2\n  s0 --> s1: go\n');
  const r = spawnSync(process.execPath, [path.join(link, 'open-chart.mjs'), dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(path.join(dir, 'chart.html')), 'chart.html was not written');
});
