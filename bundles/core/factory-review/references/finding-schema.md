# Reviewer output schema (every persona)

Every persona returns one JSON object and nothing else. No prose outside the JSON.

```json
{
  "reviewer": "<persona name, e.g. general, react-patterns>",
  "findings": [
    {
      "severity": "P0" | "P1" | "P2" | "P3",
      "confidence": 0.0,
      "blocking": true,
      "mode": "comment" | "question" | "human_eyes",
      "file": "relative/path/from/repo/root",
      "line": 123,  // line in the file at the head SHA, never a line number in diff.txt
      "title": "one-line summary",
      "consequence": "what shipping this makes true that isn't true now",
      "principle": "one sentence that would hold in a different codebase",
      "rule": "rule-name-from-compiled-file" | null,
      "evidence": "the diff line(s), the rule, and the verification you did",
      "recommendation": "fix sketch: the concrete change, as code when it fits in ~10 lines",
      "pre_existing": false
    }
  ],
  "checked_left_alone": [
    { "file": "path", "line": 88, "why_looked": "what made you stop", "why_not_a_finding": "the reason it holds" }
  ],
  "sweep_dispositions": [
    { "signal": "css-layout-rule", "file": "path", "line": 120, "disposition": "finding" | "left_alone" | "not_applicable", "note": "the design system's flex layout component covers flex + gap; raised as #2" }
  ],
  "residual_risks": [],
  "testing_gaps": []
}
```

## Field rules

- **`line` is the line number in the file at the head SHA**, the same number GitHub shows on the
  PR's right-hand side. It is never a line number in `diff.txt`: Phase 5 posts on it, and a diff-file
  line lands on the wrong code or fails with `422`. Take it from the hunk header (`@@ -a,b +c,d @@`:
  count from `c` over context and `+` lines, skipping `-` lines), or confirm it with
  `git -C <repo> show <head>:<path> | grep -n '<text>'`. The same applies to `checked_left_alone[].line`.
- **`consequence` is required.** Say what the user sees, what breaks, or what the next engineer
  trips on if this ships. If you cannot name one, you have an observation, not a finding: put it
  in `checked_left_alone` instead, or drop it if nothing made you stop.
- **`principle` is required.** One sentence, phrased so it would hold in a different codebase. When
  the finding matches a compiled rule, the rule's `principle` frontmatter (if present) is a good
  starting point; still state it in your own words for this instance.
- **`blocking`** says whether this must be fixed before merge. It is the fix contract: the verdict
  and every downstream skill key on it, not on severity. Anchors:
  - P0 or P1 that cleared verify-before-P0 → `true`.
  - P3 → `false`.
  - P2 → decide from the consequence: would we accept shipping this as is? If yes, `false`.
  - `pre_existing: true` → `false`.
- **`mode`** is decided by how verifiable the finding is, not by its subject:
  - `comment` — you verified it from the code. State it.
  - `question` — the code alone can't tell you whether there is a reason ("why do we need this
    hook?"). Ask it, in 2–12 words. A question can still be `blocking: true`.
  - `human_eyes` — nothing you can read settles it (a runtime environment, a product decision,
    another team's contract). Reported only, never posted.
- **`severity`** sorts and groups the report. It no longer decides what must be fixed.
- **`checked_left_alone`** is the audit trail of things you investigated and dismissed. Add an
  entry only when something actually made you stop and look. "Would this entry read the same on
  every PR?" — if yes, it describes your process, not this change; leave it out.
- **`sweep_dispositions` answers every hit in the `sweep.md` sections that list you as an owner,**
  one entry per hit, with its signal, file and line copied from `sweep.md`. `finding`: a finding
  covers it. `left_alone`: you weighed it and it holds; `note` says why. `not_applicable`: the
  signal misfired; `note` says how. A note on a signal for which a persona pack requires one (its `sweep-signals.txt`) names
  what it requires (for example the design-system component you weighed). Return `[]` when no section lists you. Phase 3 runs
  `scripts/check-sweep-coverage.mjs` against these (fields in `schemas/reviewer-output.schema.json`),
  and a hit no dispatched owner answered is reported as unreviewed.
- **`recommendation`** is the fix sketch the report shows. Prefer the actual code over a description.
