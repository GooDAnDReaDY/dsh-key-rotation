// test/chat-header-chip-switch.test.mjs — tests for the switch to disable chat header chip (#493, GitHub #25)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config, plainConfig } from '../lib/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf-8');

test('Config schema includes showChatHeaderChip with default true', () => {
  const parsedDefault = plainConfig(Config({}));
  assert.equal(parsedDefault.showChatHeaderChip, true);

  const parsedDisabled = plainConfig(Config({ showChatHeaderChip: false }));
  assert.equal(parsedDisabled.showChatHeaderChip, false);

  const parsedExplicitTrue = plainConfig(Config({ showChatHeaderChip: true }));
  assert.equal(parsedExplicitTrue.showChatHeaderChip, true);
});

test('client.js includes localization tokens for showChatHeaderChip in en and zh', () => {
  assert.match(clientSrc, /showChatHeaderChipLabel:\s*'Chat Header Status Chip'/);
  assert.match(clientSrc, /showChatHeaderChipDesc:\s*'Show pool status chip in conversation header'/);
  assert.match(clientSrc, /showChatHeaderChipLabel:\s*'聊天头部状态按钮'/);
  assert.match(clientSrc, /showChatHeaderChipDesc:\s*'在会话界面顶部工具栏显示密钥池状态按钮'/);
});

test('client.js renders showChatHeaderChip toggle in settings card', () => {
  assert.match(clientSrc, /val\.showChatHeaderChip \?\? true/);
  assert.match(clientSrc, /showChatHeaderChip:\s*e\.target\.checked/);
  assert.match(clientSrc, /t\('showChatHeaderChipLabel'\)/);
  assert.match(clientSrc, /t\('showChatHeaderChipDesc'\)/);
});

test('client.js KeyRotationHeaderChip hides when showChatHeaderChip is false', () => {
  assert.match(clientSrc, /settingsVal\.showChatHeaderChip === false\)\s*return null/);
  assert.match(clientSrc, /snap\.showChatHeaderChip === false\)\s*return null/);
  assert.match(clientSrc, /inject:\s*\(\)\s*=>\s*\(\{\s*ctx,\s*settingsSource\s*\}\)/);
});
