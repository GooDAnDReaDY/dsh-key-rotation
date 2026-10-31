/** Run a non-critical side effect; never throw. Logs at debug when a logger is provided. */
export function bestEffort(label, fn, logger) {
  const log = (err) => {
    try {
      logger?.debug?.(`dsh-key-rotation: best-effort ${label}`, err);
    } catch {
      /* logger itself must not throw */
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => value,
        (err) => {
          log(err);
          return undefined;
        },
      );
    }
    return result;
  } catch (err) {
    log(err);
    return undefined;
  }
}
