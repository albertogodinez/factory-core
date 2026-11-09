---
name: principle-attack-the-premise
description: "Apply when two or more fixes that share one premise have failed the same gate. Write the premise down and test it directly before you write another fix that assumes it."
disable-model-invocation: true
---

# Attack the Premise

When two or more fixes that share one premise have failed the same gate, suspect the premise, not the fixes.

**Why:** Each failed fix is evidence against the belief it assumed. A third fix on the same premise spends effort where the evidence already says the cause is not.

**Pattern:**

- **Write the premise down.** The premise is the one sentence that every failed fix assumed.
- **Test the premise before the next fix.** Find an observation that would come out differently if the premise were false, and make it. Look at how the failures are distributed, not only at how large they are. Make the check a script you can rerun rather than a one-time look (the **principle-build-the-lever** skill).
- **Follow the evidence.** If it contradicts the premise, the cause is elsewhere. Look for what the failures have in common that the premise did not predict. If it confirms the premise, ask the next "why", and keep asking until the answer is a wrong decision in the code, not a consequence of an earlier one. The earlier fixes may have treated a consequence instead of the cause: the symptom is where a wrong state became visible, and the root cause is the first place the system did something it should not do.
- **Remove the condition instead of compensating for it.** Make the smallest change that removes the cause, behind one source of truth. If the evidence shows that one part always lands on the losing side, change what puts it there. A mechanism that cleans up after it leaves the cause in place and adds work on every run.

**Stop:** Do not start the next fix before the premise is written down and tested.

This principle questions a fact the current design assumes. It is distinct from rebuilding a design around a new requirement, as if that requirement had been a day-one assumption.
