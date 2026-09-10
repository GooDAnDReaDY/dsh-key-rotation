# Findings & Research — Issue #283

## 1. Jitter in 429 / 5xx Cooldown Calculations
- In `lib/pool.js`, `recordFailure(pool, ref, now, baseMs, maxMs, isSoft = false, jitter = false)` had `jitter` set to `false` by default.
- In `lib/rotate.js`, `penalizeRef` called `recordFailure(..., cls.soft)` without specifying `jitter`.
- As a consequence, all keys failing with 429 or 5xx received strictly deterministic exponential backoff timestamps (`now + 60000 * 2^(n-1)`).
- If multiple keys hit rate limits concurrently, their cooldowns expire at the identical millisecond, resulting in a thundering herd problem where all requests retry at once against the provider.
- Solution: Default `jitter = true` in `recordFailure`, applying `applyJitter(backoff)` (±12.5% random spread) to distribute retries smoothly.

## 2. Circuit Breaker vs Ops Reset Route
- In `lib/routes-ops.js`, `POST /dsh-key-rotation/reset` cleared `failedUntil`, `failCounts`, `authFailCounts`, and `brokenUntil`.
- However, if the provider's `circuitBreaker` had tripped into `open` state, the circuit state machine remained `open` until `openMs` elapsed, because `circuitBreaker` was not notified of the administrative reset.
- Solution: Pass `circuitBreaker` into `registerOpsRoutes`, and call `circuitBreaker.reset(provider)` (or `onSuccess`) when resetting a provider's pool.

## 3. Visual Load Distribution
- Keys inside a provider pool track `info.usage` (total successful requests) and `entry.keys`.
- Users have no instant visual indicator of how evenly or unevenly traffic is distributed among the pool's keys (e.g. 70% Key 1, 20% Key 2, 10% Key 3).
- Solution: A sleek segmented horizontal bar `.krot-load-chart` displaying proportional width per key with distinct semantic theme colors and hover tooltips showing exact request count and percentage.

## 4. Sensitive Action Confirmations
- Currently, clicking "Reset cooldowns" or "Delete key" performs immediate state mutation without confirmation.
- Solution: An accessible confirmation modal `.krot-modal` with dimmed backdrop, preventing accidental disruption in production.
