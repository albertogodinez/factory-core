#!/usr/bin/env node
// post-comment.mjs: post one GitHub PR comment, adding the project's disclosure
// marker and banner (adapters.commentMarker from toolkit-context).
//
// The convention it applies lives in ../references/github-pr-comments.md (§1 marker and banner,
// §3.1 fresh head SHA, §3.2 line must be in the diff, §4 pending reviews). The caller still owns
// what the body says (§2) and the overlap check (§3.3).
//
// Usage:
//   post-comment.mjs --pr N --kind reply|annotation|review --body-file PATH
//                    [--repo OWNER/NAME] [--host HOST] [--in-reply-to ID]
//                    [--path FILE [--line L [--start-line S] [--side RIGHT|LEFT]]]
//                    [--model ID] [--expect-head SHA] [--yes] [--dry-run]
//
//   reply       in-thread reply to --in-reply-to (a thread's root comment id)
//   annotation  new inline note on the head commit; falls back to the user's pending review on 422
//   review      review finding; always lands in the user's pending review (created if none)
//   --path without --line posts a file-level comment.
//   --repo      default: this project's upstream, else its origin slug
//   --yes       the user confirmed this post (needed when the project has writeAllowed: false)
//
// Prints the created comment URL on stdout. --dry-run makes only GET requests and prints the
// final body and the requests it would send. node: imports only; needs `gh`.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(realpathSync(import.meta.filename));
const RESOLVE = join(HERE, '..', '..', 'toolkit-context', 'scripts', 'resolve.mjs');

