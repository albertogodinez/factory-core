# Adapter contracts

An adapter is an installed skill that supplies company- or tool-specific behavior to core skills. `.agents/factory-metadata/project.json` names it under `adapters`, and the resolver passes the value through. Core skills call adapters only through the contracts below. When an adapter isn't set, a core skill skips that step and says it skipped it.

## tracker

`adapters.tracker` is the name of an installed skill, e.g. `"factory-tracker-jira"`. That skill ships `scripts/tracker.mjs` (`node:` imports only). Every command prints one JSON object on stdout and exits 0, even when it skips. Exit 1 means it was asked something it can't do, and exit 2 means bad usage.

```
tracker.mjs parse    --text <branch, title or commit message>   → {"status":"ok","ticket":"KEY-123"} | {"status":"none"}
tracker.mjs get      --ticket <KEY>                              → {"status":"ok","ticket":{"key","title","status","url","type"}}
tracker.mjs link     --ticket <KEY> --url <PR url> [--title <t>] → {"status":"ok"|"exists","detail"}   adds a remote link, then reads it back
tracker.mjs review   --ticket <KEY>                              → {"status":"ok"|"skipped","from","to","detail"}  moves to the review state; never backward
tracker.mjs publish  --file <plan.md> [--target <id>]            → {"status":"ok"|"skipped","url","detail"}       optional; plan copies
```

- `status: "skipped"` carries a one-line `detail` that the core skill repeats to the user (e.g. "already In Review", "no transition to In Review from Blocked").
- Credentials are the adapter's business. Core never reads them, and never passes them on the command line.
- `writeAllowed: false` applies: a core skill asks the user before calling `link`, `review` or `publish`.

## commentMarker

Data, not a skill. See `factory-pr-comment/references/github-pr-comments.md` §1.

## envProfile

`adapters.envProfile` names an environment profile for `factory-dev-slot`: mounts, env vars, a CA bundle and proxy rewrites a company network needs inside a dev container. An adapter skill ships it as `.agents/skills/<skill>/profiles/<name>.json` (shape: `factory-dev-slot/schemas/profile.schema.json`). `slot up` loads it by name and applies it. Unset means no profile; a name that isn't installed is an error, never a silent skip.

## personas

`adapters.personas` (from `review.personas`) lists factory-review personas. Each one is found in `factory-review/personas/` or in a persona pack, `factory-review-*/personas/`.

## reviewUI, lessonInbox, lessonLanding

Read from the **source repo** a lesson lands in (`resolve.mjs --cwd <repo>`), not from the repo the session ran in. `factory-reflect` uses them in "Landing a lesson branch".

- `adapters.reviewUI` names the review step for a lesson branch. `plannotator-review` writes a guided review first (`factory-reflect/scripts/guide.mjs`, the guide by a subagent on the newest Sonnet), then runs `plannotator review <worktree | PR URL> --gate --json` and reads its `decision`. When the branch has an open PR, the guide and the review both go to the PR, and its comments are posted there when the review's destination is GitHub (the default). Plannotator has no flag that writes a guide on open, so the guide is written first and imported. Unset means the diff in chat, one commit at a time.
- `adapters.lessonInbox` names where a notice goes when a lesson branch is left undecided. `plannotator-inbox` sends one message to the thread `factory lessons`. It is a notice only; approval is always the review step.
- `adapters.lessonLanding`: `local-review` (default) fast-forwards trunk after approval and pushes; `pr` pushes the branch and opens a PR for a repo with other reviewers.

## sessionLauncher

A fact of the machine, not of a repo: `~/.agents/factory/config.json` holds it (`{"adapters": {"sessionLauncher": "factory-launcher-hc"}}`), and `factory setup` writes it when `hc` is on PATH. A repo's own `adapters.sessionLauncher` overrides it, and `null` turns it off there. `factory-reflect` uses it to hand a fact candidate to its source repo: `lessons.mjs candidate` prints the launch.

- The value names a skill that ships `launcher.json`. It's read from the repo's installed skills first, then from the `launchers` bundle beside core, so no repo has to install it. The file is: `{"argv": [...]}`, where `{repo}` is the source repo's main checkout and `{prompt}` the prompt the new session starts with. The skill's `tools.json` pins the CLI it runs.
- The new session starts in the source repo, so it writes only its own repo. Starting it is the only cross-repo step.
- Unset, or a launcher with no `launcher.json` in either place: the candidate prints `cd <repo> && <your agent CLI>` and the prompt, for the user to run.
