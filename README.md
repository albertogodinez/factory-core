# factory-core

Each `##` section stands on its own, so you can lift it into another repo's README as is.

## What it is

The agent factory is a set of agent skills that you install into any repo you work in. It works the same way in Claude Code, Codex, Copilot and Cursor. Each repo gets its own copy of the skills it needs, its own config, and its own lessons. A lesson about the shared skills is handed to the repo that owns them, batched with its family, and lands there only after you approve it.

Design rules:

- **Per-repo first.** Start each session in the repo you're changing. Nothing runs above the repos.
- **Small and fast.** Dependency-free scripts (`node:` imports only), hard limits on speed and context size, no network.
- **Local only.** Sources are local git repos. Installs copy files. Nothing is published or fetched.
- **Every harness.** Nothing in core depends on a feature that exists in only one harness.

## Bundles

| Bundle | Holds | Lives in |
|---|---|---|
| `core` | Principles, writing, review, PR, plan, CI watch, recording, feature-map, formal-verify, dev-slot, registry/status, PR mining, the resolver, and the factory kit (reflect, ask, docs-validate, tool-sync, writing-for-agents) | `factory-core` |
| `launchers` | `adapters.sessionLauncher` adapters, read in place (no repo installs them): `factory-launcher-hc` starts a session in a lesson's source repo with hc, and pins `hc` and `plannotator` | `factory-core` |
| `expedia` | Tracker adapter (Jira link, `In Review` transition, Confluence), GHE host, the `cc-autoreply` marker policy, dev-slot's `eg-corporate` env profile, the EGDS persona, and the tarmac skills (deploy-preflight, oncall, telemetry, design-capture) | `factory-org` |
| `trips` | Trip Expert auth, prototype and feature maps, CCUI and shared-ui testing, tarball linking, template blocks, RUM, dev-slot app configs, trips reviewer personas, trips data (mining cohorts, experiment map) | `factory-org` |

Core carries no internal data: no repo names, reviewer logins, hosts or paths. A core skill gets that data from the resolver, which reads it from the consumer's config or from an adapter bundle.

There's no hub bundle. Working across several repos is a mode of core (see [Neighbors](#neighbors-cross-repo-work)).

