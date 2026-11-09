---
name: toolkit-stacked-pr
description: 'Create, maintain, and land a stack of dependent pull requests. Use GitHub''s `gh stack` extension where the host supports it; otherwise chain base branches by hand. Covers the two failure modes that make a hand-rolled stack look fine while it is broken: CI that never runs because of a base-branch trigger filter, and a squash-merged parent that strands the child''s commits off trunk. Triggers on "stack this PR", "stacked PR", "stack on top of", "split this into dependent PRs", "PR 2 of 3", "my parent PR merged, now what", "restack", "retarget the PR".'
user_invocable: true
---

# Stacked PRs

**Reach for `gh stack` before hand-rolling anything.** GitHub ships a first-party stacked-PR feature and
it automates the one step that is easy to get wrong.

```bash
gh stack --help                      # if this errors, it tells you the install command
gh extension install github/gh-stack
gh skill install github/gh-stack     # optional: the extension ships an agent skill too
```

Docs: [How-to](https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests) ·
[CLI reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands)

## First: is `gh stack` available on this repo's host?

If a `toolkit-stacked-pr-*` companion skill is installed, read it first. It carries host facts and repo names.

**Stacked PRs are a github.com feature.** The extension's local commands run anywhere, but `submit` / `link` / `merge` / `unstack` need a GitHub-side stack object that GitHub Enterprise Server may not have. Get the host from the resolver (`project.remote.host`, see `toolkit-context`). `github.com` means `gh stack`; any other host: probe it.

```bash
GH_HOST=<host> gh api graphql -f query='{__type(name:"PullRequest"){fields{name}}}' \
  -q '.data.__type.fields[].name' | grep stack   # "stack"/"stackEntry" = supported, empty = not
```

Empty means use the manual fallback below. A stack that spans repos on different hosts cannot be one `gh stack` stack.

| need | `gh stack` |
|---|---|
| start a stack | `gh stack init [--base <trunk>] [branches...]` |
| add a branch on top | `gh stack add [-Am "msg"] [branch]` (run from the topmost branch) |
| push branches only, no PRs | `gh stack push` |
| push + create/update all PRs and the stack link | `gh stack submit [--auto] [--open]` |
| **adopt branches you already made** (worktree flow) | `gh stack link [--base <trunk>] [--open] <bottom> … <top>` |
| see it | `gh stack view [--short\|--json]` |
| move around | `gh stack up/down/top/bottom/trunk`, `gh stack switch` (picker) |
| resume someone's stack, or one you left | `gh stack checkout <stack-no\|pr-no\|pr-url\|branch>` (bare = picker) |
| restructure (drop/fold/reorder/rename) | `gh stack modify` (`--continue` / `--abort`) |
| **parent merged, or you amended a lower commit** | `gh stack sync [--prune]`, or `gh stack rebase [--downstack\|--upstack]` |
| land it | `gh stack merge [<stack-no>\|<pr-no>] [--squash] [--yes]` |
| stop tracking | `gh stack unstack [--local]` |

Read exit codes, not just stderr: `2` not in a stack, `3` rebase conflict, `4` API failure,
`6` branch belongs to multiple stacks, `7` rebase already in progress, `8` stack locked.

### `gh stack link` fits a worktree workflow

If you already create branches by hand (one worktree per branch), `init`/`add` would redo that work. `link`
takes them **bottom -> top**, pushes, opens any missing PRs with the base chain correct, fixes any PR
whose base is wrong, and stores no local tracking state, so it cannot desync from the worktrees.

```bash
gh stack link --base <trunk> --open \
  refactor/PROJ-101-parent \
  refactor/PROJ-102-questionnaire \
  refactor/PROJ-103-child

gh stack link --base <trunk> 557 573 581   # or adopt already-open PRs, in stack order
```

Two things `link` does that bite:

- **It needs to resolve the repo.** With an SSH-alias remote (`git@<alias>:...`) it can fail with *"none of the git remotes ... point to a
  known GitHub host"*. Prefix `GH_REPO=<org>/<repo>`.
- **It rewrites the bottom PR's base to its idea of the trunk.** Without `--base` it can retarget
  the bottom PR from the real trunk to another long-lived branch and root the stack there. Always pass
  `--base <project.trunk>` from the resolver, then confirm:

```bash
GH_REPO=<org>/<repo> gh stack link --base <trunk> 716 722 723
gh api graphql -f query='{ repository(owner:"<org>",name:"<repo>"){ pullRequest(number:723){
  stack { number size baseRefName entries(first:20){ nodes { position pullRequest { number } } } } } } }'
```

