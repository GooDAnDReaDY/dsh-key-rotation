// lib/balance-inspector.js — upstream balance inspector and credit tracking (#495).

import { decryptSecret } from './crypto-storage.js';

/**
 * Inspect upstream balance and credits for a provider API key.
 * @param {string} provider Provider identifier (e.g., 'deepseek', 'siliconflow', 'openrouter', 'openai')
 * @param {string} apiKey Raw API key
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, total?: number, currency?: string, isAvailable?: boolean, error?: string }>}
 */
export async function checkProviderBalance(provider, apiKey, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 6000;
  const signal = options.signal;
  const prov = String(provider || '').toLowerCase().trim();

  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return { ok: false, error: 'missing api key' };
  }

  // 1. DeepSeek Official
  if (prov.includes('deepseek')) {
    try {
      const url = 'https://api.deepseek.com/user/balance';
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Accept': 'application/json',
        },
        signal: signal ?? ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const info = data?.balance_infos?.[0];
      const total = info ? parseFloat(info.total_balance) : 0;
      const currency = info?.currency || 'CNY';
      const isAvailable = Boolean(data?.is_available && (Number.isNaN(total) || total > 0));
      return {
        ok: true,
        provider: 'deepseek',
        total: Number.isFinite(total) ? total : 0,
        currency,
        isAvailable,
        granted: parseFloat(info?.granted_balance || 0),
        toppedUp: parseFloat(info?.topped_up_balance || 0),
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // 2. SiliconFlow
  if (prov.includes('siliconflow')) {
    try {
      const url = 'https://api.siliconflow.cn/v1/user/info';
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Accept': 'application/json',
        },
        signal: signal ?? ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      const json = await res.json();
      const total = json?.data?.totalBalance !== undefined
        ? parseFloat(json.data.totalBalance)
        : (json?.data?.balance !== undefined ? parseFloat(json.data.balance) : 0);
      const isAvailable = Number.isFinite(total) ? total > 0 : true;
      return {
        ok: true,
        provider: 'siliconflow',
        total: Number.isFinite(total) ? total : 0,
        currency: 'CNY',
        isAvailable,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // 3. OpenRouter
  if (prov.includes('openrouter')) {
    try {
      const url = 'https://openrouter.ai/api/v1/auth/key';
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Accept': 'application/json',
        },
        signal: signal ?? ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      const json = await res.json();
      const limit = json?.data?.limit;
      const usage = json?.data?.usage ?? 0;
      const total = limit != null ? Math.max(0, limit - usage) : null;
      return {
        ok: true,
        provider: 'openrouter',
        total: total != null ? total : 999,
        currency: 'USD',
        isAvailable: total == null || total > 0,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // 4. OpenAI Credit Grants
  if (prov.includes('openai')) {
    try {
      const url = 'https://api.openai.com/v1/dashboard/billing/credit_grants';
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Accept': 'application/json',
        },
        signal: signal ?? ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const total = parseFloat(data?.total_available ?? 0);
      return {
        ok: true,
        provider: 'openai',
        total: Number.isFinite(total) ? total : 0,
        currency: 'USD',
        isAvailable: total > 0,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  return { ok: false, error: `Provider '${provider}' does not support balance inspection` };
}

/**
 * Resolve credential and inspect balance for a given ref.
 */
export async function inspectBalanceForRef(ctx, ref, provider, { testValue, fetchImpl, timeoutMs } = {}) {
  const base = ctx.get('credentials');
  let hit = await (base?.__dshKeyRotationOriginalResolve ?? base?.resolve)?.call(base, ref);
  let rawValue = testValue || hit?.value;
  if (!rawValue && process.env[ref]) rawValue = process.env[ref];
  if (typeof rawValue === 'string' && rawValue.startsWith('enc:v1:')) {
    rawValue = decryptSecret(rawValue);
  }
  if (!rawValue) return { ok: false, error: 'no credential' };
  return checkProviderBalance(provider, rawValue, { fetchImpl, timeoutMs });
}