Adopted upstream skills (`handoff`, `diagnosing-bugs`, `improve-codebase-architecture`, `wait-what`, `writing-for-agents`, originally from `mattpocock/skills`) ship as our versions. When the factory installs core into a repo, they replace any copies already there. `factory-upstream-sync` (in this repo's own `.agents/skills`, not a bundle) pulls upstream improvements into our versions. It runs only in factory-core; the pre-commit hook runs its offline check.

## Directory layout

```
~/Documents/repos/
├── factory-core/                  # core + factory CLI · local git, no remote
│   ├── bin/factory.mjs
│   └── bundles/core/<skill>/SKILL.md
├── factory-org/                   # expedia + trips bundles, registry, checks, hooks · the EG hub (was trips-ai-toolkit)
│   ├── bundles/expedia/<skill>/SKILL.md
│   └── bundles/trips/<skill>/SKILL.md
├── ai-shopping-pwa/                # team repo → LOCAL-ONLY install
│   ├── .agents/skills/
│   │   ├── migrate-ai-shopping-playground/   # the team's tracked skill, never touched
│   │   └── factory-review/ …                 # installed copies, untracked
│   ├── .claude/skills -> ../.agents/skills   # symlink on macOS/Linux; a copy on Windows
│   ├── .agents/factory-metadata/
│   │   ├── project.json                      # config: neighbors, marker policy, cohort, commands
│   │   ├── skills-lock.json                  # what factory installed, with hashes
│   │   └── state/<worktree-id>/              # resolver cache, lessons.jsonl, recordings, handoffs
│   └── .git/info/exclude                     # hides the install; covers every worktree
└── ccui-components-web/            # same local-only layout

~/Documents/playground-repos/       # repos you own → COMMITTED install
├── personal-website/   .agents/skills/ (core) · .agents/factory-metadata/project.json
├── obsidian-harness/   .agents/skills/ (its own + core)
└── herdr-mods/         .agents/skills/ (core) · zero-config until `factory init`

~/.agents/factory/                      # machine-wide, outside every repo
├── installs.json                   # onboarded repos, bundles, versions → `factory update --all`
├── config.json                     # machine adapters: sessionLauncher, agentCLI (factory setup)
├── lessons-index.jsonl             # lesson fingerprints across repos, and the never list
├── candidates/<core|org>/          # lessons handed to their source repo; triage moves them to done/
├── metrics.jsonl                   # counted signals per session (no content), 180 days
├── reports/<date>-<core|org>.html  # the trend report triage posts
├── triage-state.json               # triage's daily / weekly mode per scope
└── cache/<repo-id>/                # state for zero-config repos
```

## Install modes

| Mode | Use for | Installed files | Hidden by |
|---|---|---|---|
| **Committed** | Repos you own | Tracked in git, like any other skill | nothing; they're part of the repo |
| **Local-only** | Team repos | Untracked copies | `.git/info/exclude` (local, never committed) |

The factory never edits a repo's tracked `.gitignore` unless you opt in. `.git/info/exclude` lives in the shared git directory, so one entry covers every worktree of the repo.

New worktrees don't contain untracked files. With a local-only install, onboarding tests whether each harness, started inside a worktree, still finds the skills in the main checkout. Any harness that doesn't gets `factory link`, which adds a skills link (a copy on Windows) to each new worktree.

## The resolver

Every skill asks one script, `factory-context`, "which project am I in, and what are its settings?" Skills never read config files themselves.

Sources, first match wins:

1. `--config <file>` or `FACTORY_CONFIG`
2. The nearest `.agents/factory-metadata/project.json`, searching from the cwd up to the git root. In a hub, its `workspace` field points at the registry (3 or 4), which keeps workspace mode and the registry's repos; `factory install` sets it
3. The nearest ancestor `.agents/factory-metadata/workspace.json` (a legacy form; a hub uses `project.json` with a `workspace` pointer)
4. Legacy `.claude/repos.json` (read-only, used only during migration)
5. Zero-config detection from git: trunk from `origin/HEAD` or the current branch, the remote host, the package manager from the lockfile, the PR template

Projects are identified by git common dir first, then by normalized remote host and slug. A sibling checkout or worktree resolves to the same project.

Output, the same whichever source matched:

```json
{
  "mode": "zero-config | project | workspace",
  "source": ".agents/factory-metadata/project.json",
  "project": { "name": "", "root": "", "trunk": "", "packageManager": "", "prTemplate": "",
               "remote": { "host": "", "slug": "" }, "commands": { "build": "", "test": "", "lint": "" } },
  "neighbors": [ { "name": "", "root": "", "trunk": "", "access": "read | write" } ],
  "adapters": { "tracker": null, "personas": [], "commentMarker": null, "envProfile": null },
  "stateRoot": "",
  "writeAllowed": false
}
```

`writeAllowed` is always false in zero-config mode. A skill that posts, pushes or transitions a ticket needs config or an explicit confirmation first.

Budget: one file, `node:` imports only, no network. A cached call adds under 15 ms to Node's startup and never takes more than 100 ms in all. A cold call adds under 60 ms and takes under 150 ms. That means at most one `git` spawn cold and none cached. Output is at most 1 KB plus 70 bytes per neighbor (the neighbor list is the one part that grows with the config), or 200 bytes with `--field`. The cache is keyed by `HEAD` and the mtimes of the config files.

## State by mode

| Mode | stateRoot | Plans | Lessons |
|---|---|---|---|
| Zero-config | `~/.agents/factory/cache/<repo-id>/` | a path you choose | printed to you; nothing is written into the repo |
| Project | `<repo>/.agents/factory-metadata/state/<worktree-id>/` | `planHome` in config, default `<repo>/plans/` | that repo |
| Workspace (migration) | `<hub>/tmp/` | `<hub>/plans/` | by scope |

## Neighbors (cross-repo work)

A project can list neighbors: other repos it reads from and sometimes writes to. A typical pair is a host app and its component library.

```json
{ "neighbors": [ { "name": "ccui-components-web", "root": "../ccui-components-web", "access": "read" } ] }
```

- **Reading** a neighbor needs no permission. The resolver returns its root and trunk, so review, feature-map and similar skills can look across.
- **Writing** to a neighbor needs `"access": "write"` or a one-time confirmation. The change goes into a worktree in the neighbor and follows the neighbor's own `project.json` rules (PR template, commands). Its lessons go to the neighbor's state.
- **The neighbor's skills aren't loaded** into the host session, only its files.

A paired change:

```
host (ai-shopping-pwa)            you                     neighbor (ccui-components-web)
1 resolve context
2 read neighbor files  ─────────────────────────────────▶  (nothing changes)
3 plan: needs a ccui change
                       ─▶ 4 "Write to ccui?" ─▶            5 worktree, using its own rules
6 link tarball/canary  ◀─────────────────────────────────  change ready
7 PR #1 + host lessons                                     7 PR #2 + ccui lessons
```

## Lessons

Every accepted reflect lesson has a scope:

| Scope | Example | Lands in |
|---|---|---|
| repo | "this Astro build needs `pnpm build` before `verify:site`" | that repo: a check, test or `AGENTS.md` line |
| core | "dev-slot must re-auth the browser after a restart" | a core skill in factory-core |
| org | "tarmac needs `--web` when there's no TTY" | factory-org |

The flow:

```
reflect run (no questions, no cap) → every accepted lesson becomes a candidate
        │ owned by: this repo (repo) · core's source repo · the org source repo
        ▼
candidate → ~/.agents/factory/candidates/<core|org|repo>/   (pointers to evidence, a draft, fixedWhen)
        │ fact: launch triage in the owner repo now · pattern / harness: queue until due
        ▼
/factory-triage in the owner repo → clusters → one lesson branch, one commit per cluster
        │ review gate: the only place the user decides (keep, drop, split, never)
        ▼
land and push from that session → trunk moved: every installed repo is updated in the background
```

- A session writes only its home repo plus `~/.agents/factory/`. `lessons.mjs land` refuses anywhere else.
- Nothing counts to three, and nothing asks before the review. Triage reads the whole queue and clusters it; a cluster's size is the count that matters.
- A repo lesson queues in its own repo and lands there, through a PR in a team repo. A session start in a repo whose queue is due launches triage (`factory triage --due`, which keeps its quiet hours and one launch per 20 hours), so a schedule missed while the machine was off is caught at the next session.
- "Never" is remembered per family (`lessons.mjs decide --decision never`), and triage drops its candidates.
- `adapters.sessionLauncher` starts the source repo's session. It's machine config (`~/.agents/factory/config.json`), set by `factory setup` when `hc` is on PATH; a repo's `project.json` can override it or set `null`. Unset, reflect prints the command. `adapters.agentCLI` (also machine config) names the agent CLI the launcher starts, `claude` or `codex`; `factory setup` sets it to the first one on PATH.
- `/factory-ask` answers "what's waiting" from `lessons.mjs queue`.
- Every session's end appends counts to `~/.agents/factory/metrics.jsonl` (`metrics.mjs capture`, installed by `factory setup` as a SessionEnd hook, Codex's Stop). A row holds tool counts, command heads, failures, hook blocks, denials, stuck signals, corrections (a heuristic), the skills used, tagged core or org, and the revision each layer was installed at. It never holds prompts, file contents or tokens: a schema check refuses the row first. It keeps 180 days, up to 5 MB.
- Cadence: triage ends with `lessons.mjs cadence --ran`, which keeps each scope's mode in `~/.agents/factory/triage-state.json`. It's daily for the first 14 days and stays daily until two quiet weeks pass (at most 2 candidates a week, no facts, no cluster of 3). Then it's weekly until an early trigger brings daily back. The status hook nudges in the source repo only when triage is due, or a trigger fires. `--pin daily|weekly|off` overrides.
- Triage also runs `check-tools.mjs --online` and names each changed tool.
- Triage runs `lessons.mjs report` and posts the trend per layer: each landed lesson's `fixedWhen` signal before and after, with a verdict (better, flat, worse). A session row records the revision each layer was installed at (`revs`, from the lock's `sourceRev`), and a land records its commit (`done --commit`), so before and after split by what each session actually ran. A worse verdict queues a fact to revert or rework the lesson. The git log is the decision record: each lesson commit carries `Candidates:` and `Fixed-when:` trailers. The newest 12 reports per layer are kept.

