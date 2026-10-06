    /** Poll rotation status while the settings section is open (smart polling). */
    function useRotationStatus() {
      const [byProvider, setByProvider] = React.useState({});
      React.useEffect(() => {
        let alive = true;
        const pull = () => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          fetch('/dsh-key-rotation/status', { headers: { accept: 'application/json' }, signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(8000) : undefined })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (!alive || !data || !Array.isArray(data.providers)) return;
              const map = {};
              for (const entry of data.providers) map[entry.provider] = entry;
              setByProvider(map);
            })
            .catch(() => { /* status is optional: card stays a working editor */ });
        };
        pull();
        const id = setInterval(pull, 4000);
        const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') pull(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
        return () => {
          alive = false;
          clearInterval(id);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
        };
      }, []);
      return byProvider;
    }

    /** Latest probe result per key (#219): /sandbox-cache (smart polling). */
    function useProbeCache() {
      const [cache, setCache] = React.useState({});
      React.useEffect(() => {
        let alive = true;
        const pull = () => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          fetch('/dsh-key-rotation/sandbox-cache', { headers: { accept: 'application/json' }, signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(8000) : undefined })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => { if (alive && data) setCache(data); })
            .catch(() => { /* cache is non-critical: card works without it */ });
        };
        pull();
        const id = setInterval(pull, 4000);
        const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') pull(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
        return () => {
          alive = false;
          clearInterval(id);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
        };
      }, []);
      return cache;
    }

