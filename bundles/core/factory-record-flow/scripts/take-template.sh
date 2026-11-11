#!/usr/bin/env bash
# A before/after take, configured instead of forked. Copy nothing: set the variables below from
# the environment (or edit the defaults), run it once per build, and keep the two outputs.
#
#   RECORD_SESSION=my-app APP_URL=https://localhost:3000/ PROMPT='Search for ...' \
#   TARGET_RE='button "Save"' RESULTS_JS="document.querySelectorAll('.card').length > 0" \
#   LABEL=before .agents/skills/factory-record-flow/scripts/take-template.sh
#
# Writes <stateRoot>/recordings/<LABEL>.webm and <LABEL>.json ({label,target,t0,click,results} in epoch
# seconds), the timestamps the PR caption needs. Sync a side-by-side on pixels, not these:
# side-by-side.mjs explains why. Run from the repo root; SKIP_SETUP=1 reuses the open page.
set -u
# A project companion (factory-record-flow-*) can supply EXTRA_LIB, a file of shell helpers sourced
# after record-lib.sh; if it defines answer_open_question / unstick_pane the setup loop uses them.
RECORD_SESSION=${RECORD_SESSION:?set RECORD_SESSION to the agent-browser session}
APP_URL=${APP_URL:-}                     # page opened during setup; unused with SKIP_SETUP=1
APP_HEADERS=${APP_HEADERS:-}             # optional JSON of extra request headers for that page
INPUT_RE=${INPUT_RE:-'textbox'}          # the input the prompt is typed into, as a snapshot -i line
EXTRA_LIB=${EXTRA_LIB:-}
PROMPT=${PROMPT:-}                       # sent during setup; unused with SKIP_SETUP=1
TARGET_RE=${TARGET_RE:-}                 # the button the take clicks, as a snapshot -i regex
READY_JS=${READY_JS:-}                   # optional: JS that is true once the page may be recorded
RESULTS_JS=${RESULTS_JS:-}               # JS that is true once the click's result is on screen
CARD_RE=${CARD_RE:-}                     # optional: artifact card to re-open if the pane sticks
BUSY_RE=${BUSY_RE:-'Gathering|Thinking|Searching|Digging|Checking|Comparing|Looking|Pulling'}
LABEL=${LABEL:-}                         # output name: <stateRoot>/recordings/<LABEL>.webm
SIZE=${SIZE:-}                           # optional WxH, e.g. 2560x1300; default 1440x900
SETUP_TRIES=${SETUP_TRIES:-60}           # x 5 s
RESULTS_TIMEOUT_MS=${RESULTS_TIMEOUT_MS:-150000}
SKIP_SETUP=${SKIP_SETUP:-}
for v in TARGET_RE RESULTS_JS LABEL; do
  [ -n "${!v}" ] || { echo "✗ set $v" >&2; exit 2; }
done
[ -n "$SKIP_SETUP" ] || [ -n "$PROMPT" ] || { echo "✗ set PROMPT, or SKIP_SETUP=1" >&2; exit 2; }
[ -n "$SKIP_SETUP" ] || [ -n "$APP_URL" ] || { echo "✗ set APP_URL, or SKIP_SETUP=1" >&2; exit 2; }

cd "$(git rev-parse --show-toplevel)" || exit 1
source .agents/skills/factory-record-flow/scripts/record-lib.sh
[ -z "$EXTRA_LIB" ] || source "$EXTRA_LIB"
STATE=${FACTORY_STATE_ROOT:-}
if [ -z "$STATE" ]; then
  STATE=$(node .agents/skills/factory-context/scripts/resolve.mjs --field stateRoot) || exit 1
fi
case "$STATE" in /*) ;; *) echo "Invalid state root" >&2; exit 2 ;; esac
export FACTORY_STATE_ROOT="$STATE"
LIFECYCLE=.agents/skills/factory-teardown/scripts/lifecycle.mjs
if [ -f "$LIFECYCLE" ]; then
  if [ -n "${FACTORY_RUN_ID:-}" ]; then
    RUN=$(node "$LIFECYCLE" show --run "$FACTORY_RUN_ID" --state-root "$STATE") || exit 1
  else
    RUN=$(node "$LIFECYCLE" begin --kind recording --state-root "$STATE") || exit 1
  fi
  FACTORY_RUN_ID=$(printf '%s' "$RUN" | jq -er '.id | strings | select(length > 0)') || exit 1
  STATE=$(printf '%s' "$RUN" | jq -er '.dir | strings | select(startswith("/"))') || exit 1
  export FACTORY_RUN_ID
  echo "Recording run: $FACTORY_RUN_ID; keep it active through encoding/upload, then release inputs and teardown." >&2
elif [ -n "${FACTORY_RUN_ID:-}" ]; then
  echo "FACTORY_RUN_ID requires factory-teardown; install it or unset the run binding" >&2
  exit 2
fi
mkdir -p "$STATE/recordings" || exit 1
OUT=$STATE/recordings/$LABEL

running() { ab snapshot | grep -q -E "$BUSY_RE"; }
ready() {
  ab snapshot -i | grep -q -E "$TARGET_RE" || return 1
  running && return 1
  [ -z "$READY_JS" ] || ab eval "($READY_JS) ? 'ready-yes' : 'ready-no'" | grep -q 'ready-yes'
}

if [ -z "$SKIP_SETUP" ]; then
  ab open "$APP_URL" ${APP_HEADERS:+--headers "$APP_HEADERS"} >/dev/null; sleep 5
  ab fill "$(ref "$INPUT_RE")" "$PROMPT" >/dev/null; ab press Enter >/dev/null
  tries=0
  until ready; do
    tries=$((tries + 1)); [ "$tries" -le "$SETUP_TRIES" ] || { echo "✗ '$TARGET_RE' never became ready" >&2; exit 1; }
    sleep 5
    if declare -F answer_open_question >/dev/null; then
      answer_open_question || { [ -z "$CARD_RE" ] || ! declare -F unstick_pane >/dev/null || unstick_pane "$CARD_RE" || true; }
    fi
  done
fi
ab snapshot -i | grep -q -E "$TARGET_RE" || { echo "✗ no target matching '$TARGET_RE'" >&2; exit 1; }
settle || true

TARGET_LINE=$(ab snapshot -i | grep -m1 -E "$TARGET_RE" | sed -E 's/^[^a-z]*//; s/ \[.*//')
record_begin "$OUT.webm" ${SIZE:+"$SIZE"}
T0=$(now)
sleep 1
TARGET_REF=$(ref "$TARGET_RE")          # refs can renumber while the page settles
box=$(ab --json get box "$TARGET_REF")
glide "$(jq -r '.data.x + .data.width / 2 | floor' <<<"$box")" "$(jq -r '.data.y + .data.height / 2 | floor' <<<"$box")"
sleep 0.7
ab click "$TARGET_REF" >/dev/null; TC=$(now)
sleep 2
ab wait --fn "$RESULTS_JS" --timeout "$RESULTS_TIMEOUT_MS" >/dev/null || record_abort "results never appeared"
TR=$(now)
sleep 5
record_end
if [ -n "${FACTORY_RUN_ID:-}" ]; then
  node .agents/skills/factory-teardown/scripts/producer.mjs "$OUT.json" intermediate --pending || exit 1
fi
jq -n --arg label "$LABEL" --arg target "$TARGET_LINE" --argjson t0 "$T0" --argjson click "$TC" --argjson results "$TR" \
  '{label:$label,target:$target,t0:$t0,click:$click,results:$results}' | tee "$OUT.json"
