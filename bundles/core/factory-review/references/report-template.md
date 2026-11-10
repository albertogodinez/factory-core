# Toolkit Review Report Template

## Header

```
## Toolkit Review Results

**Repo:** <repo_name>
**Worktree:** <worktree_path_if_applicable>
**Scope:** <N files changed, M insertions, K deletions>
**Intent:** <2-3 line intent summary>
**Plan:** <plans/<...>.md if found, omit line otherwise>
**Reviewers:** <list of personas that ran>
```

## Findings

Render each severity as its own table. Omit severities with zero findings.

```
### P0 — Critical

| # | Blocking | File | Issue | What goes wrong | Fix sketch | Reviewer | Conf. |
|---|----------|------|-------|-----------------|------------|----------|-------|

### P1 — Should Fix

| # | Blocking | File | Issue | What goes wrong | Fix sketch | Reviewer | Conf. |
|---|----------|------|-------|-----------------|------------|----------|-------|

### P2 — Consider

### P3 — Low / Optional
```

Rules:
- One row per merged finding. Multi-reviewer findings list all agreeing reviewers comma-separated.
- Confidence is a number (0.00–1.00), rounded to 2 decimals.
- Blocking is `yes` or `nit`, from the finding's `blocking` field.
- What goes wrong is the finding's `consequence`, one sentence. Fix sketch is the `recommendation`, as inline code when it fits on a line; otherwise a short description and the full snippet below the table.
- Only `mode: "comment"` findings go in the severity tables. `question` findings go under Questions for the Author; `human_eyes` findings under Needs Human Eyes.
- File column uses `path:line` format with `:line-line` for ranges.

- `#` is one sequence across all severity tables, not restarted per table. Phase 5 selects findings by it.

## Questions for the Author

Findings with `mode: "question"`. These are postable; numbering continues the same `#` sequence.

```
| # | Blocking | File | Question | Why it matters |
|---|----------|------|----------|----------------|
```

## Needs Human Eyes

Findings with `mode: "human_eyes"`: nothing a reviewer could read settles them. Bullets, one line each, with what would settle it. **Never postable.**

## Checked, but Left Alone

Union of `checked_left_alone[]` across personas, deduplicated. This is where a dismissed false positive lands, so the user can see it was looked at.

```
| File | What made us look | Why it isn't a finding |
|------|-------------------|------------------------|
```

## Previously Posted (re-reviews only)

Our earlier `kind: "review"` comments on this PR, judged from the current code.

```
| # | File | Earlier comment | Status | Thread |
|---|------|-----------------|--------|--------|
| C1 | path:line | <first line> | addressed / still open / answered | <url> |
```

Number these `C1`, `C2`, … so they cannot be confused with finding numbers, severities, or plan requirements (`R#`).

## Pre-existing Issues

Separate section with the same table format. These do not count toward the verdict.

## Residual Risks

Bulleted union of `residual_risks[]` from all personas. Deduplicate by meaning.

## Testing Gaps

Bulleted union of `testing_gaps[]` from all personas.

## Requirements Completeness

Include only when a plan was found.

```
| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| R1 | <text> | met / partial / missing | <evidence or gap> |
```

## Verdict

One of:
- **Ready to merge** — no blocking findings open, plan requirements met
- **Ready with fixes** — blocking findings exist, but every one has a mechanical fix sketch (a few lines, no design decision)
- **Not ready** — any blocking finding without a mechanical fix, any blocking question, OR unmet plan requirements

Include a 1-2 sentence rationale pointing to the top blockers.

## Coverage

One row per persona that was selected, including any skipped by a gate or dropped after a timeout, so reduced coverage is visible instead of silent.

| Persona | Status | Findings | Grounding | Notes |
|---------|--------|----------|-----------|-------|
| general | completed | N | complete | |
| react-patterns | completed | N | complete | M rules loaded |
| design-system-conventions | completed | N | no design-system-context.txt (query failed) | M rules loaded |
| typescript-conventions | skipped (no .ts/.tsx) | 0 | | |
| test-behavior | skipped (no test files) | 0 | | |

Grounding names each context file the persona takes that was absent, and why. Below the table, paste the `check-sweep-coverage.mjs` summary line and any hits still unreviewed after the follow-up.

## Post to GitHub (PR targets only)

Last section, and only when the target is someone else's GitHub PR. One line, then stop and wait:

```
**Post to PR #<N>?** Reply with finding numbers (e.g. `post 2,3,5`, `post all blocking`), `draft <nums>` to preview first, or `none`. Comments go into a pending review that you submit yourself.
```

On the user's own PR, use this line instead:

```
**Fix locally?** Reply with finding numbers (e.g. `fix 1,3`, `fix all blocking`) or `none`. Fixes land as commits on the branch; nothing is posted to the PR.
```

Mention it when the user already has a pending review on the PR, since Phase 5 will add to it rather than start a new one. On a re-review with `addressed` earlier comments, add: `resolve C<nums>` closes those threads (ours only).
