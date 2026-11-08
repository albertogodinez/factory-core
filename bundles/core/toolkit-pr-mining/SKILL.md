---
name: toolkit-pr-mining
description: Mine a repo's merged PR review comments from its configured reviewer cohort (project.json mining), cluster recurring patterns, and turn those that clear an evidence bar into toolkit-review rules. The learn mode grades the review comments toolkit-review posted against what happened on each PR. Use to find what reviewers keep flagging, or to check whether the review skill's comments hold up.
user_invocable: true
---

# PR mining

Pull review comments from a repo's reviewer cohort, cluster them by theme, apply evidence bars, and write a curation report. Patterns that pass become `toolkit-review` rules. Needs `gh`, `jq`, and `toolkit-review` installed (its `fetch-pr-threads.sh` fetches every PR; its rules directory is where promoted rules go).

## Configuration

Mining reads `mining` from the repo's `.ai-toolkit/project.json` (schema: `toolkit-context/schemas/project.schema.json`):

```json
{ "mining": { "cohort": ["ann", "bo"], "loginSuffix": "", 
              "bots": { "mine": false, "minOccurrenceUnits": 5, "minVerified": 2 },
              "paths": { "include": ["src/"], "exclude": ["src/generated/"], "pathlessBodies": "scoped-pr-only" } } }
```

- `cohort`: bare logins whose comments count as human evidence. A cohort filters comment authors, not PR authors.
- `loginSuffix`: appended to a login in search queries when the host's accounts carry one. Output keeps bare logins.
- `bots`: `mine` turns on the bot discovery axis (§1.4b). The two numbers are the bot-only evidence bar and can only be raised above 5 and 2.
- `paths`: directory prefixes in scope; empty `include` means the whole repo; `exclude` wins. `pathlessBodies` is `scoped-pr-only` (keep a pathless review body only on a PR wholly in scope) or `never`.

