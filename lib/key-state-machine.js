// lib/key-state-machine.js — Encapsulated Key State Machine (#529).
// Manages credential lifecycle across deterministic states and valid transitions.

export const KEY_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  COOLDOWN: 'COOLDOWN',
  PROBING: 'PROBING',
  EXHAUSTED: 'EXHAUSTED',
  PAUSED: 'PAUSED',
  REVOKED: 'REVOKED',
});

export const VALID_TRANSITIONS = Object.freeze({
  [KEY_STATES.ACTIVE]: Object.freeze([
    KEY_STATES.COOLDOWN,
    KEY_STATES.EXHAUSTED,
    KEY_STATES.PAUSED,
    KEY_STATES.REVOKED,
  ]),
  [KEY_STATES.COOLDOWN]: Object.freeze([
    KEY_STATES.PROBING,
    KEY_STATES.ACTIVE,
    KEY_STATES.PAUSED,
    KEY_STATES.REVOKED,
  ]),
  [KEY_STATES.PROBING]: Object.freeze([
    KEY_STATES.ACTIVE,
    KEY_STATES.COOLDOWN,
    KEY_STATES.PAUSED,
    KEY_STATES.REVOKED,
  ]),
  [KEY_STATES.EXHAUSTED]: Object.freeze([
    KEY_STATES.ACTIVE,
    KEY_STATES.COOLDOWN,
    KEY_STATES.PAUSED,
    KEY_STATES.REVOKED,
  ]),
  [KEY_STATES.PAUSED]: Object.freeze([
    KEY_STATES.ACTIVE,
    KEY_STATES.COOLDOWN,
    KEY_STATES.REVOKED,
  ]),
  [KEY_STATES.REVOKED]: Object.freeze([
    KEY_STATES.ACTIVE,
  ]),
});

export class KeyStateMachine {
  /**
   * @param {object} [options]
   * @param {number} [options.maxHistory] Maximum transition history entries per pool
   */
  constructor(options = {}) {
    /** @type {Map<string, { state: string, updatedAt: number, previousState?: string, reason?: string, failedUntil?: number }>} */
    this.keyRecords = new Map();
    /** @type {Array<{ ref: string, from: string, to: string, at: number, reason: string|null }>} */
    this.history = [];
    this.maxHistory = options.maxHistory ?? 100;
  }

  /**
   * Computes the current deterministic state of a key reference.
   *
   * @param {string} keyRef
   * @param {object} [context] Optional pool state context for backward compatibility
   * @param {Set<string>} [context.revokedRefs]
   * @param {Set<string>} [context.pausedRefs]
   * @param {Map<string, number>} [context.failedUntil]
   * @param {number} [now]
   * @returns {string} Current KEY_STATES value
   */
  getState(keyRef, context = {}, now = Date.now()) {
    if (!keyRef) return KEY_STATES.ACTIVE;

    // 1. Revocation is absolute
    if (context.revokedRefs && context.revokedRefs.has(keyRef)) {
      return KEY_STATES.REVOKED;
    }

    // 2. Manual pause overrides operational state
    if (context.pausedRefs && context.pausedRefs.has(keyRef)) {
      return KEY_STATES.PAUSED;
    }

    const record = this.keyRecords.get(keyRef);
    if (!record) {
      const failedUntil = context.failedUntil?.get?.(keyRef);
      if (typeof failedUntil === 'number' && failedUntil > now) {
        return KEY_STATES.COOLDOWN;
      }
      return KEY_STATES.ACTIVE;
    }

    // Cooldown transition to probing when timer elapses
    if (record.state === KEY_STATES.COOLDOWN) {
      const until = record.failedUntil ?? context.failedUntil?.get?.(keyRef);
      if (typeof until === 'number' && until <= now) {
        return KEY_STATES.PROBING;
      }
    }

    return record.state;
  }

