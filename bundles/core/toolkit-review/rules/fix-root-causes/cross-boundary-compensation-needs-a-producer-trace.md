---
title: Trace a value another service returns empty before compensating for it on the client
impact: HIGH
repos: [cross-repo]
# repos_exclude reason: none needed. A client workaround for a producer's empty value is language- and stack-independent.
repos_exclude: []
tags: [debugging, correctness, upstream, workaround, api-contract]
source: manual
applies_when: A diff derives, falls back, or re-fetches a value that an API response field carries empty or null, or adds a module that calls a third-party SDK to supply it
principle: A client that rebuilds a value its producer should have sent fixes one consumer and leaves the producer's other consumers broken, so name the producer and its peers before accepting the workaround.
date: 2026-11-05
---

## Description

Three diff shapes signal compensation for another team's data:

- A fallback or derivation over an API response field (`coordinate ?? lookup(name)`, `items ?? refetch()`).
- A new module that calls a third-party SDK or external fetch to supply a value the payload should hold (`window.google` geocoding, a second request for data the first omits).
- A platform-shaped capability the diff adds to one app (geocoding, map framing, date resolution) that sibling apps consuming the same payload never needed.

For each, find the **producer** (the service that sets the field, and why it is empty) and **peers** (how a sibling consumer of the same payload gets the value). Read the PR body and plan for a provenance trace first. Without one, search the neighbor repos (and the organization's code search, if available) for the field name.
An optional type in this repo's mirror of the payload records what arrives and says nothing about whether the producer should send it. Guard-legitimacy comes from the producer's schema or from a peer that receives the value.

Outcomes:

- The producer is traced and the empty value is its bug: the finding is "fix at the producer", with its repo and file in `evidence`, and the client workaround is a stopgap that needs a linked ticket. The finding is `blocking: true` until the PR links that ticket or the diff fixes the producer: shipping the workaround with no removal condition is not acceptable (severity-rubric: a P2 blocks when its consequence is unacceptable to ship).
- The producer is traced and the empty value is legitimate (the state truly has no value yet): no finding.
- The producer is unknown: return a `mode: "question"` ("which service sets `tripDestinationCoordinate`, and how does shopping-pwa get it?") with `blocking: true`, for the same reason.

## Why It Matters

The workaround repairs the one symptom in this app. The producer keeps returning the bad value to every other consumer, and a payload that is empty for one cause usually breaks several features. The extra capability also becomes a second implementation to maintain beside the one the platform already owns.

## Incorrect

```ts
// The list API returns destinationCoordinate: null for agent-created trips.
// The client geocodes the destination name with the map's Google SDK instead.
export const getDestinationCenter = async (trip: TripEntry) =>
  trip.destinationCoordinate ?? (await geocode(trip.destinationName));
```

## Correct

```kotlin
// The list mapper read only the legacy `destinations`, empty for trips with no
// saved items. Fall back to `tripDestinations` where the value is produced, as
// the sibling mappers already do; every consumer gets the coordinate.
val destinations = trip.destinations.ifEmpty { trip.tripDestinations }
```
