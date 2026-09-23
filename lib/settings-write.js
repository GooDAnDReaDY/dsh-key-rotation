// Settings writes from redacted browser views must never replace an entire
// namespace. Host-side mutate is atomic and rejects conflicts on both core eras.
export const SECRET_FIELDS = new Set(['webhookActionToken']);
const UNSAFE_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);

export function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertJson(value, depth = 0) {
  if (depth > 40) throw new TypeError('Configuration is nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertJson(item, depth + 1); return; }
  if (plainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_FIELDS.has(key)) throw new TypeError('Unsafe configuration field');
      assertJson(child, depth + 1);
    }
    return;
  }
  throw new TypeError('Configuration must contain finite JSON-compatible values');
}

export function sectionOps(section, { preserveEmptySecrets = false } = {}) {
  if (!plainObject(section)) throw new TypeError('Expected a configuration object');
  assertJson(section);
  if (Object.hasOwn(section, 'providers')) validateProviders(section.providers);
  return Object.entries(section)
    .filter(([key, value]) => !(preserveEmptySecrets && SECRET_FIELDS.has(key) && (value === '' || value === null)))
    .map(([key, value]) => ({ op: 'set', path: [key], value }));
}

export function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length > 1000) throw new TypeError('Expected at most 1000 field operations');
  for (const op of ops) {
    if (!plainObject(op) || !['set', 'unset'].includes(op.op) || !Array.isArray(op.path)
      || !op.path.length || op.path.length > 40
      || op.path.some(part => typeof part !== 'string' || !part || UNSAFE_FIELDS.has(part))) {
      throw new TypeError('Expected set/unset operations with non-empty, safe field paths');
    }
    if (op.op === 'set') {
      assertJson(op.value);
      if (op.path.length === 1 && op.path[0] === 'providers') validateProviders(op.value);
    }
  }
  return ops;
}

export function requireRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('A non-negative expectedRevision from the latest read is required');
  return revision;
}

export async function mutateSettings(settings, ns, ops, expectedRevision) {
  validateOps(ops);
  requireRevision(expectedRevision);
  if (typeof settings?.mutate !== 'function') throw new Error('This host does not provide atomic field mutation');
  // Do not retry with replace or drop the revision fence after a refusal.
  await settings.mutate(ns, ops, expectedRevision);
}

export function validateProviders(providers) {
  if (!Array.isArray(providers)) throw new TypeError('Expected an array of provider key pools');
  assertJson(providers);
  const names = new Set();
  for (const provider of providers) {
    if (!plainObject(provider) || typeof provider.provider !== 'string' || !provider.provider.trim()
      || names.has(provider.provider) || !Array.isArray(provider.keys) || new Set(provider.keys).size !== provider.keys.length || provider.keys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
      throw new TypeError('Each provider must have a unique name and valid, unique credential reference names');
    }
    names.add(provider.provider);
  }
  return providers;
}
