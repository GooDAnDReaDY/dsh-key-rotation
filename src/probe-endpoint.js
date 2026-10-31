// Resolve only the selected provider's connection; never infer a vendor URL.
import { bestEffort } from './best-effort.js';

const own = (object, key) => object != null && typeof object === 'object'
  && Object.prototype.hasOwnProperty.call(object, key);

function endpointOf(profile) {
  for (const field of ['baseURL', 'baseUrl', 'apiBase', 'endpoint', 'url']) {
    if (!own(profile, field) || profile[field] == null || profile[field] === '') continue;
    const value = profile[field];
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      // /models is appended by the runner. Query/fragment/userinfo bases do
      // not compose safely; HTTP loopback remains valid for local providers.
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash) return null;
      return value.trim();
    } catch {
      return null;
    }
  }
  return null;
}

function atPath(value, path) {
  if (!Array.isArray(path)) return undefined;
  for (const segment of path) {
    if (typeof segment !== 'string' || !segment
      || ['__proto__', 'constructor', 'prototype'].includes(segment) || !own(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function legacyProfile(providers, provider) {
  if (Array.isArray(providers)) {
    // A declared alias is routing metadata; a display name is not an identity.
    const matches = providers.filter((p) => p && (p.id === provider || p.provider === provider
      || (Array.isArray(p.aliases) && p.aliases.includes(provider))));
    return matches.length === 1 ? matches[0] : undefined;
  }
  return own(providers, provider) ? providers[provider] : undefined;
}

/** Resolve current effective settings on every probe (including after edits).
 * LlmProviderInfo is display-only. Modern hosts declare the exact settings
 * address via listConfigurableProviders(); no adapter/model call is necessary.
 */
export async function resolveProbeBaseUrl(ctx, provider) {
  if (typeof provider !== 'string' || !provider) return null;
  const llm = await bestEffort('probe.llm', () => ctx?.get?.('llm') ?? ctx?.llm);
  const readSections = async () => {
    const settings = await bestEffort('probe.settings', () => ctx?.get?.('settings'));
    const sections = await bestEffort('probe.settings.describe', () => settings?.describe?.({ redactSecrets: true }));
    return Array.isArray(sections) ? sections : [];
  };
  if (typeof llm?.listConfigurableProviders === 'function') {
    const directory = await bestEffort('probe.directory', () => llm.listConfigurableProviders());
    // Do not fall through to a stale endpoint if the authoritative directory
    // is unavailable or ambiguous. No exception/connection detail is logged.
    if (!Array.isArray(directory)) return null;
    const matches = directory.filter((entry) => entry?.provider === provider);
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const entry = matches[0];
      if (typeof entry.settingsNs !== 'string' || !entry.settingsNs) return null;
      const sections = (await readSections()).filter((section) => section?.ns === entry.settingsNs);
      if (sections.length !== 1) return null;
      return endpointOf(atPath(sections[0].value, entry.settingsPath));
    }
  }

  // Older integrations may still expose endpoints directly. Only exact route
  // identities are accepted; never match a provider by its human-readable name.
  const info = await bestEffort('probe.provider', () => llm?.getProvider?.(provider));
  if (info && (info.id == null || info.id === provider)) {
    const url = endpointOf(info);
    if (url) return url;
  }
  const providers = await bestEffort('probe.providers', () => llm?.listProviders?.());
  const match = Array.isArray(providers) ? providers.filter((p) => p?.id === provider) : [];
  if (match.length > 1) return null;
  if (match.length === 1) {
    const url = endpointOf(match[0]);
    if (url) return url;
  }

  // Compatibility for hosts predating the configurable-provider directory.
  // llm-pi-ai is a known settings namespace, not necessarily a Cordis service.
  const sections = (await readSections()).filter((section) => section?.ns === 'llm-pi-ai');
  if (sections.length > 1) return null;
  if (sections.length === 1) {
    const profile = legacyProfile(sections[0].value?.providers, provider);
    if (profile !== undefined) return endpointOf(profile);
  }
  const legacy = await bestEffort('probe.legacy', () => ctx?.get?.('llm-pi-ai'));
  return endpointOf(legacyProfile(legacy?.providers ?? legacy?.config?.providers, provider));
}
