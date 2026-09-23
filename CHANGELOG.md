# Changelog

All notable changes to `@goodandready/dsh-key-rotation` are documented here.
User-facing feature notes also appear in README (en is source of truth).

## Unreleased

### Fixed
- **Settings compatibility and durable writes (PR #19)**: optional lifecycle-owned `configForms` / `settingsScope` acquisition replaces the legacy hard dependency. Modern Host settings now exposes live Config fields, and the running plugin unwraps their current values; legacy namespace registration keeps a plain schema.
- **Secret-preserving saves and imports**: use revision-fenced Host `mutate` rather than replacing a redacted section. Snapshot and provider imports no longer erase hidden tokens. The UI stages imports until explicit Save and submits changed fields only. A modern refusal or ambiguous settlement never triggers a second transport write.
- **Draft recovery and concurrency**: separate saving from snapshot readiness, retain failed/conflicting drafts, make Discard settle, ignore stale reads/service generations, bound requests/file reads, and guard duplicate submissions. Read-only forms still allow local Discard.
- **Key-pool editing**: retain original indices under provider search, fix batch removal, preserve weights/expiry on move/remove/Undo, keep empty pools editable, and associate typed credentials with their references. Earlier credential saves no longer clear later input. Runtime filtering retains metadata indices and bounds weights.
- **Host configuration and bridge details**: modern provider descriptors refresh on invalidation, auto-unbreak timing can be changed live, malformed mutations fail closed, request bodies are bounded, and bracketed IPv6 loopback origins are recognized without accepting invalid IPv4-like hosts.

### Verification
- Replaced source-only regex assertions with real React interaction and route behavior tests.
- Added isolated real Host/Cordis tests for 0.1.5-rc.2, 0.1.6-alpha.2, and 0.1.7-alpha.1, including persistence and restart.
- Added cross-platform Node/core CI and explicit test discovery. See `TESTING.md` for commands, fixture boundaries, and the distinction from Desktop/live-provider acceptance.

## 0.8.19 - 2026-09-22

### Fixed
- **Restored pool state hydration & telemetry preservation (GitHub PR #14)**: extracted `initializePoolState()` and `hasPoolActivity()` into `lib/pool-state.js`. `StatePersistence.restorePools()` now hydrates existing runtime pools in-place, ensuring transient fields like `events` array are never undefined. `pushEvent()` defensively guards `events` array so telemetry errors cannot throw `TypeError` and mask underlying provider errors as `TRANSPORT`.
- **Circuit breaker probe lifecycle & stream accounting (GitHub PR #15)**: added once-settled request permits with generation tokens in `CircuitBreaker`. Correctly counts the first half-open probe, checks admission before each key attempt, prevents late failures while open from extending cooldowns, and distinguishes error/aborted terminals from successes in `rotate()`.
- **Accurate quota failure classification & backoff overflow saturation (GitHub PR #16)**: narrowed `penalizeRef()` quota detection regex in `lib/rotate.js` to explicit quota-exhaustion phrases (`insufficient_quota`, `quota exhausted`, `You exceeded your current quota`), preventing ordinary rate limits (e.g. `rate limit exceeded`, `requests per minute exceeded`, `deadline exceeded`) from being held until midnight UTC. Replaced 32-bit signed integer shifts in `computeBackoff()` with `Math.pow(2, failCount - 1)`, preventing negative delay wrap-around on 32+ failures.
- **Quarantined key auto-unbreak isolation (GitHub PR #17)**: in `setupAutoUnbreakEffect()`, quarantined keys are now probed using the un-wrapped original credentials resolver handle, ensuring the exact broken key is tested rather than a healthy neighbor chosen by the rotation wrapper. Added concurrency lock and state-observation checks to prevent stale probes from clearing newer failures.
- **Client error message visibility & empty ref validation (GitHub Issue #13)**: `validateBeforeSave()` in `lib/client.js` now normalizes and extracts `vres.message ?? vres.error?.message` from pre-save validation failures, displaying the server-provided reason instead of the generic "validation failed" toast. `buildPoolItem()` in `lib/pool-builder.js` filters out empty, whitespace-only, and invalid ref names using `isValidRef()`.

## 0.8.18 - 2026-09-21

### Fixed
- **Stream success failCount reset (#336)**: `rotate()` now invokes `recordSuccess(pool, activeRef, now())` upon successful stream completion and clean EOF, clearing accumulated `failCounts`, removing stale `failedUntil`, and updating `lastSuccessAt`.
- **Calendar-based quota reset connection (#337)**: connected `quota-window.js` (`nextQuotaReset`) to `penalizeRef` in `lib/rotate.js` when `QUOTA` / `RESOURCE_EXHAUSTED` / quota errors occur and `quotaResetWindow` is configured. Ensures exhausted keys remain penalized until calendar reset window instead of rapidly failing over back into penalty. Enhanced `nextQuotaReset` to safely handle both object and string window configurations.
- **Penalty decay during maintenance sweeps (#338)**: `sweepExpired` in `lib/pool.js` now invokes `decayPenalties({ state: st }, now)`, allowing keys with historic transient failures that have run stably to gradually recover their base backoff levels. Also cleans up expired `quotaWindows`. Removed redundant duplicate check in `isSwitchableError`.
- **State persistence during failover (#339)**: `schedulePersist()` is now passed into `createRotate()` and invoked whenever a key failover occurs, ensuring key penalty and switch state is promptly written to disk across restarts.
- **Dead imports cleanup (#340)**: removed 16 unused named imports from `lib/index.js` (`pickCascadeFallback`, `nextQuotaReset`, `usageRows`, `usageCsv`, `findSecrets`, `readJson`, `writeSection`, etc.) ensuring lean bundle evaluation.
- **Remote configuration import timeout (#341)**: added 10-second timeout via `AbortSignal.timeout(10000)` to remote `fetch(url)` in `/dsh-key-rotation/import` route (`lib/ops-keys.js`), returning HTTP 504 Gateway Timeout with structured error code `'timeout'` on network stalls.

## 0.8.17 - 2026-09-21

### Fixed
- **Provider catalog decoupling in settings UI (#333, GitHub #11 / PR #12)**: `useProviderCatalog` in `lib/client.js` now loads the active provider catalog (`/dsh-key-rotation/config`) independently of `settingsScope` readiness, using `AbortController` and `window.focus` refresh. Eliminates false-negative `(not registered)` badge on existing routes when the settings snapshot was already ready on initial render. Fallback configuration loading is protected against overwriting newer settings values.
- **Modern provider probe endpoint discovery (#333, GitHub #11 / PR #12)**: extracted dedicated resolver `resolveProbeBaseUrl(ctx, provider)` in `lib/probe-endpoint.js`. Inspects `llm.listConfigurableProviders()` and resolves connection URLs from `settingsNs` + `settingsPath` in effective settings (`settings.describe()`). Supports `baseURL`, `baseUrl`, `apiBase`, `endpoint`, and `url`, eliminating false `no-baseurl` errors when probing SenseNova and modern dictionary-configured pi-ai / standalone adapters. Implements safe path traversal and fail-closed validation.

## 0.8.16 - 2026-09-20

### Fixed
- **Header chip translation scope (#330, GitHub #7 / PR #8)**: `KeyRotationHeaderChip` in `lib/client.js` now accepts props and resolves translator `resolveT(props)` before opening popover, preventing `ReferenceError: t is not defined` and fixing disappearance on first click. Header slot registration includes `locale: NS`.
- **Live bulk key testing & bounded concurrency (#330, GitHub #9 / PR #10)**: "Test all keys" now executes live API probes (`probe: 'models'`) identically to individual testing via unified `runKeyTests()`, eliminating false-positive green status on invalid keys. Requests are serialized (concurrency 1) to avoid bursting endpoints, mutex `testRunRef` guards duplicate clicks, and returned failure error codes (`tr.code`) are displayed in the UI.

## 0.8.15 - 2026-09-20

### Fixed
- **Settings on the plugin's own page**: the plugin-list seat `plugins.item` is the one
  the current core (0.1.6-alpha.2) renders as the plugin's page with its configuration;
  the row seat alone leaves the page without the form. `KeyRotationCard` is now
  registered there too (`id: 'dsh-key-rotation'`, order 60) with a **static** label —
  the label is resolved while the page renders, and a locale lookup there aborts the
  whole client batch. The row seat and the legacy `settings.plugin.item` card stay as
  fallbacks.
- The authoring test no longer forbids every hardcoded label: it now requires the
  list-seat label to be static while the card body keeps using `t(...)`.

## 0.8.14 - 2026-09-19

### Fixed
- **Critical fix: switchable error rotation crash (#324, GitHub #3 / PR #4)**: `isSwitchableError()` in `lib/pool.js` now normalizes `switchCodes` to a `Set` when passed as an array. Previously, runtime schema arrays (`cfg.switchCodes`, `DEFAULT_SWITCH_CODES`) caused `TypeError: switchCodes.has is not a function`, crashing turns on rate limits, quota exhaustion, and 5xx errors instead of rotating keys.
- **Critical fix: settings UI render crash (#324, GitHub #2 / PR #5)**: declared `UpdaterSection` at factory scope in `lib/client.js` before `KeyRotationSection`, removing the `apply(ctx)`-local declaration that caused `ReferenceError: UpdaterSection is not defined`.
- **Security hardening: packageSpec validation (#324, GitHub #6)**: added strict package spec regex validation in `lib/plugin-updater.js` `installExact()` before child process invocation, preventing command-option injection.
- **Settings reachable again**: the card registered into `settings.plugin.item`, a
  slot the current DSH core (0.1.6-alpha.2) no longer renders, so the plugin's
  settings were unreachable. The surface now registers into the Plugins page row
  seat `plugins.row.config` first, keyed
  `@goodandready/dsh-key-rotation#dsh-key-rotation` (`rowConfigKey(package, rowId)`):
  the plugin's row gains a configure control whose page is the settings form
  (`view: 'page'`, open and without our card chrome — the host page draws the title,
  icon, crumb and padding) plus a one-line state for `view: 'summary'`. The legacy
  seat stays registered as a fallback for older cores.

Version bump and public release are intentionally held back for now: the feature
work on `feat/issue-303-v089-evolution` is still in flight, so this change lands in
`main` without a release.

## 0.8.13 - 2026-09-17

### Changed
- **Server Decomposition (#312)**: `lib/index.js` decomposed from 924 to ~562 lines to meet the 600-line plugin authoring threshold. Extracted modular services into `lib/logger.js`, `lib/sandbox-service.js`, `lib/budget-monitor.js`, `lib/pool-builder.js`, and `lib/lifecycle.js`. Public exports and runtime behavior are 100% preserved.
- **Logging Alignment**: replaced all runtime `console.warn` calls across server modules (`lib/index.js`, `lib/rotate.js`, `lib/ops-status.js`, `lib/ops-webhook.js`) with Cordis scoped logger (`ctx.logger('key-rotation')` / `getLogger(ctx)`).

### Fixed
- **Preflight & Theme Conformance (#312)**:
  - Client UI: eliminated 11 hardcoded fallback hex color literals from `lib/client.js`, strictly adopting `--dsw-alias-state-*` tokens.
  - Client UI: requested `IconChevronDownOutline14` in module header to satisfy preflight icon contract.
  - HTTP Bridge: added strict HTTP method guard (`GET`, `PUT`, `DELETE`, `OPTIONS`) on `/api/dsh-key-rotation/config` write-capable routes.
- Preflight score improved to `FAIL: 0, WARN: 1` (only `lib/client.js` exceeding 600 lines as documented single-file browser bundle).

### Verification
- unit: 375 pass / 0 fail / 1 skipped
- `bash preflight.sh`: FAIL: 0, WARN: 1

## 0.8.12 - 2026-09-16

### Changed
- **Internal decompose (#312)**: operational HTTP routes split from a single `lib/routes-ops.js` facade into focused modules (`lib/ops-status.js`, `ops-telemetry.js`, `ops-keys.js`, `ops-test.js`, `ops-webhook.js`, shared `lib/ops-paths.js`). Public entry `registerOpsRoutes` is unchanged.
- Notify helpers (`notifySwitch`, `pushEvent`, `notifyExhaustion`) extracted to `lib/notify-events.js`; `lib/index.js` re-exports the public pair.
- `lib/client.js` intentionally remains a single ModuleLoader factory (no bundler contract); pure helpers stay in `lib/client-helpers.js`.

### Fixed
- `stability-hardening` inject mock now provides `sctx.get` so the settings registration path runs when the schemastery peer is present.

### Notes
- No user-facing behavior change: same HTTP paths, same rotation/notify semantics, same settings card.
- `lib/index.js` `apply()` remains a single cordis wiring unit by design.

### Packaging
- New runtime modules under `lib/` are included via existing `files: ["lib", ...]`.

### Verification
- unit: 377 pass / 0 fail
- PR #319 merged to main (`4d78853`)

## 0.8.11 - 2026-09-16

### Added
- **One-click plugin updater** (#307): host endpoint `GET/POST /api/dsh-key-rotation/update` and settings UI section to check the latest npm version and install it via the standard `dsh plugin add` path. POST is loopback + same-origin gated; GET exposes version metadata only.
- `lib/best-effort.js` helper for intentional non-critical side effects (sync + async, debug log, never throws) (#315).
- `dsh.client.inject` declares `@deepseek-ai/dsh-client-locale` and `@deepseek-ai/dsh-client-ui-settings` (#313).
- Unit tests: `test/plugin-updater-307.test.mjs`, `test/best-effort.test.mjs`.

### Changed
- Client styles use theme tokens via `color-mix` / `--krot_chart-*` instead of hard-coded rgba/hex (#311).
- Cyrillic comments in `lib/client.js` translated to English; locale note documents en+zh (#309).
- DESIGN.md locks: ModuleLoader single-file client constraint; short cordis `export const name` vs scoped npm identity; bestEffort policy (#312, #315).

### Fixed
- Empty `catch` blocks that swallowed persistence, circuit-reset, webhook-callback and UI errors now go through `bestEffort` with debug logging (#315).
- Production-path tests retargeted after removal of dead exports (`isSoftFailure`, `TokenBucketAccumulator`, etc.) and `test/bucket-o1.test.mjs` (#314).

### Removed
- Internal agent files (`AGENTS.md`, `index.md`, `docs/plans/*`) from the git publication set and npm pack (#308).
- Stale release `.tgz` artifacts from the DEV tree (#310).

### Packaging
- `npm pack`: 34 files, max file ~105KB (`lib/client.js`), no AGENTS/index/docs/plans/openwiki.

### Verification
- unit: 248 pass / 0 fail / 1 skip
- preflight: empty-catch FAIL cleared; remaining name FAIL is accepted short cordis id (image-gen convention)
- MiniPC test contour: status 200, updater GET 200, POST foreign/missing origin 403, cleanup OK
- Production candidate (temporary tgz): status 200, providers=2 keys=7 present=7, updater GET 200, POST 403 on non-local origin

## 0.8.8 - 2026-09-12

- feat(ui): add dedicated `.krot-header` with live status badges (pools count, keys configured, circuit state, health score) and subtitle matching `dsh-clinebot` styling (#301, #302)
- fix(ops): resolve `ReferenceError: quotaStore is not defined` in `GET /dsh-key-rotation/health` by passing dependency from `index.js` and adding defensive invocation (#301, #302)
- fix(ops): import `isLoopbackAddress` in `routes-ops.js` for local loopback verification without Origin header (#301, #302)
- fix(ops): guard `lastTestCache.snapshot` in `GET /dsh-key-rotation/sandbox-cache` against Map and mock instances (#301, #302)
- fix(ops): synchronize provider reset in `POST /dsh-key-rotation/webhook-action` with `RESET_PATH` to clear `authFailCounts`, reset `switches`, and reset `circuitBreaker` (#301, #302)
- fix(ops): single-key reset in `POST /dsh-key-rotation/reset` now checks and clears `brokenUntil` and `authFailCounts` even when cooldown has elapsed (#301, #302)
- fix(ops): clean up orphan entries from `poolState` and `lastTestCache` upon key deletion via `DELETE /dsh-key-rotation/key` (#301, #302)
- test: add comprehensive test suites `test/routes-ops-comprehensive.test.mjs` (12 tests) and `test/http-bridge-config.test.mjs` (5 tests), increasing overall test coverage to 89.40% (359 total unit tests) (#301, #302)

## 0.8.7 - 2026-09-12

- fix(client): resolve `t is not defined` ReferenceError during client bundle factory loading (#285)
- test: add automated VM execution test for client module loader factory and exports (`test/client-factory-import.test.mjs`)

## 0.8.6 - 2026-09-11

- feat(ops): add e2e failover harness covering multi-key pool exhaustion and recovery (#285)
- feat(ops): add chaos concurrency tests for parallel rotate/cooldown/reset races (#286)
- feat(ops): persist pool and circuit-breaker state across restarts via `lib/persistence.js` (#287)
- fix(ops): resolve persistence path from `persistencePath` → `DSH_HOME` → `cwd`; do not read `ctx.baseDir` (#287, #299)
- feat(ops): sanitize status snapshots — key values never leave the host (#288)
- feat(ui): accessible modal (dialog role, focus trap, Escape, focus restore) (#289)
- feat(ui): loading/error/unavailable/empty card states (#290)
- feat(ui): keyboard navigation and bulk key removal with confirmation (#291)
- fix(locale): complete en locale coverage for new UI strings (#292)
- docs: refresh `index.md` coverage matrix and pack policy (#293, #296)
- docs: document ModuleLoader single-file client constraint and helper split (#294)
- chore: branch/worktree hygiene audit recorded (#295)

## 0.8.5 - 2026-09-10

- feat(ui): add interactive key load distribution bar chart (`.krot-load-chart`, `.krot-load-bar`, `.krot-load-segment`) displaying proportional request volume per key (#283, #284)
- feat(ui): add modal action confirmation dialog (`.krot-modal`, `.krot-modal-card`) for pool cooldown resets and provider/key deletions (#283, #284)
- fix(ops): activate jitter (`applyJitter`) on 429 and 5xx backoff calculations in `lib/rotate.js` and `lib/index.js` to eliminate the thundering herd retry spike (#283, #284)
- fix(ops): synchronously reset provider `circuitBreaker` on `POST /dsh-key-rotation/reset` ops route (#283, #284)
- test: add dedicated Phase 2 test suite `test/stability-phase2-283.test.mjs` (313 total unit tests passing) (#283, #284)

## 0.8.4 - 2026-09-10

- fix(ui): inject `settingsScope` in client manifest and safely guard context property access to prevent ErrorBoundary crash on card mount (#281)

## 0.8.3 - 2026-09-10

- feat(ui): unify settings card styling with `dsh-clinebot` design baseline (`.krot-section-card`, `.krot-stat-box`, `.krot-badge-ok/warn/bad`, `.krot-btn-primary/danger`, 36px inputs with brand focus, `data-dsh-plugin="dsh-key-rotation"` style isolation) (#281, #282)
- feat(ui): add live pool health telemetry stat boxes (configured pools, total keys, healthy/ready keys) (#281)
- feat(ui): replace hardcoded hex colors with semantic DSH design system tokens (`--dsw-alias-state-*`, `--dsw-alias-bg-*`) for full dark/light theme fidelity (#281)
- test: add comprehensive stability coverage test suite (`test/stability-coverage-281.test.mjs`, 18 new unit tests covering quota windows, clock monotonicity, sandbox cache, pool network guards, and http bridge helpers) (#281)

## 0.8.2 - 2026-09-10

- fix(ui): settings live only as `settings.plugin.item` card — fallback `settings.section` sidebar row removed (#275)
- fix: resolve DSH services via `ctx.get('llm')` / `sctx.get('settings')` instead of bare context properties that proxy to `undefined` (#275)
- fix(locale): source strings are English-only (`ctx.locale.register(NS, { en })`); other languages come from host `props.t` / translation plugins (#277, GitHub #1)
- fix(locale): active locale falls back `ctx.locale` snapshot → first `navigator.languages` entry → `en` (core-aligned) (#277)
- test: card-only, `ctx.get` and full Cyrillic-in-literal locale gates

## 0.8.1 - 2026-09-09

- fix(ui): settings card no longer disappears on open — ErrorBoundary around the section and referentially stable `settingsScope.getSnapshot()` (#273)

## 0.8.0 - 2026-09-09

Stability block (#260–#270). Changed in v0.8.0.

- feat: per-provider **circuit breaker** (`circuitBreakerEnabled`, threshold/openMs/halfOpenProbes) — fail fast while a provider is down (#260)
- fix: **monotonic process clock** (`performance.timeOrigin + performance.now`) for cooldowns/durations so NTP jumps do not corrupt remaining times (#261)
- perf: **BoundedMap** (max + TTL + LRU) foundation for usage/notify maps (#262)
- fix: **non-blocking webhook notify** via bounded NotifyQueue with backoff — rotate() never awaits webhook I/O (#263)
- feat: **atomic file I/O helpers** (`atomicWriteFile`/`safeReadJson`/`safeParseJson`) — corrupt JSON never wipes previous state (#264)
- fix: in-stream failover remains safe across reload; `quotaStore` properly injected into rotate (#265)
- feat: **clone-route GC** — `expectedClones` computed from live providers; orphans dropped from runtime set (#266)
- test: **error taxonomy table** — 408/425/429/5xx, ECONNRESET/ETIMEDOUT, gRPC codes classified switch|surface|cooldown (#267)
- fix: status API returns **single snapshot** with `circuit`, `meta.expectedClones`, `meta.notifyQueue` (#268)
- test: **smoke harness** `test/smoke-rotation-080.test.mjs` — mock 429 → key switch → success (#269)
- docs: full 0.8.0 documentation package (README en/ru/zh config tables, DESIGN taxonomy, index test matrix) (#270)

## 0.7.40 - 2026-09-09

- docs: align README en/ru/zh and DESIGN.md with shipped surface after v0.7.36 de-bloat (#251)
- docs: add project `index.md` and `AGENTS.md` (#252)
- refactor: split `lib/index.js` into `rotate.js`, `http-bridge.js`, `routes-ops.js` (#253)
- feat: `verboseLogging` config (default false) gates per-request rotation logs (#254)
- docs: CHANGELOG history and task_plan hygiene (#255)

## 0.7.39 - 2026-08-28

- fix(heal): wire `lastUsedAt` into `credentials.resolve` and idle self-heal sweep; cache sweep runtime (issue #249, PR #250)
- perf: fewer redundant `buildRuntime()` calls on hot path

## 0.7.38 - 2026-08-28

- perf(hotpath): single-pass `extractRateLimit`, memoized `todayIso`, zero-allocation status totals, purge stale notify maps (issue #246)

## 0.7.37 - 2026-08-28

- fix(concurrency): AsyncLocalStorage request isolation for `pickedRef`; stream-exception failover before first token; copy `attemptList`; wire 30-day usage compaction; clear quarantine after successful sandbox probe (issue #243)

## 0.7.36 - 2026-08-27

- refactor: remove overengineered modules (`shadow`, `incident`, `agent-budget`, `region`, `canary`, `maintenance`)
- perf: memoize `buildRuntime()`, atomic pointer round-robin, HTTP/gRPC error detection, exhaustion ETA, smart visibility polling

## 0.7.34 - 2026-08-27

- fix(authoring): lifecycle dispose for credentials.resolve / stream listeners; secret role masking; settingsScope integration (PR #241)

## 0.7.33 - 2026-08-27

- fix: key probing baseURL via pool owner; cascade recursion guard; midnight PST sign; timer cleanup via cordis effect; stale lock recovery in least-loaded balancer; zh locale

## 0.7.31 - 2026-08-27

- perf: O(1) token bucket; soft vs hard backoff; penalty decay; cooldown jitter; canary probing (later removed in 0.7.36); TTFT percentiles; webhook digest; 30-day usage compaction; optimistic UI + filter pills

## 0.7.20 - 2026-08-27

- fix(client): hoist `h` to factory scope for KeyRotationCard (#155)

## Earlier

See Gitea release history and README changelog sections for pre-0.7.20 work.
