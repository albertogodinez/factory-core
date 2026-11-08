---
name: toolkit-pr-create
description: 'Open any PR, stacked or not. Use instead of a bare `gh pr create`, which skips the stack link. Triggers on "open a PR", "PR this", "stack this on #NNN", "open the stacked PR". Writes the title and body from the repo template, links the stack, and with a tracker adapter links the ticket and moves it to review.'
user_invocable: true
---

# Create a PR

One skill owns the PR itself: title, body, stack link, ticket link. Stack mechanics (rebases, merges, parents that squash-merged) and CI or bot-review triage belong to other skills (`toolkit-stacked-pr` and `toolkit-pr-ci-monitor`, when installed). Read those when the situation calls for them; don't duplicate them here.

Script paths below assume the skills are installed under `.agents/skills/`.

## 0. Resolve the project

```bash
R=.agents/skills/toolkit-context/scripts/resolve.mjs
node $R --field project.trunk          # never guess the trunk
node $R --field project.prTemplate
node $R --field project.remote.host
node $R --field project.remote.slug
node $R --field project.commands.test  # also .lint, .build
node $R --field adapters.tracker       # exit 1 means none is configured
node $R --field writeAllowed
```

For a PR in a neighbor repo, add `--repo <name>`; that repo's own trunk, template and commands apply.

If `gh` can't resolve the repo from the git remote (an SSH host alias gives *"none of the git remotes … point to a known GitHub host"*), spell it out: `export GH_REPO=<remote.slug>`, and `GH_HOST=<remote.host>` when the host isn't github.com. `gh pr` commands take no `--hostname` flag.

`writeAllowed: false` (always in zero-config mode) means ask the user before each step that posts to the tracker (§5).

## 1. Preconditions (stop if any fails)

- The branch name carries the ticket key when the work has one. If the project uses a tracker, put the key in the branch name (`<type>/<KEY>-<name>`); `tracker.mjs parse` finds it (§5). Some trackers link a PR to a ticket from the branch name alone, and a key in the title doesn't replace it. Don't rename a pushed branch to fix a missing key: renaming a branch can close its open PRs. Open the PR and let the §5 link carry it.
- Every commit follows the repo's log style (`type(scope): summary`) and its attribution trailer. Source and test commits stay separate from generated-docs commits.
- The verification commands (`project.commands`) have **actually been run on the final tree** and you hold their results. They go in the run's report (the hand-back when delegated, else your final message), with the head sha they ran on; the PR body doesn't carry them (§3). Capture exit codes before any `| tail`. Run the formatter check first (and its `--write` if it fails), then the rest. A formatter or hook that rewrites a file after the suite makes a new tree, so run the suite again before stamping `Verified at`.
- If the repo's `AGENTS.md` has a push-time gate (a docs refresh, a checklist), ask once per session and reuse the answer.

## 2. Title

```
<type>(<scope>): <imperative summary, lower-case, no trailing period> (<KEY>)
```

Same grammar as the commits. The ticket key goes in parentheses at the end when there is one; without a ticket, leave it off.

## 3. Body

Read the repo's PR template (`project.prTemplate`) and use it. Don't invent sections. Write the body to a file and pass `--body-file`; never inline a multi-paragraph body on the command line.

- **Write the evidence for a reviewer, not for the agent that ran it.** Show what changed and how to reproduce it in steps anyone can follow. Leave out run counts, coordinates, zoom levels, timings, latency tables and probe output, and name no records or accounts only the author can open. Those belong in the session's report.
- **The template's checklist stays as the template wrote it.** Tick its items; add no items and no notes after them. Detail a box needs goes in the body above.
- **Link every commit sha the body names.** A commit on the PR links to `https://<host>/<owner>/<repo>/pull/<N>/commits/<full sha>`, a trunk commit to `.../commit/<full sha>`, written as `` [`<sha>`](<url>) ``. Take `<host>` from `project.remote.host` and the full shas from `gh pr view <N> --json commits -q '.commits[].oid'`. `check-pr-body.mjs` reads `Recorded at` lines in either form and warns on an unlinked sha.
- **Shortening a body, or after a correction from the user:** sort each section by who uses it. Keep what a reviewer decides from; move what only the coordinator gates on to the run's report; drop the rest. Then tighten the wording. After the first correction, sweep the whole body for the same kind of detail, not only the line the user pointed at.

