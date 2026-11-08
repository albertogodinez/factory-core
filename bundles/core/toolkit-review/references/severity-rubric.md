# Severity & Confidence Rubric (shared across all reviewers)

Every reviewer dispatched by `toolkit-review` must apply this rubric before assigning a severity or confidence. The rubric exists to stop severity drift (same issue graded P2 by one reviewer and P3 by another) and to prevent confident-but-wrong P0s.

## Severity ladder

| Severity | Definition |
|----------|------------|
| **P0** | Production-breaking: data loss, crash for all users on a supported path, security vulnerability, auth bypass. Ship blocker. |
| **P1** | Likely user-visible regression or incorrect behavior on a realistic path. Should fix before merge. |
| **P2** | Maintenance/performance/readability issue that will compound. Fix in this PR if cheap; otherwise file a follow-up. |
| **P3** | Nit, style, optional cleanup, or defensive hardening. Authors may accept or reject without pushback. |

## Blocking: the fix contract

Severity sorts the report. **`blocking` decides what must be fixed before merge**, and the verdict and every downstream skill (any skill that consumes this report) key on it.

| Case | `blocking` |
|------|-----------|
| P0 or P1 that cleared verify-before-P0 | `true` |
| P2 | decide from the consequence: would we accept shipping this as is? No → `true` |
| P3 | `false` |
| `pre_existing: true` | `false` |

Posted comments mark `blocking: false` findings with a `nit:` prefix. If every finding on a PR comes out non-blocking, check you are not grading your own homework: re-read the top finding's consequence and ask whether you would accept it in production.

## The consequence gate (all reviewers)

Every finding needs a `consequence`: what shipping this makes true that isn't true now. If you can't name one, it's an observation, not a finding — record it under `checked_left_alone` with why it holds, and don't return it as a finding. This gate runs before severity and confidence. It is what stops "duplicated `track()` block" findings where the two blocks are an `onClick` and a guarded `onKeyDown` and extracting them would fix nothing.

## Verify-before-P0 rule (correctness, security, reliability reviewers)

Before assigning **P0 or P1**, a reviewer MUST:

1. **Walk to the call site.** The diff shows a function; the reviewer must open the caller to see how inputs are gated. A crash on `.length` of a value that is null-guarded upstream is not P0.
2. **Check the type.** If the concern is nullability, read the TypeScript / GraphQL / Zod type. If the type says non-null, the crash isn't real.
3. **Trace inputs.** For "this could be undefined" findings, show where the value comes from. If it comes from a typed fragment, from a required prop, or from a constant, downgrade or drop.

If the reviewer cannot verify any of the above (e.g., worktree missing, file unreadable), they must downgrade to P2 with confidence ≤ 0.70 and note the unverified assumption in `evidence`.

## Confidence calibration (all reviewers)

- **0.90 – 1.00** — The issue is visible in the diff, the fix is mechanical, and the reviewer has verified the call site / type.
- **0.70 – 0.89** — The issue is likely real but one assumption is unverified (e.g., parent stability, library behavior). State the assumption in `evidence`.
- **0.60 – 0.69** — Plausible concern; merge pipeline will only keep this at P0. Reviewers should prefer escalating verification before returning this band.
- **< 0.60** — Suppress. Do not return.

## Cross-persona severity consistency

When multiple reviewers may flag the same issue, use these anchors so severities line up:

| Pattern | Anchor severity |
|---------|-----------------|
| Unstable `useCallback`/`useMemo` deps causing re-creation every render | **P2** (not a bug, measurable perf concern) |
| Inline object passed as prop that triggers React re-render only (no observer, no effect re-run) | **P3** |
| Inline object that enters a dependency array or observer `deps` | **P2** |
| Missing null/undefined guard when the upstream type allows null | **P1** |
| Missing null/undefined guard when upstream is non-null by type or explicit guard | suppress (not a real bug) |
| Hardcoded magic number coupled to a fixture | **P2** |
| Missing test assertion for an important side effect | **P2** |
| Missing edge case test (empty, zero, null input) | **P3** unless the edge case is known-reachable |
| Duplicate literal that would benefit from a helper | **P2** or **P3** depending on blast radius |
| Untyped analytics/event literal that could silently diverge from schema | **P2** |
| Prop drilling via Context where a closure would work | **P2** (architectural), **P3** (style) |

When two reviewers disagree on severity for the same finding, the merge step should keep the **higher** severity only if cross-reviewer agreement is ≥ 2; otherwise, default to the anchor above.

## What every reviewer must NOT flag

- **Pre-existing code** — unchanged lines outside the diff. Exception: the change makes an existing issue reachable or worse.
- **Speculative library behavior.** If the reviewer hasn't read the library source and the concern depends on it, either (a) read the source, or (b) downgrade confidence to ≤ 0.70 and state the assumption.
- **Style preferences** not backed by a compiled rule or the anchors above.
