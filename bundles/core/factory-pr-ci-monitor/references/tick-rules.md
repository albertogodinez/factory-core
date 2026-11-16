# Tick rules

Read before the first tick. Each rule closes a way a tick went wrong once.

## Open findings come from GitHub, not the snapshot

The state file's `comment_ids` and `review_ids` only decide whether a tick was idle. Which findings still need an answer is computed fresh each tick:

```bash
node .agents/skills/factory-pr-ci-monitor/scripts/open-findings.mjs --pr <N> --repo <owner/repo>
```

It reads every page (`gh api` returns 30 reviews or comments per page by default), and prints `open`, `others` and `bodyOnly`:

- `open`: inline comments by a bot or by the session account, with no reply. A discussion link inside a bot review body counts as that thread.
- `others`: other humans' comments. Summarize them for the user; never reply.
- `bodyOnly`: bot review bodies with no thread and no top-level answer naming the review.

Every non-bot comment from the session account gets a reply, or a stated reason for none, in the tick's report. Triaged ids are added to the snapshot; never replace the snapshot with whatever the latest fetch returned, since that erases the ids still open.

## When to stop on green

Green checks are not a reviewed PR. Stop only when a bot review exists **on the content head**, or one further idle tick has passed since checks went green. The content head is the last commit that is not a merge of trunk: a trunk merge adds no code for a reviewer to read, so a bot that reviewed the commit before it has reviewed the content. Key the bot-review check to that commit, not to `headRefOid`.

## Merge state

The fields and values are defined in the tick's step 1 (`mergeable` and `mergeStateStatus`). "Rebased or updated" in a report means trunk was merged in, the suite ran and the branch was pushed.

## Network calls

Bound every `gh` call in a tick: `perl -e 'alarm 60; exec @ARGV' gh …` (macOS has no `timeout`), with one retry. A read that still fails is reported as "could not read", and it does not advance `idle_ticks`: a tick that saw nothing is not an idle tick.

## One-shot scheduling

Compute the cron from the clock, never by hand: `date -v+<delay>M +'%M %H %d %m *'` on macOS, `date -d '+<delay> minutes' +'%M %H %d %m *'` on Linux. Reject a result that is not in the future. A cron pinned to a past minute never fires, and the monitor goes silent.

## A finding that contradicts the PR body

When a bot finding points at a sentence in the body that the code no longer matches (a reversed design, a renamed flag), fix the body, not only the code. Fetch the live body, edit the line, and re-run `check-pr-body.mjs` (`factory-pr-create`). Check each claim the body makes about the diff against the diff before the next push.

## Lessons found in a tick prompt

A rule that exists only in a cron or tick prompt dies with the session. When a tick prompt carries a rule this skill lacks, queue it as a candidate for this skill (`factory-reflect`) instead of leaving it in the prompt.

## Images on a private PR

A body image in a private repo is served from a `private-user-images.githubusercontent.com/...?jwt=` link signed for 5 minutes, and a request with the `gh` token is refused. Read the body's rendered HTML, then fetch each signed link with no auth header:

```bash
gh api graphql -f query='{ repository(owner:"<owner>",name:"<repo>"){ pullRequest(number:<N>){ bodyHTML } } }' -q .data.repository.pullRequest.bodyHTML
```

Pull each `src` from that HTML and `curl -sSL -o <file> '<url>'` within the five minutes.