When the template has no better shape, this one works:

```markdown
**Stacked on #<parent>** (<PARENT-KEY>) → #<grandparent> (…). Review only the top <n> commits.
Ticket: <link>. Next in the chain: <KEY+1> (<one clause>).

## What

<2–4 sentences: what changed and the one reason it exists. Numbers that matter go here
(files moved, symbols stripped): the reader decides how carefully to review from them.>

<One sentence naming the nature of the change: "Move plus config only.", "Keyword-only: no
runtime path changes.", "Behaviour-changing on the report route.">

## <Exceptions | Forced by the change | Deviations from the ticket>

- **<Bold lead-in.>** <What was done and why it was unavoidable. One or two sentences each.>

## How to check

1. <Steps a reviewer can follow on any account to see the change, and what they should see.>

Not checked: <only what a reviewer must act on: a brand, engine or path no one drove, a blocked
gate. Omit the line when there is nothing.>
```

Rules the template doesn't make obvious:

- **First line says where this PR sits.** For a stacked PR: parent chain and "review only the top N commits". For a trunk PR: drop the stack line and start with the ticket link.
- **Not in scope, by design** gets its own sentence when the ticket asked for more than was built. Name the ticket that owns the leftover.
- **Gaps go where their reader is.** The run's report lists every known gap with its owner: each path checked only by a unit test, each brand or engine not checked, each review request left unaddressed and what it asked for. The body carries one `Not checked:` line, and only for gaps that change the reviewer's decision. A gate that didn't run names what blocked it; the size of the change is not a reason, and the check below fails on one.
- **A scope reduction raised but not decided** (the replacement shows less than what was removed) goes in the body as `Open product question: <question> (owner: <name>)`, so it has an owner.
- **No footer.** No "Generated with" line, no attribution in the body, no "Summary"/"Test plan" boilerplate headings. Attribution lives in the commit trailer only.
- Match the voice of the repo's existing PRs; read the last two before writing. Voice covers wording and layout, not evidence: when those PRs carry no screenshots, this one still does.

```bash
gh pr create --base <parent-branch-or-trunk> --head <branch> \
  --title '<title>' --body-file <body file>
node .agents/skills/toolkit-pr-create/scripts/check-pr-body.mjs --pr <N> --repo <owner/repo> [--visual]
```

Add `--draft` while validation is blocked or the check below fails, and name the blocker in the body's first line; `gh pr ready <N>` once both are cleared, as its own Bash call: auto mode can deny a compound command that mixes a body edit and a check with a PR state change.

Pass `--visual` for any change to what renders: style, layout, color, an icon or glyph, or copy. With `--pr` the check turns it on by itself when the diff touches a UI file (`src/**` minus tests and stories, or a docs `.mdx`), unless the body says `No visual change: <reason>`. A body that still has a `## Verification` section needs a `Verified at \`<sha>\`` line, and with `--pr` it fails when that commit isn't the head and code changed since. With `--pr` (or `--template <file>`) it also fails a template checklist item with text added after it, and warns on an item the template doesn't have, a coordinate, a zoom level, a record or conversation link, or an unlinked commit sha. A `-canary.` pin in `package.json` fails unless the PR is a draft with a `Blocked on <source PR>` line. `node --test scripts/check-pr-body.test.mjs` covers both image rules.

A video needs a `Recorded at \`<sha>\`` line beside it. The check warns (exit 0) when that commit is not the PR head and a UI file changed since (default: `src/**` minus tests, stories and `*.md`; override with `--ui-paths 'glob,glob'`), or `package.json` or a lockfile did (a bumped package can draw the UI differently), or when the body has a video and no such line. The check reads the live body and fails on a ticked box the body doesn't back up: one that hedges ("screenshots are local", "to be attached", "TBD"), or one that names screenshots or a video while the body has no uploaded image or video. Fix the body until it passes. A box is ticked only when what it names is in the PR. Otherwise leave it unticked and say why on the same line.

