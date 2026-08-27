// lib/webhook.js — webhook sender with throttle.
// ponytail: minimal. lastSentAt only on success — failures don't block future sends.
export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_MIN_INTERVAL_MS = 1000;
export const WEBHOOK_RETRY_DELAY_MS = 2000;

export class WebhookSender {
  constructor({ fetchImpl, minIntervalMs = WEBHOOK_MIN_INTERVAL_MS, timeoutMs = WEBHOOK_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('webhook: fetchImpl required');
    this._fetch = fetchImpl;
    this._minIntervalMs = minIntervalMs;
    this._timeoutMs = timeoutMs;
    this._lastSentAt = new Map();
  }

  async send(url, payload, now = Date.now()) {
    if (!url || typeof url !== 'string') return { sent: false };
    const last = this._lastSentAt.get(url);
    if (Number.isFinite(last) && now - last < this._minIntervalMs) return { sent: false, throttled: true };
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._timeoutMs);
    const doFetch = () => this._fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    try {
      let res;
      try {
        res = await doFetch();
      } catch (e) {
        if (e && e.name === 'AbortError') return { sent: false, error: 'timeout' };
        return { sent: false, error: 'network' };
      }
      if (res.status >= 500 && res.status < 600) {
        await new Promise((r) => setTimeout(r, WEBHOOK_RETRY_DELAY_MS));
        if (ctrl.signal.aborted) return { sent: false, error: 'timeout' };
        try {
          res = await doFetch();
        } catch (_) {
          return { sent: false, error: 'network' };
        }
      }
      // Only mark on success — failures shouldn't block future sends.
      if (res.ok) this._lastSentAt.set(url, now);
      return { sent: res.ok, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }

  reset(url) {
    if (url) this._lastSentAt.delete(url);
    else this._lastSentAt.clear();
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._lastSentAt) out[k] = v;
    return out;
  }
}
