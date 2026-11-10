---
title: Move await into branches where actually needed
impact: HIGH
repos: [cross-repo]
tags: [async, waterfall, performance]
source: vercel
applies_when: An await is at the top of a function but the result is only used in one branch
date: 2026-04-08
---

## Description

When an async result is only needed in one code path, defer the await into that branch. This avoids blocking the entire function when the other branch doesn't need the data.

## Why It Matters

Unnecessary top-level awaits block component rendering. In components with conditional rendering paths, this delays the entire component when only one path needs the data.

## Incorrect

```tsx
// BAD: Always awaits even when showing the simple view
const details = await fetchTripDetails(tripId);
if (isCompactView) {
  return <TripCard title={trip.title} />;
}
return <TripDetailView details={details} />;
```

## Correct

```tsx
// GOOD: Only fetch when the detailed view is needed
if (isCompactView) {
  return <TripCard title={trip.title} />;
}
const details = await fetchTripDetails(tripId);
return <TripDetailView details={details} />;
```

## References

- [Vercel: async-defer-await](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/async-defer-await.md)