PR mining works the same way. Each repo's `project.json` holds its reviewer cohort. Patterns found in several repos reach core as candidates.

## The factory CLI

`factory-core/bin/factory.mjs` and its cleanup coordinator use `node:` imports only and copy from local paths.

```
node factory.mjs install core [expedia] [trips] [--to <repo>] [--local | --commit]
node factory.mjs update [--all]       # re-copy changed skills; refuses if a local copy was edited
node factory.mjs cleanup [--all] [--to <repo>] [--dry-run | --apply] [--json]
node factory.mjs setup --cleanup-schedule [--dry-run] [--apply]
node factory.mjs remove <skill|bundle>
node factory.mjs link                 # add the skills to the current worktree (local-only installs)
node factory.mjs doctor               # onboarding tests
node factory.mjs list
node factory.mjs status               # one line when installed skills are behind their source; else silent
node factory.mjs status --hook        # as a hook: also tells a running session about updates and edited copies
node factory.mjs setup [--root <dir>] # a new machine: the status and metrics hooks, the session launcher, and installs.json for repos already cloned
node factory.mjs harness [--apply]    # the harness bundle's hooks and permission rules: show the change, or merge it into your settings
```

**The harness bundle.** Hooks and permission rules that factory manages live in git, in each bundle's `harness/claude-code.json` and `harness/codex.json`, so a harness lesson is a commit with the same branch, review and trailers as any other. `factory harness` shows what applying them would change; `factory harness --apply` (also run by `factory setup`) merges them into `~/.claude/settings.json` and `~/.codex/hooks.json`, with a backup. Factory records what it applied in `~/.agents/factory/harness-applied.json`: an entry dropped from a fragment is removed on the next apply, and entries you added yourself are never touched. A fragment holds only `hooks` and `permissions.allow`/`deny`, and a broad allow (`Bash`, `Bash(*)`) is refused. factory-core's trunk hook applies them after each trunk commit; the status hook names a fragment that changed upstream and wasn't applied. Each metrics row records the applied harness revision, so a harness lesson is measured across every session on the machine.

