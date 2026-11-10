// A small JSON Schema checker for the schemas this skill ships. It supports
// type, enum, const, pattern, minLength, minItems, uniqueItems, items, properties,
// required, additionalProperties, anyOf and local $ref ("#/definitions/...").
export function validate(value, schema) {
  const errors = [];
  check(value, schema, schema, '', errors);
  return errors;
}

function resolveRef(schema, root) {
  if (!schema.$ref) return schema;
  if (!schema.$ref.startsWith('#/')) throw new Error(`unsupported schema reference ${schema.$ref}`);
  return schema.$ref.slice(2).split('/').reduce((v, k) => v[k], root);
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function check(value, rawSchema, root, at, errors) {
  const schema = resolveRef(rawSchema, root);
  const here = at || '(root)';
  if (schema.anyOf) {
    const ok = schema.anyOf.some((c) => {
      const sub = [];
      check(value, c, root, at, sub);
      return sub.length === 0;
    });
    if (!ok) errors.push(`${here}: does not match any allowed shape`);
    return;
  }
  const types = schema.type === undefined ? null : [].concat(schema.type);
  const actual = typeOf(value);
  if (types && !types.some((t) => (t === 'integer' ? Number.isInteger(value) : t === actual))) {
    errors.push(`${here}: expected ${types.join(' or ')}`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${here}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${here}: expected one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${here}: must not be empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${here}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${here}: needs at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${here}: items must be unique`);
    if (schema.items) value.forEach((item, i) => check(item, schema.items, root, `${at}[${i}]`, errors));
  }
  if (actual === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}.${key}: required`);
    for (const [key, child] of Object.entries(value)) {
      const sub = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      if (sub) check(child, sub, root, `${at}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unexpected property`);
    }
  }
}
