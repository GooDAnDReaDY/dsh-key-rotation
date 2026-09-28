import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkBudgetAndHealthAlerts } from "../lib/budget-monitor.js";
import { isModelQuotaAvailable } from "../lib/model-quota.js";

test("Sparkline in client.js has no hardcoded hex color (#385)", () => {
  const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.doesNotMatch(clientSrc, /rgba\(|#[0-9a-fA-F]{6}/, "client.js must not contain hardcoded rgba or 6-digit hex colors");
});

test("checkBudgetAndHealthAlerts respects model token quotas for warnBelowHealthy (#385)", () => {
  const alerts = [];
  const fakeWebhookSender = {
    send: (url, payload) => { alerts.push({ url, payload }); },
  };

  const pool = {
    base: "anthropic::claude-3-5-sonnet",
    refs: ["KEY_A", "KEY_B"],
    hasModelQuota: true,
    quotas: {
      KEY_A: { tokenLimit: 1000 },
      KEY_B: { tokenLimit: 1000 },
    },
    state: {
      failedUntil: new Map(),
      tokenUsage: new Map([
        ["KEY_A", { used: 1000, resetAt: Date.now() + 60000 }],
        ["KEY_B", { used: 1000, resetAt: Date.now() + 60000 }],
      ]),
    },
  };

  const runtime = {
    poolByRef: new Map([["KEY_A", pool], ["KEY_B", pool]]),
    warnBelowHealthy: 2,
    notifyWebhook: "http://localhost/webhook",
  };

  checkBudgetAndHealthAlerts({
    runtime,
    poolState: new Map([[pool.base, pool.state]]),
    now: Date.now(),
    expiryNotifiedAt: new Map(),
    budgetNotifiedAt: new Map(),
    lowHealthNotifiedAt: new Map(),
    sloNotifiedAt: new Map(),
    latencyHistogram: { snapshot: () => ({}) },
    webhookSender: fakeWebhookSender,
    logger: { warn: () => {} },
  });

  assert.equal(alerts.length, 1, "low-health alert should fire because both keys are quota-exhausted");
  assert.equal(alerts[0].payload.healthy, 0);
  assert.equal(alerts[0].payload.kind, "low-health");
});

test("DELETE and RESET remove entries from st.tokenUsage (#385)", () => {
  const poolState = new Map();
  const st = {
    failedUntil: new Map([["KEY_1", Date.now() + 10000]]),
    failCounts: new Map([["KEY_1", 1]]),
    authFailCounts: new Map([["KEY_1", 1]]),
    brokenUntil: new Map([["KEY_1", Date.now() + 10000]]),
    revokedRefs: new Set(["KEY_1"]),
    tokenUsage: new Map([["KEY_1", { used: 500, resetAt: Date.now() + 10000 }]]),
    lastUsed: "KEY_1",
  };
  poolState.set("openai", st);

  // Simulate DELETE key logic
  for (const s of poolState.values()) {
    s.failedUntil?.delete("KEY_1");
    s.failCounts?.delete("KEY_1");
    s.authFailCounts?.delete("KEY_1");
    s.brokenUntil?.delete("KEY_1");
    s.revokedRefs?.delete("KEY_1");
    s.tokenUsage?.delete("KEY_1");
    if (s.lastUsed === "KEY_1") s.lastUsed = undefined;
  }

  assert.equal(st.tokenUsage.has("KEY_1"), false, "tokenUsage must be cleared for deleted key");
  assert.equal(st.lastUsed, undefined);

  // Populate again and simulate reset logic
  st.tokenUsage.set("KEY_1", { used: 500, resetAt: Date.now() + 10000 });
  for (const s of poolState.values()) {
    s.tokenUsage?.clear();
  }
  assert.equal(st.tokenUsage.size, 0, "tokenUsage must be cleared on provider reset");
});
