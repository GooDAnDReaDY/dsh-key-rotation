import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '../lib/index.js'), 'utf8');
const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8');

let mod = null;
try { mod = await import('../lib/index.js'); } catch { mod = null; }

test('Config secret tokens have role secret (#237)', (t) => {
  if (!mod) {
    // Static analysis when schemastery peer is absent
    assert.match(INDEX_SRC, /incidentGitHubToken:\s*Schema\.string\(\)\.role\('secret'\)/, 'incidentGitHubToken must have role secret');
    assert.match(INDEX_SRC, /webhookActionToken:\s*Schema\.string\(\)\.role\('secret'\)/, 'webhookActionToken must have role secret');
    return;
  }
  const incidentDef = mod.Config?.dict?.incidentGitHubToken;
  const webhookDef = mod.Config?.dict?.webhookActionToken;
  assert.equal(incidentDef?.meta?.role, 'secret', 'incidentGitHubToken must have role secret');
  assert.equal(webhookDef?.meta?.role, 'secret', 'webhookActionToken must have role secret');
});

test('credentials.resolve monkey-patch is wrapped in ctx.effect with dispose cleanup (#238)', () => {
  assert.match(INDEX_SRC, /ctx\.effect\(\(\) => \{[\s\S]*?credentials\.resolve = async/, 'credentials.resolve patch must be wrapped in ctx.effect');
  assert.match(INDEX_SRC, /credentials\.resolve = original/, 'credentials.resolve must restore original on dispose');
  assert.match(INDEX_SRC, /delete credentials\.__dshKeyRotationPatched/, 'patch flag must be deleted on dispose');
  assert.match(INDEX_SRC, /delete credentials\.__dshKeyRotationOriginalResolve/, 'original reference must be deleted on dispose');
});

test('ctx.on llm/stream and agent/request-error are wrapped in ctx.effect (#239)', () => {
  assert.match(INDEX_SRC, /ctx\.effect\(\(\) => ctx\.on\('llm\/stream'/, 'llm/stream listener must be wrapped in ctx.effect');
  assert.match(INDEX_SRC, /ctx\.effect\(\(\) => ctx\.on\('agent\/request-error'/, 'agent/request-error listener must be wrapped in ctx.effect');
});

test('client.js dead mountDashboard is removed (#240)', () => {
  assert.ok(!CLIENT_SRC.includes('function mountDashboard'), 'mountDashboard function must be removed');
  assert.ok(!CLIENT_SRC.includes('mountDashboard()'), 'mountDashboard call must be removed');
});

test('client.js fallback settings.section has localized label and locale: NS (#236)', () => {
  assert.ok(!CLIENT_SRC.includes("label: () => 'Key Rotation'"), 'Hardcoded English label must be removed');
  assert.ok(CLIENT_SRC.includes("t('title')"), 'Settings section must use t(title)');
  assert.ok(CLIENT_SRC.includes("locale: NS"), 'Settings section must include locale: NS');
});

test('client.js registers en, ru, and zh dictionaries', () => {
  assert.ok(CLIENT_SRC.includes('{ en, ru, zh }'), 'All 3 dictionaries must be registered in ctx.locale.register');
});

test('client.js settingsScope integration (#235)', () => {
  assert.match(CLIENT_SRC, /props\.ctx\.settingsScope\.bind\(\{ namespace: NS \}\)/, 'settingsScope must be bound when available');
  assert.match(CLIENT_SRC, /scopeSnapshot && scopeSnapshot\.status === 'ready'/, 'status ready check must be present');
});
