# Curation output format

Exact structure for Phase 3.3's output, written to `<stateRoot>/pr-mining/curation-report.md` after dedup and evidence-bar evaluation:

```markdown
# PR Mining Curation Report

**Date range:** [since] to [until]
**Include non-approved reviews:** [true or false]
**Pathless review bodies:** [paths.pathlessBodies policy]
**Scope fingerprint:** [value from raw/_scope.json]

## Effective Scope

| Repo | Canonical source | Local path | Trunk | Reviewers | Bots | Path scope |
|---|---|---|---|---|---|---|
| [repo name] | [ghHost/owner/repo] | [localPath] | [trunk] | [effective reviewers] | [on or off] | [whole repo, or include/exclude prefixes] |

[Repeat one row for every selected repository. Values must match raw/_scope.json exactly.]

## Summary

| Metric | Count |
|--------|-------|
| PRs discovered | N |
| Discovery date shards queried | N |
| In-scope PRs (every changed file in scope) | N |
| Mixed PRs (some files in scope) | N |
| Out-of-scope PRs excluded | N |
| Unknown-scope PRs excluded | N |
| Raw review comments fetched | N |
| In-scope evidence retained | N |
| Replies included by inherited path | N |
| Context-only replies | N |
| Out-of-scope comments excluded | N |
| Pathless comments excluded | N |
| Reviewer-axis evidence | N |
| Bot-axis evidence | N |
| Peer-review evidence | N |
| Agent-steering evidence | N |
| Self-defense context | N |
| Bot findings | N |
| Per repo/reviewer: [repo] / [effective reviewer] | N |
| Per repo: [selected repo] | N |

[Repeat the last two row shapes for every effective repo/reviewer pair and selected repository.]

## High-Confidence Rule Candidates

Patterns meeting their bucket's evidence bar: peer review requires 3+ distinct PRs; agent steering requires 3+ ancestry-collapsed occurrence-units; bot-only evidence requires the repository's `bots` evidence bar (default 5+ ancestry-collapsed units and two code-verified instances; state the bar applied).

### [Theme: Pattern Name]
**Frequency:** N occurrences across M PRs / U distinct occurrence-units
**Dominant bucket / evidence bar:** [bucket] / [bar applied]
**Reviewers:** [cohort members who flagged this]
**Repos:** [where it appeared]
**Bot-only verification:** [N/A, or at least two PR/file verdicts]
**Dedup evidence:** [four search terms, hit counts including zeros, and resulting rule verdict]

Example comments:
> "[quote from PR #X]" by `reviewer` in [in-scope file path]
> "[quote from PR #Y]" by `reviewer` in [in-scope file path]

**Suggested rule:** [one-line description of what the rule would check]

---

## Watchlist

[List every candidate one PR/occurrence-unit short of its frequency bar or one required code verification short. Include its current evidence, bucket/bar, dedup result, and the exact additional occurrence or verification needed for promotion. Write `None.` when there are no entries.]

## All Themes

### Naming Conventions (N comments)
[Representative examples with PR links]

### GraphQL Patterns (N comments)
[Representative examples with PR links]

[...etc for each theme with comments...]

### Uncategorized (N comments)
[Comments that didn't fit a theme — review for new themes]

## Low-Signal Summary

Comments skipped as noise: N

- PRs excluded as out of scope or unknown: N
- Inline comments outside the path scope: N
- Pathless comments excluded from mixed PRs: N
- Non-cohort human comments excluded from evidence: N
- Non-cohort replies retained as context only: N
- Approvals/LGTM: N
- Too brief (<20 chars): N
- Bot comments skipped where effective bot mode was off: N
```
