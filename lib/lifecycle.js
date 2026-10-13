// lib/lifecycle.js — background timers and lifecycle effects
import { healIdleCooldowns, autoUnbreakBrokenKeys } from './heal.js';
import { decryptSecret } from './crypto-storage.js';
import { StatePersistence, resolveStatePath } from './persistence.js';
import path from 'node:path';
import { envValue } from './pool.js';
import { clearAllDraining } from './key-drain.js';

export function setupIdleHealEffect(ctx, getConfig, buildRuntime, timers = globalThis) {
  return ctx.effect(() => {
    // Keep the cheap scheduler alive so a disabled-at-start preference can be
    // enabled later without restarting the plugin.
    const timer = timers.setInterval(() => {
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
    return () => timers.clearInterval(timer);
  }, 'dsh-key-rotation: self-healing idle');
}

export function setupAutoUnbreakEffect(ctx, getConfig, buildRuntime, ensureSandboxRunner, logger, timers = globalThis) {
  return ctx.effect(() => {
    let timer, intervalMs;
    let running = false;
    let disposed = false;
    const isActive = () => !disposed && (getConfig()?.selfHealingIntervalMinutes ?? 0) > 0;
    const run = async () => {
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
          const raw = typeof hit?.value === 'string' && hit.value.length > 0
            ? hit.value : envValue(ref);
          if (typeof raw === 'string' && raw.startsWith('enc:v1:')) {
            const decrypted = decryptSecret(raw);
            if (!decrypted || decrypted === raw || decrypted.startsWith('enc:v1:')) {
              logger?.warn?.(`[dsh-key-rotation] auto-unbreak: key ${ref} cannot be decrypted (missing or invalid DSH_KEY_SECRET); skipping unbreak probe`);
              return { ok: false };
            }
          }
          const value = raw ? decryptSecret(raw) : raw;
          if (!value || typeof value !== 'string' || value.startsWith('enc:v1:') || !isActive()) return { ok: false };
          return runner.probeModels(ref, value);
        }, Date.now(), { isActive });
      } catch (e) { logger?.warn?.('[dsh-key-rotation] auto-unbreak failed', e); }
      finally { running = false; }
    };
    const configure = () => {
      if (disposed) return;
      const minutes = getConfig()?.selfHealingIntervalMinutes ?? 30;
      const next = Number.isFinite(minutes) && minutes > 0
        ? Math.max(1000, Math.min(2147483647, minutes * 60000)) : 0;
      if (next === intervalMs) return;
      if (timer !== undefined) timers.clearInterval(timer);
      intervalMs = next;
      timer = next ? timers.setInterval(run, next) : undefined;
      timer?.unref?.();
    };
    const changed = () => queueMicrotask(configure);
    const off = [
      typeof ctx?.on === 'function' ? ctx.on('settings/document-updated', changed) : () => {},
      typeof ctx?.on === 'function' ? ctx.on('loader/volatile-update', changed) : () => {},
    ];
    configure();
    return () => { disposed = true; if (timer !== undefined) timers.clearInterval(timer); for (const stop of off) stop(); };

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



export function setupProactiveHealthProbeEffect(ctx, getConfig, buildRuntime, ensureSandboxRunner, logger, timers = globalThis) {
  return ctx.effect(() => {
    let timer;
    let running = false;
    let disposed = false;

    const run = async () => {
      if (running || disposed) return;
      running = true;
      try {
        const c = getConfig();
        if (!c || c.proactiveHealthProbing !== true) return;
        const { pools } = buildRuntime();
        const runner = ensureSandboxRunner(ctx);
        const now = Date.now();
        for (const pool of (pools || [])) {
          if (!pool || !pool.state) continue;
          const fu = pool.state.failedUntil;
          const bu = pool.state.brokenUntil;
          const candidates = new Set();
          if (fu) {
            for (const [ref, until] of fu.entries()) {
              if (until > now && until !== Infinity) candidates.add(ref);
            }
          }
          if (bu) {
            for (const [ref, until] of bu.entries()) {
              if (until > now) candidates.add(ref);
            }
          }
          for (const ref of candidates) {
            if (disposed) break;
            try {
              const credentials = ctx.get?.('credentials') ?? ctx.credentials;
              const resolve = credentials?.__dshKeyRotationOriginalResolve ?? credentials?.resolve;
              const hit = await resolve?.call(credentials, ref);
              const raw = typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : envValue(ref);
              const val = raw ? decryptSecret(raw) : raw;
              if (!val || typeof val !== 'string' || val.startsWith('enc:v1:')) continue;
              const res = await runner.probeModels(ref, val);
              if (res && res.ok) {
                pool.state.failedUntil?.delete(ref);
                pool.state.brokenUntil?.delete(ref);
                pool.state.failCounts?.delete(ref);
                if (Array.isArray(pool.state.events)) {
                  pool.state.events.push({ at: Date.now(), ref, reason: 'proactive-probe-heal', cooldownMs: 0, type: 'heal' });
                  if (pool.state.events.length > 50) pool.state.events.shift();
                }
                logger?.warn?.(`[dsh-key-rotation] proactive-probe: restored key ${ref} in pool ${pool.base}`);
              }
            } catch (err) {
              logger?.debug?.(`[dsh-key-rotation] proactive-probe failed for ${ref}: ${err?.message || err}`);
            }
          }
        }
      } catch (e) {
        logger?.warn?.('[dsh-key-rotation] proactive probe failed', e);
      } finally {
        running = false;
      }
    };

    const configure = () => {
      if (disposed) return;
      const c = getConfig();
      const intervalMs = (c && Number.isFinite(c.proactiveProbeIntervalMs) && c.proactiveProbeIntervalMs >= 1000)
        ? c.proactiveProbeIntervalMs : 60000;
      if (timer !== undefined) timers.clearInterval(timer);
      if (c?.proactiveHealthProbing === true) {
        timer = timers.setInterval(run, intervalMs);
        timer?.unref?.();
      }
    };

    const changed = () => queueMicrotask(configure);
    const off = [
      typeof ctx?.on === 'function' ? ctx.on('settings/document-updated', changed) : () => {},
      typeof ctx?.on === 'function' ? ctx.on('loader/volatile-update', changed) : () => {},
    ];
    configure();
    return () => {
      disposed = true;
      if (timer !== undefined) timers.clearInterval(timer);
      for (const stop of off) stop();
    };
  }, 'dsh-key-rotation: proactive health probing');
}

export function setupKeyDrainEffect(ctx) {
  return ctx.effect(() => {
    return () => {
      clearAllDraining();
    };
  }, 'dsh-key-rotation: clear draining keys on teardown');
}
