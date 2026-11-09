---
name: toolkit-second-opinion
description: 'Get a review from the other vendor''s model: Codex when running in Claude Code, Claude (latest Opus) when running in Codex, read-only, with a same-harness background subagent as the fallback. Also checks that the pinned reviewer models are still the newest. Used by toolkit-review and show-me-your-work; use directly for "second opinion", "ask codex to review this", "have claude check this", "cross-model review", "are the reviewer models current", and before the first commit of a new skill that ships a gate, a check script or a replay.'
---

# Second Opinion

A reviewer on the same model as the author shares its blind spots. This skill hands a review prompt to the other vendor's CLI and returns its answer, or tells you to fall back to a subagent in the current harness.

If `toolkit-second-opinion-*` companion is installed, read it first.

## Run a review

1. Write the prompt to a file under `tmp/second-opinion/` (keep it untracked). It must stand alone: the reviewer sees nothing of this session. Give it the paths to read (diff, plan, persona file), what to look for, and the output format you want back. Tell it not to modify files.
2. Dispatch it, in the background when other work can run meanwhile:
   ```bash
   node .agents/skills/toolkit-second-opinion/scripts/dispatch.mjs \
     --prompt tmp/second-opinion/<slug>.md --out tmp/second-opinion/<slug>.out.md --cd <repo>
   ```
   Add `--preflight` (no other arguments) to learn which reviewer would run without running it. It takes about a second.

   When the user names a model, pass `--model <id>` (for Codex, take the id from `codex debug models`) instead of calling the CLI by hand: only the script checks the tree and handles fallback. The pin stays the default, and the JSON line gains `"pinned"` whenever the override differs from it, so say which model actually ran. After changing `dispatch.mjs`, run `node --test .agents/skills/toolkit-second-opinion/scripts/dispatch.test.mjs`: it runs the script against fake `codex` and `claude` binaries and calls no model.
3. Read the JSON line it prints:
   - `"status":"ok"`: the review is in `--out`. Attribute it as `reviewed by <model> (cross-harness)`, using the `model` field, which comes from the CLI's own report where it gives one.
   - `"status":"fallback"`: dispatch one `general-purpose` subagent with the same prompt and `model: "opus"`, in the background, and attribute it as `reviewed by <model> (fallback: <reason>)`. Never block the work on the CLI.
   - `"status":"nested"`: you are the reviewer. Do the review; do not start another one.
   - A `warning` field means the working tree changed during a review that was meant to be read-only. Show the user `git status` before going on.

Codex runs with `-s read-only --ephemeral`. Claude runs with `-p`, read and search tools, and git read commands only, capped at `claudeMaxBudgetUsd`. When Codex calls Claude, the call needs network and writes under `~/.claude`, so run it with escalated sandbox permissions.

The diff and prompt go to the second vendor's API. Do not send secrets or customer data in a prompt.

## Keep the models current

`references/models.json` pins one model per CLI, and each pin's `track` regex names the family it follows (the newest id the regex matches is "latest").

- `node .agents/skills/toolkit-second-opinion/scripts/check-models.mjs` is the offline check, fit for a pre-commit hook. It reads the snapshot of the live Codex list that the `--online` run saves to `tmp/model-catalog.json`, plus Claude Code's own catalog cache, takes milliseconds, and warns without failing. Codex's `~/.codex/models_cache.json` is not used: it also lists bundled models a ChatGPT sign-in cannot run.
- `node .agents/skills/toolkit-second-opinion/scripts/check-models.mjs --online` refreshes the Codex catalog with `codex debug models`, runs each tracked model once to drop ones the account cannot run, and exits 1 when a pin is stale. Run it when the offline check warns, or when a new model is announced.

`models.json` is also the one place your Codex default model is set: the check reports `DRIFT` when the `model` line in `~/.codex/config.toml` differs from the codex pin, and `check-models.mjs --sync` writes the pin there. Claude Code needs no sync, because its settings use the `opus` alias, which follows the newest Opus.

When a pin is stale, update `model` and `verified` in `models.json`, then run `check-models.mjs --sync`. Catalogs differ per account: a model the check reports as missing may only need `codex update`, or an access grant from whoever gates frontier models for your org.
