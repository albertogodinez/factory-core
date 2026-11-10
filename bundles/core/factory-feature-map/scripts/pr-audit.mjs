import path from 'node:path';

// Anchored files are not the only thing a PR can orphan, but these are the files whose absence from
// the map is noise: tests, stories, fixtures, generated output, and anything that is not source.
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const NOISE = /(?:\.(?:test|spec|stories|story|generated)\.|(?:^|\/)(?:__tests__|__mocks__|__snapshots__|__generated__|fixtures?|mocks?|tests?|e2e|cypress|\.storybook)\/|\.d\.ts$)/;

const dirOf = (file) => path.posix.dirname(file);
const within = (dir, file) => file === dir || file.startsWith(`${dir}/`);

/**
 * @param {{repo: string, changes: {status: string, path: string, previousPath?: string}[],
 *   entries: {id: string, file: string, code: {repo: string, path: string, symbols?: string[]}[], tests?: {repo: string, path: string}[]}[],
 *   readHead?: (path: string) => string | null}} input
 */
export function auditChanges({ repo, changes, entries, readHead }) {
  const anchors = entries.flatMap((entry) =>
    [...entry.code.map((a) => ({ ...a, kind: 'code' })), ...(entry.tests ?? []).map((a) => ({ ...a, kind: 'test' }))]
      .filter((a) => a.repo === repo)
      .map((a) => ({ ...a, entry })),
  );
  const anchoredPaths = new Set(anchors.map((a) => a.path));
  const anchorsStylesheets = anchors.some((a) => /\.(?:css|scss|less)$/.test(a.path));
  const errors = [];
  const warnings = [];
  const touched = new Map();
  const touch = (anchor, change) => {
    const hit = touched.get(anchor.entry.id) ?? { feature: anchor.entry.id, file: anchor.entry.file, paths: new Set() };
    hit.paths.add(change.path);
    touched.set(anchor.entry.id, hit);
  };

  for (const change of changes) {
    const gone = change.status === 'removed' ? change.path : change.status === 'renamed' ? change.previousPath : null;
    if (gone) {
      for (const anchor of anchors.filter((a) => a.path === gone)) {
        touch(anchor, change);
        const how = change.status === 'removed' ? 'deletes' : `renames it to ${change.path}`;
        errors.push({ feature: anchor.entry.id, file: anchor.entry.file, anchor: gone, message: `PR ${how}; ${anchor.kind} anchor breaks after merge` });
      }
      for (const anchor of anchors.filter((a) => a.path !== gone && within(a.path, gone))) touch(anchor, change);
    }
    if (change.status === 'removed') continue;

    for (const anchor of anchors.filter((a) => within(a.path, change.path))) {
      touch(anchor, change);
      if (change.status !== 'modified' && change.status !== 'renamed') continue;
      if (!readHead || !anchor.symbols?.length || anchor.path !== change.path) continue;
      const text = readHead(change.path);
      if (text === null) continue;
      for (const symbol of anchor.symbols.filter((s) => !text.includes(s))) {
        errors.push({ feature: anchor.entry.id, file: anchor.entry.file, anchor: anchor.path, message: `PR removes symbol "${symbol}" from the anchored file; anchor breaks after merge` });
      }
    }

    if (anchoredPaths.has(change.path)) continue;
    const isStylesheet = /\.(?:css|scss|less)$/.test(change.path);
    if (NOISE.test(change.path) || !(SOURCE_EXT.test(change.path) || (isStylesheet && anchorsStylesheets))) continue;
    const near = anchors.filter((a) => a.kind === 'code' && (dirOf(a.path) === dirOf(change.path) || within(a.path, change.path)));
    if (near.length === 0) continue;
    const features = [...new Set(near.map((a) => a.entry.id))];
    for (const anchor of near) touch(anchor, change);
    warnings.push({ path: change.path, status: change.status, features, message: `unanchored ${change.status} file, near ${features.join(', ')}` });
  }

  return {
    errors,
    warnings,
    touched: [...touched.values()].map(({ feature, file, paths }) => ({ feature, file, paths: [...paths].sort() })),
  };
}

export function parseNameStatus(text) {
  const kind = { A: 'added', M: 'modified', D: 'removed', T: 'modified', C: 'added' };
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, first, second] = line.split('\t');
      if (code.startsWith('R')) return { status: 'renamed', path: second, previousPath: first };
      return { status: kind[code[0]] ?? 'modified', path: first };
    });
}

export function fromGithubFiles(files) {
  return files.map((file) => {
    if (file.status === 'renamed') return { status: 'renamed', path: file.filename, previousPath: file.previous_filename };
    if (file.status === 'removed') return { status: 'removed', path: file.filename };
    return { status: file.status === 'added' || file.status === 'copied' ? 'added' : 'modified', path: file.filename };
  });
}
