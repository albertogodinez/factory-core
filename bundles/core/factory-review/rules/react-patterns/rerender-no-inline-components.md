---
title: Never define components inside other components
impact: HIGH
repos: [cross-repo]
tags: [performance, re-render, component-structure]
source: vercel
applies_when: A function component or class component is defined inside the body of another component
date: 2026-04-08
---

## Description

Never define React components (function or class) inside the render body of another component. Each re-render of the parent creates a new component reference, causing React to unmount and remount the inner component on every render. This destroys state, kills performance, and breaks refs.

## Why It Matters

- **State loss**: The inner component's state resets on every parent render because React sees a new component type each time
- **DOM thrashing**: Full unmount/remount instead of a reconciliation diff — expensive for components with complex DOM trees
- **Ref breakage**: Refs to the inner component become stale after each remount
- **Hidden bugs**: The component appears to "work" but loses input focus, scroll position, animation state, and any local state on each parent update

## Incorrect

```tsx
// BAD: InlineCard is redefined on every render of TripList.
// Each render creates a new component reference, causing React
// to unmount and remount InlineCard (losing all its state).
function TripList({ trips }: { trips: Trip[] }) {
  const [sortOrder, setSortOrder] = useState('date');

  // This component is recreated on every render
  function TripCard({ trip }: { trip: Trip }) {
    const [expanded, setExpanded] = useState(false);
    return (
      <Card>
        <h3>{trip.title}</h3>
        {expanded && <TripDetails trip={trip} />}
        <button onClick={() => setExpanded(!expanded)}>Toggle</button>
      </Card>
    );
  }

  return trips.map(trip => <TripCard key={trip.id} trip={trip} />);
}
```

## Correct

```tsx
// GOOD: TripCard is defined at module scope — stable reference,
// React can reconcile efficiently without remounting.
function TripCard({ trip }: { trip: Trip }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card>
      <h3>{trip.title}</h3>
      {expanded && <TripDetails trip={trip} />}
      <button onClick={() => setExpanded(!expanded)}>Toggle</button>
    </Card>
  );
}

function TripList({ trips }: { trips: Trip[] }) {
  const [sortOrder, setSortOrder] = useState('date');
  return trips.map(trip => <TripCard key={trip.id} trip={trip} />);
}
```

## References

- [Vercel React Best Practices: rerender-no-inline-components](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rerender-no-inline-components.md)
- [React docs: Extracting Components](https://react.dev/learn/your-first-component#extracting-a-component)
