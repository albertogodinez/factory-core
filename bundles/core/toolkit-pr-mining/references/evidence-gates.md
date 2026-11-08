# Evidence gates: rationale and failure cases

Background for the gates in `SKILL.md` §1.4b, §1.6, §2.0, §2.2, §3.1 and §3.2. The SKILL.md sections are enough to run a mine. Read this when a gate's verdict is contested, when calibrating a threshold, or when output looks wrong and you need to know what the gate prevents.

## Why the reviewer axis alone is insufficient (§1.4b)

A search with `reviewed-by:<human>` returns only PRs that human reviewed. Where an AI reviewer produces most of the volume, most of the signal is unreachable however well the later phases run. One measured case: the human-scoped query returned 22 PRs against 200+ in the repo, leaving about 89% of the bot's output out of reach, and two runs in a row promoted nothing.

The two axes overlap (every bot comment inside the reviewer axis's PRs is reachable from both), so they merge before Phase 2 instead of running end to end separately. Two passes carry the same defects twice, the duplicate-findings failure §3.1 exists to prevent.

## Why `bot-finding` is its own bucket (§2.0)

The other buckets classify comments written by the reviewer being mined. A bot root comment has no interlocutor: the bot is the reviewer. Forcing it into `agent-steering` double-counts, because the bot's finding and the human's reply to it are one exchange, so a candidate would report 2n evidence for n events.

## Why ties resolve to `agent-steering` (§2.0)

A reply to a bot on a colleague's PR matches both `agent-steering` and `peer-review`. It resolves to `agent-steering` because the act is correcting an agent, not critiquing the colleague. This costs peer-review data points on purpose.

## Why `agent-steering` is not discounted (§2.0, §3.2)

It answers a different question. Peer review asks whether someone else agrees this is wrong. Agent steering asks whether this keeps happening. A correction given to an agent five times is a strong argument for a rule, since a rule exists so you stop issuing it. What agent steering lacks is a second human's assent, so §3.2 adds gates instead of a discount. Thresholds: bot-only 5 or more occurrence-units plus two code-verified instances by default, raised per repo through `mining.bots`; peer review 3 or more distinct PRs; agent steering 3 or more units.

Calibration varies by repo. A corpus where the target authored most PRs ran about 38 peer-review, 74 agent-steering and 13 self-defense of 125 comments; a repo where the target mostly reviews inverts that. Never assume which way it falls; count.

## Why bot comments have a separately controlled axis (§1.6)

Bot review density differs enough between repos that one default either loses signal or adds noise. One measured repo had a bot write 129 of 174 substantive inline comments, 2.9 times everything the non-self humans wrote, so dropping bots discarded most of its signal. Each repo declares `mining.bots.mine`. `--mine-bots` and `--no-mine-bots` replace it for a run. Bot comments pass the same path gate.

High bot volume makes repetition cheap. A bot flagged one stale-file artifact on 19 PRs, well past a bar of 5, and the flags were mostly the bot misreading a healthy squash-merge divergence. A repo can raise the bar with `mining.bots.minOccurrenceUnits` and `minVerified`. The values cannot go below the defaults (5 and 2), so the setting only raises the bar.

## Why occurrence-units use git ancestry (§3.2)

An earlier version collapsed "stacked PR chains" into one unit by how the PRs described themselves. Checked with `git merge-base --is-ancestor` against the real head commits, a narrative five-PR stack was four independent branches with a single real ancestor link. Descriptions like "step 3b of the stack", sequential numbers and adjacent merge dates are not evidence of a stack.

The two outcomes mean opposite things, so the distinction is load-bearing:

- the later PR contains the earlier: the author saw the correction and it didn't stick; one unit;
- the later PR forked before the earlier merged: the fix never reached that code; a real re-occurrence, which is exactly the repetition a rule should prevent. Collapsing these destroys the signal.

## What the dedup gate prevents (§3.1)

One run proposed five candidates and an independent three-lens panel rejected all five. The sharpest failures were two that restated already-compiled rules, one of which already contained the exact bypass and fix. A single keyword drawn from your own phrasing misses a rule that says the same thing in other words, hence four search angles: mechanism, symbol or file, artifact class, defect verb.

## Why quotes must include the conclusion (§3.2)

A candidate was built from the generalizing middle sentence of a review comment. The full body opened with "not valid against the current branch" and closed by routing the fix to a different tool. The resulting rule asserted a check the author had rejected. Hence the two gates: quote the comment's conclusion, and check whether the author already routed the fix elsewhere.
