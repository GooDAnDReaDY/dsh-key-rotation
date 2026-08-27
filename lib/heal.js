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
    const lu = pool.state.lastUsed;
    if (!fu || fu.size === 0) continue;
    const expiredRefs = [];
    for (const [ref, until] of fu.entries()) {
      if (!Number.isFinite(until)) continue;
      if (until > now) continue; // cooldown still active
      const last = lu ? lu.get(ref) : undefined;
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
