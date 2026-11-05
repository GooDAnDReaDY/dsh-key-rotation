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
