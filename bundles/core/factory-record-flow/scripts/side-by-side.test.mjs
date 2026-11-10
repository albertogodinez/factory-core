// Run: node --test side-by-side.test.mjs  (needs ffmpeg, ffprobe and magick)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { firstChange } from './side-by-side.mjs';
import { bandSize } from './caption.mjs';

const SCRIPT = fileURLToPath(new URL('./side-by-side.mjs', import.meta.url));
const CROP = '200x100+20+20';
let dir;
const HAS_MEDIA = ['ffmpeg', 'ffprobe'].every((bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0);
const mediaTest = HAS_MEDIA ? test : test.skip;
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);

before(() => {
  if (!HAS_MEDIA) return;
  dir = mkdtempSync(join(tmpdir(), 'side-by-side-test-'));
  // A take where nothing changes: the click missed, or the crop is over a region it never touches.
  ffmpeg('-f', 'lavfi', '-i', 'color=c=white:s=640x400:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'still.mp4'));
  // A take whose pane turns dark 1 s in, as a skeleton opening on the click does.
  ffmpeg('-f', 'lavfi', '-i', 'color=c=white:s=640x400:d=1:r=30', '-f', 'lavfi', '-i', 'color=c=0x334155:s=640x400:d=2:r=30',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'change.mp4'));
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

mediaTest('finds the frame where the synced region first changes', () => {
  const t = firstChange(join(dir, 'change.mp4'), CROP);
  assert.ok(t !== null && Math.abs(t - 1) < 0.1, `expected about 1 s, got ${t}`);
});

mediaTest('returns null when the synced region never changes', () => {
  assert.equal(firstChange(join(dir, 'still.mp4'), CROP), null);
});

mediaTest('refuses with exit 3 and writes nothing when a take has no pane change to sync on', () => {
  const out = join(dir, 'out.mp4');
  const r = spawnSync('node', [SCRIPT, '--before', join(dir, 'change.mp4'), '--after', join(dir, 'still.mp4'), '--out', out, '--sync-crop', CROP]);
  assert.equal(r.status, 3, r.stderr.toString());
  assert.match(r.stderr.toString(), /can't be found/);
  assert.equal(existsSync(out), false);
});

mediaTest('stacks two synced takes when both have a pane change', () => {
  const out = join(dir, 'ok.mp4');
  const r = spawnSync('node', [SCRIPT, '--before', join(dir, 'change.mp4'), '--after', join(dir, 'change.mp4'), '--out', out, '--sync-crop', CROP, '--lead', '0.5', '--tail', '0']);
  assert.equal(r.status, 0, r.stderr.toString());
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim().split(',').map(Number);
  assert.deepEqual([w, h], [1924, 600]);
});

mediaTest('adds a caption band under both halves when given captions', () => {
  const caps = join(dir, 'caps.jsonl');
  writeFileSync(caps, '{"at":0.5,"text":"Pane opens"}\n{"at":1.5,"text":"Results land"}\n');
  const out = join(dir, 'cap.mp4');
  const r = spawnSync('node', [SCRIPT, '--before', join(dir, 'change.mp4'), '--after', join(dir, 'change.mp4'), '--out', out, '--sync-crop', CROP, '--lead', '0.5', '--tail', '0', '--captions', caps]);
  assert.equal(r.status, 0, r.stderr.toString());
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim().split(',').map(Number);
  assert.deepEqual([w, h], [1924, 600 + bandSize(1924).height]);
});
