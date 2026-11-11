# index.md — @goodandready/dsh-key-rotation

Kарта проекта (source of truth в Gitea). Подробности процесса — в `AGENTS.md`, дизайн-контракт — в `docs/design/DESIGN.md`.

## Purpose
Transparent per-provider API key rotation for DeepSeek Harness (`@goodandready/dsh-key-rotation`): key pools, pre-emptive rate-limit buckets, stream failover, cascade, stall watchdog, cache-affinity routing, subagent concurrency partitions, interactive webhooks, header status chip, and Settings card.

## Status
- Release line: **0.8.95** (stability, security hardening & release hygiene)
- Package: `@goodandready/dsh-key-rotation` (`dependencies: {}`, zero runtime deps)
- Audited dependencies: `pnpm audit --prod` → **No known vulnerabilities found** (2026-11-11)
- Test suite: `npm test` (`node tools/test.mjs`) → **1086 pass / 0 fail** (offline, no DSH harness, no network)

## Paths & Channels
- DEV root (read-only): `/mnt/external/Project/DEV/dhsplugins/dsh-key-rotation`
- Worktrees: `.worktrees/<branch>` only
- Gitea (internal source of truth): `goodandready/dsh-key-rotation` (tracks `AGENTS.md`, `index.md`, `docs/**`)
- GitHub (sanitized product mirror): `GooDAnDReaDY/dsh-key-rotation` via `./scripts/publish-github.sh --push` (excludes `AGENTS.md`, `index.md`, `docs/**`, `lib/client-src/**`, `test/**`)
- npm package: `package.json.files` allowlist (105 files: `lib/**/*.js`, `!lib/client-src/**`, `lib/**/*.d.ts`, `cordis.patch.yml`, `README*.md`, `CHANGELOG.md`, `LICENSE`)
- Release packaging rule: always pack outside checkout via `npm pack --pack-destination /tmp` (0 `*.tgz` in repo root)
- Test server (pre-publish): isolated DSH test stand (`profile web`)
- Production install: exact published npm version in `dsh-web.service` on MiniAI

## Entry Points
- Host: `lib/index.js` (Cordis `apply`, Config schema, credentials resolution, lifecycle & persistence)
- Client: `lib/client.js` (bundled via `scripts/build-client.mjs` from `lib/client-src/*.js`; ~213.7 KB, limit 262,144 B)
- Types: `src/types/*.ts` → bundled to `lib/index.d.ts` via `tsdown`
- Bundle patch: `cordis.patch.yml`

## Test & Verification Matrix (Required Before Merge / Release)
| Check | Command | Gate |
|---|---|---|
| Reproducible install | `pnpm install --frozen-lockfile` | Exit 0, lockfile strictly in sync |
| Dependency audit (npm audit equiv.) | `pnpm audit --prod` | 0 known production vulnerabilities |
| Typecheck + syntax + hygiene | `npm run check` | `tsc --noEmit`, JS `--check`, 0 leaked paths/IPs |
| Pack & size guard | `npm run pack:check` | 0 `*.tgz` in root, all files ≤ 262,144 B (WARN ≥ 256,000 B) |
| Full test suite | `npm test` | Runs `build-client` + `pack:check` + all `test/*.test.*`, 0 fail |
| DSH preflight | `bash /home/vadim/.dsh/skills/dsh-plugin-preflight/scripts/preflight.sh .` | `FAIL=0`, 0 dead-export WARNs |
| Sanitized GitHub dry-run | `./scripts/publish-github.sh --check` | No `AGENTS.md`, `index.md`, `docs/**`, `lib/client-src/**` |
| npm tarball allowlist | `npm pack --dry-run --json` | 105 product files only; all 3 READMEs present |
| Isolated test server | Install `.tgz` from `/tmp` on test stand → health/status → cleanup | `DSH_TEST_OK` |
| Production deploy | Install exact npm version → restart `dsh-web.service` → health check | `status: "ok"` |

## Key Modules (`lib/`)
- `lib/pool.js`, `lib/pool-builder.js`, `lib/pool-selection.js`, `lib/resolver.js` — pool topology, weights, tier-priority & cache-affinity selection
- `lib/rotate.js`, `lib/cascade.js`, `lib/circuit-breaker.js`, `lib/heal.js` — failover, circuit breaking, self-heal
- `lib/safe-fetch.js` — SSRF guard (`assertSafeUrl`, `createSafeDispatcher`, `createSafeLookup`, `safeFetchJson`)
- `lib/persistence.js`, `lib/atomic-io.js`, `lib/crypto-storage.js` — atomic state persistence across restarts
- `lib/routes/*.js` & `lib/http-bridge.js` — loopback-guarded HTTP bridge & config export/import (`decryptConfigAsync`)
- `lib/plugin-updater.js` — 1-click npm updater (`GET`/`POST` with loopback/same-origin guard)
- `lib/sanitize-snapshot.js`, `lib/selection-trace.js`, `lib/simulator.js`, `lib/key-drain.js`, `lib/request-budget.js`

## Release Sequence (DSH Plugin)
Gitea issues → worktree from `origin/main` → implement & verify full matrix → PR → user approval → merge `main` → test-stand `.tgz` (from `/tmp`) → production `.tgz` candidate → user «Публикуем релиз?» OK → `./scripts/publish-github.sh --push origin/main` + tag + GitHub Release + `npm publish` → production registry pin → close issues → cleanup branch/worktree.
