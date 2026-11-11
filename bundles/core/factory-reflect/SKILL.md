---
name: factory-reflect
description: 'Run a retrospective on a session or PR and turn at most three durable lessons into structure: an automated check, a factory-review rule, a skill edit, a glossary term, or an AGENTS.md pointer. Three reviewer subagents mine the evidence, a synthesizer filters one-offs and labels each lesson repo, core or org, and a lesson seen three times across repos is offered for promotion into the shared skills. Use for /factory-reflect, "reflect", "retro", or a learnings phase.'
---

# Reflect

Mine a session for **lessons** and encode each one in structure, so the next agent can't repeat the mistake. A one-off isn't a lesson. A lesson a check could enforce becomes the check, and only the check: the instruction is the symptom. **Accept at most three lessons per run.** There is always something to fix; three good edits beat ten nobody reviews.

## 0. Resolve the project

```bash
node .agents/skills/factory-context/scripts/resolve.mjs
```

Lessons land in the project the resolver names (`project.root`), in the repo the session changed, not in a central toolkit. Read that repo's `AGENTS.md` (or `CLAUDE.md`) before editing anything. In zero-config mode, or with `writeAllowed: false`, propose edits but make none until the user says so.

## 1. Gather the evidence

Inputs, in order of preference:

- **The current session** (default). Claude Code: the newest `~/.claude/projects/<cwd-with-slashes-as-dashes>/*.jsonl` whose first user message matches this conversation's opening prompt. Codex: the newest file under `~/.codex/sessions/`. Stay inside the session's own project directory; never glob across other projects. If nothing matches, write a tight digest of the session instead.
- **A PR or branch** the user names: `gh pr view <N> --comments` (with `GH_HOST` from `project.remote.host`), its review threads (factory-review's `fetch-pr-threads` script, if installed), its commits, reverts and CI failures.

Skip the run when the session is trivial, or when every correction is already covered by a skill the agent followed correctly. Say so and stop.

## 2. Fan out three reviewers

Send one message with three parallel subagents. Give each one the prompt in `prompts/reviewer.md` verbatim, with the lens filled in (**judgment**, **tooling**, **divergent**) and the transcript path, PR reference or digest substituted. Reviewers only read; they never edit. When a coordinator delegated the work, add its hand-back review notes (what it caught only after the hand-back) as primary evidence beside the implementer's `Lessons seen:` list, which records friction rather than misses. Tell each reviewer to grep the transcripts for the moments it cites.

## 3. Synthesize

Fill `<KNOWN_FINGERPRINTS>` with the output of `node .agents/skills/factory-reflect/scripts/lessons.mjs known`. Then dispatch one subagent with `prompts/synthesizer.md` and the three reviewer outputs inlined. It returns Accepted (three at most, each with a scope and a fingerprint), Rejected and Backlog.

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
| The same mistake class seen twice or more | The `correct` skill, if installed | architecture, then types, then lint, then test, then docs |
| A judgement call a reviewer of the diff would catch | factory-review rule | Repo-specific: `.agents/skills/factory-review-local/rules/<persona>/<slug>.md` (a persona pack the repo owns). Generic: a core rule (scope `core`) |
| Review comments keep raising the same point across PRs | Mine it first | `factory-pr-mining`, if installed |
| A skill the session used had a missing step, a stale command or a wrong fact | Edit that skill | Its `SKILL.md` or `references/`; see the installed-copy rule below |
| A skill existed but didn't trigger | Tune its description | That skill's frontmatter `description` |
| A recurring workflow with no home | New skill | `.agents/skills/<name>/`, self-contained |
| A feature gotcha, code anchor or driving step | Feature map entry | `factory-feature-map`. A map installed from a bundle is scope `org`: its entry lands on the lesson branch now, with no promotion wait |
| A domain term the agent misread | Glossary term | The layer where it's true (factory-glossary's "Add or change a term"): the repo's `GLOSSARY.md` for a repo-only term, else a shared layer (scope `core` or `org`). A team repo with a local install keeps no glossary file. When `lookup.mjs --dupes` finds the term in two places, propose one entry in the shared layer and deleting the copies |
| The agent couldn't find a file, doc or command | One-line navigation pointer | The closest scoped `AGENTS.md` or `CLAUDE.md` |
| A decision with lasting rationale | Rationale, not structure | The PR body, the commit message, or the repo's wiki |

