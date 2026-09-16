// lib/ops-webhook.js — webhook interactive action route (#312 split from routes-ops.js).
import {
  json,
  readJson,
} from './http-bridge.js';
import { WEBHOOK_ACTION_PATH } from './ops-paths.js';

/**
 * @param {object} ctx cordis context
 * @param {object} deps live dependencies from apply()
 */
export function registerWebhookActionRoute(ctx, deps) {
  const {
    buildRuntime,
    poolState,
    setRotationDisabled,
    circuitBreaker,
  } = deps;

ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: WEBHOOK_ACTION_PATH,
  handler: async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { error: { code: 'method', message: 'POST only' } }); return; }
    const runtime = buildRuntime();
    const expected = runtime.webhookActionToken;
    if (!expected) { json(res, 503, { error: { code: 'no-token', message: 'dsh-key-rotation: webhookActionToken is not configured' } }); return; }
    const auth = String(req.headers.authorization ?? '');
    if (auth !== `Bearer ${expected}`) { json(res, 401, { error: { code: 'unauthorized', message: 'dsh-key-rotation: bad webhook action token' } }); return; }
    let body;
    try { body = await readJson(req); } catch (e) { json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } }); return; }
    // Accept callback payloads from formatInteractive (Telegram/Discord/Slack) or plain {action}
    let action = typeof body?.action === 'string' ? body.action : '';
    if (!action && typeof body?.data === 'string') {
      try { action = String(JSON.parse(body.data)?.id ?? ''); } catch { action = ''; }
    }
    if (!action && typeof body?.callback_data === 'string') {
      try { action = String(JSON.parse(body.callback_data)?.id ?? ''); } catch { action = ''; }
    }
    // #222: Telegram update envelope {update_id, callback_query:{data}}
    if (!action && typeof body?.callback_query?.data === 'string') {
      try { action = String(JSON.parse(body.callback_query.data)?.id ?? ''); } catch { action = ''; }
    }
    // #222: Telegram setWebhook registration helper
    if (typeof body?.setWebhook === 'object' && body.setWebhook) {
      const botToken = typeof body.setWebhook.botToken === 'string' ? body.setWebhook.botToken : '';
      if (!botToken) { json(res, 400, { error: { code: 'bad-request', message: 'dsh-key-rotation: setWebhook.botToken required' } }); return; }
      // derive the public URL from request headers; explicit URL wins
      const url = typeof body.setWebhook.url === 'string' && body.setWebhook.url ? body.setWebhook.url : `https://${String(req.headers.host ?? '')}/dsh-key-rotation/webhook-action`;
      try {
        const hookRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url, allowed_updates: ['callback_query'] }),
        });
        const hookData = await hookRes.json().catch(() => ({}));
        json(res, 200, { ok: hookRes.ok, url, telegram: hookData });
      } catch (e) {
        json(res, 502, { error: { code: 'telegram-failed', message: String(e?.message ?? e) } });
      }
      return;
    }
    if (!action) { json(res, 400, { error: { code: 'bad-action', message: 'dsh-key-rotation: no action in payload' } }); return; }
    const provider = action.startsWith('pause-') || action.startsWith('reset-') ? action.replace(/^(pause|reset)-/, '') : '';
    try {
      if (action === 'disable-rotation') {
        setRotationDisabled(true);
        console.warn('[dsh-key-rotation] rotation DISABLED via webhook action');
        json(res, 200, { ok: true, action });
        return;
      }
      if (action === 'enable-rotation') {
        setRotationDisabled(false);
        json(res, 200, { ok: true, action });
        return;
      }
      if (action.startsWith('pause-') || action.startsWith('reset-')) {
        const st = poolState.get(provider);
        if (!st) { json(res, 404, { error: { code: 'not-found', message: `dsh-key-rotation: no pool for '${provider}'` } }); return; }
        if (action.startsWith('pause-')) {
          const until = Date.now() + 3600000; // 1h pause
          for (const ref of (st.failedUntil ? [...st.failedUntil.keys()] : [])) st.failedUntil.set(ref, Math.max(st.failedUntil.get(ref) ?? 0, until));
          // also pause every key currently healthy
          for (const p of buildRuntime().poolByRef.values()) {
            if (p.base !== provider) continue;
            for (const ref of p.refs) st.failedUntil.set(ref, Math.max(st.failedUntil.get(ref) ?? 0, until));
          }
          console.warn(`[dsh-key-rotation] pool ${provider} PAUSED 1h via webhook action`);
          json(res, 200, { ok: true, action, provider, until: Date.now() + 3600000 });
          return;
        }
        const cleared = st.failedUntil.size;
        st.failedUntil.clear();
        st.failCounts?.clear();
        st.authFailCounts?.clear();
        st.brokenUntil?.clear();
        st.switches = 0;
        st.lastReason = undefined;
        st.lastSwitchAt = undefined;
        let circuitReset = false;
        const br = circuitBreaker ?? buildRuntime().breaker;
        if (br) {
          if (typeof br.reset === 'function') { br.reset(provider); circuitReset = true; }
          else if (typeof br.onSuccess === 'function') { br.onSuccess(provider); circuitReset = true; }
        }
        console.warn(`[dsh-key-rotation] pool ${provider} RESET via webhook action (circuitReset=${circuitReset})`);
        json(res, 200, { ok: true, action, provider, cleared, circuitReset });
        return;
      }
      json(res, 400, { error: { code: 'unknown-action', message: `dsh-key-rotation: unknown action '${action}'` } });
    } catch (e) {
      json(res, 500, { error: { code: 'action-failed', message: String(e?.message ?? e) } });
    }
  },
}), 'dsh-key-rotation: webhook-action');
}
