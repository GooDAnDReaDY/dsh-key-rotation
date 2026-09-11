# Changelog

All notable changes to `@goodandready/dsh-key-rotation` are documented here.
User-facing feature notes also appear in README (en is source of truth).

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
