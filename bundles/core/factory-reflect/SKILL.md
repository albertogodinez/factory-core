---
name: factory-reflect
description: 'Run a retrospective on a session or PR and turn durable lessons into structure, checks first: a check, review rule, skill edit, glossary term, or (last) an AGENTS.md pointer. Three reviewers mine the evidence, a synthesizer filters one-offs, and every lesson is queued, without asking, for the repo that owns it (repo, core or org). Use for /factory-reflect, "reflect", "retro", or a learnings phase.'
---

# Reflect

Mine a session for **lessons** and encode each one in structure, so the next agent can't repeat the mistake. A one-off isn't a lesson. A lesson a check could enforce becomes the check, and only the check: the instruction is the symptom.

**Reflect asks nothing and edits nothing.** Every accepted lesson, whatever its scope, becomes a **candidate** queued for the repo that owns it: this repo for a repo lesson, the core or org source repo otherwise. There is no cap and no picking. Triage in the owner repo dedupes the queue, clusters it into families and builds one lesson branch, and **its review is the only gate**: the user decides on a real diff, not on a summary.

**Prefer a check to prose.** A lint rule, test, or script guard enforces itself and costs no context. A feature map entry comes next: skills read it to reach, drive and measure the app, so it acts almost like a check. `AGENTS.md` is always loaded, so it takes only a one-line navigation pointer, and only when nothing else fits. Never add a rule, a judgement call or an explanation there.

## 0. Resolve the project

```bash
node .agents/skills/factory-context/scripts/resolve.mjs
```

Lessons land in the project the resolver names (`project.root`), in the repo the session changed, not in a central toolkit. Read that repo's `AGENTS.md` (or `CLAUDE.md`) before editing anything. In zero-config mode, or with `writeAllowed: false`, propose edits but make none until the user says so.

## 1. Gather the evidence

Inputs, in order of preference:

- **The current session** (default). Claude Code: the newest `~/.claude/projects/<cwd-with-slashes-as-dashes>/*.jsonl` whose first user message matches this conversation's opening prompt. Codex: the newest file under `~/.codex/sessions/`. Stay inside the session's own project directory; never glob across other projects. If nothing matches, write a tight digest of the session instead.
- **A PR or branch** the user names: `gh pr view <N> --comments` (with `GH_HOST` from `project.remote.host`), its review threads (factory-review's `fetch-pr-threads` script, if installed), its commits, reverts and CI failures.

- **Pending repo lessons** left `proposed` by an older reflect run, when the status hook named them: `node .agents/skills/factory-reflect/scripts/lessons.mjs pending`. Skip §2 to §4 and hand each one over as a repo candidate (§6 step 2), then record it `--status queued`.

Skip the run when the session is trivial, or when every correction is already covered by a skill the agent followed correctly. Say so and stop.

## 2. Fan out three reviewers

Send one message with three parallel subagents. Give each one the prompt in `prompts/reviewer.md` verbatim, with the lens filled in (**judgment**, **tooling**, **divergent**) and the transcript path, PR reference or digest substituted. Reviewers only read; they never edit. When a coordinator delegated the work, add its hand-back review notes (what it caught only after the hand-back) as primary evidence beside the implementer's `Lessons seen:` list, which records friction rather than misses. Tell each reviewer to grep the transcripts for the moments it cites.

## 3. Synthesize

Fill `<KNOWN_FINGERPRINTS>` with the output of `node .agents/skills/factory-reflect/scripts/lessons.mjs known`. Then dispatch one subagent with `prompts/synthesizer.md` and the three reviewer outputs inlined. It returns Accepted (each with a scope, a candidate kind and a fingerprint, with no cap) and Rejected.

## 4. Check for duplicates before proposing anything new

For every Accepted row that adds a rule, check, skill or term, search the existing structure first:

```bash
grep -rliE '<keyword>|<synonym>' .agents/skills/factory-review*/rules .agents/skills/factory-review*/personas
grep -rliE '<keyword>' .agents/skills/*/SKILL.md AGENTS.md GLOSSARY.md CONTEXT.md 2>/dev/null
node .agents/skills/factory-glossary/scripts/lookup.mjs '<term>'   # every glossary layer, if factory-glossary is installed
```

If an existing rule or skill already says it, the failure was in execution. Tighten its wording or placement so it fires, rather than adding a second copy.

## 5. Route each lesson

Pick the highest row that works. Mechanical beats judgement. Judgement goes to review, where the reviewer has the diff and the least context pressure, not into the implementer's always-loaded files.

| Lesson | Destination | Path |
| --- | --- | --- |
| Mechanical: a fixed pattern a script can detect (wrong path, banned API, missing field, bad import, file in the wrong place) | Automated check | The repo's own lint or test (`project.commands`), or a skill's own guard in its `scripts/` |
| A feature gotcha, code anchor, driving step, or a state the app must be checked in | Feature map entry | `factory-feature-map`. A map installed from a bundle is scope `org`: its entry is a `fact` candidate |
| The same mistake class seen twice or more | The `correct` skill, if installed | architecture, then types, then lint, then test, then docs |
| A judgement call a reviewer of the diff would catch | factory-review rule | Repo-specific: `.agents/skills/factory-review-local/rules/<persona>/<slug>.md` (a persona pack the repo owns). Generic: a core rule (scope `core`) |
| Review comments keep raising the same point across PRs | Mine it first | `factory-pr-mining`, if installed |
| A skill the session used had a missing step, a stale command or a wrong fact | Edit that skill | Its `SKILL.md` or `references/`; see the installed-copy rule below |
| A skill existed but didn't trigger | Tune its description | That skill's frontmatter `description` |
| A recurring workflow with no home | New skill | `.agents/skills/<name>/`, self-contained |
| A domain term the agent misread | Glossary term | The layer where it's true (factory-glossary's "Add or change a term"): the repo's `GLOSSARY.md` for a repo-only term, else a shared layer (scope `core` or `org`). A team repo with a local install keeps no glossary file. When `lookup.mjs --dupes` finds the term in two places, propose one entry in the shared layer and deleting the copies |
| The agent couldn't find a file, doc or command, and no check, skill description or glossary entry would have led it there | One-line navigation pointer (last resort) | The closest scoped `AGENTS.md` or `CLAUDE.md`. If the edit is longer than one line, or the file already has a similar line, route it elsewhere |
| A decision with lasting rationale | Rationale, not structure | The PR body, the commit message, or the repo's wiki |

