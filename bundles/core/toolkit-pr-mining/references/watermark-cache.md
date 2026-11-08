# Watermark and cache

Reruns skip PRs whose payload hasn't changed. The cache holds scope-neutral payloads, keyed by canonical source, the PR's `updatedAt` and a payload schema version. It is not source-neutral: a payload fetched from a fork can't satisfy a request for its upstream. Always re-run cohort, bot and path filtering after a cache read.

Identity comes only from `scope.mjs`: `ghHost` and `canonicalRepo`.

```
<stateRoot>/pr-mining/cache/<gh-host>/<owner>/<repo>/
  _source.json          {"ghHost","canonicalRepo"}
  _payload-schema.json  {"version": N}
  _watermark.json       {"3307": "2026-03-15T18:42:00Z", ...}
  3307.json             unfiltered review graph
  3307-files.json       complete changed-file list
```

A hit needs all of: `_source.json` equal to the resolved identity, `_payload-schema.json` equal to the current version, the watermark equal to the PR's normalized `updatedAt` from this run's discovery, and both payload files non-empty. A missing or mismatched marker invalidates the whole namespace: refetch, don't relabel. A miss fetches from the canonical repo with the bound `GH_HOST` and writes payloads, markers and watermark atomically (temp file, then rename).

`updatedAt` advances on commits, comments, labels and merges, so a late comment after a merge refetches the PR; a label edit also does, which is acceptable.

## Scope fingerprint

Hash a deterministic object: `since`, `until`, `includeNonApproved`, the pathless policy, the normalizer version, and per repo `ghHost`, `canonicalRepo`, `localPath`, `trunk`, effective cohort (sorted), bot mode and bars, `include` and `exclude` (sorted). Save it in `raw/_scope.json`; the report's Effective Scope table reproduces those values.

When the fingerprint changes, rebuild PR manifests, scoped comments, statistics, clusters and the report. A cohort, bot, path, local-path or trunk change does not refetch a compatible payload. A canonical-identity or payload-schema change does.

`--no-cache` bypasses every cache read and rewrites the namespace. The first seed creates `_watermark.json` as `{}`; the first run records each PR.
