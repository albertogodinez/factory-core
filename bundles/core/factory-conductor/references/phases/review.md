# Phase: review

Review one range of commits, once, as a fresh agent. Read the state file first: `reviewed_range`, `head_sha`, `trunk`, `findings`.

1. The range is `<end of reviewed_range>..head_sha`, or `<trunk>...head_sha` when nothing has been reviewed yet.
2. Run `factory-review` on that range with the round rules in its "Rounds" section: a follow-up round on a small diff gets a smaller panel.
3. Don't fix anything. Record each blocking finding with a stable `id`, its `severity`, a one-line `summary` and `status: open`.
4. The conductor sends open findings back to a work run with a `Task:`, then starts a new review round on just the new commits.

Handoff: `reviewed_range` (`<base>..<head_sha>`) and `findings`. Outcome `pass` with no open blocking findings, else `fail`.

Read `_exit.md` in this directory and follow it.
