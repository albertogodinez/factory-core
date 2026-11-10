---
title: Don't use useEffect to fetch, to reset on a prop change, or to wait for a precondition
impact: MEDIUM
repos: [cross-repo]
# repos_exclude: none. The three patterns hold in any React repo.
repos_exclude: []
tags: [re-render, hooks, useEffect, data-fetching]
source: manual
applies_when: A new or changed useEffect fetches data and stores it in state, resets local state when an id or prop changes, or guards its body on a loading or readiness flag
principle: An effect is for synchronizing with an external system; fetching, resetting and waiting each have a construct that does the job without an extra render or a race.
date: 2026-10-07
---

## Description

Three `useEffect` shapes have a better construct. Flag a new or changed effect that matches one:

1. **Fetch, then `setState`.** `useEffect(() => { fetchX(id).then(setX) }, [id])` races when `id` changes before the first request resolves, re-implements caching, and renders once with stale data. Use the repo's data layer: the GraphQL client's `useQuery` / `useLazyQuery`, or the repo's existing fetch hook.
2. **Reset local state when an id or prop changes.** An effect that clears or reloads state because `videoId` changed emulates a remount by hand and renders once with the old state. Give the component `key={videoId}` from its parent so React remounts it.
3. **Guard on a precondition.** `useEffect(() => { if (!isLoading) play() }, [isLoading])` re-checks on every change and re-runs if the flag flips back. Render the component only once the precondition holds, and run its setup on mount.

Two other `useEffect` shapes have their own rules: state derived from props or state (`rerender-derived-state-no-effect`) and work triggered by a user action (`rerender-move-effect-to-event`). If the repo has its own mount-only effect helper, point to it; do not ask for a helper the repo lacks.

Not a finding: an effect that subscribes to a browser API, a DOM node or a third-party widget and cleans up on unmount. That is what effects are for.

## Why It Matters

Each shape adds a render with stale or empty state, and the fetch shape adds a race the user can see, where an older response overwrites a newer one. Reviewers on these repos keep asking "do we really need this useEffect?" and "could this have been handled without useEffect?". This rule gives the answer for the three shapes no other rule covers.

## Incorrect

```tsx
function ProductPage({ productId }: Props) {
  const [product, setProduct] = useState<Product | null>(null);
  useEffect(() => {
    fetchProduct(productId).then(setProduct);
  }, [productId]);
}

function VideoPlayer({ videoId }: Props) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    setProgress(0);
    loadVideo(videoId);
  }, [videoId]);
}

function VideoPlayer({ isLoading }: Props) {
  useEffect(() => {
    if (!isLoading) playVideo();
  }, [isLoading]);
}
```

## Correct

```tsx
function ProductPage({ productId }: Props) {
  const { data } = useQuery(PRODUCT_QUERY, { variables: { productId } });
}

function VideoPlayerHost({ videoId }: Props) {
  return <VideoPlayer key={videoId} videoId={videoId} />;
}

function VideoPlayerGate({ isLoading }: Props) {
  if (isLoading) return <LoadingScreen />;
  return <VideoPlayer />;
}
```

## References

- [React: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
- [React: Resetting all state when a prop changes](https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes)
