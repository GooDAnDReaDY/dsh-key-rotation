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