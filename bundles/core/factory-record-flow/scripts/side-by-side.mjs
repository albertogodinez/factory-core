#!/usr/bin/env node
// Stack a before take and an after take into one MP4, both synced on the click, each half labelled with its
// label alone (no running timer). For a change whose point is timing: a pane that jumps, an animation, a loading hand-off.
//
//   node side-by-side.mjs --before <take> --after <take> --out <mp4>
//        [--sync-crop WxH+X+Y] [--before-click <s>] [--after-click <s>]
//        [--before-label "Before (main)"] [--after-label "After (#123)"] [--lead 2] [--tail 3]
//        [--captions <after-take.captions.jsonl>]
//
// The click time in each take is the first frame where --sync-crop (default 400x40+440+100, the work-pane header at
// 1440 x 900) differs from the take's first frame. Pass --before-click / --after-click (seconds into the raw take) to
// skip detection. The wall clock is no substitute: `agent-browser record start` returns about 2.1 s after capture
// begins, so a timestamp taken after it is that much early.
// Each half runs from its click minus --lead to the end of its take; the shorter one holds its last frame.
// --captions burns a band under both halves saying what the viewer is looking at (caption.mjs); its times are seconds
// into the after take, as `caption` in record-lib.sh writes them.
// Needs ffmpeg, ffprobe and magick (labels are PNG overlays, since not every ffmpeg build has drawtext).
// Exit 0: written. 1: usage. 2: a tool is missing. 3: no pane change found, so the takes can't be synced.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { captionFilter, readCaptions } from './caption.mjs';

const run = promisify(execFile);
const FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const HALF = { w: 960, h: 600 };

/** @param {string} file */
export function duration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
}

/**
 * Seconds into `file` of the first frame (at 30 fps) whose `crop` region differs from the first frame by more than
 * `threshold` (mean absolute grey level, 0-255, sampling every 7th pixel); null when none does before `end`.
 * @param {string} file @param {string} crop @param {{ start?: number, end?: number, threshold?: number }} [opts]
 */
export function firstChange(file, crop, { start = 0, end = 30, threshold = 12 } = {}) {
  const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(crop);
  if (!m) throw new Error(`bad crop "${crop}", want WxH+X+Y`);
  const [w, h, x, y] = m.slice(1).map(Number);
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(start), '-t', String(end - start), '-i', file,
    '-vf', `fps=30,crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const n = w * h;
  if (raw.length < n) return null;
  for (let f = 1; f * n + n <= raw.length; f += 1) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i += 7) {
      sum += Math.abs(raw[f * n + i] - raw[i]);
      count += 1;
    }
    if (sum / count > threshold) return Math.round((start + f / 30) * 1000) / 1000;
  }
  return null;
}

/** Writes 10 fps label frames showing the label alone; a burned-in timer reads as noise in a PR video. */
async function labelFrames(label, dir, total) {
  mkdirSync(dir, { recursive: true });
  const jobs = Array.from({ length: Math.floor(total * 10) + 1 }, (_, i) => i);
  const one = (i) => {
    const text = label;
    return run('magick', ['-size', '470x44', 'xc:rgba(17,24,39,0.82)', '-font', FONT, '-pointsize', '22', '-fill', 'white',
      '-gravity', 'west', '-annotate', '+12+0', text, join(dir, `f${String(i).padStart(4, '0')}.png`)]);
  };
  for (let k = 0; k < jobs.length; k += 16) await Promise.all(jobs.slice(k, k + 16).map(one));
}

function fail(code, message) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

async function main() {
  const { values: o } = parseArgs({
    options: {
      before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' },
      'sync-crop': { type: 'string', default: '400x40+440+100' },
      'before-click': { type: 'string' }, 'after-click': { type: 'string' },
      'before-label': { type: 'string', default: 'Before (main)' }, 'after-label': { type: 'string', default: 'After' },
      lead: { type: 'string', default: '2' }, tail: { type: 'string', default: '3' },
      captions: { type: 'string' }
    }
  });
  if (!o.before || !o.after || !o.out) fail(1, 'usage: side-by-side.mjs --before <take> --after <take> --out <mp4> [options]');
  let captions = [];
  if (o.captions) {
    try {
      captions = readCaptions(o.captions);
    } catch (e) {
      fail(1, e.message);
    }
  }
  for (const tool of ['ffmpeg', 'ffprobe', 'magick']) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' });
    } catch {
      fail(2, `${tool} is not installed`);
    }
  }
  const found = [
    { file: o.before, label: o['before-label'], given: o['before-click'] },
    { file: o.after, label: o['after-label'], given: o['after-click'] }
  ].map((take) => {
    const length = duration(take.file);
    const click = take.given !== undefined ? Number(take.given) : firstChange(take.file, o['sync-crop'], { end: Math.min(length, 60) });
    if (click === null) {
      fail(3, `no change in ${o['sync-crop']} in ${take.file}: the click can't be found. Pass --sync-crop over a region the click changes, or --before-click/--after-click`);
    }
    return { ...take, click, length };
  });
  // A click earlier than --lead shortens the lead for both halves, so both clicks still land on the same frame.
  const lead = Math.min(Number(o.lead), ...found.map((t) => t.click));
  const takes = found.map((t) => ({ ...t, from: t.click - lead }));
  const total = Math.round((lead + Math.max(...takes.map((t) => t.length - t.click)) + Number(o.tail)) * 10) / 10;
  console.log(takes.map((t) => `${t.label}: click at ${t.click.toFixed(2)} s`).join(', ') + `; ${total} s long`);

  const work = mkdtempSync(join(tmpdir(), 'side-by-side-'));
  try {
    await Promise.all(takes.map((t, i) => labelFrames(t.label, join(work, `l${i}`), total)));
    const half = (i) => `[${i}:v]setpts=PTS-STARTPTS,fps=30,scale=${HALF.w}:${HALF.h},tpad=stop_mode=clone:stop_duration=${total},trim=duration=${total}[v${i}];` +
      `[v${i}][${i + 2}:v]overlay=8:8:eof_action=repeat[o${i}]`;
    const stacked = `${half(0)};${half(1)};[o0]pad=${HALF.w + 4}:${HALF.h}:0:0:color=white[p0];[p0][o1]hstack=inputs=2`;
    const cap = captions.length
      ? captionFilter(captions, work, { width: 2 * HALF.w + 4, height: HALF.h, offset: takes[1].from, first: 4, inLabel: 's', outLabel: 'v' })
      : null;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-ss', String(takes[0].from), '-i', takes[0].file, '-ss', String(takes[1].from), '-i', takes[1].file,
      '-framerate', '10', '-i', join(work, 'l0', 'f%04d.png'), '-framerate', '10', '-i', join(work, 'l1', 'f%04d.png'),
      ...(cap?.inputs ?? []).flatMap((f) => ['-i', f]),
      '-filter_complex', cap ? `${stacked}[s];${cap.chain}` : `${stacked}[v]`,
      '-map', '[v]', '-t', String(total), '-c:v', 'libx264', '-preset', 'slow', '-crf', '32', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an', o.out], { stdio: 'inherit' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`✓ ${o.out} (${total} s, ${Math.round(statSync(o.out).size / 1024)} KB)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
