// Primitive Fit Audit — parameterized workflow.
//
// USAGE
//   1. Complete Phase 0 of SKILL.md first. This script assumes BRIEF.md already exists and holds
//      verified facts, including the gate/reachability finding.
//   2. Edit the CONFIG block below. Every field is required; the LENS prompts read from it.
//   3. Invoke: Workflow({ scriptPath: "<path to this file>" })
//      To iterate, edit the persisted copy under the session dir and re-invoke with the same
//      scriptPath — do not re-send the whole script inline.
//
// Agent budget: 5 survey + up to 8 verify + 1 synthesize = 14 max.

export const meta = {
  name: 'primitive-fit-audit',
  description: 'Audit transferred code against a design-system primitive set for replaceable rules',
  phases: [
    { title: 'Survey', detail: 'five independent lenses over the target vs the primitive set' },
    { title: 'Verify', detail: 'adversarially refute each positive claim' },
    { title: 'Synthesize', detail: 'merge into one ranked, deduplicated verdict list' },
  ],
}

// ─────────────────────────────── CONFIG — EDIT THIS ───────────────────────────────
const CONFIG = {
  // Absolute path to the brief written in Phase 0.
  brief: '<stateRoot>/<audit-name>/BRIEF.md',

  // What is being audited.
  target: 'PR #NNN — <one-line description of what moved where>',
  targetPath: '<absolute worktree path>',
  targetFile: '<repo-relative path of the transferred file>',
  targetSha: '<short sha>',

  // The primitive set.
  repo: '<owner>/<repo>',
  trunkRef: '<e.g. origin/main — use the resolver trunk per repo>',
  primitivePrs: [/* e.g. 524, 527, 528, 531 */],
  primitiveDirs: '<e.g. frontend/src/components/primitives/>',

  // Phase 0's reachability finding, stated in one or two sentences. The layout lens leans on this.
  gateFinding: '<e.g. all layout rules are prefixed [data-dr-system="v1"]; only <file:line> writes it>',

  // Where the written record lives — the governance lens reads these.
  docPaths: '<e.g. frontend/docs/layout/*.md, openwiki/frontend/*.md>',
  planPaths: '<e.g. <repo>/plans/*-f*.md>',

  // Guard scripts and derived-set tests the transfer might have disturbed.
  guardPaths: '<e.g. frontend/scripts/layout/*.mjs, **/derive-*.mjs>',

  // Node pin for running any read-only test, or '' to skip.
  nodePath: 'export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$PATH"',

  // Cap on adversarial verifications. Raise for high-stakes audits; the report records the cap.
  verifyCap: 8,
}
// ──────────────────────────────────────────────────────────────────────────────────

