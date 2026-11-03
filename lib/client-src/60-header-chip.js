    // (issue 201, #499, #577) header chip: one dot + counts for all pools. Green = all healthy,
    // amber = some keys cooling, red = a pool fully exhausted. Click opens interactive quick actions popover.
    function KeyRotationHeaderChip(props) {
      const t = resolveT(props);
      const [snap, setSnap] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [, setTick] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const ref = React.useRef(null);

      const load = () => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        fetch('/dsh-key-rotation/health', {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(8000) : undefined
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (d) setSnap(d); })
          .catch((e) => { void e; });
      };

      React.useEffect(() => {
        load();
        const id = setInterval(load, 5000);
        const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') load(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
        return () => {
          clearInterval(id);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
        };
      }, []);

      React.useEffect(() => {
        if (!props?.settingsSource?.subscribe) return;
        return props.settingsSource.subscribe(() => {
          setTick((c) => c + 1);
        });
      }, [props?.settingsSource]);

      React.useEffect(() => {
        if (!open) return;
        const onDocClick = (e) => {
          if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('click', onDocClick);
        return () => document.removeEventListener('click', onDocClick);
      }, [open]);

      const runAction = (action, provider, keyRef) => {
        setBusy(true);
        fetch('/dsh-key-rotation/quick-action', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ action, provider, ref: keyRef }),
          credentials: 'same-origin',
          signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(5000) : undefined,
        })
          .then((r) => r.json())
          .then(() => { load(); })
          .catch((err) => { void err; })
          .finally(() => { setBusy(false); });
      };

      let settingsVal = null;
      try {
        const sSnap = props?.settingsSource?.getSnapshot?.()?.service?.getSnapshot?.();
        settingsVal = sSnap?.value;
      } catch (e) {
        void e;
      }
      if (settingsVal && settingsVal.showChatHeaderChip === false) return null;
      if (snap && snap.showChatHeaderChip === false) return null;

      const poolsObj = (snap && snap.pools) || {};
      const poolEntries = Object.entries(poolsObj);
      const total = poolEntries.reduce((a, [, p]) => a + (p.total || 0), 0);
      const healthy = poolEntries.reduce((a, [, p]) => a + (p.healthy || 0), 0);
      const anyExhausted = poolEntries.some(([, p]) => p.exhausted);
      const color = !poolEntries.length ? 'var(--dsw-alias-label-tertiary)' : anyExhausted ? 'var(--dsw-alias-state-error-primary)' : healthy < total ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)';
      const label = poolEntries.length ? `${healthy}/${total} rot` : 'rot';

      return (
        <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            type="button"
            className="krot-header-chip"
            title={t('title')}
            onClick={() => setOpen((v) => !v)}
          >
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, flex: 'none', boxShadow: `0 0 6px ${color}` }} />
            {label}
            <span style={{ fontSize: '9px', opacity: 0.6 }}>{open ? '▲' : '▼'}</span>
          </button>
          {open ? (
            <div className="krot-popover" style={{ minWidth: '260px' }}>
              <div className="krot-pop-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('headerPoolsTitle')}</span>
                {busy ? <span style={{ fontSize: '11px', opacity: 0.7 }}>...</span> : null}
              </div>
              {!poolEntries.length ? (
                <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>{t('noActivePools')}</div>
              ) : null}
              {poolEntries.map(([name, p]) => {
                const c = p.exhausted ? 'var(--dsw-alias-state-error-primary)' : (p.healthy < p.total ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)');
                const provName = p.providerName || name;
                const activeTail = p.lastUsedTail;
                const pinnedTail = p.pinnedTail;
                const isPinned = Boolean(p.pinnedRef);
                const keysList = Array.isArray(p.keys) ? p.keys : [];
                const cacheHits = p.promptCacheHits || 0;

                return (
                  <div key={name} className="krot-pop-row" style={{ display: 'flex', flexDirection: 'column', gap: '5px', padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-subtle)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="krot-pop-name" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: c, flex: 'none' }} />
                        <strong style={{ fontSize: '12px' }}>{name}</strong>
                      </div>
                      <div className="krot-pop-count" style={{ color: c, fontWeight: 600, fontSize: '11px' }}>{`${p.healthy}/${p.total}`}</div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <span>{isPinned ? '📌' : '⚡'}</span>
                        <span style={{ fontFamily: 'monospace' }}>
                          {isPinned ? (pinnedTail ? `...${pinnedTail} (pinned)` : p.pinnedRef) : (activeTail ? `...${activeTail}` : 'auto')}
                        </span>
                      </span>
                      {cacheHits > 0 ? (
                        <span style={{ fontSize: '10px', padding: '1px 4px', borderRadius: '3px', background: 'var(--dsw-alias-bg-subtle, transparent)', color: 'var(--dsw-alias-state-success-primary)' }} title="Prompt cache hits">
                          {`⚡ ${cacheHits}`}
                        </span>
                      ) : null}
                    </div>

                    {keysList.length > 1 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                        <select
                          disabled={busy}
                          value={p.pinnedRef || ''}
                          onChange={(e) => runAction('pin', provName, e.target.value)}
                          title={t('quickPinTitle')}
                          style={{
                            width: '100%',
                            fontSize: '11px',
                            padding: '3px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--dsw-alias-border-subtle)',
                            background: 'var(--dsw-alias-bg-subtle, transparent)',
                            color: 'inherit',
                            fontFamily: 'inherit',
                            cursor: 'pointer'
                          }}
                        >
                          <option value="">{`🔀 ${t('quickAuto')}`}</option>
                          {keysList.map((k) => {
                            const marker = k.pinned ? '📌 ' : (k.active ? '▶ ' : '');
                            const status = k.paused ? ' [paused]' : (k.cooling ? ' [cooling]' : '');
                            return (
                              <option key={k.ref} value={k.ref}>
                                {`${marker}...${k.tail || k.ref.slice(-4)}${status}`}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    ) : null}

                    <div style={{ display: 'flex', gap: '4px', marginTop: '3px' }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); runAction('skip', provName, p.lastUsed); }}
                        title={t('quickSkipTitle')}
                        style={{ flex: 1, padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent', cursor: 'pointer', color: 'inherit' }}
                      >{`⏭️ ${t('quickSkip')}`}</button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); runAction('reset', provName, p.lastUsed); }}
                        title={t('quickResetTitle')}
                        style={{ flex: 1, padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent', cursor: 'pointer', color: 'inherit' }}
                      >{`🔄 ${t('quickReset')}`}</button>
                      <button
                        type="button"
                        disabled={busy || !p.lastUsed}
                        onClick={(e) => { e.stopPropagation(); runAction('pause', provName, p.lastUsed); }}
                        title={t('quickPauseTitle')}
                        style={{ flex: 1, padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent', cursor: 'pointer', color: 'inherit' }}
                      >{`⏸️ ${t('quickPause')}`}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      );
    }
