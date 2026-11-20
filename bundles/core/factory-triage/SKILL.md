---
name: factory-triage
description: Triage the lesson candidates this repo owns (a bundle source repo's core or org queue, or a repo's own lessons). Cluster them into families, then build one lesson branch, one commit per cluster, and open its review, the only gate. Pass a candidate file for one fact, or nothing for the whole queue.
disable-model-invocation: true
---

# Triage

Reflect runs hand lessons over as **candidates**. A candidate is one JSON file under `~/.agents/factory/candidates/<core|org|repo>/`; a `repo` candidate names the repo that owns it. It holds the kind, the skill, a summary, evidence pointers, an optional draft patch, and the `fixedWhen` signal. Triage turns the queue into **clusters**, which are lesson families. Each cluster becomes one commit on one lesson branch, and the user reviews the branch once. **Nothing before the review asks the user anything**: clustering, building and proving run on their own, and the review gate is where every keep, drop, split or never is decided. A cluster's size is the count that matters: one rule from three sightings beats three rules from one sighting each.

`lessons.mjs` below is `.agents/skills/factory-reflect/scripts/lessons.mjs`. In a bundle's own repo, where core isn't installed, it's `<core bundle>/factory-reflect/scripts/lessons.mjs`.

## 1. Check the home repo and read the queue

```bash
node .agents/skills/factory-context/scripts/resolve.mjs     # project.root, adapters
node <lessons.mjs> queue                                    # per scope: its source repo, candidates, ages
```

Triage only the queues this session's repo owns (`project.root`'s main checkout): the `core` or `org` scope when this is its source repo, and the `repo` queue whose `repo` is this checkout. A queue owned by another repo is that repo's work. Give its `start` command and `prompt`, then go on.

- **One fact** (you were given a candidate file): take that candidate, plus the queued candidates for the same skill (`queue --skill <its skill>`), because a fix to that file should account for them. Leave the rest for the scheduled run.
- **Whole queue** (no file): every queued candidate this repo owns.
- **Scheduled** (`--scheduled`): the triage schedule, or a session start that found the queue due, opened this session. The scheduler launches a repo only when its `lesson/triage` branch lacks a queued candidate and isn't full, and sends a desktop notice once a day while a branch waits for review. A scheduled run that finds the branch otherwise was launched by mistake: build nothing, say so in the summary, and go to the review gate on what's there. Take the whole queue. Run straight through to the review gate. **Ask nothing in this chat**: the user may never look at this terminal, so a chat question waits forever. Every decision is made in the review (§3, "Scheduled runs"), and the run ends the session when it's done (§5).

Drop what's already decided. `lessons.mjs known --never` lists the families the user refused. A candidate in one of them goes straight to `done --outcome dropped`.

## 2. Cluster

Read each candidate. Open its evidence when the summary leaves the *why* unclear: grep the transcript for its `grep` words, or read the PR thread. A transcript that no longer exists is fine: the summary and the PR links are enough.

