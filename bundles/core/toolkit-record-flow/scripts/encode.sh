#!/usr/bin/env bash
# Turn a raw take into the durable recording: H.264 at CRF 32 and a contact sheet.
#   encode.sh <raw.webm|mp4> <out-dir> <name> [--captions <raw>.captions.jsonl]
# Writes <out-dir>/<name>.mp4 and <out-dir>/contact-sheet.jpg. With <raw>.marks beside the take
# (record-lib.sh `mark`), the sheet has one frame per mark, in order, and contact-sheet.txt lists
# each tile's time and label. Without it, six evenly spaced frames. --captions burns a band under the
# video saying what each stretch shows (caption.mjs); `caption` in record-lib.sh writes the file during the take.
set -euo pipefail
RAW=${1:?raw take}
OUT_DIR=${2:?output directory}
NAME=${3:?file name without extension}
CAPTIONS=""
if [ "${4:-}" = --captions ]; then CAPTIONS=${5:?--captions needs a file}; fi

command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "✗ ffmpeg/ffprobe not installed" >&2; exit 2; }
mkdir -p "$OUT_DIR"
MP4="$OUT_DIR/$NAME.mp4"

if [ -n "$CAPTIONS" ]; then
  node "$(dirname "$0")/caption.mjs" --in "$RAW" --captions "$CAPTIONS" --out "$MP4" >/dev/null
else
  ffmpeg -y -loglevel error -i "$RAW" -c:v libx264 -preset slow -crf 32 -pix_fmt yuv420p -movflags +faststart -an "$MP4"
fi

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MP4")
MARKS="$RAW.marks"
if [ -s "$MARKS" ]; then
  FRAMES=$(mktemp -d)
  n=0
  : > "$OUT_DIR/contact-sheet.txt"
  while IFS=$'\t' read -r at label; do
    [ -n "$at" ] || continue
    # A mark past the end (the take stopped early) takes the last frame.
    at=$(awk -v a="$at" -v d="$DURATION" 'BEGIN{printf "%.2f", (a < d - 0.1) ? a : d - 0.1}')
    n=$((n + 1))
    ffmpeg -y -loglevel error -ss "$at" -i "$MP4" -frames:v 1 -vf scale=720:-1 "$FRAMES/$(printf %03d "$n").jpg"
    printf '%d\t%ss\t%s\n' "$n" "$at" "$label" >> "$OUT_DIR/contact-sheet.txt"
  done < "$MARKS"
  cols=$(( n < 3 ? n : 3 )); rows=$(( (n + 2) / 3 ))
  ffmpeg -y -loglevel error -framerate 1 -i "$FRAMES/%03d.jpg" -vf "tile=${cols}x${rows}:color=white" -frames:v 1 "$OUT_DIR/contact-sheet.jpg"
  rm -rf "$FRAMES"
else
  # Six evenly spaced frames, skipping the first and last few percent, tiled 3x2.
  ffmpeg -y -loglevel error -i "$MP4" \
    -vf "select='isnan(prev_selected_t)+gte(t-prev_selected_t\,$(awk -v d="$DURATION" 'BEGIN{printf "%.2f", d/6.2}'))',scale=720:-1,tile=3x2" \
    -frames:v 1 -fps_mode vfr "$OUT_DIR/contact-sheet.jpg"
fi

printf '✓ %s (%s s, %s)\n' "$MP4" "$(printf %.0f "$DURATION")" "$(du -h "$MP4" | cut -f1)"
echo "✓ $OUT_DIR/contact-sheet.jpg${n:+ ($n marked frames, listed in contact-sheet.txt)}"
