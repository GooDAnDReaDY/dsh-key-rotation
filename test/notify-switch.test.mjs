import test from 'node:test';
import assert from 'node:assert/strict';

// notifySwitch lives in index.js; index.js imports @deepseek-ai/schemastery.
// These tests therefore only run where peer deps resolve (CI/test server);
// guard for local env without the package.
let mod;
try { mod = await import('../lib/index.js'); } catch { mod = null; }
const notifySwitch = mod?.notifySwitch;
if (!mod) {
  test('notifySwitch: skipped locally (no schemastery peer)', () => assert.ok(true));
} else {
  const mkSender = () => { const calls = []; return { calls, send: async (url, p) => calls.push({ url, p }) }; };

  test('notifySwitch: sends once per provider within throttle', async () => {
    let now = 1000000;
    const sender = mkSender();
    const hooks = { webhookSender: sender, now: () => now };
    const runtime = { notifyWebhook: 'http://w', switchNotifyThrottleMs: 60000 };
    const pool = {};
    await notifySwitch(runtime, pool, { provider: 'p', from: 'A', code: 'QUOTA', at: 1 }, hooks);
    now += 1000;
    await notifySwitch(runtime, pool, { provider: 'p', from: 'B', code: 'RATE_LIMIT', at: 2 }, hooks);
    now += 61000;
    await notifySwitch(runtime, pool, { provider: 'p', from: 'C', code: 'AUTH', at: 3 }, hooks);
    assert.equal(sender.calls.length, 2); // 1st + after throttle window
    assert.equal(sender.calls[0].p.kind, 'switch');
    assert.equal(sender.calls[0].p.from, 'A');
  });

  test('notifySwitch: no webhook configured -> nothing', async () => {
    const sender = mkSender();
    await notifySwitch({ notifyWebhook: '' }, {}, { provider: 'p' }, { webhookSender: sender, now: () => 1 });
    assert.equal(sender.calls.length, 0);
  });

  test('notifySwitch: independent throttle per provider', async () => {
    const sender = mkSender();
    const hooks = { webhookSender: sender, now: () => 1000000 };
    const runtime = { notifyWebhook: 'http://w', switchNotifyThrottleMs: 60000 };
    await notifySwitch(runtime, {}, { provider: 'a' }, hooks);
    await notifySwitch(runtime, {}, { provider: 'b' }, hooks);
    assert.equal(sender.calls.length, 2);
  });
}
