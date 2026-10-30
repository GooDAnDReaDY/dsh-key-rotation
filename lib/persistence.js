// lib/persistence.js — atomic snapshot and append-only event journal (#287, #525).
// Cooldowns, circuit-breaker entries and quota counters live in memory; an append-only
// journal records incremental events without rewriting the entire state tree on disk.

import path from 'node:path';
import fs from 'node:fs';
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
    this.journalPath = filePath.endsWith('.json')
      ? filePath.slice(0, -5) + '-journal.jsonl'
      : `${filePath}.jsonl`;
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
        const pausedRefs = [];
        if (st && st.pausedRefs) {
          if (typeof st.pausedRefs.forEach === 'function') {
            st.pausedRefs.forEach((r) => pausedRefs.push(r));
          } else if (Array.isArray(st.pausedRefs)) {
            pausedRefs.push(...st.pausedRefs);
          }
        }
        const pauseReasons = {};
        if (st && st.pauseReasons && typeof st.pauseReasons.forEach === 'function') {
          st.pauseReasons.forEach((reason, ref) => {
            if (typeof reason === 'string') pauseReasons[ref] = reason;
          });
        }
        const modelCapabilities = {};
        if (st && st.modelCapabilities && typeof st.modelCapabilities.forEach === 'function') {
          st.modelCapabilities.forEach((caps, ref) => {
            if (caps && typeof caps.forEach === 'function') {
              const arr = [];
              caps.forEach((m) => { if (typeof m === 'string') arr.push(m); });
              if (arr.length > 0) modelCapabilities[ref] = arr;
            } else if (Array.isArray(caps) && caps.length > 0) {
              modelCapabilities[ref] = caps.filter((m) => typeof m === 'string');
            }
          });
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
          const entries = st.costDays instanceof Map ? st.costDays.entries() : Object.entries(st.costDays);
          for (const [k, val] of entries) {
            if (!val) continue;
            if (val instanceof Map || (typeof val === 'object' && !Array.isArray(val))) {
              const innerObj = {};
              const innerEntries = val instanceof Map ? val.entries() : Object.entries(val);
              for (const [day, c] of innerEntries) {
                const num = Number(c);
                if (Number.isFinite(num) && num >= 0) innerObj[day] = num;
              }
              if (Object.keys(innerObj).length > 0) costDays[k] = innerObj;
            } else if (Number.isFinite(Number(val))) {
              const num = Number(val);
              if (num >= 0) costDays[k] = num;
            }
          }
        }
        const costPerKey = {};
        if (st?.costPerKey) {
          const src = st.costPerKey instanceof Map ? Object.fromEntries(st.costPerKey) : st.costPerKey;
          if (typeof src === 'object' && src !== null) Object.assign(costPerKey, src);
        }
        const usageDays = {};
        if (st?.usageDays) {
          const entries = st.usageDays instanceof Map ? st.usageDays.entries() : Object.entries(st.usageDays);
          for (const [k, val] of entries) {
            if (!val) continue;
            if (val instanceof Map || (typeof val === 'object' && !Array.isArray(val))) {
              const innerObj = {};
              const innerEntries = val instanceof Map ? val.entries() : Object.entries(val);
              for (const [day, count] of innerEntries) {
                const num = Number(count);
                if (Number.isFinite(num) && num >= 0) innerObj[day] = Math.floor(num);
              }
              if (Object.keys(innerObj).length > 0) usageDays[k] = innerObj;
            } else if (Number.isFinite(Number(val))) {
              const num = Number(val);
              if (num >= 0) usageDays[k] = Math.floor(num);
            }
          }
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
        if (pausedRefs.length > 0) outPool.pausedRefs = pausedRefs;
        if (Object.keys(pauseReasons).length > 0) outPool.pauseReasons = pauseReasons;
        if (Object.keys(modelCapabilities).length > 0) outPool.modelCapabilities = modelCapabilities;
        const balances = {};
        if (st && st.balances && typeof st.balances.forEach === 'function') {
          st.balances.forEach((bal, ref) => {
            if (bal && typeof bal === 'object') balances[ref] = bal;
          });
        }
        if (Object.keys(balances).length > 0) outPool.balances = balances;
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
   * Append-only event journaling (#525). Records incremental event without full state rewrite.
   * @param {object} event
   */
  async appendEvent(event) {
    if (!event || typeof event !== 'object') return false;
    const line = JSON.stringify({ ...event, at: event.at ?? this._nowSafe() }) + '\n';
    try {
      await fs.promises.appendFile(this.journalPath, line, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Schedule a debounced atomic snapshot write. Never throws to the caller.
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
      try {
        await fs.promises.writeFile(this.journalPath, '', 'utf-8');
      } catch {}
      return true;
    } catch {
      this._dirty = true;
      this._pending = this._pending || payload;
      return false;
    }
  }

  /**
   * Load snapshot and replay any journaled events (#525).
   * @returns {Promise<object|null>}
   */
  async load() {
    const raw = await safeReadJson(this.filePath, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.version !== 1 && raw.version !== 2) return null;

    if (fs.existsSync(this.journalPath)) {
      try {
        const content = await fs.promises.readFile(this.journalPath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            try { this.replayEvent(raw, JSON.parse(trimmed)); } catch {}
          }
        }
      } catch {}
    }

    return raw;
  }

  /** Replay individual event into a snapshot object (#525). */
  replayEvent(snapshot, event) {
    if (!snapshot || !event?.pool || !event?.ref) return;
    if (!snapshot.pools) snapshot.pools = {};
    if (!snapshot.pools[event.pool]) {
      snapshot.pools[event.pool] = { failedUntil: {}, pausedRefs: [], revokedRefs: [] };
    }
    const p = snapshot.pools[event.pool];
    if (event.type === 'cooldown' || event.type === 'failure') {
      if (!p.failedUntil) p.failedUntil = {};
      p.failedUntil[event.ref] = event.until ?? (event.at + (event.cooldownMs || 60000));
    } else if (event.type === 'success' || event.type === 'reset') {
      if (p.failedUntil) delete p.failedUntil[event.ref];
    } else if (event.type === 'pause') {
      if (!Array.isArray(p.pausedRefs)) p.pausedRefs = [];
      if (!p.pausedRefs.includes(event.ref)) p.pausedRefs.push(event.ref);
    } else if (event.type === 'unpause') {
      if (Array.isArray(p.pausedRefs)) {
        p.pausedRefs = p.pausedRefs.filter((r) => r !== event.ref);
      }
    } else if (event.type === 'revoke') {
      if (!Array.isArray(p.revokedRefs)) p.revokedRefs = [];
      if (!p.revokedRefs.includes(event.ref)) p.revokedRefs.push(event.ref);
    }
  }

  /** Restore poolState Map from a loaded snapshot. */
  static restorePools(poolState, snapshot) {
    if (!poolState || !snapshot?.pools || typeof snapshot.pools !== 'object' || Array.isArray(snapshot.pools)) return 0;
    let n = 0;
    for (const [base, saved] of Object.entries(snapshot.pools)) {
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      const existing = poolState.get(base);
      const state = initializePoolState(existing);
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
        if (Array.isArray(saved.pausedRefs)) {
          if (!state.pausedRefs) state.pausedRefs = new Set();
          for (const r of saved.pausedRefs) {
            if (typeof r === 'string') state.pausedRefs.add(r);
          }
        }
        if (saved.pauseReasons && typeof saved.pauseReasons === 'object' && !Array.isArray(saved.pauseReasons)) {
          if (!state.pauseReasons) state.pauseReasons = new Map();
          for (const [ref, reason] of Object.entries(saved.pauseReasons)) {
            if (typeof reason === 'string') state.pauseReasons.set(ref, reason);
          }
        }
        if (saved.balances && typeof saved.balances === 'object' && !Array.isArray(saved.balances)) {
          if (!state.balances) state.balances = new Map();
          for (const [ref, bal] of Object.entries(saved.balances)) {
            if (bal && typeof bal === 'object') state.balances.set(ref, bal);
          }
        }
        if (saved.modelCapabilities && typeof saved.modelCapabilities === 'object' && !Array.isArray(saved.modelCapabilities)) {
          if (!state.modelCapabilities) state.modelCapabilities = new Map();
          for (const [ref, list] of Object.entries(saved.modelCapabilities)) {
            if (Array.isArray(list)) {
              state.modelCapabilities.set(ref, new Set(list.filter((m) => typeof m === 'string')));
            }
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
        if (saved.costDays && typeof saved.costDays === 'object' && !Array.isArray(saved.costDays)) {
          if (!state.costDays) state.costDays = new Map();
          for (const [k, val] of Object.entries(saved.costDays)) {
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              let innerMap = state.costDays.get(k);
              if (!(innerMap instanceof Map)) {
                innerMap = new Map();
                state.costDays.set(k, innerMap);
              }
              for (const [day, cost] of Object.entries(val)) {
                const num = Number(cost);
                if (Number.isFinite(num) && num >= 0) innerMap.set(day, num);
              }
            } else if (Number.isFinite(Number(val))) {
              state.costDays.set(k, Number(val));
            }
          }
        }
        if (saved.costPerKey && typeof saved.costPerKey === 'object') {
          if (!state.costPerKey) state.costPerKey = new Map();
          for (const [k, c] of Object.entries(saved.costPerKey)) {
            if (Number.isFinite(c)) state.costPerKey.set(k, c);
          }
        }
        if (saved.usageDays && typeof saved.usageDays === 'object' && !Array.isArray(saved.usageDays)) {
          if (!state.usageDays) state.usageDays = new Map();
          for (const [k, val] of Object.entries(saved.usageDays)) {
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              let innerMap = state.usageDays.get(k);
              if (!(innerMap instanceof Map)) {
                innerMap = new Map();
                state.usageDays.set(k, innerMap);
              }
              for (const [day, count] of Object.entries(val)) {
                const num = Number(count);
                if (Number.isFinite(num) && num >= 0) innerMap.set(day, Math.floor(num));
              }
            } else if (Number.isFinite(Number(val))) {
              state.usageDays.set(k, Math.floor(Number(val)));
            }
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
