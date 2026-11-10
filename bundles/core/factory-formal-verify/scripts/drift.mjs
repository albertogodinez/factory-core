// Pure parts of check-drift.mjs: validate a coverage record, match a change list to covered code.
// Mirrors ../schemas/coverage.schema.json by hand so the check runs on bare node.

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{40}$/;

const isText = (v) => typeof v === 'string' && v.length > 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function extraKeys(obj, allowed, at, errors) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) errors.push(`${at}: unknown key "${key}"`);
}

function checkCover(c, at, errors) {
  if (!isObject(c)) return errors.push(`${at}: must be an object`);
  extraKeys(c, ['path', 'symbols', 'role'], at, errors);
  if (!isText(c.path)) errors.push(`${at}.path: required`);
  else if (/:\d+/.test(c.path)) errors.push(`${at}.path: no line numbers`);
  if (c.symbols !== undefined && !(Array.isArray(c.symbols) && c.symbols.every(isText))) errors.push(`${at}.symbols: list of strings`);
  if (c.role !== undefined && typeof c.role !== 'string') errors.push(`${at}.role: string`);
}

function checkFinding(f, at, errors) {
  if (!isObject(f)) return errors.push(`${at}: must be an object`);
  extraKeys(f, ['id', 'status', 'replay'], at, errors);
  if (!ID.test(typeof f.id === 'string' ? f.id : '')) errors.push(`${at}.id: kebab-case id required`);
  if (!['open', 'fixed'].includes(f.status)) errors.push(`${at}.status: open or fixed`);
  if (f.replay !== undefined && !isText(f.replay)) errors.push(`${at}.replay: string`);
}

function checkCheck(check, at, errors) {
  if (!isObject(check)) return errors.push(`${at}: must be an object`);
  extraKeys(check, ['id', 'property', 'rule', 'model', 'config', 'view', 'covers', 'findings'], at, errors);
  if (!ID.test(typeof check.id === 'string' ? check.id : '')) errors.push(`${at}.id: kebab-case id required`);
  for (const key of ['property', 'rule', 'model', 'config']) if (!isText(check[key])) errors.push(`${at}.${key}: required`);
  if (check.view !== undefined && !isText(check.view)) errors.push(`${at}.view: string`);
  if (!Array.isArray(check.covers) || check.covers.length === 0) errors.push(`${at}.covers: at least one covered path`);
  else check.covers.forEach((c, j) => checkCover(c, `${at}.covers[${j}]`, errors));
  if (check.findings !== undefined) {
    if (!Array.isArray(check.findings)) errors.push(`${at}.findings: list`);
    else check.findings.forEach((f, j) => checkFinding(f, `${at}.findings[${j}]`, errors));
  }
}

/** Errors in a parsed coverage.json, each naming where; empty when it matches the schema. */
export function validateCoverage(cov) {
  if (!isObject(cov)) return ['coverage.json is not an object'];
  const errors = [];
  extraKeys(cov, ['repo', 'syncCommit', 'checks'], 'coverage', errors);
  if (!isText(cov.repo)) errors.push('repo: required');
  if (!SHA.test(typeof cov.syncCommit === 'string' ? cov.syncCommit : '')) errors.push('syncCommit: must be a full 40-character sha');
  if (!Array.isArray(cov.checks) || cov.checks.length === 0) errors.push('checks: at least one check');
  else cov.checks.forEach((check, i) => checkCheck(check, `checks[${i}]`, errors));
  return errors;
}

/** Every covered path in a record, once. */
export function coveredPaths(cov) {
  return [...new Set(cov.checks.flatMap((c) => c.covers.map((x) => x.path.replace(/\/$/, ''))))];
}

const under = (file, covered) => file === covered || file.startsWith(`${covered}/`);

/** The checks whose covered code a change list touches, with the files that touch each. */
export function touchedChecks(cov, changedFiles) {
  return cov.checks
    .map((check) => ({
      id: check.id,
      property: check.property,
      files: changedFiles.filter((f) => check.covers.some((c) => under(f, c.path.replace(/\/$/, '')))),
    }))
    .filter((t) => t.files.length > 0);
}

/** Covered symbols missing from trunk. `read(path)` returns the text at trunk, or null when the path is gone. */
export function missingSymbols(cov, read) {
  const out = [];
  for (const check of cov.checks) {
    for (const c of check.covers) {
      const text = read(c.path);
      if (text === null) {
        out.push({ check: check.id, path: c.path, symbol: null });
        continue;
      }
      for (const s of c.symbols ?? []) if (!text.includes(s)) out.push({ check: check.id, path: c.path, symbol: s });
    }
  }
  return out;
}
