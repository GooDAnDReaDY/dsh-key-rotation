// dsh-key-rotation — Settings section ("Key Rotation").
// Renders in the harness Settings sidebar via the settings.section slot and
// edits the plugin's `dsh-key-rotation` settings namespace through the
// loopback-fenced config bridge at /dsh-key-rotation/config.
//
// The config is a KEY POOL PER PROVIDER: a list of providers, each with a list
// of API-key env names. The provider is picked from the catalog of providers
// actually registered with ctx.llm (served by the host as data.providers), so no
// manual route typing is ever needed. The plugin derives the fallback chain and
// auto-creates clone routes from the key count.
window.__ModuleLoader__.load({
  id: 'dsh-key-rotation',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');

    const CONFIG_PATH = '/dsh-key-rotation/config';

    function KeyRotationSection() {
      const [state, setState] = React.useState({ status: 'loading', value: null, revision: 0, error: '', providers: [] });
      const [draft, setDraft] = React.useState(null);

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: '' }));
        fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((data) => {
            setState({
              status: 'ready',
              value: data.value ?? null,
              revision: data.revision ?? 0,
              providers: Array.isArray(data.providers) ? data.providers : [],
              error: data.error ? data.error.message : '',
            });
            setDraft(null);
          })
          .catch((e) => setState((s) => ({ ...s, status: 'error', error: String(e) })));
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const val = draft ?? state.value;
      if (state.status === 'loading' || !val) {
        return React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 } }, 'Loading…');
      }

      const providers = state.providers;
      const providerById = new Map(providers.map((p) => [p.id, p.name]));

      const setField = (fn) => setDraft(fn(val));
      const providerList = Array.isArray(val.providers) ? val.providers : [];

      const setProvider = (index, id) => setField((cur) => {
        const next = [...(Array.isArray(cur.providers) ? cur.providers : [])];
        next[index] = { ...next[index], provider: id };
        return { ...cur, providers: next };
      });
      const setKey = (pIndex, kIndex, value) => setField((cur) => {
        const next = [...(Array.isArray(cur.providers) ? cur.providers : [])];
        const keys = [...(next[pIndex].keys ?? [])];
        keys[kIndex] = value;
        next[pIndex] = { ...next[pIndex], keys };
        return { ...cur, providers: next };
      });
      const addKey = (pIndex) => setField((cur) => {
        const next = [...(Array.isArray(cur.providers) ? cur.providers : [])];
        next[pIndex] = { ...next[pIndex], keys: [...(next[pIndex].keys ?? []), ''] };
        return { ...cur, providers: next };
      });
      const removeKey = (pIndex, kIndex) => setField((cur) => {
        const next = [...(Array.isArray(cur.providers) ? cur.providers : [])];
        next[pIndex] = { ...next[pIndex], keys: (next[pIndex].keys ?? []).filter((_, i) => i !== kIndex) };
        return { ...cur, providers: next };
      });
      const removeProvider = (pIndex) => setField((cur) => ({
        ...cur,
        providers: (Array.isArray(cur.providers) ? cur.providers : []).filter((_, i) => i !== pIndex),
      }));
      const addProvider = () => setField((cur) => ({
        ...cur,
        providers: [...(Array.isArray(cur.providers) ? cur.providers : []), { provider: '', keys: [''] }],
      }));

      const save = () => {
        if (!draft) return;
        setState((s) => ({ ...s, status: 'saving', error: '' }));
        fetch(CONFIG_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ section: draft, expectedRevision: state.revision }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.error) {
              setState((s) => ({ ...s, status: 'error', error: data.error.message }));
              return;
            }
            setState((s) => ({ status: 'ready', value: data.value ?? draft, revision: data.revision ?? s.revision, error: '', providers: s.providers }));
            setDraft(null);
          })
          .catch((e) => setState((s) => ({ ...s, status: 'error', error: String(e) })));
      };

      const labelStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 };
      const field = (labelText, node) => React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        React.createElement('span', { style: labelStyle }, labelText), node);

      const textInput = (value, onChange, placeholder) => React.createElement('input', {
        value: value ?? '',
        onChange: (e) => onChange(e.target.value),
        placeholder,
        style: {
          background: 'var(--dsw-specific-input-major)',
          border: '1px solid var(--dsw-alias-border-l2)',
          color: 'var(--dsw-alias-label-primary)',
          borderRadius: 6,
          padding: '5px 8px',
          fontSize: 13,
          fontFamily: 'inherit',
        },
      });

      const controlBtn = (labelText, onClick, disabled, title) => React.createElement('button', {
        onClick,
        disabled: !!disabled,
        title,
        style: {
          cursor: disabled ? 'default' : 'pointer',
          borderRadius: 6,
          padding: '2px 7px',
          fontSize: 12,
          fontFamily: 'inherit',
          background: 'transparent',
          border: '1px solid var(--dsw-alias-border-l2)',
          color: disabled ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)',
        },
      }, labelText);

      const selectStyle = {
        flex: 1,
        background: 'var(--dsw-specific-input-major)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '5px 8px',
        fontSize: 13,
        fontFamily: 'inherit',
      };

      const providerRows = providerList.map((entry, pIndex) => {
        const options = [];
        if (entry.provider && !providerById.has(entry.provider)) {
          options.push(React.createElement('option', { key: entry.provider, value: entry.provider }, `${entry.provider} (not registered)`));
        }
        options.push(...providers.map((p) =>
          React.createElement('option', { key: p.id, value: p.id }, `${p.name}${p.id !== p.name ? ' — ' + p.id : ''}`)));

        const keys = entry.keys ?? [];
        const keyRows = keys.map((key, kIndex) =>
          React.createElement('div', { key: kIndex, style: { display: 'flex', gap: 6, alignItems: 'center' } },
            React.createElement('span', { style: { width: 18, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, textAlign: 'right' } }, String(kIndex + 1)),
            textInput(key, (v) => setKey(pIndex, kIndex, v), 'API_KEY_ENV_NAME'),
            controlBtn('✕', () => removeKey(pIndex, kIndex), false, 'Remove key'),
          ));

        return React.createElement('div', { key: pIndex, style: { display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 8 } },
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            React.createElement('select', { value: entry.provider, onChange: (e) => setProvider(pIndex, e.target.value), style: selectStyle }, options),
            controlBtn('✕', () => removeProvider(pIndex), false, 'Remove provider'),
          ),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            keyRows,
            React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              controlBtn('+ Add key', () => addKey(pIndex), false, 'Add API key'),
            ),
          ),
        );
      });

      const noProviders = providers.length === 0
        ? React.createElement('p', { style: { color: 'var(--dsw-alias-state-warning-primary)', fontSize: 12, margin: 0 } },
          'No providers registered with DSH — nothing to pick from yet.')
        : null;

      const btn = (labelText, onClick, primary) => React.createElement('button', {
        onClick,
        style: {
          cursor: 'pointer',
          borderRadius: 6,
          padding: '5px 12px',
          fontSize: 13,
          fontFamily: 'inherit',
          background: primary ? 'var(--dsw-alias-button-info-fill)' : 'transparent',
          border: primary ? '1px solid var(--dsw-alias-button-info-fill)' : '1px solid var(--dsw-alias-border-l2)',
          color: primary ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-secondary)',
        },
      }, labelText);

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 } },
        React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 } },
          'Per-provider API key rotation. For each provider, list its API keys (env names, stored in DSH credentials). The plugin routes a model through that provider\u2019s keys in order and switches to the next on a quota/rate-limit failure.'),
        field('Cooldown after failure (ms)', textInput(String(val.cooldownMs ?? 60000), (v) => setField((cur) => ({ ...cur, cooldownMs: Number(v) || 0 })))),
        field('Switch codes (comma-separated)', textInput((val.switchCodes ?? []).join(', '), (v) => setField((cur) => ({ ...cur, switchCodes: v.split(',').map((s) => s.trim()).filter(Boolean) })))),
        field('Providers and their keys', React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          providerRows,
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 } },
            btn('+ Add provider', addProvider, false),
            noProviders,
          ),
        )),
        state.error ? React.createElement('p', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: 0 } }, state.error) : null,
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          btn('Save', save, true),
          btn('Discard', load, false),
          state.status === 'saving' ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, 'Saving…') : null,
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-key-rotation',
        order: 20,
        label: () => 'Key Rotation',
      }, KeyRotationSection));
    }

    module.exports = { apply, inject: ['slots'] };
    return module.exports;
  },
});
