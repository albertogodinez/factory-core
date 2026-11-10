// Run: node --test caption.test.mjs  (needs ffmpeg, ffprobe and magick)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { bandSize, readCaptions } from './caption.mjs';

const SCRIPT = fileURLToPath(new URL('./caption.mjs', import.meta.url));
let dir;
const HAS_MEDIA = ['ffmpeg', 'ffprobe'].every((bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0);
const mediaTest = HAS_MEDIA ? test : test.skip;

before(() => {
  if (!HAS_MEDIA) return;
  dir = mkdtempSync(join(tmpdir(), 'caption-test-'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1440x900:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'take.mp4')]);
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

mediaTest('reads captions in time order and refuses a malformed line', () => {
  const ok = join(dir, 'ok.jsonl');
  writeFileSync(ok, '{"at":2,"text":"Results"}\n\n{"at":0.4,"text":"Prompt sent"}\n');
  assert.deepEqual(readCaptions(ok).map((c) => c.text), ['Prompt sent', 'Results']);
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{"at":"soon","text":"x"}\n');
  assert.throws(() => readCaptions(bad), /bad\.jsonl:1/);
});

mediaTest('burns a band under the video, sized for the video width', () => {
  const caps = join(dir, 'caps.jsonl');
  writeFileSync(caps, '{"at":0,"text":"Nav bar not showing up"}\n{"at":1.5,"text":"Quick replies at 16/22"}\n');
  const out = join(dir, 'out.mp4');
  const r = spawnSync('node', [SCRIPT, '--in', join(dir, 'take.mp4'), '--captions', caps, '--out', out]);
  assert.equal(r.status, 0, r.stderr.toString());
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim().split(',').map(Number);
  assert.deepEqual([w, h], [1440, 900 + bandSize(1440).height]);
});

mediaTest('refuses an empty captions file and writes nothing', () => {
  const caps = join(dir, 'none.jsonl');
  writeFileSync(caps, '\n');
  const out = join(dir, 'none.mp4');
  const r = spawnSync('node', [SCRIPT, '--in', join(dir, 'take.mp4'), '--captions', caps, '--out', out]);
  assert.equal(r.status, 1);
  assert.equal(existsSync(out), false);
});
