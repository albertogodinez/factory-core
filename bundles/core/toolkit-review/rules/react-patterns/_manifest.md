# React Patterns Rules Manifest

Tracks adaptation status of Vercel React best practice rules into toolkit-review format.
Source: `vercel-labs/agent-skills/skills/react-best-practices/rules/`

Impact levels preserved from Vercel's per-rule frontmatter (not section-level defaults).

## Excluded Rules

### Stack conflicts (7 rules)

| Rule | Reason |
|------|--------|
| client-swr-dedup | SWR-specific -- apps use a GraphQL client |
| client-event-listeners | SWR-specific subscription pattern |
| client-localstorage-schema | SWR-specific localStorage pattern |
| client-passive-event-listeners | SWR-specific (partially generic but examples are SWR) |
| rendering-activity | React experimental API -- `<Activity>` not in production |
| advanced-effect-event-deps | `useEffectEvent` not stable |
| advanced-use-latest | `useEffectEvent` not stable |

16 Next.js-specific rules and 4 server-side rules were evaluated and excluded entirely — they are not tracked here since this guidance targets non-Next.js apps. Two rules (async-api-routes, bundle-dynamic-imports) had generic React core patterns worth keeping and were re-adapted without Next.js APIs.

## Created Rules (27 total)

### CRITICAL (6 rules)

| File | Vercel Impact | Category |
|------|---------------|----------|
| async-parallel.md | CRITICAL | Async waterfalls |
| async-cheap-condition-before-await.md | CRITICAL | Async waterfalls |
| async-api-routes.md | CRITICAL | Async waterfalls (adapted to generic handler) |
| async-dependencies.md | CRITICAL | Async waterfalls |
| bundle-barrel-imports.md | CRITICAL | Bundle size |
| bundle-dynamic-imports.md | CRITICAL | Bundle size (adapted as generic React.lazy) |

### HIGH (8 rules)

| File | Vercel Impact | Category |
|------|---------------|----------|
| async-defer-await.md | HIGH | Async waterfalls |
| async-suspense-boundaries.md | HIGH | Async / Suspense |
| bundle-analyzable-paths.md | HIGH | Bundle size (adapted without Next.js output tracing) |
| bundle-conditional.md | HIGH | Bundle size |
| rendering-content-visibility.md | HIGH | Rendering |
| rendering-resource-hints.md | HIGH | Rendering |
| rendering-script-defer-async.md | HIGH | Rendering |
| rerender-no-inline-components.md | HIGH | Re-render |

### MEDIUM / MEDIUM-HIGH (10 rules)

| File | Vercel Impact | Category |
|------|---------------|----------|
| js-tosorted-immutable.md | MEDIUM-HIGH | JS immutability |
| js-length-check-first.md | MEDIUM-HIGH | JS performance |
| rerender-derived-state-no-effect.md | MEDIUM | Re-render |
| rerender-functional-setstate.md | MEDIUM | Re-render |
| rerender-memo-with-default-value.md | MEDIUM | Re-render |
| rerender-move-effect-to-event.md | MEDIUM | Re-render |
| rerender-lazy-state-init.md | MEDIUM | Re-render |
| rerender-use-ref-transient-values.md | MEDIUM | Re-render |
| js-batch-dom-css.md | MEDIUM | JS / DOM |
| js-request-idle-callback.md | MEDIUM | JS scheduling |

### LOW / LOW-MEDIUM (3 rules)

| File | Vercel Impact | Category |
|------|---------------|----------|
| js-index-maps.md | LOW-MEDIUM | JS performance |
| rerender-dependencies.md | LOW | Re-render |
| rendering-conditional-render.md | LOW | Rendering correctness |

## Toolkit-authored rules (not from Vercel)

| File | Impact | Category |
|------|--------|----------|
| rerender-no-effect-for-fetch-reset-or-guard.md | MEDIUM | Re-render / hooks. Replaces the retired `no-use-effect` skill's fetch, key-reset and precondition patterns; its derive-state and event-handler patterns were already `rerender-derived-state-no-effect` and `rerender-move-effect-to-event`. |
| rendering-no-module-state-write-in-render.md | HIGH | Rendering correctness. A predicate that wrote to a module `Set` during render. |
| rendering-scroll-mirror-observes-resize.md | MEDIUM | Rendering correctness. A custom scrollbar thumb that updated on scroll and hover only. |
| context-noop-default-must-warn.md | MEDIUM | Context correctness. A debug-panel button called a nav action from outside its provider and silently did nothing. |