`status --hook` reads the hook's JSON from stdin (`session_id`, `hook_event_name`, `cwd`). It answers the session-start check the same way, and on later prompts it tells a running session, once, what changed since it last checked:
- Skills `factory update` copied in. `update` appends each copy to `~/.agents/factory/updates.jsonl`.
- Installed copies someone edited in place, found by a file newer than the lock and then confirmed by hash.

**Updates are pushed when trunk moves.** factory-core's `.githooks/reference-transaction` hook sees every new commit on trunk (a commit, merge, pull, or a lesson land's `update-ref`) and starts `bin/auto-update.mjs` in the background. It runs `factory update --all` from the main checkout, so local-only installs get the copy and commit-mode installs get the diff to commit, and each running session hears about it at its next prompt. It skips when the main checkout isn't on trunk or has uncommitted tracked changes, since `update` copies from that working tree; the session-start "changed upstream" line still covers a skipped run. A burst of commits shares one worker. Then it runs `factory harness --apply`, so an approved harness change reaches this machine's settings too (keep that step manual with `git config factory.autoHarness false`). Runs are logged to `~/.agents/factory/auto-update.log`. Opt out with `FACTORY_AUTO_UPDATE=0` or `git config factory.autoUpdate false`. Another bundle source repo (a company bundle) gets the same behaviour by calling `node <factory-core>/bin/auto-update.mjs hook` from its own `reference-transaction` hook.

A skill read earlier in a session stays in that session's context, so the notice says to read its SKILL.md again. Per-session state lives in `~/.agents/factory/sessions/` and is pruned after a week. It runs on every prompt with no git spawns, and `status.guard.mjs` holds its overhead limit.

