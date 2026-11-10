---
title: Defer non-critical work with requestIdleCallback
impact: MEDIUM
repos: [cross-repo]
tags: [javascript, performance, scheduling, analytics]
source: vercel
applies_when: Non-critical work like analytics or localStorage writes runs synchronously in event handlers
date: 2026-04-08
---

## Description

Use `requestIdleCallback()` to schedule non-critical work (analytics, telemetry, cache writes) during browser idle periods. This keeps the main thread free for user interactions and animations, reducing jank and improving INP.

## Why It Matters

Pages fire analytics events and save state on many user interactions. Running these synchronously in event handlers competes with rendering for main thread time, causing input delay. Deferring to idle periods keeps the UI responsive.

## Incorrect

```tsx
// BAD: Analytics and storage block the main thread during user interaction
function handleTripSearch(query: string) {
  const results = searchTrips(query);
  setResults(results);
  analytics.track('trip_search', { query });
  saveToRecentSearches(query);
  prefetchTopResults(results.slice(0, 3));
}
```

## Correct

```tsx
// GOOD: Critical update is immediate, rest deferred to idle time
function handleTripSearch(query: string) {
  const results = searchTrips(query);
  setResults(results);

  requestIdleCallback(() => {
    analytics.track('trip_search', { query });
  });
  requestIdleCallback(() => {
    saveToRecentSearches(query);
  });
  requestIdleCallback(() => {
    prefetchTopResults(results.slice(0, 3));
  });
}

// With timeout for analytics that must fire within 2 seconds
requestIdleCallback(
  () => analytics.track('page_view', { path: location.pathname }),
  { timeout: 2000 }
);
```

## References

- [Vercel: js-request-idle-callback](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/js-request-idle-callback.md)
- [MDN: requestIdleCallback](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback)
