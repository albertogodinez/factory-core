---
title: Batch DOM writes to avoid layout thrashing
impact: MEDIUM
repos: [cross-repo]
tags: [rendering, dom, performance]
source: vercel
applies_when: Code interleaves DOM reads (getBoundingClientRect, offsetHeight) and writes (style mutations)
date: 2026-04-08
---

## Description

Batch all DOM reads together, then all DOM writes together. Interleaving reads and writes forces the browser to recalculate layout between each pair (layout thrashing), which is extremely expensive.

## Why It Matters

Layout thrashing can turn a 1ms operation into a 100ms+ operation. In components with map views, scroll-linked animations, or dynamic layouts, this causes visible jank.

## Incorrect

```tsx
// BAD: Each iteration forces a layout recalculation
elements.forEach(el => {
  const height = el.offsetHeight;       // READ → forces layout
  el.style.height = `${height * 2}px`;  // WRITE → invalidates layout
});
```

## Correct

```tsx
// GOOD: All reads first, then all writes
const heights = elements.map(el => el.offsetHeight);  // all READs
elements.forEach((el, i) => {
  el.style.height = `${heights[i] * 2}px`;            // all WRITEs
});
```

## References

- [Vercel: js-batch-dom-css](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/js-batch-dom-css.md)
