---
title: Extract default values to constants for memo stability
impact: MEDIUM
repos: [cross-repo]
tags: [re-render, memo, performance]
source: vercel
applies_when: A component wrapped in React.memo receives inline default values as props
date: 2026-04-08
---

## Description

When using `React.memo`, extract default prop values (empty arrays, objects, callbacks) to module-level constants. Inline defaults create new references on every render, defeating memo's shallow comparison.

## Why It Matters

`React.memo` compares props by reference. An inline `[]` or `{}` is a new object every render, so memo never skips. This is especially costly for list item components that render dozens of times.

## Incorrect

```tsx
// BAD: memo is useless — new array/object created every render
const TripCard = memo(function TripCard({ 
  tags = [],           // new array every render
  config = {},         // new object every render
  onSelect = () => {}, // new function every render
}: Props) {
  return <Card>...</Card>;
});
```

## Correct

```tsx
// GOOD: Stable references — memo works as expected
const DEFAULT_TAGS: string[] = [];
const DEFAULT_CONFIG: Config = {};
const NOOP = () => {};

const TripCard = memo(function TripCard({ 
  tags = DEFAULT_TAGS,
  config = DEFAULT_CONFIG,
  onSelect = NOOP,
}: Props) {
  return <Card>...</Card>;
});
```

## References

- [Vercel: rerender-memo-with-default-value](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rerender-memo-with-default-value.md)
