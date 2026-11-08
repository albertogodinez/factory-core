# Triage detail

How to judge a reviewer finding, and how to write the reply. Read it before the first fix in a session.

## Validate before changing anything

Three outcomes: valid (fix, then reply with what changed and how it was verified), invalid (change nothing, reply with the evidence), unclear (surface to the user with what you checked).

Failure modes to guard against:

- **The report understates the scope.** A finding that names one site is often one instance of a class. Grep for the pattern across the repo before declaring it fixed. A review that flags one stale default may have four behind it, including one in a different code path that a literal reading misses.
- **The finding is right but the obvious fix is wrong.** Ask which layer the invariant belongs in. When a "cleared value still carries a stale field" finding arrives, widening the emptiness check looks like the fix and may break another signal that depends on that check staying narrow. The right change may be in the clear path.
- **Your own "this is safe" reasoning is a claim too.** When you leave something deliberately unfixed, state the reasoning in the reply and ask for confirmation instead of asserting it. Never normalise an unset value onto a meaningful one in a comparison: defaulting `undefined` onto a real value makes that one value undetectable. Use a sentinel that can't collide (`""`, `null`), or compare the unset-ness separately.
- **Re-audit the class after each accepted finding.** If three findings in a row were consequences of this PR's own changes, the next probably is too. Ask "what else touches this field?" and grep before replying that it is done. Declaring completion is itself a claim.

When a finding lands on a test, check whether the test's stated premise still holds. A test whose docstring argues for behaviour the PR deliberately reverses should be replaced, with the docstring explaining what superseded it, not patched assertion by assertion. Patching leaves a test arguing against its own file.

## Fix, verify, reply

1. Apply the fix.
2. Run `project.commands.test` and any contract or source-assertion suites the change could invalidate. Suites that assert on source text are the ones bot reviewers most often catch, because they fail on something a type check can't see. Find them by grepping the tests for the renamed or deleted identifier.
3. Add or extend a test that locks the invariant. For a "the tests don't catch X" finding, the reviewer's examples are a sample, not the scope: list every case of the changed contract (each prop combination callers pass, each optional prop at its default, the state before and after each interaction), break the code once per case on a copy of the file, and confirm a test goes red each time. The reply names the cases you broke, so it claims only the coverage you showed.
4. Ask the user before committing and pushing. Never auto-commit, even mid-monitor.
5. Reply once the fix is pushed.

## Writing the reply

State the commit SHA, what changed, how it was verified, and, when true, that the finding was broader than reported or that this PR introduced the bug. Credit the catch.

When the finding is invalid, say so plainly and show the evidence: quote the source line or the measured value that refutes it, name which part of the premise fails, and say that no change was made and why a defensive change would be misleading. Offer the observation that would change your mind. Don't make a token change to look responsive.

A screenshot can't go through the in-thread `replies` endpoint, which takes only a body. Upload it once (for example in the PR description or a top-level comment), then link the resulting attachment URL from the in-thread reply.

## De-duplication and body-only findings

- Reviewers sometimes post the same finding twice on one line. Answer the first fully, and reply to the duplicate with a one-liner pointing at the answered thread.
- Several findings that share an answer: reply substantively to the first, and point the others at it by permalink.
- A body-only review finding has no thread. Open the top-level reply by naming the review it answers and linking it, and say why it is top-level, so a reader doesn't think a thread was skipped.
