import crypto from 'node:crypto';
// lib/ops-webhook.js — webhook interactive action route (#312 split from routes-ops.js, #388 telegram secret-token & answerCallbackQuery).
import {
  json,
  readJson,
} from './http-bridge.js';
import { WEBHOOK_ACTION_PATH } from './ops-paths.js';

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return String(v ?? '');
  }
  return '';
}

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

    const authHeader = getHeader(req.headers, 'authorization');
    const secretHeader = getHeader(req.headers, 'x-telegram-bot-api-secret-token');
    const bearerMatch = constantTimeEqual(authHeader, `Bearer ${expected}`);
    const secretMatch = constantTimeEqual(secretHeader, expected);
    if (!bearerMatch && !secretMatch) {
      json(res, 401, { error: { code: 'unauthorized', message: 'dsh-key-rotation: bad webhook action token' } });
      return;
    }

    let body;
    try { body = await readJson(req); } catch (e) { json(res, 400, { error: { code: 'bad-request', message: String(e?.message ?? e) } }); return; }

    // #222 / #388: Telegram setWebhook registration helper
    if (typeof body?.setWebhook === 'object' && body.setWebhook) {
      const botToken = typeof body.setWebhook.botToken === 'string' ? body.setWebhook.botToken : '';
      if (!botToken) { json(res, 400, { error: { code: 'bad-request', message: 'dsh-key-rotation: setWebhook.botToken required' } }); return; }
      const TELEGRAM_BOT_TOKEN_RE = /^[0-9]{5,16}:[a-zA-Z0-9_-]{20,50}$/;
      if (!TELEGRAM_BOT_TOKEN_RE.test(botToken)) {
        json(res, 400, { error: { code: 'bad-request', message: 'dsh-key-rotation: invalid telegram bot token format' } });
        return;
      }
      const rawUrl = typeof body.setWebhook.url === 'string' ? body.setWebhook.url.trim() : '';
      if (!rawUrl || !rawUrl.startsWith('https://')) {
        json(res, 400, { error: { code: 'bad-request', message: 'dsh-key-rotation: explicit public https url required in setWebhook.url' } });
        return;
      }
      try {
        const hookRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            url: rawUrl,
            secret_token: expected,
            allowed_updates: ['callback_query'],
          }),
          signal: AbortSignal.timeout(10000),
        });
        const hookData = await hookRes.json().catch(() => ({}));
        json(res, 200, { ok: hookRes.ok, url: rawUrl, secret_token_set: true, telegram: hookData });
      } catch (e) {
        json(res, 502, { error: { code: 'telegram-failed', message: String(e?.message ?? e) } });
      }
      return;
    }

    const callbackQueryId = typeof body?.callback_query?.id === 'string'
      ? body.callback_query.id
      : (typeof body?.callback_query?.id === 'number' ? String(body.callback_query.id) : '');
    const botToken = typeof body?.botToken === 'string' ? body.botToken : '';

    const respond = async (statusCode, payload, answerText) => {
      if (callbackQueryId) {
        payload.method = 'answerCallbackQuery';
        payload.callback_query_id = callbackQueryId;
        payload.text = answerText || payload.error?.message || 'OK';
        if (botToken) {
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ callback_query_id: callbackQueryId, text: payload.text }),
              signal: AbortSignal.timeout(5000),
            });
          } catch {}
        }
      }
      json(res, statusCode, payload);
    };

    // Accept callback payloads from formatInteractive (Telegram/Discord/Slack) or plain {action}
    let action = typeof body?.action === 'string' ? body.action : '';
    if (!action && typeof body?.data === 'string') {
      try { action = String(JSON.parse(body.data)?.id ?? ''); } catch { action = ''; }
    }
    if (!action && typeof body?.callback_data === 'string') {
      try { action = String(JSON.parse(body.callback_data)?.id ?? ''); } catch { action = ''; }
    }
    // #222 / #388: Telegram update envelope {update_id, callback_query:{id, data}}
    if (!action && typeof body?.callback_query?.data === 'string') {
      try {
        const parsed = JSON.parse(body.callback_query.data);
        action = typeof parsed?.id === 'string' ? parsed.id : String(parsed ?? '');
      } catch {
        action = body.callback_query.data;
      }
    }
    if (!action) {
      await respond(400, { error: { code: 'bad-action', message: 'dsh-key-rotation: no action in payload' } }, 'No action in payload');
      return;
    }
    const provider = action.startsWith('pause-') || action.startsWith('reset-') ? action.replace(/^(pause|reset)-/, '') : '';
    try {
      if (action === 'disable-rotation') {
        setRotationDisabled(true);
        (ctx?.logger ? ctx.logger('dsh-key-rotation') : null)?.warn?.('[dsh-key-rotation] rotation DISABLED via webhook action');
        await respond(200, { ok: true, action }, 'Rotation disabled');
        return;
      }
      if (action === 'enable-rotation') {
        setRotationDisabled(false);
        await respond(200, { ok: true, action }, 'Rotation enabled');
        return;
      }
      if (action.startsWith('pause-') || action.startsWith('reset-')) {
        const st = poolState.get(provider);
        if (!st) {
          await respond(404, { error: { code: 'not-found', message: `dsh-key-rotation: no pool for '${provider}'` } }, `Pool not found: ${provider}`);
          return;
        }
        if (action.startsWith('pause-')) {
          const until = Date.now() + 3600000; // 1h pause
          for (const ref of (st.failedUntil ? [...st.failedUntil.keys()] : [])) st.failedUntil.set(ref, Math.max(st.failedUntil.get(ref) ?? 0, until));
          // also pause every key currently healthy
          for (const p of buildRuntime().poolByRef.values()) {
            if (p.base !== provider) continue;
            for (const ref of p.refs) st.failedUntil.set(ref, Math.max(st.failedUntil.get(ref) ?? 0, until));
          }
          (ctx?.logger ? ctx.logger('dsh-key-rotation') : null)?.warn?.(`[dsh-key-rotation] pool ${provider} PAUSED 1h via webhook action`);
          await respond(200, { ok: true, action, provider, until }, `Pool ${provider} paused 1h`);
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
        (ctx?.logger ? ctx.logger('dsh-key-rotation') : null)?.warn?.(`[dsh-key-rotation] pool ${provider} RESET via webhook action (circuitReset=${circuitReset})`);
        await respond(200, { ok: true, action, provider, cleared, circuitReset }, `Pool ${provider} reset`);
        return;
      }
      await respond(400, { error: { code: 'unknown-action', message: `dsh-key-rotation: unknown action '${action}'` } }, `Unknown action: ${action}`);
    } catch (e) {
      await respond(500, { error: { code: 'action-failed', message: String(e?.message ?? e) } }, 'Action failed');
    }
  },
}), 'dsh-key-rotation: webhook-action');
}
