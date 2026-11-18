# Phase: deploy

Open the pull request. Read the state file first: `ticket`, `branch`, `head_sha`, `plan`, `pr`.

1. If `pr` is already set, update its body and stop there.
2. Open it with `factory-pr-create` (it links the ticket, when there is one, and any stack). With no `ticket`, open it unlinked and say so in the notes. Use the evidence the work phase recorded; don't re-record.
3. If the project has a feature map, update the feature's entry and commit it where the map is sourced, now, before the merge. An anchor that only exists on the branch gets `pending_pr`. A map sourced in another repo is committed there: pull and rebase that checkout before you edit, commit only the entry's file, and if the push fails, rebase once more and retry.
4. Move the ticket with the tracker adapter, if the project has one and `ticket` is set.
5. Refresh the branch's stack claim with `--base` and `--pr` (`factory-stacked-pr`'s `stack.mjs claim`). On a stacked PR, record `stack.mjs peers` in the notes: who owns the parent.

Handoff: `pr`, `base` (the branch the PR targets: trunk, or the parent's branch when stacked), `ci: pending`, and `head_sha` when this run added a commit to the branch (a map entry sourced there).

Read `_exit.md` in this directory and follow it.
