# Phase 5: post selected findings to the PR

Read this when the target is a GitHub PR authored by someone else and the user has picked findings.

**On the user's own PR, fix locally instead.** Compare `gh pr view <N> --json author -q .author.login` with `gh api user -q .login`. When they match, offer `fix <nums>`: make each fix on the branch, run the project's checks (`project.commands`), and commit with the reasoning in the message. A comment on your own PR reads as review noise.

Posting goes through the `factory-pr-comment` skill. Follow its `references/github-pr-comments.md`. Its `scripts/post-comment.mjs` writes the project's comment marker (`adapters.commentMarker`), when one is set.

1. **Wait for the user's selection.** Post nothing until the user names finding numbers (`post 1,3,5`, `post all blocking`, `none`). That selection approves posting those findings: do not ask again. If the user asks to see drafts first (`draft 1,3`), show them and wait. Findings and questions are postable. Needs Human Eyes, Checked but Left Alone, residual risks and testing gaps are not, unless the user names one.
2. **Re-check the PR.** Re-fetch the head SHA. If it moved, re-read each selected line at the new head, then re-anchor or drop it. Re-read `$RUN/pr-comments.json` and the user's pending review. Overlap means the same fix, not the same wording: if the user or another reviewer already suggested a change that also fixes this finding, skip it. Trim a partial overlap to the new part.
3. **Draft** one body per finding into `$RUN/comments/<n>-<file>-<line>.md`, without the marker or banner: the script adds them and refuses a body that already has them. Write in the user's voice per `references/comment-voice.md`: one or two sentences, a question for `mode: "question"`, `nit:` for `blocking: false`, a plain fenced snippet for the fix. No P-level, rule id, confidence or reviewer name.
4. **Post into a pending review, never a submitted one**, one call per draft:

   ```bash
   node .agents/skills/factory-pr-comment/scripts/post-comment.mjs --pr <N> \
     --kind review --path <file> --line <line> --expect-head <reviewed-sha> \
     --body-file "$RUN/comments/<n>-<file>-<line>.md"
   ```

   Add `--repo <owner/name>` when the PR is in a neighbor. The script adds the thread to the user's draft review, or starts one without an `event`, and fails if the head moved or the line is outside the diff (omit `--line` for a file-level comment). Use `--dry-run` first when the user asked for drafts. If the resolver says `writeAllowed: false`, confirm with the user and pass `--yes`. Never submit the review for them.
5. **Resolve only on request, and only our own threads.** If Previously posted lists earlier comments as `addressed`, offer `resolve C<nums>`. Use the GraphQL `resolveReviewThread` mutation, and only on threads whose root comment carries the project's marker (`ours: true` in `pr-comments.json`). Never resolve a thread someone else started. With no marker configured, there is no way to tell, so do not offer it.
6. **Report** in a table: finding #, `path:line`, outcome (`added to pending review`, `skipped: already raised by <who>`, `trimmed`, `dropped: line changed at <sha>`, `resolved`), and the comment URL. End by reminding the user the review is still pending and needs submitting.