**Updating an existing body: start from the live one, never from your local draft.** `gh pr edit --body-file` replaces the whole body. Once the PR exists, people edit it on GitHub. They add a recording, a screenshot or a note, and your draft has none of that. Re-sending the draft deletes their content without warning.

```bash
gh pr view <N> --json body -q .body > <body file>   # fetch the live body
# edit it in place: change only the lines that need it
gh pr edit <N> --body-file <body file>
node .agents/skills/toolkit-pr-create/scripts/check-pr-body.mjs --pr <N> --repo <owner/repo>
```

Before sending, diff the fetched copy against your edit. Every removed line should be one you meant to remove. Check `github.com/user-attachments` links and `<img>`/`<video>` tags especially: an upload made in the browser is only in the live body. A rename update sent from the local draft can silently remove a video the author attached in the browser; recover it from the edit history (`userContentEdits` in GraphQL).

**Attaching images and videos from the terminal (gh 2.100.0 or newer).** `gh pr create --attach` and `gh pr edit <N> --attach` upload the file and point the body at it. Reference the file in the body as `![alt](./shot.png)` and pass `--attach './shot.png#alt'`: the reference is rewritten to a `github.com/user-attachments` URL. An attached file the body doesn't reference is appended. Up to 50 files per command. Run it from the directory the relative paths resolve against. Videos render as a player and take no alt text. If some uploads fail the PR is still created or updated and `gh` exits non-zero, so check the exit code. `gh pr edit --attach` without a body flag keeps the existing body and appends, but `--body-file` still replaces the whole body, so the warning above applies. After an upload the `./` references in the live body are `user-attachments` URLs, so the next edit starts from a fresh `gh pr view <N> --json body`. Fill a full SHA with `git rev-parse <short>`, not by hand. When `check-pr-body.mjs` warns that a recording predates the head, re-record, or add a line naming the later commits and why they can't change the take, checked with `git diff <recorded-sha> HEAD -- src`.

To replace a placeholder with a video in place: fetch the live body, put `![](./clip.webm)` where the video goes, then run `gh pr edit <N> --body-file body.md --attach ./clip.webm` from that file's directory so the relative path matches. `.webm` is accepted, and the reference becomes a bare `https://github.com/user-attachments/assets/<uuid>` line, which GitHub renders as a video player.

**A 404 on an opened image in a private repo is an expired link, not a failed upload.** The body keeps the `user-attachments` URL, but each page load serves the image through a `private-user-images.githubusercontent.com/...?jwt=` link signed for 5 minutes. Reload the PR and open it again. To check an upload, look for the `user-attachments` URL in `gh pr view <N> --json body`.

**A library PR carries two kinds of evidence.** The library's own docs or playground page, before and after (run the playground at the merge base and at the head, open the example the change touches, and shoot both; a deployed docs site is built from trunk, so it shows only the before). And the host app before and after, where the change lands: reuse the host PR's grid image and link the host PR. A reviewer of the library PR shouldn't have to open the host PR to see what changed.

**Before/after screenshots for a visual change are required, and a video doesn't replace them.** A reviewer compares two stills in seconds and can't pause a video on the right frame. Capture both at the same viewport and state, on every brand or theme the change reaches, and run the body check with `--visual`, which fails when the body has no image. A PR with only a video and no screenshots passes the check without `--visual`.