Set aside **map entries** first: the candidates `queue` marks `map: true` (their skill is a feature map). They aren't lessons, so they skip clustering and ranking; §3's [Map entries](#map-entries) builds them. Cluster the rest.

Group candidates that the same edit would fix: the same skill section, the same missing check, the same wrong fact. Similar wording isn't enough. Two candidates belong together when one commit settles both.

Rank the clusters by size (largest first), then by cost: a fact with a draft patch is cheap, and a new check is dear. For each cluster, write:

- a **slug**: the family name, which is also the fingerprint for `never`
- its **members**: the candidate files
- the **edit**: which file changes, and how (a check, a rule, a skill edit, a fact)
- its **fixedWhen**: the members' signals, merged

**The build bar.** Build a cluster only when it has **2 or more sightings**: its member count, or the `occurrences` for its fingerprints from `lessons.mjs known` when that is higher. Two exceptions build at one sighting: a `fact` (a stale command, a wrong path, a leaked secret: cheap and wrong now), and a candidate whose draft patch applies as it stands. A cluster below the bar is **not** built and **not** closed: its candidates stay queued to gather sightings. List each in the review context under "Waiting for a second sighting", with its count and the `rate` from `known` when it has one. A queue that holds only such clusters ends the run without a branch: say so in the summary.

**Don't stop to show the clusters.** List them in one short message and go straight to §3: each cluster's slug, members and edit become its commit, so the user judges them in the review, on the diff. There they may drop a commit, ask for a split, or mark a family `never` (factory-reflect's gate step says how each annotation is applied). If the user writes in this chat first to drop or merge a cluster, do that before building.

## 3. One lesson branch, one commit per cluster

Follow factory-reflect's [Landing a lesson branch](../factory-reflect/SKILL.md#landing-a-lesson-branch), from step 2, but start the branch with `lessons.mjs start --repo <repo> --rolling` instead of `--slug`. Every triage run, whole queue or one fact, adds to the repo's one `lesson/triage` branch. A candidate stays queued while its branch is undecided, so dated branches rebuilt the same commits again (one repo ended up with three). `start` prints what you need:

- `reused` / `created`, and `sync`: `new`, `current`, `rebased` or `merged` (trunk was brought in), `dirty` (the worktree has uncommitted edits: don't add to it, finish or ask), or `conflict` (it stopped: say so in the review context, don't add anything, and go to the review).
- `commits`, `oldestDays` and `full` (lessons only; `mapEntries` counts the map commits). **When `full` is true, add no lessons** (map entries still go on): go straight to the review gate on what's there, and say at the top of the review context that the branch is full and needs a decision before more lessons join it.
- `older`: dated lesson branches from earlier runs. Don't add to them. The review context lists them, so the user can drop the ones whose commits `lesson/triage` holds.

On a reused branch, read its `Candidates:` trailers (`git log <trunk>..<branch> --format=%B`). A cluster whose members are all listed is already built: leave it. Commit only clusters with candidates the branch doesn't hold; when a new candidate belongs to a cluster already on the branch, amend that commit's edit and its trailers, which raises its counts. Put "new since the last review" at the top of the review context: the commits and amendments this run made. The branch's head moved, so note it again before the gate. A reused branch that was pushed gets the trunk merge as a new commit, so the push is a plain push. A repo-scope branch in a team repo lands through a PR (that section's `lessonLanding` rule). For each cluster:

- Make the edit in the worktree. Apply a member's draft patch when it still fits; otherwise write the edit (read `writing-for-agents` first). Prove a check: it must go **red** on the past mistake before it goes green.
- A `harness` cluster edits the bundle's `harness/<claude-code|codex>.json` (hooks and permission rules only; a broad allow such as `Bash(*)` is refused). `factory harness` shows what it would change in the user's settings; prove a guard hook by running it on the past command. After the land, factory-core's trunk hook runs `factory harness --apply`, which merges it and keeps a backup; where that hook isn't installed, the status hook says to run it.
- Commit it on its own. The subject is the edit. The body quotes the evidence grep hits, one line each, and ends with trailers: `Candidates:` (the member files' basenames) and `Fixed-when:` (the merged signal).

### Map entries

A map entry records code that a PR review already gated, and maps change with nearly every ticket, so it is built lighter than a lesson, on the same branch:

- **Clear merged PRs first.** Run `clear-pending-prs.mjs --skills-dir <the bundle dir in the worktree> --apply` (from `factory-feature-map`). When it changes anything, commit that as its own map entry.
- **One commit per entry**, no clustering. Apply its draft patch, or write the entry from it when the patch no longer fits. The proof is a clean `check-map.mjs --map <the map in the worktree> --cwd <the app repo's checkout>`, not a red-then-green check; an anchor that exists only on an open PR needs `pending_pr`. When the entry won't go clean, drop it (`done --outcome dropped`) and say why in the summary.
- **The commit** is `docs(<map skill>): <the entry>`, with the trailers `Map-entry: <feature id>` and `Candidates:`. `Map-entry:` keeps it out of the branch's cap: `commits` and `full` count lessons only, and `start` reports the map commits as `mapEntries`. A full branch still takes map entries.
- An entry whose draft edits anything besides the map's `features/` (SKILL.md, scripts, a README rule) is a lesson, not a map entry: cluster it with the rest.

Then do the landing steps in order: the internal-data screen, the review gate (with the head noted), land, and push. A cluster dropped in review is reverted on the branch before landing: `git rebase --onto` past its commit.

### The review context and the gate

When the source repo's `adapters.reviewUI` is `plannotator-review`, the gate is factory-reflect's guided review, and nothing else opens: no explainer page, no `plannotator annotate`. What the user needs beside the diff goes into the guide. Write it as a markdown file, `~/.agents/factory/reports/triage-<slug>-context.md`, and pass it to `guide.mjs prep --context <file>`. The guide writer puts the branch-wide parts in the guide's intent and leads each commit's section with that commit's part.

The file starts with the branch notes above (new since the last review, a full or conflicted branch, older branches), then one block per cluster commit, largest first:

- **How many times it happened**, in one sentence: "seen N times across M sessions in P projects". N and P are the live `occurrences` and `projects` for the cluster's fingerprints from `node <lessons.mjs> known` (members' fingerprints, summed; projects de-duplicated). Add the rate when `known` gives one: "in K sessions that used the skill" (`skillSessions`, summed over distinct skills, with `rate` beside it). A fingerprint with no `skillSessions` predates the skill stamp; say so, don't invent a denominator. M is `sessions` from the same `known` output: distinct session ids on the index entries, which `lessons.mjs record` stamps from the session's environment. Entries recorded before that carry none, so M can be smaller than N; say so rather than letting it read as one session. When `sessions` is 0 for a cluster, count the distinct transcripts in its members' `evidence` instead and label that as a lower bound. Add the member count, and, when a landed lesson on the same family came back `flat` or `worse` in the last report, that this is a repeat, with its commit.
- **Why**: the evidence lines from the commit body, and the `fixedWhen` signal that will show whether it worked.

Then "Waiting for a second sighting" (each cluster below the bar, with its count and rate), and last, **Map updates**, marked low-attention: a line per entry with its feature id, its `pending_pr` and the checker result, so the user can approve them together. The diff shows what each commit changes, so don't restate it.

Plannotator's feedback message tells an agent to return verdicts and wait before changing code. **In a scheduled run, don't wait.** On `annotated`, give each annotation its verdict in a commit, not in chat. Fix what's confirmed as new commits, and put a short answer to a question or a "not a bug" in the next guide's notes for that file. Then rewrite the review context, write a new guide from it, and re-open the gate, which is where the user answers. Repeat until the gate is approved or dismissed.

## 4. Close the candidates

After the land, mark each member:

```bash
node <lessons.mjs> done --file <candidate> --outcome landed --commit <its cluster's commit on trunk>
node <lessons.mjs> done --file <candidate> --outcome dropped    # dropped in step 1, 2 or the review
```

`done` moves the candidate and its draft to `done/`, and keeps them there for 90 days. When the branch stays undecided (the gate was dismissed), leave the candidates queued. The status hook names the branch at the next session start here, and `lessons.mjs open` lists it.

## 5. Tools, cadence and report

Check the pinned CLIs against their latest releases: `node .agents/skills/factory-tool-sync/scripts/check-tools.mjs --online` (in a bundle repo, `<core bundle>/factory-tool-sync/scripts/check-tools.mjs --online --skills <core bundle>`). Name each `CHANGED` or `BELOW` tool in the report message. Moving a pin is a `factory-tool-sync` review, not part of this run.

Record the run, with the size of the largest cluster: `node <lessons.mjs> cadence --scope <scope> --ran --clusters <largest>` (for a repo queue, `--scope repo --repo <this checkout>`). The script sets the mode: Monday, Wednesday and Thursday until two quiet weeks, then weekly, and back to Monday, Wednesday and Thursday on an early trigger (a queue of 5 or more, a candidate 3 or more days old, a cluster of 3 or more, or a lesson whose signal didn't drop). The status hook nudges by that mode. Say when it switches, and why. The user can pin a mode: `cadence --pin thrice|daily|weekly`, or `--pin off`.

Write the trend report: `node <lessons.mjs> report`. It writes one HTML file per layer under `~/.agents/factory/reports/`, from the counted metrics every session's end captures. It shows weekly per-session rates, a marker for each landed lesson, and each lesson's `fixedWhen` signal for the 7 days before and after. Each lesson carries a `verdict`, split by the revision each session had installed when its land recorded `--commit`, else by date. **flat**: it didn't work, so queue a `pattern` candidate that says so, and the next triage reopens that cluster. **worse** (listed in the report's `worse`): it made things worse, so queue a `fact` candidate to revert or rework it, with the commit as evidence (`{"commit":"<sha>"}`).

Then open each report's `file` for the user (`open` on macOS, `xdg-open` on Linux, `start` on Windows), in a scheduled run too. The trend chart is how the user sees whether the setup is working; a path in the summary alone goes unread.

End with a short summary here: the repo, the clusters with their member counts, what landed and what was dropped, the candidates still queued, and the report's path.

In a scheduled run, also write that summary to `~/.agents/factory/reports/triage-<slug>.md`, then end the session, so idle triage sessions don't pile up. When `HC_TERMINAL_ID` is set (the hc launcher started this session), run `hc kill "$HC_TERMINAL_ID"` as the last command. A dismissed gate ends the same way: the status hook names the branch at the next session start.
