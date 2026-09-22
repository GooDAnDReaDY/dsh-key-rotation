// heal.js — self-healing idle cooldowns.
// ponytail: pure function, easy to test, no side effects beyond mutation of passed-in state.

// Returns array of { ref, poolBase } entries that were healed in this tick.
// Mutates `pools` (removes from failedUntil, pushes heal event into events).
// `now` parameter is injectable for tests.
export function healIdleCooldowns(pools, idleMs, now = Date.now()) {
  if (!Array.isArray(pools) || pools.length === 0) return [];
  if (!Number.isFinite(idleMs) || idleMs <= 0) return [];
  const healed = [];
  for (const pool of pools) {
    if (!pool || !pool.state || !pool.base) continue;
    const fu = pool.state.failedUntil;
    const lua = pool.state.lastUsedAt ?? pool.state.lastUsed;
    if (!fu || fu.size === 0) continue;
    const expiredRefs = [];
    for (const [ref, until] of fu.entries()) {
      if (!Number.isFinite(until)) continue;
      if (until > now) continue; // cooldown still active
      const last = typeof lua?.get === 'function' ? lua.get(ref) : undefined;
      if (!Number.isFinite(last)) continue; // never used → no signal, skip
      if (now - last < idleMs) continue; // used recently → don't heal
      expiredRefs.push(ref);
    }
    for (const ref of expiredRefs) {
      fu.delete(ref);
      if (Array.isArray(pool.state.events)) {
        pool.state.events.push({ at: now, ref, reason: 'self-heal', cooldownMs: 0, type: 'heal' });
        if (pool.state.events.length > 50) pool.state.events.shift();
      }
      healed.push({ ref, poolBase: pool.base });
    }
  }
  return healed;
}

/**
 * Background auto-recovery for keys in brokenUntil status.
 * Tests broken keys with a lightweight free probe (e.g. probeModels).
 * If the probe succeeds, clears broken and failure states and records a 'heal' event.
 *
 * @param {Array} pools
 * @param {Function} probeFn async (ref) => { ok: boolean, code?: string, status?: number }
 * @param {number} [now=Date.now()]
 * @param {{ isActive?: () => boolean }} [options] lifecycle guard for delayed results
 * @returns {Promise<Array<{ ref: string, poolBase: string, ok: boolean }>>}
 */
export async function autoUnbreakBrokenKeys(pools, probeFn, now = Date.now(), { isActive = () => true } = {}) {
  if (!Array.isArray(pools) || pools.length === 0 || typeof probeFn !== 'function') return [];
  const results = [];
  for (const pool of pools) {
    if (!pool || !pool.state || !pool.base) continue;
    const bu = pool.state.brokenUntil;
    if (!bu || bu.size === 0) continue;
    const brokenRefs = [];
    for (const [ref, until] of bu.entries()) {
      if (Number.isFinite(until) && until > now) {
        brokenRefs.push(ref);
      }
    }
    for (const ref of brokenRefs) {
      if (!isActive()) return results;
      const state = pool.state;
      const fields = ['brokenUntil', 'failedUntil', 'failCounts', 'authFailCounts'];
      const observed = fields.map(field => [field, state[field], state[field]?.get(ref)]);
      // An earlier await may have removed this key from the captured worklist.
      if (state.brokenUntil !== bu || !bu.has(ref)) continue;
      try {
        const res = await probeFn(ref);
        if (!isActive()) return results;
        // Do not let a late success erase a newer failure or replaced state.
        if (pool.state !== state || observed.some(([field, map, value]) =>
          state[field] !== map || map?.get(ref) !== value)) continue;
        if (res && res.ok) {
          bu.delete(ref);
          pool.state.failedUntil?.delete(ref);
          pool.state.failCounts?.delete(ref);
          pool.state.authFailCounts?.delete(ref);
          if (Array.isArray(pool.state.events)) {
            pool.state.events.push({ at: now, ref, reason: 'auto-unbreak', cooldownMs: 0, type: 'heal' });
            if (pool.state.events.length > 50) pool.state.events.shift();
          }
          results.push({ ref, poolBase: pool.base, ok: true });
        } else {
          results.push({ ref, poolBase: pool.base, ok: false });
        }
      } catch (_) {
        results.push({ ref, poolBase: pool.base, ok: false });
      }
    }
  }
  return results;
}
