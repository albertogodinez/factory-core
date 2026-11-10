---
title: A check that claims to verify a flow or a change must run that flow or that change
impact: HIGH
repos: [cross-repo]
# repos_exclude reason: none needed. Replays, integration tests and verification gates exist in every registered repo and in the toolkit's own skills.
repos_exclude: []
tags: [testing, verification, gates, replay]
source: manual
applies_when: A diff adds or changes a replay, integration or end-to-end test, or a verification gate (a model check, a drift check, a pre-push step) that claims to cover a user flow or the code under review
principle: A check whose inputs are set by hand, or that reads a description of earlier code, passes whatever the real flow or the change under review does.
date: 2026-11-06
---

## Description

Some checks make a bigger claim than a unit test: "this replays the bug path", "this verifies the PR still keeps the promise", "this gate proves the change is safe". Hold each such check to its claim. For every value the check feeds the code under test, ask which code produces that value in the real flow. Then ask what the check reads to decide pass or fail.

Flag it when:

- The test sets by hand a value that a real step of the claimed flow computes (props a shell derives, a key a navigator assigns, a state an event reducer builds), and the name or the surrounding doc says it replays the flow. A fix in the skipped step changes the app and leaves the test unchanged.
- A gate that runs on a change reads a committed description of earlier code (a model of the last synced commit, a snapshot, a recorded fixture) and never the changed files. It reports the same result whatever the change does.
- Nobody stated the input that turns the check red, or that input cannot come from the code the check claims to cover.

A hand-set input is fine when the check says so plainly and scopes its claim to the unit that receives it ("the provider resets the flags when the key changes"), and the skipped producers are listed as unverified.

## Why It Matters

These checks are where a team stops looking. A replay that stays red after the real bug is fixed, or a gate that stays green whatever the change does, gives the next engineer a false verdict at the moment they rely on it most.

## Incorrect

```ts
// "Replays the bug path": but the mode and key are typed in, not produced by the shell
it('area pick -> toggle -> stays land', () => {
  rerender(<Provider artifactMode="mapFirst" selectionKey="pending-hotel-search" />);
  click(toggle);
  rerender(<Provider artifactMode="mapFirst" selectionKey="hotel-artifact-1" />);
  expect(state()).toBe('off/wide');
});
```

```md
<!-- PR gate: reruns the committed model, which describes trunk at the sync commit -->
For each touched verify skill, rerun its model and paste the result in the PR body.
```

## Correct

```ts
// Drives the shell, so the mode and key come from the code under test
it('area pick -> toggle -> stays land', () => {
  renderShell();
  pickArea('Midtown');
  click(toggle);
  landArtifact(anchoredHotels);
  expect(state()).toBe('off/wide');
});
```

```md
<!-- PR gate: the model is first brought in line with the branch's code -->
For each touched verify skill, read the change against the model, edit a copy of the model from the branch's code, run it, and say what input turns it red.
```
