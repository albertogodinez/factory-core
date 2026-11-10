# Maintain a feature map

## Outcomes

Say which one:

- **clean**: every feature in scope got source and live coverage, nothing to change.
- **changed**: map corrections made. Each one was proven by source or by a live drive.
- **blocked**: coverage could not finish. Name the prerequisite, for example "auth expired" or "design source unreachable".

## Pass

1. **Checker.** Run `node .agents/skills/factory-feature-map/scripts/check-map.mjs`.
   - Fix broken anchors first. They show where the code moved.
   - Each `unmapped` id is either a new feature, an addition to an existing feature's `covers`, or a deliberate gap. Write a deliberate gap down in the index, under a "Not mapped" list with a reason.
2. **Source wave.** Launch one read-only subagent per feature file, in parallel. Give each the feature file and the anchors' repo paths. Each returns how the feature works now (with citations), drift against the file or "none", and one live recipe. Subagents never drive the app and never edit files.
3. **Reconcile.** Merge recipes into as few app states as practical. Spot-check the drift subagents cite. Don't re-prove claims that came back clean.
4. **Live pass.** The coordinator does all the driving, following the map's `SKILL.md`.
   - Run doctor before the first drive and after any failed drive.
   - Evidence goes under `<stateRoot>/feature-map/<name>/<feature>/`, and must survive cleanup.
   - Replay each entry's `app_recipe` first, with the map's `scripts/replay-app.mjs`. A step that fails is a stale route: fix the recipe and the "Driving it" section together.
   - A path walked twice by hand is a missing recipe. Write it before you finish.
   - A feature counts as `verified-unreachable` only when you name the unmet prerequisite and the entry point you tried.
   - If the user scoped the pass (`maintain <feature-id>`), drive only those, and report the rest as not covered.
5. **Triage.**
   - Wrong description, entry point or anchor: map drift, so fix it.
   - Working behaviour the harness can't drive: harness gap, so fix the map's `SKILL.md` or scripts.
   - Broken app behaviour: product bug, so report it to the user and keep it out of the map.
6. **Finish.** Bump `last_verified` only on features you drove. Re-run the checker. Commit the map change like any other change in the repo.

Keep run notes in `<stateRoot>/feature-map/<name>/maintain-<date>.md`, and don't commit them.
