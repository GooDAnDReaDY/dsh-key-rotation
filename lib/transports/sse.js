// lib/transports/sse.js — Server-Sent Events stream decoder (#546).
// Zero-dependency streaming parser with buffering, multi-line data support, and AbortSignal awareness.

/**
 * Creates a stateful SSE stream decoder.
 * @param {object} [options]
 * @param {(event: { event: string, data: string, id?: string, retry?: number }) => void} [options.onEvent]
 * @param {(err: Error) => void} [options.onError]
 * @returns {{ feed: (chunk: string | Uint8Array | Buffer) => void, flush: () => void, reset: () => void }}
 */
export function createSseDecoder(options = {}) {
  const { onEvent, onError } = options;
  let buffer = '';
  let eventType = 'message';
  let dataLines = [];
  let eventId = undefined;
  let retry = undefined;

  function dispatchCurrent() {
    if (dataLines.length === 0) return;
    const dataStr = dataLines.join('\n');
    eventType = eventType || 'message';

    // Discard standard SSE end-of-stream signal
    if (dataStr.trim() !== '[DONE]' && typeof onEvent === 'function') {
      try {
        onEvent({
          event: eventType,
          data: dataStr,
          id: eventId,
          retry,
        });
      } catch (err) {
        if (typeof onError === 'function') onError(err);
      }
    }

    eventType = 'message';
    dataLines = [];
  }

  function processLine(rawLine) {
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);

    // Empty line signals dispatch of current event buffer
    if (!line) {
      dispatchCurrent();
      return;
    }

    // Comment line: ignored per SSE spec
    if (line.startsWith(':')) return;

    const colonIdx = line.indexOf(':');
    let field = line;
    let value = '';

    if (colonIdx !== -1) {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    if (field === 'event') {
      eventType = value;
    } else if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'id') {
      eventId = value;
    } else if (field === 'retry') {
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
    }
  }

  function feed(chunk) {
    if (chunk == null) return;
    const str = typeof chunk === 'string'
      ? chunk
      : (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)
        ? Buffer.from(chunk).toString('utf-8')
        : String(chunk));

    buffer += str;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      processLine(line);
    }
  }

  function flush() {
    if (buffer.length > 0) {
      const line = buffer;
      buffer = '';
      processLine(line);
    }
    dispatchCurrent();
  }

  function reset() {
    buffer = '';
    eventType = 'message';
    dataLines = [];
    eventId = undefined;
    retry = undefined;
  }

  return { feed, flush, reset };
}

/**
 * Async generator that consumes an async iterable of chunks and yields parsed SSE event objects.
 * Handles AbortSignal cleanly.
 *
 * @param {AsyncIterable<Uint8Array | string>} asyncIterable
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<{ event: string, data: string, id?: string, retry?: number }>}
 */
export async function* parseSseStream(asyncIterable, signal) {
  if (!asyncIterable) return;

  const queue = [];
  let error = null;

  const decoder = createSseDecoder({
    onEvent: (evt) => queue.push(evt),
    onError: (err) => { error = err; },
  });

  const checkAbort = () => {
    if (signal?.aborted) {
      const abortError = new Error(signal.reason?.message ?? 'SSE stream aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
  };

  try {
    for await (const chunk of asyncIterable) {
      checkAbort();
      decoder.feed(chunk);
      if (error) throw error;
      while (queue.length > 0) {
        checkAbort();
        yield queue.shift();
      }
    }
    decoder.flush();
    if (error) throw error;
    while (queue.length > 0) {
      checkAbort();
      yield queue.shift();
    }
  } finally {
    decoder.reset();
  }
}
