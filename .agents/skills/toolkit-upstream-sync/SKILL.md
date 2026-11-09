---
name: toolkit-upstream-sync
description: 'Review upstream changes to the core skills, review personas and rules adopted from other repos (Matt Pocock''s skills, pstack, vercel rules, the pele package), and decide per change whether to adopt it. Use for /toolkit-upstream-sync, when the pre-commit hook or npm run upstream:check reports CHANGED or GONE, or when adopting a new skill from another repo.'
disable-model-invocation: true
---

# Upstream Sync

`references/upstreams.json` records where each adopted piece came from: the upstream repo and path, the upstream commit last reviewed (`baseline`), and the git object hash of that path at the baseline. Our copies are edited, so the check never diffs them against upstream. It asks whether upstream changed since we last looked.

## Check

```bash
node .agents/skills/toolkit-upstream-sync/scripts/check-upstreams.mjs --online    # online: exit 1 when an upstream path CHANGED or is GONE
```

The pre-commit hook runs the offline half (`scripts/check-upstreams.mjs` with no flags), which warns without failing:

- `UNTRACKED`: a skill without the `toolkit-` prefix, or a review rule with `source: vercel|pstack`, has no adoption entry.
- `PROVENANCE`: a skill carries a `Source:` or `Adapted from` line. Provenance lives in the manifest so agents do not load it.
- `MISSING` / `DRIFT`: a `local` path is gone, or a pinned version in a file no longer matches the manifest.
- `CHANGED` / `GONE`: from the last online snapshot (`tmp/upstream-snapshot.json`).

## Review a pending change

For each `CHANGED` or `GONE` entry:

1. Read what upstream did and what we changed on purpose:
   ```bash
   node .agents/skills/toolkit-upstream-sync/scripts/check-upstreams.mjs --diff <id>
   ```
   It prints the upstream commits since the baseline, the patch for that path, and the entry's `notes`. For `GONE`, look for a rename in the patch list and in the upstream CHANGELOG (Matt Pocock's names the replacement of a removed skill).
2. Sort the change: bug fix, new capability, rename or restructure, wording churn, or a conflict with something `notes` says we changed on purpose. Do not re-propose something `notes` says we removed.
3. Propose adopt, partial, or skip with a one-line reason, and wait for the user's call on each.
4. Apply an approved change to our copy by hand, in our wording. Keep `notes` true: add a line when the change creates a new deliberate difference.

   Code that `notes` says is identical to upstream (`statechart/scripts/`) is not hand-applied. Copy that directory again from the upstream commit you are moving to, leave out what `notes` says is not vendored, and check with `git diff` that nothing outside it changed. Our edits there would be lost on the next copy, so make a deliberate change in a file that is not identical to upstream, and record it in `notes`.
5. Record the decision, which moves the baseline to the upstream head so the same change is not flagged again:
   ```bash
   node .agents/skills/toolkit-upstream-sync/scripts/check-upstreams.mjs --bump <id> --decision "adopted"
   node .agents/skills/toolkit-upstream-sync/scripts/check-upstreams.mjs --bump <id> --decision "skipped: <why>"
   ```
   For a pinned package (`pele`), edit the pin in the file first when adopting; `--bump` reads it back.
6. Run `npm test`.

## Adopt something new

Add an entry to `upstreams.json` instead of writing a `Source:` line in the skill:

- `id`, `source` (a key in `sources`), `relation` (`copied`, `adapted`, `partial`, `inspired`, `pinned`), and `local`: the skill directory, persona file or rules directory it feeds.
- `upstream`: one item per upstream path, with `baseline` (the commit you copied from) and `hash` (`git rev-parse <commit>:<path>` in a clone, or `gh api repos/<o>/<r>/contents/<parent>?ref=<commit>` and take the entry's `sha`).
- `notes`: what you changed on purpose, so a later review does not undo it.

A skill that is this repo's own work but lacks the `toolkit-` prefix goes in `own`.

Then find the upstream files that point to the new skill, such as a router, a README, or a skill that hands off to it:

```bash
node .agents/skills/toolkit-upstream-sync/scripts/check-upstreams.mjs --refs <id>
```

It lists each one with our copy of it, or `not adopted`. For each copy that `does NOT mention it yet`, propose the matching edit (pstack's `poteto-help` row became our `toolkit-ask` row), or say why not. Link the new skill only where upstream does: a pointer from a skill that upstream does not link is a deliberate difference, so it goes in that entry's `notes`.
