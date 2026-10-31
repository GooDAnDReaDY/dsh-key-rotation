// lib/clone-lifecycle.js — automated clone route lifecycle and settings synchronization (#502).
// Ensures virtual clone providers (provider-2, provider-3) automatically copy and sync
// baseUrl, headers, timeout, and models from the base provider, and graceful draining
// on key reduction before deregistering routes.

import { markKeyDraining, cancelKeyDrain, getDrainingStatus, isKeyDraining } from './key-drain.js';

export const CLONE_SYNC_FIELDS = [
  'baseUrl',
  'baseURL',
  'headers',
  'timeout',
  'systemPrompt',
  'customHeaders',
  'models',
  'protocol',
  'apiType',
];

/**
 * Extracts syncable configuration from a base provider profile.
 * @param {object} baseProfile
 * @returns {object}
 */
export function extractSyncableConfig(baseProfile) {
  if (!baseProfile || typeof baseProfile !== 'object') return {};
  const syncable = {};
  for (const field of CLONE_SYNC_FIELDS) {
    if (baseProfile[field] !== undefined) {
      syncable[field] = structuredClone(baseProfile[field]);
    }
  }
  return syncable;
}

/**
 * Copies base provider configuration onto each clone profile.
 * @param {object} baseProfile
 * @param {object} cloneProfile
 * @returns {object} merged clone profile
 */
export function syncCloneProfile(baseProfile, cloneProfile = {}) {
  const syncable = extractSyncableConfig(baseProfile);
  const out = {
    ...cloneProfile,
    ...syncable,
    isClone: true,
  };
  return out;
}

/**
 * Synchronizes clone providers with their base provider settings.
 * @param {object} opts
 * @param {string} opts.baseProvider
 * @param {Set<string>|string[]} opts.cloneIds
 * @param {object} opts.profiles live provider profiles map from settings
 * @param {Function} [opts.onUpdate] callback when clone is updated
 * @returns {{ updated: string[], cloned: Record<string, object> }}
 */
export function synchronizeClones({ baseProvider, cloneIds, profiles, onUpdate }) {
  if (!baseProvider || !profiles || typeof profiles !== 'object') {
    return { updated: [], cloned: {} };
  }

  const baseProfile = profiles[baseProvider];
  if (!baseProfile) {
    return { updated: [], cloned: {} };
  }

  const updated = [];
  const cloned = {};
  const ids = cloneIds instanceof Set ? [...cloneIds] : (Array.isArray(cloneIds) ? cloneIds : []);

  for (const cloneId of ids) {
    if (!cloneId.startsWith(`${baseProvider}-`)) continue;
    const existing = profiles[cloneId] || {};
    const synced = syncCloneProfile(baseProfile, existing);
    cloned[cloneId] = synced;
    updated.push(cloneId);
    if (typeof onUpdate === 'function') {
      onUpdate(cloneId, synced);
    }
  }

  return { updated, cloned };
}

/**
 * Manages clone draining lifecycle when key count is reduced.
 * Clones whose keys are removed are marked as draining, allowed to complete
 * active in-flight streams, and safely deregistered only once in-flight reaches zero.
 */
export class CloneLifecycleManager {
  /**
   * @param {object} opts
   * @param {object} opts.concurrencyTracker
   * @param {object} [opts.logger]
   */
  constructor({ concurrencyTracker, logger } = {}) {
    this.concurrencyTracker = concurrencyTracker;
    this.logger = logger || console;
    this.drainingClones = new Map(); // cloneId -> { provider, ref, startedAt, timer }
    this.knownClones = new Map(); // provider -> Set<string>
  }

  /**
   * Evaluates previous vs current expected clones for a provider.
   * If a clone was removed, marks it draining instead of instantly destroying it.
   * @param {string} provider
   * @param {Set<string>|string[]} [prevClones]
   * @param {Set<string>|string[]} currentClones
   * @param {Function} [onDeregister] callback when draining completes and route is safe to remove
   */
  reconcileClones(provider, prevOrCurrent, currentOrDeregister, maybeDeregister) {
    let prevClones;
    let currentClones;
    let onDeregister;

    if (currentOrDeregister instanceof Set || Array.isArray(currentOrDeregister)) {
      prevClones = prevOrCurrent;
      currentClones = currentOrDeregister;
      onDeregister = maybeDeregister;
    } else {
      prevClones = this.knownClones.get(provider) ?? [];
      currentClones = prevOrCurrent;
      onDeregister = currentOrDeregister;
    }

    const prevSet = prevClones instanceof Set ? prevClones : new Set(prevClones || []);
    const currSet = currentClones instanceof Set ? currentClones : new Set(currentClones || []);

    this.knownClones.set(provider, currSet);

    for (const cloneId of prevSet) {
      if (!currSet.has(cloneId)) {
        this.startDrain(cloneId, provider, onDeregister);
      }
    }

    for (const cloneId of currSet) {
      if (this.drainingClones.has(cloneId)) {
        this.cancelDrain(cloneId);
      }
    }
  }

  startDrain(cloneId, provider, onDeregister) {
    if (this.drainingClones.has(cloneId)) return;

    markKeyDraining(cloneId, provider, this.keyDrainManager);
    const entry = {
      cloneId,
      provider,
      startedAt: Date.now(),
      onDeregister,
    };
    this.drainingClones.set(cloneId, entry);

    if (this.logger?.info) {
      this.logger.info(`[dsh-key-rotation] clone ${cloneId} (${provider}) marked draining; awaiting in-flight stream completion`);
    }

    this._checkDrainCompletion(cloneId);
  }

  _checkDrainCompletion(cloneId) {
    const entry = this.drainingClones.get(cloneId);
    if (!entry) return;

    const inFlight = this.concurrencyTracker && typeof this.concurrencyTracker.getActive === 'function'
      ? this.concurrencyTracker.getActive(cloneId)
      : (this.concurrencyTracker && typeof this.concurrencyTracker.getInFlight === 'function'
        ? this.concurrencyTracker.getInFlight(cloneId)
        : 0);

    if (inFlight === 0) {
      this.drainingClones.delete(cloneId);
      cancelKeyDrain(cloneId, this.keyDrainManager);
      if (this.logger?.info) {
        this.logger.info(`[dsh-key-rotation] clone ${cloneId} (${entry.provider}) drained cleanly; safe to deregister`);
      }
      if (typeof entry.onDeregister === 'function') {
        entry.onDeregister(cloneId, entry.provider);
      }
    } else {
      // Re-check after 500ms
      setTimeout(() => this._checkDrainCompletion(cloneId), 500).unref?.();
    }
  }

  cancelDrain(cloneId) {
    this.drainingClones.delete(cloneId);
    cancelKeyDrain(cloneId, this.keyDrainManager);
  }

  isDraining(cloneId) {
    return this.drainingClones.has(cloneId) || isKeyDraining(cloneId, this.keyDrainManager);
  }

  getDrainingList() {
    return Array.from(this.drainingClones.entries()).map(([cloneId, data]) => ({
      cloneId,
      provider: data.provider,
      startedAt: data.startedAt,
      elapsedMs: Date.now() - data.startedAt,
    }));
  }

  destroy() {
    for (const cloneId of this.drainingClones.keys()) {
      cancelKeyDrain(cloneId, this.keyDrainManager);
    }
    this.drainingClones.clear();
  }
}
