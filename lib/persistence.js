// lib/persistence.js — atomic snapshot of rotation state across restarts (#287).
// Cooldowns, circuit-breaker entries and quota counters live in memory; a DSH
// reload would otherwise forget cooldowns and stampede recovered keys.

import path from 'node:path';
import { initializePoolState, hasPoolActivity } from './pool-state.js';
import { atomicWriteJson, safeReadJson } from './atomic-io.js';

const DEFAULT_FILE = 'dsh-key-rotation-state.json';
const SAVE_DEBOUNCE_MS = 400;

/**
 * @param {{ filePath: string, now?: () => number }} opts
 */
export class StatePersistence {
  constructor({ filePath, now = Date.now } = {}) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('StatePersistence: filePath is required');
    }
    this.filePath = filePath;
    this._now = now;
    this._timer = null;
    this._dirty = false;
    this._lastWrite = 0;
  }

  /** Build a plain snapshot from live maps/objects. */
  static serialize({ poolState, circuitSnapshot, quotaSnapshot }) {
    const pools = {};
    if (poolState && typeof poolState.forEach === 'function') {
      poolState.forEach((st, base) => {
        const failedUntil = {};
        if (st && st.failedUntil && typeof st.failedUntil.forEach === 'function') {
          st.failedUntil.forEach((until, ref) => {
            if (Number.isFinite(until)) failedUntil[ref] = until;
            else if (until === Infinity) failedUntil[ref] = 'Infinity';
          });
        }
        const revokedRefs = [];
        if (st && st.revokedRefs) {
          if (typeof st.revokedRefs.forEach === 'function') {
            st.revokedRefs.forEach((r) => revokedRefs.push(r));
          } else if (Array.isArray(st.revokedRefs)) {
            revokedRefs.push(...st.revokedRefs);
          }
        }
        const tokenUsage = {};
        if (st && st.tokenUsage && typeof st.tokenUsage.forEach === 'function') {
          st.tokenUsage.forEach((entry, ref) => {
            const used = Number(entry?.used);
            const resetAt = Number(entry?.resetAt);
            if (!Number.isFinite(used) || used < 0) return;
            if (!Number.isFinite(resetAt) || resetAt <= 0) return;
            tokenUsage[ref] = { used: Math.floor(used), resetAt: Math.floor(resetAt) };
          });
        }
        const costDays = {};
        if (st?.costDays) {
          const src = st.costDays instanceof Map ? Object.fromEntries(st.costDays) : st.costDays;
          if (typeof src === 'object' && src !== null) Object.assign(costDays, src);
        }
        const costPerKey = {};
        if (st?.costPerKey) {
          const src = st.costPerKey instanceof Map ? Object.fromEntries(st.costPerKey) : st.costPerKey;
          if (typeof src === 'object' && src !== null) Object.assign(costPerKey, src);
        }
        const usageDays = {};
        if (st?.usageDays) {
          const src = st.usageDays instanceof Map ? Object.fromEntries(st.usageDays) : st.usageDays;
          if (typeof src === 'object' && src !== null) Object.assign(usageDays, src);
        }
        const usageCounts = {};
        if (st?.usageCounts instanceof Map) {
          st.usageCounts.forEach((cnt, ref) => {
            if (Number.isFinite(cnt)) usageCounts[ref] = cnt;
          });
        }
        const outPool = {
          failedUntil,
          pointer: Number.isFinite(st?.pointer) ? st.pointer : 0,
          lastUsed: typeof st?.lastUsed === 'string' ? st.lastUsed : null,
        };
        if (revokedRefs.length > 0) outPool.revokedRefs = revokedRefs;
        if (Object.keys(tokenUsage).length > 0) outPool.tokenUsage = tokenUsage;
        if (Object.keys(costDays).length > 0) outPool.costDays = costDays;
        if (Object.keys(costPerKey).length > 0) outPool.costPerKey = costPerKey;
        if (Object.keys(usageDays).length > 0) outPool.usageDays = usageDays;
        if (Object.keys(usageCounts).length > 0) outPool.usageCounts = usageCounts;
        pools[base] = outPool;
      });
    }
    return {
      version: 1,
      savedAt: Date.now(),
      pools,
      circuit: circuitSnapshot && typeof circuitSnapshot === 'object' ? circuitSnapshot : {},
      quota: quotaSnapshot && typeof quotaSnapshot === 'object' ? quotaSnapshot : {},
    };
  }

  _nowSafe() {
    const n = Number(this._now?.() ?? Date.now());
    return Number.isFinite(n) ? n : Date.now();
  }

  /**
   * Schedule a debounced atomic write. Never throws to the caller.
   * @param {object} payload result of StatePersistence.serialize
   */
  save(payload) {
    this._pending = payload;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  async flush() {
    if (!this._dirty || !this._pending) return false;
    const payload = this._pending;
    this._dirty = false;
    this._pending = null;
    try {
      await atomicWriteJson(this.filePath, payload);
      this._lastWrite = this._nowSafe();
      return true;
    } catch {
      // Keep previous good file; mark dirty so a later save retries.
      this._dirty = true;
      this._pending = this._pending || payload;
      return false;
    }
  }

  /**
   * Load a snapshot. Corrupt/missing file → null (never wipes memory).
   * @returns {Promise<object|null>}
   */
  async load() {
    const raw = await safeReadJson(this.filePath, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.version !== 1 && raw.version !== 2) return null;
    return raw;
  }

  /** Restore poolState Map from a loaded snapshot. */
  static restorePools(poolState, snapshot) {
    if (!poolState || !snapshot?.pools || typeof snapshot.pools !== 'object' || Array.isArray(snapshot.pools)) return 0;
    let n = 0;
    for (const [base, saved] of Object.entries(snapshot.pools)) {
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      const existing = poolState.get(base);
      const state = initializePoolState(existing);
      // Never replace objects retained by buildRuntime(), nor roll back a pool
      // already used while the asynchronous load was in flight.
      if (!existing || !hasPoolActivity(state)) {
        if (saved.failedUntil && typeof saved.failedUntil === 'object' && !Array.isArray(saved.failedUntil)) {
          for (const [ref, until] of Object.entries(saved.failedUntil)) {
            if (until === 'Infinity' || until === Infinity) {
              state.failedUntil.set(ref, Infinity);
            } else if (Number.isFinite(until)) {
              state.failedUntil.set(ref, until);
            }
          }
        }
        if (Array.isArray(saved.revokedRefs)) {
          if (!state.revokedRefs) state.revokedRefs = new Set();
          for (const r of saved.revokedRefs) {
            if (typeof r === 'string') state.revokedRefs.add(r);
          }
        }
        if (saved.tokenUsage && typeof saved.tokenUsage === 'object' && !Array.isArray(saved.tokenUsage)) {
          for (const [ref, entry] of Object.entries(saved.tokenUsage)) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const used = Number(entry.used);
            const resetAt = Number(entry.resetAt);
            if (!Number.isFinite(used) || used < 0) continue;
            if (!Number.isFinite(resetAt) || resetAt <= 0) continue;
            state.tokenUsage.set(ref, { used: Math.floor(used), resetAt: Math.floor(resetAt) });
          }
        }
        if (saved.costDays && typeof saved.costDays === 'object') {
          if (!state.costDays) state.costDays = new Map();
          for (const [day, cost] of Object.entries(saved.costDays)) {
            if (Number.isFinite(cost)) state.costDays.set(day, cost);
          }
        }
        if (saved.costPerKey && typeof saved.costPerKey === 'object') {
          if (!state.costPerKey) state.costPerKey = new Map();
          for (const [k, c] of Object.entries(saved.costPerKey)) {
            if (Number.isFinite(c)) state.costPerKey.set(k, c);
          }
        }
        if (saved.usageDays && typeof saved.usageDays === 'object') {
          if (!state.usageDays) state.usageDays = new Map();
          for (const [d, u] of Object.entries(saved.usageDays)) {
            if (Number.isFinite(u)) state.usageDays.set(d, u);
          }
        }
        if (saved.usageCounts && typeof saved.usageCounts === 'object') {
          if (!state.usageCounts) state.usageCounts = new Map();
          for (const [k, cnt] of Object.entries(saved.usageCounts)) {
            if (Number.isFinite(cnt)) state.usageCounts.set(k, cnt);
          }
        }
        state.pointer = Number.isSafeInteger(saved.pointer) && saved.pointer >= 0 ? saved.pointer : 0;
        state.lastUsed = typeof saved.lastUsed === 'string' ? saved.lastUsed : null;
      }
      poolState.set(base, state);
      n += 1;
    }
    return n;
  }

  dispose() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

/**
 * Resolve the on-disk state path. Prefer an explicit config path; otherwise
 * place the file under `dataDir` when the host provides one. Returns null when
 * persistence cannot be enabled safely (no writable data directory).
 */
export function resolveStatePath({ dataDir, configuredPath } = {}) {
  if (configuredPath && typeof configuredPath === 'string' && configuredPath.trim()) {
    return configuredPath.trim();
  }
  if (dataDir && typeof dataDir === 'string' && dataDir.trim()) {
    return path.join(dataDir.trim(), DEFAULT_FILE);
  }
  return null;
}

export default StatePersistence;
