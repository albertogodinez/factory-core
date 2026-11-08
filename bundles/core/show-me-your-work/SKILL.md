---
name: show-me-your-work
description: "Keep a reviewable decision trail for long-running or unattended work: a TSV log with one row per decision (what, why, evidence, result). The log always stays local in the project's untracked state area and is never committed; a reviewer gets a summary in the PR body. Use for /show-me-your-work, autonomous or multi-phase runs, or work a human reviews after stepping away."
disable-model-invocation: true
---

# Show me your work

Keep one canonical log per task.

## The format

A single TSV file, one row per decision. Cells stay single-line. Evidence is a pointer, not prose.

`references/decision-log-template.tsv` holds the header row. Columns:

- **ts.** ISO8601 timestamp.
- **phase.** The phase or workstream.
- **decision.** What was chosen or done, one line.
- **why.** The reason in plain words. If a principle drove it, say it plainly, not as a jargon tag.
- **evidence.** A pointer that proves it: commit SHA, PR number, `file:line`, or an artifact, trace, or screenshot path. Never a paragraph.
- **result.** The outcome or predicate state: `tests green`, `reverted`, `pixel-diff 0`, `INCONCLUSIVE`, `open`.

An example, plain-spoken so a reviewer reads it at a glance.

```
ts	phase	decision	why	evidence	result
2026-05-24T09:02:00Z	frame	counted the work first, about 100 components and roughly 75 hours	wanted to know the size before starting a long run	commit 3a9f1c2	found 5 things to sort out before starting
2026-05-24T09:40:00Z	harness	took screenshots of the old version before changing anything	so we can compare old against new and catch any visual change	scripts/snapshot.sh, baseline/ screenshots	saved 120 reference screenshots
2026-05-24T11:15:00Z	widget	moved the widget styles over without changing how it looks	keep the change small and the result identical	commit 7c21e0a, pixel-diff 0	looks identical, tests pass
2026-05-24T12:30:00Z	widget	threw out a helper's work because its screenshots were blank	checked the real files instead of trusting its summary	worktree reset	reverted, tightened the instructions for next time
```

## Where it lives

The log is always a local working file. It never gets committed, pushed, or merged, in any repo the work touches.

- Path: `<stateRoot>/../decisions/<task-slug>.tsv`, where `<stateRoot>` comes from `node .agents/skills/toolkit-context/scripts/resolve.mjs --field stateRoot`. The `decisions/` directory sits beside the state directory, not inside it, for two reasons: clearing scratch state keeps the logs, and one project's worktrees share one set of logs. A log is the one record of why a call was made and cannot be regenerated; a script's output can, so that goes under `<stateRoot>`.
- The helper resolves the path itself, from the current directory's project, so the log lands in the same place from any worktree of it. Set `DECISIONS_DIR` to override.
- Pick a short slug per task, such as the ticket key or branch name (`PROJ-1234-clarifier`). Several efforts at once get several slugs.
- Never write the log inside a repo's tracked tree, and never `git add -f` it.

## Logging a row

Write each entry the way you'd tell a teammate what you did. Plain words, concrete actions, no AI speak or abstract jargon. Run log text through the `unslop` skill.

Use the helper:

```bash
node .agents/skills/show-me-your-work/scripts/log.mjs <slug> <phase> <decision> <why> <evidence> <result>
```

Given a bare slug, it writes to `<stateRoot>/../decisions/<slug>.tsv` and prints that path. A first argument containing a path separator or ending in `.tsv` is used as the file path instead. The helper stamps `ts`, writes the header on first use, replaces stray tabs and newlines with spaces, and prefixes any cell starting with `=`, `+`, `-`, or `@` with a single quote so a spreadsheet does not run it as a formula. A bare `printf` append works too, but then handle those same bytes yourself when cells come from generated or user-supplied text.

Log decision points and checkpoints, not every action: a fork chosen, a unit completed with its verification result, a pivot or revert with its trigger, a blocker surfaced, a gate fixed. For loop runs, one row per iteration. Skip the trivial and self-evident.

A run is one agent conversation, including its later turns and any summary or compaction of it. A pickup, a replacement agent, or a new chat starts a new run. When a run adds to a log that already has rows, its first row has phase `start`, and so does its first row after another run's `start` row. So a run that comes back to a log in a later turn first reads the log's last rows to see whether another run wrote since. A `start` row names the `ts` range of the rows before it that this run did not write, and its evidence names this run, such as its session id. Use phase `start` for nothing else.

## Rules

- Append-only. A wrong call gets a new row that supersedes it. Never edit or delete history.
- Prefer evidence produced by committed scripts over hand-made one-offs (the `principle-build-the-lever` skill).

## Audit the log against the transcript

At the end of the run, before handing back, check the log told the truth. Read this run's own transcript, and only that one:

- **Claude Code:** `~/.claude/projects/<project-slug>/<session-id>.jsonl`, where `<project-slug>` is the session's starting directory with `/` and `.` replaced by `-` (for example `-Users-me-Documents-repos-myproject`). The session id appears in the scratchpad path the system prompt names.
- **Codex:** the current session's rollout file under `~/.codex/sessions/YYYY/MM/DD/`, the newest one whose recorded `cwd` matches this session.

Never glob across `~/.claude/projects/*/` or every Codex session. That reads unrelated private conversations.

Walk this run's rows against what actually happened. Each stretch of them begins at one of this run's `start` rows, or at the first row if this run created the log, and ends at the next `start` row of another run:

- Check that every row maps to a real decision or action.
- Check that each row's evidence resolves and shows what the row claims.
- A fork, pivot, or abandoned approach that shaped the work but isn't logged is a gap. Add it.

Correct the log, not the story. The audit never edits or removes a row, even an invented one. When a row records neither a real decision nor a real action, or its claim or evidence is wrong, add a row that supersedes it with what actually happened and a pointer that resolves. This audit does not check rows outside this run's stretches. If this run's own work shows one of them is wrong, supersede it like any wrong call.

## Independent review of the trail

Before handing back, get a reviewer that did not do the work, on the other vendor's model: run `/toolkit-second-opinion` if it is installed (it sends the prompt to the other vendor's model and falls back to a fresh subagent), or any other reviewer on a different model. If none is available, use a fresh `general-purpose` subagent and say so. Self-review is not a substitute. Give it the log path and this run's transcript path. It scans for what the user should pay attention to, not a redo of the work:

- Decisions logged with weak or absent evidence.
- Verification steps skipped or claimed without proof in the transcript.
- Choices that look risky in hindsight (premature, scope-creeping, papering over a symptom).
- Gaps the user would otherwise miss on a casual skim.

Every reply for a run that produced a trail ends with an "Attention" section. Lead with the reviewer's model on its own line (`reviewed by <model> (cross-harness)`, or `(fallback: <reason>)`), then list each flag pointing to specific rows or moments. "No flags" is a valid value. The model name is not optional.

## When a reviewer needs the trail

The TSV stays local. If the work ships as a PR and a reviewer needs the trail to trust the result, summarise it into the PR body instead: a short "Key decisions" list, one line per decision that shaped the result, each with its evidence pointer (SHA, PR, `file:line`, a CI or artifact link a reviewer can open). Drop pointers to local scratch paths the reviewer cannot reach, or replace them with something they can.

## Reviewing the trail

Read top to bottom, follow the evidence pointers, spot-check. In a terminal:

```bash
column -s$'\t' -t "<stateRoot>/../decisions/<slug>.tsv"
```

## Composing this skill

Other skills route their audit trail here instead of inventing one. Reference it by name and let it own the format. Don't restate the columns.