function die(msg, code = 1) { process.stderr.write(`post-comment: ${msg}\n`); process.exit(code); }
function usage() {
  const src = readFileSync(import.meta.filename, 'utf8').split('\n');
  process.stderr.write(src.slice(1, 24).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(2);
}

// ---------- args ----------
const a = { side: 'RIGHT', dryRun: false, yes: false };
const argv = process.argv.slice(2);
const FLAGS = { '--repo': 'repo', '--host': 'host', '--pr': 'pr', '--kind': 'kind', '--in-reply-to': 'inReplyTo',
  '--path': 'path', '--line': 'line', '--start-line': 'startLine', '--side': 'side', '--body-file': 'bodyFile',
  '--model': 'model', '--expect-head': 'expectHead' };
for (let i = 0; i < argv.length; i++) {
  const f = argv[i];
  if (FLAGS[f]) { a[FLAGS[f]] = argv[++i] ?? ''; }
  else if (f === '--dry-run') a.dryRun = true;
  else if (f === '--yes') a.yes = true;
  else if (f === '-h' || f === '--help') usage();
  else die(`unknown argument: ${f} (see --help)`);
}
a.model ??= process.env.AI_TOOLKIT_MODEL || process.env.CC_AUTOREPLY_MODEL || process.env.ANTHROPIC_MODEL || 'unknown';

// ---------- project context ----------
function resolveCtx(extra = []) {
  const r = spawnSync(process.execPath, [RESOLVE, '--full', ...extra], { encoding: 'utf8' });
  if (r.status !== 0) return { error: (r.stderr || '').trim() || `resolver exited ${r.status}` };
  return JSON.parse(r.stdout);
}
const here = existsSync(RESOLVE) ? resolveCtx() : { error: `toolkit-context is not installed next to this skill (${RESOLVE})` };
let ctx = here;
if (!a.repo) {
  if (here.error) die(`${here.error}; pass --repo OWNER/NAME`);
  a.repo = here.project?.remote?.upstream || here.project?.remote?.slug;
  if (!a.repo) die('this project has no remote; pass --repo OWNER/NAME');
} else if (!here.error) {
  const want = a.repo.toLowerCase();
  const p = here.project?.remote || {};
  if (p.slug?.toLowerCase() !== want && p.upstream?.toLowerCase() !== want) {
    const sub = resolveCtx(['--repo', a.repo]);
    ctx = sub.error ? { ...here, otherRepo: true } : sub;
  }
}

// ---------- argument checks ----------
if (!/^[^/]+\/[^/]+$/.test(a.repo)) die('--repo OWNER/NAME is required');
if (!/^\d+$/.test(a.pr || '')) die('--pr N is required');
if (!a.bodyFile || !existsSync(a.bodyFile)) die('--body-file must name an existing file');
const body = readFileSync(a.bodyFile, 'utf8');
if (body.length === 0) die('--body-file is empty');
if (a.side !== 'RIGHT' && a.side !== 'LEFT') die('--side must be RIGHT or LEFT');
for (const n of [a.line, a.startLine, a.inReplyTo]) {
  if (n != null && n !== '' && !/^\d+$/.test(n)) die(`line numbers and comment ids must be integers (got '${n}')`);
}

// ---------- marker policy ----------
// adapters.commentMarker: null or {mode:"off"} adds nothing; "text" adds the hidden marker;
// "banner" adds the marker and a visible banner. Unconfigured is refused, so a missing
// setting never posts an unmarked comment by accident.
const marker = ctx.error ? undefined : (ctx.adapters ? ctx.adapters.commentMarker : undefined);
const markerConfigured = !ctx.error && ctx.adapters && 'commentMarker' in ctx.adapters;
if (!markerConfigured && !a.dryRun) {
  die(`no comment-marker policy for this project. Set pr.commentMarker in .ai-toolkit/project.json ` +
    `({"mode":"off"} for none), or run factory install, which asks once`);
}
const mode = marker?.mode || 'off';
const tag = marker?.text || null;
if (mode !== 'off' && !tag) die('commentMarker.mode is text or banner but commentMarker.text is empty');
if (tag && body.includes(tag)) {
  die(`body already contains ${tag}; pass the body without the marker or banner (this script adds them)`);
}

const kind = a.kind;
if (kind === 'reply') {
  if (!a.inReplyTo) die('--kind reply needs --in-reply-to ID');
  if (a.path || a.line) die('--kind reply takes no --path/--line (the thread fixes them)');
} else if (kind === 'annotation' || kind === 'review') {
  if (a.inReplyTo) die('--in-reply-to is only for --kind reply');
  if (!a.path) die(`--kind ${kind} needs --path (and --line for an inline comment)`);
  if (a.startLine && !a.line) die('--start-line needs --line');
  if (a.startLine && Number(a.startLine) >= Number(a.line)) die('--start-line must be below --line');
} else die('--kind must be reply, annotation or review');
const banner = mode === 'banner'
  ? (typeof marker.banner === 'string' ? marker.banner : marker.banner?.[kind]) || null
  : null;
if (mode === 'banner' && !banner) die(`commentMarker.mode is banner but has no banner for kind ${kind}`);

// ---------- writes allowed? ----------
const writeAllowed = !ctx.error && ctx.writeAllowed === true && !ctx.otherRepo;
if (!writeAllowed && !a.yes && !a.dryRun) {
  const why = ctx.error ? ctx.error : ctx.otherRepo ? `${a.repo} is not this project or a writable neighbor`
    : ctx.mode === 'zero-config' ? 'this repo has no .ai-toolkit/project.json (zero-config)' : 'writeAllowed is false';
  die(`refusing to post: ${why}. Ask the user to confirm this comment, then rerun with --yes (or --dry-run to preview)`);
}

// ---------- host ----------
let host = a.host;
if (!host) {
  host = ctx.error || ctx.otherRepo ? null : ctx.project?.remote?.host;
  if (!host) die(`cannot resolve the GitHub host for ${a.repo}; pass --host`);
}
const ghEnv = { ...process.env, GH_HOST: host };
const [owner, name] = a.repo.split('/');

function gh(args, { allowFail = false } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', env: ghEnv, maxBuffer: 64 << 20 });
  if (r.error) die(`cannot run gh: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) die(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return allowFail ? { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } : r.stdout.trim();
}
// gh --paginate prints one JSON value per page, back to back. Parse them all.
function parseConcat(text) {
  const vals = []; let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') { if (--depth === 0) { j++; break; } }
    }
    vals.push(JSON.parse(text.slice(i, j))); i = j;
  }
  return vals;
}

// ---------- §3.1 fresh head SHA ----------
const prInfo = JSON.parse(gh(['api', `repos/${a.repo}/pulls/${a.pr}`, '--jq', '{head: .head.sha, node_id, state}']));
const head = prInfo.head, prNode = prInfo.node_id;
if (prInfo.state !== 'open') process.stderr.write(`post-comment: warning: PR #${a.pr} is not open\n`);
if (a.expectHead && !head.startsWith(a.expectHead)) {
  die(`head moved: expected ${a.expectHead}, PR head is now ${head}. Re-read the target at the new head, then re-anchor or drop the comment`);
}

// ---------- §3.2 the line must be on the requested side of the PR diff ----------
function diffLines(patch, side) {
  const out = new Set(); let o = 0, n = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) {
      const mo = /-(\d+)/.exec(l), mn = /\+(\d+)/.exec(l);
      if (mo) o = Number(mo[1]); if (mn) n = Number(mn[1]); continue;
    }
    if (l.startsWith('\\')) continue;
    if (l.startsWith('+')) { if (side === 'RIGHT') out.add(n); n++; continue; }
    if (l.startsWith('-')) { if (side === 'LEFT') out.add(o); o++; continue; }
    out.add(side === 'RIGHT' ? n : o); n++; o++;
  }
  return out;
}
if (a.line) {
  const pages = parseConcat(gh(['api', '--paginate', `repos/${a.repo}/pulls/${a.pr}/files?per_page=100`]));
  const file = pages.flat().find((f) => f.filename === a.path);
  if (!file) die(`${a.path} is not changed by PR #${a.pr}; post a file-level comment (omit --line) or pick a changed file`);
  if (!file.patch) die(`GitHub returned no patch for ${a.path} (binary or too large); post a file-level comment (omit --line)`);
  const valid = diffLines(file.patch, a.side);
  for (const l of [a.line, a.startLine].filter(Boolean)) {
    if (!valid.has(Number(l))) die(`line ${l} of ${a.path} is not in the PR diff on the ${a.side} side (GitHub would 422). Post a file-level comment instead (omit --line), or anchor to a line the diff touches`);
  }
}

// ---------- §1 marker + banner ----------
const ts = process.env.POST_COMMENT_TS || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const meta = kind === 'reply'
  ? { v: 1, model: a.model, pr: Number(a.pr), in_reply_to: Number(a.inReplyTo), head, ts }
  : { v: 1, kind, model: a.model, pr: Number(a.pr), path: a.path, ...(a.line ? { line: Number(a.line) } : {}), head, ts };
let finalBody = body;
if (mode === 'banner') finalBody = `<!-- ${tag} ${JSON.stringify(meta)} -->\n${banner}\n\n${body}`;
else if (mode === 'text') finalBody = `<!-- ${tag} ${JSON.stringify(meta)} -->\n\n${body}`;

const tmp = mkdtempSync(join(tmpdir(), 'post-comment-'));
const bodyPath = join(tmp, 'body.md');
writeFileSync(bodyPath, finalBody);
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// ---------- request helpers ----------
const show = (args) => process.stderr.write(`+ GH_HOST=${host} gh ${args.join(' ')}\n`);
function pendingReview() {
  const pages = parseConcat(gh(['api', '--paginate', `repos/${a.repo}/pulls/${a.pr}/reviews?per_page=100`]));
  return pages.flat().find((r) => r.state === 'PENDING')?.node_id || '';
}
function addThread(reviewId) {
  const args = ['-f', `r=${reviewId}`, '-f', `p=${a.path}`, '-F', `b=@${bodyPath}`];
  let vars = '$r:ID!,$p:String!,$b:String!', input = 'pullRequestReviewId:$r,path:$p,body:$b';
  if (a.line) {
    args.push('-F', `l=${a.line}`, '-f', `s=${a.side}`); vars += ',$l:Int!,$s:DiffSide!'; input += ',line:$l,side:$s';
    if (a.startLine) { args.push('-F', `sl=${a.startLine}`); vars += ',$sl:Int!'; input += ',startLine:$sl,startSide:$s'; }
  } else input += ',subjectType:FILE';
  const q = `mutation(${vars}){addPullRequestReviewThread(input:{${input}}){thread{comments(last:1){nodes{url}}}}}`;
  if (a.dryRun) { show(['api', 'graphql', '-f', `query='${q}'`, ...args]); return; }
  process.stdout.write(gh(['api', 'graphql', '-f', `query=${q}`, ...args, '--jq', '.data.addPullRequestReviewThread.thread.comments.nodes[0].url']) + '\n');
}
function createPendingReview() {
  const q = 'mutation($pr:ID!,$c:GitObjectID!){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$c}){pullRequestReview{id state}}}';
  if (a.dryRun) { show(['api', 'graphql', '-f', `query='${q}'`, '-f', `pr=${prNode}`, '-f', `c=${head}`]); return '<new-pending-review>'; }
  return gh(['api', 'graphql', '-f', `query=${q}`, '-f', `pr=${prNode}`, '-f', `c=${head}`, '--jq', '.data.addPullRequestReview.pullRequestReview.id']);
}
function addPendingReply(reviewId) {
  const pages = parseConcat(gh(['api', 'graphql', '--paginate', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${a.pr}`, '-f', `query=
    query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        reviewThreads(first:100, after:$endCursor){ pageInfo{hasNextPage endCursor}
          nodes{ id comments(first:1){ nodes{ databaseId } } } } } } }`]));
  const thread = pages.flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes)
    .find((t) => t.comments.nodes[0]?.databaseId === Number(a.inReplyTo))?.id;
  if (!thread) die(`no review thread on PR #${a.pr} starts with comment ${a.inReplyTo} (reply to the thread's root comment)`);
  const q = 'mutation($r:ID!,$t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewId:$r,pullRequestReviewThreadId:$t,body:$b}){comment{url}}}';
  const args = ['-f', `r=${reviewId}`, '-f', `t=${thread}`, '-F', `b=@${bodyPath}`];
  if (a.dryRun) { show(['api', 'graphql', '-f', `query='${q}'`, ...args]); return; }
  process.stdout.write(gh(['api', 'graphql', '-f', `query=${q}`, ...args, '--jq', '.data.addPullRequestReviewThreadReply.comment.url']) + '\n');
}

// ---------- dispatch ----------
if (a.dryRun) {
  if (!markerConfigured) process.stderr.write('post-comment: warning: no comment-marker policy is configured; a real post would be refused\n');
  process.stderr.write(`----- body (${kind}, PR #${a.pr}, head ${head}) -----\n${finalBody}${finalBody.endsWith('\n') ? '' : '\n'}----- request -----\n`);
}
let pending = pendingReview();
if (kind === 'review') {
  if (!pending) pending = createPendingReview();
  addThread(pending);
  if (!a.dryRun) process.stderr.write('post-comment: added to your pending review; it stays invisible until you submit it\n');
} else {
  let rest;
  if (kind === 'reply') rest = ['-X', 'POST', `repos/${a.repo}/pulls/${a.pr}/comments/${a.inReplyTo}/replies`, '-F', `body=@${bodyPath}`];
  else if (a.line) {
    rest = ['-X', 'POST', `repos/${a.repo}/pulls/${a.pr}/comments`, '-f', `commit_id=${head}`, '-f', `path=${a.path}`, '-F', `line=${a.line}`, '-f', `side=${a.side}`, '-F', `body=@${bodyPath}`];
    if (a.startLine) rest.push('-F', `start_line=${a.startLine}`, '-f', `start_side=${a.side}`);
  } else rest = ['-X', 'POST', `repos/${a.repo}/pulls/${a.pr}/comments`, '-f', `commit_id=${head}`, '-f', `path=${a.path}`, '-f', 'subject_type=file', '-F', `body=@${bodyPath}`];
  if (a.dryRun) {
    show(['api', ...rest]);
    if (pending) {
      process.stderr.write(`note: you have a pending review (${pending}); the REST call would 422 and fall back to:\n`);
      if (kind === 'reply') addPendingReply(pending); else addThread(pending);
    }
    process.stderr.write('dry run: nothing posted\n');
    process.exit(0);
  }
  const r = gh(['api', ...rest, '--jq', '.html_url'], { allowFail: true });
  if (r.ok) { process.stdout.write(r.out + '\n'); process.exit(0); }
  const out = `${r.out}\n${r.err}`;
  if (!/one pending review per pull request/.test(out)) die(`GitHub rejected the comment: ${out.trim()}`);
  if (!pending) pending = pendingReview();
  if (!pending) die(`GitHub reported a pending review but none is visible: ${out.trim()}`);
  process.stderr.write('post-comment: you have a pending review; adding to it (invisible until you submit it)\n');
  if (kind === 'reply') addPendingReply(pending); else addThread(pending);
}
if (a.dryRun) process.stderr.write('dry run: nothing posted\n');
