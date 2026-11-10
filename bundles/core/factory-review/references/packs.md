# Persona packs and resolution

Read this when a persona is missing, when you add a persona or rule, or when you write a pack.

## Where a persona comes from

The project names its personas in `review.personas` in `.agents/factory-metadata/project.json` (the resolver reports them as `adapters.personas`). `scripts/resolve-personas.mjs` does the rest:

1. `general` always runs.
2. With no personas configured, the default set is every persona whose frontmatter has `default: true`. In core that is `fix-root-causes`, `test-behavior` and `no-comments`. A configured list is used as written.
3. To find persona `X`, it looks for `personas/X.md` in this skill, then in each sibling `factory-review-*` directory (a persona pack), in name order. First match wins.
4. Rules for `X` come from `rules/X/` in this skill and in every pack. The directories are merged. A pack file with the same name as a core file replaces it.
5. A persona that is configured but has no file, or no rules directory, is reported with `status: "gap"`. It goes in the Coverage table. It never aborts the run.

`--packs a:b` or `TOOLKIT_REVIEW_PACKS=a:b` adds directories outside `.agents/skills`, for a pack that is not installed.

## Persona gates

A persona file may carry gate keys in its frontmatter. If it has any, it runs only when at least one matches. A skipped persona is recorded as `skipped (<gate>)`.

| Key | Matches when |
| --- | --- |
| `paths` | A regex matches a changed file path. |
| `sweep` | A comma-separated list of sweep signal ids has a hit in `sweep-hits.tsv`. |
| `diff` | A regex matches a line of `diff.txt`. |

Core gates: `react-patterns` needs a JS or TS file, `typescript-conventions` a `.ts` or `.tsx` file, `test-behavior` a test file, `no-comments` an added comment, a suppression, or a deleted constraint comment. `fix-root-causes` always runs.

A repo can be polyglot. Gate by the languages in the diff, not by the repo. A persona with zero compiled rules for the project is skipped: a reviewer with no rules cannot ground a finding.

## Rule files

Frontmatter: `repos: [cross-repo]` or a list of project names (the resolver's `project.name`); optional `repos_exclude: [name]`, which wins over any include; `title`, `impact`, `tags`, `applies_when`, `principle`. See `rules/_template.md`.

## Writing a pack

A pack is a skill directory named `factory-review-<name>` with a short `SKILL.md` (a persona pack for `factory-review`, not invoked directly), `personas/`, and `rules/`. Optional files:

- `sweep-signals.txt`: extra literal-sweep signals. Rows are `id#owners#ERE#path filter#path exclude`. `+id#owners` adds owners to a core signal. `!id#regex` requires a `left_alone` note on that signal to match the regex. Lines starting with `;` are comments.
- `pack.json`: `context` entries run by `scripts/run-hooks.mjs` after the sweep (`name`, `whenPersonas`, `command` with `{RUN} {DIFF} {REPO} {HEAD}`, `output`, `consumers`). `agentContext` entries are steps the orchestrator performs by hand (`name`, `file`, `whenPersonas`, `consumers`, `how`).

## Checking

`node .agents/skills/factory-review/scripts/check-persona-sources.mjs [--all]` checks that every configured persona has a file and a rules directory, and that every persona file has `name` and `description` frontmatter with `name` matching the filename.
