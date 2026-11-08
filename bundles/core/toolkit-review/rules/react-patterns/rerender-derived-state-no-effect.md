---
title: Compute derived values directly, not via useState+useEffect
impact: MEDIUM
repos: [cross-repo]
tags: [re-render, state-management, hooks]
source: vercel
applies_when: A useEffect sets state that could be computed directly from props or other state
date: 2026-04-08
---

## Description

When a value can be computed from existing props or state, calculate it during render instead of storing it in state and syncing via useEffect. The useState+useEffect pattern causes an extra render cycle and is harder to reason about.

## Why It Matters

Each unnecessary state update triggers a re-render. The useEffect pattern means: render with stale value → effect runs → setState → re-render with correct value. This doubles render work and can cause visual flicker.

## Incorrect

```tsx
// BAD: Extra render cycle — renders with stale filteredTrips, then re-renders
const [filteredTrips, setFilteredTrips] = useState<Trip[]>([]);

useEffect(() => {
  setFilteredTrips(trips.filter(t => t.status === selectedStatus));
}, [trips, selectedStatus]);
```

## Correct

```tsx
// GOOD: Computed during render — no extra cycle, always in sync
const filteredTrips = useMemo(
  () => trips.filter(t => t.status === selectedStatus),
  [trips, selectedStatus]
);
```

## References

- [Vercel: rerender-derived-state-no-effect](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rerender-derived-state-no-effect.md)
- [React docs: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
