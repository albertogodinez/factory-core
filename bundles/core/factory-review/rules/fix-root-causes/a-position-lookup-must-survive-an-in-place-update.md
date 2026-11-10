---
title: A lookup by position must survive an in-place update
impact: HIGH
repos: [cross-repo]
# repos_exclude reason: none needed. Ordered collections whose items update in place exist in every stack.
repos_exclude: []
tags: [correctness, ordering, regression, replacement]
source: manual
applies_when: A change finds a related item by its position in a list ("the latest X before Y", "the previous entry", walking back from an index), especially when it replaces state that recorded the relationship directly (a ref, a stored id, a map)
principle: When a list keeps an item at its original position after an update, a lookup by position stops finding the relationship the moment that item is updated instead of appended.
date: 2026-10-29
---

## Description

Flag a lookup that derives a relationship from list order when the list can update an item in place. Normalized stores, upserts, and "replace by id" reducers keep an updated item at its first position, so "the latest X before Y" answers for the order items were *created*, not the order events *happened*.

Check three things:

- **What orders the list.** Read the code that builds it. If an update keeps the old index, a later event can sit before an earlier one.
- **What the replaced code handled.** When the change deletes state that recorded the relationship (a ref set at the moment of the event, a stored source id), list each case that state covered and confirm the new lookup covers it too. The in-place update is the usual one it loses.
- **The test.** There must be a test where the target item already exists and is updated in place after the related item appears, and the lookup still resolves. A test that only appends new items passes against both the right and the wrong design.

Fine without a finding: the list is append-only by construction (a log, an event stream), or the relationship is carried on the item itself (a `sourceId` field the lookup reads).

## Why It Matters

The lookup passes every test written in event order and fails in production on the first update-in-place, usually on a second or repeated user action. Because the old mechanism handled that case, the change ships as a regression that the PR's own tests can't see.

## Incorrect

```ts
// Board artifacts keep creation order; an update replaces in place.
function sourceListFor(items: Item[], target: Item) {
  const i = items.findIndex((it) => it.id === target.id);
  return items.slice(0, i).reverse().find((it) => it.kind === 'source');
}
// [hotels(v1), source] -> a pick updates hotels in place -> [hotels(v2), source]: nothing found.
```

## Correct

```ts
// Read the relationship the writer recorded, or keep the event-time state the old code had.
function sourceListFor(items: Item[], target: Item) {
  return items.find((it) => it.id === target.sourceId);
}

it('finds the source after the target is updated in place', () => {
  const items = upsert(upsert([], hotelsV1), source);
  expect(sourceListFor(upsert(items, hotelsV2(source.id)), hotelsV2(source.id))).toBe(source);
});
```
