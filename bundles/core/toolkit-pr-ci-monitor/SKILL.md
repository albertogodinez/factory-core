---
name: toolkit-pr-ci-monitor
description: Watch a GitHub PR's CI checks until they finish, and triage review comments from AI reviewers (validate each finding, fix the valid ones, reply in-thread). Use after opening a PR or when asked to "monitor this PR", "watch CI", "address the bot comments", "wait for checks then mark ready", or when given a PR number or URL with a monitoring request.
user_invocable: true
---

# PR CI monitor

Watch a PR's checks with exponential backoff, and on every tick triage AI-reviewer comments. Ticks start 5 minutes apart, double while nothing changes (cap 30 minutes), and reset when something does.

If a `toolkit-pr-ci-monitor-*` companion skill is installed, read it first. It carries the project's or company's CI quirks, repo names and bots.

## Project facts

Never read config files. Ask the resolver (from the repo root):

```bash
node .agents/skills/toolkit-context/scripts/resolve.mjs --pretty
```

| Need | Field |
| --- | --- |
| `gh` host | `project.remote.host`. Prefix every `gh` call with `GH_HOST=<host> ` unless it is `github.com`. |
| Repo | `project.remote.upstream` when set (the PR lives upstream of a fork), else `project.remote.slug` |
| Trunk | `project.trunk` |
| Build, test, lint | `project.commands.*`; a null command means skip that step |
| Comment marker | `adapters.commentMarker` (see Replies) |
| Scratch state | `stateRoot`; `mkdir -p` it before writing |
| Ticket tracker | `adapters.tracker` (see Tracker hook) |
| May I write? | `writeAllowed` |

For a PR in another repo, resolve it with `--repo <name|owner/name>`. With no config the resolver detects what it can from git; if it can't find a project, stop and tell the user. Don't guess a host, slug or trunk.

**`writeAllowed: false` (always true in zero-config mode):** don't push, mark ready, merge or post a comment without the user confirming that action first. Reading and local fixes stay allowed.

## Arguments

- **PR number or URL**: extract the number. The URL also names the repo.
- **Repo**: from the URL, the current directory, or ask.
- **Base interval**: the first delay and the delay after any change. Default `5m`; override with "every 1m". The cap stays 30m.

With no PR number, use the current branch's PR: `<GH_PREFIX>gh pr view --json number,url --jq '{number, url}'`.

A request to "mark it ready once checks pass" is a monitor that ends with `gh pr ready <N>` once CI is green and triage is clear. Ask first if `writeAllowed` is false.

## Replies and who gets one

Replies post under the user's credentials, so GitHub records them as that person. They carry the project's disclosure marker, so a reader (and any later mining of review comments) can tell them from the user's own words. The marker is `adapters.commentMarker.text` when its `mode` is not `off`; `toolkit-pr-comment` adds it, so never write it by hand.

| Author | Action |
| --- | --- |
| `user.type == "Bot"` | Triage and reply, with the marker |
| The account whose credentials this session uses (`gh api user --jq .login`, resolved once) | Triage and reply, with the marker |
| Any other human | **Never auto-reply.** Summarize for the user and stop |

A teammate's question wants a person's answer, and an unsolicited bot-style reply to a colleague is worse than none. When unsure whether a human is the owner, don't reply: a missing reply is recoverable, an unsolicited one isn't.

## Steps

### 1. Stacked PRs (first tick only)

If the PR's base is not the trunk, it was meant to be stacked. On a host that has stack objects, a base-chained PR with no stack is not a stack:

```bash
<GH_PREFIX>gh api graphql -f query='{ repository(owner:"<owner>",name:"<repo>"){ pullRequest(number:<N>){ baseRefName stack { number size } } } }'
```

If `baseRefName` isn't the trunk and `stack` is null, walk the base chain down to the PR that targets trunk, then link the chain bottom to top with `gh stack link --base <trunk> <bottom> … <top>` (set `GH_REPO=<owner>/<repo>`). If the PR is in a stack already, check it is an entry, and grow the stack with `gh stack link <stack-no> <N>` if not. If the query errors because the host has no stack field, skip this step.

### 2. Local pre-flight (blocking)

If the PR touches source or test files, build and test locally before scheduling the monitor. It catches type errors and assertion mismatches in minutes instead of a full CI cycle. Skip it for docs-only or config-only PRs. A frontend change also needs the app loaded in a real browser. Details, toolchain selection and the stale-`node_modules` check: [references/preflight.md](references/preflight.md). Read it before the first pre-flight.

**Don't schedule the monitor if the pre-flight fails.** Fix and push first, then re-invoke the skill.

### 3. Schedule with backoff

