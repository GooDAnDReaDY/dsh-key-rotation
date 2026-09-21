// lib/sandbox-service.js — sandbox runner and cache service
import { LastTestCache, SandboxRunner } from './sandbox.js';
import { bestEffort } from './best-effort.js';
import { resolveProbeBaseUrl } from './probe-endpoint.js';

export function createSandboxService({ getRuntime }) {
  let sandboxRunner = null;
  let defaultCtx = null;
  const lastTestCache = new LastTestCache();

  function ensureSandboxRunner(ctx) {
    if (ctx) defaultCtx = ctx;
    if (sandboxRunner) return sandboxRunner;
    async function resolveBaseUrl(providerOrRef) {
      const rt = await bestEffort('probe.runtime', () => typeof getRuntime === 'function' ? getRuntime() : null);
      const pool = rt?.poolByRef?.get(providerOrRef);
      const provider = pool?.base || pool?.provider || providerOrRef;
      return resolveProbeBaseUrl(defaultCtx, provider);
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
