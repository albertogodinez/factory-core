# Phase: intake

Get to a plan the work phase can follow without asking, and a ticket it belongs to. Read the state file first: `ticket`, `plan`, `worktree`.

Start from what the run was given:

- **A ticket and no plan:** read the ticket through the project's tracker adapter (factory-context names it). Research only what the plan needs, citing each source. Write the plan with `factory-plan-create`.
- **A plan (with or without a ticket):** the plan is the source of truth. Read it in full. Fill only the sections the plan template requires that it lacks, and don't rewrite or shorten what's there. With a ticket as well, read the ticket and check the two agree. A conflict in scope or acceptance becomes the `blocked` question.

Then, either way:

1. If the project has a feature map (`factory-feature-map`), find the entry this ticket changes and hand it over as `feature_entry`. Every later phase gets it in its prompt. Without it, work drives the app from scratch.
   - **The map is this repo's own** (not in `.agents/factory-metadata/skills-lock.json`): `feature_entry` is the entry's file. With no entry, write one with `status: in-progress`.
   - **The map came from a bundle:** you can't edit it here. Copy the entry, or write a new one with `status: in-progress`, to `<stateRoot>/feature-map/<map name>/features/<id>.md` (`stateRoot` from `factory-context`), and hand over that path. Deploy sends it to the map's source.
   - Before the plan relies on its driving steps, replay the first two or three.
2. Each open question in the plan names the decision and who makes it. Cite research; don't paste it.
3. **Scope gate.** End `pass` only when the decision log records the user's yes to the plan's scope. Otherwise end `blocked`, with the scope as the `question`. With no ticket, the question also says that a yes files the ticket from the plan.
4. **No ticket, after the yes:** file one with the tracker adapter, using the plan's ticket proposal (its title, `shape` and acceptance lines). Put the key in the plan. With no tracker adapter, leave `ticket` empty and say so in the notes.

Handoff: `plan` (the path), `feature_entry` when the project has a feature map, and `ticket` when this run filed it.

Read `_exit.md` in this directory and follow it.
