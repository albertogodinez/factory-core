# Phase: ci-monitor

Watch the PR until it's merged, closed or needs the user. Read the state file first: `pr`, `head_sha`, `findings`.

Run `factory-pr-ci-monitor` for `pr`, following its "Under the conductor" section:

- This session only reads, replies and classifies. A comment that needs a code change becomes an open finding. End the run with `outcome: fail` so the conductor sends it to a work run and then a review round.
- Each tick reads the state file, not your memory of earlier ticks.
- Once you've loaded the skill, don't load it again for later ticks.
- After three idle ticks on an open PR, end with `outcome: blocked` and say what the PR waits on. A `pass` only means merged, closed or a context rollover.
- When the session gets long (past about 150k tokens of context), end the run with `outcome: pass` and the current state. The conductor starts a fresh run, which carries on from the state file.

Handoff: `ci` (`green`, `red`, `merged` or `closed`), `head_sha`, `findings`.

Read `_exit.md` in this directory and follow it.
