---
name: toolkit-record-flow
description: Record a screen video of a feature flow in a signed-in agent-browser session with a slow, visible cursor, then encode it to a small H.264 MP4 with a contact sheet under the project's untracked state directory, and write the findings for the PR body; stacks a before take and an after take into one synced side-by-side MP4. Use for PR evidence, demos, bug reports, or validating a flow on camera. Triggers on "record a video of", "before/after video", "side by side", "screen recording", "record this flow", "slow cursor recording", "make a demo video", "record it with agent-browser".
user_invocable: true
---

# Record a flow

Produces `<stateRoot>/recordings/<YYYY-MM-DD>-<slug>/`: `<slug>.mp4`, `contact-sheet.jpg`, and an
optional local `README.md`. Raw takes and take scripts sit beside it in `<stateRoot>/recordings/`.
Get `<stateRoot>` once with `node .agents/skills/toolkit-context/scripts/resolve.mjs --field stateRoot`
and `mkdir -p "<stateRoot>/recordings"`. In the examples below, `$STATE` is that path.

If a `toolkit-record-flow-*` companion is installed, read it first: it holds app-specific helpers
and gotchas.

**Nothing here is pushed, and nothing here lasts.** The state directory is untracked and may be wiped at any
time, so the findings go in the PR body and the video is attached to the PR (a browser upload to the PR, or `gh` if your version
supports attaching files) or the chat thread before you move on. Don't force-add anything, and don't link a recording path from a tracked
doc: nobody else has it, and soon you won't either.

It records an existing agent-browser session; it does not sign in, start servers, or decide what
to show. If the project's app needs sign-in, use the auth skill for that app if one is installed, then take
the flow from the project's feature map if it has one.

## Requirements

- agent-browser **0.38+** for `record start --cursor` and `mouse move --human --duration`.
  `scripts/record-lib.sh` checks and refuses older versions. If the one on `PATH` is older, set
  `AGENT_BROWSER_BIN` to a 0.38+ binary; the session must have been started by that same version.
- `ffmpeg` and `ffprobe` for `scripts/encode.sh`; `jq` and `python3` for `scripts/record-lib.sh`.
- **Windows:** `record-lib.sh`, `take-template.sh` and `encode.sh` are bash and stay that way: they
  drive agent-browser and ffmpeg through shell loops, and `record-lib.sh` is sourced into the take
  script. Run them in WSL or Git Bash. `side-by-side.mjs`, `caption.mjs` and `build-page.mjs` are plain
  Node and run anywhere with `ffmpeg` on `PATH`.

## Steps

1. **Explore unrecorded.** Drive the flow once and note the exact prompts and element names that
   work. Agent replies vary; a take built on a guess fails halfway.
2. **Take script.** For a before/after pair, configure `scripts/take-template.sh` through environment
   variables (prompt, target button, results-wait JS, label, optional `SIZE`) rather than copying it; it
   writes `<label>.webm` and a `<label>.json` with t0/click/results timestamps. Otherwise write a
   script in `$STATE/recordings/` that sources the helpers:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   RECORD_SESSION=my-app
