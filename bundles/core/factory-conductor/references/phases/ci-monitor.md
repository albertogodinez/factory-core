# Phase: ci-monitor

Watch the PR until it's merged, closed or needs the user. Read the state file first: `pr`, `head_sha`, `findings`.

Run `factory-pr-ci-monitor` for `pr`, following its "Under the conductor" section:

- This session only reads, replies and classifies. A comment that needs a code change becomes an open finding. End the run with `outcome: fail` so the conductor sends it to a work run and then a review round.
- Each tick reads the state file, not your memory of earlier ticks.
- **Stacked PR** (`base` is set and isn't `trunk`): each tick, `git fetch origin <base>` and check `git merge-base --is-ancestor origin/<base> HEAD`. When the parent has moved, open finding `stack-resync` (summary: the parent's new head) and end with `outcome: fail`, even with CI green. The parent's session doesn't tell you; you find out from the ref. `stack.mjs since --branch <base> --seen <merged parent head>` adds who pushed and whether a squash is coming. Never write the parent's branch. When the parent PR has merged (`gh pr view <base PR> --json state`), the resync is a merge of `origin/<trunk>` (after a squash, the parent's commits are in trunk), never a force-push, and the PR's base moves to `<trunk>`.
- Once you've loaded the skill, don't load it again for later ticks.
- After three idle ticks on an open PR, end with `outcome: blocked` and say what the PR waits on. Checks that are only pending, or a `DIRTY` stack you can resync, aren't a wait on a person: that's `pass` (rollover) or `fail` with `stack-resync`. A `pass` only means merged, closed or a context rollover.
- When the session gets long (past about 150k tokens of context), end the run with `outcome: pass` and the current state. The conductor starts a fresh run, which carries on from the state file.

Handoff: `ci` (`green`, `red`, `merged` or `closed`), `head_sha`, `findings`.

Read `_exit.md` in this directory and follow it.
