import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInteractive } from '../lib/webhook.js';

test('Block 4 Fix #419: Telegram callback_data is <= 64 bytes and omits raw actionToken', () => {
  const payload = {
    title: 'Cost budget exceeded',
    text: 'Provider openai spent $50.00',
    actions: [
      { id: 'pause-openai-long-provider-name-which-could-be-very-long', label: 'Pause 1h' },
      { id: 'reset-openai', label: 'Reset' },
    ],
  };
  const token = 'secret_master_token_1234567890_abcdefghijklmnopqrstuvwxyz';
  const res = formatInteractive('https://api.telegram.org/bot123/sendMessage', payload, token);

  assert.equal(res.parse_mode, 'Markdown');
  assert.ok(Array.isArray(res.reply_markup.inline_keyboard));
  const buttons = res.reply_markup.inline_keyboard[0];
  assert.equal(buttons.length, 2);

  for (const btn of buttons) {
    assert.ok(btn.callback_data.length <= 64, `callback_data length ${btn.callback_data.length} > 64`);
    assert.ok(!btn.callback_data.includes(token), 'master actionToken must not be in callback_data');
  }
});

test('Block 4 Fix #417: Telemetry /usage includes model pools sharing refs', async () => {
  const { registerTelemetryRoutes } = await import('../lib/ops-telemetry.js');

  let handler = null;
  const mockCtx = {
    get: () => null,
    effect: (fn) => fn(),
    webServer: {
      register: (opts) => { if (opts.path === '/dsh-key-rotation/usage') handler = opts.handler; }
    }
  };

  const poolA = { base: 'a', provider: 'a', refs: ['KEY_A'], state: { usageCounts: new Map() } };
  const poolAModel = { base: 'a::model1', provider: 'a', model: 'model1', refs: ['KEY_A'], state: { usageCounts: new Map() } };

  const mockRuntime = {
    pools: [poolA, poolAModel],
    poolByRef: new Map([['KEY_A', poolA]]),
  };

  registerTelemetryRoutes(mockCtx, { buildRuntime: () => mockRuntime });
  assert.ok(typeof handler === 'function');

  let statusCode = 0;
  let bodyData = null;
  const req = { method: 'GET', url: '/dsh-key-rotation/usage', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    writeHead: (code) => { statusCode = code; },
    end: (data) => { bodyData = JSON.parse(data); }
  };

  await handler(req, res);
  assert.equal(statusCode, 200);
  assert.equal(bodyData.providers.length, 2);
  const providers = bodyData.providers.map(p => p.provider);
  assert.ok(providers.includes('a'));
  assert.ok(providers.includes('a::model1'));
});

test('Block 4 Fix #418: Status route exposes circuit breaker state and notifyQueue stats', async () => {
  const { registerStatusRoutes } = await import('../lib/ops-status.js');

  let handler = null;
  const mockCtx = {
    get: () => null,
    effect: (fn) => fn(),
    webServer: {
      register: (opts) => { if (opts.path === '/dsh-key-rotation/status') handler = opts.handler; }
    }
  };

  const poolA = { base: 'a', provider: 'a', refs: ['KEY_A'], state: {} };
  const mockBreaker = {
    state: (p) => 'open',
    threshold: 5,
    openMs: 30000,
  };
  const mockNotifyQueue = {
    stats: () => ({ pending: 3, sent: 12 }),
  };
  const mockRuntime = {
    pools: [poolA],
    poolByRef: new Map([['KEY_A', poolA]]),
    providerTags: new Map(),
    providerBudgets: new Map(),
    circuitBreakerEnabled: true,
    expectedClones: [],
  };

  registerStatusRoutes(mockCtx, {
    buildRuntime: () => mockRuntime,
    circuitBreaker: mockBreaker,
    notifyQueue: mockNotifyQueue,
  });

  let statusCode = 0;
  let bodyData = null;
  const req = { method: 'GET', url: '/dsh-key-rotation/status', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    writeHead: (code) => { statusCode = code; },
    end: (data) => { bodyData = JSON.parse(data); }
  };

  await handler(req, res);
  assert.equal(statusCode, 200);
  console.log('TEST 3 BODY:', JSON.stringify(bodyData, null, 2));
  assert.equal(bodyData.providers[0].circuit.state, 'open');
  assert.deepEqual(bodyData.meta.notifyQueue, { pending: 3, sent: 12 });
});

test('Block 4 Fix #423: Prometheus active_keys excludes keys blocked by model token quota', async () => {
  const { registerMetricsRoutes } = await import('../lib/ops-metrics.js');

  let handler = null;
  const mockCtx = {
    get: () => null,
    effect: (fn) => fn(),
    webServer: {
      register: (opts) => { if (opts.path === '/dsh-key-rotation/metrics') handler = opts.handler; }
    }
  };

  const stateA = {
    failedUntil: new Map(),
    tokenUsage: new Map([['KEY_A', { used: 150, resetAt: Date.now() + 60000 }]])
  };

  const poolAModel = {
    base: 'a::m1',
    provider: 'a',
    model: 'm1',
    refs: ['KEY_A'],
    quotas: { KEY_A: { tokenLimit: 100 } },
    state: stateA
  };

  const mockRuntime = {
    pools: [poolAModel],
  };

  const mockPoolState = new Map([
    ['a::m1', stateA]
  ]);

  registerMetricsRoutes(mockCtx, {
    buildRuntime: () => mockRuntime,
    poolState: mockPoolState,
  });

  let outputText = '';
  const req = { method: 'GET', url: '/dsh-key-rotation/metrics', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (data) => { outputText = data; }
  };

  await handler(req, res);
  assert.ok(outputText.includes('dsh_key_rotation_active_keys{provider="a::m1"} 0'), `active_keys should be 0, output: ${outputText}`);
  assert.ok(outputText.includes('dsh_key_rotation_quota_exhausted_keys{provider="a::m1"} 1'), `quota_exhausted_keys should be 1, output: ${outputText}`);
});