**Installed copies are never edited in place.** A skill listed in `.agents/factory-metadata/skills-lock.json` came from a bundle. An edit to that copy blocks `factory update`, and it never reaches other repos. Such a lesson has scope `core` or `org`: record it (§6) and change the skill at its source. A skill missing from the lock is the repo's own, so edit it here. In a linked worktree (`factory link`), `.agents/skills/<name>` is a link to the main checkout's installed copy, so an edit there is an in-place edit too.

Repo-local knowledge stays in its repo. In a local-only install, where the repo belongs to a team, an edit to a tracked file is a product change: it goes through the repo's normal branch and PR. The lesson log itself lives in `stateRoot`, which is never committed.

## 6. Record and queue, without asking

Show the synthesizer's table, each row led by its lane in brackets (`[now: fact]`, `[queue: pattern]`, `[queue: harness]`), then go straight on. Don't wait for the user to pick rows: the review gate in the owner repo is where they decide. If the user says in this chat to drop a row or redirect it, do that; a row they reject for good is a **never** (below). When this skill runs as a background subagent, do the same and return the report.

For each Accepted row:

1. **Record it**, whatever its scope:
   ```bash
   node .agents/skills/factory-reflect/scripts/lessons.mjs record --scope repo|core|org \
     --fingerprint <slug> --summary "<one line>" --destination <path> --status queued
   ```
   Every lesson goes to `<stateRoot>/lessons.jsonl`. A `core` or `org` lesson also goes to the machine-wide index at `~/.agents/factory/lessons-index.jsonl`, and the output reports how often it has been seen and in which repos.
2. **Queue it as a candidate** for the repo that owns the file:
   ```bash
   node .agents/skills/factory-reflect/scripts/lessons.mjs candidate --kind fact|pattern|harness --scope repo|core|org \
     --skill <installed skill> --summary "<one line>" --session <session id> \
     --evidence '[{"transcript":"<path>","grep":"<words>"},{"pr":"<owner/repo#N>","thread":"<id>"}]' \
     [--draft <patch>] [--fixed-when '{"metric":"<signal>","match":"<command head>"}']
   ```
   - **scope** `repo`: a lesson for this repo (its check, lint, feature map entry, review rule or pointer). The candidate is owned by this repo's main checkout and lands here through triage. `core` or `org`: it lands in that source repo.
   - **kind**: `fact` (a stale command, a wrong path, a leaked secret, a broken script), `pattern` (a new rule or check, a reworded skill) or `harness` (permissions, hooks, settings). The kind sets the lane, with no question: a fact launches triage now, the others queue until the owner repo's triage is due.
   - **evidence** is pointers: a transcript path and the words to grep, a PR and its thread. Never paste content.
   - **fixedWhen** names the signal that should drop once the lesson lands.
   - **lane `now`**: with `launch.argv`, run it; it starts a session in the owner repo with the triage prompt. With `launch.via: print`, give the user `launch.command` and `launch.prompt` (they can run it with `!`). With `home: true` (the owner repo is this one), run `/factory-triage` on it here after the report.
   - **lane `queue`**: nothing to run. The owner repo's status hook names the queue when triage is due, and a session start there, or the triage schedule, launches triage.

A lesson the user rejects for good is a **never**: `lessons.mjs decide --fingerprint <slug> --decision never`. `known` lists it, and triage drops its family from then on.

### Landing a lesson branch

This runs in the owner repo's own session, when `factory-triage` lands its queued candidates. A session lands only in its **home repo**, the repo it started in; anywhere else a lesson is a candidate (§6 step 2), and `land` refuses (`wrong-session`). Each run gets **one lesson branch per source repo**, with **one commit per lesson**, in its own worktree, so the main checkout never changes branch. Run every command below with `--repo <source repo>`.

