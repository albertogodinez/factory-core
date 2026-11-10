---
title: A test must stay green when only the internals change
impact: MEDIUM
repos: [cross-repo]
# repos_exclude reason: none needed. Pinning tests to internals is a framework-independent failure.
repos_exclude: []
tags: [testing, mocks, refactoring]
source: pstack
applies_when: A new or changed test asserts on a private helper, an internal call or its order, intermediate data, an exact error message, or which internal collaborator did the work
principle: A test pinned to the implementation breaks on every refactor and still catches no bug.
date: 2026-10-23
---

## Description

For every new or changed test, imagine changing the internals: keep every observable result the same and restructure the code underneath. If the test now fails, it is pinned to the implementation. Flag:

- An assertion that an internal helper, hook or module function was called (`expect(formatPrice).toHaveBeenCalled()`, `verify { mapper.map(any()) }`).
- Internal call order, intermediate data, or which collaborator did the work.
- A mock of code the test could run for real. Mock only what the test cannot run locally: an external service, the network, the clock.
- An exact error message no caller reads. The error type or code callers branch on is the contract; the wording is not.

The contract decides, not the assertion's shape. The payload a mocked **external** service receives is behavior, because that service observes it. A call to an internal helper is implementation, because no user can see it.

A test can pin an invariant instead of a call: a key that must exist in two tables, a compile-time type check, a registry every variant must appear in. The invariant is the behavior. A stylesheet's text or a class name is not an invariant a user can observe: a test that reads a `.css` file or asserts only a class is pinned to the implementation.

## Why It Matters

An implementation-pinned test fails on a correct refactor, so engineers learn to update the assertion to match the code, which is the habit that lets real regressions through. It also blocks the refactor the codebase needs.

## Incorrect

```ts
it('renders the price', () => {
  render(<PriceTag amount={180} />);
  expect(formatCurrency).toHaveBeenCalledWith(180, 'USD'); // internal helper
});
```

## Correct

```ts
it('renders the price', () => {
  render(<PriceTag amount={180} />);
  expect(screen.getByText('$180')).toBeVisible();
});
```
