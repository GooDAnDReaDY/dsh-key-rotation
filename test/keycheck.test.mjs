import test from 'node:test';
import assert from 'node:assert/strict';
import { findSecrets, looksLikeApiSecret } from '../lib/keycheck.js';

test('detects openai-shaped key', () => {
  const found = findSecrets('paste sk-abcdefghijklmnopqrstuvwx into the field');
  assert.equal(found.length, 1);
  assert.equal(found[0].type, 'openai');
  assert.ok(found[0].preview.startsWith('sk-abcde'));
});

test('detects anthropic, google, github, telegram shapes', () => {
  assert.equal(findSecrets('sk-ant-abcdefghijklmnopqrstuvwx')[0].type, 'anthropic');
  assert.equal(findSecrets('AIza0123456789abcdefghijklmnopqrstuvwx')[0].type, 'google');
  assert.equal(findSecrets('ghp_abcdefghijklmnopqrstuvwxyz012345')[0].type, 'github');
  assert.equal(findSecrets('123456789:AAabcdefghijklmnopqrstuvwxyz012345')[0].type, 'telegram');
});

test('detects private key header', () => {
  assert.equal(findSecrets('-----BEGIN RSA PRIVATE KEY-----')[0].type, 'private-key');
});

test('no false positive on env refs and urls', () => {
  assert.deepEqual(findSecrets('OPENAI_API_KEY_2'), []);
  assert.deepEqual(findSecrets('https://hooks.slack.com/services/T000/B000/XXXX'), []);
  assert.deepEqual(findSecrets('provider=openai cooldown=60000'), []);
});

test('finds multiple secrets and offsets', () => {
  const found = findSecrets('a sk-abcdefghijklmnopqrstuvwx b AIza0123456789abcdefghijklmnopqrstuvwx');
  assert.equal(found.length, 2);
  assert.ok(found[0].index < found[1].index);
});

test('looksLikeApiSecret', () => {
  assert.equal(looksLikeApiSecret('sk-abcdefghijklmnopqrstuvwx'), true);
  assert.equal(looksLikeApiSecret('OPENAI_API_KEY'), false);
});

test('handles null/undefined safely', () => {
  assert.deepEqual(findSecrets(null), []);
  assert.deepEqual(findSecrets(undefined), []);
});
