#!/usr/bin/env node
// Lists the review findings on a PR that still need an answer, computed from GitHub every time (no snapshot).
//
//   node open-findings.mjs --pr <N> --repo <owner/repo> [--host <host>] [--self <login>]
//
// Threads, reviews and thread resolution come from factory-review's fetch-pr-threads.mjs (the one place a PR's
// review graph becomes records, paginated). This adds what it doesn't carry: top-level PR comments, and the
// discussion links inside bot review bodies.
//
// Prints JSON: `open` (unreplied, unresolved inline comments by a bot or by the session account), `others` (other
// humans' comments, for the user), `bodyOnly` (bot review bodies with no thread and no top-level answer).
// Exit 0 with the JSON; 2 on a usage or gh error. Host defaults to $GH_HOST, else github.com.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchThreads } from '../../factory-review/scripts/fetch-pr-threads.mjs';

const DISCUSSION = /#discussion_r(\d+)/g;
const isBot = (author) => author?.author_type === 'Bot';

export function openFindings({ comments, reviews, issueComments, self }) {
  const repliedTo = new Set(comments.filter((comment) => comment.in_reply_to_id != null).map((comment) => String(comment.in_reply_to_id)));
  const byId = new Map(comments.map((comment) => [String(comment.comment_id), comment]));
  const brief = (comment) => ({ id: comment.comment_id, login: comment.author, path: comment.path, line: comment.line ?? comment.original_line, body: String(comment.body ?? '').slice(0, 200) });
  const unanswered = (comment) => comment.in_reply_to_id == null && !repliedTo.has(String(comment.comment_id)) && comment.thread_resolved !== true;
  const open = [];
  const others = [];
  for (const comment of comments) {
    if (!unanswered(comment)) continue;
    if (isBot(comment) || comment.author === self) open.push(brief(comment));
    else others.push(brief(comment));
  }
  const bodyOnly = [];
  for (const review of reviews) {
    if (!isBot(review) || !String(review.body ?? '').trim()) continue;
    const linked = [...String(review.body).matchAll(DISCUSSION)].map((match) => match[1]);
    for (const id of linked) {
      const comment = byId.get(id);
      if (comment && unanswered(comment) && !open.some((finding) => String(finding.id) === id)) open.push(brief(comment));
    }
    if (linked.length) continue;
    const answered = issueComments.some((comment) => comment.user?.login === self && String(comment.body ?? '').includes(`pullrequestreview-${review.review_id}`));
    if (!answered) bodyOnly.push({ id: review.review_id, login: review.author, body: String(review.body).slice(0, 200) });
  }
  return { open, others, bodyOnly };
}

function usage(message) {
  console.error(`open-findings: ${message}\nusage: open-findings.mjs --pr <N> --repo <owner/repo> [--host <host>] [--self <login>]`);
  process.exit(2);
}

const flag = (argv, name) => argv[argv.indexOf(name) + 1];

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const pr = flag(argv, '--pr');
  const repo = flag(argv, '--repo');
  if (!/^\d+$/.test(pr ?? '') || !repo) usage('--pr <N> and --repo <owner/repo> are required');
  const host = argv.includes('--host') ? flag(argv, '--host') : process.env.GH_HOST || 'github.com';
  const env = { ...process.env, GH_HOST: host };
  try {
    const self = argv.includes('--self') ? flag(argv, '--self') : execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', env, timeout: 30000 }).trim();
    const { comments, reviews } = fetchThreads(host, repo, pr);
    const issueComments = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`], { encoding: 'utf8', env, timeout: 60000 })).flat();
    console.log(JSON.stringify({ self, ...openFindings({ comments, reviews, issueComments, self }) }, null, 2));
  } catch (error) {
    console.error(`open-findings: ${String(error.message).split('\n')[0]}`);
    process.exit(2);
  }
}
