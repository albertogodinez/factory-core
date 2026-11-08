---
title: Use dynamic imports for heavy components not needed at initial load
impact: CRITICAL
repos: [cross-repo]
tags: [bundle-size, lazy-loading, code-splitting, performance]
source: vercel
applies_when: A large component or library (editor, chart, map) is statically imported but not visible on initial render
date: 2026-04-08
---

## Description

Use `React.lazy()` with dynamic `import()` to defer loading heavy components that are not visible at initial render. Static imports bundle everything into the main chunk, increasing TTI and LCP even when the component is behind a tab, modal, or conditional.

## Why It Matters

In apps, components like map views, rich text editors, or detailed itinerary builders can add 100-300KB to the initial bundle. Lazy-loading them until the user actually navigates to that section keeps the critical path fast.

## Incorrect

```tsx
// BAD: MonacoEditor (~300KB) is in the initial bundle even when the
// editor tab is not active
import { MonacoEditor } from '@monaco-editor/react';

function TripNotesPanel({ activeTab }: { activeTab: string }) {
  if (activeTab !== 'notes') return null;
  return <MonacoEditor />;
}
```

## Correct

```tsx
// GOOD: Editor loads only when the notes tab is activated
import { lazy, Suspense } from 'react';

const MonacoEditor = lazy(() =>
  import('@monaco-editor/react').then(m => ({ default: m.MonacoEditor }))
);

function TripNotesPanel({ activeTab }: { activeTab: string }) {
  if (activeTab !== 'notes') return null;
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <MonacoEditor />
    </Suspense>
  );
}
```

## References

- [Vercel: bundle-dynamic-imports](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/bundle-dynamic-imports.md)
- [React docs: lazy](https://react.dev/reference/react/lazy)
