---
name: factory-glossary
description: Look up what a project term means across the glossary layers this repo has (its own GLOSSARY.md or CONTEXT.md, then each installed glossary layer, then core) and print only the matching entry. Also checks a glossary file's format and finds terms defined in more than one place. Use when a term is unfamiliar or ambiguous, before naming a new module or concept, when adding or fixing a glossary entry, or when a skill says to use the project's vocabulary.
---

# Glossary

A term lives at the level where it's true: one repo, a company or product line, or anywhere. Each level is a layer, and a repo sees the layers it installs.

| Order | Layer | Where |
| --- | --- | --- |
| 0 | repo | `GLOSSARY.md` at the repo root (`CONTEXT.md` is read when there is no `GLOSSARY.md`) |
| set by the layer | installed layers | any skill with a `GLOSSARY.md` and a `glossary.json` (`{"layer": "<name>", "order": <n>}`) |
| 100 | core | this skill's `GLOSSARY.md`: generic process and engineering terms |

A lower order is more specific and wins. A repo's own definition overrides a shared one, and the lookup says which one it overrode.

## Look up a term

```bash
node .agents/skills/factory-glossary/scripts/lookup.mjs "<term>"
```

- It prints the entry and its layer, then any other layer that defines the same term.
- A term listed under an entry's `_Avoid_:` line points to the term to use instead.
- No exact match: it lists close matches and exits 1.
- `--list` prints every term by layer. Don't read a layer file whole; look up the terms you need.

## Add or change a term

1. Decide the layer. A term only this repo uses goes in the repo's `GLOSSARY.md` (create it if the repo has none). A term that holds for a whole company or product line goes in that layer's skill, at its source: run `factory list` to see which repo owns it, then edit it there and run `factory update`. A repo that installs skills locally, without committing them (a team repo), keeps no glossary file of its own; its terms go in a shared layer.
2. Write the entry in this format:
   ```markdown
   **Term**:
   One or two sentences saying what it is, not how to use it.
   _Avoid_: synonym, other synonym (when to avoid it)
   ```
   Group entries under `##` headings. Put a term with two meanings under `## Flagged ambiguities`, and give both meanings.
3. Check the file:
   ```bash
   node .agents/skills/factory-glossary/scripts/lookup.mjs --check GLOSSARY.md
   ```
   It fails when an entry has no definition, has more than two sentences, repeats a term in the same file, or puts the definition on the `**Term**:` line.

## Find a term defined twice

```bash
node .agents/skills/factory-glossary/scripts/lookup.mjs --dupes [file...]
```

With no files, it compares this repo's layers. Pass the `GLOSSARY.md` files of several repos to find a term each repo defined for itself. A term defined in two places belongs in one shared layer: propose moving it to the most general layer where it's still true, and deleting the copies. `factory-reflect`, if installed, makes that proposal when it routes a glossary lesson.
