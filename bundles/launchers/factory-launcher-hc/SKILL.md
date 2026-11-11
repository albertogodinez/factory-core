---
name: factory-launcher-hc
description: Session-launcher adapter that starts an agent session in another repo with hc, so a lesson's source repo reviews and lands it in its own session. Set adapters.sessionLauncher to factory-launcher-hc. factory-reflect calls it; you don't run it by hand.
disable-model-invocation: true
---

# hc session launcher

An adapter for `adapters.sessionLauncher` (contract: `factory-context/references/adapters.md`). `launcher.json` is the whole adapter: `lessons.mjs candidate` fills in `{repo}` and `{prompt}` and prints the argv. The hc terminal outlives the session that started it, so the new session keeps going after the downstream one ends.

`tools.json` pins `hc` and `plannotator`: the lesson flow runs the review gate and the Inbox through plannotator, and this adapter starts sessions through hc. `factory-tool-sync` reports either one as MISSING, BELOW or BEHIND.

To use another agent CLI than `claude`, change the program in `launcher.json` and keep `{prompt}` as its first argument.
