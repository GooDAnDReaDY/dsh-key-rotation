// lib/routes-ops.js — operational HTTP routes for dsh-key-rotation (#253/#312).
// Thin orchestrator: each route family lives in its own lib/ops-*.js module.
// Registration is injected with the live apply() dependencies.

import { registerStatusRoutes } from './ops-status.js';
import { registerTelemetryRoutes } from './ops-telemetry.js';
import { registerKeyRoutes } from './ops-keys.js';
import { registerTestRoutes } from './ops-test.js';
import { registerWebhookActionRoute } from './ops-webhook.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerOpsRoutes(ctx, deps) {
  registerStatusRoutes(ctx, deps);
  registerTelemetryRoutes(ctx, deps);
  registerKeyRoutes(ctx, deps);
  registerTestRoutes(ctx, deps);
  registerWebhookActionRoute(ctx, deps);
}
