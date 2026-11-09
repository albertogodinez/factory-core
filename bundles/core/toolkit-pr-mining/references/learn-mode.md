# Learn mode: grade the toolkit's own review comments

Mining asks what humans keep flagging. `learn` asks whether the comments `toolkit-review` posted held up, and what humans flagged on the same PRs that no persona caught.

## Needs a marker

Our comments are the ones carrying the project's comment marker. `scope.mjs` prints it as `marker` (the resolver's `adapters.commentMarker.text`; `resolve.mjs --full` shows the full config). **With no marker set, skip `learn` and say so**: there is no way to tell our comments from the user's own. Don't guess from the wording.

## Where it writes

`<learnDir>` holds the ledger and `state.json`. Get it with `node .agents/skills/toolkit-pr-mining/scripts/scope.mjs --learn-dir` (`learnDir` in the full output too): `mining.learnDir` from project.json when set, repo-relative, for a ledger that must outlive a wiped `stateRoot`; otherwise `<stateRoot>/pr-mining/learn`. `mkdir -p` it before writing.

## Inputs

- `learn <PR URL | owner/repo#N> [...]`, or
- `learn --since-last`: merged PRs since `<learnDir>/state.json` `last_run` (none yet: 30 days) that carry at least one of our `kind: "review"` comments. Find candidates with `GH_HOST=<host> gh search prs --commenter <login> --merged ">=<last_run>" --repo <owner/repo> --json number`, then keep only PRs whose fetched threads contain such a comment.

## Steps, per PR

1. **Fetch and classify.** `fetch-pr-threads.sh <host> <owner/repo> <pr> <marker>` then `scripts/classify-interlocutor.mjs <threads.json> <login> [--suffix <loginSuffix>]`. The `toolkit-posted` comments with `ours_kind: "review"` are what gets graded. `ours_kind` null (replies) and `"annotation"` come from the CI monitor and aren't review findings; skip them.
2. **Grade each against the commit it saw.** The marker's `head` is that commit. Compare the commented line at `head` with the PR's final head (`git -C <localPath> diff <head>..<head_ref_oid> -- <path>`) and read every reply.

   | Grade | Evidence |
   |---|---|
   | `confirmed` | the code at that line changed the way the comment asked, or a human agreed in the thread |
   | `false_positive` | a human explained why it was wrong and the explanation holds against the code |
   | `contested` | a human disagreed and it is unresolved, or the explanation doesn't hold |
   | `dismissed` | thread resolved with no code change and no reply |
   | `ignored` | no reply, no change, not resolved |

   A human's explicit, reasoned call settles an item; silence doesn't. `strength: "strong"` only for a code change at the line or a reasoned reply; everything else is `weak` with an `innocent_reading` ("author fixed it in a follow-up PR", "merged in a hurry"). Judge from the code, never from the resolved state alone.
3. **List missed findings.** Every `peer-review` comment by a cohort member on a file or line no toolkit comment addressed is a candidate miss. If the review's report survives in the state directory, check it: a finding the report listed but the user chose not to post is `found_not_posted`, not `missed`.
4. **Name the mechanism.** One sentence per item that would read the same with every name from the PR deleted ("flags a duplicated block without checking the two copies handle different events"). Record the persona and rule that produced or should have produced it.
5. **Append to the ledger**, one JSON line per item, `<learnDir>/ledger.jsonl`:

   ```json
   {"ts":"<ISO8601>","repo":"app","pr":234,"comment_id":4169230325,"kind":"toolkit_comment|missed|found_not_posted",
    "grade":"confirmed","strength":"strong","innocent_reading":null,"mechanism":"<one sentence>",
    "persona":"<persona>","rule":"<rule-name or null>","url":"<comment url>","head":"<sha>"}
   ```

   Never rewrite earlier lines; a re-graded PR appends new lines and the newest wins.

## Promotion across the ledger

Group lines by mechanism (meaning, not words). A group is a proposal only with **2 or more distinct PRs including one `strong` item**, or **`weak` items from 3 or more PRs across 2 or more repos**. Count PRs as occurrence-units by git ancestry (§3.2). No single PR carries a proposal. Groups older than 12 weeks with no new item drop off.

| Mechanism shape | Proposal | Goes to |
|---|---|---|
| repeated `false_positive` or `contested` on one rule or persona | narrow it: a "what you don't flag" line, a tighter `applies_when`, a rubric anchor | edit proposal quoting old and new text |
| repeated `missed` that compiled rules already cover | the persona isn't applying the rule | edit to the persona file |
| repeated `missed` with no covering rule | new rule candidate | §3.1 dedup, §3.2 bars, §3.4 routing, §3.5 file |
| repeated `confirmed` | nothing to change | report only |

Before presenting a proposal, try to break it: does it read with the PR names deleted, does existing text already say it, is it as short as it can be, would it make a future review over-react? Sharpen an existing line before adding one. Proposals go to the user; nothing edits a rule, persona or rubric without an accept.

A pattern that recurs across repos is also a lesson: `node .agents/skills/toolkit-reflect/scripts/lessons.mjs record --scope core --fingerprint <slug> --summary "<one line>" --status proposed`.

## Output

Per-PR grade table, misses, `## Proposals`, `## Watchlist` (groups one PR short of the bar), grade totals per persona. Set `learn/state.json` `last_run` to the run's start time. The ledger is local state and is never committed.
