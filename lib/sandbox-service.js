// lib/sandbox-service.js — sandbox runner and cache service
import { LastTestCache, SandboxRunner } from './sandbox.js';

export function createSandboxService({ getRuntime }) {
  let sandboxRunner = null;
  let defaultCtx = null;
  const lastTestCache = new LastTestCache();

  function ensureSandboxRunner(ctx) {
    if (ctx) defaultCtx = ctx;
    if (sandboxRunner) return sandboxRunner;
    function resolveBaseUrl(providerOrRef) {
      try {
        let provider = providerOrRef;
        const rt = typeof getRuntime === 'function' ? getRuntime() : null;
        const pool = rt?.poolByRef?.get(providerOrRef);
        if (pool?.base) provider = pool.base;
        else if (pool?.provider) provider = pool.provider;

        const c = ctx || defaultCtx;
        const pInfo = c?.llm?.getProvider?.(provider);
        if (pInfo && (pInfo.baseUrl || pInfo.endpoint || pInfo.url)) {
          return String(pInfo.baseUrl || pInfo.endpoint || pInfo.url);
        }
        for (const info of (c?.llm?.listProviders?.() || [])) {
          if (info && (info.id === provider || info.name === provider)) {
            const u = info.baseUrl || info.endpoint || info.url;
            if (u) return String(u);
          }
        }
        const ns = c?.get ? c.get('llm-pi-ai') : null;
        const list = ns && (ns.providers || (ns.config && ns.config.providers) || []);
        if (Array.isArray(list)) {
          const hit = list.find((p) => p && (p.id === provider || p.name === provider || (Array.isArray(p.aliases) && p.aliases.includes(provider))));
          const base = hit && (hit.baseUrl || hit.endpoint || hit.url);
          if (base) return String(base);
        }
        return null;
      } catch (_) {
        return null;
      }
    }
    sandboxRunner = new SandboxRunner({ fetchImpl: globalThis.fetch, resolveBaseUrl });
    return sandboxRunner;
  }

  async function probeRef(ref, key) {
    const runner = ensureSandboxRunner();
    const result = await runner.probeModels(ref, key);
    lastTestCache.set(ref, { ...result, at: Date.now() });
    return result;
  }

  return { ensureSandboxRunner, probeRef, lastTestCache };
}
