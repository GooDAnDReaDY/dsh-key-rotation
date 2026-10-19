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
          if (info && info.pinned) {
            meta.push(h('span', { key: 'pin', className: 'krot-state', title: 'Pinned key' }, '📌'));
          }
          if (info && info.label) {
            meta.push(h('span', { key: 'lbl', className: 'krot-tag', title: 'Key label' }, info.label));
          }
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
          if (info && info.balance) {
            const b = info.balance;
            const isZero = b.isAvailable === false || (typeof b.total === 'number' && b.total <= 0);
            const cur = b.currency || '';
            const amtStr = typeof b.total === 'number' ? b.total.toFixed(2) : String(b.total || 0);
            meta.push(h('span', {
              key: 'bal',
              className: 'krot-tail' + (isZero ? ' krot-badge-bad' : ''),
              title: isZero ? t('balanceEmpty') : ('Upstream balance: ' + amtStr + ' ' + cur),
              style: isZero ? { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 700 } : undefined,
            }, '💰 ' + amtStr + (cur ? (' ' + cur) : '')));
          }
          if (info && info.detectedLimits) {
            const dl = info.detectedLimits;
            const parts = [];
            if (dl.rpmLimit) parts.push(dl.rpmLimit + ' RPM');
            if (dl.tpmLimit) parts.push(dl.tpmLimit + ' TPM');
            if (parts.length > 0) {
              meta.push(h('span', {
                key: 'dl',
                className: 'krot-tail',
                title: 'Live upstream limits:\n' + JSON.stringify(dl, null, 2),
                style: { fontSize: '11px', opacity: 0.8, color: 'var(--dsw-alias-brand-primary)' }
              }, '⚡ ' + parts.join(' · ')));
            }
          }
          if (info && info.modelCapabilities && info.modelCapabilities.length > 0) {
            meta.push(h('span', {
              key: 'caps',
              className: 'krot-tail',
              title: 'Discovered models (' + info.modelCapabilities.length + '):\n' + info.modelCapabilities.join('\n'),
              style: { fontSize: '11px', opacity: 0.85 }
            }, '🤖 ' + info.modelCapabilities.length + 'm'));
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
            ) : null,
            (() => {
              const an = ps && ps.analytics24h ? ps.analytics24h : null;
              if (!an || an.totalRequests === 0) return null;
              const hColor = an.healthIndexPct >= 80 ? 'var(--dsw-alias-state-success-primary)' : an.healthIndexPct >= 50 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)';
              return h('div', { style: { marginTop: '8px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } },
                h('span', { className: 'krot-badge', style: { color: hColor, fontWeight: 700 } }, '🛡️ ' + t('healthIndex') + ': ' + an.healthIndexPct + '% (' + an.firstAttemptSuccesses + '/' + an.totalRequests + ' ' + t('cleanRequests') + ')'),
                an.errorBreakdown.rateLimit > 0 ? h('span', { className: 'krot-badge krot-badge-warn' }, '429: ' + an.errorBreakdown.rateLimit) : null,
                an.errorBreakdown.server > 0 ? h('span', { className: 'krot-badge krot-badge-warn' }, '5xx: ' + an.errorBreakdown.server) : null,
                an.errorBreakdown.timeout > 0 ? h('span', { className: 'krot-badge krot-badge-warn' }, 'Timeout: ' + an.errorBreakdown.timeout) : null,
                an.errorBreakdown.quota > 0 ? h('span', { className: 'krot-badge krot-badge-warn' }, 'Quota: ' + an.errorBreakdown.quota) : null,
                an.cascades > 0 ? h('span', { className: 'krot-badge' }, '🔀 Cascades: ' + an.cascades) : null,
                an.avgCooldownRecoveryMs > 0 ? h('span', { className: 'krot-badge' }, '⏱️ ' + t('avgRecovery') + ': ' + Math.round(an.avgCooldownRecoveryMs / 1000) + 's') : null
              );
            })()
          );
        })();

        const promptCacheWidget = (() => {
          const ps = status[entry.provider];
          const pc = ps && ps.promptCache ? ps.promptCache : null;
          if (!pc || (!pc.d30?.cachedTokens && !pc.allTime?.cachedTokens)) return null;
          const d1 = pc.d1 || { cachedTokens: 0, savingsUsd: 0, hitRatioPct: 0 };
          const d7 = pc.d7 || { cachedTokens: 0, savingsUsd: 0, hitRatioPct: 0 };
          const d30 = pc.d30 || { cachedTokens: 0, savingsUsd: 0, hitRatioPct: 0 };
          const savedStr = d30.savingsUsd > 0 ? '$' + d30.savingsUsd.toFixed(2) : '$0.00';
          return h('div', {
            className: 'krot-prompt-cache-card',
            style: {
              marginTop: '6px',
              marginBottom: '6px',
              padding: '8px 10px',
              background: 'var(--dsw-alias-bg-layer-2)',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px'
            }
          },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              h('span', { style: { fontWeight: 600, fontSize: '12px' } }, '⚡ ' + t('promptCacheTitle')),
              h('span', { className: 'krot-badge krot-badge-ok', style: { fontSize: '11px', fontWeight: 600 } }, savedStr + ' ' + t('promptCacheSaved'))
            ),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
              h('span', null, h('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, '24h: '), (d1.cachedTokens || 0).toLocaleString() + ' tok (' + d1.hitRatioPct + '%)'),
              h('span', null, h('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, '7d: '), (d7.cachedTokens || 0).toLocaleString() + ' tok (' + d7.hitRatioPct + '%)'),
              h('span', null, h('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, '30d: '), (d30.cachedTokens || 0).toLocaleString() + ' tok (' + d30.hitRatioPct + '%)')
            )
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
            btn(t('presetLimitsBtn') || '⚡ Preset Limits', () => applyPreset(pIndex, entry.provider), { title: t('presetLimitsBtn') || '⚡ Preset Limits', disabled: !entry.provider.trim() || !stateRef.current.writable }),
            presetNotice ? h('span', { className: 'krot-badge krot-badge-ok', style: { marginLeft: '4px' } }, presetNotice) : null,
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
          promptCacheWidget,
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
            btn(checkingBalance === entry.provider ? t('checkingBalance') : ('💰 ' + t('balanceCheckBtn')), () => checkBalances(pIndex, entry.provider), {
              disabled: Boolean(checkingBalance) || !entry.provider.trim(),
              title: t('balanceCheckBtn'),
            }),
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

