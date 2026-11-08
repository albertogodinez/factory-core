---
title: Use Suspense boundaries to avoid blocking the full page on data fetches
impact: HIGH
repos: [cross-repo]
tags: [async, suspense, streaming, rendering]
source: vercel
applies_when: A slow data fetch blocks the entire page layout from rendering
date: 2026-04-08
---

## Description

Instead of awaiting all data before returning JSX, wrap slow-loading sections in `<Suspense>` boundaries with fallback skeletons. The static shell (header, sidebar, footer) renders immediately while only the data-dependent section waits.

## Why It Matters

In trip overview pages, the header chrome and navigation can render instantly while trip details or activity lists load. Without Suspense boundaries, the entire page is blank until the slowest query resolves, directly hurting FCP and LCP.

## Incorrect

```tsx
// BAD: Entire page blocks until data loads
async function TripOverviewPage({ tripId }: { tripId: string }) {
  const tripData = await fetchTripData(tripId); // Blocks everything
  return (
    <PageShell>
      <TripHeader trip={tripData} />
      <TripActivities activities={tripData.activities} />
      <TripFooter />
    </PageShell>
  );
}
```

## Correct

```tsx
// GOOD: Shell renders immediately, data sections stream in
function TripOverviewPage({ tripId }: { tripId: string }) {
  return (
    <PageShell>
      <Suspense fallback={<TripHeaderSkeleton />}>
        <TripHeader tripId={tripId} />
      </Suspense>
      <Suspense fallback={<ActivitiesSkeleton />}>
        <TripActivities tripId={tripId} />
      </Suspense>
      <TripFooter />
    </PageShell>
  );
}
```

## References

- [Vercel: async-suspense-boundaries](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/async-suspense-boundaries.md)
- [React docs: Suspense](https://react.dev/reference/react/Suspense)
