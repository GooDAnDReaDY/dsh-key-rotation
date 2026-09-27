import test from 'node:test';
import assert from 'node:assert/strict';
import { isKeyRevoked, expiringSoon, shouldNotifyDaily } from '../lib/pool.js';
import { encryptSecret, decryptSecret } from '../lib/crypto-storage.js';
import { detectPlatform, formatInteractive } from '../lib/webhook.js';
import { METRICS_PATH } from '../lib/ops-paths.js';

test('isKeyRevoked accurately reports revoked state', () => {
  const pool = {
    revokedRefs: new Set(['REVOKED_1', 'KEY_DEAD']),
    state: { revokedRefs: new Set(['KEY_DEAD_2']) },
  };
  assert.equal(isKeyRevoked(pool, 'REVOKED_1'), true);
  assert.equal(isKeyRevoked(pool, 'KEY_DEAD'), true);
  assert.equal(isKeyRevoked(pool, 'KEY_DEAD_2'), true);
  assert.equal(isKeyRevoked(pool, 'ACTIVE_KEY'), false);
  assert.equal(isKeyRevoked(null, 'KEY'), false);
});

test('encryptSecret and decryptSecret round-trip with DSH_KEY_SECRET', () => {
  const secretKey = 'super-secret-master-encryption-key-123';
  const plaintext = 'sk-ant-api03-abcdef1234567890';

  const encrypted = encryptSecret(plaintext, secretKey);
  assert.ok(encrypted.startsWith('enc:v1:'));
  assert.notEqual(encrypted, plaintext);

  const decrypted = decryptSecret(encrypted, secretKey);
  assert.equal(decrypted, plaintext);

  // Wrong key returns ciphertext fallback without crashing
  const wrongKeyDecrypted = decryptSecret(encrypted, 'wrong-key');
  assert.equal(wrongKeyDecrypted, encrypted);

  // Plaintext without enc:v1: prefix returns as-is
  assert.equal(decryptSecret(plaintext, secretKey), plaintext);
});

test('encryptSecret without secretKey leaves plaintext unencrypted', () => {
  const plaintext = 'sk-regular-unencrypted-key';
  assert.equal(encryptSecret(plaintext, null), plaintext);
  assert.equal(encryptSecret(plaintext, undefined), plaintext);
});

test('detectPlatform detects gotify and ntfy', () => {
  assert.equal(detectPlatform('https://gotify.example.com/message?token=123'), 'gotify');
  assert.equal(detectPlatform('https://ntfy.sh/my-alerts-topic'), 'ntfy');
  assert.equal(detectPlatform('https://api.telegram.org/bot123/sendMessage'), 'telegram');
  assert.equal(detectPlatform('https://discord.com/api/webhooks/123/xyz'), 'discord');
  assert.equal(detectPlatform('https://hooks.slack.com/services/123/xyz'), 'slack');
  assert.equal(detectPlatform('https://example.com/webhook'), 'generic');
});

test('formatInteractive formats payloads for gotify and ntfy', () => {
  const payload = {
    title: 'Pool Exhausted',
    text: 'All keys in pool deepseek are cooling',
    actions: [{ id: 'reset-deepseek', label: 'Reset Cooldowns', url: 'https://example.com/reset' }],
  };

  const gotify = formatInteractive('https://gotify.example.com/message', payload, 'token');
  assert.equal(gotify.title, 'Pool Exhausted');
  assert.equal(gotify.message, 'All keys in pool deepseek are cooling');
  assert.equal(gotify.priority, 5);

  const ntfy = formatInteractive('https://ntfy.sh/alerts', payload, 'token');
  assert.equal(ntfy.title, 'Pool Exhausted');
  assert.equal(ntfy.topic, 'alerts');
  assert.ok(Array.isArray(ntfy.actions));
  assert.equal(ntfy.actions[0].label, 'Reset Cooldowns');
});

test('METRICS_PATH is defined correctly', () => {
  assert.equal(METRICS_PATH, '/dsh-key-rotation/metrics');
});

test('Key Expiration Tracker: expiringSoon detects upcoming expirations and skips expired/safe keys (#371)', () => {
  const now = 1700000000000;
  const DAY = 86400000;

  const pool = {
    expiresAt: {
      KEY_EXPIRED: now - 1000,
      KEY_EXP_3D: now + 3 * DAY,
      KEY_EXP_6D: now + 6 * DAY,
      KEY_EXP_20D: now + 20 * DAY,
    }
  };

  const soon7d = expiringSoon(pool, 7, now);
  assert.equal(soon7d.length, 2);
  assert.equal(soon7d[0].ref, 'KEY_EXP_3D');
  assert.equal(soon7d[0].expiresInDays, 3);
  assert.equal(soon7d[1].ref, 'KEY_EXP_6D');
  assert.equal(soon7d[1].expiresInDays, 6);

  const lastNotified = new Map();
  assert.equal(shouldNotifyDaily(lastNotified, 'KEY_EXP_3D', now), true);
  assert.equal(shouldNotifyDaily(lastNotified, 'KEY_EXP_3D', now + 3600000), false);
  assert.equal(shouldNotifyDaily(lastNotified, 'KEY_EXP_3D', now + DAY + 1000), true);
});
