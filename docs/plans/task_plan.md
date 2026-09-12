# Task Plan: Code Quality Hardening & UI Alignment with dsh-clinebot

## Phase 1: Research & Audit [DONE]
- [x] Full codebase review of `lib/*.js` and `test/*.js`
- [x] Run `--experimental-test-coverage` to identify coverage gaps
- [x] Detailed audit of `lib/routes-ops.js`, `lib/rotate.js`, `lib/http-bridge.js`
- [x] Side-by-side comparison of `dsh-clinebot/lib/client.js` and `dsh-key-rotation/lib/client.js`
- [x] Identify critical ReferenceErrors and behavioral bugs

## Phase 2: Implementation Plan & User Approval [CURRENT]
- [x] Create `findings.md`, `task_plan.md`, `progress.md`
- [x] Draft `implementation_plan.md` artifact
- [ ] Wait for user approval before modifying code / branch

## Phase 3: Git & Gitea Setup
- [ ] Create Gitea Issue: `feat(quality): ops routes hardening, zero unhandled errors, and dsh-clinebot visual alignment`
- [ ] Create clean git worktree: `.worktrees/feat/code-quality-and-clinebot-style`
- [ ] Update `docs/design/DESIGN.md` per `project-design-contract` skill

## Phase 4: Backend Hardening (`lib/routes-ops.js`, `lib/index.js`, `lib/http-bridge.js`)
- [ ] Fix `quotaStore` dependency passing and safe invocation in `HEALTH_PATH`
- [ ] Fix `isLoopbackAddress` import in `lib/routes-ops.js`
- [ ] Fix `lastTestCache.snapshot` defensive fallback in `SANDBOX_CACHE_PATH`
- [ ] Unify `webhook-action` provider reset to clear `authFailCounts`, reset `switches`, and reset `circuitBreaker`
- [ ] Fix single-ref reset in `RESET_PATH` to check and clear `brokenUntil` and `authFailCounts`
- [ ] Clean up orphan `poolState` and `lastTestCache` on key deletion in `KEY_PATH`

## Phase 5: Client UI Alignment with `dsh-clinebot` (`lib/client.js`)
- [ ] Add `.krot-header` inside `KeyRotationSection` matching `dsh-clinebot`:
  - Icon + Title (`header.title`)
  - Live badges: health/online, active pools count, total keys, circuit state
  - Subtitle (`header.sub`)
- [ ] Align CSS styles, borders, hover tokens, card padding with `dsh-clinebot`
- [ ] Add Russian and English localization dictionaries for new header elements
- [ ] Strict zero-Cyrillic in `lib/client.js` string literals (keep in `ru` dict / `test/locale-277.test.mjs` compliant)

## Phase 6: Automated Test Suite & Coverage Boost
- [ ] Create `test/routes-ops-comprehensive.test.mjs` covering all 10 endpoints:
  - `STATUS_PATH`, `USAGE_PATH`, `SNAPSHOT_PATH`, `KEY_PATH`, `RESET_PATH`, `IMPORT_PATH`, `HEALTH_PATH`, `TEST_PATH`, `SANDBOX_CACHE_PATH`, `webhook-action`
- [ ] Create `test/http-bridge-config.test.mjs` for config bridge GET/PUT/DELETE
- [ ] Run full test suite (`npm test`) -> Target: >360 tests passing, 0 failures, line coverage >85%

## Phase 7: Verification, PR, Release & Deployment
- [ ] Commit via `git-antigravity`
- [ ] Push to Gitea and create Pull Request
- [ ] Request user review / confirmation before merge and release
- [ ] Merge PR, delete worktree
- [ ] Release `v0.8.8`, publish to npm, deploy to `/home/vadim/.dsh/profiles/web` on MiniAI
- [ ] Verify production service and test in browser
