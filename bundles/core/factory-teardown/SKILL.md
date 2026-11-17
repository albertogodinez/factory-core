---
name: factory-teardown
description: Register run-owned artifacts and resources, perform targeted teardown, inspect stale runs, retire finished worktrees, or clean idle build output. Other skills and scheduled cleanup call the same repo-local scripts. Use for cleanup, low disk space, or before removing a worktree.
---

# Teardown and artifact lifecycle

Own one run, not a directory sweep. Depends on `factory-context`; slot resources also need `factory-dev-slot`. Scripts are repo-local, use Node built-ins and make no network calls.

```bash
L=.agents/skills/factory-teardown/scripts/lifecycle.mjs
node "$L" begin --kind validation                  # JSON: id, dir, manifest
node "$L" add --run <id> --path <absolute-file-in-dir> --class evidence
node "$L" resource --run <id> --type browser --session <unique-session>
node "$L" resource --run <id> --type process --pid <owned-pid>
node "$L" resource --run <id> --type slot --app <app> --worktree <run-worktree>
node "$L" scratch --run <id>                        # JSON: dir; owned short OS-temp directory
node "$L" launch --run <id> --cwd <worktree> --log <run-dir>/dev.log -- node server.mjs
node "$L" heartbeat --run <id>
node "$L" stop --run <id> --apply                 # release runtime resources before dependency restoration
node "$L" finish --run <id> --status complete        # or failed
node "$L" teardown --run <id>                       # preview
node "$L" teardown --run <id> --apply
node "$L" gc                                       # scheduled-style preview
```

Resolve `stateRoot` through `factory-context` once; `--state-root <absolute-path>` can carry that resolved value across shells. `begin` creates `<stateRoot>/teardown/runs/<id>/files/`. Register individual files before producing them. Use `begin --owner-pid <stable-pid>` for a long-lived owner, and heartbeat long-running work; a heartbeat retains that owner unless explicitly reassigned. An inactive-owner notice is an inspection hint, not proof of abandonment. A live owner with no heartbeat for a day is still reported for inspection; liveness never hides stale attendance indefinitely. Launch servers through `launch`, which owns a dedicated supervisor/process group so launcher exit cannot orphan children. Give long-running shells a heartbeat; record resource identity when creating the resource. An explicit `resource` call asserts this run created it: never register a pre-existing user process or browser session.

- **intermediate:** raw takes, temporary frames, generated patches or prompts. Targeted teardown removes these after `finish`, except files registered with `--pending`. Recording raw takes and sidecars stay pending until every consumer is done; `release --run <id> --verified` explicitly releases those inputs. This remains required even after finish.
- **evidence:** screenshots, final videos, contact sheets, self-contained reports and review guides. Retained, including after publication.
- **durable:** handoffs, lessons and decision logs. Retained.

`pin --run <id>` protects the whole run; `unpin` releases that protection. After verifying the upload at its destination, `publish --run <id> --path <file> --url <url> --verified` records publication. A successful upload command or a merged PR alone does not prove publication. The current policy never expires evidence or durable records.

Existing unregistered files are not deletion candidates. Preserve legacy `stateRoot` lessons, handoffs and feature-map evidence. Never wipe `stateRoot` or use `factory remove --purge` for housekeeping. Explicit guide output overrides are user-managed and retained.

## Completion and worktree removal

1. Finish every consumer (encoding, upload, review/import) before releasing its inputs. Keep an inspection session active if requested.
2. On success or failure, `finish`, then preview and apply targeted teardown. Stop registered runtime resources before releasing scratch files. Failures are reported individually and leave unreleased resources for retry. No force kill or broad browser close.
3. Slots must be stopped with their scoped `down --purge` before removing a worktree. If a stop fails, do not remove that worktree. On Windows, process start identity is unavailable: process registration refuses rather than killing by PID alone.
4. Remove the worktree with `retire` (below), or only the intended clean worktree through git. The scripts never delete a branch. Preserve durable/evidence files before removal if state is physically inside that worktree. Leave remote branches alone unless asked.
5. After a verified merge and successful closeout, delete that PR's monitor JSON explicitly. Report both removals and retained records.

## Retiring finished worktrees

Worktrees pile up: each one is a full checkout plus its own `node_modules` or build output. `worktrees` lists the linked ones; `retire` removes one. Both are local git only.

```bash
node "$L" refresh-prs                                     # asks gh for every PR's state and saves it
node "$L" worktrees --sizes                               # lists candidate/kept with a reason; local git only
node "$L" retire --worktree <path>                        # re-checks; preview
node "$L" retire --worktree <path> --apply                # after the user agrees
```

A worktree is **finished** when its branch's PR is merged or closed, its remote branch is gone, or it has no commits beyond the base branch and has been idle `--idle-days` (default 7). Squash merges look unmerged to git, so the PR states matter: session start refreshes them in the background (at most every 12 hours, only in repos with linked worktrees), and `refresh-prs` does it now. Without gh, save `gh pr list --state all --json headRefName,state,number` output elsewhere and pass it with `worktrees --pr-states <file>`; with no states only the last two signals apply. A finished worktree is still **kept** when it has tracked changes or untracked files (other than the skill symlinks factory links in), is locked, is the current one, or has a teardown run that is active or holds resources there. A detached HEAD with commits on no branch is kept: removing it would lose them.

`retire --apply` removes those symlinks, then runs `git worktree remove` without `--force`, so git's own clean check still applies; ignored files go with it and the branch stays. Show the user the candidates and sizes and ask before retiring; never retire a kept one by cleaning it first unless they ask. For uncommitted work they want gone, save `git diff` as a patch outside the worktree first.

## Idle build output

`outputs` lists big folders a build or install regenerates, in the current checkout: `node_modules`, `target/` (beside `Cargo.toml` or `pom.xml`), `dist/` and `build/` (beside a build file), `.next/`, `.turbo/`, `.gradle/`, `coverage/` and similar. Only folders git ignores and tracks nothing under count, at least `--min-gb` (default 1) in size; one untouched for `--idle-days` (default 14) is a candidate. Nested checkouts and symlinks are skipped.

```bash
node "$L" outputs                                         # candidate/kept, size, and what regenerates each
node "$L" clean-output --path <folder>                    # re-checks; preview
node "$L" clean-output --path <folder> --apply            # after the user agrees
```

Show the sizes and what brings each back (`again`), then ask. Cleaning deletes that one folder; the next build or install recreates it.

## Scheduled backstop

`factory cleanup --all` coordinates installed copies across registered repos/worktrees. Preview is the default. The opt-in machine schedule runs this same command in reporting mode; it does not install a job in each downstream repo. Its report lists each repo's finished worktrees (from the last saved PR states) and each checkout's idle build output, with sizes; it never retires or cleans either, even when applying. At session start, free space under the machine's `minFreeGB` (in `cleanup-schedule.json`, default 50) is reported too, with what the report found and a reminder that Docker, caches and unmanaged repos aren't measured. The session status line names them; retire them with the user as above.

Automatic GC requires both explicit apply and a repo policy:

```bash
node "$L" configure --intermediate-hours 24
node "$L" gc --apply
```

The value is a user-selected minimum age, not a default deletion policy. GC preserves every active run (reporting abandoned owners for inspection), pins, unknown/corrupt manifests and all evidence/durable records. It reports runtime resources requiring targeted teardown instead of killing them unattended. Only registered intermediates and engine-created scratch can be reclaimed. The run lock serializes mutation; an abandoned lock is reported for inspection rather than stolen from a concurrent cleaner.

No schedule or retention policy is enabled by installing this skill. See `factory setup --help` and the factory README for machine scheduling.
