---
title: Dynamically import conditionally-used features
impact: HIGH
repos: [cross-repo]
tags: [bundle-size, code-splitting, lazy-loading]
source: vercel
applies_when: A heavy module is statically imported but only used behind a feature flag or condition
date: 2026-04-08
---

## Description

Use dynamic `import()` for modules that are only used when a condition is true (feature flag, user action, experiment bucket). Static imports include the module in the initial bundle even when the feature is disabled.

## Why It Matters

In apps with experiment-gated features, static imports of gated code inflate the bundle for all users, not just those in the experiment.

## Incorrect

```tsx
// BAD: MapView is always in the bundle even when the experiment is off
import { MapView } from '@acme/planner-map';

function TripPlanner({ isMapEnabled }: Props) {
  if (!isMapEnabled) return <ListView />;
  return <MapView />;
}
```

## Correct

```tsx
// GOOD: MapView only loads when the experiment is on
import { lazy, Suspense } from 'react';

const MapView = lazy(() => import('@acme/planner-map').then(m => ({ default: m.MapView })));

function TripPlanner({ isMapEnabled }: Props) {
  if (!isMapEnabled) return <ListView />;
  return (
    <Suspense fallback={<MapSkeleton />}>
      <MapView />
    </Suspense>
  );
}
```

## References

- [Vercel: bundle-conditional](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/bundle-conditional.md)
