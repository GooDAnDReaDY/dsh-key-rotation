// Decode modern volatile Config references while retaining stable identities for
// the request hot path. Legacy cores pass ordinary resolved configuration.
export function createConfigReader(config) {
  let previous;
  const read = (value, held) => {
    if (value && typeof value.get === 'function') value = value.get();
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    const next = Array.isArray(value) ? [] : {};
    let same = held && typeof held === 'object' && Array.isArray(value) === Array.isArray(held)
      && keys.length === Object.keys(held).length;
    for (const key of keys) {
      Object.defineProperty(next, key, { value: read(value[key], held?.[key]), writable: true, enumerable: true, configurable: true });
      if (!held || !Object.hasOwn(held, key) || !Object.is(next[key], held[key])) same = false;
    }
    return same ? held : next;
  };
  return () => (previous = read(config, previous));
}

// Modern settings owns descriptors rather than the removed get(namespace) API.
// Cache by document invalidation; clone-producing describe() must not rebuild
// every key pool on every request.
export function createProviderProfilesReader(ctx, namespace) {
  let dirty = true, held = null, owner;
  ctx.effect(() => ctx.on('settings/document-updated', () => { dirty = true; }));
  return () => {
    const settings = ctx.get('settings');
    if (settings !== owner) { owner = settings; dirty = true; }
    if (!settings) return null;
    if (typeof settings.get === 'function') {
      try { return settings.get(namespace)?.providers ?? null; } catch (_) { return null; }
    }
    if (dirty) {
      try {
        held = settings.describe({ redactSecrets: true }).find(row => row.ns === namespace)?.value?.providers ?? null;
        dirty = false;
      } catch (_) { held = null; }
    }
    return held;
  };
}
