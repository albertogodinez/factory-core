#!/usr/bin/env bash
# Helpers for a slow-cursor screen recording with agent-browser. Source this from a per-feature
# take script, set RECORD_SESSION first, then call record_begin / slow_click / settle / record_end.
#
#   STATE=$(node .agents/skills/factory-context/scripts/resolve.mjs --field stateRoot)
#   RECORD_SESSION=my-app source .agents/skills/factory-record-flow/scripts/record-lib.sh
#   record_begin "$STATE/recordings/take1.webm"
#   slow_click "$(ref 'button "Send"')"
#   mark "reply rendered"        # a contact-sheet frame at this moment
#   record_end
#
# Needs agent-browser 0.38+ (`record start --cursor`, `mouse move --human --duration`). Point
# AGENT_BROWSER_BIN at a 0.38+ binary if the one on PATH is older.

: "${RECORD_SESSION:?set RECORD_SESSION to the agent-browser session to record}"
AGENT_BROWSER_BIN="${AGENT_BROWSER_BIN:-agent-browser}"
GLIDE_MS="${GLIDE_MS:-1400}"

ab() { "$AGENT_BROWSER_BIN" --session "$RECORD_SESSION" "$@"; }

require_recording_support() {
  local version major minor
  version=$("$AGENT_BROWSER_BIN" --version 2>/dev/null | awk '{print $NF}')
  major=${version%%.*}; minor=${version#*.}; minor=${minor%%.*}
  if [ -z "$version" ] || { [ "$major" -eq 0 ] && [ "$minor" -lt 38 ]; }; then
    echo "✗ agent-browser ${version:-not found} can't record with a cursor; need 0.38+ (set AGENT_BROWSER_BIN)" >&2
    return 2
  fi
}

# The ref of the first interactive element whose snapshot line matches the regex, as "@eN".
# The ref is the last attribute: `[ref=e3]`, or `[expanded=true, ref=e3]` when the line has others.
ref() { ab snapshot -i | grep -m1 -E "$1" | sed -E 's/.*[[ ]ref=(e[0-9]+)\].*/@\1/'; }

# Glide the pointer to x y over GLIDE_MS (the flags go after the coordinates, or agent-browser refuses).
glide() { ab mouse move "$1" "$2" --human --duration "$GLIDE_MS" >/dev/null; }

# Glide the pointer to the element's centre over GLIDE_MS, pause, then click it.
slow_click() {
  local target=$1 box x y
  box=$(ab --json get box "$target")
  x=$(jq -r '.data.x + .data.width / 2 | floor' <<<"$box")
  y=$(jq -r '.data.y + .data.height / 2 | floor' <<<"$box")
  glide "$x" "$y"
  sleep 0.7
  ab click "$target" >/dev/null
  sleep 0.8
}

# Slow-click a textbox and type into it.
slow_type() {
  slow_click "$1"
  ab type "$1" "$2" >/dev/null
  sleep 1.2
}

# Wait until the page's last chat reply has stopped changing for ~12 s (4 checks, 3 s apart) and
# nothing is "Queued". Override SETTLE_JS for an app whose chat isn't [role=group].
DEFAULT_SETTLE_JS='(()=>{const g=[...document.querySelectorAll("[role=group]")].pop();return (g?g.innerText.length:0)+":"+(/Queued/.test(document.body.innerText))})()'
SETTLE_JS="${SETTLE_JS:-$DEFAULT_SETTLE_JS}"
settle() {
  local prev="" cur same=0
  for _ in $(seq 1 120); do
    cur=$(ab eval "$SETTLE_JS")
    if [ "$cur" = "$prev" ]; then same=$((same + 1)); else same=0; fi
    [ "$same" -ge 4 ] && return 0
    prev=$cur
    sleep 3
  done
  return 1
}

_record_restore_traps() {
  trap - EXIT HUP INT TERM
  eval "$_RECORD_PREV_EXIT"
  eval "$_RECORD_PREV_HUP"
  eval "$_RECORD_PREV_INT"
  eval "$_RECORD_PREV_TERM"
}

_record_discard() {
  [ "${_RECORD_ACTIVE:-0}" = 1 ] || return 0
  _RECORD_ACTIVE=0
  if [ "${_RECORD_STARTED:-0}" = 1 ]; then ab record stop >/dev/null 2>&1 || true; fi
  rm -f -- "${_RECORD_FILES[@]}"
}

_record_status() { return "$1"; }

# trap -p emits shell-quoted code; decode it, then give the caller's trap its original status.
_record_run_trap() {
  local saved=$1 status=$2 command
  [ -n "$saved" ] || return 0
  saved=${saved#trap -- }; saved=${saved% *}
  eval "command=$saved"
  if _record_status "$status"; then eval "$command"; else eval "$command"; fi
}

_record_exit() {
  local status=$1
  _record_discard || true
  _record_restore_traps
  _record_run_trap "$_RECORD_PREV_EXIT" "$status"
  return "$status"
}

_record_signal() {
  local status=$1 saved=$2
  _record_discard || true
  _record_restore_traps
  _record_run_trap "$saved" "$status"
  exit "$status"
}

_record_begin_failed() {
  local status=$1
  _record_discard || true
  _record_restore_traps
  return "$status"
}

# record_begin <path> [WxH]: set the viewport (WxH, else VIEWPORT_W/H, else 1440x900), then start.
# Set the viewport here, not before: this call overwrites whatever was set earlier.
record_begin() {
  local out=${1:?output path} size=${2:-} w h file status
  [ "${_RECORD_ACTIVE:-0}" != 1 ] || { echo "✗ recording already active" >&2; return 2; }
  require_recording_support || return
  case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
  [ -d "$(dirname "$out")" ] || { echo "✗ record_begin: directory $(dirname "$out") does not exist" >&2; return 2; }
  if [ -n "$size" ]; then
    case "$size" in
      [0-9]*x[0-9]*) w=${size%x*}; h=${size#*x} ;;
      *) echo "✗ record_begin size must look like 2560x1300, got '$size'" >&2; return 2 ;;
    esac
  else
    w=${VIEWPORT_W:-1440}; h=${VIEWPORT_H:-900}
  fi
  RECORD_MARKS="$out.marks"
  RECORD_CAPTIONS="${out%.*}.captions.jsonl"
  RECORD_TAKE="${out%.*}.take.json"
  for file in "$out" "$RECORD_MARKS" "$RECORD_CAPTIONS" "$RECORD_TAKE"; do
    [ ! -e "$file" ] && [ ! -L "$file" ] || { echo "✗ recording output already exists: $file" >&2; return 2; }
  done
  if [ -n "${FACTORY_RUN_ID:-}" ]; then
    for file in "$out" "$RECORD_MARKS" "$RECORD_CAPTIONS" "$RECORD_TAKE"; do
      node "$(dirname "${BASH_SOURCE[0]}")/../../factory-teardown/scripts/producer.mjs" "$file" intermediate --pending || return
    done
  fi
  _RECORD_PREV_EXIT=$(trap -p EXIT)
  _RECORD_PREV_HUP=$(trap -p HUP)
  _RECORD_PREV_INT=$(trap -p INT)
  _RECORD_PREV_TERM=$(trap -p TERM)
  trap '_record_exit "$?"' EXIT
  trap '_record_signal 129 "$_RECORD_PREV_HUP"' HUP
  trap '_record_signal 130 "$_RECORD_PREV_INT"' INT
  trap '_record_signal 143 "$_RECORD_PREV_TERM"' TERM
  _RECORD_FILES=()
  _RECORD_STARTED=0
  for file in "$out" "$RECORD_MARKS" "$RECORD_CAPTIONS" "$RECORD_TAKE"; do
    if (set -C; : > "$file") 2>/dev/null; then
      _RECORD_FILES+=("$file")
      _RECORD_ACTIVE=1
    else
      echo "✗ cannot reserve recording output: $file" >&2
      _record_begin_failed 2
      return $?
    fi
  done
  ab set viewport "$w" "$h" >/dev/null || { _record_begin_failed "$?"; return $?; }
  ab mouse move 700 450 >/dev/null || { _record_begin_failed "$?"; return $?; }
  ab record start "$out" --cursor --fps 30 || { _record_begin_failed "$?"; return $?; }
  _RECORD_STARTED=1
  # `record start` returns about 2.1 s after capture begins, so the take's 0 s is that much earlier.
  RECORD_T0=$(python3 -c "import time;print(f'{time.time() - 2.1:.3f}')") || { _record_begin_failed "$?"; return $?; }
  # Which build this take shows, so "is the before really main?" is one jq away.
  # RECORD_APP_DIR is the worktree the server runs from (a slot's worktree).
  python3 -c 'import json,sys; json.dump({"url": sys.argv[1], "appDir": sys.argv[2] or None, "appSha": sys.argv[3] or None}, open(sys.argv[4], "w"))' \
    "$(ab get url 2>/dev/null)" "${RECORD_APP_DIR:-}" \
    "$([ -n "${RECORD_APP_DIR:-}" ] && git -C "$RECORD_APP_DIR" rev-parse HEAD 2>/dev/null)" "$RECORD_TAKE" || { _record_begin_failed "$?"; return $?; }
  sleep 2
}

# A JS expression for the one visible button named <name> (its text or aria-label), inside the
# optional <css-scope>. It throws when zero or several visible buttons match, so a highlight or
# click can't land on a hidden duplicate ("See all" exists in more than one place). The name is
# JSON-encoded, so quotes in it are safe.
visible_button() {
  python3 -c 'import json,sys; n,s=json.dumps(sys.argv[1]),json.dumps(sys.argv[2] or "body"); print(f"(()=>{{const n={n};const m=[...document.querySelectorAll({s}+\" button\")].filter(b=>(b.textContent.trim()===n||b.getAttribute(\"aria-label\")===n)&&b.offsetParent!==null&&b.getBoundingClientRect().width>0);if(m.length!==1)throw new Error(\"visible_button \"+n+\": \"+m.length+\" visible matches\");return m[0]}})()")' "$1" "${2:-}"
}

# Outline the element a JS expression returns and pin a label below it (or above with "above").
# Returns 1, and says so, when the expression finds nothing or throws, so a take never records a
# highlight that isn't there. Clear with unhighlight right after the click: the label is fixed to
# the viewport and stays put when the layout changes under it.
highlight() {
  local finder=$1 label=$2 color=${3:-#1b7f3b} pos=${4:-below} out
  out=$(ab eval "(()=>{const el=($finder);if(!el)return 'miss';el.style.outline='3px solid $color';el.style.outlineOffset='2px';el.setAttribute('data-record-hl','');const r=el.getBoundingClientRect();const t=document.createElement('div');t.className='__record_hl';t.textContent=$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$label");Object.assign(t.style,{position:'fixed',left:Math.max(4,Math.min(r.left,innerWidth-260))+'px',top:('$pos'==='above'?Math.max(4,r.top-28):r.bottom+6)+'px',background:'$color',color:'#fff',font:'700 13px sans-serif',padding:'3px 8px',borderRadius:'4px',zIndex:2147483647,pointerEvents:'none'});document.body.appendChild(t);return 'ok'})()" 2>&1)
  case "$out" in *'"ok"'*|ok) return 0 ;; esac
  echo "✗ highlight '$label': $out" >&2
  return 1
}

