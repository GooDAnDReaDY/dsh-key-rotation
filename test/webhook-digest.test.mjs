import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertDebouncer } from '../lib/webhook.js';

test('AlertDebouncer: single event sends immediately upon flush', async () => {
  const sent = [];
  const sender = {
    send: async (url, payload) => {
      sent.push({ url, payload });
      return { sent: true };
    },
  };

  const debouncer = new AlertDebouncer({ sender, debounceMs: 100 });
  debouncer.enqueue('https://webhook.url', { provider: 'openrouter', key: 'k1', reason: '429' });

  await debouncer.flush('https://webhook.url');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.provider, 'openrouter');
  assert.equal(sent[0].payload.key, 'k1');
});

test('AlertDebouncer: multiple events batch into a single consolidated digest', async () => {
  const sent = [];
  const sender = {
    send: async (url, payload) => {
      sent.push({ url, payload });
      return { sent: true };
    },
  };

  const debouncer = new AlertDebouncer({ sender, debounceMs: 100 });
  debouncer.enqueue('https://webhook.url', { provider: 'deepseek', key: 'k1', reason: 'quota' });
  debouncer.enqueue('https://webhook.url', { provider: 'deepseek', key: 'k2', reason: 'rate_limit' });
  debouncer.enqueue('https://webhook.url', { provider: 'openrouter', key: 'k3', reason: '502' });

  await debouncer.flush('https://webhook.url');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.digest, true);
  assert.equal(sent[0].payload.incidentCount, 3);
  assert.ok(sent[0].payload.text.includes('deepseek, openrouter'));
  assert.ok(sent[0].payload.text.includes('k1, k2, k3'));
});
test('AlertDebouncer: respects sender throttle window across rapid consecutive flushes without losing batches', async () => {
  const sent = [];
  let lastSent = -Infinity;
  const minIntervalMs = 50;
  const sender = {
    _minIntervalMs: minIntervalMs,
    _lastSentAt: new Map(),
    send: async (url, payload) => {
      const now = Date.now();
      if (now - lastSent < minIntervalMs) {
        return { sent: false, throttled: true };
      }
      lastSent = now;
      sender._lastSentAt.set(url, now);
      sent.push({ url, payload });
      return { sent: true, status: 200 };
    },
  };

  const debouncer = new AlertDebouncer({ sender, debounceMs: 100, maxBatch: 5 });
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(debouncer.enqueue('https://webhook.url', { provider: 'p' + i }));
  }

  const results = await Promise.all(promises);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.incidentCount, 5);
  assert.equal(sent[1].payload.incidentCount, 5);
  assert.ok(results.every(r => r.sent === true));
});