**Installed copies are never edited in place.** A skill listed in `.agents/factory-metadata/skills-lock.json` came from a bundle. An edit to that copy blocks `factory update`, and it never reaches other repos. Such a lesson has scope `core` or `org`: record it (§6) and change the skill at its source. A skill missing from the lock is the repo's own, so edit it here. In a linked worktree (`factory link`), `.agents/skills/<name>` is a link to the main checkout's installed copy, so an edit there is an in-place edit too.

Repo-local knowledge stays in its repo. In a local-only install, where the repo belongs to a team, an edit to a tracked file is a product change: it goes through the repo's normal branch and PR. The lesson log itself lives in `stateRoot`, which is never committed.

## 6. Record, apply after approval, and offer promotion

Present the synthesizer's output with its routed destinations, and wait for the user to pick rows; they may redirect a routing. When this skill runs as a background subagent, return the proposals instead and let the caller ask.

For each approved row:

1. **Record it**, whatever its scope:
   ```bash
   node .agents/skills/factory-reflect/scripts/lessons.mjs record --scope repo|core|org \
     --fingerprint <slug> --summary "<one line>" --destination <path> --status applied|proposed
   ```
   Every lesson goes to `<stateRoot>/lessons.jsonl`. A `core` or `org` lesson also goes to the machine-wide index at `~/.agents/factory/lessons-index.jsonl`, and the output reports how often it has been seen and in which repos.
2. **Apply the repo-scope ones here.**
   - **Check**: build it, then prove it goes red on the real past mistake (make the mistake, see it fail, revert). A check that never fails protects nothing.
   - **Skill, rule, AGENTS.md or glossary edit**: read `writing-for-agents` first. A one-line fix is done directly; a new section or a new skill follows its full guidance.
   - Run the repo's checks (`project.commands.lint` and `test`). Commit and push only under the user's standing authorization. A commit that touches a review rule names its source (the PR, ticket or `session`) in a `Source:` trailer; the rule itself states the lesson with no PR or ticket numbers.
3. **Core and org lessons become a candidate**, the handoff to the repo that owns the file. A repo-scope lesson stays here, in the PR that taught it.
   ```bash
   node .agents/skills/factory-reflect/scripts/lessons.mjs candidate --kind fact|pattern|harness --scope core|org \
     --skill <installed skill> --summary "<one line>" --session <session id> \
     --evidence '[{"transcript":"<path>","grep":"<words>"},{"pr":"<owner/repo#N>","thread":"<id>"}]' \
     [--draft <patch>] [--fixed-when '{"metric":"<signal>","match":"<command head>"}']
   ```
   - **kind**: `fact` (a stale command, a wrong path, a leaked secret, a broken script), `pattern` (a new rule or check, a reworded skill) or `harness` (permissions, hooks, settings). The kind sets the lane: a fact launches now, the others queue for triage, which batches a pattern with its family. Offer [Review now] [Queue] with that default; `--now` or `--queue` records the answer.
   - **evidence** is pointers: a transcript path and the words to grep, a PR and its thread. Never paste content.
   - **fixedWhen** names the signal that should drop once the lesson lands.
   - **lane `now`**: with `launch.argv`, run it; it starts a session in the source repo with the triage prompt. With `launch.via: print`, give the user `launch.command` and `launch.prompt` (they can run it with `!`). **lane `queue`**: the status hook in the source repo names it; a `harness` candidate also gets an Inbox notice (thread `factory lessons`, when `adapters.lessonInbox` is set), since it touches the user's config.
   - **`home: true`**: this session is in the source repo, so run `/factory-triage` on it here.

Then ask about whatever is due, at most three prompts per session:

```bash
node .agents/skills/factory-reflect/scripts/lessons.mjs due --session <session id>
```

Show each `prompt` line as it comes ("We've seen 'X' 3 times across 2 repos. Promote it to core? [promote / not now / never]"), and record the answer:

```bash
node .agents/skills/factory-reflect/scripts/lessons.mjs decide --fingerprint <slug> --decision promote|not-now|never --session <session id>
```

