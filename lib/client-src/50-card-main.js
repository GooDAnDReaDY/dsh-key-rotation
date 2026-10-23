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
      // Simulator State (#475)
      const [simProvider, setSimProvider] = React.useState('');
      const [simModel, setSimModel] = React.useState('');
      const [simAttempts, setSimAttempts] = React.useState(3);
      const [simScenario, setSimScenario] = React.useState('success');
      const [simRunning, setSimRunning] = React.useState(false);
      const [simResult, setSimResult] = React.useState(null);
      const [simError, setSimError] = React.useState('');

      // Auto-Discovery State (#491)
      const [discoveredKeys, setDiscoveredKeys] = React.useState([]);
      const [autoImporting, setAutoImporting] = React.useState(false);
      const [autoImportMsg, setAutoImportMsg] = React.useState('');

      // Test Matrix State (#490)
      const [testMatrixRunning, setTestMatrixRunning] = React.useState(false);
      const [exportModal, setExportModal] = React.useState(false);
      const [exportMasked, setExportMasked] = React.useState(true);
      const [exportPassphrase, setExportPassphrase] = React.useState('');
      const [exportError, setExportError] = React.useState('');
      const [importModal, setImportModal] = React.useState(false);
      const [importText, setImportText] = React.useState('');
      const [importPassphrase, setImportPassphrase] = React.useState('');
      const [importMode, setImportMode] = React.useState('merge');
      const [importPreview, setImportPreview] = React.useState(null);
      const [importError, setImportError] = React.useState('');
      const [importRunning, setImportRunning] = React.useState(false);

      const runExport = async () => {
        setExportError('');
        try {
          const q = new URLSearchParams();
          q.set('masked', exportMasked ? 'true' : 'false');
          if (exportPassphrase.trim()) q.set('passphrase', exportPassphrase.trim());
          const res = await fetch(`/dsh-key-rotation/export?${q.toString()}`, {
            headers: { accept: 'application/json' },
            signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(10000) : undefined,
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data?.error?.message || 'Export failed');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `dsh-key-rotation-${exportMasked ? 'masked' : 'full'}-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          setExportModal(false);
        } catch (err) {
          setExportError(String(err?.message ?? err));
        }
      };

      const runImportPreview = async () => {
        setImportError('');
        setImportPreview(null);
        setImportRunning(true);
        try {
          let parsed;
          try { parsed = JSON.parse(importText); } catch (_) { throw new Error('Invalid JSON format'); }
          const res = await fetch('/dsh-key-rotation/config-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              config: parsed.config || (parsed.providers ? parsed : undefined),
              ciphertext: parsed.ciphertext,
              salt: parsed.salt,
              iv: parsed.iv,
              tag: parsed.tag,
              encrypted: parsed.encrypted,
              passphrase: importPassphrase.trim() || undefined,
              mode: importMode,
              dryRun: true,
            }),
            signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(10000) : undefined,
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data?.error?.message || 'Import preview failed');
          setImportPreview(data.preview);
        } catch (err) {
          setImportError(String(err?.message ?? err));
        } finally {
          setImportRunning(false);
        }
      };

      const runImportApply = async () => {
        setImportError('');
        setImportRunning(true);
        try {
          let parsed;
          try { parsed = JSON.parse(importText); } catch (_) { throw new Error('Invalid JSON format'); }
          const res = await fetch('/dsh-key-rotation/config-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              config: parsed.config || (parsed.providers ? parsed : undefined),
              ciphertext: parsed.ciphertext,
              salt: parsed.salt,
              iv: parsed.iv,
              tag: parsed.tag,
              encrypted: parsed.encrypted,
              passphrase: importPassphrase.trim() || undefined,
              mode: importMode,
              dryRun: false,
            }),
            signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(10000) : undefined,
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data?.error?.message || 'Import apply failed');
          setImportModal(false);
          setImportPreview(null);
          setImportText('');
          void load();
        } catch (err) {
          setImportError(String(err?.message ?? err));
        } finally {
          setImportRunning(false);
        }
      };

      const [testMatrixResults, setTestMatrixResults] = React.useState(null);
      const [testMatrixModal, setTestMatrixModal] = React.useState(false);

      React.useEffect(() => {
        let mounted = true;
        fetch('/dsh-key-rotation/discover', {
          signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(5000) : undefined,
        })
          .then((r) => r.json())
          .then((data) => {
            if (mounted && data?.ok && Array.isArray(data.discovered)) {
              setDiscoveredKeys(data.discovered);
            }
          })
          .catch((e) => { void e; });
        return () => { mounted = false; };
      }, []);

      const runTestMatrix = async () => {
        setTestMatrixRunning(true);
        setTestMatrixModal(true);
        try {
          const res = await fetch('/dsh-key-rotation/test-matrix', {
            method: 'POST',
            signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(15000) : undefined,
          });
          const data = await res.json();
          if (data?.ok) {
            setTestMatrixResults(data);
          }
        } catch (err) {
          setTestMatrixResults({ ok: false, failed: 1, total: 1, results: [{ provider: 'all', ref: 'matrix', ok: false, code: 'error', error: String(err?.message ?? err) }] });
        } finally {
          setTestMatrixRunning(false);
        }
      };

      const runAutoImport = async () => {
        setAutoImporting(true);
        setAutoImportMsg('');
        try {
          const res = await fetch('/dsh-key-rotation/auto-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: true }),
            signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(8000) : undefined,
          });
          const data = await res.json();
          if (data?.ok) {
            setAutoImportMsg(t('autoImportSuccess').replace('{n}', String(data.importedCount || 0)));
            setDiscoveredKeys([]);
            void load();
          }
        } catch (err) {
          setAutoImportMsg(String(err?.message ?? err));
        } finally {
          setAutoImporting(false);
        }
      };

      const runSimulator = async () => {
        const activeProv = simProvider || (providersList[0]?.provider || '');
        if (!activeProv) return;
        setSimRunning(true);
        setSimError('');
        try {
          const events = [];
          if (simScenario === 'rate_limit') {
            events.push({ code: '429', message: 'Rate limit reached' });
          } else if (simScenario === 'error_500') {
            events.push({ code: '500', message: 'Internal Server Error' });
          }
          const res = await fetch('/dsh-key-rotation/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: activeProv,
              model: simModel,
              maxAttempts: Number(simAttempts) || 3,
              events,
            }),
          });
          const data = await res.json();
          if (data && data.ok) {
            setSimResult(data.simulation);
          } else {
            setSimError(data?.error?.message || 'Simulation error');
          }
        } catch (err) {
          setSimError(String(err?.message || err));
        } finally {
          setSimRunning(false);
        }
      };

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
