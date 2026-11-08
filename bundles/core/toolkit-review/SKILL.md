---
name: toolkit-review
description: Run a semantic code review by dispatching the project's rule-based reviewer personas plus a language-agnostic general reviewer in one parallel batch, merging their findings into one report, and optionally posting the ones you pick to the PR. Use before opening a PR, or to review a branch or someone else's PR. Persona packs add company and product conventions.
user_invocable: true
---

# Toolkit Review

Dispatch reviewer personas as sibling subagents in one parallel burst, then merge their findings. Each persona is a prompt file. `general` runs on every review. The others come from the project's configuration and from installed persona packs. No plugin is needed.

Scripts are under `.agents/skills/toolkit-review/scripts/` and import only `node:` modules. The project comes from `toolkit-context`, never from a config file: `node .agents/skills/toolkit-context/scripts/resolve.mjs`.

## Arguments

All optional, in any order:

- `--repo <name|owner/name>`: review a neighbor of this project instead of the current one (the resolver's `--repo`). Without it, review the project the resolver finds from the working directory. There is no registration step.
- `base:<sha-or-ref>`: use this as the diff base.
- `plan:<path>`: pass a plan path to reviewers so they can check requirements.
- `cwd:<path>`: review this checkout (the canonical clone, not a new worktree).
- A GitHub PR URL or `pr:<N>`: review that PR's diff (base and head from `gh pr view`) and offer Phase 5.

Read `project.name`, `project.root`, `project.trunk`, `project.remote.{host,slug}`, `stateRoot` and `writeAllowed` from the resolver. If it exits non-zero (no git repo and no config), stop and show its message.

## Phase 1: Prepare

All artifacts of a run go in one directory: `RUN=<stateRoot>/toolkit-review/<repo>-<pr-number|branch>-<head-sha7>`. `mkdir -p` it. Never read files from another run's directory: stale intent or context from an earlier PR has reached reviewers as current and produced false positives.

Budget: at most 6 Bash calls before dispatch. Do not read source files, build a hand-written dependency summary, or write a long intent summary here. Reviewers fetch what they need. Gather inputs, not analysis.

1. **Detect** (one call, with the resolver): repo, base SHA, head SHA, branch, PR metadata. With a PR target, the base and head come from `gh pr view`; set `GH_HOST` to `project.remote.host`.
2. **Existing PR comments** (PR targets only, with the PR metadata call): `node .agents/skills/toolkit-review/scripts/fetch-pr-threads.mjs <host> <owner/repo> <N> [<marker-text>] > $RUN/pr-comments.json`. Pass the `text` of `adapters.commentMarker` when one is set. Comments with `ours: true` are earlier review comments of this tool; `author_type: "Bot"` are other bots; the rest are people. `thread_resolved` is informational: judge "addressed" from the code. This feeds the re-review check (Phase 3) and the overlap check (Phase 5).
3. **Diff, sweep, personas, hooks** (one call, in this order):
   - `git diff -U10 <base>...HEAD > $RUN/diff.txt`
   - `node .agents/skills/toolkit-review/scripts/literal-sweep.mjs $RUN/diff.txt $RUN`. It greps only the added lines for fixed signals (type-checker escapes, lint suppressions, `useEffect(`, class-name selectors in tests, clickable `div`s, `console.log`, `TODO`, added comments, swallowed errors, fallback defaults, loose test assertions, plus any a persona pack adds) and writes `$RUN/sweep.md` and `$RUN/sweep-hits.tsv`. Hits are places to look, not findings.
   - `node .agents/skills/toolkit-review/scripts/resolve-personas.mjs --run $RUN --diff $RUN/diff.txt [--repo <name>]`. It picks the personas, applies their gates and compiles their rules (below).
   - `node .agents/skills/toolkit-review/scripts/run-hooks.mjs --run $RUN --diff $RUN/diff.txt --repo-path <repo root> --head <head sha>`. It runs the context hooks installed packs declare, for the personas that will be dispatched.
4. **Plan discovery** (Glob and Read, not counted): find `plans/*.md` referenced in the PR body, branch name or `plan:` argument.
5. **Intent summary**: from the PR body, commit log or diff. For a local branch record the head SHA and merge-base. Say so if the worktree is dirty or a rebase did not move HEAD: a diff built from a stale tree reviews the wrong code.
6. **Second-opinion preflight**, only if `toolkit-second-opinion` is installed (see `references/dispatch.md`).

If the diff is empty after checking committed, staged and untracked changes, say "No changes detected. Stage or commit changes before running review." `git add -N <file>` makes untracked files show in `git diff HEAD`.

If a script exits non-zero or its output is missing, skip what depended on it and record a coverage gap in the Phase 4 table. Do not abort the review.

Do not create a worktree. Reviewers read any file at any commit with `git -C <repo> show <sha>:<path>`. A large checkout costs a minute or more, twice on a re-run.

### How personas are chosen

`resolve-personas.mjs` prints JSON (also saved as `$RUN/personas.json`). Each entry has `status`:

- `dispatch`: send it. It has `personaFile` (absolute) and, for rule personas, `rulesFile` and `ruleCount`.
- `skipped`: a gate was not met, or the persona has zero rules for this project. Record `skipped (<reason>)` in the Coverage table. Do not dispatch it.
- `gap`: the project configures the persona but no installed file provides it. Record it in the Coverage table as a coverage gap and say which pack to install.

Personas come from `review.personas` (`adapters.personas`). With none configured the run is `general` plus the default cross-cutting personas whose gates apply. A persona is found in this skill's `personas/`, then in sibling `toolkit-review-*` packs; rules are merged from the same places. Gates are frontmatter in the persona file: `paths`, `sweep`, `diff`. A repo can be polyglot, so gates look at the languages in the diff, not the repo. `references/packs.md` has the rules, the gate table, and how to write a pack. If every rule persona skips, dispatch `general` alone and say so.

## Phase 2: Dispatch all reviewers in one batch

Dispatch every reviewer directly from this skill, never through another review skill: that adds a second round of scope detection and forces sequential ordering.

Send all selected reviewers in a single message of parallel `Agent` calls, with `run_in_background: false`. Never split the batch. Splitting is the largest avoidable cause of slow runs: a measured 8-reviewer run split 4+4 took about 6 minutes, against about 3.5 for one batch. If the message is too large, drop a conditional reviewer before splitting. `general` is never the one dropped.

`references/dispatch.md` has the prompt checklist, which files each reviewer gets, the dependency-context note, hook outputs, and the cross-vendor `general`. Read it before you build prompts.

Before sending, confirm:

1. No reviewer was dispatched earlier in this run. If one was, the batch is already split; stop.
2. Every `dispatch` persona is in the message, and nothing `skipped` or `gap` is. A skipped persona's absence is correct, not a split.
3. `run_in_background` is `false`.
4. If the second-opinion preflight said `ready`, its background Bash call is in the same message. If it said `fallback`, so is the fallback Agent.

### What each reviewer is

- **`general`** runs on every review with no compiled rules. It judges whether the change is the minimal correct solution, and catches regressions against the base version, duplicate logic, skipped contract members, behaviour shipped with no test, and deletions of code still in use. It defers convention calls to the rule personas. Give it the base SHA as well as the head SHA, because it reads base versions of modified functions.
- **Rule personas** read their own `rulesFile`. Each persona file enforces the severity rubric and its own verification rules.
- **Cross-cutting personas** in core: `fix-root-causes` (guards, fallbacks, retries and swallowed errors that hide a state that should never occur, and bug fixes that leave sibling instances), `test-behavior` (does each new test fail when the behaviour breaks and survive an internals refactor), `no-comments` (keep only comments the code cannot carry; constraint comments become tests; flag suppressions that hide a real bug). Language-bound core personas: `react-patterns`, `typescript-conventions`.

## Phase 3: Merge and present

Wait for all reviewers. If one has not returned after 10 minutes, proceed without it and record it as a coverage gap.

**Prove sweep coverage first.** Save each reviewer's JSON to `$RUN/reviewers/<persona>.json` (the cross-vendor `general` as `general-<model>.json`). Then run `node .agents/skills/toolkit-review/scripts/check-sweep-coverage.mjs --hits $RUN/sweep-hits.tsv --reviewers $RUN/reviewers --dispatched <comma-separated personas>`. Every hit needs a `sweep_dispositions` entry from a dispatched owner. A pack may also require the note to name something specific. Exit 1 lists unreviewed or unproven hits: send each owning persona its rows once with SendMessage, overwrite its file with the new return, and check again. Rows still open go in the Coverage table and the verdict. Exit 2 means a return does not match `schemas/reviewer-output.schema.json`: ask that persona again. A clean result with unanswered hits is the failure this step catches.

Then merge:

1. **Validate.** Drop malformed returns (`references/finding-schema.md`). Spot-check each finding's `line` against the head file (`git show <head>:<path> | sed -n '<line>p'`). A line that does not hold the cited code is usually a `diff.txt` line number: re-resolve it.
2. **Consequence gate.** Move any finding with an empty or generic `consequence` ("could cause issues") into `checked_left_alone` with that reason.
3. **Verify-before-P0 gate.** A P0 must cite the call site that passes the unchecked input and the type that admits the bad value. If either is missing, downgrade to P2 and re-decide `blocking` from its consequence per the rubric, before the confidence gate.
4. **Confidence gate**, using severity as of step 3. Suppress findings below 0.60. A finding still P0 survives at 0.50 or more.
5. **Deduplicate.** Fingerprint: `normalize(file) + line_bucket(line ±3) + normalize(title)`. On a match keep the highest severity and confidence, `blocking: true` if any agreeing reviewer said so, union the evidence, and note every agreeing reviewer.
6. **Reconcile severity.** When reviewers disagree, apply the anchors in `references/severity-rubric.md`. Only agreement of two or more reviewers makes the higher severity win automatically.
7. **Agreement boost.** When two or more independent reviewers flag the same issue, add 0.10 confidence (cap 1.0). `general` and the cross-vendor `general` count as two.
8. **Separate pre-existing** issues.
9. **Re-review check** (PR targets with earlier comments from this tool). For each earlier `ours_kind: "review"` comment, re-read its line at the current head and decide from the code, never from whether the thread is resolved: `addressed`, `still open`, or `answered` (the author gave a reason that holds). Drop new findings that repeat a still-open comment.
10. **Route by mode.** `comment` findings to the severity tables, `question` to Questions for the Author, `human_eyes` to Needs Human Eyes. Union every persona's `checked_left_alone`.
11. **Sort.** P0 to P3, then blocking first, then confidence descending, then file, then line.

## Phase 4: Render the report

Use pipe-delimited tables grouped by severity, in the format of `references/report-template.md`. Never render findings as prose. Omit empty sections:

- Header: repo, scope, intent, reviewer team
- Findings by severity (P0 to P3), with Blocking, What goes wrong and Fix sketch columns
- Questions for the author
- Needs human eyes (never postable)
- Checked, but left alone
- Previously posted (re-reviews only): each earlier comment with status and URL
- Pre-existing issues
- Residual risks and Testing gaps (union across personas)
- Requirements completeness (only with a plan: check each R# against the diff)
- Verdict: Ready, Ready with fixes, or Not ready, keyed on open blocking findings; it names any sweep hits still unreviewed
- Coverage table: per persona, status (`completed`, `skipped (<gate>)`, `gap`, timed out), finding count, absent context files, and the sweep-coverage summary line

Number findings in one sequence across all tables (`#1`, `#2`, ...). Phase 5 selects by number. End the report with the Phase 5 prompt from `references/report-template.md` when the target is someone else's PR, or the fix prompt there on the user's own.

## Phase 5: Post selected findings to the PR

Only for a GitHub PR target. `references/posting.md` has the full procedure. In short:

- On someone else's PR, post nothing until the user names finding numbers. That selection is the approval. Re-check the head SHA and overlap with existing comments first. Draft each body in the user's voice (`references/comment-voice.md`), then post each into the user's pending review with `node .agents/skills/toolkit-pr-comment/scripts/post-comment.mjs`. Never submit the review.
- On the user's own PR, offer `fix <nums>` and make the fixes locally instead of posting.
- Resolve only our own threads, only on request.

## Notes

- **No plugin dependency.** Do not dispatch another plugin's reviewers: some crash on the output-token limit and drop out of the session's agent registry. `general` covers correctness, testing and maintainability.
- **Paths, not blobs.** Pass compiled rules, the diff and context files to subagents as file paths.
- **Plan-driven review.** With `plan:<path>`, every reviewer's prompt includes the plan path so they can surface R# gaps.
- **Adding rules.** Add a `.md` file under `rules/<persona>/` in core or in a pack, with frontmatter per `rules/_template.md`. Product-specific rules belong in a pack.
- **Checks.** `node .agents/skills/toolkit-review/scripts/check-persona-sources.mjs` verifies every configured persona has a persona file and a rules directory, and that frontmatter is well formed. Tests: `node --test .agents/skills/toolkit-review/scripts/review.test.mjs`.

## Reference files

| File | Read it when |
| --- | --- |
| `references/dispatch.md` | You build reviewer prompts in Phase 2, or a hook or the cross-vendor reviewer is involved. |
| `references/packs.md` | A persona is missing, or you add a persona, rule or pack. |
| `references/finding-schema.md` | You validate a reviewer's return, or write a persona. |
| `references/severity-rubric.md` | You reconcile severity in Phase 3. |
| `references/report-template.md` | You render the report. |
| `references/posting.md` | The target is a PR and the user picked findings. |
| `references/comment-voice.md` | You draft a comment body for posting. |
