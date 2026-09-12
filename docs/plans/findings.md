# Findings: Code Quality, Stability & UI Alignment Audit

## 1. Critical Runtime Bugs & Unhandled ReferenceErrors

### Bug 1: `ReferenceError: quotaStore is not defined` in `lib/routes-ops.js:448`
- **Location**: `HEALTH_PATH` (`/dsh-key-rotation/health`), line 448:
  ```javascript
  json(res, 200, { status: exhaustedAny ? 'degraded' : 'ok', pools, exhaustedAny, latency: latencyHistogram.snapshotAll(), quota: quotaStore.snapshot() });
  ```
- **Root Cause**: `quotaStore` is instantiated in `lib/index.js:112`, but was **never passed in `deps`** at line 821 to `registerOpsRoutes(ctx, deps)`, nor imported into `lib/routes-ops.js`.
- **Impact**: Any external monitoring system or internal check calling `GET /dsh-key-rotation/health` immediately crashes with an uncaught `ReferenceError: quotaStore is not defined` (or HTTP 400/500).
- **Remedy**:
  - Pass `quotaStore` in `deps` from `lib/index.js:821`.
  - Destructure `quotaStore` in `registerOpsRoutes(ctx, deps)` in `lib/routes-ops.js:42`.
  - Use defensive chaining: `quota: quotaStore?.snapshot ? quotaStore.snapshot() : null`.

### Bug 2: `ReferenceError: isLoopbackAddress is not defined` in `lib/routes-ops.js:423`
- **Location**: `HEALTH_PATH` (`/dsh-key-rotation/health`), line 423:
  ```javascript
  if (!isLoopbackAddress(req.socket?.remoteAddress)) { res.writeHead(403); res.end(); return; }
  ```
- **Root Cause**: `isLoopbackAddress` is implemented in `lib/pool.js`, but was **omitted from the import statement** in `lib/routes-ops.js:10-19`.
- **Impact**: When `HEALTH_PATH` receives a non-browser local request without `Origin` (standard for Prometheus, Beszel, or curl), calling `isLoopbackAddress` throws `ReferenceError`.
- **Remedy**: Import `isLoopbackAddress` from `./pool.js` in `lib/routes-ops.js`.

### Bug 3: `TypeError: lastTestCache.snapshot is not a function` in `lib/routes-ops.js:516`
- **Location**: `SANDBOX_CACHE_PATH` (`/dsh-key-rotation/sandbox-cache`), line 516:
  ```javascript
  json(res, 200, lastTestCache.snapshot());
  ```
- **Root Cause**: If `lastTestCache` is a Map or mock without `.snapshot`, it throws.
- **Remedy**: Guard with:
  ```javascript
  const snap = typeof lastTestCache?.snapshot === 'function'
    ? lastTestCache.snapshot()
    : (lastTestCache instanceof Map ? Object.fromEntries(lastTestCache) : (lastTestCache ?? {}));
  json(res, 200, snap);
  ```

---

## 2. Behavioral Inconsistencies & Logic Gaps

### Issue 4: Incomplete Provider Reset via Webhook Action (`lib/routes-ops.js:597`)
- **Location**: `POST /dsh-key-rotation/webhook-action` handling `reset-<provider>`.
- **Finding**: In `RESET_PATH` (`POST /dsh-key-rotation/reset`), we reset:
  - `st.failedUntil.clear()`
  - `st.failCounts?.clear()`
  - `st.authFailCounts?.clear()`
  - `st.brokenUntil?.clear()`
  - `st.switches = 0`, `st.lastReason = undefined`, `st.lastSwitchAt = undefined`
  - `circuitBreaker.reset(provider)` / `circuitBreaker.onSuccess(provider)`
  In `webhook-action`, it **omitted** clearing `authFailCounts`, resetting `switches`, and resetting `circuitBreaker`! An operator resetting a tripped provider via Telegram/Discord webhook would find the circuit breaker still open and keys still marked with auth failures!
- **Remedy**: Unify the reset routine across both HTTP `RESET_PATH` and `webhook-action`.

### Issue 5: Single Key Reset Ignores Broken/Auth Failures when not Cooling (`lib/routes-ops.js:369`)
- **Location**: `POST /dsh-key-rotation/reset` with `{"ref": "..."}`.
- **Finding**: Line 369 currently checks:
  ```javascript
  if (st.failedUntil.has(ref) || st.failCounts?.has(ref)) {
  ```
  If a key had its temporary cooldown expire but was permanently flagged in `st.brokenUntil` or accumulated `st.authFailCounts`, line 369 evaluated to `false`, leaving the key marked broken!
- **Remedy**:
  ```javascript
  if (st.failedUntil?.has(ref) || st.failCounts?.has(ref) || st.authFailCounts?.has(ref) || st.brokenUntil?.has(ref)) {
  ```

### Issue 6: Dangling Orphan State on Key Deletion (`lib/routes-ops.js:307`)
- **Location**: `DELETE /dsh-key-rotation/key`.
- **Finding**: When a key is deleted from credentials storage via `DELETE`, its state in `poolState` (`failedUntil`, `failCounts`, `authFailCounts`, `brokenUntil`, `lastUsed`) and `lastTestCache` remains until server restart.
- **Remedy**: Clean up the deleted `ref` across all pools in `poolState` and call `lastTestCache.delete?.(ref)`.

---

## 3. Test Coverage Gaps (Current Line Coverage: 76.01%)
- **`lib/routes-ops.js`**: Only **29.41%** line coverage!
  - `STATUS_PATH`: missing branch coverage
  - `USAGE_PATH`: untested
  - `SNAPSHOT_PATH`: untested
  - `KEY_PATH`: untested
  - `IMPORT_PATH`: untested
  - `HEALTH_PATH`: untested
  - `TEST_PATH`: untested
  - `SANDBOX_CACHE_PATH`: untested
  - `webhook-action`: untested
- **`lib/http-bridge.js`**: Only **44.12%** line coverage!
  - `handleConfigBridge`: untested
  - `writeSection`: untested

---

## 4. UI / Visual Alignment with `dsh-clinebot`

1. **Top Header Section**:
   - `dsh-clinebot` has a unified `.cb-header` with:
     - `.cb-page-title` (Icon + Title + live badges)
     - Live badges for health, key count, failover status
     - `.cb-page-sub` with crisp explanation.
   - `dsh-key-rotation` currently lacks this top-level header inside `KeyRotationSection`, jumping straight into stats/pools.
2. **Typography & Card Spacing**:
   - Align card padding (18px 20px), border-radius (12px), title font size (16px, 600 weight) with `dsh-clinebot`.
3. **Buttons & Pill States**:
   - Synchronize button hover tokens (`--dsw-alias-bg-layer-4`, `--dsw-alias-label-dimmed`) and transitions with `dsh-clinebot`.
4. **Localization**:
   - Full Russian (`ru`) and English (`en`) parity for all new header strings, tooltips, and badges.
