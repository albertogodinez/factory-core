---
title: Keep render pure; do writes to module-level or shared mutable state in an effect
impact: HIGH
repos: [cross-repo]
repos_exclude: []
tags: [rendering, purity, module-state, correctness]
source: manual
applies_when: A component body, a hook's render path, or a helper called during render (a predicate, selector or useMemo callback) writes to a module-level variable, Set, Map or cache, or to any mutable object shared outside the component
principle: Render runs zero, one or many times, in whatever components happen to mount, so a write during render makes the result depend on which component rendered and when.
date: 2026-10-26
---

## Description

Flag a new or changed write to shared mutable state on the render path: `someSet.add(...)`, `cache[key] = ...` or `moduleFlag = true` inside a component body, a hook body outside an effect, a `useMemo` callback, or a plain function the component calls while rendering. That covers a predicate that "marks" something as a side effect of answering a question.

Make the read pure, and move the write to where it runs exactly when the condition holds:
- a `useEffect` in a component that is always mounted while the condition can change, often a small null-rendering component mounted once near the root;
- the store or reducer that owns the state;
- the event handler that causes the change.

## Why It Matters

React may render a component without committing it (Strict Mode, concurrent rendering, a suspended tree), render it more than once, or not render it at all while it's off screen. A write during render then fires at the wrong times, or only when some unrelated component happens to mount. The bug reproduces in one screen and not another, and a test that renders the one component that does the write passes.

A draft marked a hotel list "settled" by adding it to a module-level `Set` inside the loading predicate. A list was marked only if some pane rendered it while no run was active, so the pins and Compare button (other callers of the same predicate) could stay stuck. The fix makes the predicate a pure read and moves the write into a null-rendering `HotelResultsSettler` mounted once in the shell.

## Incorrect

```tsx
const settled = new Set<string>();

// BAD: answering "is it loading?" also records state, and only when this runs during a render
export function isResultsLoading(list: ResultList, runActive: boolean): boolean {
  if (!runActive) settled.add(list.version);
  return !settled.has(list.version) && isUnpriced(list);
}
```

## Correct

```tsx
const settled = new Set<string>();

// GOOD: a pure read
export function isResultsLoading(list: ResultList, runActive: boolean): boolean {
  return runActive && !settled.has(list.version) && isUnpriced(list);
}

// The write happens in one always-mounted place, after commit
export const ResultsSettler: React.FC = () => {
  const lists = useResultLists();
  const runActive = useRunActive();
  useEffect(() => {
    if (!runActive) lists.forEach((list) => settled.add(list.version));
  }, [lists, runActive]);
  return null;
};
```

Prefer state the framework tracks (a store or context value) over a module `Set` when components must re-render on the change; the effect pattern above is for a cache that's only read on the next render.

## References

- [React: Keeping Components Pure](https://react.dev/learn/keeping-components-pure)