Nothing else (a PR title, a nearby directory name, another repo's config) widens the cohort or the paths. Check it: `node .agents/skills/toolkit-pr-mining/scripts/scope.mjs` prints the effective scope, or exits 1 saying what to add. `--neighbor <name>` reads a neighbor's own config.

## Modes and arguments

- **Mine** (default): everything below.
- **`learn <PR...>` / `learn --since-last`**: grade the review comments toolkit-review posted. Follow `references/learn-mode.md`. It needs the project's comment marker (`adapters.commentMarker.text`); with none set, say "learn skipped: no comment marker configured" and stop.

Arguments (the scope script takes the ones marked *):

- `--since YYYY-MM-DD` (default 6 months ago), `--until YYYY-MM-DD` (default today): inclusive merge dates. Validate both and `since <= until` before any GitHub call.
- `--reviewers a,b` *: replaces the cohort for this run.
- `--neighbor <name>` *: mine a neighbor repo (read-only; its own config; its worktree and state).
- `--include-non-approved` (default `true`): `false` keeps only PRs with an `APPROVED` review.
- `--mine-bots` / `--no-mine-bots` *: override `mining.bots.mine`.

All output goes under `stateRoot` (`scope.mjs` prints it; `mkdir -p <stateRoot>/pr-mining` first), never into the repo.

## Phase 1: extract

Mechanics, schemas and commands: `references/extraction-mechanics.md`. In order:

1. **Scope** (`scope.mjs`). Print one row per repo: cohort, path rule, bot mode and bar, canonical `owner/repo`, local path, trunk. Save the same in the run's scope manifest. A fork mines its upstream.
2. **Discover** (§1.4). For each query login: `repo:<canonical> is:pr is:merged reviewed-by:<login> merged:<since>..<until>` through `gh api --method GET search/issues --paginate --slurp`, with `GH_HOST` set. Every page must say `incomplete_results: false`. A shard with `total_count >= 1000`, 1,000 rows or incomplete results is unproven: split its date interval into non-overlapping halves and rerun until all shards are complete, then de-duplicate by PR number. A one-day shard that stays capped stops the run; never mine a partial interval. Fetch each PR's real `mergedAt` and reject null or out-of-window values.
3. **Bot axis** (§1.4b, only when bot mode is on). `--reviewed-by <human>` can't find bot findings, so run a second independent query that names no reviewer, apply the same completeness and `mergedAt` checks and path gates, and keep only comments whose own author is a Bot. Run both axes in parallel, merge before Phase 2, de-duplicate by comment id keeping `axis: "reviewer"` on collisions, and report per-axis counts. Rationale: `references/evidence-gates.md`.
4. **PR path gate** (§1.5). Fetch every changed filename; classify each PR `in-scope`, `mixed`, `out-of-scope` (excluded) or `unknown` (excluded, reported). A mixed PR still holds out-of-scope comments, so §1.6 filters each thread by its own path.
5. **Extract** (§1.6). One call per PR, `xargs -P 16`, in a single foreground script (never background `&` loops; the harness stalls on prompts it can't surface):
   `bash .agents/skills/toolkit-review/scripts/fetch-pr-threads.sh <host> <owner/repo> <pr> <marker>`
   If that script is missing, stop and say so. The comment gate keeps an inline root only when its path is in scope, lets a pathless reply inherit its root's path, keeps a pathless review body only under the `pathlessBodies` policy, ignores PR conversation comments, and keeps non-cohort human replies only as `context_only` (never counted). Authorship is the posting account: a cohort member's comment is that member's evidence even when it says an AI wrote it. **One exception: a comment carrying the project's own comment marker** (`ours: true`). It is toolkit output posted under the user's account; counting it would feed the toolkit's findings back into its own rules. It is `toolkit-posted`, never human evidence, and `learn` grades it. Skip noise (LGTM, CI status, scanners, comments under 20 characters) and every bot comment unless bot mode is on.
6. **Reply graph.** Every comment carries `pr_author`, `in_reply_to_id`, `parent_author`, `parent_author_type`; the fetch script resolves them. Don't re-derive them.
7. **Save** raw payloads in the cache and scoped evidence under `<stateRoot>/pr-mining/raw/`, with `_scope.json`. Report discovered PRs, shards, in-scope, mixed, excluded, raw comments, retained evidence, inherited-path replies, context-only replies, out-of-scope, pathless and noise exclusions, per reviewer and per repo.

## Phase 2: cluster

Only records marked in scope and not `context_only` enter Phase 2; a missing marker means out of scope. Cluster from the comment body and its in-scope diff hunk only; PR titles and URLs are attribution.

### 2.0 Classify the interlocutor (mechanical, before clustering)

`reviewed-by` returns PRs the person reviewed in any role, which mixes three kinds of evidence. Run `node .agents/skills/toolkit-pr-mining/scripts/classify-interlocutor.mjs <threads.json> <reviewer> [--suffix <loginSuffix>]` per PR and reviewer:

| Bucket | Test | Meaning |
|---|---|---|
| `peer-review` | `pr_author != reviewer` | telling a colleague what to change |
| `agent-steering` | parent is a Bot or one of our marked comments | correcting an AI agent; repetition means it didn't stick |
| `self-defense` | `pr_author == reviewer`, parent human or root | rebutting a finding on your own code |
| `bot-finding` | own author is a Bot, no parent | the bot is the reviewer. Bot axis only |
| `toolkit-posted` | carries the project's marker | not evidence; `learn` grades it |

Precedence: marker, then bot root, then parent is a bot or marked, then `pr_author != reviewer`, then self-defense. Don't re-resolve ties the other way; it costs peer-review points on purpose. Never force bot roots into the other buckets (a finding and the reply to it are one exchange).

`bot-finding` uses the repo's bot bar when every counted occurrence is bot-authored; a `context_only` human reply can't lower it. **Counting is not verification**: a bot repeats a wrong finding as cheaply as a right one. Verify at least `minVerified` occurrences against the code and state each verdict, and drop AI review-body boilerplate before counting.

**Report per-bucket counts at the top of the report, before any candidate.** Never assume the split; count. Don't discard `agent-steering`: peer review asks whether someone else agrees this is wrong, steering asks whether it keeps happening, and §3.2 adds gates instead of a discount.

**Known blind spot:** agent-written code reviewed by its human author files as `self-defense`, because the test detects an AI reviewer and not the AI that wrote the code. When mining a repo where agents write most code, report the `self-defense` count and how much is root comments on the author's own PRs, and say some of the evidence can't be classified.

### 2.1 Themes, 2.2 repetition

Assign each comment one or two themes (`references/clustering-rubric.md`). A pattern needs the bar of its bucket: `peer-review` 3 or more distinct PRs; `agent-steering` 3 or more ancestry-collapsed units; bot-only `bots.minOccurrenceUnits` units plus `minVerified` code-verified instances. Same-reviewer repetition is a strong signal, and different reviewers converging is a very strong one. Never sum across buckets. Human replies retained as `context_only` can't turn a bot-only pattern into mixed evidence. If bot occurrences span repos with different bars, use the strictest.

### 2.3 Candidate set

Carry repeated patterns forward as preliminary candidates. Don't write the report yet: dedup and the bars are required report fields.

## Phase 3: curate

### 3.1 Dedup against existing rules

A candidate that restates an existing rule is worse than none. Search the compiled rules with at least four terms: mechanism, symbol or file, artifact class, defect verb.

```bash
for term in "<mechanism>" "<symbol>" "<artifact-class>" "<defect-verb>"; do
  grep -rli "$term" .agents/skills/toolkit-review*/rules/    # every persona and pack
done
```

Report every term and its hit count, zeros included. Already a rule: drop it, or propose an edit if the evidence adds a new failure mode, quoting both texts. Not a rule: go to §3.2.

### 3.2 Evidence bars per bucket

State the bucket and bar on every candidate.

- **`peer-review`**: 3 or more distinct PRs. Same-PR repeats count once.
- **`agent-steering`**: 3 or more distinct occurrence-units. Repetition is the only signal, so it must be present at that count.

An **occurrence-unit** is where most candidates die. Decide it by git ancestry, never narrative: two PRs collapse into one unit only when the later one's tree contains the earlier one. Use each PR's pre-merge head SHA, never the merge commit (after a squash every landed commit is an ancestor of every later one, which collapses the whole history into one unit):

```bash
earlier=$(GH_HOST="$host" gh pr view "$a" --repo "$repo" --json headRefOid --jq .headRefOid)
later=$(GH_HOST="$host" gh pr view "$b" --repo "$repo" --json headRefOid --jq .headRefOid)
git -C "$localPath" cat-file -e "$earlier^{commit}" && git -C "$localPath" cat-file -e "$later^{commit}"
git -C "$localPath" merge-base --is-ancestor "$earlier" "$later"   # 0 same unit, 1 separate, other = error
```

Fetch a missing head only through a local remote verified against the canonical target. A PR calling itself "step 3b of the stack" is not evidence of a stack. Contains means the correction didn't stick (one unit); forked before means the fix never reached that code (separate units).

Because no second human assented, `agent-steering` also needs: (1) an **objective defect**, stated as the failure the code shows, or reject; (2) **quote the comment's conclusion**, not a mid-thread sentence, after reading the whole thread; (3) check whether the author **routed the fix elsewhere**; if so the artifact is a fix to that tool, not a review rule.

- **`toolkit-posted`**: never evidence for a mined rule; `learn` grades it with its own bar.
- **`self-defense`**: not rule evidence alone; it can corroborate another bucket.
- **Mixed candidates**: count each bucket separately and apply the bar of the dominant one.

**Near misses go on a `## Watchlist`.** List every candidate one unit or one verification short, with its evidence, dedup result, and what would promote it. Zero promoted plus a well-formed watchlist is a successful run; don't pad.

### 3.3 Report

After §3.1 and §3.2, write `<stateRoot>/pr-mining/curation-report.md` (template: `references/curation-output-format.md`): header, effective scope, summary with the §1.7 denominators, high-confidence candidates, watchlist, all themes, low-signal summary. Show the summary and each high-confidence candidate to the user and ask **Promote to rule?** (yes, no, edit).

### 3.4 Route to a persona

Every candidate needs a persona before it becomes a rule; don't default cross-cutting patterns into one repo-specific persona.

1. Derive the live list, not a fixed one: `ls .agents/skills/toolkit-review*/rules/ | grep -v '^_'` and `resolve.mjs --field adapters.personas`. Flag a rules directory no persona list references, and the reverse.
2. Classify by the rule's actual mechanism (the hook, provider or type it narrows), never by the code sample's components or the §2.1 theme. Ask: does the rule depend on this repo's own libraries and domain, or would it hold with those stripped out? A repo-specific mechanism goes to the repo's persona. A rule that holds for any consumer of a shared library goes to that library's persona. A language- or framework-wide pattern goes to the language or framework persona. Where a rule imports from a shared package, check that the other repos can actually use that package before listing them.
3. Set `repos_exclude` deliberately, with a stated reason, only where a repo structurally can't trigger the pattern; never on a vague "not really ours" instinct.
4. If no persona matches, don't force the nearest one. Ask the user: a new persona, or a wider scope for an existing one.

### 3.5 Write the rule file

In the persona's rules directory, from `rules/_template.md`: `title`; `impact` (3-5 occurrences medium, 6 or more high); `repos`; `repos_exclude` (state "none" explicitly if none); `tags` from the theme; `source: pr-mined`; `reviewer_type` (`human`, `ai-reviewer` or `mixed`, from `source_type`); `applies_when`; a body with Description and Why It Matters in the reviewer's words and Incorrect/Correct from the diff context. With no clear example, use description only and mark `<!-- TODO: add code examples from PR context -->`. Name the PRs in the commit's `Source:` trailer, not in the rule file.

### 3.6 Report results

List the rule files created, totals (reviewed, promoted, skipped), and remind the user to run `toolkit-review` against the new rules. A pattern that held across several repos is also a lesson: `node .agents/skills/toolkit-reflect/scripts/lessons.mjs record --scope core --fingerprint <slug> --summary "<one line>" --status proposed` (see `toolkit-reflect`).

## Notes

- Rate limits: a 16-way extraction is far below GitHub's hourly limits.
- Reruns with the same scope overwrite derived data; a changed date range or scope changes the fingerprint and rebuilds derived output. Compatible raw payloads stay reusable (`references/watermark-cache.md`).
- Target: a 6-month window in under 5 minutes (cold under 2, warm under 20 s). `references/performance-pitfalls.md` first when a run is slow.

## Reference files

- `scripts/scope.mjs`: effective scope from `project.json`; `inScope()`.
- `scripts/classify-interlocutor.mjs`: §2.0, mechanically.
- `references/extraction-mechanics.md`: identity, windows, gates, record schema.
- `references/learn-mode.md`: grading, ledger, promotion bar.
- `references/clustering-rubric.md`, `references/curation-output-format.md`.
- `references/watermark-cache.md`, `references/performance-pitfalls.md`.
- `references/evidence-gates.md`: why each gate exists.

Test: `node --test bundles/core/toolkit-pr-mining/scripts/mining.test.mjs`.
