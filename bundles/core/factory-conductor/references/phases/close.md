# Phase: close

Finish the ticket after the merge. Read the state file first: `pr`, `ci`, `worktree`, `ticket`.

1. Confirm `ci` is `merged`. Otherwise end `blocked` and say why.
2. If the project has a feature map, re-run its check against trunk and remove `pending_pr` from the entry.
3. Move the ticket with the tracker adapter. With no `ticket`, skip this and say so in the notes.
4. Release the branch: `stack.mjs event --branch <branch> --owner <slug> merged --commit <merge sha>` (`factory-stacked-pr`). A child based on it then sees the merge in `since`.
5. Clean up with `factory-teardown`: dev slots, recordings, the worktree once nothing in it is unpushed.
6. Run `factory-reflect` once for the whole ticket, with `state.mjs digest --state <state file>` as its evidence (its "Phase notes" input). Open a transcript only to confirm a lesson the notes point at.

Handoff: nothing. The run's notes record what reflect queued.

Read `_exit.md` in this directory and follow it.
