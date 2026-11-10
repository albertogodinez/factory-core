#!/usr/bin/env node
// Burn captions into a band under a recording, so a viewer knows what each stretch shows ("quick replies at 16/22",
// "no drawer without an artifact"). The band sits below the video, never over the UI it describes.
//
//   node caption.mjs --in <take.webm|mp4> --captions <take.captions.jsonl> --out <mp4> [--offset <s>]
//
// Captions are JSON Lines, one {"at": <seconds into the take>, "text": "..."} per line; `caption` in record-lib.sh
// writes them while the take runs. Each one shows from its `at` until the next one starts. --offset is subtracted
// from every `at`, for a video cut from the take at that point (side-by-side.mjs passes its trim).
// Needs ffmpeg, ffprobe and magick (captions are PNG overlays, since not every ffmpeg build has drawtext).
// Exit 0: written. 1: usage or a bad captions file. 2: a tool is missing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
export const BAND_BG = '0x111827';

/** @param {string} file @returns {{ at: number, text: string }[]} sorted by `at` */
export function readCaptions(file) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((line, i) => {
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      throw new Error(`${file}:${i + 1}: not JSON`);
    }
    if (typeof c.at !== 'number' || c.at < 0 || typeof c.text !== 'string' || !c.text.trim()) {
      throw new Error(`${file}:${i + 1}: want {"at": <seconds >= 0>, "text": "<non-empty>"}`);
    }
    return { at: c.at, text: c.text.trim() };
  }).sort((a, b) => a.at - b.at);
}

/**
 * GitHub fits a video to the ~880px PR body column, so size the text from the video's width: it reads at about
 * 15px on screen whether the video is one 1440px take or a 1924px side-by-side.
 * @param {number} width
 */
export function bandSize(width) {
  const pointsize = Math.max(20, Math.round(width / 58));
  // Even, because libx264 with yuv420p refuses an odd frame height.
  return { pointsize, height: 2 * Math.round(pointsize * 1.1) };
}

/**
 * Renders one PNG per caption and returns the ffmpeg pieces that pad `[in]` with the band and overlay each caption
 * during its window, ending at `[out]`. Caption PNGs are inputs `first`, `first + 1`, ….
 * @param {{ at: number, text: string }[]} captions @param {string} dir
 * @param {{ width: number, height: number, offset?: number, first: number, inLabel: string, outLabel: string }} o
 */
export function captionFilter(captions, dir, { width, height, offset = 0, first, inLabel, outLabel }) {
  const band = bandSize(width);
  const shifted = captions.map((c) => ({ ...c, at: Math.max(0, c.at - offset) }));
  const inputs = shifted.map((c, i) => {
    const f = join(dir, `cap${i}.png`);
    execFileSync('magick', ['-background', `#${BAND_BG.slice(2)}`, '-fill', 'white', '-font', FONT, '-pointsize', String(band.pointsize),
      '-size', `${width - 32}x${band.height}`, '-gravity', 'west', `caption:${c.text}`, '-gravity', 'center', '-extent', `${width}x${band.height}`, f]);
    return f;
  });
  let chain = `[${inLabel}]pad=${width}:${height + band.height}:0:0:color=${BAND_BG}[cb0]`;
  shifted.forEach((c, i) => {
    const end = shifted[i + 1]?.at;
    const enable = end === undefined ? `gte(t,${c.at})` : `between(t,${c.at},${end})`;
    chain += `;[cb${i}][${first + i}:v]overlay=0:${height}:enable='${enable}'[${i === shifted.length - 1 ? outLabel : `cb${i + 1}`}]`;
  });
  if (!shifted.length) chain = `[${inLabel}]pad=${width}:${height + band.height}:0:0:color=${BAND_BG}[${outLabel}]`;
  return { inputs, chain };
}

function probe(file) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    .toString().trim().split(',').map(Number);
  return { w, h };
}

function fail(code, message) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

function main() {
  const { values: o } = parseArgs({ options: { in: { type: 'string' }, captions: { type: 'string' }, out: { type: 'string' }, offset: { type: 'string', default: '0' } } });
  if (!o.in || !o.captions || !o.out) fail(1, 'usage: caption.mjs --in <take> --captions <jsonl> --out <mp4> [--offset s]');
  for (const tool of ['ffmpeg', 'ffprobe', 'magick']) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' });
    } catch {
      fail(2, `${tool} is not installed`);
    }
  }
  let captions;
  try {
    captions = readCaptions(o.captions);
  } catch (e) {
    fail(1, e.message);
  }
  if (!captions.length) fail(1, `${o.captions} has no captions`);
  const { w, h } = probe(o.in);
  // libx264 with yuv420p needs even dimensions.
  const width = w - (w % 2);
  const height = h - (h % 2);
  const work = mkdtempSync(join(tmpdir(), 'caption-'));
  try {
    const { inputs, chain } = captionFilter(captions, work, { width, height, offset: Number(o.offset), first: 1, inLabel: 'v0', outLabel: 'v' });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', o.in, ...inputs.flatMap((f) => ['-i', f]),
      '-filter_complex', `[0:v]crop=${width}:${height}:0:0[v0];${chain}`, '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '32', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', o.out], { stdio: 'inherit' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`✓ ${o.out} (${captions.length} captions, ${Math.round(statSync(o.out).size / 1024)} KB)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
