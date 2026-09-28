    // #201 header chip: one dot + counts for all pools. Green = all healthy,
    // amber = some keys cooling, red = a pool fully exhausted. Click opens the
    // same summary the floating dashboard shows.
    function KeyRotationHeaderChip(props) {
      const t = resolveT(props);
      const [snap, setSnap] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const ref = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        const load = () => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          fetch('/dsh-key-rotation/health', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive) setSnap(d); })
            .catch(() => {});
        };
        load();
        const id = setInterval(load, 5000);
        const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') load(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
        return () => {
          alive = false;
          clearInterval(id);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
        };
      }, []);

      React.useEffect(() => {
        if (!open) return;
        const onDocClick = (e) => {
          if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('click', onDocClick);
        return () => document.removeEventListener('click', onDocClick);
      }, [open]);

      const poolsObj = (snap && snap.pools) || {};
      const poolEntries = Object.entries(poolsObj);
      const total = poolEntries.reduce((a, [, p]) => a + (p.total || 0), 0);
      const healthy = poolEntries.reduce((a, [, p]) => a + (p.healthy || 0), 0);
      const anyExhausted = poolEntries.some(([, p]) => p.exhausted);
      const color = !poolEntries.length ? 'var(--dsw-alias-label-tertiary)' : anyExhausted ? 'var(--dsw-alias-state-error-primary)' : healthy < total ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-state-success-primary)';
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
        open ? h('div', { className: 'krot-popover' },
          h('div', { className: 'krot-pop-title' }, t('headerPoolsTitle')),
          !poolEntries.length ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('noActivePools')) : null,
          poolEntries.map(([name, p]) => {
            const c = p.exhausted ? 'var(--dsw-alias-state-error-primary)' : (p.healthy < p.total ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-state-success-primary)');
            return h('div', { key: name, className: 'krot-pop-row' },
              h('div', { className: 'krot-pop-name' },
                h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: c, flex: 'none' } }),
                name
              ),
              h('div', { className: 'krot-pop-count', style: { color: c } }, `${p.healthy}/${p.total}`)
            );
          })
        ) : null
      );
    }

