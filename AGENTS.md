# AGENTS.md

factory-core holds the `core` skill bundle and the `factory` CLI that installs bundles into other repos. Read `README.md` for how the system works.

## Design rules

- **Per-repo first.** A skill works from the repo it's installed in. Nothing reaches back into this repo at runtime.
- **Small and fast.** Scripts are `.mjs` files that import only `node:` modules. No network. No dependencies in `package.json`.
- **Local only.** Installs copy files from local paths. Nothing is published or fetched.
- **Every harness.** Nothing in core depends on a feature only one harness has (Claude Code, Codex, Copilot, Cursor).
- **No internal data in core.** No company repo names, reviewer logins, hosts or paths. A core skill gets that data from the resolver (`bundles/core/factory-context`), which reads the consumer's config or an adapter bundle. `tests/internal-data.test.mjs` enforces this.

## Layout

- `bin/factory.mjs`: the CLI (install, update, remove, link, doctor, list).
- `bundles/core/<skill>/`: one directory per skill, self-contained: `SKILL.md`, `scripts/`, `schemas/`, `references/`.
- `tests/`: unit tests (`*.test.mjs`, run by `npm test`) and `tests/guardrails/` (timing and size limits, run when the code they guard changes). `tests/fixtures/make.mjs` builds throwaway git repos at test time.

## Checks

- `npm test` runs every test. The pre-commit hook runs only the tests the staged change needs (`tests/select.mjs`: the changed skills' tests, the tests of skills whose scripts name them, and the repo-wide checks; shared code such as `bin/`, `tests/` or `factory-context` runs everything), plus the resolver guardrails when `bundles/core/factory-context/` changes. The pre-push hook runs the whole suite. A new cross-skill dependency that isn't a path in a script (`/<skill>/` or a quoted `'<skill>'`) is invisible to the selector: name it in a script, or add the skill to `SHARED_SKILLS`.
- Let the hook run on every commit. If it fails, fix the cause or the check; never pass `--no-verify`.
- Run `npm run prepare` once per clone so `core.hooksPath` points at `.githooks`.

## Commits

- Commit straight to `main` in the main checkout, without asking and without a feature branch. Don't push unless asked.
- A lesson branch approved at the review gate lands at once: run `lessons.mjs land` with the reviewed head and ask nothing more. It commits to `main` and does not push.
- A commit on `main` runs `bin/auto-update.mjs`, which copies the change into every installed repo. Keep `main` committable: no half-done work.
