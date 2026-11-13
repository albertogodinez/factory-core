import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findings, recordingWarnings, recordedShas, verificationFindings, verifiedShas, canaryFindings, impliedVisual, checklistFindings, noiseWarnings, scopeClaimWarnings, numberingWarnings, shapeWarnings, wordCount } from './check-pr-body.mjs';

const VIDEO = 'Demo:\nhttps://github.com/user-attachments/assets/e78b568f-1fd9-436d-8807-bbfcbba2e2b3\n';
const IMAGE = '**Header alignment**\n\n![after, Acme](https://github.com/user-attachments/assets/0d1c2b3a-0000-4000-8000-000000000000)\n';

test('a video alone fails --visual', () => {
  assert.equal(findings(VIDEO, { visual: true }).length, 1);
});

test('an image passes --visual', () => {
  assert.deepEqual(findings(VIDEO + IMAGE, { visual: true }), []);
});

test('without --visual a video-only body is clean', () => {
  assert.deepEqual(findings(VIDEO), []);
});

test('a ticked screenshot box with no upload still fails', () => {
  assert.equal(findings('- [x] Screenshots attached\n').length, 1);
});

test('a ticked screenshot box backed only by a video fails', () => {
  assert.equal(findings('- [x] Include before/after screenshots for visible UI changes.\n' + VIDEO).length, 1);
});

test('a ticked video box backed by a video passes', () => {
  assert.deepEqual(findings('- [x] Demo video attached\n' + VIDEO), []);
});

test('a check not run because the change is small fails', () => {
  const body = 'Not checked live: Hotels.com, and the bundle size (a 70-line change with no new imports of heavy modules).\n';
  assert.equal(findings(body).length, 1);
});

test('a check not run for a named blocker passes', () => {
  assert.deepEqual(findings('| Not run | `pnpm test:bundles`: the build needs Artifactory, which returned E401 |\n'), []);
});

test('quoting the size excuse is not making it', () => {
  assert.deepEqual(findings('- Gates were skipped without a reason. Bundles were excused as "a 70-line change".\n'), []);
});

const HEAD = 'cf1281b8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RECORDED = VIDEO + 'Recorded at `a7f70ae8`\n';
const files = (...names) => () => names;
const NEVER = () => assert.fail('compare must not be called');

test('no recording: no warning, no compare', () => {
  assert.deepEqual(recordingWarnings(IMAGE, { head: HEAD, compare: NEVER }), []);
});

test('recording at the head commit: no compare, no warning', () => {
  assert.deepEqual(recordingWarnings(VIDEO + 'Recorded at `cf1281b8`\n', { head: HEAD, compare: NEVER }), []);
});

test('recording at the head commit, sha linked to the PR commit: no warning', () => {
  const body = VIDEO + 'Recorded at [`cf1281b8`](https://github.com/o/r/pull/1/commits/cf1281b8aaaa)\n';
  assert.deepEqual(recordingWarnings(body, { head: HEAD, compare: NEVER }), []);
});

test('older commit with only test, story and doc files changed: no warning', () => {
  const compare = files('src/a/card.test.tsx', 'src/a/card.stories.tsx', 'src/a/__tests__/x.ts', 'README.md');
  assert.deepEqual(recordingWarnings(RECORDED, { head: HEAD, compare }), []);
});

test('older commit with a UI file changed: warns naming both SHAs and the file', () => {
  const [warning, ...rest] = recordingWarnings(RECORDED, { head: HEAD, compare: files('src/stylesheets/trip-expert.css', 'src/a/card.test.tsx') });
  assert.equal(rest.length, 0);
  assert.match(warning, /a7f70ae8/);
  assert.match(warning, /cf1281b8/);
  assert.match(warning, /src\/stylesheets\/trip-expert\.css/);
  assert.doesNotMatch(warning, /card\.test/);
});

test('recording with no recorded-at SHA: warns', () => {
  assert.equal(recordingWarnings(VIDEO, { head: HEAD, compare: NEVER }).length, 1);
});

test('a natural caption counts as the recorded-at SHA', () => {
  const body = VIDEO + 'main on the left, this branch (`a7f70ae8`) on the right.\n';
  assert.deepEqual(recordedShas(body), ['a7f70ae8']);
  assert.equal(recordingWarnings(body, { head: HEAD, compare: files('src/x.tsx') }).length, 1);
});

test('a SHA that is not about the recording is ignored', () => {
  assert.deepEqual(recordedShas('prototype mlp/main 029c0bb; merge base `168067c2`\n'), []);
});

test('a failed compare warns instead of throwing', () => {
  const compare = () => { throw new Error('404 Not Found'); };
  assert.match(recordingWarnings(RECORDED, { head: HEAD, compare })[0], /could not list/);
});

