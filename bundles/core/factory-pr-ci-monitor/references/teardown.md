# After merge: tear down this PR's footprint

Run this when the PR is **merged**, not when it is green or approved. An approved PR can take another commit, and a branch deleted before merge takes that commit's only copy with it. If the skill is invoked on an already-merged PR, skip scheduling and run this.

**Read the state, never infer it.** `gh pr view <N> --json state,mergedAt,mergeCommit` must say `MERGED`. A PR watched to green and left alone is often merged hours later by someone else, and advice given on the pre-merge picture ("this merges first", "that edits the same file") goes stale silently. Re-read before acting on anything that depends on merge order.

**Touch only this PR's footprint:** its worktree, its branch, the servers and timers this session started for it, its `<stateRoot>/factory-pr-ci-monitor/pr-<N>.json`. Never sweep other worktrees or branches because they look stale.

If `writeAllowed` is false, confirm each destructive step with the user.

1. **Stop what this session started** for the PR: dev servers, a local backend, watchers. Confirm the ports are free. Delete the monitor's scheduled job if it is still pending.
2. **Remove the worktree and local branch.** If a worktree was made for this PR, remove it with `git worktree remove <path>`, then delete the local branch. Delete the branch with `git branch -d` and use `-D` only after checking the PR's commits are in the merge commit (a squash merge leaves the branch looking unmerged). If `git worktree remove` refuses because of local changes, report it; don't force.
3. **Leave the remote branch** unless the user asks. Report which remote refs remain. The durable fix is the repository's "automatically delete head branches" setting.
4. **Fast-forward local trunk** (`git pull --ff-only` on `project.trunk`) and confirm it is clean, so the next branch starts from what actually merged.
5. **Close out tracking.**
   - If `adapters.tracker` is set, run the adapter's after-merge steps: comment the merge SHA and what shipped, then move the ticket to its terminal status. If it is unset, skip this and say so.
   - If the repo has a feature map, clear entries that were waiting on this PR: `node .agents/skills/factory-feature-map/scripts/clear-pending-prs.mjs --pr <PR URL> --apply`, then commit the change. Skip it if that skill isn't installed.
   - Check any design decision records whose consequences describe code this PR changed: a "this stays" line about something the PR deleted is now false.
6. **Report** what was removed and what was kept, and why.

A closed-but-unmerged branch (a proof of concept, a superseded attempt) goes the same way only if the remote still holds it and the PR or ticket links to it, since that link is then the only index to the work.
