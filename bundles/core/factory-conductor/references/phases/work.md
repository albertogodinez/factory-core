# Phase: work

Build what the plan says, in the ticket's worktree, and prove it works. Read the state file first: `plan`, `worktree`, `branch`, `test_cmd`, and `findings` with `status: open`.

A `Task:` in your prompt narrows the run, such as fixing named findings. Then do only that, and keep the diff to it.

Finding `stack-resync` means the parent branch moved: merge `origin/<base>` into this branch with a merge commit, as `factory-stacked-pr` "After the parent moves" says. Resolve the conflicts, run `test_cmd`, push, and mark the finding fixed.

1. Read the plan. Don't re-research what it already cites.
2. Implement it. Commit in small steps on the ticket's branch.
3. Run `test_cmd` and the project's lint and build.
4. Validate in the running app when the change has a UI or behaviour you can see. Start the server with `factory-dev-slot`. Hand the browser work (driving the feature, recording, screenshots) to a subagent: give it the feature map entry's driving steps and ask for pass or fail and an artifact path, not the images. Never read screenshots into this session.
5. Apply `principle-prove-it-works` before you call it done.

Handoff: `head_sha`, `test_cmd` if you changed it, and each finding you fixed (`status: fixed`).

Read `_exit.md` in this directory and follow it.
