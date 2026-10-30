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
