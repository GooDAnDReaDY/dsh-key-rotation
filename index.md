# dsh-key-rotation

Current release line: **0.8.0** (stability block #260–#270).

## Purpose
Transparent per-provider API key rotation for DeepSeek Harness: key pools, pre-emptive rate-limit buckets, stream failover, cascade, interactive webhooks, and a Settings card.

## Status
- Package: `@goodandready/dsh-key-rotation`
- Version: 0.7.39 (see `package.json`)
- Verified: 2026-08 — `node --test test/stability-080.test.mjs test/smoke-rotation-080.test.mjs
node --test` 267 pass / 1 skip (schemastery peer absent locally)

## Paths
- DEV (worktree): `/mnt/external/Project/DEV/dhsplugins/dsh-key-rotation`
- Worktrees: `.worktrees/<branch>` only; root checkout is read-only
- Gitea: `goodandready/dsh-key-rotation`
- Test server (pre-publish): MiniPC `192.168.1.123`, DSH profile `web`
- Production install: only published npm version after quality gate

## Entry points
- Host: `lib/index.js` (cordis `apply`, routes, credentials patch)
- Client: `lib/client.js` (self-contained `__ModuleLoader__` factory)
- Bundle patch: `cordis.patch.yml`

## Modules
- `lib/pool.js` — pure pool arithmetic, switchable errors, loopback bridge helpers
- `lib/rotate.js` — stream failover/rotation generator
- `lib/routes-*.js` — HTTP bridge (config/ops)
- `lib/bucket.js`, `concurrency.js`, `cascade.js`, `quota*.js`, `webhook.js`, `sandbox.js`, `histogram.js`, `heal.js`, `usage-report.js`, `keycheck.js`

## Commands
```bash
# unit tests (no DSH harness, no network)
node --test --test-timeout=10000 test/*.test.js test/*.test.mjs
# or
pnpm test
```

## Release sequence (DSH plugin)
1. Branch + worktree from `origin/main`
2. Implement, unit tests, PR → merge `main`
3. Explicit user OK → deploy `main` to test server via `.tgz` (not `file:`)
4. Clean tests on MiniPC → remove plugin from test profile
5. Explicit user OK «Публикуем релиз?» → version/tag/`npm publish`
6. Production installs exact published version; health/smoke

## Docs
- `docs/design/DESIGN.md` — UI contract
- `docs/plans/` — task plans
- `README.md` / `README.ru.md` / `README.zh.md` — user docs (en is source of truth)

## Constraints
- No secrets in repo; key values live in DSH credentials; browser sees only key tails
- Admin HTTP routes are loopback + same-origin (`isTrustedBridgeRequest`)
- `webhookActionToken` is `role('secret')`
- Force flags, `file:` runtime deps on worktrees, and publish-before-test are forbidden
