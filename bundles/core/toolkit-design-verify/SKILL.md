---
name: toolkit-design-verify
description: Verify one implementation against the design authority configured for its repository and feature. Use for design-fidelity checks, UI measurements, and "does this match the design?" requests. Resolves one authority before loading source-specific instructions; comparing several design sources is a separate, explicit drift audit.
user_invocable: true
---

# Design verification

Resolve the design authority before opening Figma, a prototype, production, or any source-specific
skill:

```bash
node .agents/skills/toolkit-feature-map/scripts/resolve-design-authority.mjs <repo> [feature-id]
```

Read only the returned `designAuthority.skill` and `implementationVerifier`. The authority provides
the expected result. The implementation verifier provides the actual result.

If the resolver exits 3, ask one question: "I don't have a configured design authority for
`<repo>/<feature>`. Which source should I treat as authoritative, and is that choice for this task,
this feature, or the whole repository?" Do not inspect candidate sources before the answer. When the
user names a source without a scope, use it for the current task only. Write a feature override or
repo default only when the user explicitly chooses that scope.

If the configured authority is unavailable, stop and report it. Another source does not silently
replace it.

Use extra sources only when the user asks for a drift or reconciliation audit. Production answers
what is deployed unless the resolved policy names production as the authority.

## Geometry

When both sides have geometry JSON, compare them with:

```bash
node .agents/skills/toolkit-design-verify/scripts/compare-geometry.mjs \
  --authority <expected.json> --authority-card <selector> \
  --implementation <actual.json> --implementation-card <selector>
```

The command prints a Markdown table. Exit 3 means at least one box differs. Exit 4 means every box
matches but one side is **off-grid**: a box sits a few px (up to `--near-px`, default 6) off a left or
right inset its sibling boxes share. An off-grid authority is a question for the designer, not a spec
to copy: the prototype's hotel skeleton put the price 4px inside the 20px card inset
(`--pricing-unit-inset`), the implementation matched it box for box, and XD then asked for a
consistent 20px. Run the check on the authority alone as soon as it is measured, before coding:

```bash
node .agents/skills/toolkit-design-verify/scripts/compare-geometry.mjs --alignment <expected.json> --card <selector>
```

Ask "the <part> sits <n>px off the <inset>px inset the rest of the card uses; is that intended?"
and record the answer next to the measurement. The schema is
`schemas/geometry.schema.json`. Tests create synthetic geometry in an OS temp directory and remove
it after the run. Run them with `node --test scripts/compare-geometry.test.mjs`.

Headless agent-browser reports a `.5px` border as `1px` in computed style, even at
deviceScaleFactor 2. Take hairline and border widths from a headed session
(`auth.sh login --headed`) before calling a difference.

