#!/usr/bin/env node
// fetch-pr-threads.mjs <gh-host> <owner/repo> <pr-number> [<marker-text>]
//
// Fetches every review and review comment on one PR and prints a single normalized JSON object
// to stdout. Nothing is filtered: callers apply their own author, path and noise rules.
//
// Callers: factory-review (Phase 1 existing-comments fetch, Phase 3 re-review check, Phase 5
// overlap check). Keep this the only place the skill turns a PR's review graph into records.
//
// Output:
// {
//   "pr": { number, title, url, author, updated_at, merged_at, head_ref_oid },
//   "reviews":  [ { review_id, author, author_type, state, body, submitted_at, ours, ours_kind } ],
//   "comments": [ { comment_id, url, path, line, original_line, diff_hunk, body, created_at,
//                   author, author_type, review_id, review_state,
//                   in_reply_to_id, parent_author, parent_author_type, parent_ours,
//                   root_id, thread_resolved, ours, ours_kind } ]
// }
//
// - author logins use REST form: bots end in "[bot]"; author_type is "Bot" or "User".
// - root_id is the thread's first comment; thread_resolved comes from GraphQL reviewThreads.
// - ours is true when the body carries the project's hidden `<!-- <marker-text> {...} -->` marker
//   (factory-pr-comment/references/github-pr-comments.md §1; pass the text from adapters.commentMarker);
//   ours_kind is its "kind" (null for replies). With no marker text, ours is always false.
//
// Primary path is one GraphQL request. If reviews or comments exceed 100 nodes it falls back to
// the paginated REST endpoints (also forced by FETCH_PR_THREADS_FORCE_REST=1). Thread resolution
// is always a separate paginated GraphQL query, because REST does not expose it.
// Runs `gh` with GH_HOST set; needs no jq. Exit: 0 ok, 1 bad usage or a failed gh call.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GRAPH_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      number title url updatedAt mergedAt headRefOid
      author { login __typename }
      reviews(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          databaseId author { login __typename } body state submittedAt
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              databaseId url body path line originalLine diffHunk createdAt
              author { login __typename }
              replyTo { databaseId author { login __typename } }
            }
          }
        }
      }
    }
  }
}`;

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

class GhError extends Error {}

function gh(host, args) {
  const bin = process.env.FACTORY_GH_BIN || 'gh';
  let prefix = [];
  if (process.env.FACTORY_GH_BIN_ARGS) {
    try { prefix = JSON.parse(process.env.FACTORY_GH_BIN_ARGS); }
    catch { throw new GhError('FACTORY_GH_BIN_ARGS must be a JSON array'); }
    if (!Array.isArray(prefix) || prefix.some((x) => typeof x !== 'string')) throw new GhError('FACTORY_GH_BIN_ARGS must be a JSON array of strings');
  }
  const r = spawnSync(bin, [...prefix, ...args], { encoding: 'utf8', env: { ...process.env, GH_HOST: host }, maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw new GhError(`cannot run gh: ${r.error.message}`);
  if (r.status !== 0) throw new GhError(`gh ${args.slice(0, 3).join(' ')} failed (${r.status}): ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

const nullish = (v) => (v === undefined ? null : v);
const login = (a) => (a?.__typename === 'Bot' ? `${a.login}[bot]` : nullish(a?.login));
const kind = (a) => (a?.__typename === 'Bot' ? 'Bot' : 'User');

// Maps each thread's first comment id to whether the thread is resolved.
function resolvedThreads(pages) {
  const out = {};
  for (const page of pages) {
    for (const n of page.data.repository.pullRequest.reviewThreads.nodes) out[String(n.comments.nodes[0]?.databaseId ?? null)] = n.isResolved;
  }
  return out;
}

function graphBase(p) {
  return {
    pr: p,
    reviews: p.reviews.nodes.map((r) => ({ review_id: r.databaseId, author: login(r.author), author_type: kind(r.author), state: r.state, body: r.body, submitted_at: r.submittedAt })),
    comments: p.reviews.nodes.flatMap((rv) => rv.comments.nodes.map((c) => ({
      comment_id: c.databaseId, url: c.url, path: c.path, line: c.line, original_line: c.originalLine, diff_hunk: c.diffHunk, body: c.body, created_at: c.createdAt,
      author: login(c.author), author_type: kind(c.author),
      review_id: rv.databaseId, review_state: rv.state,
      in_reply_to_id: nullish(c.replyTo?.databaseId),
    }))),
  };
}

