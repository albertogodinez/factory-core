---
title: Guard only states the system may legitimately be in; trace the rest to what produced them
impact: HIGH
repos: [cross-repo]
# repos_exclude reason: none needed. The rule is language-agnostic (a swallowed exception in Kotlin, a bare `except` in Python and an `?? 0` in TypeScript are the same fault), so it holds in every review-enabled repo.
repos_exclude: []
tags: [debugging, correctness, error-handling, defensive-code]
source: pstack
applies_when: A diff adds a guard, fallback, retry, try/catch, clamp, default, or early return, especially in a change that claims to fix a bug
principle: A check where a wrong state surfaced hides the bug unless the system may legitimately be in that state; otherwise fix whatever produced it.
date: 2026-10-23
---

## Description

The symptom is where a wrong state became visible. The root cause is the first place the system did something it should not do, or failed to handle a state it should handle. For every guard the diff adds, ask one question: **may the system legitimately be in the state this guard handles?**

- **Yes** (an optional field the contract allows to be absent, a network call that can fail): the code that broke on it is the root cause, and handling the state there is the correct fix. No finding. The contract is the producer's schema or documented behavior. A type in this repo that mirrors another team's payload records what arrives, so it proves nothing about whether the producer should send it; `cross-boundary-compensation-needs-a-producer-trace` owns that case.
- **No** (a value the type says is required, a list the producer promises is non-empty, an id that must exist): the guard hides the bug. The finding is "find what produced this state", with the producer named when you can trace it.

The usual ways to hide a bug: a null check or optional chain on a value that should never be null, a `catch` that logs and continues or returns a default, a retry around a deterministic failure, a clamp (`Math.max(0, …)`, `coerceAtLeast`) on a value that should never be out of range, a `?? []` / `?: emptyList()` that turns missing data into "no results", and state discarded or reset to make an error disappear.

When the diff is a bug fix, read its intent and the base version. If the fix lands where the symptom surfaced and the PR names no producer, ask where the bad state came from.

## Why It Matters

A symptom fix hides the evidence and leaves the fault free to surface elsewhere. The guard also tells the next reader that the state is reachable, so they write tests and dependent code around a false invariant. Each one makes the system harder to reason about, because the code now carries a workaround for a bug nobody named.

## Incorrect

```ts
// The API contract says every trip has at least one segment. A crash on
// segments[0] is "fixed" where it surfaced; the empty list stays unexplained.
const first = trip.segments[0] ?? DEFAULT_SEGMENT;

try {
  await saveTrip(trip);
} catch {
  // swallowed: the save silently fails and the UI shows success
}
```

## Correct

```ts
// The mapper dropped segments with an unknown type, producing the empty list.
// Fix it there: map unknown types to an explicit "other" segment.
const first = trip.segments[0];

await saveTrip(trip); // failure propagates to the caller's error state
```