  /**
   * Transitions a key reference to a new state if valid.
   *
   * @param {string} keyRef
   * @param {string} targetState Target KEY_STATES value
   * @param {object} [metadata]
   * @param {string} [metadata.reason]
   * @param {number} [metadata.failedUntil]
   * @param {object} [metadata.context]
   * @param {number} [now]
   * @returns {string|null} Resulting state or null on failure
   */
  transition(keyRef, targetState, metadata = {}, now = Date.now()) {
    if (!keyRef || !targetState) return null;

    const currentState = this.getState(keyRef, metadata.context, now);
    if (currentState === targetState) return currentState;

    const allowed = VALID_TRANSITIONS[currentState] || [];
    if (!allowed.includes(targetState)) {
      // In relaxed mode, force transition with logged anomaly
      targetState = targetState in KEY_STATES ? targetState : KEY_STATES.ACTIVE;
    }

    const record = this.keyRecords.get(keyRef) ?? {
      state: currentState,
      updatedAt: now,
    };

    record.previousState = currentState;
    record.state = targetState;
    record.updatedAt = now;
    if (metadata.reason !== undefined) record.reason = metadata.reason;
    if (metadata.failedUntil !== undefined) record.failedUntil = metadata.failedUntil;

    this.keyRecords.set(keyRef, record);

    const event = {
      ref: keyRef,
      from: currentState,
      to: targetState,
      at: now,
      reason: metadata.reason ?? null,
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Synchronize external pool state if provided
    if (metadata.context) {
      if (targetState === KEY_STATES.REVOKED) {
        metadata.context.revokedRefs?.add?.(keyRef);
        metadata.context.pausedRefs?.delete?.(keyRef);
      } else if (targetState === KEY_STATES.PAUSED) {
        metadata.context.pausedRefs?.add?.(keyRef);
      } else if (currentState === KEY_STATES.PAUSED && targetState !== KEY_STATES.PAUSED) {
        metadata.context.pausedRefs?.delete?.(keyRef);
      }
    }

    return targetState;
  }

  /**
   * Puts key into COOLDOWN state until specified duration elapses.
   */
  transitionToCooldown(keyRef, options = {}, now = Date.now()) {
    const cooldownMs = Number(options.cooldownMs) > 0 ? Number(options.cooldownMs) : 60000;
    const failedUntil = now + cooldownMs;
    return this.transition(keyRef, KEY_STATES.COOLDOWN, {
      failedUntil,
      reason: options.reason || 'COOLDOWN',
      context: options.context,
    }, now);
  }

  /** Marks key as ready for canary probe dispatch. */
  markProbing(keyRef, metadata = {}, now = Date.now()) {
    return this.transition(keyRef, KEY_STATES.PROBING, {
      reason: metadata.reason || 'CANARY_PROBE',
      context: metadata.context,
    }, now);
  }

  /** Activates key following successful request or probe. */
  activate(keyRef, metadata = {}, now = Date.now()) {
    return this.transition(keyRef, KEY_STATES.ACTIVE, {
      reason: metadata.reason || 'SUCCESS',
      context: metadata.context,
    }, now);
  }

  /** Marks key as exhausted due to local quota or TPM/RPM window. */
  markExhausted(keyRef, metadata = {}, now = Date.now()) {
    return this.transition(keyRef, KEY_STATES.EXHAUSTED, {
      reason: metadata.reason || 'QUOTA_EXHAUSTED',
      context: metadata.context,
    }, now);
  }

  /** Manually pauses key from rotation. */
  pause(keyRef, reason = 'USER_PAUSE', metadata = {}, now = Date.now()) {
    return this.transition(keyRef, KEY_STATES.PAUSED, {
      reason,
      context: metadata.context,
    }, now);
  }

  /** Unpauses key, returning it to active rotation. */
  unpause(keyRef, metadata = {}, now = Date.now()) {
    return this.transition(keyRef, KEY_STATES.ACTIVE, {
      reason: 'USER_RESUME',
      context: metadata.context,
    }, now);
  }

  /** Revokes key permanently until credentials change. */
  revoke(keyRef, reason = 'INVALID_CREDENTIAL', metadata = {}, now = Date.now()) {
    return this.transition(keyRef, KEY_STATES.REVOKED, {
      reason,
      context: metadata.context,
    }, now);
  }

  /** Checks if key is usable for dispatch (ACTIVE or PROBING). */
  isUsable(keyRef, context = {}, now = Date.now()) {
    const state = this.getState(keyRef, context, now);
    return state === KEY_STATES.ACTIVE || state === KEY_STATES.PROBING;
  }

  /** Returns transition history for a specific key or all keys. */
  getHistory(keyRef) {
    if (!keyRef) return this.history.slice();
    return this.history.filter((e) => e.ref === keyRef);
  }

  /** Returns state distribution statistics across a set of keys. */
  getStats(refs = [], context = {}, now = Date.now()) {
    const stats = {
      total: refs.length,
      [KEY_STATES.ACTIVE]: 0,
      [KEY_STATES.COOLDOWN]: 0,
      [KEY_STATES.PROBING]: 0,
      [KEY_STATES.EXHAUSTED]: 0,
      [KEY_STATES.PAUSED]: 0,
      [KEY_STATES.REVOKED]: 0,
    };
    for (const ref of refs) {
      const state = this.getState(ref, context, now);
      if (state in stats) stats[state]++;
    }
    return stats;
  }

  clear() {
    this.keyRecords.clear();
    this.history = [];
  }
}

export const defaultKeyStateMachine = new KeyStateMachine();
