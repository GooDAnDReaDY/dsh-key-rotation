import { getWebServer } from './guard.js';
// lib/ops-balance.js — operational HTTP routes for balance inspection (#495).

import {
  json,
  readJson,
} from '../http-bridge.js';
import {
  isTrustedBridgeRequest,
  isValidRef,
} from '../pool.js';
import { BALANCE_PATH } from './paths.js';
import { inspectBalanceForRef } from '../balance-inspector.js';
import { pushEvent } from '../notify-events.js';

export function registerBalanceRoutes(ctx, deps) {
  const {
    poolState,
    buildRuntime,
  } = deps;

  ctx.effect(() => getWebServer(ctx).register({
    kind: 'exact',
    path: BALANCE_PATH,
    handler: async (req, res) => {
      if (!isTrustedBridgeRequest(req)) {
        json(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }

      const urlObj = new URL(req.url, 'http://127.0.0.1');

      // GET: Query single key or provider cached balances
      if (req.method === 'GET') {
        const ref = urlObj.searchParams.get('ref');
        const provider = urlObj.searchParams.get('provider');

        if (ref) {
          const runtime = buildRuntime();
          const targetPool = provider ? runtime.pools?.find((p) => p.provider === provider) : null;
          const pool = targetPool ?? runtime.poolByRef?.get(ref);
          const cached = pool?.state?.balances?.get(ref) ?? null;

          if (urlObj.searchParams.get('refresh') === 'true' && provider) {
            const inspectRes = await inspectBalanceForRef(ctx, ref, provider);
            if (inspectRes.ok) {
              if (pool && pool.state) {
                if (!pool.state.balances) pool.state.balances = new Map();
                pool.state.balances.set(ref, { ...inspectRes, at: Date.now() });

                // Check soft pause
                applyBalanceState(pool, ref, inspectRes);
              }
              json(res, 200, { ok: true, ref, balance: inspectRes });
              return;
            }
            json(res, 200, { ok: false, ref, error: inspectRes.error, cached });
            return;
          }

          json(res, 200, { ok: true, ref, balance: cached });
          return;
        }

        // Return all cached balances
        const out = {};
        if (poolState && typeof poolState.forEach === 'function') {
          poolState.forEach((st, provName) => {
            if (st && st.balances instanceof Map) {
              for (const [k, v] of st.balances) {
                out[k] = v;
              }
            }
          });
        }
        json(res, 200, { ok: true, balances: out });
        return;
      }

      // POST: Trigger refresh of balances for a provider or key list
      if (req.method === 'POST') {
        const body = await readJson(req);
        const provider = body?.provider;
        const ref = body?.ref;
        const testValue = body?.value;

        if (ref && provider) {
          const inspectRes = await inspectBalanceForRef(ctx, ref, provider, { testValue });
          const runtime = buildRuntime();
          const pool = runtime.pools?.find((p) => p.provider === provider) ?? runtime.poolByRef?.get(ref);

          if (inspectRes.ok && pool && pool.state) {
            if (!pool.state.balances) pool.state.balances = new Map();
            pool.state.balances.set(ref, { ...inspectRes, at: Date.now() });
            applyBalanceState(pool, ref, inspectRes);
          }

          json(res, inspectRes.ok ? 200 : 400, { ok: inspectRes.ok, ref, balance: inspectRes });
          return;
        }

        if (provider) {
          const runtime = buildRuntime();
          const pool = runtime.pools?.find((p) => p.provider === provider);
          if (!pool || !Array.isArray(pool.refs) || pool.refs.length === 0) {
            json(res, 404, { ok: false, error: `Provider '${provider}' not found or has no keys` });
            return;
          }

          const results = {};
          for (const kRef of pool.refs) {
            const r = await inspectBalanceForRef(ctx, kRef, provider);
            results[kRef] = r;
            if (r.ok && pool.state) {
              if (!pool.state.balances) pool.state.balances = new Map();
              pool.state.balances.set(kRef, { ...r, at: Date.now() });
              applyBalanceState(pool, kRef, r);
            }
          }
          json(res, 200, { ok: true, provider, balances: results });
          return;
        }

        json(res, 400, { ok: false, error: 'ref or provider required' });
        return;
      }

      json(res, 405, { ok: false, error: 'Method Not Allowed' });
    },
  }), 'dsh-key-rotation: balance routes');
}

function applyBalanceState(pool, ref, balanceRes) {
  if (!pool || !pool.state) return;
  const isZero = balanceRes.isAvailable === false || (typeof balanceRes.total === 'number' && balanceRes.total <= 0);

  if (isZero) {
    if (!pool.state.pausedRefs) pool.state.pausedRefs = new Set();
    if (pool.state.pausedRefs instanceof Set) pool.state.pausedRefs.add(ref);
    if (!pool.state.pauseReasons) pool.state.pauseReasons = new Map();
    pool.state.pauseReasons.set(ref, 'EMPTY_BALANCE_PAUSED');
    pushEvent(pool, ref, 'BALANCE_EMPTY', 0);
  } else if (pool.state.pauseReasons?.get?.(ref) === 'EMPTY_BALANCE_PAUSED') {
    if (pool.state.pausedRefs instanceof Set) pool.state.pausedRefs.delete(ref);
    pool.state.pauseReasons.delete(ref);
    pushEvent(pool, ref, 'BALANCE_RESTORED', 0);
  }
}
