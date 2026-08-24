// dsh-key-rotation — Settings section ("Key Rotation" / "Ротация ключей").
// Renders in the harness Settings sidebar via the settings.section slot and
// edits the plugin's `dsh-key-rotation` settings namespace through the
// loopback-fenced config bridge at /dsh-key-rotation/config.
//
// The config is a KEY POOL PER PROVIDER: a list of providers, each with a list
// of API-key env names. The provider is picked from the catalog of providers
// actually registered with ctx.llm (served by the host as data.providers), so no
// manual route typing is ever needed. The plugin derives the fallback chain and
// auto-creates clone routes from the key count.
//
// Localization: the plugin registers its own en/ru dictionaries with the DSH
// locale service (ctx.locale.register) and resolves the "active" locale
// through ctx.locale.getSnapshot().active + ctx.locale.subscribe() via
// React.useSyncExternalStore, so the UI switches language live whenever the
// DSH UI locale changes (Settings → Language).
window.__ModuleLoader__.load({
  id: '@goodandready/dsh-key-rotation',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');

    const CONFIG_PATH = '/dsh-key-rotation/config';
    const NS = 'dsh-key-rotation';

    // -------------------------------------------------------------- i18n
    const en = {
      title: 'Key Rotation',
      loading: 'Loading…',
      notRegistered: 'not registered',
      removeKey: 'Remove key',
      removeProvider: 'Remove provider',
      addKey: '+ Add key',
      addKeyTitle: 'Add API key',
      noProviders: 'No providers registered with DSH — nothing to pick from yet.',
      addProvider: '+ Add provider',
      desc: 'Per-provider API key rotation. For each provider, list its API keys (env names, stored in DSH credentials). The plugin routes a model through that provider\u2019s keys in order and switches to the next on a quota/rate-limit failure.',
      cooldown: 'Cooldown after failure (ms)',
      switchCodes: 'Switch codes (comma-separated)',
      providersTitle: 'Providers and their keys',
      save: 'Save',
      discard: 'Discard',
      saving: 'Saving…',
      moveUp: 'Move up',
      moveDown: 'Move down',
      keyActive: 'in use',
      keyReady: 'ready',
      keyCooling: 'cooling down, {s}s',
      keyMissing: 'no such credential',
      switchesNone: 'no switches yet',
      switchesSome: 'switches: {n} · last: {reason}, {ago}',
      justNow: 'just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      codesTitle: 'Switch on these failures',
      keyValuePlaceholder: 'paste the key, then Save',
      keySave: 'Save key',
      keySaved: 'saved',
      keyFromEnv: 'from the environment, read-only here',
      keyWriteFailed: 'could not store the key: {msg}',
      keyHint: 'The value is stored in DSH credentials and never sent back to the browser — only its last 5 characters are shown. Names are generated for you; hover a key to see the one it uses.',
      resetCooldown: 'Reset cooldown',
      poolExhausted: 'pool exhausted — all keys cooling',
      resetting: 'Resetting…',
      keyLabel: 'Key {n}',
    };
    const ru = {
      title: 'Ротация ключей',
      loading: 'Загрузка…',
      notRegistered: 'не зарегистрирован',
      removeKey: 'Удалить ключ',
      removeProvider: 'Удалить провайдера',
      addKey: '+ Добавить ключ',
      addKeyTitle: 'Добавить API-ключ',
      noProviders: 'Провайдеры ещё не зарегистрированы в DSH — выбирать не из чего.',
      addProvider: '+ Добавить провайдера',
      desc: 'Ротация API-ключей по провайдерам. Для каждого провайдера укажите его API-ключи (имена env, хранятся в учётных данных DSH). Плагин ведёт модель по ключам провайдера по порядку и переключается на следующий при исчерпании квоты/превышении лимита.',
      cooldown: 'Задержка после сбоя (мс)',
      switchCodes: 'Коды переключения (через запятую)',
      providersTitle: 'Провайдеры и их ключи',
      save: 'Сохранить',
      discard: 'Отменить',
      saving: 'Сохранение…',
      moveUp: 'Выше',
      moveDown: 'Ниже',
      keyActive: 'используется',
      keyReady: 'готов',
      keyCooling: 'остывает, {s}с',
      keyMissing: 'ключ не найден',
      switchesNone: 'переключений не было',
      switchesSome: 'переключений: {n} · последнее: {reason}, {ago}',
      justNow: 'только что',
      minutesAgo: '{n} мин назад',
      hoursAgo: '{n} ч назад',
      codesTitle: 'Переключаться при этих сбоях',
      keyValuePlaceholder: 'вставьте ключ и нажмите «Сохранить»',
      keySave: 'Сохранить ключ',
      keySaved: 'сохранён',
      keyFromEnv: 'задан в окружении, отсюда не меняется',
      keyWriteFailed: 'не удалось сохранить ключ: {msg}',
      keyHint: 'Значение хранится в учётных данных DSH и обратно в браузер не отдаётся — показываются только последние 5 символов. Имена переменных создаются автоматически; наведите на ключ, чтобы увидеть используемое имя.',
      resetCooldown: 'Сбросить кулдаун',
      poolExhausted: 'пул исчерпан — все ключи остывают',
      resetting: 'Сброс…',
      keyLabel: 'Ключ {n}',
    };

    // Коды, на которых имеет смысл переключать ключ. Список из хоста
    // (DEFAULT_SWITCH_CODES); конфиг может содержать и свои — они показываются
    // отдельными отмеченными галочками, чтобы правило нельзя было потерять.
    const KNOWN_CODES = ['QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'UNKNOWN_MODEL', 'AUTH'];

    /** Опрос статуса ротации, пока раздел настроек открыт. */
    function useRotationStatus() {
      const [byProvider, setByProvider] = React.useState({});
      React.useEffect(() => {
        let alive = true;
        const pull = () => {
          fetch('/dsh-key-rotation/status', { headers: { accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (!alive || !data || !Array.isArray(data.providers)) return;
              const map = {};
              for (const entry of data.providers) map[entry.provider] = entry;
              setByProvider(map);
            })
            .catch(() => { /* статус необязателен: карточка остаётся редактором */ });
        };
        pull();
        const id = setInterval(pull, 4000);
        return () => { alive = false; clearInterval(id); };
      }, []);
      return byProvider;
    }

    function formatAgo(t, at) {
      if (!at) return '';
      const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (sec < 60) return t('justNow');
      if (sec < 3600) return t('minutesAgo').replace('{n}', String(Math.round(sec / 60)));
      return t('hoursAgo').replace('{n}', String(Math.round(sec / 3600)));
    }

    // Разметка карточки: сетка, а не набор inline-стилей. Фиксированные ширины
    // здесь уже приводили к тому, что имя ключа обрезалось, а кнопки наезжали
    // на поле значения, поэтому имя занимает свою строку, а служебная строка
    // под ним ужимается сама.
    const CARD_CSS = [
      '.krot{display:flex;flex-direction:column;gap:14px;max-width:640px}',
      '.krot p{margin:0}',
      '.krot-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.krot-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.krot-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.krot-field{display:flex;flex-direction:column;gap:5px}',
      '.krot-in{background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 8px;font-size:13px;font-family:inherit;min-width:0;width:100%;box-sizing:border-box}',
      '.krot-in:focus{outline:none;border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}',
      '.krot-codes{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px 12px}',
      '.krot-code{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.krot-prov{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px}',
      '.krot-prov-head{display:flex;gap:8px;align-items:center}',
      '.krot-prov-head select{flex:1;min-width:0}',
      '.krot-keys{display:flex;flex-direction:column;gap:8px}',
      '.krot-key{display:grid;grid-template-columns:18px minmax(0,1fr);gap:4px 8px;align-items:center}',
      '.krot-num{font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:right}',
      '.krot-name{font-size:13px;color:var(--dsw-alias-label-primary);cursor:default}',
      '.krot-meta{grid-column:2;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.krot-dot{width:8px;height:8px;border-radius:50%;flex:none}',
      '.krot-state{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.krot-tail{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,Consolas,monospace}',
      '.krot-secret{flex:1;min-width:120px;max-width:220px}',
      '.krot-acts{display:flex;gap:4px;margin-left:auto;flex:none}',
      '.krot-btn{cursor:pointer;border-radius:6px;padding:2px 8px;font-size:12px;font-family:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.krot-btn:disabled{opacity:.35;cursor:default}',
      '.krot-btn:not(:disabled):hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}',
      '.krot-foot{display:flex;gap:8px;align-items:center}',
      '.krot-save{background:var(--dsw-alias-button-info-fill);border-color:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground);padding:5px 14px;font-size:13px}',
    ].join('');
    const CARD_CSS_ID = 'dsh-key-rotation/section.module.css';
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + CARD_CSS_ID + '"]')) {
      const tag = document.createElement('style');
      tag.textContent = CARD_CSS;
      tag.setAttribute('data-plugin', 'dsh-key-rotation');
      tag.dataset.pluginCss = CARD_CSS_ID;
      document.head.appendChild(tag);
    }

    /**
     * Имя переменной под новый ключ.
     *
     * Пользователь его больше не печатает: первый ключ провайдера получает имя
     * вида <PROVIDER>_API_KEY, следующие — тот же корень с суффиксом _2, _3…
     * Корень берётся у уже существующих ключей, чтобы вручную заведённые имена
     * не ломались, и проверяется на занятость по ВСЕМ провайдерам — иначе два
     * провайдера незаметно делили бы одну учётную запись.
     */
    function nextKeyRef(providerId, existingKeys, allRefs) {
      const fromExisting = (existingKeys || []).find((k) => typeof k === 'string' && k.length > 0);
      const base = fromExisting
        ? fromExisting.replace(/_\d+$/, '')
        : String(providerId || 'provider').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_API_KEY';
      const taken = new Set(allRefs);
      if (!taken.has(base)) return base;
      for (let n = 2; n < 1000; n++) {
        const candidate = base + '_' + n;
        if (!taken.has(candidate)) return candidate;
      }
      return base + '_' + Date.now();
    }

    function useActiveLocale(ctx) {
      return React.useSyncExternalStore(
        React.useMemo(() => (cb) => (ctx && ctx.locale ? ctx.locale.subscribe(cb) : () => {}), [ctx]),
        React.useCallback(() => {
          if (ctx && ctx.locale) {
            const active = ctx.locale.getSnapshot().active;
            if (typeof active === 'string' && active) return active;
          }
          return typeof navigator !== 'undefined' ? String(navigator.language || '').slice(0, 2) : '';
        }, [ctx])
      );
    }

    function makeT(DICT, fallbackKeys) {
      return (key) => (DICT && DICT[key]) || (fallbackKeys && fallbackKeys[key]) || key;
    }

    function KeyRotationSection(props) {
      const DICT = props.locale === 'ru' ? ru : en;
      const t = makeT(DICT, en);
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
      const status = useRotationStatus();
      // Значения ключей живут только здесь, до нажатия «сохранить»: обратно из
      // хоста они не приходят, в карточке видны лишь последние символы.
      const [secretDraft, setSecretDraft] = React.useState({});
      const [secretError, setSecretError] = React.useState('');
      const [resetting, setResetting] = React.useState('');
      const doReset = (providerId) => {
        setResetting(providerId);
        setSecretError('');
        fetch('/dsh-key-rotation/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: providerId }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => { if (!ok) throw new Error(data?.error?.message ?? 'unknown error'); })
          .catch((e) => setSecretError(t('keyWriteFailed').replace('{msg}', String(e?.message ?? e))))
          .finally(() => setResetting(''));
      };

      const keyInfo = (providerId, ref) => {
        const entryStatus = status[providerId];
        if (!entryStatus || !ref) return null;
        return (entryStatus.keys ?? []).find((k) => k.ref === ref) ?? null;
      };

      const saveSecret = (ref, rowKey) => {
        const value = secretDraft[rowKey];
        if (!value) return;
        setSecretError('');
        fetch('/dsh-key-rotation/key', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref, value }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) throw new Error(data?.error?.message ?? 'unknown error');
            setSecretDraft((cur) => {
              const next = { ...cur };
              delete next[rowKey];
              return next;
            });
          })
          .catch((e) => setSecretError(t('keyWriteFailed').replace('{msg}', String(e?.message ?? e))));
      };
      if (state.status === 'loading' || !val) {
        return React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 } }, t('loading'));
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
      const addKey = (pIndex) => setField((cur) => {
        const providers = [...(cur.providers ?? [])];
        const entry = { ...(providers[pIndex] ?? {}) };
        const allRefs = providers.flatMap((prov) => prov?.keys ?? []);
        entry.keys = [...(entry.keys ?? []), nextKeyRef(entry.provider, entry.keys, allRefs)];
        providers[pIndex] = entry;
        return { ...cur, providers };
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
      // Порядок ключей = порядок попыток, поэтому его надо менять кнопками,
      // а не перепечатыванием имён.
      const moveKey = (pIndex, kIndex, delta) => setField((cur) => {
        const providers = [...(cur.providers ?? [])];
        const entry = { ...(providers[pIndex] ?? {}) };
        const keys = [...(entry.keys ?? [])];
        const target = kIndex + delta;
        if (target < 0 || target >= keys.length) return cur;
        const moved = keys[kIndex];
        keys[kIndex] = keys[target];
        keys[target] = moved;
        entry.keys = keys;
        providers[pIndex] = entry;
        return { ...cur, providers };
      });

      // Коды из конфига, которых нет в известном списке, показываем тоже:
      // иначе галочки молча выбросили бы чужое правило при первом сохранении.
      const selectedCodes = new Set(Array.isArray(val.switchCodes) ? val.switchCodes : []);
      const codeList = [...KNOWN_CODES, ...[...selectedCodes].filter((c) => !KNOWN_CODES.includes(c))];
      const toggleCode = (code, on) => setField((cur) => {
        const current = new Set(Array.isArray(cur.switchCodes) ? cur.switchCodes : []);
        if (on) current.add(code); else current.delete(code);
        return { ...cur, switchCodes: codeList.filter((c) => current.has(c)) };
      });

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

      const h = React.createElement;

      const field = (labelText, node) => h('label', { className: 'krot-field' },
        h('span', { className: 'krot-label' }, labelText), node);

      const textInput = (value, onChange, placeholder) => h('input', {
        className: 'krot-in',
        value: value ?? '',
        onChange: (e) => onChange(e.target.value),
        placeholder,
      });

      const btn = (labelText, onClick, opts) => h('button', {
        className: 'krot-btn' + (opts && opts.primary ? ' krot-save' : ''),
        onClick,
        disabled: Boolean(opts && opts.disabled),
        title: (opts && opts.title) || undefined,
      }, labelText);

      // Точка состояния ключа: цвет и подпись читаются с одного взгляда,
      // а «ключ не найден» ловит опечатку в имени env, которая иначе молчит.
      const keyStatus = (providerId, ref) => {
        const hit = keyInfo(providerId, ref);
        if (!hit) return null;
        if (!hit.present) return { color: 'var(--dsw-alias-state-error-primary)', text: t('keyMissing') };
        if (hit.cooldownMsLeft > 0) {
          return {
            color: 'var(--dsw-alias-state-warning-primary)',
            text: t('keyCooling').replace('{s}', String(Math.ceil(hit.cooldownMsLeft / 1000))),
          };
        }
        if (hit.active) return { color: 'var(--dsw-alias-state-success-primary)', text: t('keyActive') };
        return { color: 'var(--dsw-alias-label-tertiary)', text: t('keyReady') };
      };

      const providerRows = providerList.map((entry, pIndex) => {
        const options = [];
        if (entry.provider && !providerById.has(entry.provider)) {
          options.push(h('option', { key: entry.provider, value: entry.provider }, entry.provider + ' (' + t('notRegistered') + ')'));
        }
        options.push(...providers.map((prov) =>
          h('option', { key: prov.id, value: prov.id }, prov.name + (prov.id !== prov.name ? ' — ' + prov.id : ''))));

        const keys = entry.keys ?? [];
        const keyRows = keys.map((key, kIndex) => {
          const st = keyStatus(entry.provider, key);
          const info = keyInfo(entry.provider, key);
          const rowKey = entry.provider + '/' + kIndex;
          const typed = secretDraft[rowKey];
          const fromEnv = Boolean(info && info.source === 'env');

          // Имя ключа занимает свою строку целиком: раньше оно обрезалось и
          // соседние ключи выглядели одинаково.
          const nameRow = [
            h('span', { className: 'krot-num', key: 'n' }, String(kIndex + 1)),
            h('span', { key: 'i', className: 'krot-name', title: key },
              t('keyLabel').replace('{n}', String(kIndex + 1))),
          ];

          const meta = [
            h('span', { key: 'd', className: 'krot-dot', style: { background: st ? st.color : 'var(--dsw-alias-border-l2)' } }),
            h('span', { key: 's', className: 'krot-state' }, st ? st.text : ''),
          ];
          if (fromEnv) {
            meta.push(h('span', { key: 'v', className: 'krot-tail', title: t('keyFromEnv') },
              info.tail ? '••••' + info.tail : t('keyFromEnv')));
          } else {
            meta.push(h('input', {
              key: 'v',
              type: 'password',
              className: 'krot-in krot-secret',
              value: typed ?? '',
              placeholder: info && info.tail ? '••••' + info.tail : t('keyValuePlaceholder'),
              onChange: (e) => setSecretDraft((cur) => ({ ...cur, [rowKey]: e.target.value })),
            }));
            if (typed) meta.push(btn('✓', () => saveSecret(key, rowKey), { title: t('keySave'), key: 'w' }));
          }
          meta.push(h('span', { key: 'a', className: 'krot-acts' },
            btn('↑', () => moveKey(pIndex, kIndex, -1), { disabled: kIndex === 0, title: t('moveUp') }),
            btn('↓', () => moveKey(pIndex, kIndex, 1), { disabled: kIndex === keys.length - 1, title: t('moveDown') }),
            btn('✕', () => removeKey(pIndex, kIndex), { title: t('removeKey') }),
          ));

          return h('div', { key: kIndex, className: 'krot-key' },
            nameRow,
            h('div', { className: 'krot-meta' }, meta),
          );
        });

        const providerStatus = status[entry.provider];
        const switchesLine = h('p', { className: 'krot-hint' },
          providerStatus && providerStatus.switches > 0
            ? t('switchesSome')
                .replace('{n}', String(providerStatus.switches))
                .replace('{reason}', String(providerStatus.lastReason || '—'))
                .replace('{ago}', formatAgo(t, providerStatus.lastSwitchAt))
            : t('switchesNone'));
        const exhaustionWarning = providerStatus && providerStatus.lastExhaustionAt && (Date.now() - providerStatus.lastExhaustionAt) < 3600000
          ? h('p', { className: 'krot-err' }, t('poolExhausted') + ' (' + formatAgo(t, providerStatus.lastExhaustionAt) + ')')
          : null;

        return h('div', { key: pIndex, className: 'krot-prov' },
          h('div', { className: 'krot-prov-head' },
            h('select', { className: 'krot-in', value: entry.provider, onChange: (e) => setProvider(pIndex, e.target.value) }, options),
            btn('✕', () => removeProvider(pIndex), { title: t('removeProvider') }),
          ),
          h('div', { className: 'krot-keys' }, keyRows),
          h('div', { className: 'krot-foot' },
            btn(t('addKey'), () => addKey(pIndex), { title: t('addKeyTitle') }),
            switchesLine,
            exhaustionWarning,
            btn(t('resetCooldown'), () => doReset(entry.provider), { disabled: !(providerStatus && providerStatus.switches > 0) || resetting === entry.provider, title: t('resetCooldown') }),
          ),
        );
      });

      const noProviders = providers.length === 0
        ? h('p', { className: 'krot-err' }, t('noProviders'))
        : null;

      return h('div', { className: 'krot' },
        h('p', { className: 'krot-hint' }, t('desc')),
        field(t('cooldown'), textInput(String(val.cooldownMs ?? 60000), (v) => setField((cur) => ({ ...cur, cooldownMs: Number(v) || 0 })))),
        field(t('codesTitle'), h('div', { className: 'krot-codes' }, codeList.map((code) => h('label', { key: code, className: 'krot-code' },
          h('input', {
            type: 'checkbox',
            checked: selectedCodes.has(code),
            onChange: (e) => toggleCode(code, e.target.checked),
          }),
          code,
        )))),
        field(t('providersTitle'), h('div', { className: 'krot-keys' },
          providerRows,
          h('div', { className: 'krot-foot' }, btn(t('addProvider'), addProvider, {}), noProviders),
        )),
        h('p', { className: 'krot-hint' }, t('keyHint')),
        secretError ? h('p', { className: 'krot-err' }, secretError) : null,
        state.error ? h('p', { className: 'krot-err' }, state.error) : null,
        h('div', { className: 'krot-foot' },
          btn(t('save'), save, { primary: true }),
          btn(t('discard'), load, {}),
          state.status === 'saving' ? h('span', { className: 'krot-hint' }, t('saving')) : null,
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-key-rotation: dictionaries');
      function useLocale() {
        return useActiveLocale(ctx);
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-key-rotation',
        order: 20,
        label: () => 'Key Rotation',
      }, (props) => React.createElement(KeyRotationSection, { ...props, locale: useLocale() })));
    }

    module.exports = { apply, inject: ['slots', 'locale'] };
    return module.exports;
  },
});