- **A timing change (an animation, a layout jump, a loading hand-off) also gets a synced before|after side-by-side video, as the body's first evidence**, with the stills under a `<details>` below it. `toolkit-record-flow`'s `scripts/side-by-side.mjs` makes it.
- **"Before" is the branch's merge base, not the trunk's tip.** Check out `git merge-base HEAD origin/<trunk>` in a scratch worktree. After any merge or rebase of the branch, re-capture it: a kept "before" can still show a line the merge removed.
- **Capture "before" from a detached `origin/<trunk>` worktree, or before the first edit.** Never `git stash` under a running dev server: the stash deletes files its watcher is compiling and the server dies.
- **Every capture proves its state before it is shot.** Take a probe (a DOM measurement of the element you changed) in the same step as the screenshot and save it as JSON beside the image. A screenshot of a pane that had already swapped away looks like a normal image and can upload with a blank half.
- **Give every screenshot a bold title on the line above it**, naming what it shows (`**Header alignment**`), so a reviewer can scan the body without opening each image. The title inside a grid and the alt text stay; neither shows until the image is opened. `check-pr-body.mjs` fails an image outside a table without one.
- **Crop out anything the change doesn't own.** Before attaching, look for UI from another surface painted over the panel and crop it out, or retake from a state where it is hidden. If it also shows on trunk, name it in the body as a known issue rather than leaving a reviewer to wonder whether the PR caused it.
- **Every number in the body names its viewport** (`innerWidth`x`innerHeight`), URL and probe, and every claim that a mode or state exists cites the source file that gates it. A width measured at one viewport reads as true at another, and a mode the code never enters reads as a real case.
- **Pick the format by what changed.** For an *added or removed* element, box the region:

  ```bash
  magick after.png -fill none -stroke '#E3183C' -strokewidth 4 \
    -draw "roundrectangle <x1>,<y1>,<x2>,<y2> 8,8" after-boxed.png
  ```

  Open the boxed image and confirm the box sits on the change without covering neighbouring text. A box can't show *where* something moved, so for an alignment or spacing change build a grid: Before | After | Reference (prototype or design file) columns, one row per brand, a thin guide line on the shared edge, and a caption with the measured pixels. Every row's Reference cell is filled. An empty one needs the design source's own reason, cited by file and line. `scripts/build-compare-grid.mjs` builds it from a JSON spec (`schemas/compare-grid.schema.json`):

  ```bash
  node .agents/skills/toolkit-pr-create/scripts/build-compare-grid.mjs spec.json
  ```

  Each panel is `{ src, crop: "WxH+X+Y", guideX?, caption?, probe? }`; paths resolve against the spec's folder, so write absolute paths when the spec lives elsewhere. Every row needs one panel per column; a column with nothing to show takes `{ "empty": true, "caption": "why" }`.

  **Every grid has a reference column when a prototype or design file has the surface**, even one where before/after already tells the story: a reviewer checks the change against the design, not against the old build. Capture it at the same state as the other columns, and name the column with the source and commit (`Prototype (main dee7ca1)`). The script refuses a grid whose columns name no Prototype, Figma or Reference unless the spec sets `noReference` to why ("the prototype has no chat scrollbar"); that reason is drawn under the grid. A source-only read of the prototype is not a reference panel; when sign-in blocks the capture, say so in `noReference`. Use `empty` for one row the reference lacks, not for the whole column.

  Text is drawn at a size that scales with the grid's width, because GitHub fits a wide image to the ~880px body column; every grid then reads at the same size on the PR. Row labels are a band across the row and wrap rather than shrink, so describe the row in full ("Brand A, pointer on the transcript"). Keep one `panelWidth` (default 480) across a PR's grids. It checks every panel first and writes nothing if any crop is near-uniform (`minStdDev`, default 0.02) or names a probe file that is missing or empty, so a blank panel can't reach the PR. Open the result before attaching it. `node --test scripts/build-compare-grid.test.mjs` covers the blank-panel and missing-probe refusals.

## 4. Link the stack (stacked PRs only)

Setting `--base` to the parent branch is **not** a stack. GitHub shows *"This pull request can be stacked with other pull requests"* until the PRs are linked into a stack object. Link them, bottom to top, **always passing the trunk explicitly**:

```bash
gh stack link --base <trunk> <bottom-pr> <middle-pr> <top-pr>
# growing an existing stack: first arg is the stack number shown in the GitHub UI
gh stack link <stack-no> <new-pr>
```

`gh stack` is GitHub's stack extension and exists only on hosts that support stacks. Where the host has none (a self-hosted GitHub without stacks), chain the PRs by base branch and say so in the body.

Check whether a stack already exists before linking, and verify afterwards, with one query:

```bash
gh api graphql -f query='{ repository(owner:"<owner>",name:"<repo>"){ pullRequest(number:<top>){
  stack { number size baseRefName entries(first:20){ nodes { position pullRequest { number } } } } } } }'
```

