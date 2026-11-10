---
title: Encode a constraint comment as a test before deleting it
impact: HIGH
repos: [cross-repo]
# repos_exclude reason: none needed. A "do not remove" comment guards an invariant in any language, and a stricter narration rule elsewhere does not cover the encode-first step.
repos_exclude: []
tags: [comments, testing, invariants]
source: pstack
applies_when: A diff adds a constraint comment ("do not remove", "IMPORTANT", "must stay", "do not change wording", "talk to X before changing"), or deletes one
principle: Rationale belongs in the wiki and invariants belong in tests; a comment that guards an invariant protects nothing until a test fails when the invariant breaks.
date: 2026-10-23
---

## Description

Constraint comments (`IMPORTANT`, `do not remove`, `must stay this way`, `too risky to change`, `talk to X first`) are a claim, not proof. For each one the diff **adds**, read the nearby code and the history (`git -C <repo> log -L<line>,<line>:<path> <head>`) to decide what it claims:

- **About something we cannot change** (a vendor quirk, a platform bug, a protocol requirement): a short keep. No finding, unless it runs long.
- **About our own code**: flag it. The recommendation is the cheapest encoding of the invariant: a unit test that goes red when the guarded line changes, a type that makes the bad edit uncompilable, a lint rule, or a CI check. Then delete the comment. Rationale moves to the PR body, commit, and wiki.

For each one the diff **deletes**, grep the tests at the head SHA for the invariant it guarded. If nothing enforces it, the comment was the only guard: flag the deletion and recommend writing the test first. A reviewer cannot run the suite, so when the grep is inconclusive use `mode: "question"` ("what fails if `X` is reordered?").

## Why It Matters

A comment cannot fail. The next engineer, or the next coding agent, deletes it during a cleanup and the invariant breaks silently. A test fails at the moment someone makes the edit the comment warned against, which is the only point where the warning is useful.

## Incorrect

```ts
// IMPORTANT: do not reorder. The analytics event must fire before navigation
// or the click is lost.
trackClick(event);
navigate(url);
```

## Correct

```ts
trackClick(event);
navigate(url);
```

```ts
it("sends the click event before navigating", async () => {
  await user.click(screen.getByRole("link", { name: "View trip" }));
  expect(order(analytics.send, router.push)).toEqual(["send", "push"]);
});
```
