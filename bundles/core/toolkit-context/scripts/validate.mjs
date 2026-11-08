#!/usr/bin/env node
// Checks a .ai-toolkit/project.json against schemas/project.schema.json.
// A small JSON Schema subset (type, const, enum, pattern, minLength, required,
// properties, additionalProperties, items, $ref to #/$defs, oneOf), enough for
// the schemas this skill ships. node: imports only.
// Usage: validate.mjs [path/to/project.json]   (default: ./.ai-toolkit/project.json)
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (want, v) => {
  const t = typeOf(v);
  return [].concat(want).some((w) => w === t || (w === 'number' && t === 'integer'));
};

export function validate(schema, data, root = schema, at = '') {
  const errs = [];
  const err = (m) => errs.push(`${at || '/'}: ${m}`);
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    if (!m || !root.$defs?.[m[1]]) return [`${at || '/'}: unresolvable $ref ${schema.$ref}`];
    return validate(root.$defs[m[1]], data, root, at);
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(s, data, root, at).length === 0).length;
    if (ok !== 1) err(`must match exactly one of ${schema.oneOf.length} shapes (matched ${ok})`);
    return errs;
  }
  if ('const' in schema && data !== schema.const) err(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(data)) err(`must be one of ${schema.enum.join(', ')}`);
  if (schema.type && !typeOk(schema.type, data)) { err(`must be ${[].concat(schema.type).join(' or ')}`); return errs; }
  if (typeof data === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) err(`must not be empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) err(`must match ${schema.pattern}`);
  }
  if (Array.isArray(data) && schema.items) data.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${at}/${i}`)));
  if (typeOf(data) === 'object') {
    for (const k of schema.required || []) if (!(k in data)) err(`missing required "${k}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(data)) {
      if (props[k]) errs.push(...validate(props[k], v, root, `${at}/${k}`));
      else if (schema.additionalProperties === false) err(`unknown property "${k}"`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, root, `${at}/${k}`));
    }
  }
  return errs;
}

export function loadSchema() {
  return JSON.parse(readFileSync(new URL('../schemas/project.schema.json', import.meta.url), 'utf8'));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const file = resolve(process.argv[2] || '.ai-toolkit/project.json');
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    console.error(`validate: cannot read ${file}: ${e.message}`); process.exit(2);
  }
  const errs = validate(loadSchema(), data);
  if (errs.length) { for (const e of errs) console.error(`${file} ${e}`); process.exit(1); }
  console.log(`validate: ${file} ok`);
}
