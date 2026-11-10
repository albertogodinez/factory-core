---
title: Run independent async operations in parallel
impact: CRITICAL
repos: [cross-repo]
tags: [async, waterfall, performance]
source: vercel
applies_when: Multiple independent await calls are sequential instead of using Promise.all
date: 2026-04-08
---

## Description

When multiple async operations don't depend on each other's results, run them in parallel with `Promise.all` instead of awaiting sequentially. Sequential awaits create request waterfalls — the total time is the sum of all operations instead of the maximum.

## Why It Matters

Sequential awaits are the #1 cause of unnecessary latency in data-fetching code. In repos where components fetch from multiple GraphQL endpoints or downstream services, this directly impacts page load time and LCP.

## Incorrect

```tsx
// BAD: Each fetch waits for the previous one to complete.
// Total time = tripDetails + activities + weather
const tripDetails = await fetchTripDetails(tripId);
const activities = await fetchActivities(tripId);
const weather = await fetchWeather(tripDetails.destination);
```

## Correct

```tsx
// GOOD: Independent fetches run in parallel.
// Total time = max(tripDetails, activities)
const [tripDetails, activities] = await Promise.all([
  fetchTripDetails(tripId),
  fetchActivities(tripId),
]);
// weather depends on tripDetails, so it runs after
const weather = await fetchWeather(tripDetails.destination);
```

## References

- [Vercel: async-parallel](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/async-parallel.md)
