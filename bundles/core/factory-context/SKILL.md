---
name: factory-context
description: Resolve which project the current directory belongs to and its settings (trunk, remote host and slug, package manager, commands, PR template, neighbors, adapters, state directory, whether writes are allowed) from .agents/factory-metadata/project.json, a workspace registry, or git alone. Other skills call its script instead of reading config files. Use when a skill needs repo facts, or to check what the toolkit sees in a repo ("what project am I in", "why does the toolkit think trunk is X").
---

# factory-context

Every factory-core skill asks one script, "which project am I in, and what are its settings?", and never reads config files itself.

```bash
node .agents/skills/factory-context/scripts/resolve.mjs                 # JSON, one line
node .agents/skills/factory-context/scripts/resolve.mjs --field project.trunk
node .agents/skills/factory-context/scripts/resolve.mjs --pretty        # for a person
```

**Skill paths are relative to the project root.** Keep the shell there, and write into `stateRoot` by path. From any other directory (a subfolder, the state directory, a worktree that was never linked), prefix the path with the main checkout: `node "$(git rev-parse --path-format=absolute --git-common-dir)/../.agents/skills/factory-context/scripts/resolve.mjs"`.

`factory install` puts skills in `.agents/skills` (with `.claude/skills` linking to it). Other flags: `--cwd <dir>`, `--config <file>`, `--full` (don't elide long values), `--no-cache`, and `--repo <name|owner/name>`, which resolves one registered repo (workspace mode) or this project's neighbor (project mode) instead of the cwd. A neighbor reached this way has `writeAllowed: false` unless its `access` is `write`.

## Sources, first match wins

1. `--config <file>` or `FACTORY_CONFIG`.
2. The nearest `.agents/factory-metadata/project.json` from the cwd up to the git root. A linked worktree with none of its own uses the main checkout's. If it has `"workspace": "<registry path>"` (a hub), the mode stays `workspace`: that registry lists the repos, and project.json's marker, adapters, personas and `writeAllowed` apply on top. `factory install` writes the pointer when the repo already has a registry.
3. The nearest `.agents/factory-metadata/workspace.json` (a multi-repo registry; migration only).
4. A legacy `.claude/repos.json` registry (read-only; migration only).
5. Zero-config: git and the working tree. Trunk comes from `origin/HEAD`, then a `main`, `master` or `trunk` branch, then the current branch. The package manager comes from the lockfile, commands from `package.json` scripts, and the PR template from `.github/`.

A sibling checkout or worktree of a registered repo resolves to that repo, matched by git common dir first, then by remote host and slug.

## Output

```json
{"mode":"project","source":".agents/factory-metadata/project.json",
 "project":{"name":"","root":"","trunk":"","packageManager":"","prTemplate":"",
            "remote":{"host":"","slug":""},"commands":{"build":"","test":"","lint":""}},
 "neighbors":[{"name":"","root":"","trunk":"","access":"write"}],
 "adapters":{"tracker":"","personas":[],"commentMarker":{"mode":"off"},"envProfile":""},
 "stateRoot":"","writeAllowed":true}
```

- Empty and null fields are left out. A comment marker's banner text is elided (`--full` prints it). Read a missing field as "not configured".
- A neighbor's `root` is left out when it is `<project.root>/../<name>`, and its `access` when it is `read`.
- `stateRoot` is where a skill writes scratch state (recordings, handoffs, lessons). It's per worktree. The resolver doesn't create it, so `mkdir -p` it before writing.
- **`writeAllowed: false` (always, in zero-config mode): don't post, push, merge or move a ticket without the user confirming that action first.**

Exit codes: 0 ok; 1 `--field` path not present; 2 bad usage, an invalid config, or no git repo and no config.

## Config

`.agents/factory-metadata/project.json` follows `schemas/project.schema.json`. Every field is optional, and detection fills in what's missing. Check a config with `node .agents/skills/factory-context/scripts/validate.mjs [file]`. The `adapters` values (tracker, personas, comment marker, env profile) name installed skills; their contracts are in `references/adapters.md`.

## Limits

The resolver is a single file that imports only `node:` modules and makes no network calls. A cached call adds under 15 ms to Node's own startup (about 55 ms in all on a busy laptop) and never takes 100 ms; a cold call adds under 60 ms and stays under 150 ms. It spawns `git` at most once (only when `GIT_DIR` is set), and its output is at most 1 KB plus 70 B per neighbor, or 200 B with `--field`. The cache lives in `~/.agents/factory/cache/resolver/` (or `$FACTORY_HOME`), keyed by `HEAD` and the mtimes of every file it read.

Tests: `node --test bundles/core/factory-context/scripts/resolve.test.mjs`. In factory-core, `tests/guardrails/resolver.guard.mjs` enforces the limits.
