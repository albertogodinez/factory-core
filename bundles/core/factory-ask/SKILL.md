---
name: factory-ask
description: Ask which installed skill fits a situation ("which skill do I use for X", "what's the flow for shipping a ticket", "is there a skill for reviewing a PR"), or what's waiting (queued lesson candidates and lesson branches, and where to review them). Routes over the skills actually installed in this repo, read from their frontmatter at run time, and answers with a command and a prompt to send. Does not start the work.
disable-model-invocation: true
---

# Toolkit ask

Nobody remembers every skill, so ask. Answer with the skill to run and a prompt the user can send. Don't start the work.

## The routing table is the installed skills

There is no hand-kept map. Build it each time:

```bash
node .agents/skills/factory-ask/scripts/routes.mjs                         # every installed skill, name and description
node .agents/skills/factory-ask/scripts/routes.mjs --query "watch CI and answer bot comments"   # ranked candidates
node .agents/skills/factory-ask/scripts/routes.mjs --cache --query "..."    # reuse a table kept in stateRoot while no SKILL.md changed
node .agents/skills/factory-ask/scripts/routes.mjs --dir ~/.claude/skills   # also search another skills directory
```

The ranking is keyword overlap with each skill's name and description. It narrows the field; it doesn't decide. Skills whose frontmatter has `disable-model-invocation` are still listed: they are real, and the user runs them by name.

## Rules

- **Read the skill before you recommend it.** Open `<skills-dir>/<name>/SKILL.md` for each skill you name. The description is orientation only. If the file disagrees with the description, the file wins; say so in one line.
- **Don't run it.** A help question gets a command and a prompt. Skills here spawn subagents, browsers and dev servers, which cost time and tokens, so the user sends the prompt. A message that asks for the work ("review my PR") is not a help question: use the skill and do it.
- **Ask at most one question.** Infer the need from the message and the conversation first. If it is still unclear, ask one multiple-choice question, with options drawn from the table (ship a change, something is broken, keep the repo healthy, steer this session), and answer only the part they pick.
- **Resolve the repo first when it changes the answer.** `node .agents/skills/factory-context/scripts/resolve.mjs` gives trunk, host, commands, neighbors and adapters. A skill that needs an adapter or a config field the repo lacks (a tracker, a comment marker, a mining cohort) isn't a fit until that is set; say what's missing.
- **If nothing fits, say so.** Don't stretch the nearest skill. Suggest `factory-reflect` if a past session shows the gap, or writing a new skill with `writing-for-agents`, when they are installed.
- **Name only installed skills.** A skill the table doesn't list isn't available here, whatever you remember of other repos.

## What's waiting

"What's waiting", "what's queued", "any lessons to review": answer from the queue, not the routing table.

```bash
node .agents/skills/factory-reflect/scripts/lessons.mjs queue
```

It lists queued candidates per source repo (kind, skill, summary, age) with the command that starts a session there, and the open lesson branches. Lead with the counts per repo, then that repo's start command and `/factory-triage`. Reviewing and landing happen in the source repo's own session, so give the command; don't start it. Without factory-reflect installed, say nothing is tracked here.

## Reply

Lead with the answer: the slash command and one sentence on why this one and not its nearest neighbour. Then one ready-to-send prompt in a code block, filled in with what you know (ticket key, PR number, URL). Then the path of the SKILL.md you read. Keep it short unless the user asked for the whole list.

```text
/factory-pr-ci-monitor #640. Watch CI to completion, then triage the bot review comments:
validate each against the tree, fix the valid ones, reply in-thread.
```

## The usual order of a change

Name a step only when the table has a skill for it, in this order; skip the rest:

1. Plan: a plan skill (`factory-plan-create`).
2. Find the code: a feature map (`factory-feature-map`).
3. Implement in a worktree; validate with the repo's own test and run skills.
4. Review: `factory-review`.
5. Record the flow: `factory-record-flow`.
6. Open the PR: `factory-pr-create`. Every posted comment goes through `factory-pr-comment`.
7. Watch CI and bot comments: `factory-pr-ci-monitor`.
8. Learn from it: `factory-reflect`.

Mid-session: `handoff` (to another agent or harness), `wait-what` (the last reply didn't land), `principle-*` skills (steer with a principle). Repo upkeep: `factory-repo-status`, `factory-repo-register`, `factory-pr-mining`. In a repo that owns skills: `factory-triage` (queued lesson candidates).

Test: `node --test bundles/core/factory-ask/scripts/routes.test.mjs`.
