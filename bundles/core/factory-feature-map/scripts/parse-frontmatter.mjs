// Frontmatter parser for feature entries. It reads the YAML subset entries use:
// maps, block lists, lists of maps, inline [a, b] lists, plain and quoted scalars.
// Anything else is reported as an error against a file line instead of thrown.

const KEY_LINE = /^(\s*(?:-\s+)?)([\w-]+):[ \t]+(.*)$/;
const KEY_RE = /^([\w.$-]+):(?:[ \t]+(.*)|[ \t]*)$/;

class YamlError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

/** The frontmatter block's lines with their 1-based file line numbers. */
function frontmatterLines(raw) {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return lines.slice(1, end === -1 ? lines.length : end).map((text, i) => ({ text, line: i + 2 }));
}

/** True when a value that opens with a quote does not close it on the same line. */
function opensUnclosedQuote(value) {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return false;
  const rest = value.slice(1);
  if (quote === "'") return !rest.replace(/''/g, '').includes("'");
  return !/(^|[^\\])"/.test(rest);
}

// A value written as `key: #…` parses as empty, because YAML reads ` #` as a comment.
function commentValueWarnings(raw) {
  return frontmatterLines(raw).flatMap(({ text, line }) => {
    const match = KEY_LINE.exec(text);
    if (!match || !match[3].startsWith('#')) return [];
    const key = match[2];
    return [`frontmatter line ${line}: the value of "${key}" starts with "#", which YAML reads as a comment, so "${key}" is empty. Quote it (${key}: "${match[3].slice(0, 30)}")`];
  });
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[,]/.test(text[i - 1]))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function quoted(text, line) {
  const quote = text[0];
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === '\\') {
      const n = text[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else if (quote === "'" && c === "'" && text[i + 1] === "'") {
      out += "'";
      i++;
    } else if (c === quote) {
      if (text.slice(i + 1).trim()) throw new YamlError('unexpected text after a closing quote', line);
      return out;
    } else out += c;
  }
  throw new YamlError('a quoted value is never closed', line);
}

function scalar(text, line) {
  const t = text.trim();
  if (t === '') return null;
  if (t[0] === '"' || t[0] === "'") return quoted(t, line);
  if (t[0] === '{') throw new YamlError('flow maps are not supported; use a block map', line);
  if (t[0] === '|' || t[0] === '>') throw new YamlError('block scalars are not supported; use a quoted one-line value', line);
  if (t.includes(': ') || t.endsWith(':')) throw new YamlError('mapping values are not allowed in a plain value', line);
  if (t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

function flowList(text, line) {
  const t = text.trim();
  if (!t.endsWith(']')) throw new YamlError('a [ list is never closed on its line', line);
  const inner = t.slice(1, -1);
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') cur += inner[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quote) throw new YamlError('a quoted value is never closed', line);
  if (cur.trim() || items.length) items.push(cur);
  return items.filter((s, i) => s.trim() || i < items.length - 1).map((s) => scalar(s, line));
}

function value(text, line) {
  const t = stripComment(text).trim();
  return t.startsWith('[') ? flowList(t, line) : scalar(t, line);
}

function parseYaml(lines) {
  const rows = lines
    .map(({ text, line }) => ({ line, indent: text.length - text.trimStart().length, text: text.trim() }))
    .filter((r) => r.text && !r.text.startsWith('#'));
  let pos = 0;

  function block(indent) {
    if (pos >= rows.length) return null;
    return rows[pos].text.startsWith('- ') || rows[pos].text === '-' ? list(rows[pos].indent) : map(rows[pos].indent);
  }

  function list(indent) {
    const out = [];
    while (pos < rows.length && rows[pos].indent === indent && (rows[pos].text.startsWith('- ') || rows[pos].text === '-')) {
      const row = rows[pos];
      const rest = row.text.slice(1).trim();
      if (!rest) {
        pos++;
        out.push(pos < rows.length && rows[pos].indent > indent ? block(rows[pos].indent) : null);
      } else if (KEY_RE.test(stripComment(rest))) {
        // `- key: value` opens a map whose later keys sit two columns in.
        const offset = row.text.indexOf(rest);
        rows[pos] = { line: row.line, indent: indent + offset, text: rest };
        out.push(map(indent + offset));
      } else {
        pos++;
        out.push(value(rest, row.line));
      }
    }
    return out;
  }

  function map(indent) {
    const out = {};
    while (pos < rows.length && rows[pos].indent === indent && !rows[pos].text.startsWith('- ')) {
      const row = rows[pos];
      const m = KEY_RE.exec(stripComment(row.text));
      if (!m) throw new YamlError('expected "key: value"', row.line);
      pos++;
      const rest = (m[2] ?? '').trim();
      if (rest) out[m[1]] = value(rest, row.line);
      else if (pos < rows.length && rows[pos].indent > indent) out[m[1]] = block(rows[pos].indent);
      else if (pos < rows.length && rows[pos].indent === indent && rows[pos].text.startsWith('- ')) out[m[1]] = list(indent);
      else out[m[1]] = null;
    }
    if (pos < rows.length && rows[pos].indent > indent) throw new YamlError('unexpected indentation', rows[pos].line);
    return out;
  }

  if (rows.length === 0) return {};
  const result = block(rows[0].indent);
  if (pos < rows.length) throw new YamlError('unexpected indentation', rows[pos].line);
  return result;
}

/** @returns {{data: object, content: string, warnings: string[]} | {error: string}} */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') throw new TypeError('parseFrontmatter takes the file text');
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return { data: {}, content: raw, warnings: [] };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { error: 'frontmatter is not valid YAML at unknown line: the closing --- is missing' };
  const content = lines.slice(end + 1).join('\n');
  try {
    const data = parseYaml(frontmatterLines(raw));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new YamlError('frontmatter must be a map', 2);
    return { data, content, warnings: commentValueWarnings(raw) };
  } catch (error) {
    if (!(error instanceof YamlError)) throw error;
    let { line } = error;
    let reason = error.message;
    // Point at the line that opened an unclosed quote, not where parsing gave up.
    if (/quoted value is never closed/.test(reason)) {
      const opener = frontmatterLines(raw).find(({ text }) => { const m = KEY_LINE.exec(text); return m && opensUnclosedQuote(m[3]); });
      if (opener) line = opener.line;
    }
    const source = line ? lines[line - 1]?.trim() : null;
    const where = line ? `line ${line}${source ? ` (\`${source.slice(0, 80)}\`)` : ''}` : 'unknown line';
    return {
      error: `frontmatter is not valid YAML at ${where}: ${reason}. Quote any value that contains ": " or starts with a quote, "#", "[" or "{" (role: "the steps: fare, seats")`,
    };
  }
}
