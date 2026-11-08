---
name: toolkit-context
description: Resolve which project the current directory belongs to and its settings (trunk, remote host and slug, package manager, commands, PR template, neighbors, adapters, state directory, whether writes are allowed) from .ai-toolkit/project.json, a workspace registry, or git alone. Other skills call its script instead of reading config files. Use when a skill needs repo facts, or to check what the toolkit sees in a repo ("what project am I in", "why does the toolkit think trunk is X").
---

# toolkit-context

Every agent-factory skill asks one script, "which project am I in, and what are its settings?", and never reads config files itself.

```bash
node <skills>/toolkit-context/scripts/resolve.mjs                 # JSON, one line
node <skills>/toolkit-context/scripts/resolve.mjs --field project.trunk
node <skills>/toolkit-context/scripts/resolve.mjs --pretty        # for a person
```

`<skills>` is the directory this skill is installed in (`.agents/skills` or `.claude/skills`). Other flags: `--cwd <dir>`, `--config <file>`, `--repo <name>` (workspace mode: one registered repo), `--no-cache`.

## Sources, first match wins

1. `--config <file>` or `AI_TOOLKIT_CONFIG`.
2. The nearest `.ai-toolkit/project.json` from the cwd up to the git root. A linked worktree with none of its own uses the main checkout's.
3. The nearest `.ai-toolkit/workspace.json` (a multi-repo registry; migration only).
4. A legacy `.claude/repos.json` registry (read-only; migration only).
5. Zero-config: git and the working tree. Trunk comes from `origin/HEAD`, then a `main`, `master` or `trunk` branch, then the current branch. The package manager comes from the lockfile, commands from `package.json` scripts, and the PR template from `.github/`.

A sibling checkout or worktree of a registered repo resolves to that repo, matched by git common dir first, then by remote host and slug.

## Output

```json
{"mode":"project","source":".ai-toolkit/project.json",
 "project":{"name":"","root":"","trunk":"","packageManager":"","prTemplate":"",
            "remote":{"host":"","slug":""},"commands":{"build":"","test":"","lint":""}},
 "neighbors":[{"name":"","root":"","trunk":"","access":"write"}],
 "adapters":{"tracker":"","personas":[],"commentMarker":{"mode":"off"},"envProfile":""},
 "stateRoot":"","writeAllowed":true}
```

- Empty and null fields are left out. Read a missing field as "not configured".
- A neighbor's `root` is left out when it is `<project.root>/../<name>`, and its `access` when it is `read`.
- `stateRoot` is where a skill writes scratch state (recordings, handoffs, lessons). It's per worktree. The resolver doesn't create it, so `mkdir -p` it before writing.
- **`writeAllowed: false` (always, in zero-config mode): don't post, push, merge or move a ticket without the user confirming that action first.**

Exit codes: 0 ok; 1 `--field` path not present; 2 bad usage, an invalid config, or no git repo and no config.

## Config

`.ai-toolkit/project.json` follows `schemas/project.schema.json`. Every field is optional, and detection fills in what's missing. Check a config with `node <skills>/toolkit-context/scripts/validate.mjs [file]`.

## Limits

The resolver is a single file that imports only `node:` modules and makes no network calls. Cached calls take a median under 50 ms; cold calls under 150 ms. It spawns `git` at most once (only when `GIT_DIR` is set), and its output is at most 1 KB, or 200 B with `--field`. The cache lives in `~/.ai-toolkit/cache/resolver/` (or `$AI_TOOLKIT_HOME`), keyed by `HEAD` and the mtimes of every file it read.

Tests: `node --test bundles/core/toolkit-context/scripts/resolve.test.mjs`. In agent-factory, `tests/guardrails/resolver.guard.mjs` enforces the limits.
