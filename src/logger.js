// lib/logger.js — safe Cordis logger wrapper
const noop = () => {};
const noopLogger = { warn: noop, info: noop, error: noop, debug: noop, log: noop };

export function getLogger(ctx, scope = 'dsh-key-rotation') {
  if (typeof ctx?.logger === 'function') {
    return ctx.logger(scope);
  }
  if (ctx?.logger && typeof ctx.logger.warn === 'function') {
    return ctx.logger;
  }
  return noopLogger;
}