1. **Pick the source repo.** For an installed skill, `lessons.mjs target --skill <name>` names it. For new content with no skill yet, write the draft to a file and run `lessons.mjs classify --file <draft>`: `org` means a company bundle (company-wide or product-specific), `core` means the generic core bundle. When a lesson has both parts, the generic rule goes in the core skill and the specifics in its company companion. When the source isn't on this machine, record the lesson, say where it has to land, and stop.
2. **Bring its trunk up to date** (`git -C <repo> pull --ff-only` in the checkout that has trunk checked out, else `git -C <repo> fetch origin <trunk>:<trunk>`), then `lessons.mjs start --repo <repo> --slug <run slug>`. Use the same slug for every repo in the run. It prints the worktree; make every edit there (read `writing-for-agents` first) and commit each lesson on its own. The repo's pre-commit hook runs its suite.
3. **Screen a core branch for internal data.** When an `internal-data` persona is installed (a company review pack), run `factory-review` on the core worktree with `resolve-personas.mjs --only internal-data`, and fix what it finds before the review.
4. **The review gate**, by `adapters.reviewUI` of the source repo (`resolve.mjs --cwd <repo>`). Note the head first: `git -C <worktree> rev-parse HEAD`.
   - `plannotator-review`: a guided review first, then the gate. Plannotator has no flag that writes a guide when a review opens (its own writer starts by hand from the Agents tab), so write it first and import it. `guide.mjs` is `.agents/skills/factory-reflect/scripts/guide.mjs`.
     1. **Target.** When the branch has an open PR (`gh pr view <branch> --json url -q .url`, with `GH_HOST` from the source repo's `project.remote.host`), review the PR. Its comments are posted on the PR (through `gh`) when the review's destination is GitHub, which is the default; Plannotator remembers the last pick, so tell the user to check it says GitHub, not Agent. Otherwise review the worktree.
     2. `node guide.mjs prep --worktree <worktree> --base <trunk> [--pr <url>]`. It begins a managed `factory-teardown` run, writes the patch and brief (`prompt`), names the `guide` path and prints the `review` command. Successful import finishes the run and releases its patch/prompt while retaining guide evidence. An explicit `--out` gets a unique user-managed directory and stays outside automatic cleanup.
     3. Dispatch one subagent on the newest Sonnet (the `sonnet` model alias). Prompt: "Read `<prompt>` and follow it; write only `<guide>`." Where the harness can't pick a model, run `claude -p --model sonnet` on the same prompt, if the `claude` CLI is installed.
     4. `node guide.mjs import --worktree <worktree> --guide <guide> --patch <patch> [--pr <url>] --model sonnet`. On `bad-guide`, send its message back to the same subagent once. If it's refused again, open the gate without a guide and say so.
     5. Run the `review` command in the background with a long timeout. It prints `{decision, message}`, and the guide is listed under Guides. `annotated`: apply the feedback as commits, then review again, with a new guide. An annotation that says to **drop** a commit removes that cluster from the branch (`git rebase --onto` past it); one that says **never** also records `lessons.mjs decide --fingerprint <cluster slug> --decision never`. Either way its candidates close as `dropped`. `dismissed`: leave the branch (step 6).
   - Unset: show `git -C <worktree> log --oneline <trunk>..` and each commit's diff, one at a time. Ask keep, drop or change for each; drop with `git rebase --onto`, change by amending and showing it again. Then ask once: merge it?
   - `adapters.lessonLanding: "pr"` (a repo with other reviewers), and **always for a repo-scope branch in a team repo** (a local-only install, where a tracked-file edit is a product change): push the branch and open the PR with `factory-pr-create`. The gate then reviews that PR, and the merge happens there.
5. **On approval, land it:** `lessons.mjs land --repo <repo> --branch <branch> --reviewed <head>`. It fast-forwards trunk, then removes the worktree and branch. `changed-since-review`: review again. `trunk-moved`: `git -C <worktree> rebase <trunk>`, run the repo's checks, and land again with the same `--reviewed`. Then run its `next` commands: the push needs no second question, because approving was the decision. The land ends at that push. A source repo with the factory trunk hook copies the change into every installed repo itself; otherwise each consumer's status hook says its skills changed upstream at its next session start.
6. **A branch nobody decided on stays.** The factory status hook names it at the next session start, and `lessons.mjs open` lists every one with its commits and worktree. When `adapters.lessonInbox` is `plannotator-inbox`, also send one Inbox message: thread `factory lessons`, `idempotency_key` `<branch>@<head>`, with the repo, branch, worktree, commit subjects and the review command. The Inbox is the notice; the approval is always the review gate.

## 7. Report

A short list, no preamble:

- **Queued**: each candidate with its lane, scope and owner repo, and the launch command for a `now` lane.
- **Recorded**: each fingerprint with its scope and occurrence count.
- **Dropped**: one line per rejected finding, with the synthesizer's reason.
- **Next**: when triage is due in each owner repo, or that a `now` lane launched it.

Tests: `node --test .agents/skills/factory-reflect/scripts/*.test.mjs`.
