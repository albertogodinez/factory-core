---
title: Check array lengths before expensive comparisons
impact: MEDIUM-HIGH
repos: [cross-repo]
tags: [javascript, arrays, performance, optimization]
source: vercel
applies_when: Arrays are compared using sorting, serialization, or deep equality without a length guard
date: 2026-04-08
---

## Description

When comparing arrays with expensive operations (sorting, joining, deep equality), check lengths first. If lengths differ, the arrays cannot be equal and the comparison can return immediately in O(1).

## Why It Matters

In components that compare itinerary items, activity lists, or search results to detect changes, skipping the length check means running O(n log n) sorts on every comparison even when the arrays are obviously different sizes. In hot paths like render loops or event handlers, this adds up fast.

## Incorrect

```tsx
// BAD: Always sorts and joins, even when arrays are different sizes
function hasActivitiesChanged(current: Activity[], original: Activity[]) {
  return current.map(a => a.id).sort().join() !== original.map(a => a.id).sort().join();
}
```

## Correct

```tsx
// GOOD: O(1) bail-out when lengths differ
function hasActivitiesChanged(current: Activity[], original: Activity[]) {
  if (current.length !== original.length) return true;

  const currentIds = current.map(a => a.id).toSorted();
  const originalIds = original.map(a => a.id).toSorted();
  return currentIds.some((id, i) => id !== originalIds[i]);
}
```

## References

- [Vercel: js-length-check-first](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/js-length-check-first.md)
