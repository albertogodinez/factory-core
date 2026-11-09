---
name: toolkit-formal-verify
description: "Create or maintain a formal verify skill for one subsystem of a registered repo, and check which verify skills a PR or new commits make stale. Use for /toolkit-formal-verify, \"model-check this race\", \"prove this invariant\", or \"is the model still true to the code\"."
disable-model-invocation: true
---

# Formal verify skills

A test checks the cases someone thought to write. A formal check covers every case in a stated scope: every order of steps in a model, or every input up to a bound. This skill builds one such check for one subsystem, as a skill of its own, and keeps it true to the code as the code changes.

A feature map (`toolkit-features-<repo>`) says how to reach and drive a feature. A verify skill says which promise one subsystem keeps, and proves it. They sit side by side: the feature entry names the verify skill in `verified_by`.

```
.agents/skills/toolkit-formal-verify/                 this skill: create, maintain, check drift
.agents/skills/toolkit-verify-<repo>-<subsystem>/     one per verified subsystem
  SKILL.md            the promise, when a change touches it, how to run and read the check
  coverage.json       covered files and symbols, the sync commit, the known findings
  model/              the model (TLA+ by default), its config, the statechart view
  replay/             a test that replays each bug path against the real code
```

The shape of a verify skill is in [references/verify-skill-contract.md](references/verify-skill-contract.md). Read it before writing or editing one.

## Create

Follow [references/create.md](references/create.md): choose the promise from the code, model it, show the check failing on a broken variant, replay each finding against the real code, write the verify skill, design its gate around the change under review, prove it on a scratch change in the real code, then get a cross-model second opinion before the first commit.

## Maintain

Follow [references/maintain.md](references/maintain.md) after merges or edits that touched covered code without rerunning the check. Each check ends **in sync**, **updated**, **bug**, or **blocked**.

## Check drift

```bash
node .agents/skills/toolkit-formal-verify/scripts/check-drift.mjs [<verify-skill>...] [--fetch] [--strict] [--json]
node .agents/skills/toolkit-formal-verify/scripts/check-drift.mjs --repo <repo> --pr <N> | --diff <base>...<head> [--worktree <path>] [--strict] [--json]
```

- **No `--pr` or `--diff`:** for each verify skill, it lists the commits on the sibling's trunk since `syncCommit` that touch covered files, and covered symbols that are gone from trunk. Either one makes the skill **stale**: run maintain.
- **`--fetch`** fetches the sibling's trunk first. Without it, a local `origin/<trunk>` that does not contain `syncCommit` exits 2 rather than reading as in sync; the output names the trunk commit it compared against.
- **`--pr` / `--diff`:** it lists the verify skills whose covered files the change touches. The committed model describes `syncCommit`, so a touched skill needs its `Does my change touch it?` steps: read the change against the model, rerun a copy edited from the branch's code, and say the result in the PR body. The skill itself moves to the new code after the merge, through maintain.
- Exit 0 when nothing is stale or touched. A stale or touched skill exits 1 under `--strict`, 0 otherwise. Bad input or a missing sync commit exits 2. A sibling that is not cloned is a warning.

Tests: `node --test .agents/skills/toolkit-formal-verify/scripts/drift.test.mjs .agents/skills/toolkit-formal-verify/scripts/check-drift.test.mjs`. The first also checks the hand validation against `coverage.schema.json` when `ajv` is installed.

## Rules

- Edit only the verification (models, replays, the verify skill, `coverage.json`) during create and maintain. A property the code breaks is a finding: report it with the bug path, and fix product code only when the user asks.
- Keep the property as the reader agreed it. A check that passes because the property or the model was weakened proves nothing.
- Read every TLA+ result with `/statechart`, by name. Copy none of its commands or paths into a verify skill; they change between releases.
- Move `syncCommit` only after you confirm the model describes the code at that commit.
- Models and replays run from `<stateRoot>` (`node .agents/skills/toolkit-context/scripts/resolve.mjs --field stateRoot`); nothing is committed to the product repo.
- Commit on the toolkit's `main`, like other toolkit work.