unhighlight() {
  ab eval "(()=>{document.querySelectorAll('.__record_hl').forEach(e=>e.remove());document.querySelectorAll('[data-record-hl]').forEach(e=>{e.style.outline='';e.style.outlineOffset='';e.removeAttribute('data-record-hl')});return 'ok'})()" >/dev/null
}

# Note this moment for the contact sheet: encode.sh takes one frame per mark from <take>.marks
# ("<seconds into the take><TAB><label>"). Mark once the state to show is on screen.
mark() {
  : "${RECORD_MARKS:?call record_begin first}"
  printf '%s\t%s\n' "$(awk -v a="$(now)" -v b="$RECORD_T0" 'BEGIN{printf "%.2f", a-b}')" "$*" >> "$RECORD_MARKS"
}

# caption "<what the viewer is looking at>": from now until the next caption, the band under the video shows
# this text. Appends {"at", "text"} to <take>.captions.jsonl for encode.sh / side-by-side.mjs --captions.
caption() {
  : "${RECORD_CAPTIONS:?caption runs after record_begin}"
  python3 -c 'import json,sys,time;print(json.dumps({"at":round(time.time()-float(sys.argv[1]),1),"text":sys.argv[2]}))' \
    "$RECORD_T0" "${1:?caption text}" >>"$RECORD_CAPTIONS"
}

record_end() {
  [ "${_RECORD_ACTIVE:-0}" = 1 ] || { echo "✗ no recording active" >&2; return 2; }
  sleep 2
  ab record stop || { _record_begin_failed "$?"; return $?; }
  _RECORD_ACTIVE=0
  _RECORD_STARTED=0
  _record_restore_traps
}

# Stop the take and fail, so a bad take is never kept by accident.
record_abort() {
  echo "✗ $1" >&2
  _record_discard || true
  exit 1
}

# Epoch seconds with milliseconds (macOS `date` has no %N).
now() { python3 -c 'import time;print(f"{time.time():.3f}")'; }