function restBase(p, comments, reviews) {
  const state = Object.fromEntries(reviews.map((r) => [String(r.id), r.state]));
  return {
    pr: p,
    reviews: reviews.map((r) => ({ review_id: r.id, author: nullish(r.user?.login), author_type: nullish(r.user?.type), state: r.state, body: nullish(r.body), submitted_at: nullish(r.submitted_at) })),
    comments: comments.map((c) => ({
      comment_id: c.id, url: nullish(c.html_url), path: nullish(c.path), line: nullish(c.line), original_line: nullish(c.original_line), diff_hunk: nullish(c.diff_hunk), body: nullish(c.body), created_at: nullish(c.created_at),
      author: nullish(c.user?.login), author_type: nullish(c.user?.type),
      review_id: nullish(c.pull_request_review_id), review_state: nullish(state[String(nullish(c.pull_request_review_id))]),
      in_reply_to_id: nullish(c.in_reply_to_id),
    })),
  };
}

const escapeLikeJq = (s) => s.replace(/[^A-Za-z0-9 ]/g, (c) => `\\${c}`);

export function normalize(base, resolved, marker) {
  const ours = (o) => (marker === '' ? false : (o.body ?? '').includes(`<!-- ${marker} `));
  const oursKind = (o) => {
    if (!ours(o)) return null;
    const m = new RegExp(`<!-- ${escapeLikeJq(marker)} (\\{[^\\n]*\\}) -->`).exec(o.body);
    if (!m) return null;
    try {
      const k = JSON.parse(m[1])?.kind;
      return k === undefined || k === false ? null : k;
    } catch { return null; }
  };
  const byId = new Map(base.comments.map((c) => [String(c.comment_id), c]));
  const rootOf = (c) => {
    const seen = new Set();
    while (c.in_reply_to_id != null && byId.has(String(c.in_reply_to_id)) && !seen.has(c.comment_id)) { seen.add(c.comment_id); c = byId.get(String(c.in_reply_to_id)); }
    return c.comment_id;
  };
  const p = base.pr;
  return {
    pr: { number: p.number, title: p.title, url: p.url, author: login(p.author), updated_at: p.updatedAt, merged_at: p.mergedAt, head_ref_oid: p.headRefOid },
    reviews: base.reviews.map((r) => ({ ...r, ours: ours(r), ours_kind: oursKind(r) })),
    comments: base.comments.map((c) => {
      const parent = byId.get(String(c.in_reply_to_id ?? '')) ?? null;
      const root = rootOf(c);
      return {
        ...c,
        parent_author: parent?.author ?? null,
        parent_author_type: parent?.author_type ?? null,
        parent_ours: parent === null ? null : ours(parent),
        root_id: root,
        thread_resolved: String(root) in resolved ? resolved[String(root)] : null,
        ours: ours(c),
        ours_kind: oursKind(c),
      };
    }),
  };
}

export function fetchThreads(host, ownerRepo, pr, marker = '') {
  const [owner, repo] = [ownerRepo.split('/')[0], ownerRepo.slice(ownerRepo.indexOf('/') + 1)];
  const vars = ['-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `pr=${pr}`];
  const graph = gh(host, ['api', 'graphql', ...vars, '-f', `query=${GRAPH_QUERY.trim()}`]);
  const pages = gh(host, ['api', 'graphql', '--paginate', '--slurp', ...vars, '-f', `query=${THREADS_QUERY.trim()}`]);
  const resolved = resolvedThreads(pages);
  const p = graph.data.repository.pullRequest;
  const paginated = p.reviews.pageInfo.hasNextPage || p.reviews.nodes.some((r) => r.comments.pageInfo.hasNextPage);
  let base;
  if (paginated || process.env.FETCH_PR_THREADS_FORCE_REST === '1') {
    console.error(`fetch-pr-threads: >100 reviews or comments on ${ownerRepo}#${pr}; using paginated REST`);
    const flat = (x) => (x ?? []).flat();
    const comments = flat(gh(host, ['api', '--paginate', '--slurp', `repos/${ownerRepo}/pulls/${pr}/comments?per_page=100`]));
    const reviews = flat(gh(host, ['api', '--paginate', '--slurp', `repos/${ownerRepo}/pulls/${pr}/reviews?per_page=100`]));
    base = restBase(p, comments, reviews);
  } else base = graphBase(p);
  return normalize(base, resolved, marker);
}

function main() {
  const a = process.argv.slice(2);
  if (a.length < 3 || a.length > 4) { console.error('Usage: fetch-pr-threads.mjs <gh-host> <owner/repo> <pr-number> [<marker-text>]'); process.exit(1); }
  try {
    process.stdout.write(`${JSON.stringify(fetchThreads(a[0], a[1], a[2], a[3] ?? ''), null, 2)}\n`);
  } catch (e) {
    console.error(`fetch-pr-threads: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
