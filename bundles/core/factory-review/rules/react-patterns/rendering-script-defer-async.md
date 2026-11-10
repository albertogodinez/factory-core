---
title: Use defer or async on script tags to avoid render-blocking
impact: HIGH
repos: [cross-repo]
tags: [rendering, scripts, performance, fcp]
source: vercel
applies_when: A script tag is added to the document without defer or async attributes
date: 2026-04-08
---

## Description

Script tags without `defer` or `async` block HTML parsing while the script downloads and executes, delaying First Contentful Paint and Time to Interactive. Use `defer` for scripts that depend on DOM or execution order, and `async` for independent scripts like analytics.

## Why It Matters

Pages include third-party scripts (analytics, A/B testing, error tracking). Each render-blocking script delays the entire page. A single 200ms blocking script on the critical path delays FCP by 200ms for every page view.

## Incorrect

```tsx
// BAD: Both scripts block HTML parsing during download and execution
<head>
  <script src="https://example.com/analytics.js" />
  <script src="/scripts/utils.js" />
</head>
```

## Correct

```tsx
// GOOD: Scripts download in parallel with parsing
<head>
  {/* Independent analytics — use async */}
  <script src="https://example.com/analytics.js" async />
  {/* DOM-dependent utility — use defer (maintains execution order) */}
  <script src="/scripts/utils.js" defer />
</head>
```

## References

- [Vercel: rendering-script-defer-async](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rendering-script-defer-async.md)
- [MDN: Script element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script#defer)
