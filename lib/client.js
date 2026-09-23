// dsh-key-rotation — Settings card (Key Rotation).
// Renders in Settings → Plugins → Plugin settings via the settings.plugin.item slot and
// edits the plugin's `dsh-key-rotation` settings namespace through the
// loopback-fenced config bridge at /dsh-key-rotation/config.
//
// The config is a KEY POOL PER PROVIDER: a list of providers, each with a list
// of API-key env names. The provider is picked from the catalog of providers
// actually registered with ctx.llm (served by the host as data.providers), so no
// manual route typing is ever needed. The plugin derives the fallback chain and
// auto-creates clone routes from the key count.
//
// Localization: source strings are English; Chinese is a first-class locale (en + zh).
// Other languages come from the DSH core locale service / translation plugins
// via props.t (slot locale: NS). Active locale prefers ctx.locale.getSnapshot().active,
// else first navigator.languages entry, else 'en' — same fallback chain as DSH core.
window.__ModuleLoader__.load({
  id: '@goodandready/dsh-key-rotation',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

        // Core primitives and chevron icon
    let ChevronIcon = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-primitives') || require('@deepseek-ai/dsh-client-icons');
      ChevronIcon = primitives && (primitives.IconChevronDownOutline14 || primitives.IconChevronDownOutline);
    } catch (err) {
      ChevronIcon = null;
    }

    const CONFIG_PATH = '/dsh-key-rotation/config';
    const NS = 'dsh-key-rotation';
    // Plugins page row seat (DSH 0.1.6-alpha.2): key = '<package name>#<row id>'.
    const PKG = '@goodandready/dsh-key-rotation';
    const ROW_ID = 'dsh-key-rotation';
    const ROW_CONFIG_KEY = PKG + '#' + ROW_ID;

    // -------------------------------------------------------------- i18n
    const en = {
      title: 'Key Rotation',
      'header.title': 'Key Rotation & Failover',
      'header.sub': 'Automated multi-key round-robin rotation, 429/5xx exponential backoff cooldowns, circuit breaker failover protection, and credential security (~/.dsh/.credentials.yaml).',
      'header.pools_badge': 'pools active',
      'header.keys_badge': 'keys configured',
      sectionStats: 'Pool Health & Telemetry',
      sectionStatsDesc: 'Real-time telemetry of active key pools, healthy credentials, and failover status.',
      sectionFailover: 'Failover Triggers & Error Codes',
      sectionFailoverDesc: 'Select error conditions that trigger automatic switching to the next available key.',
      sectionTiming: 'Timing & Rotation Schedule',
      sectionTimingDesc: 'Configure cooldown durations and scheduled periodic rotation windows.',
      sectionBackup: 'Backup & Snapshots',
      sectionBackupDesc: 'Export or import provider pools and create full plugin configuration snapshots.',
      statPools: 'Configured Pools',
      statKeys: 'Total Keys',
      statHealthy: 'Healthy / Ready',
      loadDistribution: 'Traffic Distribution',
      statRequests: 'requests',
      noTrafficYet: 'No traffic recorded yet',
      confirm: 'Confirm',
      cancel: 'Cancel',
      confirmResetTitle: 'Reset cooldowns for {p}?',
      confirmResetDesc: 'This will immediately clear all failure counts, cooldown timers, and reset the circuit breaker.',
      confirmRemoveProvTitle: 'Remove provider {p}?',
      confirmRemoveProvDesc: 'Are you sure you want to remove this provider and all configured keys from rotation?',
      filterAll: 'All',
      filterReady: 'Ready',
      filterCooldown: 'In Cooldown',
      filterErrors: 'With Errors',
      subtitle: 'Per-provider API key rotation: pools of keys, automatic failover on quota/rate-limit errors, cooldown and recovery.',
      cardDesc: 'Per-provider API key rotation: pools of keys, automatic failover on quota/rate-limit errors, cooldown and recovery.',
      loading: 'Loading…',
      notRegistered: 'not registered',
      providerCatalogUnavailable: 'Provider list unavailable',
      removeKey: 'Remove key',
      removeProvider: 'Remove provider',
      addKey: '+ Add key',
      addKeyTitle: 'Add API key',
      noProviders: 'No providers registered with DSH — nothing to pick from yet.',
      addProvider: '+ Add provider',
      desc: 'Per-provider API key rotation. For each provider, list its API keys (env names, stored in DSH credentials). The plugin routes a model through that provider\u2019s keys in order and switches to the next on a quota/rate-limit failure.',
      cooldown: 'Cooldown after failure (ms)',
      scheduleDays: 'Rotation schedule (days, 0=off)',
      switchCodes: 'Switch codes (comma-separated)',
      providersTitle: 'Providers and their keys',
      save: 'Save',
      discard: 'Discard',
      saving: 'Saving…',
      moveUp: 'Move up',
      moveDown: 'Move down',
      keyActive: 'in use',
      keyReady: 'ready',
      keyCooling: 'cooling down, {s}s',
      keyMissing: 'no such credential',
      switchesNone: 'no switches yet',
      switchesSome: 'switches: {n} · last: {reason}, {ago}',
      justNow: 'just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      codesTitle: 'Switch on these failures',
      keyValuePlaceholder: 'paste the key, then Save',
      keySave: 'Save key',
      keySaved: 'saved',
      keyFromEnv: 'from the environment, read-only here',
      keyWriteFailed: 'could not store the key: {msg}',
      notSecretShape: 'saved, but the value does not look like an API key - check for a typo',
      rpmTitle: 'requests/min: {u} used, {r} remaining',
      budgetLabel: 'budget:',
      exportCsv: 'Export CSV',
      weightHint: 'round-robin weight: how many times this key joins the cycle (1 = equal share)',
      retestBroken: 'Re-test',
      retestFail: 're-test failed - key still down',
      snapshotExport: 'Snapshot ⬇',
      snapshotImport: 'Restore',
      keyHint: 'The value is stored in DSH credentials and never sent back to the browser — only its last 5 characters are shown. Names are generated for you; hover a key to see the one it uses.',
      brokenKey: 'broken (3× AUTH)',
      keyExpired: 'expired',
      keyExpiringSoon: 'expires in {n} d',
      exportPools: 'Export',
      exportOne: '⬇',
      usedAgo: '{ago} ago',
      importPools: 'Import',
      importEnv: 'Import .env',
      resetCooldown: 'Reset cooldown',
      testAll: 'Test all keys',
      testing: 'Testing…',
      testKey: 'Test',
      testOk: 'OK',
      testFail: 'FAIL',
      poolExhausted: 'pool exhausted — all keys cooling',
      resetting: 'Resetting…',
      keyLabel: 'Key {n}',
      undoProvider: 'Provider removed',
      undoKey: 'Key removed',
      undo: 'Undo',
      // #289 a11y / #290 states / #291 bulk / #292 locale
      emptyTitle: 'No pools yet',
      emptyDesc: 'Add a provider and at least one API key name to start rotating.',
      errorTitle: 'Could not load settings',
      retry: 'Retry',
      unavailableTitle: 'Settings bridge unavailable',
      unavailableDesc: 'The host did not expose the dsh-key-rotation settings namespace. Reopen Settings or check the plugin is enabled.',
      modalClose: 'Close dialog',
      dialogLabel: 'Confirmation',
      loadChartAria: 'Key traffic distribution',
      bulkCooldownPlaceholder: 'Bulk cooldown (ms)',
      bulkApply: 'Apply to selected',
      bulkRemove: 'Remove selected',
      confirmBulkRemoveTitle: 'Remove {n} provider(s)?',
      confirmBulkRemoveDesc: 'Selected providers and all their keys will be removed from rotation. You can undo once immediately after.',
      selectProvider: 'Select provider {p}',
      activeBadge: 'active',
      healthScoreTitle: 'health score',
      totalRequestsTitle: 'total requests',
      exportProvider: 'Export this provider',
      recentFailures: 'Recent failures ({n})',
      noActivePools: 'No active pools',
      headerPoolsTitle: 'Key rotation pools',
            pausedBudget: 'paused',
      sortUsage: 'Sort by usage',
      testingAllProgress: 'Testing {n}/{total}…',
      liveEventStream: 'Live Event Stream',
      liveEventStreamEmpty: 'No rotation events recorded',
      eventAt: 'Time',
      eventKey: 'Key',
      eventReason: 'Reason',
      eventCooldown: 'Cooldown',
      quotaResetIn: 'Reset in {time}',
      routingStrategyLabel: 'Routing Strategy',
      routingStrategyRoundRobin: 'Round-Robin (default)',
      routingStrategyLeastLoaded: 'Least-Loaded (concurrency)',
      routingStrategyLowestLatency: 'Lowest-Latency (p95)',
      proactiveGuardLabel: 'Proactive Rate-Limit Guard',
      proactiveGuardHint: 'Pre-emptively pause keys when remaining quota or Retry-After header indicates limit before hitting 429',
      selfHealingLabel: 'Auto-Unbreak Interval (min)',
      selfHealingHint: 'Periodic free model check to revive broken keys (0 to disable)',
    };

    
    const zh = {
      title: '密钥轮换',
      'header.title': '密钥轮换与故障转移',
      'header.sub': '自动化多密钥轮换、429/5xx指数退避冷却、断路器保护及凭证安全 (~/.dsh/.credentials.yaml)。',
      'header.pools_badge': '个活跃密钥池',
      'header.keys_badge': '个已配置密钥',
      sectionStats: '密钥池健康与遥测',
      sectionStatsDesc: '活跃密钥池、健康凭证和故障转移状态的实时遥测。',
      sectionFailover: '故障转移触发器与错误代码',
      sectionFailoverDesc: '选择触发自动切换至下一个可用密钥的错误条件。',
      sectionTiming: '时间与轮换计划',
      sectionTimingDesc: '配置冷却持续时间和定期轮换计划窗口。',
      sectionBackup: '备份与快照',
      sectionBackupDesc: '导出或导入提供商密钥池，并创建完整插件配置快照。',
      statPools: '已配置密钥池',
      statKeys: '总密钥数',
      statHealthy: '健康 / 就绪',
      loadDistribution: '流量分布',
      statRequests: '请求',
      noTrafficYet: '暂无流量记录',
      confirm: '确认',
      cancel: '取消',
      confirmResetTitle: '重置 {p} 的冷却状态？',
      confirmResetDesc: '这将立即清除所有故障计数、冷却计时器并重置断路器。',
      confirmRemoveProvTitle: '移除提供商 {p}？',
      confirmRemoveProvDesc: '确定要从轮换中移除该提供商及其所有已配置密钥吗？',
      filterAll: '全部',
      filterReady: '就绪',
      filterCooldown: '冷却中',
      filterErrors: '存在错误',
      subtitle: '按提供商 API 密钥轮换：密钥池、配额/限流错误自动故障转移、冷却与恢复。',
      cardDesc: '按提供商 API 密钥轮换：密钥池、配额/限流错误自动故障转移、冷却与恢复。',
      loading: '加载中…',
      notRegistered: '未注册',
      providerCatalogUnavailable: '提供商列表暂不可用',
      removeKey: '移除密钥',
      removeProvider: '移除提供商',
      addKey: '+ 添加密钥',
      addKeyTitle: '添加 API 密钥',
      noProviders: 'DSH 尚未注册任何提供商 — 暂无可选项目。',
      addProvider: '+ 添加提供商',
      desc: '按提供商的 API 密钥轮换。为每个提供商列出其 API 密钥（环境变量名，存储在 DSH 凭据中）。插件按顺序通过提供商的密钥路由模型，并在配额/速率限制失败时切换到下一个。',
      cooldown: '故障后冷却时间 (毫秒)',
      scheduleDays: '轮换计划 (天数，0=关闭)',
      switchCodes: '切换代码 (逗号分隔)',
      providersTitle: '提供商与其密钥',
      save: '保存',
      discard: '放弃',
      saving: '保存中…',
      moveUp: '上移',
      moveDown: '下移',
      keyActive: '使用中',
      keyReady: '就绪',
      keyCooling: '冷却中，{s}秒',
      keyMissing: '凭证不存在',
      switchesNone: '暂无切换',
      switchesSome: '切换次数: {n} · 上次: {reason}, {ago}',
      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      codesTitle: '在这些故障时切换',
      keyValuePlaceholder: '粘贴密钥，然后保存',
      keySave: '保存密钥',
      keySaved: '已保存',
      keyFromEnv: '来自环境变量，此处只读',
      keyWriteFailed: '无法存储密钥: {msg}',
      notSecretShape: '已保存，但该值看起来不像 API 密钥 - 请检查是否有拼写错误',
      rpmTitle: '请求/分钟: 已用 {u}, 剩余 {r}',
      budgetLabel: '预算:',
      exportCsv: '导出 CSV',
      weightHint: '轮换权重：该密钥参与循环的次数 (1 = 等分)',
      retestBroken: '重新测试',
      retestFail: '重新测试失败 - 密钥仍然不可用',
      snapshotExport: '快照 ⬇',
      snapshotImport: '恢复',
      keyHint: '该值存储在 DSH 凭据中，绝不会发送回浏览器 — 仅显示其最后 5 个字符。名称已自动生成；悬停在密钥上可查看其使用的名称。',
      brokenKey: '已损坏 (3× 认证失败)',
      keyExpired: '已过期',
      keyExpiringSoon: '{n} 天后过期',
      exportPools: '导出',
      exportOne: '⬇',
      usedAgo: '{ago}前使用',
      importPools: '导入',
      importEnv: '导入 .env',
      resetCooldown: '重置冷却',
      testAll: '测试所有密钥',
      testing: '测试中…',
      testKey: '测试',
      testOk: '正常',
      testFail: '失败',
      poolExhausted: '密钥池耗尽 — 所有密钥冷却中',
      resetting: '重置中…',
      keyLabel: '密钥 {n}',
      undoProvider: '提供商已移除',
      undoKey: '密钥已移除',
      undo: '撤销',
      emptyTitle: '暂无密钥池',
      emptyDesc: '添加提供商及至少一个 API 密钥名称以开始轮换。',
      errorTitle: '无法加载设置',
      retry: '重试',
      unavailableTitle: '设置桥接不可用',
      unavailableDesc: '宿主未暴露 dsh-key-rotation 设置命名空间。请重新打开设置或检查插件是否已启用。',
      modalClose: '关闭对话框',
      dialogLabel: '确认',
      loadChartAria: '密钥流量分布',
      bulkCooldownPlaceholder: '批量冷却时间 (毫秒)',
      bulkApply: '应用到所选项',
      bulkRemove: '删除所选项',
      confirmBulkRemoveTitle: '删除 {n} 个提供商？',
      confirmBulkRemoveDesc: '所选提供商及其所有密钥将从轮换中移除。操作后可立即撤销一次。',
      selectProvider: '选择提供商 {p}',
      activeBadge: '活跃',
      healthScoreTitle: '健康评分',
      totalRequestsTitle: '总请求数',
      exportProvider: '导出此提供商',
      recentFailures: '近期故障 ({n})',
      noActivePools: '无活跃密钥池',
      headerPoolsTitle: '密钥轮换池',
      pausedBudget: '已暂停',
      sortUsage: '按使用量排序',
      testingAllProgress: '正在测试 {n}/{total}…',
      liveEventStream: '实时事件流',
      liveEventStreamEmpty: '暂无轮换事件记录',
      eventAt: '时间',
      eventKey: '密钥',
      eventReason: '原因',
      eventCooldown: '冷却',
      quotaResetIn: '{time} 后重置',
      routingStrategyLabel: '路由策略',
      routingStrategyRoundRobin: '轮询 (默认)',
      routingStrategyLeastLoaded: '最低负载 (并发)',
      routingStrategyLowestLatency: '最低延迟 (p95)',
      proactiveGuardLabel: '前瞻性限流防护',
      proactiveGuardHint: '当响应中的剩余配额或 Retry-After 头提示即将超限时，预先冷却密钥以防触发 429',
      selfHealingLabel: '自愈检查间隔 (分钟)',
      selfHealingHint: '定期轻量探测以自动恢复损坏密钥 (0 为禁用)',
    };

    // Codes worth switching on. Host list is DEFAULT_SWITCH_CODES; config may
    // add extras — those render as separate checked boxes so a custom rule is
    // not dropped on first save.
    const KNOWN_CODES = ['QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'UNKNOWN_MODEL', 'AUTH'];

    // #273: keep the settings list item mounted if the section throws.
        const bestEffort = (label, fn) => {
          try { return fn(); } catch (err) {
            try { console.debug('[dsh-key-rotation] best-effort ' + label, err); } catch { /* console unavailable */ }
            return undefined;
          }
        };
    class KeyRotationErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        bestEffort('error-boundary.log', () => { console.error('[dsh-key-rotation] settings card crashed', error, info); });
      }
      render() {
        if (this.state.error) {
          return React.createElement('div', { className: 'krot krot-err', style: { padding: 12 } },
            React.createElement('p', null, 'Key Rotation settings failed to render.'),
            React.createElement('p', { style: { fontSize: 11, opacity: 0.8 } }, String(this.state.error?.message || this.state.error)),
            React.createElement('button', {
              type: 'button',
              className: 'krot-btn',
              onClick: () => this.setState({ error: null }),
            }, 'Retry'));
        }
        return this.props.children;
      }
    }

    /** Poll rotation status while the settings section is open (smart polling). */
    function useRotationStatus() {
      const [byProvider, setByProvider] = React.useState({});
      React.useEffect(() => {
        let alive = true;
        const pull = () => {
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          fetch('/dsh-key-rotation/status', { headers: { accept: 'application/json' } })
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
          fetch('/dsh-key-rotation/sandbox-cache', { headers: { accept: 'application/json' } })
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
      '.krot-in:focus{outline:none;border-color:var(--dsw-alias-state-brand-primary)}',
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
      '.krot-badge-warn{border-color:var(--dsw-alias-state-warning-primary);color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 8%, transparent)}',
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
      '.krot-pill-warn{border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary) 30%, transparent);color:var(--dsw-alias-state-warning-primary)}',
      '.krot-pill-err{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);color:var(--dsw-alias-state-error-primary)}',
      '.krot-alert-ok{padding:10px 14px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary);font-size:13px;display:flex;align-items:center;gap:10px}',
      '.krot-alert-bad{padding:10px 14px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary);font-size:13px;display:flex;align-items:center;gap:10px}',
      '.krot-event-stream{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.krot-event-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.krot-event-time{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      ':root{--krot-chart-4:var(--dsw-alias-state-brand-primary);--krot-chart-5:var(--dsw-alias-state-error-primary);--krot-chart-6:var(--dsw-alias-state-success-primary)}',
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

    function UpdaterSection({ t }) {
      const [state, setState] = React.useState({ phase: 'idle', current: '', latest: '', message: '' });
      const load = React.useCallback(async () => {
        setState((s) => ({ ...s, phase: 'loading', message: '' }));
        try {
          const res = await fetch('/api/dsh-key-rotation/update', { headers: { 'x-dsh-plugin-update': '1' } });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message || t('updateFailed'));
          setState({
            phase: data.updateAvailable ? 'available' : 'current',
            current: data.currentVersion || '',
            latest: data.latestVersion || '',
            message: data.updateAvailable ? t('updateAvailable') : t('updateNone'),
          });
        } catch (e) {
          setState({ phase: 'error', current: '', latest: '', message: e?.message || t('updateFailed') });
        }
      }, [t]);
      React.useEffect(() => { load(); }, [load]);
      const run = async () => {
        setState((s) => ({ ...s, phase: 'running', message: t('updateRunning') }));
        try {
          const res = await fetch('/api/dsh-key-rotation/update', {
            method: 'POST',
            headers: { 'x-dsh-plugin-update': '1', 'content-type': 'application/json' },
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message || t('updateFailed'));
          setState({
            phase: 'done',
            current: data.currentVersion || '',
            latest: data.installedVersion || data.latestVersion || '',
            message: t('updateRestart'),
          });
        } catch (e) {
          setState({ phase: 'error', current: '', latest: '', message: e?.message || t('updateFailed') });
        }
      };
      return h('div', { className: 'krot-update', style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            t('currentVersion') + ': ' + (state.current || '—')),
          state.latest ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            t('latestVersion') + ': ' + state.latest) : null,
          h('button', {
            className: 'krot-btn',
            type: 'button',
            disabled: state.phase === 'running' || state.phase === 'loading',
            onClick: load,
          }, t('updateCheck')),
          state.phase === 'available' ? h('button', {
            className: 'krot-btn krot-btn-primary',
            type: 'button',
            disabled: state.phase === 'running',
            onClick: run,
          }, t('updateRun')) : null,
        ),
        state.message ? h('div', {
          className: state.phase === 'error' ? 'krot-alert-bad' : state.phase === 'done' ? 'krot-alert-ok' : '',
          style: { marginTop: 8, fontSize: 12 },
        }, state.message) : null,
      );
    }

    // Provider registration is not part of settingsScope's value. Fetch it
    // independently, and never turn an unavailable catalog into proof of absence.
    function useProviderCatalog() {
      const [catalog, setCatalog] = React.useState({ status: 'loading', providers: [] });
      const requestRef = React.useRef(null);
      const reload = React.useCallback(() => {
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setCatalog((s) => ({ ...s, status: 'loading' }));
        return fetch(CONFIG_PATH, { headers: { accept: 'application/json' }, signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error('provider catalog unavailable');
            const data = await response.json();
            if (!Array.isArray(data?.providers) || !data.providers.every((p) =>
              p && typeof p.id === 'string' && p.id.length > 0)) {
              throw new Error('invalid provider catalog');
            }
            if (controller.signal.aborted || requestRef.current !== controller) return;
            setCatalog({ status: 'ready', providers: data.providers.map((p) => ({
              id: p.id, name: typeof p.name === 'string' ? p.name : p.id,
            })) });
          })
          .catch(() => {
            if (!controller.signal.aborted && requestRef.current === controller) {
              setCatalog((s) => ({ ...s, status: 'error' }));
            }
          });
      }, []);
      React.useEffect(() => {
        reload();
        // A provider may have been installed/enabled while this page was open.
        window.addEventListener?.('focus', reload);
        return () => {
          requestRef.current?.abort();
          window.removeEventListener?.('focus', reload);
        };
      }, [reload]);
      return { ...catalog, reload };
    }

    function KeyRotationSection(props) {
      const t = resolveT(props);
      const settingsBinding = React.useMemo(() => {
        const ctx = props.ctx;
        if (!ctx) return null;

        // Core lines differ here: released 0.1.5/0.1.6-alpha builds expose
        // settingsScope, while newer builds may expose configForms instead.
        // Keep the contract identity so save semantics can remain safe: the
        // legacy Promise<void> write API cannot distinguish acceptance from
        // conflict/refusal, while ConfigForm.mutate() returns boolean.
        try {
          const form = ctx.configForms?.get?.(NS);
          if (form && typeof form.getSnapshot === 'function'
            && typeof form.subscribe === 'function') {
            return { kind: 'configForm', service: form };
          }
        } catch (_) {
          // Fall through to the legacy service.
        }

        try {
          const scope = ctx.settingsScope?.bind?.({ namespace: NS }) ?? null;
          if (scope && typeof scope.getSnapshot === 'function'
            && typeof scope.subscribe === 'function') {
            return { kind: 'settingsScope', service: scope };
          }
          return null;
        } catch (_) {
          return null;
        }
      }, [props.ctx]);
      const settingsScope = settingsBinding?.service ?? null;
      const settingsContract = settingsBinding?.kind ?? null;
      // #273: getSnapshot must be referentially stable or React 18 unmounts the tree
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
        if (prev.has && Object.is(prev.value, next)) return prev.value;
        // shallow-compare common snapshot shape to avoid identity thrash
        if (prev.has && prev.value && next
          && prev.value.status === next.status
          && prev.value.revision === next.revision
          && prev.value.value === next.value) {
          return prev.value;
        }
        scopeCacheRef.current = { has: true, value: next };
        return next;
      }, [settingsScope]);
      const scopeSnapshot = React.useSyncExternalStore(
        React.useMemo(() => (cb) => (settingsScope && typeof settingsScope.subscribe === 'function' ? settingsScope.subscribe(cb) : () => {}), [settingsScope]),
        getScopeSnapshot
      );
      const [state, setState] = React.useState({ status: 'loading', value: null, revision: 0, error: '', providers: [] });
      const catalog = useProviderCatalog();
      const latestScopeSnapshot = React.useRef(scopeSnapshot);
      latestScopeSnapshot.current = scopeSnapshot;
      // #290: surface settingsScope availability as card state
      React.useEffect(() => {
        if (!settingsScope) {
          setState((s) => (s.status === 'unavailable' ? s : { ...s, status: 'unavailable' }));
        }
      }, [settingsScope]);
      const [draft, setDraft] = React.useState(null);
      // Fence a staged edit to the revision it started from. Live snapshots may
      // advance while the user is editing; using their newer revision would let
      // an older draft overwrite a concurrent change instead of conflicting.
      const draftRevisionRef = React.useRef(null);
      const saveInFlightRef = React.useRef(false);
      // ── all hooks live ABOVE any early return (React error 310 otherwise) ──
      const [search, setSearch] = React.useState('');
      const [statusFilter, setStatusFilter] = React.useState('all');
      const [confirmModal, setConfirmModal] = React.useState(null);
      const [optimisticReset, setOptimisticReset] = React.useState({});
      const [selected, setSelected] = React.useState(new Set());
      const [bulkCooldown, setBulkCooldown] = React.useState('');
      const [undo, setUndo] = React.useState(null);
      const undoTimer = React.useRef(null);
      // #289 a11y: confirm dialog focus trap / Escape / restore (hooks above returns)
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
      const stashUndo = (u) => { setUndo(u); if (undoTimer.current) clearTimeout(undoTimer.current); undoTimer.current = setTimeout(() => setUndo(null), 5000); };
      const doUndo = () => { if (!undo) return; const u = undo; setUndo(null); setField((cur) => {
        const providers = [...(cur.providers ?? [])];
        if (u.type === 'provider') providers.splice(Math.min(u.index, providers.length), 0, u.entry);
        else if (providers[u.index]) { const keys=[...providers[u.index].keys]; keys.splice(Math.min(u.kIndex, keys.length), 0, u.key); providers[u.index] = { ...providers[u.index], keys }; }
        return { ...cur, providers };
      }); };
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

      const load = React.useCallback(() => {
        const scopeIsReady = () => latestScopeSnapshot.current?.status === 'ready'
          && latestScopeSnapshot.current.value;
        setState((s) => ({ ...s, status: 'loading', error: '' }));
        fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((data) => {
            // The scope may have become ready while this fallback was in flight.
            // A bridge snapshot must not replace that newer value or its revision.
            if (scopeIsReady()) return;
            setState({
              status: 'ready',
              value: data.value ?? null,
              revision: data.revision ?? 0,
              providers: Array.isArray(data.providers) ? data.providers : [],
              error: data.error ? data.error.message : '',
            });
          })
          .catch((e) => {
            if (!scopeIsReady()) setState((s) => ({ ...s, status: 'error', error: String(e) }));
          });
      }, []);

      React.useEffect(() => {
        if (scopeSnapshot && scopeSnapshot.status === 'ready' && scopeSnapshot.value) {
          setState((s) => ({
            ...s,
            status: 'ready',
            value: scopeSnapshot.value,
            revision: scopeSnapshot.revision ?? s.revision,
          }));
        } else {
          load();
        }
      }, [load, scopeSnapshot]);

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
        fetch('/dsh-key-rotation/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: providerId }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => { if (!ok) throw new Error(data?.error?.message ?? 'unknown error'); })
          .catch((e) => {
            setSecretError(t('keyWriteFailed').replace('{msg}', String(e?.message ?? e)));
            if (provEntry && Array.isArray(provEntry.keys)) {
              setOptimisticReset((cur) => {
                const next = { ...cur };
                provEntry.keys.forEach((k) => { delete next[k]; });
                return next;
              });
            }
          })
          .finally(() => setResetting(''));
      };
      // #223: re-test a broken key; a successful live probe lifts the 30-day broken quarantine
      const retestBroken = (ref) => {
        setSecretError('');
        fetch('/dsh-key-rotation/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref, probe: 'models' }) })
          .then((r) => r.json())
          .then((data) => {
            if (data && data.ok) {
              return fetch('/dsh-key-rotation/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref }) });
            }
            setSecretError(t('retestFail'));
            return null;
          })
          .catch((e) => setSecretError(t('keyWriteFailed').replace('{msg}', String(e?.message ?? e))));
      };
      const keyInfo = (providerId, ref) => {
        const entryStatus = status[providerId];
        if (!entryStatus || !ref) return null;
        return (entryStatus.keys ?? []).find((k) => k.ref === ref) ?? null;
      };

      const [validating, setValidating] = React.useState('');
      const [validationResult, setValidationResult] = React.useState({});
      const validateBeforeSave = (ref, value) => {
        setValidating(ref);
        return fetch('/dsh-key-rotation/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref, value }),
        })
          .then(async (r) => {
            const data = (await r.json().catch(() => null)) ?? {};
            const resData = !r.ok && data.error
              ? { ok: false, code: data.error.code, message: data.error.message }
              : { ok: r.ok, ...data };
            setValidationResult((m) => ({ ...m, [ref]: resData }));
            return resData;
          })
          .catch((e) => ({ ok: false, message: String(e?.message ?? e) }))
          .finally(() => setValidating(''));
      };
      const saveSecret = async (ref, rowKey) => {
        const value = secretDraft[rowKey];
        if (!value) return;
        setSecretError('');
        // Pre-save validation (issue #118)
        setValidating(ref);
        const vres = await validateBeforeSave(ref, value);
        setValidating('');
        if (vres && vres.ok === false && vres.code === 'no-credential') {
          // No credential yet is fine for a new key being saved
        } else if (vres && !vres.ok) {
          const msg = vres.message ?? vres.error?.message ?? 'validation failed';
          setSecretError(t('keyWriteFailed').replace('{msg}', msg));
          return;
        }
        fetch('/dsh-key-rotation/key', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref, value }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) throw new Error(data?.error?.message ?? 'unknown error');
            // #200 leak-detector hint: stored value does not match any known
            // API-key shape - probably a placeholder or a typo.
            if (data?.looksLikeSecret === false) {
              setSecretError(t('notSecretShape'));
            }
            setSecretDraft((cur) => {
              const next = { ...cur };
              delete next[rowKey];
              return next;
            });
          })
          .catch((e) => setSecretError(t('keyWriteFailed').replace('{msg}', String(e?.message ?? e))));
      };
      // #290: explicit card states — loading / error / unavailable / empty / ready
      if (state.status === 'loading' || (!val && state.status !== 'error' && state.status !== 'unavailable')) {
        return React.createElement('div', { className: 'krot-state-block', role: 'status', 'aria-live': 'polite', style: { padding: '18px 4px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 } }, t('loading')),
          React.createElement('div', {
            className: 'krot-skeleton',
            'aria-hidden': 'true',
            style: {
              height: 10, borderRadius: 999, background: 'linear-gradient(90deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-3), var(--dsw-alias-bg-layer-2))',
              backgroundSize: '200% 100%', animation: 'krot-shimmer 1.2s ease-in-out infinite', maxWidth: 280,
            },
          })
        );
      }
      if (state.status === 'error') {
        return React.createElement('div', { className: 'krot-state-block', role: 'alert', style: { padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' } },
          React.createElement('p', { className: 'krot-err', style: { margin: 0 } }, t('errorTitle') + (state.error ? (': ' + state.error) : '')),
          React.createElement('button', { type: 'button', className: 'krot-btn', onClick: () => load() }, t('retry'))
        );
      }
      if (state.status === 'unavailable' || !settingsScope) {
        return React.createElement('div', { className: 'krot-state-block', role: 'status', style: { padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '6px' } },
          React.createElement('p', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: 0 } }, t('unavailableTitle')),
          React.createElement('p', { className: 'krot-hint', style: { margin: 0 } }, t('unavailableDesc'))
        );
      }

      const providers = catalog.providers;
      const providerById = new Map(providers.map((p) => [p.id, p.name]));

      const setField = (fn) => {
        // Do not let edits race an in-flight save. Otherwise a later edit can
        // be cleared when the earlier request settles.
        if (saveInFlightRef.current) return;
        if (draftRevisionRef.current === null) {
          draftRevisionRef.current = state.revision;
        }
        setDraft(fn(val));
      };
      const clearDraft = () => {
        draftRevisionRef.current = null;
        setDraft(null);
      };
      const providerList = Array.isArray(val.providers) ? val.providers.filter((p) => Array.isArray(p.keys) && p.keys.length > 0).filter((p) => !search || p.provider.toLowerCase().includes(search.toLowerCase())) : [];

      const setProvider = (index, id) => setField((cur) => {
        const next = [...(Array.isArray(cur.providers) ? cur.providers : [])];
        next[index] = { ...next[index], provider: id };
        return { ...cur, providers: next };
      });
      const addKey = (pIndex) => setField((cur) => {
        const providers = [...(cur.providers ?? [])];
        const entry = { ...(providers[pIndex] ?? {}) };
        const allRefs = providers.flatMap((prov) => prov?.keys ?? []);
        entry.keys = [...(entry.keys ?? []), nextKeyRef(entry.provider, entry.keys, allRefs)];
        // keep weights aligned with keys (#215): new key gets default weight 1
        if (Array.isArray(entry.weights) && entry.weights.length > 0) entry.weights = [...entry.weights, 1];
        providers[pIndex] = entry;
        return { ...cur, providers };
      });
      const removeKey = (pIndex, kIndex) => { setField((cur) => {
        const next = [...(Array.isArray(cur.providers) ? cur.providers : [])];
        stashUndo({ type: 'key', index: pIndex, kIndex, key: next[pIndex]?.keys?.[kIndex] });
        next[pIndex] = { ...next[pIndex], keys: (next[pIndex].keys ?? []).filter((_, i) => i !== kIndex) };
        // weights are positional - drop along with the key (#215)
        if (Array.isArray(next[pIndex].weights) && next[pIndex].weights.length > 0) {
          next[pIndex] = { ...next[pIndex], weights: next[pIndex].weights.filter((_, i) => i !== kIndex) };
        }
        return { ...cur, providers: next };
      }); };
      const removeProvider = (pIndex) => setField((cur) => {
        const arr = Array.isArray(cur.providers) ? cur.providers : [];
        stashUndo({ type: 'provider', index: pIndex, entry: arr[pIndex] });
        return { ...cur, providers: arr.filter((_, i) => i !== pIndex) };
      });
      // Key order is attempt order — move it with buttons, do not retype names.
      const moveKey = (pIndex, kIndex, delta) => setField((cur) => {
        const providers = [...(cur.providers ?? [])];
        const entry = { ...(providers[pIndex] ?? {}) };
        const keys = [...(entry.keys ?? [])];
        const target = kIndex + delta;
        if (target < 0 || target >= keys.length) return cur;
        const moved = keys[kIndex];
        keys[kIndex] = keys[target];
        keys[target] = moved;
        entry.keys = keys;
        // weights are positional - swap along with the keys (#215)
        const weights = [...(entry.weights ?? [])];
        if (weights.length > 0) {
          const w = weights[kIndex];
          weights[kIndex] = weights[target];
          weights[target] = w;
          entry.weights = weights;
        }
        providers[pIndex] = entry;
        return { ...cur, providers };
      });
      // #215: set a single key's round-robin weight (integer >= 1)
      const setKeyWeight = (pIndex, kIndex, weight) => setField((cur) => {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(weight) || 1)));
        const providers = [...(cur.providers ?? [])];
        const entry = { ...(providers[pIndex] ?? {}) };
        const weights = [...(entry.weights ?? [])];
        while (weights.length < (entry.keys ?? []).length) weights.push(1);
        weights[kIndex] = n;
        entry.weights = weights;
        providers[pIndex] = entry;
        return { ...cur, providers };
      });

      // Config codes missing from the known list still render as checked items;
      // otherwise the checkboxes would silently drop a custom rule on first save.
      const selectedCodes = new Set(Array.isArray(val.switchCodes) ? val.switchCodes : []);
      const codeList = [...KNOWN_CODES, ...[...selectedCodes].filter((c) => !KNOWN_CODES.includes(c))];
      const toggleCode = (code, on) => setField((cur) => {
        const current = new Set(Array.isArray(cur.switchCodes) ? cur.switchCodes : []);
        if (on) current.add(code); else current.delete(code);
        return { ...cur, switchCodes: codeList.filter((c) => current.has(c)) };
      });

      const addProvider = () => setField((cur) => ({
        ...cur,
        providers: [...(Array.isArray(cur.providers) ? cur.providers : []), { provider: '', keys: [''] }],
      }));

      const save = () => {
        if (!draft || saveInFlightRef.current) return;
        const savingDraft = draft;
        const expectedRevision = draftRevisionRef.current ?? state.revision;
        saveInFlightRef.current = true;
        setState((s) => ({ ...s, status: 'saving', error: '' }));

        const failSave = (error) => {
          saveInFlightRef.current = false;
          setState((s) => ({
            ...s,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }));
        };

        const finishNativeSave = () => {
          let committed = null;
          try {
            committed = settingsScope?.getSnapshot?.() ?? null;
          } catch (_) {
            committed = null;
          }
          setState((s) => ({
            ...s,
            status: 'ready',
            value: committed?.status === 'ready' && committed.value !== undefined
              ? committed.value
              : savingDraft,
            revision: typeof committed?.revision === 'number'
              ? committed.revision
              : s.revision,
            error: '',
          }));
          saveInFlightRef.current = false;
          clearDraft();
        };

        const saveViaBridge = () => {
          fetch(CONFIG_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ section: savingDraft, expectedRevision }),
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then(({ ok, data }) => {
              if (!ok || data.error) {
                failSave(new Error(data?.error?.message ?? ('settings write failed (' + String(data?.error?.code ?? 'http') + ')')));
                return;
              }
              setState((s) => ({
                status: 'ready',
                value: data.value ?? savingDraft,
                revision: data.revision ?? s.revision,
                error: '',
                providers: s.providers,
              }));
              saveInFlightRef.current = false;
              clearDraft();
            })
            .catch(failSave);
        };

        // Only the modern ConfigForm contract has an unambiguous boolean
        // settlement. Legacy SettingsScope.mutate()/set() resolve void for
        // both accepted and rejected writes, so legacy saves must use the
        // loopback bridge where revision conflicts are explicit HTTP errors.
        if (settingsContract === 'configForm'
          && settingsScope
          && typeof settingsScope.mutate === 'function') {
          (async () => {
            try {
              const ops = Object.entries(savingDraft).map(([k, v]) => ({
                op: 'set',
                path: [k],
                value: v,
              }));
              const accepted = await settingsScope.mutate(ops, expectedRevision);
              if (accepted === false) {
                saveViaBridge();
                return;
              }
              finishNativeSave();
            } catch (_) {
              saveViaBridge();
            }
          })();
          return;
        }

        saveViaBridge();
      };

      

      const field = (labelText, node) => h('label', { className: 'krot-field' },
        h('span', { className: 'krot-label' }, labelText), node);

      const textInput = (value, onChange, placeholder) => h('input', {
        className: 'krot-in',
        value: value ?? '',
        onChange: (e) => onChange(e.target.value),
        placeholder,
      });

      const btn = (labelText, onClick, opts) => h('button', {
        className: 'krot-btn' + (opts && opts.primary ? ' krot-save' : ''),
        onClick,
        disabled: Boolean(opts && opts.disabled),
        title: (opts && opts.title) || undefined,
      }, labelText);

      // Key state dot: color and label read at a glance; "key not found"
      // catches an env-name typo that would otherwise stay silent.
      const keyStatus = (providerId, ref) => {
        const hit = keyInfo(providerId, ref);
        if (!hit) return null;
        if (hit.expired) return { color: 'var(--dsw-alias-state-error-primary)', text: t('keyExpired') };
        if (hit.expiresAt && !hit.expired) {
          const days = Math.ceil((hit.expiresAt - Date.now()) / 86400000);
          const warnDays = Number(val?.expiryWarnDays) || 7; // #207: configurable horizon
          if (days <= warnDays) return { color: 'var(--dsw-alias-state-warning-primary)', text: t('keyExpiringSoon').replace('{n}', String(days)) };
        }
        if (hit.broken) return { color: 'var(--dsw-alias-state-error-primary)', text: t('brokenKey') };
        if (!hit.present) return { color: 'var(--dsw-alias-state-error-primary)', text: t('keyMissing') };
        if (hit.cooldownMsLeft > 0 && !optimisticReset[ref]) {
          return {
            color: 'var(--dsw-alias-state-warning-primary)',
            text: t('keyCooling').replace('{s}', String(Math.ceil(hit.cooldownMsLeft / 1000))),
          };
        }
        if (hit.active) return { color: 'var(--dsw-alias-state-success-primary)', text: t('keyActive') };
        return { color: 'var(--dsw-alias-label-tertiary)', text: t('keyReady') };
      };

      const searchInput = h('input', { className: 'krot-in', placeholder: 'Search providers…', value: search, onChange: (e) => setSearch(e.target.value), style: { marginBottom: '8px' } });
      const providerRows = providerList.map((entry, pIndex) => {
        const options = [];
        if (entry.provider && !providerById.has(entry.provider)) {
          options.push(h('option', { key: entry.provider, value: entry.provider }, entry.provider + ' (' + (catalog.status === 'ready' ? t('notRegistered')
            : catalog.status === 'loading' ? t('loading') : t('providerCatalogUnavailable')) + ')'));
        }
        options.push(...providers.map((prov) =>
          h('option', { key: prov.id, value: prov.id }, prov.name + (prov.id !== prov.name ? ' — ' + prov.id : ''))));

        const keys = entry.keys ?? [];
        const entryWeights = entry.weights ?? [];

        let readyCount = 0, cooldownCount = 0, errorCount = 0;
        for (const k of keys) {
          const st = keyStatus(entry.provider, k);
          const isCool = (st && (st.text === t('brokenKey') || (st.text && st.text.includes(t('keyCooling').slice(0, 4))))) && !optimisticReset[k];
          const tr = testResult[k];
          if (tr && !tr.ok) errorCount++;
          if (isCool) cooldownCount++;
          else readyCount++;
        }

        const filteredIndices = keys.map((k, idx) => ({ key: k, kIndex: idx })).filter(({ key: k }) => {
          if (statusFilter === 'all') return true;
          const st = keyStatus(entry.provider, k);
          const isCool = (st && (st.text === t('brokenKey') || (st.text && st.text.includes(t('keyCooling').slice(0, 4))))) && !optimisticReset[k];
          const tr = testResult[k];
          if (statusFilter === 'ready') return !isCool;
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
          const st = keyStatus(entry.provider, key);
          const info = keyInfo(entry.provider, key);
          const rowKey = entry.provider + '/' + kIndex;
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
            if (typed) meta.push(btn('✓', () => saveSecret(key, rowKey), { title: t('keySave'), key: 'w' }));
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
          // #215: per-key weight input (default 1)
          meta.push(h('input', { key: 'w', type: 'number', min: 1, max: 1000, className: 'krot-in krot-weight',
            value: (entryWeights[kIndex] ?? info?.weight ?? 1),
            title: t('weightHint'),
            onChange: (e) => setKeyWeight(pIndex, kIndex, e.target.value),
            style: { width: '52px', padding: '2px 6px', fontSize: '12px' } }));
          // #210: RPM capacity indicator (only when rpmLimit is active)
          if (info && info.rpm) meta.push(h('span', { key: 'rpm', className: 'krot-tail',
            title: t('rpmTitle').replace('{u}', String(info.rpm.used)).replace('{r}', String(info.rpm.remaining)),
            style: info.rpm.remaining === 0 ? { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 700 } : undefined },
            '⏱' + info.rpm.remaining));
          if (info && typeof info.cost === 'number' && info.cost > 0) meta.push(h('span', { key: 'c', className: 'krot-tail', title: 'cost' }, '$' + info.cost.toFixed(2)));
          const tr = testResult[key];
          if (tr) meta.push(h('span', { key: 'tr', className: 'krot-tail',
            title: (tr.message || (tr.ok ? t('testOk') : t('testFail')))
              + (!tr.ok && tr.code ? ' · ' + tr.code : '')
              + (tr.ok && tr.modelsCount ? ' · ' + tr.modelsCount + ' models' : '')
              + (tr.ok && tr.latencyMs ? ' · ' + tr.latencyMs + 'ms' : ''),
            style: { color: tr.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)', fontWeight: 700 } },
            tr.ok ? (tr.modelsCount ? tr.modelsCount + 'm' : '✓') : ('✕' + (tr.code ? ' ' + tr.code : ''))));
          // #219: last probe from the sandbox cache, greyed when older than 24h
          else if (!Object.prototype.hasOwnProperty.call(testResult, key) && probeCache && probeCache[key]) {
            const pc = probeCache[key];
            const stale = Date.now() - (pc.at ?? 0) > 86400000;
            meta.push(h('span', { key: 'pc', className: 'krot-tail',
              title: 'last probe ' + (pc.at ? new Date(pc.at).toLocaleTimeString() : '') + (pc.ok ? ' ok' : ' ' + (pc.code ?? 'fail')),
              style: { opacity: stale ? 0.4 : 0.7, color: pc.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } },
              (pc.ok ? '✓' : '✕') + (pc.latencyMs ? ' ' + pc.latencyMs + 'ms' : '')));
          }
          meta.push(h('button', { key: 't', className: 'krot-btn', onClick: () => doTest(key), disabled: Boolean(testing || testAllProvider), title: t('testKey') }, testing === key ? '…' : t('testKey')));
          // #223: broken keys get a one-click live re-test + auto-unbreak
          if (info && info.broken) {
            meta.push(h('button', { key: 'rt', className: 'krot-btn', onClick: () => retestBroken(key), title: t('retestBroken') }, t('retestBroken')));
          }
          meta.push(h('span', { key: 'a', className: 'krot-acts' },
            btn('↑', () => moveKey(pIndex, kIndex, -1), { disabled: kIndex === 0, title: t('moveUp') }),
            btn('↓', () => moveKey(pIndex, kIndex, 1), { disabled: kIndex === keys.length - 1, title: t('moveDown') }),
            btn('✕', () => removeKey(pIndex, kIndex), { title: t('removeKey') }),
          ));

          return h('div', { key: kIndex, className: 'krot-key' },
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
        // #208: budget line (warn color at >=80%, red at 100%)
        const budgetLine = providerStatus && (providerStatus.budgetDaily > 0 || providerStatus.budgetWeekly > 0)
          ? (() => {
              const dayRatio = providerStatus.budgetDaily > 0 ? providerStatus.todayCost / providerStatus.budgetDaily : 0;
              const weekRatio = providerStatus.budgetWeekly > 0 ? providerStatus.weeklyCost / providerStatus.budgetWeekly : 0;
              const worst = Math.max(dayRatio, weekRatio);
              const color = worst >= 1 ? 'var(--dsw-alias-state-error-primary)' : worst >= 0.8 ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-label-tertiary)';
              const parts = [];
              if (providerStatus.budgetDaily > 0) parts.push('$' + (providerStatus.todayCost ?? 0).toFixed(2) + '/' + '$' + providerStatus.budgetDaily);
              if (providerStatus.budgetWeekly > 0) parts.push('week $' + (providerStatus.weeklyCost ?? 0).toFixed(2) + '/' + '$' + providerStatus.budgetWeekly);
              if (worst >= 1 && providerStatus.pauseOnBudget) parts.push('· ' + t('pausedBudget'));
              return h('p', { className: 'krot-hint', style: { color } }, t('budgetLabel') + ' ' + parts.join(' · '));
            })()
          : null;
        // #225: provider p95 latency + SLO marker
        const sloLine = providerStatus && providerStatus.p95 != null
          ? (() => {
              const over = providerStatus.latencySloMs && providerStatus.p95 > providerStatus.latencySloMs;
              return h('p', { className: 'krot-hint', style: over ? { color: 'var(--dsw-alias-state-warning-primary)' } : undefined },
                'p95 ' + providerStatus.p95 + 'ms' + (providerStatus.latencySloMs ? ' / ' + providerStatus.latencySloMs + 'ms SLO' : ''));
            })()
          : null;
        // #209: CSV export for this provider's usage (last 7 days)
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
            'var(--dsw-alias-state-brand-primary)',
            'var(--dsw-alias-state-success-primary)',
            'var(--dsw-alias-state-warning-primary)',
            'var(--dsw-alias-state-info-primary)',
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
            ) : null
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
                const sorted = [...(next[pIndex].keys ?? [])].sort((a, b) => usageOf(b) - usageOf(a));
                next[pIndex] = { ...next[pIndex], keys: sorted };
                return { ...cur, providers: next };
              });
            }, { title: t('sortUsage') }),
            h('select', { className: 'krot-in', value: entry.provider, onChange: (e) => setProvider(pIndex, e.target.value) }, options),
            (() => {
              const ps = status[entry.provider];
              const score = ps && typeof ps.healthScore === 'number' ? ps.healthScore : null;
              if (score === null) return null;
              const color = score > 80 ? 'var(--dsw-alias-state-success-primary)' : score >= 50 ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-state-error-primary)';
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
          h('div', { className: 'krot-keys' }, keyRows),
          h(UpdaterSection, { t }),
      h('div', { className: 'krot-foot' },
            btn(t('addKey'), () => addKey(pIndex), { title: t('addKeyTitle') }),
            switchesLine,
            budgetLine,
            sloLine,
            exhaustionWarning,
            (providerStatus && Array.isArray(providerStatus.events) && providerStatus.events.length > 0 ? h('div', { style: { display: 'flex', gap: '2px', alignItems: 'end', height: '24px', marginTop: '4px' } }, (() => { const now = Date.now(); const buckets = Array(24).fill(0); for (const ev of providerStatus.events) { const h = Math.floor((now - ev.at) / 3600000); if (h >= 0 && h < 24) buckets[23 - h]++; } const max = Math.max(1, ...buckets); return buckets.map((c, i) => h('div', { key: i, title: c + ' switches', style: { flex: 1, background: c ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-border-l2)', height: (c / max * 24) + 'px', minHeight: '2px', borderRadius: '2px' } })); })()) : null),
            // #224: 7-day switches per day (client-side, from the same events)
            (providerStatus && Array.isArray(providerStatus.events) && providerStatus.events.length > 0 ? h('div', { style: { display: 'flex', gap: '2px', alignItems: 'end', height: '16px', marginTop: '2px' } }, (() => { const now = Date.now(); const days = Array(7).fill(0); for (const ev of providerStatus.events) { const d = Math.floor((now - ev.at) / 86400000); if (d >= 0 && d < 7) days[6 - d]++; } const max = Math.max(1, ...days); return days.map((c, i) => h('div', { key: i, title: c + ' switches · day -' + (6 - i), style: { flex: 1, background: c ? 'var(--dsw-alias-state-info-primary, var(--dsw-alias-state-warning-primary))' : 'var(--dsw-alias-border-l2)', height: (c / max * 16) + 'px', minHeight: '2px', borderRadius: '2px' } })); })()) : null),
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
          const isDown = st && (st.text === t('brokenKey') || st.text === t('keyMissing') || (st.text && st.text.includes(t('keyCooling').slice(0, 4)))) && !optimisticReset[k];
          if (!isDown) healthyKeysCount++;
        }
      }

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
            const ids = [...selected];
            if (!ids.length) return;
            setConfirmModal({
              title: t('confirmBulkRemoveTitle').replace('{n}', String(ids.length)),
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
          noProviders
        )
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
        h('div', { className: 'krot-grid-3', style: { marginTop: '10px' } },
          field(t('routingStrategyLabel'), h('select', {
            className: 'krot-in',
            value: val.routingStrategy ?? 'round-robin',
            onChange: (e) => setField((cur) => ({ ...cur, routingStrategy: e.target.value })),
          }, [
            h('option', { key: 'round-robin', value: 'round-robin' }, t('routingStrategyRoundRobin')),
            h('option', { key: 'least-loaded', value: 'least-loaded' }, t('routingStrategyLeastLoaded')),
            h('option', { key: 'lowest-latency', value: 'lowest-latency' }, t('routingStrategyLowestLatency')),
          ])),
          field(t('selfHealingLabel'), textInput(String(val.selfHealingIntervalMinutes ?? 30), (v) => setField((cur) => ({ ...cur, selfHealingIntervalMinutes: Number(v) || 0 })))),
          field(t('proactiveGuardLabel'), h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', height: '36px', cursor: 'pointer' } }, [
            h('input', {
              type: 'checkbox',
              checked: val.proactiveRateLimitGuard ?? true,
              onChange: (e) => setField((cur) => ({ ...cur, proactiveRateLimitGuard: e.target.checked })),
            }),
            h('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, t('proactiveGuardLabel')),
          ]))
        )
      );

      const backupSection = h('div', { className: 'krot-section-card' },
        h('div', { className: 'krot-section-title' },
          h('span', null, '💾 ' + t('sectionBackup')),
        ),
        h('div', { className: 'krot-section-desc' }, t('sectionBackupDesc')),
        h('div', { className: 'krot-row' },
          btn(t('exportPools'), () => {
            const data = JSON.stringify(val.providers ?? [], null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'pools.json'; a.click(); URL.revokeObjectURL(url);
          }, {}),
          h('label', { className: 'krot-btn', style: { cursor: 'pointer' } }, t('importPools'), h('input', { type: 'file', accept: '.json', style: { display: 'none' }, onChange: (e) => {
            const f = e.target.files[0]; if (!f) return;
            const reader = new FileReader();
            reader.onload = () => { try { const imp = JSON.parse(String(reader.result)); if (!Array.isArray(imp)) throw new Error('expected array'); setField((cur) => {
              const curProviders = Array.isArray(cur.providers) ? [...cur.providers] : [];
              const map = new Map(curProviders.map((p) => [p.provider, p]));
              for (const p of imp) { if (p && typeof p.provider === 'string') map.set(p.provider, p); }
              return { ...cur, providers: [...map.values()] };
            }); } catch (err) { setSecretError(String(err.message || err)); } };
            reader.readAsText(f);
          } })),
          btn(t('snapshotExport'), () => {
            fetch('/dsh-key-rotation/snapshot', { headers: { accept: 'application/json' } })
              .then((r) => r.json())
              .then((data) => {
                const blob = new Blob([JSON.stringify(data.snapshot ?? {}, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = 'dsh-key-rotation-snapshot.json'; a.click(); URL.revokeObjectURL(url);
              })
              .catch((e) => setSecretError(String(e?.message ?? e)));
          }, {}),
          h('label', { className: 'krot-btn', style: { cursor: 'pointer' } }, t('snapshotImport'), h('input', { type: 'file', accept: '.json', style: { display: 'none' }, onChange: (e) => {
            const f = e.target.files[0]; if (!f) return;
            const reader2 = new FileReader();
            reader2.onload = () => {
              try {
                const snap = JSON.parse(String(reader2.result));
                if (!snap || typeof snap !== 'object' || Array.isArray(snap)) throw new Error('expected snapshot object');
                fetch('/dsh-key-rotation/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot: snap }) })
                  .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
                  .then(({ ok, data }) => { if (!ok) throw new Error(data?.error?.message ?? 'import failed'); load(); })
                  .catch((err) => setSecretError(t('keyWriteFailed').replace('{msg}', String(err?.message ?? err))));
              } catch (err) { setSecretError(String(err.message || err)); }
            };
            reader2.readAsText(f);
          } }))
        ),
        h('p', { className: 'krot-hint', style: { marginTop: '4px' } }, t('keyHint'))
      );

      const alerts = [
        secretError ? h('div', { key: 'se', className: 'krot-alert-bad' }, secretError) : null,
        state.error ? h('div', { key: 'st', className: 'krot-alert-bad' }, state.error) : null,
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

      return h('div', { className: 'krot' },
        confirmModalEl,
        headerSection,
        statsSection,
        poolsSection,
        failoverSection,
        timingSection,
        backupSection,
        alerts.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, alerts) : null,
        h('div', { className: 'krot-foot', style: { marginTop: '6px', paddingTop: '14px', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          btn(t('save'), save, { primary: true, disabled: state.status === 'saving' }),
          btn(t('discard'), () => {
            if (saveInFlightRef.current) return;
            clearDraft();
            load();
          }, { disabled: state.status === 'saving' }),
          state.status === 'saving' ? h('span', { className: 'krot-hint' }, t('saving')) : null,
        )
      );
    }



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

    function apply(ctx) {
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
      // #275: card only — no top-level sidebar row. The host sidebar is a
      // shared flat list; a duplicate row wastes a slot and confuses Settings.
      // Plugin-list seat (plugins.item) first: it is what the current core
      // (0.1.6-alpha.2) renders as the plugin's own page with its configuration. The
      // label is a static string on purpose — it is resolved while the page renders,
      // and a locale lookup there would take the whole client batch down with it.
      try {
        ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            { name: 'plugins.item', id: ROW_ID, order: 60, label: () => 'Key Rotation', locale: NS, inject: () => ({ ctx }) },
            KeyRotationCard,
          ));
        // Row seat and the legacy seat stay as fallbacks.
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: ROW_CONFIG_KEY, locale: NS, inject: () => ({ ctx }) },
            KeyRotationCard,
          ));
        ctx.slots.inject('settings.plugin.item', () =>
          ctx.slots.register(
            { name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({ ctx }) },
            KeyRotationCard,
          ));
      } catch (e) {
        bestEffort('slots.register.log', () => { console.error('[dsh-key-rotation] settings seats register failed', e); });
      }
    }

    module.exports = { apply, inject: ['slots', 'locale', 'settingsScope'] };
    return module.exports;
  },
    updateCheck: 'Check for updates',
    updateAvailable: 'Update available',
    updateNone: 'Plugin is up to date',
    updateRun: 'Update now',
    updateRestart: 'Update installed. Restart DSH to load the new version.',
    updateRunning: 'Updating…',
    updateFailed: 'Update failed',
    currentVersion: 'Current version',
    latestVersion: 'Latest version',

    updateCheck: '检查更新',
    updateAvailable: '有可用更新',
    updateNone: '插件已是最新版本',
    updateRun: '立即更新',
    updateRestart: '更新已安装。请重启 DSH 以加载新版本。',
    updateRunning: '更新中…',
    updateFailed: '更新失败',
    currentVersion: '当前版本',
    latestVersion: '最新版本',

});
