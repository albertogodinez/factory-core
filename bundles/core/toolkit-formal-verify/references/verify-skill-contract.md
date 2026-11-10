# Verify skill contract

A verify skill is read cold, mid-change, by an agent that has never seen the model. From the skill alone it must be able to tell whether its change touches the verified code, run the check, tell a real bug from a modeling error, and update the model when the change is intended.

## Directory

`.agents/skills/toolkit-verify-<repo>-<subsystem>/`, where `<repo>` is its name in the project registry (`resolve.mjs --repo`) and `<subsystem>` is the noun the repo uses for that part (`map-toggle`, not `layout-state`).

## `coverage.json`

Schema: `../schemas/coverage.schema.json`. `check-drift.mjs` reads it, so the covered code lives here and not in prose.

```json
{
  "repo": "example-app",
  "syncCommit": "<40-char sha on the repo's trunk>",
  "checks": [
    {
      "id": "no-jump-when-results-match",
      "property": "NoJumpWhenResultsMatch",
      "rule": "When the results match the search's intent, the pane keeps the layout it had when they land.",
      "model": "model/PendingHotel.tla",
      "config": "model/PendingHotel.cfg",
      "view": "model/view.mjs",
      "covers": [
        { "path": "src/…/map-toggle-context.tsx", "symbols": ["userDisabledAfterForced"], "role": "forced-choice flags and their per-key reset" }
      ],
      "findings": [
        { "id": "skeleton-toggle-lost", "status": "open", "replay": "replay/no-jump-when-results-match.spec.tsx" }
      ]
    }
  ]
}
```

- `syncCommit` is the trunk commit at which someone last confirmed the model describes every covered file. One per skill: a maintain pass confirms the whole model.
- `covers[].symbols` are substring checks, like feature-map anchors. Choose names that would change if the code moved.
- `property` is the TLA+ name in the config, `rule` is the reader's sentence for it.
- `findings[].status` is `open` while the code breaks the property, `fixed` once a sync confirms it passes. A `fixed` finding keeps its replay as a regression test to offer upstream.

## `SKILL.md`

Frontmatter: `name`, and a model-invoked `description` that names the subsystem, the promise, and the files a change would touch, so an agent editing those files reaches it. Then these H2s in order:

1. `Promise`: each property as one plain sentence, and the harm when it breaks in one more.
2. `Does my change touch it?`: `check-drift.mjs --repo <repo> --diff …` as the quick answer, what to do when it says `touched` (the committed model describes `syncCommit`, so read the change against the model and rerun a copy edited from the branch's code; the skill moves after the merge), and the covered files with what in them the model depends on.
3. `Run`: the steps to copy the model to `<stateRoot>/`, run it with `/statechart`, and replay a finding. Name the model, config and view, and let `/statechart` supply its own command and flags.
4. `Read the result`: which properties should hold, which known findings should break, how to tell drift from a bug, and what each replay drives for real and what it feeds in by hand. A new break, or a known one that stops breaking, means the code or the model changed.
5. `Model ↔ code`: one line per action and variable, pointing at the file and symbol it stands for. One indivisible step in the code is one action in the model.
6. `Scope`: the bounds, the assumptions, and what the model leaves out.
7. `Update the model`: when the change is intended, edit the model from the code first, rerun, show the check still fails on a broken variant, then move `syncCommit`.
