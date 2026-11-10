---
title: Prefer `cond && <JSX>` for conditional render, but guard the operand against 0/NaN
impact: LOW
repos: [cross-repo]
tags: [rendering, correctness, jsx, readability]
source: vercel
applies_when: JSX conditionally renders an element — either via `cond ? <JSX> : null` or via `cond && <JSX>`
date: 2026-06-02
---

## Description

For conditional rendering of a single element, prefer the short-circuit form `{cond && <JSX>}` over the verbose `{cond ? <JSX> : null}`. The explicit `: null` branch adds no value and is the form the team has repeatedly committed and then had to clean up in review.

There is **one hard constraint**: the left operand of `&&` must be a real boolean (or `null`/`undefined`/`false`). It must **never** be a raw number or other falsy-renderable value, because `&&` returns its left operand when falsy and React renders `0` and `NaN` as visible text. Coerce numeric/length checks to a boolean first.

## Why It Matters

- **Readability / consistency:** `cond ? <JSX> : null` is noise. The `&&` form is the idiom the team standardizes on; mixing both styles makes diffs and reviews noisier.
- **Correctness:** the reason `&&` gets misused is the `0`/`NaN` leak — `{items.length && <List/>}` renders a stray `0` when the array is empty. That's a real bug we've shipped. The fix is not "go back to ternary," it's "make the operand boolean": `{items.length > 0 && <List/>}`.

So: **`&&` is the default; a boolean operand is mandatory.** Reach for a ternary only when you genuinely need a non-null else branch (`cond ? <A/> : <B/>`).

## Incorrect

```tsx
// BAD: verbose ternary with a pointless `: null` else branch
{heading ? (
  <EGDSLayoutFlexItem>
    <WelcomeHeading heading={heading} />
  </EGDSLayoutFlexItem>
) : null}

// BAD: && with a raw number — renders a stray "0" when length is 0
{trips.length && <TripList trips={trips} />}
```

## Correct

```tsx
// GOOD: && short-circuit; `heading` is string | undefined, never a number
{heading && (
  <EGDSLayoutFlexItem>
    <WelcomeHeading heading={heading} />
  </EGDSLayoutFlexItem>
)}

// GOOD: numeric check coerced to boolean before &&
{trips.length > 0 && <TripList trips={trips} />}

// GOOD: ternary is correct ONLY when there's a real else element
{isLoading ? <Skeleton /> : <Content />}
```

## References

- [Vercel: rendering-conditional-render](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/rendering-conditional-render.md)
