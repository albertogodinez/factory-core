---
name: factory-conductor
description: Take a ticket to a merged PR as fresh phase agents that hand over through one state file.
disable-model-invocation: true
---

# Conductor

Run a ticket as a chain of short-lived phase agents instead of one long session. Each phase starts fresh, reads one state file, does one job, leaves notes and exits. The conductor only dispatches, records decisions and watches the state. It never does phase work, so its own context stays small for the whole ticket.

Why: one long session carries everything forward, so context only ever grows. Planning detail is still loaded during CI polling, and every review round and skill reload is paid for again on every later turn. Splitting the work into phases keeps each context small. It also makes each phase measurable on its own, so you can improve one phase without touching the rest.

## The phases

| Phase | Job | Uses | Hands over |
|---|---|---|---|
| intake | Ticket to plan | tracker adapter, `factory-plan-create`, `factory-feature-map` (read, seed, replay) | `plan`, `feature_entry` |
| work | Build and prove it | `factory-dev-slot`, a browser subagent driven by `feature_entry`, `principle-prove-it-works` | `head_sha`, fixed findings; driving steps added to `feature_entry` |
| review (opt-in) | One fresh review of one commit range | `factory-review` (its "Rounds" section) | `reviewed_range`, `findings` |
| deploy | Open the PR | `factory-pr-create`, `factory-feature-map` (update, commit now) | `pr`, `ci` |
| ci-monitor (opt-in) | Watch CI and comments until merged | `factory-pr-ci-monitor` (its "Under the conductor" section) | `ci`, `findings` |
| close | Clean up and learn, once | `factory-feature-map` (after-merge check), `factory-teardown`, `factory-reflect` | nothing |

Each phase's prompt is in `references/phases/`: `intake.md`, `work.md`, `review.md`, `deploy.md`, `ci-monitor.md` and `close.md`. Each one ends with `_exit.md`, the notes-and-exit steps they share. A **recipe** replaces any of them: set `recipe` to an installed skill, and its `phases/<phase>.md` is used instead for the phases it has. The others keep the default. This is how a project adds its own steps without forking the conductor.

Phases of one ticket run **in order, in the ticket's one worktree**. Never run two phases of one ticket at once. The exception is a fix loop while CI runs: the ci-monitor run ends first, then the conductor starts a work run.

## The state file

`scripts/state.mjs` owns it. The file is `<stateRoot>/conductor/state.json`, where `stateRoot` is the factory-context resolver's for the ticket's worktree. Its shape is `schemas/state.schema.json`. Every write is checked against that schema, and a write that would break it is refused.

```bash
S() { node .agents/skills/factory-conductor/scripts/state.mjs "$@"; }   # a function: zsh doesn't word-split a variable
S init --worktree <path> [--ticket <key>] [--plan <path>] [--recipe <skill>] # one of ticket or plan; prints the state file
S launch --state <file> <phase> [--task "<what this run does>"] [--what "<a few words>"] [--run]
S status --state <file>                                                      # one line
S live --state <file>                                                        # this ticket's sessions still open
S kill --state <file> <phase> --why "<reason>"
S set --state <file> key=value ...                                           # a fix the conductor makes by hand
S digest --state <file>                                                      # every run's notes, for reflect
```

A phase ends its own run with `state.mjs end --state <file> <phase> --notes <file>`. The notes follow `schemas/phase-notes.schema.json`. Their `handoff` object is the only way a phase changes the state.

## Run a ticket

**Default route:** intake → work and local verification → deploy → report the PR URL and end this run. Review and CI monitoring start off, including for older states without `automation`. A mention in a ticket, plan, or PR is context. Enable a phase when the user asks for it or has configured a standing opt-in:

```bash
S set --state <file> automation.review=true        # review this ticket in the conductor
S set --state <file> automation.ci_monitor=true    # monitor this ticket's PR in the conductor
```

Set a flag to `false` to disable it again. For a standing repo preference, set the corresponding boolean under `adapters.conductor` in `.agents/factory-metadata/project.json`. `init` copies those defaults to new tickets. Use `set` for an existing ticket. Users can also invoke `factory-review` or `factory-pr-ci-monitor` directly for a one-off without changing the ticket's choices.