Each tick is a one-shot job that schedules the next, so the gap can change between ticks. A recurring job can't back off: its interval is fixed at creation. Use the harness's one-shot scheduler (in Claude Code: `CronCreate` with `recurring: false`, a cron pinned to now plus the delay, and `CronDelete` to cancel). If the harness has none, tell the user the next check time and stop, or wait in-session.

- The delay doubles on each idle tick and resets on any change: 5, 10, 20, 30, 30 minutes.
- At the end of every tick, after reporting, schedule the next one unless the monitor is stopping (CI green with no open findings, or the 3rd idle tick). Store the new job id and delay in the state file.
- There is never more than one pending job per PR. If a tick finds a `job_id` in the state file that the scheduler still lists, delete it before scheduling its own.
- A background agent running this skill arms one watch per PR and stops every timer before its final report, so a late timer can't wake it into a duplicate report.

#### 3a. Stop after 3 idle ticks

A monitor that reports no change is noise. A tick is **idle** when all three are unchanged since the last tick: the head SHA, the set of check names and conclusions, and the set of review-comment ids and review ids. Any change resets the counter to 0.

A tick with a check still queued is not idle: CI hasn't run. When checks stay pending for two intervals, read `gh run list --branch <branch> --limit 4 --json name,status,conclusion,createdAt,headSha`. If every run is `queued`, it's a runner backlog, not a failure: don't re-run (a re-run joins the same queue), don't count the tick, and keep backing off. If you stop anyway, report "stopped while CI was still queued, so the PR is not verified", never "parked".

Persist state in `<stateRoot>/toolkit-pr-ci-monitor/pr-<NUMBER>.json`, since a scheduled prompt is static and can't hold it:

```json
{ "head_sha": "<sha>", "checks": {"<name>": "<conclusion>"}, "comment_ids": [1,2], "review_ids": [3], "idle_ticks": 0, "delay_min": 5, "base_min": 5, "job_id": "<id>" }
```

On the 3rd consecutive idle tick: report that monitoring stopped for inactivity, say what the PR is waiting on, give the exact command to restart it, and schedule nothing. Don't call a parked PR finished: it looks the same as a finished one in `gh pr checks`, and conflating them is how a green but unmergeable PR gets mistaken for done. Restart is cheap: re-invoke the skill the moment the PR moves, and start it in the same turn as a push (3b).

#### 3b. Start straight after a push

When a commit and push just happened in this session, schedule the monitor in the same turn. The first CI run is the highest-value one, and a hand-rolled `gh pr checks` loop stops at green while AI reviewers post after the checks pass. A green report states when comments were last fetched ("no open findings as of 11:51"), never "no review comments" or "ready for review" as a settled fact.

Carry into the tick prompt so it doesn't rediscover settled ground: the new head SHA; findings already answered (by comment id) and those now moot because their code is gone; known non-issues and flakes, each with the evidence; and the single highest-value check this round, with likely causes in order and an instruction to read the log first.

### The tick

Run `<GH_PREFIX>gh pr checks <N>` in the repo, then:

