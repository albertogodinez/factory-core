---
title: Say why a value is missing instead of threading optionals through signatures
impact: MEDIUM
repos: [cross-repo]
repos_exclude: []
tags: [type-safety, typescript, optional-chaining, discriminated-unions, nullability, readability]
source: manual
applies_when: A diff adds or changes a function, hook, service or prop signature whose parameter or return type is `T | undefined`, `T | null`, or both, or a function body that chains `?.` on the same value three or more times
principle: Keep optionality at the boundary where data can really be missing; past it, a signature states either a required value or a named reason for its absence.
date: 2026-11-06
---

## Description

Every `| undefined` in a signature is a check its callers have to repeat. Data from the network, the agent, or GraphQL is optional because the wire format allows absence, and that is where the optional type belongs. Flag the diff when that optionality travels inward through signatures we own. There are four shapes:

1. **Tri-state parameter.** One parameter where `undefined`, `null` and a value mean three different things (`name?: string | null`, where `undefined` means "skip" and `null` means "use the fallback"). The type cannot tell a caller which one it wants. Ask for separate fields: `{ geocode: boolean; outlineName?: string }`.
2. **Reasonless nullable return.** A function returns `T | undefined` while it knows *why* it failed (no results, a rejected request, a dependency not loaded), and a caller branches or logs on that cause. Ask for a discriminated result: `{ found: true; center } | { found: false; reason: 'no-results' | 'error'; code?: string }`. One `if (result.found)` narrows it, and the service needs no logging callback, so there is no `onMiss?.()` either.
3. **Optional parameter every caller passes.** `lookup?: Lookup` where each call site supplies it. Make it required, and the `lookup?.` reads inside the function become `lookup.`.
4. **Optional-chain thicket.** Three or more `?.` on one value, or the same `entry?.` repeated across a function. Ask for an early return (`if (!entry) return …`) or destructuring defaults (`const { outline = {}, criteria = [] } = model`) inside a small named helper, so the code after it reads plain property access.

Leave alone:

- Types that mirror a wire format (agent data models, GraphQL fragments, API responses). Flag the first function that passes their optional fields onward unchanged, not the model type itself.
- A `T | undefined` return whose only cause is "not found" and whose callers treat it that way (`array.find`, a `Map.get` wrapper).
- One guard such as `window.google?.maps?.Geocoder` that checks whether a dependency has loaded, when it returns a named outcome rather than spreading through the module.

## Why It Matters

- **Brittle callers.** A `T | undefined` return makes every caller handle the value *and* `undefined`, and none of them learns why it is missing. The cause is lost, so logging and fallbacks have to guess.
- **Hidden meanings.** A tri-state parameter puts the meaning in a convention ("pass `undefined`, not `null`") that the type checker cannot enforce. Mixing up `null` and `undefined` compiles and silently changes behaviour.
- **Reader tax.** Each `?.` asks the reader whether absence is really possible at that point. Nested chains multiply the question, and TypeScript's narrowing does not carry across them.

## Incorrect

```ts
// Tri-state: undefined = don't geocode, null = geocode the trip list's name, string = geocode this name
export function useTripDestinationCenter(conversationId: string | null, destinationName?: string | null) {
  const lookupName =
    listed || !conversationId || destinationName === undefined ? undefined : (entry?.tripDestination ?? destinationName ?? undefined);
}

// Reasonless return: the service knows why it failed, the caller only sees undefined
async function requestCenter(name: string): Promise<DestinationCenter | undefined> {
  const location = results[0]?.geometry.location;
  return location ? { lat: location.lat(), lng: location.lng() } : undefined;
}

// Thicket
const outlinePlace = tripOutline?.outline?.destinations?.[0] ?? tripOutline?.criteria?.find((c) => c.icon === 'place')?.label;
```

## Correct

```ts
export interface DestinationLookup {
  geocode: boolean;
  outlineName?: string;
}

function nameToGeocode(entry: TripSelectorEntry | undefined, lookup: DestinationLookup): string | undefined {
  if (!lookup.geocode) return undefined;
  if (!entry) return lookup.outlineName;
  if (entry.tripDestinationCoordinate) return undefined;
  return entry.tripDestination ?? lookup.outlineName;
}

export type GeocodeResult = { found: true; center: DestinationCenter } | { found: false; reason: 'no-geocoder' | 'no-results' | 'error'; code?: string };

async function requestCenter(name: string): Promise<GeocodeResult> {
  const [first] = results;
  if (!first) return { found: false, reason: 'no-results' };
  const { location } = first.geometry;
  return { found: true, center: { lat: location.lat(), lng: location.lng() } };
}

function outlineDestination(model: TripOutlineModel | undefined): string | undefined {
  if (!model) return undefined;
  const { outline = {}, criteria = [] } = model;
  const [first] = outline.destinations ?? [];
  if (first) return first;
  const place = criteria.find((criterion) => criterion.icon === 'place');
  return place ? place.label : undefined;
}
```

## References

- Yaron Minsky, "Make illegal states unrepresentable".
- Alexis King, "Parse, don't validate".
