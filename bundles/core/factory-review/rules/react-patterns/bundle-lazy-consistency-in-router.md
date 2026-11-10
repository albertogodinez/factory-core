---
title: Lazy loading must be consistent within a switch/router pattern
impact: MEDIUM
repos: [cross-repo]
tags: [bundle, lazy, consistency, architecture]
source: manual
applies_when: A switch statement or router dispatches to multiple components where some branches use lazy() and others use direct imports
date: 2026-04-08
---

## Description

When a switch statement or router renders different components based on a discriminator (e.g., `__typename`, route path), all branches should use the same loading strategy. Mixing `lazy()` imports with direct imports in the same switch creates an inconsistent rendering path that is harder to reason about, test, and debug.

If one branch needs lazy loading, there should be a clear justification for why that branch is different from the others — and that justification should be documented.

## Why It Matters

- **Maintenance cost**: Developers reading the switch expect uniform behavior. A single lazy branch is a surprise that requires investigation to understand.
- **Error handling asymmetry**: Direct-imported branches fail at build time if the module is missing. Lazy branches fail at runtime with a chunk load error — caught only by Suspense/error boundaries (if present).
- **Testing gaps**: Lazy branches need async rendering tests; direct branches don't. The inconsistency means test patterns diverge within the same component.
- **Parallel rendering paths**: If a lazy branch is intercepted at a parent level (before reaching the switch), it creates a second rendering path that bypasses the switch's centralized routing logic.

## Incorrect

```tsx
// BAD: 6 direct imports, 1 lazy — inconsistent with no justification
import { AppUINoteSheet } from './app-ui-note-sheet';
import { AppUIScheduleItemSheet } from './app-ui-schedule-item-sheet';
import { AppUIBulkChangeDatesSheet } from './app-ui-bulk-change-dates-sheet';
// ... all other actions are direct imports

const AppUIActivityPlannerAction = lazy(() =>
  import('./app-ui-activity-planner-action').then((m) => ({ default: m.AppUIActivityPlannerAction }))
);

switch (data.__typename) {
  case 'AppUINoteSheet':
    return <AppUINoteSheet data={data} />;           // direct
  case 'AppUIScheduleItemSheet':
    return <AppUIScheduleItemSheet data={data} />;   // direct
  case 'AppUIActivityPlannerPrimer':
    return (
      <Suspense fallback={null}>                        // lazy — why?
        <AppUIActivityPlannerAction data={data} />
      </Suspense>
    );
}
```

## Correct

```tsx
// GOOD: All branches use the same loading strategy
import { AppUINoteSheet } from './app-ui-note-sheet';
import { AppUIScheduleItemSheet } from './app-ui-schedule-item-sheet';
import { AppUIActivityPlannerAction } from './app-ui-activity-planner-action';

switch (data.__typename) {
  case 'AppUINoteSheet':
    return <AppUINoteSheet data={data} />;
  case 'AppUIScheduleItemSheet':
    return <AppUIScheduleItemSheet data={data} />;
  case 'AppUIActivityPlannerPrimer':
    return <AppUIActivityPlannerAction data={data} />;
}
```

```tsx
// ALSO GOOD: All branches lazy-loaded with shared Suspense boundary
// (justified when the switch is behind a user interaction and all branches are heavy)
const AppUINoteSheet = lazy(() => import('./app-ui-note-sheet'));
const AppUIScheduleItemSheet = lazy(() => import('./app-ui-schedule-item-sheet'));
const AppUIActivityPlannerAction = lazy(() => import('./app-ui-activity-planner-action'));

<Suspense fallback={<SheetSkeleton />}>
  {renderSwitch(data)}
</Suspense>
```
