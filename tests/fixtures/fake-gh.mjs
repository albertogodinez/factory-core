#!/usr/bin/env node
// A stand-in for `gh` that records every call and answers from a scenario file.
//   FAKE_GH_SCENARIO  JSON: { pr: {head,node_id,state}, files: [[page], [page]], reviews: [...],
//                             threads: [...], rest422: bool, urls: {...} }
//   FAKE_GH_LOG       JSONL file; each line is { argv, host }. An `@file` argument is
//                     replaced by "@<contents>" so temp paths don't differ between runs.
import { readFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const sc = JSON.parse(readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
const logged = argv.map((x) => {
  const m = /^([^=]+=)@(.+)$/.exec(x);
  if (m) { try { return `${m[1]}@${readFileSync(m[2], 'utf8')}`; } catch { return x; } }
  return x;
});
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv: logged, host: process.env.GH_HOST }) + '\n');

const all = argv.join(' ');
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (argv[0] !== 'api') { process.stderr.write(`fake gh: unsupported ${argv[0]}\n`); process.exit(1); }
if (argv.includes('graphql')) {
  if (/reviewThreads/.test(all)) out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: sc.threads || [] } } } } }));
  if (/addPullRequestReviewThreadReply/.test(all)) out('https://example.test/pending-reply\n');
  if (/addPullRequestReviewThread\(/.test(all)) out('https://example.test/pending-thread\n');
  if (/addPullRequestReview\(/.test(all)) out('PRR_new\n');
}
if (/\/files\?/.test(all)) out((sc.files || [[]]).map((p) => JSON.stringify(p)).join(''));
if (/\/reviews\?/.test(all)) out(JSON.stringify(sc.reviews || []));
if (argv.includes('POST')) {
  if (sc.rest422) { process.stderr.write('gh: Validation Failed: user_id can only have one pending review per pull request (HTTP 422)\n'); process.exit(1); }
  out('https://example.test/comment/1\n');
}
if (/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(argv[1])) out(JSON.stringify(sc.pr) + '\n');
process.stderr.write(`fake gh: no answer for ${all}\n`); process.exit(1);
