---
name: factory-repo-register
description: Onboard or refresh a repo's .agents/factory-metadata/project.json by checking each field against the repo itself (trunk, remote host and slug, package manager, commands, PR template, worktree convention) and writing only what zero-config detection doesn't already give. Can add a neighbor repo. Use when setting up a repo for the toolkit, when its toolchain or trunk changed, or when a skill reports a wrong trunk, host or command.
user_invocable: true
---

# Repo register

`.agents/factory-metadata/project.json` holds one repo's settings. Zero-config detection already reads trunk, host, package manager, a few commands and the PR template from git, so the file should hold only what detection gets wrong or can't know. This skill checks each field against the repo and writes the difference.

It never edits anything but `.agents/factory-metadata/project.json`.

## Run it

From the repo (or one of its worktrees; it writes to the main checkout):

```bash
node .agents/skills/factory-repo-register/scripts/register.mjs --dry-run
```

Stdout is the proposed file. Stderr is the report:

- `add`: fields written because they differ from detection.
- `drift`: a field already in the config that no longer matches the repo. Kept as is.
- `check`: judgment calls to confirm with the user (see below).

`--dry-run` is the default. When the proposal looks right:

```bash
node .agents/skills/factory-repo-register/scripts/register.mjs --write
```

`--write` validates the result with `factory-context/scripts/validate.mjs` and refuses to write an invalid file. On an existing config it adds missing fields and keeps the rest, because a deliberate override (a deploy trunk that isn't `origin/HEAD`) looks like drift. `--refresh` replaces drifted fields with the verified values; use it only after the user agrees.

## What it verifies

| Field | Source |
|---|---|
| `trunk` | `refs/remotes/origin/HEAD` |
| `remote` | `origin` URL. An SSH alias is resolved through `~/.ssh/config` to its real host and kept as `sshAlias`. An `upstream` remote with another slug marks origin as a fork and sets `upstream`. |
| `packageManager` | lockfile, then the `packageManager` field in `package.json` |
| `commands` | `package.json` scripts, Makefile targets, or the build tool's defaults (maven, gradle, cargo, go, uv). `install` is included. A missing command stays unset; nothing is invented. |
| `prTemplate` | the file under `.github/` or the repo root, with its exact case. Several templates in a folder: not set, reported. |
| `worktreeConvention` | `git worktree list`: `.worktrees/` is `dot-worktrees`, a `<repo>-<slug>` sibling is `sibling-directory`; `none` is not written. |

Compare with what detection gives: `node .agents/skills/factory-context/scripts/resolve.mjs --no-cache` in a repo with no config.

## Neighbors

```bash
node .agents/skills/factory-repo-register/scripts/register.mjs --neighbor <name>[:read|write] --write
```

The neighbor must be a git checkout at `../<name>`. `read` is the default and is omitted from the file. Use `write` only when the user wants skills to change that repo without asking. The neighbor's own trunk and commands come from its own config or detection.

## Review personas

```bash
node .agents/skills/factory-repo-register/scripts/register.mjs --persona <name> --write
```

Adds `<name>` to `review.personas`, which `factory-review` reads. It checks first that `personas/<name>.md` exists in `factory-review` or an installed `factory-review-*` pack, and the error lists the installed ones. Repeat the flag to add several. It never removes one: delete it from `review.personas` by hand.

## Confirm before writing

Report every `check` line and anything you judged. The register cannot know:

- a deploy trunk that differs from `origin/HEAD` (set `trunk` by hand);
- which of several PR templates applies;
- whether `writeAllowed: false` should be set for a team repo;
- reviewer cohorts and bot policy for `factory-pr-mining` (`mining`; see that skill).

Do not commit the file. A local-only install keeps `.agents/factory-metadata/` out of git through `.git/info/exclude`; leave that as it is.

Test: `node --test bundles/core/factory-repo-register/scripts/register.test.mjs`.
