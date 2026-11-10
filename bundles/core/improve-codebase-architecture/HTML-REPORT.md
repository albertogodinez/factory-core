# HTML Report Format

The architectural review is rendered as a single self-contained HTML file in the project's `stateRoot` (`factory-context`). Tailwind and [Pele](https://pele.run) both come from CDNs. Diagrams are written in Mermaid syntax and rendered by Pele, which draws them as SVG themed with CSS variables, in the pele.run palette below. Pele handles graph-shaped diagrams; hand-built divs and inline SVG handle the more editorial visuals (mass diagrams, cross-sections). Mix the two: don't lean on graphs for everything, it'll start to look generic.

## Scaffold

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review for {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import { mount } from "https://cdn.jsdelivr.net/npm/pele@1.9.0/dist/pele.js";
      for (const el of document.querySelectorAll("pre.mermaid")) {
        const host = document.createElement("div");
        host.className = "diagram";
        el.replaceWith(host);
        mount(host, el.textContent);
      }
    </script>
    <style>
      .diagram {
        --pele-font: ui-sans-serif, system-ui, sans-serif;
        --pele-font-mono: ui-monospace, SFMono-Regular, monospace;
      }
      .pele {
        --pele-bg: #fffcf0;
        --pele-fg: #100f0f;
        --pele-muted: #6f6e69;
        --pele-line: #100f0f;
        --pele-surface: #f2f0e5;
        --pele-surface-alt: #e6e4d9;
        --pele-border: #cecdc3;
        --pele-accent: #205ea6;
        --pele-critical: #af3029;
      }
      @media (prefers-color-scheme: dark) {
        .pele {
          --pele-bg: #100f0f;
          --pele-fg: #cecdc3;
          --pele-muted: #878580;
          --pele-line: #cecdc3;
          --pele-surface: #1c1b1a;
          --pele-surface-alt: #282726;
          --pele-border: #403e3c;
          --pele-accent: #4385be;
          --pele-critical: #d14d41;
        }
      }
      /* Role styling by node id keeps colours on the theme variables. */
      .pele-node[data-id^="leak"] rect { stroke: var(--pele-critical); stroke-width: 2px; }
      .pele-node[data-id^="deep"] rect { fill: var(--pele-fg); }
      .pele-node[data-id^="deep"] .pele-label { fill: var(--pele-bg); }
      /* Hand-built visuals use the same palette. */
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: var(--pele-critical, #af3029); }
    </style>
  </head>
  <body class="bg-[#fffcf0] text-[#100f0f] font-sans dark:bg-[#100f0f] dark:text-[#cecdc3]">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## Header

Repo name, date, and a compact legend: solid box = module, dashed line = seam, red arrow = leakage, thick dark box = deep module. No introduction paragraph. Straight into the candidates.

## Candidate card

The diagrams carry the weight. Prose is sparse, plain, and uses the glossary terms (from [CODEBASE-DESIGN.md](CODEBASE-DESIGN.md)) without ceremony.

Each candidate is one `<article>`:

- **Title**: short, names the deepening (e.g. "Collapse the Order intake pipeline").
- **Badge row**: recommendation strength (`Strong` = emerald, `Worth exploring` = amber, `Speculative` = slate), plus a tag for the dependency category (`in-process`, `local-substitutable`, `ports & adapters`, `mock`).
- **Files**: monospaced list, `font-mono text-sm`.
- **Before / After diagram**: the centrepiece. Two columns, side by side. See patterns below.
- **Problem**: one sentence. What hurts.
- **Solution**: one sentence. What changes.
- **Wins**: bullets, ≤6 words each. e.g. "Tests hit one interface", "Pricing logic stops leaking", "Delete 4 shallow wrappers".
- **Convention callout** (if applicable): one line in an amber-tinted box.

No paragraphs of explanation. If the diagram needs a paragraph to be understood, redraw the diagram.

## Diagram patterns

Pick the pattern that fits the candidate. Mix them. Don't make every diagram look the same. Variety is part of the point.

### Graph (the workhorse for dependencies / call flow)

Write a Mermaid `flowchart` or `graph` when the point is "X calls Y calls Z, and look at the mess"; Pele renders it. Wrap it in a Tailwind-styled card so it doesn't feel parachuted in. Mark roles through node ids, not inline styles: an id starting `leak` gets the critical border and one starting `deep` is drawn dark, from the CSS in the scaffold. Mermaid `style` and `classDef` colours are fixed and ignore the light/dark theme, so avoid them. Sequence diagrams work well for "before: 6 round-trips; after: 1."

```html
<div class="rounded-lg border border-[#cecdc3] bg-[#fffcf0] p-4">
  <pre class="mermaid">
    flowchart LR
      handler[OrderHandler] --> validator[OrderValidator]
      validator --> leakRepo[OrderRepo]
      leakRepo -. leak .-> leakPricing[PricingClient]
  </pre>
</div>
```

Pele supports every diagram type built into Mermaid; when a diagram fails to draw, `mount()` shows the error in place of the diagram, so open the report and look before handing it over.

### Hand-built boxes-and-arrows (when the graph layout fights you)

Modules as `<div>`s with borders and labels. Arrows as inline SVG `<line>` or `<path>` elements positioned absolutely over a relative container. Reach for this when you want the "after" diagram to feel like one thick-bordered deep module with greyed-out internals, since a generated graph won't render that with the right weight.

### Cross-section (good for layered shallowness)

Stack horizontal bands (`h-12 border-l-4`) to show layers a call passes through. Before: 6 thin layers each doing nothing. After: 1 thick band labelled with the consolidated responsibility.

### Mass diagram (good for "interface as wide as implementation")

Two rectangles per module: one for interface surface area, one for implementation. Before: interface rectangle is nearly as tall as the implementation rectangle (shallow). After: interface rectangle is short, implementation rectangle is tall (deep).

### Call-graph collapse

Before: a tree of function calls rendered as nested boxes. After: the same tree collapsed into one box, with the now-internal calls shown faded inside it.

## Style guidance

- Lean editorial, not corporate-dashboard. Generous whitespace. Serif optional for headings. Page background `#fffcf0`, text `#100f0f`, borders `#cecdc3`, matching the diagrams.
- Colour sparingly: the accent (`--pele-accent`) plus the critical red (`--pele-critical`) for leakage and amber for warnings.
- Keep diagrams ~320px tall so before/after sits comfortably side by side without scrolling.
- Use `text-xs uppercase tracking-wider` for module labels inside diagrams, so they read as schematic, not as UI.
- The only scripts are the Tailwind CDN and the pinned Pele module (`pele@1.3.0`). The report is otherwise static: no app code, no interactivity beyond Pele's rendering.

## Top recommendation section

One larger card. Candidate name, one sentence on why, anchor link to its card. That's it.

## Tone

Plain English, concise, but the architectural nouns and verbs come straight from [CODEBASE-DESIGN.md](CODEBASE-DESIGN.md). Concision is not an excuse to drift.

**Use exactly:** module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality.

**Never substitute:** component, service, unit (for module) · API, signature (for interface) · boundary (for seam) · layer, wrapper (for module, when you mean module).

**Phrasings that fit the style:**

- "Order intake module is shallow: interface nearly matches the implementation."
- "Pricing leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: HTTP in prod, in-memory in tests."

**Wins bullets** name the gain in glossary terms: *"locality: bugs concentrate in one module"*, *"leverage: one interface, N call sites"*, *"interface shrinks; implementation absorbs the wrappers"*. Don't write *"easier to maintain"* or *"cleaner code"*, because those terms aren't in the glossary and don't earn their place.

No hedging, no throat-clearing, no "it's worth noting that…". If a sentence could be a bullet, make it a bullet. If a bullet could be cut, cut it. If a term isn't in the [CODEBASE-DESIGN.md](CODEBASE-DESIGN.md) glossary, reach for one that is before inventing a new one.
