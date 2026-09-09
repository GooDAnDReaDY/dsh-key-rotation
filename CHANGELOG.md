# Changelog

All notable changes to `@goodandready/dsh-key-rotation` are documented here.
User-facing feature notes also appear in README (en is source of truth).

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
