#!/usr/bin/env node
// Lists the review findings on a PR that still need an answer, computed from GitHub every time (no snapshot).
//
//   node open-findings.mjs --pr <N> --repo <owner/repo> [--self <login>]
//
// Prints JSON: `open` (inline comments by a bot or by the session account with no reply),
// `others` (other humans' comments, for the user), `bodyOnly` (bot review bodies with no thread and no top-level
// answer). A discussion link inside a bot review body counts as that thread. Every list is read with --paginate:
// `gh api` returns 30 reviews and comments per page by default.
// Exit 0 with the JSON; 2 on a usage or gh error. Set GH_HOST for a non-github.com host.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DISCUSSION = /#discussion_r(\d+)/g;
const isBot = (user) => user?.type === 'Bot';

export function openFindings({ comments, reviews, issueComments, self }) {
  const repliedTo = new Set(comments.filter((comment) => comment.in_reply_to_id).map((comment) => comment.in_reply_to_id));
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const brief = (comment) => ({ id: comment.id, login: comment.user?.login, path: comment.path, line: comment.line ?? comment.original_line, body: String(comment.body ?? '').slice(0, 200) });
  const open = [];
  const others = [];
  for (const comment of comments) {
    if (comment.in_reply_to_id) continue;
    if (repliedTo.has(comment.id)) continue;
    if (isBot(comment.user) || comment.user?.login === self) open.push(brief(comment));
    else others.push(brief(comment));
  }
  const bodyOnly = [];
  for (const review of reviews) {
    if (!isBot(review.user) || !String(review.body ?? '').trim()) continue;
    const linked = [...String(review.body).matchAll(DISCUSSION)].map((match) => Number(match[1]));
    for (const id of linked) {
      const comment = byId.get(id);
      if (comment && !repliedTo.has(id) && !open.some((finding) => finding.id === id)) open.push(brief(comment));
    }
    if (linked.length) continue;
    const answered = issueComments.some((comment) => comment.user?.login === self && String(comment.body ?? '').includes(`pullrequestreview-${review.id}`));
    if (!answered) bodyOnly.push({ id: review.id, login: review.user.login, body: String(review.body).slice(0, 200) });
  }
  return { open, others, bodyOnly };
}

function usage(message) {
  console.error(`open-findings: ${message}\nusage: open-findings.mjs --pr <N> --repo <owner/repo> [--self <login>]`);
  process.exit(2);
}

const flag = (argv, name) => argv[argv.indexOf(name) + 1];
const gh = (args) => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', ...args], { encoding: 'utf8', timeout: 60000 })).flat();

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const pr = flag(argv, '--pr');
  const repo = flag(argv, '--repo');
  if (!/^\d+$/.test(pr ?? '') || !repo) usage('--pr <N> and --repo <owner/repo> are required');
  try {
    const self = argv.includes('--self') ? flag(argv, '--self') : execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 30000 }).trim();
    const comments = gh([`repos/${repo}/pulls/${pr}/comments?per_page=100`]);
    const reviews = gh([`repos/${repo}/pulls/${pr}/reviews?per_page=100`]);
    const issueComments = gh([`repos/${repo}/issues/${pr}/comments?per_page=100`]);
    console.log(JSON.stringify({ self, ...openFindings({ comments, reviews, issueComments, self }) }, null, 2));
  } catch (error) {
    console.error(`open-findings: ${String(error.message).split('\n')[0]}`);
    process.exit(2);
  }
}
