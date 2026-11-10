---
name: factory-primitive-fit-audit
description: Audit transferred or relocated CSS/components against a design-system primitive set to determine what can actually be replaced. Runs a five-lens parallel survey, adversarially verifies every positive claim, and reports honest coverage. Use when code has been moved into a new home (component-owned stylesheet, extracted package, new file) and you need to know whether the new primitives supersede any of it. Triggers on "can this be replaced by our primitives", "audit <PR> against the primitives we built in <PRs>", "does anything here duplicate the design system".
user_invocable: true
---

# Primitive Fit Audit

Answers one question: **of the code that just moved, is any of it now redundant with a primitive we
already shipped?**

The honest answer is usually "almost none," and a clean null result is the valuable outcome — not a
failure to find work. This skill is built to make that answer trustworthy, because the expensive
error here is the opposite one: a confident "yes, swap this" that quietly changes rendering.

**But that framing only holds for the question this skill was built for.** It is right for
*reachability* ("is this gated primitive even reaching the target?") and it actively licenses
under-reporting for *reduction* ("what can this file stop owning?"). A null result is trustworthy only
if the audit was run **library-first** — see Phase 0 step 0. Two audits in the same program returned
a wrong null: one because its role inventory was mid-rename (staleness, fixed in Phase 0 step 2), one
because it only checked the primitives the reader happened to recognise (direction, which is what
step 0 exists for).

## When NOT to use this

- **The code is being written fresh.** Then just use the primitives. This skill is for auditing an
  existing body of code against a primitive set that landed after it.
- **You already know the answer.** A single-rule question is a grep, not a 14-agent workflow.
- **The primitives and the target are the same surface and same token family.** Then fit is obvious
  and the interesting question is sequencing, not fit.

## Inputs

Parse from the invocation, and ask only for what you cannot infer:

