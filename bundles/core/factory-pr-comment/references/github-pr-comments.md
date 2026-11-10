# Posting PR comments from a local session

The convention `factory-pr-comment` enforces. Every PR comment, reply or review comment a local
session posts follows this file, whichever skill (or no skill) is driving, so the comments read
and filter the same way. `scripts/post-comment.mjs` applies §1, §3.1, §3.2 and §4 for you; §2 and
§3.3 are judgment and stay with the caller.

## 1. The disclosure marker

Comments post under the user's own credentials, so GitHub records them as that person
(`user.type: "User"`). Through the API they look exactly like the user's own review comments. If
the user mines their review comments into rules (`factory-pr-mining`), an unmarked comment puts the
bot's words into that corpus. So a project can require a marker, set as `pr.commentMarker` in
`.agents/factory-metadata/project.json` (the resolver reports it as `adapters.commentMarker`):

| `mode` | The body starts with |
| --- | --- |
| `off` (or `null`) | nothing; the body is posted as written |
| `text` | `<!-- <text> {metadata} -->`, then a blank line |
| `banner` | `<!-- <text> {metadata} -->`, the banner for the kind on the next line, then a blank line |

`banner` is one string, or one per kind: `{"reply": "…", "annotation": "…", "review": "…"}`.
`factory install` asks once whether to keep, change or turn off the bundle's default; an adapter
bundle may ship a default policy.

The metadata JSON, by kind:

```markdown
<!-- <text> {"v":1,"model":"<model>","pr":<N>,"in_reply_to":<COMMENT_ID>,"head":"<SHA>","ts":"<ISO8601>"} -->
<!-- <text> {"v":1,"kind":"annotation","model":"<model>","pr":<N>,"path":"<FILE>","line":<LINE>,"head":"<SHA>","ts":"<ISO8601>"} -->
<!-- <text> {"v":1,"kind":"review","model":"<model>","pr":<N>,"path":"<FILE>","line":<LINE>,"head":"<SHA>","ts":"<ISO8601>"} -->
```

Use one tag for every kind, so filtering stays a single predicate:

```bash
gh api "repos/<OWNER>/<REPO>/pulls/<N>/comments?per_page=100" \
  --jq '.[] | select(.body | contains("<text>") | not)'
```

Keep `head` accurate. It tells a later reader which commit the comment was true of.

A file-level comment (no line) omits `line` from the metadata. `ts` is ISO 8601 UTC
(`2026-10-09T17:04:00Z`). A body that already contains the tag would be marked twice; refuse it.

## 2. Writing the body

- Write it to a scratch file under the resolver's `stateRoot` and pass it with `-F body=@<file>` (REST) or
  `-f b="$(cat <file>)"` (GraphQL). Bodies contain backticks, quotes and `${...}`, which break
  inline shell strings.
- Keep it short. One sentence on the problem and its consequence, the concrete trigger (input or
  state, then the wrong output), the fix as a snippet when one fits in about ten lines, and the
  test that would pin it. No severity labels, rule ids or confidence scores: those are for the
  report, not the author.
- One finding per comment, on the line it is about.

## 3. Before posting

1. **Re-fetch the head SHA.** If it moved since the review, re-read each target line at the new
   head. Re-anchor when the content only shifted. Drop the comment and tell the user when the
   finding no longer holds.
2. **The line must be in the diff,** on the head side. GitHub returns `422` for a line the PR does
   not touch. For a finding about untouched code, use a file-level comment instead.
3. **Check for overlap.** Read the published comments (`pulls/<N>/comments`) and the user's own
   pending review, if there is one (§4). Skip a comment that repeats one already there. Trim a
   comment to the part that is new, and say what was skipped or trimmed.

## 4. Pending reviews

GitHub allows **one pending review per user per PR**. While the owner has an unsubmitted draft
review open, `POST pulls/<N>/comments` fails with:

```
422 user_id can only have one pending review per pull request
```

Find the draft and add to it instead:

```bash
GH_HOST=<host> gh api "repos/<OWNER>/<REPO>/pulls/<N>/reviews" \
  --jq '.[] | select(.state=="PENDING") | {id, node_id}'
GH_HOST=<host> gh api "repos/<OWNER>/<REPO>/pulls/<N>/reviews/<ID>/comments" \
  --jq '.[] | {path, body: .body[0:120]}'   # what the owner already drafted; line is null on pending comments
```

```bash
GH_HOST=<host> gh api graphql -f query='
  mutation($r:ID!,$p:String!,$l:Int!,$b:String!){
    addPullRequestReviewThread(input:{pullRequestReviewId:$r,path:$p,line:$l,side:RIGHT,body:$b}){
      thread{ comments(first:1){ nodes{ url } } }
    }
  }' -f r=<NODE_ID> -f p=<FILE> -F l=<LINE> -f b="$(cat <file>)"
```

To start a new draft when none exists, create a review without an `event`. It stays `PENDING`:

```bash
GH_HOST=<host> gh api -X POST "repos/<OWNER>/<REPO>/pulls/<N>/reviews" \
  --input <review.json>   # {"commit_id": "<HEAD_SHA>", "comments": [{"path", "line", "side": "RIGHT", "body"}]}
```

**Never submit the owner's review** (`.../reviews/<ID>/events`). Submitting publishes their
drafted comments along with yours and picks the review verdict for them. The owner submits it.

## 5. Endpoints

| Purpose | Call |
| --- | --- |
| Reply in a thread | `POST pulls/<N>/comments/<COMMENT_ID>/replies -F body=@file` |
| New inline comment, no pending review | `POST pulls/<N>/comments -f commit_id=<HEAD> -f path=<FILE> -F line=<L> -f side=RIGHT -F body=@file` |
| Span | add `-F start_line=<N>` |
| Whole file | drop `line`/`side`, add `-f subject_type=file` |
| Add to a pending review | GraphQL `addPullRequestReviewThread` (§4) |

`line` is a line number in the **head** version of the file. `side=RIGHT` means the post-change
file; use `LEFT` only for a deleted line. Never put a finding in a top-level
`issues/<N>/comments` post: it is detached from the code and leaves no thread to answer.
