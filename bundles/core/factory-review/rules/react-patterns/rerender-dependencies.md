---
title: Use primitive values in hook dependency arrays
impact: LOW
repos: [cross-repo]
tags: [re-render, hooks, performance]
source: vercel
applies_when: A useEffect or useMemo dependency is an object or array when a primitive field would suffice
date: 2026-04-08
---

## Description

Depend on primitive values (strings, numbers, booleans) instead of objects in hook dependency arrays. Objects create new references on every render, causing effects and memos to re-run unnecessarily.

## Why It Matters

Every unnecessary effect re-run can trigger network requests, DOM mutations, or subscription resets. In components that depend on trip data objects, this causes redundant GraphQL refetches.

## Incorrect

```tsx
// BAD: trip object reference changes every render → effect re-runs every time
useEffect(() => {
  fetchActivities(trip.id);
}, [trip]);
```

## Correct

```tsx
// GOOD: Depends on the primitive id — only re-runs when id actually changes
useEffect(() => {
  fetchActivities(trip.id);
}, [trip.id]);
```

## References

- [Vercel: rerender-dependencies](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rerender-dependencies.md)
