---
name: toolkit-plan-create
description: Create an implementation plan from the plan template, with optional ticket data from the configured tracker. Triggers on "create a plan", "start a new plan", "scaffold a plan", "plan this ticket", "write up an implementation plan", or any request to produce a plan file before starting work.
user_invocable: true
---

# Plan creation

Create a plan file from the template, optionally seeded from a ticket, and say what to do next. A plan is a local working file. The ticket (or the PR bodies) holds what lasts; Step 6 harvests the plan into it.

**If a `toolkit-plan-create-*` companion skill is installed, read it first.** It adds fields and conventions for a particular stack (for example extra Manual Test Plan fields).

Script paths below assume the skills are installed under `.agents/skills/`.

## Step 0: Resolve the project

```bash
R=.agents/skills/toolkit-context/scripts/resolve.mjs
node $R --field project.root
node $R --field project.planHome     # exit 1: use "plans"
node $R --field adapters.tracker     # exit 1: no tracker configured
node $R --field neighbors            # other repos a plan may touch
```

Plans go in `<project.root>/<project.planHome or plans>/`, flat, as `feat-<title>.md`. Create the directory if it's missing. Whether plans are tracked is the repo's call (a plan is a working file, so most repos exclude them).

## Step 1: Gather information

Ask the user (AskUserQuestion or plain questions):

1. **Plan title** (required), kebab-case, e.g. `trip-planner-enhancements`. It becomes the filename.
2. **Ticket key** (optional), only when a tracker is configured. Leave empty for none. Check the format with `tracker.mjs parse --text <input>`; `{"status":"none"}` means it isn't a ticket key.
3. **Affected repositories** (multi-select): this project, plus each name from `neighbors`. Default: this project only. Another repo the user names that isn't a neighbor goes in too, as free text.
4. **Publish a copy?** Default is local only. Offer a published copy only when a tracker is configured, and only once per session; reuse the answer. An explicit request ("publish it", "local only") overrides.

## Step 2: Fetch ticket data (when a ticket was given)

```bash
T=.agents/skills/<adapters.tracker>/scripts/tracker.mjs
node $T get --ticket <KEY>
```

On `ok`, take `ticket.title`, `ticket.url`, `ticket.type` and `ticket.description`. On `skipped` (no credentials) or `error`, show the `detail` and ask the user whether to continue without ticket data, retry with another key, or cancel. If no tracker is configured, say "no tracker configured; skipped ticket fetch" and take the summary from the user.

**A chat thread as the source:** read it with whatever tool the harness has, and record the newest reply's timestamp in the plan's References, so a later re-read from that point shows only what is new.

## Step 3: Generate the plan

Read `references/plan-template.md` and fill it in. Frontmatter:

```yaml
---
title: "{plan-title}"
status: "draft"
ticket: "{KEY or empty}"
ticket_url: "{url from get, or empty}"
ticket_summary: "{title from get, or empty}"
repos: [{selected repos}]
created: {YYYY-MM-DD}
pr_links: []
---
```

Body:

- With a ticket, use its title as the plan title and its description as the Overview. Without one, use the user's title and leave the Overview as "Brief description."
- Label the root cause **observed** (cite the payload, log line, or code branch you read) or **hypothesis** (say what would confirm it). A guess written as fact gets copied into the ticket and shared comments, and stays there after the implementation disproves it.
- For a CSS-only or layout fix, make the acceptance line a measurement on every brand and the proof the before/after numbers in the PR body. Don't prescribe a unit test that pins a class or reads a stylesheet as text: reviewers reject those as adding no value.
- If the plan reads a spacing or position off a prototype or design screenshot, write down the raw pixel numbers (each edge, both sides) and state a target only from them. Don't explain a difference away ("side-bearing", "rounding") without a second measurement that shows it.
- Anything a teammate reads (a ticket comment, a published copy) must not cite this repo's plan or skill paths: they can't open them.

## Step 4: Write the file

Write `<plans dir>/feat-{plan-title}.md`.

## Step 4b: Publish a copy (only if chosen in Step 1)

The local file stays the source of truth; the copy is for teammates, who can't open local paths. Show the user the destination and title, and publish only after they confirm: the page or comment is visible to others.

```bash
node $T publish --file <plan> --target confluence --dry-run   # preview the converted body
node $T publish --file <plan> --target confluence [--space-id ID] [--parent-id ID]
node $T publish --file <plan> --target jira                   # a comment on the plan's ticket
```

The adapter's SKILL.md lists the guards (it refuses to overwrite a copy someone edited, refuses a body that cites local paths, and so on) and what it writes back into the frontmatter. Re-run the same command after editing the plan to update that copy; never create a second one. With no tracker configured, say "no tracker configured; skipped publishing" and stop. A finished plan is deleted in Step 6, but its published copy stays.

## Step 5: Next steps

Print:

```
Plan created: <path>

Next steps:
1. Review and edit the plan.
2. Update `repos` if needed.
3. In each affected code repo, create a worktree from its trunk. Take the trunk, worktree
   convention and PR template from `resolve.mjs --repo <name>` (or the repo's AGENTS.md); don't
   guess them. With a ticket, put the key in the branch name: `<type>/<KEY>-<name>`.
4. When ready for a PR, run /toolkit-pr-create. It uses the repo's PR template, links the ticket
   through the tracker adapter, and moves it to review.
```

Add each PR's URL to `pr_links` as it opens, and set `status` to `active` once the Manual Test Plan is filled in.

## Step 6: Harvest at the end

A plan is a working file, so the ticket is the only place its lasting parts survive. Run this when the plan's last PR merges or the work is abandoned.

To find finished plans nothing was watching:

```bash
node .agents/skills/toolkit-plan-create/scripts/reconcile-plan-prs.mjs            # report only
node .agents/skills/toolkit-plan-create/scripts/reconcile-plan-prs.mjs --apply    # deletes finished ticketless plans
```

`ready-to-complete`: every linked PR merged. `pending`: some did. `unverifiable`: `gh` couldn't tell. `no-signal`: the plan has no `pr_links`, so ask the user whether it is still live. A plan with a ticket is never deleted by `--apply`; the report prints its harvest command.

**Ask the user before harvesting when the end state is unclear:** a linked PR closed unmerged, one still open, or a follow-up you can't find a ticket for. Name what you found and what you'd do with it (close the open PR, drop that half, file the follow-up). Act on their answer, never on a guess.

1. Read the merged PR bodies and the ticket. Cut the plan down to what they don't already say: decisions and the options rejected, scope deliberately left out, follow-ups with no ticket of their own. Drop instructions to the implementing agent, unchecked boxes for work that shipped, and local scratch paths. Run `/unslop` (when installed) on what remains: a teammate reads it on the ticket. Repoint any tracked file that links to the plan at the PR or ticket.
2. If something is left, the plan has a ticket and a tracker is configured, show the user the dry run, then post it:
   ```bash
   node $T publish --file <plan> --target jira --harvest --dry-run
   node $T publish --file <plan> --target jira --harvest   # posts, then deletes the plan
   ```
   It drops the Setup and Handoff report sections and updates the plan's earlier ticket comment if there is one. A follow-up with no ticket goes to the user as a ticket to file, not into the comment.
3. If nothing is left, or there is no ticket or tracker, delete the file. A plan whose PR bodies already carry the cause, the scope calls, and the measurements has nothing to harvest.

## Files

- `references/plan-template.md`: the template.
- `scripts/reconcile-plan-prs.mjs`: plan-versus-PR report for Step 6 (`node:` only; needs `gh`). Test: `node --test scripts/reconcile-plan-prs.test.mjs`.