1. **Set up.** Create or find the ticket's worktree, then `init`. A plan-first run (a detailed plan, no ticket yet) passes `--plan` alone. Intake files the ticket after the user's scope yes, and until then tabs are named after the plan. On a ticket whose base is an unmerged PR, `set base=<that PR's branch>` now: review, ci-monitor and work read `base` from the state, so it can't wait for deploy. Cut the branch with `--no-track` and `git push -u origin <branch>`; a branch cut from `origin/<base>` otherwise tracks the parent, and a bare `git push` lands there. Check `git rev-parse --abbrev-ref @{u}` names this branch before any push. Claim the branch in the stack ledger with the state's `slug` as owner (`factory-stacked-pr`'s `stack.mjs claim`). A refused claim means another session owns it: ask the user. Start a decision log with `show-me-your-work` and `set decisions=<its path>`. Every call the user makes goes there, one row each. A phase reads the log, never the conversation.
2. **Launch the next phase.** Read the two opt-ins from `status`. After work, launch review only when enabled, then deploy. After deploy, launch ci-monitor only when enabled. Otherwise give the user the confirmed PR URL, draft or open status, and local verification summary. CI and PR feedback are their handoff. End the run here without launching close. `launch` starts the selected phase and works out where it opens:
   - **A session launcher is configured** (`adapters.sessionLauncher`, see factory-context's `references/adapters.md`). The phase opens as its own session, in the worktree, tagged `conductor:<slug>:<phase>:<n>`. Pass `--what` with a few words on what this run does (`CI on #1029`, `fix page-view reset`, `review round 3`): that's the session's name in the tab and the sidebar, which is how the user tells a ticket's stages apart. Without `--what` the tab is `<ticket> · <phase>` and the sidebar keeps its default. With the hc launcher, that's a Herdr tab and its sidebar row. Pass `--run` to open it, or run the `command` it prints, then its `after` command. Never start a phase with your own `hc run` (or `--name`): the session then belongs to your tab, unnamed, and `live` can't see it.
   - **No launcher** (`via: subagent`). Dispatch the printed `prompt` to a general-purpose subagent, unchanged.
3. **Wait without polling the phase.** A launched phase signals by ending its run. Check `status` when you're woken, and check `live` only to see whether a session that should be open has gone. Never read a phase's terminal or transcript to follow its progress. If you need to know something, the phase should have written it down: add a `friction` note to its run instead.
4. **Route on the outcome.**
   - `pass`: follow the enabled route above. A ci-monitor run moves on to close only when `ci` is `merged`. A `pass` with any other `ci` is a rollover while monitoring is enabled. A PR that's `closed` without merging goes to the user.
   - `fail` from review or ci-monitor, with open findings: launch `work` with `--task "fix <ids>"`, then follow the enabled route. When review is enabled, the next round covers only the commits since `reviewed_range`.
   - `blocked`: ask the user the one `question`, log the answer, and launch the phase again if enabled. Resume a parked ci-monitor when the user says the PR has moved and monitoring is enabled. When review is enabled, check that `reviewed_range` ends at `head_sha` before calling the PR reviewed. Review any later commits first.
   - Stuck: the phase is looping, a session vanished, or the same check failed twice. `kill` it with the reason and relaunch it with a narrower `--task`. The reason is evidence for reflect.
5. **Close.** When the enabled monitor confirms the merge, launch `close`. For a manually monitored PR, resume close only when asked and after verifying the merge. Close runs `factory-reflect` once for the ticket over `digest`.

## Rules

- **No phase work in the conductor.** Side quests go to their own agent: a Slack draft, an explainer page, a demo, a dev server that keeps dying. That agent returns a link or a one-line status, never its working context.
- **Only agent sessions get a tab.** A dev server, watcher or other plain process that the conductor or a phase starts in the terminal app runs as a child of the session that started it, with no tab of its own. With hc that's `hc run --bg --keep --name <short-name> --cwd <dir> -- <cmd>`, with no `--no-parent` and no `herdr.tab` or `herdr.space` label. Herdr then lists it under its parent in the sidebar. This applies even when a plan or an earlier note says new terminals open in their own tab: that rule is for agents.
- **One question at a time goes to the user,** and only one a phase has marked `blocked`. Answer a phase's question from the plan or the decision log first.
- **No screenshots, recordings or long logs in the conductor.** Keep the path, not the bytes.
- **Don't load the terminal app's manual** (a multiplexer's `AGENTS.md` or `--skill` output). The launcher handles where a session opens and what its tab is called. The conductor needs only `launch`, `status` and `live`.
- **Notes before exit, always.** A phase that dies without notes gets `kill` notes from you. A failed run teaches the most.
- **Measure per phase.** `digest` totals the runs, wall time, rounds, turns and peak context for each phase, with tokens, model time and a `by_model` split for the runs `end` measured from their session logs (`scripts/usage.mjs`; `measured` counts them). Compare these across tickets before you change a phase's prompt, skill or model.
- **Look before you spawn.** Before `launch` for a ticket, check `live`, the session launcher's own list, `gh pr list --search <KEY>`, and the worktrees and branches for the key. An existing run is adopted, not duplicated.
- **Look before you alarm.** Before telling the user a worker's worktree holds changes nobody made, read `git log -3`, `git reflog -5`, run `git fetch`, and read the worker's last notes. A merge in progress looks like foreign staged files.
- **Verify a branch claim.** A worker's hand-off attaches `git rev-parse HEAD origin/<branch>`. Check `git ls-remote` or `gh pr view` before writing the tracker or telling the user the work is pushed.
