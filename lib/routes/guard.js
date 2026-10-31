// lib/routes/guard.js — Route security guards and payload parsing (#522).

export {
  isTrustedBridgeRequest,
  hasNonLoopbackForwarding,
  isDesktopShellRequest,
  isLoopbackAddress,
} from '../pool.js';

export {
  json,
  readJson,
} from '../http-bridge.js';

/**
 * Safely resolve webServer from a Cordis context or test mock without
 * triggering Cordis's Proxy trap (`cannot get property "webServer" without inject`)
 * when `webServer` is provided by a sibling plugin and not in static `inject`.
 */
export function getWebServer(ctx) {
  if (!ctx) return undefined;
  if (Object.prototype.hasOwnProperty.call(ctx, 'webServer') && typeof ctx.webServer?.register === 'function') {
    return ctx.webServer;
  }
  if (typeof ctx.get === 'function') {
    const viaGet = ctx.get('webServer');
    if (typeof viaGet?.register === 'function') return viaGet;
  }
  try {
    const ws = ctx.webServer;
    if (typeof ws?.register === 'function') return ws;
  } catch {
    return undefined;
  }
  return undefined;
}
