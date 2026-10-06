    function KeyRotationSection(props) {
      const t = resolveT(props);
      const settingsBinding = React.useSyncExternalStore(
        props.settingsSource.subscribe, props.settingsSource.getSnapshot
      );
      const settingsScope = settingsBinding.service;
      const settingsContract = settingsBinding.kind;
      const bindingRef = React.useRef(settingsBinding);
      bindingRef.current = settingsBinding;
      // (issue 273): getSnapshot must be referentially stable or React 18 unmounts the tree
      const scopeCacheRef = React.useRef({ has: false, value: null });
      const getScopeSnapshot = React.useCallback(() => {
        if (!settingsScope || typeof settingsScope.getSnapshot !== 'function') return null;
        let next = null;
        try {
          next = settingsScope.getSnapshot();
        } catch (_) {
          return null;
        }
        const prev = scopeCacheRef.current;
        if (prev.service !== settingsScope) prev.has = false;
        if (prev.has && Object.is(prev.value, next)) return prev.value;
        // shallow-compare common snapshot shape to avoid identity thrash
        if (prev.has && prev.value && next
          && Object.keys(prev.value).length === Object.keys(next).length
          && Object.keys(next).every((key) => Object.is(prev.value[key], next[key]))) {
          return prev.value;
        }
        scopeCacheRef.current = { has: true, value: next, service: settingsScope };
        return next;
      }, [settingsScope]);
      const scopeSnapshot = React.useSyncExternalStore(
        React.useMemo(() => (cb) => (settingsScope && typeof settingsScope.subscribe === 'function' ? settingsScope.subscribe(cb) : () => {}), [settingsScope]),
        getScopeSnapshot
      );
      const [state, setState] = React.useState({ status: 'loading', value: null, revision: undefined, writable: false, error: '', providers: [] });
      const stateRef = React.useRef(state);
      const updateState = React.useCallback((update) => {
        const next = typeof update === 'function' ? update(stateRef.current) : update;
        stateRef.current = next;
        setState(next);
      }, []);
      const catalog = useProviderCatalog(Boolean(settingsScope) && scopeSnapshot?.mode !== 'memory');
      const latestScopeSnapshot = React.useRef(scopeSnapshot);
      latestScopeSnapshot.current = scopeSnapshot;
      const [draft, setDraft] = React.useState(null);
      const draftRef = React.useRef(null);
      const draftBaseRef = React.useRef(null);
      const saveInFlightRef = React.useRef(false);
      const [saving, setSaving] = React.useState(false);
      const [importing, setImporting] = React.useState(false);
      const importRef = React.useRef(false);
      const importCancelRef = React.useRef(null);
      const editEpochRef = React.useRef(0);
      const mountedRef = React.useRef(true);
      const readRef = React.useRef({ generation: 0, controller: null });
      const saveControllerRef = React.useRef(null);
      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          editEpochRef.current++;
          readRef.current.generation++;
          readRef.current.controller?.abort();
          saveControllerRef.current?.abort();
          importCancelRef.current?.();
        };
      }, []);
      // ── all hooks live ABOVE any early return (React error 310 otherwise) ──
      const [search, setSearch] = React.useState('');
      const [statusFilter, setStatusFilter] = React.useState('all');
      const [confirmModal, setConfirmModal] = React.useState(null);
      const [optimisticReset, setOptimisticReset] = React.useState({});
      const [selected, setSelected] = React.useState(new Set());
      const [bulkCooldown, setBulkCooldown] = React.useState('');
      const [undo, setUndo] = React.useState(null);
      const [bulkOpen, setBulkOpen] = React.useState({});
      const [bulkText, setBulkText] = React.useState({});

      const togglePauseKey = (pIndex, kIndex) => setField((cur) => {
        const providers = [...(cur.providers ?? [])];
        const ent = { ...providers[pIndex] };
        const paused = [...(ent.paused ?? [])];
        paused[kIndex] = !paused[kIndex];
        ent.paused = paused;
        providers[pIndex] = ent;
        return { ...cur, providers };
      });

      const applyBulkImport = (pIndex) => {
        const text = bulkText[pIndex] || '';
        const parsed = parseBulkKeys(text);
        if (!parsed.length) return;
        setField((cur) => {
          const providers = [...(cur.providers ?? [])];
          const ent = { ...providers[pIndex] };
          const existingKeys = new Set(ent.keys ?? []);
          const nextKeys = [...(ent.keys ?? [])];
          const nextWeights = [...(ent.weights ?? [])];
          const nextPaused = [...(ent.paused ?? [])];
          for (const item of parsed) {
            if (!existingKeys.has(item.ref)) {
              existingKeys.add(item.ref);
              nextKeys.push(item.ref);
              nextWeights.push(item.weight);
              nextPaused.push(false);
            }
          }
          ent.keys = nextKeys;
          ent.weights = nextWeights;
          ent.paused = nextPaused;
          providers[pIndex] = ent;
          return { ...cur, providers };
        });
        setBulkText((cur) => ({ ...cur, [pIndex]: '' }));
        setBulkOpen((cur) => ({ ...cur, [pIndex]: false }));
      };
      const undoTimer = React.useRef(null);
      React.useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
      // (issue 289) a11y: confirm dialog focus trap / Escape / restore (hooks above returns)
      const modalReturnFocusRef = React.useRef(null);
      const modalCardRef = React.useRef(null);
      React.useEffect(() => {
        if (!confirmModal) return undefined;
        modalReturnFocusRef.current = typeof document !== 'undefined' ? document.activeElement : null;
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setConfirmModal(null);
            return;
          }
          if (e.key !== 'Tab' || !modalCardRef.current) return;
          const focusables = modalCardRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        };
        document.addEventListener('keydown', onKey, true);
        const id = requestAnimationFrame(() => {
          if (!modalCardRef.current) return;
          const cancelBtn = modalCardRef.current.querySelector('[data-krot-modal-cancel]');
          (cancelBtn || modalCardRef.current.querySelector('button'))?.focus();
        });
        return () => {
          document.removeEventListener('keydown', onKey, true);
          cancelAnimationFrame(id);
          const prev = modalReturnFocusRef.current;
          if (prev && typeof prev.focus === 'function') {
            bestEffort('modal.returnFocus', () => { prev.focus(); });
          }
        };
      }, [confirmModal]);
      const testRunRef = React.useRef(false);
      const [testing, setTesting] = React.useState('');
      const [testResult, setTestResult] = React.useState({});
      const [testAllProvider, setTestAllProvider] = React.useState('');
      const [testingProgress, setTestingProgress] = React.useState({});
      const [secretDraft, setSecretDraft] = React.useState({});
      const [secretError, setSecretError] = React.useState('');
      const secretWritesRef = React.useRef(new Set());
      const stashUndo = (u) => { setUndo(u); if (undoTimer.current) clearTimeout(undoTimer.current); undoTimer.current = setTimeout(() => setUndo(null), 5000); };
      const doUndo = () => {
        if (!undo || saveInFlightRef.current || importRef.current || !stateRef.current.writable) return;
        const u = undo;
        setField((cur) => {
          const providers = [...(cur.providers ?? [])];
          if (u.type === 'provider') {
            if (providers.some(p => p.provider === u.entry.provider)) return cur;
            providers.splice(Math.min(u.index, providers.length), 0, u.entry);
          } else {
            // Other providers may have been removed or re-ordered since Undo
            // was staged. Identity, not the old displayed index, selects it.
            const index = providers.findIndex(p => p.provider === u.provider);
            if (index < 0 || providers[index].keys.includes(u.key)) return cur;
            const entry = { ...providers[index] };
            const at = Math.min(u.kIndex, entry.keys.length);
            entry.keys = [...entry.keys]; entry.keys.splice(at, 0, u.key);
            for (const [field, fallback] of [['weights', 1], ['expiresAt', 0], ['paused', false], ['revoked', false]]) {
              if (u[field] !== undefined || entry[field]?.length) {
                const values = Array.from({ length: entry.keys.length - 1 }, (_, i) => entry[field]?.[i] ?? fallback);
                values.splice(at, 0, u[field] ?? fallback); entry[field] = values;
              }
            }
            providers[index] = entry;
          }
          return { ...cur, providers };
        });
        setUndo(null);
      };
      // Both buttons must run the same live probe, never a presence-only check.
      // Serialize probes: a large pool must not burst /models requests. The ref
      // also guards repeated clicks before React has rendered disabled buttons.
      const runKeyTests = async (refs, providerId = '') => {
        if (testRunRef.current || refs.length === 0) return;
        testRunRef.current = true;
        setTestAllProvider(providerId);
        setTestResult((m) => {
          const next = { ...m };
          for (const ref of refs) next[ref] = null;
          return next;
        });
        if (providerId) setTestingProgress((m) => ({ ...m, [providerId]: '0/' + refs.length }));
        try {
          let completed = 0;
          for (const ref of refs) {
            setTesting(ref);
            let result;
            try {
              const response = await fetch('/dsh-key-rotation/test', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ref, probe: 'models' }),
              });
              const data = await response.json();
              if (!response.ok) {
                result = { ok: false, code: data?.error?.code || ('http-' + response.status),
                  message: data?.error?.message || data?.message };
              } else if (typeof data?.ok !== 'boolean') {
                result = { ok: false, code: 'invalid-response' };
              } else {
                result = data;
              }
            } catch (e) {
              result = { ok: false, code: 'error', message: String(e?.message ?? e) };
            }
            setTestResult((m) => ({ ...m, [ref]: result }));
            completed++;
            if (providerId) setTestingProgress((m) => ({ ...m, [providerId]: completed + '/' + refs.length }));
          }
        } finally {
          setTesting('');
          setTestAllProvider('');
          testRunRef.current = false;
        }
      };
      const doTest = (ref) => runKeyTests([ref]);
      const doTestAll = (providerId) => {
        if (!val || !Array.isArray(val.providers)) return;
        const entry = val.providers.find((p) => p.provider === providerId);
        if (!entry || !Array.isArray(entry.keys)) return;
        const refs = [...new Set(entry.keys.filter((k) => typeof k === 'string' && k.trim().length > 0))];
        return runKeyTests(refs, providerId);
      };

      const acceptSnapshot = React.useCallback((snapshot, source) => {
        if (!mountedRef.current || bindingRef.current.service !== source) return;
        if (!snapshot || snapshot.status === 'unavailable' || snapshot.mode === 'memory'
          || snapshot.available === false) {
          updateState((s) => ({ ...s, status: 'unavailable', writable: false, source }));
          return;
        }
        if (!snapshot.value || typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)
          || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
          throw new Error('Invalid settings snapshot or revision');
        }
        updateState((s) => {
          if (s.source === source && Number.isSafeInteger(s.revision) && s.revision > snapshot.revision) return s;
          return { ...s, status: 'ready', value: snapshot.value, revision: snapshot.revision,
            writable: snapshot.writable === true, source };
        });
      }, [updateState]);

      const load = React.useCallback(async (force = false) => {
        const source = bindingRef.current.service;
        const snapshot = latestScopeSnapshot.current;
        const generation = ++readRef.current.generation;
        readRef.current.controller?.abort();
        if (!source || snapshot?.status === 'unavailable' || snapshot?.mode === 'memory') {
          acceptSnapshot(null, source);
          return;
        }
        updateState((s) => ({ ...s, error: '' }));
        if (!force && snapshot?.status === 'ready') {
          try { acceptSnapshot(snapshot, source); }
          catch (error) { updateState((s) => ({ ...s, status: s.value ? 'ready' : 'error', error: error.message })); }
          return;
        }
        const controller = new AbortController();
        readRef.current.controller = controller;
        const timeout = setTimeout(() => controller.abort(), 15000);
        updateState((s) => ({ ...s, status: s.value ? s.status : 'loading' }));
        try {
          const data = await settingsResponse(await fetch(CONFIG_PATH, {
            headers: { accept: 'application/json' }, signal: controller.signal,
          }));
          if (controller.signal.aborted || generation !== readRef.current.generation || !mountedRef.current) return;
          acceptSnapshot(data, source);
        } catch (error) {
          if (generation !== readRef.current.generation || !mountedRef.current) return;
          updateState((s) => ({ ...s, status: s.value ? 'ready' : 'error', error: String(error?.message ?? error) }));
        } finally {
          clearTimeout(timeout);
          if (readRef.current.controller === controller) readRef.current.controller = null;
        }
      }, [acceptSnapshot, updateState]);

      React.useEffect(() => {
        readRef.current.generation++;
        readRef.current.controller?.abort();
        if (!settingsScope || scopeSnapshot?.status === 'unavailable' || scopeSnapshot?.mode === 'memory') {
          acceptSnapshot(null, settingsScope);
        } else if (scopeSnapshot?.status === 'ready') {
          try { acceptSnapshot(scopeSnapshot, settingsScope); }
          catch (error) { updateState((s) => ({ ...s, status: s.value ? 'ready' : 'error', error: error.message })); }
        } else {
          void load();
        }
      }, [settingsScope, scopeSnapshot, load, acceptSnapshot, updateState]);

      const val = draft ?? state.value;
      const status = useRotationStatus();
      const probeCache = useProbeCache();
      const [resetting, setResetting] = React.useState('');
      const doReset = (providerId) => {
        setResetting(providerId);
        setSecretError('');
        const provEntry = val?.providers?.find((p) => p.provider === providerId);
        if (provEntry && Array.isArray(provEntry.keys)) {
          setOptimisticReset((cur) => {
            const next = { ...cur };
            provEntry.keys.forEach((k) => { next[k] = true; });
            return next;
          });
        }
        fetch('/dsh-key-rotation/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: providerId }), signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(15000) : undefined })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => { if (!ok) throw new Error(data?.error?.message ?? 'unknown error'); })
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

      const searchInput = h('input', { className: 'krot-in', placeholder: 'Search providers…', value: search, onChange: (e) => setSearch(e.target.value), style: { marginBottom: '8px' } });
      const providerRows = providerList.map(({ entry, pIndex }) => {
        const options = [h('option', { key: '', value: '' }, t('chooseProvider'))];
        if (entry.provider && !providerById.has(entry.provider)) {
          options.push(h('option', { key: entry.provider, value: entry.provider }, entry.provider + ' (' + (catalog.status === 'ready' ? t('notRegistered')
            : catalog.status === 'loading' ? t('loading') : t('providerCatalogUnavailable')) + ')'));
        }
        options.push(...providers.map((prov) =>
          h('option', { key: prov.id, value: prov.id }, prov.name + (prov.id !== prov.name ? ' — ' + prov.id : ''))));

        const keys = entry.keys ?? [];
        const entryWeights = entry.weights ?? [];
        const entryPaused = entry.paused ?? [];

        let readyCount = 0, cooldownCount = 0, errorCount = 0;
        for (let idx = 0; idx < keys.length; idx++) {
          const k = keys[idx];
          const st = keyStatus(entry.provider, k, Boolean(entryPaused[idx]));
          const isCool = (st && st.cooling) && !optimisticReset[k];
          const tr = testResult[k];
          if (tr && !tr.ok) errorCount++;
          if (isCool) cooldownCount++;
          if (st && st.ready) readyCount++;
        }

        const filteredIndices = keys.map((k, idx) => ({ key: k, kIndex: idx })).filter(({ key: k, kIndex: idx }) => {
          if (statusFilter === 'all') return true;
          const st = keyStatus(entry.provider, k, Boolean(entryPaused[idx]));
          const isCool = (st && st.cooling) && !optimisticReset[k];
          const tr = testResult[k];
          if (statusFilter === 'ready') return Boolean(st && st.ready);
          if (statusFilter === 'cooldown') return isCool;
          if (statusFilter === 'error') return tr && !tr.ok;
          return true;
        });

        const filterBar = keys.length > 1 ? h('div', { className: 'krot-filter-bar' },
          h('button', { type: 'button', className: 'krot-pill' + (statusFilter === 'all' ? ' krot-pill-active' : ''), onClick: () => setStatusFilter('all') }, t('filterAll') + ' (' + keys.length + ')'),
          h('button', { type: 'button', className: 'krot-pill' + (statusFilter === 'ready' ? ' krot-pill-active' : ''), onClick: () => setStatusFilter('ready') }, t('filterReady') + ' (' + readyCount + ')'),
          cooldownCount > 0 ? h('button', { type: 'button', className: 'krot-pill krot-pill-warn' + (statusFilter === 'cooldown' ? ' krot-pill-active' : ''), onClick: () => setStatusFilter('cooldown') }, t('filterCooldown') + ' (' + cooldownCount + ')') : null,
          errorCount > 0 ? h('button', { type: 'button', className: 'krot-pill krot-pill-err' + (statusFilter === 'error' ? ' krot-pill-active' : ''), onClick: () => setStatusFilter('error') }, t('filterErrors') + ' (' + errorCount + ')') : null,
        ) : null;

        const keyRows = filteredIndices.map(({ key, kIndex }) => {
          const isP = Boolean(entryPaused[kIndex]);
          const st = keyStatus(entry.provider, key, isP);
          const info = keyInfo(entry.provider, key);
          const rowKey = entry.provider + '/' + key;
          const typed = secretDraft[rowKey];
          const fromEnv = Boolean(info && info.source === 'env');

          // Key name owns a full row so neighbouring keys stay distinguishable.
          const nameRow = [
            h('span', { className: 'krot-num', key: 'n' }, String(kIndex + 1)),
            h('span', { key: 'i', className: 'krot-name', title: key + ' (click to copy)', style: { cursor: 'copy' }, onClick: () => {
              if (navigator.clipboard) navigator.clipboard.writeText(key).then(() => setSecretDraft((cur) => ({ ...cur, ['copied:' + key]: true }))).catch(() => {});
              setTimeout(() => setSecretDraft((cur) => ({ ...cur, ['copied:' + key]: false })), 1500);
            } },
              t('keyLabel').replace('{n}', String(kIndex + 1)),
              h('span', null, secretDraft['copied:' + key] ? ' ✓' : '')),
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
            if (typed) meta.push(btn('✓', () => saveSecret(key, rowKey), { title: t('keySave'), key: 'save-secret' }));
          }
          if (info && typeof info.usage === 'number' && info.usage > 0) {
            let tip = 'requests through this key';
            if (info.byModel && Object.keys(info.byModel).length > 0) {
              tip = Object.entries(info.byModel).map(([m, c]) => m + ': ' + c).join('\n');
            }
            meta.push(h('span', { key: 'u', className: 'krot-tail', title: tip }, String(info.usage)));
            if (info.usageDays && Object.keys(info.usageDays).length > 0) {
              const days = Object.entries(info.usageDays);
              const max = Math.max(1, ...days.map(([, c]) => c));
              meta.push(h('span', { key: 'g', className: 'krot-graph', title: days.map(([d, c]) => d + ': ' + c).join('\n'), style: { display: 'inline-flex', gap: '1px', alignItems: 'flex-end', height: '12px' } },
                days.slice(-14).map(([d, c]) => h('span', { key: d, style: { width: '3px', height: Math.max(2, (c / max) * 12) + 'px', background: 'var(--dsw-alias-state-success-primary)', borderRadius: '1px' } }))
              ));
            }
          }
          if (info && info.lastUsedAt) meta.push(h('span', { key: 'lu', className: 'krot-tail', title: 'last used' }, formatAgo((k)=>t(k), info.lastUsedAt)));
          // (issue 215): per-key weight input (default 1)
          meta.push(h('input', { key: 'w', type: 'number', min: 1, max: 1000, className: 'krot-in krot-weight',
            value: (entryWeights[kIndex] ?? info?.weight ?? 1),
            title: t('weightHint'),
            onChange: (e) => setKeyWeight(pIndex, kIndex, e.target.value),
            style: { width: '52px', padding: '2px 6px', fontSize: '12px' } }));
          meta.push(h('button', {
            key: 'pause-btn',
            type: 'button',
            className: 'krot-btn' + (isP ? ' krot-pill-warn' : ''),
            title: isP ? t('resumeKey') : t('pauseKey'),
            style: { padding: '2px 6px', fontSize: '11px' },
            onClick: () => togglePauseKey(pIndex, kIndex),
          }, isP ? '⏸ ' + t('keyPaused') : '▶'));
          // (issue 210): RPM capacity indicator (only when rpmLimit is active)
          if (info && info.rpm) meta.push(h('span', { key: 'rpm', className: 'krot-tail',
            title: t('rpmTitle').replace('{u}', String(info.rpm.used)).replace('{r}', String(info.rpm.remaining)),
            style: info.rpm.remaining === 0 ? { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 700 } : undefined },
            '⏱' + info.rpm.remaining));
          // TPM capacity indicator (only when tpmLimit is active)
          if (info && info.tpm) meta.push(h('span', { key: 'tpm', className: 'krot-tail',
            title: t('tpmTitle').replace('{u}', String(info.tpm.used)).replace('{r}', String(info.tpm.remaining)),
            style: info.tpm.remaining === 0 ? { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 700 } : undefined },
            '⚡' + info.tpm.remaining));
          if (info && typeof info.cost === 'number' && info.cost > 0) meta.push(h('span', { key: 'c', className: 'krot-tail', title: 'cost' }, '$' + info.cost.toFixed(2)));
          const tr = testResult[key];
          if (tr) meta.push(h('span', { key: 'tr', className: 'krot-tail',
            title: (tr.message || (tr.ok ? t('testOk') : t('testFail')))
              + (!tr.ok && tr.code ? ' · ' + tr.code : '')
              + (tr.ok && tr.modelsCount ? ' · ' + tr.modelsCount + ' models' : '')
              + (tr.ok && tr.latencyMs ? ' · ' + tr.latencyMs + 'ms' : ''),
            style: { color: tr.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)', fontWeight: 700 } },
            tr.ok ? (tr.modelsCount ? tr.modelsCount + 'm' : '✓') : ('✕' + (tr.code ? ' ' + tr.code : ''))));
          // (issue 219): last probe from the sandbox cache, greyed when older than 24h
          else if (!Object.prototype.hasOwnProperty.call(testResult, key) && probeCache && probeCache[key]) {
            const pc = probeCache[key];
            const stale = Date.now() - (pc.at ?? 0) > 86400000;
            meta.push(h('span', { key: 'pc', className: 'krot-tail',
              title: 'last probe ' + (pc.at ? new Date(pc.at).toLocaleTimeString() : '') + (pc.ok ? ' ok' : ' ' + (pc.code ?? 'fail')),
              style: { opacity: stale ? 0.4 : 0.7, color: pc.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } },
              (pc.ok ? '✓' : '✕') + (pc.latencyMs ? ' ' + pc.latencyMs + 'ms' : '')));
          }
          meta.push(h('button', { key: 't', className: 'krot-btn', onClick: () => doTest(key), disabled: Boolean(testing || testAllProvider), title: t('testKey') }, testing === key ? '…' : t('testKey')));
          // (issue 223): broken keys get a one-click live re-test + auto-unbreak
          if (info && info.broken) {
            meta.push(h('button', { key: 'rt', className: 'krot-btn', onClick: () => retestBroken(key), title: t('retestBroken') }, t('retestBroken')));
          }
          meta.push(h('span', { key: 'a', className: 'krot-acts' },
            btn('↑', () => moveKey(pIndex, kIndex, -1), { disabled: kIndex === 0, title: t('moveUp') }),
            btn('↓', () => moveKey(pIndex, kIndex, 1), { disabled: kIndex === keys.length - 1, title: t('moveDown') }),
            btn('✕', () => removeKey(pIndex, kIndex), { title: t('removeKey') }),
          ));

          return h('div', { key, className: 'krot-key' },
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
        // (issue 208): budget line (warn color at >=80%, red at 100%)
        const budgetLine = providerStatus && (providerStatus.budgetDaily > 0 || providerStatus.budgetWeekly > 0)
          ? (() => {
              const dayRatio = providerStatus.budgetDaily > 0 ? providerStatus.todayCost / providerStatus.budgetDaily : 0;
              const weekRatio = providerStatus.budgetWeekly > 0 ? providerStatus.weeklyCost / providerStatus.budgetWeekly : 0;
              const worst = Math.max(dayRatio, weekRatio);
              const color = worst >= 1 ? 'var(--dsw-alias-state-error-primary)' : worst >= 0.8 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)';
              const parts = [];
              if (providerStatus.budgetDaily > 0) parts.push('$' + (providerStatus.todayCost ?? 0).toFixed(2) + '/' + '$' + providerStatus.budgetDaily);
              if (providerStatus.budgetWeekly > 0) parts.push('week $' + (providerStatus.weeklyCost ?? 0).toFixed(2) + '/' + '$' + providerStatus.budgetWeekly);
              if (worst >= 1 && providerStatus.pauseOnBudget) parts.push('· ' + t('pausedBudget'));
              return h('p', { className: 'krot-hint', style: { color } }, t('budgetLabel') + ' ' + parts.join(' · '));
            })()
          : null;
        // (issue 225): provider p95 latency + SLO marker
        const sloLine = providerStatus && providerStatus.p95 != null
          ? (() => {
              const over = providerStatus.latencySloMs && providerStatus.p95 > providerStatus.latencySloMs;
              return h('p', { className: 'krot-hint', style: over ? { color: 'var(--dsw-alias-state-warn-primary)' } : undefined },
                'p95 ' + providerStatus.p95 + 'ms' + (providerStatus.latencySloMs ? ' / ' + providerStatus.latencySloMs + 'ms SLO' : ''));
            })()
          : null;
        // (issue 209): CSV export for this provider's usage (last 7 days)
        const exportCsv = h('button', { className: 'krot-btn', title: t('exportCsv'),
          onClick: () => {
            const url = '/dsh-key-rotation/usage?format=csv&days=7&provider=' + encodeURIComponent(entry.provider);
            const a = document.createElement('a');
            a.href = url; a.download = 'usage-' + entry.provider + '.csv';
            document.body.appendChild(a); a.click(); a.remove();
          } }, t('exportCsv'));

                const loadChart = (() => {
          if (keys.length === 0) return null;
          const ps = status[entry.provider];
          const keyUsages = keys.map((k, idx) => {
            const hit = ps && Array.isArray(ps.keys) ? ps.keys.find((x) => x.ref === k) : null;
            const u = hit && typeof hit.usage === 'number' ? hit.usage : 0;
            return { ref: k, index: idx, usage: u };
          });
          const total = keyUsages.reduce((acc, x) => acc + x.usage, 0);
          const palette = [
            'var(--dsw-alias-brand-primary)',
            'var(--dsw-alias-state-success-primary)',
            'var(--dsw-alias-state-warn-primary)',
            'var(--dsw-alias-brand-primary)',
            'var(--krot-chart-4)',
            'var(--krot-chart-5)',
            'var(--krot-chart-6)',
          ];
          return h('div', { className: 'krot-load-chart' },
            h('div', { className: 'krot-load-header' },
              h('span', { style: { fontWeight: 600 } }, '📊 ' + t('loadDistribution')),
              h('span', { className: 'krot-sr-only', style: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', border: 0 } },
                t('loadChartAria') + ': ' + (total > 0 ? keyUsages.map((x) => t('keyLabel').replace('{n}', String(x.index + 1)) + ' ' + x.usage).join(', ') : t('noTrafficYet'))),
              h('span', null, total > 0 ? (total + ' ' + t('statRequests')) : t('noTrafficYet'))
            ),
            h('div', { className: 'krot-load-bar' },
              total > 0
                ? keyUsages.map((x, i) => {
                    if (x.usage === 0) return null;
                    const pct = Math.max(1, Math.round((x.usage / total) * 100));
                    const color = palette[i % palette.length];
                    return h('div', {
                      key: x.ref,
                      className: 'krot-load-segment',
                      style: { width: pct + '%', background: color },
                      title: x.ref + ': ' + x.usage + ' (' + pct + '%)',
                    });
                  })
                : h('div', { className: 'krot-load-segment', style: { width: '100%', background: 'var(--dsw-alias-bg-layer-2)', opacity: 0.6 } })
            ),
            total > 0 ? h('div', { className: 'krot-load-legend' },
              keyUsages.map((x, i) => {
                const pct = total > 0 ? Math.round((x.usage / total) * 100) : 0;
                const color = palette[i % palette.length];
                return h('span', { key: x.ref, className: 'krot-load-item' },
                  h('span', { className: 'krot-load-dot', style: { background: color } }),
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('keyLabel').replace('{n}', String(x.index + 1)) + ': ' + x.usage + ' (' + pct + '%)')
                );
              })
            ) : null,
            total > 0 && keyUsages.length > 1 ? h('div', { style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, '📈 ' + t('sparklineTraffic') + ':'),
              h(Sparkline, { points: keyUsages.map(x => x.usage), width: 140, height: 20 })
            ) : null
          );
        })();

// ── per-model sub-pools: keys + token quotas, plus live usage meters ──
        const modelPools = (() => {
          const models = modelEntriesOf(entry);
          const statusFor = (model) => status[entry.provider + '::' + model] ?? null;
          const runtimeKeysOf = (model) => {
            const ps = statusFor(model);
            return ps && Array.isArray(ps.keys) ? ps.keys : null;
          };
          const rendered = models.map(([model, mp]) => {
            const keys = Array.isArray(mp.keys) ? mp.keys : [];
            const limits = quotaMapOf(mp);
            const rtKeys = runtimeKeysOf(model);
            const rows = keys.map((ref, kIndex) => {
              const info = rtKeys ? rtKeys.find((x) => x.ref === ref) : null;
              const quota = info && info.modelQuota ? info.modelQuota : null;
              const limits2 = { ...limits };
              const limitValue = limits2[ref]?.tokenLimit;
              const cells = [
                h('span', { key: 'r', className: 'krot-tail', title: ref }, ref),
                h('input', {
                  key: 'l',
                  type: 'number',
                  min: 1,
                  step: 1,
                  className: 'krot-in krot-limit',
                  value: limitValue === undefined ? '' : String(limitValue),
                  placeholder: t('tokenLimitPlaceholder'),
                  title: t('tokenLimitHint'),
                  disabled: !stateRef.current.writable,
                  onChange: (e) => setModelTokenLimit(pIndex, model, ref, e.target.value),
                }),
              ];
              if (!quota) {
                cells.push(h('span', { key: 'm', className: 'krot-q-unlimited', title: t('mtLocalOnly') }, t('mtUnlimited')));
              } else {
                const pct = quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
                const color = quota.exhausted
                  ? 'var(--dsw-alias-state-error-primary)'
                  : pct >= 80 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)';
                const resetIn = quota.resetAt ? formatCountdown(quota.resetAt - Date.now()) : null;
                cells.push(h('span', { key: 'm', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                  h('span', { className: 'krot-qbar', title: t('mtUsedOf').replace('{u}', String(quota.used)).replace('{l}', String(quota.limit)) },
                    h('span', { className: 'krot-qbar-fill', style: { width: pct + '%', background: color } })),
                  h('span', {
                    className: quota.exhausted ? 'krot-q-exhausted' : 'krot-qmeta',
                    title: [t('mtUsedOf').replace('{u}', String(quota.used)).replace('{l}', String(quota.limit)),
                      t('mtRemaining').replace('{n}', String(quota.remaining)),
                      resetIn ? t('mtResetIn').replace('{t}', resetIn) : '',
                      t('mtResetWindowHint')].filter(Boolean).join(' · '),
                  }, quota.exhausted
                    ? t('mtExhausted')
                    : (pct >= 1 || quota.used > 0 ? pct + '%' : t('mtRemaining').replace('{n}', String(quota.remaining)))),
                ));
              }
              cells.push(h('span', { key: 'a', className: 'krot-acts' },
                btn('↑', () => reorderModelKeys(pIndex, model, -1, kIndex), { disabled: kIndex === 0, title: t('moveUp') }),
                btn('↓', () => reorderModelKeys(pIndex, model, 1, kIndex), { disabled: kIndex === keys.length - 1, title: t('moveDown') }),
                btn('✕', () => toggleModelKey(pIndex, model, ref, false), { title: t('removeKey') }),
              ));
              return h('div', { key: ref, className: 'krot-qrow' }, cells);
            });

            const available = (entry.keys ?? []).filter((ref) => !keys.includes(ref));
            return h('div', { key: model, className: 'krot-model' },
              h('div', { className: 'krot-model-head' },
                h('input', {
                  className: 'krot-in',
                  defaultValue: model,
                  title: t('modelName'),
                  placeholder: t('modelNamePlaceholder'),
                  disabled: !stateRef.current.writable,
                  onBlur: (e) => renameModel(pIndex, model, e.target.value.trim()),
                  style: { maxWidth: '220px' },
                }),
                h('span', { className: 'krot-tail' }, t('modelKeys') + ': ' + keys.length),
                btn(t('removeModel'), () => removeModel(pIndex, model), { title: t('removeModel') }),
              ),
              rows.length > 0 ? h('div', { className: 'krot-keys' }, rows)
                : h('p', { className: 'krot-hint' }, t('modelPoolsEmpty')),
              available.length > 0 ? h('div', { className: 'krot-foot', style: { marginTop: '6px' } },
                h('span', { className: 'krot-hint' }, t('addKey') + ':'),
                available.map((ref) => btn(ref, () => toggleModelKey(pIndex, model, ref, true), { key: 'add-' + ref, title: ref })),
              ) : null,
            );
          });

          return h('div', { className: 'krot-models' },
            h('div', { className: 'krot-models-title' }, '🎯 ' + t('modelPoolsTitle')),
            h('p', { className: 'krot-models-hint' }, t('modelPoolsHint')),
            rendered.length > 0 ? h('div', null, rendered) : h('p', { className: 'krot-hint' }, t('modelPoolsEmpty')),
            btn(t('addModel'), () => addModel(pIndex), { title: t('addModel'), disabled: !stateRef.current.writable }),
          );
        })();

        return h('div', { key: pIndex, className: 'krot-prov' },
          h('div', { className: 'krot-prov-head' },
            h('input', {
              type: 'checkbox',
              'aria-label': t('selectProvider').replace('{p}', entry.provider),
              checked: selected.has(entry.provider),
              onChange: (e) => { const ns = new Set(selected); if (e.target.checked) ns.add(entry.provider); else ns.delete(entry.provider); setSelected(ns); },
            }),
            btn(t('exportOne'), () => {
              const data = JSON.stringify([entry], null, 2);
              const blob = new Blob([data], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = entry.provider + '.json'; a.click(); URL.revokeObjectURL(url);
            }, { title: t('exportProvider') }),
            btn('⇅', () => {
              const ps = status[entry.provider];
              if (!ps || !Array.isArray(ps.keys)) return;
              const usageOf = (ref) => { const hit = ps.keys.find((k) => k.ref === ref); return hit && typeof hit.usage === 'number' ? hit.usage : 0; };
              setField((cur) => {
                const next = [...(cur.providers ?? [])];
                if (!next[pIndex]) return cur;
                const entry = next[pIndex];
                const order = entry.keys.map((_, index) => index).sort((a, b) => usageOf(entry.keys[b]) - usageOf(entry.keys[a]));
                next[pIndex] = reorderKeys(entry, order);
                return { ...cur, providers: next };
              });
            }, { title: t('sortUsage') }),
            h('select', { className: 'krot-in', value: entry.provider, onChange: (e) => setProvider(pIndex, e.target.value) }, options),
            (() => {
              const ps = status[entry.provider];
              const score = ps && typeof ps.healthScore === 'number' ? ps.healthScore : null;
              if (score === null) return null;
              const color = score > 80 ? 'var(--dsw-alias-state-success-primary)' : score >= 50 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)';
              return h('span', { className: 'krot-tail', title: t('healthScoreTitle'), style: { flex: 'none', color, fontWeight: 700 } }, String(score));
            })(),
            (() => { const ps = status[entry.provider]; const tot = ps && typeof ps.totalUsage === 'number' ? ps.totalUsage : null; return tot !== null ? h('span', { className: 'krot-tail', title: t('totalRequestsTitle'), style: { flex: 'none' } }, String(tot)) : null; })(),
            (() => {
              const q = status.quota || (providerStatus && providerStatus.quota);
              let nearestReset = null;
              if (q && typeof q === 'object') {
                for (const k of (entry.keys || [])) {
                  const entryQ = q[k];
                  if (entryQ && typeof entryQ.reset === 'number' && entryQ.reset > Date.now()) {
                    if (!nearestReset || entryQ.reset < nearestReset) nearestReset = entryQ.reset;
                  }
                }
              }
              if (!nearestReset) return null;
              const diffMs = nearestReset - Date.now();
              if (diffMs <= 0) return null;
              const mins = Math.ceil(diffMs / 60000);
              const timeStr = mins > 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
              return h('span', { className: 'krot-badge krot-badge-warn', title: 'Quota window reset' }, t('quotaResetIn').replace('{time}', timeStr));
            })(),
            btn('✕', () => setConfirmModal({
              title: t('confirmRemoveProvTitle').replace('{p}', entry.provider),
              desc: t('confirmRemoveProvDesc'),
              actionLabel: t('removeProvider'),
              danger: true,
              onConfirm: () => removeProvider(pIndex),
            }), { title: t('removeProvider') }),
          ),
          filterBar,
          loadChart,
          h('div', { className: 'krot-keys' }, keyRows),
          modelPools,
      h('div', { className: 'krot-foot' },
            btn(t('addKey'), () => addKey(pIndex), { title: t('addKeyTitle'), disabled: !entry.provider.trim() }),
            btn('📋 ' + t('bulkImport'), () => setBulkOpen(cur => ({ ...cur, [pIndex]: !cur[pIndex] })), { disabled: !entry.provider.trim(), title: t('bulkImport') }),
            bulkOpen[pIndex] ? h('div', { className: 'krot-bulk-import-box', style: { width: '100%', marginTop: '8px', padding: '8px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '6px' } },
              h('p', { style: { margin: '0 0 6px 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('bulkImportDesc')),
              h('textarea', {
                className: 'krot-in',
                rows: 4,
                style: { width: '100%', fontFamily: 'monospace', fontSize: '11px', resize: 'vertical' },
                placeholder: 'KEY_1\nKEY_2, weight=5\nOPENAI_KEY=sk-...',
                value: bulkText[pIndex] || '',
                onChange: (e) => setBulkText(cur => ({ ...cur, [pIndex]: e.target.value })),
              }),
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
                btn(t('bulkImportBtn'), () => applyBulkImport(pIndex), { primary: true }),
                btn(t('bulkImportCancel'), () => setBulkOpen(cur => ({ ...cur, [pIndex]: false })))
              )
            ) : null,
            switchesLine,
            budgetLine,
            sloLine,
            exhaustionWarning,
            (providerStatus && Array.isArray(providerStatus.events) && providerStatus.events.length > 0 ? h('div', { style: { display: 'flex', gap: '2px', alignItems: 'end', height: '24px', marginTop: '4px' } }, (() => { const now = Date.now(); const buckets = Array(24).fill(0); for (const ev of providerStatus.events) { const h = Math.floor((now - ev.at) / 3600000); if (h >= 0 && h < 24) buckets[23 - h]++; } const max = Math.max(1, ...buckets); return buckets.map((c, i) => h('div', { key: i, title: c + ' switches', style: { flex: 1, background: c ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-border-l2)', height: (c / max * 24) + 'px', minHeight: '2px', borderRadius: '2px' } })); })()) : null),
            // (issue 224): 7-day switches per day (client-side, from the same events)
            (providerStatus && Array.isArray(providerStatus.events) && providerStatus.events.length > 0 ? h('div', { style: { display: 'flex', gap: '2px', alignItems: 'end', height: '16px', marginTop: '2px' } }, (() => { const now = Date.now(); const days = Array(7).fill(0); for (const ev of providerStatus.events) { const d = Math.floor((now - ev.at) / 86400000); if (d >= 0 && d < 7) days[6 - d]++; } const max = Math.max(1, ...days); return days.map((c, i) => h('div', { key: i, title: c + ' switches · day -' + (6 - i), style: { flex: 1, background: c ? 'var(--dsw-alias-brand-primary, var(--dsw-alias-state-warn-primary))' : 'var(--dsw-alias-border-l2)', height: (c / max * 16) + 'px', minHeight: '2px', borderRadius: '2px' } })); })()) : null),
            (providerStatus && Array.isArray(providerStatus.events) && providerStatus.events.length > 0 ? h('details', { className: 'krot-event-stream' },
              h('summary', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' } },
                h('span', null, '📜 ' + t('liveEventStream')),
                h('span', { className: 'krot-badge' }, String(providerStatus.events.length))
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' } },
                providerStatus.events.slice().reverse().map((ev, i) => {
                  const isHeal = ev.type === 'heal' || ev.reason === 'auto-unbreak' || ev.reason === 'self-heal';
                  const isBad = ev.code === 'AUTH' || ev.reason === 'AUTH' || ev.type === 'broken';
                  const badgeClass = isHeal ? 'krot-badge-ok' : isBad ? 'krot-badge-bad' : 'krot-badge-warn';
                  const timeStr = ev.at ? new Date(ev.at).toLocaleTimeString() : '';
                  return h('div', { key: i, className: 'krot-event-row' },
                    h('span', { className: 'krot-event-time' }, timeStr),
                    h('span', { className: 'krot-tail' }, ev.ref || 'pool'),
                    h('span', { className: 'krot-badge ' + badgeClass }, String(ev.reason || ev.code || ev.type)),
                    ev.cooldownMs > 0 ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, 'cd: ' + Math.round(ev.cooldownMs / 1000) + 's') : null
                  );
                })
              )
            ) : null),
            btn(t('resetCooldown'), () => setConfirmModal({
              title: t('confirmResetTitle').replace('{p}', entry.provider),
              desc: t('confirmResetDesc'),
              actionLabel: t('resetCooldown'),
              danger: false,
              onConfirm: () => doReset(entry.provider),
            }), { disabled: !(providerStatus && providerStatus.switches > 0) || resetting === entry.provider, title: t('resetCooldown') }),
            btn(testAllProvider === entry.provider ? (testingProgress[entry.provider] ? t('testingAllProgress').replace('{n}', testingProgress[entry.provider].split('/')[0]).replace('{total}', testingProgress[entry.provider].split('/')[1]) : t('testing')) : t('testAll'), () => doTestAll(entry.provider), { disabled: Boolean(testing || testAllProvider), title: t('testAll') }),
            exportCsv,
          ),
        );
      });

      const noProviders = catalog.status === 'error'
        ? h('div', { className: 'krot-hint', role: 'status' }, t('providerCatalogUnavailable'),
          btn(t('retry'), catalog.reload))
        : catalog.status === 'ready' && providers.length === 0
        ? h('div', { className: 'krot-empty', role: 'status', style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '16px 14px', border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)' } },
            h('p', { style: { margin: 0, fontWeight: 600, fontSize: 14, color: 'var(--dsw-alias-label-primary)' } }, t('emptyTitle')),
            h('p', { className: 'krot-hint', style: { margin: 0 } }, t('emptyDesc')),
            h('p', { className: 'krot-hint', style: { margin: 0 } }, t('noProviders')),
          )
        : null;

      const allConfiguredProviders = Array.isArray(val?.providers) ? val.providers : [];
      const totalPoolsCount = allConfiguredProviders.length;
      let totalKeysCount = 0;
      let healthyKeysCount = 0;
      for (const prov of allConfiguredProviders) {
        const pKeys = Array.isArray(prov.keys) ? prov.keys : [];
        totalKeysCount += pKeys.length;
        for (const k of pKeys) {
          const st = keyStatus(prov.provider, k);
          if (st && st.ready) healthyKeysCount++;
        }
      }

      const statsSection = h('div', { className: 'krot-section-card' },
        h('div', { className: 'krot-section-title' },
          h('span', null, '📊 ' + t('sectionStats')),
          h('span', { className: 'krot-badge ' + (totalPoolsCount > 0 && healthyKeysCount === totalKeysCount ? 'krot-badge-ok' : totalPoolsCount > 0 ? 'krot-badge-warn' : 'krot-badge-bad') },
            totalPoolsCount > 0 ? (healthyKeysCount + '/' + totalKeysCount + ' ' + t('keyReady')) : t('notRegistered')
          )
        ),
        h('div', { className: 'krot-section-desc' }, t('sectionStatsDesc')),
        h('div', { className: 'krot-grid-3' },
          h('div', { className: 'krot-stat-box' },
            h('span', { className: 'krot-stat-val' }, String(totalPoolsCount)),
            h('span', { className: 'krot-stat-lbl' }, t('statPools'))
          ),
          h('div', { className: 'krot-stat-box' },
            h('span', { className: 'krot-stat-val' }, String(totalKeysCount)),
            h('span', { className: 'krot-stat-lbl' }, t('statKeys'))
          ),
          h('div', { className: 'krot-stat-box' },
            h('span', { className: 'krot-stat-val', style: { color: healthyKeysCount > 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-primary)' } }, String(healthyKeysCount)),
            h('span', { className: 'krot-stat-lbl' }, t('statHealthy'))
          )
        )
      );

      const poolsSection = h('div', { className: 'krot-section-card' },
        h('div', { className: 'krot-section-title' },
          h('span', null, '🔑 ' + t('providersTitle')),
          h('span', { className: 'krot-badge krot-badge-ok' }, totalPoolsCount + ' ' + t('statPools'))
        ),
        h('div', { className: 'krot-section-desc' }, t('desc')),
        searchInput,
        h('div', { className: 'krot-foot', style: { marginBottom: '8px' } },
          h('input', {
            className: 'krot-in',
            placeholder: t('bulkCooldownPlaceholder'),
            value: bulkCooldown,
            onChange: (e) => setBulkCooldown(e.target.value),
            style: { maxWidth: '160px' },
          }),
          btn(t('bulkApply'), () => {
            const v = Number(bulkCooldown); if (!v) return;
            setField((cur) => {
              const next = [...(cur.providers ?? [])];
              for (let i = 0; i < next.length; i++) if (selected.has(next[i].provider)) next[i] = { ...next[i], cooldownMs: v };
              return { ...cur, providers: next };
            });
          }, { disabled: selected.size === 0 || !bulkCooldown }),
          btn(t('bulkRemove'), () => {
            const ids = new Set(selected);
            if (!ids.size) return;
            setConfirmModal({
              title: t('confirmBulkRemoveTitle').replace('{n}', String(ids.size)),
              desc: t('confirmBulkRemoveDesc'),
              actionLabel: t('bulkRemove'),
              danger: true,
              onConfirm: () => {
                setField((cur) => {
                  const next = (cur.providers ?? []).filter((p) => !ids.has(p.provider));
                  return { ...cur, providers: next };
                });
                setSelected(new Set());
              },
            });
          }, { disabled: selected.size === 0, className: 'krot-btn-danger' })
        ),
        h('div', { className: 'krot-keys' }, providerRows),
        h('div', { className: 'krot-foot', style: { marginTop: '10px' } },
          btn(t('addProvider'), addProvider, { primary: false }),
          noProviders
        ),
        h(UpdaterSection, { t })
      );

      const failoverSection = h('div', { className: 'krot-section-card' },
        h('div', { className: 'krot-section-title' },
          h('span', null, '⚡ ' + t('codesTitle')),
          h('span', { className: 'krot-badge krot-badge-warn' }, selectedCodes.size + ' ' + t('activeBadge'))
        ),
        h('div', { className: 'krot-section-desc' }, t('sectionFailoverDesc')),
        h('div', { className: 'krot-codes' }, codeList.map((code) => h('label', { key: code, className: 'krot-code' },
          h('input', {
            type: 'checkbox',
            checked: selectedCodes.has(code),
            onChange: (e) => toggleCode(code, e.target.checked),
          }),
          code,
        )))
      );

      const timingSection = h('div', { className: 'krot-section-card' },
        h('div', { className: 'krot-section-title' },
          h('span', null, '⏱ ' + t('sectionTiming')),
        ),
        h('div', { className: 'krot-section-desc' }, t('sectionTimingDesc')),
        h('div', { className: 'krot-grid-2' },
          field(t('cooldown'), textInput(String(val.cooldownMs ?? 60000), (v) => setField((cur) => ({ ...cur, cooldownMs: Number(v) || 0 })))),
          field(t('scheduleDays'), textInput(String(val.rotationScheduleDays ?? 0), (v) => setField((cur) => ({ ...cur, rotationScheduleDays: Number(v) || 0 }))))
        ),
        h('div', { className: 'krot-grid-2', style: { marginTop: '10px' } },
          field(t('rpmLimitLabel'), textInput(String(val.rpmLimit ?? 0), (v) => setField((cur) => ({ ...cur, rpmLimit: Number(v) || 0 })))),
          field(t('tpmLimitLabel'), textInput(String(val.tpmLimit ?? 0), (v) => setField((cur) => ({ ...cur, tpmLimit: Number(v) || 0 }))))
        ),
        h('div', { className: 'krot-grid-3', style: { marginTop: '10px' } },
          field(t('routingStrategyLabel'), h('select', {
            className: 'krot-in',
            value: val.routingStrategy ?? 'round-robin',
            onChange: (e) => setField((cur) => ({ ...cur, routingStrategy: e.target.value })),
          }, [
            h('option', { key: 'round-robin', value: 'round-robin' }, t('routingStrategyRoundRobin')),
            h('option', { key: 'least-loaded', value: 'least-loaded' }, t('routingStrategyLeastLoaded')),
            h('option', { key: 'lowest-latency', value: 'lowest-latency' }, t('routingStrategyLowestLatency')),
          ])),
          field(t('selfHealingLabel'), textInput(String(val.selfHealingIntervalMinutes ?? 30), (v) => setField((cur) => ({ ...cur, selfHealingIntervalMinutes: Number(v) || 0 })))),
          field(t('proactiveGuardLabel'), h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', height: '36px', cursor: 'pointer' } }, [
            h('input', {
              key: 'input', type: 'checkbox',
              checked: val.proactiveRateLimitGuard ?? true,
              onChange: (e) => setField((cur) => ({ ...cur, proactiveRateLimitGuard: e.target.checked })),
            }),
            h('span', { key: 'label', style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, t('proactiveGuardLabel')),
          ]))
        )
      );

      const backupSection = h('div', { className: 'krot-section-card' },
        h('div', { className: 'krot-section-title' },
          h('span', null, '💾 ' + t('sectionBackup')),
        ),
        h('div', { className: 'krot-section-desc' }, t('sectionBackupDesc')),
        h('div', { className: 'krot-row' },
          btn(t('exportPools'), () => {
            const data = JSON.stringify(val.providers ?? [], null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'pools.json'; a.click(); URL.revokeObjectURL(url);
          }, {}),
          h('label', { className: 'krot-btn', style: { cursor: 'pointer' } }, t('importPools'), h('input', { type: 'file', accept: '.json', style: { display: 'none' }, onChange: (e) => {
            const file = e.target.files[0]; e.target.value = '';
            readImport(file, (imported) => {
              validatePoolDraft(imported);
              setField((cur) => {
                const map = new Map((cur.providers ?? []).map((p) => [p.provider, p]));
                for (const p of imported) map.set(p.provider, p);
                return { ...cur, providers: [...map.values()] };
              }, true);
            });
          } })),
          btn(t('snapshotExport'), () => {
            fetch('/dsh-key-rotation/snapshot', { headers: { accept: 'application/json' }, signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(8000) : undefined })
              .then((r) => r.json())
              .then((data) => {
                const blob = new Blob([JSON.stringify(data.snapshot ?? {}, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = 'dsh-key-rotation-snapshot.json'; a.click(); URL.revokeObjectURL(url);
              })
              .catch((e) => setSecretError(String(e?.message ?? e)));
          }, {}),
          h('label', { className: 'krot-btn', style: { cursor: 'pointer' } }, t('snapshotImport'), h('input', { type: 'file', accept: '.json', style: { display: 'none' }, onChange: (e) => {
            const file = e.target.files[0]; e.target.value = '';
            readImport(file, (imported) => {
              const snap = imported?.snapshot ?? imported;
              if (!snap || typeof snap !== 'object' || Array.isArray(snap)) throw new Error('Expected a settings snapshot');
              if (Object.prototype.hasOwnProperty.call(snap, 'providers')) validatePoolDraft(snap.providers);
              const patch = { ...snap };
              // Exported empty secret fields mean "not included", not "erase".
              if (!patch.webhookActionToken) delete patch.webhookActionToken;
              setField((cur) => ({ ...cur, ...patch }), true);
            });
          } }))
        ),
        h('p', { className: 'krot-hint', style: { marginTop: '4px' } }, t('keyHint'))
      );

      const alerts = [
        secretError ? h('div', { key: 'se', className: 'krot-alert-bad' }, secretError) : null,
        state.error ? h('div', { key: 'st', role: 'alert', className: 'krot-alert-bad' }, state.error) : null,
        undo ? h('div', { key: 'un', className: 'krot-alert-ok' },
          h('span', null, undo.type === 'provider' ? t('undoProvider') : t('undoKey')),
          btn(t('undo'), doUndo, { className: 'krot-btn-sm' })
        ) : null,
      ].filter(Boolean);

      const confirmModalEl = confirmModal ? h('div', {
          className: 'krot-modal-backdrop',
          onClick: () => setConfirmModal(null),
        },
        h('div', {
          className: 'krot-modal-card',
          ref: modalCardRef,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'krot-modal-title',
          'aria-describedby': 'krot-modal-desc',
          onClick: (e) => e.stopPropagation(),
        },
          h('div', { className: 'krot-modal-title', id: 'krot-modal-title' }, confirmModal.title),
          h('div', { className: 'krot-modal-desc', id: 'krot-modal-desc' }, confirmModal.desc),
          h('div', { className: 'krot-modal-actions' },
            btn(t('cancel'), () => setConfirmModal(null), { 'data-krot-modal-cancel': '1' }),
            btn(confirmModal.actionLabel || t('confirm'), () => {
              const fn = confirmModal.onConfirm;
              setConfirmModal(null);
              if (fn) fn();
            }, { primary: !confirmModal.danger, className: confirmModal.danger ? 'krot-btn-danger' : undefined })
          )
        )
      ) : null;

      const headerSection = h('div', { className: 'krot-header' },
        h('div', { className: 'krot-page-title' },
          '🔄 ' + t('header.title'),
          h('span', { className: 'krot-badge ' + (totalPoolsCount > 0 ? 'krot-badge-ok' : 'krot-badge-warn') },
            totalPoolsCount > 0 ? (totalPoolsCount + ' ' + t('header.pools_badge')) : t('noActivePools')
          ),
          h('span', { className: 'krot-badge ' + (totalKeysCount > 0 ? 'krot-badge-ok' : 'krot-badge-warn') },
            totalKeysCount + ' ' + t('header.keys_badge')
          ),
          h('span', { className: 'krot-badge ' + (healthyKeysCount === totalKeysCount && totalKeysCount > 0 ? 'krot-badge-ok' : 'krot-badge-warn') },
            healthyKeysCount + '/' + totalKeysCount + ' ' + t('keyReady')
          )
        ),
        h('div', { className: 'krot-page-sub' }, t('header.sub'))
      );

      return h('div', { className: 'krot', 'aria-busy': saving || importing },
        confirmModalEl,
        headerSection,
        statsSection,
        h('fieldset', { disabled: saving || importing || !state.writable,
          style: { border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' } },
          poolsSection,
          failoverSection,
          timingSection,
          backupSection,
        ),
        alerts.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, alerts) : null,
        h('div', { className: 'krot-foot', style: { marginTop: '6px', paddingTop: '14px', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          btn(t('save'), save, { primary: true, disabled: saving || importing || !state.writable || !draft }),
          btn(t('discard'), () => {
            if (saveInFlightRef.current || importRef.current) return;
            clearDraft();
            setSecretError('');
            void load();
          }, { disabled: saving || importing }),
          saving || importing ? h('span', { className: 'krot-hint' }, t(saving ? 'saving' : 'loading')) : null,
          !state.writable ? h('span', { className: 'krot-hint' }, t('readOnly')) : null,
        )
      );
    }



