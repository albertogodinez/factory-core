# Clustering rubric: theme buckets

Signal catalog for §2.1. Assign each retained comment to one or two themes from its body and in-scope diff hunk. The list is a starting set: edit it for the repo's stack, and when a run leaves many comments in Uncategorized, name a new theme.

| Theme | Signal keywords and patterns |
|---|---|
| Naming | "rename", "naming", "should be called", "misleading name" |
| Data access and schema | "query", "mutation", "schema", "codegen", "migration", "fragment" |
| Structure | "extract", "split", "composition", "props", "module boundary" |
| Performance | "memo", "re-render", "lazy", "bundle", "N+1", "cache" |
| Testing | "test", "assert", "mock", "fixture", "coverage", "expect" |
| Type safety | "type", "as any", "generic", "interface", "union", "narrow" |
| Design system and styling | "token", "spacing", "styled", "inline style", "theme" |
| Error handling | "error", "catch", "fallback", "null check", "undefined" |
| Accessibility | "aria", "role", "screen reader", "a11y", "alt text", "label" |
| Uncategorized | matches none of the above; review by hand |
