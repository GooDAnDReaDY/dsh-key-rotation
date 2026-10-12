import test from "node:test";
import assert from "node:assert/strict";
import { sortAttemptList } from "../lib/pool.js";
import { buildPoolItem } from "../lib/pool-builder.js";
import { notifyEarlyWarning } from "../lib/notify-events.js";
import { setupProactiveHealthProbeEffect } from "../lib/lifecycle.js";

test("feat 475: tier-priority routing strategy groups by tier ascending", () => {
  const refs = ["key-tier-2", "key-tier-1a", "key-tier-3", "key-tier-1b"];
  const tiers = {
    "key-tier-2": 2,
    "key-tier-1a": 1,
    "key-tier-3": 3,
    "key-tier-1b": 1,
  };
  const sorted = sortAttemptList(refs, "tier-priority", { tiers });
  assert.equal(sorted[0], "key-tier-1a");
  assert.equal(sorted[1], "key-tier-1b");
  assert.equal(sorted[2], "key-tier-2");
  assert.equal(sorted[3], "key-tier-3");
});

test("feat 475: buildPoolItem correctly maps tiers array into pool.tiers", () => {
  const pool = buildPoolItem({
    base: "deepseek",
    keys: ["k1", "k2", "k3"],
    tiers: [2, 1, 3],
    poolStrategy: "tier-priority",
    makeState: () => ({ failedUntil: new Map() }),
  });
  assert.deepEqual(pool.tiers, { k1: 2, k2: 1, k3: 3 });
  assert.equal(pool.routingStrategy, "tier-priority");
});

test("feat 475: early warning alert fires when ready keys drop below threshold", () => {
  let sentPayload = null;
  const mockSender = {
    send: (url, payload) => { sentPayload = payload; },
  };
  const runtime = {
    notifyWebhook: "https://example.com/webhook",
    earlyWarningNotify: true,
    earlyWarningKeyThreshold: 0.25,
    switchNotifyThrottleMs: 0,
  };
  const pool = {
    provider: "deepseek",
    base: "deepseek",
    refs: ["k1", "k2", "k3", "k4"],
  };

  notifyEarlyWarning(runtime, pool, {
    availableCount: 1,
    totalCount: 4,
  }, { webhookSender: mockSender, now: () => 1000 });

  assert.ok(sentPayload);
  assert.equal(sentPayload.kind, "early_warning");
  assert.equal(sentPayload.availableCount, 1);
  assert.equal(sentPayload.totalCount, 4);
  assert.equal(sentPayload.ratio, 0.25);
});

test("feat 475: proactive health probing restores healthy key when runner succeeds", async () => {
  const fakePool = {
    base: "anthropic",
    state: {
      failedUntil: new Map([["k-fail", Date.now() + 10000]]),
      brokenUntil: new Map([["k-broken", Date.now() + 20000]]),
      failCounts: new Map([["k-broken", 3]]),
      events: [],
    },
  };
  let effectRegistered = false;
  let effectCb = null;
  const mockCtx = {
    effect: (cb) => {
      effectRegistered = true;
      effectCb = cb;
      return () => {};
    },
    get: () => ({
      resolve: async (ref) => ({ value: "secret-" + ref }),
    }),
  };
  const mockRunner = {
    probeModels: async () => ({ ok: true }),
  };
  let intervalCb = null;
  const mockTimers = {
    setInterval: (cb) => { intervalCb = cb; return { unref: () => {} }; },
    clearInterval: () => {},
  };

  setupProactiveHealthProbeEffect(
    mockCtx,
    () => ({ proactiveHealthProbing: true, proactiveProbeIntervalMs: 1000 }),
    () => ({ pools: [fakePool] }),
    () => mockRunner,
    console,
    mockTimers
  );

  assert.ok(effectRegistered);
  effectCb();
  assert.ok(intervalCb);

  await intervalCb();

  assert.equal(fakePool.state.failedUntil.has("k-fail"), false);
  assert.equal(fakePool.state.brokenUntil.has("k-broken"), false);
  assert.equal(fakePool.state.events.length, 2);
  assert.equal(fakePool.state.events[0].reason, "proactive-probe-heal");
});

test("feat 475: resolver micro-throttles inline when RPM wait is within microThrottleMaxMs", async () => {
  const { createResolver } = await import("../lib/resolver.js");
  const pool = {
    base: "openai",
    provider: "openai",
    refs: ["k1"],
    rpmLimit: 1,
    microThrottling: true,
    microThrottleMaxMs: 50,
    state: {
      pointer: 0,
      failedUntil: new Map(),
      rpmWindows: new Map([["k1", [Date.now() - 59980]]]), // 20ms remaining
    },
  };
  const runtime = {
    index: { allPools: [pool] },
    poolByRef: new Map([["k1", pool]]),
    providerToPool: new Map([["openai", pool]]),
    microThrottling: true,
    microThrottleMaxMs: 50,
  };
  const resolve = createResolver({
    buildRuntime: () => runtime,
    currentPool: () => pool,
  });

  const res = await resolve("k1", async (r) => ({ value: "secret-" + r }));
  assert.equal(res.value, "secret-k1");
});
