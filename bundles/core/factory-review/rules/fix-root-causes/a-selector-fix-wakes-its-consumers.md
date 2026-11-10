---
title: A selector fix wakes every consumer; review each one as new behaviour
impact: HIGH
repos: [cross-repo]
# repos_exclude reason: none needed. Code keyed on a DOM query that matches nothing is dormant in any web repo, whatever the stack.
repos_exclude: []
tags: [correctness, dom, selectors]
source: manual
applies_when: A diff changes a shared selector constant, class name or DOM query that matched no elements before the change
principle: Code keyed on a selector that matched nothing has never run; fixing the selector runs it, so every consumer is new behaviour to review.
date: 2026-11-02
---

## Description

When a diff repairs a selector that had stopped matching (a class renamed upstream, a constant
pointing at old markup), find every consumer of it: `querySelector`, `closest`, `matches`, CSS
rules, tests. Each one was a no-op until this diff, so its behaviour has never been seen in
production. Check what each now reaches, and flag any that acts on more than it should.

## Why It Matters

The fix is reviewed for the one feature that was reported broken. The other consumers come back to
life unreviewed, carrying whatever assumptions held when the old markup was current.

## Incorrect

```ts
// CHAT_INPUT_SELECTOR now matches the chat composer again, so this lock runs for the first time.
// The nearest .ui-layout-flex ancestor is the whole conversation column: the transcript goes inert.
const input = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
const row = input?.closest<HTMLElement>('.ui-layout-flex');
row.inert = true;
```

## Correct

```ts
const input = document.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
const row = input?.closest<HTMLElement>('form');
row.inert = true;
```

