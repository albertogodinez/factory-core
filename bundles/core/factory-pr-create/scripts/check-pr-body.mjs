#!/usr/bin/env node
// Fails when a PR body ticks a checklist box the body doesn't back up, or excuses an unrun check
// by the size of the change.
//
//   node check-pr-body.mjs <body.md>
//   node check-pr-body.mjs --pr <N> [--repo <owner/repo>]   # reads the live body with gh
//   add --visual for a style or layout change: the body must also carry an image, not only a video.
//   With --pr it turns on by itself when the PR changes a UI file (src/** minus tests and stories, or a docs
//   .mdx page) unless the body has a line "No visual change: <reason>".
//
// Every image outside a table needs a bold title as the nearest non-blank line above it
// (`**Header alignment**`), so a reader can scan the body without opening each screenshot.
//   add --ui-paths 'glob,glob' to replace the default UI-path test used by the stale-recording warning
//
// Stale recording: a body with a video must say which commit it was recorded at, on a line
// `Recorded at \`<sha>\``. With --pr, if that commit is not the PR head and a UI file or a dependency
// (package.json, a lockfile) changed since, it warns.
// Warnings print on stderr as "!" and never change the exit code.
//
// Verified at: a body with a `## Verification` section must say which commit the checks ran on, on a line
// `Verified at \`<sha>\``. With --pr, a sha that is not the PR head fails once a non-doc file changed since.
//
// Canary pin: with --pr, a package.json line the PR adds with a `-canary.` version fails unless the PR is a
// draft and the body has a `Blocked on <source PR>` line.
//
// Template checklist: with --pr (or --template <file>), each checkbox item in the body must be one of the repo's
// `.github/pull_request_template.md` items as written. A template item with text added after it fails; an item the
// template doesn't have warns. Skipped when the repo has no template.
//
// Reviewer noise (warnings): decimal coordinates, "zoom N", trip or conversation URLs a reviewer can't open, and a
// commit sha in backticks that isn't a link.
//
// Exit 0: clean. 1: findings (one per line on stderr). 2: usage or gh error.
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEDGE = /\b(to be (attached|added|uploaded)|tbd|will (be )?(attach|add|upload)(ed)?|(attach|add|upload)(ed)? later|(are|is|kept|saved|stored|only) local(ly)?)\b/i;
const EVIDENCE_BOX = /\b(screenshots?|screen ?shots?|recording|video|gif)\b/i;
const SCREENSHOT_BOX = /\b(screenshots?|screen ?shots?)\b/i;
const UPLOADED = /github\.com\/user-attachments\/assets\/|<img\b|<video\b|!\[[^\]]*\]\(https?:\/\//i;
// gh --attach rewrites an image to ![alt](https://…) and a video to a bare URL line, so only these are images.
const IMAGE = /!\[[^\]]*\]\(https?:\/\/|<img\b/i;
// A video is a bare user-attachments URL on its own line (an image is wrapped in ![]() or <img>), a <video>, or an .mp4/.webm link.
const VIDEO = /^\s*https:\/\/github\.com\/user-attachments\/assets\/\S+\s*$|<video\b|\.(?:mp4|webm)\b/im;
// The convention is `Recorded at `<sha>``, the sha optionally linked (`[`<sha>`](<commit url>)`). A natural caption also counts: "this branch (`<sha>`)", "branch at `<sha>`".
const RECORDED_AT = /\brecorded at\s*\[?`([0-9a-f]{7,40})`/gi;
const CAPTION_AT = /\b(?:this branch|the branch|branch)\s*(?:\(|at\s*)\[?`([0-9a-f]{7,40})`/gi;
const NOT_UI = /(^|\/)(__tests__|__mocks__|__fixtures__|fixtures|e2e|cypress)\/|\.(test|spec|stories|story)\.[a-z]+$|\.mdx?$/i;
const DEFAULT_UI = (file) => /(^|\/)src\//.test(file) && !NOT_UI.test(file);
// A dependency bump can change what renders (a design-system or component package drawing the UI).
const DEPENDENCY_FILE = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;
// A docs page renders the component, so changing one is a visual change too.
const VISUAL_FILE = (file) => DEFAULT_UI(file) || /(^|\/)docs\/[^/]+\.mdx$/i.test(file);
const NO_VISUAL_CHANGE = /^\s*(?:[-*]\s*)?\**no visual change\**:\s*\S/im;
const TITLE = /^\s*\*\*[^*]+\*\*:?\s*$/;
const TICKED = /^\s*(?:[-*+]|\d+\.)\s+\[[xX]\]\s+(.*)$/;
const NOT_RUN = /\b(not (run|checked|done|measured|verified)|skipped)\b/i;
const VERIFIED_AT = /\bverified at\s*\[?`([0-9a-f]{7,40})`/gi;
const VERIFICATION_HEADING = /^#{2,4}\s+verification\b/im;
const DOC_ONLY = /\.mdx?$/i;
const CANARY_PIN = /^\+\s*"[^"]+"\s*:\s*"[^"]*-canary\.[^"]*"/m;
const BLOCKED_ON = /\bblocked on\b/i;
const SIZE_REASON = /\b(\d+[- ]line (change|diff|pr)|(small|tiny|trivial) (change|diff|pr)|no (new )?(heavy )?imports?( of heavy modules)?)\b/i;

function usage(message) {
  console.error(`check-pr-body: ${message}\nusage: check-pr-body.mjs <body.md> | --pr <N> [--repo <owner/repo>] [--visual]`);
  process.exit(2);
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function readPr(rawArgv) {
  const argv = rawArgv.filter((arg) => arg !== '--visual');
  const pr = argv.indexOf('--pr');
  if (pr === -1) {
    const files = argv.filter((arg, i) => !arg.startsWith('--') && !['--template', '--ui-paths', '--repo'].includes(argv[i - 1]));
    if (files.length !== 1) usage('pass one body file, or --pr');
    return { body: readFileSync(files[0], 'utf8') };
  }
  const number = argv[pr + 1];
  if (!/^\d+$/.test(number ?? '')) usage('--pr needs a number');
  const args = ['pr', 'view', number, '--json', 'body,headRefOid,isDraft'];
  const repo = flag(argv, '--repo');
  if (repo) args.push('--repo', repo);
  try {
    const { body, headRefOid, isDraft } = JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
    return { body, head: headRefOid, isDraft, number, repo };
  } catch (error) {
    console.error(`check-pr-body: gh pr view failed: ${error.message}`);
    process.exit(2);
  }
}

// Files changed between a recorded commit and the head, without a local checkout.
function compareFiles(repo) {
  return (sha, head) => {
    const out = execFileSync('gh', ['api', `repos/${repo}/compare/${sha}...${head}`, '--paginate', '-q', '.files[].filename'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  };
}

function prFiles(repo, number) {
  return execFileSync('gh', ['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '-q', '.[].filename'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

// --visual is the default for a PR that changes what renders; an explicit reason in the body turns it off.
export function impliedVisual(body, files) {
  if (NO_VISUAL_CHANGE.test(body)) return [];
  return files.filter(VISUAL_FILE);
}

// The added lines of every package.json the PR changes.
function packagePatches(repo, number) {
  const out = execFileSync('gh', ['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '-q', '.[] | select(.filename == "package.json" or (.filename | endswith("/package.json"))) | .patch // ""'], { encoding: 'utf8' });
  return out;
}

function globToTest(globs) {
  const patterns = globs.map((glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`));
  return (file) => patterns.some((pattern) => pattern.test(file));
}

export function recordedShas(body) {
  const explicit = [...body.matchAll(RECORDED_AT)].map((match) => match[1]);
  const found = explicit.length ? explicit : [...body.matchAll(CAPTION_AT)].map((match) => match[1]);
  return [...new Set(found.map((sha) => sha.toLowerCase()))];
}

export function recordingWarnings(body, { head, compare, isUi = DEFAULT_UI } = {}) {
  if (!VIDEO.test(body)) return [];
  const shas = recordedShas(body);
  if (!shas.length) return ['the body has a recording but no commit it was recorded at: add a line "Recorded at `<sha>`" next to it, so a later commit is not mistaken for what the video shows'];
  if (!head || !compare) return [];
  const out = [];
  for (const sha of shas) {
    if (head.toLowerCase().startsWith(sha)) continue;
    let files;
    try {
      files = compare(sha, head);
    } catch (error) {
      out.push(`recorded at ${sha} but the PR head is ${head.slice(0, 8)}; could not list the files changed between them (${String(error.message).split('\n')[0]})`);
      continue;
    }
    const deps = files.filter((file) => DEPENDENCY_FILE.test(file));
    if (deps.length) out.push(`recording is of ${sha} but the PR head is ${head.slice(0, 8)}, and the dependencies changed since (${deps.join(', ')}); a package that draws the UI may render differently now. Re-record, or compare the old and new package's dist and say so in the body`);
    const ui = files.filter(isUi);
    if (ui.length) out.push(`recording is of ${sha} but the PR head is ${head.slice(0, 8)}; ${ui.length} UI file${ui.length === 1 ? '' : 's'} changed since: ${ui.slice(0, 5).join(', ')}${ui.length > 5 ? `, and ${ui.length - 5} more` : ''}. Re-record, or say in the body what changed`);
  }
  return out;
}

export function verifiedShas(body) {
  return [...new Set([...body.matchAll(VERIFIED_AT)].map((match) => match[1].toLowerCase()))];
}

// A verification table is a claim about one tree; it must name that tree, and with --pr it must be the head.
export function verificationFindings(body, { head, compare } = {}) {
  if (!VERIFICATION_HEADING.test(body)) return [];
  const shas = verifiedShas(body);
  if (!shas.length) return ['the body has a Verification section but no commit it ran on: add a line "Verified at `<sha>`" under the table (the head you ran the checks on)'];
  if (!head || !compare) return [];
  const out = [];
  for (const sha of shas) {
    if (head.toLowerCase().startsWith(sha)) continue;
    let files;
    try {
      files = compare(sha, head);
    } catch (error) {
      out.push(`verified at ${sha} but the PR head is ${head.slice(0, 8)}; could not list the files changed between them (${String(error.message).split('\n')[0]})`);
      continue;
    }
    const code = files.filter((file) => !DOC_ONLY.test(file));
    if (code.length) out.push(`verification ran at ${sha} but the PR head is ${head.slice(0, 8)}, and ${code.length} file${code.length === 1 ? '' : 's'} changed since: ${code.slice(0, 5).join(', ')}${code.length > 5 ? `, and ${code.length - 5} more` : ''}. Re-run the checks on the head and update the table and its "Verified at" line`);
  }
  return out;
}

const CHECKBOX = /^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s+(.*\S)\s*$/;
const squash = (text) => text.replace(/\s+/g, ' ').trim();

// The repo's PR template at the head, or null when it has none.
function prTemplate(repo, ref) {
  for (const path of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md']) {
    try {
      const b64 = execFileSync('gh', ['api', `repos/${repo}/contents/${path}?ref=${ref}`, '-q', '.content'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
    } catch {}
  }
  return null;
}

// The template's checklist is the repo's, so the body ticks its items as written: detail goes in the body above.
export function checklistFindings(body, template) {
  if (!template) return { problems: [], warnings: [] };
  const items = template.split('\n').map((line) => CHECKBOX.exec(line)?.[1]).filter(Boolean).map(squash);
  if (!items.length) return { problems: [], warnings: [] };
  const problems = [];
  const warnings = [];
  body.split('\n').forEach((line, index) => {
    const match = CHECKBOX.exec(line);
    if (!match) return;
    const text = squash(match[1]);
    if (items.includes(text)) return;
    const extended = items.find((item) => text.startsWith(item));
    if (extended) problems.push(`checklist item has text added after the template's wording; move it into the body above. line ${index + 1}: ${text.slice(extended.length).trim().slice(0, 100)}`);
    else warnings.push(`checklist item is not in the repo's PR template; keep the template's items as written. line ${index + 1}: ${text.slice(0, 100)}`);
  });
  return { problems, warnings };
}

const COORDINATE = /-?\b\d{1,3}\.\d{4,}\b/;
const ZOOM = /\bzoom(?: level)?\s*\d+\b/i;
const PRIVATE_LINK = /\/trips\/[0-9a-f-]{8,}|conversationId=[0-9a-f-]{8,}/i;
const BACKTICK_SHA = /(^|[^[])`([0-9a-f]{7,40})`/g;

// Numbers and links only the author can use; a reviewer gets the finding and steps to reproduce it instead.
export function noiseWarnings(body) {
  const out = [];
  let fenced = false;
  body.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const where = `line ${index + 1}: ${line.trim().slice(0, 100)}`;
    if (COORDINATE.test(line)) out.push(`the body gives a coordinate (${COORDINATE.exec(line)[0]}); say where the map lands instead. ${where}`);
    if (ZOOM.test(line)) out.push(`the body gives a zoom level ("${ZOOM.exec(line)[0]}"); describe what the reviewer sees instead. ${where}`);
    if (PRIVATE_LINK.test(line)) out.push(`the body links a trip or conversation only the author can open; describe the kind of trip and how to make one. ${where}`);
    for (const match of line.matchAll(BACKTICK_SHA)) {
      const sha = match[2];
      if (/[a-f]/.test(sha) && /\d/.test(sha)) out.push(`commit ${sha} is not a link; write it as [\`${sha}\`](<commit url>). ${where}`);
    }
  });
  return out;
}

// A host pinned to a prerelease can't merge; the PR has to say so in a way a reviewer can't miss.
export function canaryFindings(body, { patches = '', isDraft } = {}) {
  const pin = CANARY_PIN.exec(patches);
  if (!pin) return [];
  const out = [];
  const what = pin[0].replace(/^\+\s*/, '').trim();
  if (isDraft === false) out.push(`package.json pins a canary (${what}) but the PR is not a draft: mark it draft until the source PR releases`);
  if (!BLOCKED_ON.test(body)) out.push(`package.json pins a canary (${what}) but the body has no "Blocked on <source PR URL>" line`);
  return out;
}

export function findings(body, { visual = false } = {}) {
  const hasUpload = UPLOADED.test(body);
  const out = [];
  if (visual && !IMAGE.test(body)) {
    out.push('visual change but the body has no image: attach before/after screenshots on every brand (a video alone does not count)');
  }
  const lines = body.split('\n');
  lines.forEach((line, index) => {
    if (!IMAGE.test(line) || line.trim().startsWith('|')) return;
    let above = index - 1;
    while (above >= 0 && !lines[above].trim()) above -= 1;
    if (above < 0 || !TITLE.test(lines[above])) {
      out.push(`image has no bold title on the line above it; add one, e.g. **Header alignment**. line ${index + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
  lines.forEach((line, index) => {
    // A quoted phrase is someone citing the excuse, not making it.
    const unquoted = line.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, '');
    if (NOT_RUN.test(unquoted) && SIZE_REASON.test(unquoted)) {
      out.push(`a check is excused by the change's size ("${SIZE_REASON.exec(unquoted)[0]}"); run it, or name what blocked it. line ${index + 1}: ${line.trim().slice(0, 100)}`);
    }
    const match = TICKED.exec(line);
    if (!match) return;
    const text = match[1].trim();
    const where = `line ${index + 1}: ${text.slice(0, 100)}`;
    if (HEDGE.test(text)) out.push(`ticked box hedges ("${HEDGE.exec(text)[0]}"); untick it or attach what it names. ${where}`);
    else if (EVIDENCE_BOX.test(text) && !hasUpload) out.push(`ticked box names screenshots/video but the body has no uploaded image or video. ${where}`);
    else if (SCREENSHOT_BOX.test(text) && !IMAGE.test(body)) out.push(`ticked box names screenshots but the body has only a video; attach the images. ${where}`);
  });
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const { body, head, isDraft, number, repo } = readPr(argv);
  const uiPaths = flag(argv, '--ui-paths');
  const isUi = uiPaths ? globToTest(uiPaths.split(',').map((glob) => glob.trim()).filter(Boolean)) : DEFAULT_UI;
  let slug = repo;
  if (head && !slug) {
    try {
      slug = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' }).trim();
    } catch {}
  }
  let visual = argv.includes('--visual');
  if (!visual && number && slug) {
    try {
      const ui = impliedVisual(body, prFiles(slug, number));
      if (ui.length) {
        visual = true;
        console.error(`! treating this as a visual change: it changes ${ui.slice(0, 3).join(', ')}${ui.length > 3 ? `, and ${ui.length - 3} more` : ''}. A body line "No visual change: <reason>" turns this off`);
      }
    } catch (error) {
      console.error(`! could not list the PR's files, so a visual change was not inferred (${String(error.message).split('\n')[0]})`);
    }
  }
  const problems = findings(body, { visual });
  const compare = head && slug ? compareFiles(slug) : undefined;
  problems.push(...verificationFindings(body, { head, compare }));
  if (number && slug) {
    try {
      problems.push(...canaryFindings(body, { patches: packagePatches(slug, number), isDraft }));
    } catch (error) {
      console.error(`! could not read the PR's package.json changes, so the canary-pin check did not run (${String(error.message).split('\n')[0]})`);
    }
  }
  const templateFile = flag(argv, '--template');
  let template = templateFile ? readFileSync(templateFile, 'utf8') : null;
  if (!template && head && slug) template = prTemplate(slug, head);
  const checklist = checklistFindings(body, template);
  problems.push(...checklist.problems);
  for (const warning of [...recordingWarnings(body, { head, compare, isUi }), ...checklist.warnings, ...noiseWarnings(body)]) console.error(`! ${warning}`);
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length) process.exit(1);
  console.log('✓ PR body: every ticked box is backed, and no check is skipped for size');
}
