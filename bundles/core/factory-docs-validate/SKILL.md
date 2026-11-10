---
name: factory-docs-validate
description: Skill-hygiene checks for any repo with agent skills, in one deterministic command. Checks SKILL.md frontmatter (name matches directory, description at most 600 chars), run-directly guards that skip realpath, `timeout` in shell scripts, orphaned scripts and references in a skill, and plan frontmatter. Use before committing a skill or plan change, in a pre-commit hook or CI, and when a skill script silently does nothing.
---

# Docs validate

One command runs every check over `<project.root>/.agents/skills` and the plans directory (`project.planHome` from `factory-context`, default `plans`). It reads files and changes nothing. Node only, no install.

```bash
node .agents/skills/factory-docs-validate/scripts/validate.mjs                 # all checks
node .agents/skills/factory-docs-validate/scripts/validate.mjs --only orphans,no-timeout
node .agents/skills/factory-docs-validate/scripts/validate.mjs --list          # checks and exit bits
```

Other flags: `--cwd <dir>` (default the current directory), `--skills <dir>` and `--plans <dir>` (override the two directories), `--verbose` (print the resolved paths).

## Checks

| Bit | Check | Fails when |
|---|---|---|
| 1 | `skill-frontmatter` | a `SKILL.md` has no frontmatter, its `name` differs from its directory, or its `description` is missing or over 600 characters (descriptions load into every session) |
| 2 | `main-guard` | a skill `.mjs` or `.js` file (tests excluded) compares `process.argv[1]` with `import.meta.url` without `realpathSync`. Agents reach skills through the `.claude/skills` symlink, so the paths differ and the script does nothing and exits 0 |
| 4 | `no-timeout` | a skill `.sh` file runs `timeout` as a command. macOS has none, so the guarded step never runs |
| 8 | `orphans` | a file under a skill's `scripts/` or `references/` is named by no other file in the skills directory. Tests (`*.test.*`, `*.guard.*`) are exempt. Reference the file from the skill that uses it, or delete it |
| 16 | `plan-frontmatter` | a plan (`<planHome>/*.md`, `README.md` excluded) lacks `title`, `status`, `repos` or `created`, has a `status` outside `draft`, `active`, `completed`, `abandoned`, a bad `YYYY-MM-DD` date, or is completed or abandoned without a `completed` date |

## Exit codes

- `0`: every selected check passed.
- Otherwise the sum of the failing checks' bits, so `5` means `skill-frontmatter` and `no-timeout` failed. With `--only <check>` the exit is that check's bit.
- `64`: bad usage.

Each problem prints as `path:line  message`. A check with no skills or plans to look at passes.

## Hook and CI

```bash
node .agents/skills/factory-docs-validate/scripts/validate.mjs || exit 1
```

Put that in the repo's pre-commit hook or a CI step. A bundle's own checks (a registry schema, a map, a rule) run beside it. A companion skill such as `factory-docs-validate-<bundle>` names those and where they run.

Tests: `node --test .agents/skills/factory-docs-validate/scripts/validate.test.mjs`.
