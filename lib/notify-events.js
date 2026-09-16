// lib/notify-events.js — switch/exhaustion notify helpers and pool event ring (#312).
// Extracted from index.js for size and testability; behavior unchanged.

import { WebhookSender } from './webhook.js';

const switchNotifiedAt = new Map();
const MAX_EVENTS = 50;
// Default sender for callers that omit hooks (matches former index.js module scope).
const defaultWebhookSender = new WebhookSender({ fetchImpl: globalThis.fetch });

export function notifySwitch(runtime, pool, info, hooks = { webhookSender: defaultWebhookSender, now: () => Date.now() }) {
  if (!runtime?.notifyWebhook) return;
  const throttle = Math.max(0, runtime.switchNotifyThrottleMs ?? 60000);
  const last = switchNotifiedAt.get(info.provider) ?? 0;
  const now = hooks.now();
  if (now - last < throttle) return;
  switchNotifiedAt.set(info.provider, now);
  // #263: non-blocking — enqueue never awaits webhook I/O
  const send = hooks.notifyQueue
    ? (url, payload) => { hooks.notifyQueue.enqueue(url, payload); return { sent: true, queued: true }; }
    : (url, payload) => hooks.webhookSender.send(url, payload);
  send(runtime.notifyWebhook, {
    title: `Key switched: ${info.provider}`,
    text: `${info.from} failed (${info.code}) - next key in pool`,
    provider: info.provider,
    kind: 'switch',
    from: info.from,
    code: info.code,
    at: info.at,
  });
}

export function pushEvent(pool, ref, reason, cooldownMs, type) {
  const ev = { at: Date.now(), ref, reason: String(reason ?? 'UNKNOWN'), cooldownMs, type: type ?? 'fail' };
  pool.state.events.push(ev);
  if (pool.state.events.length > MAX_EVENTS) pool.state.events.shift();
}

export function notifyExhaustion(runtime, pool, options, hooks = { webhookSender: defaultWebhookSender }) {
  if (!runtime || !pool) return;
  const count = pool.state ? (pool.state.exhaustionCount ?? 0) : 0;
  if (count <= 0) return;
  try {
    if (runtime.notifyWebhook && count >= (runtime.notifyThreshold ?? 0)) {
      const token = runtime.webhookActionToken ?? '';
      const payload = {
        title: `Key pool exhausted: ${options.provider}`,
        text: `${count} exhaustion(s); keys: ${(pool.refs ?? []).join(', ')}`,
        provider: options.provider,
        exhaustionCount: count,
        at: pool.state.lastExhaustionAt,
        keys: pool.refs,
        actionToken: token || undefined,
        actions: token ? [
          { id: `reset-${options.provider}`, label: 'Reset cooldown' },
          { id: `pause-${options.provider}`, label: 'Pause 1h' },
        ] : undefined,
      };
      if (hooks.notifyQueue) hooks.notifyQueue.enqueue(runtime.notifyWebhook, payload);
      else hooks.webhookSender.send(runtime.notifyWebhook, payload);
    }
  } catch (_) { /* ponytail: never crash rotate() */ }
}

