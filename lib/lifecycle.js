// lib/lifecycle.js — background timers and lifecycle effects
import { healIdleCooldowns, autoUnbreakBrokenKeys } from './heal.js';
import { StatePersistence, resolveStatePath } from './persistence.js';
import path from 'node:path';
import { envValue } from './pool.js';

export function setupIdleHealEffect(ctx, getConfig, buildRuntime) {
  return ctx.effect(() => {
    const cfg = getConfig();
    if (!cfg || cfg.selfHealCooldown === false) return () => {};
    const timer = setInterval(() => {
      try {
        const c = getConfig();
        if (!c || c.selfHealCooldown === false) return;
        const idle = Number.isFinite(c.selfHealIdleMs) && c.selfHealIdleMs > 0 ? c.selfHealIdleMs : 3600000;
        const providers = Array.isArray(c.providers) ? c.providers : [];
        const pools = providers
          .map((p) => buildRuntime().providerToPool.get(p.provider))
          .filter(Boolean);
        healIdleCooldowns(pools, idle);
      } catch (_) { /* ponytail: never crash the timer */ }
    }, 60000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'dsh-key-rotation: self-healing idle');
}

export function setupAutoUnbreakEffect(ctx, getConfig, buildRuntime, ensureSandboxRunner, logger) {
  return ctx.effect(() => {
    const cfg = getConfig();
    const intervalMin = cfg?.selfHealingIntervalMinutes ?? 30;
    if (!intervalMin || intervalMin <= 0) return () => {};
    const intervalMs = intervalMin * 60 * 1000;
    let running = false;
    let disposed = false;
    const isActive = () => !disposed && (getConfig()?.selfHealingIntervalMinutes ?? 0) > 0;
    const timer = setInterval(async () => {
      if (running || disposed) return;
      running = true;
      try {
        const c = getConfig();
        if (!c || !c.selfHealingIntervalMinutes || c.selfHealingIntervalMinutes <= 0) return;
        const { pools } = buildRuntime();
        const runner = ensureSandboxRunner(ctx);
        await autoUnbreakBrokenKeys(pools, async (ref) => {
          // A rotating resolver can substitute a healthy neighbor for this
          // quarantined ref, falsely proving that the broken key recovered.
          const credentials = ctx.get?.('credentials') ?? ctx.credentials;
          const resolve = credentials?.__dshKeyRotationOriginalResolve ?? credentials?.resolve;
          const hit = await resolve?.call(credentials, ref);
          const value = typeof hit?.value === 'string' && hit.value.length > 0
            ? hit.value : envValue(ref);
          if (!value || !isActive()) return { ok: false };
          return runner.probeModels(ref, value);
        }, Date.now(), { isActive });
      } catch (e) { logger?.warn?.('[dsh-key-rotation] auto-unbreak failed', e); }
      finally { running = false; }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => { disposed = true; clearInterval(timer); };
  }, 'dsh-key-rotation: auto-unbreak');
}

export function setupPersistence(ctx, { cfg0, poolState, moduleBreaker, verboseLoggingOn, logger }) {
  let statePersistence = null;
  try {
    const hostDirs = [
      process.env.DSH_HOME,
      process.cwd(),
    ].filter((d) => typeof d === 'string' && d.length > 0);
    const resolvedPath = resolveStatePath({
      configuredPath: cfg0.persistencePath,
      dataDir: hostDirs[0],
    });
    if (cfg0.persistenceEnabled !== false && resolvedPath) {
      statePersistence = new StatePersistence({ filePath: resolvedPath });
      statePersistence.load().then((snap) => {
        if (!snap) return;
        try {
          StatePersistence.restorePools(poolState, snap);
          if (moduleBreaker && snap.circuit) moduleBreaker.restore(snap.circuit, { preserveExisting: true });
          if (verboseLoggingOn?.()) {
            logger?.warn?.(`[dsh-key-rotation] restored ${Object.keys(snap.pools ?? {}).length} pool state(s) from ${path.basename(resolvedPath)}`);
          }
        } catch (e) {
          logger?.warn?.('[dsh-key-rotation] persistence restore failed', e?.message ?? e);
        }
      }).catch(() => {});
    } else if (cfg0.persistenceEnabled !== false && !resolvedPath) {
      logger?.warn?.('[dsh-key-rotation] persistence disabled: no data directory');
    }
  } catch (e) {
    logger?.warn?.('[dsh-key-rotation] persistence init failed', e?.message ?? e);
  }

  function persistenceSnapshot() {
    if (!statePersistence) return null;
    return StatePersistence.serialize({
      poolState,
      circuitSnapshot: moduleBreaker ? moduleBreaker.snapshot() : {},
      quotaSnapshot: {},
    });
  }

  function schedulePersist() {
    if (!statePersistence) return;
    const snap = persistenceSnapshot();
    if (snap) statePersistence.save(snap);
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      try { schedulePersist(); }
      catch (e) { logger?.warn?.('[dsh-key-rotation] periodic persist failed', e); }
    }, 15000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      clearInterval(timer);
      try {
        if (statePersistence) {
          const snap = persistenceSnapshot();
          if (snap) {
            statePersistence.save(snap);
            void statePersistence.flush();
          }
          statePersistence.dispose();
        }
      } catch (e) {
        logger?.warn?.('[dsh-key-rotation] dispose persist failed', e);
      }
    };
  }, 'dsh-key-rotation: state persistence');

  return { schedulePersist, persistenceSnapshot };
}