Fixing a wrong base afterwards is `gh pr edit <bottom> --base <trunk>`, which an auto-mode
classifier may refuse; then the user has to run it. PR authoring (title, body, ticket, timeline) lives in
`toolkit-pr-create`; this skill owns the stack.

Prefer `gh stack submit` when you want `gh stack` to own the branches too. `--auto` skips its editor
and creates **drafts** unless you also pass `--open`. Local state lives in `.git/gh-stack`
(uncommitted, not shared), which is why `gh stack checkout <pr-url>` exists to pick up someone else's
stack.

`gh stack rebase` is the important one: when a branch's PR has merged it *"automatically switches to
`--onto` mode to correctly replay commits on top of the merge target."* That is exactly the squash-merge
problem below, solved by one command.

`gh stack merge` is all-or-nothing and cannot bypass branch protection. On a merge-queue base it
queues instead, picks its own merge method, and the PRs may land in separate groups.

## Before you open a stacked PR: two checks

Both are cheap, both were skipped once, and both cost real time to rediscover.

### 1. Will CI actually run on this base?

```bash
grep -A8 'pull_request:' .github/workflows/*.y*ml
```

Read the `branches:` list. If your base branch does not match it, **no workflow fires for the entire
life of the stack** — and `gh pr checks` will still show a short list of *passing* third-party checks
(gitStream, size labellers), which reads exactly like a green PR.

Observed: a workflow filtered `branches: [main, master, versions/*]`. A PR
based on `refactor/parent-branch` matched none of them and had **zero** workflow runs from
creation until it was retargeted. The `paths:` filter matched fine; the base filter was the blocker.

If you accept no CI, say so in the PR body — a reviewer glancing at a green checks list will otherwise
assume it was tested.

### 2. How does this repo merge?

```bash
git log --oneline -5 origin/<trunk>
```

Single `title (#NNN)` commits mean **squash**. That determines the endgame:

| parent merged via | what the child needs |
|---|---|
| merge commit | parent's commits are ancestors of trunk → `gh pr edit --base <trunk>`. No rewrite. |
| **squash** | parent's commits are **not** ancestors → retargeting alone re-presents the parent's whole change and conflicts. Needs `gh stack rebase` / `gh stack sync`, or manual `git rebase --onto`. |

## Manual fallback

For hosts with no stack object, and anywhere `gh stack` is unavailable. There is no GitHub-side stack object
here, so the PR body is the only place the stack is legible; see the section below it.

```bash
# create
git worktree add <worktree-dir>/<type>/<name> -b <type>/<TICKET>-<name> origin/<parent-branch> --no-track
gh pr create --base <parent-branch> --head <type>/<name>

# after the parent merges (squash case)
git fetch origin
git rebase --onto origin/<trunk> <old-parent-head>
gh pr edit <N> --base <trunk>
git push --force-with-lease origin <type>/<name>
```

> **Branch names should carry the ticket key** when the work has a ticket: `<type>/<TICKET>-<name>`.
> Tracker integrations often link off the **branch name**, not the PR title or commit messages. Renaming the branch
> of an open PR can close it; leave a pushed branch alone and link the ticket another way.

**De-risk the rebase first — it is free.** Replay the commits onto trunk in a throwaway worktree and run
the suite there before touching the real branch:

```bash
git worktree add --detach "$TMPDIR/rebase-test" origin/<trunk>
cd "$TMPDIR/rebase-test" && git cherry-pick <c1> <c2> <c3>   # all exit 0?
<the repo's test command>
git worktree remove --force "$TMPDIR/rebase-test"
```

## Make the stack legible in the PR body

A stacked PR with no explanation reads as one that mistargeted its base. State the tree, the merge
order, and the retarget plan:

```markdown
## Stack

PR 2 of 3. Stacked on #557.

<trunk>
  └── #557  PROJ-101  parent            [APPROVED]
        └── #573  PROJ-103  ← this PR

Merge order: #557 → this. Retarget toward `<trunk>` once #557 lands.
```

## Things that turned out not to be true

- **"Force-pushing stales the review threads."** It did not. After a rebase + `--force-with-lease`, all
  four inline threads survived with `outdated=false` and their replies intact. Do not choose the worse
  git strategy to protect threads that are not actually at risk — and never choose merge over rebase on
  a squash-merged parent, where merge is strictly worse.
- **"`gh pr checks` exiting non-zero means a check failed."** Exit code 8 means *not all passing yet*,
  which includes pending. Read the rows, not the exit code.
- **Never `cmd | tail` and then read `$?`** — that reports the pipe's status. Capture the exit code
  first: `cmd > /tmp/out 2>&1; echo "EXIT=$?"; cat /tmp/out`. Two real failures were reported as
  success this way, including an `npm install` that had failed outright.
