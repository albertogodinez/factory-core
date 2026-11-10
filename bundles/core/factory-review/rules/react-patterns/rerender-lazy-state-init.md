---
title: Pass function to useState for expensive initial values
impact: MEDIUM
repos: [cross-repo]
tags: [re-render, state-management, performance]
source: vercel
applies_when: useState initializer performs expensive computation (parsing, filtering, sorting)
date: 2026-04-08
---

## Description

When the initial state value requires computation (parsing JSON, filtering arrays, building data structures), pass a function to useState instead of the computed value. The function form runs only once; the value form runs on every render.

## Why It Matters

Without the function form, the expensive computation runs on every render even though React only uses the initial value once. This adds hidden latency to every re-render.

## Incorrect

```tsx
// BAD: JSON.parse runs on EVERY render, result is discarded after first
const [trips, setTrips] = useState(JSON.parse(localStorage.getItem('trips') || '[]'));
```

## Correct

```tsx
// GOOD: Parser runs only once during initialization
const [trips, setTrips] = useState(() => 
  JSON.parse(localStorage.getItem('trips') || '[]')
);
```

## References

- [Vercel: rerender-lazy-state-init](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rerender-lazy-state-init.md)
