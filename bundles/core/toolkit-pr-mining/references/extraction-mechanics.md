# Extraction mechanics

Phase 1 in detail. Read it when running a mine.

## Scope and identity

`node .agents/skills/toolkit-pr-mining/scripts/scope.mjs [--neighbor <name>] [--reviewers a,b] [--mine-bots|--no-mine-bots]` prints, per repo: `ghHost`, `canonicalRepo` (`owner/repo`; the upstream when origin is a fork), `localPath`, `trunk`, `cohort`, `queryLogins` (cohort plus `loginSuffix`), `bots`, `paths`, `marker`, `stateRoot`. These are the only inputs. Don't read the remote URL or any other config for them. If it exits 1, mining isn't configured for that repo; stop and say what to add.

Prefix every `gh` call with `GH_HOST="$ghHost"` and pass `--repo "$canonicalRepo"`. Use `git -C "$localPath"` for every local git call. A fork's own slug is never a mining target. Output keeps bare logins; `queryLogins` is for search queries only.

## Merge-date window

Validate `since` and `until` as real `YYYY-MM-DD` dates with `since <= until` before any GitHub call. Both bounds are inclusive. Search through `gh api --method GET search/issues ... --paginate --slurp` so each page keeps `total_count` and `incomplete_results`:

- reviewer axis: `repo:$canonicalRepo is:pr is:merged reviewed-by:$login merged:$since..$until`, one per query login;
- bot axis: the same without `reviewed-by`.

A shard is unproven when any page has `incomplete_results: true` or `total_count >= 1000`. Split its interval at the midpoint into two non-overlapping inclusive halves, rerun, and recurse until every shard is complete. Merge and de-duplicate by PR number. If a single-day shard is still capped or incomplete, stop: write no manifest and no report. Record each final shard's interval, row count, `total_count` and `incomplete_results` in the scope manifest.

Normalize Search items to the cache contract (`html_url` to `url`, `updated_at` to `updatedAt`, `user.login` to `author.login`) before writing `_all_prs.json`, and reject an item missing a field. Search items carry no canonical `mergedAt`: the detail fetch must include it, and every PR whose `mergedAt` is null or outside `sinceT00:00:00Z`..`untilT23:59:59Z` is rejected, after cache reads too.

## PR path gate

Fetch every changed filename per PR, paginated, in one foreground `xargs -P 8` job; a failed or partial request makes the PR `unknown`:

```bash
GH_HOST="$ghHost" gh api --paginate "repos/$canonicalRepo/pulls/$pr/files?per_page=100" --jq '.[].filename'
```

A path is in scope when it starts with an `include` prefix (any path, when `include` is empty) and with no `exclude` prefix; `exclude` wins. Prefixes end in `/` and match whole directories: `src/` matches `src/a.ts`, not `srcish/a.ts` or `docs/src/a.ts`. Reject absolute paths and paths containing `..`. `scope.mjs` exports `inScope(path, paths)`.

Classify each PR: `in-scope` (every file in scope), `mixed`, `out-of-scope` (excluded), `unknown` (excluded, reported). Keep `in-scope` and `mixed`; a mixed PR still has out-of-scope comments, so the comment gate filters each thread by its own path.

## Fetch and comment gate

One call per PR, from toolkit-review's script, passing the marker text from `scope.mjs` so our own comments are flagged:

```bash
bash .agents/skills/toolkit-review/scripts/fetch-pr-threads.sh "$ghHost" "$canonicalRepo" "$pr" "$marker"
```

It returns `pr`, `reviews[]` and `comments[]` with the reply graph already resolved. Fields used here:

| Field | Meaning |
|---|---|
| `pr.{number,title,url,author,merged_at,head_ref_oid}` | PR metadata |
| `comments[].{comment_id,url,path,diff_hunk,body}` | the comment |
| `comments[].{author,author_type}` | login (bots end in `[bot]`) and `Bot` or `User` |
| `comments[].{review_id,review_state}` | the review it belongs to |
| `comments[].{in_reply_to_id,parent_author,parent_author_type,parent_ours}` | reply graph |
| `comments[].{root_id,thread_resolved}` | thread root, resolution |
| `comments[].{ours,ours_kind}` | carries the project's marker; its `kind` |

Cache the output unfiltered; filter after every cache read. Fetch the whole graph first: non-cohort replies may be needed as context. Apply in order:

1. An inline root comment uses its own `path`.
2. A reply with no path inherits its root's path by following `in_reply_to_id`; if the chain is missing or cyclic, drop it.
3. Keep a thread only if the resolved path is in scope.
4. Keep a pathless review body only when `paths.pathlessBodies` is `scoped-pr-only` and the PR is `in-scope`.
5. Never use issue or PR conversation comments.
6. A human comment is evidence only when its login, with `loginSuffix` removed once, is in the cohort. A non-cohort reply inside an in-scope thread is kept as `context_only: true` and is never counted or quoted.
7. Skip bot comments unless the repo's bot mode is on; then they must pass the path gate and are tagged `source_type: "ai-reviewer"`, `axis: "bot"`.
8. Drop approvals, LGTM or emoji-only text, CI status, dependency-bot and scanner noise, bot review-body boilerplate, and anything under 20 substantive characters.

Run these in one foreground script, `xargs -P 16`; never `&` loops.

## Output

Raw, unfiltered payloads: `<stateRoot>/pr-mining/cache/<ghHost>/<owner>/<repo>/` (see `watermark-cache.md`). Derived evidence: `<stateRoot>/pr-mining/raw/<repo>/<reviewer>.json`, plus `_bots.json` when the bot axis is on. Each record needs at least:

```json
{ "reviewer": "ann", "author": "ann_corp", "author_type": "User", "repo": "app", "gh_host": "github.com",
  "canonical_repo": "acme/app", "pr_number": 552, "pr_title": "Example", "pr_url": "https://example.invalid/pull/552",
  "pr_author": "someone", "pr_merged_at": "2026-08-15T12:34:56Z", "head_ref_oid": "abc123", "pr_scope": "mixed",
  "comment_type": "inline", "comment_id": 123, "body": "Example feedback", "diff_hunk": "@@ -1,2 +1,2 @@",
  "file_path": "src/example.ts", "resolved_scope_path": "src/example.ts", "scope_match": true, "context_only": false,
  "in_reply_to_id": null, "parent_author": null, "parent_author_type": null, "source_type": "human", "axis": "reviewer" }
```

Before clustering, assert: every record has `scope_match: true` and `context_only: false`; `pr_merged_at` is non-null and inside the window; the path is in scope (or the body is a pathless body of an `in-scope` PR); `source_type` is `human` wherever bot mode is off; every human `reviewer` is in the cohort.

`<stateRoot>/pr-mining/raw/_scope.json` holds `since`, `until`, `includeNonApproved`, the pathless policy, the proven-complete shards with counts, and for each repo: `ghHost`, `canonicalRepo`, `localPath`, `trunk`, effective cohort, bot mode and bars, `include`, `exclude`. A stable fingerprint hashes the scope-defining inputs (not shard counts). A report without this manifest is incomplete and must not be curated. Keep PR author names apart from reviewer counts: a cohort constrains comment authors, not who opened the PR.
