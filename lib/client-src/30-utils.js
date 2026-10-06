    // formatAgo moved to lib/client-helpers.js for testability — keep local alias for bundle self-containment
    function formatAgo(t, at) {
      if (!at) return '';
      const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (sec < 60) return t('justNow');
      if (sec < 3600) return t('minutesAgo').replace('{n}', String(Math.round(sec / 60)));
      return t('hoursAgo').replace('{n}', String(Math.round(sec / 3600)));
    }

    // Card layout uses a grid, not ad-hoc inline widths. Fixed widths used to
    // clip key names and collide actions with the value field, so the name owns
    // its own row and the meta row shrinks on its own.
    const CARD_CSS = [
      '.krot{display:flex;flex-direction:column;gap:20px;max-width:960px;padding:6px 0 24px;box-sizing:border-box}',
      '.krot-header{display:flex;flex-direction:column;gap:8px;padding-bottom:16px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.krot-page-title{font-size:20px;font-weight:700;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.krot-page-sub{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.krot p{margin:0}',
      '.krot-hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.4}',
      '.krot-err{font-size:13px;color:var(--dsw-alias-state-error-primary);padding:10px 14px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);display:flex;align-items:center;gap:8px}',
      '.krot-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.krot-field{display:flex;flex-direction:column;gap:6px}',
      '.krot-in{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;height:36px;font-family:inherit;min-width:0;width:100%;box-sizing:border-box;transition:border-color .15s ease}',
      '.krot-in:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.krot-codes{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px 14px}',
      '.krot-code{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none}',
      '.krot-section-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:14px}',
      '.krot-section-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.krot-section-desc{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:-6px;line-height:1.4}',
      '.krot-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
      '.krot-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}',
      '.krot-grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}',
      '.krot-stat-box{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:4px}',
      '.krot-stat-val{font-size:20px;font-weight:700;color:var(--dsw-alias-label-primary)}',
      '.krot-stat-lbl{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.krot-load-chart{margin:10px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.krot-load-header{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}',
      '.krot-load-bar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
      '.krot-load-segment{height:100%;transition:width 0.2s ease}',
      '.krot-load-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;font-size:11px}',
      '.krot-load-item{display:inline-flex;align-items:center;gap:4px}',
      '.krot-load-dot{width:7px;height:7px;border-radius:50%}',
      '.krot-modal-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:var(--dsw-alias-bg-overlay, color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent));z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)}',
      '.krot-modal-card{width:90%;max-width:420px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 36px color-mix(in srgb, var(--dsw-alias-bg-layer-1) 28%, transparent);padding:20px;display:flex;flex-direction:column;gap:12px}',
      '.krot-modal-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.krot-modal-desc{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.45}',
      '.krot-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}',
      '.krot-badge{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);display:inline-flex;align-items:center;gap:5px;font-weight:500;white-space:nowrap}',
      '.krot-badge-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)}',
      '.krot-badge-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent)}',
      '.krot-badge-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)}',
      '.krot-prov{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:14px 16px}',
      '.krot-prov-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.krot-prov-head select{flex:1;min-width:180px}',
      '.krot-keys{display:flex;flex-direction:column;gap:8px}',
      '.krot-key{display:grid;grid-template-columns:22px minmax(0,1fr);gap:6px 10px;align-items:center;padding:8px 12px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.krot-num{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-align:right}',
      '.krot-name{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);cursor:default}',
      '.krot-meta{grid-column:2;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.krot-dot{width:8px;height:8px;border-radius:50%;flex:none}',
      '.krot-state{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.krot-tail{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--dsw-alias-bg-layer-1);padding:2px 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2)}',
      '.krot-secret{flex:1;min-width:120px;max-width:220px}',
      '.krot-acts{display:flex;gap:4px;margin-left:auto;flex:none}',
      '.krot-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 14px;font-size:13px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:all .15s ease}',
      '.krot-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-label-dimmed,var(--dsw-alias-border-l2))}',
      '.krot-btn-primary,.krot-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent;font-weight:600}',
      '.krot-btn-primary:hover:not(:disabled),.krot-save:hover:not(:disabled){background:var(--dsw-alias-label-primary)!important;color:var(--dsw-alias-bg-layer-3)!important;opacity:0.88}',
      '.krot-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)}',
      '.krot-btn-danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)!important;border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent)}',
      '.krot-btn:disabled{opacity:0.45;cursor:not-allowed}',
      '.krot-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.krot-filter-bar{display:flex;gap:8px;margin:4px 0 10px;flex-wrap:wrap}',
      '.krot-pill{appearance:none;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:all .15s ease}',
      '.krot-pill:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.krot-pill-active{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)!important;font-weight:600}',
      '.krot-pill-warn{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.krot-pill-err{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);color:var(--dsw-alias-state-error-primary)}',
      '.krot-alert-ok{padding:10px 14px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary);font-size:13px;display:flex;align-items:center;gap:10px}',
      '.krot-alert-bad{padding:10px 14px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary);font-size:13px;display:flex;align-items:center;gap:10px}',
      '.krot-event-stream{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      // Per-model token quota editor + runtime meter
      '.krot-models{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}',
      '.krot-models-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}',
      '.krot-models-hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.4;margin:0 0 10px}',
      '.krot-model{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.krot-model-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      '.krot-model-tag{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.krot-limit{width:110px;font-variant-numeric:tabular-nums;text-align:right}',
      '.krot-qbar{display:inline-block;width:64px;height:6px;background:var(--dsw-alias-bg-layer-3);border-radius:3px;overflow:hidden;vertical-align:middle}',
      '.krot-qbar-fill{display:block;height:100%;transition:width .2s ease}',
      '.krot-qmeta{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.krot-q-exhausted{font-size:11px;font-weight:600;color:var(--dsw-alias-state-error-primary)}',
      '.krot-q-unlimited{font-size:11px;color:var(--dsw-alias-label-tertiary);font-style:italic}',
      '.krot-event-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.krot-event-time{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      ':root{--krot-chart-4:var(--dsw-alias-brand-primary);--krot-chart-5:var(--dsw-alias-state-error-primary);--krot-chart-6:var(--dsw-alias-state-success-primary)}',
      '.krot-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none}',
      '.krot-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}',
      '.krot-card-head-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0}',
      '.krot-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.krot-card-description{color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.krot-card-chevron{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease;display:flex;align-items:center}.krot-card-chevron-open{transform:rotate(180deg)}',
      '.krot-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:16px 0 8px}',
      '.krot-header-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;cursor:pointer;position:relative;user-select:none;transition:all .15s ease}',
      '.krot-header-chip:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3));border-color:var(--dsw-alias-border-l1);transform:translateY(-0.5px)}',
      '.krot-popover{position:absolute;top:calc(100% + 6px);right:0;z-index:10000;min-width:220px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;box-shadow:0 16px 40px color-mix(in srgb, var(--dsw-alias-bg-layer-1) 45%, transparent),0 2px 8px color-mix(in srgb, var(--dsw-alias-bg-layer-1) 15%, transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);display:flex;flex-direction:column;gap:8px;text-align:left}',
      '.krot-pop-title{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.krot-pop-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0}',
      '.krot-pop-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}',
      '.krot-pop-count{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;opacity:.9}',
    ].join('');
    const CARD_CSS_ID = 'dsh-key-rotation/section.module.css';
    if (typeof document !== 'undefined' && !document.getElementById('dsh-key-rotation-full-css')) {
      const tag = document.createElement('style');
      tag.id = 'dsh-key-rotation-full-css';
      tag.dataset.dshPlugin = NS;
      tag.dataset.pluginCss = CARD_CSS_ID;
      tag.setAttribute('data-plugin', NS);
      tag.textContent = CARD_CSS;
      document.head.appendChild(tag);
    }

    /**
     * Env-var name for a newly added key.
     *
     * Users no longer type it: the first key of a provider becomes
     * <PROVIDER>_API_KEY, later keys reuse that root with _2, _3… suffixes.
     * The root is taken from existing keys so hand-made names keep working,
     * and uniqueness is checked across ALL providers — otherwise two providers
     * would silently share one credential.
     */
    // nextKeyRef also in lib/client-helpers.js
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
          // Match DSH core: first entry of navigator.languages, else en.
          if (typeof navigator !== 'undefined') {
            const langs = (navigator.languages && navigator.languages.length)
              ? Array.from(navigator.languages)
              : (navigator.language ? [navigator.language] : []);
            for (const lang of langs) {
              const code = String(lang || '').slice(0, 2).toLowerCase();
              if (code) return code;
            }
          }
          return 'en';
        }, [ctx])
      );
    }

    function makeT(DICT, fallbackKeys) {
      return (key) => (DICT && DICT[key]) || (fallbackKeys && fallbackKeys[key]) || key;
    }

    // Prefer the host slot translator (props.t + translation plugins); fall back to en source.
    function resolveT(props) {
      const coreT = props && typeof props.t === 'function' ? props.t : null;
      if (!coreT) return makeT(en, en);
      return (key) => {
        const v = coreT(key);
        return (v && v !== key) ? v : (en[key] || key);
      };
    }


