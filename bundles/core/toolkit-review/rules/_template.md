---
# BEFORE FILLING THIS IN: choose the persona directory this file lives in deliberately. Ask:
# "does this rule depend on one product's code (its GraphQL schema, its component library, its
# template system), or would it hold in any repo using the same language or framework with that
# dependency stripped out?"
# - Depends on product code -> a persona pack's rules/<persona>/ directory, not core.
# - Holds in any React repo with no design-system or product dependency -> rules/react-patterns/.
# - Holds for any TypeScript code and isn't a React render/perf pattern -> rules/typescript-conventions/.
# - Holds in any language and is about symptom fixes, test-assertion quality, or comments/suppressions
#   -> rules/fix-root-causes/, rules/test-behavior/, or rules/no-comments/ (repos: [cross-repo]).
# Do NOT classify by which design-system components appear in your code sample. Read what the rule's
# mechanism (the hook/provider/type it narrows) depends on and where that mechanism lives.
# If no existing persona directory fits, stop and flag it for a human decision (new persona vs.
# widen an existing one) instead of forcing it into the nearest bucket.
title: [Rule name - concise, imperative]
impact: CRITICAL|HIGH|MEDIUM|LOW
repos: [cross-repo]  # or a list of project names (the resolver's project.name)
# repos_exclude: set this deliberately, not by omission. For every repo not obviously in scope,
# decide whether it needs excluding and say why. Exclusion wins over a cross-repo include.
repos_exclude: []
tags: [performance, re-render]  # topic tags
source: manual  # or pr-mined, or the name of a third-party adaptation
reviewer_type: human|ai-reviewer|mixed  # optional; for source: pr-mined only
applies_when: One-line description of when this rule is relevant
principle: One sentence that would hold in a different codebase, e.g. "Reuse the design system's component when it already covers the edge cases you'd reimplement."  # reviewers start their finding's principle from this
date: 2026-04-08
---

## Description

What this rule checks for and why it matters.

## Why It Matters

Impact on performance, maintainability, correctness, or user experience.

## Incorrect

```tsx
// Bad example with explanation comment
```

## Correct

```tsx
// Good example with explanation comment
```

## References

- [Link to source or further reading]
