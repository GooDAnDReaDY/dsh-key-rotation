# AGENTS.md — @goodandready/dsh-key-rotation

Project-specific rules only. Root `/mnt/external/Project/DEV/AGENTS.md` still applies.

## Identity
- Package scope: `@goodandready/dsh-key-rotation` (must match `package.json`, `cordis.patch.yml` `name:`, client `load({ id })`)
- Gitea: `goodandready/dsh-key-rotation` (canonical source of truth)
- GitHub: `GooDAnDReaDY/dsh-key-rotation` (sanitized product mirror via `scripts/publish-github.sh` ONLY; never push raw `origin/main` directly)
- Agent git wrapper: `/home/vadim/.ssh/bin/git-<agent>` on MiniAI; never bare `git` for commit/push

## Layout
- Root checkout is read-only. All writes in `.worktrees/<branch>`
- Single DEV folder + single OPT/test profile; no project copies
- Canonical source of truth for runtime code is `lib/` (`src/types/` holds TS declarations only)
- Client `lib/client.js` is built from `lib/client-src/*.js` via `npm run build:client` and must stay self-contained under 262,144 bytes (practical warning threshold 256,000 bytes; currently ~213.7 KB)
- Packaging rule: NEVER run bare `npm pack` inside checkout; always build artifacts outside checkout (`npm pack --pack-destination /tmp`). `npm test` fails if any `*.tgz` exists in root.

## Commands
```bash
pnpm install --frozen-lockfile   # reproducible dependency install
pnpm audit --prod                # dependency vulnerability audit (npm audit equivalent for pnpm)
npm run build                    # rebuild server .d.ts (tsdown) and lib/client.js (esbuild)
npm run check                    # typecheck + JS syntax check + publishable path/IP hygiene
npm run pack:check               # verify 0 stray *.tgz in root, npm pack allowlist & file size limits
npm test                         # pack:check + build-client + full offline test suite (1085+ tests)
```
- Tests must run without DSH harness and without network
- Do NOT put `/home/`, `/mnt/`, machine hostnames, systemd unit names, or LAN IPs (`192.168.*`) in code, docs, CHANGELOG, or tests (use `/tmp/stand`, `example.local`, RFC 5737 TEST-NET `192.0.2.x` / `198.51.100.x` / `203.0.113.x`)

## Release gate
- Only fully working features enter a release
- Run `dsh-plugin-preflight` (`FAIL=0`), `npm run check`, `npm test`, `pnpm audit --prod`, and `./scripts/publish-github.sh --check`
- MiniPC test server install via temporary `.tgz` in `/tmp` or `~/.cache/dsh-test-artifacts/` before any npm publish
- Production gets only the exact published immutable version
- Ask «Публикуем релиз?» and wait for explicit OK before tag / GitHub sanitized publish (`./scripts/publish-github.sh --push origin/main`) / npm publish / GitHub Release
- Never use `--force`, `npm publish --force`, or `file:` paths into `.worktrees/`

## Security
- No hardcoded secrets, IPs of machines, or absolute paths in code/docs
- Route keys through DSH credentials; settings hold env names only
- Masked tails only (`keyTail`, last 5 chars)
- Local admin bridges: `isTrustedBridgeRequest` (strict loopback + origin checks)
- Outbound HTTPS requests use `safeFetchJson` with `assertSafeUrl`, `createSafeDispatcher`, and `createSafeLookup`

## Constraints (MUST NOT)
- Do not change package identity (`@goodandready/...`) without a dedicated migration issue
- Do not add features that burn tokens in the background without tests and owner approval
- Do not edit other DSH plugins' profiles when testing this one
- Do not invent provider defaults that bind the plugin to a specific installation
- Do not publish `AGENTS.md`, `index.md`, `docs/**`, `test/**`, or `lib/client-src/**` to npm or GitHub

## Docs gate
- Update README (en + ru + zh) together when user-facing behavior changes
- Keep `docs/design/DESIGN.md` aligned with real Config keys, routes, helper decisions, and bundle limits
- Keep this `index.md` map current after structure changes

## Core & Stability Modules (`lib/`)
- `lib/clock.js` — monotonic process clock (`nowMono`) for durations
- `lib/circuit-breaker.js` — per-provider breaker
- `lib/error-taxonomy.js` — `classifyFailure` / `shouldSwitch`
- `lib/notify-queue.js` — non-blocking webhook queue
- `lib/atomic-io.js` — atomic write + safe JSON load
- `lib/safe-fetch.js` — SSRF guard (`assertSafeUrl`, `createSafeDispatcher`, `createSafeLookup`, `safeFetchJson`)
- `lib/routes/` — modular HTTP endpoints (`config.js` with `decryptConfigAsync`, `keys.js`, `status.js`, `quick-action.js`, `balance.js`, etc.)
