---
title: Check synchronous conditions before expensive awaits
impact: CRITICAL
repos: [cross-repo]
tags: [async, waterfall, performance]
source: vercel
applies_when: An await is performed before checking a condition that could short-circuit the operation
date: 2026-04-08
---

## Description

Check cheap synchronous conditions (null checks, feature flags, permissions) before performing expensive async operations. Moving the guard before the await avoids unnecessary network calls.

## Why It Matters

Every unnecessary await adds latency and server load. In components that conditionally fetch data based on trip state or user permissions, this pattern prevents wasted API calls.

## Incorrect

```tsx
// BAD: Fetches data even when the trip is cancelled
const tripData = await fetchTripDetails(tripId);
if (trip.status === 'cancelled') {
  return null;
}
return <TripOverview data={tripData} />;
```

## Correct

```tsx
// GOOD: Cheap check first, expensive fetch only when needed
if (trip.status === 'cancelled') {
  return null;
}
const tripData = await fetchTripDetails(tripId);
return <TripOverview data={tripData} />;
```

## References

- [Vercel: async-cheap-condition-before-await](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/async-cheap-condition-before-await.md)