test('a custom UI test replaces the default', () => {
  const isUi = (file) => file.endsWith('.css');
  assert.equal(recordingWarnings(RECORDED, { head: HEAD, compare: files('src/x.tsx'), isUi }).length, 0);
  assert.equal(recordingWarnings(RECORDED, { head: HEAD, compare: files('a.css'), isUi }).length, 1);
});

test('an image with no bold title line above it fails', () => {
  const out = findings('Notes.\n\n![grid](https://github.com/user-attachments/assets/0d1c2b3a-0000-4000-8000-000000000000)\n');
  assert.equal(out.length, 1);
  assert.match(out[0], /bold title/);
});

test('an <img> under a plain-text label fails', () => {
  assert.equal(findings('Most recent:\n<img width="641" src="https://github.com/user-attachments/assets/53df2f1d" />\n').length, 1);
});

test('a bold title on the line above an image passes, with or without a blank line', () => {
  assert.deepEqual(findings('**Next up card**\n![a](https://x.test/a.png)\n\n**Tiles**\n\n![b](https://x.test/b.png)\n'), []);
});

test('images in a table cell are titled by the column header', () => {
  assert.deepEqual(findings('| Before | After |\n| --- | --- |\n| ![b](https://x.test/b.png) | ![a](https://x.test/a.png) |\n'), []);
});

const VERIFICATION = '## Verification\n\n| Check | Result |\n| --- | --- |\n| `pnpm test` | 12 passed |\n';
const CANARY_PATCH = '@@ -45,7 +45,7 @@\n-    "@scope/components-compare": "4.19.0",\n+    "@scope/components-compare": "4.19.1-canary.41729367709-1.0.9abeb93",\n';

test('a Verification section without a Verified at line fails', () => {
  assert.equal(verificationFindings(VERIFICATION).length, 1);
});

test('a Verified at line at the head passes', () => {
  const body = VERIFICATION + '\nVerified at `10b01793`\n';
  assert.deepEqual(verifiedShas(body), ['10b01793']);
  assert.deepEqual(verificationFindings(body, { head: '10b01793c0a5', compare: () => ['src/a.ts'] }), []);
});

test('verification at an older commit fails once code changed since', () => {
  const body = VERIFICATION + '\nVerified at `8ad3edc1`\n';
  assert.equal(verificationFindings(body, { head: '10b01793c0a5', compare: () => ['tests/unit/a.spec.tsx'] }).length, 1);
});

test('verification at an older commit passes when only docs changed since', () => {
  const body = VERIFICATION + '\nVerified at `8ad3edc1`\n';
  assert.deepEqual(verificationFindings(body, { head: '10b01793c0a5', compare: () => ['README.md'] }), []);
});

test('a body with no Verification section is not asked for a sha', () => {
  assert.deepEqual(verificationFindings('Just a summary.\n'), []);
});

test('a canary pin on a non-draft PR with no Blocked on line fails twice', () => {
  assert.equal(canaryFindings('Summary.\n', { patches: CANARY_PATCH, isDraft: false }).length, 2);
});

test('a canary pin on a draft that says what it is blocked on passes', () => {
  assert.deepEqual(canaryFindings('Blocked on https://github.com/acme/widgets-web/pull/298\n', { patches: CANARY_PATCH, isDraft: true }), []);
});

test('removing a canary pin (a minus line) is not a pin', () => {
  assert.deepEqual(canaryFindings('', { patches: '-    "x": "1.0.0-canary.1"\n+    "x": "1.0.1"\n', isDraft: false }), []);
});

test('a component source change implies a visual change', () => {
  assert.deepEqual(impliedVisual('', ['packages/property-comparison/components/src/components/header.tsx', 'packages/x/test/header.test.tsx']), ['packages/property-comparison/components/src/components/header.tsx']);
});

test('a docs page change implies a visual change', () => {
  assert.equal(impliedVisual('', ['packages/property-comparison/components/docs/property-compare-card-v2.mdx']).length, 1);
});

test('tests and config alone do not imply a visual change', () => {
  assert.deepEqual(impliedVisual('', ['tests/unit/a.spec.tsx', 'package.json', 'src/a.test.ts']), []);
});

test('a stated reason turns the implied visual check off', () => {
  assert.deepEqual(impliedVisual('No visual change: renames an internal hook\n', ['src/hooks/use-x.ts']), []);
});

