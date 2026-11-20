# Phase: work

Build what the plan says, in the ticket's worktree, and prove it works. Read the state file first: `plan`, `worktree`, `branch`, `test_cmd`, `feature_entry`, and `findings` with `status: open`.

A `Task:` in your prompt narrows the run, such as fixing named findings. Then do only that, and keep the diff to it.

Finding `stack-resync` means the parent branch moved: merge `origin/<base>` into this branch with a merge commit, as `factory-stacked-pr` "After the parent moves" says. Resolve the conflicts, run `test_cmd`, push, and mark the finding fixed.

0. Bootstrap the worktree before anything else: run `node .agents/skills/factory-dev-slot/scripts/preflight.mjs`. It exits 1 on a symlinked `node_modules` or a Node that misses `.nvmrc`. Never link `node_modules` from the main checkout: it gives false `tsc` and test failures, and each one then reads as unrelated. Run the project's real install in this worktree (frozen lockfile), then `preflight` again.
1. Read the plan. Don't re-research what it already cites.
2. Implement it. Commit in small steps on the ticket's branch. Before each push run `stack.mjs guard --branch <branch> --owner <slug>` (`factory-stacked-pr`) and stop on exit 1; after it, `stack.mjs event ... pushed --head <sha>`.
3. Run `test_cmd` and the project's lint and build.
4. Validate in the running app when the change has a UI or behaviour you can see. Start the server with `factory-dev-slot`. Hand the browser work (driving the feature, recording, screenshots) to a subagent. Give it the `feature_entry` path and tell it to follow its `Driving it with` and `Gotchas` sections. Ask for pass or fail, an artifact path, and every driving step it had to work out (a selector, an input trick, a wait, a step that only works in one order). Ask for no images. Never read screenshots into this session.
5. Before you end, add what the subagent had to work out to `feature_entry`: a step under `Driving it with`, a trap under `Gotchas`. Edit only that file. The next run starts from it instead of finding the same things again.
6. Apply `principle-prove-it-works` before you call it done.

Handoff: `head_sha`, `test_cmd` if you changed it, and each finding you fixed (`status: fixed`).

Read `_exit.md` in this directory and follow it.
