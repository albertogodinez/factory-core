# Core glossary

Process and engineering terms that hold in any repo. Look a term up with `node .agents/skills/toolkit-glossary/scripts/lookup.mjs <term>` instead of reading this file whole; a repo's own `GLOSSARY.md` and any installed glossary layer are searched first.

## Working on a change

**Plan**:
A living document for work in progress, moved through `draft`, `active`, `completed`, or `abandoned`, that records intent and open decisions. An index plan owns a programme's sequence and state while child plans hold detail.

**Base-dependent fact**:
A fact in a plan about a system the programme does not control (a target repo's tooling, config, or trunk state), which ages on its own and is re-derived at each decision point. Contrast a work-owned fact, which stays valid until the programme changes it.

**Definition ticket**:
A ticket whose deliverable is a settled specification (for eventing, the event table plus any registration) rather than code, paired with implementation tickets that consume its values. New registrations make it the long-lead item.

**Evidence pull request**:
A pull request opened to collect verdicts on an approach, not to be merged. The team porting from it owns the verdict on what is carried across; only decisions the author explicitly reserved need the author's sign-off.
_Avoid_: spec PR

**Reference implementation**:
The repository a decision record or plan names as the pattern to copy, authoritative because it was named. A checked-out sibling with an adjacent name is not a substitute.
_Avoid_: the reference repo, the example app

**Registered repository**:
A repository recorded in a workspace registry (the file a `project.json` names with `"workspace"`), which lets the resolver give its trunk, package manager and commands as a neighbor. An unregistered repository a change must touch is a scheduling cost found while planning.
_Avoid_: sibling repository (when the distinction matters)

**Dev slot**:
One worktree's dev server running in its own container on its own host port, so parallel agents validate the same app without sharing its fixed port. It belongs to the worktree that started it; its commands keep the short name (`slot up`, `slot check`, `slot down`).
_Avoid_: slot (alone, outside `toolkit-dev-slot`), the dev server (when several run at once)

## Generated and vendored files

**Provenance stamp**:
The metadata a generated-documentation run records to name the commit its prose describes, which is an ancestor of the branch tip, never the tip. It goes stale when that commit stops being an ancestor or when later commits change what the prose describes.
_Avoid_: reachable (existence and ancestry are different checks)

**Vendored artifact**:
A build output committed to a repository as a pinned snapshot because its generating pipeline runs where the repository cannot reach. It is a mirror, not a source of truth: a local edit is drift that the next refresh reverts.

## Design systems and CSS

**Token family**:
A set of design tokens that share a naming prefix and a single owner, the party whose change moves every value in the set. A token family is a statement of provenance, so two families that resolve to the same value today are not interchangeable.

**Emitted surface**:
The set of CSS properties a design system's utility classes actually declare, read from its compiled stylesheets. It is the complete denominator for "how much of this CSS could the design system own"; a property outside it is a firm negative.
_Avoid_: documented API, prop surface (both are different, incomplete sets)

**CSS ownership migration**:
Moving a surface's styling from a global stylesheet into a file the component owns (phase one, proven by computed-style parity), then cutting what the design system already provides (phase two, defended by measured deltas). The two phases never share a commit.

## Quality gates

**Source-contract test**:
A test that reads a component's source as text and asserts on substrings or patterns, instead of importing or rendering it. It pins the source's shape, not its behaviour, so a failure during a deletion is a question to re-point or delete, not a blocker.
_Avoid_: source-text test, contract test

**Suppressions ratchet**:
A lint baseline that records accepted findings per file and rule and fails when a count rises or a new file or rule appears. It lets a rule turn on with existing debt while forbidding new debt.

## Flagged ambiguities

**Provenance**:
Either a provenance stamp (which commit generated docs describe) or a vendoring manifest (which upstream commit and content hashes a set of vendored artifacts came from). Say which you mean.
