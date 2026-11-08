---
name: toolkit-pr-comment
description: Post a GitHub PR comment from a local session, with the project's disclosure marker and banner. Use before posting, replying to, or annotating anything on a pull request ("reply to this PR comment", "answer the review thread", "comment on line N", "add this finding to my pending review"), and before any `gh api …/pulls/…/comments`, `…/replies`, `…/reviews`, `gh pr comment` or `gh pr review` call. Its script fetches the head SHA, checks the line is in the diff, adds the marker, and handles the one-pending-review 422.
---

# Post a PR comment

Every comment a session posts goes out under the user's credentials, so GitHub records it as that person. A project can require a hidden marker and a visible banner so those comments can be told apart from the user's own. This skill is the single home of that convention. The full spec is [`references/github-pr-comments.md`](references/github-pr-comments.md), and `scripts/post-comment.mjs` applies it, so no caller writes the marker by hand.

**Don't post with a bare `gh api` call.** It posts with no marker, and the comment then has to be fixed by hand.

Skills that post through this one keep their own rules for *what* to say and *when*.

## 1. Pick the kind

| Kind | Use for | Lands as |
| --- | --- | --- |
| `reply` | Answering an existing review thread | In-thread reply |
| `annotation` | Context for reviewers on a line or file ("this looks wrong but is deliberate") | New inline comment on the head commit |
| `review` | A review finding | A thread in the user's **pending** review, never a submitted one |

Top-level `issues/<N>/comments` posts (`gh pr comment`) are outside this script's scope, and they're never the place for a finding.

## 2. Write the body

Write the body to a file under the project's `stateRoot` (`node .agents/skills/toolkit-context/scripts/resolve.mjs --field stateRoot`; `mkdir -p` it first). Write only the body: the script adds the marker and banner, and refuses a body that already contains the marker.

- One finding or point per comment, on the line it's about.
- Keep it short: the problem and its consequence, the concrete trigger, the fix as a snippet when it fits in about ten lines, and the test that would pin it.
- No severity labels, rule ids or confidence scores.

## 3. Before posting (your part)

1. **Check for overlap.** Read the published comments and the user's pending review (reference §3.3). Skip a comment that repeats one already there, trim one that partly overlaps, and say which.
2. **Know the head you reviewed.** Pass it as `--expect-head`. The script fails if the PR moved; then re-read the line at the new head, and re-anchor or drop the comment.
3. **Auto-reply only to the user's own comments or a bot's**, unless the user asked otherwise.

## 4. Post with the script

```bash
node .agents/skills/toolkit-pr-comment/scripts/post-comment.mjs \
  --pr <N> --kind reply|annotation|review --body-file <file> \
  [--repo <owner/name>]                                  # default: this project's upstream, else origin
  [--in-reply-to <COMMENT_ID>]                           # reply: the thread's root comment id
  [--path <FILE> [--line <L> [--start-line <S>] [--side RIGHT|LEFT]]]   # no --line = file-level
  [--host <host>]                                        # default: from toolkit-context
  [--expect-head <SHA>] [--model <ID>] [--yes] [--dry-run]
```

Pass `--model` with your own model id. It goes into the marker, and the fallback is `$AI_TOOLKIT_MODEL`, then `unknown`.

What the script does:

- Asks `toolkit-context` for the host, the marker policy and `writeAllowed`, for this project or a neighbor named by `--repo`. It sets `GH_HOST`, because `gh pr` takes no `--hostname`.
- **Refuses to post when the marker policy isn't configured.** Set `pr.commentMarker` in `.ai-toolkit/project.json` (`{"mode":"off"}` for none).
- **Refuses to post when `writeAllowed` is false**, which is always the case in a zero-config repo, and when `--repo` isn't this project or a writable neighbor. Ask the user to confirm the comment, then rerun with `--yes`.
- Fetches the head SHA fresh and writes it into the marker metadata, with `model`, `pr`, `in_reply_to` or `path`/`line`, and a UTC `ts`.
- For an inline comment, checks every line is on the requested side of the PR's diff hunks. If one isn't, it fails and suggests a file-level comment (GitHub would return `422`).
- Posts with `-F body=@file`, never an inline string, and prints the comment URL.
- `reply` and `annotation` go over REST first. On `422 … one pending review per pull request`, the script adds the comment to the user's pending review over GraphQL and says so. Those comments stay invisible until the user submits the review.
- `review` adds a thread to the user's pending review, starting one if none exists. **It never submits a review.** The user submits it and picks the verdict.

`--dry-run` makes only GET requests. It prints the final body and the requests it would send, including the pending-review fallback when one is open, and posts nothing. Use it whenever you're unsure.

## 5. Report

For each comment: the kind, `path:line` or the thread, the outcome (posted, added to pending review, skipped, or dropped), and the URL. Remind the user when anything is waiting in their pending review.

Tests: `node --test .agents/skills/toolkit-pr-comment/scripts/post-comment.test.mjs` (in agent-factory; it uses a fake `gh`).
