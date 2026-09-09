// lib/notify-queue.js — non-blocking webhook dispatch with backoff (#263).
// rotate() must never await webhook I/O.

export class NotifyQueue {
  /**
   * @param {{ send: (url:string, payload:object)=>Promise<any>, maxDepth?: number, baseBackoffMs?: number, maxBackoffMs?: number }} opts
   */
  constructor({ send, maxDepth = 50, baseBackoffMs = 2000, maxBackoffMs = 60000 } = {}) {
    if (typeof send !== 'function') throw new Error('NotifyQueue: send required');
    this._send = send;
    this.maxDepth = maxDepth;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this._q = [];
    this._busy = false;
    this._backoffByUrl = new Map();
    this._dropped = 0;
    this._sent = 0;
    this._failed = 0;
  }

  enqueue(url, payload) {
    if (!url) return { queued: false, reason: 'no-url' };
    if (this._q.length >= this.maxDepth) {
      this._dropped += 1;
      return { queued: false, reason: 'full', dropped: this._dropped };
    }
    this._q.push({ url, payload });
    this._pump();
    return { queued: true };
  }

  _pump() {
    if (this._busy) return;
    const job = this._q.shift();
    if (!job) return;
    this._busy = true;
    const delay = this._backoffByUrl.get(job.url) ?? 0;
    const run = async () => {
      try {
        const res = await this._send(job.url, job.payload);
        if (res && res.sent === false) {
          this._failed += 1;
          this._bumpBackoff(job.url);
        } else {
          this._sent += 1;
          this._backoffByUrl.delete(job.url);
        }
      } catch {
        this._failed += 1;
        this._bumpBackoff(job.url);
      } finally {
        this._busy = false;
        if (this._q.length > 0) this._pump();
      }
    };
    if (delay > 0) {
      const t = setTimeout(run, delay);
      if (typeof t.unref === 'function') t.unref();
    } else {
      // fire and forget — do not return a promise to callers
      run();
    }
  }

  _bumpBackoff(url) {
    const cur = this._backoffByUrl.get(url) ?? 0;
    const next = cur === 0 ? this.baseBackoffMs : Math.min(cur * 2, this.maxBackoffMs);
    this._backoffByUrl.set(url, next);
  }

  stats() {
    return { depth: this._q.length, dropped: this._dropped, sent: this._sent, failed: this._failed, busy: this._busy };
  }
}
