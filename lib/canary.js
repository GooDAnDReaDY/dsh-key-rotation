// canary.js — canary probing before releasing a key from cooldown (issue #196, #7).

export const CANARY_PROBE_TIMEOUT_MS = 5000;
export const CANARY_DEFAULT_INTERVAL_MS = 30 * 1000;

export class CanaryProber {
  constructor(opts) {
    opts = opts || {};
    if (!opts.sandboxRunner) throw new Error('canary: sandboxRunner required');
    this._runner = opts.sandboxRunner;
    this._intervalMs = opts.intervalMs || CANARY_DEFAULT_INTERVAL_MS;
    this._probeTargetModel = Boolean(opts.probeTargetModel);
    this._results = new Map();
    this._inProgress = new Set();
  }

  get intervalMs() { return this._intervalMs; }
  get probeTargetModel() { return this._probeTargetModel; }

  async probe(ref, key, targetModel = null) {
    if (!ref || this._inProgress.has(ref)) return null;
    this._inProgress.add(ref);
    try {
      let result;
      if (this._probeTargetModel && targetModel && typeof this._runner.probeChatCompletion === 'function') {
        result = await this._runner.probeChatCompletion(ref, key, targetModel);
      } else {
        result = await this._runner.probeModels(ref, key);
      }
      this._results.set(ref, Object.assign({}, result, { at: Date.now() }));
      return result;
    } catch (e) {
      return { ok: false, code: 'error', at: Date.now() };
    } finally {
      this._inProgress.delete(ref);
    }
  }

  lastResult(ref) {
    return this._results.get(ref) || null;
  }

  isHealthy(ref) {
    const r = this._results.get(ref);
    return Boolean(r && r.ok);
  }

  clear(ref) {
    if (ref) {
      this._results.delete(ref);
      this._inProgress.delete(ref);
    } else {
      this._results.clear();
      this._inProgress.clear();
    }
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this._results) out[k] = v;
    return out;
  }
}