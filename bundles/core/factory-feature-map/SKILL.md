---
name: factory-feature-map
description: Create, maintain, or check a per-repo feature map, the index from a user-facing feature (description, design links, screenshots) to how to reach it, how to drive it, and the exact code anchors to change. Maps live in the repo that owns the feature. Use for "create a feature map", "map this feature", "add X to the feature map", "audit the feature map", "is the feature map stale".
user_invocable: true
---

# Feature maps

A feature map lets an agent go from "the compare carousel" or a design frame to the three files that implement it without reading the codebase. It is per repo because each repo is reached, driven and inventoried differently.

```
<project.root>/.agents/skills/
  factory-feature-map/                 this skill: the contract, the checker, the templates
  factory-features-<project.name>/     the map, owned by the repo it describes
    SKILL.md                           launch, auth, drive, evidence, cleanup for that repo
    design-authority.json              repo default plus rare feature overrides
    features/README.md                 index + baseline preconditions
    features/<id>.md                   one file per user-facing feature
    scripts/inventory.mjs              lists the repo's user-facing surfaces (types: scripts/inventory.d.ts)
```

The map goes in the repo that owns the feature, not in a hub. Every script finds it through `factory-context` (`project.root`, `project.name`), or takes `--map <dir>`. Run scripts from inside the repo, or pass `--cwd <dir>`.

**To find a feature, don't use this skill.** Open the repo's map skill (`factory-features-<name>`), read its `features/README.md`, then only the matching file.

Read [references/entry-contract.md](references/entry-contract.md) before writing or editing any feature file.

## Anchors

An anchor in `code` or `tests` names a file or directory and optional `symbols`. Its `repo` field is:

- omitted, or the project's own name: relative to `project.root`;
- a neighbor's name (`neighbors[].name` in `factory-context`): relative to that neighbor's root, `../<name>` unless the config says otherwise.

Anchors never carry line numbers. A neighbor that isn't cloned is skipped with a warning.

## Check

```bash
node .agents/skills/factory-feature-map/scripts/check-map.mjs [--map <dir>] [--cwd <dir>] [--strict] [--json] [--verbose]
```

It validates:

- frontmatter against `schemas/entry.schema.json` (unknown keys are warnings), and `design-authority.json` against its schema;
- section order, and that the index links every feature file and every link resolves;
- every `code` and `tests` anchor, and that each listed symbol appears in the file (or anywhere under a directory);
- `app_recipe`, when set, by running the map's `scripts/replay-app.mjs --check`;
- the output of the map's `inventory.mjs` against `schemas/inventory.schema.json`. Surfaces no feature `covers` are `unmapped`, an error under `--strict`.

Anchor severity:

- An own-repo anchor that doesn't resolve is an error, because the map and the code ship together.
- A neighbor anchor is an error only while that neighbor is on its trunk, and a warning on any other branch, so a feature branch in a neighbor can't break this repo's checks.
- With `pending_pr` set, an unresolved anchor is a warning naming the PR.

Frontmatter that isn't valid YAML is an error for that file and line, and the check goes on to the other files. Lines that read as history (commit SHAs, "squash-merged", thread ids, "CI green") are a warning, an error under `--strict`; move them to the PR body or ticket.

Exit codes: 0 ok, 1 findings, 2 usage or no project.

## Check a PR against the map

```bash
node .agents/skills/factory-feature-map/scripts/check-map.mjs --pr <N> [--strict] [--json]
node .agents/skills/factory-feature-map/scripts/check-map.mjs --diff origin/<trunk>...HEAD [--worktree <path>]
node .agents/skills/factory-feature-map/scripts/check-map.mjs --changes <file.json>
```

Run it before the final push of any PR in a mapped repo. The default check resolves anchors against the checkout, so a PR that deletes or renames an anchor passes until the merge. This mode reads the PR's file list (`--pr` uses `gh api` with the resolved `project.remote.host`; `--diff` uses local git; `--changes` takes `schemas/changes.schema.json`) and reports:

- **Error, exit 1:** an anchor the PR deletes or renames, or an anchored symbol it removes (`--diff` only). Repoint the entry in the same PR.
- **Warning, exit 0 (exit 1 under `--strict`):** a source file the PR adds or changes beside an anchored file that no entry anchors. Anchor it, or decide it needs none. Tests, stories, fixtures, generated files and stylesheets are skipped.
- **Entries touched:** the feature files to update.

## After a merge

```bash
node .agents/skills/factory-feature-map/scripts/clear-pending-prs.mjs --pr <PR URL> [--apply]
```

Removes `pending_pr` from entries whose PR merged, and flags one whose PR closed unmerged. It reads PR state with `gh`, so it never runs as a pre-commit check. Without `--apply` it reports only. Commit the change.

When the map is installed from a bundle, edit it in the bundle's source, not in the installed copy (`factory update` refuses to overwrite an edited one): pass `--skills-dir <bundle dir>`, commit there, then run `factory update` in the repos that install it.

## Design authority

For a design-fidelity check, resolve one source before loading source-specific instructions:

```bash
node .agents/skills/factory-feature-map/scripts/resolve-design-authority.mjs [feature-id]
```

It reads only the map's `design-authority.json`. A feature override wins over `defaultDesignAuthority`. A null default, or a missing policy, means ask the user which source is authoritative for the current feature (exit 3); never infer one from the sources an entry lists.

## Create a map

Follow [references/create.md](references/create.md). Short version: interview the repo, write `inventory.mjs` first, seed 3 to 5 features from what it lists, then drive one feature live before handing off.

## Add or update one feature

1. Run `inventory.mjs`. Pick the ids the feature `covers`.
2. Write `features/<id>.md` per the contract, and link it from `features/README.md`.
3. Run the checker until it is clean. An entry written for an open PR, whose anchors exist only on its branch, sets `pending_pr` so it can be committed now.
4. Drive it live once, using the map's own SKILL.md, and set `last_verified` to today. If you couldn't drive it, leave `last_verified` alone and say why.

## Maintain

Follow [references/maintain.md](references/maintain.md): a checker pass, one read-only reader per feature, a live pass, then fixes only inside the map's directory.

## Rules

- Edit only inside `factory-features-<name>/` during create and maintain. A behaviour the app no longer has is either map drift (fix the map) or a product bug (report it).
- Anchors name files, directories and symbols. Never line numbers.
- Sources behind a login (a prototype, private docs, a design file) are references. Record how to reach them in the entry's `sources[].note`. They don't choose the design authority.
- Write scratch output (evidence, run notes) under `<stateRoot>/feature-map/<name>/` from `factory-context`. It's not committed.
- If `writeAllowed` is false, ask before committing the map.
