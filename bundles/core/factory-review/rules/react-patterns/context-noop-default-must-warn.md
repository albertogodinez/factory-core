---
title: A context whose default holds no-op actions warns when it is used outside its provider
impact: MEDIUM
repos: [cross-repo]
repos_exclude: []
tags: [context, provider, correctness, silent-failure]
source: manual
applies_when: The diff adds a createContext whose default value holds no-op functions, or calls a context's actions from a component that may render outside that context's provider
principle: A provider-less context that falls back to no-op functions turns a wiring mistake into a button that silently does nothing, so the miss should be loud.
date: 2026-11-06
---

## Description

`createContext({ open: () => {} })` gives every consumer outside the provider a working-looking
action that does nothing. A component mounted in a different branch of the tree (a debug sheet, a
portal, a dialog rendered beside the shell) calls it, nothing happens, and no error or warning
says why. Flag two things:

- A new context whose default holds no-op functions, with no hook that throws or warns when the
  provider is missing.
- A new call to a context's action from a component whose mount point the diff doesn't show to be
  inside that provider. Ask for the mount point (the file that renders it) before accepting it.

Competing concern: a context can be provider-optional by design (a no-op is the right behavior in
isolated stories or tests). Then the default should say so in its name or a type, and the diff
should not rely on the action doing something from that branch of the tree.

## Why It Matters

The failure shows up only by clicking the control and noticing nothing happened. Unit tests that
render the component inside a test provider pass, so the bug ships unless a test clicks the real
control through the real tree.

## Incorrect

```tsx
const NavActionsContext = createContext<NavActions>({ openSurface: () => {} });
export const useNavActions = () => useContext(NavActionsContext);

// Rendered outside <NavActionsProvider>: the click is a silent no-op.
const DebugPanel = () => {
  const { openSurface } = useNavActions();
  return <button onClick={() => openSurface('board')}>Open board</button>;
};
```

## Correct

```tsx
const NavActionsContext = createContext<NavActions | null>(null);
export function useNavActions(): NavActions {
  const actions = useContext(NavActionsContext);
  if (!actions) throw new Error('useNavActions must be used within NavActionsProvider');
  return actions;
}

// Or, when the caller genuinely lives outside the provider, bridge to a component inside it
// (an event or a request the inside component handles) and test the real click end to end.
```

## References

- React docs: `createContext` default value is used only when no provider is above the consumer.
