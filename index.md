# dsh-key-rotation

Current release line: **0.8.x** (stability + UI quality). Working tree: phase 3 (#285–#296).

## Purpose
Transparent per-provider API key rotation for DeepSeek Harness: key pools, pre-emptive rate-limit buckets, stream failover, cascade, interactive webhooks, and a Settings card.

## Status
- Package: `@goodandready/dsh-key-rotation`
- Version: see `package.json` (do not trust stale copies of this file)
- Verified on branch: `node --test --test-timeout=15000 test/*.test.js test/*.test.mjs`
  - Expect **340 pass / 0 fail / 1 skip** (skip = schemastery peer absent locally)
  - Phase 3 suites: `e2e-failover-285`, `chaos-concurrency-286`, `persistence-287`, `sanitize-snapshot-288`, `locale-a11y-292`

## Paths
- DEV root: `/mnt/external/Project/DEV/dhsplugins/dsh-key-rotation`
- Worktrees: `.worktrees/<branch>` only; root checkout is read-only
- Gitea: `goodandready/dsh-key-rotation` (source of truth)
- GitHub: `GooDAnDReaDY/dsh-key-rotation` (public releases/mirror only)
- Test server (pre-publish): MiniPC `192.168.1.123`, DSH profile `web`, port 3082
- Production install: only published npm version after quality gate (`dsh-web.service` on MiniAI)

## Entry points
- Host: `lib/index.js` (cordis `apply`, config schema, credentials patch, persistence)
- Client: `lib/client.js` (self-contained `__ModuleLoader__` factory)
- Bundle patch: `cordis.patch.yml`

## Modules
- `lib/pool.js` — pure pool arithmetic, switchable errors, loopback bridge helpers
- `lib/rotate.js` — stream failover/rotation generator
- `lib/routes-ops.js` / `lib/http-bridge.js` — HTTP ops + config bridge
- `lib/persistence.js` — atomic cooldown/circuit snapshot across restarts (#287)
- `lib/sanitize-snapshot.js` — clamp status payload (#288)
- `lib/circuit-breaker.js`, `bucket.js`, `concurrency.js`, `cascade.js`, `quota*.js`, `webhook.js`, `sandbox.js`, `histogram.js`, `heal.js`, `usage-report.js`, `keycheck.js`, `atomic-io.js`, `client-helpers.js`

## Test matrix (required before release)
| Check | Command | Gate |
|---|---|---|
| Unit + e2e + chaos | `node --test --test-timeout=15000 test/*.test.js test/*.test.mjs` | 0 fail; document pass/skip |
| Pack file list | `npm pack --dry-run --json` | no AGENTS.md / index.md / docs internals; no file >262144 bytes |
| Pack size warn | same | files ≥256000 bytes reduced if possible |
| Secret/PII scan | review diff + grep for keys/IPs/hosts | clean before GitHub/npm |
| Test server | MiniPC install candidate tgz → status/UI → cleanup | keep `dsh-lanmode` |
| Production candidate | temporary tgz → health/smoke | before publish OK |
| Registry install | published version → health/smoke | after publish |

## Publication file policy
`package.json` `files` allowlist: `lib`, `cordis.patch.yml`, `README.md`, `LICENSE` only.
**Never publish** `AGENTS.md`, `index.md`, `docs/`, tests internals, plans, credentials, worktrees.

## Commands
```bash
# unit/e2e tests (no DSH harness, no external network)
node --test --test-timeout=15000 test/*.test.js test/*.test.mjs
```

## Release sequence (DSH plugin)
Gitea issue → worktree from origin/main → implement/test → PR → merge main → MiniPC candidate → production candidate → «Публикуем релиз?» → tag/npm/GitHub → production registry version → close issues → cleanup branch/worktree.
