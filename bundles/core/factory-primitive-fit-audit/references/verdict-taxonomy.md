# Verdict taxonomy and failure-mode catalogue

Read this before writing the fact brief. The ground rules below go into the brief verbatim; the
failure modes go into the verifier prompts.

## The three verdicts

Every candidate gets exactly one.

| Verdict | Means | Bar |
| --- | --- | --- |
| **DROP-IN** | Computed-identical at every breakpoint, in every theme, and the cascade outcome is unchanged. | Chase both sides' tokens to a literal and compare strings. Anything that differs anywhere is not a DROP-IN. |
| **DESIGN CHANGE** | A primitive exists and would work, but rendering changes. | Quantify the delta in px / weight / font / tier. "Minor" is not a delta. |
| **NOT APPLICABLE** | Structurally impossible or forbidden. | Say which: unreachable CSS, tag/role union excludes it, cascade loss, executable fence, governance prohibition. |

There is no "probably fine" verdict. A candidate you cannot resolve is a DESIGN CHANGE with the
open question stated.

## Computed-identical is not equivalent

The trap that makes DROP-IN the most dangerous verdict rather than the safest.

Two declarations can resolve to the same value today and still not be interchangeable, because
replacing one with the other **transfers ownership of the next change**. Ask, always:

> Who moves this value next, and does that party know this surface exists?

A worked example. A badge-shaped element reads its size from a brand-theme component token; a
design-system role reads the same 12px from a vendored token artifact regenerated from another
product's Figma. Both render 12px. After the swap:

- a brand change to badge sizing **stops** moving this element, and
- a token re-vendor from an unrelated product **starts** moving it, with no review of this surface in
  that loop.

Zero pixels changed and the governance got worse. So a DROP-IN across token families should normally
be **declined**, and the report should say why rather than listing it as free cleanup. Report the
match — recommending against it is a separate judgement from finding it.

Corollary: when two token families hold byte-identical values and no test compares them, they agree
by coincidence of shared origin. Nothing keeps them agreeing. Note it.

## Reachability precedes fit

Establish, for every primitive, whether its CSS can match at all on the target's surface, before
asking whether it fits. Three shapes:

1. **Not imported.** Adoption is an import away. Cheap.
2. **Imported and gated.** Every selector carries an ancestor condition; nothing on the target route
   satisfies it. The CSS ships on the page and never applies. Adoption means planting the gate — and
   thereby opting the subtree into the whole system that gate guards. This is a structural decision,
   not a substitution, and it is routinely misread as the first case.
3. **Imported and ungated.** Global classes. Fit is the only question.

The halves of one design system frequently differ here — ungated typography, gated layout — so
resolve it per primitive, not per system. When they differ, the audit has two different answers and
the report must say so up front.

## Failure-mode catalogue

Each of these has actually produced a wrong claim. Put them in the verifier prompt.

### 1. Understated delta — the dominant failure

A surveyor cites a line range and omits a declaration inside the range it cited. Observed at 3-of-8
on verified claims. Two claims cited a role's block and both missed a `text-wrap: balance` sitting in
it; both reported only the font-size delta.

**Verifier instruction:** re-read the full cited block and enumerate every declaration the swap would
add or drop. Do not verify only the properties the claim names.

### 2. An asserted current value that was never read

A claim described the current computed value as a browser default without opening anything. A CSS
reset several layers up had already set it, so the real delta was 1px rather than a jump.

**Verifier instruction:** the *current* side of a delta needs a citation as much as the proposed side.
Trace inherited properties up the ancestor chain, including resets and normalize layers.

### 3. The match is unreachable through the component API

A role can be numerically perfect and still be unreachable: component tag unions
(`h1`–`h6` only) and role unions (text components excluding heading roles) can make a "match"
impossible to express without also changing the element's tag.

**Verifier instruction:** read the component's prop types, not just the CSS class. Confirm the target
element's tag is in the accepted union.

### 4. The replacement loses the cascade

Existing `!important` declarations usually exist to beat a design-system default at equal
specificity. A bare replacement class carries no `!important` and simply loses.

**Verifier instruction:** compute specificity for both the replacement and everything it must beat.
Where the current rule carries `!important`, find what it was fighting before accepting a swap.

### 5. Equal-specificity ties decided by source order

When two rules set the same property at equal specificity, only load order decides, and load order is
invisible to lint, typecheck, unit tests, and source assertions. Related failure: a **dev** build
inlines stylesheets that ship as separate chunks in production, reversing tie outcomes and
manufacturing regressions that do not exist in the artifact.

Build both sides with a production build before believing any cascade diff.

### 6. Numeric coverage mistaken for permission

Two token families can both cover a set of literals exactly. Coverage does not pick the winner —
coherence with what the surface already uses, existing precedent in the file, and executable fences
do. Check for a fence before recommending a family:

- prose in the design docs ("does not authorize new consumers of …"), and
- a verifier script asserting a hard equality against an allowlist of permitted consumer files.

An executable fence outranks a numeric match, and it fails the moment it runs regardless of whether
it is currently wired into CI. Note the wiring status either way — an unwired guard is a weaker
argument in both directions.

### 7. The transfer disturbed a derived-set guard

A transfer that empties a file can change what a derived-set scanner derives, and such sets are
commonly pinned "both ways" (failing if the set grows *or* shrinks).

**Check:** read what the scanner globs. If it globs the file the transfer emptied, the transfer was in
its blast radius — then run the both-ways test on the branch rather than reasoning about it. Note
whether the set survived by design or by an incidental prefix filter; the second is fragile and worth
reporting.

### 8. Fixture and harness routes that lie about coverage

A fixture route that falls back to a default on an unrecognised id will silently measure the wrong
thing. Assert the rendered fixture matches what was requested.

## Ground rules for the brief

Copy into `BRIEF.md`:

- Read the source. Never assert a token value, size, selector, or resolved font stack you have not
  read. Cite `path:line` for every claim.
- A replacement counts only if it is behaviour-preserving **or** a deliberate, named design change.
  Numeric near-misses are not drop-ins.
- Distinguish the three verdicts. Quantify every delta; "none" is only permitted on a DROP-IN.
- Read-only git only: `show`, `log`, `grep`, `diff`, `ls-tree`. No `commit`, `add`, `checkout`,
  `stash`, `push`, `worktree`.
- Never run `npm ci` / `npm install`. If `node_modules` is absent, say so and reason statically.
- Write only under `<stateRoot>`.
- Challenge the brief if it is wrong. It is the orchestrator's current best understanding, not a
  settled fact set.
