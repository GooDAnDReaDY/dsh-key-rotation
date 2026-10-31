// lib/routes/index.js — Unified HTTP route registration (#522).

import { registerStatusRoutes } from './status.js';
import { registerTelemetryRoutes } from './telemetry.js';
import { registerKeyRoutes } from './keys.js';
import { registerTestRoutes } from './testing.js';
import { registerWebhookActionRoute } from './webhook.js';
import { registerMetricsRoutes } from './metrics.js';
import { registerBalanceRoutes } from './balance.js';
import { registerConfigIoRoutes } from './config.js';
import { registerQuickActionRoutes } from './quick-action.js';

export {
  registerStatusRoutes,
  registerTelemetryRoutes,
  registerKeyRoutes,
  registerTestRoutes,
  registerWebhookActionRoute,
  registerMetricsRoutes,
  registerBalanceRoutes,
  registerConfigIoRoutes,
  registerQuickActionRoutes,
};

export * from './paths.js';
export * from './guard.js';

/**
 * Registers all operational HTTP routes for dsh-key-rotation in ctx.webServer.
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerOpsRoutes(ctx, deps) {
  registerStatusRoutes(ctx, deps);
  registerTelemetryRoutes(ctx, deps);
  registerKeyRoutes(ctx, deps);
  registerTestRoutes(ctx, deps);
  registerWebhookActionRoute(ctx, deps);
  registerMetricsRoutes(ctx, deps);
  registerBalanceRoutes(ctx, deps);
  registerConfigIoRoutes(ctx, deps);
  registerQuickActionRoutes(ctx, deps);
}
