# Task Plan — Issue #283: Advanced Stability Hardening & Visual Load Distribution Charts

## Current Objective
Phase 2: Comprehensive stability audit & 429/5xx recovery hardening together with visual load distribution charts and confirmation modals for sensitive operations.

## Status Overview
- **Issue**: Gitea Issue #283 (Open)
- **Worktree**: `.worktrees/feat/stability-phase2-and-charts`
- **Current Phase**: Implementation Plan Created -> Waiting for User Approval

## Phases

### Phase 1: Research & Planning [COMPLETED]
- [x] Create Gitea Issue #283
- [x] Create isolated git worktree `feat/stability-phase2-and-charts`
- [x] Audit `lib/routes-ops.js`, `lib/rotate.js`, `lib/pool.js`, and `lib/client.js`
- [x] Identify failure cases: absence of jitter by default (thundering herd risk on 429), unhandled circuit breaker reset on ops route, lack of visual load distribution per key, lack of action confirmation for pool resets.
- [x] Formulate comprehensive implementation plan.

### Phase 2: Implementation [COMPLETED]
- [x] Update `lib/pool.js`: jitter default, safe decay in `sweepExpired`, circuit reset helper.
- [x] Update `lib/rotate.js`: jitter propagation in `penalizeRef`, safe retry-after backoff.
- [x] Update `lib/routes-ops.js`: circuit breaker reset integration in `/dsh-key-rotation/reset`.
- [x] Update `lib/index.js`: pass circuitBreaker to ops routes, enable jitter on agent error hook.
- [x] Update `lib/client.js`: `.krot-load-chart` segmented load distribution bar, `.krot-modal` confirmation dialog, CSS tokens, English localization keys.
- [x] Create `test/stability-phase2-283.test.mjs`: new unit test suite.
- [x] Update `docs/design/DESIGN.md`: record Locked Design Decisions for Phase 2.

### Phase 3: Verification & Review [UPCOMING]
- [x] Run `npm test` across all unit tests (313 pass / 0 fail / 1 skip) (target: ~320+ passing tests, 0 failures).
- [x] Verify zero-Cyrillic string literals in `lib/client.js` (pass).
- [x] Syntax check across all `lib/*.js` (pass).
- [ ] Create PR on Gitea and present Walkthrough to user.
