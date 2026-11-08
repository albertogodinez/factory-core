---
title: Use resource hints to preload critical assets and preconnect to APIs
impact: HIGH
repos: [cross-repo]
tags: [rendering, preload, preconnect, performance, lcp]
source: vercel
applies_when: A page fetches from known external APIs or loads critical fonts/images that could be hinted earlier
date: 2026-04-08
---

## Description

Use browser resource hints (`preconnect`, `prefetchDNS`, `preload`) to start loading critical resources before they are needed. React DOM provides `preconnect()`, `prefetchDNS()`, `preload()`, and `preinit()` APIs. For non-React contexts, use `<link rel="preconnect">` and `<link rel="preload">` in HTML head.

## Why It Matters

Pages connect to multiple external domains (GraphQL APIs, image CDNs, analytics endpoints). Without preconnect, each new domain requires DNS lookup + TCP + TLS handshake before the first byte. Preconnecting saves 100-300ms per domain on the critical path, directly improving LCP.

## Incorrect

```tsx
// BAD: Browser discovers API domain only when fetch executes
function TripOverview({ tripId }: { tripId: string }) {
  const { data } = useQuery(TRIP_QUERY, { variables: { tripId } });
  return <TripDetails trip={data?.trip} />;
}
```

## Correct

```tsx
// GOOD: Browser connects to API domain immediately on page load
import { preconnect, prefetchDNS } from 'react-dom';

function App() {
  prefetchDNS('https://analytics.example.com');
  preconnect('https://api.example.com');
  preconnect('https://images.trvl-media.com');

  return <main>{/* routes */}</main>;
}
```

```html
<!-- Alternative: HTML link tags in document head -->
<link rel="preconnect" href="https://api.example.com" />
<link rel="dns-prefetch" href="https://analytics.example.com" />
<link rel="preload" href="/fonts/Inter.woff2" as="font" type="font/woff2" crossorigin />
```

## References

- [Vercel: rendering-resource-hints](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rendering-resource-hints.md)
- [React DOM Resource Preloading APIs](https://react.dev/reference/react-dom#resource-preloading-apis)
