---
title: Maximize parallelism for operations with partial dependencies
impact: CRITICAL
repos: [cross-repo]
tags: [async, waterfall, parallelism, promise-chaining]
source: vercel
applies_when: Async operations have partial dependencies but are being fully serialized
date: 2026-04-08
---

## Description

When async operations have partial dependencies (A and B are independent, but C depends on A), structure promises so that independent work starts immediately. Create promises eagerly, then chain dependent work off specific promises rather than awaiting everything sequentially.

## Why It Matters

In apps, an overview page might need an item's details, user preferences, and related activities (which depend on the ID from the details). Fully serializing these wastes time — preferences can load in parallel with trip details, and activities can start as soon as trip details resolve without waiting for preferences.

## Incorrect

```tsx
// BAD: preferences and activities both wait for tripDetails unnecessarily
const [tripDetails, preferences] = await Promise.all([
  fetchTripDetails(tripId),
  fetchPreferences(),
]);
const activities = await fetchActivities(tripDetails.destination);
```

## Correct

```tsx
// GOOD: preferences and activities chain independently
const tripDetailsPromise = fetchTripDetails(tripId);
const activitiesPromise = tripDetailsPromise.then(trip =>
  fetchActivities(trip.destination)
);

const [tripDetails, preferences, activities] = await Promise.all([
  tripDetailsPromise,
  fetchPreferences(),
  activitiesPromise,
]);
```

## References

- [Vercel: async-dependencies](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/async-dependencies.md)
