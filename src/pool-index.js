// lib/pool-index.js — which pool owns a credential ref for a given request.
//
// One credential ref can legitimately live in several pools at once:
//
//   anthropic::claude-sonnet  -> CLAUDE_KEY_A, CLAUDE_KEY_B
//   anthropic::claude-opus    -> CLAUDE_KEY_A, CLAUDE_KEY_B
//
// A single `Map<ref, pool>` therefore cannot answer "which pool is this request
// using?" — the last pool written wins and every other model pool becomes
// invisible. The runtime keeps instead:
//
//   allPools          Map<poolBase, pool>      every pool, base and per-model
//   basePoolByRef     Map<ref, basePool>       provider-base ownership only
//   modelPoolsByProvider Map<provider, Map<model, pool>>
//   modelPoolByRef    Map<ref, Set<modelPool>> every model pool a ref appears in
//
// `poolByRef` still exists for single-pool compatibility lookups, but it is no
// longer the enumeration source for persistence, status, health or sweeps.

/** Provider id of a pool base (`anthropic::claude-opus` -> `anthropic`). */
export function providerOfBase(base) {
  if (typeof base !== 'string') return '';
  const at = base.indexOf('::');
  return at === -1 ? base : base.slice(0, at);
}

/**
 * Build an empty index. Call `addProvider()` once per configured provider.
 * @returns {object} index consumed by `resolveRefPool()` / `allPools()`
 */
export function createPoolIndex() {
  const index = {
    // Complete pool inventory, keyed by pool base, so no pool is ever lost to
    // a ref collision. Iterate `allPools`, never `poolByRef`, to enumerate.
    allPools: new Map(),
    basePoolByRef: new Map(),
    modelPoolsByProvider: new Map(),
    modelPoolByRef: new Map(),
    basePoolByProvider: new Map(),
  };
  return index;
}

/** Register one provider's base pool and its `model -> pool` sub-pools. */
export function addProviderPools(index, provider, basePool, modelPools) {
  if (basePool) {
    index.allPools.set(basePool.base, basePool);
    index.basePoolByProvider.set(provider, basePool);
    for (const ref of basePool.refs) {
      if (!index.basePoolByRef.has(ref)) index.basePoolByRef.set(ref, basePool);
    }
  }
  if (!modelPools || modelPools.size === 0) return;
  index.modelPoolsByProvider.set(provider, modelPools);
  for (const pool of modelPools.values()) {
    index.allPools.set(pool.base, pool);
    for (const ref of pool.refs) {
      let set = index.modelPoolByRef.get(ref);
      if (!set) { set = new Set(); index.modelPoolByRef.set(ref, set); }
      set.add(pool);
    }
  }
}

/** Every pool of the index, deduplicated by base. */
export function allPools(index) {
  return [...index.allPools.values()];
}

/** Provider-base pool for a pool of any depth (base pool returns itself). */
export function basePoolOf(index, pool) {
  if (!pool) return null;
  if (!pool.model) return pool;
  return index.basePoolByProvider.get(pool.provider) ?? pool;
}

/** The provider-base pool that a pool base belongs to, or null. */
export function basePoolForBase(index, base) {
  const own = index.allPools.get(base);
  if (!own) return null;
  return basePoolOf(index, own);
}

/**
 * Pool that owns `ref` for the request currently being dispatched.
 *
 * `requested` is the request-scoped pool chosen for this LLM call (set by
 * rotate() in the dispatch AsyncLocalStorage). It is authoritative: a Sonnet
 * request must rotate inside the Sonnet pool even when the incoming ref is the
 * provider profile's original `apiKeyEnv`, because replacing that key with the
 * model-specific key pool is the entire point of a model sub-pool.
 *
 * The one thing a request-scoped pool must not do is hijack an unrelated
 * credential resolved during the same request, so substitution is limited to
 * refs that belong to this pool or to its provider-base pool:
 *
 *   ref in requested.refs            -> requested  (already a model-pool key)
 *   ref in provider base pool refs   -> requested  (substitute the model pool)
 *   provider has no base pool        -> requested  (model pool is the only source)
 *   anything else                    -> null       (plain original resolve)
 *
 * With no request-scoped pool (ordinary `credentials.resolve()` outside
 * rotation) the global lookup runs, preferring the provider-base pool.
 *
 * @param {object} index result of createPoolIndex()
 * @param {string} ref credential ref being resolved
 * @param {object|null|undefined} requested request-scoped pool
 * @returns {object|null} pool to rotate within, or null to use the original resolve
 */
export function resolveRefPool(index, ref, requested) {
  if (typeof ref !== 'string' || ref.length === 0) return null;
  if (requested) {
    if (Array.isArray(requested.refs) && requested.refs.includes(ref)) return requested;
    if (!requested.model) return null;
    const base = index.basePoolByProvider.get(requested.provider);
    if (!base) return requested;
    return base.refs.includes(ref) ? requested : null;
  }
  const base = index.basePoolByRef.get(ref);
  if (base) return base;
  const set = index.modelPoolByRef.get(ref);
  return set && set.size > 0 ? set.values().next().value : null;
}

/**
 * True when the resolver may still rotate for this ref even though every
 * candidate is locally out of budget. Quota enforcement is fail-closed only for
 * requests this plugin actually manages; an ordinary `credentials.resolve()`
 * outside rotation keeps its historical behaviour.
 */
export function isQuotaManagedRequest(index, ref, requested) {
  if (!requested) return false;
  return resolveRefPool(index, ref, requested) === requested;
}

/**
 * Model pools a ref appears in. Used by ops routes to describe one credential
 * across the models it serves without guessing from the pool base string.
 */
export function modelPoolsForRef(index, ref) {
  const set = index.modelPoolByRef.get(ref);
  return set ? [...set] : [];
}
