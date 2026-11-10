---
title: Don't use lazy() when SSR is already handled by the component
impact: MEDIUM
repos: [cross-repo]
tags: [bundle, lazy, ssr, suspense]
source: manual
applies_when: A component is wrapped in lazy() + Suspense but already handles SSR avoidance internally (e.g., skipSsr prop, ssr:false on queries)
date: 2026-04-08
---

## Description

Don't use `React.lazy()` + `<Suspense>` to avoid server-side rendering when the component already handles SSR internally. Components that pass `skipSsr`, `ssr: false`, or return `null` during SSR don't need an outer lazy boundary — the server output is identical either way.

Adding a redundant lazy boundary introduces:
- A Suspense fallback risk (`fallback={null}` with no error boundary means the component vanishes silently on chunk load failure)
- Unnecessary async chunk overhead for code that would tree-shake or no-op during SSR anyway
- A false signal to future developers that lazy loading is required here

## Why It Matters

`lazy()` is a bundle-splitting tool, not an SSR-avoidance tool. When used solely to prevent server rendering of a component that already skips SSR, it adds complexity without reducing bundle size. Worse, `<Suspense fallback={null}>` without an error boundary creates a silent failure mode — if the chunk fails to load, the entire feature disappears with no user feedback.

## Incorrect

```tsx
// BAD: lazy() used but AgentConversationController already passes skipSsr
// The component returns null during SSR regardless of lazy()
const AppUIActivityPlannerAction = lazy(() =>
  import('./app-ui-activity-planner-action').then((m) => ({ default: m.AppUIActivityPlannerAction }))
);

// In the switch case:
case 'AppUIActivityPlannerPrimer':
  return (
    <Suspense fallback={null}>
      <AppUIActivityPlannerAction data={data} />
    </Suspense>
  );
```

## Correct

```tsx
// GOOD: Direct import — skipSsr on the inner controller already handles SSR
import { AppUIActivityPlannerAction } from './app-ui-activity-planner-action';

// In the switch case:
case 'AppUIActivityPlannerPrimer':
  return (
    <AppUIActivityPlannerAction data={data} />
  );
```

## When lazy() IS appropriate

- The component is conditionally rendered behind a user interaction (e.g., modal, drawer) and its dependencies are large enough to justify a separate chunk
- The component is behind an experiment gate and most users will never load it
- Bundle analysis shows the component's dependencies create a meaningful chunk (>20KB gzipped)

## References

- React docs on lazy: https://react.dev/reference/react/lazy
