# Performance targets and pitfalls

Target: a 6-month window should extract and cluster in under 5 minutes (cold cache under 2, warm under 20 s). Discovery scales with the number of repo and reviewer pairs; the bot axis adds one repo-wide query per repo that has it on.

Failure modes that cost minutes:

1. **Background `&` loops hang on permission prompts** the harness can't surface. Use one foreground `xargs -P`, or write a `.sh` file and run it in the foreground.
2. **Sequential PR-by-PR extraction.** About 150 ms per call, six calls per PR, 100 PRs is 90 s at best. Parallelize with `xargs -P 8`.
3. **High-level search output hides completeness metadata and `mergedAt`.** Use the Search REST response (`total_count`, `incomplete_results`), split capped windows, use `updated_at` for watermarks, fetch `mergedAt` from PR details and enforce the window client-side.
4. **A bare login returns nothing on a host whose accounts carry a suffix.** Query with `queryLogins` from `scope.mjs`.
5. **Re-fetching unchanged file lists.** Cache each PR's changed-file list by `updatedAt` and schema version; don't reuse derived path matches after the scope fingerprint changes.
6. **`jq` lookups inside loops** reparse the file each time. Build a lookup table once (`jq -r '.[] | "\(.number)\t\(.title)\t\(.url)"' > _lookup.tsv`) and use `awk`.
7. **An unbound `gh` call uses the ambient account's host.** Prefix every call with the resolved `GH_HOST`, discovery and ancestry checks included.
8. **Logical-repo cache paths mix fork and upstream payloads.** Namespace by `ghHost/owner/repo` and check `_source.json` before a hit.

| Phase | Target | If exceeded |
|---|---|---|
| Search, all pairs and bot axes in parallel | 5-10 s | check host-bound auth and rate limits |
| Path classification (`xargs -P 8`) | 5-15 s | check the file-list cache and pagination |
| Comment extraction (`xargs -P 16`) | 15-45 s | check the response shape and pagination |
| Cluster and report | 5 s | n/a |
| Total, cold | under 2 min | investigate before the next run |
| Total, warm | under 20 s | cache invalidation is broken; check `_watermark.json` |
