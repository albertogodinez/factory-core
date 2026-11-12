---
name: factory-launcher-hc
description: Session-launcher adapter that starts an agent session in another repo with hc, so a lesson's source repo reviews and lands it in its own session. factory setup turns it on for the machine when hc is on PATH. factory-reflect calls it; you don't run it by hand.
disable-model-invocation: true
---

# hc session launcher

An adapter for `adapters.sessionLauncher` (contract: `factory-context/references/adapters.md`). `factory setup` sets it in `~/.agents/factory/config.json` when `hc` is on PATH, and factory-reflect reads `launcher.json` from this bundle, so no repo installs it; install the bundle only to get its `tools.json` pins checked there. `launcher.json` is the whole adapter: `lessons.mjs candidate` fills in `{repo}` and `{prompt}` and prints the argv. The hc terminal outlives the session that started it, so the new session keeps going after the downstream one ends.

`tools.json` pins `hc` and `plannotator`: the lesson flow runs the review gate and the Inbox through plannotator, and this adapter starts sessions through hc. `factory-tool-sync` reports either one as MISSING, BELOW or BEHIND.

`{agent}` is the agent CLI the machine picks (`adapters.agentCLI` in `~/.agents/factory/config.json`; `claude` when unset), and `{prompt}` is that agent's way of running the triage skill.
