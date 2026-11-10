---
title: Use useRef for frequently-changing values that do not need re-render
impact: MEDIUM
repos: [cross-repo]
tags: [re-render, refs, performance]
source: vercel
applies_when: useState is used for values that change often but do not affect the rendered output (timers, scroll position, animation state)
date: 2026-04-08
---

## Description

Use `useRef` instead of `useState` for values that change frequently but don't need to trigger a re-render. Common examples: scroll position, timer IDs, previous values for comparison, animation frame IDs.

## Why It Matters

Each useState update triggers a re-render. For values that change 60+ times per second (scroll, animation) or are only used for cleanup (timer IDs), this creates massive unnecessary render work.

## Incorrect

```tsx
// BAD: 60 re-renders per second from scroll tracking
const [scrollY, setScrollY] = useState(0);

useEffect(() => {
  const handler = () => setScrollY(window.scrollY);
  window.addEventListener('scroll', handler);
  return () => window.removeEventListener('scroll', handler);
}, []);
```

## Correct

```tsx
// GOOD: No re-renders — ref updates are silent
const scrollY = useRef(0);

useEffect(() => {
  const handler = () => { scrollY.current = window.scrollY; };
  window.addEventListener('scroll', handler, { passive: true });
  return () => window.removeEventListener('scroll', handler);
}, []);
```

## References

- [Vercel: rerender-use-ref-transient-values](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rerender-use-ref-transient-values.md)
