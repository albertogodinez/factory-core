---
title: Apply content-visibility auto for long off-screen lists
impact: HIGH
repos: [cross-repo]
tags: [rendering, css, performance, long-lists]
source: vercel
applies_when: A component renders a long list or repeated items where most are below the viewport fold
date: 2026-04-08
---

## Description

Apply `content-visibility: auto` with `contain-intrinsic-size` on list items to tell the browser to skip layout and paint for off-screen elements. The browser only renders visible items, dramatically reducing initial render cost for long lists.

## Why It Matters

Long list pages, activity lists, and timelines can have dozens to hundreds of items. Without content-visibility, the browser lays out and paints every item on initial render even though only 5-10 are visible. For 100 items, this gives roughly 10x faster initial render.

## Incorrect

```tsx
// BAD: All 200 trip cards are laid out and painted on mount
function TripList({ trips }: { trips: Trip[] }) {
  return (
    <div className="trip-list">
      {trips.map(trip => (
        <div key={trip.id} className="trip-card">
          <TripCard trip={trip} />
        </div>
      ))}
    </div>
  );
}
```

## Correct

```tsx
// GOOD: Only visible cards are rendered; off-screen cards are skipped
function TripList({ trips }: { trips: Trip[] }) {
  return (
    <div className="trip-list">
      {trips.map(trip => (
        <div key={trip.id} className="trip-card">
          <TripCard trip={trip} />
        </div>
      ))}
    </div>
  );
}
```

```css
.trip-card {
  content-visibility: auto;
  contain-intrinsic-size: 0 120px; /* estimated height of one card */
}
```

## References

- [Vercel: rendering-content-visibility](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rendering-content-visibility.md)
- [MDN: content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility)