STATE=$(node .agents/skills/toolkit-context/scripts/resolve.mjs --field stateRoot)
   source .agents/skills/toolkit-record-flow/scripts/record-lib.sh
   record_begin "$STATE/recordings/<slug>-take1.webm"
   slow_type "$(ref 'textbox "What are you looking for"')" "<prompt>"
   slow_click "$(ref 'button "Send"')"
   ab wait --text "<expected text>" --timeout 240000 >/dev/null || record_abort "no reply"
   settle || record_abort "reply never settled"
   ab snapshot -i | grep -q '<expected element>' || record_abort "agent answered without <thing>"
   slow_click "$(ref '<next element>')"
   record_end
   ```
   | Helper | Does |
   |---|---|
   | `record_begin <path> [WxH]` / `record_end` | set the viewport (`WxH`, else `VIEWPORT_W`/`VIEWPORT_H`, else 1440×900), start/stop with the cursor overlay at 30 fps; writes `<take>.take.json` with the page URL and, with `RECORD_APP_DIR=<served worktree>`, its commit |
   | `visible_button <name> [css-scope]` | a JS expression for the one visible button with that text or aria-label; throws on 0 or 2+ visible matches, so a hidden duplicate can't be picked |
   | `highlight <js-expr> <label> [color] [below\|above]` / `unhighlight` | outline the element and pin a label; exit 1 if nothing matched. Unhighlight right after the click: the label is fixed to the viewport |
   | `ref '<regex>'` | `@eN` ref of the first `snapshot -i` line that matches |
   | `glide <x> <y>` | move the cursor to a point over `GLIDE_MS` |
   | `slow_click <ref>` | glide to the element's centre over `GLIDE_MS` (1400), pause, click |
   | `slow_type <ref> <text>` | slow-click a textbox, then type |
   | `settle` | wait until the last chat reply stops changing for ~12 s and nothing is "Queued" (`SETTLE_JS` to override for an app whose chat isn't `[role=group]`) |
   | `mark <label>` | log this moment to `<take>.marks`; the contact sheet gets one frame per mark |
   | `caption "<text>"` | from now until the next caption, the band under the video says this; writes `<take>.captions.jsonl` |
   | `now` | epoch seconds with milliseconds, for timestamps (macOS `date` has no `%N`) |
   | `record_abort <why>` | stop the take and exit non-zero, so a bad take is never kept |
   | `ab …` | agent-browser on `RECORD_SESSION` |
   **Captions are optional; add them when a viewer could watch the video and not know what to look
   at.** Caption a take that shows several changes in a row (one per PR row: "No drawer before the
   first artifact", "Quick replies at 16/22", "Scrollbar appears on hover"), or a change that is an
   absence or a style a glance misses. Skip them for a take showing one obvious interaction. Call
   `caption` just before the step it names, in a few words that say what to look at, not what the
   cursor does ("Next up card: 32px corners", not "Scrolling down"). The band sits under the video,
   never over the UI.
3. **Run it** (the template's setup waits until the target is ready, and runs a companion's question helpers if it loaded them via `EXTRA_LIB`). Wait for each agent turn to settle before sending the next; a send during a run
   is "Queued" on camera. Guard every step that depends on the agent and discard failed takes.
4. **Encode** from the repo root:
   ```bash
   .agents/skills/toolkit-record-flow/scripts/encode.sh "$STATE/recordings/<slug>-take1.webm" \
     "$STATE/recordings/<YYYY-MM-DD>-<slug>" <slug> [--captions "$STATE/recordings/<slug>-take1.captions.jsonl"]
   ```
   Then open `contact-sheet.jpg` and check its frames show the flow, not a spinner. A take with
   `mark` calls gets one frame per mark, and `contact-sheet.txt` gives each tile's time and label,
   so call `mark` right after every state the video has to prove. Without marks the sheet is six
   evenly spaced frames, which can miss a short state entirely.
5. **Before/after comparison** (a change whose point is timing: a jump, an animation, a loading hand-off, a load-order race). For a race, each take uses the trigger that reproduced it (the same request order as the failure, forced by slowing the load that loses), so the before half shows the bug. If no take shows it, the PR says the video evidence is missing rather than that the race can't be filmed. Record
   the same take script against each build, one dev server at a time, before from a worktree detached at the branch's merge base
   (`git worktree add --detach <path> $(git merge-base HEAD origin/<trunk>)`), not trunk's tip. Then
   stack them:
   ```bash
   node .agents/skills/toolkit-record-flow/scripts/side-by-side.mjs --before <before.webm> --after <after.webm> \
     --after-label "After (#<PR>)" --out "$STATE/recordings/<YYYY-MM-DD>-<slug>/<slug>-side-by-side.mp4" \
     [--captions <after-take>.captions.jsonl]
   ```
   It syncs both halves on the click, which it finds as the first frame where `--sync-crop` changes (default: the
   work-pane header at 1440×900). Burns in each half's label alone, with no seconds-after-click timer (a timer reads as noise in a PR video). Holds the shorter take's last
   frame. Exit 3 means a take has no change in that region: point `--sync-crop` at what the click changes, or pass
   `--before-click`/`--after-click` in seconds. Injected highlight outlines defeat the default sync; find each
   click with `ffmpeg -i <take>.webm -vf "select='gt(scene,0.01)',showinfo" -f null - 2>&1 | grep pts_time` and pass it.
   **Each half runs from its click minus `--lead` (2 s)**, so a label drawn earlier is cut: keep
   highlights up through the cursor's glide, clear them right after the click, and look at the
   output's first frame. Both halves press the same control, or the removed control in before and
   its replacement in after, captioned so. The before half is the branch's merge base: name it in the
   body from `<take>.take.json`. With one dev server, swap builds one at a time (a `toolkit-dev-slot` skill, if installed, gives each worktree its own).
   **Both takes on one saved conversation share its conversation**, so the after take proves only the new path: show
   separately that what the removed control was for still works, and run a take that sends an agent turn on a
   throwaway conversation. A timestamp taken after `ab record start` is about 2.1 s early, because
   the command returns after capture has begun, so sync on pixels. Open frames at 0.3 s and at each landing before
   attaching. `--captions` takes the after take's captions file and spans both halves. `node --test scripts/side-by-side.test.mjs` covers the refusal;
   `scripts/caption.test.mjs` covers the caption band; `scripts/record-lib.test.mjs` covers `record_begin`.
6. **Write up the findings**, in two places. The PR body (or bug report) gets a
   `Recorded at` line above each video with the sha linked (the PR-creation skill, if installed, says how), one line on what the video shows, and steps
   a reviewer can follow on any account to see it, e.g. "Ask for 2 adults in Las Vegas, open a
   hotel: the insights carousel shows v2." The run's report gets the rest: prompts in order, env and
   package versions, what was unreachable and why, and how it was recorded (agent-browser version,
   cursor flags, CRF 32). Save that as `README.md` next to the video if you want a local copy; it
   stays local.
7. **A self-contained page** (an explainer or bug report the user opens or annotates): write the
   page with placeholders and build it, rather than inlining base64 by hand:
   ```bash
   node .agents/skills/toolkit-record-flow/scripts/build-page.mjs src.html out.html \
     --assets "$STATE/recordings/<YYYY-MM-DD>-<slug>" --assets <screenshots dir>
   ```
   `{{style}}` is the bundled Plannotator theme (`assets/explainer-theme.css`: `.ve-card`,
   `.chip`, `.grid`, `.steps`, light and dark), `{{img:<file>}}` and `{{vid:<file>}}` become data
   URIs, `{{css:<file>}}` inlines a stylesheet. It writes nothing while a file is missing (exit 1), or while a
   placeholder is misplaced (exit 3): `{{img:}}`/`{{vid:}}` outside a `src`/`poster`/`href`
   attribute, or `{{style}}`/`{{css:}}` inside a `<style>`, since each emits its own. Keep the
   `src.html` beside the output so the page can be rebuilt after an edit.
   `node --test scripts/build-page.test.mjs` covers the placeholders and the missing-file refusal.

## Gotchas

- Set the viewport through `record_begin <path> WxH`: a `ab set viewport` before it is overwritten.
- The browser daemon resolves a relative `record start` or `screenshot` path against its own cwd,
  not yours. A relative record path printed "Recording started", then "ffmpeg write failed: Broken
  pipe", and wrote nothing. `record_begin` makes its path absolute; pass absolute paths to any
  `ab screenshot` you call yourself.
- Wrap each `ab eval` body in `(()=>{ … })()`. Evals share the page's global scope, so a second
  `const r = …` fails with "Identifier 'r' has already been declared" and loses the take.
- `timeout` does not exist on macOS. Bound a wait with agent-browser's `--timeout` or a counted loop.
- Use `glide <x> <y>` from `record-lib.sh` for cursor moves. Calling `ab mouse move`
  yourself, put the flags after the coordinates: `<x> <y> --human --duration N`; flags first fails
  with "Missing arguments for: mouse move" and the take is lost.
- Clicking a ref inside a carousel or sheet can miss while it animates; `slow_click` pauses
  before and after for this. Raise `GLIDE_MS` for a slower demo.
- `slow_click` on a ref another element covers (overlapping map cards) fails and loses the take.
  `ref` returns the first match, so pick the topmost yourself (`ab snapshot -i | grep … | tail -1`)
  or `glide` to a point only that element covers and click there.
- **PR evidence is recorded on live data; mock routes are for iterating.** A mock route can draw controls the product doesn't have, so a reviewer can't tell them from the product. Iterate on the mock, then record both builds on a live conversation or fixture that has the state the take needs.
- Don't record a HAR alongside: it adds nothing (streamed bodies aren't captured) and it holds
  auth headers.
- Leave the session open afterwards if the user wants to look at the same state.
