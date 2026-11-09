# Maintain a verify skill

When the code changes and the model does not, the check can keep passing on code that no longer exists. That pass is the dangerous case, because it looks like a proof.

## Outcomes

Give each check one, and say which:

- **in sync**: no change since `syncCommit` alters what the model describes, and the result matches the skill.
- **updated**: the model now describes the new code, and the result matches.
- **bug**: the model describes the current code, and the code breaks the property. A finding, not drift.
- **blocked**: the model could not be brought in line or could not run. Say exactly why, and leave `syncCommit` where it is.

A check can be both updated and bug.

## Pass

1. **List the drift.** `node .agents/skills/toolkit-formal-verify/scripts/check-drift.mjs <skill>`. Each commit it lists touched a covered file; each missing symbol is code that moved.
2. **Run it as it is**, before changing anything, and record the result. A pass here only says the old description still holds.
3. **Read every listed commit**, and search trunk for code that moved or new code that writes the guarded state. Sort each change:
   - **No effect** on anything the model describes (check against the model, not the commit message).
   - **Shape changed**: a step split in two, a branch added, a new path to the guarded state. The model must change.
   - **Promise changed on purpose**, with evidence (tests, doc comment, commit message, ticket). The property changes; record the old wording, the new wording, and the evidence.
   - **Promise may be broken**: the code changed and nothing says the promise did. A failure after this is a bug candidate.
4. **Update from the code**, before you rerun, never shaped by what makes the check pass. Keep the bounds unless the change makes them wrong.
5. **Rerun and judge.** A pass: break the new code the way the property guards against, and confirm the check catches it. A fail: replay the path against the real code. A step that cannot happen means the model is wrong; every step happening means a bug, named with the commit that introduced it. A known finding that stops breaking: confirm with its replay, then mark it `fixed`.
6. **Update the skill**: covered files and symbols, the `Model ↔ code` lines, findings, and `syncCommit` set to the trunk commit you checked. Follow the skill once as the next agent would.

## Report

For each check: the outcome and the commits read; what changed in the model and why; the rerun result and the break that showed it can still fail; each bug as steps in the code's words, its harm, and the commit; and what the model still leaves out. Say outright which failures were drift and which were bugs. Commit the verification change on its own, apart from any product fix.
