// lib/agent-budget.js — per-agent rate cap.
// ponytail: in-memory counter per (agent, window), thread-safe-ish via timer map.

export const AGENT_BUDGET_DEFAULT_WINDOW_MS = 3600_000; // 1h
export const AGENT_BUDGET_DEFAULT_LIMIT = 0;             // 0 = disabled
export const AGENT_BUDGET_MAX = 50000;                  // hard ceiling per agent

export class AgentBudget {
  constructor({ windowMs = AGENT_BUDGET_DEFAULT_WINDOW_MS, limit = AGENT_BUDGET_DEFAULT_LIMIT } = {}) {
    const w = Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : AGENT_BUDGET_DEFAULT_WINDOW_MS;
    const l = Number.isFinite(limit) && limit >= 0 ? Math.min(AGENT_BUDGET_MAX, Math.floor(limit)) : 0;
    this._windowMs = w;
    this._limit = l;
    this._state = new Map(); // agent -> { hits: number[], windowStart: epochMs }
  }

  isEnabled() {
    return this._limit > 0;
  }

  // Decide if request from this agent is allowed. Returns { allowed, remaining, resetAt }.
  // Records the hit only when allowed.
  check(agentId, now = Date.now()) {
    if (!this.isEnabled()) return { allowed: true, remaining: Infinity, resetAt: null };
    if (!agentId || typeof agentId !== 'string') return { allowed: false, remaining: 0, resetAt: now };
    let s = this._state.get(agentId);
    if (!s) {
      s = { hits: [], windowStart: now };
      this._state.set(agentId, s);
    }
    // Window: prune hits older than windowStart + windowMs
    const cutoff = now - this._windowMs;
    while (s.hits.length > 0 && s.hits[0] < cutoff) s.hits.shift();
    s.windowStart = s.hits.length ? s.hits[0] : now;
    if (s.hits.length >= this._limit) {
      const resetAt = s.hits[0] + this._windowMs;
      return { allowed: false, remaining: 0, resetAt };
    }
    s.hits.push(now);
    return { allowed: true, remaining: this._limit - s.hits.length, resetAt: now + this._windowMs };
  }

  // Reset single agent or all
  reset(agentId) {
    if (agentId) this._state.delete(agentId);
    else this._state.clear();
  }

  // Inspect-only: return remaining without recording.
  peek(agentId, now = Date.now()) {
    if (!this.isEnabled()) return { remaining: Infinity, resetAt: null };
    const s = this._state.get(agentId);
    if (!s) return { remaining: this._limit, resetAt: null };
    const cutoff = now - this._windowMs;
    let count = 0;
    for (let i = 0; i < s.hits.length; i++) {
      if (s.hits[i] >= cutoff) count += 1;
    }
    const oldest = s.hits[0];
    return { remaining: this._limit - count, resetAt: oldest ? oldest + this._windowMs : null };
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._state) out[k] = { hits: v.hits.length };
    return out;
  }
}
