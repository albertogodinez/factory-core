import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inline } from './build-page.mjs';

const files = { '/a/shot.png': Buffer.from('PNG'), '/a/take.mp4': Buffer.from('MP4'), '/a/extra.css': Buffer.from('p{}') };
const opts = { resolveFile: (name) => `/a/${name}`, read: (p) => files[p] ?? null };

test('images and videos become data URIs with their type', () => {
  const { html, missing } = inline('<img src="{{img:shot.png}}"><video src="{{vid:take.mp4}}"></video>', opts);
  assert.deepEqual(missing, []);
  assert.equal(html, `<img src="data:image/png;base64,${Buffer.from('PNG').toString('base64')}"><video src="data:video/mp4;base64,${Buffer.from('MP4').toString('base64')}"></video>`);
});

test('{{style}} inlines the bundled theme and {{css:}} a named file', () => {
  const { html, missing } = inline('{{style}}{{css:extra.css}}', { ...opts, read: (p) => files[p] ?? (p.endsWith('explainer-theme.css') ? Buffer.from(':root{}') : null) });
  assert.deepEqual(missing, []);
  assert.equal(html, '<style>\n:root{}\n</style><style>\np{}\n</style>');
});

test('a missing file or unknown type is reported, not silently left in', () => {
  const { missing } = inline('{{img:gone.png}} {{img:extra.css}}', opts);
  assert.deepEqual(missing, ['{{img:gone.png}}', '{{img:extra.css}} (unknown type .css)']);
});

test('an image or video placeholder outside a src attribute is refused', () => {
  const { misplaced } = inline('<figure>\n  {{img:shot.png}}\n</figure><p>{{vid:take.mp4}}</p>', opts);
  assert.equal(misplaced.length, 2);
  assert.match(misplaced[0], /\{\{img:shot\.png\}\} on line 2 is not inside src="…"/);
  assert.match(misplaced[1], /\{\{vid:take\.mp4\}\} on line 3/);
});

test('src, poster and href attributes, with either quote, are accepted', () => {
  const { misplaced } = inline(`<img src="{{img:shot.png}}"><video poster='{{img:shot.png}}' src = "{{vid:take.mp4}}"></video><a href="{{img:shot.png}}">x</a>`, opts);
  assert.deepEqual(misplaced, []);
});

test('{{style}} or {{css:}} inside an open <style> element is refused', () => {
  const read = (p) => files[p] ?? (p.endsWith('explainer-theme.css') ? Buffer.from(':root{}') : null);
  const { misplaced } = inline('<style>{{style}}\n.x{}\n</style><style>\n{{css:extra.css}}</style>', { ...opts, read });
  assert.equal(misplaced.length, 2);
  assert.match(misplaced[0], /\{\{style\}\} on line 1 is inside a <style> element/);
  assert.match(misplaced[1], /\{\{css:extra\.css\}\} on line 4/);
  assert.deepEqual(inline('<style>.a{}</style>\n{{style}}\n<style>.b{}</style>', { ...opts, read }).misplaced, []);
});
