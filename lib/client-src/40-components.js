    function Sparkline({ points = [], width = 120, height = 22, stroke = 'var(--dsw-alias-state-brand-primary, var(--dsw-alias-color-primary, currentColor))' }) {
      if (!Array.isArray(points) || points.length < 2) {
        return h('svg', { width, height, viewBox: `0 0 ${width} ${height}`, style: { opacity: 0.3 } },
          h('line', { x1: 0, y1: height / 2, x2: width, y2: height / 2, stroke, strokeWidth: 1, strokeDasharray: '3 3' })
        );
      }
      const min = Math.min(...points);
      const max = Math.max(...points);
      const range = max - min || 1;
      const step = width / (points.length - 1);
      const coords = points.map((p, i) => {
        const x = Math.round(i * step * 10) / 10;
        const y = Math.round((height - ((p - min) / range) * (height - 4) - 2) * 10) / 10;
        return `${x},${y}`;
      }).join(' ');

      return h('svg', {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        style: { display: 'inline-block', verticalAlign: 'middle', overflow: 'visible' },
      }, h('polyline', {
        points: coords,
        fill: 'none',
        stroke,
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }));
    }

    function parseBulkKeys(text) {
      if (!text || typeof text !== 'string') return [];
      const lines = text.split(/\r?\n/);
      const result = [];
      const seen = new Set();
      for (let raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        const envMatch = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (envMatch) {
          const ref = envMatch[1];
          if (!seen.has(ref)) {
            seen.add(ref);
            let weight = 1;
            const rest = envMatch[2].trim().replace(/^['"]|['"]$/g, '');
            const wMatch = rest.match(/,\s*(?:weight\s*=\s*)?([0-9]+)$/i);
            if (wMatch) weight = Math.max(1, parseInt(wMatch[1], 10) || 1);
            result.push({ ref, weight });
          }
          continue;
        }
        const parts = line.split(',');
        const ref = parts[0].trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) && !seen.has(ref)) {
          seen.add(ref);
          let weight = 1;
          if (parts[1]) {
            const wm = parts[1].trim().match(/(?:weight\s*=\s*)?([0-9]+)/i);
            if (wm) weight = Math.max(1, parseInt(wm[1], 10) || 1);
          }
          result.push({ ref, weight });
        }
      }
      return result;
    }

    function UpdaterSection({ t }) {
      const [state, setState] = React.useState({ phase: 'idle', current: '', latest: '', message: '' });
      const load = React.useCallback(async () => {
        setState((s) => ({ ...s, phase: 'loading', message: '' }));
        try {
          const res = await fetch('/api/dsh-key-rotation/update', { headers: { 'x-dsh-plugin-update': '1' } });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message || t('updateFailed'));
          setState({
            phase: data.updateAvailable ? 'available' : 'current',
            current: data.currentVersion || '',
            latest: data.latestVersion || '',
            message: data.updateAvailable ? t('updateAvailable') : t('updateNone'),
          });
        } catch (e) {
          setState({ phase: 'error', current: '', latest: '', message: e?.message || t('updateFailed') });
        }
      }, [t]);
      React.useEffect(() => { load(); }, [load]);
      const run = async () => {
        setState((s) => ({ ...s, phase: 'running', message: t('updateRunning') }));
        try {
          const res = await fetch('/api/dsh-key-rotation/update', {
            method: 'POST',
            headers: { 'x-dsh-plugin-update': '1', 'content-type': 'application/json' },
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message || t('updateFailed'));
          setState({
            phase: 'done',
            current: data.currentVersion || '',
            latest: data.installedVersion || data.latestVersion || '',
            message: t('updateRestart'),
          });
        } catch (e) {
          setState({ phase: 'error', current: '', latest: '', message: e?.message || t('updateFailed') });
        }
      };
      return h('div', { className: 'krot-update', style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            t('currentVersion') + ': ' + (state.current || '—')),
          state.latest ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            t('latestVersion') + ': ' + state.latest) : null,
          h('button', {
            className: 'krot-btn',
            type: 'button',
            disabled: state.phase === 'running' || state.phase === 'loading',
            onClick: load,
          }, t('updateCheck')),
          state.phase === 'available' ? h('button', {
            className: 'krot-btn krot-btn-primary',
            type: 'button',
            disabled: state.phase === 'running',
            onClick: run,
          }, t('updateRun')) : null,
        ),
        state.message ? h('div', {
          className: state.phase === 'error' ? 'krot-alert-bad' : state.phase === 'done' ? 'krot-alert-ok' : '',
          style: { marginTop: 8, fontSize: 12 },
        }, state.message) : null,
      );
    }

    // Provider registration is not part of settingsScope's value. Fetch it
    // independently, and never turn an unavailable catalog into proof of absence.
    function useProviderCatalog(enabled = true) {
      const [catalog, setCatalog] = React.useState({ status: 'loading', providers: [] });
      const requestRef = React.useRef(null);
      const reload = React.useCallback(() => {
        requestRef.current?.abort();
        if (!enabled) {
          setCatalog({ status: 'unavailable', providers: [] });
          return Promise.resolve();
        }
        const controller = new AbortController();
        requestRef.current = controller;
        setCatalog((s) => ({ ...s, status: 'loading' }));
        return fetch(CONFIG_PATH, { headers: { accept: 'application/json' }, signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error('provider catalog unavailable');
            const data = await response.json();
            if (!Array.isArray(data?.providers) || !data.providers.every((p) =>
              p && typeof p.id === 'string' && p.id.length > 0)) {
              throw new Error('invalid provider catalog');
            }
            if (controller.signal.aborted || requestRef.current !== controller) return;
            setCatalog({ status: 'ready', providers: data.providers.map((p) => ({
              id: p.id, name: typeof p.name === 'string' ? p.name : p.id,
            })) });
          })
          .catch(() => {
            if (!controller.signal.aborted && requestRef.current === controller) {
              setCatalog((s) => ({ ...s, status: 'error' }));
            }
          });
      }, [enabled]);
      React.useEffect(() => {
        reload();
        // A provider may have been installed/enabled while this page was open.
        window.addEventListener?.('focus', reload);
        return () => {
          requestRef.current?.abort();
          window.removeEventListener?.('focus', reload);
        };
      }, [reload]);
      return { ...catalog, reload };
    }

    // Services from different core generations are optional at the plugin boundary.
    // One binding belongs to one Cordis activation, not to each React page mount.
    function createSettingsSource(ctx) {
      const listeners = new Set();
      const candidates = new Map();
      let value = { kind: null, service: null };
      const publish = () => {
        const kind = candidates.has('configForm') ? 'configForm'
          : candidates.has('settingsScope') ? 'settingsScope' : null;
        const service = candidates.get(kind) ?? null;
        if (value.kind === kind && value.service === service) return;
        value = { kind, service };
        for (const listener of [...listeners]) listener();
      };
      if (typeof ctx?.inject === 'function') {
        const watch = (name, kind, resolve) => {
          ctx.inject([name], (owner) => {
            let service;
            try { service = resolve(owner.get(name)); } catch (_) { return; }
            if (!service || typeof service.getSnapshot !== 'function'
              || typeof service.subscribe !== 'function') return;
            candidates.set(kind, service);
            publish();
            owner.effect(() => () => {
              if (candidates.get(kind) === service) candidates.delete(kind);
              publish();
            });
          });
        };
        watch('configForms', 'configForm', (forms) => forms?.get?.(NS));
        watch('settingsScope', 'settingsScope', (binder) => binder?.bind?.({ namespace: NS }));
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => { candidates.clear(); publish(); listeners.clear(); });
        }
      }
      return {
        getSnapshot: () => value,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      };
    }

    function sameJson(a, b) {
      if (Object.is(a, b)) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object'
        || Array.isArray(a) !== Array.isArray(b)) return false;
      const keys = Object.keys(a);
      return keys.length === Object.keys(b).length
        && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameJson(a[key], b[key]));
    }

    // A redacted, resolved snapshot is not a complete user section. Submit only
    // changed top-level fields; arrays are intentionally edited atomically.
    function changedSettingsOps(base, next) {
      const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
      return [...keys].filter((key) => !sameJson(base[key], next[key])).map((key) =>
        next[key] === undefined ? { op: 'unset', path: [key] }
          : { op: 'set', path: [key], value: next[key] });
    }

    function requireJson(value, depth = 0) {
      if (depth > 40) throw new Error('Configuration is nested too deeply');
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (Array.isArray(value)) { value.forEach(child => requireJson(child, depth + 1)); return; }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe configuration field');
          if (child !== undefined) requireJson(child, depth + 1);
        }
        return;
      }
      throw new Error('Configuration must contain finite, JSON-compatible values');
    }


    function reorderKeys(entry, order) {
      const next = { ...entry, keys: order.map(index => entry.keys[index]) };
      for (const [field, fallback] of [['weights', 1], ['expiresAt', 0]]) {
        if (Array.isArray(entry[field]) && entry[field].length) next[field] = order.map(index => entry[field][index] ?? fallback);
      }
      return next;
    }

    function formatCountdown(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '00:00:00';
      const total = Math.floor(ms / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return pad(h) + ':' + pad(m) + ':' + pad(s);
    }

    function quotaMapOf(modelEntry) {
      const out = {};
      const raw = (modelEntry && typeof modelEntry === 'object' && modelEntry.quotas) || {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
      for (const [ref, value] of Object.entries(raw)) {
        if (['__proto__', 'constructor', 'prototype'].includes(ref)) continue;
        const n = typeof value === 'object' && value !== null ? value.tokenLimit : value;
        const num = typeof n === 'string' ? Number(n.trim() === '' ? NaN : n) : Number(n);
        if (Number.isFinite(num) && num > 0) out[ref] = { tokenLimit: Math.floor(num) };
      }
      return out;
    }

    function withQuotas(modelEntry, limits) {
      const quotas = {};
      for (const [ref, value] of Object.entries(limits ?? {})) {
        const n = typeof value === 'object' && value !== null ? value.tokenLimit : value;
        const num = typeof n === 'string' ? Number(n.trim() === '' ? NaN : n) : Number(n);
        if (!Number.isFinite(num) || num <= 0) continue;
        quotas[ref] = { tokenLimit: Math.floor(num) };
      }
      const next = { ...modelEntry };
      if (Object.keys(quotas).length === 0) delete next.quotas;
      else next.quotas = quotas;
      return next;
    }

    function modelEntriesOf(entry) {
      const models = entry && entry.models;
      if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
      return Object.entries(models).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value));
    }

    function isValidModelId(id) {
      return typeof id === 'string' && id.trim().length > 0
        && !['__proto__', 'constructor', 'prototype'].includes(id)
        && id.length <= 200;
    }

    function validatePoolDraft(providers) {
      if (!Array.isArray(providers)) throw new Error('Provider pools must be an array');
      const names = new Set();
      for (const entry of providers) {
        if (!entry || typeof entry.provider !== 'string' || !entry.provider.trim()
          || names.has(entry.provider) || !Array.isArray(entry.keys)
          || entry.keys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          || new Set(entry.keys).size !== entry.keys.length) {
          throw new Error('Choose a unique provider and valid, unique credential reference names');
        }
        names.add(entry.provider);
        for (const [model, mp] of modelEntriesOf(entry)) {
          if (!isValidModelId(model)) throw new Error('Model ids must be non-empty and safe as configuration keys');
          if (!Array.isArray(mp.keys)
            || mp.keys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            || new Set(mp.keys).size !== mp.keys.length) {
            throw new Error('Each model pool needs valid, unique credential reference names');
          }
          for (const ref of Object.keys(quotaMapOf(mp))) {
            if (!mp.keys.includes(ref)) throw new Error('A model token limit must reference a credential of that model pool');
          }
        }
      }
    }

    async function settingsResponse(response) {
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error('Settings response is not valid JSON (HTTP ' + response.status + ')'); }
      if (!response.ok || data?.error) {
        throw new Error(data?.error?.message || 'Settings request failed (HTTP ' + response.status + ')');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid settings response');
      return data;
    }

