---
title: Put interaction logic in event handlers, not effects
impact: MEDIUM
repos: [cross-repo]
tags: [re-render, hooks, effects]
source: vercel
applies_when: A useEffect runs logic that is triggered by a specific user action rather than a state/prop change
date: 2026-04-08
---

## Description

Logic that runs in response to a user action (click, submit, selection) belongs in the event handler, not in a useEffect watching the state the action changed. Effects are for synchronization with external systems, not for responding to events.

## Why It Matters

Effect-based event handling creates timing issues (runs after render, not during the event), makes the causal chain harder to follow, and can trigger unnecessary re-renders via intermediate state.

## Incorrect

```tsx
// BAD: Effect watches state that was just set by a click handler
const [selectedTrip, setSelectedTrip] = useState<string | null>(null);

useEffect(() => {
  if (selectedTrip) {
    analytics.track('trip_selected', { tripId: selectedTrip });
    router.push(`/trips/${selectedTrip}`);
  }
}, [selectedTrip]);

const handleSelect = (tripId: string) => {
  setSelectedTrip(tripId);  // triggers effect above
};
```

## Correct

```tsx
// GOOD: Logic runs directly in the event handler
const handleSelect = (tripId: string) => {
  analytics.track('trip_selected', { tripId });
  router.push(`/trips/${tripId}`);
};
```

## References

- [Vercel: rerender-move-effect-to-event](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rerender-move-effect-to-event.md)
- [React docs: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
