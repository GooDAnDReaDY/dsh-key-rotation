# Changelog

All notable changes to `@goodandready/dsh-key-rotation` are documented here.
User-facing feature notes also appear in README (en is source of truth).

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
