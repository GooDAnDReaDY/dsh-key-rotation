import test from 'node:test';
import assert from 'node:assert/strict';
import { isKeyPaused, isKeyRevoked } from '../lib/pool.js';
import { pickCascadeFallback } from '../lib/cascade.js';
import { formatInteractive } from '../lib/webhook.js';
import { encryptSecret, decryptSecret } from '../lib/crypto-storage.js';

test('isKeyPaused correctly detects dynamic pausedRefs in pool.state even with empty pool.pausedRefs Set (#376)', () => {
  const pool = {
    pausedRefs: new Set(),
    state: { pausedRefs: new Set(['KEY_PAUSED_DYNAMIC']) },
  };
  assert.equal(isKeyPaused(pool, 'KEY_PAUSED_DYNAMIC'), true);
  assert.equal(isKeyPaused(pool, 'OTHER_KEY'), false);

  const arrayPool = {
    pausedRefs: ['KEY_ARRAY_PAUSED'],
    state: {},
  };
  assert.equal(isKeyPaused(arrayPool, 'KEY_ARRAY_PAUSED'), true);
  assert.equal(isKeyPaused(arrayPool, 'OTHER_KEY'), false);
});

test('pickCascadeFallback handles array revokedRefs and skips revoked and paused keys (#376)', () => {
  const cfg = {
    cascade: [{ provider: 'fallback-p', modelMapping: { 'gpt-4': 'claude-3-haiku' } }]
  };
  const pools = new Map([
    ['fallback-p', {
      base: 'fallback-p',
      refs: ['K1', 'K2'],
      revokedRefs: ['K1'], // Array revokedRefs should not throw
      pausedRefs: new Set(['K2']),
      state: { failedUntil: new Map() }
    }]
  ]);

  // All keys in fallback-p are revoked or paused, so fallback should return null
  const res = pickCascadeFallback('main-p', cfg, pools, 'gpt-4');
  assert.equal(res, null);

  // If K2 is unpaused, fallback should succeed
  pools.get('fallback-p').pausedRefs.clear();
  const res2 = pickCascadeFallback('main-p', cfg, pools, 'gpt-4');
  assert.notEqual(res2, null);
  assert.equal(res2.provider, 'fallback-p');
  assert.equal(res2.model, 'claude-3-haiku');
});

test('formatInteractive ntfy topic extraction handles trailing slashes and query strings (#376)', () => {
  const payload = { title: 'Test', text: 'Alert body', actions: [] };

  const ntfy1 = formatInteractive('https://ntfy.sh/ops-alerts/', payload, 'tok');
  assert.equal(ntfy1.topic, 'ops-alerts');

  const ntfy2 = formatInteractive('https://ntfy.sh/ops-alerts?auth=bearer123', payload, 'tok');
  assert.equal(ntfy2.topic, 'ops-alerts');

  const ntfy3 = formatInteractive('https://ntfy.sh/ops-alerts/?auth=bearer123', payload, 'tok');
  assert.equal(ntfy3.topic, 'ops-alerts');
});

test('encryptSecret and decryptSecret work transparently with credentials (#376)', () => {
  const secretKey = 'test-master-secret-key';
  const plaintext = 'sk-live-1234567890abcdef';
  const ciphertext = encryptSecret(plaintext, secretKey);

  assert.ok(ciphertext.startsWith('enc:v1:'));
  assert.equal(decryptSecret(ciphertext, secretKey), plaintext);
  assert.equal(decryptSecret(plaintext, secretKey), plaintext);
});
