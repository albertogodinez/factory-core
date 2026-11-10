---
title: A UI that mirrors a scroller's geometry observes its size, not only its scroll events
impact: MEDIUM
repos: [cross-repo]
repos_exclude: []
tags: [rendering, scroll, resize-observer, correctness]
source: manual
applies_when: A component or hook reads a scroller's scrollHeight, clientHeight or scrollTop to draw something that tracks it (a custom scrollbar thumb, a scroll-progress bar, a fade at the edge) and recomputes only on `scroll` or pointer events
principle: Content can grow or the box can resize with no scroll event, so a mirror that updates only on scroll shows the geometry of the last scroll, not the current one.
date: 2026-10-29
---

## Description

Flag a mirror of a scroller's size or position that has no `ResizeObserver` (on the scroller and its content child). Streamed content, a window or panel resize, and a collapsing toolbar all change `scrollHeight` or `clientHeight` without firing `scroll`, so the thumb keeps the old height and offset until the next scroll or hover.

Observe the scroller and its first child, recompute in the callback, disconnect in the effect's cleanup, and guard `typeof ResizeObserver === 'undefined'` for jsdom.

## Why It Matters

The stale mirror only shows when something changes while the user is idle, so it passes a manual check that scrolls. In one case the chat transcript's overlay thumb synced on scroll and hover only; a reply streaming in under a still pointer left it the wrong size.

## Incorrect

```ts
panel.addEventListener('scroll', (e) => syncThumb(e.target as HTMLElement), true);
```

## Correct

```ts
const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => current && syncThumb(current));
const follow = (scroller: HTMLElement) => {
  resizeObserver?.disconnect();
  resizeObserver?.observe(scroller);
  if (scroller.firstElementChild) resizeObserver?.observe(scroller.firstElementChild);
};
panel.addEventListener('scroll', (e) => syncThumb(e.target as HTMLElement), true);
return () => resizeObserver?.disconnect();
```
