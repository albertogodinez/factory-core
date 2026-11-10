---
title: Use functional setState to remove state from callback deps
impact: MEDIUM
repos: [cross-repo]
tags: [re-render, hooks, state-management]
source: vercel
applies_when: A callback uses current state value and is in a dependency array, causing re-subscriptions
date: 2026-04-08
---

## Description

When a callback needs the current state value, use the functional form of setState (`setState(prev => ...)`) instead of referencing the state variable directly. This removes the state from the callback's dependency array, preventing re-creation and re-subscription on every state change.

## Why It Matters

Callbacks that reference state directly must be recreated whenever state changes, causing child components to re-render and event listeners to re-subscribe.

## Incorrect

```tsx
// BAD: handleClick recreates on every count change
const [count, setCount] = useState(0);
const handleClick = useCallback(() => {
  setCount(count + 1);  // count in deps → recreates on every change
}, [count]);
```

## Correct

```tsx
// GOOD: Functional update — no dependency on count
const [count, setCount] = useState(0);
const handleClick = useCallback(() => {
  setCount(prev => prev + 1);  // no external deps needed
}, []);
```

## References

- [Vercel: rerender-functional-setstate](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rerender-functional-setstate.md)
