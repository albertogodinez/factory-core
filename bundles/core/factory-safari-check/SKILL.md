---
name: factory-safari-check
description: Check a page in real Safari (not Playwright WebKit) from a session — open a URL through safaridriver, read computed styles with a probe script, save a screenshot. Use only when a change renders differently by browser engine and Safari has to be confirmed — scrollbars, `::-webkit-*` pseudo-elements, `@supports` fallbacks, backdrop-filter, form controls, date inputs — or when a plan or PR says "Safari not checked". Triggers on "check it in Safari", "Safari fallback", "does Safari support", "WebKit fallback unchecked".
user_invocable: true
---

# Safari check

Chrome-only tools (agent-browser, Playwright MCP, Chrome DevTools MCP) can't answer a Safari
question, and Playwright's WebKit is a patched engine build, not Safari. This skill drives the
Safari.app on this Mac through Apple's `safaridriver`, once per run: open, probe, screenshot,
close. Run it when a change depends on the engine, not as a default step of every validation.

`<stateRoot>` is `node .agents/skills/factory-context/scripts/resolve.mjs --field stateRoot`.

```bash
K=.agents/skills/factory-safari-check/scripts
node $K/safari.mjs --url <url> --probe $K/probes/scrollbar.js --shot <stateRoot>/safari/<name>.png
node $K/safari.mjs --serve <dir> --url index.html --probe <your-probe.js> --arg "<selectors>"
node $K/safari.mjs --help
```

It prints JSON: the page URL, the Safari version, the probe's return value and the screenshot
path. A probe is a WebDriver sync script body: it `return`s a JSON-able value and reads
`--arg` values as `arguments[0]`, `arguments[1]`, …. `probes/scrollbar.js` reports
`CSS.supports` for `scrollbar-width` / `scrollbar-color`, then per scroller (the selectors in
`arguments[0]`, or every overflowing element) the computed `scrollbarWidth`, `scrollbarColor`,
`::-webkit-scrollbar` width and gutter. Write another probe beside it when a second property
class needs checking.

## Steps

1. **Pick the page.**
   - **CSS question** (does Safari apply this rule, which fallback wins): build a static page in
     `<stateRoot>` that links the worktree's real stylesheet by relative path and holds one element per
     selector under test, made to overflow or to enter the state. `--serve <dir>` serves it. No
     dev server, auth or port lock is needed, and it can't collide with another session's server.
   - **Rendered app behind sign-in**: safaridriver starts a clean Safari profile with no
     cookies, so use the app's auth skill, if installed, to start an auth proxy that adds the
     token server-side, and point `--url` at the proxy. Self-signed certificates are accepted
     (`acceptInsecureCerts`). Stop the proxy afterwards. This path hasn't been run in Safari
     yet: check the first run's screenshot shows a signed-in page, and record the outcome here.
2. **Run** `safari.mjs` with the probe and `--shot` into `<stateRoot>/safari/`. Read the screenshot.
3. **Report** Safari's version and each probe value next to Chrome's for the same element. A difference from
   Chrome is a finding; a match goes in the run's report as "Safari <version>: same", and the PR body drops Safari from its `Not checked:` line.

Done when every selector the change touches has a Safari value next to its Chrome value.

## Exit codes

| Code | Meaning | Do |
|---|---|---|
| 2 | Bad arguments | `--help` |
| 3 | Remote automation is off | Ask the user: Safari → Settings → Advanced → "Show features for web developers", then Develop → **Allow Remote Automation**. `sudo safaridriver --enable` also works, but in their own terminal app: `!` has no TTY for the password. |
| 4 | Session or probe error | A session left open blocks the next one; quit the automation window. A probe error prints Safari's message. |

## Gotchas

- **The screenshot leaves out scrollbars**, even a custom always-red `::-webkit-scrollbar-thumb`
  with a 4px gutter (Safari 27). A scrollbar shot proves nothing, so the computed
  values and the gutter carry the check, and the painted bar needs a person looking. Safari's
  `AppleShowScrollBars` can't be set from a session either: its preferences are sandboxed and
  `defaults write com.apple.Safari` fails with "Could not write domain".
- **Safari 27 supports and computes `scrollbar-width` and `scrollbar-color`** (`scrollbar-color`
  arrived in 26.2), so the `::-webkit-scrollbar` fallback is for older Safari. The computed
  `::-webkit-scrollbar` width still reads the rule's value when the standard properties are set;
  it doesn't tell you which one drew the bar. A non-zero gutter shows a non-overlay bar is drawn.
- **One session at a time,** in a separate automation window with a clean profile, and headed.
  The user's own Safari windows are left alone.
- iOS Safari is a different check: `safaridriver` takes `safari:deviceType` for the Simulator
  (needs Xcode). Mobile scrollbars are always overlay.
