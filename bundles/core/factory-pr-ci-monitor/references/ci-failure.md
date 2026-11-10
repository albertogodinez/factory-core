# Diagnosing and fixing a CI failure

When a check fails:

1. **Report it.** List the failed checks with their URLs.
2. **Fetch the failed logs:** `<GH_PREFIX>gh run view <RUN_ID> --repo <owner>/<repo> --log-failed`. Read the log before choosing a cause.
3. **Diagnose.** Classify the failure:
   - coverage threshold: untested functions or branches;
   - lint or format errors;
   - type errors. If they sit in fixtures and reference types from another package, suspect a stale install after a rebase (see `preflight.md` step 2);
   - test failures: read the failing assertion, and check the helper or matcher is the right one for the data shape under test, since a wrong-shape matcher fails only in CI's runner;
   - build or bundle-size failures;
   - infrastructure: a runner outage, a queued run, a known flake. Name the flake and re-run the job. Don't change code for it.
4. **Get the full picture locally before fixing.** Run the project's full test command (`project.commands.test`) and coverage run so every gap and failure shows at once. Fix all of them in a single commit. Don't fix one and push.
5. **Read the project's test conventions** (its testing guide or neighboring tests) before writing or fixing test code, for the provider setup, mocks and fixtures to reuse.
6. **Auto-fix what is in scope:**
   - coverage: write tests for every uncovered function and branch in one pass;
   - lint: run the linter with its fix flag, and commit the fixes;
   - types: read the error and fix the type, don't cast it away;
   - tests: fix the logic, or update the expectation if the old one encoded the old behaviour;
   - size: raise a size budget only when the new code legitimately adds size, and say so.
7. **Verify locally** that the thresholds pass before pushing.
8. **Ask the user before pushing.** The monitor continues after the push.

If it can't be auto-fixed (complex logic errors, unclear requirements), report the diagnosed cause, the suggested next steps, and the relevant log lines or code.
