---
title: Build lookup Maps for repeated searches
impact: LOW-MEDIUM
repos: [cross-repo]
tags: [js-performance, data-structures]
source: vercel
applies_when: Code uses array.find() or array.includes() repeatedly inside a loop or render
date: 2026-04-08
---

## Description

When looking up items by key repeatedly, build a Map or object index first. Array.find() is O(n) per lookup; a Map lookup is O(1). For lists rendered in the UI (trip items, activities, destinations), this prevents quadratic performance.

## Why It Matters

In trip list views with 50+ items where each item checks membership or looks up related data, O(n²) array scans cause visible jank during render.

## Incorrect

```tsx
// BAD: O(n²) — find() scans selectedIds for every trip
{trips.map(trip => (
  <TripCard 
    key={trip.id} 
    selected={selectedIds.find(id => id === trip.id) !== undefined}
  />
))}
```

## Correct

```tsx
// GOOD: O(n) — Set lookup is O(1) per trip
const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

{trips.map(trip => (
  <TripCard 
    key={trip.id} 
    selected={selectedSet.has(trip.id)}
  />
))}
```

## References

- [Vercel: js-index-maps](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/js-index-maps.md)
