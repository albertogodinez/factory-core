---
title: Keep only comments the code cannot carry; reshape the code that needs the rest
impact: MEDIUM
repos: [cross-repo]
repos_exclude: []
tags: [comments, readability, agent-authored-code]
source: pstack
applies_when: A diff adds or edits a code comment, doc comment, banner, or commented-out code in any source or test file
principle: A comment that explains our own code is a sign the code should be reshaped until it explains itself; rationale belongs in the wiki, PR and commit, not in the source.
date: 2026-10-23
---

## Description

An added comment survives only if it is one of these **keeps**:

- A legal or license header.
- Non-obvious behavior forced by something we cannot reshape: an external dependency, platform, vendor, or protocol. One or two lines.
- A doc comment (JSDoc, KDoc, docstring) that defines a public API contract: a package export, a published endpoint, a shared-library interface.
- An issue, ticket or RFC link that explains a constraint the code cannot express.
- A formatter or lint directive (`// prettier-ignore`, `// ktlint-disable`); suppressions are judged by `suppress-only-a-faulty-lint-rule`.

Flag every other added comment, and recommend deletion, never a shorter rewording:

- **Narration**: restates what the next line does, or a doc comment on a well-named internal function.
- **Banners and section dividers.**
- **Commented-out code.** Version control holds the old version.
- **History and justification**: "replaces X", "was Y before", "we do this because…". That rationale goes in the PR body and commit message, and durable "why" goes in the repo's wiki. A generated wiki is refreshed by its tooling, never hand-edited, and never referenced by path from source.
- **Workaround sermons**: a long comment justifying a surprise in **our own** code. The surprise is the defect. Name the exact symbol to reshape (rename it, extract it, give it a type, or change the design) so the behavior is obvious without prose, and put that in the recommendation.

When you cannot tell whether a keep applies, the comment does not qualify.

## Why It Matters

A comment cannot fail, so it drifts from the code it describes and starts to mislead. Comments that explain our own surprises let the surprise stay. Agent-authored code produces narration by default, and review time spent asking for deletions is time not spent on behavior.

## Incorrect

```kotlin
// ===== Mapping =====
// Map the trip to the UI model. We filter cancelled segments here because the
// downstream sometimes returns them and the card would show them otherwise.
fun map(trip: Trip) = trip.segments.filter { it.status != CANCELLED }.map(::toUi)
// fun mapLegacy(trip: Trip) = ...
```

## Correct

```kotlin
fun mapActiveSegments(trip: Trip) = trip.segments.filter { it.isActive }.map(::toUi)
```
