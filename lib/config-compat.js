// Decode modern volatile Config references while retaining stable identities for
// the request hot path. Legacy cores pass ordinary resolved configuration.
// If ctx is provided, invalidation listeners cache the unwrapped tree so the hot
// path never recursively walks volatile nodes on unchanged configuration.
export function createConfigReader(config, ctx) {
  let previous;
  let dirty = true;
  if (ctx && typeof ctx.on === 'function') {
    const markDirty = () => { dirty = true; };
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.on('settings/document-updated', markDirty));
      ctx.effect(() => ctx.on('loader/volatile-update', markDirty));
      ctx.effect(() => ctx.on('config', markDirty));
    } else {
      ctx.on('settings/document-updated', markDirty);
      ctx.on('loader/volatile-update', markDirty);
      ctx.on('config', markDirty);
    }
  }

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

  return () => {
    if (ctx && !dirty && previous !== undefined) {
      return previous;
    }
    previous = read(config, previous);
    dirty = false;
    return previous;
  };
}

// Modern settings owns descriptors rather than the removed get(namespace) API.
// Cache by document invalidation; clone-producing describe() and tree-materializing
// settings.get() on 0.1.7+ must not execute on every request.
export function createProviderProfilesReader(ctx, namespace) {
  let dirty = true, held = null, owner;
  const markDirty = () => { dirty = true; };
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => ctx.on('settings/document-updated', markDirty));
  } else if (typeof ctx?.on === 'function') {
    ctx.on('settings/document-updated', markDirty);
  }

  return () => {
    const settings = ctx?.get?.('settings');
    if (settings !== owner) { owner = settings; dirty = true; }
    if (!settings) return null;
    if (dirty) {
      if (typeof settings.get === 'function') {
        try {
          held = settings.get(namespace)?.providers ?? null;
          dirty = false;
        } catch (_) {
          held = null;
          dirty = false;
        }
      } else {
        try {
          held = settings.describe({ redactSecrets: true }).find(row => row.ns === namespace)?.value?.providers ?? null;
          dirty = false;
        } catch (_) {
          held = null;
          dirty = false;
        }
      }
    }
    return held;
  };
}
