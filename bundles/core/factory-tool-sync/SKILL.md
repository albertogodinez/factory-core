---
name: factory-tool-sync
description: 'Check that the CLIs installed skills shell out to are installed, at least the version a skill needs, and whether a release came out since the pins were last reviewed. Pins come from every installed skill''s tools.json, so each bundle ships its own. Use for /factory-tool-sync, when a check reports CHANGED, BELOW, BEHIND or MISSING, before upgrading one of those CLIs, or when a skill starts depending on a new CLI.'
disable-model-invocation: true
---

# Tool sync

Each installed skill may ship a `tools.json` beside its `SKILL.md`. The checker reads `<project.root>/.agents/skills/*/tools.json` and merges them, so a bundle brings its own pins. Core ships pins for `node`, `git` and `gh`; companion skills (`factory-tool-sync-<bundle>`) add the rest. Entries with the same `id` merge: the later skill name wins field by field, and the highest `min` wins.

Each entry has:

- `min`: the lowest version any skill relies on. Below it a skill breaks.
- `verified`: the version the skills were last checked against.
- `latest`: where to read the newest release (`npm`, `github`, or a `command` the CLI answers). Needs `verified`.
- `usage`: a regex that finds the skills invoking it. Dependents are derived from it on each run, never listed by hand.
- `version`: `argv` that prints the installed version, a `pattern` whose group 1 is the version, and optional `env` for the probe.
- `install`, `notes`, `reviewed`, `decision`: how to install it, version-specific behaviour, and the last review.

`schemas/tools.schema.json` describes the file for editors. The checker validates it itself and exits 2 on an invalid one.

## Check

```bash
node .agents/skills/factory-tool-sync/scripts/check-tools.mjs            # offline: no network call; warns, exits 0
node .agents/skills/factory-tool-sync/scripts/check-tools.mjs --online   # fetch latest releases; exit 1 on CHANGED or BELOW
```

Other flags: `--cwd <dir>`, `--skills <dir>`, `--state <dir>`. The snapshot and a version cache live in the resolver's `stateRoot`.

The default run reads the last `--online` snapshot and never touches the network. Tags:

- `MISSING`: not on PATH. The line names the skills that need it.
- `BELOW`: installed version is under `min`. A skill will fail; upgrade.
- `BEHIND`: installed version is under `verified`. Upgrade the copy first on `PATH` (`which -a <cli>`) with the tool that installed it.
- `AHEAD`: installed version is newer than `verified`. Nothing to do unless a skill misbehaves; then start there, and run the review below.
- `UNUSED`: no skill matches `usage`. Drop the entry or fix the regex.
- `CHANGED`: from the last snapshot, a release newer than `verified` is out.
- `UNKNOWN`: the version command ran but `pattern` found no version.

A snapshot older than `snapshotMaxAgeDays` (default 14) is ignored.

## Review a new release

For each `CHANGED` tool:

1. Read the release notes between `verified` and the new version, and the entry's `notes`.
2. Grep the dependents for the commands and flags they use (`grep -rnE '<usage regex>' .agents/skills`), and look for those in the notes: removed or renamed flags, changed output shapes (`--json`), changed defaults.
3. Upgrade locally and run one dependent skill's script for each invocation the notes touch.
4. Propose adopt or skip with a one-line reason, and wait for the user's call. If a skill now needs the new version, raise `min`. If it now works around a new quirk, write that in `notes`.
5. Record it. This moves `verified` to the snapshot's latest in the `tools.json` that defines the entry, so the same release isn't flagged again:
   ```bash
   node .agents/skills/factory-tool-sync/scripts/check-tools.mjs --bump <id> --decision "adopted"
   node .agents/skills/factory-tool-sync/scripts/check-tools.mjs --bump <id> --decision "adopted" --min 0.41.0
   node .agents/skills/factory-tool-sync/scripts/check-tools.mjs --bump <id> --decision "skipped: <why>"
   ```

## Track a new CLI

When a skill starts shelling out to a CLI nobody pins, add an entry to that skill's own `tools.json`: `id`, `version`, `usage`, `install`, and `min` if a skill needs a particular feature. Add `latest` and `verified` together when there is a release source worth following. A CLI pinned per product repo (such as `pnpm` through `packageManager`) gets no `latest`.

Tests: `node --test .agents/skills/factory-tool-sync/scripts/check-tools.test.mjs`.
