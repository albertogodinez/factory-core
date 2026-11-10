---
title: A global or page-scoped style rule needs a sweep for surfaces mounted outside its scope
impact: HIGH
repos: [cross-repo]
repos_exclude: []
tags: [css, scope, portals, completeness]
source: manual
applies_when: A change adds or edits a CSS rule scoped to a page root (`.page-root *`) to restyle every instance of something (scrollbars, focus rings, fonts), and the app renders sheets, dialogs, lightboxes or other portals outside that root
principle: A rule meant for every instance of a thing fixes only the instances inside its selector, so find the ones outside before calling it done.
date: 2026-10-29
---

## Description

When a rule is scoped to a root so it can "match the prototype everywhere", grep for what mounts outside that root: `createPortal`, `document.body` appends, sheets or dialogs rendered as siblings of the page root, and class names on host elements the portals add. Add each scroll or text surface found to the selector, or list it in the PR as not covered. Then measure one real instance of each, or at minimum a stand-in element carrying its class, and say which in the PR.

## Why It Matters

The surface outside the root keeps the old look, which fails an "every X" acceptance criterion and is rarely noticed in the page you were testing. In one change the plan said to check overlays rendered outside the root, the first draft scoped the rule to the page root alone, and review found the fare flow sheet (a sibling of the shell) and the destination gallery (portaled to `<body>`) still on default scrollbars.

## Incorrect

```css
:where(.page-root, .page-root *) { scrollbar-width: thin; }
```

## Correct

```css
:where(.page-root, .page-root *, .fare-flow-sheet, .fare-flow-sheet *, .gallery-host, .gallery-host *) { scrollbar-width: thin; }
```
