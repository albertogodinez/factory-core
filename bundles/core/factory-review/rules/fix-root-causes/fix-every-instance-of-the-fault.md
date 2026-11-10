---
title: Fix every instance of the fault, not only the one that was reported
impact: MEDIUM
repos: [cross-repo]
# repos_exclude reason: none needed. A fault repeated across sibling call sites is language- and stack-independent.
repos_exclude: []
tags: [debugging, correctness, consistency]
source: pstack
applies_when: A diff fixes a bug in one function, file, or call site, and the same pattern (the same helper misuse, the same missing case, the same wrong assumption) may exist elsewhere in the repo
principle: A fault is a pattern; fixing one instance leaves its siblings to fail the same way later.
date: 2026-10-23
---

## Description

When the diff fixes a bug, name the fault as a pattern ("parses the date without a timezone", "reads `items[0]` before checking the response status") and grep the repo at the head SHA for other places with the same shape. Flag the siblings the diff leaves unfixed, with their paths and lines.

Two shapes hide their siblings:

- **A readiness gate added to one caller.** When the fix holds a call until a dependency is ready (a map camera, an SDK, a socket, a mounted ref) because the dependency ignores it before then, every other caller of that dependency's API that can run before ready is a sibling. List each with whether it is gated. A sibling the PR body calls "pre-existing, out of scope" needs a linked ticket; a mention alone gets dropped.
- **A widened guard.** When the diff widens a condition (`else if (pending)` to `else`, a narrower predicate made broader), every call inside it now runs for the newly admitted states. List each call and what it does there; a call that only made sense for the old states is a regression the diff introduced.

Also flag a fix whose investigation clearly took a deep dig (the PR body or commits describe a long hunt) when nothing in the diff makes the deciding fact visible next time. Recommend the cheap, always-on signal that would have shown it at first look: a log field, a typed error, an assertion in a test, a metric tag. Return this as a `question` at P3; it is a suggestion, not a defect.

A workaround that needs a paragraph-long comment to justify it is the code saying it is wrong. Flag the code, not the comment's length; `no-comments` owns the comment itself.

## Why It Matters

The sibling with the same fault fails next week, in a different place, and its investigation starts from zero because nothing links it to the fix that already happened.

## Incorrect

```ts
// Fixed in formatCheckIn; formatCheckOut still calls new Date(isoDate) without the zone.
export const formatCheckIn = (iso: string, zone: string) =>
  formatInZone(iso, zone);
export const formatCheckOut = (iso: string) => format(new Date(iso));
```

## Correct

```ts
export const formatCheckIn = (iso: string, zone: string) =>
  formatInZone(iso, zone);
export const formatCheckOut = (iso: string, zone: string) =>
  formatInZone(iso, zone);
```
