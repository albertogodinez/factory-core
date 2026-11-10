---
title: Import from source modules, not barrel files
impact: CRITICAL
repos: [cross-repo]
tags: [bundle-size, tree-shaking, imports]
source: vercel
applies_when: Importing from a package index/barrel file that re-exports many modules
date: 2026-04-08
---

## Description

Import directly from the source module instead of barrel files (index.ts/index.js that re-export everything). Barrel imports pull the entire module graph into the bundle even when only one export is used, defeating tree-shaking.

## Why It Matters

In repos with large shared packages, barrel imports can add hundreds of KB to bundles. This directly impacts LCP and page load time.

## Incorrect

```tsx
// BAD: Pulls in everything exported from the package barrel
import { Card } from '@acme/ui';
import { TripCard } from '@acme/ui-components';
```

## Correct

```tsx
// GOOD: Direct imports enable tree-shaking
import { Card } from '@acme/ui/card';
import { TripCard } from '@acme/ui-components/trip-card';
```

## References

- [Vercel: bundle-barrel-imports](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/bundle-barrel-imports.md)
