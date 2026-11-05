// test/chat-header-chip-switch.test.mjs — tests for the switch to disable chat header chip (#493, #585)

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

test('client.js includes localization tokens for showChatHeaderChip in en and zh (#585)', () => {
  // English
  assert.match(clientSrc, /sectionDisplayTitle:\s*['"]Interface & Display['"]/);
  assert.match(clientSrc, /showChatHeaderChipLabel:\s*['"]Chat Header Rotation Indicator \(rot\)['"]/);
  assert.match(clientSrc, /showChatHeaderChipDesc:\s*['"]Show the interactive key pool status chip and quick actions menu in the conversation header toolbar\. Turn off to remove this indicator from the chat interface\.['"]/);

  // Chinese
  assert.match(clientSrc, /sectionDisplayTitle:\s*['"]界面与显示['"]/);
  assert.match(clientSrc, /showChatHeaderChipLabel:\s*['"]聊天顶部轮换指示器 \(rot\)['"]/);
  assert.match(clientSrc, /showChatHeaderChipDesc:\s*['"]在会话窗口顶部工具栏显示交互式密钥池状态按钮及快捷操作菜单。关闭即可从界面中隐藏该元素。['"]/);
});

test('client.js renders dedicated displaySection with showChatHeaderChip toggle (#585)', () => {
  assert.match(clientSrc, /val\.showChatHeaderChip \?\? true/);
  assert.match(clientSrc, /showChatHeaderChip:\s*e\.target\.checked/);
  assert.match(clientSrc, /t\(['"]sectionDisplayTitle['"]\)/);
  assert.match(clientSrc, /t\(['"]sectionDisplayDesc['"]\)/);
  assert.match(clientSrc, /t\(['"]showChatHeaderChipLabel['"]\)/);
  assert.match(clientSrc, /t\(['"]showChatHeaderChipDesc['"]\)/);
  // Ensured displaySection is placed inside the rendered fieldset
  assert.match(clientSrc, /displaySection,\s*poolsSection/);
});

test('client.js KeyRotationHeaderChip hides when showChatHeaderChip is false (#585)', () => {
  assert.match(clientSrc, /settingsVal\.showChatHeaderChip === false\)\s*return null/);
  assert.match(clientSrc, /snap\.showChatHeaderChip === false\)\s*return null/);
  assert.match(clientSrc, /inject:\s*\(\)\s*=>\s*\(\{\s*ctx,\s*settingsSource\s*\}\)/);
});

test('client.js KeyRotationHeaderChip includes deep reactive subscription to service (#585)', () => {
  assert.match(clientSrc, /service\.subscribe\(\(\)\s*=>/);
  assert.match(clientSrc, /syncCache\(curVal\.showChatHeaderChip\)/);
});

test('client.js KeyRotationHeaderChip implements localStorage flash-free cache (#585)', () => {
  assert.match(clientSrc, /localStorage\.getItem\(['"]dsh_krot_show_header_chip['"]\)/);
  assert.match(clientSrc, /localStorage\.setItem\(['"]dsh_krot_show_header_chip['"]/);
  assert.match(clientSrc, /getCachedVisibility\(\) === false\)\s*return null/);
});

test('client.js registers { en, zh } dictionaries in ctx.locale (#585)', () => {
  assert.match(clientSrc, /ctx\.locale\.register\(NS,\s*\{\s*en,\s*zh\s*\}\)/);
});