1. `gh pr view <N> --json state,mergeable -q '.state+" "+.mergeable'`. If `MERGED`, run teardown ([references/teardown.md](references/teardown.md)), report, schedule nothing, stop. If `CONFLICTING`, GitHub starts no `pull_request` workflows on the head, so checks missing since the last tick are blocked, not queued: merge trunk (a merge commit on another author's branch), resolve, run the local suite, push, and report the PR as conflicting until the new head's checks start.
2. All checks `pass` or `skipping`: CI is green. Run the comment triage before declaring done, since a green PR can still hold bot findings. Report "CI green, no open AI-reviewer findings" and stop scheduling only when both are clear.
3. Some `pending`: report how many, and run the triage anyway. Bot reviews land independently of CI.
4. Any `fail`: diagnose and fix ([references/ci-failure.md](references/ci-failure.md)).
5. Update the state file: compare head SHA, check conclusions and comment/review ids with the stored snapshot. Unchanged is idle: increment `idle_ticks`, set `delay_min` to min(2 x `delay_min`, 30). Changed resets `idle_ticks` to 0 and `delay_min` to `base_min`. A queued run leaves `idle_ticks` as it is.
6. Unless stopping, schedule the next tick, record its id, and say its time in the report.

### 4. Triage AI-reviewer comments (every tick, or on demand)

CI going green is not the PR being reviewed. AI reviewers post inline findings that fail no check, so a green PR can carry a real bug in a comment nobody read. Also run this on "address the bot comments", where there is no CI failure to react to.

```bash
<GH_PREFIX>gh api "repos/<owner>/<repo>/pulls/<N>/comments?per_page=100" \
  --jq '.[] | {id, login: .user.login, type: .user.type, path, line: (.line // .original_line), reply_to: .in_reply_to_id, body}'
<GH_PREFIX>gh api "repos/<owner>/<repo>/pulls/<N>/reviews" \
  --jq '.[] | select(.body != "") | {id, login: .user.login, type: .user.type, submitted_at, body}'
```

An AI reviewer is one where `user.type == "Bot"`. Prefer that over a login list, so a new reviewer bot is handled without a code change. The second query catches body-only findings, which never become inline comments (4.4 covers replying to them).

Then, per finding:

1. **Skip handled ones.** A thread with a reply from the PR author is done: skip any comment whose `id` is another's `in_reply_to_id`. Track by `id`, never `commit_id`, since GitHub re-anchors old comments to the newest SHA. Answer the first of two identical findings, and point the duplicate at it in one line.
2. **Validate against the tree first.** A finding is a hypothesis, not a work order. Outcomes: valid (fix, then reply with what changed and how it was checked), invalid (change nothing; reply with the evidence that refutes it), unclear (surface to the user with what you checked; don't guess).
3. **Fix, verify, then reply, in that order.** Apply the fix, run `project.commands.test` and any contract or source-assertion suites the change could invalidate, add or extend a test that locks the invariant, then **ask the user before committing and pushing**. Reply once the fix is pushed, so the reply references a real commit.
4. **Reply in-thread** on the finding's comment id, through `toolkit-pr-comment`:

   ```bash
   node .agents/skills/toolkit-pr-comment/scripts/post-comment.mjs --pr <N> \
     --kind reply --in-reply-to <COMMENT_ID> --body-file <stateRoot>/reply.md
   ```

   Write the body to a file: replies hold backticks and quotes that break inline shell strings. State the commit SHA, what changed, how it was verified (real numbers, not "tested"), and, when true, that the finding was broader than reported or that this PR introduced the bug. Credit the catch. Never resolve threads; that is the human reviewer's call.
5. **Re-fetch right before replying.** Findings land asynchronously. Re-run the fetch, diff against the ids you've handled, and pick up anything new.

Never answer a finding with a top-level PR comment (`issues/<N>/comments`): it is detached from the code and doesn't mark the thread answered. Top-level is only for a body-only review finding with no thread (name the review it answers and say why it is top-level), a re-review request, or a final summary. Before falling back, confirm no thread exists by re-scanning for a bot comment on the same file and line.

Validation habits, judgment calls, and how to write an invalid-finding reply: [references/triage.md](references/triage.md). Read it before the first fix in a session.

Report per comment: author, path and line, verdict, action, reply URL. List other humans' comments separately as needing the user's own response.

#### Explanatory notes go in the PR, never in the code

A hunk that reads oddly needs a note for the reviewer, but not as a source comment: a comment can't fail, so it protects nothing. Post "read this in this order" or "this looks wrong but is deliberate, here is why" as a new inline comment on the head commit, after the push that creates the lines:

```bash
node .agents/skills/toolkit-pr-comment/scripts/post-comment.mjs --pr <N> --kind annotation --path <FILE> --line <L> --body-file <note.md>
```

The bar is that a reviewer would plausibly stop at the line and ask. Don't narrate the diff or restate the PR body, and don't annotate a line a reviewer already commented on: reply in their thread. An explanation that must outlive the merge isn't a note: write the test or the doc.

### 5. Confirm to the user

Report the PR and repo, current check status, the base interval, cap and next tick's time, the pending job id (and how to cancel it), that jobs end with the session, and that it stops after 3 idle ticks and how to restart it.

## Tracker hook

If `adapters.tracker` is set, run that adapter skill's link and transition steps at the points below. If it is unset, skip them and say they were skipped. Core doesn't implement a tracker.

- **PR linked to a ticket:** link the PR, then move the ticket to the review state. Never move a ticket backward, and skip gracefully if the review transition isn't available.
- **After merge:** comment the merge SHA and what shipped, and move the ticket to its terminal status. Terminal names vary by workflow, so match on the destination status.

## Teardown after merge

When the PR is **merged** (not merely green or approved), remove this PR's footprint: servers and timers this session started, its worktree and local branch, its state file; fast-forward local trunk; close out tracking; clear `pending_pr` from feature-map entries. Read the state, never infer it. Touch only this PR's footprint. Full steps: [references/teardown.md](references/teardown.md).

## Usage

```
/toolkit-pr-ci-monitor 123
/toolkit-pr-ci-monitor https://github.com/acme/app/pull/123
/toolkit-pr-ci-monitor                       # the current branch's PR
/toolkit-pr-ci-monitor 123 every 1m          # base interval 1m; still doubles to the 30m cap
/toolkit-pr-ci-monitor 123 teardown          # after merge: teardown only
/toolkit-pr-ci-monitor 123 address the bot comments
```
