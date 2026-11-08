---
name: toolkit-reflect
description: 'Run a retrospective on a session or PR and turn at most three durable lessons into structure: an automated check, a toolkit-review rule, a skill edit, a glossary term, or an AGENTS.md pointer. Three reviewer subagents mine the evidence, a synthesizer filters one-offs and labels each lesson repo, core or org, and a lesson seen three times across repos is offered for promotion into the shared skills. Use for /toolkit-reflect, "reflect", "retro", or a learnings phase.'
---

# Reflect

Mine a session for **lessons** and encode each one in structure, so the next agent can't repeat the mistake. A one-off isn't a lesson. A lesson a check could enforce becomes the check, and only the check: the instruction is the symptom. **Accept at most three lessons per run.** There is always something to fix; three good edits beat ten nobody reviews.

## 0. Resolve the project

```bash
node .agents/skills/toolkit-context/scripts/resolve.mjs
```

Lessons land in the project the resolver names (`project.root`), in the repo the session changed, not in a central toolkit. Read that repo's `AGENTS.md` (or `CLAUDE.md`) before editing anything. In zero-config mode, or with `writeAllowed: false`, propose edits but make none until the user says so.

## 1. Gather the evidence

Inputs, in order of preference:

- **The current session** (default). Claude Code: the newest `~/.claude/projects/<cwd-with-slashes-as-dashes>/*.jsonl` whose first user message matches this conversation's opening prompt. Codex: the newest file under `~/.codex/sessions/`. Stay inside the session's own project directory; never glob across other projects. If nothing matches, write a tight digest of the session instead.
- **A PR or branch** the user names: `gh pr view <N> --comments` (with `GH_HOST` from `project.remote.host`), its review threads (toolkit-review's `fetch-pr-threads` script, if installed), its commits, reverts and CI failures.

Skip the run when the session is trivial, or when every correction is already covered by a skill the agent followed correctly. Say so and stop.

## 2. Fan out three reviewers

Send one message with three parallel subagents. Give each one the prompt in `prompts/reviewer.md` verbatim, with the lens filled in (**judgment**, **tooling**, **divergent**) and the transcript path, PR reference or digest substituted. Reviewers only read; they never edit. When a coordinator delegated the work, add its hand-back review notes (what it caught only after the hand-back) as primary evidence beside the implementer's `Lessons seen:` list, which records friction rather than misses. Tell each reviewer to grep the transcripts for the moments it cites.

## 3. Synthesize

Fill `<KNOWN_FINGERPRINTS>` with the output of `node .agents/skills/toolkit-reflect/scripts/lessons.mjs known`. Then dispatch one subagent with `prompts/synthesizer.md` and the three reviewer outputs inlined. It returns Accepted (three at most, each with a scope and a fingerprint), Rejected and Backlog.

## 4. Check for duplicates before proposing anything new

For every Accepted row that adds a rule, check, skill or term, search the existing structure first:

```bash
grep -rliE '<keyword>|<synonym>' .agents/skills/toolkit-review*/rules .agents/skills/toolkit-review*/personas
grep -rliE '<keyword>' .agents/skills/*/SKILL.md AGENTS.md GLOSSARY.md CONTEXT.md 2>/dev/null
```

If an existing rule or skill already says it, the failure was in execution. Tighten its wording or placement so it fires, rather than adding a second copy.

## 5. Route each lesson

Pick the highest row that works. Mechanical beats judgement. Judgement goes to review, where the reviewer has the diff and the least context pressure, not into the implementer's always-loaded files.

| Lesson | Destination | Path |
| --- | --- | --- |
| Mechanical: a fixed pattern a script can detect (wrong path, banned API, missing field, bad import, file in the wrong place) | Automated check | The repo's own lint or test (`project.commands`), or a skill's own guard in its `scripts/` |
| The same mistake class seen twice or more | The `correct` skill, if installed | architecture, then types, then lint, then test, then docs |
| A judgement call a reviewer of the diff would catch | toolkit-review rule | Repo-specific: `.agents/skills/toolkit-review-local/rules/<persona>/<slug>.md` (a persona pack the repo owns). Generic: a core rule (scope `core`) |
| Review comments keep raising the same point across PRs | Mine it first | `toolkit-pr-mining`, if installed |
| A skill the session used had a missing step, a stale command or a wrong fact | Edit that skill | Its `SKILL.md` or `references/`; see the installed-copy rule below |
| A skill existed but didn't trigger | Tune its description | That skill's frontmatter `description` |
| A recurring workflow with no home | New skill | `.agents/skills/<name>/`, self-contained |
| A feature gotcha, code anchor or driving step | Feature map entry | `toolkit-feature-map` |
| A domain term the agent misread | Glossary term | The repo's `GLOSSARY.md` or `CONTEXT.md` |
| The agent couldn't find a file, doc or command | One-line navigation pointer | The closest scoped `AGENTS.md` or `CLAUDE.md` |
| A decision with lasting rationale | Rationale, not structure | The PR body, the commit message, or the repo's wiki |

**Installed copies are never edited in place.** A skill listed in `.ai-toolkit/skills-lock.json` came from a bundle. An edit to that copy blocks `factory update`, and it never reaches other repos. Such a lesson has scope `core` or `org`: record it (§6) and change the skill at its source. A skill missing from the lock is the repo's own, so edit it here.

Repo-local knowledge stays in its repo. In a local-only install, where the repo belongs to a team, an edit to a tracked file is a product change: it goes through the repo's normal branch and PR. The lesson log itself lives in `stateRoot`, which is never committed.

## 6. Record, apply after approval, and offer promotion

Present the synthesizer's output with its routed destinations, and wait for the user to pick rows; they may redirect a routing. When this skill runs as a background subagent, return the proposals instead and let the caller ask.

For each approved row:

1. **Record it**, whatever its scope:
   ```bash
   node .agents/skills/toolkit-reflect/scripts/lessons.mjs record --scope repo|core|org \
     --fingerprint <slug> --summary "<one line>" --destination <path> --status applied|proposed
   ```
   Every lesson goes to `<stateRoot>/lessons.jsonl`. A `core` or `org` lesson also goes to the machine-wide index at `~/.ai-toolkit/lessons-index.jsonl`, and the output reports how often it has been seen and in which repos.
2. **Apply the repo-scope ones here.**
   - **Check**: build it, then prove it goes red on the real past mistake (make the mistake, see it fail, revert). A check that never fails protects nothing.
   - **Skill, rule, AGENTS.md or glossary edit**: read `writing-for-agents` first. A one-line fix is done directly; a new section or a new skill follows its full guidance.
   - Run the repo's checks (`project.commands.lint` and `test`). Commit and push only under the user's standing authorization. A commit that touches a review rule names its source (the PR, ticket or `session`) in a `Source:` trailer; the rule itself states the lesson with no PR or ticket numbers.
3. **Core and org lessons wait for the promotion prompt.** Don't edit the shared skill yet, unless the user says "promote now".

Then ask about whatever is due, at most three prompts per session:

```bash
node .agents/skills/toolkit-reflect/scripts/lessons.mjs due --session <session id>
```

Show each `prompt` line as it comes ("We've seen 'X' 3 times across 2 repos. Promote it to core? [promote / not now / never]"), and record the answer:

```bash
node .agents/skills/toolkit-reflect/scripts/lessons.mjs decide --fingerprint <slug> --decision promote|not-now|never --session <session id>
```

- **never** is remembered, and that fingerprint is never offered again.
- **not now** waits for another occurrence.
- Entries expire after 90 days without a new occurrence.
- **promote**: `lessons.mjs target --skill <name>` names the source repo of the skill the lesson changes. Edit the skill there on a local branch, `lesson/<fingerprint>`, commit, and ask the user to review the branch. After they merge it, `factory update --all` delivers it to every repo. Writes outside this repo go only to `~/.ai-toolkit/` and, on promote, to that source repo.

Backlog items (a check worth building but too large now) go to the user as a list to file.

## 7. Report

A short list, no preamble:

- **Edits made**: `<destination path>`: what changed, one line each. For a check, the command that proved it red.
- **Edits proposed** (not yet approved): `<destination path>`: one line each.
- **Recorded**: each fingerprint with its scope and occurrence count; any promotion answers given.
- **Backlog**: one line each, with the suggested mechanism.
- **Dropped**: one line per rejected finding, with the synthesizer's reason.

Tests: `node --test .agents/skills/toolkit-reflect/scripts/index.test.mjs`.
