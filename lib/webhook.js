// lib/webhook.js — webhook sender with throttle, interactive actions + alert digest debouncer (#199, #10).
export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_MIN_INTERVAL_MS = 1000;
export const WEBHOOK_RETRY_DELAY_MS = 2000;

/**
 * Detect platform from webhook URL (#199).
 */
export function detectPlatform(url) {
  const u = String(url ?? '');
  if (u.includes('api.telegram.org')) return 'telegram';
  if (u.includes('discord.com/api/webhooks')) return 'discord';
  if (u.includes('hooks.slack.com')) return 'slack';
  return 'generic';
}

/**
 * Build a platform-specific interactive body (#199).
 * payload: { title, text, actions: [{ id, label }] }
 */
export function formatInteractive(url, payload, actionToken) {
  const platform = detectPlatform(url);
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const title = String(payload.title ?? 'dsh-key-rotation');
  const text = String(payload.text ?? '');
  if (platform === 'telegram') {
    return {
      text: `*${title}*\n${text}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [actions.map((a) => ({
          text: a.label,
          callback_data: JSON.stringify({ id: a.id, token: actionToken }),
        }))],
      },
    };
  }
  if (platform === 'discord') {
    return {
      content: `**${title}**\n${text}`,
      components: [{
        type: 1, // action row
        components: actions.map((a) => ({
          type: 2, // button
          style: 4, // danger
          label: String(a.label).slice(0, 80),
          custom_id: JSON.stringify({ id: a.id, token: actionToken }),
        })),
      }],
    };
  }
  if (platform === 'slack') {
    return {
      text: `*${title}*\n${text}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${text}` } },
        {
          type: 'actions',
          elements: actions.map((a) => ({
            type: 'button',
            text: { type: 'plain_text', text: String(a.label).slice(0, 75) },
            value: JSON.stringify({ id: a.id, token: actionToken }),
          })),
        },
      ],
    };
  }
  // generic JSON webhook: actions as plain data, receiver decides
  return { ...payload, actions };
}

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
    // #199: interactive payload -> platform-specific buttons with callback data
    const body = (payload && typeof payload === 'object' && Array.isArray(payload.actions) && payload.actions.length > 0)
      ? JSON.stringify(formatInteractive(url, payload, payload.actionToken))
      : (typeof payload === 'string' ? payload : JSON.stringify(payload));
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

/**
 * AlertDebouncer aggregates rapid alert events across providers into a consolidated digest.
 */
export class AlertDebouncer {
  constructor({ sender, debounceMs = 5000, maxBatch = 10 } = {}) {
    this._sender = sender;
    this._debounceMs = debounceMs;
    this._maxBatch = maxBatch;
    this._pending = new Map(); // url -> { timer, events: [], callbacks: [] }
  }

  enqueue(url, event, onFlushed = null) {
    if (!url) return;
    let entry = this._pending.get(url);
    if (!entry) {
      entry = { events: [], timer: null, callbacks: [] };
      this._pending.set(url, entry);
    }
    entry.events.push(event);
    if (onFlushed) entry.callbacks.push(onFlushed);

    if (entry.events.length >= this._maxBatch) {
      return this.flush(url);
    }
    if (!entry.timer) {
      entry.timer = setTimeout(() => this.flush(url), this._debounceMs);
    }
  }

  async flush(url) {
    const entry = this._pending.get(url);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this._pending.delete(url);

    const events = entry.events;
    if (events.length === 0) return;

    let payload;
    if (events.length === 1) {
      payload = events[0];
    } else {
      const providers = [...new Set(events.map((e) => e.provider).filter(Boolean))];
      const keys = [...new Set(events.flatMap((e) => e.keys || [e.key]).filter(Boolean))];
      payload = {
        title: `dsh-key-rotation: Alert Digest (${events.length} incidents)`,
        text: `Multiple key incidents:\n- Providers: ${providers.join(', ')}\n- Affected keys: ${keys.join(', ')}`,
        digest: true,
        incidentCount: events.length,
        events,
      };
    }

    const res = await this._sender.send(url, payload);
    for (const cb of entry.callbacks) {
      try { cb(res); } catch (_) {}
    }
    return res;
  }
}