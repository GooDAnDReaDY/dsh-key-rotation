// lib/ops-metrics.js — Prometheus / OpenMetrics export route (#373).
import { METRICS_PATH } from './ops-paths.js';
import { isTrustedBridgeRequest, isKeyPaused, isKeyRevoked } from './pool.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerMetricsRoutes(ctx, deps) {
  const { buildRuntime, poolState } = deps;

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: METRICS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('content-type', 'text/plain');
        res.end('Method Not Allowed\n');
        return;
      }
      if (!isTrustedBridgeRequest(req)) {
        res.statusCode = 403;
        res.setHeader('content-type', 'text/plain');
        res.end('Forbidden: local only\n');
        return;
      }

      const lines = [];
      const runtime = buildRuntime();
      const pools = runtime.pools ?? [];
      const now = Date.now();

      lines.push('# HELP dsh_key_rotation_pools_total Total configured provider pools');
      lines.push('# TYPE dsh_key_rotation_pools_total gauge');
      lines.push(`dsh_key_rotation_pools_total ${pools.length}`);

      lines.push('# HELP dsh_key_rotation_active_keys Number of currently active and ready keys');
      lines.push('# TYPE dsh_key_rotation_active_keys gauge');

      lines.push('# HELP dsh_key_rotation_cooldown_keys Number of keys in cooldown');
      lines.push('# TYPE dsh_key_rotation_cooldown_keys gauge');

      lines.push('# HELP dsh_key_rotation_paused_keys Number of paused keys');
      lines.push('# TYPE dsh_key_rotation_paused_keys gauge');

      lines.push('# HELP dsh_key_rotation_revoked_keys Number of permanently revoked keys');
      lines.push('# TYPE dsh_key_rotation_revoked_keys gauge');

      lines.push('# HELP dsh_key_rotation_proactive_switches_total Number of proactive rate-limit switches');
      lines.push('# TYPE dsh_key_rotation_proactive_switches_total counter');

      lines.push('# HELP dsh_key_rotation_cascade_switches_total Number of multi-vendor cascade switches');
      lines.push('# TYPE dsh_key_rotation_cascade_switches_total counter');

      for (const pool of pools) {
        const p = pool.base;
        const st = poolState.get(p);
        let active = 0, cooling = 0, paused = 0, revoked = 0;
        for (const r of (pool.refs ?? [])) {
          if (isKeyRevoked(pool, r)) { revoked++; continue; }
          if (isKeyPaused(pool, r)) { paused++; continue; }
          const fu = st?.failedUntil?.get(r) ?? 0;
          if (fu > now) cooling++;
          else active++;
        }
        lines.push(`dsh_key_rotation_active_keys{provider="${p}"} ${active}`);
        lines.push(`dsh_key_rotation_cooldown_keys{provider="${p}"} ${cooling}`);
        lines.push(`dsh_key_rotation_paused_keys{provider="${p}"} ${paused}`);
        lines.push(`dsh_key_rotation_revoked_keys{provider="${p}"} ${revoked}`);
        lines.push(`dsh_key_rotation_proactive_switches_total{provider="${p}"} ${st?.proactiveSwitches ?? 0}`);
        lines.push(`dsh_key_rotation_cascade_switches_total{provider="${p}"} ${st?.cascadeCount ?? 0}`);
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      res.end(lines.join('\n') + '\n');
    }
  }), 'dsh-key-rotation: metrics');
}
