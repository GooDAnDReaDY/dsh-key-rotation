// lib/stream-watchdog.js — Inter-token stall & zombie stream detector (#569).
// Monitors streaming chunk intervals and TTFT to prevent infinite agent hangs.

export class StreamStallError extends Error {
  constructor(message, elapsedMs, chunkCount) {
    super(message || `Stream stalled: no tokens received for ${elapsedMs}ms`);
    this.name = 'StreamStallError';
    this.code = 'STREAM_STALLED';
    this.elapsedMs = elapsedMs;
    this.chunkCount = chunkCount;
    this.isStall = true;
  }
}

/**
 * Wraps an async iterable stream with an inter-chunk stall watchdog.
 *
 * @param {AsyncIterable<any>} innerStream
 * @param {object} [options]
 * @param {number} [options.stallTimeoutMs=15000]
 * @param {number} [options.stallInitialTimeoutMs=30000]
 * @param {boolean} [options.stallDetectionEnabled=true]
 * @param {AbortController} [options.abortController]
 * @param {Function} [options.onStall]
 * @returns {AsyncGenerator<any>}
 */
export async function* withStreamWatchdog(innerStream, options = {}) {
  const {
    stallTimeoutMs = 15000,
    stallInitialTimeoutMs = 30000,
    stallDetectionEnabled = true,
    abortController = null,
    onStall = null,
  } = options;

  if (!stallDetectionEnabled || (!stallTimeoutMs && !stallInitialTimeoutMs)) {
    yield* innerStream;
    return;
  }

  const iterator = innerStream[Symbol.asyncIterator]();
  let chunksCount = 0;

  try {
    while (true) {
      const currentTimeout = chunksCount === 0
        ? (stallInitialTimeoutMs || stallTimeoutMs || 30000)
        : (stallTimeoutMs || 15000);

      let timerId = null;

      const timerPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
          const err = new StreamStallError(
            `Stream stalled: no tokens received for ${currentTimeout}ms (chunks: ${chunksCount})`,
            currentTimeout,
            chunksCount
          );
          if (abortController && typeof abortController.abort === 'function') {
            try { abortController.abort(err); } catch (err) { void err; }
          }
          if (typeof onStall === 'function') {
            try { onStall(err); } catch (err) { void err; }
          }
          reject(err);
        }, currentTimeout);
      });

      // Suppress unhandled rejection if iterator.next() finishes first
      timerPromise.catch((err) => { void err; });

      let result;
      try {
        result = await Promise.race([
          iterator.next(),
          timerPromise,
        ]);
      } finally {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
      }

      if (result.done) {
        break;
      }

      chunksCount++;
      yield result.value;
    }
  } finally {
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch (err) { void err; }
    }
  }
}
