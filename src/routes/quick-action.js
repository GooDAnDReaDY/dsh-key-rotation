import { getWebServer } from './guard.js';
import { json, readJson, isTrustedBridgeRequest } from '../http-bridge.js';
import { QUICK_ACTION_PATH } from './paths.js';
import { keyTail, isKeyPaused } from '../pool.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerQuickActionRoutes(ctx, deps) {
  const { buildRuntime, pushEvent, circuitBreaker } = deps;

  ctx.effect(() => getWebServer(ctx).register({
    kind: 'exact',
    path: QUICK_ACTION_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { error: { code: 'method', message: 'POST only' } });
        return;
      }
      if (!isTrustedBridgeRequest(req)) {
        json(res, 403, { error: { code: 'forbidden', message: 'dsh-key-rotation: quick-action is local-only' } });
        return;
      }

      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } });
        return;
      }

      const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : '';
      const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
      const ref = typeof body?.ref === 'string' ? body.ref.trim() : null;

      if (!action || !['skip', 'reset', 'pause'].includes(action)) {
        json(res, 400, { error: { code: 'invalid-action', message: 'action must be skip, reset, or pause' } });
        return;
      }

      if (!provider) {
        json(res, 400, { error: { code: 'missing-provider', message: 'provider is required' } });
        return;
      }

      const runtime = buildRuntime();
      let targetPool = null;

      const pools = runtime.pools ?? Array.from(runtime.poolByRef?.values() || []);
      for (const pool of pools) {
        if (pool.provider === provider || pool.base === provider) {
          targetPool = pool;
          break;
        }
      }

      if (!targetPool) {
        json(res, 404, { error: { code: 'pool-not-found', message: `Pool not found for provider: ${provider}` } });
        return;
      }

      if (action === 'skip') {
        const total = targetPool.refs?.length || 0;
        if (total === 0) {
          json(res, 400, { error: { code: 'no-keys', message: 'Pool has no keys to rotate' } });
          return;
        }
        const currentPointer = targetPool.state.pointer ?? targetPool.state.cursor ?? 0;
        const nextPointer = (currentPointer + 1) % total;
        targetPool.state.pointer = nextPointer;
        targetPool.state.cursor = nextPointer;
        const nextRef = targetPool.refs[nextPointer];
        targetPool.state.lastUsed = nextRef;

        if (typeof pushEvent === 'function') {
          pushEvent(targetPool, nextRef, 'QUICK_ACTION_SKIP', 0);
        }

        json(res, 200, {
          ok: true,
          action: 'skip',
          provider,
          cursor: nextPointer,
          activeRef: nextRef,
          activeTail: keyTail(nextRef),
        });
        return;
      }

      if (action === 'reset') {
        targetPool.state.failedUntil?.clear();
        targetPool.state.failCounts?.clear();
        targetPool.state.resetReasons?.clear();
        targetPool.state.headerResetTimes?.clear();
        targetPool.state.switches = 0;
        targetPool.state.lastReason = null;

        const breaker = circuitBreaker ?? runtime.breaker;
        if (breaker) {
          if (typeof breaker.reset === 'function') breaker.reset(provider);
          else if (typeof breaker.onSuccess === 'function') breaker.onSuccess(provider);
        }

        if (typeof pushEvent === 'function') {
          pushEvent(targetPool, '*', 'QUICK_ACTION_RESET', 0);
        }

        json(res, 200, {
          ok: true,
          action: 'reset',
          provider,
          healthyKeys: targetPool.refs?.length || 0,
        });
        return;
      }

      if (action === 'pause') {
        const targetRef = ref || targetPool.state.lastUsed || targetPool.refs?.[0];
        if (!targetRef) {
          json(res, 400, { error: { code: 'no-ref', message: 'No key specified or active in pool' } });
          return;
        }

        let isPaused = false;
        if (!targetPool.state.pausedRefs) targetPool.state.pausedRefs = new Set();

        if (targetPool.state.pausedRefs instanceof Set) {
          if (targetPool.state.pausedRefs.has(targetRef)) {
            targetPool.state.pausedRefs.delete(targetRef);
            targetPool.state.pauseReasons?.delete(targetRef);
            isPaused = false;
          } else {
            targetPool.state.pausedRefs.add(targetRef);
            if (!targetPool.state.pauseReasons) targetPool.state.pauseReasons = new Map();
            targetPool.state.pauseReasons.set(targetRef, 'MANUAL_QUICK_PAUSED');
            isPaused = true;
          }
        } else if (Array.isArray(targetPool.state.pausedRefs)) {
          const idx = targetPool.state.pausedRefs.indexOf(targetRef);
          if (idx >= 0) {
            targetPool.state.pausedRefs.splice(idx, 1);
            targetPool.state.pauseReasons?.delete(targetRef);
            isPaused = false;
          } else {
            targetPool.state.pausedRefs.push(targetRef);
            if (!targetPool.state.pauseReasons) targetPool.state.pauseReasons = new Map();
            targetPool.state.pauseReasons.set(targetRef, 'MANUAL_QUICK_PAUSED');
            isPaused = true;
          }
        }

        if (typeof pushEvent === 'function') {
          pushEvent(targetPool, targetRef, isPaused ? 'KEY_PAUSED' : 'KEY_RESUMED', 0);
        }

        json(res, 200, {
          ok: true,
          action: 'pause',
          provider,
          ref: targetRef,
          paused: isPaused,
        });
        return;
      }
    },
  }));
}