- **never** is remembered, and that fingerprint is never offered again.
- **not now** waits for another occurrence.
- Entries expire after 90 days without a new occurrence.
- **promote**: write it as a candidate (step 3) with `--now`. Writes outside this repo go only to `~/.agents/factory/`.

### Landing a lesson branch

This runs in the source repo's own session: `factory-triage` follows it for queued candidates, and a reflect run in a factory repo follows it for its own core or org lessons. A session lands only in its **home repo**, the repo it started in; downstream, a lesson is a candidate (§6 step 3), and `land` refuses anywhere else (`wrong-session`). Each run gets **one lesson branch per source repo**, with **one commit per lesson**, in its own worktree, so the main checkout never changes branch. Run every command below with `--repo <source repo>`.

1. **Pick the source repo.** For an installed skill, `lessons.mjs target --skill <name>` names it. For new content with no skill yet, write the draft to a file and run `lessons.mjs classify --file <draft>`: `org` means a company bundle (company-wide or product-specific), `core` means the generic core bundle. When a lesson has both parts, the generic rule goes in the core skill and the specifics in its company companion. When the source isn't on this machine, record the lesson, say where it has to land, and stop.
2. **Bring its trunk up to date** (`git -C <repo> pull --ff-only` in the checkout that has trunk checked out, else `git -C <repo> fetch origin <trunk>:<trunk>`), then `lessons.mjs start --repo <repo> --slug <run slug>`. Use the same slug for every repo in the run. It prints the worktree; make every edit there (read `writing-for-agents` first) and commit each lesson on its own. The repo's pre-commit hook runs its suite.
3. **Screen a core branch for internal data.** When an `internal-data` persona is installed (a company review pack), run `factory-review` on the core worktree with `resolve-personas.mjs --only internal-data`, and fix what it finds before the review.
4. **The review gate**, by `adapters.reviewUI` of the source repo (`resolve.mjs --cwd <repo>`). Note the head first: `git -C <worktree> rev-parse HEAD`.
   - `plannotator-review`: `plannotator review <worktree> --base <trunk> --diff-type merge-base --gate --json` prints `{decision, message}`. `annotated`: apply the feedback as commits, then review again. `dismissed`: leave the branch (step 6).
   - Unset: show `git -C <worktree> log --oneline <trunk>..` and each commit's diff, one at a time. Ask keep, drop or change for each; drop with `git rebase --onto`, change by amending and showing it again. Then ask once: merge it?
   - `adapters.lessonLanding: "pr"` (a source repo with other reviewers): push the branch and open the PR with `factory-pr-create` instead. The merge happens there.
5. **On approval, land it:** `lessons.mjs land --repo <repo> --branch <branch> --reviewed <head>`. It fast-forwards trunk, then removes the worktree and branch. `changed-since-review`: review again. `trunk-moved`: `git -C <worktree> rebase <trunk>`, run the repo's checks, and land again with the same `--reviewed`. Then run its `next` commands: the push needs no second question, because approving was the decision. The land ends at that push: each consumer pulls the change at its next session start, when the status hook says its skills changed upstream.
6. **A branch nobody decided on stays.** The factory status hook names it at the next session start, and `lessons.mjs open` lists every one with its commits and worktree. When `adapters.lessonInbox` is `plannotator-inbox`, also send one Inbox message: thread `factory lessons`, `idempotency_key` `<branch>@<head>`, with the repo, branch, worktree, commit subjects and the review command. The Inbox is the notice; the approval is always the review gate.

Backlog items (a check worth building but too large now) go to the user as a list to file.

## 7. Report

A short list, no preamble:

- **Edits made**: `<destination path>`: what changed, one line each. For a check, the command that proved it red.
- **Lesson branches**: each `lesson/*` branch still open in a source repo, with the repo path and a one-line diff summary.
- **Edits proposed** (not yet approved): `<destination path>`: one line each.
- **Recorded**: each fingerprint with its scope and occurrence count; any promotion answers given.
- **Backlog**: one line each, with the suggested mechanism.
- **Dropped**: one line per rejected finding, with the synthesizer's reason.

Tests: `node --test .agents/skills/factory-reflect/scripts/*.test.mjs`.
