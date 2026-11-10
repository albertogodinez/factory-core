---
name: factory-repo-status
description: Report how fresh this repo is against its trunk, its worktrees, and its stale or merged branches, and the same for each neighbor repo the project lists. Read-only. Use when asked "is my checkout current", "what worktrees or branches can I clean up", before cutting a worktree from trunk, or before work that spans a neighbor repo.
user_invocable: true
---

# Repo status

One script reads the repo you are in and the neighbors `factory-context` lists, and reports on each:

```bash
node .agents/skills/factory-repo-status/scripts/status.mjs            # this repo, then its neighbors
node .agents/skills/factory-repo-status/scripts/status.mjs --fetch    # git fetch --prune first (network)
node .agents/skills/factory-repo-status/scripts/status.mjs --no-neighbors
node .agents/skills/factory-repo-status/scripts/status.mjs --json
```

It only reads. It fetches only with `--fetch`, so without it the "behind origin" count reflects the last fetch; say so when the answer matters. Trunk and neighbor roots come from the resolver (`factory-context`), never from a list in this skill. With no neighbors configured, only this repo is reported. In a legacy multi-repo workspace the resolver lists every registered repo as a neighbor, so the same run covers all of them.

## What each section means

| Section | Meaning |
|---|---|
| Behind origin | commits on `origin/<trunk>` that local `<trunk>` lacks. Why it matters: a worktree cut from a stale trunk starts from old code. |
| Checked out, Dirty | the branch in the main checkout and its count of changed files |
| worktree `prunable` | git says the path or branch is gone; `git worktree prune` clears it |
| `merged` | the tip is already an ancestor of `origin/<trunk>` |
| `gone` | its upstream was deleted on the remote, which usually means the PR merged or closed |
| `stale` | more than 50 commits behind trunk and nothing committed in 30 days |
| `detached` | a worktree on a bare commit; check it before removing |

A squash or rebase merge puts new commits on trunk, so a squash-merged branch won't show `merged`; it usually shows `gone` once the remote branch is deleted. For a merged branch a script can't prove, check the PR (`gh pr list --head <branch> --state merged`) before deleting.

## Acting on it

Report the tables, then suggest commands and run none of them unasked:

- Refresh trunk: `git -C <root> checkout <trunk> && git -C <root> pull`.
- Prune: `git -C <root> worktree prune`.
- Remove a worktree: `git -C <root> worktree remove <path>` after confirming it has no uncommitted changes.
- Delete a branch: `git -C <root> branch -d <branch>`. Use `-d`, never `-D`, so git refuses a branch with unmerged work. Never delete trunk or the checked-out branch.

Wait for explicit approval before deleting anything, and list exactly what will be affected first. A `gone` branch with no merged PR is an abandoned PR; show it to the user rather than deleting it.

A repo with no `origin/<trunk>` ref (no remote, or never fetched) reports a note instead of a count.

Test: `node --test bundles/core/factory-repo-status/scripts/status.test.mjs`.
