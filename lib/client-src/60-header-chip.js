    // (issue 201, #499) header chip: one dot + counts for all pools. Green = all healthy,
    // amber = some keys cooling, red = a pool fully exhausted. Click opens quick actions popover.
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

      return h('div', { ref, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          className: 'krot-header-chip',
          title: t('title'),
          onClick: () => setOpen((v) => !v),
        },
          h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: color, flex: 'none', boxShadow: `0 0 6px ${color}` } }),
          label,
          h('span', { style: { fontSize: '9px', opacity: 0.6 } }, open ? '▲' : '▼')
        ),
        open ? h('div', { className: 'krot-popover', style: { minWidth: '220px' } },
          h('div', { className: 'krot-pop-title' }, t('headerPoolsTitle')),
          !poolEntries.length ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('noActivePools')) : null,
          poolEntries.map(([name, p]) => {
            const c = p.exhausted ? 'var(--dsw-alias-state-error-primary)' : (p.healthy < p.total ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)');
            const provName = p.providerName || name;
            const tail = p.lastUsedTail;
            return h('div', { key: name, className: 'krot-pop-row', style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-subtle)' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('div', { className: 'krot-pop-name' },
                  h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: c, flex: 'none' } }),
                  name,
                  tail ? h('span', { style: { marginLeft: '6px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', fontFeatureSettings: '"tnum"', fontFamily: 'monospace' } }, `...${tail}`) : null
                ),
                h('div', { className: 'krot-pop-count', style: { color: c, fontWeight: 600 } }, `${p.healthy}/${p.total}`)
              ),
              h('div', { style: { display: 'flex', gap: '4px', marginTop: '2px' } },
                h('button', {
                  type: 'button',
                  disabled: busy,
                  onClick: (e) => { e.stopPropagation(); runAction('skip', provName, p.lastUsed); },
                  title: t('quickSkipTitle'),
                  style: { padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent', cursor: 'pointer', color: 'inherit' }
                }, `⏭️ ${t('quickSkip')}`),
                h('button', {
                  type: 'button',
                  disabled: busy,
                  onClick: (e) => { e.stopPropagation(); runAction('reset', provName, p.lastUsed); },
                  title: t('quickResetTitle'),
                  style: { padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent', cursor: 'pointer', color: 'inherit' }
                }, `🔄 ${t('quickReset')}`),
                h('button', {
                  type: 'button',
                  disabled: busy || !p.lastUsed,
                  onClick: (e) => { e.stopPropagation(); runAction('pause', provName, p.lastUsed); },
                  title: t('quickPauseTitle'),
                  style: { padding: '2px 6px', fontSize: '11px', borderRadius: '4px', border: '1px solid var(--dsw-alias-border-subtle)', background: 'transparent', cursor: 'pointer', color: 'inherit' }
                }, `⏸️ ${t('quickPause')}`)
              )
            );
          })
        ) : null
      );
    }
