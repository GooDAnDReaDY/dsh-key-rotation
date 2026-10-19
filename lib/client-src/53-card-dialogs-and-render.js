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
          btn('⚡ ' + (testMatrixRunning ? t('testingMatrix') : t('testAllKeys')), runTestMatrix, { disabled: testMatrixRunning || totalKeysCount === 0 }),
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
            h('option', { key: 'sticky', value: 'sticky' }, t('routingStrategySticky')),
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
        ),
        h('div', { className: 'krot-grid-2', style: { marginTop: '10px' } },
          field(t('showChatHeaderChipLabel'), h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', height: '36px', cursor: 'pointer' } }, [
            h('input', {
              key: 'input', type: 'checkbox',
              checked: val.showChatHeaderChip ?? true,
              onChange: (e) => setField((cur) => ({ ...cur, showChatHeaderChip: e.target.checked })),
            }),
            h('span', { key: 'label', style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, t('showChatHeaderChipDesc')),
          ]))
        )
      );

      
      
      const configuredProviders = (draft?.providers ?? state.value?.providers ?? []);
      const simulatorSection = h('div', { className: 'krot-section', style: { marginTop: '14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '14px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
          h('div', null,
            h('span', { style: { fontWeight: 600, fontSize: '13px' } }, '🧪 ' + t('simulatorTitle')),
            h('div', { className: 'krot-hint', style: { fontSize: '11px', marginTop: '2px' } }, t('simulatorDesc'))
          )
        ),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' } },
          h('select', {
            className: 'krot-input',
            style: { width: '140px' },
            value: simProvider || (configuredProviders[0]?.provider || ''),
            onChange: (e) => setSimProvider(e.target.value),
          }, configuredProviders.map((p) => h('option', { key: p.provider, value: p.provider }, p.provider))),
          h('input', {
            type: 'text',
            className: 'krot-input',
            style: { width: '120px' },
            placeholder: t('simulatorSelectModel'),
            value: simModel,
            onChange: (e) => setSimModel(e.target.value),
          }),
          h('select', {
            className: 'krot-input',
            style: { width: '180px' },
            value: simScenario,
            onChange: (e) => setSimScenario(e.target.value),
          },
            h('option', { value: 'success' }, t('simulatorEventSuccess')),
            h('option', { value: 'rate_limit' }, t('simulatorEventRateLimit')),
            h('option', { value: 'error_500' }, t('simulatorEventServer500')),
          ),
          btn(simRunning ? t('simulatorRunning') : t('simulatorRun'), runSimulator, {
            primary: true,
            disabled: simRunning,
          })
        ),
        simError ? h('div', { className: 'krot-warn', style: { marginTop: '8px', color: 'var(--dsw-alias-error)' } }, simError) : null,
        simResult ? h('div', { style: { marginTop: '12px', background: 'var(--dsw-alias-bg-hover)', padding: '10px', borderRadius: '6px' } },
          h('div', { style: { fontWeight: 600, fontSize: '12px', marginBottom: '6px' } }, t('simulatorResults') + ': ' + (simResult.status || 'DONE')),
          h('div', { style: { fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            Array.isArray(simResult.steps) ? simResult.steps.map((st, idx) =>
              h('div', { key: idx, style: { display: 'flex', gap: '8px', fontFamily: 'monospace' } },
                h('span', { style: { color: 'var(--dsw-alias-text-sub)' } }, '[' + (idx + 1) + ']'),
                h('span', { style: { fontWeight: 500 } }, st.ref || '-'),
                h('span', { style: { color: st.status === 'OK' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' } }, st.status),
                h('span', { style: { opacity: 0.8 } }, st.reason || st.error || '')
              )
            ) : null
          )
        ) : null
      );

      const backupSection = h('div', { className: 'krot-section-card' },
        h('div', { className: 'krot-section-title' },
          h('span', null, '💾 ' + t('sectionBackup')),
        ),
        h('div', { className: 'krot-section-desc' }, t('sectionBackupDesc')),
        exportModal ? h('div', { className: 'krot-box', style: { marginBottom: '12px', padding: '12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', background: 'var(--dsw-alias-bg-hover)' } },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '📥 ' + (t('exportConfig') || 'Export Pools')),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer', marginBottom: '8px' } },
            h('input', { type: 'checkbox', checked: exportMasked, onChange: (e) => setExportMasked(e.target.checked) }),
            t('exportSafe') || 'Masked (Safe for sharing)'
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' } },
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('passphraseLabel') || 'Passphrase (optional)'),
            h('input', {
              type: 'password',
              className: 'krot-input',
              value: exportPassphrase,
              onChange: (e) => setExportPassphrase(e.target.value),
              placeholder: t('passphrasePlaceholder') || 'Enter passphrase for AES-256-GCM encryption',
              style: { maxWidth: '360px' }
            })
          ),
          exportError ? h('div', { className: 'krot-alert krot-alert-bad', style: { marginBottom: '8px' } }, exportError) : null,
          h('div', { style: { display: 'flex', gap: '8px' } },
            btn('⬇️ ' + (t('exportConfig') || 'Download JSON'), runExport, { primary: true }),
            btn(t('cancel'), () => setExportModal(false))
          )
        ) : null,
        importModal ? h('div', { className: 'krot-box', style: { marginBottom: '12px', padding: '12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', background: 'var(--dsw-alias-bg-hover)' } },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '📤 ' + (t('importConfig') || 'Import Pools')),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } },
            h('label', { className: 'krot-btn', style: { cursor: 'pointer', fontSize: '12px' } },
              '📁 Choose File',
              h('input', {
                type: 'file',
                accept: '.json',
                style: { display: 'none' },
                onChange: (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => { setImportText(String(ev.target?.result || '')); };
                  reader.readAsText(file);
                }
              })
            ),
            h('span', { style: { fontSize: '12px', opacity: 0.7 } }, 'or paste JSON below')
          ),
          h('textarea', {
            className: 'krot-input',
            rows: 6,
            value: importText,
            onChange: (e) => { setImportText(e.target.value); setImportPreview(null); },
            placeholder: t('jsonConfigPlaceholder') || 'Paste JSON configuration here...',
            style: { width: '100%', fontFamily: 'monospace', fontSize: '11px', marginBottom: '8px' }
          }),
          h('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '8px' } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' } },
              h('input', { type: 'radio', name: 'importMode', checked: importMode === 'merge', onChange: () => setImportMode('merge') }),
              t('importMerge') || 'Merge'
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' } },
              h('input', { type: 'radio', name: 'importMode', checked: importMode === 'replace', onChange: () => setImportMode('replace') }),
              t('importReplace') || 'Replace'
            )
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' } },
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('passphraseLabel') || 'Passphrase (if encrypted)'),
            h('input', {
              type: 'password',
              className: 'krot-input',
              value: importPassphrase,
              onChange: (e) => setImportPassphrase(e.target.value),
              placeholder: t('passphrasePlaceholder') || 'Enter passphrase for decryption',
              style: { maxWidth: '360px' }
            })
          ),
          importError ? h('div', { className: 'krot-alert krot-alert-bad', style: { marginBottom: '8px' } }, importError) : null,
          importPreview ? h('div', { className: 'krot-alert krot-alert-ok', style: { marginBottom: '8px', fontSize: '12px' } },
            `Preview: ${importPreview.createdProviders?.length || 0} created, ${importPreview.updatedProviders?.length || 0} updated, ${importPreview.keysAdded || 0} keys added, ${importPreview.totalKeys || 0} total keys.`
          ) : null,
          h('div', { style: { display: 'flex', gap: '8px' } },
            btn('🔍 ' + (t('importPreview') || 'Preview Diff'), runImportPreview, { disabled: !importText.trim() || importRunning }),
            btn('✅ ' + (t('importApply') || 'Apply Configuration'), runImportApply, { primary: true, disabled: !importText.trim() || importRunning }),
            btn(t('cancel'), () => { setImportModal(false); setImportPreview(null); })
          )
        ) : null,
        h('div', { className: 'krot-row', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          btn('📥 ' + (t('exportConfig') || 'Export Pools'), () => { setExportModal((v) => !v); setImportModal(false); }, { primary: exportModal }),
          btn('📤 ' + (t('importConfig') || 'Import Pools'), () => { setImportModal((v) => !v); setExportModal(false); }, { primary: importModal }),
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

      const discoveryBanner = (discoveredKeys.length > 0 || autoImportMsg) ? h('div', {
        className: 'krot-section-card',
        style: {
          background: 'var(--dsw-alias-bg-hover)',
          border: '1px solid var(--dsw-alias-border-l2)',
          marginBottom: '12px',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('div', null,
            h('span', { style: { fontWeight: 600, fontSize: '13px' } }, t('discoverBannerTitle')),
            h('div', { className: 'krot-hint', style: { fontSize: '11px', marginTop: '2px' } },
              autoImportMsg || t('discoverBannerDesc').replace('{n}', String(discoveredKeys.length))
            ),
          ),
          discoveredKeys.length > 0 ? btn(autoImporting ? t('autoImporting') : t('autoImportBtn'), runAutoImport, {
            primary: true,
            disabled: autoImporting,
          }) : null
        ),
        discoveredKeys.length > 0 ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
          discoveredKeys.slice(0, 10).map((d) => h('span', {
            key: d.ref,
            className: 'krot-badge',
            style: { fontSize: '10px', background: 'var(--dsw-alias-bg-layer-3)' }
          }, `${d.provider}: ${d.ref} ${d.keyTail ? '(' + d.keyTail + ')' : ''}`))
        ) : null
      ) : null;

      const testMatrixDialog = testMatrixModal ? h('div', {
        className: 'krot-modal-backdrop',
        onClick: () => setTestMatrixModal(false),
      },
        h('div', {
          className: 'krot-modal-card',
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (e) => e.stopPropagation(),
          style: {
            maxWidth: '560px',
            width: '90vw',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', { style: { fontWeight: 600, fontSize: '15px' } }, t('matrixModalTitle')),
            btn('✕', () => setTestMatrixModal(false), { className: 'krot-btn-sub' })
          ),
          h('div', { className: 'krot-hint', style: { fontSize: '12px' } }, t('matrixModalDesc')),
          testMatrixRunning ? h('div', { style: { textAlign: 'center', padding: '20px' } }, t('testingMatrix')) : null,
          testMatrixResults ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto', maxHeight: '50vh' } },
            h('div', { style: { fontWeight: 600, fontSize: '13px' } },
              t('matrixSummary').replace('{healthy}', String(testMatrixResults.healthy)).replace('{total}', String(testMatrixResults.total))
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              (testMatrixResults.results || []).map((r, i) => h('div', {
                key: i,
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  background: 'var(--dsw-alias-bg-hover)',
                  fontSize: '12px',
                }
              },
                h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                  h('span', { style: { fontWeight: 500 } }, r.provider),
                  h('span', { style: { fontFamily: 'monospace' } }, r.ref),
                  r.keyTail ? h('span', { style: { color: 'var(--dsw-alias-text-sub)', fontSize: '11px' } }, `(${r.keyTail})`) : null
                ),
                h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                  h('span', { style: { color: 'var(--dsw-alias-text-sub)' } }, `${r.latencyMs || 0}ms`),
                  h('span', {
                    className: 'krot-badge ' + (r.ok ? 'krot-badge-ok' : 'krot-badge-bad')
                  }, r.ok ? 'OK' : (r.code || 'FAIL'))
                )
              ))
            )
          ) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } },
            btn(t('matrixClose'), () => setTestMatrixModal(false), { primary: true })
          )
        )
      ) : null;
      return h('div', { className: 'krot', 'aria-busy': saving || importing },
        confirmModalEl,
        testMatrixDialog,
        headerSection,
        statsSection,
        discoveryBanner,
        h('fieldset', { disabled: saving || importing || !state.writable,
          style: { border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' } },
          poolsSection,
          failoverSection,
          timingSection,
          backupSection,
          simulatorSection,
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



