## Before you exit (every phase)

Write your notes while the details are fresh, then end the run. This is the only thing the conductor reads back from you.

1. Write a JSON file that matches `schemas/phase-notes.schema.json` in the factory-conductor skill:
   - `phase`, `outcome` (`pass`, `fail`, or `blocked` with a one-line `question`), and a one-line `summary`.
   - `skills`: the skills you loaded. `metrics`: `rounds` and `user_interventions`, which only you know. `end` measures `turns`, `peak_ctx`, `agents`, tokens and the model from your session's log (Claude Code and Codex). Give your own `turns` and `peak_ctx` only on another harness.
   - `friction`: what slowed you down. `misses`: anything an earlier phase should have caught. One line each, no story.
   - `evidence`: pointers only (a commit, a PR thread, `file:line`). Never paste content.
   - `handoff`: the state fields the next phase needs, and only those.
2. Run `node .agents/skills/factory-conductor/scripts/state.mjs end --state <state file> <phase> --notes <file>`. If it refuses, fix the notes and run it again.
3. Stop. Don't start the next phase: the conductor does that.

Blocked on a decision only the user can make? End with `outcome: blocked` and the question. Don't wait in the session.
