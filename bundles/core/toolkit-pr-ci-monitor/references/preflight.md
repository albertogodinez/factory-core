# Local pre-flight

Run this before scheduling the monitor, when the PR touches source or test files. Skip it for docs-only or config-only PRs.

## 1. Pick the toolchain from the resolver

```bash
node .agents/skills/toolkit-context/scripts/resolve.mjs --field project.commands.build
node .agents/skills/toolkit-context/scripts/resolve.mjs --field project.commands.test
node .agents/skills/toolkit-context/scripts/resolve.mjs --field project.packageManager
```

- Run `commands.build`, then `commands.test`. A field that isn't present means "not configured": skip that step and say so in the report.
- Don't assume a package manager or test runner. Use only what the resolver reports. If it reports neither command, read the repo's README or CI config for the commands CI runs, and say that's what you did.
- If the repo pins a runtime version (`.nvmrc`, `.tool-versions`, a `rust-toolchain` file, CI config), switch to it before running anything, and check the active version matches. A failed switch that is hidden by redirecting output has produced a "passing" run on the wrong version.
- For a monorepo, run the build and test commands for the affected packages only, using the repo's own filter convention.

## 2. Check for a stale install after a rebase

When the branch was rebased or merged from trunk since the last dependency install, stale dependencies cause type errors that pass locally and fail in CI, because CI installs fresh from the lockfile.

```bash
BASE=$(git merge-base HEAD origin/<trunk>)
[ "$BASE" != "$(git rev-parse origin/<trunk>)" ] && echo "trunk moved ahead of this branch's base: reinstall dependencies, then re-run the build"
```

Where `<trunk>` is `project.trunk`, and the install is `project.commands.install` if present. Warn the user and recommend the reinstall. Don't block: the user may have installed already.

## 3. Build, then test

Run the build. If it fails, stop: don't schedule the monitor. Then run the tests, scoped to the files the PR changed when the runner supports it. Common local-only causes of a mismatch with CI: a stale install (step 2), a missing generated file, and fixtures that no longer satisfy a changed type.

## 4. A frontend change isn't validated until the app has run

A build passing is not the app working, and neither is an HTTP 200. For any change touching frontend code, config, or the toolchain under it, boot the app and load a real page in a real browser before reporting it validated. Name and justify any exception in the report; don't assume one.

The failure mode: server-rendered HTML arrives with a `200` and full body content, and then the client bundle fails (a missing chunk, a hydration mismatch, a module that resolves at build time but not in the browser). A plain HTTP client can't see past the first half, so it reports success on exactly the changes most likely to break.

The check is console-clean, not status-clean. Load the page with a headless browser from the app directory (so the browser library resolves from its dependencies), listening for page errors, console errors and failed requests:

```js
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = [], failed = [];
  p.on("pageerror", e => errs.push(e.message));
  p.on("console", m => m.type() === "error" && errs.push(m.text()));
  p.on("requestfailed", r => failed.push(r.url() + " :: " + r.failure()?.errorText));
  await p.goto("http://localhost:<PORT>/", { waitUntil: "networkidle" });
  const body = await p.textContent("body");
  console.log("body chars:", body.length, "| errors:", errs.length, "| failed:", failed.length);
  errs.concat(failed).forEach(e => console.log("  * " + e));
  await b.close();
})();
```

Report the three numbers. Non-zero console errors or failed requests is a failed validation, even with a `200` and rendered text on screen. If the page needs a signed-in session, a lost session and a broken render look identical from outside: check authentication before blaming the change.

**Restart the dev server after every rebuild.** A server that read its build manifest at startup serves HTML pointing at chunk hashes that a later rebuild removed, so every chunk 400s and hydration dies. It looks exactly like a code regression and isn't one. Compare when the build happened with when the server started (file mtime against process start time). Build newer than server start means restart before believing the page. When comparing two ports (a change against its baseline), check both.

Delete any probe script you wrote into the worktree when finished. It must not reach a commit.
