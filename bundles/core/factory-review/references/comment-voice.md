# Comment voice for posted review findings

Phase 5 comments post under the user's account, so they should read like the user's own reviews.
These rules come from a sample of inline comments one reviewer wrote by hand on other people's PRs.
If the project keeps its own voice guide, follow that instead.

The project's disclosure marker and banner (adapters.commentMarker), when one is set, still go on every comment, unchanged: the `factory-pr-comment`
skill owns them (its `references/github-pr-comments.md` §1) and its `scripts/post-comment.mjs` adds
them. This file governs only the body. For `kind: "review"` comments it narrows that spec's §2
"Writing the body": keep the problem, the consequence and the fix; drop the
explanatory preamble.

## Shape

- **One or two sentences.** The measured median is 119 characters and the 75th percentile is 230.
  If the body is longer than that, cut the explanation, not the consequence.
- **Lead with a question when intent is unclear.** 61% of the user's comments are questions. For
  a `mode: "question"` finding, the comment *is* the question: "why do we need this hook?", "is
  there a reason this isn't the design system's `CardLink`?", "what happens if `topics` is empty?". Use a
  statement only when the finding is verified (`mode: "comment"`).
- **Say the consequence in plain words,** then the fix. "this renders a literal `0` when there's
  no top bar and topics is empty. could we coerce it first?"
- **Fix as a plain fenced snippet** when it fits in about ten lines. Not a GitHub ` ```suggestion `
  block: the user never uses them.

## Voice

- **"we", "lets", "could we".** Not "you should", "consider", or "it is recommended".
- **Lowercase and conversational.** No headers, no bullet lists, no bold.
- **Mark optional findings with `nit:`** (`blocking: false`). Blocking findings carry no prefix;
  never write "blocking:" or a P-level.
- **Deferral is allowed for non-blocking structure findings:** "we don't have to do this now, but
  …". Do not offer to file a ticket on the user's behalf; they decide that when they review the
  draft.
- **Point at precedent rather than asserting a rule.** A sibling file that already does it, the
  design system's docs page, or the repo's own guidance: "similar to how `ItemCard` handles it". Never
  cite a toolkit rule id.
- **Hedge only when you are actually unsure.** "I think" is fine on a `question`. A verified
  `comment` states the fact.

## What never goes in the body

- Severity, confidence, rule ids, persona names, or "this was flagged by…".
- A restatement of the code the author just wrote.
- Generic advice that would read the same on any PR.

## Examples

Measured from the user's own comments:

> why are these all divs?

> we should not be getting items by their class names

> nit: do we need the entire buttonProps on this dependency array? or is `buttonProps.onClick()` enough?

> lets not use !important since CSS cascades down in terms of styling, this can cause other side effects in the future that are tricker to catch

> did we not have this dialog functionality in our design-system component? reimplementing is tricky because there are several edge cases that the component already covers

Before and after, for the same finding (a stray-`0` render in a component):

> ~~When `top_bar` is falsy and `topics` is an empty array, `(top_bar || topics?.length)` evaluates to `0`, and React renders numbers, so a literal 0 appears in the header. This is a common pitfall with `&&` short-circuiting on numeric values. Consider coercing to a boolean before the conditional render so the falsy case renders nothing.~~

> this renders a literal `0` when there's no top bar and topics is empty. could we coerce it first?
> ```tsx
> const hasHeader = Boolean(top_bar) || topics.length > 0
> ```
