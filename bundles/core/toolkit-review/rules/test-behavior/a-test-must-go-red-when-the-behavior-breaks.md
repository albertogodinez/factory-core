---
title: A test must go red when the behavior it names breaks
impact: HIGH
repos: [cross-repo]
# repos_exclude reason: none needed. The check is framework-independent: it applies to Vitest, Jest, Cypress, JUnit/Kotest and pytest alike.
repos_exclude: []
tags: [testing, assertions, contracts]
source: pstack
applies_when: A diff adds or changes a test, or changes code whose existing test should now catch a regression
principle: A test that still passes when the behavior is broken proves nothing about that behavior.
date: 2026-10-23
---

## Description

A test is a claim about what the code does for its users: a caller, an end user, or another service. Behavior is what those users observe through the interface they use: return values, errors, state they can read back, and effects outside the code (a request sent, a row written, an event emitted).

For every new or changed test, imagine breaking the behavior: make the code return a wrong value, skip the effect, or do it twice. If the test still passes, flag it. The usual causes:

- An assertion looser than the contract: `toBeTruthy()`, `isNotNull()`, `toHaveLength(greaterThan(0))`, "something rendered", when the contract promises a specific value.
- An expected value computed by the code under test, or copied from a run of it, instead of derived from the requirement.
- A restated constant, prompt string or config value that the test asserts against itself, never running the code that reads it.
- An assertion on data the test built itself (the fixture, the mock's return value).
- Only the happy path of a branch the diff added.

An absence assertion is behavior when absence is the promise ("an empty cart never charges"), but it must be paired with a case where the effect happens, so the test shows it can see it.

## Why It Matters

A test that cannot go red is green forever. It reports coverage, passes CI, and gives the next engineer false confidence to refactor code that nothing actually protects.

## Incorrect

```ts
it("applies the member discount", () => {
  const price = applyDiscount(cart, member);
  expect(price).toBe(applyDiscount(cart, member)); // expected value from the code under test
  expect(price).toBeTruthy(); // looser than the contract
});
```

## Correct

```ts
it("applies the 10% member discount", () => {
  expect(applyDiscount(cartOf(200), member)).toBe(180); // derived from the requirement
});

it("charges nothing for an empty cart, and charges a full one", async () => {
  await checkout(emptyCart);
  expect(payments.charge).not.toHaveBeenCalled();
  await checkout(cartOf(200));
  expect(payments.charge).toHaveBeenCalledWith({ amount: 200 }); // shows the test can see a charge
});
```
