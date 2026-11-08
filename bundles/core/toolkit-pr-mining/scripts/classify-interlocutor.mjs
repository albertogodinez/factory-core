#!/usr/bin/env node
// classify-interlocutor.mjs <threads.json> <reviewer-login> [--suffix <loginSuffix>]
//
// Applies the SKILL.md §2.0 buckets to one PR's comments, as seen from one reviewer, and prints
// the comments array with an `interlocutor` field. Input is the output of toolkit-review's
// fetch-pr-threads.sh (run with the project's marker text so `ours` is set).
//
// Precedence, first match wins:
//   T. the comment carries the project's marker (ours)             -> toolkit-posted
//   0. author is a Bot and the comment opens a thread              -> bot-finding
//   1. parent is a Bot, or parent carries the marker               -> agent-steering
//   2. PR author != reviewer                                       -> peer-review
//   3. otherwise                                                   -> self-defense
// Logins compare after removing the suffix once. node: imports only.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function classify(threads, reviewer, suffix = '') {
  const canon = (l) => (suffix && l && l.endsWith(suffix) ? l.slice(0, -suffix.length) : l);
  const prAuthor = threads.pr?.author;
  return (threads.comments || []).map((c) => {
    let bucket;
    if (c.ours) bucket = 'toolkit-posted';
    else if (c.author_type === 'Bot' && c.in_reply_to_id == null) bucket = 'bot-finding';
    else if (c.parent_author_type === 'Bot' || c.parent_ours === true) bucket = 'agent-steering';
    else if (canon(prAuthor) !== canon(reviewer)) bucket = 'peer-review';
    else bucket = 'self-defense';
    return { ...c, pr_author: prAuthor, interlocutor: bucket };
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  const si = a.indexOf('--suffix');
  const suffix = si >= 0 ? a.splice(si, 2)[1] : '';
  if (a.length !== 2) { process.stderr.write('usage: classify-interlocutor.mjs <threads.json> <reviewer-login> [--suffix <s>]\n'); process.exit(2); }
  process.stdout.write(JSON.stringify(classify(JSON.parse(readFileSync(a[0], 'utf8')), a[1], suffix), null, 2) + '\n');
}
