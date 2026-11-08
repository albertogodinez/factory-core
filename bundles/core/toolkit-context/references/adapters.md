# Adapter contracts

An adapter is an installed skill that supplies company- or tool-specific behavior to core skills. `.ai-toolkit/project.json` names it under `adapters`, and the resolver passes the value through. Core skills call adapters only through the contracts below. When an adapter isn't set, a core skill skips that step and says it skipped it.

## tracker

`adapters.tracker` is the name of an installed skill, e.g. `"toolkit-tracker-jira"`. That skill ships `scripts/tracker.mjs` (`node:` imports only). Every command prints one JSON object on stdout and exits 0, even when it skips. Exit 1 means it was asked something it can't do, and exit 2 means bad usage.

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

Data, not a skill. See `toolkit-pr-comment/references/github-pr-comments.md` §1.

## envProfile

`adapters.envProfile` names an environment profile for `toolkit-dev-slot`: extra environment variables, CA certificates or proxy settings a company network needs. An adapter skill ships it as `profiles/<name>.json`. See `toolkit-dev-slot`'s SKILL.md for the shape.

## personas

`adapters.personas` (from `review.personas`) lists toolkit-review personas. Each one is found in `toolkit-review/personas/` or in a persona pack, `toolkit-review-*/personas/`.
