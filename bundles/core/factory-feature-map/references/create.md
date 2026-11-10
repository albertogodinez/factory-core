# Create a feature map for a repo

The map goes in the repo it describes: `.agents/skills/factory-features-<project.name>/` under `project.root` (`factory-context`).

## 1. Interview the repo

Answer from the codebase. Ask the user only what you can't observe (design links, which prototype, who owns it).

| Question | Where to look |
|---|---|
| Surface | Routes or controllers, pages, CLI entry points |
| Run | `project.commands` from `factory-context`, the README, the repo's agent instructions |
| Auth | An existing auth skill, or the repo's own login route |
| Drive | A browser harness with stable handles: ARIA names, `data-*` attributes, route paths. Existing end-to-end specs are a good source of handles |
| Inventory | The registries that make a surface exist: component registries, route tables, nav configs, framework route folders |
| Neighbors | Which other repos hold code the features touch. They must be listed under `neighbors` in the project config so anchors can name them |
| Design authority | Ask which source decides what should be built for this repo. Confirm it is a repo default, not merely the source for the first feature |

If the app doesn't start as-is, fix that or report it precisely before writing anything.

## 2. Write `scripts/inventory.mjs` first

- Prints `{"items":[{"id","kind","source"}]}` to stdout. The checker runs it with `project.root` as the working directory.
- When the surface can't be read (a needed checkout is missing), it prints `{"skipped":"<reason>"}` and exits 0.
- It reads the registries found above. No model calls, no network.
- Ids are stable strings people already use, such as registry keys and route paths, so `covers:` stays readable.
- Plain Node, `node:` imports only, so it runs in a hook with nothing installed.
- Type it. Start the file with `// @ts-check`, declare the map's kinds as a union, and type every item through the shared types:

  ```js
  /** @typedef {'route' | 'page' | 'registered-component'} Kind */
  /** @typedef {import('../../factory-feature-map/scripts/inventory.js').InventoryItem<Kind>} Item */
  ```

  `check-map.mjs` also validates the output against `schemas/inventory.schema.json` on every run.

## 3. Write the map's `SKILL.md`

Frontmatter:

- `name: factory-features-<project.name>`
- `user_invocable: true`
- a `description` that names the repo and starts with "Where a feature lives in <repo>", so agents load it when asked where something is or how to change it

Sections: Launch, Auth, Doctor (one read-only health check), Drive (harness conventions), Evidence (saved under `<stateRoot>/feature-map/<name>/<feature>/`), Cleanup (stop only what you started). Each holds real commands from this repo, not placeholders.

Always add `design-authority.json`. When the repo has a settled default:

```json
{
  "version": 1,
  "repo": "<project.name>",
  "defaultDesignAuthority": { "kind": "<kind>", "skill": "<source-skill>" },
  "implementationVerifier": "factory-features-<project.name>",
  "featureOverrides": {}
}
```

The named skills must exist under `.agents/skills/`. When the repo has no default, set `"defaultDesignAuthority": null`. Use a feature override only for a stable exception. With no override and a null default, the resolver stops and the agent asks the user which source is authoritative. It doesn't inspect the available sources to choose one.

## 4. Seed 3 to 5 features

Pick the features the user is about to work on first, then the biggest inventory clusters. Follow [entry-contract.md](entry-contract.md). Run `check-map.mjs` until it passes. Unmapped warnings are expected at this stage.

## 5. Prove it

Run the map's own instructions end to end once: launch, doctor, drive ONE feature, capture evidence, clean up. Then confirm the evidence still exists and set that feature's `last_verified`. A map that was never driven is a draft.

## 6. Wire it in

Mention the map in the repo's agent instructions (for example its `AGENTS.md`), so agents read it before searching for a feature. Point the user at `maintain.md` for upkeep.