`status` is the session-start drift check. User-level `SessionStart` and `UserPromptSubmit` hooks run it in Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`), so no team repo's tracked settings change:

```json
{ "type": "command", "command": "node '<factory-core>/bin/factory.mjs' status --hook 2>/dev/null || true", "timeout": 5 }
```

A third hook captures metrics when a session ends: `SessionEnd` in Claude Code, `Stop` in Codex (Codex has no session-end event, so each turn replaces the session's row):

```json
{ "type": "command", "command": "node '<factory-core>/bundles/core/factory-reflect/scripts/metrics.mjs' capture --hook 2>/dev/null || true", "timeout": 10 }
```

`factory setup` adds these entries, or repoints them when factory-core moved. It keeps every other hook, backs up a file before writing it, and writes nothing when the hooks are already set.

Both harnesses pass the hook's stdout to the model on `UserPromptSubmit` (checked live in each, 2026-11-09). In Codex, two things differ. `codex exec` runs no user hooks, so only interactive sessions hear about updates. And hooks don't inherit `FACTORY_HOME`, so a hook always reads `~/.agents/factory`.

It checks only the repo the session starts in. A skill is behind when a commit after its `sourceRev` touched its directory in the bundle's repo, and a bundle skill the repo lacks counts as new. There's no hashing. When a source repo's HEAD or the lock changed, it runs one `git log` per source repo. Otherwise it answers from `~/.agents/factory/status-cache.json` without spawning git. `tests/guardrails/status.guard.mjs` holds those limits. Uncommitted bundle edits don't count, and `doctor`'s hash check still catches them. In a linked worktree of a local-only install, it also says when the worktree has no links to the installed skills yet (a new worktree never does) and gives the `factory link` command. As a hook it says so once per worktree, including one the session moves into after it starts. At a session start the hook also names each `factory-reflect` lesson branch still waiting for review (in its own repo it says to land them; elsewhere it names the repo to start a session in): `lessons.mjs start` records them in `~/.agents/factory/lesson-branches.jsonl`, and the hook reads their refs without spawning git.

`install` does the following:

- copies the bundles into `.agents/skills`, leaving out test files (`*.test.mjs`, `*.guard.mjs`): they run in the bundle's own repo, where their fixtures live
- replaces same-named skills and their lock entries, and reports what it replaced
- creates the `.claude/skills` link (a copy on Windows)
- writes `.agents/factory-metadata/project.json`, asking once about the PR comment marker (keep, change or off)
- hides `.agents/factory-metadata/`, plus the copies and the plan directory (`planHome`, default `plans/`, unless the team already tracks it) in local-only mode, through `.git/info/exclude`
- records the repo in `~/.agents/factory/installs.json`

The lock keeps the `skills-lock.json` shape (`source`, `skillPath`, `computedHash`).

## Temporary files, evidence and teardown

`factory-teardown` provides one repo-local engine for recording, validation and post-merge cleanup.
Each run gets `<stateRoot>/teardown/runs/<id>/files/` and a manifest of owned files and resources.
Producers carry `FACTORY_RUN_ID` and `FACTORY_STATE_ROOT` across shells; final videos, screenshots,
comparison grids and HTML reports register as evidence, while raw takes and generated review inputs
register as intermediates. Raw recording inputs remain pending until every consumer is verified
finished and the caller explicitly releases them with `release --verified`. The recording template creates a run when none is supplied. Direct helper
calls without that binding remain compatible but are unregistered and never automatic GC candidates.

- Targeted teardown runs after consumers finish and stops only registered processes, named browser
  sessions and project-scoped dev slots. A failed stop leaves inputs for retry. Stop slots before
  removing worktrees; never force-remove dirty worktrees.
- Registered intermediates can be deleted. Evidence, lessons, handoffs, decision logs, pins and
  unregistered legacy state are retained. Even published evidence currently has no automatic expiry.
- The engine can create an owned short OS-temp scratch directory for tarballs. It verifies the
  ownership marker and root before deleting it; arbitrary external paths cannot be registered for deletion.
- `factory remove all --purge` is uninstall and deletes project metadata/config; it is not housekeeping.

Use `factory cleanup --all --dry-run` to inspect installed engines across registered repos and their
worktrees. Shared state roots are visited once. Missing engines are reported as upgrade skips rather
than installing anything. `--apply` is still subject to each repo's policy; the engine's
`configure --intermediate-hours <hours>` explicitly opts registered intermediates into age-based GC.
A schedule or skill install never creates a retention policy. Unknown files, corrupt manifests,
all active runs and runtime resources needing targeted teardown are preserved or reported.

A daily backstop is optional:

```bash
node bin/factory.mjs setup --cleanup-schedule --dry-run  # inspect scheduler configuration
node bin/factory.mjs setup --cleanup-schedule            # install daily reporting, no deletion
```

This configures one user-level launchd job on macOS, a systemd user timer on Linux, or a Task Scheduler
job on Windows. It runs the factory coordinator, which invokes each repo's installed engine; downstream
skills do not reach into factory-core. Scheduled results live at `~/.agents/factory/cleanup-last.json`;
status hooks surface candidates, failures and repos needing an engine update once per result/session.
After repo retention policies are configured, `setup --cleanup-schedule --apply` explicitly enables
policy-protected GC. A later setup without `--apply` preserves that setting; edit the machine's
`cleanup-schedule.json` to set `apply` to false to return to reporting. No job is installed by normal
`factory setup` or skill installation. Scheduler activation failures and stale mutation locks are
reported for inspection; locks are never stolen from concurrent cleanup.

### Scheduled triage

Lesson triage can run on a schedule, too:

```bash
node bin/factory.mjs triage --due --dry-run              # what would launch right now, per scope
node bin/factory.mjs setup --triage-schedule --dry-run   # inspect scheduler configuration
node bin/factory.mjs setup --triage-schedule             # install: checks every 4 hours
```

Every 4 hours, the job runs `factory triage --due`. For each queue (core, org, and each repo's own) that is due by
its cadence, it starts one interactive triage session in the source repo through the machine's
`sessionLauncher`. The session opens the repo's `adapters.agentCLI`, else the machine's. It clusters
the queue, builds the lesson branch and opens the review gate, the only place it waits for you. The
job launches a scope at most once every 20 hours and never between 22:00 and 07:00. With no launcher,
it only records the due scope in `~/.agents/factory/triage-last.json`, and the status hook in the
source repo names the queue at its next session start. Like the cleanup job, normal `factory setup`
doesn't install it.

The install registry cannot enumerate every unregistered zero-config repo. Its cache, legacy shared
workspace tmp, and user-chosen output overrides need explicit discovery/ownership; no all-disk sweep
is performed. Inactive-owner notices are inspection hints; a transient shell disappearing does not prove abandonment.
Use a stable owner PID for long work. Managed server launch uses a dedicated process-group supervisor.
A worktree can store state in its main checkout, or physically inside the worktree:
preserve retained evidence and durable records before removing the latter.

## Context budget

Context use is held to proxies a hook can measure. Tokens are roughly characters divided by 4.

| What | When it costs | Limit |
|---|---|---|
| Skill description | every session | 600 chars each; 14K chars for all of core |
| SKILL.md body | when the skill is used | 24 KB; longer detail goes in `references/` |
| Script stdout | every call | a stated limit per script, checked in its tests |
| Resolver output | every call | 1 KB + 70 B per neighbor |

The check is a ratchet. A baseline records current sizes, a commit fails only when something grows past its baseline, and the baseline tightens as skills get trimmed.

## Harness parity

Codex may be the daily driver on another machine. `factory doctor` therefore runs its onboarding tests in each harness present, and that includes running workflows (opening a PR, watching CI), not just listing skills. A skill whose instructions only work in one harness fails doctor.

## Onboarding a repo

1. `node ~/Documents/repos/factory-core/bin/factory.mjs install core --to . --commit` (use `--local` for a team repo, and add `expedia` for an EG repo).
2. Answer the PR-marker question.
3. For `--commit`, commit the install (`install` prints the command). Doctor's worktree check reads `HEAD`, so it fails until then. A `--local` install has nothing to commit.
4. `node … factory.mjs doctor` checks:
   - the resolver
   - the marker policy
   - no leftover colliding skills
   - lock hashes
   - CLI versions
   - harness discovery, from the main checkout and from a throwaway worktree
   - the context budget
   - host linters: a warning when the repo's oxlint, ESLint or Biome would lint the installed skills' scripts under its own rules, with the ignore line to add (install prints the same warning)
5. Start sessions in the repo.

## A new machine

Clone factory-core, factory-org and your repos as siblings, then:

```bash
node ~/Documents/repos/factory-core/bin/factory.mjs setup            # --root <dir> for repos kept elsewhere
```

It does what a clone can't bring:
- **The user hooks.** It adds the `status --hook` entries to `~/.claude/settings.json` and `~/.codex/hooks.json` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` move them). Trust them in the next interactive Codex session.
- **installs.json.** A `--commit` repo's skills and lock arrive with the clone, but this machine's `~/.agents/factory/installs.json` doesn't list it, so `update --all` would skip it. `setup` records each repo under `--root` (default: factory-core's parent directory) that carries a lock.
- **The triage schedule (optional).** `setup` says when it isn't installed. `setup --triage-schedule` adds it: every 4 hours, it opens a triage session in factory-core or factory-org when that repo's lesson queue is due (see Scheduled triage).
- **Team repos.** A `--local` install is never tracked, so a clone has none. `setup` lists the repos with no install. Run `install … --local` in the ones you work in, then `/factory-repo-register`, because `project.json` was untracked too.

Keep the resolver and scripts fast, small and free of dependencies. On Windows, `factory` copies skills instead of linking them, and every script runs without a shell.
