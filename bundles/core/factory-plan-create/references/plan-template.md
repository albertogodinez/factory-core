---
title: ""
status: "draft"
ticket: ""
ticket_url: ""
ticket_summary: ""
repos: []
created: YYYY-MM-DD
pr_links: []
transcripts: []
---

# feat: Title

## Setup

Before implementation:

1. **Create a worktree in each affected code repo** (the `repos` frontmatter lists them). Use the repo's own worktree convention and trunk, from `resolve.mjs --repo <name>`; push with `-u` on the first push.
2. **Check that sibling repos are current** (`/factory-repo-status`, when installed).
3. **Dev server:** start it the way the repo's `AGENTS.md` says; use `/factory-dev-slot` when parallel agents could share the port.

## Overview
Brief description.

## Problem Statement
Why this matters.

**Root cause:** observed (cite the payload, log line, or code branch you read) or hypothesis (say what would confirm it). Copy the label wherever the cause goes: the ticket, a shared comment.

## Provenance trace
Fill in when the fix compensates for a value another service returns empty or wrong (a fallback, derivation, re-fetch, or client-side lookup). Otherwise write "N/A: no upstream value is compensated".

- **Producer:** the repo and file that sets the value, and why it is empty or wrong.
- **Peers:** how one or two sibling consumers of the same payload get the value.
- **Label:** observed (cite the code you read) or hypothesis, per line.

Without a trace, the plan offers "fix upstream" to the user as an option next to the client workaround.

## Proposed Solution
High-level approach.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

<!-- A CSS-only or layout fix: write "measured on every brand: <edge or size> within <n>px", not "unit tests cover the change". jsdom has no layout, so a test pinning a class or reading a stylesheet as text adds no value; reviewers reject it. -->

## Manual Test Plan

How a human reaches this feature and exercises it. **Fill this in before the plan is marked `active`**: skipping it forces validation agents to guess where to start and what to click, and they will guess wrong.

- **Entry point:** the URL, route or command to start from, and the account or state it needs.
- **Click path:** ordered steps to reach the feature. Use role + accessible-name pairs so steps survive snapshot changes.
  1. Click `button: "Saves (3)"` on the toolbar
  2. Wait for the sheet to open
- **Expected visible state:** one sentence describing what should render when the path is followed.
- **Key interactions to exercise:** the specific buttons or inputs the change affects, which a validation run must click or type to confirm the change works.
- **Prerequisites / setup:** experiments or flags to force on, cookie state, seed data to create before the run.
- **Known gotchas:** anything non-obvious (auth quirks, timing, ordering of overrides).

## References
- (Add links to related plans, PRs, tickets, etc.)
