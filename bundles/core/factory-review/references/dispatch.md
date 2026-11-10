# Dispatch checklist and context matrix

Read this in Phase 2, when you build each reviewer's prompt.

## Prompt contents

Every reviewer is an `Agent` call with `subagent_type: "general-purpose"` and the strongest available model. The prompt opens with: "Read and follow `<personaFile>`. It defines your scope, verification steps and output format." Use the absolute `personaFile` from `personas.json`: it may live in a pack. Personas are prompt files, not registered agent types, so a new one works without restarting the session.

| Item | `general` | Rule personas |
| --- | :---: | :---: |
| Persona file to read and follow | yes | yes |
| Diff path, intent summary, plan path (if found) | yes | yes |
| Target repo path (canonical clone), base and head SHA | yes | yes |
| `references/severity-rubric.md` path | yes | yes |
| `sweep.md` path, "read the sections that list you as an owner" | yes | yes |
| Hook outputs the persona consumes (`run-hooks.mjs` `consumers`) | if listed | if listed |
| One line per absent context file the persona takes, and why | yes | yes |
| Compiled-rules file (its own only) | no | yes |
| Tool budget hint (15 calls) | yes | not needed |

Pass files by path, never inline. Passing every compiled-rules file to every reviewer cost about 200K extra tokens each on reviewers that never used them. `dependency-context.md` goes to every reviewer when it exists.

## Dependency context

If the diff imports a library whose source semantics are load-bearing (an observer hook, an experiment hook), do one read in Phase 1 and write `$RUN/dependency-context.md`: library and version, the one or two behaviour notes reviewers need, and the file path. Reviewers read it before flagging library-behaviour findings. Keep it to what you verified. A misread note passed to every reviewer had three of them cross-flag the same false positive.

## Hook outputs

A persona pack may add context files (see `packs.md`). `run-hooks.mjs` prints each hook's `status`, `output` and `consumers`. Pass an output only to its consumers. For a hook that failed or found nothing to do, tell the consumers the file is absent and why, and list it in the Coverage table. If the pack declares an `agentContext` step, do it in the same batch as the reviewers and read the pack's `SKILL.md` for how.

A schema file such as an SDL, when a hook produces one, is ground truth over generated types when the two disagree. Dismiss a nullability finding the schema contradicts. Raise a field or union member the schema lacks as schema drift.

## Cross-vendor `general`

If `.agents/skills/factory-second-opinion` is installed, a second `general` runs on the other vendor's model, so the review is not limited to one model's blind spots. Run its preflight in Phase 1 (`node .agents/skills/factory-second-opinion/scripts/dispatch.mjs --preflight`). Write its prompt to `$RUN/second-opinion.md` from the `general` row above, adding "Return findings in the format `personas/general.md` defines. Do not modify files." In the same message as the Agent batch:

- Preflight `ready`: one Bash call with `run_in_background: true`: `node .agents/skills/factory-second-opinion/scripts/dispatch.mjs --prompt $RUN/second-opinion.md --out $RUN/second-opinion.out.md --cd <repo path>`.
- Preflight `fallback`: one more `general-purpose` Agent with the same prompt, labelled `general (fallback: <reason>)`.

If the dispatch itself returns `fallback` (a timeout, an empty review), dispatch that Agent then. It is the one reviewer allowed outside the single batch. Phase 3 reads `$RUN/second-opinion.out.md` as `general@<model>`. If the skill is not installed, skip this step.
