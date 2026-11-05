          .catch((e) => {
            setSecretError(t('keyWriteFailed').replace('{msg}', String(e?.message ?? e)));
            if (provEntry && Array.isArray(provEntry.keys)) {
              setOptimisticReset((cur) => {
                const next = { ...cur };
                provEntry.keys.forEach((k) => { delete next[k]; });
                return next;
              });
            }
          })
          .finally(() => setResetting(''));
      };
      // (issue 223): re-test a broken key; a successful live probe lifts the 30-day broken quarantine
      const retestBroken = (ref) => {
        setSecretError('');
        fetch('/dsh-key-rotation/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref, probe: 'models' }), signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(30000) : undefined })
          .then((r) => r.json())
          .then((data) => {
            if (data && data.ok) {
              return fetch('/dsh-key-rotation/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref }), signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(15000) : undefined });
            }
            setSecretError(t('retestFail'));
            return null;
          })
          .catch((e) => setSecretError(t('keyWriteFailed').replace('{msg}', String(e?.message ?? e))));
      };
      const keyInfo = (providerId, ref) => {
        const entryStatus = status[providerId];
        if (!entryStatus || !ref) return null;
        return (entryStatus.keys ?? []).find((k) => k.ref === ref) ?? null;
      };

      const [validating, setValidating] = React.useState('');
      const [presetNotice, setPresetNotice] = React.useState('');
      const [checkingBalance, setCheckingBalance] = React.useState('');
      const checkBalances = async (pIndex, provName) => {
        setCheckingBalance(provName);
        try {
          const r = await fetch('/dsh-key-rotation/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: provName }),
            signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(15000) : undefined,
          });
          const data = await r.json();
          if (data && data.ok) {
            load();
          }
        } catch (err) {
          setSecretError(String(err?.message || err));
        } finally {
          setCheckingBalance('');
        }
      };
      const applyPreset = async (pIndex, provName) => {
        try {
          const r = await fetch('/dsh-key-rotation/preset-limits?provider=' + encodeURIComponent(provName));
          const data = await r.json();
          if (data && data.preset) {
            setField((cur) => {
              const providers = [...(cur.providers ?? [])];
              const ent = { ...providers[pIndex] };
              if (data.preset.rpmLimit) ent.rpmLimit = data.preset.rpmLimit;
              if (data.preset.tpmLimit) ent.tpmLimit = data.preset.tpmLimit;
              providers[pIndex] = ent;
              return { ...cur, providers };
            });
            setPresetNotice(t('presetApplied').replace('{prov}', provName).replace('{rpm}', String(data.preset.rpmLimit)).replace('{tpm}', String(data.preset.tpmLimit)));
            setTimeout(() => setPresetNotice(''), 4000);
          } else {
            setPresetNotice(t('presetNone'));
            setTimeout(() => setPresetNotice(''), 3000);
          }
        } catch (err) {
          setPresetNotice(String(err?.message || err));
          setTimeout(() => setPresetNotice(''), 3000);
        }
      };
      const [validationResult, setValidationResult] = React.useState({});
      const validateBeforeSave = (ref, value) => {
        setValidating(ref);
        return fetch('/dsh-key-rotation/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref, value }),
          signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(30000) : undefined,
        })
          .then(async (r) => {
            const data = (await r.json().catch(() => null)) ?? {};
            const resData = !r.ok && data.error
              ? { ok: false, code: data.error.code, message: data.error.message }
              : { ok: r.ok, ...data };
            setValidationResult((m) => ({ ...m, [ref]: resData }));
            return resData;
          })
          .catch((e) => ({ ok: false, message: String(e?.message ?? e) }))
          .finally(() => setValidating(''));
      };
      const saveSecret = async (ref, rowKey) => {
        const value = secretDraft[rowKey];
        if (!value || secretWritesRef.current.has(ref)) return;
        secretWritesRef.current.add(ref);
        try {
        setSecretError('');
        // Pre-save validation (issue #118)
        setValidating(ref);
        const vres = await validateBeforeSave(ref, value);
        setValidating('');
        if (vres && vres.ok === false && vres.code === 'no-credential') {
          // No credential yet is fine for a new key being saved
        } else if (vres && !vres.ok) {
          const msg = vres.message ?? vres.error?.message ?? 'validation failed';
          setSecretError(t('keyWriteFailed').replace('{msg}', msg));
          return;
        }
        await fetch('/dsh-key-rotation/key', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref, value }),
          signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(15000) : undefined,
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) throw new Error(data?.error?.message ?? 'unknown error');
            // (issue 200) leak-detector hint: stored value does not match any known
            // API-key shape - probably a placeholder or a typo.
            if (data?.looksLikeSecret === false) {
              setSecretError(t('notSecretShape'));
            }
            setSecretDraft((cur) => {
              const next = { ...cur };
              if (next[rowKey] === value) delete next[rowKey];
              return next;
            });
          })
          .catch((e) => setSecretError(t('keyWriteFailed').replace('{msg}', String(e?.message ?? e))));
        } finally { secretWritesRef.current.delete(ref); }
      };
      // (issue 290): explicit card states — loading / error / unavailable / empty / ready
      if (state.status === 'loading' || (!val && state.status !== 'error' && state.status !== 'unavailable')) {
        return React.createElement('div', { className: 'krot-state-block', role: 'status', 'aria-live': 'polite', style: { padding: '18px 4px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 } }, t('loading')),
          React.createElement('div', {
            className: 'krot-skeleton',
            'aria-hidden': 'true',
            style: {
              height: 10, borderRadius: 999, background: 'linear-gradient(90deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-3), var(--dsw-alias-bg-layer-2))',
              backgroundSize: '200% 100%', animation: 'krot-shimmer 1.2s ease-in-out infinite', maxWidth: 280,
            },
          })
        );
      }
      if (state.status === 'error' && !val) {
        return React.createElement('div', { className: 'krot-state-block', role: 'alert', style: { padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' } },
          React.createElement('p', { className: 'krot-err', style: { margin: 0 } }, t('errorTitle') + (state.error ? (': ' + state.error) : '')),
          React.createElement('button', { type: 'button', className: 'krot-btn', onClick: () => load() }, t('retry'))
        );
      }
      if (state.status === 'unavailable' || !settingsScope) {
        return React.createElement('div', { className: 'krot-state-block', role: 'status', style: { padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '6px' } },
          React.createElement('p', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: 0 } }, t('unavailableTitle')),
          React.createElement('p', { className: 'krot-hint', style: { margin: 0 } }, t('unavailableDesc'))
        );
      }

      const providers = catalog.providers;
      const providerById = new Map(providers.map((p) => [p.id, p.name]));

      const setField = (fn, fromImport = false) => {
        if (!mountedRef.current || saveInFlightRef.current || (importRef.current && !fromImport)
          || !stateRef.current.writable) return;
        const current = draftRef.current ?? stateRef.current.value;
        if (!current) return;
        const next = fn(current);
        if (sameJson(current, next)) return;
        if (!draftBaseRef.current) {
          draftBaseRef.current = { value: structuredClone(current), revision: stateRef.current.revision,
            source: bindingRef.current.service };
        }
        const unchanged = sameJson(draftBaseRef.current.value, next);
        if (unchanged) draftBaseRef.current = null;
        draftRef.current = unchanged ? null : next;
        setDraft(draftRef.current);
        updateState((s) => ({ ...s, error: '' }));
      };
      const clearDraft = () => {
        editEpochRef.current++;
        draftBaseRef.current = null;
        draftRef.current = null;
        setDraft(null);
        setUndo(null);
        setSelected(new Set());
        if (undoTimer.current) clearTimeout(undoTimer.current);
      };
      const readImport = (file, stage) => {
        if (!file || saveInFlightRef.current || importRef.current || !stateRef.current.writable) return;
        if (file.size > 1024 * 1024) { setSecretError('Import file exceeds 1 MiB'); return; }
        const epoch = editEpochRef.current;
        const source = bindingRef.current.service;
        importRef.current = true;
        setImporting(true);
        const reader = new FileReader();
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          importCancelRef.current = null;
          importRef.current = false;
          if (mountedRef.current) setImporting(false);
        };
        const timeout = setTimeout(() => {
          if (mountedRef.current) setSecretError('Import file read timed out');
          finish(); reader.abort?.();
        }, 15000);
        importCancelRef.current = () => { finish(); reader.abort?.(); };
        reader.onload = () => {
          if (finished) return;
          try {
            if (!mountedRef.current || epoch !== editEpochRef.current || source !== bindingRef.current.service) return;
            const value = JSON.parse(String(reader.result));
            requireJson(value);
            stage(value);
          } catch (error) {
            if (mountedRef.current) setSecretError(String(error?.message ?? error));
          } finally { finish(); }
        };
        reader.onerror = reader.onabort = () => { if (mountedRef.current) setSecretError('Could not read the import file'); finish(); };
        try { reader.readAsText(file); }
        catch (error) { if (mountedRef.current) setSecretError(String(error?.message ?? error)); finish(); }
      };
      const providerList = (Array.isArray(val.providers) ? val.providers : [])
        .map((entry, pIndex) => ({ entry, pIndex }))
        .filter(({ entry }) => entry && typeof entry.provider === 'string')
        .filter(({ entry }) => !search || entry.provider.toLowerCase().includes(search.toLowerCase()));

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
        // keep weights aligned with keys (#215): new key gets default weight 1
        for (const [field, fallback] of [['weights', 1], ['expiresAt', 0], ['paused', false], ['revoked', false]]) {
          if (Array.isArray(entry[field]) && entry[field].length) entry[field] = Array.from({ length: entry.keys.length }, (_, i) => entry[field][i] ?? fallback);
        }
        providers[pIndex] = entry;
        return { ...cur, providers };
      });
      const removeKey = (pIndex, kIndex) => setField((cur) => {
        const next = [...(cur.providers ?? [])];
        const entry = next[pIndex];
        if (!entry || !entry.keys[kIndex]) return cur;
        stashUndo({ type: 'key', provider: entry.provider, kIndex, key: entry.keys[kIndex],
          weights: entry.weights?.[kIndex], expiresAt: entry.expiresAt?.[kIndex],
          paused: entry.paused?.[kIndex], revoked: entry.revoked?.[kIndex] });
        next[pIndex] = reorderKeys(entry, entry.keys.map((_, index) => index).filter(index => index !== kIndex));
        return { ...cur, providers: next };
      });
      const removeProvider = (pIndex) => setField((cur) => {
        const arr = Array.isArray(cur.providers) ? cur.providers : [];
        stashUndo({ type: 'provider', index: pIndex, entry: arr[pIndex] });
        return { ...cur, providers: arr.filter((_, i) => i !== pIndex) };
      });
      // Key order is attempt order — move it with buttons, do not retype names.
      const moveKey = (pIndex, kIndex, delta) => setField((cur) => {
        const providers = [...(cur.providers ?? [])];
        const entry = providers[pIndex];
        if (!entry) return cur;
        const order = entry.keys.map((_, index) => index);
        const target = kIndex + delta;
        if (target < 0 || target >= order.length) return cur;
        [order[kIndex], order[target]] = [order[target], order[kIndex]];
        providers[pIndex] = reorderKeys(entry, order);
        return { ...cur, providers };
      });
      // (issue 215): set a single key's round-robin weight (integer >= 1)
      const setKeyWeight = (pIndex, kIndex, weight) => setField((cur) => {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(weight) || 1)));
        const providers = [...(cur.providers ?? [])];
        const entry = { ...(providers[pIndex] ?? {}) };
        const weights = [...(entry.weights ?? [])];
        while (weights.length < (entry.keys ?? []).length) weights.push(1);
        weights[kIndex] = n;
        entry.weights = weights;
        providers[pIndex] = entry;
        return { ...cur, providers };
      });

      // Config codes missing from the known list still render as checked items;
      // otherwise the checkboxes would silently drop a custom rule on first save.
      const selectedCodes = new Set(Array.isArray(val.switchCodes) ? val.switchCodes : []);
      const codeList = [...KNOWN_CODES, ...[...selectedCodes].filter((c) => !KNOWN_CODES.includes(c))];
      const toggleCode = (code, on) => setField((cur) => {
        const current = new Set(Array.isArray(cur.switchCodes) ? cur.switchCodes : []);
        if (on) current.add(code); else current.delete(code);
        return { ...cur, switchCodes: codeList.filter((c) => current.has(c)) };
      });

      const addProvider = () => setField((cur) => ({
        ...cur,
        providers: [...(Array.isArray(cur.providers) ? cur.providers : []), { provider: '', keys: [] }],
      }));

      // ── per-model sub-pools + token quotas ──
      const setModels = (pIndex, mutate) => setField((cur) => {
        const providers = [...(cur.providers ?? [])];
        const entry = { ...(providers[pIndex] ?? {}) };
        const models = { ...(entry.models && !Array.isArray(entry.models) ? entry.models : {}) };
        mutate(models);
        if (Object.keys(models).length === 0) delete entry.models;
        else entry.models = models;
        providers[pIndex] = entry;
        return { ...cur, providers };
      });

      const addModel = (pIndex) => setModels(pIndex, (models) => {
        let name = 'model';
        let n = 2;
        while (Object.prototype.hasOwnProperty.call(models, name)) name = 'model-' + n++;
        const seedKeys = ((draftRef.current ?? stateRef.current.value)?.providers ?? [])[pIndex]?.keys ?? [];
        models[name] = { keys: [...seedKeys] };
      });

      const renameModel = (pIndex, from, to) => setModels(pIndex, (models) => {
        const id = String(to ?? '');
        if (id === from || !isValidModelId(id)) return;
        if (Object.prototype.hasOwnProperty.call(models, id)) return;
        const rebuilt = {};
        for (const [key, value] of Object.entries(models)) rebuilt[key === from ? id : key] = value;
        for (const key of Object.keys(models)) delete models[key];
        Object.assign(models, rebuilt);
      });

      const removeModel = (pIndex, model) => setModels(pIndex, (models) => {
        delete models[model];
      });

      const toggleModelKey = (pIndex, model, ref, on) => setModels(pIndex, (models) => {
        const mp = { ...(models[model] ?? {}) };
        const keys = Array.isArray(mp.keys) ? [...mp.keys] : [];
        const index = keys.indexOf(ref);
        if (on && index < 0) keys.push(ref);
        if (!on && index >= 0) keys.splice(index, 1);
        mp.keys = keys;
        if (!on) {
          const limits = quotaMapOf(mp);
          delete limits[ref];
          models[model] = withQuotas(mp, limits);
        } else {
          models[model] = mp;
        }
      });

      const setModelTokenLimit = (pIndex, model, ref, raw) => setModels(pIndex, (models) => {
        const mp = { ...(models[model] ?? {}) };
        const limits = quotaMapOf(mp);
        const text = String(raw ?? '').trim();
        if (text === '') delete limits[ref];
        else {
          const num = Number(text);
          if (!Number.isFinite(num) || num <= 0) delete limits[ref];
          else limits[ref] = Math.floor(num);
        }
        models[model] = withQuotas(mp, limits);
      });

      const reorderModelKeys = (pIndex, model, delta, kIndex) => setModels(pIndex, (models) => {
        const mp = { ...(models[model] ?? {}) };
        const keys = Array.isArray(mp.keys) ? [...mp.keys] : [];
        const target = kIndex + delta;
        if (target < 0 || target >= keys.length) return;
        const order = keys.map((_, i) => i);
        [order[kIndex], order[target]] = [order[target], order[kIndex]];
        models[model] = reorderKeys(mp, order);
      });

      const save = async () => {
        const savingDraft = draftRef.current;
        const base = draftBaseRef.current;
        if (!savingDraft || !base || saveInFlightRef.current || importRef.current) return;
        if (!stateRef.current.writable || bindingRef.current.service !== base.source) {
          updateState((s) => ({ ...s, error: t('settingsChanged') }));
          return;
        }
        const expectedRevision = base.revision;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          updateState((s) => ({ ...s, error: t('settingsChanged') }));
          return;
        }
        let ops;
        try {
          ops = changedSettingsOps(base.value, savingDraft); requireJson(ops);
          if (ops.some(op => op.path[0] === 'providers')) validatePoolDraft(savingDraft.providers);
        }
        catch (error) { updateState((s) => ({ ...s, error: error.message })); return; }
        if (!ops.length) { clearDraft(); return; }
        saveInFlightRef.current = true;
        setSaving(true);
        editEpochRef.current++;
        readRef.current.generation++;
        readRef.current.controller?.abort();
        updateState((s) => ({ ...s, error: '' }));
        const controller = new AbortController();
        saveControllerRef.current = controller;
        let timeout;
        try {
          const expired = new Promise((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error(t('saveUnconfirmed')));
            }, 15000);
          });
          const operation = async () => {
            if (settingsContract === 'configForm' && typeof base.source.mutate === 'function') {
              const accepted = await base.source.mutate(ops, expectedRevision);
              if (accepted !== true) throw new Error(t('saveRefused'));
              const committed = base.source.getSnapshot();
              // Shared native queues can settle before publishing this write's
              // snapshot. Confirm an older/absent snapshot through the bridge.
              if (committed?.status === 'ready' && committed.revision > expectedRevision) return committed;
              return settingsResponse(await fetch(CONFIG_PATH, { headers: { accept: 'application/json' }, signal: controller.signal }));
            }
            // Legacy client mutate resolves void on BOTH success and refusal.
            // Host-side mutate, reached through this bridge, throws on refusal.
            return settingsResponse(await fetch(CONFIG_PATH, {
              method: 'PUT', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ops, expectedRevision }), signal: controller.signal,
            }));
          };
          const committed = await Promise.race([operation(), expired]);
          if (!mountedRef.current) return;
          if (bindingRef.current.service !== base.source) throw new Error(t('saveUnconfirmed'));
          if (committed?.available === false || committed?.status === 'unavailable'
            || !committed?.value || !Number.isSafeInteger(committed.revision)
            || committed.revision < expectedRevision) throw new Error(t('saveUnconfirmed'));
          acceptSnapshot(committed, base.source);
          clearDraft();
        } catch (error) {
          if (mountedRef.current) updateState((s) => ({ ...s, status: s.value ? 'ready' : 'error', error: String(error?.message ?? error) }));
        } finally {
          clearTimeout(timeout);
          saveInFlightRef.current = false;
          if (saveControllerRef.current === controller) saveControllerRef.current = null;
          if (mountedRef.current) setSaving(false);
        }
      };

      const field = (labelText, node) => h('label', { className: 'krot-field' },
        h('span', { className: 'krot-label' }, labelText), node);

      const textInput = (value, onChange, placeholder) => h('input', {
        className: 'krot-in',
        value: value ?? '',
        onChange: (e) => onChange(e.target.value),
        placeholder,
      });

      const btn = (labelText, onClick, opts = {}) => {
        const { primary, className = '', ...rest } = opts;
        return h('button', { type: 'button', ...rest,
          className: 'krot-btn' + (primary ? ' krot-save' : '') + (className ? ' ' + className : ''),
          onClick, disabled: Boolean(rest.disabled),
        }, labelText);
      };

      // Key state dot: color and label read at a glance; "key not found"
      // catches an env-name typo that would otherwise stay silent.
      const keyStatus = (providerId, ref, isPaused = false) => {
        if (isPaused) return { color: 'var(--dsw-alias-state-warn-primary)', text: t('keyPaused'), ready: false, paused: true };
        const hit = keyInfo(providerId, ref);
        if (!hit) return null;
        if (hit.authPaused || hit.pauseReason === 'AUTH_FAILURE_PAUSED') return { color: 'var(--dsw-alias-state-error-primary)', text: t('keyAuthPaused'), ready: false, authPaused: true };
        if (hit.paused) return { color: 'var(--dsw-alias-state-warn-primary)', text: t('keyPaused'), ready: false, paused: true };
        if (hit.expired) return { color: 'var(--dsw-alias-state-error-primary)', text: t('keyExpired'), ready: false, expired: true };
        if (hit.broken || hit.revoked || hit.status === 'revoked') return { color: 'var(--dsw-alias-state-error-primary)', text: t('keyRevoked'), ready: false, revoked: true };
        if (!hit.present) return { color: 'var(--dsw-alias-state-error-primary)', text: t('keyMissing'), ready: false, missing: true };
        if (hit.cooldownMsLeft > 0) {
          if (optimisticReset && ref in optimisticReset) {
            delete optimisticReset[ref];
          }
          return {
            color: 'var(--dsw-alias-state-warn-primary)',
            text: t('keyCooling').replace('{s}', String(Math.ceil(hit.cooldownMsLeft / 1000))),
            ready: false,
            cooling: true,
          };
        }
        if (hit.expiresAt && !hit.expired) {
          const days = Math.ceil((hit.expiresAt - Date.now()) / 86400000);
          const warnDays = Number(val?.expiryWarnDays) || 7;
          if (days <= warnDays) return { color: 'var(--dsw-alias-state-warn-primary)', text: t('keyExpiringSoon').replace('{n}', String(days)), ready: true, expiringSoon: true };
        }
        if (hit.active) return { color: 'var(--dsw-alias-state-success-primary)', text: t('keyActive'), ready: true, active: true };
        return { color: 'var(--dsw-alias-label-tertiary)', text: t('keyReady'), ready: true };
      };

