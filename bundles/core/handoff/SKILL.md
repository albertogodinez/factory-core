---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Writes the document only; starts no agent, pane or session.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to `<stateRoot>/handoffs/<timestamp>-<slug>.md`, where `<stateRoot>` is `node .agents/skills/factory-context/scripts/resolve.mjs --field stateRoot` (`mkdir -p` it first). The state directory is untracked and per worktree, so the handoff never lands in a commit.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (plans, whether a local file, a Confluence page or a Jira comment; tickets, PRs, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user wants the handoff run, say so and offer the exact command or a subagent to run it.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