**Why `--base` is mandatory:** `gh stack link` rewrites the **bottom PR's base branch** to whatever it takes the trunk to be, and has retargeted a bottom PR from `main` to an old long-lived branch unasked. Once a PR is in a stack, GitHub refuses `gh pr edit --base` (*"Cannot change the base branch because the pull request is part of a stack"*), so the only repair is to rebuild the stack, which also gives it a new number:

```bash
gh stack unstack <stack-no>                          # removes the stack object only
gh stack link --base <trunk> <bottom>…<top>          # → new stack number
```

Get it right the first time. Full stack mechanics, exit codes, CI base-branch filters and the squash-merge endgame: `toolkit-stacked-pr`, when installed.

## 5. Ticket and timeline

```bash
node $R --field adapters.tracker
```

If this prints nothing or exits 1, **no tracker is configured: say "no tracker configured; skipped ticket linking" and go to step 5 of this section.** Otherwise `T=.agents/skills/<that name>/scripts/tracker.mjs`. The adapter owns the tracker's endpoints and credentials; you never read them. Each command prints one JSON object (`status`, `detail`); repeat each result to the user.

1. **Find the ticket.** `node $T parse --text "<branch name>"`. On `none`, try the PR title, then the commit messages. Still `none`: say so and skip the rest of this section.
2. **Confirm with the user** if `writeAllowed` is false: the next two commands change the tracker.
3. **Link and move.**
   ```bash
   node $T link --ticket <KEY> --url <PR url> --title "<repo>#<N>: <title>"
   node $T review --ticket <KEY>
   ```
   `link` adds a link to the PR and reads it back; report it as done only on `ok` or `exists`. A comment is not a link. `review` moves the ticket to its review state by target status, never backward, and skips with a reason when it can't (already in review, no such transition). Report a `skipped` result as skipped, not as done. A failed command (`status: error`, exit 1) is reported with its `detail`; the PR itself is already open, so don't retry in a loop.
4. **Comment and timeline (optional).** With the tracker's own tools (its adapter's SKILL.md says which), add a comment with the PR URL, the stack position, and the acceptance criteria as a checklist with what proved each one; call out actuals that differ from the ticket's estimate and anything deliberately not built. If the ticket names a timeline or tracking page with a row for this work, mark it "In review: PR #N" with the same marker its neighbouring rows use; don't tick its Done box, because that happens when the ticket closes.
5. **Bot review threads:** triage per `toolkit-pr-ci-monitor`. Reply in-thread only when you acted on the finding, and name the commit.

## 6. Report back

Lead with the PR URL and the stack. Then, briefly: what a reviewer needs to know that the body doesn't say (side effects like a rewritten base branch), the tracker results from §5, and the next PR in the chain with the branch it starts from.

## Example

```
> open the stacked PR for KEY-12 on top of #722

gh pr create --base feat/KEY-11-strip-exports --head feat/KEY-12-tests-tree \
  --title 'refactor(app): relocate tests out of src/ into tests/unit/ (KEY-12)' \
  --body-file body.md                                      # → #723
gh stack link --base main 716 722 723                      # → stack #724, verified via GraphQL
tracker.mjs parse  → KEY-12; link → ok; review → ok (In Progress → In Review)
```

## Things that went wrong once

- **Mechanical moves do not get a per-file comment.** A `// Moved out of src/ …` line repeated across 37 test files was rejected in review. Say it once in the commit message; let the code speak for itself.
- **Narrowing a glob is a change, not a move.** Tightening `**/*.test.mjs` to `tests/**/*.test.mjs` silently dropped a test under `scripts/`. If the move doesn't need the config line changed, don't change it.
- **The PR was "stacked" only by base branch** for its first hour, because `gh stack link` was not run. Step 4 is not optional.
- **Moving a directory changes every relative read inside its tests, not just the anchor.** A `resolve(__dirname, "../../../styles/…")` that was right at three levels deep is wrong at two. After a `git mv`, run the suite before trusting the anchor rewrite.
- **Recreating a file at a moved path hides the rename from `git status`.** Moving a route body elsewhere and writing a short stub back at the old path shows as `M` + `A`, not `R`. `git log --follow` on the new file still finds the history; say so in the PR before a reviewer reads the rename count as "history lost".
