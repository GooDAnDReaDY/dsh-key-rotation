// lib/region.js — region tag + failover helper.
// ponytail: simple — providers declare an optional 'region' (string).
// When the primary provider hits exhaustion AND a same-region fallback is
// configured, the plugin picks that as next fallback.

export const REGION_NONE = '';
export const REGION_GLOBAL = 'global';

export class RegionMap {
  constructor() {
    this._byProvider = new Map(); // provider id -> region
  }

  set(provider, region = REGION_GLOBAL) {
    if (!provider) return;
    if (!region) region = REGION_GLOBAL;
    this._byProvider.set(provider, region);
  }

  get(provider) {
    return this._byProvider.get(provider) || REGION_GLOBAL;
  }

  // Pick a fallback for `provider`. Returns another provider in the same
  // region if available; otherwise null. Returns null for unknown providers
  // (we don't know their region -> conservative).
  pickFallback(provider) {
    if (!this._byProvider.has(provider)) return null;
    const region = this.get(provider);
    for (const [p, r] of this._byProvider) {
      if (p === provider) continue;
      if (r === region) return p;
    }
    return null;
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._byProvider) out[k] = v;
    return out;
  }

  clear() {
    this._byProvider.clear();
  }

  get size() {
    return this._byProvider.size;
  }
}
