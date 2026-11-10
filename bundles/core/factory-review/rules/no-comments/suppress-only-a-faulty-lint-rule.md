---
title: Suppress only a faulty lint rule, never one that catches a real bug
impact: MEDIUM
repos: [cross-repo]
# repos_exclude reason: none needed. eslint-disable, @ts-ignore, @Suppress, # noqa and # type: ignore all switch off a check the same way.
repos_exclude: []
tags: [comments, lint, type-safety, suppressions]
source: pstack
applies_when: A diff adds eslint-disable, @ts-ignore, @ts-expect-error, @ts-nocheck, @Suppress / @SuppressWarnings, detekt or ktlint suppressions, # noqa, # type: ignore, or a similar directive
principle: Suppress a check only when the check is wrong for this line; when it catches a real bug, fix the code it points at.
date: 2026-10-23
---

## Description

For every suppression the diff adds, look up the rule it silences and decide which kind it is:

- **Faulty, pedantic, or style-only** for this line (a formatting rule, a known false positive with a linked upstream issue): it may stay, scoped to one line, ideally with the rule name and a one-line reason.
- **Protects correctness or safety** (`react-hooks/exhaustive-deps`, `@typescript-eslint/no-floating-promises`, a type error, `UNCHECKED_CAST`, a security lint): flag it. Name the exact symbol the check points at and the fix that satisfies the rule. Removing the directive is half the fix; the other half is the code change.

Flag a file-wide or block-wide suppression (`/* eslint-disable */` at the top, `@file:Suppress`, `# type: ignore` on an import of a whole module) whenever a line-scoped one would do.

`typescript-conventions` owns `as` casts and `!` non-null assertions; this rule owns the directives.

## Why It Matters

A suppression on a correctness rule keeps the bug and removes the only thing that reports it. It also stays after the code around it changes, silencing new violations nobody reviewed.

## Incorrect

```ts
// eslint-disable-next-line react-hooks/exhaustive-deps
useEffect(() => {
  load(tripId);
}, []);
```

## Correct

```ts
useEffect(() => {
  load(tripId);
}, [tripId, load]);
```
