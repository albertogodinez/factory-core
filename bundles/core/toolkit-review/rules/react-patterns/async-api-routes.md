---
title: Prevent waterfall chains in API routes and handlers
impact: CRITICAL
repos: [cross-repo]
tags: [async, waterfall, api-routes, performance]
source: vercel
applies_when: An API route or server handler awaits multiple independent operations sequentially
date: 2026-04-08
---

## Description

In API route handlers and server-side functions, start independent async operations immediately rather than awaiting them sequentially. Kick off all independent promises first, then await them together. This eliminates waterfall chains where later operations wait unnecessarily for earlier ones.

## Why It Matters

API handlers (especially GraphQL resolvers) commonly fetch from multiple downstream services. Sequential awaits mean total latency is the sum of all calls instead of the maximum. For a resolver calling 3 services at 200ms each, this is 600ms vs 200ms.

## Incorrect

```tsx
// BAD: config waits for auth, data waits for both
export async function handler(request: Request) {
  const session = await auth();
  const config = await fetchConfig();
  const data = await fetchTripData(session.user.id);
  return { data, config };
}
```

## Correct

```tsx
// GOOD: auth and config start immediately, data waits only for auth
export async function handler(request: Request) {
  const sessionPromise = auth();
  const configPromise = fetchConfig();
  const session = await sessionPromise;
  const [config, data] = await Promise.all([
    configPromise,
    fetchTripData(session.user.id),
  ]);
  return { data, config };
}
```

## References

- [Vercel: async-api-routes](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/async-api-routes.md)