| Input | How to resolve |
| --- | --- |
| **Target** | The PR, branch, worktree or file holding the transferred code. Resolve to an absolute worktree path and a commit SHA. |
| **Primitive set** | The PRs/tickets that created the primitives, or a directory. |
| **State dir** | `<stateRoot>` is `node .agents/skills/factory-context/scripts/resolve.mjs --field stateRoot`. The audit writes only there. |
| **Repo + trunk ref** | From the resolver (`project.trunk`, or the neighbor's `trunk`). Confirm it against `origin/HEAD`; a repo's trunk is not always `main`. |

## Phase 0 — Scout inline. Never delegate this.

Subagents handed a wrong frame produce fluent, confident, wrong output, and the frame is set here.
Do all of Phase 0 yourself before dispatching anything.

0. **Enumerate the primitive surface BEFORE you read the target. Mechanically.**

   Skip this and the audit silently reports your recall instead of the library's surface. The two
   reports are indistinguishable — internally consistent, backed by a real read of the file, and
   wrong by however much you did not happen to remember.

   Every prop on a layout/spacing primitive emits a utility class whose rule declares the property
   that prop controls, so the library's compiled CSS is a machine-readable map of prop surface -> CSS
   property. Join it against the target and read the result **ascending by count**:

   ```bash
   python3 .claude/scripts/library-surface-join.py \
       <target.css> '<primitive-dir-or-node_modules>/**/*.css'
   ```

   Ascending, because a rule holding one declaration a prop expresses lets you delete the **whole
   rule** — and a one-line rule is what you skim past reading top-to-bottom. On one run the tail of
   the candidate list held every missed primitive: `grid-template-columns` (a grid), and
   `margin-block-end` / `padding-block-start` / `padding-inline` / `padding-block` (a spacing
   utility). It also held one true hit the `.d.ts` check correctly rejected (`min-block-size`, a
   grid-only prop on a flex container) and one pure false lead — so **a hit is a candidate, never a
   verdict.**

   The half of the output listing properties with **no** primitive equivalent is a stop-looking
   signal, and is usually the majority — 63 of 89 on that run. Put both halves in the brief (step 6);
   the counts are how a later reader tells whether a lens skipped something.

   **The join's blind spot is cross-property substitution.** A `width: 100%` that should become
   `alignSelf="stretch"` never surfaces, because `width` lands in the no-equivalent half — the
   substitution changes which property does the work. The join makes same-property coverage
   exhaustive; semantic swaps still need a lens that knows the library.

   **Source-of-truth order for the prop surface: compiled `.d.ts` in `node_modules` > design-system
   MCP > memory.** An MCP query for one layout API omitted the shared `layout/types.d.ts` entirely —
   the file holding both decisive facts for that audit. The MCP answer was not wrong; it was
   incomplete in a way that looked complete.

1. **Resolve which primitive PRs actually merged.** A closed PR whose content shipped under a
   different number is a real trap — check `state` and `mergedAt` on every one, and diff
   `--name-only` to see where the content actually landed.

   ```bash
   gh pr view <N> --repo <owner>/<repo> --json number,title,state,mergedAt,headRefName --jq '"\(.number) | \(.state) | \(.title) | merged=\(.mergedAt)"'
   ```

2. **Build the pending-changes list, and carry it to the end.** Merged state describes the
   primitives as they are; pending work describes what you would actually be adopting. Two sources,
   and the second is the one that gets skipped:

   ```bash
   gh pr list --repo <owner>/<repo> --state open --search "<primitive dir or token filename>" --json number,title,updatedAt
   gh pr diff <N> --repo <owner>/<repo> --name-only   # does it touch the primitive source?
   ```

   ...and **your own project's written record.** The failure that motivated this step was not a
   missing search: the repo's migration plan already documented, in `HEAD`, that an open PR renamed
   every type role — and the audit still recommended adopting one of those roles. The fact was
   reachable, in a file a survey lens had been pointed at, and it did not travel from that lens to
   the conclusion.

   So the list is a **deliverable of Phase 0, not a search you run once.** Write it into the brief as
   an explicit table (what changes, which PR/doc, what it renames or retires), and check every
   surviving recommendation against it in Phase 3. A pending rename converts "adopt this" into
   "adopt this and coordinate a breaking change" — which is usually a different decision.

   **Record the commit each pending change was read at, because the pending change will itself be
   superseded.** This is the failure one level up, and it is not hypothetical: the audit that
   motivated this skill recorded an open PR's rename table as its correction — and **within 24 hours
   that PR was closed unmerged and replaced by a different PR with a different mapping.** Same
   direction, different names (`dr-caption` -> `dr-caption-01-regular` became `dr-caption` ->
   `dr-detail-02`; a family rename became a family collapse), a different provenance pin, and 60
   emitted roles instead of 24. A correction written against the superseded PR is not merely stale,
   it is confidently wrong in specifics while sounding verified.

   So the pending-changes table needs a **"checked at" column** holding a SHA or PR head, and any
   artifact quoting it must say so. When the target is a vendored artifact, also note that an open PR
   against a moving upstream is the least stable fact in the audit — treat it as a pointer to
   re-resolve, never as a value to copy forward.

3. **Answer the reachability question before the fit question.** This single fact can close half the
   audit, and it is cheap. For each primitive, read its CSS and ask: *is this rule gated?*
   - Look for an ancestor condition on every selector (`[data-x="v1"] .thing`), a scoping class, a
     container-query root, or a conditional import.
   - Then grep for who **writes** the gate. If nothing on the target's route writes it, the CSS is
     loaded-and-inert, and adopting the primitive is a structural decision rather than a substitution.
   - Note the distinction explicitly: *not imported* ≠ *imported and unmatched*. The second is the
     one people misread as "just add the component."

4. **Establish the token families on both sides.** Read what the target's declarations actually
   resolve through and what the primitives resolve through. If they are different families, no swap
   is value-neutral even when the numbers agree — see `references/verdict-taxonomy.md`.

5. **Size the work** so you can tell later whether a lens skipped something:

   ```bash
   for p in font-size font-weight line-height letter-spacing font-family display gap padding margin border-radius grid-template-columns; do
     printf "%-22s %s\n" "$p" "$(grep -cE "^\s*$p:" <target-css>)"
   done
   ```

6. **Write the fact brief** to `<stateRoot>/<audit-name>/BRIEF.md` — verified paths, resolved token values,
   the gate finding, the declaration counts, and the ground rules from
   `references/verdict-taxonomy.md`. Every subagent reads this first. Tell them to **challenge it if
   it is wrong** rather than treat it as settled; a brief that cannot be contradicted propagates your
   own errors.

**zsh gotcha:** `$REF:frontend/...` silently loses `:f` to a zsh history modifier. Always write
`"origin/main:frontend/..."` fully quoted, or brace the variable.

## Phase 1 — Five-lens survey, in parallel

Run the workflow in `references/audit-workflow.js`. Fill in the placeholders at the top, then:

```bash
# Read the script, substitute the CONFIG block, and invoke:
#   Workflow({ scriptPath: ".agents/skills/factory-primitive-fit-audit/references/audit-workflow.js" })
```

The five lenses, and why each one is not optional:

| Lens | Asks | Why it earns its slot |
| --- | --- | --- |
| **type / semantics** | does a primitive role match this declaration exactly? | The obvious lens. Produces the most candidates and the most near-misses. |
| **layout / structure** | which of Phase 0 step 0's candidate properties does a layout primitive actually cover? | **Do not treat this as pre-answered by the gate finding.** That shortcut is exactly how one audit missed a grid, a spacing utility and a flex-item modifier: the gate tells you whether a *gated* primitive reaches the target, and says nothing about ungated utility classes. Work the join output row by row. |
| **tokens** | should these literals become tokens, and *whose* tokens? | Finds the real follow-up work, which is usually not the primitives at all. |
| **governance** | does the written record say this system applies here? | **Most frequently skipped, frequently decisive.** An explicit fence in a doc outranks any numeric match. Read the PRs' bodies, the design docs, and the migration plans. |
| **guard impact** | did the transfer itself disturb a derived-set guard or verifier? | Catches damage the transfer already did. Derived-set scanners that glob the *source* file the transfer emptied are the case to look for — run the both-ways test on the branch. |

**Before any lens spends effort on value-matching, it must clear three near-free structural checks
for each candidate**, structure before values:

1. **Can the element host the primitive?** Grep the `tag`/polymorphic union in the installed `.d.ts`.
   One closed union was `article|aside|div|footer|header|section|ul|ol|li|main` — no `button` — which
   correctly kept a `<button>`'s five flex declarations in CSS regardless of how well they matched.
2. **Does the primitive wrap its child or `cloneElement` it?** A cloning primitive adds no DOM node
   and can land on an element that must keep its own `position`/border/background declarations; a
   wrapping one restructures the tree and is a larger change. `EGDSLayoutPosition` merging the
   child's style onto its own wrapper caused real double-transform bugs.
3. **Do the primitive's breakpoints match the surface's?** A conditional prop switching at 576px
   cannot serve a surface switching at 767px. When the app already carries a JS breakpoint, drive the
   prop from that instead of the primitive's conditional map — it removes the media-query override
   too, which is a larger deletion than the prop itself.

## Phase 2 — Adversarially verify every positive claim

Verifiers default to `refuted = true`. Only claims with verdict ≠ NOT APPLICABLE go to verification:
a cited negative is cheap, and an over-eager "replace this" is the costly mistake.

**Understated delta is the dominant failure mode.** Observed rate: 3 of 8 verified claims, every one
of them for this reason — a surveyor cites a line range and omits a declaration sitting inside the
range it cited. Instruct verifiers to re-read the full cited block and enumerate *every* declaration
the replacement would add or drop, not just the ones the claim mentions.

Cap verification if you must, but **record the cap** and label uncapped claims
`PLAUSIBLE-UNVERIFIED`. Never let an unverified claim read as confirmed.

## Phase 3 — Re-verify the load-bearing claims yourself

Non-negotiable, and the reason this skill produces a trustworthy answer rather than a plausible one.
Identify which two or three findings the headline conclusion actually rests on, and check those
personally from source — do not relay them on a subagent's word.

In practice that means: the gate/reachability finding, any executable fence, the governance quote,
and every claim marked DROP-IN. Deliberately try to break the DROP-IN: chase the resolved value of
each token on both sides through to a literal, and compare the strings.

**Then cross-check every surviving recommendation against Phase 0's pending-changes table.** For each
one ask: *is the thing I am recommending scheduled to be renamed, retired or re-vendored?* This is a
separate pass, done deliberately, because it is the step that fails silently — no lens owns it, and a
recommendation that is correct against today's tree can be wrong against next week's.

When your own check contradicts a subagent, say so in the report. When it confirms one you suspected
was wrong, say that too.

## Phase 4 — Report

Structure:

1. **Verdict** — direct answer in two or three sentences. If nothing is replaceable, say so plainly.
2. **Reachability** — what is gated, what is not, and what that means here.
3. **Findings table** — surviving candidates, most consequential first, with the quantified delta.
4. **Refuted or downgraded** — what the verifiers killed and why. This section is how a reader
   calibrates trust in the rest; do not omit it when it is unflattering.
5. **Coverage** — verification cap, what went unverified, and which claims you personally re-checked.
6. **Recommended action** — split into: nothing to change in the audited PR / worth a follow-up
   ticket / explicitly do not do. Include the maintenance-cost argument, which is often the real
   reason not to adopt a technically-available primitive.

Write the full report to `<stateRoot>/<audit-name>/report.md` and summarize in chat.

**Date-stamp the primitive state, and expect the report to go stale.** Any artifact this audit
produces — the report, a visual explainer, a plan section — pins facts about a moving target: role
names, token values, a provenance SHA. State the commit the primitives were read at, so a later
reader can tell whether the report still applies rather than trusting it silently.

When a pending change later lands, **correct the artifact, don't just say it in chat.** A written
recommendation that has become wrong will outlive the conversation that superseded it; a report
recommending a swap that a merged rename has since broken is worse than no report. If the artifact is
ephemeral (`<stateRoot>`), put the correction somewhere durable — the migration plan — and say which
artifact it supersedes.

## Hard rules

- **Cite `path:line` for every factual claim,** in subagent output and in the final report. A claim
  whose citation does not say what it is quoted as saying is refuted outright.
- **Read-only.** Subagent prompts must forbid every writing git subcommand — `commit`, `add`,
  `checkout`, `stash`, `push`, `worktree`. The orchestrator owns version control. Subagents write
  only under `<stateRoot>`.
- **Never run `npm ci` / `npm install`** in a worktree to satisfy a check. If `node_modules` is
  absent, say so and reason statically.
- **Do not fold the fix into the audit.** This skill investigates. A relocation PR's reviewability
  rests on rule-level parity, and smuggling a tokenization pass into it destroys exactly that.
  Findings become follow-up tickets.
- **Report the null result as a result — but only a library-first one.** "Nothing is replaceable,
  here is the proof" is a common correct outcome and should read as a finding, not an apology. A null
  result from an audit that never ran Phase 0 step 0 is not a null result; it is an unmeasured one,
  and must say so.
- **If the audit recommends adopting a class, verify that class ships in a PRODUCTION bundle.**
  Dev-server CSS chunks completely differently (2 stylesheets vs 29 on one app), so a dev check
  proves nothing about what ships. Grep every chunk a production build links for every class the
  recommendation depends on.

## References

- `references/verdict-taxonomy.md` — the three verdicts, the ownership-transfer trap, and the
  catalogue of failure modes this audit is shaped to catch. Read before writing the brief.
- `references/audit-workflow.js` — the parameterized workflow script. Fill the CONFIG block and
  invoke via `Workflow({ scriptPath: … })`.
- `.claude/scripts/library-surface-join.py` — the Phase 0
  step 0 enumeration. Shared with the migration skill rather than duplicated.
