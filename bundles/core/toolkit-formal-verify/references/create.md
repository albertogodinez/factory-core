# Create a verify skill

The result is a skill the next agent can follow without learning TLA+, and that the user can trust and act on.

## 1. Choose the promise from the code

Start where the user pointed (an area, a bug, a review finding). Otherwise pick the strongest target: a promise the code makes, where a break harms users and tests rarely reach the case that breaks it. Order of events, state that resets when a key changes, a flag copied a commit late, a stream that rebuilds state mid-turn. Choose the strongest one, not the easiest to model.

Write the property as the reader's sentence first (the PM, designer or reviewer who decides whether the behavior is right), then as a TLA+ invariant.

## 2. Pick the tool for the question

Whether events can happen in a bad order suits a model checker over a small model: TLA+ with `/statechart`, which reports each break as its shortest path in plain words. Whether a function behaves for every input suits a verifier that runs on the code; with none for this language, test the real function with generated inputs rather than modeling it by hand. Tell the user why you chose the tool.

## 3. Model from the code

Work in `<stateRoot>/statechart/<subsystem>/` (`node .agents/skills/toolkit-context/scripts/resolve.mjs --field stateRoot`). Every action and variable points to a file and symbol a reviewer can open. One indivisible step in the code is one action. Names come from the repo. Keep constants small so the run takes seconds.

## 4. Show the model can fail and can pass

- Run the model with `/statechart` on the code as it is.
- Break the guarded step in a copy of the model (remove the check, reorder the step) and confirm the property breaks.
- When the code already breaks it, write the variant that keeps the promise and confirm it passes, so the break is in the code and not in the model.

This checks the model. Step 8 checks the skill against a change in the real code.

## 5. Replay each finding against the real code

For each property the code breaks, write a test in `replay/` that drives the real code through the bug path, one step for each action. Run it in the product repo's worktree from `tmp/`, uncommitted there. When a step cannot happen in the code, the model is wrong: fix the model and say what was wrong.

## 6. Write the verify skill

Follow `verify-skill-contract.md`. Copy the model, config, view and replays into the skill. Set `syncCommit` to the trunk commit you modeled, and record each finding. In the repo's feature map, set `verified_by: [toolkit-verify-<repo>-<subsystem>]` on each feature entry whose behavior the promise describes. `toolkit-ask` builds its routes from each skill's frontmatter, so the new skill's `description` is what routes to it.

## 7. Design the gate around the change

The verify skill's `Does my change touch it?` steps run on someone else's change. They must read or run that change: rerunning the committed model checks the code at `syncCommit`, whatever the change does. Write down the input from a real change that turns the check red. When a replay feeds a value by hand that a real step computes, say which step it skips.

## 8. Prove the skill on a scratch change in the real code

Follow the new skill once as the next agent would, on a scratch change in a detached worktree of the product repo: one that breaks the property (remove the guard, reorder the step), or, when the code already breaks it, one that fixes the finding.

- `check-drift.mjs --repo <repo> --diff HEAD --worktree <path>` lists the skill as `touched`.
- The skill's `Does my change touch it?` steps, followed from the scratch code, change the result: the property breaks, or the finding's replay passes.
- Drop the scratch change and confirm the check is back where it started: passing, or failing only on the findings you report.

A verify skill that misses the scratch change, or has a step that does not run, is a draft: fix the skill or the model, not the scratch change. Then `npm run validate`.

## 9. Get a second opinion before the first commit

Run `/toolkit-second-opinion` on the new skill, its scripts and its replays, with the `general` and `test-behavior` toolkit-review personas as the lenses. A reviewer on the other vendor's model reads the gate cold, which is where its design flaws show. Settle each finding before you commit.

## Hand off

Tell the user what you verified, with which tool and why, the bounds, each finding in plain words with its path, how to run the check, and what it leaves out. Suggest a second target only when you found a close one.
