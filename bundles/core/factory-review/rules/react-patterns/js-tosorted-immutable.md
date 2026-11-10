---
title: Use toSorted instead of sort to avoid mutating arrays in React state
impact: MEDIUM-HIGH
repos: [cross-repo]
tags: [javascript, immutability, arrays, state]
source: vercel
applies_when: Array.sort() is called on props, state, or derived data inside a React component
date: 2026-04-08
---

## Description

Use `.toSorted()` instead of `.sort()` when sorting arrays in React components. `.sort()` mutates the original array in place, which violates React's immutability model and causes subtle bugs when the sorted array is derived from props or state.

## Why It Matters

Mutating props or state arrays breaks React's ability to detect changes. In components that sort trip lists by date or name, calling `.sort()` on the original array silently corrupts the source data, leading to stale renders and inconsistent UI.

## Incorrect

```tsx
// BAD: .sort() mutates the trips prop array in place
function TripList({ trips }: { trips: Trip[] }) {
  const sorted = useMemo(
    () => trips.sort((a, b) => a.startDate - b.startDate),
    [trips]
  );
  return <div>{sorted.map(renderTrip)}</div>;
}
```

## Correct

```tsx
// GOOD: .toSorted() creates a new array, original unchanged
function TripList({ trips }: { trips: Trip[] }) {
  const sorted = useMemo(
    () => trips.toSorted((a, b) => a.startDate - b.startDate),
    [trips]
  );
  return <div>{sorted.map(renderTrip)}</div>;
}

// Fallback for older environments: [...trips].sort(...)
```

## References

- [Vercel: js-tosorted-immutable](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/js-tosorted-immutable.md)
- [MDN: Array.toSorted()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/toSorted)