test('a dependency bump since the recorded commit counts as a UI change for the recording', () => {
  const body = 'Demo:\nhttps://github.com/user-attachments/assets/e78b568f-1fd9-436d-8807-bbfcbba2e2b3\nRecorded at `10b01793`\n';
  const warnings = recordingWarnings(body, { head: '5df3c207aa', compare: () => ['package.json', 'pnpm-lock.yaml'] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dependenc/);
});

test('a test-only change since the recorded commit does not stale the recording', () => {
  const body = 'Demo:\nhttps://github.com/user-attachments/assets/e78b568f-1fd9-436d-8807-bbfcbba2e2b3\nRecorded at `10b01793`\n';
  assert.deepEqual(recordingWarnings(body, { head: '5df3c207aa', compare: () => ['tests/unit/a.spec.tsx'] }), []);
});

const TEMPLATE = ':white_check_mark: **Checklist:**\n\n1.  [ ] Provide a link to an issue describing the feature or bug.\n5.  [ ] Call out any configuration or deployment effects of this change.\n';

test('checklist ticked as the template wrote it passes', () => {
  const body = '1.  [x] Provide a link to an issue describing the feature or bug.\n5.  [x] Call out any configuration or deployment effects of this change.\n';
  assert.deepEqual(checklistFindings(body, TEMPLATE), { problems: [], warnings: [] });
});

test('a note added after a template item fails', () => {
  const body = '5.  [x] Call out any configuration or deployment effects of this change. The geocode makes one billable request per name.\n';
  const { problems } = checklistFindings(body, TEMPLATE);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /geocode makes one billable/);
});

test('a checklist item the template does not have warns', () => {
  const { problems, warnings } = checklistFindings('- [x] Ran the perf gate\n', TEMPLATE);
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, 1);
});

test('no template, no checklist finding', () => {
  assert.deepEqual(checklistFindings('5.  [x] anything at all\n', null), { problems: [], warnings: [] });
});

test('coordinates, zoom levels and private trip links warn', () => {
  const body = 'centerWhenEmpty = {52.37304, 4.89237}\nThe camera ended at zoom 2.\nOpen ?conversationId=045a7416-809c-4a19-b327-3edb8bb5b594\n';
  assert.equal(noiseWarnings(body).length, 3);
});

test('bundle sizes and versions are not coordinates', () => {
  assert.deepEqual(noiseWarnings('`widgetPanel` 317.71 to 318.09 kB, widget 2.11.0\n'), []);
});

test('an unlinked commit sha warns and a linked one does not', () => {
  assert.equal(noiseWarnings('Recorded at `837dc843`.\n').length, 1);
  assert.deepEqual(noiseWarnings('Recorded at [`837dc843`](https://github.com/o/r/pull/1/commits/837dc843aa).\n'), []);
});

test('noise inside a code fence is ignored', () => {
  assert.deepEqual(noiseWarnings('```\nlat 52.37304, zoom 12, `837dc843`\n```\n'), []);
});

test('a claim of what the change does not touch warns without a merge-base diff, and passes with one', () => {
  const claim = 'This PR does not touch the checkout flow.\n';
  assert.equal(scopeClaimWarnings(claim).length, 1);
  assert.equal(scopeClaimWarnings('It only gates the banner.\n').length, 1);
  assert.deepEqual(scopeClaimWarnings(claim + '```\ngit diff --stat $(git merge-base origin/main HEAD)..HEAD\n```\n'), []);
});

test('a scope claim inside quotes or a code fence is not a claim', () => {
  assert.deepEqual(scopeClaimWarnings('The reviewer wrote "does not touch".\n```\nit does not touch x\n```\n'), []);
});

test('numbered items out of order warn, in order do not', () => {
  assert.equal(numberingWarnings('1. a\n2. b\n4. c\n3. d\n5. e\n').length, 1);
  assert.deepEqual(numberingWarnings('1. a\n2. b\n3. c\n'), []);
});

test('a numbered list restarts after a heading, and a nested list is its own', () => {
  assert.deepEqual(numberingWarnings('1. a\n2. b\n\n## Next\n1. c\n2. d\n'), []);
  assert.deepEqual(numberingWarnings('1. a\n   1. x\n   2. y\n2. b\n'), []);
});

test('takes and steps named in headings must increase', () => {
  assert.equal(numberingWarnings('**Take 1**\n\n**Take 3**\n\n**Take 2**\n').length, 1);
  assert.deepEqual(numberingWarnings('### Step 1\n### Step 2\n'), []);
});

test('a body past the word ceiling warns; tables, code and URLs do not count', () => {
  const prose = 'word '.repeat(460);
  assert.equal(shapeWarnings(prose).length, 1);
  assert.deepEqual(shapeWarnings('| ' + 'word '.repeat(600) + '|\n```\n' + 'word '.repeat(600) + '\n```\nhttps://example.com/' + 'a'.repeat(900) + '\n'), []);
  assert.equal(wordCount('one two\n```\nthree\n```\n'), 2);
});

test('sections out of the template order warn', () => {
  const template = '## Summary\n## Testing\n## Checklist\n';
  assert.equal(shapeWarnings('## Testing\nx\n## Summary\ny\n', template).length, 1);
  assert.deepEqual(shapeWarnings('## Summary\nx\n## Extra\n## Testing\ny\n', template), []);
});
