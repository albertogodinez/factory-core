---
title: Assert what a render-only change shows, in every state it can show
impact: MEDIUM
repos: [cross-repo]
# repos_exclude reason: none needed. Any UI test framework can observe a rendered icon name, label or glyph once the icon module is stubbed.
repos_exclude: []
tags: [testing, assertions, rendering]
source: session
applies_when: A diff changes a value that only changes what renders (an icon or glyph name, a label, an aria name) and adds or changes tests for it
principle: A test that checks the label and the click but never the rendered value lets the value regress while the suite stays green.
date: 2026-11-04
---

## Description

Some changes only change what the user sees: the icon a button draws, the glyph it swaps to, the
label it reads. The usual tests for that component check labels, clicks and pressed state, and all of
them still pass when the rendered value is wrong.

List the states the changed value can take: each prop combination the callers pass, the default
value of every optional prop, before and after each interaction. For each state ask what the test
still passes on if the value were wrong there (swapped, reverted, or the old one). Flag every state
whose rendered value is never asserted, and name the edit that survives in `evidence`
(`icon={mapOn ? 'expand' : collapseLabel === 'Show map' ? 'map' : 'collapse'}` still passes).

The states a test skips are usually the ones reached by default: a prop left unset, the state before
the first click. A test that renders, clicks, and asserts only the result has skipped the starting
state.

When the real icon component renders nothing observable under jsdom, stub its module in the test so
the name reaches the DOM (`vi.mock('@acme/ui/icons', …)` rendering `data-icon-name`), or
assert the prop passed to the component that draws it.

## Why It Matters

The point of a render-only change is the rendered value. If no test asserts it, reverting it is a
silent regression, and a reviewer has to catch it by eye.

## Incorrect

```tsx
it('offers to expand the pane beside the map', () => {
  renderButton({ expandLabel: 'Expand details' });
  fireEvent.click(screen.getByRole('button', { name: 'Show map' }));
  expect(screen.getByRole('button', { name: 'Expand details' })).toBeVisible(); // label only, and only after the click
});
```

## Correct

```tsx
it('shows the collapse glyph while wide, under the default label', () => {
  renderButton({ expandLabel: 'Expand details' });
  expect(glyphOf('Show map')).toBe('icon-collapse'); // the starting state, default collapse label
});

it('shows the expand glyph beside the map', () => {
  renderButton({ expandLabel: 'Expand details' });
  fireEvent.click(screen.getByRole('button', { name: 'Show map' }));
  expect(glyphOf('Expand details')).toBe('icon-expand');
});
```
