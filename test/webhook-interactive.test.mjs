import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, formatInteractive, WebhookSender } from '../lib/webhook.js';

const ACTIONS = [
  { id: 'pause-pool', label: 'Pause pool' },
  { id: 'disable-rotation', label: 'Disable rotation' },
];

test('detectPlatform: telegram/discord/slack/generic', () => {
  assert.equal(detectPlatform('https://api.telegram.org/bot123/sendMessage'), 'telegram');
  assert.equal(detectPlatform('https://discord.com/api/webhooks/1/x'), 'discord');
  assert.equal(detectPlatform('https://hooks.slack.com/services/T/B/X'), 'slack');
  assert.equal(detectPlatform('https://example.com/hook'), 'generic');
});

test('telegram: inline keyboard with callback_data JSON', () => {
  const body = formatInteractive('https://api.telegram.org/bot1/sendMessage', { title: 'T', text: 'x', actions: [{ id: 'pause-pool', label: 'Pause' }] }, 'tok');
  assert.equal(body.parse_mode, 'Markdown');
  const btn = body.reply_markup.inline_keyboard[0][0];
  const data = JSON.parse(btn.callback_data);
  assert.equal(data.id, 'pause-pool');
  assert.equal(data.token, 'tok');
});

test('discord: action row buttons with custom_id', () => {
  const body = formatInteractive('https://discord.com/api/webhooks/1/x', { title: 'T', text: 'x', actions: [{ id: 'pause-pool', label: 'Pause' }] }, 'tok');
  const btn = body.components[0].components[0];
  assert.equal(btn.type, 2);
  assert.equal(JSON.parse(btn.custom_id).id, 'pause-pool');
});

test('slack: actions block with value JSON', () => {
  const body = formatInteractive('https://hooks.slack.com/services/T/B/X', { title: 'T', text: 'x', actions: [{ id: 'disable-rotation', label: 'Disable' }] }, 'tok');
  const btn = body.blocks[1].elements[0];
  assert.equal(JSON.parse(btn.value).id, 'disable-rotation');
});

test('generic: passthrough with actions', () => {
  const body = formatInteractive('https://example.com/hook', { title: 'T', text: 'x', actions: ACTIONS }, 'tok');
  assert.deepEqual(body.actions, ACTIONS);
});

test('WebhookSender: interactive payload formats body via formatInteractive', async () => {
  let captured;
  const sender = new WebhookSender({ fetchImpl: async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200 }; } });
  await sender.send('https://api.telegram.org/bot1/sendMessage', { title: 'T', text: 'x', actions: [{ id: 'pause-pool', label: 'Pause' }], actionToken: 'tok' });
  const btn = captured.reply_markup.inline_keyboard[0][0];
  assert.equal(JSON.parse(btn.callback_data).id, 'pause-pool');
  assert.equal(JSON.parse(btn.callback_data).token, 'tok');
});

test('WebhookSender: plain payload stays plain JSON', async () => {
  let captured;
  const sender = new WebhookSender({ fetchImpl: async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, status: 200 }; } });
  await sender.send('http://x', { provider: 'p', exhaustionCount: 1 });
  assert.equal(captured.provider, 'p');
});
