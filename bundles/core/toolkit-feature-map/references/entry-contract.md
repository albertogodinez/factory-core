# Feature entry contract

An entry says how to reach and drive a feature, and maps it to code, because finding where to edit is the reason a map exists. Code anchors rot fastest, so they live in frontmatter, where `check-map.mjs` resolves each one, not in prose.

## Frontmatter

Schema: `../schemas/entry.schema.json`.

```yaml
---
id: cart-compare                     # = filename
title: Cart compare
status: shipped                      # shipped | in-progress | planned
summary: One sentence a user would recognise.
aliases: [compare carousel, side by side]   # names from design files, tickets, chat
covers: [route:/compare]             # ids from scripts/inventory.mjs
sources:
  - kind: figma                      # figma | prototype | component-docs | confluence | jira | slack | pr | screenshot
    url: https://…
    note: How to reach it, and what it shows.
app_recipe: app/cart-compare.recipe  # optional; replayable route into the running app
code:
  - path: src/compare/index.tsx      # repo omitted: this project
    symbols: [CompareCarousel]       # must appear in the file (or anywhere under a directory)
    role: register a new compare column
  - repo: ui-kit                     # a neighbor's name
    path: packages/carousel/
    role: carousel layout
tests:
  - path: test/compare.test.tsx
pending_pr: https://example.com/acme/app/pull/12   # optional; the open PR this entry already describes
last_verified: 2026-10-02            # last live drive, not last edit; "never" until the first
---
```

- `symbols` are plain substring checks: identifiers, registry keys, string literals. Choose ones that would be renamed if the code moved, so a stale anchor fails.
- `role` says what to change there ("add the new key", "board tab title"), not what the file is.
- `repo` is the project's own name or a neighbor's name from `toolkit-context`. One feature can span repos: use the repo where each file actually lives, not where it's consumed.
- Frontmatter is YAML: quote any value that contains `: ` or starts with a quote, `#`, `[` or `{` (`role: "the steps: fare, seats"`). The checker reports bare ones as an error with the file line. It reads maps, block lists, lists of maps, inline `[a, b]` lists and plain or quoted scalars. Flow maps and block scalars (`|`, `>`) are not supported.
- `sources` records provenance and useful evidence. It doesn't rank sources or choose design authority; `design-authority.json` does that.
- `app_recipe` points to `app/<feature-id>.recipe`: the route into the running app that "Driving it" describes, replayed by the map's own `scripts/replay-app.mjs`. The checker runs it with `--check`. A map that doesn't ship a replayer shouldn't set this key.
- `pending_pr` names the open PR the entry already describes, so the entry is committed with the PR rather than left in a working tree until the merge. While it's set, an anchor that doesn't resolve is a warning naming the PR. After the merge, `scripts/clear-pending-prs.mjs --apply` removes the field.
- A map's own extra keys go in `features/keys.json`, as `{ "<key>": "<one-line meaning>" }`. A declared key is accepted on every entry. Any other key is ignored with a warning, so a typo still shows.

## Body

An H1 and one paragraph on the user-visible behaviour, then these H2s in order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every entry point (route, prompt, button, link).
3. `Driving it with <harness>`: starts with `Preconditions:`. Each labelled bullet pairs a user action with an exact command and the observable result.
4. `Where to change it`: one bullet per change someone is likely to ask for, each pointing at a `code` anchor ("new compare layout → ui-kit `carousel/`, then bump the pin in this repo's `package.json`"). This section saves the most tokens.
5. `Gotchas`: traps that waste or invalidate a run.

One file per user-facing feature: something a user would name ("compare hotels", "the trip board"), reached from routes, menus or prompts. A behaviour of that feature is a `Sub-features` ID, not a new file. When a file grows, check whether it now describes two things a user would name separately, and split it there. Length alone isn't the test. Keep the body user-facing: contracts and how-it-works belong in a test or the PR body, and the body keeps only the one-line fact a driver or editor needs.

## What an entry leaves out

An entry states what is true now. Nothing reads its history, and an agent pays for every line it opens.

| Keep | Leave out (it belongs in the PR body, commit message or ticket) |
|---|---|
| A settled decision, as one line: `Decided: <rule>; don't re-raise. (<TICKET>)` | Who decided, which chat thread, review comment ids |
| One ticket key or PR number as a pointer to where to re-check | Merge dates, commit SHAs, "squash-merged as", release versions of merged work |
| A claim that can drift, stated as current plus the symptom that shows it changed ("step 4 no longer matches: the sample cart has no `Compare` button"); recheck it and bump `last_verified` | A date in the body ("as of <date>", "seen <date>"), dated narratives of a run, prod bundle hashes |
| Measured values that are the current target or budget | Measurements of a superseded state, and before/after tables |
| `sources[].note`: how to reach the source and what it shows | Status of a PR or ticket (open, mergeable, assignee) once it has merged or closed |

When a PR merges, rewrite the bullets that described it in flight as the current behaviour, and drop the PR from `sources` unless it is still the best place to read the design.

## Index (`features/README.md`)

- Baseline preconditions shared by every feature (dev server, auth, data).
- Driving conventions and proof rules.
- One link per feature: `- [Title](./<id>.md) one line`. The checker requires every file to be linked and every link to resolve.