const PREAMBLE = `You are auditing whether code transferred in ${CONFIG.target} could be replaced by
design-system primitives merged in ${CONFIG.repo} PRs ${CONFIG.primitivePrs.join(', ')}.

FIRST: read the fact brief at ${CONFIG.brief}. It holds verified paths, token values, the
reachability finding and the ground rules. Follow those ground rules exactly — cite path:line for
every claim, never run a writing git command, never assert a value you have not read from source.
Challenge the brief if you find it wrong; it is the orchestrator's best current understanding, not a
settled fact set.

Target worktree: ${CONFIG.targetPath} (at ${CONFIG.targetSha})
File under audit: ${CONFIG.targetFile}
Trunk ref for comparison: ${CONFIG.trunkRef}
Primitive sources: ${CONFIG.primitiveDirs}

`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'candidates', 'notes'],
  properties: {
    lens: { type: 'string' },
    notes: {
      type: 'string',
      description:
        'Cross-cutting observations that are not per-candidate findings. Include anything that surprised you or contradicts the brief.',
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'target_selector', 'target_evidence', 'primitive',
          'primitive_evidence', 'verdict', 'delta', 'recommendation',
        ],
        properties: {
          id: { type: 'string', description: 'short kebab-case id, unique within this lens' },
          target_selector: { type: 'string', description: 'the selector or rule region in the audited file' },
          target_evidence: { type: 'string', description: 'path:line plus the literal declarations, quoted' },
          primitive: { type: 'string', description: 'the specific primitive, role or token proposed' },
          primitive_evidence: { type: 'string', description: 'path:line plus the literal declarations/values, quoted' },
          verdict: { type: 'string', enum: ['DROP-IN', 'DESIGN CHANGE', 'NOT APPLICABLE'] },
          delta: {
            type: 'string',
            description:
              'exactly what would change in the rendered result. "none" only for DROP-IN. Quantify px/weight/font/tier differences.',
          },
          recommendation: { type: 'string', description: 'do now / follow-up ticket / do not do — and why' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'refuted', 'confidence', 'reasoning', 'corrected_verdict'],
  properties: {
    id: { type: 'string' },
    refuted: { type: 'boolean', description: 'true if the claim is wrong, overstated, or rests on an unread assumption' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string', description: 'what you checked, with path:line citations, and what you found' },
    corrected_verdict: { type: 'string', enum: ['DROP-IN', 'DESIGN CHANGE', 'NOT APPLICABLE', 'UNCHANGED'] },
  },
}

const LENSES = [
  {
    key: 'type-semantics',
    prompt: `LENS 1 of 5 — TYPE / SEMANTIC PRIMITIVES.

Enumerate EVERY typography (or equivalent semantic) declaration in the audited file and decide, per
rule, whether a primitive role could replace it.

1. Read the full role table from source, INCLUDING every responsive tier. Report the breakpoints and
   values. If roles change by tier and the target's tokens do not (or vice versa), no swap is
   size-neutral across breakpoints — that alone downgrades a whole class of candidates.
2. For each target rule, find the nearest role and state the exact delta in px and weight, and
   whether the font-family would change. Resolve BOTH sides' font stacks to literal strings and
   compare them character by character. Byte-identical stacks that no test compares agree by
   coincidence — say so.
3. Check the cascade. Where the target carries !important, find what it was written to beat, then
   compute whether a bare role class could win that tie.
4. Read the components' prop types, not just the CSS classes. Tag unions and role unions can make a
   numerically perfect match unreachable through the sanctioned API. Enumerate which target elements
   sit on tags the components reject — read the JSX, not the CSS.
5. Read any guard/assert functions the components run on className and style. Would a migration trip
   them? Establish whether tripping them fails a build or only logs.

Be exhaustive on the enumeration. A near-miss is a DESIGN CHANGE, never a DROP-IN.`,
  },
  {
    key: 'layout-structure',
    prompt: `LENS 2 of 5 — LAYOUT / STRUCTURAL PRIMITIVES.

Phase 0 established: ${CONFIG.gateFinding}

Your job is to confirm or refute that independently, then decide whether any structural declaration
in the audited file could be replaced.

1. Read every layout primitive's source and CSS. Establish precisely what each requires of its
   ancestors: gate attributes, scoping classes, container-query roots, named grid lines, @supports
   splits.
2. Establish WHO sets the gate. Grep the whole source tree for the attribute and for every primitive
   name. List every call site and route. Determine whether any route that renders the audited
   surface sets it. This decides the lens before shape-fit is relevant.
3. Read the target's actual layout shape from its JSX and CSS. Then judge honestly whether the
   primitives' geometry model maps onto it at all.
4. Look specifically for target regions that DO match the shapes the primitives model — those are
   the only real candidates. Report them even if small.
5. Report what the primitives' validation code enforces and whether a target use would satisfy it.`,
  },
  {
    key: 'tokens',
    prompt: `LENS 3 of 5 — TOKENS.

Decide whether the hardcoded literals in the audited file should become tokens, and whose.

1. Extract EVERY literal length and produce a frequency table of distinct values. High-frequency
   repeats are one design intent and the highest-value candidates regardless of which family wins.
2. Read the primitive system's full token inventory from source, plus its token docs. Report names
   and values explicitly — do not rely on the brief for values you can read.
3. Find the OTHER candidate families. The target surface probably already commits to one; grep
   node_modules and the theme files for its scale and report what exists. There are usually three
   options: raw literals (today), the primitive system's tokens, and the surface's existing scale.
4. Cross-tabulate: exact matches per family, off-scale values, and structural values that should stay
   literal. Off-scale repeats deserve a design question — flag them.
5. THE JUDGEMENT CALL, and I want reasoning not reflex: numeric coverage does NOT decide this. Argue
   from coherence with what the surface already uses, existing precedent in the file itself, and any
   fence. Specifically look for:
     - prose in the token docs restricting consumers, and
     - a verifier script asserting a hard equality against an allowlist of permitted consumer files.
   Read the token artifact's provenance file. If it is a vendored, hash-pinned artifact from another
   repo, taking a dependency on it from this surface has a re-vendor risk — quantify it.
   Guard scripts to read: ${CONFIG.guardPaths}`,
  },
  {
    key: 'governance',
    prompt: `LENS 4 of 5 — DECLARED SCOPE AND INTENT.

"Could this be replaced" is downstream of "is this system meant to apply here". Establish the
declared scope from the written record, not from inference.

1. Read every doc the primitive PRs added or touched: ${CONFIG.docPaths}. Quote the passages that
   define scope. Does the system claim this surface, a different one, or the whole app?
2. Read the PR descriptions:
     gh pr view <N> --repo ${CONFIG.repo} --json body --jq .body
   for N in ${CONFIG.primitivePrs.join(', ')}, plus any CLOSED sibling PRs. Quote any statement of
   scope, sequencing, or "do not use this yet" caveat.
3. Read the migration program documents: ${CONFIG.planPaths}. Report what the program says about
   which surfaces adopt the primitives and in what order, and whether the audited surface is named
   in-scope or out-of-scope anywhere.
4. Look hard for a decision already recorded about this exact question — a program that decided
   "surface X stays on its existing system" is a direct answer and must be quoted verbatim with a
   path:line citation.
5. Report ambiguity honestly. Do not manufacture a conclusion the documents do not support.

Return candidates ONLY where a document explicitly supports or forbids a specific replacement. Put
everything else in notes.`,
  },
  {
    key: 'guard-impact',
    prompt: `LENS 5 of 5 — GUARD AND VERIFIER IMPACT.

Two questions: (a) does the transfer ALREADY affect any guard, and (b) would adopting the primitives
create new obligations?

1. Read every guard/verifier script (${CONFIG.guardPaths}). For each: what paths does it read, what
   does it assert, and is it wired into CI? Read package.json and the CI workflow files to establish
   which actually run on a PR. Report wiring status — an unwired guard is a weaker argument both ways.
2. THE KEY CHECK: find every derived-set scanner whose output is pinned by a test "both ways" (fails
   if the set grows OR shrinks). Establish exactly which files each scans. If the transfer emptied or
   created a file the scanner globs, the transfer was inside its blast radius. Do not reason about
   this — RUN the test on the branch:
     ${CONFIG.nodePath}
     cd ${CONFIG.targetPath} && node --test <the derived-set test>
   Report whether the set survived by design or by an incidental filter; the second is fragile.
   Never run npm ci or npm install. If node_modules is absent, say so and reason statically.
3. Do any baseline/geometry verifiers capture from routes that render the audited surface? If so, the
   transfer or any future adoption needs a baseline re-capture.
4. Forward-looking: if the surface adopted the primitives, which guards would newly apply, and what
   new obligations would that create — registering classes, capturing baselines, keeping a derived
   set in sync? Be concrete about maintenance cost; it is often the real argument against adoption.`,
  },
]

phase('Survey')

const surveys = await parallel(
  LENSES.map((lens) => () =>
    agent(PREAMBLE + lens.prompt, {
      label: `survey:${lens.key}`,
      phase: 'Survey',
      schema: FINDINGS_SCHEMA,
    })
  )
)

const ok = surveys.filter(Boolean)
log(`surveys returned: ${ok.length}/${LENSES.length}`)

const allCandidates = ok.flatMap((s) =>
  (s.candidates || []).map((c) => ({ ...c, lens: s.lens || 'unknown' }))
)
const positive = allCandidates.filter((c) => c.verdict !== 'NOT APPLICABLE')
log(`${allCandidates.length} candidates total; ${positive.length} positive claims`)

// Verify positive claims only: a cited negative is cheap, an over-eager "replace this" is the
// expensive mistake. The cap is recorded so the report can label the remainder honestly.
const toVerify = positive.slice(0, CONFIG.verifyCap)
if (positive.length > CONFIG.verifyCap) {
  log(`NOTE: capped verification at ${CONFIG.verifyCap}; ${positive.length - CONFIG.verifyCap} unverified, reported as PLAUSIBLE-UNVERIFIED`)
}

phase('Verify')

const verdicts = await parallel(
  toVerify.map((c) => () =>
    agent(
      PREAMBLE +
        `You are an ADVERSARIAL VERIFIER. Your default answer is refuted=true. A peer claims a piece
of the audited code can be replaced by a primitive. Try hard to prove it wrong before accepting it.

CLAIM ID: ${c.id} (lens: ${c.lens})
Target: ${c.target_selector}
Target evidence offered: ${c.target_evidence}
Proposed primitive: ${c.primitive}
Primitive evidence offered: ${c.primitive_evidence}
Verdict claimed: ${c.verdict}
Delta claimed: ${c.delta}

Check independently, by reading source:

1. CITATION CHECK. Open every cited path:line. Does it say what is quoted? A citation that does not
   refutes the claim outright.
2. UNDERSTATED DELTA — the most common failure by far. Re-read the FULL cited block on the primitive
   side and enumerate EVERY declaration the swap would add or drop. Do not check only the properties
   the claim names. Claims routinely omit a declaration sitting inside the very range they cite.
3. THE CURRENT SIDE NEEDS A CITATION TOO. If the claim describes the current value as a default or
   as inherited, trace it up the ancestor chain including resets and normalize layers. An asserted-
   but-unread current value is a refutation.
4. DROP-IN RIGOUR. If the verdict is DROP-IN, resolve both sides' tokens to literals and compare
   strings. Check responsive tiers, theme variants, letter-spacing units (an em value on a different
   font-size is a different absolute), and line-height. Anything differing anywhere is not a DROP-IN.
   Then ask the ownership question: after the swap, who moves this value next, and does that party
   know this surface exists? A cross-family DROP-IN transfers governance even at zero pixels.
5. CASCADE CHECK. Compute specificity for the replacement and for everything it must beat. Where the
   current rule carries !important, find what it was fighting.
6. REACHABILITY CHECK. If the proposal involves a gated primitive, confirm whether the gate is set on
   an ancestor on the route that renders this surface. If not, the CSS is inert and the claim fails
   unless it also proposes setting the gate.
7. API CHECK. Read the component's prop types. Is the target element's tag in the accepted union? Is
   the role reachable through the component at all?
8. GUARD CHECK. Would this trip a component assert, or change a derived set a test pins both ways?

If the claim survives all eight, set refuted=false. If it is directionally right but the verdict or
delta is wrong, set refuted=true and give the corrected_verdict. Return id exactly as given.`,
      { label: `verify:${c.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
    )
  )
)

const byId = {}
for (const v of verdicts.filter(Boolean)) byId[v.id] = v

phase('Synthesize')

const payload = JSON.stringify(
  {
    lens_notes: ok.map((s) => ({ lens: s.lens, notes: s.notes })),
    candidates: allCandidates.map((c) => ({ ...c, verification: byId[c.id] || null })),
    verify_cap: CONFIG.verifyCap,
    positive_claim_count: positive.length,
  },
  null,
  1
)

const synthesis = await agent(
  PREAMBLE +
    `You are the SYNTHESIZER. Five survey agents and a set of adversarial verifiers have finished.
Merge their output into one decision-ready answer to:

  "Of the code transferred in ${CONFIG.target}, is any of it now replaceable by the primitives from
   PRs ${CONFIG.primitivePrs.join(', ')}?"

Raw material:

${payload}

Produce a markdown report with these sections and nothing else:

## Verdict
Two or three sentences answering directly. If nothing is replaceable, say that plainly.

## Reachability
What is gated, what is not, and what that means for this audit — with citations. If the halves of the
primitive system answer differently, lead with that.

## Findings
A table of every candidate that survived verification, most consequential first:
| # | Target | Primitive | Verdict | What would change | Recommendation |
Then one short paragraph per row with path:line evidence.

## Refuted or downgraded claims
Every candidate a verifier refuted or corrected, with one line on what was wrong. This section is how
the reader calibrates trust in the rest — do not omit it when it is unflattering. Claims beyond the
verification cap of ${CONFIG.verifyCap} must be labelled PLAUSIBLE-UNVERIFIED, and the cap stated.

## Governance answer
What the written record says about whether this system is meant to apply to this surface. Quote it.

## Recommended action
An ordered list, split into: (a) nothing to change in the audited PR, (b) worth a follow-up ticket,
(c) explicitly do not do. Include the maintenance-cost argument where it applies, and flag any
cross-family DROP-IN that should be declined despite matching.

Rules: cite path:line for every factual claim. Never present a refuted claim without labelling it.
A cleanly proven null result is the valuable outcome, not a failure. Do not pad.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return {
  candidate_count: allCandidates.length,
  positive_claims: positive.length,
  verified: Object.keys(byId).length,
  verify_cap: CONFIG.verifyCap,
  report: synthesis,
}
