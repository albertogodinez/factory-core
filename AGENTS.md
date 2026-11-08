# AGENTS.md

agent-factory holds the `core` skill bundle and the `factory` CLI that installs bundles into other repos. Read `README.md` for how the system works.

## Design rules

- **Per-repo first.** A skill works from the repo it's installed in. Nothing reaches back into this repo at runtime.
- **Small and fast.** Scripts are `.mjs` files that import only `node:` modules. No network. No dependencies in `package.json`.
- **Local only.** Installs copy files from local paths. Nothing is published or fetched.
- **Every harness.** Nothing in core depends on a feature only one harness has (Claude Code, Codex, Copilot, Cursor).
- **No internal data in core.** No company repo names, reviewer logins, hosts or paths. A core skill gets that data from the resolver (`bundles/core/toolkit-context`), which reads the consumer's config or an adapter bundle. `tests/internal-data.test.mjs` enforces this.

## Layout

- `bin/factory.mjs`: the CLI (install, update, remove, link, doctor, list).
- `bundles/core/<skill>/`: one directory per skill, self-contained: `SKILL.md`, `scripts/`, `schemas/`, `references/`.
- `tests/`: unit and guardrail tests (`node --test`). `tests/fixtures/` holds throwaway git repos built at test time.

## Checks

- `npm test` runs every test. The pre-commit hook runs the same suite, plus the resolver guardrails when `bundles/core/toolkit-context/` changes.
- Let the hook run on every commit. If it fails, fix the cause or the check; never pass `--no-verify`.
- Run `npm run prepare` once per clone so `core.hooksPath` points at `.githooks`.
