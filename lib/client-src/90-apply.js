    function apply(ctx) {
      const settingsSource = createSettingsSource(ctx);
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-key-rotation: dictionaries');
      // Header chip (#201): status dot in the session header utilities slot,
      // same slot dsh-gitea / dsh-subscriptions use for their header widgets.
      ctx.effect(() => {
        if (!ctx.slots) return;
        try {
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              { name: 'conversation.session.header.utilities', id: 'dsh-key-rotation-header-chip', order: 6, locale: NS },
              KeyRotationHeaderChip,
            ));
        } catch { /* slot not available in this build */ }
      }, 'dsh-key-rotation: header chip');

      function useLocale() {
        return useActiveLocale(ctx);
      }
      // Collapsible card in Settings -> Plugins -> Plugin settings
      // (settings.plugin.item), matching Model Sync / Spendmeter / Vision Bridge.
      // key MUST equal the settings namespace (NS), else the tab silently skips it.
      
  function KeyRotationCard(props) {
        const locale = useLocale();
        const t = resolveT(props);
        const page = !!(props && props.view === 'page');
        const [open, setOpen] = React.useState(!!page);
        // Row seat (plugins.row.config): the host page draws title/icon/crumb and the
        // padding, so the summary is a one-liner and the page drops our card chrome.
        if (props && props.view === 'summary') {
          return h('span', { className: 'krot-card-description' }, t('subtitle'));
        }
        return h(page ? 'div' : 'div', { className: page ? 'krot-page' : 'krot-card' + (open ? ' krot-card-open' : '') },
          h('button', { type: 'button', className: 'krot-card-header', style: page ? { display: 'none' } : undefined, 'aria-expanded': page ? true : open, onClick: () => setOpen((v) => !v) },
            h('span', { className: 'krot-card-head-text' },
              h('span', { className: 'krot-card-name' }, t('title')),
              h('span', { className: 'krot-card-description' }, t('subtitle'))),
            h('span', { className: 'krot-card-chevron' + (open ? ' krot-card-chevron-open' : ''), 'aria-hidden': 'true' },
              h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, style: { display: 'block' } },
                h('path', { d: 'M3.5 5.25L7 8.75L10.5 5.25' })))),
          (page || open) ? h('div', { className: 'krot-card-body' }, h(KeyRotationErrorBoundary, null, h(KeyRotationSection, { ...props, locale }))) : null);
      }
      // Register each available seat independently. A missing legacy seat must
      // not prevent the current bundle or row seat from registering.
      for (const [name, key] of [
        ['plugins.bundle.config', PKG],
        ['plugins.row.config', ROW_CONFIG_KEY],
        ['settings.plugin.item', NS],
      ]) {
        try {
          ctx.slots.inject(name, () => ctx.slots.register(
            { name, key, locale: NS, inject: () => ({ ctx, settingsSource }) }, KeyRotationCard,
          ));
        } catch (error) {
          bestEffort('slots.register.log', () => { console.error('[dsh-key-rotation] settings seat unavailable', name, error); });
        }
      }
    }

    module.exports = { apply, inject: ['slots', 'locale'] };
    if (typeof globalThis !== 'undefined') {
      globalThis.__dshKeyRotationClientInternals = {
        quotaMapOf, withQuotas, modelEntriesOf, isValidModelId, formatCountdown, validatePoolDraft,
      };
    }
    return module.exports;
  },
});
