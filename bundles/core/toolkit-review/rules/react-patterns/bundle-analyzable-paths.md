---
title: Keep import() and file-system paths statically analyzable
impact: HIGH
repos: [cross-repo]
tags: [bundle-size, code-splitting, build, performance]
source: vercel
applies_when: An import() or fs path is built from a variable, a lookup of string paths, or string concatenation
date: 2026-10-23
---

## Description

Write each `import()` and file-system path so the bundler can see it at build time. Use a map of loader functions (`() => import('./x')`) or a literal path at each call site, not `import(MAP[key])` or `'./dir/' + name`. When the bundler cannot resolve the path, it either includes every file the expression could match, warns that it cannot analyze the import, or fails at runtime.

## Why It Matters

A dynamic `import()` with a computed path defeats the code splitting it was meant to provide. Webpack turns `import('./blocks/' + name)` into a context module that bundles every file under `./blocks/`, and an `import(variable)` it cannot resolve at all becomes a runtime error. The cost shows up as larger chunks, slower builds, and slower cold starts, and nothing fails in review.

## Incorrect

```tsx
// BAD: the bundler sees import(<expression>) and cannot tell which
// modules are reachable
const PANEL_MODULES = {
  itinerary: './panels/ItineraryPanel',
  map: './panels/MapPanel',
} as const;

const Panel = lazy(() => import(PANEL_MODULES[panelName]));
```

```ts
// BAD: a two-value union still hides the final path
const dir = path.join(process.cwd(), 'fixtures/' + kind);
```

## Correct

```tsx
// GOOD: each entry is a literal import(), so each becomes its own chunk
const PANEL_MODULES = {
  itinerary: () => import('./panels/ItineraryPanel'),
  map: () => import('./panels/MapPanel'),
} as const;

const Panel = lazy(PANEL_MODULES[panelName]);
```

```ts
// GOOD: the final path is literal at the call site
const dir =
  kind === 'trips'
    ? path.join(process.cwd(), 'fixtures/trips')
    : path.join(process.cwd(), 'fixtures/flights');
```

## References

- [Vercel: bundle-analyzable-paths](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/bundle-analyzable-paths.md)
- [Webpack: dependency management](https://webpack.js.org/guides/dependency-management/)
- [Rollup: dynamic import vars](https://www.npmjs.com/package/@rollup/plugin-dynamic-import-vars)
